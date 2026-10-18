// Position de lecture : conservée pour cet onglet (sessionStorage) afin qu'un
// rafraîchissement reprenne au même endroit, sans rien mettre dans l'URL (qui reste
// partageable et cachable). `?t=` est réservé aux liens de partage : lu une fois, puis
// retiré de la barre d'adresse.

export interface PositionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const key = (videoId: string) => `clip:pos:${videoId}`;

/** « 80 », « 1:20 », « 1m20s », « 1h02m » → secondes ; `null` si illisible. */
export const parseTime = (raw: string): number | null => {
  const value = raw.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (units && value !== "") {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  return null;
};

/**
 * Où démarrer : `?t=` du lien de partage d'abord, sinon la position mémorisée.
 * `shareParam` indique qu'il faut retirer `t` de l'URL.
 */
export const startPosition = (
  videoId: string,
  search: URLSearchParams,
  storage: PositionStorage | null,
): { readonly time: number; readonly shareParam: boolean } => {
  const fromLink = search.get("t");
  if (fromLink !== null) {
    const t = parseTime(fromLink);
    if (t !== null) return { time: t, shareParam: true };
  }
  try {
    const saved = Number(storage?.getItem(key(videoId)));
    return { time: Number.isFinite(saved) && saved > 0 ? saved : 0, shareParam: fromLink !== null };
  } catch {
    return { time: 0, shareParam: fromLink !== null };
  }
};

export const savePosition = (videoId: string, time: number, storage: PositionStorage | null) => {
  try {
    storage?.setItem(key(videoId), String(Math.floor(time)));
  } catch {
    // stockage indisponible (navigation privée) : on repartira du début
  }
};

/** Lien de partage qui démarre à `time` (secondes entières). */
export const shareLink = (origin: string, videoId: string, time?: number) =>
  `${origin}/v/${videoId}${time !== undefined && time >= 1 ? `?t=${Math.floor(time)}` : ""}`;
