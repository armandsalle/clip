import { bindings, defineConfig } from "cf/config";
import { resourceNames, runtime, settings, STAGING } from "@clip/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

export default defineConfig(({ mode, isPreview }) => {
  const s = settings(mode);
  return {
    worker: {
      name: s.names.web,
      entrypoint,
      ...runtime,
      // Seul Worker exposé : production sur clipshare.dev, ses Previews (staging, PR
      // d'interface) sur <nom>.clipshare.dev, environnement de PR complet sur
      // pr-<n>.clipshare.dev.
      ...(s.hostname !== null && {
        domains: [{ hostname: s.hostname, production: true, previews: s.production }],
      }),
      // En PR, aussi sur workers.dev : la CI (IP de datacenter) y passe, alors que le
      // Bot Fight Mode de clipshare.dev la bloque (403) sur pr-<n>.clipshare.dev.
      ...(s.preview && { workersDev: true }),
      // Previews aussi sur <nom>-clip-web.<compte>.workers.dev, pour la même raison.
      ...(s.production && { previewUrls: true }),
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/dev/*", "/media/*"],
      },
      // Une Preview (staging, PR d'interface) ne touche jamais la prod : elle parle au
      // staging, qui a sa propre base, sa Queue et son Workflow.
      env: {
        API: bindings.worker({
          worker: isPreview ? resourceNames(STAGING).workers.api : s.names.api,
        }),
      },
    },
  };
});
