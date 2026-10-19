CREATE TYPE "enrichment_kind" AS ENUM('thumbnail', 'transcript', 'summary', 'suggestions', 'storyboard', 'shareCard', 'index');--> statement-breakpoint
CREATE TYPE "expiry" AS ENUM('never', '1d', '7d', '30d');--> statement-breakpoint
CREATE TYPE "video_status" AS ENUM('Uploading', 'Encoding', 'Ready', 'Failed', 'Expired', 'Deleted');--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY,
	"video_id" uuid NOT NULL,
	"parent_id" uuid,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"time" double precision NOT NULL,
	"via" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "comments_body_length" CHECK (length("body") between 1 and 2000),
	CONSTRAINT "comments_time_positive" CHECK ("time" >= 0)
);
--> statement-breakpoint
CREATE TABLE "enrichments" (
	"video_id" uuid,
	"kind" "enrichment_kind",
	"status" jsonb NOT NULL,
	"result" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichments_pkey" PRIMARY KEY("video_id","kind")
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY,
	"stream_uid" text NOT NULL UNIQUE,
	"title" text,
	"status" "video_status" NOT NULL,
	"status_details" jsonb NOT NULL,
	"thumbnail" jsonb NOT NULL,
	"expiry" "expiry" NOT NULL,
	"admin_key_hash" text NOT NULL,
	"owner_email" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_video_time_idx" ON "comments" ("video_id","time");--> statement-breakpoint
CREATE INDEX "videos_status_idx" ON "videos" ("status");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_video_id_videos_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "enrichments" ADD CONSTRAINT "enrichments_video_id_videos_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE;