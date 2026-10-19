import { Link } from "@tanstack/react-router";
import { copy } from "../copy.ts";

// Barre du haut commune (galerie, et bientôt monitoring) : marque, navigation, Déposer.

export const UploadArrow = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <path
      d="M6 9V2M3 4.5 6 1.5l3 3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const AppNav = () => (
  <header className="c-nav">
    <nav className="c-nav-links" aria-label="Navigation principale">
      <Link to="/" className="c-brand" aria-label="Clip, galerie">
        <span className="c-brand-mark" aria-hidden>
          <svg width="8" height="10" viewBox="0 0 8 10">
            <path d="M0 0l8 5-8 5z" fill="var(--clip-bg)" />
          </svg>
        </span>
        Clip
      </Link>
      <Link
        to="/"
        className="c-nav-link"
        activeProps={{ className: "c-nav-link-active" }}
        activeOptions={{ exact: true, includeSearch: false }}
      >
        {copy.nav.gallery}
      </Link>
    </nav>
    <Link to="/upload" className="c-btn c-btn-primary c-nav-cta">
      <UploadArrow />
      {copy.nav.upload}
    </Link>
  </header>
);
