import type { ReactNode } from "react";
import { MailIcon } from "./icons.tsx";

// Badges des Fondations Paper. Les états (en cours, prête, échec, retry) portent
// leur couleur ; le reste est neutre.

export type BadgeTone = "running" | "success" | "failed" | "retry";

/** Pastille d'état : point de couleur et libellé. */
export const StatusBadge = ({
  tone,
  dot = true,
  children,
}: {
  tone: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}) => (
  <span className={`c-badge c-badge-pill c-tone-${tone}`}>
    {dot && <span className="c-dot" aria-hidden />}
    {children}
  </span>
);

/** Durée sur une miniature (fond sombre translucide). */
export const DurationBadge = ({ children }: { children: ReactNode }) => (
  <span className="c-badge c-badge-overlay c-mono">{children}</span>
);

/** Timecode (mono, fond relevé), cliquable quand `onClick` est donné. */
export const TimecodeBadge = ({
  children,
  onClick,
  label,
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  label?: string;
}) =>
  onClick ? (
    <button
      type="button"
      className="c-badge c-badge-raised c-mono c-timecode"
      onClick={onClick}
      aria-label={label}
    >
      <svg width="7" height="8" viewBox="0 0 8 10" aria-hidden>
        <path d="M0 0l8 5-8 5z" fill="var(--clip-fg)" />
      </svg>
      {children}
    </button>
  ) : (
    <span className="c-badge c-badge-raised c-mono">{children}</span>
  );

/** Rendition courante du lecteur (« HD 1080p »). */
export const RenditionBadge = ({ children }: { children: ReactNode }) => (
  <span className="c-badge c-badge-outline c-mono">{children}</span>
);

/** Langue détectée (« FR · détectée »). */
export const LanguageBadge = ({ children }: { children: ReactNode }) => (
  <span className="c-badge c-badge-raised c-mono c-badge-muted">{children}</span>
);

export const EmailReplyBadge = () => (
  <span className="c-badge c-badge-pill c-badge-line">
    <MailIcon />
    répondu par email
  </span>
);

/** Fonction coupée par un flag (« flag ai · off »). */
export const FlagBadge = ({ children }: { children: ReactNode }) => (
  <span className="c-badge c-badge-pill c-badge-dashed c-mono">{children}</span>
);
