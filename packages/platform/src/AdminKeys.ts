import { Context, Effect, Layer } from "effect";
import { Base64Url, Hex } from "effect/encoding";

// Secrets d'admin -------------------------------------------------------------------

export class AdminKeys extends Context.Service<
  AdminKeys,
  {
    readonly generate: Effect.Effect<{ readonly key: string; readonly hash: string }>;
    hash(key: string): Effect.Effect<string>;
  }
>()("@clip/api/AdminKeys") {
  static readonly layer = Layer.sync(AdminKeys, () => {
    const hash = (key: string) =>
      Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).pipe(
        Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
      );
    return AdminKeys.of({
      hash,
      generate: Effect.gen(function* () {
        const key = Base64Url.encode(crypto.getRandomValues(new Uint8Array(24)));
        return { key, hash: yield* hash(key) };
      }),
    });
  });
}
