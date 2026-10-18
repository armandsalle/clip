import type { ReactNode } from "react";
import { DurationBadge, EmailReplyBadge, TimecodeBadge } from "./Badge.tsx";
import { StepGlyph, type StepState } from "./steps.tsx";

// Blocs des Fondations Paper : carte vidéo, tuile de pipeline, commentaire,
// segment de transcription, timeline.

/** Carte de la galerie : miniature (ou dégradé tant qu'il n'y en a pas), titre, méta. */
export const VideoCard = ({
  title,
  meta,
  thumbnail,
  duration,
  status,
}: {
  title: string;
  meta: string;
  thumbnail?: string | null | undefined;
  duration?: string | null | undefined;
  /** Étape en cours, affichée sur la miniature (ex. « Transcription 2/5 »). */
  status?: { readonly label: string; readonly tone: "running" | "failed" } | null | undefined;
}) => (
  <article className="c-card">
    <div className="c-card-thumb">
      {thumbnail && <img src={thumbnail} alt="" loading="lazy" decoding="async" />}
      {status && (
        <span className={`c-card-status c-tone-${status.tone}`}>
          <span className="c-dot" aria-hidden />
          {status.label}
        </span>
      )}
      {duration && (
        <span className="c-card-duration">
          <DurationBadge>{duration}</DurationBadge>
        </span>
      )}
    </div>
    <div className="c-card-text">
      <h3 className="c-card-title">{title}</h3>
      <p className="c-card-meta">{meta}</p>
    </div>
  </article>
);

const tileLabels: Record<StepState, string> = {
  pending: "attente",
  running: "en cours",
  retry: "retry",
  done: "succès",
  failed: "échec",
  disabled: "flag off",
};

/** Tuile d'une étape du pipeline (48 px) et son libellé mono. */
export const PipelineTile = ({
  state,
  label,
  detail,
}: {
  state: StepState;
  /** Nom de l'étape ; par défaut, l'état. */
  label?: string | undefined;
  detail?: string | undefined;
}) => (
  <div className={`c-ptile c-ptile-${state}`}>
    <div className="c-ptile-box">
      <StepGlyph state={state} size={18} />
    </div>
    <span className="c-ptile-label">{label ?? tileLabels[state]}</span>
    {detail && <span className="c-ptile-detail">{detail}</span>}
  </div>
);

/** Commentaire horodaté ; le timecode est cliquable et fait sauter le lecteur. */
export const CommentItem = ({
  author,
  color,
  time,
  ago,
  body,
  onSeek,
  viaEmail = false,
  reply = false,
  children,
}: {
  author: string;
  color: string;
  time: string;
  ago: string;
  body: string;
  onSeek?: (() => void) | undefined;
  viaEmail?: boolean;
  /** Réponse dans un fil : barre latérale au lieu de l'avatar. */
  reply?: boolean;
  children?: ReactNode;
}) => (
  <div className={`c-comment ${reply ? "c-comment-reply" : ""}`}>
    {reply ? (
      <span className="c-comment-bar" style={{ background: color }} aria-hidden />
    ) : (
      <span className="c-avatar" style={{ background: color }} aria-hidden />
    )}
    <div className="c-comment-main">
      <div className="c-comment-head">
        <span className="c-comment-author" style={reply ? { color } : undefined}>
          {author}
        </span>
        {reply ? (
          <span className="c-mono c-fg-3">{time}</span>
        ) : (
          <TimecodeBadge onClick={onSeek} label={`Aller à ${time}`}>
            {time}
          </TimecodeBadge>
        )}
        <span className="c-comment-ago">{ago}</span>
        {viaEmail && <EmailReplyBadge />}
      </div>
      <p className="c-comment-body">{body}</p>
      {children}
    </div>
  </div>
);

/** Segment de transcription, coloré par intervenant ; surligné pendant sa lecture. */
export const TranscriptLine = ({
  speaker,
  color,
  time,
  text,
  current = false,
  onSeek,
}: {
  speaker: string;
  color: string;
  time: string;
  text: string;
  current?: boolean;
  onSeek: () => void;
}) => (
  <button
    type="button"
    className={`c-segment ${current ? "c-segment-current" : ""}`}
    onClick={onSeek}
    aria-current={current ? "true" : undefined}
  >
    <span className="c-comment-bar" style={{ background: color }} aria-hidden />
    <span className="c-segment-main">
      <span className="c-comment-head">
        <span className="c-comment-author" style={{ color }}>
          {speaker}
        </span>
        <span className="c-mono c-fg-3">{time}</span>
      </span>
      <span className="c-comment-body">{text}</span>
    </span>
  </button>
);

/**
 * Timeline : segments = chapitres (remplis jusqu'à la tête de lecture), losanges =
 * commentaires. Les positions sont en fraction de la durée (0 à 1).
 */
export const Timeline = ({
  chapters,
  markers,
  progress,
}: {
  chapters: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  markers: ReadonlyArray<number>;
  progress: number;
}) => {
  const segments = chapters.length > 0 ? chapters : [{ start: 0, end: 1 }];
  return (
    <div className="c-timeline">
      {segments.map((s) => {
        const fill = Math.min(1, Math.max(0, (progress - s.start) / (s.end - s.start || 1)));
        return (
          <span key={s.start} className="c-timeline-seg" style={{ flexGrow: s.end - s.start }}>
            <span className="c-timeline-fill" style={{ width: `${fill * 100}%` }} />
          </span>
        );
      })}
      {markers.map((m, i) => (
        <span key={`${m}-${i}`} className="c-timeline-marker" style={{ left: `${m * 100}%` }} />
      ))}
    </div>
  );
};
