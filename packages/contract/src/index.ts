import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AuthorName,
  Comment,
  CommentBody,
  CommentId,
  EnrichmentKind,
  EnrichmentStatus,
  Expiry,
  Forbidden,
  InvalidTransition,
  OutOfRange,
  Seconds,
  Thumbnail,
  Video,
  VideoId,
  VideoNotFound,
  VideoNotReady,
} from "@clip/domain";

// Contrat partagé entre le Worker et le front : le client typé en est dérivé.

/** Lien d'admin : envoyé dans l'en-tête `x-clip-admin`. */
const AdminHeaders = { "x-clip-admin": Schema.String };

export const TranscriptSegment = Schema.Struct({
  start: Seconds,
  end: Seconds,
  text: Schema.String,
});

export const Chapter = Schema.Struct({ time: Seconds, title: Schema.String });

/** Ce que voit la page vidéo : la vidéo, ses lectures et l'avancement du pipeline. */
export class VideoView extends Schema.Class<VideoView, { readonly brand: unique symbol }>(
  "@clip/contract/VideoView",
)({
  video: Video,
  playback: Schema.NullOr(Schema.Struct({ hls: Schema.String, thumbnail: Schema.String })),
  enrichments: Schema.Record(EnrichmentKind, EnrichmentStatus),
  summary: Schema.NullOr(Schema.String),
  chapters: Schema.Array(Chapter),
  transcript: Schema.Array(TranscriptSegment),
  thumbnailSuggestions: Schema.Array(Seconds),
}) {}

export const CreateVideo = Schema.Struct({
  email: Schema.NullOr(Schema.String),
  expiry: Expiry,
  /** Taille du fichier en octets : l'upload tus de Stream l'exige à la création. */
  size: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** `tus` : Cloudflare Stream, par morceaux et reprenable ; `put` : faux Stream local. */
export const UploadProtocol = Schema.Literals(["tus", "put"]);

export const VideoCreated = Schema.Struct({
  video: Video,
  /** URL d'upload direct (Cloudflare Stream, ou faux Stream en local). */
  uploadUrl: Schema.String,
  uploadProtocol: UploadProtocol,
  /** Secret d'admin, montré une seule fois. */
  adminKey: Schema.String,
});

export const UpdateVideo = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  thumbnail: Schema.optionalKey(Thumbnail),
  expiry: Schema.optionalKey(Expiry),
  /** Email du propriétaire (notifications, réponses par email) ; `null` l'efface. */
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const NewComment = Schema.Struct({
  author: AuthorName,
  body: CommentBody,
  time: Seconds,
  parentId: Schema.NullOr(CommentId),
});

const CommandErrors = [VideoNotFound, Forbidden, InvalidTransition, VideoNotReady, OutOfRange];

export class VideosGroup extends HttpApiGroup.make("videos")
  .add(
    HttpApiEndpoint.post("create", "/", { payload: CreateVideo, success: VideoCreated }),
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: VideoId },
      success: VideoView,
      error: VideoNotFound,
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: VideoId },
      headers: AdminHeaders,
      payload: UpdateVideo,
      success: Video,
      error: CommandErrors,
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: VideoId },
      headers: AdminHeaders,
      success: Video,
      error: CommandErrors,
    }),
    HttpApiEndpoint.get("comments", "/:id/comments", {
      params: { id: VideoId },
      success: Schema.Array(Comment),
      error: VideoNotFound,
    }),
    HttpApiEndpoint.post("comment", "/:id/comments", {
      params: { id: VideoId },
      payload: NewComment,
      success: Comment,
      error: CommandErrors,
    }),
  )
  .prefix("/videos") {}

export class SystemGroup extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/health", { success: Schema.Struct({ ok: Schema.Boolean }) }),
) {}

export class ClipApi extends HttpApi.make("clip")
  .add(VideosGroup)
  .add(SystemGroup)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "Clip API" })) {}

// Événements temps réel (WebSocket de la page vidéo) ---------------------------

export const LiveEvent = Schema.TaggedUnion({
  /** Une étape du pipeline (ou un span Effect) change d'état. */
  Step: {
    kind: Schema.String,
    status: EnrichmentStatus,
    at: Schema.DateTimeUtcFromString,
  },
  VideoChanged: { video: Video },
  CommentAdded: { comment: Comment },
  Presence: {
    viewers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, time: Seconds })),
  },
});
export type LiveEvent = typeof LiveEvent.Type;
