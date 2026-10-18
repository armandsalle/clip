import { Context, Effect, Layer } from "effect";
import { TooManyRequests } from "@clip/contract";

// Limitation de débit (binding Rate Limiting) : la galerie est publique, chaque
// dépôt coûte de l'encodage Stream et de l'IA.

export type LimitedAction = "create" | "comment";

export class RateLimits extends Context.Service<
  RateLimits,
  { check(action: LimitedAction, key: string): Effect.Effect<void, TooManyRequests> }
>()("@clip/platform/RateLimits") {
  static readonly layer = (limiters: Record<LimitedAction, RateLimit>) =>
    Layer.succeed(
      RateLimits,
      RateLimits.of({
        check: (action, key) =>
          Effect.promise(() => limiters[action].limit({ key: `${action}:${key}` })).pipe(
            Effect.flatMap(({ success }) =>
              success ? Effect.void : Effect.fail(new TooManyRequests({ action })),
            ),
            Effect.withSpan("rateLimit.check", { attributes: { action } }),
          ),
      }),
    );

  static readonly layerUnlimited = Layer.succeed(
    RateLimits,
    RateLimits.of({ check: () => Effect.void }),
  );
}
