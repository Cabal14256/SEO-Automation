import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgBoss } from 'pg-boss';
import ExcelJS from 'exceljs';
import { applyDocumentAddress, DOCUMENT_ADDRESS_FIELDS, documentBoxFieldKey, documentLingxingPreviewSchema, type DemandSnapshot, type Document, type DocumentCandidateList, type DocumentExport, type DocumentLingxingPreview, type DocumentProfile, type DocumentTemplate, type DocumentValidation, type PhysicalReview, type PhysicalSource, type ShipmentData } from '@scm/contracts';
import { db, pool, closeDatabase } from './db/client.js';
import { fileIndex } from './db/schema.js';
import { readConfig } from './config.js';
import { createApp } from './app.js';
import { auth } from './auth.js';
import { allocateCodes, confirmGroup, correctGroup, createSubBatch, createWeeklyBatch, getConfirmedGroup, getSubBatchDetail, getWeeklyBatch, publishCandidate } from './modules/batches/service.js';
import { adoptPhysicalSource, confirmPhysicalReview, getPhysicalReview, publishPhysicalSource, savePhysicalRevision } from './modules/physical/service.js';
import { physicalSourceFingerprint } from './modules/physical/domain.js';
import { DOCUMENT_EXPORT_QUEUE, executeDocumentExport, registerDocumentExportWorker } from './modules/documents/exports.js';
import { documentDigest } from './modules/documents/domain.js';
import { documentOperation } from './modules/documents/service.js';
import { publishReportFile } from './modules/batches/report-service.js';
import { createWorkbook, DOCUMENT_HEADER_LABELS, DOCUMENT_MAIN_HEADERS, documentProductOverrideKey } from './modules/documents/workbook.js';

const config = readConfig();
assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_m4_acceptance', 'Run scripts/m4/verify.mjs against its isolated database only');
assert.equal(config.LINGXING_REQUESTS_ENABLED, false);
const checks: string[] = [], queue = new PgBoss({ connectionString: config.DATABASE_URL });
const actorId = 'm4-fixture-admin', sid = 1900000002, week = '2000-01-03', now = '2026-10-19T00:00:00.000Z';
const reason = 'ISOLATED M4 TECHNICAL FIXTURE';
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const fields = { service: '示例物流服务', recipientName: 'TECH-FC', addressLine1: 'Technical Address', city: 'Test', postalCode: '00000', countryCode: 'US', currency: 'USD', customsMode: '9810', clearanceMode: '一般贸易清关', deliveryStation: '深圳坂田仓库', taxMode: '包税', battery: '否', magnetic: '否', liquid: '否', powder: '否', dangerous: '否', remarks: reason, deliveryWindow: '2000-01-04 至 2000-01-10' };
const datasets = new Map<string, ShipmentData>();
let cookie = '', failed = false, failure: string | null = null, stopWorker: (() => void) | undefined;
const app = createApp(() => queue);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External HTTP is forbidden in isolated M4 acceptance'); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const m2input = (expectedVersion: number) => ({ operationId: randomUUID(), expectedVersion, reason });
const docInput = (document: Document) => ({ operationId: randomUUID(), expectedVersion: document.version, reason });
const pwrite = (review: PhysicalReview) => ({ operationId: randomUUID(), m2ConfirmationId: review.m2ConfirmationId!, expectedVersion: review.version, sourceFingerprint: review.source?.fingerprint ?? null });

async function request(path: string, body?: unknown, session = cookie) {
  return app.request(`/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.WEB_ORIGIN, ...(session ? { Cookie: session } : {}), ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
}
async function api<T = Record<string, unknown>>(path: string, body?: unknown, expected = 200, session = cookie): Promise<T> {
  const response = await request(path, body, session), data: unknown = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); return data as T;
}
async function binary(path: string, session = cookie, expected = 200) {
  const response = await request(path, undefined, session);
  assert.equal(response.status, expected, `${path}: ${response.status === expected ? '' : await response.clone().text()}`);
  return Buffer.from(await response.arrayBuffer());
}
async function current(id: string) { return (await api<{ document: Document }>(`/documents/${id}`)).document; }
async function validate(document: Document) { return (await api<{ validation: DocumentValidation }>(`/documents/${document.id}/validate`, docInput(document))).validation; }
function confirmedFixturePriceFields(document: Document) {
  const data = document.currentRevision.data, confirmed = { ...data.fields };
  for (const member of data.members) for (const product of member.shipment.data.items) {
    const profile = data.profileReferences.find((reference) => reference.category === 'product' && Number(reference.data.sid) === member.demand.snapshot.sid && ['msku', 'fnsku', 'sku'].every((key) => reference.data[key] === product[key as 'msku' | 'fnsku' | 'sku']));
    assert(profile, 'Explicit price confirmation must use a pinned authoritative product profile');
    const prefix = `product.${documentProductOverrideKey(member.demand.snapshot.sid, product)}.`;
    confirmed[`${prefix}unitPrice`] = String(profile.data.unitPrice); confirmed[`${prefix}currency`] = String(profile.data.currency); confirmed[`${prefix}unitPriceConfirmed`] = 'true';
  }
  return confirmed;
}
async function passed(name: string) { checks.push(name); console.log(`PASS ${name}`); }
async function seed(index: number, boxCount = 1) {
  const id = randomUUID(), fba = `FBAM4ISOLATED${index}`;
  const snapshot: DemandSnapshot = { sid, fba, shop: 'M4隔离技术店铺', country: 'US', channel: 'TECH', destinationFc: 'TECH-FC', referenceQuantity: null, notes: reason, subBatchName: null };
  await pool.query("insert into demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) values($1,$2,$3,$4,1,'2000-01-03','2000-01-03','2000-01-09')", [id, sid, fba, snapshot]);
  await pool.query('insert into demand_revision(id,demand_id,version,snapshot,created_by) values($1,$2,1,$3,$4)', [randomUUID(), id, snapshot, actorId]);
  const items = [{ msku: 'M1', fnsku: 'F1', sku: 'S1', quantity: String(boxCount * 2), name: '技术商品一' }, { msku: 'M2', fnsku: 'F2', sku: 'S2', quantity: String(boxCount * 3), name: '技术商品二' }];
  const data: ShipmentData = { sid, fba, observedAt: now, issues: [], items, boxes: Array.from({ length: boxCount }, (_, index) => ({ id: randomUUID(), externalBoxId: `${fba}-BOX-${index + 1}`, packageId: null, localBoxId: String(index + 1), name: `箱${index + 1}`, order: index + 1, items: items.map((item, i) => ({ ...item, quantity: String(i + 2) })), weight: '1.25', weightUnit: 'KG', length: '2', width: '3', height: '4', dimensionUnit: 'CM' })) };
  datasets.set(id, data); return id;
}
async function makeGroup(batchId: string, ids: string[]) {
  const batch = await getWeeklyBatch(batchId, actorId);
  const id = (await createSubBatch(batchId, { ...m2input(batch.batch.version), name: `M4技术组-${ids.length}`, demandIds: ids, expectedDemandVersions: Object.fromEntries(ids.map((id) => [id, 1])) }, actorId)).groupId!;
  for (const demandId of ids) await publishCandidate({ demandId, subBatchId: id, expectedGroupVersion: 1, expectedDemandVersion: 1, actorId, data: datasets.get(demandId)!, source: 'manual', reason });
  const detail = await getSubBatchDetail(id, actorId);
  await confirmGroup(id, { ...m2input(detail.group.version), expectedDemandVersions: Object.fromEntries(detail.members.map((member) => [member.id, member.version])), expectedShipmentVersions: Object.fromEntries(detail.shipments.map((shipment) => [shipment.demandId, shipment.revision!.version])) }, actorId);
  const currentGroup = await getSubBatchDetail(id, actorId), currentBatch = await getWeeklyBatch(batchId, actorId);
  await allocateCodes(batchId, { ...m2input(currentBatch.batch.version), groupIds: [id], expectedGroupVersions: { [id]: currentGroup.group.version } }, actorId); return id;
}
async function confirmPhysical(groupId: string, weight = '1.25') {
  const bundle = await getConfirmedGroup(groupId, actorId);
  const source: PhysicalSource = { id: randomUUID(), groupId, m2ConfirmationId: bundle.confirmation.id, origin: 'history', fingerprint: '', identityValid: true, issues: [], snapshotIds: [], createdBy: actorId, createdAt: new Date().toISOString(),
    boxes: bundle.shipments.flatMap(({ demandId, revision }) => revision.data.boxes.map((box) => ({ demandId, shipmentRevisionId: revision.id, boxId: box.id, sid, fba: revision.data.fba, order: box.order!, code: bundle.codes.find((code) => code.demandId === demandId && code.boxId === box.id && code.valid)!.code, po: `PO-${revision.data.fba}`, range: `${revision.data.fba}000001-${revision.data.boxes.length}`, raw: { weight, weightUnit: 'KG', length: '2', width: '3', height: '4', dimensionUnit: 'CM' }, values: { weight, length: '2.00', width: '3.00', height: '4.00' }, items: box.items, sourceObservedAt: now }))) };
  source.fingerprint = physicalSourceFingerprint(source);
  await db.transaction((tx) => publishPhysicalSource(tx, source));
  let review = await getPhysicalReview(groupId, actorId);
  await adoptPhysicalSource(groupId, { ...pwrite(review), sourceId: source.id }, actorId);
  review = await getPhysicalReview(groupId, actorId);
  await savePhysicalRevision(groupId, { ...pwrite(review), entries: source.boxes.map((box) => ({ shipmentRevisionId: box.shipmentRevisionId, boxId: box.boxId, status: 'consistent', measured: {}, reason: '' })) }, actorId);
  review = await getPhysicalReview(groupId, actorId); await confirmPhysicalReview(groupId, pwrite(review), actorId);
  assert((await getPhysicalReview(groupId, actorId)).valid);
}
async function templateBytes() {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('清关单');
  DOCUMENT_MAIN_HEADERS.forEach((label, index) => { sheet.getCell(17, index + 1).value = label; });
  DOCUMENT_HEADER_LABELS.forEach(([left, right], index) => { sheet.getCell(index + 1, 1).value = left; sheet.getCell(index + 1, 5).value = right; });
  sheet.mergeCells('B6:D6'); sheet.getCell('B6').value = 'OLD-PRIVATE-ADDRESS'; sheet.getCell('B1').value = 'OLD-ORDER'; sheet.getCell('A18').value = 'OLD-FBA'; sheet.getCell('Q20').value = 'OLD-SALES-LINK';
  book.addWorksheet('旧地址库').getCell('A1').value = 'OLD-PRIVATE-DATA';
  const image = book.addImage({ base64: pixel, extension: 'png' }); sheet.addImage(image, 'P20:P20');
  return Buffer.from(await book.xlsx.writeBuffer());
}
function templateForm(bytes: Buffer, operationId: string, expectedVersion?: number) { const form = new FormData(); form.set('file', new File([new Uint8Array(bytes)], 'technical-invoice-template.xlsx')); form.set('operationId', operationId); form.set('purpose', 'invoice'); form.set('name', '隔离丰信模板'); form.set('reason', reason); if (expectedVersion !== undefined) form.set('expectedVersion', String(expectedVersion)); return form; }
async function indexedStorageFiles() { return (await readdir(resolve(config.dataDir, 'files'), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => resolve(entry.parentPath, entry.name)).sort(); }
async function createDoc(ids: string[], title = '隔离发票') {
  const boxFields = Object.fromEntries(ids.flatMap((id) => datasets.get(id)!.boxes.map((box) => [documentBoxFieldKey(box.id, 'po'), `PO-${datasets.get(id)!.fba}`])));
  return api<{ document: Document; documentId: string; replayed: boolean }>('/documents', { operationId: randomUUID(), purpose: 'invoice', weekStartDate: week, demandIds: ids, title, fields: { ...fields, ...boxFields } }, 201);
}
async function revise(document: Document, extra: Record<string, unknown>) { return (await api<{ document: Document }>(`/documents/${document.id}/revisions`, { ...docInput(document), ...extra })).document; }
async function exported(document: Document) { return (await api<{ export: DocumentExport }>(`/documents/${document.id}/exports`, docInput(document), 202)).export; }
async function exportRecord(id: string) { return (await api<{ export: DocumentExport }>(`/document-exports/${id}`)).export; }
type ProfilePreview = { previewId: string; sha256: string; valid: boolean; rows: { row: number; errors: string[] }[] };
async function profileImport(rows: Array<{ category: string; key: string; expectedVersion?: number; data: Record<string, string> }>) {
  const bytes = await binary('/document-profiles/import-template.xlsx'), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never);
  const sheet = book.worksheets[0]!, columns = Array.from({ length: sheet.columnCount }, (_, index) => sheet.getCell(1, index + 1).text);
  for (const [index, row] of rows.entries()) {
    sheet.getCell(index + 2, 1).value = row.category; sheet.getCell(index + 2, 2).value = row.key; sheet.getCell(index + 2, 3).value = row.expectedVersion ?? null;
    for (const [key, value] of Object.entries(row.data)) { const column = columns.indexOf(key); assert(column >= 3, `import field ${key} is missing`); sheet.getCell(index + 2, column + 1).value = value; }
  }
  const form = new FormData(); form.set('phase', 'preview'); form.set('operationId', randomUUID()); form.set('file', new File([new Uint8Array(await book.xlsx.writeBuffer())], 'technical-profiles.xlsx'));
  return api<ProfilePreview>('/document-profiles/import', form);
}
function commitProfiles(preview: ProfilePreview, operationId = randomUUID()) { const form = new FormData(); form.set('phase', 'commit'); form.set('operationId', operationId); form.set('previewId', preview.previewId); form.set('sha256', preview.sha256); form.set('reason', reason); return form; }
async function oldCoreDigest() {
  const tables = ['user', 'demand', 'demand_revision', 'weekly_batch', 'sub_batch', 'sub_batch_member', 'shipment_revision', 'group_confirmation', 'allocation_code', 'physical_review_state', 'physical_source', 'physical_revision', 'physical_confirmation'];
  const result: Record<string, string> = {};
  for (const table of tables) result[table] = digest((await pool.query(`select row_to_json(t) as row from "${table}" t order by row_to_json(t)::text`)).rows);
  return result;
}

/** This is a synthetic already-reviewed response, never a substitute for a live
 * query. Save it through the same archive + operation boundary used in production
 * so the API acceptance exercises authoritative replay and file verification. */
async function savedLingxingPreview(document: Document, previewActorId: string) {
  const operationId = randomUUID(), unique = new Map<string, DocumentLingxingPreview['products'][number]>();
  for (const member of document.currentRevision.data.members) for (const item of member.shipment.data.items) {
    const identity = { sid: member.demand.snapshot.sid, msku: item.msku, fnsku: item.fnsku, sku: item.sku };
    unique.set(JSON.stringify(identity), { ...identity, data: { ...identity, englishName: 'ARCHIVED CANDIDATE', chineseName: '归档商品候选', material: 'archived polyester',
      salesPrice: '6.25', cartonQuantity: '500', unitPrice: '1.25', currency: 'USD', unitPriceConfirmed: false, unitPriceSource: 'listing.price', unitPriceKind: 'listing-sales-20-percent', unitPriceSourceLabel: '领星 Listing 普通售价 × 20%',
      hsCode: '123456', use: 'technical fixture', brand: 'fixture', model: item.sku, unit: 'PCS', salesLink: 'https://acceptance.invalid/archived-product', imageBase64: pixel, imageExtension: 'png' }, imageUrls: [], issues: [] });
  }
  const suggestions = { products: [...unique.values()], fields: { battery: '是', currency: 'EUR', email: 'archived@acceptance.invalid' }, parties: [], issues: [] };
  const archive = { schema: 'document-lingxing-preview/v1', documentId: document.id, documentVersion: document.version, operationId, actorId: previewActorId,
    fetchedAt: now, revisionDigest: documentDigest(document.currentRevision.data), suggestions, requests: [], attempts: [] };
  let preview: DocumentLingxingPreview | undefined;
  const file = await publishReportFile({ bytes: Buffer.from(JSON.stringify(archive)), originalName: `technical-lingxing-preview-${operationId}.json`, mimeType: 'application/json', createdBy: previewActorId }, async (saved) => {
    await documentOperation(previewActorId, operationId, 'document.lingxing.preview', { id: document.id, operationId, expectedVersion: document.version }, async (tx) => {
      await tx.insert(fileIndex).values(saved);
      preview = documentLingxingPreviewSchema.parse({ documentId: document.id, documentVersion: document.version, operationId, ...suggestions, sourceFileId: saved.id });
      return { documentId: document.id, preview };
    });
  });
  assert(preview); return { preview, file };
}
async function adoptFixtureSources(document: Document, previewActorId: string) {
  // Explicitly select current product versions before taking a fresh preview,
  // matching the existing concurrency rule for authoritative profile adoption.
  const profiles = (await api<{ items: DocumentProfile[] }>('/document-profiles?category=product')).items;
  const references = document.currentRevision.data.profileReferences.map((reference) => {
    const current = reference.category === 'product' ? profiles.find((profile) => profile.id === reference.profileId) : undefined;
    return current ? { ...reference, version: current.version, data: {} } : reference;
  });
  if (references.some((reference, index) => reference.version !== document.currentRevision.data.profileReferences[index]!.version)) document = await revise(document, { profileReferences: references });
  const saved = await savedLingxingPreview(document, previewActorId);
  const adopted = (await api<{ document: Document }>(`/documents/${document.id}/lingxing-apply`, { ...docInput(document), previewOperationId: saved.preview.operationId })).document;
  assert.equal(adopted.currentRevision.data.generationRulesVersion, 'v2');
  assert.equal(adopted.currentRevision.data.productSourceFacts?.length, 2);
  assert(adopted.currentRevision.data.productSourceFacts?.every((fact) => fact.sourceFileId === saved.file.id && fact.sourceSha256 === saved.file.sha256 && fact.salesPrice === '6.25' && fact.unitPrice === '1.25' && fact.cartonQuantity === '500'));
  return adopted;
}
async function lingxingMutationState(documentId: string) {
  const tables = ['document_profile', 'document_profile_version', 'batch_operation', 'operation_audit', 'document_member_claim'];
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await pool.query(`select row_to_json(t) as row from "${table}" t order by row_to_json(t)::text`)).rows;
  rows.document = (await pool.query('select row_to_json(t) as row from document t where id=$1', [documentId])).rows;
  rows.revisions = (await pool.query('select row_to_json(t) as row from document_revision t where document_id=$1 order by version', [documentId])).rows;
  return documentDigest(rows);
}

try {
  await migrate(db, { migrationsFolder: process.env.M4_OLD_MIGRATIONS! });
  await pool.query('insert into "user"(id,name,email,role) values($1,$1,\'m4@acceptance.invalid\',\'admin\')', [actorId]);
  const d1 = await seed(1, 12), d2 = await seed(2), d3 = await seed(3);
  const batchId = (await createWeeklyBatch({ operationId: randomUUID(), weekStartDate: week }, actorId)).batchId!;
  const groupId = await makeGroup(batchId, [d1, d2]), groupTwo = await makeGroup(batchId, [d3]);
  await confirmPhysical(groupTwo);
  const before = await oldCoreDigest(); await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  assert.deepEqual(await oldCoreDigest(), before); await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') }); assert.deepEqual(await oldCoreDigest(), before);
  assert.equal((await pool.query('select count(*) from document')).rows[0].count, '0');
  await passed('incremental-and-repeat-migration-preserve-13-core-table-digests-without-backfill');
  await queue.start(); await queue.createQueue(DOCUMENT_EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 180, deleteAfterSeconds: 0 });
  const password = 'Isolated-M4-fixture-password-2026';
  const account = await auth.api.createUser({ body: { email: 'm4-login@acceptance.invalid', password, name: '隔离M4管理员', role: 'admin' } });
  const login = await app.request('/api/v1/auth/sign-in/email', { method: 'POST', headers: { Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: account.user.email, password }) });
  assert.equal(login.status, 200); cookie = login.headers.getSetCookie().map((part) => part.split(';')[0]).join('; '); assert(cookie);
  await api('/documents', undefined, 401, ''); await api('/document-profiles', undefined, 401, ''); await api('/document-templates', undefined, 401, '');
  await pool.query('update "user" set banned=true where id=$1', [account.user.id]); await api('/documents', undefined, 403); await pool.query('update "user" set banned=false where id=$1', [account.user.id]);
  const candidates = await api<DocumentCandidateList>(`/documents/candidates?weekStartDate=${week}`); assert.equal(candidates.total, 3); assert(!candidates.items.find((item) => item.demandId === d1)?.blockers.some((issue) => issue.code.includes('PHYSICAL')));
  await passed('real-admin-auth-revocation-and-candidate-source-waiting');

  const claimRequests = [0, 1].map((index) => request('/documents', { operationId: randomUUID(), purpose: 'invoice', weekStartDate: week, demandIds: [d2], title: `并发票${index}`, fields }));
  const claimResponses = await Promise.all(claimRequests); assert.deepEqual(claimResponses.map((response) => response.status).sort(), [201, 409]);
  const winner = await claimResponses.find((response) => response.status === 201)!.json() as { document: Document };
  assert.equal((await pool.query('select count(*) from document_member_claim where demand_id=$1 and released_at is null', [d2])).rows[0].count, '1');
  await api(`/documents/${winner.document.id}/cancel`, docInput(winner.document));
  const released = (await createDoc([d2])).document; const correction = await api<{ document: Document; replacesDocumentId: string }>(`/documents/${released.id}/correct`, { ...docInput(released), demandIds: [d2], title: '更正版' }, 201);
  assert.equal(correction.replacesDocumentId, released.id); assert.equal((await current(released.id)).status, 'superseded');
  assert.equal((await pool.query('select document_id from document_member_claim where demand_id=$1 and released_at is null', [d2])).rows[0].document_id, correction.document.id);
  await api(`/documents/${correction.document.id}/cancel`, docInput(correction.document));
  await passed('concurrent-draft-claims-are-exclusive-cancel-releases-and-correction-atomically-transfers');

  const input = await templateBytes(), uploadId = randomUUID();
  const invalidLayout = new ExcelJS.Workbook(); await invalidLayout.xlsx.load(input as never); invalidLayout.worksheets[0]!.getCell('C17').value = '不支持的错误字段';
  const invalidHeader = new ExcelJS.Workbook(); await invalidHeader.xlsx.load(input as never); invalidHeader.worksheets[0]!.getCell('E6').value = '不匹配的错误标签';
  const indexesBeforeInvalidTemplates = (await pool.query('select count(*) from file_index')).rows[0].count;
  for (const book of [invalidLayout, invalidHeader]) { const invalid = await api<{ error: { code: string } }>('/document-templates', templateForm(Buffer.from(await book.xlsx.writeBuffer()), randomUUID()), 422); assert.equal(invalid.error.code, 'INVALID_TEMPLATE'); }
  assert.equal((await pool.query('select count(*) from file_index')).rows[0].count, indexesBeforeInvalidTemplates);
  const uploaded = await api<{ template: DocumentTemplate }>('/document-templates', templateForm(input, uploadId), 201), template = uploaded.template;
  const stored = await binary(`/document-templates/${template.id}/download?version=1`), clean = new ExcelJS.Workbook(); await clean.xlsx.load(stored as never);
  assert.equal(clean.worksheets.length, 1); assert.equal(clean.worksheets[0]!.getCell('B6').value, null); assert.equal(clean.worksheets[0]!.getCell('A18').value, null); assert.equal(clean.worksheets[0]!.getImages().length, 0);
  const beforeReplay = (await pool.query('select count(*) from file_index')).rows[0].count;
  await new Promise((done) => setTimeout(done, 1100));
  const uploadReplay = await api<{ template: DocumentTemplate; replayed: boolean }>('/document-templates', templateForm(input, uploadId), 200); assert(uploadReplay.replayed); assert.equal(uploadReplay.template.id, template.id);
  assert.equal((await pool.query('select count(*) from file_index')).rows[0].count, beforeReplay);
  await passed('uploaded-template-clears-prior-values-images-and-helpers-with-idempotent-replay');
  await api('/document-templates', templateForm(input, randomUUID()), 409);
  const templateV2 = await api<{ template: DocumentTemplate }>('/document-templates', templateForm(input, randomUUID(), 1), 201); assert.equal(templateV2.template.version, 2);
  const beforeConflicts = { indexes: (await pool.query('select count(*) from file_index')).rows[0].count, files: await indexedStorageFiles(), versions: (await pool.query('select count(*) from document_template_version')).rows[0].count };
  for (let retry = 0; retry < 2; retry++) await api('/document-templates', templateForm(input, randomUUID(), 1), 409);
  const newWithVersion = templateForm(input, randomUUID(), 1); newWithVersion.set('name', '不得创建带旧版本的新模板'); await api('/document-templates', newWithVersion, 409);
  assert.equal((await pool.query('select count(*) from file_index')).rows[0].count, beforeConflicts.indexes); assert.deepEqual(await indexedStorageFiles(), beforeConflicts.files); assert.equal((await pool.query('select count(*) from document_template_version')).rows[0].count, beforeConflicts.versions); assert.equal((await pool.query('select version from document_template where id=$1', [template.id])).rows[0].version, 2);
  await passed('template-updates-require-current-version-and-repeated-conflicts-leave-no-index-or-file-orphans');

  // d2 was released by the concurrent-claim scenario. Its two product identities
  // are retired after this block, before the baseline S1/S2 profiles are created.
  const addressDefaults: DocumentProfile[] = [];
  for (const countryCode of ['US', 'DE']) addressDefaults.push((await api<{ profile: DocumentProfile }>('/document-profiles', {
    operationId: randomUUID(), category: 'address', key: `technical-auto-address-${countryCode}`, reason,
    data: { destinationFc: 'TECH-FC', countryCode, recipientName: 'Technical Receiver', addressLine1: '10 Technical Road', city: 'Test City', postalCode: '00000' },
  }, 201)).profile);
  let automatic = (await api<{ document: Document }>('/documents', { operationId: randomUUID(), weekStartDate: week, demandIds: [d2], title: '显式地址与属性默认值技术验证', fields: { battery: '是', dangerous: '否' } }, 201)).document;
  assert.deepEqual(Object.fromEntries(['battery', 'magnetic', 'liquid', 'powder', 'dangerous'].map((key) => [key, automatic.currentRevision.data.fields[key]])), { battery: '是', magnetic: '否', liquid: '否', powder: '否', dangerous: '否' });
  assert.equal(automatic.currentRevision.data.profileReferences.filter((reference) => reference.category === 'address').length, 0);
  assert.equal(automatic.currentRevision.data.fields.addressLine1, undefined);
  automatic = await revise(automatic, { fields: applyDocumentAddress(automatic.currentRevision.data.fields, addressDefaults[0]!.data), profileReferences: [{ category: 'address', profileId: addressDefaults[0]!.id, version: addressDefaults[0]!.version, data: {} }] });
  assert.equal(automatic.currentRevision.data.fields.addressConfirmed, 'false');
  assert.equal(automatic.currentRevision.data.fields.addressLine1, '10 Technical Road');
  const automaticOriginal = structuredClone(automatic.currentRevision);
  automatic = await revise(automatic, { profileReferences: [], fields: { ...automatic.currentRevision.data.fields, addressSelectionMode: 'manual' } });
  automatic = await revise(automatic, { title: '保留显式取消的地址引用' });
  assert.equal(automatic.currentRevision.data.profileReferences.filter((reference) => reference.category === 'address').length, 0);
  assert.deepEqual((await pool.query('select data from document_revision where id=$1', [automaticOriginal.id])).rows[0].data, automaticOriginal.data);
  await api(`/documents/${automatic.id}/cancel`, docInput(automatic));
  const duplicate = (await api<{ profile: DocumentProfile }>('/document-profiles', { operationId: randomUUID(), category: 'address', key: 'technical-auto-address-duplicate', reason, data: { ...addressDefaults[0]!.data, addressLine1: '20 Technical Road' } }, 201)).profile;
  const ambiguous = (await api<{ document: Document }>('/documents', { operationId: randomUUID(), weekStartDate: week, demandIds: [d2], title: '地址歧义技术验证', fields: {} }, 201)).document;
  assert.equal(ambiguous.currentRevision.data.profileReferences.filter((reference) => reference.category === 'address').length, 0);
  assert.equal(ambiguous.currentRevision.data.fields.addressLine1, undefined);
  await api(`/documents/${ambiguous.id}/cancel`, docInput(ambiguous));
  for (const profile of [...addressDefaults, duplicate]) await pool.query("update document_profile set status='retired' where id=$1", [profile.id]);
  await passed('invoice-four-flag-defaults-and-explicit-whole-address-adoption-without-implicit-selection');

  const lingxingItem = datasets.get(d2)!.items[0]!;
  const manualLingxing = (await api<{ profile: DocumentProfile }>('/document-profiles', { operationId: randomUUID(), category: 'product', key: 'lingxing-acceptance-existing', reason,
    data: { sid, msku: lingxingItem.msku, fnsku: lingxingItem.fnsku, sku: lingxingItem.sku, englishName: 'MANUAL VALUE MUST SURVIVE', material: '', unitPrice: '7.77', currency: 'USD', unitPriceConfirmed: false, manualMarker: 'preserve' } }, 201)).profile;
  const hiddenItem = datasets.get(d2)!.items[1]!;
  const hiddenLingxing = (await api<{ profile: DocumentProfile }>('/document-profiles', { operationId: randomUUID(), category: 'product', key: 'lingxing-acceptance-hidden', reason,
    data: { sid, msku: hiddenItem.msku, fnsku: hiddenItem.fnsku, sku: hiddenItem.sku, unitPrice: '0', currency: 'CNY', unitPriceConfirmed: false, manualMarker: 'hidden snapshot must survive retirement' } }, 201)).profile;
  let lingxingDocument = (await createDoc([d2], '隔离领星采用测试')).document;
  lingxingDocument = await revise(lingxingDocument, { profileReferences: [manualLingxing, hiddenLingxing].map((profile) => ({ category: 'product', profileId: profile.id, version: profile.version, data: {} })),
    fields: { ...lingxingDocument.currentRevision.data.fields, addressConfirmed: 'true', addressConfirmationReason: reason }, confirmAddress: true });
  const hiddenSnapshot = structuredClone(lingxingDocument.currentRevision.data.profileReferences.find((reference) => reference.profileId === hiddenLingxing.id)!);
  await pool.query("update document_profile set status='retired' where id=$1", [hiddenLingxing.id]);
  lingxingDocument = await revise(lingxingDocument, { title: '隐藏商品档案退役后仍可保存', profileReferences: lingxingDocument.currentRevision.data.profileReferences.map((reference) => ({ ...reference, data: { clientForgedHiddenSnapshot: true } })) });
  assert.deepEqual(lingxingDocument.currentRevision.data.profileReferences.find((reference) => reference.profileId === hiddenLingxing.id), hiddenSnapshot);
  const applyPath = `/documents/${lingxingDocument.id}/lingxing-apply`;
  const rejectedApply = async (body: Record<string, unknown>, expected: number, code: string) => {
    const state = await lingxingMutationState(lingxingDocument.id);
    const rejected = await api<{ error: { code: string } }>(applyPath, body, expected);
    assert.equal(rejected.error.code, code); assert.equal(await lingxingMutationState(lingxingDocument.id), state, `${code} must roll back document, profiles, claims and operations`);
  };
  const foreignPreview = await savedLingxingPreview(lingxingDocument, actorId);
  await rejectedApply({ ...docInput(lingxingDocument), previewOperationId: foreignPreview.preview.operationId }, 409, 'PREVIEW_CONFLICT');
  const stalePreview = await savedLingxingPreview(lingxingDocument, account.user.id);
  lingxingDocument = await revise(lingxingDocument, { fields: { ...lingxingDocument.currentRevision.data.fields, remarks: 'REVISION AFTER PREVIEW' } });
  await rejectedApply({ ...docInput(lingxingDocument), previewOperationId: stalePreview.preview.operationId }, 409, 'PREVIEW_CONFLICT');
  const savedPreview = await savedLingxingPreview(lingxingDocument, account.user.id);
  const applyInput = { ...docInput(lingxingDocument), previewOperationId: savedPreview.preview.operationId };
  await rejectedApply({ ...applyInput, products: [{ data: { englishName: 'CLIENT FORGED VALUE' } }] }, 422, 'VALIDATION_ERROR');
  const priorResult = (await pool.query('select result from batch_operation where operation_id=$1', [savedPreview.preview.operationId])).rows[0].result as Record<string, unknown>;
  const forgedPreview = structuredClone(savedPreview.preview); forgedPreview.products[0]!.data.englishName = 'DATABASE RESULT WITHOUT MATCHING ARCHIVE';
  await pool.query('update batch_operation set result=$2 where operation_id=$1', [savedPreview.preview.operationId, { ...priorResult, preview: forgedPreview }]);
  try { await rejectedApply(applyInput, 409, 'PREVIEW_CONFLICT'); }
  finally { await pool.query('update batch_operation set result=$2 where operation_id=$1', [savedPreview.preview.operationId, priorResult]); }
  const archivePath = resolve(config.dataDir, savedPreview.file.storageKey), archiveBytes = await readFile(archivePath);
  await writeFile(archivePath, 'TAMPERED LINGXING TECHNICAL ARCHIVE');
  try { await rejectedApply(applyInput, 503, 'FILE_INTEGRITY_ERROR'); }
  finally { await writeFile(archivePath, archiveBytes); }
  await passed('lingxing-apply-rejects-wrong-actor-stale-preview-client-forgery-archive-drift-and-hash-tamper-without-partial-writes');
  const priorLingxingRevision = structuredClone(lingxingDocument.currentRevision.data);
  const adopted = await api<{ document: Document; appliedProducts: number; replayed: boolean }>(applyPath, applyInput);
  assert.equal(adopted.replayed, false); assert.equal(adopted.appliedProducts, 1); assert.equal(adopted.document.version, lingxingDocument.version + 1);
  assert.equal(adopted.document.currentRevision.data.fields.battery, '否'); assert.equal(adopted.document.currentRevision.data.fields.currency, 'USD');
  // Product adoption keeps address suggestions in the authoritative archive;
  // adopting an address requires the explicit whole-address workflow above.
  assert.equal(savedPreview.preview.fields.email, 'archived@acceptance.invalid');
  assert.equal((JSON.parse(archiveBytes.toString('utf8')) as { suggestions: { fields: Record<string, string> } }).suggestions.fields.email, 'archived@acceptance.invalid');
  const addressKeys = [...DOCUMENT_ADDRESS_FIELDS, 'addressConfirmed', 'addressConfirmationReason', 'addressAdoptionVersion', 'addressSelectionMode'];
  assert.deepEqual(Object.fromEntries(addressKeys.map((key) => [key, adopted.document.currentRevision.data.fields[key]])), Object.fromEntries(addressKeys.map((key) => [key, priorLingxingRevision.fields[key]])), 'Adopting product candidates must preserve the whole selected address and its confirmation');
  assert.deepEqual(adopted.document.currentRevision.data.profileReferences.filter((reference) => reference.category === 'address'), priorLingxingRevision.profileReferences.filter((reference) => reference.category === 'address'), 'Product adoption must not implicitly add an address reference');
  const adoptedProfiles = adopted.document.currentRevision.data.profileReferences.filter((reference) => reference.category === 'product'); assert.equal(adoptedProfiles.length, 2);
  const preserved = adoptedProfiles.find((reference) => reference.profileId === manualLingxing.id)!;
  assert.equal(preserved.version, 2); assert.equal(preserved.data.englishName, 'MANUAL VALUE MUST SURVIVE'); assert.equal(preserved.data.manualMarker, 'preserve');
  assert.equal(preserved.data.unitPrice, '7.77'); assert.equal(preserved.data.currency, 'USD'); assert.equal(preserved.data.material, 'archived polyester');
  assert.deepEqual(adoptedProfiles.find((reference) => reference.profileId === hiddenLingxing.id), hiddenSnapshot);
  assert.equal((await pool.query('select version,status from document_profile where id=$1', [hiddenLingxing.id])).rows[0].version, 1);
  assert.equal((await pool.query('select version,status from document_profile where id=$1', [hiddenLingxing.id])).rows[0].status, 'retired');
  for (const reference of [preserved]) {
    assert.equal(reference.data.unitPriceConfirmed, false); assert.equal(reference.data.imageBase64, pixel);
    assert(Array.isArray(reference.data._lingxingSources)); const source = reference.data._lingxingSources[0] as Record<string, unknown>;
    assert.equal(source.system, 'lingxing'); assert.equal(source.sourceFileId, savedPreview.file.id); assert.equal(source.sourceSha256, savedPreview.file.sha256);
    assert.equal(source.previewOperationId, savedPreview.preview.operationId); assert.equal(source.documentId, lingxingDocument.id); assert.equal(source.documentVersion, lingxingDocument.version);
  }
  assert.equal(adopted.document.currentRevision.data.generationRulesVersion, 'v2');
  assert.equal(adopted.document.currentRevision.data.productSourceFacts?.length, 2);
  assert(adopted.document.currentRevision.data.productSourceFacts?.every((fact) => fact.salesPrice === '6.25' && fact.unitPrice === '1.25' && fact.cartonQuantity === '500' && fact.sourceFileId === savedPreview.file.id && fact.sourceSha256 === savedPreview.file.sha256));
  assert.equal(adopted.document.currentRevision.data.templateReference?.templateId, template.id); assert.equal(adopted.document.currentRevision.data.templateReference?.version, 2);
  assert.deepEqual((await pool.query('select data from document_revision where id=$1', [lingxingDocument.currentRevision.id])).rows[0].data, priorLingxingRevision);
  const beforeApplyReplay = await lingxingMutationState(lingxingDocument.id);
  const adoptedReplay = await api<{ document: Document; replayed: boolean }>(applyPath, applyInput);
  assert(adoptedReplay.replayed); assert.equal(adoptedReplay.document.currentRevision.id, adopted.document.currentRevision.id);
  assert.equal(await lingxingMutationState(lingxingDocument.id), beforeApplyReplay);
  const hiddenRetiredValidation = await validate(adopted.document);
  assert(hiddenRetiredValidation.valid, JSON.stringify(hiddenRetiredValidation.issues));
  assert(!hiddenRetiredValidation.issues.some((issue) => issue.code === 'DOCUMENT_PROFILE_STALE'));
  assert.deepEqual((await current(adopted.document.id)).currentRevision.data.profileReferences.find((reference) => reference.profileId === hiddenLingxing.id), hiddenSnapshot);
  await passed('retired-hidden-product-keeps-server-snapshot-on-save-and-does-not-block-representative-adoption-or-validation');
  await api(`/documents/${adopted.document.id}/cancel`, docInput(adopted.document));
  for (const reference of adoptedProfiles) await pool.query("update document_profile set status='retired' where id=$1", [reference.profileId]);
  assert.equal((await pool.query("select count(*) from document_profile where category='product' and status='active'")).rows[0].count, '0');
  assert.equal((await pool.query('select count(*) from document_member_claim where demand_id=$1 and released_at is null', [d2])).rows[0].count, '0');
  await passed('lingxing-apply-adopts-archived-sales-and-carton-facts-preserves-manual-values-and-explicit-address-pins-provenance-and-replays-once');

  const beforeProfiles = digest((await pool.query('select row_to_json(t) as row from document_profile t order by id')).rows);
  const invalidProfiles = await profileImport([{ category: 'party', key: 'import-valid-uncommitted', data: { partyName: 'should not commit' } }, { category: 'party', key: '', data: { partyName: 'invalid key' } }]);
  assert(!invalidProfiles.valid); assert.equal(digest((await pool.query('select row_to_json(t) as row from document_profile t order by id')).rows), beforeProfiles);
  await api('/document-profiles/import', commitProfiles(invalidProfiles), 422); assert.equal(digest((await pool.query('select row_to_json(t) as row from document_profile t order by id')).rows), beforeProfiles);
  const validProfiles = await profileImport([{ category: 'party', key: 'import-one', data: { partyName: 'Bulk One' } }, { category: 'tax', key: 'import-two', data: { currency: 'USD' } }]); assert(validProfiles.valid);
  const importOperation = randomUUID(); const imported = await api<{ count: number }>('/document-profiles/import', commitProfiles(validProfiles, importOperation)); assert.equal(imported.count, 2);
  const profileVersions = (await pool.query('select count(*) from document_profile_version')).rows[0].count;
  const importReplay = await api<{ replayed: boolean }>('/document-profiles/import', commitProfiles(validProfiles, importOperation)); assert(importReplay.replayed); assert.equal((await pool.query('select count(*) from document_profile_version')).rows[0].count, profileVersions);
  const drifted = await profileImport([{ category: 'party', key: 'import-one', expectedVersion: 1, data: { partyName: 'Bulk One Modified' } }, { category: 'party', key: 'import-no-partial', data: { partyName: 'Must Roll Back' } }]); assert(drifted.valid);
  await api('/document-profiles', { operationId: randomUUID(), category: 'party', key: 'import-one', expectedVersion: 1, reason, data: { partyName: 'Concurrent v2' } }, 201);
  const driftResult = await api<{ error: { code: string } }>('/document-profiles/import', commitProfiles(drifted), 409); assert.equal(driftResult.error.code, 'VERSION_CONFLICT'); assert.equal((await pool.query("select count(*) from document_profile where key='import-no-partial'")).rows[0].count, '0');
  const newKeyCollision = await profileImport([{ category: 'party', key: 'import-concurrent-key', data: { partyName: 'Preview candidate' } }, { category: 'party', key: 'import-collision-no-partial', data: { partyName: 'Must Roll Back' } }]); assert(newKeyCollision.valid);
  await api('/document-profiles', { operationId: randomUUID(), category: 'party', key: 'import-concurrent-key', reason, data: { partyName: 'Concurrent original' } }, 201);
  const collisionResult = await api<{ error: { code: string } }>('/document-profiles/import', commitProfiles(newKeyCollision), 409); assert.equal(collisionResult.error.code, 'VERSION_CONFLICT'); assert.equal((await pool.query("select count(*) from document_profile where key='import-collision-no-partial'")).rows[0].count, '0'); assert.equal((await pool.query("select data->>'partyName' as name from document_profile where key='import-concurrent-key'")).rows[0].name, 'Concurrent original');
  await passed('bulk-preview-keeps-profiles-unchanged-errors-reject-whole-batch-replay-and-version-drift-are-safe');

  const profiles: DocumentProfile[] = [];
  for (const product of datasets.get(d1)!.items) profiles.push((await api<{ profile: DocumentProfile }>('/document-profiles', { operationId: randomUUID(), category: 'product', key: product.sku, reason, data: { sid, msku: product.msku, fnsku: product.fnsku, sku: product.sku, englishName: 'Technical product', chineseName: '技术商品', unitPrice: '1.25', unitPriceConfirmed: true, material: 'glass', hsCode: '123456', use: 'test', brand: 'fixture', model: product.sku, unit: 'PCS', currency: 'USD', salesLink: 'https://acceptance.invalid/product', imageBase64: pixel, imageExtension: 'png' } }, 201)).profile);
  for (const category of ['party', 'address', 'channel', 'tax'] as const) profiles.push((await api<{ profile: DocumentProfile }>('/document-profiles', { operationId: randomUUID(), category, key: category, reason, data: { name: `Technical ${category}`, sid, country: 'US', destinationFc: 'TECH-FC', businessChannel: 'TECH', service: fields.service, ...(category === 'address' ? fields : {}) } }, 201)).profile);
  const references = profiles.map((profile) => ({ category: profile.category, profileId: profile.id, version: profile.version, data: { forged: 'client data must not be trusted' } }));
  const templateReference = { templateId: template.id, version: template.version, sha256: template.sha256, fileId: template.fileId };
  let document = (await createDoc([d1])).document;
  document = await revise(document, { profileReferences: references, templateReference, fields: { ...document.currentRevision.data.fields, addressConfirmed: 'true', addressConfirmationReason: reason }, confirmAddress: true });
  assert(!('forged' in document.currentRevision.data.profileReferences[0]!.data));
  const productV1 = profiles[0]!;
  await api('/document-profiles', { operationId: randomUUID(), expectedVersion: 1, category: 'product', key: productV1.key, data: { ...productV1.data, unitPrice: '9.99' }, reason }, 201);
  assert.equal(document.currentRevision.data.profileReferences[0]!.version, 1); assert.equal(document.currentRevision.data.profileReferences[0]!.data.unitPrice, '1.25');
  assert.equal(document.currentRevision.data.generationRulesVersion, 'v2');
  const waiting = await validate(document); assert(!waiting.valid && waiting.issues.some((issue) => issue.code === 'DECLARATION_SALES_PRICE_INVALID'));
  assert(!waiting.issues.some((issue) => issue.code === 'PHYSICAL_CONFIRMATION_REQUIRED'));
  await api(`/documents/${document.id}/exports`, docInput(document), 422); assert.equal((await getSubBatchDetail(groupId, actorId)).group.status, 'confirmed');
  assert.equal((await pool.query('select count(*) from physical_confirmation where group_id=$1', [groupId])).rows[0].count, '0');
  document = await revise(document, { demandIds: [d1] });
  const pricesAwaitingSource = await validate(document); assert(!pricesAwaitingSource.valid && pricesAwaitingSource.issues.filter((issue) => issue.code === 'DECLARATION_SALES_PRICE_INVALID').length === 1, JSON.stringify(pricesAwaitingSource.issues));
  await api(`/documents/${document.id}/exports`, docInput(document), 422);
  document = await adoptFixtureSources(document, account.user.id); const ready = await validate(document); assert(ready.valid, JSON.stringify(ready.issues));
  assert(!ready.issues.some((issue) => issue.code === 'DECLARATION_PRICE_UNCONFIRMED'));
  assert(ready.issues.some((issue) => issue.code === 'DOCUMENT_MIXED_CARTON' && issue.severity === 'warning'));
  const firstBoxId = document.currentRevision.data.members[0]!.shipment.data.boxes[0]!.id;
  const savedFields = { ...document.currentRevision.data.fields };
  document = await revise(document, { fields: { ...savedFields, [documentBoxFieldKey(firstBoxId, 'length')]: '' } });
  assert.equal((await validate(document)).valid, false); await api(`/documents/${document.id}/exports`, docInput(document), 422);
  const modifiedFields = { ...savedFields };
  for (const box of document.currentRevision.data.members[0]!.shipment.data.boxes) modifiedFields[documentBoxFieldKey(box.id, 'length')] = '12.34';
  document = await revise(document, { fields: modifiedFields });
  document = await revise(document, { demandIds: [d1] });
  assert.equal(document.currentRevision.data.fields[documentBoxFieldKey(firstBoxId, 'length')], '12.34');
  assert.equal((await validate(document)).valid, true);
  assert(document.currentRevision.data.members.every((member) => member.physical === null && member.source.physicalConfirmationId === null));
  await passed('M2-only-invoice-validates-box-overrides-preserves-them-on-adoption-and-pins-profile-and-template-versions');

  const failedExport = await exported(document); const beforeFiles = (await pool.query('select count(*) from file_index')).rows[0].count;
  await assert.rejects(() => executeDocumentExport(failedExport.id, { createWorkbook: async () => { throw new Error('ISOLATED RENDER FAILURE'); } }));
  assert.equal((await exportRecord(failedExport.id)).status, 'failed'); assert.equal((await getSubBatchDetail(groupId, actorId)).group.status, 'confirmed'); assert.equal((await pool.query('select count(*) from file_index')).rows[0].count, beforeFiles);
  document = await current(document.id);
  const retry = await exported(document); await Promise.all([executeDocumentExport(retry.id), executeDocumentExport(retry.id)]);
  const complete = await exportRecord(retry.id); assert.equal(complete.status, 'completed'); assert(complete.fileId); assert.equal((await getSubBatchDetail(groupId, actorId)).group.status, 'frozen');
  assert.equal((await pool.query('select count(*) from file_index where id=$1', [complete.fileId])).rows[0].count, '1');
  const bytes = await binary(`/document-exports/${retry.id}/download`), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never); const sheet = book.worksheets[0]!;
  assert.equal(sheet.getCell('B16').value, 12); assert.equal(sheet.getCell('F15').value, 60); assert.equal(sheet.getCell('A18').value, 'FBAM4ISOLATED1U000001-12'); assert.equal(sheet.getCell('J18').value, 500); assert.equal(sheet.getCell('I18').value, 1.25); assert.equal(sheet.getCell('I18').numFmt, '0.00'); assert.equal(sheet.getImages().length, 1); assert.equal(sheet.rowCount, 18);
  assert.equal(sheet.getCell('C18').value, 1.25); assert.equal(sheet.getCell('D18').value, 12.34);
  await api(`/documents/${document.id}/revisions`, { ...docInput(await current(document.id)), fields: { ...modifiedFields, [documentBoxFieldKey(firstBoxId, 'length')]: '99' } }, 409);
  await binary(`/document-exports/${retry.id}/download`, '', 401);
  assert.equal(complete.fileSha256, createHash('sha256').update(bytes).digest('hex'));
  const regenerating = await exported(await current(document.id));
  await api(`/documents/${document.id}/review`, { ...docInput(await current(document.id)), decision: 'approve', exportId: retry.id, fileSha256: complete.fileSha256 }, 409);
  await executeDocumentExport(regenerating.id); const regenerated = await exportRecord(regenerating.id); assert.equal(regenerated.status, 'completed'); assert(regenerated.fileSha256);
  await api(`/documents/${document.id}/review`, { ...docInput(await current(document.id)), decision: 'approve', exportId: regenerated.id, fileSha256: '0'.repeat(64) }, 409);
  const reviewInput = { ...docInput(await current(document.id)), decision: 'approve', exportId: retry.id, fileSha256: complete.fileSha256 };
  await api(`/documents/${document.id}/review`, reviewInput); const reviewReplay = await api<{ replayed: boolean }>(`/documents/${document.id}/review`, reviewInput); assert(reviewReplay.replayed);
  const review = (await pool.query('select file_sha256,dependencies from document_review where document_id=$1', [document.id])).rows[0]; assert.equal(review.file_sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(review.dependencies.revisionId, document.currentRevision.id);
  await passed('failed-render-does-not-freeze-retry-concurrent-publish-and-review-locks-specific-export-hash');

  const old = await current(document.id); const corrected = await api<{ document: Document }>(`/documents/${old.id}/correct`, { ...docInput(old), demandIds: [d1] }, 201);
  await api(`/documents/${corrected.document.id}/cancel`, docInput(corrected.document));
  assert.equal((await getSubBatchDetail(groupId, actorId)).group.status, 'frozen'); assert.equal(digest(await binary(`/document-exports/${retry.id}/download`)), digest(bytes));
  await passed('correction-and-cancellation-preserve-M2-freeze-and-immutable-authorized-history');

  // Simulate pre-deployment metadata only inside this isolated database. All
  // exports and reviews below first use the real v2 API/worker publication flow;
  // no fixture inserts a completed export or changes a published file's bytes.
  // The actual v1 multi-product renderer remains covered in workbook.test.ts.
  let legacy = (await createDoc([d2], '旧规则兼容技术夹具')).document;
  legacy = await revise(legacy, { profileReferences: references, templateReference, fields: { ...legacy.currentRevision.data.fields, addressConfirmed: 'true', addressConfirmationReason: reason }, confirmAddress: true });
  await pool.query("update document_revision set data=data-'generationRulesVersion'-'productSourceFacts' where id=$1", [legacy.currentRevision.id]);
  legacy = await current(legacy.id);
  const legacyRevision = structuredClone(legacy.currentRevision);
  const upgradeRequired = await api<{ error: { code: string } }>(`/documents/${legacy.id}/exports`, docInput(legacy), 422);
  assert.equal(upgradeRequired.error.code, 'DOCUMENT_GENERATION_UPGRADE_REQUIRED');
  legacy = await adoptFixtureSources(legacy, account.user.id);
  assert.equal(legacy.currentRevision.data.generationRulesVersion, 'v2');
  assert.deepEqual((await pool.query('select data from document_revision where id=$1', [legacyRevision.id])).rows[0].data, legacyRevision.data);
  const legacyQueued = await exported(legacy), legacyQueueReference = { ...legacyQueued.reference };
  delete legacyQueueReference.generationRulesVersion;
  await pool.query("update document_revision set data=data-'generationRulesVersion'-'productSourceFacts' where id=$1", [legacy.currentRevision.id]);
  await pool.query('update document_export set reference=$2,request_hash=$3 where id=$1', [legacyQueued.id, legacyQueueReference, documentDigest(legacyQueueReference)]);
  const beforeLegacyQueueFiles = (await pool.query('select count(*) from file_index')).rows[0].count;
  await executeDocumentExport(legacyQueued.id, { createWorkbook: async () => { throw new Error('Old queued rules must not reach the renderer'); } });
  const staleLegacyQueue = await exportRecord(legacyQueued.id);
  assert.equal(staleLegacyQueue.status, 'stale'); assert.equal(staleLegacyQueue.fileId, null);
  assert.equal((await current(legacy.id)).status, 'draft');
  assert.equal((await pool.query('select count(*) from file_index')).rows[0].count, beforeLegacyQueueFiles);
  await passed('legacy-draft-requires-explicit-source-upgrade-and-predeployment-queue-stales-without-publication');

  legacy = await adoptFixtureSources(await current(legacy.id), account.user.id);
  // Explicit v1 confirmations are preserved in this technical snapshot so that
  // legacy validation is checked on its own terms after removing v2 metadata.
  legacy = await revise(legacy, { fields: confirmedFixturePriceFields(legacy) });
  const legacyPublished = await exported(legacy); await executeDocumentExport(legacyPublished.id);
  const historical = await exportRecord(legacyPublished.id); assert.equal(historical.status, 'completed'); assert(historical.fileSha256);
  const historicalBytes = await binary(`/document-exports/${historical.id}/download`);
  await api(`/documents/${legacy.id}/review`, { ...docInput(await current(legacy.id)), decision: 'approve', exportId: historical.id, fileSha256: historical.fileSha256 });
  await pool.query("update document_revision set data=data-'generationRulesVersion'-'productSourceFacts' where id=$1", [legacy.currentRevision.id]);
  await pool.query("update document_export set reference=reference-'generationRulesVersion' where id=$1", [historical.id]);
  await pool.query("update document_review set dependencies=dependencies-'generationRulesVersion' where export_id=$1", [historical.id]);
  legacy = await current(legacy.id); assert.equal(legacy.currentRevision.data.generationRulesVersion, undefined); assert.equal(legacy.status, 'approved');
  const historicalValidation = await validate(legacy); assert(historicalValidation.valid, JSON.stringify(historicalValidation.issues));
  assert.equal((await exportRecord(historical.id)).valid, true);
  await executeDocumentExport(historical.id, { createWorkbook: async () => { throw new Error('A historical completed export must never be regenerated'); } });
  assert.equal(digest(await binary(`/document-exports/${historical.id}/download`)), digest(historicalBytes));
  assert.equal((await exportRecord(historical.id)).fileSha256, historical.fileSha256);
  await api(`/documents/${legacy.id}/cancel`, docInput(legacy));
  await passed('completed-legacy-metadata-keeps-v1-validation-original-reviewed-file-hash-and-download-without-regeneration');

  let changing = (await createDoc([d3], '生成中变化')).document; changing = await revise(changing, { profileReferences: references, templateReference });
  changing = await revise(changing, { fields: { ...changing.currentRevision.data.fields, addressConfirmed: 'true', addressConfirmationReason: reason }, confirmAddress: true });
  changing = await adoptFixtureSources(changing, account.user.id);
  const changingReady = await validate(changing); assert(changingReady.valid, JSON.stringify(changingReady.issues)); const changingExport = await exported(changing);
  await executeDocumentExport(changingExport.id, { createWorkbook: async (data, templateBytes, exportId) => {
    const latest = await current(changing.id); await revise(latest, { fields: { ...latest.currentRevision.data.fields, remarks: 'changed while rendering' } }); return createWorkbook(data, templateBytes, exportId);
  } });
  assert.equal((await exportRecord(changingExport.id)).status, 'stale'); assert.equal((await exportRecord(changingExport.id)).fileId, null); assert.equal((await getSubBatchDetail(groupTwo, actorId)).group.status, 'confirmed');
  await passed('mid-render-revision-change-stales-without-publication-or-premature-freeze');
  changing = await current(changing.id); stopWorker = await registerDocumentExportWorker(queue); const workerExport = await exported(changing);
  let result: DocumentExport = workerExport; const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { result = await exportRecord(workerExport.id); if (['completed', 'failed', 'stale'].includes(result.status)) break; await new Promise((done) => setTimeout(done, 200)); }
  assert.equal(result.status, 'completed'); assert(result.fileId); assert.equal((await getSubBatchDetail(groupTwo, actorId)).group.status, 'frozen');
  await binary(`/document-exports/${workerExport.id}/download`); await passed('registered-pg-boss-worker-renders-and-publishes-persistent-task');
  const file = (await pool.query('select storage_key from file_index where id=$1', [result.fileId])).rows[0]; const original = await readFile(resolve(config.dataDir, file.storage_key));
  await writeFile(resolve(config.dataDir, file.storage_key), 'TAMPERED TECHNICAL FILE'); await binary(`/document-exports/${workerExport.id}/download`, cookie, 503); await writeFile(resolve(config.dataDir, file.storage_key), original);
  assert.equal(digest(await binary(`/document-exports/${workerExport.id}/download`)), digest(original)); await passed('download-rechecks-file-hash-and-rejects-tampered-storage');

  const m2BeforeCorrection = await getSubBatchDetail(groupTwo, actorId), replacement = await correctGroup(groupTwo, m2input(m2BeforeCorrection.group.version), actorId); assert(replacement.groupId);
  assert.equal((await current(changing.id)).status, 'stale');
  assert.equal((await pool.query('select document_id from document_member_claim where demand_id=$1 and released_at is null', [d3])).rows[0].document_id, changing.id);
  const replacementDetail = await getSubBatchDetail(replacement.groupId, actorId);
  await confirmGroup(replacement.groupId, { ...m2input(replacementDetail.group.version), expectedDemandVersions: Object.fromEntries(replacementDetail.members.map((member) => [member.id, member.version])), expectedShipmentVersions: Object.fromEntries(replacementDetail.shipments.map((shipment) => [shipment.demandId, shipment.revision!.version])) }, actorId);
  const replacementConfirmed = await getSubBatchDetail(replacement.groupId, actorId), replacementWeek = await getWeeklyBatch(batchId, actorId);
  await allocateCodes(batchId, { ...m2input(replacementWeek.batch.version), groupIds: [replacement.groupId], expectedGroupVersions: { [replacement.groupId]: replacementConfirmed.group.version } }, actorId);
  await confirmPhysical(replacement.groupId); await api('/documents', { operationId: randomUUID(), purpose: 'invoice', weekStartDate: week, demandIds: [d3], title: '不得抢占更正成员', fields }, 409);
  const outdated = await current(changing.id), successor = await api<{ document: Document }>(`/documents/${outdated.id}/correct`, { ...docInput(outdated), demandIds: [d3] }, 201);
  assert.equal(successor.document.currentRevision.data.members[0]!.source.groupId, replacement.groupId); assert.equal((await validate(successor.document)).valid, true);
  assert.equal((await pool.query('select document_id from document_member_claim where demand_id=$1 and released_at is null', [d3])).rows[0].document_id, successor.document.id);
  assert.equal(digest(await binary(`/document-exports/${workerExport.id}/download`)), digest(original));
  await passed('M2-correction-keeps-member-claim-stales-old-file-and-M4-correction-transfers-to-current-source');
} catch (error) { failed = true; failure = error instanceof Error ? error.stack ?? error.message : String(error); console.error(error); }
finally {
  globalThis.fetch = originalFetch;
  const out = resolve(process.env.M4_ACCEPTANCE_OUT!); await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ kind: 'isolated-postgresql-M4-technical-acceptance', result: failed ? 'failed' : 'passed', checks, failure, externalBusinessRequests: 0, technicalFixturesOnly: true, businessSignoff: 'pending', generatedAt: new Date().toISOString() }, null, 2));
  stopWorker?.(); await queue.stop().catch(() => undefined); await closeDatabase(); if (failed) process.exitCode = 1;
}
