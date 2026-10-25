CREATE TABLE "document_invoice_bundle" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"references" jsonb NOT NULL,
	"sheets" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_invoice_bundle_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD COLUMN "mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD COLUMN "phase" text DEFAULT 'preparing' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD COLUMN "bundle" jsonb;--> statement-breakpoint
ALTER TABLE "document_invoice_bundle" ADD CONSTRAINT "document_invoice_bundle_job_id_document_automation_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."document_automation_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_invoice_bundle" ADD CONSTRAINT "document_invoice_bundle_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_invoice_bundle" ADD CONSTRAINT "document_invoice_bundle_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD CONSTRAINT "document_automation_mode_check" CHECK ("document_automation_job"."mode" IN ('legacy','single_workbook'));--> statement-breakpoint
ALTER TABLE "document_automation_job" ADD CONSTRAINT "document_automation_phase_check" CHECK ("document_automation_job"."phase" IN ('preparing','needs_input','ready','generating','completed','failed'));