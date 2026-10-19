import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Schema } from "effect";
import type { VideoId } from "@clip/domain";
import { Email, MAX_UPLOAD_BYTES } from "@clip/contract";
import { call, errorMessage } from "../api/client.ts";
import { copy as text } from "../copy.ts";
import {
  clearPending,
  isSameFile,
  readPending,
  writePending,
  type PendingUpload,
} from "../lib/pendingUpload.ts";
import { CHUNK_BYTES, probeVideo, startUpload, type UploadControl } from "../lib/upload.ts";
import { AppNav } from "../ui/AppNav.tsx";
import { Button, Field } from "../ui/controls.tsx";
import {
  copy as copyToClipboard,
  formatBytes,
  formatTime,
  ownerEmail,
  rememberAdminKey,
} from "../util.ts";
import "./upload.css";

// Dépôt façon Smash : Fichier → Email (obligatoire) → Envoi. Le lien de partage est
// actif dès la création ; l'envoi tus reprend après une coupure ou un rechargement.

const emailStandard = Schema.toStandardSchemaV1(Email);

type Rejected = { readonly kind: "type" | "size"; readonly file: File };

interface Chosen {
  readonly file: File;
  readonly duration: number | null;
  readonly preview: string | null;
}

interface Sending {
  readonly file: File;
  readonly videoId: VideoId;
  readonly email: string;
  readonly loaded: number;
  readonly speed: number;
  readonly status:
    | { readonly _tag: "running" }
    | { readonly _tag: "paused" }
    | { readonly _tag: "retrying"; readonly at: number }
    | { readonly _tag: "resumed"; readonly from: number };
}

type State =
  | { readonly step: "file"; readonly rejected?: Rejected; readonly error?: string }
  | { readonly step: "resume"; readonly pending: PendingUpload; readonly error?: string }
  | { readonly step: "email"; readonly chosen: Chosen; readonly error?: string }
  | { readonly step: "sending"; readonly sending: Sending }
  | { readonly step: "done"; readonly videoId: VideoId; readonly email: string };

const isVideo = (file: File) =>
  file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name);

const formatEta = (seconds: number) =>
  seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;

const Check = () => (
  <svg width="10" height="10" viewBox="0 0 20 20" aria-hidden>
    <path
      d="m5 10.5 3.2 3.2L15 6.8"
      fill="none"
      stroke="var(--clip-bg)"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Fichier → Email → Envoi ; `current` : 0, 1 ou 2. */
const Steps = ({ current }: { current: 0 | 1 | 2 }) => (
  <ol className="u-steps" aria-label="Étapes du dépôt">
    {text.upload.steps.map((label, i) => (
      <li
        key={label}
        className={`u-step ${i < current ? "u-step-done" : i === current ? "u-step-current" : ""}`}
        aria-current={i === current ? "step" : undefined}
      >
        <span className="u-step-dot">{i < current ? <Check /> : i + 1}</span>
        {label}
      </li>
    ))}
  </ol>
);

const DropZone = ({
  onFile,
  tone = "idle",
  children,
}: {
  onFile: (file: File) => void;
  tone?: "idle" | "error";
  children: ReactNode;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`u-drop u-drop-${tone} ${over ? "u-drop-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      {children}
      <button type="button" className="u-drop-button" onClick={() => input.current?.click()}>
        <span className="u-sr">{text.upload.drop.text}</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="video/*,.mov,.mkv,.m4v"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
};

export const Upload = () => {
  const navigate = useNavigate();
  const [state, setState] = useState<State>(() => {
    const pending = readPending();
    return pending ? { step: "resume", pending } : { step: "file" };
  });
  const control = useRef<UploadControl | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  // Horloge du compte à rebours de nouvel essai.
  useEffect(() => {
    if (state.step !== "sending" || state.sending.status._tag !== "retrying") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [state]);

  // Quitter la page pendant l'envoi : on prévient (la reprise reste possible).
  useEffect(() => {
    if (state.step !== "sending") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [state.step]);

  /** Nouvel essai programmé après une coupure : annulé par « Annuler » et au démontage. */
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Quitter la page (navigation dans l'app) : l'envoi s'arrête mais reste reprenable,
  // l'URL tus mémorisée sert à la reprise.
  useEffect(
    () => () => {
      clearTimeout(retryTimer.current);
      control.current?.stop();
    },
    [],
  );

  useEffect(() => {
    if (state.step !== "done") return;
    const timer = setTimeout(
      () => void navigate({ to: "/v/$id", params: { id: state.videoId } }),
      1400,
    );
    return () => clearTimeout(timer);
  }, [state, navigate]);

  const choose = async (file: File) => {
    if (!isVideo(file)) return setState({ step: "file", rejected: { kind: "type", file } });
    if (file.size > MAX_UPLOAD_BYTES)
      return setState({ step: "file", rejected: { kind: "size", file } });
    const { duration, preview } = await probeVideo(file);
    setState({ step: "email", chosen: { file, duration, preview } });
  };

  /** Lance (ou relance) l'envoi des octets vers l'URL d'upload. */
  const send = (file: File, duration: number | null, pending: PendingUpload, startAt = 0) => {
    rememberAdminKey(pending.videoId, pending.adminKey);
    writePending(pending);
    let lastSaved = 0;
    const update = (f: (s: Sending) => Sending) =>
      setState((st) => (st.step === "sending" ? { step: "sending", sending: f(st.sending) } : st));
    setState({
      step: "sending",
      sending: {
        file,
        videoId: pending.videoId,
        email: pending.email,
        loaded: startAt,
        speed: 0,
        status: startAt > 0 ? { _tag: "resumed", from: startAt } : { _tag: "running" },
      },
    });
    control.current = startUpload(pending.uploadUrl, pending.protocol, file, duration, {
      onProgress: (loaded, speed) => {
        update((s) => ({
          ...s,
          loaded,
          speed,
          status: s.status._tag === "retrying" ? { _tag: "resumed", from: s.loaded } : s.status,
        }));
        if (loaded - lastSaved > CHUNK_BYTES) {
          lastSaved = loaded;
          writePending({ ...pending, loaded });
        }
      },
      onRetry: (inMs) =>
        update((s) => ({ ...s, status: { _tag: "retrying", at: Date.now() + inMs } })),
      onSuccess: () => {
        clearPending();
        control.current = null;
        setState({ step: "done", videoId: pending.videoId, email: pending.email });
      },
      // Toutes les tentatives de tus ont échoué : on réessaie quand même, toutes les 4 s,
      // tant que l'onglet est ouvert (la reprise après rechargement reste possible).
      onError: () => {
        update((s) => ({ ...s, status: { _tag: "retrying", at: Date.now() + 4000 } }));
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => control.current?.resume(), 4000);
      },
    });
  };

  const form = useForm({
    defaultValues: { email: ownerEmail.last() ?? "" },
    onSubmit: async ({ value }) => {
      if (state.step !== "email") return;
      const { file, duration } = state.chosen;
      const email = value.email.trim();
      try {
        const created = await call((api) =>
          api.videos.create({ payload: { email, expiry: "7d", size: file.size } }),
        );
        ownerEmail.remember(created.video.id, email);
        send(file, duration, {
          videoId: created.video.id,
          adminKey: created.adminKey,
          uploadUrl: new URL(created.uploadUrl, location.href).href,
          protocol: created.uploadProtocol,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          loaded: 0,
          email,
        });
      } catch (error) {
        setState({ ...state, error: errorMessage(error) });
      }
    },
  });

  const card = (() => {
    switch (state.step) {
      case "file": {
        const { rejected } = state;
        return (
          <>
            <Steps current={0} />
            {rejected ? (
              <DropZone onFile={choose} tone="error">
                <p className="u-drop-title">
                  {rejected.kind === "type" ? text.upload.notVideo : text.upload.tooBig}
                </p>
                <p className="u-drop-meta">
                  {rejected.file.name} ·{" "}
                  {rejected.kind === "type"
                    ? rejected.file.type || "type inconnu"
                    : formatBytes(rejected.file.size)}
                </p>
                {rejected.kind === "size" && (
                  <p className="u-drop-text">{text.upload.tooBigHint}</p>
                )}
                <span className="u-drop-link">{text.upload.otherFile}</span>
              </DropZone>
            ) : (
              <DropZone onFile={choose}>
                <span className="u-drop-icon" aria-hidden>
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path
                      d="M6 9V2M3 4.5 6 1.5l3 3"
                      fill="none"
                      stroke="var(--clip-fg)"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <p className="u-drop-title">{text.upload.drop.title}</p>
                <p className="u-drop-text">{text.upload.drop.text}</p>
              </DropZone>
            )}
            <p className="u-footnote u-mono">
              {rejected ? text.upload.checkedLocally : text.upload.drop.footer}
            </p>
            {state.error && <p className="u-error">{state.error}</p>}
          </>
        );
      }

      case "resume": {
        const { pending } = state;
        const pct = Math.floor((pending.loaded / pending.size) * 100);
        return (
          <>
            <div className="u-block">
              <h2 className="u-title">{text.upload.pendingTitle}</h2>
              <p className="u-text">{text.upload.pendingText(pending.name, pct)}</p>
            </div>
            <div className="u-bar u-bar-muted">
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="u-actions">
              <label className="c-btn c-btn-primary u-file-button">
                {text.upload.pendingResume}
                <input
                  type="file"
                  accept="video/*,.mov,.mkv,.m4v"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    if (!isSameFile(pending, file)) {
                      setState({ ...state, error: text.upload.wrongFile });
                      return;
                    }
                    send(file, null, pending, pending.loaded);
                  }}
                />
              </label>
              <Button
                onClick={() => {
                  clearPending();
                  setState({ step: "file" });
                }}
              >
                {text.upload.pendingRestart}
              </Button>
            </div>
            {state.error ? (
              <p className="u-error">{state.error}</p>
            ) : (
              <p className="u-footnote u-mono">{text.upload.pendingNote}</p>
            )}
          </>
        );
      }

      case "email": {
        const { chosen } = state;
        return (
          <form
            className="u-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <Steps current={1} />
            <div className="u-file">
              {chosen.preview ? (
                <img className="u-file-thumb" src={chosen.preview} alt="" />
              ) : (
                <span className="u-file-thumb" aria-hidden />
              )}
              <div className="u-file-text">
                <span className="u-file-name">{chosen.file.name}</span>
                <span className="u-file-meta u-mono">
                  {formatBytes(chosen.file.size)}
                  {chosen.duration !== null && ` · ${formatTime(chosen.duration)}`}
                </span>
              </div>
              <button type="button" className="u-change" onClick={() => setState({ step: "file" })}>
                {text.upload.change}
              </button>
            </div>
            <form.Field name="email" validators={{ onChange: emailStandard }}>
              {(field) => (
                <Field
                  label={text.upload.emailLabel}
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="vous@exemple.fr"
                  autoFocus
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  error={
                    // Erreur affichée une fois le champ quitté (pas pendant la première saisie).
                    field.state.meta.isBlurred || form.state.submissionAttempts > 0
                      ? field.state.meta.errors.map((e) => e?.message).find(Boolean)
                      : undefined
                  }
                  hint={text.upload.emailHint}
                />
              )}
            </form.Field>
            <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <button type="submit" className="u-submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? text.upload.creating : text.upload.send}
                </button>
              )}
            </form.Subscribe>
            {state.error && (
              <p className="u-error" role="alert">
                {state.error}
              </p>
            )}
          </form>
        );
      }

      case "sending": {
        const s = state.sending;
        const pct = Math.min(100, Math.floor((s.loaded / s.file.size) * 100));
        const remaining = s.speed > 0 ? (s.file.size - s.loaded) / s.speed : null;
        const share = `${location.origin}/v/${s.videoId}`;
        const lost = s.status._tag === "retrying";
        const paused = s.status._tag === "paused";
        return (
          <>
            <Steps current={2} />
            <div className="u-progress-head">
              <span className={`u-pct ${lost ? "u-pct-lost" : ""}`}>{pct} %</span>
              <span className={`u-mono u-eta ${lost ? "u-eta-lost" : ""}`}>
                {lost && s.status._tag === "retrying"
                  ? text.upload.retryIn(Math.max(0, Math.ceil((s.status.at - now) / 1000)))
                  : paused
                    ? text.upload.paused
                    : remaining !== null
                      ? text.upload.eta(formatEta(remaining))
                      : ""}
              </span>
            </div>
            <div className={`u-bar ${lost ? "u-bar-lost" : ""}`}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="u-progress-meta u-mono">
              <span>{text.upload.sentOf(formatBytes(s.loaded), formatBytes(s.file.size))}</span>
              {!lost && !paused && s.speed > 0 && <span>{formatBytes(s.speed)}/s</span>}
            </div>
            {lost ? (
              <div className="u-notice">
                <span className="u-notice-dot u-notice-lost" aria-hidden />
                <div>
                  <p className="u-notice-title">{text.upload.lost}</p>
                  <p className="u-notice-text">{text.upload.lostHint(formatBytes(s.loaded))}</p>
                </div>
              </div>
            ) : (
              s.status._tag === "resumed" && (
                <div className="u-notice">
                  <span className="u-notice-dot" aria-hidden />
                  <div>
                    <p className="u-notice-title">
                      {text.upload.resumed(formatBytes(s.status.from))}
                    </p>
                    <p className="u-notice-text">
                      {text.upload.resumedHint(formatBytes(CHUNK_BYTES))}
                    </p>
                  </div>
                </div>
              )
            )}
            <div className="u-share">
              <p className="u-share-title">{text.upload.shareTitle}</p>
              <div className="u-share-row">
                <span className="u-mono u-share-url">{share.replace(/^https?:\/\//, "")}</span>
                <button
                  type="button"
                  className="u-copy"
                  onClick={() =>
                    void copyToClipboard(share).then((ok) => {
                      setCopied(ok);
                      setTimeout(() => setCopied(false), 1500);
                    })
                  }
                >
                  {copied ? text.upload.copied : text.upload.copy}
                </button>
              </div>
            </div>
            <div className="u-sending-foot">
              <p className="u-footnote">{text.upload.keepOpen}</p>
              {lost ? (
                <div className="u-actions">
                  <Button
                    variant="primary"
                    onClick={() => {
                      clearTimeout(retryTimer.current);
                      control.current?.pause?.();
                      control.current?.resume();
                    }}
                  >
                    {text.upload.retryNow}
                  </Button>
                  <Button
                    onClick={() => {
                      clearTimeout(retryTimer.current);
                      control.current?.abort();
                      control.current = null;
                      clearPending();
                      setState({ step: "file" });
                    }}
                  >
                    {text.upload.cancel}
                  </Button>
                </div>
              ) : (
                control.current?.pause && (
                  <Button
                    onClick={() => {
                      if (paused) {
                        control.current?.resume();
                        setState({
                          step: "sending",
                          sending: { ...s, status: { _tag: "running" } },
                        });
                      } else {
                        control.current?.pause?.();
                        setState({
                          step: "sending",
                          sending: { ...s, status: { _tag: "paused" } },
                        });
                      }
                    }}
                  >
                    {paused ? text.upload.resume : text.upload.pause}
                  </Button>
                )
              )}
            </div>
          </>
        );
      }

      case "done":
        return (
          <div className="u-done" role="status">
            <p className="u-done-title">
              <span className="u-done-check" aria-hidden>
                <Check />
              </span>
              {text.upload.done}
            </p>
            <p className="u-text">{text.upload.doneText}</p>
            <div className="u-bar u-bar-done">
              <span />
            </div>
            <p className="u-footnote u-mono">
              {text.upload.doneNote(`/v/${state.videoId}`, state.email)}
            </p>
          </div>
        );
    }
  })();

  return (
    <div className="u-page">
      <AppNav />
      <main className="u-body">
        <section className="u-hero">
          <h1>
            {text.upload.hero.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </h1>
          <p className="u-intro">{text.upload.intro}</p>
          <ul className="u-perks u-mono">
            {text.upload.perks.map((perk) => (
              <li key={perk}>{perk}</li>
            ))}
          </ul>
        </section>
        <section className="u-card" aria-live="polite">
          {card}
        </section>
      </main>
    </div>
  );
};
