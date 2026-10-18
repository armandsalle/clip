import { Link } from "@tanstack/react-router";

// Marque et icônes.

export const Logo = () => (
  <Link className="logo" to="/">
    <span className="logo-mark">
      <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden>
        <path d="M0 0l8 5-8 5z" fill="var(--clip-bg)" />
      </svg>
    </span>
    Clip
  </Link>
);

export const UploadIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
    <path
      d="M11 15V3M5.5 8.5 11 3l5.5 5.5M3 17v2h16v-2"
      fill="none"
      stroke="var(--clip-fg)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
    <path
      d="m9.5 2.5 2 2L5 11H3V9z"
      fill="none"
      stroke="var(--clip-fg-2)"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

export const MailIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect
      x="1"
      y="2.5"
      width="10"
      height="7"
      rx="1"
      fill="none"
      stroke="var(--clip-fg-2)"
      strokeWidth="1.1"
    />
    <path d="m1.5 3 4.5 3.5L10.5 3" fill="none" stroke="var(--clip-fg-2)" strokeWidth="1.1" />
  </svg>
);
