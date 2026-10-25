CREATE TABLE "import_draft" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_expected_version" integer NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "import_draft_version_check" CHECK ("import_draft"."version">0 AND "import_draft"."last_expected_version">=0 AND "import_draft"."last_expected_version"<"import_draft"."version"),
	CONSTRAINT "import_draft_title_check" CHECK (length(trim("import_draft"."title")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
ALTER TABLE "import_draft" ADD CONSTRAINT "import_draft_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_draft_owner_updated_idx" ON "import_draft" USING btree ("owner_id","updated_at");