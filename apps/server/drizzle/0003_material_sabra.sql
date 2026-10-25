CREATE TABLE "import_operation" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"import_id" uuid NOT NULL,
	"parse_run_id" uuid NOT NULL,
	"deduplicated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_operation_kind_check" CHECK ("import_operation"."kind" IN ('upload','parse'))
);
--> statement-breakpoint
CREATE TABLE "import_parse_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"queue_job_id" text NOT NULL,
	"created_by" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input_version" integer NOT NULL,
	"mapping_version" text,
	"sheet_name" text,
	"parser_version" text NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{"totalRows":0,"validFbaRows":0,"errorRows":0,"warningRows":0}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_parse_run_status_check" CHECK ("import_parse_run"."status" IN ('queued','running','completed','failed')),
	CONSTRAINT "import_parse_run_version_check" CHECK ("import_parse_run"."input_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "source_import_row" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parse_run_id" uuid NOT NULL,
	"sheet_name" text NOT NULL,
	"row_number" integer NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"raw_cells" jsonb NOT NULL,
	"normalized" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	CONSTRAINT "source_import_row_number_check" CHECK ("source_import_row"."row_number" > 0),
	CONSTRAINT "source_import_row_status_check" CHECK ("source_import_row"."status" IN ('valid','needs_review','error'))
);
--> statement-breakpoint
CREATE TABLE "source_import" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"original_name" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_by" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"date_policy_version" text NOT NULL,
	"week_start_date" date NOT NULL,
	"week_end_date" date NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"latest_run_id" uuid,
	"sheets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "source_import_status_check" CHECK ("source_import"."status" IN ('queued','parsing','awaiting_mapping','preview_ready','failed')),
	CONSTRAINT "source_import_version_check" CHECK ("source_import"."version" > 0),
	CONSTRAINT "source_import_size_check" CHECK ("source_import"."byte_size" > 0 AND "source_import"."byte_size" <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "source_mapping_version" (
	"key" text PRIMARY KEY NOT NULL,
	"parser_version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_operation" ADD CONSTRAINT "import_operation_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_operation" ADD CONSTRAINT "import_operation_import_id_source_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."source_import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_operation" ADD CONSTRAINT "import_operation_parse_run_id_import_parse_run_id_fk" FOREIGN KEY ("parse_run_id") REFERENCES "public"."import_parse_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_parse_run" ADD CONSTRAINT "import_parse_run_import_id_source_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."source_import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_parse_run" ADD CONSTRAINT "import_parse_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_parse_run" ADD CONSTRAINT "import_parse_run_mapping_version_source_mapping_version_key_fk" FOREIGN KEY ("mapping_version") REFERENCES "public"."source_mapping_version"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_import_row" ADD CONSTRAINT "source_import_row_parse_run_id_import_parse_run_id_fk" FOREIGN KEY ("parse_run_id") REFERENCES "public"."import_parse_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_import" ADD CONSTRAINT "source_import_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_import" ADD CONSTRAINT "source_import_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_import" ADD CONSTRAINT "source_import_latest_run_id_import_parse_run_id_fk" FOREIGN KEY ("latest_run_id") REFERENCES "public"."import_parse_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_parse_run_import_idx" ON "import_parse_run" USING btree ("import_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_import_row_run_number_idx" ON "source_import_row" USING btree ("parse_run_id","row_number");--> statement-breakpoint
CREATE INDEX "source_import_row_run_status_idx" ON "source_import_row" USING btree ("parse_run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_import_owner_sha_idx" ON "source_import" USING btree ("created_by","sha256");--> statement-breakpoint
CREATE INDEX "source_import_owner_time_idx" ON "source_import" USING btree ("created_by","imported_at");
--> statement-breakpoint
INSERT INTO "source_mapping_version" ("key", "parser_version", "definition") VALUES
  ('feishu-v1', 'xlsx-preview-v1', '{"sheet":"飞书表格","headerRow":"1","shop":"B","channel":"C","country":"D","destinationFc":"E","fba":"F","referenceQuantity":"G","sourceDate":"J","datePolicy":"import-date-shanghai-v1"}'::jsonb),
  ('manual-v1', 'xlsx-preview-v1', '{"sheet":"需求导入","headerRow":"1","shop":"A","channel":"B","country":"C","destinationFc":"D","fba":"E","referenceQuantity":"F","sourceDate":"G","subBatchName":"H","notes":"I","datePolicy":"import-date-shanghai-v1"}'::jsonb);
