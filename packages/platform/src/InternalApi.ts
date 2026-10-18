import { Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import { InternalRpcs } from "@clip/contract";
import { Live } from "./Live.ts";

// Client de la RPC interne (jobs → api), transportée par un service binding : la
// requête ne quitte pas Cloudflare et n'a pas d'URL publique.

/** Chemin servi par l'entrypoint `Internal` d'api. */
export const INTERNAL_RPC_PATH = "/internal/rpc";

export class InternalApi extends Context.Service<
  InternalApi,
  RpcClient.FromGroup<typeof InternalRpcs, RpcClientError.RpcClientError>
>()("@clip/platform/InternalApi") {
  static readonly layer = (binding: Fetcher) =>
    Layer.effect(InternalApi, RpcClient.make(InternalRpcs)).pipe(
      Layer.provide(RpcClient.layerProtocolHttp({ url: `https://api${INTERNAL_RPC_PATH}` })),
      Layer.provide([RpcSerialization.layerJson, FetchHttpClient.layer]),
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
          binding.fetch(input, init)) as typeof globalThis.fetch),
      ),
    );
}

/** Temps réel côté jobs : relayé par api, qui héberge les rooms. */
export const LiveViaApi = Layer.effect(
  Live,
  Effect.map(InternalApi, (api) =>
    Live.of({
      publish: (videoId, event) =>
        api.Publish({ videoId, event }).pipe(
          // Le temps réel est un bonus : une diffusion ratée ne fait pas échouer l'étape.
          Effect.catch((error) => Effect.logWarning("live.publish", error)),
          Effect.withSpan("live.publish", { attributes: { event: event._tag } }),
        ),
    }),
  ),
);
