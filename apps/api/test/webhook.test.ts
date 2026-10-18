import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Hex } from "effect/encoding";
import { toVtt } from "../src/pipeline.ts";
import { isReady, verifyStreamWebhook } from "../src/webhook.ts";

const sign = async (secret: string, time: number, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${time}.${body}`));
  return `time=${time},sig1=${Hex.encode(new Uint8Array(sig))}`;
};

describe("webhook Stream", () => {
  const body = JSON.stringify({ uid: "abc", readyToStream: true, status: { state: "ready" } });
  const now = 1_792_300_000;

  it.effect("accepte une signature valide et récente", () =>
    Effect.gen(function* () {
      const header = yield* Effect.promise(() => sign("s3cret", now, body));
      const result = yield* verifyStreamWebhook("s3cret", header, body, now + 10);
      assert.isTrue(Option.isSome(result) && result.value.uid === "abc" && isReady(result.value));
    }),
  );

  it.effect("refuse une mauvaise signature, un vieux message ou un en-tête absent", () =>
    Effect.gen(function* () {
      const header = yield* Effect.promise(() => sign("autre", now, body));
      assert.isTrue(Option.isNone(yield* verifyStreamWebhook("s3cret", header, body, now)));
      const old = yield* Effect.promise(() => sign("s3cret", now - 3600, body));
      assert.isTrue(Option.isNone(yield* verifyStreamWebhook("s3cret", old, body, now)));
      assert.isTrue(Option.isNone(yield* verifyStreamWebhook("s3cret", null, body, now)));
    }),
  );
});

describe("toVtt", () => {
  it.effect("produit un WebVTT avec les intervenants", () =>
    Effect.sync(() => {
      const vtt = toVtt([
        { start: 0, end: 2.5, text: "Bonjour", speaker: 0 },
        { start: 3661.2, end: 3663, text: "Salut", speaker: 1 },
      ]);
      assert.strictEqual(
        vtt,
        "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\n<v Intervenant 1>Bonjour\n\n2\n01:01:01.200 --> 01:01:03.000\n<v Intervenant 2>Salut",
      );
    }),
  );
});
