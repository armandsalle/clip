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

// Même scénario contre les deux implémentations : la galerie se comporte pareil en
// mémoire (dev sans base) et sur Postgres.

const at = (minutes: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 18, 10, minutes));
const make = (
  n: number,
  title: string | null,
  status: VideoStatus = VideoStatus.cases.Uploading.make({}),
) =>
  new Video({
    id: VideoId.make(`019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`),
    streamUid: StreamUid.make(`gallery-${n}`),
    title,
    status,
    thumbnail: Thumbnail.cases.Auto.make({}),
    expiry: "never",
    createdAt: at(n),
  });

const scenario = Effect.gen(function* () {
  const store = yield* Store;
  const videos = [
    make(1, "Démo produit Q4"),
    make(2, "Revue de sprint 42"),
    make(3, "Atelier 100% design"),
    make(4, null),
    make(5, "Supprimée", VideoStatus.cases.Deleted.make({ deletedAt: at(6) })),
  ];
  for (const v of videos) yield* store.createVideo(v, "hash", "owner@example.com");
  yield* store.setEnrichment(
    videos[3]!.id,
    "transcript",
    EnrichmentStatus.cases.Done.make({ durationMs: 10 }),
    { language: "fr", segments: [{ start: 0, end: 2, text: "Le budget 2024 est validé." }] },
  );
  yield* store.addComment(
    new Comment({
      id: CommentId.make("019a0000-0000-7000-8000-00000000c001"),
      videoId: videos[0]!.id,
      parentId: null,
      author: "Alice",
      body: "Bravo",
      time: 0,
      via: "web",
      createdAt: at(7),
    }),
  );

  // Plus récentes d'abord, supprimées exclues, pagination par curseur.
  const first = yield* store.listPublic({ cursor: null, q: null, limit: 2 });
  assert.deepStrictEqual(
    first.entries.map((e) => e.video.id),
    [videos[3]!.id, videos[2]!.id],
  );
  assert.isTrue(first.more);
  assert.strictEqual(first.total, 4);
  assert.strictEqual(first.entries[0]!.enrichments[0]?.kind, "transcript");
  const last = first.entries.at(-1)!.video;
  const second = yield* store.listPublic({
    cursor: { createdAtMs: last.createdAt.epochMilliseconds, id: last.id },
    q: null,
    limit: 2,
  });
  assert.deepStrictEqual(
    second.entries.map((e) => e.video.id),
    [videos[1]!.id, videos[0]!.id],
  );
  assert.isFalse(second.more);
  assert.strictEqual(second.entries[1]!.comments, 1);

  // Recherche : titre (insensible à la casse), transcription, caractères spéciaux.
  const byTitle = yield* store.listPublic({ cursor: null, q: "SPRINT", limit: 10 });
  assert.deepStrictEqual(
    byTitle.entries.map((e) => e.video.title),
    ["Revue de sprint 42"],
  );
  const bySpeech = yield* store.listPublic({ cursor: null, q: "budget 2024", limit: 10 });
  assert.deepStrictEqual(
    bySpeech.entries.map((e) => e.video.id),
    [videos[3]!.id],
  );
  const literal = yield* store.listPublic({ cursor: null, q: "100%", limit: 10 });
  assert.deepStrictEqual(
    literal.entries.map((e) => e.video.id),
    [videos[2]!.id],
  );
  const none = yield* store.listPublic({ cursor: null, q: "%", limit: 10 });
  assert.strictEqual(none.total, 1);
});

layer(Store.layerMemory)("Galerie (mémoire)", (it) => {
  it.effect(
    "pagine, exclut les supprimées et cherche dans les titres et la parole",
    () => scenario,
  );
});

layer(Store.layerDrizzle.pipe(Layer.provide(DbPglite)))("Galerie (Drizzle + PGlite)", (it) => {
  it.effect(
    "pagine, exclut les supprimées et cherche dans les titres et la parole",
    () => scenario,
  );
});
