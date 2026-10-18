import type { EnrichmentStatus } from "@clip/domain";

// États d'étape --------------------------------------------------------------------

/** État affiché d'une étape : celui du domaine, plus « retry » (tentative > 1). */
export type StepState = "pending" | "running" | "retry" | "done" | "failed" | "disabled";

export const stepState = (status: EnrichmentStatus | undefined): StepState => {
  switch (status?._tag) {
    case undefined:
    case "Pending":
      return "pending";
    case "Running":
      return status.attempt > 1 ? "retry" : "running";
    case "Done":
      return "done";
    case "Failed":
      return "failed";
    case "Disabled":
      return "disabled";
  }
};

/** Durée lisible : « 0,8 s », « 42 s », « 3 min 05 ». */
export const formatDuration = (ms: number): string => {
  if (ms < 10_000) return `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, "0")}`;
};

/**
 * Détail d'une étape. Avec `now`, une étape en cours affiche son chrono (depuis
 * `startedAt`) et son avancement quand il est connu.
 */
export const stepDetail = (status: EnrichmentStatus | undefined, now?: number): string => {
  switch (status?._tag) {
    case undefined:
    case "Pending":
      return "en attente";
    case "Running": {
      const label = status.attempt > 1 ? `nouvelle tentative ${status.attempt}/3` : "en cours";
      const chrono =
        now !== undefined && status.startedAt
          ? ` · ${formatDuration(Math.max(0, now - status.startedAt.epochMilliseconds))}`
          : "";
      const progress = status.progress === undefined ? "" : ` · ${Math.floor(status.progress)} %`;
      return `${label}${progress}${chrono}`;
    }
    case "Done":
      return status.durationMs > 0 ? formatDuration(status.durationMs) : "fait";
    case "Failed":
      return `échec · ${status.error}`;
    case "Disabled":
      return "désactivé (flag)";
  }
};

/** Glyphe de la tuile, selon l'état. */
export const StepGlyph = ({ state, size = 20 }: { state: StepState; size?: number }) => {
  switch (state) {
    case "pending":
      return <div className="pending-ring" />;
    case "running":
      return (
        <svg className="spin" width={size} height={size} viewBox="0 0 20 20" aria-hidden>
          <path
            d="M10 3a7 7 0 1 1-7 7"
            fill="none"
            stroke="var(--clip-running)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "retry":
      return (
        <svg className="spin" width={size} height={size} viewBox="0 0 20 20" aria-hidden>
          <path
            d="M15.5 8A6 6 0 1 0 16 11.5M15.5 3.5V8H11"
            fill="none"
            stroke="var(--clip-retry)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "done":
      return (
        <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
          <path
            d="m5 10.5 3.2 3.2L15 6.8"
            fill="none"
            stroke="var(--clip-success)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "failed":
      return (
        <svg width={size - 2} height={size - 2} viewBox="0 0 20 20" aria-hidden>
          <path
            d="m5 5 10 10M15 5 5 15"
            fill="none"
            stroke="var(--clip-failed)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "disabled":
      return (
        <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="var(--clip-disabled)"
            strokeWidth="1.6"
          />
          <path d="m5 15 10-10" fill="none" stroke="var(--clip-disabled)" strokeWidth="1.6" />
        </svg>
      );
  }
};

export const Tile = ({
  state,
  size = "",
  flashKey,
}: {
  state: StepState;
  size?: "" | "large" | "xl";
  /** Change à chaque événement : rejoue l'animation d'arrivée. */
  flashKey?: string | number | undefined;
}) => (
  <div key={flashKey} className={`tile ${size} ${state} ${flashKey === undefined ? "" : "flash"}`}>
    <StepGlyph state={state} size={size === "xl" ? 26 : 20} />
  </div>
);
