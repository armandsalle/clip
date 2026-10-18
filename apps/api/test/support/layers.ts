import { Effect, Layer } from "effect";
import { StreamUid } from "@clip/domain";
import { Summarizer, Transcriber } from "../../src/Ai.ts";
import { Features } from "../../src/pipeline.ts";
import { AdminKeys, Live, Pipeline, StreamVideos } from "../../src/Platform.ts";
import { Store } from "../../src/Store.ts";

/** Sous-titres envoyés au Stream de test (pour les assertions). */
export const captionsUploaded: Array<{ uid: string; language: string; vtt: string }> = [];

/** Stream de test : chaque vidéo est lisible (120 s) dès sa création, HD à 94 %. */
export const StreamTest = Layer.succeed(
  StreamVideos,
  StreamVideos.of({
    createUpload: () =>
      Effect.sync(() => ({
        uid: StreamUid.make(crypto.randomUUID()),
        uploadUrl: "https://upload.test",
        protocol: "tus" as const,
      })),
    details: () =>
      Effect.succeed({
        ready: true,
        failed: null,
        duration: 120,
        hls: "https://hls.test",
        thumbnail: "https://thumb.test",
        encoding: true,
        progress: 94,
      }),
    setThumbnail: () => Effect.void,
    requestAudio: () => Effect.void,
    audioReady: () => Effect.succeed(true),
    audio: () => Effect.succeed({ body: new Blob([]).stream(), contentType: "audio/mp4" }),
    uploadCaptions: (uid, language, vtt) =>
      Effect.sync(() => void captionsUploaded.push({ uid, language, vtt })),
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
