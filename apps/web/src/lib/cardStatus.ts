import type { EnrichmentKind, EnrichmentStatus, Video } from "@clip/domain";
import { formatAgo, formatTime } from "../util.ts";

// Ce qu'une carte de la galerie affiche de l'avancement d'une vidéo. Pur et testé :
// la galerie n'a qu'à afficher le résultat.

export interface CardStatus {
  readonly label: string;
  readonly tone: "running" | "retry" | "failed";
}

/** Les étapes que la carte compte (« Transcription 2/5 »). */
const tracked: ReadonlyArray<EnrichmentKind> = [
  "thumbnail",
  "audio",
  "transcript",
  "captions",
  "summary",
];

const names: Partial<Record<EnrichmentKind, string>> = {
  thumbnail: "Miniature",
  audio: "Piste audio",
  transcript: "Transcription",
  captions: "Sous-titres",
  summary: "Résumé",
};

export const cardStatus = (
  video: Video,
  steps: Readonly<Record<EnrichmentKind, EnrichmentStatus>>,
): CardStatus | null => {
  switch (video.status._tag) {
    case "Uploading":
      return { label: "Envoi en cours", tone: "running" };
    case "Encoding":
      return { label: "Encodage", tone: "running" };
    case "Failed":
      return { label: "Échec de l'encodage", tone: "failed" };
    case "Expired":
    case "Deleted":
      return null;
    case "Ready": {
      const running = tracked.find((k) => steps[k]._tag === "Running");
      if (running) {
        const done = tracked.filter((k) => steps[k]._tag === "Done").length;
        return { label: `${names[running]} ${done + 1}/${tracked.length}`, tone: "running" };
      }
      const hd = steps.hd;
      if (hd._tag === "Running") {
        return {
          label:
            hd.progress === undefined
              ? "HD en cours"
              : `HD en cours · ${Math.floor(hd.progress)} %`,
          tone: "retry",
        };
      }
      return null;
    }
  }
};

/** Durée sur la miniature : connue une fois encodée, « – » en cas d'échec. */
export const cardDuration = (video: Video): string | null =>
  video.status._tag === "Ready"
    ? formatTime(video.status.duration)
    : video.status._tag === "Failed"
      ? "–"
      : null;

const plural = (n: number) =>
  n === 0 ? "aucun commentaire" : n === 1 ? "1 commentaire" : `${n} commentaires`;

export const cardMeta = (video: Video, comments: number, now = Date.now()): string =>
  `${formatAgo(new Date(video.createdAt.epochMilliseconds), now)} · ${plural(comments)}`;
