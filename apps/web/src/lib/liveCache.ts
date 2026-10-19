import type { Comment } from "@clip/domain";
import { EnrichmentKind } from "@clip/domain";
import { VideoView, type LiveEvent } from "@clip/contract";

// Le temps réel met le cache TanStack Query à jour (plus d'état parallèle) : fonctions
// pures, testées, appliquées par `useLiveVideo`.

const isKind = (kind: string): kind is EnrichmentKind =>
  (EnrichmentKind.literals as ReadonlyArray<string>).includes(kind);

/** Étapes dont le résultat change la vue (texte, chapitres, miniatures…). */
const resultKinds: ReadonlyArray<string> = [
  "transcript",
  "summary",
  "captions",
  "suggestions",
  "thumbnail",
];

export const patchView = (view: VideoView, event: LiveEvent): VideoView => {
  switch (event._tag) {
    case "VideoChanged":
      return new VideoView({ ...view, video: event.video });
    case "Step":
      return isKind(event.kind)
        ? new VideoView({
            ...view,
            enrichments: { ...view.enrichments, [event.kind]: event.status },
          })
        : view;
    default:
      return view;
  }
};

export const patchComments = (
  comments: ReadonlyArray<Comment>,
  event: LiveEvent,
): ReadonlyArray<Comment> =>
  event._tag === "CommentAdded" && !comments.some((c) => c.id === event.comment.id)
    ? [...comments, event.comment]
    : comments;

/** La vue complète doit être relue : un résultat est arrivé, ou la vidéo devient lisible. */
export const needsReload = (event: LiveEvent, before: VideoView | undefined): boolean => {
  if (event._tag === "Step")
    return event.status._tag === "Done" && resultKinds.includes(event.kind);
  if (event._tag === "VideoChanged") return before?.video.status._tag !== event.video.status._tag;
  return false;
};
