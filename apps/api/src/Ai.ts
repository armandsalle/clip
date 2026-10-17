import { Context, Effect, Layer, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { Chapter, TranscriptSegment } from "@clip/contract";

// L'IA est une couche : chaque service a une implémentation Workers AI et une
// implémentation factice (déterministe) pour `cf dev` sans compte et les tests.

export class AiError extends Schema.TaggedError<AiError, { readonly brand: unique symbol }>()(
  "AiError",
  { step: Schema.String, message: Schema.String },
) {}

type Segment = typeof TranscriptSegment.Type;
type ChapterT = typeof Chapter.Type;

export class Transcriber extends Context.Service<
  Transcriber,
  {
    transcribe(audio: Uint8Array, duration: number): Effect.Effect<ReadonlyArray<Segment>, AiError>;
  }
>()("@clip/api/Transcriber") {
  static readonly layer = (ai: Ai) =>
    Layer.succeed(
      Transcriber,
      Transcriber.of({
        transcribe: (audio) =>
          Effect.tryPromise({
            try: () => ai.run("@cf/openai/whisper-large-v3-turbo", { audio: Base64.encode(audio) }),
            catch: (e) => new AiError({ step: "transcript", message: String(e) }),
          }).pipe(
            Effect.map((out) =>
              (out.segments ?? []).map((s) => ({
                start: s.start ?? 0,
                end: s.end ?? 0,
                text: (s.text ?? "").trim(),
              })),
            ),
            Effect.withSpan("ai.transcribe"),
          ),
      }),
    );

  static readonly layerFake = Layer.succeed(
    Transcriber,
    Transcriber.of({
      transcribe: (_audio, duration) =>
        Effect.succeed(
          Array.from({ length: Math.max(1, Math.floor(duration / 10)) }, (_, i) => ({
            start: i * 10,
            end: Math.min(duration, (i + 1) * 10),
            text: `Passage ${i + 1} de la démo (transcription factice en local).`,
          })),
        ).pipe(Effect.delay("1500 millis"), Effect.withSpan("ai.transcribe.fake")),
    }),
  );
}

export class Summarizer extends Context.Service<
  Summarizer,
  {
    summarize(
      transcript: ReadonlyArray<Segment>,
    ): Effect.Effect<
      { title: string; summary: string; chapters: ReadonlyArray<ChapterT> },
      AiError
    >;
  }
>()("@clip/api/Summarizer") {
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
        summarize: (transcript) =>
          Effect.tryPromise({
            try: () =>
              ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: [
                  {
                    role: "system",
                    content:
                      'Tu résumes la transcription horodatée d\'une vidéo. Réponds uniquement en JSON : {"title": string (max 60 caractères), "summary": string (3 phrases), "chapters": [{"time": nombre de secondes, "title": string}] (3 à 6 chapitres)}. Langue de la transcription.',
                  },
                  {
                    role: "user",
                    content: transcript
                      .map((s) => `[${Math.floor(s.start)}s] ${s.text}`)
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
