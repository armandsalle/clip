import type {
  Forbidden,
  InvalidTransition,
  OutOfRange,
  VideoNotFound,
  VideoNotReady,
} from "@clip/domain";
import type { TooManyRequests } from "@clip/contract";

// Traduction centrale des erreurs du contrat en messages : aucun composant n'écrit
// ses propres messages d'erreur. Le Record est exhaustif : une erreur ajoutée au
// contrat sans message ne compile pas.

export type ApiErrorTag =
  | VideoNotFound["_tag"]
  | Forbidden["_tag"]
  | VideoNotReady["_tag"]
  | OutOfRange["_tag"]
  | InvalidTransition["_tag"]
  | TooManyRequests["_tag"];

const messages: Record<ApiErrorTag, string> = {
  VideoNotFound: "Cette vidéo n'existe pas ou n'est plus disponible.",
  Forbidden: "Ce lien d'admin n'est pas valide pour cette vidéo.",
  VideoNotReady: "La vidéo n'est pas encore prête.",
  OutOfRange: "Ce moment n'existe pas dans la vidéo.",
  InvalidTransition: "Action impossible dans l'état actuel de la vidéo.",
  TooManyRequests: "Trop de demandes en peu de temps. Réessayez dans une minute.",
};

export const UNKNOWN_ERROR = "Une erreur est survenue. Réessayez dans un instant.";

const isApiErrorTag = (tag: string): tag is ApiErrorTag => Object.hasOwn(messages, tag);

/** Message à afficher pour une erreur reçue de l'API (ou inattendue). */
export const messageFor = (tag: string | undefined): string =>
  tag !== undefined && isApiErrorTag(tag) ? messages[tag] : UNKNOWN_ERROR;
