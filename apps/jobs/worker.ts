import { bindings, defineWorker, defineContainer, exports, triggers } from "cf/config";
import { ACCOUNT_ID, runtime, SECRETS_STORE_ID, settings } from "@clip/config";

/** Planche de vignettes (aperçu au survol de la timeline) : ffmpeg hors du Worker. */
export const storyboard = defineContainer({
  name: "clip-jobs-storyboard",
  image: { dockerfile: "./containers/storyboard/Dockerfile" },
});

export const withContainers = process.env.CLIP_CONTAINERS !== "0";

/**
 * clip-jobs : Workflow du pipeline, consommateur de la Queue, emails entrants, Cron
 * d'expiration. N'écrit jamais l'état d'une vidéo : il le demande à clip-api (RPC).
 */
export const jobsWorker = (mode: string | undefined, containers = withContainers) => {
  const s = settings(mode);
  const name = s.names.jobs;
  return defineWorker({
    name,
    ...runtime,
    workersDev: false,
    env: {
      STORE: bindings.text(s.store),
      REMOTE: bindings.text(s.remote ? "1" : "0"),
      CHAOS: bindings.text(s.chaos),
      // Avec le webhook, l'encodage attend l'événement ; sans, il sonde plus souvent.
      STREAM_WEBHOOK: bindings.text(s.webhook ? "1" : "0"),
      ACCOUNT_ID: bindings.text(ACCOUNT_ID),
      STREAM: s.remote && bindings.stream({ dev: { remote: true } }),
      STREAM_API_TOKEN:
        s.remote &&
        bindings.secretsStoreSecret({ storeId: SECRETS_STORE_ID, secretName: "STREAM_API_TOKEN" }),
      MEDIA: bindings.r2({ name: s.resources.media }),
      DB: bindings.hyperdrive({
        id: s.hyperdriveId,
        dev: {
          connectionString: s.databaseUrl ?? "postgres://postgres:postgres@localhost:5432/clip",
        },
      }),
      AI: s.remote && bindings.ai({ dev: { remote: true } }),
      MAIL: bindings.sendEmail({ allowedSenderAddresses: [`notifications@${s.domain}`] }),
      DOMAIN: bindings.text(s.domain),
      // RPC interne vers clip-api (entrypoint `Internal`).
      API: bindings.worker({ worker: s.names.api, exportName: "Internal" }),
      STORYBOARD: bindings.durableObject({ worker: name, exportName: "Storyboard" }),
    },
    exports: {
      VideoPipeline: exports.workflow({
        name: s.resources.pipeline,
        defaultRetention: { successRetention: "7 days", errorRetention: "30 days" },
      }),
      Storyboard: exports.durableObject({
        storage: "sqlite",
        ...(containers && { container: storyboard }),
      }),
    },
    triggers: [
      triggers.queue({
        name: s.resources.notifications,
        maxBatchSize: 50,
        // Regroupe les commentaires d'une rafale dans un même lot (donc un email).
        maxBatchTimeout: 5,
        maxRetries: 5,
      }),
      // Expiration des vidéos : un balayage toutes les 15 minutes.
      triggers.scheduled({ schedule: "*/15 * * * *" }),
      // Avec le sous-adressage d'Email Routing, reply+<jeton>@… arrive ici.
      ...(s.emailRouting ? [triggers.email({ addresses: [`reply@${s.domain}`] })] : []),
    ],
  });
};
