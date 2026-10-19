import { bindings, defineWorker, triggers } from "cf/config";
import { resourceNames, runtime, SECRETS_STORE_ID, settings, workersDevUrl } from "@clip/config";

/**
 * clip-hooks : reçoit le webhook Stream du compte (un seul par compte) et le livre à
 * l'environnement propriétaire de la vidéo, d'après son créateur Stream : production
 * par service binding, PR par l'URL workers.dev de son clip-web. Déployé une fois, en
 * production, sur une route qui passe avant le domaine de clip-web : l'URL enregistrée
 * chez Stream (`https://clipshare.dev/api/stream/webhook`) ne change pas.
 */
export const hooksWorker = (mode: string | undefined) => {
  const s = settings(mode);
  return defineWorker({
    name: "clip-hooks",
    ...runtime,
    workersDev: false,
    env: {
      STREAM_WEBHOOK_SECRET: bindings.secretsStoreSecret({
        storeId: SECRETS_STORE_ID,
        secretName: "STREAM_WEBHOOK_SECRET",
      }),
      API: bindings.worker({ worker: resourceNames("production").workers.api }),
      // `{mode}` remplacé par `pr-<n>` : clip-web de la PR, hors du Bot Fight Mode de la zone.
      PREVIEW_WEBHOOK_URL: bindings.text(
        `${workersDevUrl(resourceNames("{mode}").workers.web)}/api/stream/webhook`,
      ),
    },
    triggers: [triggers.fetch({ pattern: `${s.domain}/api/stream/webhook`, zone: s.domain })],
  });
};
