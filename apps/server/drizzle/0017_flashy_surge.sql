CREATE TABLE "workflow_attachment" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_box_claim" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"box_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_export" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dependency_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"file_id" uuid,
	"error" text,
	"queue_job_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_export_status_check" CHECK ("workflow_export"."status" in ('queued','running','completed','failed','stale'))
);
--> statement-breakpoint
CREATE TABLE "workflow_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source" jsonb NOT NULL,
	"box_ids" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_record_version_check" CHECK ("workflow_record"."version" > 0),
	CONSTRAINT "workflow_record_kind_check" CHECK ("workflow_record"."kind" in ('fulfillment','logistics','customs','finance','archive'))
);
--> statement-breakpoint
CREATE TABLE "workflow_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_attachment" ADD CONSTRAINT "workflow_attachment_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_attachment" ADD CONSTRAINT "workflow_attachment_record_id_workflow_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."workflow_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_attachment" ADD CONSTRAINT "workflow_attachment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_box_claim" ADD CONSTRAINT "workflow_box_claim_record_id_workflow_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."workflow_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_export" ADD CONSTRAINT "workflow_export_record_id_workflow_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."workflow_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_export" ADD CONSTRAINT "workflow_export_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_export" ADD CONSTRAINT "workflow_export_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_record" ADD CONSTRAINT "workflow_record_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revision" ADD CONSTRAINT "workflow_revision_record_id_workflow_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."workflow_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revision" ADD CONSTRAINT "workflow_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_attachment_record_idx" ON "workflow_attachment" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_box_claim_active_uq" ON "workflow_box_claim" USING btree ("purpose","box_id") WHERE "workflow_box_claim"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workflow_box_claim_record_idx" ON "workflow_box_claim" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "workflow_export_record_idx" ON "workflow_export" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "workflow_record_kind_idx" ON "workflow_record" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revision_version_uq" ON "workflow_revision" USING btree ("record_id","version");