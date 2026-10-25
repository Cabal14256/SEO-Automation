CREATE TABLE "demand_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"demand_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_revision_version_check" CHECK ("demand_revision"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "demand_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"demand_id" uuid NOT NULL,
	"accepted_version" integer NOT NULL,
	"import_id" uuid NOT NULL,
	"parse_run_id" uuid NOT NULL,
	"source_row_id" uuid NOT NULL,
	"sheet_name" text NOT NULL,
	"row_number" integer NOT NULL,
	"location" jsonb NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_source_row_check" CHECK ("demand_source"."row_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "demand" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sid" integer NOT NULL,
	"fba" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"version" integer NOT NULL,
	"business_date" date NOT NULL,
	"week_start_date" date NOT NULL,
	"week_end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_identity_check" CHECK ("demand"."sid" > 0 AND "demand"."fba" ~ '^FBA[A-Z0-9]+$'),
	CONSTRAINT "demand_version_check" CHECK ("demand"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "import_commit" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_preview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"parse_run_id" uuid NOT NULL,
	"import_version" integer NOT NULL,
	"created_by" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demand_revision" ADD CONSTRAINT "demand_revision_demand_id_demand_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_revision" ADD CONSTRAINT "demand_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_source" ADD CONSTRAINT "demand_source_demand_id_demand_id_fk" FOREIGN KEY ("demand_id") REFERENCES "public"."demand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_source" ADD CONSTRAINT "demand_source_import_id_source_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."source_import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_source" ADD CONSTRAINT "demand_source_parse_run_id_import_parse_run_id_fk" FOREIGN KEY ("parse_run_id") REFERENCES "public"."import_parse_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_source" ADD CONSTRAINT "demand_source_source_row_id_source_import_row_id_fk" FOREIGN KEY ("source_row_id") REFERENCES "public"."source_import_row"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_source" ADD CONSTRAINT "demand_source_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_revision_version_idx" ON "demand_revision" USING btree ("demand_id","version");--> statement-breakpoint
ALTER TABLE "demand_source" ADD CONSTRAINT "demand_source_revision_fk" FOREIGN KEY ("demand_id","accepted_version") REFERENCES "public"."demand_revision"("demand_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_commit" ADD CONSTRAINT "import_commit_import_id_source_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."source_import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_commit" ADD CONSTRAINT "import_commit_preview_id_import_preview_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."import_preview"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_commit" ADD CONSTRAINT "import_commit_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_preview" ADD CONSTRAINT "import_preview_import_id_source_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."source_import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_preview" ADD CONSTRAINT "import_preview_parse_run_id_import_parse_run_id_fk" FOREIGN KEY ("parse_run_id") REFERENCES "public"."import_parse_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_preview" ADD CONSTRAINT "import_preview_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_source_origin_idx" ON "demand_source" USING btree ("import_id","sheet_name","row_number");--> statement-breakpoint
CREATE INDEX "demand_source_demand_idx" ON "demand_source" USING btree ("demand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demand_sid_fba_idx" ON "demand" USING btree ("sid","fba");--> statement-breakpoint
CREATE INDEX "import_commit_import_idx" ON "import_commit" USING btree ("import_id","created_at");--> statement-breakpoint
CREATE INDEX "import_preview_import_idx" ON "import_preview" USING btree ("import_id","created_at");
