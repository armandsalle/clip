import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, EnrichmentStatus, VideoId } from "@clip/domain";
import type { LiveEvent, VideoView } from "@clip/contract";
import { call, errorMessage } from "./api/client.ts";
import { useLive, type Live } from "./live.ts";
import { viewerName } from "./util.ts";

export interface VideoData {
  readonly view: VideoView | null;
  readonly error: string | null;
  readonly comments: ReadonlyArray<Comment>;
  /** Commentaires arrivés en direct (pour les mettre en évidence). */
  readonly freshIds: ReadonlySet<string>;
  /** État des étapes : celui de la vue, mis à jour en direct par les événements `Step`. */
  readonly steps: Readonly<Record<string, EnrichmentStatus>>;
  readonly live: Live;
  readonly reload: () => void;
}

/**
 * Données d'une page vidéo : la vue (contrat `VideoView`), les commentaires, et le
 * flux temps réel du Durable Object. Les événements mettent l'écran à jour
 * immédiatement ; la vue complète est rechargée quand la vidéo ou une étape change.
 */
export const useVideo = (id: VideoId): VideoData => {
  const [view, setView] = useState<VideoView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<ReadonlyArray<Comment>>([]);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [liveSteps, setLiveSteps] = useState<Record<string, EnrichmentStatus>>({});
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(() => {
    call((api) => api.videos.get({ params: { id } }))
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [id]);

  const reload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(load, 250);
  }, [load]);

  useEffect(() => {
    load();
    call((api) => api.videos.comments({ params: { id } }))
      .then(setComments)
      .catch(() => undefined);
    return () => clearTimeout(reloadTimer.current);
  }, [id, load]);

  const onEvent = useCallback(
    (event: LiveEvent) => {
      switch (event._tag) {
        case "Step":
          setLiveSteps((s) => ({ ...s, [event.kind]: event.status }));
          if (event.status._tag !== "Running") reload();
          return;
        case "VideoChanged":
          reload();
          return;
        case "CommentAdded":
          setComments((list) =>
            list.some((c) => c.id === event.comment.id) ? list : [...list, event.comment],
          );
          setFreshIds((ids) => new Set(ids).add(event.comment.id));
          return;
        case "Presence":
          return;
      }
    },
    [reload],
  );

  const live = useLive(id, viewerName() ?? "Anonyme", onEvent);

  const steps: Record<string, EnrichmentStatus> = { ...view?.enrichments, ...liveSteps };
  return { view, error, comments, freshIds, steps, live, reload };
};
