import type { EnrichmentStatus } from "@clip/domain";
import type { VideoView } from "@clip/contract";
import { TimecodeBadge } from "../../ui/Badge.tsx";
import { formatTime } from "../../util.ts";
import { languageName } from "../../lib/speakers.ts";
import { PanelEmpty } from "./PanelEmpty.tsx";

/** Résumé et points clés écrits par Workers AI, à partir de la transcription. */
export const Summary = ({
  view,
  status,
  onSeek,
}: {
  view: VideoView;
  status: EnrichmentStatus | undefined;
  onSeek: (t: number) => void;
}) => {
  if (view.summary === null) {
    return (
      <PanelEmpty
        status={status}
        waiting={
          status?._tag === "Running" ? "Le résumé s'écrit…" : "En attente de la transcription"
        }
        hint="Le titre, le résumé et les chapitres apparaîtront ici en direct."
      />
    );
  }
  return (
    <div className="v-panel-body v-summary">
      <div className="v-summary-meta">
        {view.language && (
          <span className="c-badge c-badge-raised">
            {languageName(view.language)} <span className="c-fg-3">détecté</span>
          </span>
        )}
        <span className="c-mono c-fg-3">résumé par Workers AI</span>
      </div>
      <p className="v-summary-text">{view.summary}</p>
      {view.chapters.length > 0 && (
        <>
          <p className="v-caps">Points clés</p>
          <ul className="v-points">
            {view.chapters.map((c) => (
              <li key={c.time}>
                <TimecodeBadge
                  onClick={() => onSeek(c.time)}
                  label={`Aller à ${formatTime(c.time)}`}
                >
                  {formatTime(c.time)}
                </TimecodeBadge>
                <span>{c.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};
