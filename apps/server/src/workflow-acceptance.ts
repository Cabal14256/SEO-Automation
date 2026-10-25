import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgBoss } from 'pg-boss';
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { archiveDataSchema, customsDataSchema, documentBoxFieldKey, financeDataSchema, fulfillmentDataSchema, logisticsDataSchema, workflowBoxes, workflowWriteSchema, type DemandSnapshot, type WorkflowRecord } from '@scm/contracts';
import { readConfig } from './config.js';
import { db, pool, closeDatabase } from './db/client.js';
import { fileIndex } from './db/schema.js';
import { allocateCodes, confirmGroup, createSubBatch, createWeeklyBatch, getSubBatchDetail, getWeeklyBatch, publishCandidate, BatchError } from './modules/batches/service.js';
import { publishReportFile } from './modules/batches/report-service.js';
import { createDocument, getDocument, reviseDocument, reviewDocument, validateDocument } from './modules/documents/service.js';
import { DOCUMENT_EXPORT_QUEUE, executeDocumentExport, getDocumentExport, readDocumentExport, requestDocumentExport } from './modules/documents/exports.js';
import { documentProductOverrideKey, DOCUMENT_HEADER_LABELS, DOCUMENT_MAIN_HEADERS } from './modules/documents/workbook.js';
import { documentTemplates, documentTemplateVersions } from './modules/documents/schema.js';
import { fulfillmentPolicy, fulfillmentPreparation } from './modules/fulfillment/domain.js';
import { logisticsPolicy } from './modules/logistics/domain.js';
import { customsPolicy } from './modules/customs/policy.js';
import { financePolicy } from './modules/finance/domain.js';
import { archivePolicy } from './modules/finance/archive.js';
import { attachWorkflowFile } from './modules/workflow/files.js';
import { executeWorkflowExport, getWorkflowExport, readWorkflowExport, requestWorkflowExport, WORKFLOW_EXPORT_QUEUE } from './modules/workflow/exports.js';
import { getWorkflowDetail, listWorkflowSources, writeWorkflow } from './modules/workflow/service.js';
import type { WorkflowPolicy } from './modules/workflow/policy.js';

const config = readConfig(), checks: string[] = [], actorId = 'workflow-fixture-admin', week = '2000-01-03', at = '2026-10-22T02:00:00.000Z';
assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_workflow_acceptance', 'Use the isolated workflow database only');
assert.equal(config.LINGXING_REQUESTS_ENABLED, false);
const queue = new PgBoss({ connectionString: config.DATABASE_URL }), reason = 'ISOLATED SYNTHETIC WORKFLOW ACCEPTANCE';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External HTTP forbidden in workflow acceptance'); };
const operation = (version: number) => ({ operationId: randomUUID(), expectedVersion: version, reason });
const passed = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function blocked(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => error instanceof BatchError && error.code === code);
}
async function update(record: WorkflowRecord, policy: WorkflowPolicy, data: Record<string, unknown>, action = 'save') {
  return (await writeWorkflow(actorId, policy, workflowWriteSchema.parse({ ...operation(record.version), title: record.title, boxIds: record.boxIds, data, action }), record.id)).record;
}
async function attachment(record: WorkflowRecord, purpose: string, name = 'synthetic-evidence.pdf') {
  const bytes = name.endsWith('.pdf') ? Buffer.from('%PDF-1.4\n% Synthetic technical evidence, not a real business document\n%%EOF') : Buffer.from('SYNTHETIC TECHNICAL BILL');
  const input = { recordId: record.id, operationId: randomUUID(), purpose, bytes, name, mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain' };
  const storedFiles = async () => (await readdir(config.dataDir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => `${entry.parentPath}/${entry.name}`).sort();
  const first = await attachWorkflowFile(actorId, input), beforeReplay = await storedFiles();
  const replay = await attachWorkflowFile(actorId, input);
  assert.equal(replay.replayed, true); assert.equal(replay.file.id, first.file.id);
  assert.deepEqual(await storedFiles(), beforeReplay, 'attachment replay must not leave unindexed staged bytes');
  await blocked(() => attachWorkflowFile(actorId, { ...input, operationId: randomUUID(), name: 'not-a-pdf.pdf', mimeType: 'application/pdf', bytes: Buffer.from('invalid file content') }), 'INVALID_FILE_CONTENT');
  return first.file;
}
async function generated(record: WorkflowRecord, purpose: string) {
  const result = await requestWorkflowExport(queue, record.id, actorId, { operationId: randomUUID(), expectedVersion: record.version, purpose });
  await executeWorkflowExport(result.export.id);
  const item = (await getWorkflowExport(result.export.id, actorId)).export;
  assert.equal(item.status, 'completed', item.error ?? 'file must publish'); assert(item.fileSha256);
  return item;
}
async function sourceFixture() {
  const sid = 1900000005, demandId = randomUUID(), fba = 'FBAWORKFLOWTECH', boxIds = [randomUUID(), randomUUID()];
  const snapshot: DemandSnapshot = { sid, fba, shop: '隔离技术店铺', country: 'US', channel: 'TECH', destinationFc: 'TECH-FC', referenceQuantity: null, notes: reason, subBatchName: null };
  await pool.query("insert into demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) values($1,$2,$3,$4,1,'2000-01-03','2000-01-03','2000-01-09')", [demandId, sid, fba, snapshot]);
  await pool.query('insert into demand_revision(id,demand_id,version,snapshot,created_by) values($1,$2,1,$3,$4)', [randomUUID(), demandId, snapshot, actorId]);
  const batchId = (await createWeeklyBatch({ operationId: randomUUID(), weekStartDate: week }, actorId)).batchId!;
  const batch = await getWeeklyBatch(batchId, actorId);
  const groupId = (await createSubBatch(batchId, { ...operation(batch.batch.version), name: 'M5-M8技术批次', demandIds: [demandId], expectedDemandVersions: { [demandId]: 1 } }, actorId)).groupId!;
  const product = { msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', quantity: '4', name: 'Synthetic item' };
  await publishCandidate({ demandId, subBatchId: groupId, expectedGroupVersion: 1, expectedDemandVersion: 1, actorId, source: 'manual', reason, data: { sid, fba, items: [product], boxes: boxIds.map((id, index) => ({ id, externalBoxId: `TECH-BOX-${index + 1}`, packageId: null, localBoxId: null, name: 'Synthetic box', order: index + 1, items: [{ ...product, quantity: '2' }], weight: '1.25', weightUnit: 'KG', length: '2', width: '3', height: '4', dimensionUnit: 'CM' })), observedAt: at, issues: [] } });
  const group = await getSubBatchDetail(groupId, actorId);
  await confirmGroup(groupId, { ...operation(group.group.version), expectedDemandVersions: { [demandId]: 1 }, expectedShipmentVersions: { [demandId]: group.shipments[0]!.revision!.version } }, actorId);
  await allocateCodes(batchId, { ...operation((await getWeeklyBatch(batchId, actorId)).batch.version), groupIds: [groupId], expectedGroupVersions: { [groupId]: (await getSubBatchDetail(groupId, actorId)).group.version } }, actorId);
  const fields: Record<string, string> = { service: '技术服务', recipientName: 'TECH RECEIVER', addressLine1: 'Synthetic Road', city: 'Test', postalCode: '00000', countryCode: 'US', currency: 'USD', customsMode: '9810', taxMode: '包税', battery: '否', magnetic: '否', liquid: '否', powder: '否', dangerous: '否', addressConfirmed: 'true', addressConfirmationReason: reason };
  for (const boxId of boxIds) fields[documentBoxFieldKey(boxId, 'po')] = 'TECH-PO';
  fields[documentBoxFieldKey(boxIds[0]!, 'weight')] = '2.50';
  fields[documentBoxFieldKey(boxIds[0]!, 'length')] = '12.34';
  const key = `product.${documentProductOverrideKey(sid, product)}.`;
  for (const [field, value] of Object.entries({ englishName: 'Synthetic item', chineseName: '技术商品', unitPrice: '1.25', unitPriceConfirmed: 'true', currency: 'USD', material: 'synthetic textile', hsCode: '123456', use: 'technical test', brand: 'TECH', model: 'TECH', salesLink: 'https://acceptance.invalid/synthetic' })) fields[key + field] = value;
  let document = (await createDocument(actorId, { operationId: randomUUID(), purpose: 'invoice', weekStartDate: week, demandIds: [demandId], title: 'M5-M8隔离丰信单', fields })).document;
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('清关单'); DOCUMENT_MAIN_HEADERS.forEach((label, index) => { sheet.getCell(17, index + 1).value = label; }); DOCUMENT_HEADER_LABELS.forEach(([left, right], index) => { sheet.getCell(index + 1, 1).value = left; sheet.getCell(index + 1, 5).value = right; });
  const templateId = randomUUID(); let templateReference: { templateId: string; version: number; fileId: string; sha256: string } | undefined;
  await publishReportFile({ bytes: Buffer.from(await book.xlsx.writeBuffer()), originalName: 'synthetic-template.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: actorId }, async (file) => {
    await db.transaction(async (tx) => { await tx.insert(fileIndex).values(file); await tx.insert(documentTemplates).values({ id: templateId, purpose: 'invoice', name: 'Synthetic template', createdBy: actorId }); await tx.insert(documentTemplateVersions).values({ id: randomUUID(), templateId, version: 1, fileId: file.id, sha256: file.sha256, mimeType: file.mimeType, originalName: file.originalName, reason, createdBy: actorId }); });
    templateReference = { templateId, version: 1, fileId: file.id, sha256: file.sha256 };
  });
  document = (await reviseDocument(document.id, actorId, { ...operation(document.version), fields, confirmAddress: true, templateReference: templateReference! })).document;
  const validation = (await validateDocument(document.id, actorId, operation(document.version))).validation; assert(validation.valid, JSON.stringify(validation.issues));
  const exported = (await requestDocumentExport(queue, document.id, actorId, operation(document.version))).export; await executeDocumentExport(exported.id);
  const file = (await getDocumentExport(exported.id, actorId)).export; assert.equal(file.status, 'completed');
  const invoice = new ExcelJS.Workbook(); await invoice.xlsx.load((await readDocumentExport(exported.id, actorId)).bytes as never);
  assert.equal(invoice.worksheets[0]!.getCell('C18').value, 2.5); assert.equal(invoice.worksheets[0]!.getCell('D18').value, 12.34);
  document = (await getDocument(document.id, actorId)).document; await reviewDocument(document.id, actorId, { ...operation(document.version), decision: 'approve', exportId: file.id, fileSha256: file.fileSha256! });
  const sources = await listWorkflowSources(actorId); assert.equal(sources.items.length, 1);
  assert(sources.items[0]!.members.every((member) => member.physical === null && member.source.physicalConfirmationId === null));
  const adoptedBox = workflowBoxes(sources.items[0]!).find((box) => box.id === boxIds[0])!;
  assert.equal(adoptedBox.length, '12.34'); assert.equal(adoptedBox.weight, '2.50'); assert.equal(adoptedBox.po, 'TECH-PO');
  assert.equal((await pool.query('select count(*) from physical_confirmation')).rows[0].count, '0');
  passed('M2-only-invoice-adopts-box-overrides-and-propagates-final-values-without-M3');
  return { source: sources.items[0]!, groupId, boxIds };
}

let failure: string | null = null;
try {
  await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  await pool.query('insert into "user"(id,name,email,role) values($1,$1,\'workflow@acceptance.invalid\',\'admin\')', [actorId]);
  await queue.start(); await queue.createQueue(DOCUMENT_EXPORT_QUEUE); await queue.createQueue(WORKFLOW_EXPORT_QUEUE);
  const fixture = await sourceFixture(); passed('M2-M4-real-source-confirmation-export-and-review');
  const preparations: WorkflowRecord[] = [];
  for (const [index, boxId] of fixture.boxIds.entries()) {
    let record = (await writeWorkflow(actorId, fulfillmentPolicy, workflowWriteSchema.parse({ operationId: randomUUID(), sourceDocumentId: fixture.source.documentId, title: `准备单${index + 1}`, boxIds: [boxId], data: {} }))).record;
    const data = fulfillmentDataSchema.parse({ warehouseCode: 'TECH-WH', logistics: 'TECH', lines: fulfillmentPreparation(record) });
    record = await update(record, fulfillmentPolicy, data, 'confirm'); assert.equal(record.status, 'ready');
    const evidence = await attachment(record, 'allocation');
    data.externalOrders.push({ externalOrderNo: `LX-TECH-${index + 1}`, warehouseCode: data.warehouseCode, status: index === 0 ? 'shortage' : 'allocated', lines: data.lines, materials: [], evidenceFileId: evidence.id, shortageReason: index === 0 ? 'Synthetic shortage' : '' });
    const write = workflowWriteSchema.parse({ ...operation(record.version), title: record.title, boxIds: record.boxIds, data, action: 'record_result' });
    const result = await writeWorkflow(actorId, fulfillmentPolicy, write, record.id); record = result.record;
    const replay = await writeWorkflow(actorId, fulfillmentPolicy, write, record.id); assert(replay.replayed); assert.equal(replay.record.version, record.version);
    if (index === 0) { assert.equal(record.status, 'pending'); data.externalOrders[0]!.status = 'allocated'; record = await update(record, fulfillmentPolicy, data, 'record_result'); }
    assert.equal(record.status, 'complete'); await blocked(() => update({ ...record, version: record.version - 1 }, fulfillmentPolicy, data), 'VERSION_CONFLICT'); preparations.push(record);
  }
  await generated(preparations[0]!, 'reconciliation');
  await blocked(() => writeWorkflow(actorId, fulfillmentPolicy, workflowWriteSchema.parse({ operationId: randomUUID(), sourceDocumentId: fixture.source.documentId, title: 'Duplicate scope', boxIds: preparations[0]!.boxIds, data: { ...preparations[0]!.data, externalOrders: [] }, action: 'confirm' })), 'BOX_ALREADY_CLAIMED');
  passed('M5-multiple-orders-shortage-reconciliation-operation-replay-version-and-exclusive-box-claims');
  let logistics = (await writeWorkflow(actorId, logisticsPolicy, workflowWriteSchema.parse({ operationId: randomUUID(), sourceDocumentId: fixture.source.documentId, title: '技术物流单', boxIds: fixture.boxIds, data: {} }))).record;
  await blocked(() => update(logistics, logisticsPolicy, logistics.data, 'release'), 'WORKFLOW_VALIDATION');
  const logisticsEvidence = await attachment(logistics, 'receipt');
  const logisticsData = logisticsDataSchema.parse({ fulfillmentIds: preparations.map((record) => record.id), logisticsOrderNo: 'LOG-TECH-1', trackingNo: 'TRACK-TECH-1', submission: { exportId: fixture.source.exportId, fileSha256: fixture.source.fileSha256, submittedAt: at }, receipt: { status: 'accepted', evidenceFileId: logisticsEvidence.id }, outboundReview: { passed: true, checkedAt: at, checkedBy: 'Synthetic reviewer', evidenceFileId: logisticsEvidence.id }, boxes: fixture.boxIds.map((boxId, index) => ({ boxId, labelFileId: logisticsEvidence.id, labelReference: `LABEL-${index + 1}`, grossWeightKg: '1.25', chargeableWeightKg: '1.50' })) });
  logistics = await update(logistics, logisticsPolicy, logisticsData, 'release'); assert.equal(logistics.status, 'released');
  for (const boxId of fixture.boxIds) { logisticsData.handovers.push({ id: randomUUID(), boxIds: [boxId], handedOverAt: at, receiver: 'Synthetic receiver', evidenceFileId: logisticsEvidence.id, exceptionReason: '' }); logistics = await update(logistics, logisticsPolicy, logisticsData, 'handover'); }
  assert.equal(logistics.status, 'pending');
  logisticsData.lingxingResults = fixture.boxIds.map((boxId, index) => ({ boxId, status: 'shipped', externalOrderNo: `LX-TECH-${index + 1}`, evidenceFileId: logisticsEvidence.id })); logistics = await update(logistics, logisticsPolicy, logisticsData, 'record_lingxing'); assert.equal(logistics.status, 'complete');
  const duplicate = structuredClone(logisticsData); duplicate.handovers.push({ ...duplicate.handovers[0]!, id: randomUUID() }); await blocked(() => update(logistics, logisticsPolicy, duplicate, 'handover'), 'WORKFLOW_VALIDATION');
  passed('M6-release-gates-partial-handover-independent-Lingxing-shipping-and-duplicate-protection');
  const customsData = customsDataSchema.parse({ entity: 'Technical entity', countryCodes: ['US'], declarationMode: '9810', currency: 'USD', freightAmount: '30', freightCurrency: 'CNY', exportDate: '2000-01-04', contractNumber: 'TECH-CONTRACT', invoiceNumber: 'TECH-INVOICE', sellerName: 'Technical seller', sellerAddress: 'Synthetic address', buyerName: 'Technical buyer', buyerAddress: 'Synthetic destination', portOfLoading: 'TECH-SZ', portOfDestination: 'TECH-US', tradeTerms: 'FOB', ecommerceOrderNumber: 'ECOMMERCE-TECH', lines: workflowBoxes(fixture.source).flatMap((box) => box.items.map((item) => ({ boxId: box.id, msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: item.quantity!, declaredQuantity: item.quantity!, unit: 'PCS', unitPrice: '1.25', currency: 'USD', chineseName: '技术商品', englishName: 'Synthetic item', hsCode: '123456', material: 'Synthetic textile', use: 'Technical test', brand: 'TECH', model: 'TECH', conversionConfirmed: false, conversionReason: '' }))), boxWeights: fixture.boxIds.map((boxId) => ({ boxId, grossWeight: '1.25', netWeight: '1.00', confirmed: true })) });
  let customs = (await writeWorkflow(actorId, customsPolicy, workflowWriteSchema.parse({ operationId: randomUUID(), sourceDocumentId: fixture.source.documentId, title: '技术报关与9810', boxIds: fixture.boxIds, data: customsData, action: 'preflight' }))).record;
  const customsExport = await generated(customs, 'customs-package'), workbook = new ExcelJS.Workbook(); await workbook.xlsx.load((await readWorkflowExport(customsExport.id, actorId)).bytes as never); assert.equal(workbook.worksheets.length, 7);
  customsData.review = { exportId: customsExport.id, fileSha256: customsExport.fileSha256!, fingerprint: customsExport.dependencyHash }; customs = await update(customs, customsPolicy, customsData, 'review');
  const customsEvidence = await attachment(customs, 'feedback');
  customsData.customsResult = { status: 'saved', externalNumber: 'CUSTOMS-TECH', feedbackFileIds: [customsEvidence.id], submittedExportId: customsExport.id, submittedSha256: customsExport.fileSha256!, reason };
  customs = await update(customs, customsPolicy, customsData, 'record-customs'); await blocked(() => update(customs, customsPolicy, customsData, 'complete'), 'WORKFLOW_VALIDATION');
  customsData.customsResult.status = 'success'; customs = await update(customs, customsPolicy, customsData, 'record-customs');
  const filingExport = await generated(customs, 'filing9810-checklist');
  customsData.filing9810Result = { status: 'success', externalNumber: '9810-TECH', feedbackFileIds: [customsEvidence.id], submittedExportId: filingExport.id, submittedSha256: filingExport.fileSha256!, reason }; customs = await update(customs, customsPolicy, customsData, 'record-9810'); customs = await update(customs, customsPolicy, customsData, 'complete'); assert.equal(customs.status, 'complete');
  passed('M7-seven-sheet-export-review-separated-saved-and-successful-customs-and-9810');
  let archive = (await writeWorkflow(actorId, archivePolicy, workflowWriteSchema.parse({ operationId: randomUUID(), sourceDocumentId: fixture.source.documentId, title: '技术批次归档', boxIds: fixture.boxIds, data: archiveDataSchema.parse({ groupId: fixture.groupId }) }))).record;
  await blocked(() => update(archive, archivePolicy, archive.data, 'archive'), 'WORKFLOW_VALIDATION');
  let finance = (await writeWorkflow(actorId, financePolicy, workflowWriteSchema.parse({ operationId: randomUUID(), sourceDocumentId: fixture.source.documentId, title: '技术合并账单', boxIds: fixture.boxIds, data: {} }))).record;
  const bill = await attachment(finance, 'bill', 'synthetic-bill.txt');
  const financeData = financeDataSchema.parse({ billNumber: 'BILL-TECH', provider: 'Technical provider', billFileId: bill.id, lines: [{ id: randomUUID(), type: 'freight', nature: 'actual', description: 'Synthetic combined charge', amount: '30', currency: 'USD', boxIds: fixture.boxIds, allocations: preparations.map((record, index) => ({ fulfillmentId: record.id, externalOrderNo: `LX-TECH-${index + 1}`, amount: index === 0 ? '10' : '20' })) }] });
  const unbalanced = structuredClone(financeData); unbalanced.lines[0]!.allocations[0]!.amount = '11'; await blocked(() => update(finance, financePolicy, unbalanced, 'confirm'), 'WORKFLOW_VALIDATION');
  finance = await update(finance, financePolicy, financeData, 'confirm'); await blocked(() => update(finance, financePolicy, financeData, 'settle'), 'WORKFLOW_VALIDATION');
  financeData.externalResults = preparations.map((record, index) => ({ id: randomUUID(), fulfillmentId: record.id, externalOrderNo: `LX-TECH-${index + 1}`, feeType: 'freight', currency: 'USD', beforeAmount: null, expectedAmount: index === 0 ? '10' : '20', afterAmount: index === 0 ? '10' : '20', status: 'verified', evidenceFileIds: [bill.id], recordedAt: at, note: reason }));
  finance = await update(finance, financePolicy, financeData, 'record_result'); assert.equal(finance.status, 'complete');
  archive = await update(archive, archivePolicy, archive.data, 'archive'); assert.equal(archive.status, 'ready');
  const archived = await generated(archive, 'archive-package'), archivedBytes = (await readWorkflowExport(archived.id, actorId)).bytes, zip = unzipSync(archivedBytes); assert(Object.keys(zip).some((key) => /manifest.*json/.test(key)));
  assert.equal(Buffer.from(zip['manifest.sha256']!).toString('utf8'), createHash('sha256').update(zip['manifest.json']!).digest('hex'));
  const manifest = JSON.parse(Buffer.from(zip['manifest.json']!).toString('utf8')) as { files: Array<{ path: string; sha256: string; byteSize: number }> };
  for (const entry of manifest.files) { assert.equal(zip[entry.path]?.byteLength, entry.byteSize); assert.equal(createHash('sha256').update(zip[entry.path]!).digest('hex'), entry.sha256); }
  const originalArchiveSha = createHash('sha256').update(archivedBytes).digest('hex');
  passed('M8-combined-fee-manual-allocation-conservation-external-values-archive-gates-and-hashed-ZIP');
  financeData.lines.push({ id: randomUUID(), type: 'freight', nature: 'supplement', description: 'Synthetic late charge', amount: '5', currency: 'USD', boxIds: fixture.boxIds, allocations: [{ fulfillmentId: preparations[0]!.id, externalOrderNo: 'LX-TECH-1', amount: '5' }] });
  finance = await update(finance, financePolicy, financeData); assert.equal(finance.status, 'draft');
  const erasedConfirmedLine = structuredClone(financeData); erasedConfirmedLine.lines.shift();
  await blocked(() => update(finance, financePolicy, erasedConfirmedLine), 'IMMUTABLE_CONFIRMED_BILL');
  assert((await getWorkflowDetail(archive.id, actorId, archivePolicy)).issues.some((issue) => issue.code === 'FINANCE_PENDING'));
  assert.equal((await getWorkflowExport(archived.id, actorId)).export.valid, false);
  assert.equal(createHash('sha256').update((await readWorkflowExport(archived.id, actorId)).bytes).digest('hex'), originalArchiveSha);
  passed('late-supplement-reopens-finance-and-archive-checklist-while-preserving-old-ZIP');
  const indexedSource = (await pool.query('select storage_key from file_index where id=$1', [fixture.source.fileId])).rows[0] as { storage_key: string };
  const sourcePath = resolve(config.dataDir, indexedSource.storage_key), sourceBytes = await readFile(sourcePath);
  try {
    await writeFile(sourcePath, Buffer.from('SYNTHETIC FILE INTEGRITY FAILURE'));
    const damaged = await getWorkflowDetail(logistics.id, actorId, logisticsPolicy);
    assert.equal(damaged.context.sourceValid, false); assert(damaged.history.length > 0);
    assert.equal(logisticsDataSchema.parse(damaged.record.data).handovers.length, 2);
    await blocked(() => update(logistics, logisticsPolicy, logistics.data, 'release'), 'WORKFLOW_VALIDATION');
  } finally { await writeFile(sourcePath, sourceBytes); }
  assert.equal((await getWorkflowDetail(logistics.id, actorId, logisticsPolicy)).context.sourceValid, true);
  passed('tampered-M4-bytes-invalidate-source-with-readable-history-and-restore-cleanly');
  // A source-side cancellation is a technical mutation in this isolated fixture,
  // used to verify that external facts survive source invalidation.
  await pool.query("update document set status='cancelled' where id=$1", [fixture.source.documentId]);
  const detail = await getWorkflowDetail(logistics.id, actorId, logisticsPolicy); assert.equal(detail.context.sourceValid, false); assert.equal(logisticsDataSchema.parse(detail.record.data).handovers.length, 2);
  await blocked(() => update(logistics, logisticsPolicy, logistics.data, 'release'), 'WORKFLOW_VALIDATION');
  passed('source-invalidation-blocks-new-release-without-erasing-external-physical-facts');
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); console.error(failure); process.exitCode = 1; }
finally {
  await queue.stop({ graceful: true, timeout: 5000 }).catch(() => undefined); globalThis.fetch = originalFetch;
  const output = resolve(process.env.WORKFLOW_ACCEPTANCE_OUT ?? '../../.local/workflow-acceptance.json'); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ result: failure ? 'failed' : 'passed', technicalFixturesOnly: true, externalBusinessRequests: 0, checks, failure, completedAt: new Date().toISOString() }, null, 2) + '\n');
  await closeDatabase();
}
