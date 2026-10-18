import { queryOptions } from "@tanstack/react-query";
import type { VideoId } from "@clip/domain";
import { call } from "./client.ts";

// Requêtes TanStack Query : clés et fonctions déclarées une fois. Le temps réel
// (WebSocket) met ces entrées à jour directement dans le cache.

export const keys = {
  video: (id: VideoId) => ["video", id] as const,
  comments: (id: VideoId) => ["video", id, "comments"] as const,
};

export const videoQuery = (id: VideoId) =>
  queryOptions({
    queryKey: keys.video(id),
    queryFn: () => call((api) => api.videos.get({ params: { id } })),
  });

export const commentsQuery = (id: VideoId) =>
  queryOptions({
    queryKey: keys.comments(id),
    queryFn: () => call((api) => api.videos.comments({ params: { id } })),
  });
