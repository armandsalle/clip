import { assert, layer } from "@effect/vitest";
import { DateTime, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { ClipApi } from "@clip/contract";
import { InternalApi } from "@clip/platform";
import { Store } from "@clip/db";
import { captionsUploaded, queued, sentEmails, TestPlatform } from "@clip/testing";
import { ApiTest } from "@clip/api/testing";
import * as Pipeline from "../src/pipeline.ts";

const makeClient = HttpApiTest.groups(ClipApi, ["videos"]);

/** L'IA factice simule une latence : on avance l'horloge de test au lieu d'attendre. */
const withClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("5 seconds");
    return yield* Fiber.join(fiber);
  });

const replyByEmail = (input: { to: string; from: string; text: string }) =>
  InternalApi.use((api) => api.AddEmailReply(input));

// La logique du Workflow, de la Queue et du Cron contre une api en mémoire : les
// écritures passent par la vraie RPC interne (contrat jobs → api).
layer(ApiTest.pipe(Layer.provideMerge(TestPlatform), Layer.provideMerge(HttpServer.layerServices)))(
  "Pipeline",
  (it) => {
    it.effect("upload → encodage → enrichissements → vue complète", () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const created = yield* client.videos.create({
          payload: { email: "owner@example.com", expiry: "7d", size: 1_000_000 },
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

    it.effect("l'encodage a une vraie durée, et la HD publie son avancement", () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { video } = yield* client.videos.create({
          payload: { email: "owner@example.com", expiry: "never", size: 1_000_000 },
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
        const refused = yield* replyByEmail({
          to: replyTo,
          from: "pirate@example.com",
          text: "Coucou",
        }).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "expéditeur non autorisé");

        // Jeton inconnu : refusé
        const unknown = yield* replyByEmail({
          to: "reply+aaaaaaaaaaaaaaaa@clip.test",
          from: "owner@example.com",
          text: "x",
        }).pipe(Effect.flip);
        assert.strictEqual(unknown.reason, "adresse inconnue");

        // Réponse du propriétaire : publiée sous le dernier commentaire
        const reply = yield* replyByEmail({
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

    it.effect("pas d'email « vidéo prête » si le propriétaire a retiré son adresse", () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { video, adminKey } = yield* client.videos.create({
          payload: { email: "owner@example.com", expiry: "7d", size: 1_000_000 },
        });
        yield* client.videos.update({
          params: { id: video.id },
          headers: { "x-clip-admin": adminKey },
          payload: { email: null },
        });
        yield* Pipeline.checkEncoding(video.id);
        yield* Pipeline.notify(video.id);
        const view = yield* client.videos.get({ params: { id: video.id } });
        assert.strictEqual(view.enrichments.notify._tag, "Disabled");
      }),
    );

    it.effect("le Cron expire les vidéos arrivées à échéance, et seulement elles", () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const short = yield* client.videos.create({
          payload: { email: "owner@example.com", expiry: "1d", size: 1_000_000 },
        });
        const kept = yield* client.videos.create({
          payload: { email: "owner@example.com", expiry: "never", size: 1_000_000 },
        });
        yield* Pipeline.checkEncoding(short.video.id);
        assert.strictEqual(yield* Pipeline.expireDue(), 0);
        yield* TestClock.adjust("25 hours");
        assert.isTrue((yield* Pipeline.expireDue()) >= 1);
        const expired = yield* client.videos.get({ params: { id: short.video.id } });
        assert.strictEqual(expired.video.status._tag, "Expired");
        const alive = yield* client.videos.get({ params: { id: kept.video.id } });
        assert.notStrictEqual(alive.video.status._tag, "Expired");
      }),
    );

    it.effect("la miniature est enregistrée et la galerie l'affiche", () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { video } = yield* client.videos.create({
          payload: { email: "owner@example.com", expiry: "never", size: 1_000_000 },
        });
        yield* Pipeline.checkEncoding(video.id);
        yield* withClock(Pipeline.thumbnail(video.id));
        const stored = (yield* Store.use((st) => st.enrichments(video.id))).find(
          (e) => e.kind === "thumbnail",
        );
        assert.deepStrictEqual(stored?.result, { url: "https://thumb.test" });
        const page = yield* client.videos.list({ query: {} });
        const card = page.items.find((i) => i.video.id === video.id);
        assert.strictEqual(card?.thumbnail, "https://thumb.test");
        assert.strictEqual(card?.enrichments.thumbnail._tag, "Done");
      }),
    );
  },
);
