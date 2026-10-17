import { Context, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ClipApi } from "@clip/contract";

// Client typé dérivé du contrat : les noms d'endpoints, les payloads, les réponses
// et les erreurs viennent de `@clip/contract`, partagé avec le Worker.

export class Api extends Context.Service<Api, HttpApiClient.ForApi<typeof ClipApi>>()(
  "@clip/web/Api",
) {
  static readonly layer = Layer.effect(Api, HttpApiClient.make(ClipApi)).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}

const runtime = ManagedRuntime.make(Api.layer);

/** Erreur lisible, à afficher telle quelle. */
export class CallError extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message);
  }
}

const messages: Record<string, string> = {
  VideoNotFound: "Cette vidéo n'existe pas ou n'est plus disponible.",
  Forbidden: "Ce lien d'admin n'est pas valide pour cette vidéo.",
  VideoNotReady: "La vidéo n'est pas encore prête.",
  OutOfRange: "Ce moment n'existe pas dans la vidéo.",
  InvalidTransition: "Action impossible dans l'état actuel de la vidéo.",
};

/** Exécute un appel au client et rejette avec une `CallError` lisible. */
export const call = async <A, E>(f: (api: Api["Service"]) => Effect.Effect<A, E>): Promise<A> => {
  const exit = await runtime.runPromiseExit(Effect.flatMap(Api, f));
  if (Exit.isSuccess(exit)) return exit.value;
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error as
    | { _tag?: string; message?: string }
    | undefined;
  const tag = error?._tag ?? "Unknown";
  throw new CallError(tag, messages[tag] ?? error?.message ?? "Une erreur est survenue.");
};
