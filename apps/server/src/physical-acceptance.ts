import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgBoss } from 'pg-boss';
import ExcelJS from 'exceljs';
import { PHYSICAL_RULE_VERSION, type DemandSnapshot, type PhysicalReview, type ShipmentData } from '@scm/contracts';
import { db, pool, closeDatabase } from './db/client.js';
import { readConfig } from './config.js';
import { createApp } from './app.js';
import { auth } from './auth.js';
import { allocateCodes, confirmGroup, correctGroup, createSubBatch, createWeeklyBatch, getConfirmedGroup, getSubBatchDetail, getWeeklyBatch, publishCandidate, setActualShipDate } from './modules/batches/service.js';
import { createReportWorkbook } from './modules/batches/workbook.js';
import { getShipmentReport } from './modules/batches/report-service.js';
import { executePhysicalSync, PHYSICAL_SYNC_QUEUE } from './modules/physical/sync.js';
import { LingxingReadClient } from './modules/lingxing/read-client.js';
import { physicalReference, executePhysicalExport, PHYSICAL_EXPORT_QUEUE, registerPhysicalExportWorker } from './modules/physical/exports.js';
import { createPhysicalWorkbook } from './modules/physical/workbook.js';
import { checkedFileBytes } from './modules/imports/service.js';
import { readPhysicalExportFile } from './modules/physical/exports.js';
import { saveBusinessFile } from './files.js';

const config = readConfig(); assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_m3_acceptance', 'Use scripts/m3/verify.mjs isolated database');
const checks: string[] = [], queue = new PgBoss({ connectionString: config.DATABASE_URL });
const actorId = 'm3-technical-admin', sid = 1900000001, now = '2026-10-18T00:00:00.000Z';
let cookie = '', failed = false;
let stopExportWorker: (() => void) | undefined;
const app = createApp(() => queue);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External transport is forbidden in isolated M3 acceptance'); };
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function api(path: string, body?: unknown, expected = 200, session = cookie) {
  const response = await app.request(`/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.WEB_ORIGIN, ...(session ? { Cookie: session } : {}), ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
  const data = await response.json() as Record<string, unknown>;
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); return data;
}
async function binary(path: string) {
  const response = await app.request(`/api/v1${path}`, { headers: { Cookie: cookie } }); assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`); return Buffer.from(await response.arrayBuffer());
}
const path = (id: string) => `/sub-batches/${id}/physical-review`;
async function review(id: string) { return await api(path(id)) as unknown as PhysicalReview; }
const write = (r: PhysicalReview) => ({ operationId: randomUUID(), m2ConfirmationId: r.m2ConfirmationId!, expectedVersion: r.version, sourceFingerprint: r.source?.fingerprint ?? null });
const m2input = (expectedVersion: number) => ({ operationId: randomUUID(), expectedVersion, reason: 'ISOLATED M3 TECHNICAL FIXTURE' });
const datasets = new Map<string, ShipmentData>(); let changedWeight = false, failSecond = false;
function remote(operation: string, fba: string) {
  const data = [...datasets.values()].find((d) => d.fba === fba)!;
  if (failSecond && fba.endsWith('2')) throw new Error('Simulated partial transport failure');
  if (operation === 'list') return { code: 0, total: 1, data: { list: [{ sid, shipment_id: fba, sta_shipment_id: `STA-${fba}`, is_sta: 1, reference_id: `PO-${fba}`,
    item_list: data.items.map((p) => ({ ...p, productName: p.name, quantity_shipped: p.quantity })) }] } };
  if (operation === 'detail') return { code: 0, data: { shipmentList: [{ sid, shipmentConfirmationId: fba, shipmentId: `STA-${fba}`, amazonReferenceId: `PO-${fba}`, itemList: data.items.map((p) => ({ ...p, productName: p.name })) }] } };
  return { code: 0, data: { shipmentList: [{ shipmentId: `STA-${fba}`, shipmentPackingList: data.boxes.map((b) => ({ boxId: b.externalBoxId, localBoxId: b.localBoxId, boxName: b.name,
    weight: changedWeight && fba.endsWith('1') ? '11.005' : '10', weightUnit: 'LB', length: '10.005', width: '5', height: '4', lengthUnit: 'IN', total: b.items.reduce((s, p) => s + Number(p.quantity), 0), productList: b.items.map((p) => ({ ...p, quantityInBox: p.quantity })) })) }] } };
}
const dependencies = { createClient: async (dependencies: ConstructorParameters<typeof LingxingReadClient>[1]) => new LingxingReadClient({ appId: '1234567890123456', accessToken: 'isolated-fixture-token' }, { ...dependencies,
  fetchImpl: async (input, init) => {
    const url = new URL(String(input)), body = JSON.parse(String(init?.body)) as Record<string, unknown>, fba = String(body.shipment_id ?? body.shipmentConfirmationId);
    const operation = url.pathname.endsWith('shipmentList') ? 'list' : url.pathname.endsWith('shipmentDetailList') ? 'detail' : 'boxes';
    return Response.json(remote(operation, fba));
  } }) };
async function seed(index: number, boxCount = 1) {
  const id = randomUUID(), fba = `FBAM3ISOLATED${index}`;
  const snapshot: DemandSnapshot = { sid, fba, shop: 'M3技术店铺', country: '美国', channel: '技术渠道', destinationFc: 'TECH', referenceQuantity: null, notes: 'ISOLATED FIXTURE', subBatchName: null };
  await pool.query('insert into demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) values($1,$2,$3,$4,1,\'2000-01-03\',\'2000-01-03\',\'2000-01-09\')', [id, sid, fba, snapshot]);
  await pool.query('insert into demand_revision(id,demand_id,version,snapshot,created_by) values($1,$2,1,$3,$4)', [randomUUID(), id, snapshot, actorId]);
  const data: ShipmentData = { sid, fba, observedAt: now, issues: [], items: [{ msku: 'M', fnsku: 'F', sku: 'S', name: '技术商品', quantity: String(boxCount * 3) }],
    boxes: Array.from({ length: boxCount }, (_, n) => ({ id: randomUUID(), externalBoxId: `${fba}-BOX-${n}`, packageId: null, localBoxId: String(n + 1), name: `箱${n + 1}`, order: n + 1, items: [{ msku: 'M', fnsku: 'F', sku: 'S', quantity: '3' }] })) };
  datasets.set(id, data); return id;
}
async function makeGroup(batchId: string, ids: string[], historical = false) {
  const batch = await getWeeklyBatch(batchId, actorId);
  const id = (await createSubBatch(batchId, { ...m2input(batch.batch.version), name: 'M3隔离技术组', demandIds: ids, expectedDemandVersions: Object.fromEntries(ids.map((id) => [id, 1])) }, actorId)).groupId!;
  for (const demandId of ids) {
    const snapshotIds: string[] = [], data = datasets.get(demandId)!;
    if (historical) {
      const runId = randomUUID(), itemId = randomUUID();
      await pool.query("insert into batch_sync_run(id,sub_batch_id,group_version,operation_id,request_hash,status,start_date,end_date,request_budget,requests_used,created_by) values($1,$2,1,$3,'fixture','completed','2026-01-01','2026-10-19',3,3,$4)", [runId, id, randomUUID(), actorId]);
      await pool.query("insert into batch_sync_item(id,run_id,demand_id,demand_version,sid,fba,status) values($1,$2,$3,1,$4,$5,'completed')", [itemId, runId, demandId, sid, data.fba]);
      for (const [operation, kind] of [['listShipments', 'list'], ['getShipmentDetails', 'detail'], ['getShipmentBoxes', 'boxes']]) {
        const snapshotId = randomUUID(), params = operation === 'listShipments' ? { sid: String(sid), shipment_id: data.fba, offset: 0, length: 100, start_date: '2026-01-01', end_date: '2026-10-19' } : { sid, shipmentConfirmationId: data.fba };
        const bytes = Buffer.from(JSON.stringify({ request: { operation, params }, payload: remote(kind!, data.fba), metadata: { operation, readOnly: true, businessCode: '0', httpStatus: 200, requestedAt: now } }));
        const file = await saveBusinessFile({ bytes, originalName: `${operation}.json`, mimeType: 'application/json', createdBy: actorId });
        await pool.query('insert into batch_sync_snapshot(id,run_id,item_id,operation,page,attempt,file_id,successful) values($1,$2,$3,$4,0,1,$5,1)', [snapshotId, runId, itemId, operation, file.id]); snapshotIds.push(snapshotId);
      }
    }
    await publishCandidate({ demandId, subBatchId: id, expectedGroupVersion: 1, expectedDemandVersion: 1, actorId, data, source: historical ? 'lingxing' : 'manual', snapshotIds, reason: 'ISOLATED FIXTURE' });
  }
  const detail = await getSubBatchDetail(id, actorId);
  await confirmGroup(id, { ...m2input(detail.group.version), expectedDemandVersions: Object.fromEntries(detail.members.map((m) => [m.id, m.version])), expectedShipmentVersions: Object.fromEntries(detail.shipments.map((s) => [s.demandId, s.revision!.version])) }, actorId);
  const week = await getWeeklyBatch(batchId, actorId), current = await getSubBatchDetail(id, actorId);
  await allocateCodes(batchId, { ...m2input(week.batch.version), groupIds: [id], expectedGroupVersions: { [id]: current.group.version } }, actorId); return id;
}
async function collect(id: string) {
  const r = await review(id), response = await api(`${path(id)}/sync`, { ...write(r), startDate: '2026-01-01', endDate: '2026-10-19', requestBudget: 100, maxPages: 10 }, 202);
  const runId = (response.run as { id: string }).id; await executePhysicalSync(runId, dependencies); return review(id);
}
async function adopt(id: string) { const r = await review(id); await api(`${path(id)}/sources`, { ...write(r), sourceId: r.availableSources[0]!.id }); return review(id); }
async function checkAll(id: string) { const r = await review(id); await api(`${path(id)}/revisions`, { ...write(r), entries: r.source!.boxes.map((b) => ({ shipmentRevisionId: b.shipmentRevisionId, boxId: b.boxId, status: 'consistent', measured: {}, reason: '' })) }); return review(id); }
async function confirm(id: string) { const r = await review(id); assert(r.canConfirm); await api(`${path(id)}/confirmations`, write(r)); return review(id); }
async function exported(id: string) { const r = await review(id); const result = await api('/physical-exports', { operationId: randomUUID(), references: [physicalReference(r.confirmation!)] }, 202); return (result.export as { id: string }).id; }
async function passed(name: string) { checks.push(name); console.log(`PASS ${name}`); }
try {
  await migrate(db, { migrationsFolder: process.env.M3_OLD_MIGRATIONS! });
  await pool.query('insert into "user"(id,name,email,role) values($1,$1,\'m3@acceptance.invalid\',\'admin\')', [actorId]);
  const d1 = await seed(1, 12), d2 = await seed(2);
  const batchId = (await createWeeklyBatch({ operationId: randomUUID(), weekStartDate: '2000-01-03' }, actorId)).batchId!;
  const groupId = await makeGroup(batchId, [d1, d2]);
  const beforeM2 = digest((await pool.query('select row_to_json(t) as row from sub_batch t order by id')).rows);
  await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  assert.equal(digest((await pool.query('select row_to_json(t) as row from sub_batch t order by id')).rows), beforeM2);
  assert.equal((await pool.query('select count(*) from physical_confirmation')).rows[0].count, '0'); await passed('incremental-migration-preserves-existing-M2-and-does-not-backfill-M3');
  await queue.start();
  await queue.createQueue(PHYSICAL_SYNC_QUEUE, { retryLimit: 0, expireInSeconds: 7200, deleteAfterSeconds: 0 });
  await queue.createQueue(PHYSICAL_EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 180, deleteAfterSeconds: 0 });
  const password = 'Isolated-M3-fixture-password-2026';
  const user = await auth.api.createUser({ body: { email: 'm3-login@acceptance.invalid', password, name: '隔离测试管理员', role: 'admin' } });
  const login = await app.request('/api/v1/auth/sign-in/email', { method: 'POST', headers: { Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.user.email, password }) });
  assert.equal(login.status, 200); cookie = login.headers.getSetCookie().map((part) => part.split(';')[0]).join('; '); assert(cookie);
  await api(path(groupId), undefined, 401, '');
  const initial = await review(groupId); assert(!initial.valid && !initial.canExport); await passed('real-auth-and-history-start-unconfirmed');
  const m2BeforeSync = await getConfirmedGroup(groupId, actorId), revisionsBefore = (await pool.query('select count(*) from shipment_revision')).rows[0].count;
  process.env.LINGXING_REQUESTS_ENABLED = 'true';
  let r = await review(groupId);
  const limited = await api(`${path(groupId)}/sync`, { ...write(r), startDate: '2026-01-01', endDate: '2026-10-19', requestBudget: 2, maxPages: 10 }, 202);
  const limitedId = (limited.run as { id: string }).id;
  assert.equal((await queue.findJobs(PHYSICAL_SYNC_QUEUE, { data: { runId: limitedId } })).length, 1);
  await executePhysicalSync(limitedId, dependencies);
  const exhausted = await api(`${path(groupId)}/sync/${limitedId}`); assert.equal((exhausted.run as { requestsUsed: number }).requestsUsed, 2);
  assert(['failed', 'partial'].includes((exhausted.run as { status: string }).status));
  const retryInput = { operationId: randomUUID(), additionalRequestBudget: 4 };
  await api(`${path(groupId)}/sync/${limitedId}/retry`, retryInput, 202); await api(`${path(groupId)}/sync/${limitedId}/retry`, retryInput, 202);
  await executePhysicalSync(limitedId, dependencies);
  const recovered = await api(`${path(groupId)}/sync/${limitedId}`); assert.equal((recovered.run as { status: string }).status, 'completed'); assert.equal((recovered.run as { requestsUsed: number }).requestsUsed, 6); assert((recovered.run as { cacheHits: number }).cacheHits >= 2);
  await passed('persistent-queue-budget-exhaustion-idempotent-retry-and-successful-checkpoint-reuse');
  r = await review(groupId); assert.equal(r.availableSources[0]!.boxes.length, 13); assert(r.availableSources[0]!.identityValid);
  assert.equal((await pool.query('select count(*) from shipment_revision')).rows[0].count, revisionsBefore); assert.equal((await getConfirmedGroup(groupId, actorId)).confirmation.id, m2BeforeSync.confirmation.id);
  r = await adopt(groupId); assert.equal(r.source!.boxes[0]!.values.weight, '4.54'); assert.equal(r.source!.boxes[0]!.range, 'FBAM3ISOLATED1000001-12'); await passed('independent-read-only-sync-preserves-M2-and-converts-13-boxes');
  const saveInput = { ...write(r), entries: r.source!.boxes.map((b) => ({ shipmentRevisionId: b.shipmentRevisionId, boxId: b.boxId, status: 'consistent', measured: {}, reason: '' })) };
  await api(`${path(groupId)}/revisions`, saveInput); const replay = await api(`${path(groupId)}/revisions`, saveInput); assert.equal(replay.replayed, true);
  await api(`${path(groupId)}/revisions`, { ...saveInput, entries: [] }, 409); await api(`${path(groupId)}/confirmations`, write(r), 409);
  r = await review(groupId); assert(r.canConfirm); r = await confirm(groupId); assert(r.valid && r.canExport); await passed('saved-draft-full-confirmation-operation-replay-and-stale-write-conflict');
  const confirmedVersion = r.version; r = await collect(groupId); assert(r.valid); assert.equal(r.version, confirmedVersion); assert(!r.pendingChange); await passed('equal-recollection-preserves-confirmation-and-progress');
  const exportId = await exported(groupId), m2Version = (await getConfirmedGroup(groupId, actorId)).group.version;
  await Promise.all([executePhysicalExport(exportId), executePhysicalExport(exportId)]);
  const completed = await api(`/physical-exports/${exportId}`); const fileId = (completed.export as { fileId: string; status: string }).fileId; assert(fileId); assert.equal((completed.export as { status: string }).status, 'completed');
  assert.equal((await getConfirmedGroup(groupId, actorId)).group.version, m2Version); assert((await review(groupId)).valid);
  const bytes = await binary(`/files/${fileId}/download`), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  assert.deepEqual(book.worksheets.map((s) => s.name), ['实物箱明细', '箱内商品', '版本与核对记录']); assert.equal(book.worksheets[0]!.rowCount, 14); assert.equal(book.worksheets[0]!.getCell(2, 9).numFmt, '0.00');
  assert.equal((await getSubBatchDetail(groupId, actorId)).group.status, 'frozen'); await passed('concurrent-export-publishes-one-file-freezes-without-changing-M2-version');
  const dateDetail = await getSubBatchDetail(groupId, actorId); await setActualShipDate(groupId, { ...m2input(dateDetail.group.version), actualShipDate: '2000-01-04' }, actorId); assert((await review(groupId)).valid); await passed('actual-ship-date-does-not-expire-independent-M3');
  r = await review(groupId); const entries = structuredClone(r.revision!.entries); entries[0] = { ...entries[0]!, status: 'different', measured: { weight: '5.00' }, reason: '隔离实测差异' };
  await api(`${path(groupId)}/revisions`, { ...write(r), entries }); r = await review(groupId); assert(!r.valid); assert(r.revision!.entries.every((e) => e.status === 'pending'));
  await passed('post-confirmation-edit-preserves-history-and-requires-whole-group-recheck');
  const template = await binary(`${path(groupId)}/template.xlsx`), intakeBook = new ExcelJS.Workbook(); await intakeBook.xlsx.load(template as unknown as Parameters<typeof intakeBook.xlsx.load>[0]);
  const intakeSheet = intakeBook.getWorksheet('逐箱核对')!; for (let row = 2; row <= intakeSheet.rowCount; row++) { intakeSheet.getCell(row, 22).value = row === 2 ? '有差异' : '一致'; }
  const upload = Buffer.from(await intakeBook.xlsx.writeBuffer());
  const intake = (phase: string, data: Buffer, writeInput: ReturnType<typeof write>, preview?: Record<string, unknown>) => { const form = new FormData(); form.set('file', new File([new Uint8Array(data)], 'physical.xlsx')); form.set('phase', phase); for (const [k, v] of Object.entries(writeInput)) form.set(k, v === null ? '' : String(v)); if (preview) { form.set('previewId', String(preview.previewId)); form.set('sha256', String(preview.sha256)); } return form; };
  const previewWrite = write(r); const preview = await api(`${path(groupId)}/intake`, intake('preview', upload, previewWrite));
  const duplicatePreview = await api(`${path(groupId)}/intake`, intake('preview', upload, previewWrite)); assert.equal(duplicatePreview.previewId, preview.previewId);
  const importWrite = write(r);
  assert.equal(preview.boxCount, 13); const commit = intake('commit', upload, importWrite, preview); await api(`${path(groupId)}/intake`, commit); assert.equal((await api(`${path(groupId)}/intake`, commit)).replayed, true);
  r = await review(groupId); assert(r.canConfirm); r = await confirm(groupId); await passed('template-preview-commit-replay-and-only-difference-fields');
  const oldVersion = r.version; changedWeight = true; failSecond = true;
  const partial = await collect(groupId); assert(partial.pendingChange); assert(!partial.canExport); assert.equal(partial.version, oldVersion);
  const acceptedOld = partial.source!; await api(`${path(groupId)}/sources`, { ...write(partial), sourceId: acceptedOld.id }, 409); await passed('partial-sync-detected-change-blocks-export-and-cannot-re-adopt-old-source');
  failSecond = false; r = await collect(groupId); assert(r.pendingChange); r = await adopt(groupId); assert(r.revision!.entries.every((e) => e.status === 'pending')); assert(!r.valid); await passed('explicit-new-source-adoption-clears-all-review-marks');
  await checkAll(groupId); await confirm(groupId);
  const staleId = await exported(groupId);
  await assert.rejects(() => executePhysicalExport(staleId, { createWorkbook: async (projection) => { const current = await review(groupId); const modified = structuredClone(current.revision!.entries); modified[0] = { ...modified[0]!, status: 'different', measured: { length: '30.00' }, reason: '导出过程中修订' }; await api(`${path(groupId)}/revisions`, { ...write(current), entries: modified }); return createPhysicalWorkbook(projection); } }));
  assert.equal((await api(`/physical-exports/${staleId}`)).export && ((await api(`/physical-exports/${staleId}`)).export as { status: string }).status, 'stale');
  const historical = await readPhysicalExportFile(fileId, actorId); assert.equal(digest(await checkedFileBytes(historical.file)), digest(bytes)); await passed('mid-generation-version-change-stales-task-and-history-download-remains-immutable');
  const m2Report = await getShipmentReport(actorId, { subBatchId: groupId }); assert.equal(m2Report.boxes.length, 13); assert((await createReportWorkbook(m2Report, { exportId: randomUUID(), month: null })).length > 0); await passed('M2-report-remains-exportable-when-M3-is-incomplete');
  await checkAll(groupId); await confirm(groupId);
  stopExportWorker = await registerPhysicalExportWorker(queue);
  const workerExportId = await exported(groupId);
  const deadline = Date.now() + 20000;
  let workerResult: { status: string; fileId: string | null } | undefined;
  while (Date.now() < deadline) {
    workerResult = (await api(`/physical-exports/${workerExportId}`)).export as { status: string; fileId: string | null };
    if (workerResult.status === 'completed') break;
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.equal(workerResult?.status, 'completed'); assert(workerResult.fileId); await passed('registered-pg-boss-worker-publishes-durable-export-task');
  const historicalDemand = await seed(3), historicalGroup = await makeGroup(batchId, [historicalDemand], true);
  const evidenceFile = (await pool.query('select f.storage_key from file_index f join batch_sync_snapshot s on s.file_id=f.id join batch_sync_run r on r.id=s.run_id where r.sub_batch_id=$1 limit 1', [historicalGroup])).rows[0]!.storage_key as string;
  const evidencePath = resolve(config.dataDir, evidenceFile), originalBytes = await readFile(evidencePath);
  await writeFile(evidencePath, 'tampered isolated fixture');
  assert(!(await review(historicalGroup)).availableSources[0]!.identityValid);
  await writeFile(evidencePath, originalBytes);
  const historicalReview = await review(historicalGroup); assert.equal(historicalReview.availableSources[0]!.origin, 'history'); assert(historicalReview.availableSources[0]!.identityValid);
  const adoptInput = { ...write(historicalReview), sourceId: historicalReview.availableSources[0]!.id };
  await api(`${path(historicalGroup)}/sources`, adoptInput); assert.equal((await api(`${path(historicalGroup)}/sources`, adoptInput)).replayed, true);
  await checkAll(historicalGroup); await confirm(historicalGroup); await passed('bound-M2-raw-history-hash-validation-adoption-and-replay');
  const beforeCandidate = await getSubBatchDetail(historicalGroup, actorId);
  await publishCandidate({ demandId: historicalDemand, subBatchId: historicalGroup, expectedGroupVersion: beforeCandidate.group.version, expectedDemandVersion: 1, actorId, data: datasets.get(historicalDemand)!, source: 'manual', reason: 'ISOLATED EQUAL M2 CANDIDATE' });
  const invalidM2 = await review(historicalGroup); assert(!invalidM2.valid && !invalidM2.canExport); assert(invalidM2.blocked.some((i) => i.code === 'CONFIRMATION_STALE'));
  await passed('unfrozen-M2-new-equal-candidate-still-invalidates-dependent-M3');
  const oldDetail = await getSubBatchDetail(groupId, actorId); await correctGroup(groupId, { ...m2input(oldDetail.group.version), reason: 'ISOLATED M3 CORRECTION' }, actorId); assert((await review(groupId)).readOnly); await api(`${path(groupId)}/confirmations`, write(await review(groupId)), 409); await passed('superseded-group-is-read-only');
  assert.equal(PHYSICAL_RULE_VERSION, 'physical-review/v1');
} catch (error) { failed = true; console.error(error); }
finally {
  globalThis.fetch = originalFetch;
  const out = resolve(process.env.M3_ACCEPTANCE_OUT!); await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ kind: 'isolated-postgresql-M3-technical-acceptance', result: failed ? 'failed' : 'passed', checks, externalBusinessRequests: 0, technicalFixturesOnly: true, businessSignoff: 'pending', generatedAt: new Date().toISOString() }, null, 2));
  stopExportWorker?.(); await queue.stop().catch(() => undefined); await closeDatabase(); if (failed) process.exitCode = 1;
}
