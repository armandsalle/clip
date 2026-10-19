import { Layer, ManagedRuntime, Scheduler } from "effect";
import type { OtlpExporter } from "effect/observability";
import { flushTelemetry } from "./Telemetry.ts";
import { HttpRouter, HttpServer } from "effect/http";

// Runtime d'un Worker : construit une fois au chargement du module (recommandation
// Effect pour Workers), avec une seule MemoMap pour tous les points d'entrée (HTTP,
// RPC, Workflow, Queue, email, Cron) afin qu'ils partagent les mêmes services.

/** Workers n'a pas de setImmediate fiable entre requêtes : ordonnanceur synchrone. */
const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));

export const makeWorkerRuntime = <R, E, ET>(
  services: Layer.Layer<R, E>,
  /** `telemetryLayer(...)` : export OTLP des spans et logs (ou rien, sans cible). */
  telemetry: Layer.Layer<OtlpExporter.Flusher, ET>,
) => {
  const memoMap = Layer.makeMemoMapUnsafe();
  const runtime = ManagedRuntime.make(Layer.mergeAll(services, telemetry, SyncScheduler), {
    memoMap,
  });
  /**
   * Gestionnaire `fetch` d'un ensemble de routes, sur les mêmes services (passer les
   * routes déjà munies des services du Worker : `routes.pipe(Layer.provide(services))`).
   */
  const http = <A, EA>(
    routes: Layer.Layer<
      A,
      EA,
      HttpRouter.HttpRouter | Layer.Success<typeof HttpServer.layerServices>
    >,
  ) =>
    HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provide(HttpServer.layerServices),
        Layer.provideMerge(SyncScheduler),
        // Même instance que celle du runtime (MemoMap partagée) : un seul tampon à vider.
        Layer.provideMerge(telemetry),
      ),
      { memoMap },
    );
  /** À passer à `ctx.waitUntil` : envoie les spans et logs avant que l'isolat gèle. */
  const flush = () => runtime.runPromise(flushTelemetry).catch(() => undefined);
  return { runtime, http, flush };
};
