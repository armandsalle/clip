import { Context, Effect, Exit, Layer, ManagedRuntime, Predicate } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ClipApi } from "@clip/contract";
import { messageFor } from "./errors.ts";

// Client typé dérivé du contrat : les noms d'endpoints, les payloads, les réponses
// et les erreurs viennent de `@clip/contract`, partagé avec clip-api.

export class Api extends Context.Service<Api, HttpApiClient.ForApi<typeof ClipApi>>()(
  "@clip/web/Api",
) {
  static readonly layer = Layer.effect(Api, HttpApiClient.make(ClipApi)).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}

const runtime = ManagedRuntime.make(Api.layer);

/** Erreur d'un appel : son tag (celui du contrat) et le message à afficher. */
export class ApiError extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message);
  }
}

const tagOf = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : undefined;

/**
 * Exécute un appel au client, en Promise (pour TanStack Query) : rejette avec une
 * `ApiError` dont le message vient du mappeur central.
 */
export const call = async <A, E>(f: (api: Api["Service"]) => Effect.Effect<A, E>): Promise<A> => {
  const exit = await runtime.runPromiseExit(Effect.flatMap(Api, f));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = exit.cause.reasons.find((r) => r._tag === "Fail");
  const tag = failure?._tag === "Fail" ? tagOf(failure.error) : undefined;
  throw new ApiError(tag ?? "Unknown", messageFor(tag));
};

/** Message d'une erreur quelconque (rejet de `call`, ou autre). */
export const errorMessage = (error: unknown): string =>
  error instanceof ApiError ? error.message : messageFor(undefined);
