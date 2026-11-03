CREATE TABLE "seller_export_code" (
	"sid" integer PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_export_code_format_check" CHECK ("seller_export_code"."code" ~ '^[0-9]{0,20}$'),
	CONSTRAINT "seller_export_code_version_check" CHECK ("seller_export_code"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "seller_export_code" ADD CONSTRAINT "seller_export_code_sid_seller_mapping_sid_fk" FOREIGN KEY ("sid") REFERENCES "public"."seller_mapping"("sid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_export_code" ADD CONSTRAINT "seller_export_code_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;