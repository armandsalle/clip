import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { verifyStreamWebhook } from "@clip/platform";

// Routeur du webhook Stream : vérifie la signature, lit le créateur de la vidéo
// (`clip-production`, `clip-pr-12`…, posé à la création du dépôt) et relaie la requête
// telle quelle (corps et signature) à cet environnement, qui la vérifie à son tour.

/**
 * Environnement d'un créateur Stream (même règle que `modeOfStreamCreator` de
 * @clip/config, qui lit le système de fichiers et reste hors des Workers).
 * Sans créateur : vidéo d'avant l'étiquetage (prod).
 */
const modeOf = (creator: string | null | undefined): string | null => {
  if (!creator) return "production";
  return /^clip-(production|staging|pr-\d+)$/.exec(creator)?.[1] ?? null;
};

export default {
  async fetch(request) {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const body = await request.text();
    const signature = request.headers.get("webhook-signature");
    const notification = await Effect.runPromise(
      verifyStreamWebhook(
        await env.STREAM_WEBHOOK_SECRET.get(),
        signature,
        body,
        Math.floor(Date.now() / 1000),
      ),
    );
    if (Option.isNone(notification)) return new Response("signature invalide", { status: 401 });

    const { uid, creator } = notification.value;
    const mode = modeOf(creator);
    if (mode === null) {
      // clip-dev (CLIP_REMOTE=1 en local) : Stream ne peut pas joindre localhost.
      console.log(JSON.stringify({ message: "webhook.ignored", uid, creator }));
      return new Response(null, { status: 204 });
    }
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-signature": signature ?? "" },
      body,
    };
    const response =
      mode === "production"
        ? await env.API.fetch("https://clip-api/api/stream/webhook", init)
        : mode === "staging"
          ? await env.API_STAGING.fetch("https://clip-api/api/stream/webhook", init)
          : await fetch(env.PREVIEW_WEBHOOK_URL.replace("{mode}", mode), init);
    console.log(
      JSON.stringify({ message: "webhook.forwarded", uid, mode, status: response.status }),
    );
    // Échec en aval : Stream retentera ; le pipeline sonde aussi l'encodage en secours.
    return new Response(null, { status: response.ok ? 204 : 502 });
  },
} satisfies ExportedHandler<Env>;
