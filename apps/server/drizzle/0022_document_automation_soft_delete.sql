ALTER TABLE "document_automation_job" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD CONSTRAINT "document_automation_job_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;