CREATE TABLE "service_mapping" (
	"id" uuid PRIMARY KEY NOT NULL,
	"country_code" text NOT NULL,
	"transport_method" text NOT NULL,
	"transport_method_id" text,
	"service" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "service_mapping_country_check" CHECK ("service_mapping"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "service_mapping_fields_check" CHECK (length(btrim("service_mapping"."transport_method")) BETWEEN 1 AND 500 AND length(btrim("service_mapping"."service")) BETWEEN 1 AND 4000),
	CONSTRAINT "service_mapping_version_check" CHECK ("service_mapping"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "service_mapping" ADD CONSTRAINT "service_mapping_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_mapping" ADD CONSTRAINT "service_mapping_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_mapping_active_combination_uq" ON "service_mapping" USING btree ("country_code","transport_method") WHERE "service_mapping"."deleted_at" IS NULL;