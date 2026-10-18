import { useEffect, useRef, useState } from "react";
import type { EnrichmentStatus, Expiry, VideoId } from "@clip/domain";
import type { UpdateVideo, VideoView } from "@clip/contract";
import { call } from "./api/client.ts";
import { Panel } from "./Panel.tsx";
import { Player } from "./Player.tsx";
import { Logo, PencilIcon } from "./ui/icons.tsx";
import { stepDetail, stepState, Tile } from "./ui/steps.tsx";
import { useVideo } from "./useVideo.ts";
import { Link } from "@tanstack/react-router";
import { adminKeyFor, copy, formatTime, viewerName } from "./util.ts";

const shareUrl = (id: string) => `${location.origin}/v/${id}`;
const thumbBase = (url: string) => url.split("?")[0]!;

export const VideoPage = ({ id }: { id: VideoId }) => {
  const { view, error, comments, freshIds, steps, live } = useVideo(id);
  const [adminKey] = useState(() => adminKeyFor(id));
  const [time, setTime] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  if (error) return <Gone message={error} />;
  if (!view)
    return (
      <div className="topbar">
        <Logo />
      </div>
    );

  const video = view.video;
  const status = video.status._tag;
  if (status === "Deleted" || status === "Expired")
    return <Gone message="Cette vidéo n'est plus disponible." />;

  const isOwner = adminKey !== null;
  const playable = status === "Ready" && view.playback !== null;
  const duration = video.status._tag === "Ready" ? video.status.duration : 0;
  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    void v.play();
  };

  // Le spectateur courant apparaît aussi dans la présence : on le retire de la timeline.
  const myName = viewerName() ?? "Anonyme";
  let selfSkipped = false;
  const others = live.viewers.filter((v) => {
    if (!selfSkipped && v.name === myName && Math.abs(v.time - time) < 3) {
      selfSkipped = true;
      return false;
    }
    return true;
  });

  return (
    <div>
      <TopBar
        view={view}
        adminKey={adminKey}
        viewers={live.viewers.length}
        onShare={async () => setToast((await copy(shareUrl(id))) ? "Lien copié" : shareUrl(id))}
      />
      <div className="video-layout">
        <main className="video-main">
          {playable ? (
            <Player
              src={view.playback!.hls}
              poster={view.playback!.thumbnail}
              captions={
                view.transcript.length > 0
                  ? `/api/videos/${id}/captions.vtt?n=${view.transcript.length}`
                  : undefined
              }
              captionsLang={view.language ?? undefined}
              videoRef={videoRef}
              duration={duration}
              comments={comments}
              viewers={others}
              selfId={null}
              chapters={view.chapters}
              onTime={(t) => {
                setTime(t);
                live.sendTime(t);
              }}
            />
          ) : status === "Failed" ? (
            <div className="pipeline-card">
              <h2>L'encodage a échoué</h2>
              <p className="muted">
                {video.status._tag === "Failed" ? video.status.reason : ""} Déposez la vidéo à
                nouveau, dans un autre format si possible.
              </p>
            </div>
          ) : (
            <PipelineCard view={view} steps={steps} />
          )}

          {playable && steps.hd?._tag === "Running" && (
            <div style={{ marginTop: 8 }}>
              <span className="hd-badge" title="Stream encode encore les qualités hautes">
                HD en cours
                {steps.hd.progress !== undefined && ` · ${Math.floor(steps.hd.progress)} %`}
              </span>
            </div>
          )}

          {view.chapters.length > 0 && (
            <div className="chapters">
              Chapitres
              {view.chapters.map((c, i) => {
                const next = view.chapters[i + 1]?.time ?? Infinity;
                return (
                  <button
                    key={c.time}
                    className={`chip ${time >= c.time && time < next ? "active" : ""}`}
                    onClick={() => seek(c.time)}
                  >
                    <span className="mono">{formatTime(c.time)}</span>
                    {c.title}
                  </button>
                );
              })}
            </div>
          )}

          {isOwner && !playable && (
            <Links id={id} adminKey={adminKey} onCopied={() => setToast("Lien copié")} />
          )}
          {isOwner && (
            <OwnerControls
              view={view}
              adminKey={adminKey}
              time={time}
              playable={playable}
              onToast={setToast}
            />
          )}
        </main>
        <Panel
          view={view}
          steps={steps}
          comments={comments}
          freshIds={freshIds}
          time={time}
          playable={playable}
          isOwner={isOwner}
          onSeek={seek}
        />
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};

const Gone = ({ message }: { message: string }) => (
  <div className="home">
    <div>
      <Logo />
    </div>
    <div className="home-center">
      <h1 style={{ margin: 0, fontSize: 28, letterSpacing: "-0.03em" }}>{message}</h1>
      <Link className="btn primary" to="/" style={{ textDecoration: "none" }}>
        Déposer une vidéo
      </Link>
    </div>
  </div>
);

const TopBar = ({
  view,
  adminKey,
  viewers,
  onShare,
}: {
  view: VideoView;
  adminKey: string | null;
  viewers: number;
  onShare: () => void;
}) => {
  const video = view.video;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(video.title ?? "");
  const summaryRunning = view.enrichments.summary._tag !== "Done";

  const save = async () => {
    setEditing(false);
    const title = draft.trim();
    if (!adminKey || !title || title === video.title) return;
    await call((api) =>
      api.videos.update({
        params: { id: video.id },
        headers: { "x-clip-admin": adminKey },
        payload: { title },
      }),
    ).catch(() => undefined);
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Logo />
        <span className="crumb">/</span>
        {editing ? (
          <input
            className="title-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="title">{video.title ?? "Vidéo sans titre"}</span>
        )}
        {adminKey && !editing && (
          <button
            className="icon-btn"
            aria-label="Renommer"
            onClick={() => {
              setDraft(video.title ?? "");
              setEditing(true);
            }}
          >
            <PencilIcon />
          </button>
        )}
        {video.title === null && summaryRunning && (
          <span className="mono faint hide-mobile" style={{ fontSize: 12 }}>
            le titre arrive…
          </span>
        )}
      </div>
      <div className="topbar-right">
        <div className="presence hide-mobile">
          <div className="avatars">
            {Array.from({ length: Math.min(4, Math.max(1, viewers)) }, (_, i) => (
              <div
                key={i}
                className="avatar"
                style={{ background: `var(--clip-presence-${i + 1})` }}
              />
            ))}
          </div>
          {viewers <= 1 ? "vous seul" : `${viewers} regardent`}
        </div>
        <Link
          className="btn"
          to="/v/$id/coulisses"
          params={{ id: video.id }}
          style={{ textDecoration: "none" }}
        >
          Coulisses
        </Link>
        <button className="btn primary" onClick={onShare}>
          Partager
        </button>
      </div>
    </header>
  );
};

/** Ce que montre la page pendant le traitement : le Workflow, étape par étape. */
const PipelineCard = ({
  view,
  steps,
}: {
  view: VideoView;
  steps: Readonly<Record<string, EnrichmentStatus>>;
}) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const status = view.video.status._tag;
  // Le serveur ne marque la vidéo qu'à l'encodage : le premier événement du pipeline
  // sur l'encodage prouve que le fichier est arrivé.
  const uploaded = status !== "Uploading" || steps.encoding !== undefined;
  const elapsed = Math.max(0, Math.floor((now - view.video.createdAt.epochMilliseconds) / 1000));
  const rows: ReadonlyArray<[string, ReadonlyArray<string>]> = [
    ["miniature auto", ["thumbnail"]],
    ["transcription → titre, résumé, chapitres → index", ["transcript", "summary", "index"]],
    ["suggestions de miniatures", ["suggestions"]],
    ["vignettes · carte de partage", ["storyboard", "shareCard"]],
  ];
  const all = rows.flatMap(([, kinds]) => kinds);
  const finished = all.filter((k) =>
    ["done", "failed", "disabled"].includes(stepState(steps[k])),
  ).length;
  const progress = (Number(uploaded) + Number(status === "Ready") + finished) / (2 + all.length);

  return (
    <div className="pipeline-card">
      <div className="pipeline-head">
        <div>
          <h2>Votre vidéo arrive</h2>
          <div className="muted" style={{ marginTop: 6 }}>
            Lisible dans une vingtaine de secondes. Le reste arrive ensuite, au fil de l'eau.
          </div>
        </div>
        <span className="mono faint" style={{ fontSize: 12 }}>
          workflow · {formatTime(elapsed).padStart(5, "0")}
        </span>
      </div>
      <div className="pipeline-row">
        <div className="stage">
          <Tile state={uploaded ? "done" : "running"} />
          upload
          <small>{uploaded ? "terminé" : "en cours"}</small>
        </div>
        <div className="arrow">→</div>
        <div className="stage">
          <Tile state={!uploaded ? "pending" : status === "Ready" ? "done" : "running"} />
          encodage
          <small className={uploaded && status !== "Ready" ? "c-running" : ""}>
            {!uploaded ? "en attente" : status === "Ready" ? "lisible" : "Stream"}
          </small>
        </div>
        <div className="arrow">→</div>
        <div className="steps">
          {rows.map(([label, kinds]) => {
            const current =
              kinds.map((k) => steps[k]).find((s) => stepState(s) !== "done") ?? steps[kinds[0]!];
            const state = stepState(current);
            return (
              <div key={label} className="step-row">
                <span className={`c-${state === "retry" ? "retry" : state}`} style={{ width: 14 }}>
                  {state === "done"
                    ? "✓"
                    : state === "failed"
                      ? "✕"
                      : state === "disabled"
                        ? "⊘"
                        : state === "pending"
                          ? "◌"
                          : "●"}
                </span>
                <span className="label">{label}</span>
                <span className={`state c-${state}`}>{stepDetail(current)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "auto" }}>
        <div className="bar">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          Vous pouvez déjà partager le lien : la page se mettra à jour toute seule chez tout le
          monde.
        </div>
      </div>
    </div>
  );
};

const Links = ({
  id,
  adminKey,
  onCopied,
}: {
  id: string;
  adminKey: string;
  onCopied: () => void;
}) => {
  const share = shareUrl(id);
  const admin = `${share}?k=${adminKey}`;
  return (
    <div className="links">
      <div className="link-box">
        <span style={{ fontSize: 13, fontWeight: 500 }}>Lien de partage</span>
        <div className="link-field">
          <span>{share.replace(/^https?:\/\//, "")}</span>
          <button className="btn primary small" onClick={() => void copy(share).then(onCopied)}>
            Copier
          </button>
        </div>
      </div>
      <div className="link-box">
        <span className="muted" style={{ fontSize: 13 }}>
          Votre lien d'admin · gardez-le pour vous
        </span>
        <div className="link-field">
          <span className="faint">{`${share.replace(/^https?:\/\//, "")}?k=••••••••`}</span>
          <button className="btn small" onClick={() => void copy(admin).then(onCopied)}>
            Copier
          </button>
        </div>
      </div>
    </div>
  );
};

const EXPIRIES: ReadonlyArray<[Expiry, string]> = [
  ["never", "jamais"],
  ["1d", "24 h"],
  ["7d", "7 jours"],
  ["30d", "30 j"],
];

/** Email du propriétaire : notifications de commentaires et réponses par email. */
const EmailSetting = ({
  videoId,
  update,
  onToast,
}: {
  videoId: string;
  update: (payload: typeof UpdateVideo.Type) => Promise<boolean>;
  onToast: (message: string) => void;
}) => {
  const key = `clip:email:${videoId}`;
  const [saved, setSaved] = useState<string | null>(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  });
  const [value, setValue] = useState(saved ?? "");
  const remember = (email: string | null) => {
    setSaved(email);
    try {
      if (email === null) localStorage.removeItem(key);
      else localStorage.setItem(key, email);
    } catch {
      // stockage indisponible : l'email reste enregistré côté serveur
    }
  };
  const save = async (email: string | null) => {
    // Marqué comme enregistré seulement si le serveur confirme.
    if (!(await update({ email }))) return;
    remember(email);
    onToast(email === null ? "Notifications désactivées" : `Notifications envoyées à ${email}`);
  };
  return (
    <div className="owner-block">
      <span className="owner-label">Notifications</span>
      <form
        className="email-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.includes("@")) void save(value.trim());
        }}
      >
        <input
          type="email"
          placeholder="votre@email.fr"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" disabled={!value.includes("@")}>
          {saved ? "Enregistrer" : "Activer"}
        </button>
        {saved && (
          <button type="button" className="link-danger" onClick={() => void save(null)}>
            Retirer
          </button>
        )}
      </form>
      <span className="owner-hint">
        {saved
          ? `Les nouveaux commentaires arrivent sur ${saved} ; répondez à l'email pour répondre.`
          : "Recevez les commentaires par email et répondez-y depuis votre messagerie."}
      </span>
    </div>
  );
};

const OwnerControls = ({
  view,
  adminKey,
  time,
  playable,
  onToast,
}: {
  view: VideoView;
  adminKey: string;
  time: number;
  playable: boolean;
  onToast: (message: string) => void;
}) => {
  const video = view.video;
  /** `true` si le serveur a confirmé ; sinon un message d'erreur est affiché. */
  const update = (payload: typeof UpdateVideo.Type): Promise<boolean> =>
    call((api) =>
      api.videos.update({
        params: { id: video.id },
        headers: { "x-clip-admin": adminKey },
        payload,
      }),
    ).then(
      () => true,
      (e: unknown) => {
        onToast(e instanceof Error ? e.message : "Modification impossible.");
        return false;
      },
    );

  const selected = video.thumbnail._tag === "Frame" ? video.thumbnail.time : null;
  const base = view.playback ? thumbBase(view.playback.thumbnail) : null;
  const suggestions = view.thumbnailSuggestions;

  return (
    <section className="owner">
      <div className="owner-block">
        <span className="owner-label">Miniature</span>
        <div className="thumbs">
          {(suggestions.length > 0 ? suggestions : [null, null, null]).map((t, i) =>
            t === null || base === null ? (
              <div key={i} className="thumb" />
            ) : (
              <button
                key={t}
                className={`thumb ${selected !== null && Math.abs(selected - t) < 0.5 ? "selected" : ""}`}
                title={`Image à ${formatTime(t)}`}
                onClick={() =>
                  void update({ thumbnail: { _tag: "Frame", time: t } }).then(
                    (ok) => ok && onToast("Miniature mise à jour"),
                  )
                }
              >
                <img src={`${base}?time=${Math.floor(t)}s`} alt="" loading="lazy" />
              </button>
            ),
          )}
          <button
            className={`thumb timeline ${selected !== null && !suggestions.some((s) => Math.abs(s - selected) < 0.5) ? "selected" : ""}`}
            disabled={!playable}
            onClick={() =>
              void update({ thumbnail: { _tag: "Frame", time: Math.floor(time) } }).then(
                (ok) => ok && onToast(`Miniature : image à ${formatTime(time)}`),
              )
            }
          >
            sur la timeline
          </button>
        </div>
        <span className="owner-hint">
          {suggestions.length > 0
            ? `${suggestions.length} suggestions · ou l'image en cours de lecture`
            : "suggestions en cours…"}
        </span>
      </div>
      <EmailSetting videoId={video.id} update={update} onToast={onToast} />
      <div className="owner-block">
        <span className="owner-label">Expiration</span>
        <div className="segmented">
          {EXPIRIES.map(([value, label]) => (
            <button
              key={value}
              className={video.expiry === value ? "active" : ""}
              onClick={() => void update({ expiry: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="owner-actions">
        <button
          className="link-danger"
          onClick={() => {
            if (
              !confirm("Supprimer cette vidéo ? Le lien cessera de fonctionner pour tout le monde.")
            )
              return;
            void call((api) =>
              api.videos.remove({
                params: { id: video.id },
                headers: { "x-clip-admin": adminKey },
              }),
            ).catch((e: unknown) =>
              onToast(e instanceof Error ? e.message : "Suppression impossible."),
            );
          }}
        >
          Supprimer
        </button>
      </div>
    </section>
  );
};
