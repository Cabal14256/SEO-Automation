CREATE TABLE "document_export" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"reference" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"queue_job_id" text,
	"file_id" uuid,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "document_export_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "document_export_status_check" CHECK ("document_export"."status" IN ('queued','running','completed','failed','stale'))
);
--> statement-breakpoint
CREATE TABLE "document_member_claim" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"sid" integer NOT NULL,
	"fba" text NOT NULL,
	"demand_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_profile_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"data" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_profile_version_check" CHECK ("document_profile"."version" > 0),
	CONSTRAINT "document_profile_status_check" CHECK ("document_profile"."status" IN ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "document_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"export_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"file_sha256" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"dependencies" jsonb NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_review_decision_check" CHECK ("document_review"."decision" IN ('approve','return'))
);
--> statement-breakpoint
CREATE TABLE "document_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_template_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"original_name" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_template_version_check" CHECK ("document_template"."version" > 0),
	CONSTRAINT "document_template_status_check" CHECK ("document_template"."status" IN ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "document_validation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"valid" boolean NOT NULL,
	"issues" jsonb NOT NULL,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"current_revision_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_status_check" CHECK ("document"."status" IN ('draft','pending_review','approved','returned','cancelled','superseded','stale')),
	CONSTRAINT "document_version_check" CHECK ("document"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "document_export" ADD CONSTRAINT "document_export_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export" ADD CONSTRAINT "document_export_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_member_claim" ADD CONSTRAINT "document_member_claim_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_member_claim" ADD CONSTRAINT "document_member_claim_revision_id_document_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."document_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_profile_version" ADD CONSTRAINT "document_profile_version_profile_id_document_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."document_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_profile_version" ADD CONSTRAINT "document_profile_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_profile" ADD CONSTRAINT "document_profile_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review" ADD CONSTRAINT "document_review_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review" ADD CONSTRAINT "document_review_revision_id_document_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."document_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review" ADD CONSTRAINT "document_review_export_id_document_export_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."document_export"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review" ADD CONSTRAINT "document_review_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review" ADD CONSTRAINT "document_review_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_template_version" ADD CONSTRAINT "document_template_version_template_id_document_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_template_version" ADD CONSTRAINT "document_template_version_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_template_version" ADD CONSTRAINT "document_template_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_validation" ADD CONSTRAINT "document_validation_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_validation" ADD CONSTRAINT "document_validation_revision_id_document_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."document_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_validation" ADD CONSTRAINT "document_validation_checked_by_user_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_export_document_idx" ON "document_export" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_member_live_unique" ON "document_member_claim" USING btree ("purpose","sid","fba") WHERE "document_member_claim"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "document_member_document_idx" ON "document_member_claim" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_profile_version_idx" ON "document_profile_version" USING btree ("profile_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "document_profile_category_key_idx" ON "document_profile" USING btree ("category","key");--> statement-breakpoint
CREATE INDEX "document_review_document_idx" ON "document_review" USING btree ("document_id","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revision_version_idx" ON "document_revision" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "document_template_version_idx" ON "document_template_version" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "document_template_purpose_name_idx" ON "document_template" USING btree ("purpose","name");--> statement-breakpoint
CREATE INDEX "document_validation_document_idx" ON "document_validation" USING btree ("document_id","checked_at");--> statement-breakpoint
CREATE INDEX "document_created_idx" ON "document" USING btree ("created_at");