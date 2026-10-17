import { Effect, Layer } from "effect";
import { StreamUid } from "@clip/domain";
import { Summarizer, Transcriber } from "../../src/Ai.ts";
import { Features } from "../../src/pipeline.ts";
import { AdminKeys, Live, Pipeline, StreamVideos } from "../../src/Platform.ts";
import { Store } from "../../src/Store.ts";

/** Stream de test : chaque vidéo est encodée (120 s) dès sa création. */
export const StreamTest = Layer.succeed(
  StreamVideos,
  StreamVideos.of({
    createUpload: () =>
      Effect.sync(() => ({
        uid: StreamUid.make(crypto.randomUUID()),
        uploadUrl: "https://upload.test",
      })),
    details: () =>
      Effect.succeed({
        ready: true,
        failed: null,
        duration: 120,
        hls: "https://hls.test",
        thumbnail: "https://thumb.test",
      }),
    setThumbnail: () => Effect.void,
    audio: () => Effect.succeed(new Uint8Array()),
    remove: () => Effect.void,
  }),
);

/** Toutes les dépendances en mémoire, IA factice, pas de chaos. */
export const TestPlatform = Layer.mergeAll(
  Store.layerMemory,
  StreamTest,
  AdminKeys.layer,
  Live.layerRecorder,
  Pipeline.layerNoop,
  Transcriber.layerFake,
  Summarizer.layerFake,
  Features.layer({ ai: true, storyboard: false, chaos: 0 }),
);
