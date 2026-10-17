import { Schema } from "effect";
import { CommentId, Seconds, VideoId } from "./Video.ts";

export const CommentBody = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

export const AuthorName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60));

export class Comment extends Schema.Class<Comment, { readonly brand: unique symbol }>(
  "@clip/domain/Comment",
)({
  id: CommentId,
  videoId: VideoId,
  parentId: Schema.NullOr(CommentId),
  author: AuthorName,
  body: CommentBody,
  /** Position dans la vidéo à laquelle le commentaire est accroché. */
  time: Seconds,
  /** Réponse publiée depuis la page ou en répondant à un email de notification. */
  via: Schema.Literals(["web", "email"]),
  createdAt: Schema.DateTimeUtcFromString,
}) {}
