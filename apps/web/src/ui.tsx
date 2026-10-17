import type { EnrichmentStatus } from "@clip/domain";
import { navigate } from "./util.ts";

export const Logo = () => (
  <a
    className="logo"
    href="/"
    onClick={(e) => {
      e.preventDefault();
      navigate("/");
    }}
  >
    <span className="logo-mark">
      <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden>
        <path d="M0 0l8 5-8 5z" fill="var(--clip-bg)" />
      </svg>
    </span>
    Clip
  </a>
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

export const stepDetail = (status: EnrichmentStatus | undefined): string => {
  switch (status?._tag) {
    case undefined:
    case "Pending":
      return "en attente";
    case "Running":
      return status.attempt > 1 ? `nouvelle tentative ${status.attempt}/3` : "en cours";
    case "Done":
      return status.durationMs > 0
        ? `${(status.durationMs / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`
        : "fait";
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
