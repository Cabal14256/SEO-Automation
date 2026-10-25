CREATE TABLE "seller_catalog_operation" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_catalog_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'lingxing' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"catalog_version" integer DEFAULT 0 NOT NULL,
	"source_file_id" uuid,
	"last_synced_at" timestamp with time zone,
	"last_error" jsonb,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_catalog_mode_check" CHECK ("seller_catalog_settings"."mode" IN ('lingxing','manual')),
	CONSTRAINT "seller_catalog_version_check" CHECK ("seller_catalog_settings"."version" > 0 AND "seller_catalog_settings"."catalog_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "seller_mapping" ADD COLUMN "manual_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_mapping" ADD COLUMN "lingxing_data" jsonb;--> statement-breakpoint
ALTER TABLE "seller_catalog_operation" ADD CONSTRAINT "seller_catalog_operation_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_catalog_settings" ADD CONSTRAINT "seller_catalog_settings_source_file_id_file_index_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_catalog_settings" ADD CONSTRAINT "seller_catalog_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "seller_catalog_settings" ("id", "mode") VALUES ('global', 'lingxing');
