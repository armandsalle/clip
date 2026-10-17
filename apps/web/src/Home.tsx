import { useRef, useState } from "react";
import type { VideoId } from "@clip/domain";
import { call } from "./api.ts";
import { Logo, UploadIcon } from "./ui.tsx";
import { formatBytes, navigate, rememberAdminKey } from "./util.ts";

type State =
  | { readonly step: "idle"; readonly error?: string }
  | {
      readonly step: "uploading";
      readonly file: File;
      readonly loaded: number;
      readonly speed: number;
      readonly videoId: VideoId;
      readonly adminKey: string;
    };

/** Durée lue dans le fichier par le navigateur (utile au faux Stream local). */
const readDuration = (file: File): Promise<number | null> =>
  new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });

/**
 * Upload direct : vers Cloudflare Stream (formulaire multipart sur l'URL signée)
 * ou vers le faux Stream du Worker en local (PUT brut), avec progression.
 */
const upload = (
  url: string,
  file: File,
  duration: number | null,
  onProgress: (loaded: number) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const local = url.startsWith("/");
    xhr.open(local ? "PUT" : "POST", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status < 300 ? resolve() : reject(new Error(`L'envoi a échoué (${xhr.status}).`));
    xhr.onerror = () => reject(new Error("L'envoi a été interrompu. Vérifiez votre connexion."));
    if (local) {
      xhr.setRequestHeader("content-type", file.type || "video/mp4");
      if (duration !== null) xhr.setRequestHeader("x-clip-duration", String(Math.round(duration)));
      xhr.send(file);
    } else {
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    }
  });

const MAX_BYTES = 2e9;

export const Home = () => {
  const [state, setState] = useState<State>({ step: "idle" });
  const [over, setOver] = useState(false);
  const [email, setEmail] = useState("");
  const [emailSaved, setEmailSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const start = async (file: File) => {
    if (!file.type.startsWith("video/")) {
      setState({
        step: "idle",
        error: "Ce fichier n'est pas une vidéo. Essayez un mp4, un mov ou un webm.",
      });
      return;
    }
    if (file.size > MAX_BYTES) {
      setState({ step: "idle", error: "Cette vidéo dépasse 2 Go." });
      return;
    }
    try {
      const [created, duration] = await Promise.all([
        call((api) => api.videos.create({ payload: { email: null, expiry: "7d" } })),
        readDuration(file),
      ]);
      const videoId = created.video.id;
      rememberAdminKey(videoId, created.adminKey);
      const startedAt = performance.now();
      setState({
        step: "uploading",
        file,
        loaded: 0,
        speed: 0,
        videoId,
        adminKey: created.adminKey,
      });
      await upload(created.uploadUrl, file, duration, (loaded) =>
        setState((s) =>
          s.step === "uploading"
            ? {
                ...s,
                loaded,
                speed: loaded / Math.max(0.001, (performance.now() - startedAt) / 1000),
              }
            : s,
        ),
      );
      navigate(`/v/${videoId}`);
    } catch (error) {
      setState({
        step: "idle",
        error: error instanceof Error ? error.message : "Une erreur est survenue.",
      });
    }
  };

  const saveEmail = async () => {
    if (state.step !== "uploading" || !email.includes("@")) return;
    await call((api) =>
      api.videos.update({
        params: { id: state.videoId },
        headers: { "x-clip-admin": state.adminKey },
        payload: { email },
      }),
    ).catch(() => undefined);
    setEmailSaved(true);
  };

  return (
    <div className="home">
      <div>
        <Logo />
      </div>
      <div className="home-center">
        {state.step === "idle" ? (
          <div
            className={`drop ${over ? "over" : ""} ${state.error ? "error" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const file = e.dataTransfer.files[0];
              if (file) void start(file);
            }}
          >
            <div className="drop-icon">
              <UploadIcon />
            </div>
            <div>
              <h1>Déposez une vidéo</h1>
              <p className="lead">On s'occupe du reste. Vous recevez un lien.</p>
            </div>
            <button
              className="btn primary"
              style={{ height: 44, padding: "0 20px", fontSize: 15 }}
              onClick={() => input.current?.click()}
            >
              Choisir un fichier
            </button>
            {state.error ? (
              <div className="error-text">{state.error}</div>
            ) : (
              <div className="formats">mp4 · mov · webm · jusqu'à 2 Go</div>
            )}
            <input
              ref={input}
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void start(file);
                e.target.value = "";
              }}
            />
          </div>
        ) : (
          <div className="uploading">
            <div className="upload-head">
              <div>
                <div className="upload-name">{state.file.name}</div>
                <div className="mono faint" style={{ fontSize: 12, marginTop: 4 }}>
                  {formatBytes(state.file.size)}
                  {state.speed > 0 &&
                    ` · ${formatBytes(state.speed)}/s · reste ${Math.max(0, Math.ceil((state.file.size - state.loaded) / state.speed))} s`}
                </div>
              </div>
              <div className="upload-pct">
                {Math.floor((state.loaded / state.file.size) * 100)} %
              </div>
            </div>
            <div className="bar">
              <div style={{ width: `${(state.loaded / state.file.size) * 100}%` }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label htmlFor="email" style={{ fontSize: 14 }}>
                Pendant ce temps : votre email ? (facultatif)
              </label>
              <form
                className="field"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveEmail();
                }}
              >
                <input
                  id="email"
                  className="input"
                  type="email"
                  placeholder="vous@exemple.fr"
                  value={email}
                  disabled={emailSaved}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <button
                  className="btn primary"
                  style={{ height: 44, borderRadius: 12 }}
                  disabled={emailSaved}
                >
                  {emailSaved ? "Noté" : "OK"}
                </button>
              </form>
              <div className="muted" style={{ fontSize: 13 }}>
                Pour être prévenu des commentaires et y répondre par email.
              </div>
            </div>
          </div>
        )}
        <div className="muted">
          {state.step === "uploading"
            ? "Ne fermez pas l'onglet : votre page s'ouvre dès la fin de l'envoi."
            : "Pas de compte. Le lien expire quand vous voulez."}
        </div>
      </div>
      <div className="home-foot">
        stream · workers ai · durable objects · workflows · r2 · email
      </div>
    </div>
  );
};
