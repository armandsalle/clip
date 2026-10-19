import {
  DurableObject,
  env,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Effect, Layer } from "effect";
import PostalMime from "postal-mime";
import { VideoId } from "@clip/domain";
import {
  AiFor,
  decodeNotifications,
  Features,
  InternalApi,
  LiveViaApi,
  Mailer,
  makeWorkerRuntime,
  StreamVideos,
} from "@clip/platform";
import { Db, Store } from "@clip/db";
import * as Pipeline from "./pipeline.ts";

// clip-jobs : tout ce qui est asynchrone (Workflow, Queue, emails entrants, Cron).
// Chaque binding devient une Layer, composée une fois ici.

const remote = env.REMOTE === "1";
const webhook = env.STREAM_WEBHOOK === "1";

const PlatformLive = LiveViaApi.pipe(
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
      AiFor(remote ? env.AI || undefined : undefined),
      InternalApi.layer(env.API || InternalApi.unavailable),
      env.MAIL ? Mailer.layer(env.MAIL, env.DOMAIN) : Mailer.layerDisabled(env.DOMAIN),
      Features.layer({ ai: true, storyboard: false, chaos: Number(env.CHAOS) || 0 }),
    ),
  ),
);

const { runtime } = makeWorkerRuntime(PlatformLive);

type Services = Layer.Success<typeof PlatformLive>;
/** Une étape de Workflow échoue (et sera rejouée) si l'Effect échoue. */
const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runtime.runPromise(effect.pipe(Effect.orDie));
/** Résultat d'étape sérialisable (les Workflows stockent du JSON). */
const json =
  <A, E>(effect: Effect.Effect<A, E, Services>) =>
  async () =>
    JSON.parse(JSON.stringify((await run(effect)) ?? null)) as Rpc.Serializable<unknown>;

export default {
  async queue(batch) {
    // Notifications de commentaires : un email par vidéo pour toute la rafale.
    try {
      await run(
        Effect.flatMap(
          decodeNotifications(batch.messages.map((m) => m.body)),
          Pipeline.notifyComments,
        ),
      );
      batch.ackAll();
    } catch (error) {
      console.error("notifications", error);
      batch.retryAll({ delaySeconds: 30 });
    }
  },

  async email(message) {
    // Réponse à une notification : api la publie sous le commentaire visé.
    const parsed = await PostalMime.parse(message.raw);
    const result = await runtime.runPromise(
      InternalApi.use((api) =>
        api.AddEmailReply({
          to: message.to,
          // Expéditeur de l'enveloppe SMTP (contrôlé par Email Routing), pas l'en-tête
          // From, que n'importe qui peut écrire.
          from: message.from,
          text: parsed.text ?? "",
        }),
      ).pipe(Effect.result),
    );
    if (result._tag === "Failure") {
      const reason =
        result.failure._tag === "ReplyRejected" ? result.failure.reason : "erreur temporaire";
      message.setReject(`Clip : ${reason}`);
    }
  },

  async scheduled() {
    const expired = await run(Pipeline.expireDue());
    if (expired > 0) console.log(JSON.stringify({ message: "videos.expired", count: expired }));
  },
} satisfies ExportedHandler<Env>;

/** Attentes successives d'un sondage : rapide au début, puis de plus en plus espacé. */
const backoff = (steps: ReadonlyArray<WorkflowSleepDuration>, i: number) =>
  steps[Math.min(i, steps.length - 1)]!;

/** Pipeline d'une vidéo : chaque étape est durable (rejouée, jamais refaite si réussie). */
export class VideoPipeline extends WorkflowEntrypoint<Env, { videoId: string }> {
  override async run(event: WorkflowEvent<{ videoId: string }>, step: WorkflowStep) {
    const videoId = VideoId.make(event.payload.videoId);

    // 1. Encodage Stream : réveillé par le webhook « vidéo prête », avec un sondage de
    //    secours espacé (le webhook arrive ~10 s après que Stream a marqué la vidéo prête).
    const wait = webhook ? "30 seconds" : "3 seconds";
    let state: "ready" | "waiting" | "failed" = "waiting";
    for (let i = 0; i < 240 && state === "waiting"; i++) {
      state = await step.do(`encoding #${i}`, () => run(Pipeline.checkEncoding(videoId, i === 0)));
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
      every: ReadonlyArray<WorkflowSleepDuration>,
      max: number,
      check: (startedAtMs: number) => Promise<"done" | "waiting">,
      startedAtMs: number,
    ) => {
      for (let i = 0; i < max; i++) {
        if ((await step.do(`${kind} #${i}`, () => check(startedAtMs))) === "done") return true;
        await step.sleep(`${kind} attente #${i}`, backoff(every, i));
      }
      return false;
    };

    // 2. En parallèle : étapes rapides, chaîne audio → transcription, et HD.
    const audioChain = async () => {
      const startedAtMs = await step.do("audio", () => run(Pipeline.requestAudio(videoId)));
      if (startedAtMs === null) {
        // IA coupée : les étapes se marquent elles-mêmes comme désactivées
        await step.do("transcript", json(Pipeline.transcript(videoId)));
        return;
      }
      await poll(
        "audio",
        ["5 seconds"],
        180,
        (t) => run(Pipeline.checkAudio(videoId, t)),
        startedAtMs,
      );
      await step.do("transcript", json(Pipeline.transcript(videoId)));
      await Promise.all([
        step.do("captions", json(Pipeline.captions(videoId))),
        step.do("summary", json(Pipeline.summary(videoId))),
        step.do("index", json(Pipeline.index(videoId))),
      ]);
    };

    // HD : 10 s au début (la 1080p arrive souvent vite), puis 30 s, puis 1 min (~2 h max).
    const hdChain = async () => {
      const startedAtMs = await step.do("hd start", async () => Date.now());
      await poll(
        "hd",
        ["10 seconds", "10 seconds", "10 seconds", "30 seconds", "30 seconds", "1 minute"],
        120,
        (t) => run(Pipeline.checkHd(videoId, t)),
        startedAtMs,
      );
    };

    await Promise.all([
      // L'email « vidéo prête » part quand titre, résumé et chapitres sont là.
      audioChain().then(() => step.do("notify", json(Pipeline.notify(videoId)))),
      step.do("thumbnail", json(Pipeline.thumbnail(videoId))),
      step.do("suggestions", json(Pipeline.suggestions(videoId))),
      step.do("storyboard", json(Pipeline.storyboard(videoId))),
      step.do("shareCard", json(Pipeline.shareCard(videoId))),
      hdChain(),
    ]);
    // L'expiration ne dort plus dans le Workflow : le Cron s'en charge.
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
