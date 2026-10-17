import { useEffect, useRef, useState } from "react";
import type { Comment, CommentId, EnrichmentStatus, VideoId } from "@clip/domain";
import type { VideoView } from "@clip/contract";
import { call } from "./api.ts";
import { MailIcon } from "./ui.tsx";
import { formatAgo, formatTime, presenceColor, rememberViewerName, viewerName } from "./util.ts";

type Tab = "summary" | "transcript" | "comments" | "qa";

export const Panel = ({
  view,
  steps,
  comments,
  freshIds,
  time,
  playable,
  isOwner,
  onSeek,
}: {
  view: VideoView;
  steps: Readonly<Record<string, EnrichmentStatus>>;
  comments: ReadonlyArray<Comment>;
  freshIds: ReadonlySet<string>;
  time: number;
  playable: boolean;
  isOwner: boolean;
  onSeek: (time: number) => void;
}) => {
  const [tab, setTab] = useState<Tab>(playable ? "comments" : "summary");
  const tabs: ReadonlyArray<[Tab, string, number | null]> = [
    ["summary", "Résumé", null],
    ["transcript", "Transcription", null],
    ["comments", "Commentaires", comments.length],
    ["qa", "Q&R", null],
  ];
  return (
    <aside className="panel">
      <nav className="tabs">
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            className={`tab ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
            {count !== null && <span className="count">{count}</span>}
          </button>
        ))}
      </nav>
      {tab === "summary" && <Summary view={view} status={steps.summary} onSeek={onSeek} />}
      {tab === "transcript" && (
        <Transcript view={view} status={steps.transcript} time={time} onSeek={onSeek} />
      )}
      {tab === "comments" && (
        <Comments
          videoId={view.video.id}
          comments={comments}
          freshIds={freshIds}
          time={time}
          playable={playable}
          isOwner={isOwner}
          onSeek={onSeek}
        />
      )}
      {tab === "qa" && <QuestionsSoon />}
    </aside>
  );
};

const Pending = ({ label, hint }: { label: string; hint: string }) => (
  <div className="panel-body">
    <div className="waiting">{label}</div>
    <div className="skeleton" style={{ width: "70%", marginTop: 20 }} />
    <div className="skeleton" />
    <div className="skeleton" style={{ width: "92%" }} />
    <div className="skeleton" style={{ width: "60%" }} />
    <p className="muted" style={{ fontSize: 13, marginTop: 24 }}>
      {hint}
    </p>
  </div>
);

const Unavailable = ({ status }: { status: EnrichmentStatus | undefined }) => (
  <div className="panel-body">
    <p className="empty">
      {status?._tag === "Disabled"
        ? "Cette étape est désactivée pour le moment. La vidéo reste lisible."
        : "Cette étape n'a pas abouti. La vidéo reste lisible."}
    </p>
  </div>
);

const Summary = ({
  view,
  status,
  onSeek,
}: {
  view: VideoView;
  status: EnrichmentStatus | undefined;
  onSeek: (t: number) => void;
}) => {
  if (status?._tag === "Failed" || status?._tag === "Disabled")
    return <Unavailable status={status} />;
  if (view.summary === null)
    return (
      <Pending
        label={status?._tag === "Running" ? "le résumé s'écrit…" : "en attente de la transcription"}
        hint="Le titre, le résumé et les chapitres s'écriront ici en direct dès que la transcription commence."
      />
    );
  return (
    <div className="panel-body summary">
      <p>{view.summary}</p>
      {view.chapters.length > 0 && (
        <>
          <h3>Chapitres</h3>
          {view.chapters.map((c) => (
            <button key={c.time} className="segment" onClick={() => onSeek(c.time)}>
              <span className="mono">{formatTime(c.time)}</span>
              {c.title}
            </button>
          ))}
        </>
      )}
    </div>
  );
};

const Transcript = ({
  view,
  status,
  time,
  onSeek,
}: {
  view: VideoView;
  status: EnrichmentStatus | undefined;
  time: number;
  onSeek: (t: number) => void;
}) => {
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => current.current?.scrollIntoView({ block: "nearest" }), [time]);
  if (status?._tag === "Failed" || status?._tag === "Disabled")
    return <Unavailable status={status} />;
  if (view.transcript.length === 0)
    return (
      <Pending
        label="transcription en cours…"
        hint="La transcription arrive au fil de l'eau ; cliquez sur une phrase pour y aller."
      />
    );
  return (
    <div className="panel-body">
      {view.transcript.map((s) => {
        const active = time >= s.start && time < s.end;
        return (
          <button
            key={s.start}
            ref={active ? current : undefined}
            className={`segment ${active ? "current" : ""}`}
            onClick={() => onSeek(s.start)}
          >
            <span className="mono">{formatTime(s.start)}</span>
            {s.text}
          </button>
        );
      })}
    </div>
  );
};

const Comments = ({
  videoId,
  comments,
  freshIds,
  time,
  playable,
  isOwner,
  onSeek,
}: {
  videoId: VideoId;
  comments: ReadonlyArray<Comment>;
  freshIds: ReadonlySet<string>;
  time: number;
  playable: boolean;
  isOwner: boolean;
  onSeek: (t: number) => void;
}) => {
  const [body, setBody] = useState("");
  const [name, setName] = useState(viewerName() ?? "");
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const needsName = !viewerName();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const roots = comments.filter((c) => c.parentId === null);
  const repliesOf = (id: CommentId) => comments.filter((c) => c.parentId === id);
  const at = replyTo ? replyTo.time : time;

  const send = async () => {
    const author = name.trim();
    if (!body.trim() || !author) return;
    setSending(true);
    setError(null);
    try {
      rememberViewerName(author);
      await call((api) =>
        api.videos.comment({
          params: { id: videoId },
          payload: { author, body: body.trim(), time: at, parentId: replyTo?.id ?? null },
        }),
      );
      setBody("");
      setReplyTo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Envoi impossible.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="panel-body">
        {roots.length === 0 && (
          <p className="empty">
            {playable
              ? "Aucun commentaire pour l'instant. Le vôtre s'accrochera au moment en cours."
              : "Commentaires ouverts dès la lecture possible."}
          </p>
        )}
        {roots.map((c) => (
          <div key={c.id} className={`comment ${freshIds.has(c.id) ? "fresh" : ""}`}>
            <div className="comment-avatar" style={{ background: presenceColor(c.author) }} />
            <div className="comment-main">
              <div className="comment-head">
                <strong>{c.author}</strong>
                <button className="timecode" onClick={() => onSeek(c.time)}>
                  {formatTime(c.time)}
                </button>
                <span className="faint">{formatAgo(new Date(c.createdAt.epochMilliseconds))}</span>
              </div>
              <div>{c.body}</div>
              {repliesOf(c.id).map((r) => (
                <div key={r.id} className={`reply ${freshIds.has(r.id) ? "fresh" : ""}`}>
                  <div className="comment-main">
                    <div className="comment-head">
                      <strong>{r.author}</strong>
                      {r.via === "email" && (
                        <>
                          <span className="muted">répondu par email</span>
                          <MailIcon />
                        </>
                      )}
                    </div>
                    <div>{r.body}</div>
                  </div>
                </div>
              ))}
              {playable && (
                <div style={{ paddingTop: 4 }}>
                  <button className="pill" onClick={() => setReplyTo(c)}>
                    Répondre
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="panel-foot">
        {playable ? (
          <>
            {needsName && (
              <input
                className="input"
                style={{ height: 36 }}
                placeholder={
                  isOwner
                    ? "Votre prénom (affiché à vos spectateurs)"
                    : "Votre prénom (affiché avec vos commentaires)"
                }
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input
                placeholder={
                  replyTo ? `Répondre à ${replyTo.author}…` : `Commenter à ${formatTime(at)}…`
                }
                value={body}
                maxLength={2000}
                onChange={(e) => setBody(e.target.value)}
              />
              <button disabled={sending || !body.trim() || !name.trim()}>Envoyer</button>
            </form>
            {replyTo && (
              <button
                className="pill"
                style={{ alignSelf: "flex-start" }}
                onClick={() => setReplyTo(null)}
              >
                Annuler la réponse
              </button>
            )}
            {error && <div className="error-text">{error}</div>}
          </>
        ) : (
          <div className="composer inactive">Commentaires ouverts dès la lecture possible.</div>
        )}
      </div>
    </>
  );
};

const QuestionsSoon = () => (
  <>
    <div className="panel-body">
      <p className="empty">
        Bientôt : posez une question à la vidéo, la réponse cite les moments où on en parle.
      </p>
    </div>
    <div className="panel-foot">
      <div className="composer inactive">Posez une question sur cette vidéo…</div>
      <div className="faint" style={{ fontSize: 12 }}>
        Réponses tirées de la transcription, avec les moments cités.
      </div>
    </div>
  </>
);
