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

export { VideoRoom } from "./room.ts";

// Composition : chaque binding devient une Layer. Une seule MemoMap pour le
// handler HTTP et le Workflow, afin qu'ils partagent les mêmes instances (le
// stockage en mémoire de `cf dev` en dépend).

const remote = env.REMOTE === "1";

const StoreLive =
  env.STORE === "postgres"
    ? Store.layerDrizzle.pipe(
        Layer.provide(Db.layerPg),
        Layer.provide(PgClient.layer({ url: Redacted.make(env.DB.connectionString) })),
        Layer.orDie,
      )
    : Store.layerMemory;

const StreamLive =
  remote && env.STREAM ? StreamVideos.layer(env.STREAM) : StreamVideos.layerFake(env.MEDIA);

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

export default {
  async fetch(request) {
    const url = new URL(request.url);
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

    // 1. Attendre l'encodage Stream : sondage durable, une étape par essai.
    let state: "ready" | "waiting" | "failed" = "waiting";
    for (let i = 0; i < 120 && state === "waiting"; i++) {
      state = await step.do(`encoding #${i}`, () => run(Pipeline_.checkEncoding(videoId)));
      if (state === "waiting") await step.sleep(`attente #${i}`, "3 seconds");
    }
    if (state !== "ready") return { outcome: state };

    // 2. Enrichissements indépendants en parallèle, puis ceux qui en dépendent.
    const json =
      <A>(effect: Effect.Effect<A, never, Layer.Success<typeof PlatformLive>>) =>
      async () =>
        JSON.parse(JSON.stringify((await run(effect)) ?? null)) as Rpc.Serializable<unknown>;
    await Promise.all([
      step.do("thumbnail", json(Pipeline_.thumbnail(videoId))),
      step.do("suggestions", json(Pipeline_.suggestions(videoId))),
      step.do("storyboard", json(Pipeline_.storyboard(videoId))),
      step.do("shareCard", json(Pipeline_.shareCard(videoId))),
      step
        .do("transcript", json(Pipeline_.transcript(videoId)))
        .then(() =>
          Promise.all([
            step.do("summary", json(Pipeline_.summary(videoId))),
            step.do("index", json(Pipeline_.index(videoId))),
          ]),
        ),
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
