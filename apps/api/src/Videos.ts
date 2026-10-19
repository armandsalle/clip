import { Context, DateTime, Effect, Layer } from "effect";
import {
  Comment,
  CommentId,
  decide,
  EnrichmentStatus,
  isTerminal,
  type Video,
  type VideoError,
  type VideoEvent,
  type VideoId,
  type VideoNotFound,
} from "@clip/domain";
import { type IncomingReply, ReplyRejected } from "@clip/contract/internal";
import { extractReplyText, Live, StreamVideos, tokenFromAddress } from "@clip/platform";
import { Store } from "@clip/db";

// Seul écrivain des vidéos et des commentaires : l'API HTTP (front) et la RPC interne
// (jobs) passent par ici. Chaque changement est enregistré puis diffusé en direct.

export class Videos extends Context.Service<
  Videos,
  {
    /** Applique une suite d'événements du domaine, enregistre, diffuse. */
    apply(
      id: VideoId,
      events: ReadonlyArray<VideoEvent>,
    ): Effect.Effect<Video, VideoNotFound | VideoError>;
    /** Titre proposé par l'IA : ignoré si le propriétaire en a déjà choisi un. */
    suggestTitle(id: VideoId, title: string): Effect.Effect<Video, VideoNotFound | VideoError>;
    /** Réponse par email du propriétaire, publiée sous le commentaire visé. */
    addEmailReply(input: IncomingReply): Effect.Effect<Comment, ReplyRejected>;
  }
>()("@clip/api/Videos") {
  static readonly layer = Layer.effect(
    Videos,
    Effect.gen(function* () {
      const store = yield* Store;
      const live = yield* Live;
      const stream = yield* StreamVideos;

      const apply = Effect.fn("Videos.apply")(function* (
        id: VideoId,
        events: ReadonlyArray<VideoEvent>,
      ) {
        const now = yield* DateTime.now;
        let video = yield* store.getVideo(id);
        const wasTerminal = isTerminal(video);
        for (const event of events) video = yield* Effect.fromResult(decide(video, event, now));
        yield* store.saveVideo(video);
        yield* live.publish(id, { _tag: "VideoChanged", video });
        // Expirée ou supprimée : transcription, résultats et commentaires sont effacés,
        // et le fichier quitte Stream. L'état est déjà enregistré : une panne de Stream
        // ne fait pas échouer la demande (le fichier resterait orphelin, journalisé).
        if (!wasTerminal && isTerminal(video)) {
          yield* store.purgeContent(id);
          yield* stream.remove(video.streamUid).pipe(
            Effect.retry({ times: 2 }),
            Effect.catchCause((cause) =>
              Effect.logError("stream.remove", { videoId: id, streamUid: video.streamUid, cause }),
            ),
          );
        }
        return video;
      });

      return Videos.of({
        apply,

        suggestTitle: Effect.fn("Videos.suggestTitle")(function* (id, title) {
          const video = yield* store.getVideo(id);
          return video.title === null ? yield* apply(id, [{ _tag: "Rename", title }]) : video;
        }),

        addEmailReply: Effect.fn("Videos.addEmailReply")(function* (input) {
          const token = tokenFromAddress(input.to);
          if (token === null) return yield* new ReplyRejected({ reason: "adresse inconnue" });
          const parent = yield* store.findCommentByReplyToken(token);
          if (parent === null) return yield* new ReplyRejected({ reason: "adresse inconnue" });
          const owner = yield* store
            .ownerEmail(parent.videoId)
            .pipe(Effect.orElseSucceed(() => null));
          if (owner === null || owner.trim().toLowerCase() !== input.from.trim().toLowerCase()) {
            return yield* new ReplyRejected({ reason: "expéditeur non autorisé" });
          }
          const body = extractReplyText(input.text);
          if (body === null) return yield* new ReplyRejected({ reason: "réponse vide" });
          const reply = new Comment({
            id: CommentId.make(crypto.randomUUID()),
            videoId: parent.videoId,
            parentId: parent.parentId ?? parent.id,
            author: "Propriétaire",
            body,
            time: parent.time,
            via: "email",
            createdAt: yield* DateTime.now,
          });
          yield* store.addComment(reply);
          yield* live.publish(parent.videoId, { _tag: "CommentAdded", comment: reply });
          yield* live.publish(parent.videoId, {
            _tag: "Step",
            kind: "mail.reply",
            status: EnrichmentStatus.cases.Done.make({ durationMs: 0 }),
            at: yield* DateTime.now,
          });
          return reply;
        }),
      });
    }),
  );
}
