import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VideoId } from "@clip/domain";
import { VideoView } from "@clip/contract";
import { ApiError, errorMessage } from "../../api/client.ts";
import { commentsQuery, keys, updateVideo, videoQuery } from "../../api/queries.ts";
import { useLiveVideo } from "../../live/useLiveVideo.ts";
import { savePosition, shareLink, startPosition } from "../../lib/position.ts";
import { actionFor, SHORTCUTS } from "../../lib/shortcuts.ts";
import { AppNav } from "../../ui/AppNav.tsx";
import { Tabs } from "../../ui/controls.tsx";
import { adminKeyFor, copy, formatTime, presenceColor, viewerName } from "../../util.ts";
import { Comments, type CommentsHandle } from "./Comments.tsx";
import { OwnerSettings } from "./OwnerSettings.tsx";
import { Player, type PlayerHandle } from "./Player.tsx";
import { EncodingFailed, Processing, Unavailable, VideoSkeleton } from "./States.tsx";
import { Summary } from "./Summary.tsx";
import { Transcript } from "./Transcript.tsx";
import "./video.css";

type Tab = "summary" | "transcript" | "comments";

const session = (() => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
})();

const dayFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

/** Titre, modifiable par le propriétaire (crayon). */
const Title = ({ view, adminKey }: { view: VideoView; adminKey: string | null }) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const rename = useMutation({
    mutationFn: (title: string) => updateVideo(view.video.id, adminKey ?? "", { title }),
    onSuccess: (video) =>
      queryClient.setQueryData<VideoView>(keys.video(video.id), (v) =>
        v ? new VideoView({ ...v, video }) : v,
      ),
  });
  const title =
    view.video.title ??
    (view.enrichments.summary._tag === "Done" ? "Sans titre" : "Titre en cours…");
  if (editing && adminKey) {
    return (
      <form
        className="v-title-form"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          if (next && next !== view.video.title) rename.mutate(next);
          setEditing(false);
        }}
      >
        <input
          className="v-title-input"
          value={draft}
          maxLength={120}
          autoFocus
          aria-label="Titre de la vidéo"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        />
      </form>
    );
  }
  return (
    <h1 className="v-title">
      {title}
      {adminKey && (
        <button
          type="button"
          className="v-edit"
          aria-label="Renommer la vidéo"
          onClick={() => {
            setDraft(view.video.title ?? "");
            setEditing(true);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path
              d="m9.5 2.5 2 2L5 11H3V9z"
              fill="none"
              stroke="var(--clip-fg-2)"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </h1>
  );
};

export const VideoPage = ({ id }: { id: VideoId }) => {
  const video = useQuery(videoQuery(id));
  const comments = useQuery(commentsQuery(id));
  const [adminKey] = useState(() => adminKeyFor(id));
  const [name] = useState(() => viewerName() ?? "Invité");
  const alive =
    video.data !== undefined && !["Expired", "Deleted"].includes(video.data.video.status._tag);
  const live = useLiveVideo(id, name, alive);
  const [start] = useState(() => startPosition(id, new URLSearchParams(location.search), session));
  // ?lecteur=natif : lecteur HLS du navigateur, pour le comparer à hls.js.
  const [engine] = useState<"auto" | "native">(() =>
    new URLSearchParams(location.search).get("lecteur") === "natif" ? "native" : "auto",
  );
  const [time, setTime] = useState(start.time);
  const [tab, setTab] = useState<Tab>("comments");
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const player = useRef<PlayerHandle>(null);
  const commentBox = useRef<CommentsHandle>(null);
  const lastSaved = useRef(0);

  // hls.js se télécharge pendant que la vue se charge, plutôt qu'après.
  useEffect(() => void import("hls.js"), []);

  // Lien de partage ?t= : lu une fois, puis retiré de la barre d'adresse.
  useEffect(() => {
    if (!start.shareParam) return;
    const url = new URL(location.href);
    url.searchParams.delete("t");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }, [start.shareParam]);

  useEffect(() => {
    const save = () => savePosition(id, player.current?.currentTime() ?? time, session);
    addEventListener("pagehide", save);
    return () => removeEventListener("pagehide", save);
  }, [id, time]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const view = video.data;
  const chapters = view?.chapters ?? [];

  // Raccourcis clavier (désactivés pendant la saisie).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor({ ...e, key: e.key, target: e.target as HTMLElement | null });
      const p = player.current;
      if (!action || !p) return;
      e.preventDefault();
      switch (action) {
        case "toggle":
          return p.toggle();
        case "back":
          return p.skip(-10);
        case "forward":
          return p.skip(10);
        case "captions":
          return p.toggleCaptions();
        case "fullscreen":
          return p.fullscreen();
        case "help":
          return setHelp((h) => !h);
        case "nextChapter": {
          const next = chapters.find((c) => c.time > p.currentTime() + 0.5);
          return next && p.seek(next.time);
        }
        case "commentHere":
          setSettings(false);
          setTab("comments");
          return requestAnimationFrame(() => commentBox.current?.focusAt(p.currentTime()));
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [chapters]);

  const body = (() => {
    if (video.isPending) return <VideoSkeleton />;
    if (video.isError || !view) {
      const gone = video.error instanceof ApiError && video.error.tag === "VideoNotFound";
      return gone ? (
        <Unavailable detail="404 · introuvable" />
      ) : (
        <div className="v-gone">
          <h2>La vidéo n'a pas pu se charger</h2>
          <p>{errorMessage(video.error)}</p>
          <button
            type="button"
            className="c-btn c-btn-secondary"
            onClick={() => void video.refetch()}
          >
            Réessayer
          </button>
        </div>
      );
    }
    const status = view.video.status;
    if (status._tag === "Expired" || status._tag === "Deleted") {
      return (
        <Unavailable
          detail={
            status._tag === "Expired"
              ? "410 · supprimée par le cron d'expiration"
              : "410 · supprimée par son propriétaire"
          }
        />
      );
    }

    const playable = status._tag === "Ready" && view.playback !== null;
    const duration = status._tag === "Ready" ? status.duration : 0;
    const list = comments.data ?? [];
    const seek = (t: number) => {
      player.current?.seek(t);
      savePosition(id, t, session);
    };
    const currentChapter = chapters.findLast((c) => c.time <= time);
    const viewers = live.viewers.length;

    return (
      <div className="v-layout">
        <div className="v-main">
          {playable ? (
            <Player
              ref={player}
              src={view.playback!.hls}
              poster={view.playback!.thumbnail}
              captions={
                view.transcript.length > 0
                  ? `/api/videos/${id}/captions.vtt?n=${view.transcript.length}`
                  : undefined
              }
              captionsLang={view.language ?? undefined}
              duration={duration}
              startAt={start.time}
              chapters={chapters}
              commentTimes={list.filter((c) => c.parentId === null).map((c) => c.time)}
              viewers={live.viewers.filter((v) => v.name !== name)}
              hd={live.steps.hd ?? view.enrichments.hd}
              engine={engine}
              onTime={(t, playing) => {
                setTime(t);
                live.sendTime(t);
                if (!playing || Math.abs(t - lastSaved.current) >= 5) {
                  lastSaved.current = t;
                  savePosition(id, t, session);
                }
              }}
            />
          ) : status._tag === "Failed" ? (
            <EncodingFailed reason={status.reason} isOwner={adminKey !== null} />
          ) : (
            <Processing id={id} view={view} steps={{ ...view.enrichments, ...live.steps }} />
          )}

          {playable && (
            <ul className="v-shortcuts" aria-label="Raccourcis clavier">
              {SHORTCUTS.map((s) => (
                <li key={s.label}>
                  {s.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                  {s.label}
                </li>
              ))}
            </ul>
          )}

          <div className="v-info">
            <div className="v-info-text">
              <Title view={view} adminKey={adminKey} />
              <p className="v-meta">
                Déposée le {dayFormat.format(new Date(view.video.createdAt.epochMilliseconds))}
                {duration > 0 && ` · ${formatTime(duration)}`}
                {viewers > 0 && (
                  <span className="v-presence">
                    <span className="v-presence-dots" aria-hidden>
                      {live.viewers.slice(0, 3).map((v) => (
                        <span key={v.id} style={{ background: presenceColor(v.name) }} />
                      ))}
                    </span>
                    {viewers === 1 ? "vous seul" : `${viewers} personnes regardent`}
                  </span>
                )}
              </p>
            </div>
            <div className="v-actions">
              <Link to="/v/$id/coulisses" params={{ id }} className="c-btn c-btn-secondary">
                Coulisses
              </Link>
              {adminKey && (
                <button
                  type="button"
                  className={`c-btn c-btn-secondary ${settings ? "v-active" : ""}`}
                  aria-pressed={settings}
                  onClick={() => setSettings((s) => !s)}
                >
                  Réglages
                </button>
              )}
              <button
                type="button"
                className="c-btn c-btn-primary"
                onClick={() =>
                  void copy(shareLink(location.origin, id)).then((ok) =>
                    setToast(ok ? "Lien copié" : shareLink(location.origin, id)),
                  )
                }
              >
                Copier le lien
              </button>
            </div>
          </div>

          {chapters.length > 0 && (
            <section className="v-chapters">
              <p className="v-caps">Chapitres · générés par Workers AI</p>
              <ol>
                {chapters.map((c) => (
                  <li key={c.time}>
                    <button
                      type="button"
                      className={`v-chapter ${currentChapter === c ? "v-chapter-current" : ""}`}
                      onClick={() => seek(c.time)}
                      disabled={!playable}
                    >
                      <span className="c-mono">{formatTime(c.time)}</span>
                      <span className="v-chapter-title">{c.title}</span>
                      {currentChapter === c && playable && (
                        <span className="v-chapter-now">en cours</span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <aside className="v-panel">
          {settings && adminKey ? (
            <OwnerSettings
              id={id}
              view={view}
              adminKey={adminKey}
              time={time}
              onClose={() => setSettings(false)}
            />
          ) : (
            <>
              <div className="v-tabs">
                <Tabs
                  label="Contenu de la vidéo"
                  value={tab}
                  onChange={setTab}
                  choices={[
                    { key: "summary", label: "Résumé" },
                    { key: "transcript", label: "Transcription" },
                    { key: "comments", label: "Commentaires", count: list.length },
                  ]}
                />
              </div>
              {tab === "summary" && (
                <Summary view={view} status={view.enrichments.summary} onSeek={seek} />
              )}
              {tab === "transcript" && (
                <Transcript
                  id={id}
                  view={view}
                  status={view.enrichments.transcript}
                  time={time}
                  onSeek={seek}
                />
              )}
              {tab === "comments" && (
                <Comments
                  ref={commentBox}
                  id={id}
                  comments={list}
                  freshIds={live.freshIds}
                  time={time}
                  duration={duration}
                  onSeek={seek}
                />
              )}
            </>
          )}
        </aside>
      </div>
    );
  })();

  return (
    <div className="v-page">
      <AppNav />
      <main>{body}</main>
      {help && (
        <div
          className="v-help"
          role="dialog"
          aria-label="Raccourcis clavier"
          onClick={() => setHelp(false)}
        >
          <div className="v-help-card" onClick={(e) => e.stopPropagation()}>
            <h2>Raccourcis clavier</h2>
            <ul>
              {SHORTCUTS.map((s) => (
                <li key={s.label}>
                  <span>
                    {s.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                  {s.label}
                </li>
              ))}
              <li>
                <span>
                  <kbd>←</kbd>
                  <kbd>→</kbd>
                </span>
                ±10 s
              </li>
            </ul>
            <button type="button" className="c-btn c-btn-secondary" onClick={() => setHelp(false)}>
              Fermer
            </button>
          </div>
        </div>
      )}
      {toast && (
        <div className="v-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
};
