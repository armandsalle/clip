import { assert, layer } from "@effect/vitest";
import { DateTime, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { ClipApi } from "@clip/contract";
import { VideosHandlers } from "../src/http.ts";
import * as Pipeline from "../src/pipeline.ts";
import { captionsUploaded, queued, sentEmails, TestPlatform } from "./support/layers.ts";

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
      yield* withClock(Effect.all([Pipeline.summary(id), Pipeline.captions(id)]));

      const view = yield* client.videos.get({ params: { id } });
      assert.strictEqual(view.video.status._tag, "Ready");
      assert.strictEqual(view.video.title, "Démo Clip");
      assert.isTrue(view.transcript.length > 0);
      assert.strictEqual(view.language, "fr");
      assert.deepStrictEqual([...new Set(view.transcript.map((s) => s.speaker))].sort(), [0, 1]);
      const vtt = captionsUploaded.at(-1);
      assert.strictEqual(vtt?.language, "fr");
      assert.isTrue(vtt?.vtt.startsWith("WEBVTT") && vtt.vtt.includes("<v Intervenant 2>"));
      assert.strictEqual(view.enrichments.captions._tag, "Done");
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

  it.effect("l'encodage a une vraie durée, et la HD publie son avancement", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { video } = yield* client.videos.create({
        payload: { email: null, expiry: "never", size: 1_000_000 },
      });
      yield* TestClock.adjust("42 seconds");
      yield* Pipeline.checkEncoding(video.id);
      const startedAt = (yield* DateTime.now).epochMilliseconds;
      assert.strictEqual(yield* Pipeline.checkHd(video.id, startedAt), "waiting");
      const view = yield* client.videos.get({ params: { id: video.id } });
      const hd = view.enrichments.hd;
      assert.isTrue(hd._tag === "Running" && hd.progress === 94 && hd.startedAt !== undefined);
    }),
  );

  it.effect("emails : vidéo prête, commentaires regroupés, réponse par email", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const created = yield* client.videos.create({
        payload: { email: "owner@example.com", expiry: "7d", size: 1_000_000 },
      });
      const id = created.video.id;
      yield* Pipeline.checkEncoding(id);

      // Vidéo prête
      yield* Pipeline.notify(id);
      const ready = sentEmails.at(-1);
      assert.strictEqual(ready?.to, "owner@example.com");
      assert.isTrue(ready?.subject.startsWith("Votre vidéo est prête"));

      // Deux commentaires → deux notifications enfilées → un seul email
      const before = queued.length;
      for (const body of ["Premier", "Second"]) {
        yield* client.videos.comment({
          params: { id },
          payload: { author: "Alice", body, time: 10, parentId: null },
        });
      }
      const batch = queued.slice(before);
      assert.strictEqual(batch.length, 2);
      const sentBefore = sentEmails.length;
      yield* Pipeline.notifyComments(batch);
      assert.strictEqual(sentEmails.length, sentBefore + 1);
      const mail = sentEmails.at(-1)!;
      assert.isTrue(mail.subject.startsWith("2 nouveaux commentaires"));
      const replyTo = mail.replyTo!;
      assert.isTrue(/^reply\+[a-z2-7]{16}@clip\.test$/.test(replyTo));

      // Réponse depuis une autre adresse : refusée
      const refused = yield* Pipeline.replyByEmail({
        to: replyTo,
        from: "pirate@example.com",
        text: "Coucou",
      }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "expéditeur non autorisé");

      // Jeton inconnu : refusé
      const unknown = yield* Pipeline.replyByEmail({
        to: "reply+aaaaaaaaaaaaaaaa@clip.test",
        from: "owner@example.com",
        text: "x",
      }).pipe(Effect.flip);
      assert.strictEqual(unknown.reason, "adresse inconnue");

      // Réponse du propriétaire : publiée sous le dernier commentaire
      const reply = yield* Pipeline.replyByEmail({
        to: replyTo,
        from: "Owner@Example.com",
        text: "Merci !\n\nLe 18 oct., Clip a écrit :\n> Second",
      });
      assert.strictEqual(reply.body, "Merci !");
      assert.strictEqual(reply.via, "email");
      const all = yield* client.videos.comments({ params: { id } });
      const parent = all.find((c) => c.body === "Second")!;
      assert.strictEqual(reply.parentId, parent.id);
    }),
  );

  it.effect("pas d'email « vidéo prête » sans adresse", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { video } = yield* client.videos.create({
        payload: { email: null, expiry: "7d", size: 1_000_000 },
      });
      yield* Pipeline.checkEncoding(video.id);
      yield* Pipeline.notify(video.id);
      const view = yield* client.videos.get({ params: { id: video.id } });
      assert.strictEqual(view.enrichments.notify._tag, "Disabled");
    }),
  );
});
