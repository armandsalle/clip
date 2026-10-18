import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { VideoId } from "@clip/domain";
import { Coulisses } from "./Coulisses.tsx";
import { Gallery } from "./routes/Gallery.tsx";
import { Upload } from "./routes/Upload.tsx";
import { VideoPage } from "./routes/video/VideoPage.tsx";

// Routes déclarées en code, typées de bout en bout. Les paramètres sont validés par
// les Schemas du domaine : un identifiant invalide donne la page « introuvable ».

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

const decodeVideoId = Schema.decodeUnknownOption(VideoId);
const videoParams = {
  parse: (raw: { id: string }) =>
    Option.match(decodeVideoId(raw.id), {
      onNone: () => {
        throw notFound();
      },
      onSome: (id) => ({ id }),
    }),
  stringify: ({ id }: { id: VideoId }) => ({ id }),
};

/** `?q=` : recherche de la galerie, partageable. */
const GallerySearch = Schema.Struct({ q: Schema.optionalKey(Schema.String) });

const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: Schema.toStandardSchemaV1(GallerySearch),
  component: function GalleryRoute() {
    const { q = "" } = galleryRoute.useSearch();
    const navigate = galleryRoute.useNavigate();
    return (
      <Gallery
        q={q}
        onSearch={(next) =>
          void navigate({ search: next.trim() ? { q: next.trim() } : {}, replace: true })
        }
      />
    );
  },
});

/** Dépôt façon Smash : Fichier → Email (obligatoire) → Envoi. */
const uploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upload",
  component: Upload,
});

const videoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/v/$id",
  params: videoParams,
  component: function VideoRoute() {
    const { id } = videoRoute.useParams();
    return <VideoPage key={id} id={id} />;
  },
});

const coulissesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/v/$id/coulisses",
  params: videoParams,
  component: function CoulissesRoute() {
    const { id } = coulissesRoute.useParams();
    return <Coulisses key={id} id={id} />;
  },
});

const routeTree = rootRoute.addChildren([galleryRoute, uploadRoute, videoRoute, coulissesRoute]);

export const makeRouter = (queryClient: QueryClient) =>
  createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: function NotFound() {
      return <Gallery q="" onSearch={() => undefined} />;
    },
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
