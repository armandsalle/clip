import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  Comment,
  CommentId,
  InvalidTransition,
  OutOfRange,
  Seconds,
  Video,
  VideoEvent,
  VideoId,
  VideoNotFound,
  VideoNotReady,
  EnrichmentStatus,
} from "@clip/domain";

// Contrat interne entre Workers. api est le seul écrivain des vidéos et des
// commentaires : jobs lui demande d'appliquer un événement plutôt que d'écrire en base.
// Les erreurs sont des Schemas : elles arrivent typées de l'autre côté de la RPC.

/** Événements temps réel (WebSocket de la page vidéo). */
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

/** Message de la Queue `notifications` (api produit, jobs consomme). */
export const CommentNotification = Schema.Struct({ videoId: VideoId, commentId: CommentId });
export type CommentNotification = typeof CommentNotification.Type;

/** Réponse par email refusée : renvoyée à l'expéditeur par Email Routing. */
export class ReplyRejected extends Schema.TaggedError<
  ReplyRejected,
  { readonly brand: unique symbol }
>()("ReplyRejected", { reason: Schema.String }) {}

export const IncomingReply = Schema.Struct({
  to: Schema.String,
  from: Schema.String,
  text: Schema.String,
});
export type IncomingReply = typeof IncomingReply.Type;

/** Refus du domaine, identiques à ceux de l'API publique. */
const CommandError = Schema.Union([VideoNotFound, InvalidTransition, VideoNotReady, OutOfRange]);

export class InternalRpcs extends RpcGroup.make(
  /** Applique un événement du domaine (`decide`), enregistre et diffuse. */
  Rpc.make("ApplyVideoEvent", {
    payload: { videoId: VideoId, event: VideoEvent },
    success: Video,
    error: CommandError,
  }),
  /** Titre proposé par l'IA : appliqué seulement si le propriétaire n'en a pas choisi. */
  Rpc.make("SuggestTitle", {
    payload: { videoId: VideoId, title: Schema.String },
    success: Video,
    error: CommandError,
  }),
  /** Réponse par email du propriétaire, publiée sous le commentaire visé. */
  Rpc.make("AddEmailReply", { payload: IncomingReply, success: Comment, error: ReplyRejected }),
  /** Diffusion temps réel dans la room de la vidéo (VideoRoom, hébergée par api). */
  Rpc.make("Publish", { payload: { videoId: VideoId, event: LiveEvent } }),
) {}
