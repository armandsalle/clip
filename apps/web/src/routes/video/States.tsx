import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnrichmentKind, EnrichmentStatus, VideoId } from "@clip/domain";
import type { VideoView } from "@clip/contract";
import { formatTime } from "../../util.ts";

// États de la page vidéo (artboard « Page vidéo · états »).

export const VideoSkeleton = () => (
  <div className="v-skeleton" aria-busy="true" aria-label="Chargement de la vidéo">
    <div className="v-skeleton-main">
      <div className="v-skeleton-player" />
      <div className="v-skeleton-line" />
      <div className="v-skeleton-line v-skeleton-short" />
    </div>
    <div className="v-skeleton-side">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="v-skeleton-block" />
      ))}
    </div>
  </div>
);

type TileState = "done" | "running" | "waiting" | "failed";

const tile = (status: EnrichmentStatus | undefined): TileState =>
  status?._tag === "Done"
    ? "done"
    : status?._tag === "Running"
      ? "running"
      : status?._tag === "Failed"
        ? "failed"
        : "waiting";

/** Le lecteur est remplacé par l'avancement tant que la vidéo n'est pas lisible. */
export const Processing = ({
  id,
  view,
  steps,
}: {
  id: VideoId;
  view: VideoView;
  steps: Readonly<Record<string, EnrichmentStatus>>;
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const status = view.video.status;
  const elapsed = Math.max(0, (now - view.video.createdAt.epochMilliseconds) / 1000);
  const uploaded = status._tag !== "Uploading";
  const encoding = steps.encoding;
  const at = (kind: EnrichmentKind) => steps[kind] ?? view.enrichments[kind];
  const tiles: ReadonlyArray<{ label: string; state: TileState; detail: string }> = [
    {
      label: "Envoi",
      state: uploaded ? "done" : "running",
      detail: uploaded ? "reçu" : formatTime(elapsed),
    },
    {
      label: "Encodage",
      state: status._tag === "Ready" ? "done" : uploaded ? "running" : "waiting",
      detail:
        encoding?._tag === "Running" && encoding.progress !== undefined
          ? `${Math.floor(encoding.progress)} %`
          : uploaded
            ? "Stream"
            : "attente",
    },
    {
      label: "Transcription",
      state: tile(at("transcript")),
      detail: tile(at("transcript")) === "waiting" ? "attente" : "Deepgram",
    },
    {
      label: "Résumé",
      state: tile(at("summary")),
      detail: tile(at("summary")) === "waiting" ? "attente" : "Workers AI",
    },
    {
      label: "Miniatures",
      state: tile(at("thumbnail")),
      detail: tile(at("thumbnail")) === "waiting" ? "attente" : "Stream",
    },
  ];
  const step = tiles.filter((t) => t.state === "done").length + 1;
  return (
    <div className="v-processing">
      <h2>Votre vidéo se prépare</h2>
      <p>Le lien fonctionne déjà. La lecture démarre dès la première version encodée.</p>
      <ol className="v-tiles">
        {tiles.map((t) => (
          <li key={t.label} className={`v-tile v-tile-${t.state}`}>
            <span className="v-tile-bar" aria-hidden />
            <span className="v-tile-label">{t.label}</span>
            <span className="v-tile-detail">{t.detail}</span>
          </li>
        ))}
      </ol>
      <div className="v-processing-foot">
        <span className="c-mono c-fg-3">
          Workflow VideoPipeline · étape {Math.min(step, tiles.length)}/{tiles.length}
        </span>
        <Link to="/v/$id/coulisses" params={{ id }} className="v-link">
          Voir les coulisses
        </Link>
      </div>
    </div>
  );
};

export const EncodingFailed = ({ reason, isOwner }: { reason: string; isOwner: boolean }) => (
  <div className="v-failed">
    <h2>
      <span className="v-failed-mark" aria-hidden />
      L'encodage a échoué
    </h2>
    <p>
      Stream n'a pas pu lire ce fichier : les autres étapes n'ont pas été lancées.
      {isOwner && " Déposez une nouvelle version, dans un autre format si possible."}
    </p>
    {isOwner && (
      <Link to="/upload" className="c-btn c-btn-primary">
        Déposer une nouvelle version
      </Link>
    )}
    <p className="c-mono c-fg-3">EncodingFailed · {reason}</p>
  </div>
);

export const Unavailable = ({ detail }: { detail: string }) => (
  <div className="v-gone">
    <h2>Cette vidéo n'est plus disponible</h2>
    <p>
      Elle a expiré ou a été supprimée, avec sa transcription et ses commentaires. Demandez une
      nouvelle version à la personne qui vous l'a envoyée.
    </p>
    <Link to="/" className="c-btn c-btn-secondary">
      Retour à la galerie
    </Link>
    <p className="c-mono c-fg-3">{detail}</p>
  </div>
);
