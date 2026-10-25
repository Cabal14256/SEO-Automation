CREATE TABLE "allocation_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"sequence" integer NOT NULL,
	"code" text NOT NULL,
	"valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_code_sequence_check" CHECK ("allocation_code"."sequence">0)
);
--> statement-breakpoint
CREATE TABLE "batch_decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"shipment_version" integer NOT NULL,
	"issue_code" text NOT NULL,
	"note" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_operation" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_print_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"confirmation_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_confirmation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"group_version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"demand_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"demand_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"source" text NOT NULL,
	"snapshot_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_revision_source_check" CHECK ("shipment_revision"."source" IN ('lingxing','manual','xlsx'))
);
--> statement-breakpoint
CREATE TABLE "sub_batch_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"demand_version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sub_batch_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sub_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"prefix" text,
	"confirmed_version" integer,
	"frozen_at" timestamp with time zone,
	"correction_of_id" uuid,
	"replaced_by_id" uuid,
	"actual_ship_date" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sub_batch_status_check" CHECK ("sub_batch"."status" IN ('draft','confirmed','frozen','superseded')),
	CONSTRAINT "sub_batch_version_check" CHECK ("sub_batch"."version">0 AND "sub_batch"."position">=0)
);
--> statement-breakpoint
CREATE TABLE "weekly_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"week_start_date" date NOT NULL,
	"week_end_date" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sort_mode" text DEFAULT 'fba' NOT NULL,
	"next_prefix" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_batch_range_check" CHECK ("weekly_batch"."week_end_date" = "weekly_batch"."week_start_date" + 6 AND extract(isodow from "weekly_batch"."week_start_date") = 1),
	CONSTRAINT "weekly_batch_version_check" CHECK ("weekly_batch"."version">0 AND "weekly_batch"."next_prefix">=0)
);
--> statement-breakpoint
CREATE TABLE "batch_export" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"queue_job_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"group_ids" jsonb NOT NULL,
	"references" jsonb NOT NULL,
	"month" text,
	"region" text DEFAULT 'all' NOT NULL,
	"projection" jsonb NOT NULL,
	"file_id" uuid,
	"error" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"box_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "batch_export_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "batch_export_status_check" CHECK ("batch_export"."status" in ('queued','running','completed','failed','stale'))
);
--> statement-breakpoint
CREATE TABLE "batch_intake" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"group_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"source_file_id" uuid NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_sync_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"demand_version" integer NOT NULL,
	"sid" integer NOT NULL,
	"fba" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"revision_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"snapshot_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "batch_sync_retry_operation" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_sync_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sub_batch_id" uuid NOT NULL,
	"group_version" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"queue_job_id" uuid,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"max_pages" integer DEFAULT 10 NOT NULL,
	"request_budget" integer NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "batch_sync_run_operation_id_unique" UNIQUE("operation_id")
);
--> statement-breakpoint
CREATE TABLE "batch_sync_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"page" integer DEFAULT 0 NOT NULL,
	"attempt" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"successful" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lingxing_read_cooldown" (
	"key" text PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lingxing_token_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocation_code" ADD CONSTRAINT "allocation_code_batch_id_weekly_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."weekly_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_code" ADD CONSTRAINT "allocation_code_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_code" ADD CONSTRAINT "allocation_code_demand_id_demand_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_decision" ADD CONSTRAINT "batch_decision_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_decision" ADD CONSTRAINT "batch_decision_demand_id_demand_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_decision" ADD CONSTRAINT "batch_decision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_operation" ADD CONSTRAINT "batch_operation_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_print_record" ADD CONSTRAINT "batch_print_record_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_print_record" ADD CONSTRAINT "batch_print_record_confirmation_id_group_confirmation_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."group_confirmation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_print_record" ADD CONSTRAINT "batch_print_record_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_confirmation" ADD CONSTRAINT "group_confirmation_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_confirmation" ADD CONSTRAINT "group_confirmation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_revision" ADD CONSTRAINT "shipment_revision_demand_id_demand_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_revision" ADD CONSTRAINT "shipment_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_revision" ADD CONSTRAINT "shipment_revision_demand_fk" FOREIGN KEY ("demand_id","demand_version") REFERENCES "public"."demand_revision"("demand_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_batch_member" ADD CONSTRAINT "sub_batch_member_batch_id_weekly_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."weekly_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_batch_member" ADD CONSTRAINT "sub_batch_member_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_batch_member" ADD CONSTRAINT "sub_batch_member_demand_id_demand_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sub_batch_id_week_unique" ON "sub_batch" USING btree ("id","batch_id");--> statement-breakpoint
ALTER TABLE "sub_batch_member" ADD CONSTRAINT "sub_batch_member_group_week_fk" FOREIGN KEY ("group_id","batch_id") REFERENCES "public"."sub_batch"("id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_batch_member" ADD CONSTRAINT "sub_batch_member_demand_revision_fk" FOREIGN KEY ("demand_id","demand_version") REFERENCES "public"."demand_revision"("demand_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_batch_revision" ADD CONSTRAINT "sub_batch_revision_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_batch_revision" ADD CONSTRAINT "sub_batch_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD CONSTRAINT "sub_batch_batch_id_weekly_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."weekly_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD CONSTRAINT "sub_batch_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_batch" ADD CONSTRAINT "weekly_batch_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_export" ADD CONSTRAINT "batch_export_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_export" ADD CONSTRAINT "batch_export_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_intake" ADD CONSTRAINT "batch_intake_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_intake" ADD CONSTRAINT "batch_intake_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_intake" ADD CONSTRAINT "batch_intake_demand_id_demand_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_intake" ADD CONSTRAINT "batch_intake_source_file_id_file_index_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_sync_item" ADD CONSTRAINT "batch_sync_item_run_id_batch_sync_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."batch_sync_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_sync_retry_operation" ADD CONSTRAINT "batch_sync_retry_operation_run_id_batch_sync_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."batch_sync_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_sync_retry_operation" ADD CONSTRAINT "batch_sync_retry_operation_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_sync_run" ADD CONSTRAINT "batch_sync_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_sync_snapshot" ADD CONSTRAINT "batch_sync_snapshot_run_id_batch_sync_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."batch_sync_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_sync_snapshot" ADD CONSTRAINT "batch_sync_snapshot_item_id_batch_sync_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."batch_sync_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_sync_snapshot" ADD CONSTRAINT "batch_sync_snapshot_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_code_week_code_idx" ON "allocation_code" USING btree ("batch_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_code_active_box_idx" ON "allocation_code" USING btree ("group_id","box_id") WHERE "allocation_code"."valid"=true;--> statement-breakpoint
CREATE INDEX "batch_decision_group_idx" ON "batch_decision" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_confirmation_version_idx" ON "group_confirmation" USING btree ("group_id","group_version");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_revision_version_idx" ON "shipment_revision" USING btree ("demand_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_batch_member_active_unique" ON "sub_batch_member" USING btree ("batch_id","demand_id") WHERE "sub_batch_member"."active" = true;--> statement-breakpoint
CREATE INDEX "sub_batch_member_group_idx" ON "sub_batch_member" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_batch_revision_version_idx" ON "sub_batch_revision" USING btree ("group_id","version");--> statement-breakpoint
CREATE INDEX "sub_batch_week_idx" ON "sub_batch" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_batch_week_idx" ON "weekly_batch" USING btree ("week_start_date","week_end_date");--> statement-breakpoint
CREATE INDEX "batch_export_created_idx" ON "batch_export" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_sync_item_member_idx" ON "batch_sync_item" USING btree ("run_id","demand_id");
