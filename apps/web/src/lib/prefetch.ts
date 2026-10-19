import type Hls from "hls.js";

// Préchargement des segments HLS : Stream sert un segment « froid » en ~0,5 s et
// « chaud » en ~0,08 s, avec `cache-control: public, max-age=864000`. Charger à
// l'avance les segments d'un instant (survol de la timeline, chapitres, commentaires)
// les met dans le cache HTTP du navigateur : le saut devient quasi instantané.

interface Fragmented {
  readonly details?:
    | {
        readonly fragments: ReadonlyArray<{
          readonly url: string;
          readonly start: number;
          readonly duration: number;
        }>;
      }
    | undefined;
}

/** Segments (vidéo du niveau courant, puis audio) qui couvrent `time`, et les `ahead - 1` suivants. */
export const segmentsAt = (hls: Hls, time: number, ahead = 2): ReadonlyArray<string> => {
  const level: Fragmented | undefined =
    hls.levels[hls.loadLevel >= 0 ? hls.loadLevel : hls.currentLevel];
  const audio: Fragmented | undefined = hls.audioTracks[hls.audioTrack];
  const around = (track: Fragmented | undefined) => {
    const fragments = track?.details?.fragments ?? [];
    const i = fragments.findIndex((f) => time >= f.start && time < f.start + f.duration);
    return i < 0 ? [] : fragments.slice(i, i + ahead).map((f) => f.url);
  };
  return [...around(level), ...around(audio)];
};

const done = new Set<string>();
let inFlight = 0;
const MAX_IN_FLIGHT = 4;

/** Charge les URL une seule fois, en basse priorité, sans gêner la lecture. */
export const prefetch = (urls: ReadonlyArray<string>) => {
  for (const url of urls) {
    if (done.has(url) || inFlight >= MAX_IN_FLIGHT) continue;
    done.add(url);
    inFlight++;
    void fetch(url, { mode: "cors", credentials: "omit", priority: "low" })
      .then((r) => r.arrayBuffer())
      .catch(() => done.delete(url))
      .finally(() => inFlight--);
  }
};
