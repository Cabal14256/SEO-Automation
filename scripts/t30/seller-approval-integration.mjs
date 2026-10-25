import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { importAcceptedSchema, importRowsResponseSchema, sellerMappingSchema, sourceImportSchema } from '../../packages/contracts/dist/index.js';

if (!process.argv.includes('--run')) { console.log('Prepared. Use --run after coordinated migration/API/Worker readiness.'); process.exit(0); }
const root = resolve(import.meta.dirname, '../..'), server = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(server, 'package.json'));
for (const [key, value] of Object.entries(requireServer('dotenv').parse(await readFile(resolve(server, '.env'))))) if (process.env[key] === undefined) process.env[key] = value;
process.env.LINGXING_REQUESTS_ENABLED = 'false';
const ExcelJS = requireServer('exceljs');
const { auth } = await import(pathToFileURL(resolve(server, 'dist/auth.js')));
const { readConfig } = await import(pathToFileURL(resolve(server, 'dist/config.js')));
const { pool, closeDatabase } = await import(pathToFileURL(resolve(server, 'dist/db/client.js')));
const config = readConfig(), base = new URL(process.env.SELLER_APPROVAL_BASE_URL || 'http://localhost:3001').origin;
const outDir = resolve(process.env.SELLER_APPROVAL_EVIDENCE_DIR || resolve(root, '.local/t30/backend'));
const checks = [], runId = randomUUID();
let actorId = null, cookie = '', stage = 'preflight', failed = false, cleaned = false;
const note = (name, details = {}) => { checks.push({ name, result: 'passed', ...details }); console.log('PASS ' + name); };
async function request(path, method = 'GET', body) {
  const multipart = body instanceof FormData;
  const response = await fetch(base + '/api/v1' + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Origin: config.WEB_ORIGIN,
    ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
  const bytes = Buffer.from(await response.arrayBuffer()); let data = null;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { /* Binary template. */ }
  return { status: response.status, data, bytes, cookie: response.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ') };
}
async function catalogCounters() {
  return (await pool.query(`select (select catalog_version from seller_catalog_settings where id='global') as catalog_version,
    (select sum(version)::int from seller_mapping) as mapping_versions,
    (select count(*)::int from seller_mapping_revision) as revisions,
    (select count(*)::int from operation_audit where action like 'seller_%') as audit`)).rows[0];
}
try {
  assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_automation_dev');
  assert.equal((await request('/health')).status, 200);
  const email = 't30-' + runId + '@acceptance.invalid', password = randomBytes(32).toString('base64url');
  actorId = (await auth.api.createUser({ body: { email, password, name: 'T30 technical validation', role: 'admin' } })).user.id;
  const session = await request('/auth/sign-in/email', 'POST', { email, password }); assert.equal(session.status, 200); assert(session.cookie); cookie = session.cookie;
  note('healthy-existing-api-worker-and-temporary-admin-session');

  stage = 'cached-catalog-policy';
  const before = await catalogCounters();
  const cached = (await pool.query(`select m.id,m.sid,m.status,m.version,m.manual_enabled,m.lingxing_auto_approved,m.lingxing_disabled,m.lingxing_data,
    (f.id is not null and f.sha256=m.lingxing_data->>'sha256' and f.mime_type='application/json' and f.original_name like 'lingxing-sellers-%.json') as trusted_archive
    from seller_mapping m left join file_index f on f.id::text=m.lingxing_data->>'fileId'`)).rows;
  const trusted = cached.filter((row) => { const remote = row.lingxing_data; return row.trusted_archive && remote?.present === true && remote.status === '1'
    && typeof remote.name === 'string' && remote.name.trim() && typeof remote.country === 'string' && remote.country.trim()
    && typeof remote.observedAt === 'string' && Number.isFinite(Date.parse(remote.observedAt)); });
  assert(trusted.every((row) => row.lingxing_auto_approved), 'Every trustworthy authorized cached identity must receive the approval policy');
  const eligible = trusted.filter((row) => !row.lingxing_disabled);
  assert(eligible.length > 0, 'Migration must publish trustworthy cached approvals');
  const listed = await request('/seller-mappings?pageSize=100&status=approved'); assert.equal(listed.status, 200); assert.equal(listed.data.settings.mode, 'lingxing');
  const items = listed.data.items.map((row) => sellerMappingSchema.parse(row));
  for (const row of eligible) assert(items.some((item) => item.id === row.id && item.status === 'approved' && item.autoApproved), 'Eligible cached shop must be approved in the current-source list');
  const all = await request('/seller-mappings?pageSize=100'); assert.equal(all.status, 200);
  for (const row of cached.filter((row) => row.lingxing_data?.present && (row.lingxing_disabled || row.lingxing_data.status !== '1'))) {
    assert(all.data.items.some((item) => item.id === row.id && item.status === 'disabled'), 'Locally disabled or unauthorized cache must remain disabled');
  }
  assert.deepEqual(await catalogCounters(), before, 'Catalog GETs must not write approvals, versions or audit');
  const system = (await pool.query(`select banned,
    (select count(*)::int from account where user_id=u.id) as credentials,
    (select count(*)::int from session where user_id=u.id) as sessions
    from "user" u where id='system:seller-catalog-auto-approval-v1'`)).rows[0];
  assert.deepEqual(system, { banned: true, credentials: 0, sessions: 0 });
  note('trusted-cache-auto-approved-with-pure-get-and-non-login-migration-audit', { cachedRows: cached.length, trustedAuthorizedRows: trusted.length, authorizedApprovedRows: eligible.length });

  stage = 'remote-write-gates';
  const normalize = (value) => value.normalize('NFKC').trim().toLowerCase();
  const unambiguous = eligible.filter((row) => { const item = items.find((item) => item.id === row.id); return item && items.filter((other) => [other.name, ...other.aliases].some((name) => normalize(name) === normalize(item.name))).length === 1; });
  const chosenRow = unambiguous.find((row) => row.status === 'candidate') ?? unambiguous[0]; assert(chosenRow, 'A uniquely named current shop is needed for the isolated parse fixture');
  const chosen = items.find((row) => row.id === chosenRow.id);
  assert(chosen);
  const payload = { operationId: randomUUID(), expectedVersion: chosen.version, expectedCatalogSettingsVersion: listed.data.settings.version,
    expectedCatalogVersion: listed.data.settings.catalogVersion, aliases: chosen.aliases, status: 'candidate', reason: 'Technical rejected request' };
  const candidate = await request('/seller-mappings/' + chosen.id + '/aliases', 'POST', payload); assert.equal(candidate.status, 422);
  const identity = await request('/seller-mappings/' + chosen.id + '/aliases', 'POST', { ...payload, operationId: randomUUID(), status: 'approved', name: 'Forbidden remote identity write' }); assert.equal(identity.status, 422);
  const manual = await request('/seller-mappings/manual', 'POST', { operationId: randomUUID(), sid: 2147400000, name: 'T30 technical manual', country: 'Technical country' }); assert.equal(manual.status, 409); assert.equal(manual.data.error.code, 'CATALOG_READ_ONLY');
  assert.deepEqual(await catalogCounters(), before);
  note('remote-candidate-and-identity-writes-rejected-and-manual-mode-gate-preserved');

  stage = 'automatic-worker-resolution';
  const template = await request('/imports/template'); assert.equal(template.status, 200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(template.bytes);
  workbook.getWorksheet('在线需求导入').getRow(2).values = [chosen.name, 'HY', chosen.country, '', 'FBATECH' + runId.replaceAll('-', '').toUpperCase(), '0'];
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer()), form = new FormData();
  form.set('operationId', randomUUID()); form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'technical-auto-approval.xlsx');
  const upload = await request('/imports', 'POST', form); assert.equal(upload.status, 202);
  const accepted = importAcceptedSchema.parse(upload.data);
  let parsed;
  const deadline = Date.now() + 45000;
  do {
    const result = await request('/imports/' + accepted.import.id); assert.equal(result.status, 200); parsed = sourceImportSchema.parse(result.data.import);
    if (!['queued', 'parsing'].includes(parsed.status)) break;
    if (Date.now() >= deadline) throw new Error('PARSE_TIMEOUT'); await delay(250);
  } while (true);
  assert.equal(parsed.status, 'preview_ready');
  const rowResponse = await request('/imports/' + accepted.import.id + '/rows'); assert.equal(rowResponse.status, 200);
  const rows = importRowsResponseSchema.parse(rowResponse.data); assert.equal(rows.total, 1);
  assert.equal(rows.items[0].normalized.sellerMappingId, chosen.id); assert.equal(rows.items[0].normalized.sid, chosen.sid); assert.equal(rows.items[0].normalized.sellerMappingVersion, chosen.version);
  assert(!rows.items[0].issues.some((issue) => ['SOURCE_MAPPING_REQUIRED', 'SELLER_ALIAS_CONFLICT'].includes(issue.code)), 'Auto-approved current source must resolve in the worker');
  const context = await request('/imports/' + accepted.import.id + '/confirmation'); assert.equal(context.status, 200);
  assert(context.data.sellers.some((seller) => seller.id === chosen.id && seller.status === 'approved'));
  const stale = await request('/imports/' + accepted.import.id + '/preview', 'POST', { expectedVersion: parsed.version, parseRunId: parsed.latestRun.id,
    sellerSelections: [{ sourceShop: chosen.name, sellerMappingId: chosen.id, expectedVersion: chosen.version, confirmed: true }],
    expectedCatalogSettingsVersion: context.data.catalog.version, expectedCatalogVersion: Math.max(0, context.data.catalog.catalogVersion - 1) });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'SELLER_CATALOG_CONFLICT');
  assert.equal((await pool.query('select status from seller_mapping where id=$1', [chosen.id])).rows[0].status, chosenRow.status);
  assert.deepEqual(await catalogCounters(), before);
  note('worker-and-confirmation-use-current-automatic-approval-with-version-gates-and-unchanged-manual-status', { sourceRows: 1 });
} catch (error) {
  failed = true; checks.push({ name: stage, result: 'failed', code: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'INTEGRATION_FAILED' });
  console.error('FAIL ' + stage + ': ' + (error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'INTEGRATION_FAILED'));
} finally {
  if (actorId) {
    try {
      const deadline = Date.now() + 30000;
      while ((await pool.query('select count(*)::int as count from pgboss.job where name=$1 and data->>\'runId\' in (select id::text from import_parse_run where created_by=$2) and state in (\'active\',\'created\',\'retry\')', ['import-parse', actorId])).rows[0].count > 0) {
        if (Date.now() >= deadline) throw new Error('TECHNICAL_QUEUE_ACTIVE'); await delay(250);
      }
      assert.equal((await pool.query('select count(*)::int as count from demand_source where created_by=$1', [actorId])).rows[0].count, 0);
      const files = (await pool.query('select storage_key from file_index where created_by=$1', [actorId])).rows;
      const targets = files.map((file) => { const target = resolve(config.dataDir, file.storage_key), suffix = relative(resolve(config.dataDir), target); assert(suffix && !suffix.startsWith('..') && !isAbsolute(suffix)); return target; });
      const tx = await pool.connect();
      try {
        await tx.query('begin');
        await tx.query('delete from pgboss.job where name=$1 and data->>\'runId\' in (select id::text from import_parse_run where created_by=$2)', ['import-parse', actorId]);
        await tx.query('delete from import_operation where actor_user_id=$1', [actorId]);
        await tx.query('delete from import_preview where created_by=$1', [actorId]);
        await tx.query('delete from source_import_row where parse_run_id in (select id from import_parse_run where created_by=$1)', [actorId]);
        await tx.query('update source_import set latest_run_id=null where created_by=$1', [actorId]);
        await tx.query('delete from import_parse_run where created_by=$1', [actorId]);
        await tx.query('delete from operation_audit where actor_user_id=$1', [actorId]);
        await tx.query('delete from source_import where created_by=$1', [actorId]);
        await tx.query('delete from file_index where created_by=$1', [actorId]);
        await tx.query('update "user" set banned=true,ban_reason=$2 where id=$1', [actorId, 'T30 technical validation completed']);
        await tx.query('delete from session where user_id=$1', [actorId]); await tx.query('delete from account where user_id=$1', [actorId]);
        await tx.query('commit');
      } catch (error) { await tx.query('rollback'); throw error; } finally { tx.release(); }
      for (const target of targets) await unlink(target).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      cleaned = true;
    } catch { failed = true; checks.push({ name: 'technical-fixture-cleanup', result: 'failed', code: 'CLEANUP_FAILED' }); }
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'integration-result.json'), JSON.stringify({ kind: 'existing-runtime-cache-auto-approval', result: failed ? 'failed' : 'passed', runId, checks,
    technicalFixturesRemoved: cleaned, existingCatalogUnchanged: !failed, externalRequests: 0, completedAt: new Date().toISOString() }, null, 2) + '\n');
  await closeDatabase(); console.log(JSON.stringify({ result: failed ? 'failed' : 'passed', checks: checks.filter((check) => check.result === 'passed').length, technicalFixturesRemoved: cleaned, externalRequests: 0 }));
  if (failed) process.exitCode = 1;
}
