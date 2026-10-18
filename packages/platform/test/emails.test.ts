import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import {
  Comment,
  CommentId,
  StreamUid,
  Thumbnail,
  Video,
  VideoId,
  VideoStatus,
} from "@clip/domain";
import { commentsEmail, extractReplyText, readyEmail, tokenFromAddress } from "../src/emails.ts";

const now = DateTime.makeUnsafe("2026-10-18T10:00:00Z");
const video = new Video({
  id: VideoId.make("019a0000-0000-7000-8000-0000000000a1"),
  streamUid: StreamUid.make("s"),
  title: "Démo <script>",
  status: VideoStatus.cases.Ready.make({ readyAt: now, duration: 120 }),
  thumbnail: Thumbnail.cases.Auto.make({}),
  expiry: "7d",
  createdAt: now,
});

describe("emails", () => {
  it.effect("échappe le contenu utilisateur et met des liens absolus", () =>
    Effect.sync(() => {
      const email = readyEmail("clip.test", video, "Résumé", [{ time: 65, title: "Partie 2" }]);
      assert.strictEqual(email.subject, "Votre vidéo est prête : Démo <script>");
      assert.isFalse(email.html.includes("<script>"));
      assert.isTrue(email.html.includes(`https://clip.test/v/${video.id}?t=65`));
      assert.isTrue(email.text.includes("1:05 Partie 2"));
    }),
  );

  it.effect("liste les commentaires avec un lien de réponse chacun", () =>
    Effect.sync(() => {
      const comment = new Comment({
        id: CommentId.make("019a0000-0000-7000-8000-000000000001"),
        videoId: video.id,
        parentId: null,
        author: "Alice",
        body: "Bravo",
        time: 42,
        via: "web",
        createdAt: now,
      });
      const email = commentsEmail("clip.test", video, [
        { comment, replyToken: "abcdefghijklmnop" },
        { comment, replyToken: null },
      ]);
      assert.strictEqual(email.subject, "2 nouveaux commentaires sur « Démo <script> »");
      assert.isTrue(email.html.includes("mailto:reply+abcdefghijklmnop@clip.test"));
    }),
  );

  it.effect("extrait le texte d'une réponse sans citation ni signature", () =>
    Effect.sync(() => {
      assert.strictEqual(
        extractReplyText("Merci, je corrige !\n\nLe 18 oct. 2026, Clip a écrit :\n> Bravo"),
        "Merci, je corrige !",
      );
      assert.strictEqual(extractReplyText("Ok\r\n-- \r\nArmand"), "Ok");
      assert.strictEqual(extractReplyText("> rien"), null);
      assert.strictEqual(extractReplyText("Bien vu\nOn Sat, Oct 18, Clip wrote:\n> x"), "Bien vu");
    }),
  );

  it.effect("lit le jeton d'une adresse de réponse", () =>
    Effect.sync(() => {
      assert.strictEqual(tokenFromAddress("reply+abcdefghijklmnop@clip.test"), "abcdefghijklmnop");
      assert.strictEqual(tokenFromAddress("reply@clip.test"), null);
    }),
  );
});
