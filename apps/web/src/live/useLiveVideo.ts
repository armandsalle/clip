import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EnrichmentStatus, VideoId } from "@clip/domain";
import type { LiveEvent, VideoView } from "@clip/contract";
import type { Comment } from "@clip/domain";
import { keys } from "../api/queries.ts";
import { needsReload, patchComments, patchView } from "../lib/liveCache.ts";
import { useLive, type Live } from "../live.ts";

export interface LiveVideo extends Live {
  /** États des étapes reçus en direct, y compris celles hors du contrat (emails…). */
  readonly steps: Readonly<Record<string, EnrichmentStatus>>;
  /** Commentaires arrivés en direct (mise en évidence). */
  readonly freshIds: ReadonlySet<string>;
}

/**
 * WebSocket de la page vidéo (Durable Object VideoRoom) branché sur le cache Query :
 * chaque événement patche `video(id)` et `comments(id)` ; la vue complète n'est
 * relue que quand un résultat arrive.
 */
export const useLiveVideo = (id: VideoId, name: string, enabled = true): LiveVideo => {
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState<Record<string, EnrichmentStatus>>({});
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());

  const onEvent = useCallback(
    (event: LiveEvent) => {
      const before = queryClient.getQueryData<VideoView>(keys.video(id));
      if (before) queryClient.setQueryData<VideoView>(keys.video(id), patchView(before, event));
      if (needsReload(event, before))
        void queryClient.invalidateQueries({ queryKey: keys.video(id), exact: true });
      if (event._tag === "Step") setSteps((s) => ({ ...s, [event.kind]: event.status }));
      if (event._tag === "CommentAdded") {
        queryClient.setQueryData<ReadonlyArray<Comment>>(keys.comments(id), (list) =>
          patchComments(list ?? [], event),
        );
        setFreshIds((ids) => new Set(ids).add(event.comment.id));
      }
    },
    [id, queryClient],
  );

  const live = useLive(id, name, onEvent, enabled);
  return { ...live, steps, freshIds };
};
