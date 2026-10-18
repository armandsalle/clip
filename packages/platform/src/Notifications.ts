import { Context, Effect, Layer } from "effect";

// Notifications de commentaires (Queue) ---------------------------------------------------

export interface CommentNotification {
  readonly videoId: string;
  readonly commentId: string;
}

export class Notifications extends Context.Service<
  Notifications,
  { enqueue(n: CommentNotification): Effect.Effect<void> }
>()("@clip/api/Notifications") {
  /** Sans délai : le regroupement des rafales se fait côté consommateur (lots de 5 s). */
  static readonly layer = (queue: Queue<CommentNotification>) =>
    Layer.succeed(
      Notifications,
      Notifications.of({
        enqueue: (n) =>
          Effect.promise(() => queue.send(n)).pipe(Effect.withSpan("notifications.enqueue")),
      }),
    );

  static readonly layerNoop = Layer.succeed(
    Notifications,
    Notifications.of({ enqueue: () => Effect.void }),
  );
}
