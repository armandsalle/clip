import { Schema } from "effect";
import { Comment, EnrichmentStatus, Seconds, Video } from "@clip/domain";

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
