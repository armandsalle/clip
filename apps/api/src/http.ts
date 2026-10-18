import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  canCommentAt,
  Comment,
  CommentId,
  decide,
  EnrichmentKind,
  EnrichmentStatus,
  Thumbnail,
  Video,
  VideoId,
  VideoStatus,
  type VideoEvent,
} from "@clip/domain";
import { Chapter, ClipApi, TranscriptSegment, VideoView } from "@clip/contract";
import {
  AdminKeys,
  Live,
  Notifications,
  Pipeline,
  StreamVideos,
  type StreamDetails,
} from "./Platform.ts";
import { Store } from "./Store.ts";

const MAX_DURATION_SECONDS = 3600;
const KINDS = EnrichmentKind.literals;

// Résultats d'enrichissement : stockés en JSONB, relus avec tolérance (une étape
// pas encore passée donne simplement une valeur vide).
const SummaryResult = Schema.Struct({ summary: Schema.String, chapters: Schema.Array(Chapter) });
const TranscriptResult = Schema.Struct({
  language: Schema.optionalKey(Schema.NullOr(Schema.String)),
  segments: Schema.Array(TranscriptSegment),
});
const SuggestionsResult = Schema.Struct({ times: Schema.Array(Schema.Finite) });

const decodeOption = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (value: unknown): Option.Option<S["Type"]> => decode(value);
};

const thumbnailUrl = (video: Video, details: StreamDetails) =>
  Thumbnail.match(video.thumbnail, {
    Auto: () => details.thumbnail,
    Frame: ({ time }) => `${details.thumbnail}?time=${Math.floor(time)}s`,
    Custom: ({ key }) => `/media/${key}`,
  });

export const VideosHandlers = HttpApiBuilder.group(
  ClipApi,
  "videos",
  Effect.fn(function* (handlers) {
    const store = yield* Store;
    const stream = yield* StreamVideos;
    const keys = yield* AdminKeys;
    const live = yield* Live;
    const pipeline = yield* Pipeline;
    const notifications = yield* Notifications;

    const summaryOf = decodeOption(SummaryResult);
    const transcriptOf = decodeOption(TranscriptResult);
    const suggestionsOf = decodeOption(SuggestionsResult);

    const view = Effect.fn("Videos.view")(function* (id: VideoId) {
      const video = yield* store.getVideo(id);
      const records = yield* store.enrichments(id);
      const byKind = new Map(records.map((r) => [r.kind, r]));
      const details =
        video.status._tag === "Ready"
          ? Option.some(yield* stream.details(video.streamUid))
          : Option.none();
      const summary = Option.flatMap(
        Option.fromNullishOr(byKind.get("summary")?.result),
        summaryOf,
      );
      const stored = Option.flatMap(
        Option.fromNullishOr(byKind.get("transcript")?.result),
        transcriptOf,
      );
      return new VideoView({
        video,
        playback: Option.match(details, {
          onNone: () => null,
          onSome: (d) => ({ hls: d.hls, thumbnail: thumbnailUrl(video, d) }),
        }),
        enrichments: Object.fromEntries(
          KINDS.map((kind) => [
            kind,
            byKind.get(kind)?.status ?? EnrichmentStatus.cases.Pending.make({}),
          ]),
        ) as VideoView["enrichments"],
        summary: Option.match(summary, { onNone: () => null, onSome: (s) => s.summary }),
        chapters: Option.match(summary, { onNone: () => [], onSome: (s) => s.chapters }),
        language: Option.getOrNull(Option.flatMap(stored, (t) => Option.fromNullishOr(t.language))),
        transcript: Option.getOrElse(
          Option.map(stored, (t) => t.segments),
          () => [],
        ),
        thumbnailSuggestions: Option.getOrElse(
          Option.map(
            Option.flatMap(Option.fromNullishOr(byKind.get("suggestions")?.result), suggestionsOf),
            (s) => s.times,
          ),
          () => [],
        ),
      });
    });

    // Appliquer une suite d'événements du domaine, enregistrer, diffuser.
    const apply = Effect.fn("Videos.apply")(function* (
      id: VideoId,
      events: ReadonlyArray<VideoEvent>,
    ) {
      const now = yield* DateTime.now;
      let video = yield* store.getVideo(id);
      for (const event of events) video = yield* Effect.fromResult(decide(video, event, now));
      yield* store.saveVideo(video);
      yield* live.publish(id, { _tag: "VideoChanged", video });
      return video;
    });

    const requireAdmin = Effect.fn("Videos.requireAdmin")(function* (id: VideoId, key: string) {
      yield* store.checkAdmin(id, yield* keys.hash(key));
    });

    return handlers.handleAll({
      create: ({ payload }) =>
        Effect.gen(function* () {
          const upload = yield* stream.createUpload(MAX_DURATION_SECONDS, payload.size);
          const admin = yield* keys.generate;
          const video = new Video({
            id: VideoId.make(crypto.randomUUID()),
            streamUid: upload.uid,
            title: null,
            status: VideoStatus.cases.Uploading.make({}),
            thumbnail: Thumbnail.cases.Auto.make({}),
            expiry: payload.expiry,
            createdAt: yield* DateTime.now,
          });
          yield* store.createVideo(video, admin.hash, payload.email);
          yield* pipeline.start(video.id);
          return {
            video,
            uploadUrl: upload.uploadUrl,
            uploadProtocol: upload.protocol,
            adminKey: admin.key,
          };
        }),

      get: ({ params }) => view(params.id),

      update: ({ params, headers, payload }) =>
        Effect.gen(function* () {
          yield* requireAdmin(params.id, headers["x-clip-admin"]);
          const events: Array<VideoEvent> = [];
          if (payload.title !== undefined) events.push({ _tag: "Rename", title: payload.title });
          if (payload.thumbnail !== undefined)
            events.push({ _tag: "SetThumbnail", thumbnail: payload.thumbnail });
          if (payload.expiry !== undefined)
            events.push({ _tag: "SetExpiry", expiry: payload.expiry });
          if (payload.email !== undefined) yield* store.setOwnerEmail(params.id, payload.email);
          const video = yield* apply(params.id, events);
          if (video.thumbnail._tag === "Frame" && video.status._tag === "Ready") {
            const pct =
              video.status.duration > 0 ? video.thumbnail.time / video.status.duration : 0.5;
            yield* stream.setThumbnail(video.streamUid, Math.min(1, pct));
          }
          return video;
        }),

      remove: ({ params, headers }) =>
        Effect.gen(function* () {
          yield* requireAdmin(params.id, headers["x-clip-admin"]);
          const video = yield* apply(params.id, [{ _tag: "Delete" }]);
          yield* stream.remove(video.streamUid);
          return video;
        }),

      comments: ({ params }) =>
        Effect.gen(function* () {
          yield* store.getVideo(params.id);
          return yield* store.comments(params.id);
        }),

      comment: ({ params, payload }) =>
        Effect.gen(function* () {
          const video = yield* store.getVideo(params.id);
          yield* Effect.fromResult(canCommentAt(video, payload.time));
          const comment = new Comment({
            id: CommentId.make(crypto.randomUUID()),
            videoId: video.id,
            parentId: payload.parentId,
            author: payload.author,
            body: payload.body,
            time: payload.time,
            via: "web",
            createdAt: yield* DateTime.now,
          });
          yield* store.addComment(comment);
          yield* live.publish(video.id, { _tag: "CommentAdded", comment });
          yield* notifications.enqueue({ videoId: video.id, commentId: comment.id });
          return comment;
        }),
    });
  }),
);

export const SystemHandlers = HttpApiBuilder.group(ClipApi, "system", (handlers) =>
  Effect.succeed(handlers.handleAll({ health: () => Effect.succeed({ ok: true }) })),
);

export const ApiRoutes = HttpApiBuilder.layer(ClipApi, { openapiPath: "/api/openapi.json" }).pipe(
  Layer.provide([VideosHandlers, SystemHandlers]),
);
