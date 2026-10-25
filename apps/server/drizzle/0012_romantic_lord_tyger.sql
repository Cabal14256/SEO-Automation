CREATE TABLE "physical_confirmation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"m2_confirmation_id" uuid NOT NULL,
	"m3_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "physical_export" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"references" jsonb NOT NULL,
	"projection" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"queue_job_id" uuid,
	"file_id" uuid,
	"box_count" integer NOT NULL,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "physical_export_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "physical_export_status_check" CHECK ("physical_export"."status" IN ('queued','running','completed','failed','stale'))
);
--> statement-breakpoint
CREATE TABLE "physical_intake_preview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"file_id" uuid NOT NULL,
	"entries" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "physical_review_state" (
	"group_id" uuid PRIMARY KEY NOT NULL,
	"m2_confirmation_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"source_id" uuid,
	"revision_id" uuid,
	"confirmation_id" uuid,
	"pending_change" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "physical_review_version_check" CHECK ("physical_review_state"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "physical_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"m2_confirmation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "physical_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"m2_confirmation_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "physical_sync_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"sid" integer NOT NULL,
	"fba" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"snapshot_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "physical_sync_item_status_check" CHECK ("physical_sync_item"."status" IN ('queued','running','completed','failed'))
);
--> statement-breakpoint
CREATE TABLE "physical_sync_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"m2_confirmation_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"queue_job_id" uuid,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"request_budget" integer NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"auth_requests" integer DEFAULT 0 NOT NULL,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	"max_pages" integer DEFAULT 10 NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "physical_sync_run_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "physical_sync_status_check" CHECK ("physical_sync_run"."status" IN ('queued','running','completed','partial','failed')),
	CONSTRAINT "physical_sync_budget_check" CHECK ("physical_sync_run"."request_budget" BETWEEN 1 AND 1000 AND "physical_sync_run"."requests_used" BETWEEN 0 AND "physical_sync_run"."request_budget" AND "physical_sync_run"."max_pages" BETWEEN 1 AND 100),
	CONSTRAINT "physical_sync_range_check" CHECK ("physical_sync_run"."start_date" < "physical_sync_run"."end_date")
);
--> statement-breakpoint
CREATE TABLE "physical_sync_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"page" integer DEFAULT 0 NOT NULL,
	"attempt" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"successful" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "physical_snapshot_success_check" CHECK ("physical_sync_snapshot"."successful" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "physical_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "physical_confirmation" ADD CONSTRAINT "physical_confirmation_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_confirmation" ADD CONSTRAINT "physical_confirmation_m2_confirmation_id_group_confirmation_id_fk" FOREIGN KEY ("m2_confirmation_id") REFERENCES "public"."group_confirmation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_export" ADD CONSTRAINT "physical_export_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_export" ADD CONSTRAINT "physical_export_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_intake_preview" ADD CONSTRAINT "physical_intake_preview_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_intake_preview" ADD CONSTRAINT "physical_intake_preview_template_id_physical_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."physical_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_intake_preview" ADD CONSTRAINT "physical_intake_preview_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_intake_preview" ADD CONSTRAINT "physical_intake_preview_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_review_state" ADD CONSTRAINT "physical_review_state_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_review_state" ADD CONSTRAINT "physical_review_state_m2_confirmation_id_group_confirmation_id_fk" FOREIGN KEY ("m2_confirmation_id") REFERENCES "public"."group_confirmation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_revision" ADD CONSTRAINT "physical_revision_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_revision" ADD CONSTRAINT "physical_revision_m2_confirmation_id_group_confirmation_id_fk" FOREIGN KEY ("m2_confirmation_id") REFERENCES "public"."group_confirmation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_source" ADD CONSTRAINT "physical_source_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_source" ADD CONSTRAINT "physical_source_m2_confirmation_id_group_confirmation_id_fk" FOREIGN KEY ("m2_confirmation_id") REFERENCES "public"."group_confirmation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_sync_item" ADD CONSTRAINT "physical_sync_item_run_id_physical_sync_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."physical_sync_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_sync_run" ADD CONSTRAINT "physical_sync_run_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_sync_run" ADD CONSTRAINT "physical_sync_run_m2_confirmation_id_group_confirmation_id_fk" FOREIGN KEY ("m2_confirmation_id") REFERENCES "public"."group_confirmation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_sync_run" ADD CONSTRAINT "physical_sync_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_sync_snapshot" ADD CONSTRAINT "physical_sync_snapshot_run_id_physical_sync_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."physical_sync_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_sync_snapshot" ADD CONSTRAINT "physical_sync_snapshot_item_id_physical_sync_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."physical_sync_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_sync_snapshot" ADD CONSTRAINT "physical_sync_snapshot_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_template" ADD CONSTRAINT "physical_template_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_template" ADD CONSTRAINT "physical_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "physical_confirmation_group_version_idx" ON "physical_confirmation" USING btree ("group_id","m3_version");--> statement-breakpoint
CREATE UNIQUE INDEX "physical_revision_group_version_idx" ON "physical_revision" USING btree ("group_id","version");--> statement-breakpoint
CREATE INDEX "physical_source_group_idx" ON "physical_source" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "physical_sync_item_member_idx" ON "physical_sync_item" USING btree ("run_id","demand_id");--> statement-breakpoint
CREATE INDEX "physical_sync_group_idx" ON "physical_sync_run" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "physical_sync_checkpoint_idx" ON "physical_sync_snapshot" USING btree ("item_id","operation","page");