CREATE TABLE "fba_lookup_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"queue_job_id" uuid,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"fbas" jsonb NOT NULL,
	"catalog_mode" text NOT NULL,
	"catalog_settings_version" integer NOT NULL,
	"catalog_version" integer NOT NULL,
	"seller_scope" jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_pages" integer DEFAULT 20 NOT NULL,
	"request_budget" integer DEFAULT 20 NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "fba_lookup_run_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "fba_lookup_run_status_check" CHECK ("fba_lookup_run"."status" IN ('queued','running','completed','failed')),
	CONSTRAINT "fba_lookup_run_catalog_check" CHECK ("fba_lookup_run"."catalog_mode" IN ('manual','lingxing') AND "fba_lookup_run"."catalog_settings_version">0 AND "fba_lookup_run"."catalog_version">=0),
	CONSTRAINT "fba_lookup_run_request_check" CHECK ("fba_lookup_run"."start_date"<="fba_lookup_run"."end_date" AND jsonb_array_length("fba_lookup_run"."fbas") BETWEEN 1 AND 100 AND jsonb_array_length("fba_lookup_run"."seller_scope")>0),
	CONSTRAINT "fba_lookup_run_budget_check" CHECK ("fba_lookup_run"."max_pages" BETWEEN 1 AND 100 AND "fba_lookup_run"."request_budget" BETWEEN 1 AND 1000 AND "fba_lookup_run"."requests_used" BETWEEN 0 AND "fba_lookup_run"."request_budget"),
	CONSTRAINT "fba_lookup_run_results_check" CHECK ("fba_lookup_run"."status"='completed' OR "fba_lookup_run"."rows"='[]'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "fba_lookup_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"attempt" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"successful" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fba_lookup_snapshot_attempt_check" CHECK ("fba_lookup_snapshot"."page">=0 AND "fba_lookup_snapshot"."attempt">0 AND "fba_lookup_snapshot"."successful" IN (0,1))
);
--> statement-breakpoint
ALTER TABLE "source_import" ADD COLUMN "source_type" text DEFAULT 'xlsx' NOT NULL;--> statement-breakpoint
ALTER TABLE "fba_lookup_run" ADD CONSTRAINT "fba_lookup_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fba_lookup_snapshot" ADD CONSTRAINT "fba_lookup_snapshot_run_id_fba_lookup_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fba_lookup_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fba_lookup_snapshot" ADD CONSTRAINT "fba_lookup_snapshot_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fba_lookup_run_owner_time_idx" ON "fba_lookup_run" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fba_lookup_snapshot_attempt_idx" ON "fba_lookup_snapshot" USING btree ("run_id","page","attempt");--> statement-breakpoint
ALTER TABLE "source_import" ADD CONSTRAINT "source_import_type_check" CHECK ("source_import"."source_type" IN ('xlsx','online'));
--> statement-breakpoint
INSERT INTO "source_mapping_version" ("key", "parser_version", "definition") VALUES
  ('online-v1', 'xlsx-preview-v1', '{"sheet":"在线需求导入","headerRow":"1","shop":"A","channel":"B","country":"C","destinationFc":"D","fba":"E","referenceQuantity":"F","sourceFilledAt":"G","subBatchName":"H","notes":"I","destinationAddress":"J","shipmentCreatedAt":"K","metadataSource":"L","metadataObservedAt":"M","datePolicy":"import-date-shanghai-v1"}'::jsonb);
