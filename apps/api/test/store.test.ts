import { assert, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import {
  Comment,
  CommentId,
  EnrichmentStatus,
  StreamUid,
  Thumbnail,
  Video,
  VideoId,
  VideoStatus,
} from "@clip/domain";
import { Store } from "../src/Store.ts";
import { DbPglite } from "./support/pglite.ts";

const now = DateTime.makeUnsafe("2026-10-17T10:00:00Z");
const video = new Video({
  id: VideoId.make("019a0000-0000-7000-8000-0000000000a1"),
  streamUid: StreamUid.make("stream-1"),
  title: null,
  status: VideoStatus.cases.Ready.make({ readyAt: now, duration: 120 }),
  thumbnail: Thumbnail.cases.Frame.make({ time: 42 }),
  expiry: "7d",
  createdAt: now,
});

layer(Store.layerDrizzle.pipe(Layer.provide(DbPglite)))("Store (Drizzle + PGlite)", (it) => {
  it.effect("crée et relit une vidéo à l'identique", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.createVideo(video, "hash-1", "owner@example.com");
      assert.deepStrictEqual(yield* store.getVideo(video.id), video);
      assert.strictEqual(yield* store.ownerEmail(video.id), "owner@example.com");
      yield* store.setOwnerEmail(video.id, "autre@example.com");
      assert.strictEqual(yield* store.ownerEmail(video.id), "autre@example.com");
    }),
  );

  it.effect("vérifie le secret d'admin", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.checkAdmin(video.id, "hash-1");
      const error = yield* store.checkAdmin(video.id, "mauvais").pipe(Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
    }),
  );

  it.effect("met à jour les enrichissements sans perdre le résultat", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.setEnrichment(
        video.id,
        "summary",
        EnrichmentStatus.cases.Running.make({ attempt: 1 }),
      );
      yield* store.setEnrichment(
        video.id,
        "summary",
        EnrichmentStatus.cases.Done.make({ durationMs: 900 }),
        { summary: "Une démo." },
      );
      const [summary] = yield* store.enrichments(video.id);
      assert.strictEqual(summary?.status._tag, "Done");
      assert.deepStrictEqual(summary?.result, { summary: "Une démo." });
    }),
  );

  it.effect("liste les commentaires dans l'ordre de la vidéo", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      for (const [n, time] of [
        ["1", 90],
        ["2", 10],
      ] as const) {
        yield* store.addComment(
          new Comment({
            id: CommentId.make(`019a0000-0000-7000-8000-00000000000${n}`),
            videoId: video.id,
            parentId: null,
            author: "Alice",
            body: `à ${time}s`,
            time,
            via: "web",
            createdAt: now,
          }),
        );
      }
      const list = yield* store.comments(video.id);
      assert.deepStrictEqual(
        list.map((c) => c.time),
        [10, 90],
      );
    }),
  );
});
