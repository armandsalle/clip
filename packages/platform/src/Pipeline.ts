import { Context, Effect, Layer } from "effect";
import type { VideoId } from "@clip/domain";

// Pipeline (Workflow) ---------------------------------------------------------------------

export class Pipeline extends Context.Service<
  Pipeline,
  {
    start(videoId: VideoId): Effect.Effect<void>;
    /** Réveille le Workflow : Stream a fini (ou raté) l'encodage. */
    notifyEncoded(videoId: VideoId): Effect.Effect<void>;
  }
>()("@clip/platform/Pipeline") {
  static readonly layer = (binding: Workflow) =>
    Layer.succeed(
      Pipeline,
      Pipeline.of({
        start: (videoId) =>
          Effect.promise(() => binding.create({ id: videoId, params: { videoId } })).pipe(
            Effect.asVoid,
            Effect.withSpan("pipeline.start"),
          ),
        notifyEncoded: (videoId) =>
          Effect.promise(async () => {
            const instance = await binding.get(videoId);
            await instance.sendEvent({ type: "stream-ready", payload: {} });
          }).pipe(Effect.withSpan("pipeline.notifyEncoded")),
      }),
    );

  static readonly layerNoop = Layer.succeed(
    Pipeline,
    Pipeline.of({ start: () => Effect.void, notifyEncoded: () => Effect.void }),
  );
}
