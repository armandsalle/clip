import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ApiError } from "./api/client.ts";
import { isApiErrorTag } from "./api/errors.ts";
import { makeRouter } from "./router.tsx";
import "./styles/tokens.css";
import "./ui/ui.css";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    // Le temps réel met le cache à jour : pas besoin de recharger au retour sur l'onglet.
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Une erreur du contrat (vidéo introuvable…) est une réponse : on ne réessaie que
      // les pannes (réseau, 5xx).
      retry: (count, error) =>
        count < 2 && !(error instanceof ApiError && isApiErrorTag(error.tag)),
    },
  },
});
const router = makeRouter(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
