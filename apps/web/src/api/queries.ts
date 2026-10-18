import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { VideoId } from "@clip/domain";
import type { NewComment, UpdateVideo } from "@clip/contract";
import { call } from "./client.ts";

// Requêtes TanStack Query : clés et fonctions déclarées une fois. Le temps réel
// (WebSocket) met ces entrées à jour directement dans le cache.

export const keys = {
  gallery: (q: string) => ["gallery", q] as const,
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

/** Galerie paginée par curseur ; `q` vide = toutes les vidéos. */
export const galleryQuery = (q: string) =>
  infiniteQueryOptions({
    queryKey: keys.gallery(q),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      call((api) =>
        api.videos.list({
          query: { ...(pageParam === null ? {} : { cursor: pageParam }), ...(q ? { q } : {}) },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor,
  });

/** Mise à jour d'une vidéo par son propriétaire (secret d'admin). */
export const updateVideo = (id: VideoId, adminKey: string, payload: typeof UpdateVideo.Type) =>
  call((api) =>
    api.videos.update({ params: { id }, headers: { "x-clip-admin": adminKey }, payload }),
  );

export const removeVideo = (id: VideoId, adminKey: string) =>
  call((api) => api.videos.remove({ params: { id }, headers: { "x-clip-admin": adminKey } }));

export const postComment = (id: VideoId, payload: typeof NewComment.Type) =>
  call((api) => api.videos.comment({ params: { id }, payload }));
