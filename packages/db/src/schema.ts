import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { EnrichmentStatus, Thumbnail, VideoStatus } from "@clip/domain";

// Colonnes en snake_case côté base (`snakeCase.table`, API de casse de Drizzle v1).
// Le tag de chaque union est une colonne enum (indexable, contrainte par la base) ;
// les champs propres à chaque variante vivent dans une colonne JSONB typée par
// l'encodage du Schema du domaine.

export const videoStatus = pgEnum("video_status", [
  "Uploading",
  "Encoding",
  "Ready",
  "Failed",
  "Expired",
  "Deleted",
]);

export const expiry = pgEnum("expiry", ["never", "1d", "7d", "30d"]);

export const enrichmentKind = pgEnum("enrichment_kind", [
  "thumbnail",
  "audio",
  "transcript",
  "captions",
  "hd",
  "summary",
  "suggestions",
  "storyboard",
  "shareCard",
  "index",
  "notify",
]);

export const videos = snakeCase.table(
  "videos",
  {
    id: uuid().primaryKey(),
    streamUid: text().notNull().unique(),
    title: text(),
    status: videoStatus().notNull(),
    statusDetails: jsonb().$type<typeof VideoStatus.Encoded>().notNull(),
    thumbnail: jsonb().$type<typeof Thumbnail.Encoded>().notNull(),
    expiry: expiry().notNull(),
    /** SHA-256 du secret d'admin : le secret lui-même n'est jamais stocké. */
    adminKeyHash: text().notNull(),
    ownerEmail: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("videos_status_idx").on(t.status)],
);

/** État et résultat de chaque étape du pipeline, par vidéo. */
export const enrichments = snakeCase.table(
  "enrichments",
  {
    videoId: uuid()
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    kind: enrichmentKind().notNull(),
    status: jsonb().$type<typeof EnrichmentStatus.Encoded>().notNull(),
    /** Résultat de l'étape (transcription, résumé, chapitres, suggestions…). */
    result: jsonb().$type<unknown>(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.videoId, t.kind] })],
);

export const comments = snakeCase.table(
  "comments",
  {
    id: uuid().primaryKey(),
    videoId: uuid()
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    parentId: uuid(),
    author: text().notNull(),
    body: text().notNull(),
    time: doublePrecision().notNull(),
    via: text().$type<"web" | "email">().notNull(),
    /** Jeton aléatoire de l'adresse reply+<jeton>@… (réponse par email). */
    replyToken: text().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index("comments_video_time_idx").on(t.videoId, t.time),
    check("comments_body_length", sql`length(${t.body}) between 1 and 2000`),
    check("comments_time_positive", sql`${t.time} >= 0`),
  ],
);
