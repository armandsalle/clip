import { Option, Schema } from "effect";
import { Seconds } from "@clip/domain";

// Résultats d'enrichissement : écrits par jobs (JSONB), relus par api et jobs. Relus
// avec tolérance : une étape pas encore passée donne simplement « aucun résultat ».

export const TranscriptSegment = Schema.Struct({
  start: Seconds,
  end: Seconds,
  text: Schema.String,
  /** Intervenant (0, 1, …) détecté par la diarisation ; absent des anciennes transcriptions. */
  speaker: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});

export const Chapter = Schema.Struct({ time: Seconds, title: Schema.String });

export const TranscriptResult = Schema.Struct({
  language: Schema.optionalKey(Schema.NullOr(Schema.String)),
  segments: Schema.Array(TranscriptSegment),
});

export const SummaryResult = Schema.Struct({
  summary: Schema.String,
  chapters: Schema.Array(Chapter),
});

/**
 * Résultat de l'étape `thumbnail` : URL de base de la miniature Stream et manifeste
 * HLS. Enregistrés une fois : la page vidéo et la galerie n'appellent plus Stream.
 */
export const ThumbnailResult = Schema.Struct({
  url: Schema.String,
  /** Absent des vidéos traitées avant son ajout. */
  hls: Schema.optionalKey(Schema.String),
});

export const SuggestionsResult = Schema.Struct({ times: Schema.Array(Schema.Finite) });

/** Décodeur tolérant d'un résultat stocké : `None` si absent ou d'une autre forme. */
export const decodeResult =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (value: unknown): Option.Option<S["Type"]> =>
    Option.flatMap(Option.fromNullishOr(value), Schema.decodeUnknownOption(schema));
