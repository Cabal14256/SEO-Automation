import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(serverRoot, 'package.json'));
const suppliedBaseURL = process.env.IMPORT_BASE_URL;
Object.assign(process.env, requireServer('dotenv').parse(await readFile(resolve(serverRoot, '.env'))));
if (suppliedBaseURL) process.env.IMPORT_BASE_URL = suppliedBaseURL;
const { createConfirmationHarness, digest } = await import(pathToFileURL(resolve(serverRoot, 'dist/import-confirmation-acceptance.js')));
const { closeDatabase, pool } = await import(pathToFileURL(resolve(serverRoot, 'dist/db/client.js')));
const { readConfig } = await import(pathToFileURL(resolve(serverRoot, 'dist/config.js')));
const { demandWorkspaceSchema, importAcceptedSchema, importRowsResponseSchema } = await import(pathToFileURL(resolve(root, 'packages/contracts/dist/index.js')));
const ExcelJS = requireServer('exceljs');
const reportArgument = process.argv.indexOf('--report');
const reportPath = resolve(root, reportArgument >= 0 ? process.argv[reportArgument + 1] : '.local/t24/import-workspace-integration.json');
const checks = [];
let stage = 'setup'; let failed = false; let cleaned = false;
const h = await createConfirmationHarness();
const record = (name, details = {}) => { checks.push({ name, result: 'passed', ...details }); console.log(`PASS ${name}`); };
async function api(path, body, expected = 200) {
  const result = await h.request(path, undefined, body === undefined ? 'GET' : 'POST', body);
  assert.equal(result.status, expected, `${path}: ${JSON.stringify(result.data?.error ?? result.data)}`);
  return result.data;
}
async function workspace(search) {
  const result = await api(`/demands?${new URLSearchParams(search)}`);
  return demandWorkspaceSchema.parse(result);
}

try {
  await h.setup();
  const seller = await h.seller();
  const suffix = h.runId.replaceAll('-', '').slice(0, 16).toUpperCase();
  const rows = [0, 1, 2].map((index) => ({
    fba: `FBA${suffix}${index}`, shop: seller.name, country: seller.country, channel: 'T24-ONLINE', destinationFc: 'IND9',
    destinationAddress: `TECHNICAL FIXTURE destination ${index}`, shipmentCreatedAt: '2026-09-01', sourceFilledAt: '2026-09-02',
    referenceQuantity: index === 1 ? '0' : '10', notes: index === 2 ? '=1+1' : 'T24 TECHNICAL FIXTURE',
  }));
  const input = { operationId: randomUUID(), rows };

  stage = 'online-submit-worker-parse';
  const accepted = importAcceptedSchema.parse(await api('/imports/online', input, 202));
  assert.equal(accepted.import.sourceType, 'online');
  const source = await h.settle(accepted.import.id);
  assert.equal(source.status, 'preview_ready'); assert.equal(source.latestRun.status, 'completed');
  assert.equal(source.latestRun.mappingVersion, 'online-v1'); assert.equal(source.latestRun.counts.totalRows, 3);
  const parsed = importRowsResponseSchema.parse(await api(`/imports/${source.id}/rows?pageSize=100`));
  assert.equal(parsed.items.length, 3);
  assert(parsed.items.every((row) => row.normalized.metadataSource === 'online'));
  assert(parsed.items.every((row) => row.normalized.sourceFilledAt === '2026-09-02'));
  assert.equal(parsed.items[2].normalized.notes, '=1+1');
  record(stage, { sourceType: source.sourceType, parsedRows: parsed.items.length, mappingVersion: source.latestRun.mappingVersion });

  stage = 'online-operation-replay-and-conflict';
  const replay = importAcceptedSchema.parse(await api('/imports/online', input, 202));
  assert.equal(replay.replayed, true); assert.equal(replay.import.id, source.id); assert.equal(replay.taskId, accepted.taskId);
  const conflict = await h.request('/imports/online', undefined, 'POST', { ...input, rows: [{ ...rows[0], notes: 'different content' }, ...rows.slice(1)] });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error.code, 'OPERATION_CONFLICT');
  record(stage);

  stage = 'immutable-online-snapshot-download';
  const download = await fetch(`${h.baseURL}/api/v1/files/${source.fileId}/download`, {
    headers: { Cookie: h.users.get('admin').cookie, Origin: readConfig().WEB_ORIGIN }, signal: AbortSignal.timeout(30_000),
  });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
  const downloadedBytes = Buffer.from(await download.arrayBuffer()); assert.equal(digest(downloadedBytes), source.sha256);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(downloadedBytes);
  const sheet = workbook.getWorksheet('在线需求导入'); assert(sheet);
  assert.equal(sheet.getCell('E2').value, rows[0].fba);
  assert.equal(sheet.getCell('J2').value, rows[0].destinationAddress);
  assert.equal(sheet.getCell('I4').value, '=1+1', 'Pasted formula-like text remains a literal source cell');
  assert.equal(typeof sheet.getCell('I4').value, 'string');
  record(stage, { bytes: downloadedBytes.length, hashVerified: true, literalSourceText: true });

  stage = 'explicit-confirmation-and-submit';
  const preview = await h.preview(source);
  assert.equal(preview.preview.counts.new, 3);
  const committed = await h.commit(source, preview);
  assert.equal(committed.status, 200); assert.equal(committed.result.counts.created, 3);
  const context = await h.context(source.id); assert.equal(context.status, 'submitted'); assert.equal(context.submittedSourceRows, 3);
  const committedIds = new Set(committed.result.items.map((item) => item.demandId));
  record(stage, { demandsCreated: committed.result.counts.created, submittedRows: context.submittedSourceRows });

  stage = 'workspace-placeholder-metadata-and-sources';
  const all = await workspace({ sid: String(seller.sid) });
  assert.equal(all.total, 3); assert.equal(all.demandTotal, 3); assert.equal(all.maxBoxes, 10); assert.equal(all.pageSize, 50);
  assert.deepEqual(new Set(all.rows.map((row) => row.demandId)), committedIds);
  for (const row of all.rows) {
    assert.equal(row.rowKind, 'placeholder'); assert.equal(row.status, 'unsynced'); assert.equal(row.groupId, null);
    assert.equal(row.quantity, null); assert.equal(row.totalBoxes, null); assert.equal(row.dataVersion, null); assert.equal(row.confirmationId, null);
    assert.equal(row.metadataSource, 'online'); assert.equal(row.sourceFilledAt, '2026-09-02'); assert.equal(row.shipmentCreatedAt, '2026-09-01');
    assert(row.destinationAddress.startsWith('TECHNICAL FIXTURE destination'));
    assert(row.sources.some((origin) => origin.importId === source.id && origin.fileName === '在线填写快照.xlsx' && origin.sheetName === '在线需求导入' && origin.rowNumber >= 2));
  }
  assert.equal(all.rows.find((row) => row.fba === rows[1].fba).referenceQuantity, '0');
  record(stage, { total: all.total, demandTotal: all.demandTotal, maxBoxes: all.maxBoxes, metadataSource: 'online' });

  stage = 'workspace-filters-and-stable-pagination';
  const common = { sid: String(seller.sid), month: source.businessDate.slice(0, 7), channel: 'T24-ONLINE', country: seller.country, status: 'unsynced' };
  const first = await workspace({ ...common, pageSize: '1' }); const again = await workspace({ ...common, pageSize: '1' });
  const second = await workspace({ ...common, page: '2', pageSize: '1' });
  assert.equal(first.total, 3); assert.equal(first.demandTotal, 3); assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].id, again.rows[0].id); assert.notEqual(first.rows[0].id, second.rows[0].id);
  assert.equal((await workspace({ ...common, q: rows[2].fba.toLowerCase() })).total, 1);
  assert.equal((await workspace({ ...common, status: 'confirmed' })).total, 0);
  assert.equal((await workspace({ ...common, batchId: randomUUID() })).total, 0);
  assert.equal((await workspace({ ...common, month: '2000-01' })).total, 0);
  assert.equal((await h.request('/demands?month=2026-13')).status, 422);
  record(stage, { total: first.total, stablePage: true, testedFilters: ['month', 'batchId', 'sid', 'country', 'channel', 'status', 'q'] });

  stage = 'equal-content-new-operation-no-duplicate-demand';
  const repeated = importAcceptedSchema.parse(await api('/imports/online', { ...input, operationId: randomUUID() }, 202));
  assert.equal(repeated.deduplicated, true); assert.equal(repeated.import.id, source.id);
  const repeatedSource = await h.settle(repeated.import.id); const repeatedPreview = await h.preview(repeatedSource);
  assert.equal(repeatedPreview.preview.counts.new, 0); assert.equal(repeatedPreview.preview.selectableItemIds.length, 0);
  const dbCount = await pool.query('select count(*)::int as count from demand where sid=$1', [seller.sid]);
  assert.equal(dbCount.rows[0].count, 3); assert.equal((await workspace({ sid: String(seller.sid) })).demandTotal, 3);
  const history = await api('/imports?pageSize=100');
  const historySource = history.items.find((item) => item.id === source.id); assert(historySource);
  assert.equal(historySource.sourceType, 'online'); assert.equal(historySource.submissionStatus, 'submitted');
  record(stage, { deduplicated: repeated.deduplicated, demandsRemain: dbCount.rows[0].count });

  stage = 'source-and-real-mapping-preservation';
  await h.unchangedOriginalAndMappings(); record(stage);
} catch (error) {
  failed = true; checks.push({ name: stage, result: 'failed', message: error.message }); console.error(`FAIL ${stage}: ${error.stack ?? error}`);
} finally {
  try { await h.cleanup(); cleaned = true; } catch (error) { failed = true; checks.push({ name: 'cleanup', result: 'failed', message: error.message }); console.error(`Cleanup failed: ${error.stack ?? error}`); }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ runId: h.runId, passed: !failed, cleaned, checks, externalLookupRequests: 0, evidence: 'Generated and labelled technical online rows; real API, Worker, database, source download and confirmation flow.' }, null, 2)}\n`);
  await closeDatabase();
}
if (failed) process.exitCode = 1;
