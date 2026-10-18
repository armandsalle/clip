import { Context, Effect, Layer, Schema } from "effect";

// Emails (Email Service) ------------------------------------------------------------------

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string;
}

export class Mailer extends Context.Service<
  Mailer,
  { readonly domain: string; send(email: OutgoingEmail): Effect.Effect<void, MailError> }
>()("@clip/api/Mailer") {
  static readonly layer = (binding: SendEmail, domain: string) =>
    Layer.succeed(
      Mailer,
      Mailer.of({
        domain,
        send: (email) =>
          Effect.tryPromise({
            try: () =>
              binding.send({
                from: { name: "Clip", email: `notifications@${domain}` },
                to: email.to,
                subject: email.subject,
                html: email.html,
                text: email.text,
                ...(email.replyTo === undefined ? {} : { replyTo: email.replyTo }),
              }),
            catch: (e) => new MailError({ message: String(e) }),
          }).pipe(
            Effect.tap((result) =>
              Effect.logInfo("mail.sent", { messageId: result.messageId, subject: email.subject }),
            ),
            Effect.tapError((error) => Effect.logError("mail.failed", { error: error.message })),
            Effect.asVoid,
            Effect.withSpan("mail.send", { attributes: { to: email.to } }),
          ),
      }),
    );

  /** Garde les emails envoyés, pour les tests. */
  static readonly layerRecorder = (domain = "clip.test") =>
    Layer.sync(Mailer, () => {
      const sent: Array<OutgoingEmail> = [];
      return Object.assign(
        Mailer.of({ domain, send: (email) => Effect.sync(() => void sent.push(email)) }),
        { sent },
      );
    });
}

export class MailError extends Schema.TaggedError<MailError, { readonly brand: unique symbol }>()(
  "MailError",
  { message: Schema.String },
) {}
