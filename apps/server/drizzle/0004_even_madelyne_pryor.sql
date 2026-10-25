-- Preserve historical business identities; remove only their ability to sign in.
DO $$
DECLARE
  actor_id text;
  disabled_count integer;
  revoked_count integer;
  credential_count integer;
BEGIN
  SELECT id INTO actor_id FROM "user" WHERE role = 'admin' AND banned = false ORDER BY created_at, id LIMIT 1;
  IF actor_id IS NULL AND EXISTS (SELECT 1 FROM "user") THEN
    RAISE EXCEPTION 'An active administrator is required before applying the administrator-only policy';
  END IF;
  UPDATE "user" SET banned = true,
    ban_reason = CASE WHEN banned = false THEN 'Administrator-only account policy (2026-10-17)' ELSE ban_reason END,
    ban_expires = NULL, updated_at = now()
    WHERE role <> 'admin' AND (banned = false OR ban_expires IS NOT NULL);
  GET DIAGNOSTICS disabled_count = ROW_COUNT;
  DELETE FROM "session" WHERE user_id IN (SELECT id FROM "user" WHERE role <> 'admin');
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  DELETE FROM "account" WHERE user_id IN (SELECT id FROM "user" WHERE role <> 'admin');
  GET DIAGNOSTICS credential_count = ROW_COUNT;
  IF actor_id IS NOT NULL THEN
    INSERT INTO operation_audit (id, action, target_id, actor_user_id, request_hash, details)
      VALUES (gen_random_uuid(), 'account.admin_only_migration', gen_random_uuid(), actor_id,
        'admin-only-v1', jsonb_build_object('policy', 'admin-only-v1', 'disabledAccounts', disabled_count::text,
          'revokedSessions', revoked_count::text, 'removedCredentials', credential_count::text));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'admin';--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_admin_only_active_check" CHECK ("user"."role" = 'admin' OR "user"."banned" = true);
