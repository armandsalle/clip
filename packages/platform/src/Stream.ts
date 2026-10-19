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
    /** Dépôt tus étiqueté avec l'environnement (créateur) et la vidéo Clip (nom). */
    createUpload(
      videoId: string,
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
    /** Supprime la vidéo, seulement si elle appartient à cet environnement. */
    remove(uid: StreamUid): Effect.Effect<void>;
  }
>()("@clip/platform/StreamVideos") {
  static readonly layer = (
    binding: StreamBinding,
    rest: {
      accountId: string;
      token: () => Promise<string>;
      /** Environnement propriétaire (`clip-production`, `clip-pr-12`…), voir packages/config. */
      creator: string;
      /** Suppression programmée par Stream (filet de sécurité hors production), en jours. */
      deleteAfterDays: number | null;
    },
  ) =>
    Layer.succeed(
      StreamVideos,
      StreamVideos.of({
        // Le binding ne crée que des uploads « POST » limités à 200 Mo : l'upload tus
        // (gros fichiers, reprenable) passe par l'API REST de Stream avec un token.
        createUpload: (videoId, maxDurationSeconds, size) =>
          Effect.tryPromise(async () => {
            // Upload-Metadata : paires « clé base64(valeur) ». `name` est le nom affiché
            // dans le tableau de bord (`clip-pr-12/<id>`), les autres clés vont dans `meta`.
            const metadata = {
              maxDurationSeconds: String(maxDurationSeconds),
              name: `${rest.creator}/${videoId}`,
              clipvideo: videoId,
              ...(rest.deleteAfterDays === null
                ? {}
                : {
                    scheduleddeletion: new Date(
                      Date.now() + rest.deleteAfterDays * 24 * 3600 * 1000,
                    ).toISOString(),
                  }),
            };
            const response = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${rest.accountId}/stream?direct_user=true`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${await rest.token()}`,
                  "tus-resumable": "1.0.0",
                  "upload-length": String(size),
                  "upload-creator": rest.creator,
                  "upload-metadata": Object.entries(metadata)
                    .map(([k, v]) => `${k} ${Base64.encode(v)}`)
                    .join(","),
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
        // Jamais la vidéo d'un autre environnement : une branche Neon de PR est copiée de
        // la production, ses vidéos y pointent vers les fichiers Stream de la prod.
        remove: (uid) =>
          Effect.promise(async () => {
            const video = binding.video(uid);
            const { creator } = await video.details();
            if (creator !== rest.creator) return { skipped: creator };
            await video.delete();
            return { skipped: null };
          }).pipe(
            Effect.tap(({ skipped }) =>
              skipped === null
                ? Effect.void
                : Effect.logWarning("stream.delete.skipped", { uid, creator: skipped }),
            ),
            Effect.asVoid,
            Effect.withSpan("stream.delete"),
          ),
      }),
    );

  /**
   * Faux Stream pour `cf dev` sans compte : l'upload va dans R2 (PUT sur le
   * Worker), la vidéo est « prête » quelques secondes après, et la lecture se fait
   * en MP4 direct depuis R2.
   */
  /**
   * Stream réel quand le Worker est « remote » (prod, ou CLIP_REMOTE=1) et que les
   * bindings existent ; sinon faux Stream sur R2 (dev local sans compte).
   */
  static readonly layerFor = (env: {
    readonly remote: boolean;
    readonly stream: StreamBinding | undefined;
    readonly token: SecretsStoreSecret | undefined;
    readonly accountId: string;
    readonly creator: string;
    readonly deleteAfterDays: number | null;
    readonly media: R2Bucket;
  }) => {
    const { stream, token } = env;
    return env.remote && stream && token
      ? // Secrets Store : lu à la demande, dans le handler.
        StreamVideos.layer(stream, {
          accountId: env.accountId,
          token: () => token.get(),
          creator: env.creator,
          deleteAfterDays: env.deleteAfterDays,
        })
      : StreamVideos.layerFake(env.media);
  };

  static readonly layerFake = (bucket: R2Bucket, encodingDelayMs = 4000) =>
    Layer.succeed(
      StreamVideos,
      StreamVideos.of({
        // tus, comme le vrai Stream (morceaux de 50 Mo : derrière un domaine Cloudflare,
        // un corps de plus de 100 Mo est refusé). L'état du dépôt vit à côté du fichier
        // (voir apps/api/src/devStream.ts).
        createUpload: (_videoId, _maxDurationSeconds, size) =>
          Effect.promise(async () => {
            const uid = StreamUid.make(`dev-${crypto.randomUUID()}`);
            await bucket.put(`dev-stream/${uid}.tus`, JSON.stringify({ length: size, offset: 0 }));
            return { uid, uploadUrl: `/dev/stream/${uid}`, protocol: "tus" as const };
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
