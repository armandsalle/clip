import { useEffect, useMemo, useRef, useState } from "react";
import type { EnrichmentStatus, VideoId } from "@clip/domain";
import type { VideoView } from "@clip/contract";
import { TranscriptLine } from "../../ui/blocks.tsx";
import { languageName, speakerColor, speakerName, speakingTime } from "../../lib/speakers.ts";
import { formatTime } from "../../util.ts";
import { PanelEmpty } from "./PanelEmpty.tsx";

/**
 * Transcription par intervenant : temps de parole, filtre par voix, recherche, segment
 * en cours surligné (et suivi), téléchargement du .vtt.
 */
export const Transcript = ({
  id,
  view,
  status,
  time,
  onSeek,
}: {
  id: VideoId;
  view: VideoView;
  status: EnrichmentStatus | undefined;
  time: number;
  onSeek: (t: number) => void;
}) => {
  const [speaker, setSpeaker] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const segments = view.transcript;
  const voices = useMemo(() => speakingTime(segments), [segments]);
  const needle = query.trim().toLowerCase();
  // Textes mis en minuscules une fois ; filtre recalculé seulement si la recherche change
  // (pas à chaque tick du lecteur).
  const lowered = useMemo(() => segments.map((s) => s.text.toLowerCase()), [segments]);
  const shown = useMemo(
    () =>
      segments.filter(
        (s, i) =>
          (speaker === null || s.speaker === speaker) &&
          (needle === "" || lowered[i]!.includes(needle)),
      ),
    [segments, lowered, speaker, needle],
  );
  const current = segments.findIndex((s) => time >= s.start && time < s.end);

  // Suit la lecture : le segment en cours reste visible (sans voler le défilement de la page).
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>("[aria-current=true]");
    const box = list.current;
    if (!el || !box) return;
    const top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + el.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTo({ top: top - box.clientHeight / 3, behavior: "smooth" });
    }
  }, [current]);

  if (segments.length === 0) {
    return (
      <PanelEmpty
        status={status}
        waiting={status?._tag === "Running" ? "Transcription en cours…" : "En attente de l'audio"}
        hint="Deepgram Nova-3 transcrit la vidéo et sépare les voix ; le texte apparaîtra ici."
      />
    );
  }

  return (
    <div className="v-transcript">
      <div className="v-transcript-head">
        {voices.length > 0 && (
          <>
            <div className="v-transcript-row">
              <p className="v-caps">Temps de parole</p>
              {view.language && (
                <span className="c-badge c-badge-raised">
                  {languageName(view.language)} <span className="c-fg-3">détecté</span>
                </span>
              )}
            </div>
            <div className="v-share-bar" aria-hidden>
              {voices.map((v) => (
                <span
                  key={v.speaker}
                  style={{ flexGrow: v.share, background: speakerColor(v.speaker) }}
                />
              ))}
            </div>
            <div className="v-voices" role="group" aria-label="Filtrer par intervenant">
              <button
                type="button"
                className={`v-voice ${speaker === null ? "v-voice-active" : ""}`}
                aria-pressed={speaker === null}
                onClick={() => setSpeaker(null)}
              >
                Tous
              </button>
              {voices.map((v) => (
                <button
                  key={v.speaker}
                  type="button"
                  className={`v-voice ${speaker === v.speaker ? "v-voice-active" : ""}`}
                  aria-pressed={speaker === v.speaker}
                  onClick={() => setSpeaker(speaker === v.speaker ? null : v.speaker)}
                >
                  <span
                    className="c-dot"
                    style={{ background: speakerColor(v.speaker) }}
                    aria-hidden
                  />
                  {speakerName(v.speaker)}
                  <span className="c-mono c-fg-3">{formatTime(v.seconds)}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <label className="v-search">
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--clip-fg-3)" strokeWidth="1.4" />
            <path
              d="m9.5 9.5 3 3"
              fill="none"
              stroke="var(--clip-fg-3)"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher dans la transcription"
            aria-label="Rechercher dans la transcription"
          />
        </label>
      </div>
      <div className="v-transcript-list" ref={list}>
        {shown.length === 0 ? (
          <p className="v-panel-note">Aucun passage ne correspond.</p>
        ) : (
          shown.map((s) => (
            <TranscriptLine
              key={s.start}
              speaker={speakerName(s.speaker)}
              color={speakerColor(s.speaker)}
              time={formatTime(s.start)}
              text={s.text}
              current={segments[current] === s}
              onSeek={() => onSeek(s.start)}
            />
          ))
        )}
      </div>
      <div className="v-panel-foot">
        <span className="c-mono c-fg-3">
          Deepgram Nova-3
          {voices.length > 0 && ` · ${voices.length} ${voices.length > 1 ? "voix" : "voix"}`}
        </span>
        <a className="v-link" href={`/api/videos/${id}/captions.vtt`} download={`clip-${id}.vtt`}>
          Télécharger .vtt
        </a>
      </div>
    </div>
  );
};
