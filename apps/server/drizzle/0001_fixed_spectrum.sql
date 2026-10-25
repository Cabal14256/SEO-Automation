CREATE TABLE "seller_alias" (
	"normalized_alias" text PRIMARY KEY NOT NULL,
	"alias" text NOT NULL,
	"seller_mapping_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_mapping_revision" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"seller_mapping_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"reason" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_mapping" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sid" integer NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"marketplace_id" text,
	"wid" text,
	"status" text DEFAULT 'candidate' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_observed_at" timestamp with time zone NOT NULL,
	"source_sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_mapping_sid_unique" UNIQUE("sid"),
	CONSTRAINT "seller_mapping_status_check" CHECK ("seller_mapping"."status" IN ('candidate', 'approved', 'disabled')),
	CONSTRAINT "seller_mapping_version_check" CHECK ("seller_mapping"."version" > 0),
	CONSTRAINT "seller_mapping_sid_check" CHECK ("seller_mapping"."sid" > 0)
);
--> statement-breakpoint
ALTER TABLE "seller_alias" ADD CONSTRAINT "seller_alias_seller_mapping_id_seller_mapping_id_fk" FOREIGN KEY ("seller_mapping_id") REFERENCES "public"."seller_mapping"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_mapping_revision" ADD CONSTRAINT "seller_mapping_revision_seller_mapping_id_seller_mapping_id_fk" FOREIGN KEY ("seller_mapping_id") REFERENCES "public"."seller_mapping"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_mapping_revision" ADD CONSTRAINT "seller_mapping_revision_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_alias_mapping_idx" ON "seller_alias" USING btree ("seller_mapping_id");--> statement-breakpoint
CREATE INDEX "seller_mapping_revision_target_idx" ON "seller_mapping_revision" USING btree ("seller_mapping_id");