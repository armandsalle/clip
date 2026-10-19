import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerRequest } from "effect/http";
import {
  canCommentAt,
  isTerminal,
  Comment,
  CommentId,
  EnrichmentKind,
  EnrichmentStatus,
  Thumbnail,
  Video,
  VideoId,
  VideoStatus,
  type VideoEvent,
} from "@clip/domain";
import {
  ClipApi,
  decodeResult,
  SuggestionsResult,
  SummaryResult,
  ThumbnailResult,
  TranscriptResult,
  VideoView,
} from "@clip/contract";
import { AdminKeys, Live, Notifications, Pipeline, RateLimits, StreamVideos } from "@clip/platform";
import { type EnrichmentRecord, type GalleryCursor, Store } from "@clip/db";
import { Videos } from "./Videos.ts";

const MAX_DURATION_SECONDS = 3600;
const KINDS = EnrichmentKind.literals;

const summaryOf = decodeResult(SummaryResult);
const transcriptOf = decodeResult(TranscriptResult);
const suggestionsOf = decodeResult(SuggestionsResult);

/** Clé de limitation : l'adresse du client (en-tête posé par Cloudflare). */
const clientKey = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => request.headers["cf-connecting-ip"] ?? "local",
);

/** Miniature affichée : celle de Stream, ou l'instant choisi par le propriétaire. */
const thumbnailUrl = (video: Video, base: string) =>
  Thumbnail.match(video.thumbnail, {
    Auto: () => base,
    Frame: ({ time }) => `${base}?time=${Math.floor(time)}s`,
    Custom: ({ key }) => `/media/${key}`,
  });

/**
 * URL de lecture enregistrées. Pour les vidéos traitées avant l'ajout de `hls`, le
 * manifeste se déduit de la miniature (format d'URL documenté de Stream :
 * `<base>/<uid>/thumbnails/thumbnail.jpg` → `<base>/<uid>/manifest/video.m3u8`).
 */
const playbackOf = (saved: typeof ThumbnailResult.Type) => {
  const hls =
    saved.hls ?? saved.url.replace(/\/thumbnails\/thumbnail\.jpg$/, "/manifest/video.m3u8");
  return hls.endsWith(".m3u8") ? Option.some({ hls, thumbnail: saved.url }) : Option.none();
};

const GALLERY_PAGE_SIZE = 12;
const thumbnailOf = decodeResult(ThumbnailResult);

/** Curseur opaque de la galerie : `<createdAt ms>.<id>` de la dernière carte. */
const encodeCursor = (video: Video) => `${video.createdAt.epochMilliseconds}.${video.id}`;
const decodeVideoId = Schema.decodeUnknownOption(VideoId);
const decodeCursor = (raw: string | undefined): GalleryCursor | null => {
  const [ms, id] = raw?.split(".") ?? [];
  const createdAtMs = Number(ms);
  const videoId = decodeVideoId(id);
  return Number.isFinite(createdAtMs) && Option.isSome(videoId)
    ? { createdAtMs, id: videoId.value }
    : null;
};

/** Toutes les étapes, `Pending` pour celles qui n'ont pas encore tourné. */
const allSteps = (records: ReadonlyArray<EnrichmentRecord>) =>
  Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      records.find((r) => r.kind === kind)?.status ?? EnrichmentStatus.cases.Pending.make({}),
    ]),
  ) as VideoView["enrichments"];

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
    const videos = yield* Videos;
    const limits = yield* RateLimits;

    const view = Effect.fn("Videos.view")(function* (id: VideoId) {
      // Deux connexions Hyperdrive en parallèle plutôt qu'à la suite.
      const [video, allRecords] = yield* Effect.all([store.getVideo(id), store.enrichments(id)], {
        concurrency: 2,
      });
      // Vidéo expirée ou supprimée : seul son état reste visible, plus son contenu.
      const records = isTerminal(video) ? [] : allRecords;
      const byKind = new Map(records.map((r) => [r.kind, r]));
      // Lecture : URL enregistrées par l'étape `thumbnail` ; sinon (juste après
      // l'encodage, anciennes vidéos), demandées à Stream.
      const saved = Option.flatMap(thumbnailOf(byKind.get("thumbnail")?.result), playbackOf);
      const details =
        video.status._tag !== "Ready"
          ? Option.none()
          : Option.isSome(saved)
            ? saved
            : Option.some(yield* stream.details(video.streamUid));
      const summary = summaryOf(byKind.get("summary")?.result);
      const stored = transcriptOf(byKind.get("transcript")?.result);
      return new VideoView({
        video,
        playback: Option.match(details, {
          onNone: () => null,
          onSome: (d) => ({ hls: d.hls, thumbnail: thumbnailUrl(video, d.thumbnail) }),
        }),
        enrichments: allSteps(records),
        summary: Option.match(summary, { onNone: () => null, onSome: (s) => s.summary }),
        chapters: Option.match(summary, { onNone: () => [], onSome: (s) => s.chapters }),
        language: Option.getOrNull(Option.flatMap(stored, (t) => Option.fromNullishOr(t.language))),
        transcript: Option.getOrElse(
          Option.map(stored, (t) => t.segments),
          () => [],
        ),
        thumbnailSuggestions: Option.getOrElse(
          Option.map(suggestionsOf(byKind.get("suggestions")?.result), (s) => s.times),
          () => [],
        ),
      });
    });

    const requireAdmin = Effect.fn("Videos.requireAdmin")(function* (id: VideoId, key: string) {
      yield* store.checkAdmin(id, yield* keys.hash(key));
    });

    return handlers.handleAll({
      list: ({ query }) =>
        Effect.gen(function* () {
          const q = query.q?.trim() || null;
          const page = yield* store.listPublic({
            cursor: decodeCursor(query.cursor),
            q,
            limit: GALLERY_PAGE_SIZE,
          });
          const last = page.entries.at(-1)?.video;
          // Miniature lue en base ; les vidéos d'avant l'enregistrement de l'URL la
          // demandent encore à Stream (une fois par carte, seulement pour elles).
          const thumbnailFor = (video: Video, enrichments: ReadonlyArray<EnrichmentRecord>) =>
            Option.match(thumbnailOf(enrichments.find((e) => e.kind === "thumbnail")?.result), {
              onSome: (t) => Effect.succeed<string | null>(thumbnailUrl(video, t.url)),
              onNone: () =>
                video.status._tag === "Ready"
                  ? Effect.map(stream.details(video.streamUid), (d) =>
                      thumbnailUrl(video, d.thumbnail),
                    )
                  : Effect.succeed(null),
            });
          const items = yield* Effect.forEach(
            page.entries,
            ({ video, comments, enrichments }) =>
              Effect.map(thumbnailFor(video, enrichments), (thumbnail) => ({
                video,
                comments,
                enrichments: allSteps(enrichments),
                thumbnail,
              })),
            { concurrency: 4 },
          );
          return {
            items,
            nextCursor: page.more && last ? encodeCursor(last) : null,
            total: page.total,
          };
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          yield* limits.check("create", yield* clientKey);
          const id = VideoId.make(crypto.randomUUID());
          const [upload, admin] = yield* Effect.all(
            [stream.createUpload(id, MAX_DURATION_SECONDS, payload.size), keys.generate],
            { concurrency: 2 },
          );
          const video = new Video({
            id,
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
          const video = yield* videos.apply(params.id, events);
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
          return yield* videos.apply(params.id, [{ _tag: "Delete" }]);
        }),

      comments: ({ params }) =>
        Effect.gen(function* () {
          const [video, list] = yield* Effect.all(
            [store.getVideo(params.id), store.comments(params.id)],
            { concurrency: 2 },
          );
          // Vidéo expirée ou supprimée : plus aucun commentaire n'est servi.
          return isTerminal(video) ? [] : list;
        }),

      comment: ({ params, payload }) =>
        Effect.gen(function* () {
          yield* limits.check("comment", yield* clientKey);
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
