import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { IMPORT_PARSER_VERSION, importAcceptedSchema, importRowsResponseSchema, sourceImportSchema } from '../../packages/contracts/dist/index.js';

// Uses only the already-running coordinated development API and worker. No
// service lifecycle changes, existing account file or external business API.
if (!process.argv.includes('--run')) {
  console.log('Prepared. Use --run only after coordinated API/Worker readiness.');
  process.exit(0);
}
const root = resolve(import.meta.dirname, '../..'), server = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(server, 'package.json'));
for (const [key, value] of Object.entries(requireServer('dotenv').parse(await readFile(resolve(server, '.env'))))) if (process.env[key] === undefined) process.env[key] = value;
process.env.LINGXING_REQUESTS_ENABLED = 'false';
const ExcelJS = requireServer('exceljs');
const { auth } = await import(pathToFileURL(resolve(server, 'dist/auth.js')));
const { readConfig } = await import(pathToFileURL(resolve(server, 'dist/config.js')));
const { pool, closeDatabase } = await import(pathToFileURL(resolve(server, 'dist/db/client.js')));
const config = readConfig(), baseURL = new URL(process.env.IMPORT_VALIDATION_BASE_URL || 'http://localhost:3001').origin;
const out = resolve(process.env.IMPORT_VALIDATION_EVIDENCE_DIR || resolve(root, '.local/t29/backend'), 'result.json');
const runId = randomUUID(), checks = [];
let actorId = null, cookie = '', stage = 'preflight', failed = false, cleaned = false;
const note = (name, details = {}) => { checks.push({ name, result: 'passed', ...details }); console.log('PASS ' + name); };
async function request(path, method = 'GET', body) {
  const form = body instanceof FormData;
  const response = await fetch(baseURL + '/api/v1' + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Origin: config.WEB_ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }) });
  const bytes = Buffer.from(await response.arrayBuffer()); let data = null;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { /* Binary template response. */ }
  return { status: response.status, data, bytes, headers: response.headers, cookie: response.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ') };
}
function upload(bytes, operationId = randomUUID(), name = 'technical-validation.xlsx') {
  const form = new FormData(); form.set('operationId', operationId); form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name); return form;
}
async function workbook(inputs) {
  const book = new ExcelJS.Workbook();
  for (const input of inputs) { const sheet = book.addWorksheet(input.name); sheet.addRow(input.headers ?? ['店铺', '渠道', '国家', '目的FC', 'FBA货件号', '参考数量', '业务日期', '子批次名称', '备注']); for (const row of input.rows ?? []) sheet.addRow(row); }
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function settle(importId) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const response = await request('/imports/' + importId); assert.equal(response.status, 200);
    const record = sourceImportSchema.parse(response.data.import);
    if (!['queued', 'parsing'].includes(record.status)) return record;
    await delay(250);
  }
  throw new Error('PARSE_TIMEOUT');
}
async function ownedCounts() {
  return (await pool.query(`select
    (select count(*)::int from source_import where created_by=$1) as imports,
    (select count(*)::int from import_parse_run where created_by=$1) as runs,
    (select count(*)::int from file_index where created_by=$1) as files,
    (select count(*)::int from operation_audit where actor_user_id=$1) as audit`, [actorId])).rows[0];
}

try {
  assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_automation_dev', 'Dedicated development database required');
  assert.equal(IMPORT_PARSER_VERSION, 'xlsx-preview-v2', 'Build the current contracts before execution');
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/imports/template')).status, 401);
  const email = 't29-' + runId + '@acceptance.invalid', password = randomBytes(32).toString('base64url');
  actorId = (await auth.api.createUser({ body: { email, password, name: 'T29 technical validation', role: 'admin' } })).user.id;
  const signed = await request('/auth/sign-in/email', 'POST', { email, password }); assert.equal(signed.status, 200); assert(signed.cookie); cookie = signed.cookie;
  note('current-api-worker-and-temporary-administrator-session');

  stage = 'template-download';
  const downloaded = await request('/imports/template'); assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(downloaded.headers.get('Cache-Control'), 'no-store');
  assert(downloaded.headers.get('Content-Disposition').includes(encodeURIComponent('需求导入模板.xlsx')));
  const template = new ExcelJS.Workbook(); await template.xlsx.load(downloaded.bytes);
  assert(template.getWorksheet('在线需求导入')); assert.equal(template.getWorksheet('在线需求导入').getCell('K1').value, '货件创建时间');
  note('authorized-download-returns-compatible-metadata-template', { worksheets: template.worksheets.length });

  stage = 'invalid-admission';
  const before = await ownedCounts();
  for (const [bytes, code] of [[downloaded.bytes, 'EMPTY_WORKSHEET'], [await workbook([{ name: '不支持的表格', headers: ['其他列'], rows: [['technical']] }]), 'UNSUPPORTED_IMPORT_HEADERS'], [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), 'INVALID_XLSX']]) {
    const response = await request('/imports', 'POST', upload(bytes)); assert.equal(response.status, 422); assert.equal(response.data.error.code, code);
  }
  assert.deepEqual(await ownedCounts(), before);
  note('empty-template-unsupported-headers-and-corrupt-archive-reject-before-source-file-audit-or-queue');

  stage = 'automatic-parse';
  const sheet = template.getWorksheet('在线需求导入');
  sheet.getRow(2).values = ['T29-' + runId, 'HY', '美国', 'TEST1', 'FBATECH' + runId.replaceAll('-', '').toUpperCase(), '0', '2026-09-01', '', 'TECHNICAL FIXTURE', 'Technical warehouse', '2026-09-02 10:30:00'];
  sheet.getRow(3).values = ['T29-' + runId, 'HY', '美国', '', 'invalid technical FBA', '', '', '', 'Intentional row error'];
  const bytes = Buffer.from(await template.xlsx.writeBuffer()), operationId = randomUUID();
  const uploaded = await request('/imports', 'POST', upload(bytes, operationId)); assert.equal(uploaded.status, 202);
  stage = 'automatic-parse-accepted-contract';
  const accepted = importAcceptedSchema.parse(uploaded.data);
  assert.equal(accepted.import.status, 'queued'); assert.equal(accepted.run.sheetName, '在线需求导入'); assert.equal(accepted.run.mappingVersion, 'online-v1'); assert.equal(accepted.run.parserVersion, 'xlsx-preview-v2'); assert(accepted.import.sheets.length >= 1);
  stage = 'automatic-parse-worker-result';
  const parsed = await settle(accepted.import.id); assert.equal(parsed.status, 'preview_ready'); assert.equal(parsed.latestRun.status, 'completed');
  const rowsResponse = await request('/imports/' + accepted.import.id + '/rows'); assert.equal(rowsResponse.status, 200);
  stage = 'automatic-parse-rows-contract';
  const rows = importRowsResponseSchema.parse(rowsResponse.data); assert.equal(rows.total, 2); assert.equal(rows.items.filter((row) => row.status === 'error').length, 1);
  const good = rows.items.find((row) => row.rowNumber === 2); assert.equal(good.normalized.referenceQuantity, '0'); assert.equal(good.normalized.destinationAddress, 'Technical warehouse'); assert.equal(good.normalized.shipmentCreatedAt, '2026-09-02 10:30:00'); assert.equal(good.normalized.sourceFilledAt, '2026-09-01');
  note('validated-upload-automatically-parses-with-metadata-and-preserves-row-errors', { rows: rows.total, rowErrors: 1 });

  stage = 'idempotent-retries';
  const replay = await request('/imports', 'POST', upload(bytes, operationId)); assert.equal(replay.status, 202);
  const sameOperation = importAcceptedSchema.parse(replay.data); assert(sameOperation.replayed); assert.equal(sameOperation.import.id, accepted.import.id); assert.equal(sameOperation.run.id, accepted.run.id);
  const duplicate = await request('/imports', 'POST', upload(bytes)); assert.equal(duplicate.status, 202);
  const sameContent = importAcceptedSchema.parse(duplicate.data); assert(sameContent.deduplicated); assert.equal(sameContent.import.id, accepted.import.id);
  assert.equal((await ownedCounts()).runs, 1);
  note('same-operation-and-same-file-retries-preserve-one-source-and-one-parse-run');

  stage = 'manual-ambiguity-recovery';
  const ambiguousBytes = await workbook([{ name: '需求导入', rows: [['T29-' + runId, 'HY', '美国', '', 'FBATECHAMBIGUOUSA']] }, { name: '另一需求页', rows: [['T29-' + runId, 'HY', '美国', '', 'FBATECHAMBIGUOUSB']] }]);
  const ambiguousResponse = await request('/imports', 'POST', upload(ambiguousBytes)); assert.equal(ambiguousResponse.status, 202);
  const ambiguous = importAcceptedSchema.parse(ambiguousResponse.data); assert.equal(ambiguous.import.status, 'awaiting_mapping'); assert.equal(ambiguous.run.status, 'completed'); assert.equal(ambiguous.run.sheetName, null);
  const queued = await pool.query('select count(*)::int as count from pgboss.job where name=$1 and data->>\'runId\'=$2', ['import-parse', ambiguous.run.id]); assert.equal(queued.rows[0].count, 0);
  const mismatch = await request('/imports/' + ambiguous.import.id + '/parse', 'POST', { operationId: randomUUID(), expectedVersion: 1, sheetName: '另一需求页', mappingVersion: 'online-v1' });
  assert.equal(mismatch.status, 422); assert.equal(mismatch.data.error.code, 'SOURCE_MAPPING_REQUIRED');
  const chosen = await request('/imports/' + ambiguous.import.id + '/parse', 'POST', { operationId: randomUUID(), expectedVersion: 1, sheetName: '另一需求页', mappingVersion: 'manual-v1' }); assert.equal(chosen.status, 202);
  const manual = await settle(ambiguous.import.id); assert.equal(manual.status, 'preview_ready'); assert.equal(manual.latestRun.sheetName, '另一需求页'); assert.equal(manual.version, 2);
  note('multiple-valid-sheets-require-choice-and-explicit-mapping-recovery-queues-only-reviewed-sheet');

  stage = 'no-auto-commit';
  const business = (await pool.query(`select
    (select count(*)::int from demand_source where created_by=$1) as sources,
    (select count(*)::int from demand_revision where created_by=$1) as demands,
    (select count(*)::int from sub_batch where created_by=$1) as groups,
    (select count(*)::int from shipment_revision where created_by=$1) as shipments`, [actorId])).rows[0];
  assert(Object.values(business).every((value) => value === 0));
  note('validation-and-parsing-create-no-business-demands-groups-or-shipment-candidates');
} catch (error) {
  failed = true; checks.push({ name: stage, result: 'failed', code: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'INTEGRATION_FAILED' });
  const diagnostic = error instanceof assert.AssertionError ? error.message : error?.name === 'ZodError' ? JSON.stringify(error.issues.map((issue) => ({ path: issue.path, code: issue.code, expected: issue.expected }))) : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : error?.name ?? 'INTEGRATION_FAILED';
  console.error('FAIL ' + stage + ': ' + diagnostic);
} finally {
  if (actorId) {
    try {
      const deadline = Date.now() + 30000;
      while ((await pool.query('select count(*)::int as count from pgboss.job where name=$1 and data->>\'runId\' in (select id::text from import_parse_run where created_by=$2) and state in (\'active\',\'created\',\'retry\')', ['import-parse', actorId])).rows[0].count > 0) {
        if (Date.now() >= deadline) throw new Error('TECHNICAL_QUEUE_STILL_ACTIVE'); await delay(250);
      }
      assert.equal((await pool.query('select count(*)::int as count from demand_source where created_by=$1', [actorId])).rows[0].count, 0);
      const files = (await pool.query('select storage_key from file_index where created_by=$1', [actorId])).rows;
      const targets = files.map((file) => { const target = resolve(config.dataDir, file.storage_key), suffix = relative(resolve(config.dataDir), target); assert(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Safe owned fixture file path'); return target; });
      const tx = await pool.connect();
      try {
        await tx.query('begin');
        await tx.query('delete from pgboss.job where name=$1 and data->>\'runId\' in (select id::text from import_parse_run where created_by=$2)', ['import-parse', actorId]);
        await tx.query('delete from import_operation where actor_user_id=$1', [actorId]);
        await tx.query('delete from source_import_row where parse_run_id in (select id from import_parse_run where created_by=$1)', [actorId]);
        await tx.query('update source_import set latest_run_id=null where created_by=$1', [actorId]);
        await tx.query('delete from import_parse_run where created_by=$1', [actorId]);
        await tx.query('delete from operation_audit where actor_user_id=$1', [actorId]);
        await tx.query('delete from source_import where created_by=$1', [actorId]);
        await tx.query('delete from file_index where created_by=$1', [actorId]);
        await tx.query('update "user" set banned=true,ban_reason=$2 where id=$1', [actorId, 'T29 import validation technical verification completed']);
        await tx.query('delete from session where user_id=$1', [actorId]); await tx.query('delete from account where user_id=$1', [actorId]);
        await tx.query('commit');
      } catch (error) { await tx.query('rollback'); throw error; } finally { tx.release(); }
      for (const target of targets) await unlink(target).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      assert.equal((await ownedCounts()).imports, 0); cleaned = true;
    } catch { failed = true; checks.push({ name: 'technical-fixture-cleanup', result: 'failed', code: 'CLEANUP_FAILED' }); }
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ kind: 'real-api-worker-import-validation', result: failed ? 'failed' : 'passed', runId, checks, technicalFixturesRemoved: cleaned, externalRequests: 0, completedAt: new Date().toISOString() }, null, 2) + '\n');
  await closeDatabase(); console.log(JSON.stringify({ result: failed ? 'failed' : 'passed', checks: checks.filter((entry) => entry.result === 'passed').length, technicalFixturesRemoved: cleaned, externalRequests: 0 }));
  if (failed) process.exitCode = 1;
}
