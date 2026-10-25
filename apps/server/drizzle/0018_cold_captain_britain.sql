CREATE TABLE "shipping_month_counter" (
	"month" text PRIMARY KEY NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shipping_month_counter_value_check" CHECK ("shipping_month_counter"."last_sequence">=0)
);
--> statement-breakpoint
CREATE TABLE "shipping_run_operation" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"parse_run_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'lookup' NOT NULL,
	"numbering_date" date NOT NULL,
	"month" text NOT NULL,
	"sequence" integer,
	"queue_job_id" text,
	"checkpoint" jsonb DEFAULT '{"operations":{},"lookupAttempt":0}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_run_status_check" CHECK ("shipping_run"."status" IN ('queued','running','needs_review','ready','failed')),
	CONSTRAINT "shipping_run_stage_check" CHECK ("shipping_run"."stage" IN ('lookup','commit','grouping','sync','confirmation','ready')),
	CONSTRAINT "shipping_run_number_check" CHECK ("shipping_run"."version">0 AND ("shipping_run"."sequence" IS NULL OR "shipping_run"."sequence">0) AND "shipping_run"."month"=to_char("shipping_run"."numbering_date",'YYYY-MM'))
);
--> statement-breakpoint
CREATE TABLE "shipping_ticket_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"source_row_id" uuid NOT NULL,
	"demand_id" uuid,
	"fba" text NOT NULL,
	"sid" integer,
	"input_order" integer NOT NULL,
	"group_id" uuid,
	CONSTRAINT "shipping_ticket_member_order_check" CHECK ("shipping_ticket_member"."input_order">0 AND ("shipping_ticket_member"."sid" IS NULL OR "shipping_ticket_member"."sid">0))
);
--> statement-breakpoint
CREATE TABLE "shipping_ticket" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"source_ticket_index" integer NOT NULL,
	"country" text,
	"ticket_sequence" integer,
	"number" text,
	CONSTRAINT "shipping_ticket_order_check" CHECK ("shipping_ticket"."source_ticket_index">0 AND ("shipping_ticket"."ticket_sequence" IS NULL OR "shipping_ticket"."ticket_sequence">0))
);
--> statement-breakpoint
ALTER TABLE "shipping_run_operation" ADD CONSTRAINT "shipping_run_operation_run_id_shipping_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."shipping_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_run_operation" ADD CONSTRAINT "shipping_run_operation_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD CONSTRAINT "shipping_run_import_id_source_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."source_import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD CONSTRAINT "shipping_run_parse_run_id_import_parse_run_id_fk" FOREIGN KEY ("parse_run_id") REFERENCES "public"."import_parse_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD CONSTRAINT "shipping_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_ticket_member" ADD CONSTRAINT "shipping_ticket_member_run_id_shipping_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."shipping_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_ticket_member" ADD CONSTRAINT "shipping_ticket_member_ticket_id_shipping_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."shipping_ticket"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_ticket_member" ADD CONSTRAINT "shipping_ticket_member_source_row_id_source_import_row_id_fk" FOREIGN KEY ("source_row_id") REFERENCES "public"."source_import_row"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_ticket_member" ADD CONSTRAINT "shipping_ticket_member_demand_id_demand_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_ticket_member" ADD CONSTRAINT "shipping_ticket_member_group_id_sub_batch_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."sub_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_ticket" ADD CONSTRAINT "shipping_ticket_run_id_shipping_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."shipping_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_run_import_uq" ON "shipping_run" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_run_month_sequence_uq" ON "shipping_run" USING btree ("month","sequence");--> statement-breakpoint
CREATE INDEX "shipping_run_status_idx" ON "shipping_run" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_ticket_member_demand_uq" ON "shipping_ticket_member" USING btree ("demand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_ticket_member_run_fba_uq" ON "shipping_ticket_member" USING btree ("run_id","fba");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_ticket_member_order_uq" ON "shipping_ticket_member" USING btree ("ticket_id","input_order");--> statement-breakpoint
CREATE INDEX "shipping_ticket_member_run_idx" ON "shipping_ticket_member" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_ticket_source_uq" ON "shipping_ticket" USING btree ("run_id","source_ticket_index");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_ticket_number_uq" ON "shipping_ticket" USING btree ("number");
--> statement-breakpoint
INSERT INTO "source_mapping_version" ("key", "parser_version", "definition") VALUES
  ('fba-list-v1', 'xlsx-preview-v3', '{"fba":"A","headerRow":"auto","ticketSeparator":"empty-row","datePolicy":"import-date-shanghai-v1"}'::jsonb)
ON CONFLICT ("key") DO NOTHING;
