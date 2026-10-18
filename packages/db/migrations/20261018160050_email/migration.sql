ALTER TYPE "enrichment_kind" ADD VALUE 'notify';--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "reply_token" text;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_reply_token_key" UNIQUE("reply_token");