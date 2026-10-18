import { Context, Effect, Layer, Schema } from "effect";
import { Chapter, TranscriptSegment } from "@clip/contract";

// L'IA est une couche : chaque service a une implémentation Workers AI et une
// implémentation factice (déterministe) pour `cf dev` sans compte et les tests.

export class AiError extends Schema.TaggedError<AiError, { readonly brand: unique symbol }>()(
  "AiError",
  { step: Schema.String, message: Schema.String },
) {}

type Segment = typeof TranscriptSegment.Type;
type ChapterT = typeof Chapter.Type;

export interface Transcript {
  readonly language: string | null;
  readonly segments: ReadonlyArray<Segment>;
}

/** Audio à transcrire : flux HTTP transmis tel quel (pas de chargement en mémoire). */
export interface AudioInput {
  readonly body: ReadableStream;
  readonly contentType: string;
}

// Réponse Deepgram : le type Workers AI ne décrit pas `utterances`, `speaker` ni
// `detected_language`, on les décode donc avec tolérance.
const NovaWord = Schema.Struct({
  word: Schema.optionalKey(Schema.String),
  punctuated_word: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(Schema.Finite),
  end: Schema.optionalKey(Schema.Finite),
  speaker: Schema.optionalKey(Schema.Int),
});
const NovaOutput = Schema.Struct({
  results: Schema.optionalKey(
    Schema.Struct({
      channels: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            detected_language: Schema.optionalKey(Schema.String),
            alternatives: Schema.optionalKey(
              Schema.Array(
                Schema.Struct({
                  words: Schema.optionalKey(Schema.Array(NovaWord)),
                  languages: Schema.optionalKey(Schema.Array(Schema.String)),
                }),
              ),
            ),
          }),
        ),
      ),
      utterances: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            start: Schema.Finite,
            end: Schema.Finite,
            transcript: Schema.String,
            speaker: Schema.optionalKey(Schema.Int),
            languages: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});

/** Sans `utterances`, regroupe les mots consécutifs d'un même intervenant. */
const segmentsFromWords = (words: ReadonlyArray<typeof NovaWord.Type>): Array<Segment> => {
  const segments: Array<Segment> = [];
  for (const w of words) {
    const text = w.punctuated_word ?? w.word ?? "";
    const last = segments.at(-1);
    const speaker = w.speaker ?? null;
    if (last && last.speaker === speaker && (w.start ?? 0) - last.end < 1.5) {
      segments[segments.length - 1] = {
        ...last,
        end: w.end ?? last.end,
        text: `${last.text} ${text}`,
      };
    } else {
      segments.push({ start: w.start ?? 0, end: w.end ?? 0, text, speaker });
    }
  }
  return segments;
};

export class Transcriber extends Context.Service<
  Transcriber,
  { transcribe(audio: AudioInput, duration: number): Effect.Effect<Transcript, AiError> }
>()("@clip/platform/Transcriber") {
  /** Deepgram Nova-3 : intervenants (diarisation), langue détectée, ponctuation. */
  static readonly layer = (ai: Ai) => {
    const decode = Schema.decodeUnknownEffect(NovaOutput);
    return Layer.succeed(
      Transcriber,
      Transcriber.of({
        transcribe: (audio) =>
          Effect.tryPromise({
            try: () =>
              ai.run("@cf/deepgram/nova-3", {
                audio: { body: audio.body, contentType: audio.contentType },
                diarize: true,
                utterances: true,
                detect_language: true,
                smart_format: true,
                punctuate: true,
              }),
            catch: (e) => new AiError({ step: "transcript", message: String(e) }),
          }).pipe(
            Effect.flatMap((out) =>
              decode(out).pipe(
                Effect.mapError((e) => new AiError({ step: "transcript", message: e.message })),
              ),
            ),
            Effect.map((out): Transcript => {
              const channel = out.results?.channels?.[0];
              const utterances = out.results?.utterances ?? [];
              const segments =
                utterances.length > 0
                  ? utterances.map((u) => ({
                      start: u.start,
                      end: u.end,
                      text: u.transcript.trim(),
                      speaker: u.speaker ?? null,
                    }))
                  : segmentsFromWords(channel?.alternatives?.[0]?.words ?? []);
              // Nova-3 renvoie la langue dans `alternatives[].languages` (et par utterance).
              const language =
                channel?.detected_language ??
                channel?.alternatives?.[0]?.languages?.[0] ??
                utterances[0]?.languages?.[0] ??
                null;
              return { language, segments };
            }),
            Effect.withSpan("ai.transcribe"),
          ),
      }),
    );
  };

  /** Deux intervenants qui alternent, langue « fr ». */
  static readonly layerFake = Layer.succeed(
    Transcriber,
    Transcriber.of({
      transcribe: (_audio, duration) =>
        Effect.succeed({
          language: "fr",
          segments: Array.from({ length: Math.max(1, Math.floor(duration / 10)) }, (_, i) => ({
            start: i * 10,
            end: Math.min(duration, (i + 1) * 10),
            text: `Passage ${i + 1} de la démo (transcription factice en local).`,
            speaker: i % 2,
          })),
        }).pipe(Effect.delay("1500 millis"), Effect.withSpan("ai.transcribe.fake")),
    }),
  );
}

export class Summarizer extends Context.Service<
  Summarizer,
  {
    summarize(
      transcript: ReadonlyArray<Segment>,
      language: string | null,
    ): Effect.Effect<
      { title: string; summary: string; chapters: ReadonlyArray<ChapterT> },
      AiError
    >;
  }
>()("@clip/platform/Summarizer") {
  static readonly layer = (ai: Ai) => {
    const Output = Schema.fromJsonString(
      Schema.Struct({
        title: Schema.String,
        summary: Schema.String,
        chapters: Schema.Array(Chapter),
      }),
    );
    const decode = Schema.decodeUnknownEffect(Output);
    return Layer.succeed(
      Summarizer,
      Summarizer.of({
        summarize: (transcript, language) =>
          Effect.tryPromise({
            try: () =>
              ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: [
                  {
                    role: "system",
                    content: `Tu résumes la transcription horodatée d'une vidéo, où chaque ligne indique l'intervenant. Réponds uniquement en JSON : {"title": string (max 60 caractères), "summary": string (3 phrases ; mentionne les intervenants s'il y en a plusieurs), "chapters": [{"time": nombre de secondes, "title": string}] (3 à 6 chapitres)}. Langue de la réponse : ${language ?? "celle de la transcription"}.`,
                  },
                  {
                    role: "user",
                    content: transcript
                      .map(
                        (s) =>
                          `[${Math.floor(s.start)}s]${s.speaker == null ? "" : ` Intervenant ${s.speaker + 1} :`} ${s.text}`,
                      )
                      .join("\n"),
                  },
                ],
                response_format: { type: "json_object" },
              }),
            catch: (e) => new AiError({ step: "summary", message: String(e) }),
          }).pipe(
            Effect.flatMap((out) =>
              decode(
                typeof out === "string"
                  ? out
                  : "response" in out
                    ? typeof out.response === "string"
                      ? out.response
                      : JSON.stringify(out.response)
                    : "",
              ),
            ),
            Effect.mapError((e) =>
              e._tag === "AiError" ? e : new AiError({ step: "summary", message: e.message }),
            ),
            Effect.withSpan("ai.summarize"),
          ),
      }),
    );
  };

  static readonly layerFake = Layer.succeed(
    Summarizer,
    Summarizer.of({
      summarize: (transcript) =>
        Effect.succeed({
          title: "Démo Clip",
          summary: `Vidéo de ${transcript.length} passages. Résumé factice généré en local, sans Workers AI.`,
          chapters: transcript
            .filter((_, i) => i % 3 === 0)
            .map((s, i) => ({ time: s.start, title: `Chapitre ${i + 1}` })),
        }).pipe(Effect.delay("1200 millis"), Effect.withSpan("ai.summarize.fake")),
    }),
  );
}

/** IA réelle (Workers AI) en remote, factice sinon : la même règle pour tous les Workers. */
export const AiFor = (ai: Ai | undefined) =>
  ai
    ? Layer.mergeAll(Transcriber.layer(ai), Summarizer.layer(ai))
    : Layer.mergeAll(Transcriber.layerFake, Summarizer.layerFake);
