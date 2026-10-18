import {
  DurableObject,
  env,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Option, Redacted, Scheduler } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { PgClient } from "@effect/sql-pg";
import { VideoId } from "@clip/domain";
import { Summarizer, Transcriber } from "./Ai.ts";
import { Db } from "./db/Db.ts";
import { ApiRoutes } from "./http.ts";
import * as Pipeline_ from "./pipeline.ts";
import { AdminKeys, Live, Pipeline, StreamVideos } from "./Platform.ts";
import { Store } from "./Store.ts";
import { isReady, verifyStreamWebhook } from "./webhook.ts";

export { VideoRoom } from "./room.ts";

// Composition : chaque binding devient une Layer. Une seule MemoMap pour le
// handler HTTP et le Workflow, afin qu'ils partagent les mêmes instances (le
// stockage en mémoire de `cf dev` en dépend).

const remote = env.REMOTE === "1";
// Le webhook Stream (unique par compte) ne vise que la production.
const webhook = env.STREAM_WEBHOOK_SECRET !== undefined;

const StoreLive =
  env.STORE === "postgres"
    ? Store.layerPerCall(
        Db.layerPg.pipe(
          // `env.DB.connectionString` ne se lit que dans un handler (Hyperdrive la génère
          // à la demande) : la Layer est donc construite à chaque appel, pas au chargement.
          Layer.provide(
            Layer.unwrap(
              Effect.sync(() => PgClient.layer({ url: Redacted.make(env.DB.connectionString) })),
            ),
          ),
        ),
      )
    : Store.layerMemory;

const StreamLive =
  remote && env.STREAM && env.STREAM_API_TOKEN
    ? StreamVideos.layer(env.STREAM, {
        accountId: env.ACCOUNT_ID,
        // Secrets Store : lu à la demande, dans le handler.
        token: () => env.STREAM_API_TOKEN!.get(),
      })
    : StreamVideos.layerFake(env.MEDIA);

const AiLive =
  remote && env.AI
    ? Layer.mergeAll(Transcriber.layer(env.AI), Summarizer.layer(env.AI))
    : Layer.mergeAll(Transcriber.layerFake, Summarizer.layerFake);

const PlatformLive = Layer.mergeAll(
  StoreLive,
  StreamLive,
  AiLive,
  AdminKeys.layer,
  Live.layer(env.VIDEO_ROOM),
  Pipeline.layer(env.PIPELINE),
  Pipeline_.Features.layer({ ai: true, storyboard: false, chaos: Number(env.CHAOS) || 0 }),
);

const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
const memoMap = Layer.makeMemoMapUnsafe();

// Construit une seule fois, au niveau du module (recommandation Effect pour Workers).
const app = HttpRouter.toWebHandler(
  ApiRoutes.pipe(
    Layer.provide(PlatformLive),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(SyncScheduler),
  ),
  { memoMap },
);

const runtime = ManagedRuntime.make(Layer.mergeAll(PlatformLive, SyncScheduler), { memoMap });

// Routes hors contrat : WebSocket temps réel, médias, faux Stream en local.
const LIVE_ROUTE = /^\/api\/videos\/([0-9a-f-]{36})\/live$/;
const CAPTIONS_ROUTE = /^\/api\/videos\/([0-9a-f-]{36})\/captions\.vtt$/;
const DEV_STREAM_ROUTE = /^\/dev\/stream\/(dev-[0-9a-f-]{36})(\/thumbnail\.svg)?$/;

async function devStream(request: Request, uid: string, thumbnail: boolean): Promise<Response> {
  const key = `dev-stream/${uid}`;
  if (thumbnail) {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#1d1d22"/><text x="50%" y="50%" fill="#8b8b94" font-family="monospace" font-size="20" text-anchor="middle">${uid.slice(0, 12)}</text></svg>`,
      { headers: { "content-type": "image/svg+xml", "x-content-type-options": "nosniff" } },
    );
  }
  if (request.method === "PUT" || request.method === "POST") {
    await env.MEDIA.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get("content-type") ?? "video/mp4" },
      customMetadata: { duration: request.headers.get("x-clip-duration") ?? "60" },
    });
    return new Response(null, { status: 201 });
  }
  const object = await env.MEDIA.get(key, { range: request.headers });
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers({ "accept-ranges": "bytes" });
  object.writeHttpMetadata(headers);
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
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/stream/webhook") {
      return streamWebhook(request);
    }
    const captions = CAPTIONS_ROUTE.exec(url.pathname);
    if (captions) {
      // Sous-titres servis par le Worker (lecteur), sans attendre le manifeste Stream.
      const vtt = await runtime.runPromise(
        Pipeline_.captionsVtt(VideoId.make(captions[1]!)).pipe(Effect.orDie),
      );
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
    return app.handler(request);
  },
  async queue(batch) {
    // Notifications de commentaires (regroupées, puis envoyées par Email Service).
    for (const message of batch.messages) message.ack();
  },
  async email(message) {
    // Réponse à une notification : publiée sous le commentaire visé.
    console.log("inbound email", message.to);
  },
} satisfies ExportedHandler<Env>;

/** Pipeline d'une vidéo : chaque étape est durable (rejouée, jamais refaite si réussie). */
export class VideoPipeline extends WorkflowEntrypoint<Env, { videoId: string }> {
  override async run(event: WorkflowEvent<{ videoId: string }>, step: WorkflowStep) {
    const videoId = VideoId.make(event.payload.videoId);
    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof PlatformLive>>) =>
      runtime.runPromise(effect.pipe(Effect.orDie));
    const json =
      <A>(effect: Effect.Effect<A, never, Layer.Success<typeof PlatformLive>>) =>
      async () =>
        JSON.parse(JSON.stringify((await run(effect)) ?? null)) as Rpc.Serializable<unknown>;

    // 1. Encodage Stream : réveillé par le webhook « vidéo prête », avec un sondage de
    //    secours (Stream envoie le webhook ~10 s après avoir marqué la vidéo prête).
    const wait = webhook ? "5 seconds" : "3 seconds";
    let state: "ready" | "waiting" | "failed" = "waiting";
    for (let i = 0; i < 240 && state === "waiting"; i++) {
      state = await step.do(`encoding #${i}`, () => run(Pipeline_.checkEncoding(videoId)));
      if (state !== "waiting") break;
      try {
        await step.waitForEvent(`stream-ready #${i}`, { type: "stream-ready", timeout: wait });
      } catch {
        // délai écoulé : on revérifie
      }
    }
    if (state !== "ready") return { outcome: state };

    // Attente durable d'une étape longue : une vérification, puis `step.sleep`.
    const poll = async (
      kind: string,
      every: WorkflowSleepDuration,
      max: number,
      check: (startedAtMs: number) => Promise<"done" | "waiting">,
      startedAtMs: number,
    ) => {
      for (let i = 0; i < max; i++) {
        if ((await step.do(`${kind} #${i}`, () => check(startedAtMs))) === "done") return true;
        await step.sleep(`${kind} attente #${i}`, every);
      }
      return false;
    };

    // 2. En parallèle : étapes rapides, chaîne audio → transcription, et HD.
    const audioChain = async () => {
      const startedAtMs = await step.do("audio", () => run(Pipeline_.requestAudio(videoId)));
      if (startedAtMs === null) {
        // IA coupée : les étapes se marquent elles-mêmes comme désactivées
        await step.do("transcript", json(Pipeline_.transcript(videoId)));
        return;
      }
      await poll(
        "audio",
        "5 seconds",
        180,
        (t) => run(Pipeline_.checkAudio(videoId, t)),
        startedAtMs,
      );
      await step.do("transcript", json(Pipeline_.transcript(videoId)));
      await Promise.all([
        step.do("captions", json(Pipeline_.captions(videoId))),
        step.do("summary", json(Pipeline_.summary(videoId))),
        step.do("index", json(Pipeline_.index(videoId))),
      ]);
    };

    const hdChain = async () => {
      const startedAtMs = await step.do("hd start", async () => Date.now());
      await poll("hd", "10 seconds", 360, (t) => run(Pipeline_.checkHd(videoId, t)), startedAtMs);
    };

    await Promise.all([
      step.do("thumbnail", json(Pipeline_.thumbnail(videoId))),
      step.do("suggestions", json(Pipeline_.suggestions(videoId))),
      step.do("storyboard", json(Pipeline_.storyboard(videoId))),
      step.do("shareCard", json(Pipeline_.shareCard(videoId))),
      audioChain(),
      hdChain(),
    ]);

    // 3. Expiration : le Workflow dort jusqu'à la date, puis supprime.
    const expiry = await step.do("expiry", () =>
      run(Effect.map(Pipeline_.expiryOf(videoId), Option.getOrNull)),
    );
    if (expiry !== null) {
      await step.sleepUntil("jusqu'à l'expiration", new Date(expiry));
      await step.do("expire", () => run(Pipeline_.expire(videoId)));
    }
    return { outcome: "done" };
  }
}

/** Planche de vignettes dans un Container (ffmpeg), pilotée par ce Durable Object. */
export class Storyboard extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (container === undefined) return new Response("container unavailable", { status: 503 });
    if (!container.running) container.start();
    return container.getTcpPort(8080).fetch(request.url, request);
  }
}
