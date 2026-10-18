import { Context, Effect, Layer, Schema } from "effect";
import type { VideoId } from "@clip/domain";
import { LiveEvent } from "@clip/contract";

// Temps réel ------------------------------------------------------------------------------

export class Live extends Context.Service<
  Live,
  { publish(videoId: VideoId, event: LiveEvent): Effect.Effect<void> }
>()("@clip/platform/Live") {
  static readonly layer = (namespace: DurableObjectNamespace) =>
    Layer.sync(Live, () => {
      const encode = Schema.encodeEffect(Schema.fromJsonString(LiveEvent));
      return Live.of({
        publish: (videoId, event) =>
          encode(event).pipe(
            Effect.flatMap((body) =>
              Effect.promise(() =>
                namespace
                  .get(namespace.idFromName(videoId))
                  .fetch("https://room/publish", { method: "POST", body }),
              ),
            ),
            Effect.asVoid,
            Effect.orDie,
            Effect.withSpan("live.publish", { attributes: { event: event._tag } }),
          ),
      });
    });

  /** Garde les événements publiés, pour les tests. */
  static readonly layerRecorder = Layer.sync(Live, () => {
    const events: Array<{ videoId: VideoId; event: LiveEvent }> = [];
    return Object.assign(
      Live.of({
        publish: (videoId, event) => Effect.sync(() => void events.push({ videoId, event })),
      }),
      { events },
    );
  });
}
