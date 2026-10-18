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
import { Home } from "./Home.tsx";
import { VideoPage } from "./VideoPage.tsx";

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

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });

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

const routeTree = rootRoute.addChildren([homeRoute, videoRoute, coulissesRoute]);

export const makeRouter = (queryClient: QueryClient) =>
  createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: Home,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
