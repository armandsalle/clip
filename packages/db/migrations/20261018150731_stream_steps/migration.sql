ALTER TYPE "enrichment_kind" ADD VALUE 'audio' BEFORE 'transcript';--> statement-breakpoint
ALTER TYPE "enrichment_kind" ADD VALUE 'captions' BEFORE 'summary';--> statement-breakpoint
ALTER TYPE "enrichment_kind" ADD VALUE 'hd' BEFORE 'summary';