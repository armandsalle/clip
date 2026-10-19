import * as tus from "tus-js-client";

// Envoi direct du fichier, avec progression, débit, pause et reprise :
// - `tus` : vers Cloudflare Stream, par morceaux, reprenable (même après rechargement :
//   l'URL d'upload suffit, tus demande au serveur où il en est) ;
// - `put` : vers le faux Stream de clip-api en local (PUT brut, sans reprise).

export const CHUNK_BYTES = 50 * 1024 * 1024;
/** Nouvelles tentatives automatiques après une coupure (ms). */
const RETRY_DELAYS = [0, 2000, 4000, 8000, 15000, 30000];

export interface UploadCallbacks {
  readonly onProgress: (loaded: number, bytesPerSecond: number) => void;
  /** Coupure : nouvel essai automatique dans `inMs`. */
  readonly onRetry: (inMs: number) => void;
  readonly onSuccess: () => void;
  readonly onError: (message: string) => void;
}

export interface UploadControl {
  /** `null` : envoi non interruptible (faux Stream local). */
  readonly pause: (() => void) | null;
  readonly resume: () => void;
  /** Arrête l'envoi sans l'effacer chez Stream : il reste reprenable (rechargement). */
  readonly stop: () => void;
  /** Annule l'envoi et l'efface chez Stream (bouton « Annuler »). */
  readonly abort: () => void;
}

/** Débit lissé sur les dernières secondes. */
const speedMeter = () => {
  const samples: Array<{ at: number; loaded: number }> = [];
  return (loaded: number) => {
    const now = performance.now();
    samples.push({ at: now, loaded });
    while (samples.length > 2 && now - samples[0]!.at > 4000) samples.shift();
    const first = samples[0]!;
    const seconds = (now - first.at) / 1000;
    return seconds > 0.25 ? Math.max(0, (loaded - first.loaded) / seconds) : 0;
  };
};

export const startUpload = (
  url: string,
  protocol: "tus" | "put",
  file: File,
  duration: number | null,
  callbacks: UploadCallbacks,
): UploadControl => {
  const speed = speedMeter();
  if (protocol === "tus") {
    const upload = new tus.Upload(file, {
      uploadUrl: url,
      chunkSize: CHUNK_BYTES,
      retryDelays: RETRY_DELAYS,
      onShouldRetry: (_error, attempt) => {
        callbacks.onRetry(RETRY_DELAYS[attempt] ?? 0);
        return true;
      },
      onProgress: (sent) => callbacks.onProgress(sent, speed(sent)),
      onSuccess: () => callbacks.onSuccess(),
      onError: () => callbacks.onError("connection"),
    });
    upload.start();
    return {
      pause: () => void upload.abort(),
      resume: () => upload.start(),
      stop: () => void upload.abort(),
      abort: () => void upload.abort(true).catch(() => undefined),
    };
  }
  let xhr: XMLHttpRequest | null = null;
  const send = () => {
    const request = new XMLHttpRequest();
    xhr = request;
    request.open("PUT", url);
    request.upload.onprogress = (e) => callbacks.onProgress(e.loaded, speed(e.loaded));
    request.onload = () =>
      request.status < 300 ? callbacks.onSuccess() : callbacks.onError("server");
    request.onerror = () => callbacks.onError("connection");
    request.setRequestHeader("content-type", file.type || "video/mp4");
    if (duration !== null)
      request.setRequestHeader("x-clip-duration", String(Math.round(duration)));
    request.send(file);
  };
  send();
  return { pause: null, resume: send, stop: () => xhr?.abort(), abort: () => xhr?.abort() };
};

/** Durée et image d'aperçu, lues dans le fichier par le navigateur (rien n'est envoyé). */
export const probeVideo = (
  file: File,
): Promise<{ duration: number | null; preview: string | null }> =>
  new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let duration: number | null = null;
    const done = (preview: string | null) => {
      URL.revokeObjectURL(url);
      resolve({ duration, preview });
    };
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      duration = Number.isFinite(video.duration) ? video.duration : null;
      video.currentTime = Math.min(1, (duration ?? 2) / 2);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 144;
        canvas.height = 88;
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        done(null);
      }
    };
    video.onerror = () => done(null);
    setTimeout(() => done(null), 2500);
    video.src = url;
  });
