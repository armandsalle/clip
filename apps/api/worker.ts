import { bindings, defineWorker, exports } from "cf/config";
import { ACCOUNT_ID, runtime, SECRETS_STORE_ID, settings } from "@clip/config";

/**
 * clip-api : API publique (derrière clip-web), RPC interne, rooms temps réel. Pas de
 * domaine ni de workers.dev : on n'y entre que par service binding.
 * Partagé entre `cloudflare.config.ts` (déploiement) et le dev local multi-Workers.
 */
export const apiWorker = (mode: string | undefined) => {
  const s = settings(mode);
  const name = s.names.api;
  return defineWorker({
    name,
    ...runtime,
    workersDev: false,
    env: {
      STORE: bindings.text(s.store),
      REMOTE: bindings.text(s.remote ? "1" : "0"),
      ACCOUNT_ID: bindings.text(ACCOUNT_ID),
      // Observabilité : export OTLP des spans et logs Effect (PostHog), si configuré.
      ENVIRONMENT: bindings.text(s.mode),
      POSTHOG_HOST: !!s.posthogHost && bindings.text(s.posthogHost),
      POSTHOG_PROJECT_TOKEN:
        !!s.posthogHost &&
        bindings.secretsStoreSecret({
          storeId: SECRETS_STORE_ID,
          secretName: "POSTHOG_PROJECT_TOKEN",
        }),
      // Vidéo et médias. Token API Stream (Stream:Edit) pour l'upload tus, rangé une
      // fois dans le Secrets Store du compte ; en local, copie locale (`--local`).
      STREAM: s.remote && bindings.stream({ dev: { remote: true } }),
      STREAM_API_TOKEN:
        s.remote &&
        bindings.secretsStoreSecret({ storeId: SECRETS_STORE_ID, secretName: "STREAM_API_TOKEN" }),
      // Secret de signature du webhook Stream (unique par compte → production seulement).
      STREAM_WEBHOOK_SECRET:
        s.webhook &&
        bindings.secretsStoreSecret({
          storeId: SECRETS_STORE_ID,
          secretName: "STREAM_WEBHOOK_SECRET",
        }),
      MEDIA: bindings.r2({ name: s.resources.media }),
      DB: bindings.hyperdrive({
        id: s.hyperdriveId,
        dev: {
          connectionString: s.databaseUrl ?? "postgres://postgres:postgres@localhost:5432/clip",
        },
      }),
      // Vers clip-jobs : démarrage du pipeline et notifications de commentaires.
      PIPELINE: bindings.workflow({
        name: s.resources.pipeline,
        worker: s.names.jobs,
        exportName: "VideoPipeline",
      }),
      NOTIFICATIONS: bindings.queue({ name: s.resources.notifications }),
      VIDEO_ROOM: bindings.durableObject({ worker: name, exportName: "VideoRoom" }),
      // Garde-fous de coût : par adresse, sur une minute.
      CREATE_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 10, period: 60 } }),
      COMMENT_LIMIT: bindings.rateLimit({ namespace: "1002", simple: { limit: 30, period: 60 } }),
    },
    exports: {
      VideoRoom: exports.durableObject({ storage: "sqlite" }),
      Internal: exports.worker(),
      // La planche de vignettes a déménagé dans clip-jobs (namespace historique de la prod).
      ...(s.production && { Storyboard: exports.durableObject({ state: "deleted" }) }),
    },
  });
};
