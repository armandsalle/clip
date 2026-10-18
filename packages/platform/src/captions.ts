import type { TranscriptSegment } from "@clip/contract";

const vttTime = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
};

/** WebVTT avec les intervenants (`<v Intervenant 1>`), lus par les lecteurs HLS. */
export const toVtt = (segments: ReadonlyArray<typeof TranscriptSegment.Type>): string =>
  [
    "WEBVTT",
    ...segments.map(
      (s, i) =>
        `${i + 1}\n${vttTime(s.start)} --> ${vttTime(Math.max(s.end, s.start + 0.5))}\n${
          s.speaker == null ? "" : `<v Intervenant ${s.speaker + 1}>`
        }${s.text}`,
    ),
  ].join("\n\n");
