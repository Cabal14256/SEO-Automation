CREATE TABLE "document_automation_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"shipping_run_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text,
	"items" jsonb NOT NULL,
	"error" jsonb,
	"retry_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"queue_job_id" text,
	"lease_until" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "document_automation_job_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "document_automation_version_check" CHECK ("document_automation_job"."version" > 0),
	CONSTRAINT "document_automation_status_check" CHECK ("document_automation_job"."status" IN ('queued','running','completed','partial','blocked','failed'))
);
--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD CONSTRAINT "document_automation_job_shipping_run_id_shipping_run_id_fk" FOREIGN KEY ("shipping_run_id") REFERENCES "public"."shipping_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD CONSTRAINT "document_automation_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_automation_actor_created_idx" ON "document_automation_job" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "document_automation_status_idx" ON "document_automation_job" USING btree ("status");