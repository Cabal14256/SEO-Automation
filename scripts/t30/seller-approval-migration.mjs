import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// SQL validation only: every table is TEMP, all changes are rolled back, and no
// application or remote API client is imported or started.
if (!process.argv.includes('--run')) { console.log('Prepared temporary-table migration validation. Use --run.'); process.exit(0); }
const root = resolve(import.meta.dirname, '../..'), server = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(server, 'package.json'));
for (const [key, value] of Object.entries(requireServer('dotenv').parse(await readFile(resolve(server, '.env'))))) if (process.env[key] === undefined) process.env[key] = value;
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/scm_automation_dev');
const client = new (requireServer('pg').Client)({ connectionString: process.env.DATABASE_URL });
const migration = await readFile(resolve(server, 'drizzle/0011_next_thunderbolts.sql'), 'utf8');
const outDir = resolve(process.env.SELLER_APPROVAL_EVIDENCE_DIR || resolve(root, '.local/t30/backend'));
let passed = false;
await client.connect();
try {
  await client.query('begin');
  await client.query('set local search_path = pg_temp, public');
  await client.query(`
    create temporary table "user" (id text primary key, name text, email text, role text, banned boolean, ban_reason text);
    create temporary table account (user_id text);
    create temporary table session (user_id text);
    create temporary table file_index (id uuid primary key, sha256 text, mime_type text, original_name text);
    create temporary table seller_mapping (id uuid primary key, sid integer, name text, country text, marketplace_id text, wid text,
      status text, version integer, source_observed_at timestamptz, source_sha256 text, source_file_id uuid, updated_at timestamptz,
      manual_enabled boolean, lingxing_data jsonb);
    create temporary table seller_alias (seller_mapping_id uuid, alias text);
    create temporary table seller_catalog_settings (id text primary key, catalog_version integer, updated_by text, updated_at timestamptz);
    create temporary table seller_mapping_revision (operation_id uuid primary key, seller_mapping_id uuid, version integer,
      actor_user_id text, request_hash text, reason text, "before" jsonb, "after" jsonb, unique(seller_mapping_id,version));
    create temporary table operation_audit (id uuid primary key, action text, target_id uuid, actor_user_id text, request_hash text, details jsonb);
    insert into seller_catalog_settings values ('global',7,null,now());`);
  const fileId = randomUUID(), sha256 = 'a'.repeat(64);
  await client.query('insert into file_index values ($1,$2,$3,$4)', [fileId, sha256, 'application/json', 'lingxing-sellers-technical.json']);
  const remote = { name: 'Technical remote', country: 'Technical country', marketplaceId: 'TECH', present: true, status: '1', observedAt: '2026-10-18T00:00:00.000Z', sha256, fileId };
  const fixtures = [
    { sid: 101, status: 'candidate', remote },
    { sid: 102, status: 'disabled', remote },
    { sid: 103, status: 'candidate', remote: { ...remote, status: '0' } },
    { sid: 104, status: 'candidate', remote: { ...remote, present: false } },
    { sid: 105, status: 'candidate', remote: { ...remote, name: ' ' } },
    { sid: 106, status: 'candidate', remote: { ...remote, observedAt: 'invalid-time' } },
    { sid: 107, status: 'candidate', remote: { ...remote, sha256: 'b'.repeat(64) } },
    { sid: 108, status: 'approved', remote: { ...remote, fileId: randomUUID() } },
    { sid: 109, status: 'candidate', remote: null },
    { sid: 110, status: 'candidate', remote: { ...remote, country: 123 } },
  ];
  for (const fixture of fixtures) {
    const id = randomUUID();
    await client.query('insert into seller_mapping values ($1,$2,$3,$4,null,null,$5,3,now(),$6,null,now(),true,$7)', [id, fixture.sid, 'Technical manual', 'Manual country', fixture.status, 'c'.repeat(64), fixture.remote]);
    await client.query('insert into seller_alias values ($1,$2)', [id, 'Technical alias ' + fixture.sid]);
  }
  const publicBefore = (await client.query('select count(*)::int as count from public.seller_mapping')).rows[0].count;
  await client.query(migration);
  const current = (await client.query('select sid,status,version,lingxing_auto_approved,lingxing_disabled from seller_mapping order by sid')).rows;
  assert.deepEqual(current.filter((row) => row.lingxing_auto_approved).map((row) => row.sid), [101, 102]);
  assert.deepEqual(current.map((row) => row.version), [4, 4, 3, 3, 3, 3, 3, 3, 3, 3]);
  assert.equal(current[0].status, 'candidate'); assert.equal(current[1].status, 'disabled'); assert.equal(current[1].lingxing_disabled, true);
  const revisions = (await client.query('select * from seller_mapping_revision order by "after"->>\'sid\'')).rows;
  assert.equal(revisions.length, 2);
  for (const revision of revisions) {
    assert.equal(revision.before.dataSource, 'lingxing'); assert.equal(revision.after.dataSource, 'lingxing'); assert.equal(revision.after.version, 4);
    assert.equal(revision.after.autoApproved, true); assert.equal(revision.after.aliases.length, 1); assert.equal(revision.after.sourceSha256, sha256);
  }
  assert.deepEqual(revisions.map((revision) => revision.after.status), ['approved', 'disabled']);
  assert.equal((await client.query('select count(*)::int as count from operation_audit')).rows[0].count, 2);
  const system = (await client.query('select * from "user"')).rows; assert.equal(system.length, 1); assert.equal(system[0].banned, true);
  assert.equal((await client.query('select count(*)::int as count from account')).rows[0].count, 0);
  assert.equal((await client.query('select count(*)::int as count from session')).rows[0].count, 0);
  assert.equal((await client.query('select catalog_version from seller_catalog_settings')).rows[0].catalog_version, 8);
  await client.query(migration.slice(migration.indexOf('DO $$')));
  assert.equal((await client.query('select count(*)::int as count from seller_mapping_revision')).rows[0].count, 2);
  assert.equal((await client.query('select catalog_version from seller_catalog_settings')).rows[0].catalog_version, 8);
  assert.equal((await client.query('select count(*)::int as count from public.seller_mapping')).rows[0].count, publicBefore);
  passed = true;
} finally {
  await client.query('rollback'); await client.end();
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'migration-result.json'), JSON.stringify({ result: passed ? 'passed' : 'failed', fixtures: 10, approvedPolicies: 2, explicitlyDisabledPreserved: 1,
    idempotentBackfill: passed, temporaryTablesRolledBack: true, externalRequests: 0, completedAt: new Date().toISOString() }, null, 2) + '\n');
}
console.log(JSON.stringify({ result: 'passed', fixtures: 10, temporaryTablesRolledBack: true, externalRequests: 0 }));
