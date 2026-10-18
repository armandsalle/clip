import { Context, Effect, Layer, Schema } from "effect";
import { Base64, Base64Url, Hex } from "effect/encoding";
import { StreamUid, type VideoId } from "@clip/domain";
import { LiveEvent } from "@clip/contract";

// Services Effect autour des bindings Cloudflare. Les handlers ne voient jamais
// `env` : en test, chaque service se remplace par une Layer en mémoire.

// Secrets d'admin -------------------------------------------------------------------

export class AdminKeys extends Context.Service<
  AdminKeys,
  {
    readonly generate: Effect.Effect<{ readonly key: string; readonly hash: string }>;
    hash(key: string): Effect.Effect<string>;
  }
>()("@clip/api/AdminKeys") {
  static readonly layer = Layer.sync(AdminKeys, () => {
    const hash = (key: string) =>
      Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).pipe(
        Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
      );
    return AdminKeys.of({
      hash,
      generate: Effect.gen(function* () {
        const key = Base64Url.encode(crypto.getRandomValues(new Uint8Array(24)));
        return { key, hash: yield* hash(key) };
      }),
    });
  });
}

// Cloudflare Stream -------------------------------------------------------------------

export interface StreamDetails {
  readonly ready: boolean;
  readonly failed: string | null;
  readonly duration: number;
  readonly hls: string;
  /** URL de miniature ; accepte `?time=42s`. */
  readonly thumbnail: string;
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
    /** Piste audio (pour la transcription) ; `null` tant que le téléchargement n'est pas prêt. */
    audio(uid: StreamUid): Effect.Effect<Uint8Array | null>;
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
            })),
            Effect.withSpan("stream.details"),
          ),
        setThumbnail: (uid, pct) =>
          Effect.promise(() => binding.video(uid).update({ thumbnailTimestampPct: pct })).pipe(
            Effect.asVoid,
            Effect.withSpan("stream.setThumbnail"),
          ),
        audio: (uid) =>
          Effect.promise(async () => {
            const downloads = binding.video(uid).downloads;
            const current = await downloads.get();
            const audio = current.audio ?? (await downloads.generate("audio")).audio;
            if (audio?.status !== "ready" || !audio.url) return null;
            return new Uint8Array(await (await fetch(audio.url)).arrayBuffer());
          }).pipe(Effect.withSpan("stream.audio")),
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
            })),
          ),
        setThumbnail: () => Effect.void,
        audio: () => Effect.succeed(new Uint8Array()),
        remove: (uid) => Effect.promise(() => bucket.delete(`dev-stream/${uid}`)),
      }),
    );
}

// Temps réel ------------------------------------------------------------------------------

export class Live extends Context.Service<
  Live,
  { publish(videoId: VideoId, event: LiveEvent): Effect.Effect<void> }
>()("@clip/api/Live") {
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

// Pipeline (Workflow) ---------------------------------------------------------------------

export class Pipeline extends Context.Service<
  Pipeline,
  { start(videoId: VideoId): Effect.Effect<void> }
>()("@clip/api/Pipeline") {
  static readonly layer = (binding: Workflow) =>
    Layer.succeed(
      Pipeline,
      Pipeline.of({
        start: (videoId) =>
          Effect.promise(() => binding.create({ id: videoId, params: { videoId } })).pipe(
            Effect.asVoid,
            Effect.withSpan("pipeline.start"),
          ),
      }),
    );

  static readonly layerNoop = Layer.succeed(Pipeline, Pipeline.of({ start: () => Effect.void }));
}
