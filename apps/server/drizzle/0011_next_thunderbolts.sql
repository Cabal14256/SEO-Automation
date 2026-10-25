ALTER TABLE "seller_mapping" ADD COLUMN "lingxing_auto_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_mapping" ADD COLUMN "lingxing_disabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Preserve legacy explicit local disable decisions independently of manual approval.
UPDATE "seller_mapping" SET "lingxing_disabled" = true WHERE "status" = 'disabled';
--> statement-breakpoint
-- Apply the approval policy once to trustworthy archived observations, never by GET
-- or a repeated remote query. Drizzle runs this migration in its transaction.
DO $$
DECLARE
  entry record;
  observed_at timestamptz;
  operation_id uuid;
  request_hash text;
  previous jsonb;
  current_snapshot jsonb;
  aliases jsonb;
  changed integer := 0;
  system_actor constant text := 'system:seller-catalog-auto-approval-v1';
BEGIN
  PERFORM 1 FROM "seller_catalog_settings" WHERE "id" = 'global' FOR UPDATE;
  FOR entry IN
    SELECT m.* FROM "seller_mapping" m
    JOIN "file_index" f ON f."id"::text = m."lingxing_data"->>'fileId'
      AND f."sha256" = m."lingxing_data"->>'sha256'
      AND f."mime_type" = 'application/json'
      AND f."original_name" LIKE 'lingxing-sellers-%.json'
    WHERE NOT m."lingxing_auto_approved"
      AND m."lingxing_data"->'present' = 'true'::jsonb
      AND m."lingxing_data"->>'status' = '1'
      AND jsonb_typeof(m."lingxing_data"->'status') = 'string'
      AND jsonb_typeof(m."lingxing_data"->'name') = 'string'
      AND jsonb_typeof(m."lingxing_data"->'country') = 'string'
      AND jsonb_typeof(m."lingxing_data"->'observedAt') = 'string'
      AND m."sid" > 0
      AND length(btrim(m."lingxing_data"->>'name')) BETWEEN 1 AND 160
      AND length(btrim(m."lingxing_data"->>'country')) BETWEEN 1 AND 80
      AND m."lingxing_data"->>'sha256' ~ '^[a-f0-9]{64}$'
    ORDER BY m."id" FOR UPDATE OF m
  LOOP
    BEGIN
      observed_at := (entry."lingxing_data"->>'observedAt')::timestamptz;
      IF observed_at IS NULL OR NOT isfinite(observed_at) THEN CONTINUE; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN CONTINUE;
    END;
    IF changed = 0 THEN
      INSERT INTO "user" ("id", "name", "email", "role", "banned", "ban_reason")
      VALUES (system_actor, 'System: Lingxing approval policy migration', 'seller-catalog-auto-approval-v1@system.invalid', 'admin', true, 'Non-login migration audit identity')
      ON CONFLICT ("id") DO NOTHING;
      IF NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = system_actor AND "banned" = true)
        OR EXISTS (SELECT 1 FROM "account" WHERE "user_id" = system_actor)
        OR EXISTS (SELECT 1 FROM "session" WHERE "user_id" = system_actor) THEN
        RAISE EXCEPTION 'Migration audit identity must be disabled and have no login credentials';
      END IF;
    END IF;
    SELECT COALESCE(jsonb_agg(a."alias" ORDER BY a."alias"), '[]'::jsonb) INTO aliases
      FROM "seller_alias" a WHERE a."seller_mapping_id" = entry."id";
    previous := jsonb_build_object('id', entry."id", 'sid', entry."sid", 'name', entry."lingxing_data"->>'name',
      'country', entry."lingxing_data"->>'country', 'marketplaceId', entry."lingxing_data"->'marketplaceId', 'wid', entry."wid",
      'aliases', aliases, 'status', entry."status", 'version', entry."version", 'updatedAt', entry."updated_at",
      'sourceObservedAt', observed_at, 'sourceSha256', entry."lingxing_data"->>'sha256', 'dataSource', 'lingxing',
      'manualEnabled', entry."manual_enabled", 'lingxingName', entry."lingxing_data"->>'name',
      'lingxingStatus', entry."lingxing_data"->>'status', 'identityLocked', true,
      'hasApprovedBefore', entry."status" = 'approved', 'autoApproved', false);
    current_snapshot := previous || jsonb_build_object('status', CASE WHEN entry."lingxing_disabled" THEN 'disabled' ELSE 'approved' END,
      'version', entry."version" + 1, 'updatedAt', now(), 'autoApproved', true,
      'hasApprovedBefore', entry."status" = 'approved' OR NOT entry."lingxing_disabled");
    operation_id := gen_random_uuid();
    request_hash := encode(sha256(convert_to('lingxing-auto-approval-v1:' || entry."id"::text, 'UTF8')), 'hex');
    UPDATE "seller_mapping" SET "lingxing_auto_approved" = true, "version" = "version" + 1, "updated_at" = now() WHERE "id" = entry."id";
    INSERT INTO "seller_mapping_revision" ("operation_id", "seller_mapping_id", "version", "actor_user_id", "request_hash", "reason", "before", "after")
    VALUES (operation_id, entry."id", entry."version" + 1, system_actor, request_hash,
      '领星已授权缓存店铺自动批准；人工资料审批与本地停用决定保留。', previous, current_snapshot);
    INSERT INTO "operation_audit" ("id", "action", "target_id", "actor_user_id", "request_hash", "details")
    VALUES (gen_random_uuid(), 'seller_mapping.auto_approve', entry."id", system_actor, request_hash,
      jsonb_build_object('operationId', operation_id::text, 'source', 'lingxing', 'policy', 'lingxing-auto-approval-v1',
        'migration', '0011_next_thunderbolts', 'version', (entry."version" + 1)::text,
        'sourceSha256', entry."lingxing_data"->>'sha256', 'sourceFileId', entry."lingxing_data"->>'fileId', 'localDisabled', entry."lingxing_disabled"::text));
    changed := changed + 1;
  END LOOP;
  IF changed > 0 THEN
    UPDATE "seller_catalog_settings" SET "catalog_version" = "catalog_version" + 1, "updated_by" = system_actor, "updated_at" = now() WHERE "id" = 'global';
  END IF;
END $$;
