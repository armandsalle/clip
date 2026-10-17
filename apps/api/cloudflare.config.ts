import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Planche de vignettes (aperçu au survol de la timeline) : ffmpeg hors du Worker.
const storyboard = defineContainer({
  name: "clip-storyboard",
  image: { dockerfile: "./containers/storyboard/Dockerfile" },
});

export default defineConfig(({ mode }) => {
  const name = mode === "production" ? "clip-api" : `clip-api-${mode ?? "dev"}`;
  // Ressources sans simulation locale (Stream, IA, AI Search, Flagship) : activées
  // en production, ou en dev avec CLIP_REMOTE=1 après `cf auth login`. Sinon : faux
  // Stream sur R2 et IA factice.
  const remote = mode === "production" || process.env.CLIP_REMOTE === "1";
  const withContainers = process.env.CLIP_CONTAINERS !== "0";
  // Sous-domaine dédié : l'app, l'envoi d'emails et les réponses par email y vivent,
  // sans toucher à la racine bonjour.pizza.
  const domain = process.env.CLIP_DOMAIN ?? "clip.bonjour.pizza";
  return {
    containers: withContainers ? [storyboard] : [],
    worker: {
      name,
      entrypoint,
      compatibilityDate: "2026-10-15",
      // @effect/sql-pg ouvre ses connexions via node:net.
      compatibilityFlags: ["nodejs_compat"],
      observability: { enabled: true },
      // Production sur clip.bonjour.pizza, previews sur ses sous-domaines.
      ...(mode === "production" && {
        domains: [{ hostname: domain, production: true, previews: true }],
      }),
      // Le front est une SPA servie en static assets ; le Worker garde l'API, le
      // faux Stream local et les médias.
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/dev/*", "/media/*"],
      },
      env: {
        STORE: bindings.text(process.env.CLIP_STORE ?? "memory"),
        REMOTE: bindings.text(remote ? "1" : "0"),
        CHAOS: bindings.text(process.env.CLIP_CHAOS ?? "0"),
        // Vidéo et médias
        STREAM: remote && bindings.stream({ dev: { remote: true } }),
        MEDIA: bindings.r2({ name: `${name}-media` }),
        IMAGES: bindings.images(),
        // Données
        DB: bindings.hyperdrive({
          id: process.env.CLIP_HYPERDRIVE_ID ?? "local",
          dev: {
            connectionString:
              process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/clip",
          },
        }),
        CACHE: bindings.kv(),
        NOTIFICATIONS: bindings.queue({ name: `${name}-notifications` }),
        // IA
        AI: remote && bindings.ai({ dev: { remote: true } }),
        SEARCH: remote && bindings.aiSearch({ name: "clip-transcripts", dev: { remote: true } }),
        // Messagerie et pilotage
        MAIL: bindings.sendEmail({ allowedSenderAddresses: [`notifications@${domain}`] }),
        DOMAIN: bindings.text(domain),
        FLAGS:
          remote &&
          bindings.flagship({ id: process.env.CLIP_FLAGSHIP_APP_ID ?? "", dev: { remote: true } }),
        // Orchestration et temps réel
        PIPELINE: bindings.workflow({
          name: "video-pipeline",
          worker: name,
          exportName: "VideoPipeline",
        }),
        VIDEO_ROOM: bindings.durableObject({ worker: name, exportName: "VideoRoom" }),
        STORYBOARD: bindings.durableObject({ worker: name, exportName: "Storyboard" }),
      },
      exports: {
        VideoRoom: exports.durableObject({ storage: "sqlite" }),
        Storyboard: exports.durableObject({
          storage: "sqlite",
          ...(withContainers && { container: storyboard }),
        }),
        VideoPipeline: exports.workflow({
          name: "video-pipeline",
          defaultRetention: { successRetention: "7 days", errorRetention: "30 days" },
        }),
      },
      triggers: [
        triggers.queue({ name: `${name}-notifications`, maxBatchSize: 10, maxRetries: 5 }),
        // Avec le sous-adressage d'Email Routing, reply+<jeton>@… arrive ici.
        triggers.email({ addresses: [`reply@${domain}`] }),
      ],
    },
  };
});
