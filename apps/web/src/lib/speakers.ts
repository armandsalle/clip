import type { VideoView } from "@clip/contract";

// Intervenants de la transcription (diarisation Deepgram) : nom, couleur, temps de parole.

const SPEAKER_COLORS = ["var(--clip-speaker-1)", "var(--clip-speaker-2)", "var(--clip-speaker-3)"];

export const speakerColor = (speaker: number | null | undefined) =>
  speaker == null ? "var(--clip-fg-3)" : SPEAKER_COLORS[speaker % SPEAKER_COLORS.length]!;

export const speakerName = (speaker: number | null | undefined) =>
  speaker == null ? "Voix" : `Intervenant ${speaker + 1}`;

export const speakingTime = (segments: VideoView["transcript"]) => {
  const totals = new Map<number, number>();
  for (const s of segments) {
    if (s.speaker != null)
      totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start));
  }
  const all = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
  return [...totals.entries()]
    .sort(([a], [b]) => a - b)
    .map(([speaker, seconds]) => ({ speaker, seconds, share: seconds / all }));
};

export const languageName = (code: string) => {
  try {
    const name = new Intl.DisplayNames(["fr"], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return code;
  }
};
