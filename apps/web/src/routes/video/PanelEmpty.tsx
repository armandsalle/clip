import type { EnrichmentStatus } from "@clip/domain";
import { FlagBadge } from "../../ui/Badge.tsx";

/** Onglet sans contenu : en attente, en échec ou coupé par un flag. */
export const PanelEmpty = ({
  status,
  waiting,
  hint,
}: {
  status: EnrichmentStatus | undefined;
  waiting: string;
  hint: string;
}) => (
  <div className="v-panel-empty">
    {status?._tag === "Disabled" ? (
      <>
        <FlagBadge>flag ai · off</FlagBadge>
        <p>
          L'IA est coupée pour cette vidéo : la lecture et les commentaires restent disponibles.
        </p>
      </>
    ) : status?._tag === "Failed" ? (
      <>
        <p className="v-panel-empty-title">Cette étape a échoué</p>
        <p>{status.error}</p>
      </>
    ) : (
      <>
        <p className="v-panel-empty-title">{waiting}</p>
        <p>{hint}</p>
      </>
    )}
  </div>
);
