import { bindings, defineConfig } from "cf/config";
import { runtime, settings } from "@clip/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => {
  const s = settings(mode);
  return {
    worker: {
      name: s.names.web,
      entrypoint,
      ...runtime,
      // Seul Worker exposé : production sur clipshare.dev (previews sur ses
      // sous-domaines), environnement de PR sur pr-<n>.clipshare.dev.
      ...(s.hostname !== null && {
        domains: [{ hostname: s.hostname, production: true, previews: s.production }],
      }),
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/dev/*", "/media/*"],
      },
      env: { API: bindings.worker({ worker: s.names.api }) },
    },
  };
});
