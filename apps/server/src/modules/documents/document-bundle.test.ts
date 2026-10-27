import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentExportReference, DocumentRevisionData } from '@scm/contracts';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), actor: vi.fn(), freeze: vi.fn(), locked: vi.fn(), validate: vi.fn(), checked: vi.fn(), publish: vi.fn(), render: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('../batches/service.js', () => ({ BatchError: class extends Error { constructor(public code: string, public status: number, message: string, public details?: unknown) { super(message); } }, requireBatchActor: mocks.actor, freezeGroupForExport: mocks.freeze }));
vi.mock('../batches/report-service.js', () => ({ publishReportFile: mocks.publish }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: mocks.checked }));
vi.mock('./service.js', () => ({ lockedDocument: mocks.locked, validateDocumentInTx: mocks.validate }));
vi.mock('./workbook.js', async (original) => ({ ...await original<typeof import('./workbook.js')>(), createWorkbook: mocks.render }));
import { BatchError } from '../batches/service.js';
import { fileIndex } from '../../db/schema.js';
import { documentAutomationJobs, documentInvoiceBundles } from './automation-schema.js';
import { documentExports, documents } from './schema.js';
import { assertDocumentBundleValidInTx, preflightDocumentBundle, publishDocumentBundle, readDocumentBundle } from './document-bundle.js';
import { DOCUMENT_MAIN_HEADERS } from './workbook.js';
import type { BatchTx } from '../batches/service.js';

type Job = typeof documentAutomationJobs.$inferSelect;
type StoredFile = typeof fileIndex.$inferSelect;
type Source = Parameters<typeof publishDocumentBundle>[1][number];
type Saved = { record: { id: string; version: number; status: string; currentRevisionId: string }; revision: { id: string; version: number; data: DocumentRevisionData } };
let state: { job: Job; files: StoredFile[]; bundles: Array<typeof documentInvoiceBundles.$inferSelect>; exports: Array<typeof documentExports.$inferSelect>; docs: Map<string, Saved>; frozen: string[] };
let bytes: Buffer, sources: Source[], invalid: Set<string>;
const at = new Date('2026-10-25T01:00:00Z'), dialect = new PgDialect();
function rows(table: unknown, params: unknown[] = []) {
  const result = table === documentAutomationJobs ? [state.job] : table === fileIndex ? state.files : table === documentInvoiceBundles ? state.bundles : table === documentExports ? state.exports : [];
  const ids = params.filter((value): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value));
  return !ids.length ? result : result.filter((entry) => ids.includes(entry.id) || 'fileId' in entry && ids.includes(String(entry.fileId)) || 'jobId' in entry && ids.includes(String(entry.jobId)) || 'reference' in entry && ids.includes(String(entry.reference.documentId)));
}
function query(table: unknown) {
  let params: unknown[] = [];
  const value = { from: () => value, for: () => value, orderBy: () => value,
    where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => { params = dialect.sqlToQuery(condition).params; return value; },
    then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows(table, params)).then(resolve, reject) };
  return value;
}
const tx = {
  select: vi.fn(() => ({ from: (table: unknown) => query(table) })),
  insert: vi.fn((table: unknown) => ({ values: (value: Record<string, unknown>) => {
    if (table === fileIndex) state.files.push(value as StoredFile);
    if (table === documentInvoiceBundles) state.bundles.push(value as typeof documentInvoiceBundles.$inferSelect);
    if (table === documentExports) state.exports.push(value as typeof documentExports.$inferSelect);
    return Promise.resolve([]);
  } })),
  update: vi.fn((table: unknown) => ({ set: (value: Record<string, unknown>) => ({ where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
    if (table === documentAutomationJobs) { const version = typeof value.version === 'object' ? state.job.version + 1 : value.version; Object.assign(state.job, value, version ? { version } : {}); }
    if (table === documents) { const id = dialect.sqlToQuery(condition).params[0] as string; Object.assign(state.docs.get(id)!.record, value); }
    return Promise.resolve([]);
  } }) })),
} as unknown as BatchTx;
beforeEach(async () => {
  vi.clearAllMocks(); invalid = new Set();
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('清关单'); DOCUMENT_MAIN_HEADERS.forEach((label, index) => { sheet.getCell(17, index + 1).value = label; });
  sheet.getCell('B4').value = 'Receiver'; sheet.getCell('B6').value = '10 Road'; sheet.getCell('B12').value = 'US'; sheet.getCell('F12').value = '美元'; sheet.getCell('B16').value = 1; sheet.getCell('F15').value = 5;
  for (let row = 1; row <= 5; row++) sheet.getCell(`F${row}`).value = '否';
  sheet.getRow(18).values = ['FBA-BOX', 'PO', 1, 2, 3, 4, 'Product', '商品', 1.25, 5, 'Glass', '123', 'Use', 'Brand', 'Model', null, 'https://example.invalid']; sheet.pageSetup.printArea = 'A1:Q18';
  bytes = Buffer.from(await book.xlsx.writeBuffer());
  const jobId = randomUUID(), templateId = randomUUID(), templateFile: StoredFile = { id: randomUUID(), originalName: 'template.xlsx', storageKey: 'template.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', byteSize: bytes.length, sha256: 'a'.repeat(64), createdBy: 'admin', createdAt: at };
  const docs = new Map<string, Saved>();
  sources = Array.from({ length: 2 }, () => {
    const documentId = randomUUID(), revisionId = randomUUID(), source = { groupId: randomUUID(), m2ConfirmationId: randomUUID(), demandId: randomUUID() };
    const data = { purpose: 'invoice', generationRulesVersion: 'v2', templateReference: { templateId, version: 1, sha256: templateFile.sha256, fileId: templateFile.id }, members: [{ source, demand: { id: source.demandId, snapshot: { country: 'US' } } }], profileReferences: [], fields: { recipientName: 'Receiver', addressLine1: '10 Road', countryCode: 'US', currency: 'USD' } } as unknown as DocumentRevisionData;
    const reference: DocumentExportReference = { documentId, revisionId, revisionVersion: 1, templateId, templateVersion: 1, templateSha256: templateFile.sha256, sources: [source] as DocumentExportReference['sources'], generationRulesVersion: 'v2', bundleJobId: jobId };
    docs.set(documentId, { record: { id: documentId, version: 1, status: 'draft', currentRevisionId: revisionId }, revision: { id: revisionId, version: 1, data } });
    return { itemId: randomUUID(), documentId, version: 1, reference, data, file: templateFile, existingExportId: null };
  });
  const items = sources.map((source) => ({ id: source.itemId, demandIds: [source.reference.sources[0]!.demandId], fbas: ['FBA1'], documentId: source.documentId, documentVersion: 1, exportId: null, fileId: null, status: 'ready' as const, stage: 'ready' as const, issues: [], error: null, attempt: 1, sourceDigest: 'digest', operations: {} }));
  state = { files: [templateFile], bundles: [], exports: [], docs, frozen: [], job: { id: jobId, operationId: randomUUID(), requestHash: 'digest', shippingRunId: randomUUID(), version: 4, status: 'running', mode: 'single_workbook', phase: 'generating', bundle: null, fields: {}, title: null, items, error: null, retryRequests: [], queueJobId: null, leaseUntil: null, createdBy: 'admin', createdAt: at, updatedAt: at, completedAt: null, deletedAt: null, deletedBy: null, deletionReason: null } };
  mocks.transaction.mockImplementation(async (action: (tx: BatchTx) => Promise<unknown>) => { const original = structuredClone(state); try { return await action(tx); } catch (error) { state = original; throw error; } });
  mocks.actor.mockResolvedValue({}); mocks.freeze.mockImplementation(async (_tx, id) => { state.frozen.push(id); });
  mocks.locked.mockImplementation(async (_tx, id: string, _actor, expected?: number) => { const saved = state.docs.get(id)!; if (expected !== undefined && expected !== saved.record.version) throw new BatchError('VERSION_CONFLICT', 409, '版本已变化'); return saved; });
  mocks.validate.mockImplementation(async (_tx, id) => ({ documentId: id, version: 1, valid: !invalid.has(id), issues: invalid.has(id) ? [{ code: 'VAT_REQUIRED', severity: 'error', message: 'VAT缺失' }] : [], checkedAt: at.toISOString() }));
  mocks.checked.mockResolvedValue(bytes); mocks.render.mockImplementation(async (_data, value) => value);
  mocks.publish.mockImplementation(async (input, action) => { const file: StoredFile = { ...templateFile, id: randomUUID(), originalName: input.originalName, storageKey: 'bundle.xlsx', byteSize: input.bytes.length, sha256: 'b'.repeat(64) }; await action(file); return file; });
});
describe('whole-batch preflight and atomic XLSX publication', () => {
  it('blocks deleted task downloads and ordinary scope validation while retaining fully validated historic export access', async () => {
    const id = state.job.id; await publishDocumentBundle(structuredClone(state.job), sources); state.job.deletedAt = at;
    await expect(readDocumentBundle(id, 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(assertDocumentBundleValidInTx(tx, id, 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(readDocumentBundle(id, 'admin', { historicalExport: true })).resolves.toHaveProperty('file.id', state.job.bundle!.fileId);
    invalid.add(sources[1]!.documentId);
    await expect(readDocumentBundle(id, 'admin', { historicalExport: true })).resolves.toHaveProperty('file.id', state.job.bundle!.fileId);
    expect(state.exports).toHaveLength(2); expect(state.bundles).toHaveLength(1);
  });
  it('never renders a deleted task during preflight and never publishes after deletion', async () => {
    state.job.deletedAt = at;
    await expect(preflightDocumentBundle(state.job)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(mocks.render).not.toHaveBeenCalled();
    await expect(publishDocumentBundle(structuredClone(state.job), sources)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(state.exports).toEqual([]); expect(state.bundles).toEqual([]); expect(state.frozen).toEqual([]);
  });
  it('blocks a legacy completed invoice instead of copying obsolete headers into a new bundle', async () => {
    const document = state.docs.get(sources[0]!.documentId)!; document.revision.data.generationRulesVersion = 'v1';
    const result = await preflightDocumentBundle(state.job);
    expect(result.items.find((item) => item.documentId === sources[0]!.documentId)).toMatchObject({ status: 'blocked', error: { code: 'DOCUMENT_GENERATION_UPGRADE_REQUIRED' } });
    expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('rejects a v1 existing export reference even if the current snapshot claims newer rules', async () => {
    const source = sources[0]!;
    state.exports.push({ id: randomUUID(), fileId: source.file.id, status: 'completed', reference: { ...source.reference, generationRulesVersion: 'v1', bundleJobId: undefined }, createdAt: at } as typeof documentExports.$inferSelect);
    const result = await preflightDocumentBundle(state.job);
    expect(result.items.find((item) => item.documentId === source.documentId)).toMatchObject({ status: 'blocked', error: { code: 'DOCUMENT_GENERATION_UPGRADE_REQUIRED' } });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('reports every blocked ticket before any rendering or file publication', async () => {
    invalid.add(sources[1]!.documentId);
    const result = await preflightDocumentBundle(state.job);
    expect(result.items.map((item) => item.status)).toContain('blocked'); expect(result.sources).toHaveLength(1);
    await expect(publishDocumentBundle({ ...state.job, items: result.items }, result.sources)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' });
    expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled(); expect(state.exports).toEqual([]); expect(state.frozen).toEqual([]);
  });
  it('publishes exactly one bundle and all per-document references/freeze decisions in the same transaction', async () => {
    const snapshot = structuredClone(state.job); await publishDocumentBundle(snapshot, sources);
    expect(mocks.publish).toHaveBeenCalledOnce(); expect(state.bundles).toHaveLength(1); expect(state.exports).toHaveLength(2);
    expect(new Set(state.exports.map((entry) => entry.fileId)).size).toBe(1); expect(state.exports.every((entry) => entry.reference.bundleJobId === snapshot.id)).toBe(true);
    expect(state.job).toMatchObject({ status: 'completed', phase: 'completed', bundle: { status: 'completed', sheetCount: 1 } });
    expect(state.job.items.every((item) => item.status === 'completed')).toBe(true); expect(state.frozen).toHaveLength(2);
    const buffer = vi.mocked(mocks.publish).mock.calls[0]![0].bytes, book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
    expect(book.worksheets).toHaveLength(1); expect(book.worksheets[0]!.getCell('B16').value).toBe(2); expect(book.worksheets[0]!.getCell('F15').value).toBe(10);
    await expect(publishDocumentBundle(snapshot, sources)).resolves.toBe(false); expect(state.bundles).toHaveLength(1); expect(state.exports).toHaveLength(2);
  });
  it('does not publish a partial workbook or freeze any source when a late member validation fails', async () => {
    invalid.add(sources[1]!.documentId);
    await expect(publishDocumentBundle(structuredClone(state.job), sources)).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_STALE' });
    expect(state.bundles).toEqual([]); expect(state.exports).toEqual([]); expect(state.files).toHaveLength(1); expect(state.frozen).toEqual([]); expect(state.job.bundle).toBeNull();
  });
  it('keeps immutable archives downloadable after source invalidation but rejects damaged publication mappings', async () => {
    const id = state.job.id; await publishDocumentBundle(structuredClone(state.job), sources);
    await expect(assertDocumentBundleValidInTx(tx, id, 'admin')).resolves.toBeTruthy();
    invalid.add(sources[1]!.documentId);
    await expect(assertDocumentBundleValidInTx(tx, id, 'admin')).rejects.toMatchObject({ code: 'DOCUMENT_EXPORT_STALE' });
    await expect(readDocumentBundle(id, 'admin')).resolves.toHaveProperty('file.id', state.job.bundle!.fileId);
    state.exports.pop();
    await expect(readDocumentBundle(id, 'admin')).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
    expect(state.bundles).toHaveLength(1); expect(state.job.bundle?.status).toBe('completed');
  });
});
