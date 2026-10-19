import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpExporter, OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";

// Export des spans et logs Effect en OTLP (une seule Layer pour les trois Workers).
// Cible configurable : PostHog d'abord (traces en alpha, logs), Sentry prévu en option.
// Sans cible, la Layer ne fait rien : aucun coût, rien à configurer en dev.

export type TelemetryTarget =
  | {
      readonly kind: "posthog";
      /** Hôte d'ingestion, ex. `https://us.i.posthog.com` ou `https://eu.i.posthog.com`. */
      readonly host: string;
      /** Token du projet (`phc_…`), lu dans le Secrets Store au premier envoi. */
      readonly token: () => Promise<string>;
    }
  | {
      readonly kind: "sentry";
      /** Base OTLP du projet : `https://o<org>.ingest.<region>.sentry.io/api/<projet>/integration/otlp`. */
      readonly base: string;
      /** Clé publique du projet (en-tête `x-sentry-auth`). */
      readonly publicKey: () => Promise<string>;
    };

const endpoints = Effect.fnUntraced(function* (target: TelemetryTarget) {
  switch (target.kind) {
    case "posthog": {
      const token = yield* Effect.promise(target.token);
      return {
        traces: `${target.host}/i/v1/traces`,
        logs: `${target.host}/i/v1/logs`,
        headers: { authorization: `Bearer ${token}` },
      };
    }
    case "sentry": {
      const key = yield* Effect.promise(target.publicKey);
      return {
        traces: `${target.base}/v1/traces`,
        logs: `${target.base}/v1/logs`,
        headers: { "x-sentry-auth": `sentry sentry_key=${key}` },
      };
    }
  }
});

/**
 * Traces et logs Effect vers la cible, plus le `Flusher` : sur Workers l'isolat peut
 * geler dès la réponse envoyée, chaque point d'entrée vide donc le tampon dans
 * `ctx.waitUntil` (voir `makeWorkerRuntime`).
 */
export const telemetryLayer = (options: {
  readonly service: string;
  readonly environment: string;
  readonly target: TelemetryTarget | null;
}) => {
  const { target } = options;
  if (target === null) return OtlpExporter.layerFlusher;
  const resource = {
    serviceName: options.service,
    attributes: { "deployment.environment": options.environment },
  };
  // Construite à la demande (dans un handler) : le secret ne se lit pas au chargement.
  return Layer.unwrap(
    Effect.map(endpoints(target), ({ traces, logs, headers }) =>
      Layer.mergeAll(
        OtlpTracer.layer({ url: traces, headers, resource }),
        OtlpLogger.layer({ url: logs, headers, resource }),
      ),
    ),
  ).pipe(
    Layer.provideMerge(OtlpExporter.layerFlusher),
    Layer.provide([OtlpSerialization.layerJson, FetchHttpClient.layer]),
  );
};

/** Vide les spans et logs en attente (à passer à `ctx.waitUntil`). */
export const flushTelemetry = OtlpExporter.Flusher.use((flusher) => flusher.flush);

/** Cible PostHog si l'hôte et le token sont liés au Worker, sinon aucune. */
export const posthogTarget = (env: {
  readonly host: string | undefined;
  readonly token: SecretsStoreSecret | undefined;
}): TelemetryTarget | null => {
  const { host, token } = env;
  return host && token ? { kind: "posthog", host, token: () => token.get() } : null;
};
