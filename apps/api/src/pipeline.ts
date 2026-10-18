import { DateTime, Duration, Effect, Option, Ref, Schedule, Schema } from "effect";
import {
  Comment,
  CommentId,
  decide,
  EnrichmentStatus,
  VideoId,
  expiresAt,
  type EnrichmentKind,
} from "@clip/domain";
import { TranscriptSegment } from "@clip/contract";
import {
  AiError,
  commentsEmail,
  extractReplyText,
  Features,
  Live,
  Mailer,
  readyEmail,
  replyAddress,
  StreamVideos,
  Summarizer,
  toVtt,
  tokenFromAddress,
  Transcriber,
  type CommentNotification,
} from "@clip/platform";
import { Store } from "@clip/db";

// Logique du pipeline en Effect pur (testable sans Workflow). Le Workflow
// Cloudflare (index.ts) appelle chaque fonction dans un `step.do` durable.

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

const elapsedMs = (from: DateTime.Utc, to: DateTime.Utc) =>
  Math.round(Duration.toMillis(DateTime.distance(from, to)));

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
    yield* publishStep(
      videoId,
      "encoding",
      EnrichmentStatus.cases.Running.make({ attempt: 1, startedAt: video.createdAt }),
    );
    return "waiting" as const;
  }
  const next = yield* Effect.fromResult(decide(video, event, now)).pipe(Effect.orDie);
  yield* store.saveVideo(next);
  yield* Live.use((live) => live.publish(videoId, { _tag: "VideoChanged", video: next }));
  yield* publishStep(
    videoId,
    "encoding",
    event._tag === "Encoded"
      ? EnrichmentStatus.cases.Done.make({ durationMs: elapsedMs(video.createdAt, now) })
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
      const running = EnrichmentStatus.cases.Running.make({ attempt: n, startedAt });
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
              durationMs: elapsedMs(startedAt, yield* DateTime.now),
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

/**
 * Étapes « à attente » (audio, HD) : le Workflow les rappelle avec `step.sleep`
 * entre deux vérifications, plutôt qu'un sondage enfermé dans une seule étape.
 * `startedAtMs` est fixé au premier appel pour un chrono stable.
 */
const waitingStep = Effect.fn("pipeline.waitingStep")(function* (
  videoId: VideoId,
  kind: EnrichmentKind,
  startedAtMs: number,
  state: { readonly done: boolean; readonly progress?: number },
) {
  const store = yield* Store;
  const startedAt = DateTime.makeUnsafe(startedAtMs);
  const status = state.done
    ? EnrichmentStatus.cases.Done.make({ durationMs: elapsedMs(startedAt, yield* DateTime.now) })
    : EnrichmentStatus.cases.Running.make({
        attempt: 1,
        startedAt,
        ...(state.progress === undefined ? {} : { progress: state.progress }),
      });
  yield* store.setEnrichment(videoId, kind, status);
  yield* publishStep(videoId, kind, status);
  return state.done ? ("done" as const) : ("waiting" as const);
});

/** Demande la piste audio à Stream dès que la vidéo est prête. */
export const requestAudio = Effect.fn("pipeline.requestAudio")(function* (videoId: VideoId) {
  if (!(yield* Features).ai) return yield* disabled(videoId, "audio");
  const { video } = yield* readyVideo(videoId).pipe(Effect.orDie);
  yield* StreamVideos.use((s) => s.requestAudio(video.streamUid));
  return yield* DateTime.now.pipe(Effect.map((d) => d.epochMilliseconds));
});

export const checkAudio = Effect.fn("pipeline.checkAudio")(function* (
  videoId: VideoId,
  startedAtMs: number,
) {
  const { video } = yield* readyVideo(videoId).pipe(Effect.orDie);
  const done = yield* StreamVideos.use((s) => s.audioReady(video.streamUid));
  return yield* waitingStep(videoId, "audio", startedAtMs, { done });
});

/** Encodage des qualités hautes, qui continue après Ready. */
export const checkHd = Effect.fn("pipeline.checkHd")(function* (
  videoId: VideoId,
  startedAtMs: number,
) {
  const { video } = yield* readyVideo(videoId).pipe(Effect.orDie);
  const details = yield* StreamVideos.use((s) => s.details(video.streamUid));
  return yield* waitingStep(videoId, "hd", startedAtMs, {
    done: !details.encoding || details.progress >= 100,
    progress: details.progress,
  });
});

const TranscriptResult = Schema.Struct({
  language: Schema.optionalKey(Schema.NullOr(Schema.String)),
  segments: Schema.Array(TranscriptSegment),
});

const storedTranscript = Effect.fn("pipeline.storedTranscript")(function* (videoId: VideoId) {
  const records = yield* Store.use((s) => s.enrichments(videoId));
  const raw = records.find((r) => r.kind === "transcript")?.result;
  return Option.getOrElse(Schema.decodeUnknownOption(TranscriptResult)(raw), () => ({
    language: null,
    segments: [],
  }));
});

/** Transcription Deepgram Nova-3 : l'audio Stream est transmis en flux. */
export const transcript = (videoId: VideoId) =>
  Effect.gen(function* () {
    if (!(yield* Features).ai) return yield* disabled(videoId, "transcript");
    return yield* enrichment(
      videoId,
      "transcript",
      Effect.gen(function* () {
        const { video, duration } = yield* readyVideo(videoId);
        const audio = yield* StreamVideos.use((s) => s.audio(video.streamUid));
        if (audio === null) {
          return yield* new StepFailed({ kind: "transcript", message: "audio pas encore prêt" });
        }
        return yield* Transcriber.use((t) => t.transcribe(audio, duration));
      }),
    );
  });

/** VTT de la transcription enregistrée, ou `null` s'il n'y en a pas encore. */
export const captionsVtt = Effect.fn("pipeline.captionsVtt")(function* (videoId: VideoId) {
  const { segments } = yield* storedTranscript(videoId);
  return segments.length === 0 ? null : toVtt(segments);
});

/** Sous-titres renvoyés à Stream : ils apparaissent dans le lecteur et le manifeste. */
export const captions = (videoId: VideoId) =>
  Effect.gen(function* () {
    if (!(yield* Features).ai) return yield* disabled(videoId, "captions");
    return yield* enrichment(
      videoId,
      "captions",
      Effect.gen(function* () {
        const { video } = yield* readyVideo(videoId);
        const { language, segments } = yield* storedTranscript(videoId);
        if (segments.length === 0) {
          return yield* new StepFailed({ kind: "captions", message: "pas de transcription" });
        }
        const lang = language ?? "fr";
        yield* StreamVideos.use((s) => s.uploadCaptions(video.streamUid, lang, toVtt(segments)));
        return { language: lang, cues: segments.length };
      }),
    );
  });

export const summary = (videoId: VideoId) =>
  Effect.gen(function* () {
    if (!(yield* Features).ai) return yield* disabled(videoId, "summary");
    return yield* enrichment(
      videoId,
      "summary",
      Effect.gen(function* () {
        const { language, segments } = yield* storedTranscript(videoId);
        if (segments.length === 0)
          return yield* new AiError({ step: "summary", message: "pas de transcription" });
        const result = yield* Summarizer.use((s) => s.summarize(segments, language ?? null));
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

// Emails ------------------------------------------------------------------------------------

const SummaryResult = Schema.Struct({
  summary: Schema.String,
  chapters: Schema.Array(Schema.Struct({ time: Schema.Finite, title: Schema.String })),
});

/** « Votre vidéo est prête », au propriétaire s'il a laissé son email. */
export const notify = (videoId: VideoId) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const to = yield* store.ownerEmail(videoId).pipe(Effect.orDie);
    if (to === null) return yield* disabled(videoId, "notify");
    return yield* enrichment(
      videoId,
      "notify",
      Effect.gen(function* () {
        const mailer = yield* Mailer;
        const video = yield* store.getVideo(videoId);
        const records = yield* store.enrichments(videoId);
        const summary = Option.getOrNull(
          Schema.decodeUnknownOption(SummaryResult)(
            records.find((r) => r.kind === "summary")?.result,
          ),
        );
        const email = readyEmail(
          mailer.domain,
          video,
          summary?.summary ?? null,
          summary?.chapters ?? [],
        );
        yield* mailer.send({ to, ...email });
        return { to };
      }),
    );
  });

/**
 * Consommateur de la Queue : un email par vidéo, listant ses nouveaux commentaires.
 * Renvoie les vidéos notifiées (pour le flux des Coulisses).
 */
export const notifyComments = Effect.fn("pipeline.notifyComments")(function* (
  notifications: ReadonlyArray<CommentNotification>,
) {
  const store = yield* Store;
  const mailer = yield* Mailer;
  const byVideo = new Map<string, Set<string>>();
  for (const n of notifications) {
    byVideo.set(n.videoId, (byVideo.get(n.videoId) ?? new Set()).add(n.commentId));
  }
  for (const [rawId, commentIds] of byVideo) {
    const videoId = VideoId.make(rawId);
    const to = yield* store.ownerEmail(videoId).pipe(Effect.orElseSucceed(() => null));
    if (to === null) continue;
    const video = yield* store.getVideo(videoId).pipe(Effect.orDie);
    const all = yield* store.comments(videoId);
    const fresh = all.filter((c) => commentIds.has(c.id));
    if (fresh.length === 0) continue;
    const items = yield* Effect.forEach(fresh, (comment) =>
      Effect.map(store.replyTokenOf(comment.id), (replyToken) => ({ comment, replyToken })),
    );
    const last = items.at(-1)?.replyToken;
    yield* mailer.send({
      to,
      ...commentsEmail(mailer.domain, video, items),
      ...(last ? { replyTo: replyAddress(mailer.domain, last) } : {}),
    });
    yield* publishStep(
      videoId,
      "mail.comment",
      EnrichmentStatus.cases.Done.make({ durationMs: 0 }),
    );
  }
});

export class ReplyRejected extends Schema.TaggedError<
  ReplyRejected,
  { readonly brand: unique symbol }
>()("ReplyRejected", { reason: Schema.String }) {}

/** Réponse par email : publiée sous le commentaire visé, en direct. */
export const replyByEmail = Effect.fn("pipeline.replyByEmail")(function* (input: {
  readonly to: string;
  readonly from: string;
  readonly text: string;
}) {
  const store = yield* Store;
  const token = tokenFromAddress(input.to);
  if (token === null) return yield* new ReplyRejected({ reason: "adresse inconnue" });
  const parent = yield* store.findCommentByReplyToken(token);
  if (parent === null) return yield* new ReplyRejected({ reason: "adresse inconnue" });
  const owner = yield* store.ownerEmail(parent.videoId).pipe(Effect.orElseSucceed(() => null));
  if (owner === null || owner.trim().toLowerCase() !== input.from.trim().toLowerCase()) {
    return yield* new ReplyRejected({ reason: "expéditeur non autorisé" });
  }
  const body = extractReplyText(input.text);
  if (body === null) return yield* new ReplyRejected({ reason: "réponse vide" });
  const reply = new Comment({
    id: CommentId.make(crypto.randomUUID()),
    videoId: parent.videoId,
    parentId: parent.parentId ?? parent.id,
    author: "Propriétaire",
    body,
    time: parent.time,
    via: "email",
    createdAt: yield* DateTime.now,
  });
  yield* store.addComment(reply);
  yield* Live.use((l) => l.publish(parent.videoId, { _tag: "CommentAdded", comment: reply }));
  yield* publishStep(
    parent.videoId,
    "mail.reply",
    EnrichmentStatus.cases.Done.make({ durationMs: 0 }),
  );
  return reply;
});
