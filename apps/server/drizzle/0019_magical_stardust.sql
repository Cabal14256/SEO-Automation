-- Stop before any schema/data change if legacy scopes contain conflicting active memberships.
DO $migration$
DECLARE conflicts text;
BEGIN
  SELECT string_agg(demand_id::text || ': ' || groups, E'\n') INTO conflicts
  FROM (SELECT demand_id, string_agg(group_id::text, ', ' ORDER BY group_id) AS groups
        FROM sub_batch_member WHERE active GROUP BY demand_id HAVING count(*) > 1) duplicate_members;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot migrate: a demand belongs to multiple active groups'
      USING DETAIL = conflicts, HINT = 'Resolve the listed memberships explicitly, then retry the migration.';
  END IF;
END $migration$;
--> statement-breakpoint
CREATE TABLE "shipping_run_correction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipping_run" DROP CONSTRAINT "shipping_run_status_check";--> statement-breakpoint
DROP INDEX "sub_batch_member_active_unique";--> statement-breakpoint
DROP INDEX "weekly_batch_week_idx";--> statement-breakpoint
ALTER TABLE "shipping_run" ALTER COLUMN "import_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_run" ALTER COLUMN "parse_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_ticket_member" ALTER COLUMN "source_row_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_batch" ADD COLUMN "shipping_run_id" uuid;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "origin" text DEFAULT 'import' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "membership_frozen_at" timestamp with time zone;--> statement-breakpoint
UPDATE shipping_run r SET membership_frozen_at = published.completed_at
FROM (SELECT projection->>'shippingRunId' AS run_id, min(completed_at) AS completed_at
      FROM batch_export WHERE status='completed' AND projection ? 'shippingRunId'
      GROUP BY projection->>'shippingRunId') published
WHERE r.id::text=published.run_id;
--> statement-breakpoint
ALTER TABLE "shipping_run_correction" ADD CONSTRAINT "shipping_run_correction_run_id_shipping_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."shipping_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_run_correction" ADD CONSTRAINT "shipping_run_correction_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_run_correction_version_uq" ON "shipping_run_correction" USING btree ("run_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_batch_run_uq" ON "weekly_batch" USING btree ("shipping_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_batch_member_active_unique" ON "sub_batch_member" USING btree ("demand_id") WHERE "sub_batch_member"."active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_batch_week_idx" ON "weekly_batch" USING btree ("week_start_date","week_end_date") WHERE "weekly_batch"."shipping_run_id" IS NULL;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD CONSTRAINT "shipping_run_origin_check" CHECK (("shipping_run"."origin"='import' AND "shipping_run"."import_id" IS NOT NULL AND "shipping_run"."parse_run_id" IS NOT NULL) OR ("shipping_run"."origin"='manual' AND "shipping_run"."import_id" IS NULL AND "shipping_run"."parse_run_id" IS NULL));--> statement-breakpoint
ALTER TABLE "shipping_run" ADD CONSTRAINT "shipping_run_status_check" CHECK ("shipping_run"."status" IN ('draft','queued','running','needs_review','ready','failed'));
