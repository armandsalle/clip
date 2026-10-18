import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { galleryQuery } from "../api/queries.ts";
import { ApiError, errorMessage } from "../api/client.ts";
import { copy } from "../copy.ts";
import { cardDuration, cardMeta, cardStatus } from "../lib/cardStatus.ts";
import { AppNav } from "../ui/AppNav.tsx";
import { VideoCard } from "../ui/blocks.tsx";
import { Button } from "../ui/controls.tsx";
import "./gallery.css";

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
    <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--clip-fg-2)" strokeWidth="1.4" />
    <path
      d="m9.5 9.5 3 3"
      fill="none"
      stroke="var(--clip-fg-2)"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

/** Champ de recherche : `/` y place le curseur ; la recherche part après une courte pause. */
const Search = ({ value, onChange }: { value: string; onChange: (q: string) => void }) => {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), 250);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, [contenteditable=true]");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <label className="g-search">
      <SearchIcon />
      <input
        ref={input}
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDraft("");
          if (e.key === "Enter") onChange(draft);
        }}
        placeholder={copy.gallery.search}
        aria-label={copy.gallery.search}
      />
      <kbd className="g-kbd">/</kbd>
    </label>
  );
};

const Skeletons = () => (
  <div className="g-grid" aria-busy="true" aria-label="Chargement de la galerie">
    {Array.from({ length: 8 }, (_, i) => (
      <div key={i} className="g-skeleton">
        <div className="g-skeleton-thumb" />
        <div className="g-skeleton-line" />
        <div className="g-skeleton-line g-skeleton-short" />
      </div>
    ))}
  </div>
);

const Empty = () => (
  <div className="g-empty">
    <span className="g-state-icon" aria-hidden>
      <svg width="18" height="18" viewBox="0 0 22 22">
        <path
          d="M11 15V3M5.5 8.5 11 3l5.5 5.5M3 17v2h16v-2"
          fill="none"
          stroke="var(--clip-fg)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
    <h2 className="g-state-title">{copy.gallery.empty.title}</h2>
    <p className="g-state-text">{copy.gallery.empty.text}</p>
    <Link to="/upload" className="c-btn c-btn-primary">
      {copy.gallery.empty.action}
    </Link>
  </div>
);

const Failure = ({ error, onRetry }: { error: unknown; onRetry: () => void }) => (
  <div className="g-error" role="alert">
    <span className="g-state-icon g-state-icon-failed" aria-hidden>
      <svg width="18" height="18" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--clip-failed)" strokeWidth="1.6" />
        <path d="M10 6v5" stroke="var(--clip-failed)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="10" cy="13.8" r="1" fill="var(--clip-failed)" />
      </svg>
    </span>
    <h2 className="g-state-title">{copy.gallery.error.title}</h2>
    <p className="g-state-text">
      {error instanceof ApiError && error.tag !== "Unknown"
        ? errorMessage(error)
        : copy.gallery.error.text}
    </p>
    <Button onClick={onRetry}>{copy.gallery.error.retry}</Button>
    {error instanceof ApiError && <p className="g-error-tag">{error.tag}</p>}
  </div>
);

/** Galerie publique : toutes les vidéos de la démo, plus récentes d'abord. */
export const Gallery = ({ q, onSearch }: { q: string; onSearch: (q: string) => void }) => {
  const query = useInfiniteQuery(galleryQuery(q));
  const pages = query.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const total = pages[0]?.total;

  return (
    <div className="g-page">
      <AppNav />
      <main>
        <div className="g-head">
          <div className="g-title">
            <h1>{copy.gallery.title}</h1>
            {total !== undefined &&
              (q ? (
                <p>{copy.gallery.results(total)}</p>
              ) : (
                <p>
                  <span className="g-sub-long">{copy.gallery.subtitle(total)}</span>
                  <span className="g-sub-short">{copy.gallery.subtitleShort(total)}</span>
                </p>
              ))}
          </div>
          <Search value={q} onChange={onSearch} />
        </div>

        {query.isPending ? (
          <Skeletons />
        ) : query.isError ? (
          <Failure error={query.error} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          q ? (
            <div className="g-noresult">
              <p>{copy.gallery.noResult(q)}</p>
              <button type="button" className="g-link" onClick={() => onSearch("")}>
                {copy.gallery.clearSearch}
              </button>
            </div>
          ) : (
            <Empty />
          )
        ) : (
          <>
            <ul className="g-grid">
              {items.map(({ video, comments, enrichments, thumbnail }) => (
                <li key={video.id}>
                  <Link to="/v/$id" params={{ id: video.id }} className="g-card-link">
                    <VideoCard
                      title={video.title ?? copy.gallery.untitled}
                      meta={cardMeta(video, comments)}
                      thumbnail={thumbnail}
                      duration={cardDuration(video)}
                      status={cardStatus(video, enrichments)}
                    />
                  </Link>
                </li>
              ))}
            </ul>
            {query.hasNextPage && (
              <div className="g-more">
                <Button
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? copy.gallery.loadingMore : copy.gallery.more}
                </Button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};
