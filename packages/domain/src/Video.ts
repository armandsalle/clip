import { Schema } from "effect";

// Identifiants ---------------------------------------------------------------

export const VideoId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("VideoId"));
export type VideoId = typeof VideoId.Type;

export const CommentId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("CommentId"));
export type CommentId = typeof CommentId.Type;

/** Identifiant de la vidéo côté Cloudflare Stream. */
export const StreamUid = Schema.String.pipe(Schema.brand("StreamUid"));
export type StreamUid = typeof StreamUid.Type;

/** Position dans la vidéo, en secondes. */
export const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

// Vidéo ------------------------------------------------------------------------
//
// La vidéo est `Ready` dès qu'elle est lisible. Les enrichissements (IA,
// miniatures) ont chacun leur propre état et ne bloquent jamais la lecture.

export const VideoStatus = Schema.TaggedUnion({
  Uploading: {},
  Encoding: { uploadedAt: Schema.DateTimeUtcFromString },
  Ready: { readyAt: Schema.DateTimeUtcFromString, duration: Seconds },
  Failed: { failedAt: Schema.DateTimeUtcFromString, reason: Schema.String },
  Expired: { expiredAt: Schema.DateTimeUtcFromString },
  Deleted: { deletedAt: Schema.DateTimeUtcFromString },
});
export type VideoStatus = typeof VideoStatus.Type;

export const Thumbnail = Schema.TaggedUnion({
  /** Image extraite par Stream (par défaut au milieu). */
  Auto: {},
  /** Image choisie dans la vidéo. */
  Frame: { time: Seconds },
  /** Image importée par le propriétaire (clé R2). */
  Custom: { key: Schema.String },
});
export type Thumbnail = typeof Thumbnail.Type;

export const Expiry = Schema.Literals(["never", "1d", "7d", "30d"]);
export type Expiry = typeof Expiry.Type;

export class Video extends Schema.Class<Video, { readonly brand: unique symbol }>(
  "@clip/domain/Video",
)({
  id: VideoId,
  streamUid: StreamUid,
  title: Schema.NullOr(Schema.String),
  status: VideoStatus,
  thumbnail: Thumbnail,
  expiry: Expiry,
  createdAt: Schema.DateTimeUtcFromString,
}) {}

export const videoFields = (v: Video) => ({
  id: v.id,
  streamUid: v.streamUid,
  title: v.title,
  status: v.status,
  thumbnail: v.thumbnail,
  expiry: v.expiry,
  createdAt: v.createdAt,
});

// Enrichissements ------------------------------------------------------------

export const EnrichmentKind = Schema.Literals([
  "thumbnail",
  "transcript",
  "summary",
  "suggestions",
  "storyboard",
  "shareCard",
  "index",
]);
export type EnrichmentKind = typeof EnrichmentKind.Type;

export const EnrichmentStatus = Schema.TaggedUnion({
  Pending: {},
  Running: { attempt: Schema.Int },
  Done: { durationMs: Schema.Int },
  Failed: { error: Schema.String, attempts: Schema.Int },
  /** Coupé par un feature flag (ex. IA désactivée). */
  Disabled: {},
});
export type EnrichmentStatus = typeof EnrichmentStatus.Type;

// Erreurs métier -----------------------------------------------------------------

export class VideoNotFound extends Schema.TaggedError<
  VideoNotFound,
  { readonly brand: unique symbol }
>()("VideoNotFound", { id: VideoId }, { httpApiStatus: 404 }) {}

export class VideoNotReady extends Schema.TaggedError<
  VideoNotReady,
  { readonly brand: unique symbol }
>()("VideoNotReady", { status: Schema.String }, { httpApiStatus: 409 }) {}

export class InvalidTransition extends Schema.TaggedError<
  InvalidTransition,
  { readonly brand: unique symbol }
>()("InvalidTransition", { from: Schema.String, event: Schema.String }, { httpApiStatus: 409 }) {}

export class OutOfRange extends Schema.TaggedError<OutOfRange, { readonly brand: unique symbol }>()(
  "OutOfRange",
  { time: Seconds, duration: Seconds },
  { httpApiStatus: 422 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden, { readonly brand: unique symbol }>()(
  "Forbidden",
  {},
  { httpApiStatus: 403 },
) {}
