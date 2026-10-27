CREATE TABLE "shipping_lifecycle_operation" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"input" jsonb,
	"result" jsonb NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_lifecycle_pending_check" CHECK ("shipping_lifecycle_operation"."pending" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "shipping_lifecycle_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipping_run_operation" DROP CONSTRAINT "shipping_run_operation_run_id_shipping_run_id_fk";
--> statement-breakpoint
DROP INDEX "shipping_ticket_member_demand_uq";--> statement-breakpoint
DROP INDEX "shipping_ticket_member_run_fba_uq";--> statement-breakpoint
ALTER TABLE "demand" ADD COLUMN "lifecycle" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand" ADD COLUMN "lifecycle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "demand" ADD COLUMN "lifecycle_changed_by" text;--> statement-breakpoint
ALTER TABLE "demand" ADD COLUMN "lifecycle_reason" text;--> statement-breakpoint
ALTER TABLE "demand" ADD COLUMN "lifecycle_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "demand" ADD COLUMN "lifecycle_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "demand" ADD COLUMN "lifecycle_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD COLUMN "lifecycle" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD COLUMN "lifecycle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD COLUMN "lifecycle_changed_by" text;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD COLUMN "lifecycle_reason" text;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD COLUMN "lifecycle_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD COLUMN "lifecycle_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "sub_batch" ADD COLUMN "lifecycle_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "lifecycle" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "lifecycle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "lifecycle_changed_by" text;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "lifecycle_reason" text;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "lifecycle_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "lifecycle_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "shipping_run" ADD COLUMN "lifecycle_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_ticket_member" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "shipping_lifecycle_pending_idx" ON "shipping_lifecycle_operation" USING btree ("pending","created_at");--> statement-breakpoint
CREATE INDEX "shipping_lifecycle_snapshot_entity_idx" ON "shipping_lifecycle_snapshot" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_ticket_member_demand_uq" ON "shipping_ticket_member" USING btree ("demand_id") WHERE "shipping_ticket_member"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_ticket_member_run_fba_uq" ON "shipping_ticket_member" USING btree ("run_id","fba") WHERE "shipping_ticket_member"."released_at" IS NULL;--> statement-breakpoint
ALTER TABLE "demand" ADD CONSTRAINT "demand_lifecycle_check" CHECK ("demand"."lifecycle" IN ('active','cancelled','trashed'));--> statement-breakpoint
ALTER TABLE "sub_batch" ADD CONSTRAINT "sub_batch_lifecycle_check" CHECK ("sub_batch"."lifecycle" IN ('active','cancelled','trashed'));--> statement-breakpoint
ALTER TABLE "shipping_run" ADD CONSTRAINT "shipping_run_lifecycle_check" CHECK ("shipping_run"."lifecycle" IN ('active','cancelled','trashed'));
--> statement-breakpoint
-- Historically the UI labelled demand.cancel as deletion. Preserve that intent in the recycle bin.
UPDATE demand d SET lifecycle='trashed', lifecycle_changed_at=a.created_at,
  lifecycle_changed_by=a.actor_user_id, lifecycle_reason=COALESCE(a.details->>'reason','历史删除需求'),
  lifecycle_operation_id=CASE WHEN a.details->>'operationId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (a.details->>'operationId')::uuid ELSE NULL END
FROM (SELECT DISTINCT ON (target_id) * FROM operation_audit WHERE action='demand.cancel' ORDER BY target_id,created_at DESC,id DESC) a
WHERE d.id=a.target_id;
--> statement-breakpoint
UPDATE shipping_ticket_member m SET released_at=d.lifecycle_changed_at
FROM demand d WHERE m.demand_id=d.id AND d.lifecycle='trashed' AND m.released_at IS NULL;
