import { Context, DateTime, Duration, Effect, Layer, Option, Ref, Schedule, Schema } from "effect";
import {
  decide,
  EnrichmentStatus,
  expiresAt,
  type EnrichmentKind,
  type VideoId,
} from "@clip/domain";
import { TranscriptSegment } from "@clip/contract";
import { AiError, Summarizer, Transcriber } from "./Ai.ts";
import { Live, StreamVideos } from "./Platform.ts";
import { Store } from "./Store.ts";

// Logique du pipeline en Effect pur (testable sans Workflow). Le Workflow
// Cloudflare (index.ts) appelle chaque fonction dans un `step.do` durable.

/** Interrupteurs à chaud (Flagship en prod, variables en local). */
export class Features extends Context.Service<
  Features,
  { readonly ai: boolean; readonly storyboard: boolean; readonly chaos: number }
>()("@clip/api/Features") {
  static readonly layer = (features: { ai: boolean; storyboard: boolean; chaos: number }) =>
    Layer.succeed(Features, Features.of(features));
}

export class StepFailed extends Schema.TaggedError<StepFailed, { readonly brand: unique symbol }>()(
  "StepFailed",
  { kind: Schema.String, message: Schema.String },
) {}

const publishStep = Effect.fn("pipeline.publishStep")(function* (
  videoId: VideoId,
  kind: string,
  status: EnrichmentStatus,
) {
  const live = yield* Live;
  yield* live.publish(videoId, { _tag: "Step", kind, status, at: yield* DateTime.now });
});

/** Encodage : `ready` (vidéo passée en Ready), `waiting` ou `failed`. */
export const checkEncoding = Effect.fn("pipeline.checkEncoding")(function* (videoId: VideoId) {
  const store = yield* Store;
  const stream = yield* StreamVideos;
  const video = yield* store.getVideo(videoId);
  if (video.status._tag === "Ready") return "ready" as const;
  const details = yield* stream.details(video.streamUid);
  const now = yield* DateTime.now;
  const event = details.failed
    ? ({ _tag: "EncodingFailed", reason: details.failed } as const)
    : details.ready
      ? ({ _tag: "Encoded", duration: details.duration } as const)
      : null;
  if (event === null) {
    yield* publishStep(videoId, "encoding", EnrichmentStatus.cases.Running.make({ attempt: 1 }));
    return "waiting" as const;
  }
  const next = yield* Effect.fromResult(decide(video, event, now)).pipe(Effect.orDie);
  yield* store.saveVideo(next);
  yield* Live.use((live) => live.publish(videoId, { _tag: "VideoChanged", video: next }));
  yield* publishStep(
    videoId,
    "encoding",
    event._tag === "Encoded"
      ? EnrichmentStatus.cases.Done.make({ durationMs: 0 })
      : EnrichmentStatus.cases.Failed.make({ error: event.reason, attempts: 1 }),
  );
  return event._tag === "Encoded" ? ("ready" as const) : ("failed" as const);
});

/**
 * Exécute une étape d'enrichissement : états publiés en direct (Running avec le
 * numéro de tentative, Done, Failed), retries exponentiels, résultat enregistré.
 */
const enrichment = <A, E, R>(
  videoId: VideoId,
  kind: EnrichmentKind,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const features = yield* Features;
    const attempts = yield* Ref.make(0);
    const startedAt = yield* DateTime.now;

    const attempt = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (a) => a + 1);
      const running = EnrichmentStatus.cases.Running.make({ attempt: n });
      yield* store.setEnrichment(videoId, kind, running);
      yield* publishStep(videoId, kind, running);
      // Mode chaos : échecs aléatoires pour montrer les retries en démo.
      if (Math.random() < features.chaos) {
        return yield* new StepFailed({ kind, message: "chaos" });
      }
      return yield* work;
    });

    return yield* attempt.pipe(
      Effect.retry({ schedule: Schedule.exponential("400 millis"), times: 2 }),
      Effect.matchEffect({
        onSuccess: (result) =>
          Effect.gen(function* () {
            const done = EnrichmentStatus.cases.Done.make({
              durationMs: Math.round(
                Duration.toMillis(DateTime.distance(startedAt, yield* DateTime.now)),
              ),
            });
            yield* store.setEnrichment(videoId, kind, done, result);
            yield* publishStep(videoId, kind, done);
            return result;
          }),
        onFailure: (error) =>
          Effect.gen(function* () {
            const failed = EnrichmentStatus.cases.Failed.make({
              error: error instanceof Error ? error.message : String(error),
              attempts: yield* Ref.get(attempts),
            });
            yield* store.setEnrichment(videoId, kind, failed);
            yield* publishStep(videoId, kind, failed);
            return null;
          }),
      }),
      Effect.withSpan(`pipeline.${kind}`, { attributes: { videoId } }),
    );
  });

const disabled = Effect.fn("pipeline.disabled")(function* (videoId: VideoId, kind: EnrichmentKind) {
  const store = yield* Store;
  const status = EnrichmentStatus.cases.Disabled.make({});
  yield* store.setEnrichment(videoId, kind, status);
  yield* publishStep(videoId, kind, status);
  return null;
});

const readyVideo = Effect.fn("pipeline.readyVideo")(function* (videoId: VideoId) {
  const video = yield* Store.use((s) => s.getVideo(videoId));
  if (video.status._tag !== "Ready") {
    return yield* new StepFailed({ kind: "ready", message: `vidéo ${video.status._tag}` });
  }
  return { video, duration: video.status.duration };
});

export const thumbnail = (videoId: VideoId) =>
  enrichment(videoId, "thumbnail", Effect.succeed({ source: "stream" }));

export const transcript = (videoId: VideoId) =>
  Effect.gen(function* () {
    if (!(yield* Features).ai) return yield* disabled(videoId, "transcript");
    return yield* enrichment(
      videoId,
      "transcript",
      Effect.gen(function* () {
        const { video, duration } = yield* readyVideo(videoId);
        const audio = yield* StreamVideos.use((s) => s.audio(video.streamUid));
        if (audio === null)
          return yield* new StepFailed({ kind: "transcript", message: "audio pas encore prêt" });
        const segments = yield* Transcriber.use((t) => t.transcribe(audio, duration));
        return { segments };
      }),
    );
  });

const TranscriptResult = Schema.Struct({ segments: Schema.Array(TranscriptSegment) });

export const summary = (videoId: VideoId) =>
  Effect.gen(function* () {
    if (!(yield* Features).ai) return yield* disabled(videoId, "summary");
    return yield* enrichment(
      videoId,
      "summary",
      Effect.gen(function* () {
        const records = yield* Store.use((s) => s.enrichments(videoId));
        const raw = records.find((r) => r.kind === "transcript")?.result;
        const segments = Option.getOrElse(
          Option.map(Schema.decodeUnknownOption(TranscriptResult)(raw), (t) => t.segments),
          () => [],
        );
        if (segments.length === 0)
          return yield* new AiError({ step: "summary", message: "pas de transcription" });
        const result = yield* Summarizer.use((s) => s.summarize(segments));
        // Le titre généré ne remplace jamais un titre choisi par le propriétaire.
        const store = yield* Store;
        const video = yield* store.getVideo(videoId);
        if (video.title === null) {
          const renamed = yield* Effect.fromResult(
            decide(video, { _tag: "Rename", title: result.title }, yield* DateTime.now),
          ).pipe(Effect.orDie);
          yield* store.saveVideo(renamed);
          yield* Live.use((l) => l.publish(videoId, { _tag: "VideoChanged", video: renamed }));
        }
        return { summary: result.summary, chapters: result.chapters };
      }),
    );
  });

/** Suggestions de miniatures : 3 instants répartis (classés par l'IA en prod). */
export const suggestions = (videoId: VideoId) =>
  enrichment(
    videoId,
    "suggestions",
    Effect.map(readyVideo(videoId), ({ duration }) => ({
      times: [0.2, 0.5, 0.8].map((p) => Math.round(duration * p * 10) / 10),
    })),
  );

export const storyboard = (videoId: VideoId) =>
  Effect.gen(function* () {
    if (!(yield* Features).storyboard) return yield* disabled(videoId, "storyboard");
    return yield* enrichment(videoId, "storyboard", Effect.succeed({ sprite: null }));
  });

export const shareCard = (videoId: VideoId) =>
  enrichment(videoId, "shareCard", Effect.succeed({ path: `/v/${videoId}/card.png` }));

export const index = (videoId: VideoId) =>
  Effect.gen(function* () {
    if (!(yield* Features).ai) return yield* disabled(videoId, "index");
    return yield* enrichment(videoId, "index", Effect.succeed({ indexed: true }));
  });

/** Date d'expiration de la vidéo, si elle en a une. */
export const expiryOf = Effect.fn("pipeline.expiryOf")(function* (videoId: VideoId) {
  const video = yield* Store.use((s) => s.getVideo(videoId));
  return Option.map(expiresAt(video), (d) => d.epochMilliseconds);
});

export const expire = Effect.fn("pipeline.expire")(function* (videoId: VideoId) {
  const store = yield* Store;
  const video = yield* store.getVideo(videoId);
  const next = decide(video, { _tag: "Expire" }, yield* DateTime.now);
  if (next._tag === "Failure") return; // déjà supprimée
  yield* store.saveVideo(next.success);
  yield* StreamVideos.use((s) => s.remove(video.streamUid));
  yield* Live.use((l) => l.publish(videoId, { _tag: "VideoChanged", video: next.success }));
});
