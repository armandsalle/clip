import { Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";

// Webhook Stream : `Webhook-Signature: time=<unix>,sig1=<hex>`, où sig1 est le
// HMAC-SHA256 de `<time>.<corps brut>` avec le secret renvoyé à l'enregistrement.

const MAX_AGE_SECONDS = 5 * 60;

const StreamNotification = Schema.Struct({
  uid: Schema.String,
  /** Environnement propriétaire (`clip-production`, `clip-pr-12`…), posé à la création. */
  creator: Schema.optionalKey(Schema.NullOr(Schema.String)),
  readyToStream: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.Struct({ state: Schema.optionalKey(Schema.String) })),
});
export type StreamNotification = typeof StreamNotification.Type;

const hmacHex = (secret: string, message: string) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return Hex.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
    );
  });

/** Comparaison à temps constant (pas de fuite par la durée de comparaison). */
const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Vérifie la signature et l'âge, puis décode la notification ; `None` si invalide. */
export const verifyStreamWebhook = Effect.fn("webhook.verify")(function* (
  secret: string,
  header: string | null,
  body: string,
  nowSeconds: number,
) {
  const parts = Object.fromEntries(
    (header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const time = Number(parts["time"]);
  const signature = parts["sig1"];
  if (!Number.isFinite(time) || !signature) return Option.none<StreamNotification>();
  if (Math.abs(nowSeconds - time) > MAX_AGE_SECONDS) return Option.none<StreamNotification>();
  const expected = yield* hmacHex(secret, `${parts["time"]}.${body}`);
  if (!timingSafeEqual(expected, signature)) return Option.none<StreamNotification>();
  return Schema.decodeOption(Schema.fromJsonString(StreamNotification))(body);
});

export const isReady = (n: StreamNotification) =>
  n.readyToStream === true || n.status?.state === "ready" || n.status?.state === "error";
