import { assert, layer } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { ClipApi } from "@clip/contract";
import { VideosHandlers } from "../src/http.ts";
import * as Pipeline from "../src/pipeline.ts";
import { TestPlatform } from "./support/layers.ts";

const makeClient = HttpApiTest.groups(ClipApi, ["videos"]);

/** L'IA factice simule une latence : on avance l'horloge de test au lieu d'attendre. */
const withClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("5 seconds");
    return yield* Fiber.join(fiber);
  });

// Tout le pipeline HTTP (encodage, routage, décodage) et la logique du Workflow,
// sans Worker ni base : les bindings sont remplacés par des Layers en mémoire.
layer(
  VideosHandlers.pipe(
    Layer.provideMerge(TestPlatform),
    Layer.provideMerge(HttpServer.layerServices),
  ),
)("Clip", (it) => {
  it.effect("upload → encodage → enrichissements → vue complète", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const created = yield* client.videos.create({
        payload: { email: null, expiry: "7d", size: 1_000_000 },
      });
      assert.strictEqual(created.video.status._tag, "Uploading");

      const id = created.video.id;
      assert.strictEqual(yield* Pipeline.checkEncoding(id), "ready");
      yield* withClock(
        Effect.all([Pipeline.thumbnail(id), Pipeline.suggestions(id), Pipeline.transcript(id)]),
      );
      yield* withClock(Pipeline.summary(id));

      const view = yield* client.videos.get({ params: { id } });
      assert.strictEqual(view.video.status._tag, "Ready");
      assert.strictEqual(view.video.title, "Démo Clip");
      assert.isTrue(view.transcript.length > 0);
      assert.deepStrictEqual(view.thumbnailSuggestions, [24, 60, 96]);
      assert.strictEqual(view.enrichments.summary._tag, "Done");
      assert.strictEqual(view.enrichments.storyboard._tag, "Pending");
    }),
  );

  it.effect("commentaires horodatés, bornés par la durée", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { video } = yield* client.videos.create({
        payload: { email: null, expiry: "never", size: 1_000_000 },
      });
      yield* Pipeline.checkEncoding(video.id);
      yield* client.videos.comment({
        params: { id: video.id },
        payload: { author: "Alice", body: "Joli", time: 42, parentId: null },
      });
      const error = yield* client.videos
        .comment({
          params: { id: video.id },
          payload: { author: "Bob", body: "?", time: 999, parentId: null },
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "OutOfRange");
      const list = yield* client.videos.comments({ params: { id: video.id } });
      assert.deepStrictEqual(
        list.map((c) => c.body),
        ["Joli"],
      );
    }),
  );

  it.effect("seul le secret d'admin permet de modifier", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const created = yield* client.videos.create({
        payload: { email: null, expiry: "7d", size: 1_000_000 },
      });
      yield* Pipeline.checkEncoding(created.video.id);
      const denied = yield* client.videos
        .update({
          params: { id: created.video.id },
          headers: { "x-clip-admin": "faux" },
          payload: { title: "x" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(denied._tag, "Forbidden");
      const updated = yield* client.videos.update({
        params: { id: created.video.id },
        headers: { "x-clip-admin": created.adminKey },
        payload: { title: "Démo", thumbnail: { _tag: "Frame", time: 30 } },
      });
      assert.strictEqual(updated.title, "Démo");
      assert.strictEqual(updated.thumbnail._tag, "Frame");
    }),
  );
});
