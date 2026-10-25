ALTER TABLE "batch_sync_run" ADD COLUMN "auth_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "batch_sync_run" ADD COLUMN "cache_hits" integer DEFAULT 0 NOT NULL;