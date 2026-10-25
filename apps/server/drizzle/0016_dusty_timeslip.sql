CREATE TABLE "document_reference_dataset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_file_id" uuid NOT NULL,
	"source_sha256" text NOT NULL,
	"sheet_name" text NOT NULL,
	"source_range" text NOT NULL,
	"parser_version" text NOT NULL,
	"data" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_reference_dataset_kind_check" CHECK ("document_reference_dataset"."kind" IN ('customs_options', 'channel_catalog', 'address_catalog', 'transit_reference')),
	CONSTRAINT "document_reference_dataset_source_sha256_check" CHECK ("document_reference_dataset"."source_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "document_reference_dataset_content_sha256_check" CHECK ("document_reference_dataset"."content_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "document_reference_dataset" ADD CONSTRAINT "document_reference_dataset_source_file_id_file_index_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reference_dataset" ADD CONSTRAINT "document_reference_dataset_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_reference_dataset_source_unique" ON "document_reference_dataset" USING btree ("source_sha256","kind","sheet_name","parser_version");
--> statement-breakpoint
CREATE FUNCTION "document_reference_dataset_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'document_reference_dataset is immutable; insert a new dataset instead'
		USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "document_reference_dataset_immutable"
BEFORE UPDATE OR DELETE ON "document_reference_dataset"
FOR EACH ROW EXECUTE FUNCTION "document_reference_dataset_reject_mutation"();
