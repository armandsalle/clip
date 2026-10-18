import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { makeRouter } from "./router.tsx";
import "./styles/tokens.css";
import "./ui/ui.css";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    // Le temps réel met le cache à jour : pas besoin de recharger au retour sur l'onglet.
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
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
