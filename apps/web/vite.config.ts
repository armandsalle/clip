import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { path } from "@clip/config";
import { apiWorker } from "../api/worker.ts";
import { jobsWorker } from "../jobs/worker.ts";

type AuxiliaryWorker = NonNullable<
  NonNullable<Parameters<typeof cloudflare>[0]>["auxiliaryWorkers"]
>[number];

/**
 * Worker de `cf/config` → Worker auxiliaire du plugin Vite. `cf` ignore les bindings
 * désactivés (`false`), le plugin les refuse : on les retire. Les deux décrivent le
 * même format, mais leurs types viennent de deux paquets distincts (d'où la
 * conversion, limitée à cette frontière d'outillage).
 */
const auxiliary = (
  worker: { readonly env: Record<string, unknown> },
  entrypoint: string,
): AuxiliaryWorker => ({
  config: {
    ...worker,
    entrypoint,
    env: Object.fromEntries(Object.entries(worker.env).filter(([, b]) => b !== false)),
  } as AuxiliaryWorker["config"],
});

// Dev local : un seul `cf dev` lance web (primaire) avec api et jobs en Workers
// auxiliaires : service bindings, Durable Objects, Workflow et Queue entre Workers
// fonctionnent comme en ligne. Chaque Worker se déploie ensuite séparément.
export default defineConfig(({ command, mode }) => ({
  // Dépendances pré-optimisées d'emblée : pas de ré-optimisation (et de double React)
  // en cours de session quand une page charge une nouvelle bibliothèque.
  optimizeDeps: {
    include: [
      "@tanstack/react-form",
      "@tanstack/react-query",
      "@tanstack/react-router",
      "hls.js",
      "tus-js-client",
    ],
  },
  plugins: process.env.VITEST
    ? []
    : [
        react(),
        cloudflare(
          command === "serve"
            ? {
                auxiliaryWorkers: [
                  auxiliary(apiWorker(mode), path("../api/src/index.ts", import.meta.url)),
                  // Pas de Container en local : la planche de vignettes est désactivée.
                  auxiliary(jobsWorker(mode, false), path("../jobs/src/index.ts", import.meta.url)),
                ],
              }
            : {},
        ),
      ],
  run: {
    tasks: {
      dev: { command: "cf dev", cache: false },
      deploy: { command: "cf deploy --mode production", cache: false },
      build: {
        command: "cf build",
        cache: { env: ["CLIP_*", "DATABASE_URL"], input: [{ auto: true }, "!.cloudflare/**"] },
      },
    },
  },
}));
