import { Context, Effect, Layer } from "effect";
import { Base64 } from "effect/encoding";
import { StreamUid } from "@clip/domain";

// Cloudflare Stream -------------------------------------------------------------------

export interface StreamDetails {
  readonly ready: boolean;
  readonly failed: string | null;
  readonly duration: number;
  readonly hls: string;
  /** URL de miniature ; accepte `?time=42s`. */
  readonly thumbnail: string;
  /** Les qualités hautes s'encodent encore (Stream est lisible avant la fin). */
  readonly encoding: boolean;
  /** Avancement de l'encodage, 0–100. */
  readonly progress: number;
}

/** Flux audio à transmettre tel quel à la transcription. */
export interface AudioStream {
  readonly body: ReadableStream;
  readonly contentType: string;
}

export class StreamVideos extends Context.Service<
  StreamVideos,
  {
    createUpload(
      maxDurationSeconds: number,
      size: number,
    ): Effect.Effect<{ uid: StreamUid; uploadUrl: string; protocol: "tus" | "put" }>;
    details(uid: StreamUid): Effect.Effect<StreamDetails>;
    setThumbnail(uid: StreamUid, pct: number): Effect.Effect<void>;
    /** Demande à Stream de préparer la piste audio (sans attendre). */
    requestAudio(uid: StreamUid): Effect.Effect<void>;
    /** La piste audio est-elle prête ? */
    audioReady(uid: StreamUid): Effect.Effect<boolean>;
    /** Piste audio en flux ; `null` tant que Stream ne l'a pas préparée. */
    audio(uid: StreamUid): Effect.Effect<AudioStream | null>;
    /** Sous-titres WebVTT, affichés par le lecteur et déclarés dans le manifeste HLS. */
    uploadCaptions(uid: StreamUid, language: string, vtt: string): Effect.Effect<void>;
    remove(uid: StreamUid): Effect.Effect<void>;
  }
>()("@clip/api/StreamVideos") {
  static readonly layer = (
    binding: StreamBinding,
    rest: { accountId: string; token: () => Promise<string> },
  ) =>
    Layer.succeed(
      StreamVideos,
      StreamVideos.of({
        // Le binding ne crée que des uploads « POST » limités à 200 Mo : l'upload tus
        // (gros fichiers, reprenable) passe par l'API REST de Stream avec un token.
        createUpload: (maxDurationSeconds, size) =>
          Effect.tryPromise(async () => {
            const response = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${rest.accountId}/stream?direct_user=true`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${await rest.token()}`,
                  "tus-resumable": "1.0.0",
                  "upload-length": String(size),
                  "upload-metadata": `maxDurationSeconds ${Base64.encode(String(maxDurationSeconds))}`,
                },
              },
            );
            const location = response.headers.get("location");
            const uid = response.headers.get("stream-media-id");
            if (!response.ok || !location || !uid) {
              throw new Error(`Stream tus ${response.status}: ${await response.text()}`);
            }
            return { uid: StreamUid.make(uid), uploadUrl: location, protocol: "tus" as const };
          }).pipe(Effect.orDie, Effect.withSpan("stream.createUpload")),
        details: (uid) =>
          Effect.promise(() => binding.video(uid).details()).pipe(
            Effect.map((v) => ({
              ready: v.readyToStream,
              failed: v.status.state === "error" ? v.status.errorReasonText : null,
              duration: v.duration,
              hls: v.hlsPlaybackUrl,
              thumbnail: v.thumbnail,
              encoding: v.status.state !== "error" && v.status.step === "encoding",
              progress: Number(v.status.pctComplete ?? (v.readyToStream ? 100 : 0)),
            })),
            Effect.withSpan("stream.details"),
          ),
        setThumbnail: (uid, pct) =>
          Effect.promise(() => binding.video(uid).update({ thumbnailTimestampPct: pct })).pipe(
            Effect.asVoid,
            Effect.withSpan("stream.setThumbnail"),
          ),
        requestAudio: (uid) =>
          Effect.promise(async () => {
            const downloads = binding.video(uid).downloads;
            if (!(await downloads.get()).audio) await downloads.generate("audio");
          }).pipe(Effect.withSpan("stream.requestAudio")),
        audioReady: (uid) =>
          Effect.promise(() => binding.video(uid).downloads.get()).pipe(
            Effect.map((d) => d.audio?.status === "ready"),
            Effect.withSpan("stream.audioReady"),
          ),
        audio: (uid) =>
          Effect.promise(async () => {
            const audio = (await binding.video(uid).downloads.get()).audio;
            if (audio?.status !== "ready" || !audio.url) return null;
            const response = await fetch(audio.url);
            if (!response.ok || !response.body) return null;
            return {
              body: response.body,
              contentType: response.headers.get("content-type") ?? "audio/mp4",
            };
          }).pipe(Effect.withSpan("stream.audio")),
        uploadCaptions: (uid, language, vtt) =>
          Effect.promise(() =>
            binding.video(uid).captions.upload(language, new Blob([vtt]).stream()),
          ).pipe(Effect.asVoid, Effect.withSpan("stream.captions")),
        remove: (uid) =>
          Effect.promise(() => binding.video(uid).delete()).pipe(Effect.withSpan("stream.delete")),
      }),
    );

  /**
   * Faux Stream pour `cf dev` sans compte : l'upload va dans R2 (PUT sur le
   * Worker), la vidéo est « prête » quelques secondes après, et la lecture se fait
   * en MP4 direct depuis R2.
   */
  static readonly layerFake = (bucket: R2Bucket, encodingDelayMs = 4000) =>
    Layer.succeed(
      StreamVideos,
      StreamVideos.of({
        createUpload: () =>
          Effect.sync(() => {
            const uid = StreamUid.make(`dev-${crypto.randomUUID()}`);
            return { uid, uploadUrl: `/dev/stream/${uid}`, protocol: "put" as const };
          }),
        details: (uid) =>
          Effect.promise(() => bucket.head(`dev-stream/${uid}`)).pipe(
            Effect.map((object) => ({
              ready: object !== null && Date.now() - object.uploaded.getTime() > encodingDelayMs,
              failed: null,
              duration: Number(object?.customMetadata?.duration ?? 60),
              hls: `/dev/stream/${uid}`,
              thumbnail: `/dev/stream/${uid}/thumbnail.svg`,
              encoding: false,
              progress: 100,
            })),
          ),
        setThumbnail: () => Effect.void,
        requestAudio: () => Effect.void,
        audioReady: () => Effect.succeed(true),
        audio: () => Effect.sync(() => ({ body: new Blob([]).stream(), contentType: "audio/mp4" })),
        uploadCaptions: () => Effect.void,
        remove: (uid) => Effect.promise(() => bucket.delete(`dev-stream/${uid}`)),
      }),
    );
}
