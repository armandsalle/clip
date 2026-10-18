import { Context, Effect, Layer, Schema } from "effect";
import { CommentNotification } from "@clip/contract";

// Notifications de commentaires (Queue) ---------------------------------------------------

export class Notifications extends Context.Service<
  Notifications,
  { enqueue(n: CommentNotification): Effect.Effect<void> }
>()("@clip/platform/Notifications") {
  /** Sans délai : le regroupement des rafales se fait côté consommateur (lots de 5 s). */
  static readonly layer = (queue: Queue<typeof CommentNotification.Encoded>) =>
    Layer.sync(Notifications, () => {
      const encode = Schema.encodeSync(CommentNotification);
      return Notifications.of({
        enqueue: (n) =>
          Effect.promise(() => queue.send(encode(n))).pipe(
            Effect.withSpan("notifications.enqueue"),
          ),
      });
    });

  static readonly layerNoop = Layer.succeed(
    Notifications,
    Notifications.of({ enqueue: () => Effect.void }),
  );
}

/** Décodage côté consommateur : un message d'une autre forme est écarté (et journalisé). */
export const decodeNotifications = (bodies: ReadonlyArray<unknown>) =>
  Effect.forEach(bodies, (body) =>
    Schema.decodeUnknownEffect(CommentNotification)(body).pipe(
      Effect.map((n) => [n]),
      Effect.catch((error) => Effect.as(Effect.logWarning("notification invalide", error), [])),
    ),
  ).pipe(Effect.map((lists) => lists.flat()));
