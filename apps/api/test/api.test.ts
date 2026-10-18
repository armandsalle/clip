import { assert, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { ClipApi } from "@clip/contract";
import type { VideoId } from "@clip/domain";
import { queued, TestPlatform } from "@clip/testing";
import { VideosHandlers } from "../src/http.ts";
import { Videos } from "../src/Videos.ts";

const makeClient = HttpApiTest.groups(ClipApi, ["videos"]);

/** Ce que fait jobs quand Stream a fini d'encoder (via la RPC `ApplyVideoEvent`). */
const encoded = (id: VideoId) =>
  Videos.use((v) => v.apply(id, [{ _tag: "Encoded", duration: 120 }]));

// Toute l'API HTTP (encodage, routage, décodage), sans Worker ni base : les bindings
// sont remplacés par des Layers en mémoire. Le pipeline est testé dans apps/jobs.
layer(
  VideosHandlers.pipe(
    Layer.provideMerge(Videos.layer),
    Layer.provideMerge(TestPlatform),
    Layer.provideMerge(HttpServer.layerServices),
  ),
)("Clip", (it) => {
  it.effect("commentaires horodatés, bornés par la durée", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { video } = yield* client.videos.create({
        payload: { email: null, expiry: "never", size: 1_000_000 },
      });
      yield* encoded(video.id);
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
      yield* encoded(created.video.id);
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

  it.effect("un commentaire part dans la file des notifications", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { video } = yield* client.videos.create({
        payload: { email: "owner@example.com", expiry: "7d", size: 1_000_000 },
      });
      yield* encoded(video.id);
      const before = queued.length;
      const comment = yield* client.videos.comment({
        params: { id: video.id },
        payload: { author: "Alice", body: "Bravo", time: 5, parentId: null },
      });
      assert.deepStrictEqual(queued.slice(before), [{ videoId: video.id, commentId: comment.id }]);
    }),
  );

  it.effect("supprimée, une vidéo n'accepte plus de changement", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const created = yield* client.videos.create({
        payload: { email: null, expiry: "7d", size: 1_000_000 },
      });
      const headers = { "x-clip-admin": created.adminKey };
      const removed = yield* client.videos.remove({ params: { id: created.video.id }, headers });
      assert.strictEqual(removed.status._tag, "Deleted");
      const error = yield* encoded(created.video.id).pipe(Effect.flip);
      assert.strictEqual(error._tag, "InvalidTransition");
    }),
  );

  it.effect("la galerie liste les vidéos visibles, plus récentes d'abord", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const before = yield* client.videos.list({ query: {} });
      // Les autres tests créent leurs vidéos à l'instant 0 de l'horloge de test.
      yield* TestClock.adjust("1 hour");
      const a = yield* client.videos.create({
        payload: { email: null, expiry: "7d", size: 1_000_000 },
      });
      yield* TestClock.adjust("1 second");
      const b = yield* client.videos.create({
        payload: { email: null, expiry: "7d", size: 1_000_000 },
      });
      yield* client.videos.update({
        params: { id: b.video.id },
        headers: { "x-clip-admin": b.adminKey },
        payload: { title: "Revue de sprint" },
      });
      const page = yield* client.videos.list({ query: {} });
      assert.strictEqual(page.total, before.total + 2);
      assert.deepStrictEqual(
        page.items.slice(0, 2).map((i) => i.video.id),
        [b.video.id, a.video.id],
      );
      assert.strictEqual(page.items[0]!.enrichments.transcript._tag, "Pending");
      const found = yield* client.videos.list({ query: { q: "sprint" } });
      assert.deepStrictEqual(
        found.items.map((i) => i.video.id),
        [b.video.id],
      );
      yield* client.videos.remove({
        params: { id: a.video.id },
        headers: { "x-clip-admin": a.adminKey },
      });
      const after = yield* client.videos.list({ query: {} });
      assert.isFalse(after.items.some((i) => i.video.id === a.video.id));
    }),
  );
});
