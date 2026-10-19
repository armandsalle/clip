import { env, WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { isTerminal, VideoId } from "@clip/domain";
import { decodeResult, TranscriptResult } from "@clip/contract";
import {
  AdminKeys,
  isReady,
  Live,
  makeWorkerRuntime,
  posthogTarget,
  Notifications,
  Pipeline,
  RateLimits,
  StreamVideos,
  telemetryLayer,
  toVtt,
  verifyStreamWebhook,
} from "@clip/platform";
import { Db, Store } from "@clip/db";
import { ApiRoutes } from "./http.ts";
import { InternalRoutes } from "./internal.ts";
import { Videos } from "./Videos.ts";

export { VideoRoom } from "./room.ts";

// clip-api : API publique (atteinte via clip-web), RPC interne (atteinte par
// clip-jobs), rooms temps réel et webhook Stream. Seul écrivain des vidéos et des
// commentaires. Chaque binding devient une Layer, composée une fois ici.

const remote = env.REMOTE === "1";

const PlatformLive = Videos.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      env.STORE === "postgres" ? Store.layerPerCall(Db.layerHyperdrive(env.DB)) : Store.layerMemory,
      StreamVideos.layerFor({
        remote,
        stream: env.STREAM || undefined,
        token: env.STREAM_API_TOKEN || undefined,
        accountId: env.ACCOUNT_ID,
        media: env.MEDIA,
      }),
      AdminKeys.layer,
      Live.layer(env.VIDEO_ROOM),
      Pipeline.layer(env.PIPELINE),
      Notifications.layer(env.NOTIFICATIONS),
      RateLimits.layer({ create: env.CREATE_LIMIT, comment: env.COMMENT_LIMIT }),
    ),
  ),
);

const telemetry = telemetryLayer({
  service: "clip-api",
  environment: env.ENVIRONMENT,
  target: posthogTarget({
    host: env.POSTHOG_HOST || undefined,
    token: env.POSTHOG_PROJECT_TOKEN || undefined,
  }),
});

const { runtime, http, flush } = makeWorkerRuntime(PlatformLive, telemetry);
const api = http(ApiRoutes.pipe(Layer.provide(PlatformLive)));
const internal = http(InternalRoutes.pipe(Layer.provide(PlatformLive)));

// Routes hors contrat : WebSocket temps réel, sous-titres, faux Stream en local.
const LIVE_ROUTE = /^\/api\/videos\/([0-9a-f-]{36})\/live$/;
const CAPTIONS_ROUTE = /^\/api\/videos\/([0-9a-f-]{36})\/captions\.vtt$/;
const DEV_STREAM_ROUTE = /^\/dev\/stream\/(dev-[0-9a-f-]{36})(\/thumbnail\.svg)?$/;

const transcriptOf = decodeResult(TranscriptResult);

/** VTT de la transcription enregistrée, ou `null` s'il n'y en a pas encore. */
const captionsVtt = Effect.fn("captionsVtt")(function* (videoId: VideoId) {
  const store = yield* Store;
  const [video, records] = yield* Effect.all(
    [store.getVideo(videoId).pipe(Effect.option), store.enrichments(videoId)],
    { concurrency: 2 },
  );
  // Introuvable, expirée ou supprimée : pas de sous-titres.
  if (Option.isNone(video) || isTerminal(video.value)) return null;
  const segments = Option.match(
    transcriptOf(records.find((r) => r.kind === "transcript")?.result),
    {
      onNone: () => [],
      onSome: (t) => t.segments,
    },
  );
  return segments.length === 0 ? null : toVtt(segments);
});

async function devStream(request: Request, uid: string, thumbnail: boolean): Promise<Response> {
  const key = `dev-stream/${uid}`;
  if (thumbnail) {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#1d1d22"/><text x="50%" y="50%" fill="#8b8b94" font-family="monospace" font-size="20" text-anchor="middle">${uid.slice(0, 12)}</text></svg>`,
      { headers: { "content-type": "image/svg+xml", "x-content-type-options": "nosniff" } },
    );
  }
  if (request.method === "PUT" || request.method === "POST") {
    // Écriture seulement pour un dépôt créé par l'API et encore en cours : le faux
    // Stream (dev local, environnements de PR) n'héberge pas de fichiers arbitraires.
    const accepting = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const videoId = yield* store.findByStreamUid(uid);
        if (videoId === null) return false;
        const video = yield* store.getVideo(videoId).pipe(Effect.option);
        return Option.isSome(video) && video.value.status._tag === "Uploading";
      }),
    );
    if (!accepting) return new Response("upload inconnu", { status: 404 });
    await env.MEDIA.put(key, request.body, {
      // Type imposé : jamais celui du client (sinon du HTML servi depuis clipshare.dev).
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { duration: request.headers.get("x-clip-duration") ?? "60" },
    });
    return new Response(null, { status: 201 });
  }
  const object = await env.MEDIA.get(key, { range: request.headers });
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": "video/mp4",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  if (object.range && "offset" in object.range) {
    const { offset = 0, length = object.size - offset } = object.range;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

/** Webhook Stream : vérifie la signature, puis réveille le Workflow de la vidéo. */
async function streamWebhook(request: Request): Promise<Response> {
  if (!env.STREAM_WEBHOOK_SECRET) return new Response("webhook non configuré", { status: 404 });
  const body = await request.text();
  const secret = await env.STREAM_WEBHOOK_SECRET.get();
  const notification = await runtime.runPromise(
    verifyStreamWebhook(
      secret,
      request.headers.get("webhook-signature"),
      body,
      Math.floor(Date.now() / 1000),
    ),
  );
  if (Option.isNone(notification)) return new Response("signature invalide", { status: 401 });
  if (isReady(notification.value)) {
    await runtime.runPromise(
      Effect.gen(function* () {
        const videoId = yield* Store.use((s) => s.findByStreamUid(notification.value.uid));
        if (videoId !== null) yield* Pipeline.use((p) => p.notifyEncoded(videoId));
      }).pipe(Effect.orDie),
    );
  }
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request, _env, ctx) {
    const response = await route(request);
    ctx.waitUntil(flush());
    return response;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request): Promise<Response> {
  {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/stream/webhook") {
      return streamWebhook(request);
    }
    const captions = CAPTIONS_ROUTE.exec(url.pathname);
    if (captions) {
      // Sous-titres servis par le Worker (lecteur), sans attendre le manifeste Stream.
      const vtt = await runtime.runPromise(captionsVtt(VideoId.make(captions[1]!)));
      return vtt === null
        ? new Response("pas encore de transcription", { status: 404 })
        : new Response(vtt, {
            headers: { "content-type": "text/vtt; charset=utf-8", "cache-control": "no-store" },
          });
    }
    const live = LIVE_ROUTE.exec(url.pathname);
    if (live) {
      const room = env.VIDEO_ROOM.get(env.VIDEO_ROOM.idFromName(live[1]!));
      return room.fetch(request);
    }
    const dev = !remote && DEV_STREAM_ROUTE.exec(url.pathname);
    if (dev) return devStream(request, dev[1]!, dev[2] !== undefined);
    return api.handler(request);
  }
}

/** RPC interne : seul clip-jobs y accède, par service binding (aucune route publique). */
export class Internal extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const response = await internal.handler(request);
    this.ctx.waitUntil(flush());
    return response;
  }
}
