// Raccourcis clavier du lecteur (affichés sous la vidéo). Ignorés pendant la saisie.

export type PlayerAction =
  | "toggle"
  | "back"
  | "forward"
  | "captions"
  | "nextChapter"
  | "commentHere"
  | "fullscreen"
  | "help";

export const SHORTCUTS: ReadonlyArray<{
  readonly keys: ReadonlyArray<string>;
  readonly label: string;
}> = [
  { keys: ["Espace"], label: "lecture" },
  { keys: ["J", "L"], label: "±10 s" },
  { keys: ["C"], label: "sous-titres" },
  { keys: ["N"], label: "chapitre suivant" },
  { keys: ["K"], label: "commenter ici" },
  { keys: ["F"], label: "plein écran" },
  { keys: ["?"], label: "tous les raccourcis" },
];

const byKey: Record<string, PlayerAction> = {
  " ": "toggle",
  j: "back",
  arrowleft: "back",
  l: "forward",
  arrowright: "forward",
  c: "captions",
  n: "nextChapter",
  k: "commentHere",
  f: "fullscreen",
  "?": "help",
};

interface KeyLike {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  /** Élément qui a le focus : un champ de saisie désactive les raccourcis. */
  readonly target: { readonly tagName?: string; readonly isContentEditable?: boolean } | null;
}

export const actionFor = (event: KeyLike): PlayerAction | null => {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const tag = event.target?.tagName?.toLowerCase();
  if (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    event.target?.isContentEditable
  ) {
    return null;
  }
  // Espace sur un bouton : laisser le bouton réagir (accessibilité).
  if (event.key === " " && tag === "button") return null;
  return byKey[event.key.toLowerCase()] ?? null;
};
