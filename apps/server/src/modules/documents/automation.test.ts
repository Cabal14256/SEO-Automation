import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgBoss } from 'pg-boss';
import type { DocumentCandidate, DocumentRevisionData } from '@scm/contracts';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), actor: vi.fn(), candidates: vi.fn(), locked: vi.fn(), connect: vi.fn(), log: vi.fn(), requirements: vi.fn(), supplement: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: mocks.transaction }, pool: { connect: mocks.connect } }));
vi.mock('../../errors.js', () => ({ logError: mocks.log }));
vi.mock('../batches/service.js', async (original) => ({ ...await original<typeof import('../batches/service.js')>(), requireBatchActor: mocks.actor }));
vi.mock('./lingxing-sync.js', () => ({ applyDocumentLingxing: vi.fn(), previewDocumentLingxing: vi.fn() }));
vi.mock('./automatic-preparation.js', () => ({ prepareDocumentAutomation: vi.fn() }));
vi.mock('./automation-supplement.js', () => ({ getDocumentAutomationRequirementsInTx: mocks.requirements, applyDocumentAutomationSupplementInTx: mocks.supplement }));
vi.mock('./exports.js', () => ({ getDocumentExport: vi.fn(), listDocumentExports: vi.fn(), requestDocumentExport: vi.fn() }));
vi.mock('./service.js', async (original) => ({ ...await original<typeof import('./service.js')>(), documentCandidatesInTx: mocks.candidates, lockedDocument: mocks.locked }));
import { db } from '../../db/client.js';
import { documentAutomationJobs } from './automation-schema.js';
import { documentExports, documentMemberClaims, documents } from './schema.js';
import { automationOperationId, candidateItem } from './automation-engine.js';
import { deleteDocumentAutomation, documentAutomationError, executeDocumentAutomation, getDocumentAutomation, getDocumentAutomationRequirements, listDocumentAutomations, reconcileDocumentAutomations, resolveAutomationSuccessorInTx, retryDocumentAutomation, serializeDocumentAutomation, startDocumentAutomation, supplementDocumentAutomation } from './automation.js';
import { batchOperations } from '../batches/schema.js';
import { documentDigest } from './domain.js';
import { operationAudit } from '../../db/schema.js';
import { DocumentWorkbookError } from './workbook-errors.js';

type Row = typeof documentAutomationJobs.$inferSelect;
let jobs: Row[], operationRows: Record<string, unknown>[], selections: unknown[], inserts: unknown[], currentActor: string;
let selectionReturns: Map<unknown, unknown[]>;
let updates: Array<{ table: unknown; values: Record<string, unknown> }>, auditRows: Record<string, unknown>[];
const dialect = new PgDialect();
const at = new Date('2026-10-25T01:00:00Z');
const boss = { send: vi.fn(), findJobs: vi.fn() } as unknown as PgBoss;
const candidate = (): DocumentCandidate => {
  const demandId = randomUUID();
  return { demandId, demand: { id: demandId, version: 1, snapshot: { sid: 12, fba: 'FBA1', country: '美国', destinationFc: 'ONT8', channel: 'SEA' } },
    groupId: randomUUID(), groupVersion: 1, m2ConfirmationId: randomUUID(), shipment: { id: randomUUID() }, codes: [], physical: null, blockers: [] } as unknown as DocumentCandidate;
};
function job(changes: Partial<Row> = {}): Row {
  const item = candidateItem([candidate()], randomUUID()); item.status = 'blocked'; item.stage = 'prepare'; item.error = { code: 'VAT_REQUIRED', message: '请填写 VAT' };
  return { id: randomUUID(), operationId: randomUUID(), requestHash: 'hash', shippingRunId: randomUUID(), version: 4, status: 'blocked', mode: 'legacy', phase: 'needs_input', bundle: null, fields: {}, title: null,
    items: [item], error: null, retryRequests: [], queueJobId: randomUUID(), leaseUntil: null, createdBy: 'admin', createdAt: at, updatedAt: at, completedAt: at, deletedAt: null, deletedBy: null, deletionReason: null, ...changes };
}
function result(rows: unknown[]) {
  const query = Object.assign(Promise.resolve(rows), { where: () => query, for: () => query, orderBy: () => query, limit: () => query, returning: () => query }); return query;
}
const tx = {
  execute: vi.fn(async () => ({ rows: [{ locked: true }] })),
  select: vi.fn(() => ({ from: (table: unknown) => { selections.push(table); const rows = selectionReturns.get(table) ?? (table === documentAutomationJobs ? jobs : table === batchOperations ? operationRows : []);
    return table === batchOperations ? { where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => result(rows.filter((entry) => (entry as { operationId: string }).operationId === dialect.sqlToQuery(condition).params[0])) } : result(rows); } })),
  insert: vi.fn((table: unknown) => ({ values: (values: Record<string, unknown>) => {
    inserts.push(table);
    if (table === documentAutomationJobs) { const row = { version: 1, retryRequests: [], error: null, queueJobId: null, leaseUntil: null, title: null, createdAt: at, updatedAt: at, completedAt: null, ...values } as Row; jobs.push(row); return result([row]); }
    if (table === batchOperations) operationRows.push(values); if (table === operationAudit) auditRows.push(values); return result([]);
  } })),
  update: vi.fn((table: unknown) => ({ set: (values: Record<string, unknown>) => {
    updates.push({ table, values });
    if (table === documentAutomationJobs && jobs[0]) { const increment = values.version && typeof values.version !== 'number'; Object.assign(jobs[0], values, increment ? { version: jobs[0].version + 1 } : {}); }
    return result(table === documentAutomationJobs ? jobs : []);
  } })),
};
beforeEach(() => {
  vi.clearAllMocks(); jobs = []; operationRows = []; selections = []; inserts = []; updates = []; auditRows = []; selectionReturns = new Map(); currentActor = 'admin';
  mocks.actor.mockImplementation(async () => ({ id: currentActor }));
  tx.execute.mockResolvedValue({ rows: [{ locked: true }] });
  mocks.requirements.mockResolvedValue({ descriptors: [], issues: [], documentVersions: {} }); mocks.supplement.mockResolvedValue({ documents: [] });
  mocks.candidates.mockResolvedValue({ items: [candidate()] });
  mocks.transaction.mockImplementation(async (action: (value: unknown) => Promise<unknown>) => { const before = structuredClone(jobs); try { return await action(tx); } catch (error) { jobs = before; throw error; } });
  vi.mocked(boss.send).mockResolvedValue(randomUUID()); vi.mocked(boss.findJobs).mockResolvedValue([]);
});
describe('persistent invoice automation submissions and recovery', () => {
  it('preserves controlled workbook failure reasons while hiding unexpected runtime or database details', () => {
    expect(documentAutomationError(new DocumentWorkbookError('原始发票明细表头不属于当前受控制单格式。'))).toEqual({ code: 'DOCUMENT_WORKBOOK_INVALID', message: '原始发票明细表头不属于当前受控制单格式。' });
    expect(documentAutomationError(new Error('database connection secret details'))).toEqual({ code: 'DOCUMENT_AUTOMATION_FAILED', message: '自动出单暂未完成，已保存成功步骤，请续跑。' });
  });
  function ownedDraft(row: Row, item = row.items[0]!, orphan = false) {
    const documentId = randomUUID(), version = orphan ? 1 : 3;
    const data = { shippingRunId: row.shippingRunId, members: item.demandIds.map((id) => ({ demand: { id } })) } as DocumentRevisionData;
    const input = { operationId: automationOperationId(row.id, item.id, 'create'), shippingRunId: row.shippingRunId, purpose: 'invoice', demandIds: item.demandIds, title: '自动发票', fields: {} };
    item.operations.create = { input }; item.documentId = orphan ? null : documentId; item.documentVersion = orphan ? null : version;
    operationRows.push({ operationId: input.operationId, action: 'document.create', actorId: row.createdBy, requestHash: documentDigest({ action: 'document.create', input }), result: { documentId, document: { id: documentId, version: 1, currentRevision: { data } } } });
    const saved = { record: { id: documentId, version, createdBy: row.createdBy, purpose: 'invoice', status: 'draft' }, revision: { data } };
    mocks.locked.mockResolvedValue(saved); return { documentId, saved };
  }
  it('atomically soft deletes only the exact owned unexported draft, clears resume intent and audits the release', async () => {
    const row = job(), { documentId } = ownedDraft(row); jobs = [row]; row.retryRequests = [{ operationId: randomUUID(), itemIds: [row.items[0]!.id] }];
    const input = { operationId: randomUUID(), expectedVersion: 4, reason: '删除指定的旧自动任务' };
    const response = await deleteDocumentAutomation(row.id, 'admin', input);
    expect(response).toMatchObject({ automationId: row.id, version: 5, deleted: true, cancelledDocumentIds: [documentId], preservedDocumentIds: [], replayed: false });
    expect(jobs[0]).toMatchObject({ deletedBy: 'admin', deletionReason: input.reason, retryRequests: [], queueJobId: null, leaseUntil: null, status: 'failed' }); expect(jobs[0]!.deletedAt).toBeInstanceOf(Date);
    expect(updates.filter((entry) => entry.table === documentMemberClaims)).toHaveLength(1); expect(updates.find((entry) => entry.table === documents)?.values).toMatchObject({ status: 'cancelled', version: 4 });
    expect(auditRows).toContainEqual(expect.objectContaining({ action: 'document.automation.delete.result', targetId: row.id, details: expect.objectContaining({ reason: input.reason, cancelledDocumentIds: documentId }) }));
    expect(auditRows).toContainEqual(expect.objectContaining({ action: 'document.cancel', targetId: documentId, details: expect.objectContaining({ reason: input.reason, automationId: row.id }) }));
    const second = await deleteDocumentAutomation(row.id, 'admin', input); expect(second).toEqual({ ...response, replayed: true });
    expect(updates.filter((entry) => entry.table === documents)).toHaveLength(1); expect(boss.send).not.toHaveBeenCalled();
  });
  it('recovers a committed creation with a lost response before releasing its orphaned owned draft', async () => {
    const row = job(), { documentId } = ownedDraft(row, row.items[0], true); jobs = [row];
    const response = await deleteDocumentAutomation(row.id, 'admin', { operationId: randomUUID(), expectedVersion: 4, reason: '取消' });
    expect(response.cancelledDocumentIds).toEqual([documentId]); expect(mocks.locked).toHaveBeenCalledWith(tx, documentId, 'admin');
  });
  it.each(['adopted', 'uncommitted', 'different-request', 'changed-version', 'exported', 'other-task', 'different-scope'])('preserves a %s document and every claim', async (kind) => {
    const row = job(), { documentId, saved } = ownedDraft(row); jobs = [row];
    if (kind === 'adopted') row.items[0]!.operations = {};
    if (kind === 'uncommitted') operationRows = [];
    if (kind === 'different-request') operationRows[0]!.requestHash = 'another-hash';
    if (kind === 'changed-version') saved.record.version++;
    if (kind === 'exported') selectionReturns.set(documentExports, [{ fileId: randomUUID(), status: 'completed' }]);
    if (kind === 'other-task') selectionReturns.set(documentAutomationJobs, [row, job({ items: structuredClone(row.items) })]);
    if (kind === 'different-scope') saved.revision.data = { ...saved.revision.data, members: [] };
    const response = await deleteDocumentAutomation(row.id, 'admin', { operationId: randomUUID(), expectedVersion: 4, reason: '取消' });
    expect(response.cancelledDocumentIds).toEqual([]); expect(response.preservedDocumentIds).toEqual([documentId]);
    expect(updates.some((entry) => entry.table === documents || entry.table === documentMemberClaims)).toBe(false);
  });
  it('requires worker lock, owner and current job version before deleting anything', async () => {
    const row = job(); ownedDraft(row); jobs = [row]; const input = { operationId: randomUUID(), expectedVersion: 4, reason: '取消' };
    tx.execute.mockImplementationOnce(async () => ({ rows: [{ locked: true }] })).mockImplementationOnce(async () => ({ rows: [{ locked: false }] }));
    await expect(deleteDocumentAutomation(row.id, 'admin', input)).rejects.toMatchObject({ code: 'DOCUMENT_AUTOMATION_BUSY' });
    await expect(deleteDocumentAutomation(row.id, 'another-admin', { ...input, operationId: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteDocumentAutomation(row.id, 'admin', { ...input, operationId: randomUUID(), expectedVersion: 3 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(updates).toEqual([]); expect(jobs[0]!.deletedAt).toBeNull();
  });
  it('refuses deletion while an already requested individual export can still create a file', async () => {
    const row = job(); ownedDraft(row); jobs = [row]; selectionReturns.set(documentExports, [{ fileId: null, status: 'running' }]);
    await expect(deleteDocumentAutomation(row.id, 'admin', { operationId: randomUUID(), expectedVersion: 4, reason: '取消' })).rejects.toMatchObject({ code: 'DOCUMENT_EXPORT_BUSY' });
    expect(updates).toEqual([]); expect(jobs[0]!.deletedAt).toBeNull();
  });
  it('hides deleted jobs and refuses reads, requirements, retry, supplement and delayed worker execution', async () => {
    const row = job({ deletedAt: at, deletedBy: 'admin', deletionReason: '取消', status: 'queued' }); jobs = [row];
    await expect(getDocumentAutomation(row.id, 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getDocumentAutomationRequirements(row.id, 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(retryDocumentAutomation(boss, row.id, 'admin', { operationId: randomUUID(), expectedVersion: 4 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(supplementDocumentAutomation(boss, row.id, 'admin', { operationId: randomUUID(), expectedVersion: 4, documentVersions: {}, values: [{ id: 'field', value: 'value' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listDocumentAutomations('admin')).items).toEqual([]); expect(mocks.requirements).not.toHaveBeenCalled(); expect(mocks.supplement).not.toHaveBeenCalled();
    Object.assign(db, { select: tx.select, update: tx.update }); const query = vi.fn().mockResolvedValue({ rows: [{ locked: true }] }); mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    await executeDocumentAutomation(boss, row.id); await reconcileDocumentAutomations(boss);
    expect(updates).toEqual([]); expect(boss.send).not.toHaveBeenCalled();
  });
  it('does not let a deleted old task occupy the same selected FBA on a new task', async () => {
    const selected = candidate(), old = job({ deletedAt: at }); old.items[0]!.demandIds = [selected.demandId]; jobs = [old]; mocks.candidates.mockResolvedValue({ items: [selected] });
    await expect(startDocumentAutomation(boss, 'admin', { operationId: randomUUID(), shippingRunId: old.shippingRunId })).resolves.toHaveProperty('job');
  });
  it('adopts a corrected successor only when its live claims cover the same whole scope and shipping run', async () => {
    const row = job(), item = row.items[0]!, oldId = randomUUID(), newId = randomUUID(); item.documentId = oldId; item.fileId = randomUUID();
    const member = { demand: { id: item.demandIds[0], snapshot: { sid: 12, fba: 'FBA1' } }, source: { demandId: item.demandIds[0] } };
    mocks.locked.mockImplementation(async (_tx, id) => id === oldId ? { record: { id: oldId, status: 'superseded' }, revision: {} } : { record: { id: newId, status: 'draft', version: 9 }, revision: { data: { shippingRunId: row.shippingRunId, members: [member] } } });
    selectionReturns.set(documentMemberClaims, [{ documentId: newId, demandId: item.demandIds[0] }]);
    await resolveAutomationSuccessorInTx(tx as never, row, item);
    expect(item).toMatchObject({ documentId: newId, documentVersion: 9, stage: 'preview', fileId: null, exportId: null });
  });
  it('does not redirect a corrected ticket to another shipping run or a partial/different claim scope', async () => {
    const row = job(), item = row.items[0]!, oldId = randomUUID(), newId = randomUUID(); item.documentId = oldId;
    mocks.locked.mockImplementation(async (_tx, id) => id === oldId ? { record: { id: oldId, status: 'superseded' }, revision: {} } : { record: { id: newId, status: 'draft', version: 2 }, revision: { data: { shippingRunId: randomUUID(), members: [] } } });
    selectionReturns.set(documentMemberClaims, [{ documentId: newId, demandId: item.demandIds[0] }]);
    await resolveAutomationSuccessorInTx(tx as never, row, item); expect(item.documentId).toBe(oldId);
    selectionReturns.set(documentMemberClaims, [{ documentId: newId, demandId: item.demandIds[0] }, { documentId: randomUUID(), demandId: item.demandIds[0] }]);
    await resolveAutomationSuccessorInTx(tx as never, row, item); expect(item.documentId).toBe(oldId);
  });
  it('returns authoritative requirements versions without changing the running checkpoint', async () => {
    const row = job({ mode: 'single_workbook' }), documentId = randomUUID(); row.items[0]!.documentId = documentId; row.items[0]!.documentVersion = 1; jobs = [row];
    mocks.requirements.mockResolvedValue({ descriptors: [], issues: [], documentVersions: { [documentId]: 7 } });
    const response = await getDocumentAutomationRequirements(row.id, 'admin');
    expect(response.job.items[0]!.documentVersion).toBe(7); expect(jobs[0]!.items[0]!.documentVersion).toBe(1); expect(response.job.supplement).toEqual({ descriptors: [], issues: [] });
  });
  it('atomically resumes supplemented and explicitly reviewed changed tickets without exporting a partial batch', async () => {
    const row = job({ mode: 'single_workbook' }), second = structuredClone(row.items[0]!); second.id = randomUUID(); second.documentId = randomUUID(); second.documentVersion = 2; second.status = 'ready'; row.items[0]!.documentId = randomUUID(); row.items[0]!.documentVersion = 1; row.items.push(second); jobs = [row];
    const firstId = row.items[0]!.documentId!;
    mocks.supplement.mockResolvedValue({ documents: [{ itemId: row.items[0]!.id, documentId: firstId, documentVersion: 3 }] });
    const input = { operationId: randomUUID(), expectedVersion: 4, documentVersions: { [firstId]: 1, [second.documentId!]: 5 }, values: [{ id: 'field-vat', value: 'VAT123' }] };
    const response = await supplementDocumentAutomation(boss, row.id, 'admin', input);
    expect(response.job).toMatchObject({ phase: 'preparing', mode: 'single_workbook', bundle: null, status: 'queued' });
    expect(jobs[0]!.items.map((item) => [item.documentVersion, item.stage, item.status])).toEqual([[3, 'prepare', 'queued'], [5, 'prepare', 'queued']]);
    expect(mocks.supplement).toHaveBeenCalledOnce(); expect(boss.send).toHaveBeenCalledOnce();
  });
  it('preserves all inputs and queue state when supplement preparation fails or the batch is busy', async () => {
    const row = job({ mode: 'single_workbook' }); jobs = [row]; const original = structuredClone(row);
    mocks.supplement.mockRejectedValue(Object.assign(new Error('document version changed'), { code: 'VERSION_CONFLICT' }));
    const input = { operationId: randomUUID(), expectedVersion: 4, documentVersions: {}, values: [{ id: 'field-vat', value: 'VAT123' }] };
    await expect(supplementDocumentAutomation(boss, row.id, 'admin', input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }); expect(jobs[0]).toEqual(original); expect(boss.send).not.toHaveBeenCalled();
    tx.execute.mockResolvedValue({ rows: [{ locked: false }] });
    await expect(supplementDocumentAutomation(boss, row.id, 'admin', { ...input, operationId: randomUUID() })).rejects.toMatchObject({ code: 'DOCUMENT_AUTOMATION_BUSY' }); expect(mocks.supplement).toHaveBeenCalledOnce();
  });
  it('atomically accepts one queued scope and replays the same start without another split or enqueue', async () => {
    const input = { operationId: randomUUID(), shippingRunId: randomUUID() };
    const first = await startDocumentAutomation(boss, 'admin', input);
    expect(first).toMatchObject({ replayed: false, job: { status: 'queued', counts: { queued: 1 } } });
    expect(jobs).toHaveLength(1); expect(vi.mocked(boss.send).mock.calls[0]?.[2]?.db).toBeTruthy();
    // The real documentOperation reads its saved result before looking up sources again.
    operationRows[0]!.actorId = 'admin';
    const second = await startDocumentAutomation(boss, 'admin', input);
    expect(second).toEqual({ ...first, replayed: true }); expect(mocks.candidates).toHaveBeenCalledOnce(); expect(boss.send).toHaveBeenCalledOnce();
  });
  it('rolls back the task if its durable queue rejects acceptance', async () => {
    vi.mocked(boss.send).mockResolvedValue(null);
    await expect(startDocumentAutomation(boss, 'admin', { operationId: randomUUID(), shippingRunId: randomUUID() })).rejects.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
    expect(jobs).toEqual([]); expect(operationRows).toEqual([]);
  });
  it('refuses overlapping unfinished work and identifies the resumable existing task', async () => {
    const existing = job(), selected = candidate(); existing.items[0]!.demandIds = [selected.demandId]; jobs = [existing]; mocks.candidates.mockResolvedValue({ items: [selected] });
    await expect(startDocumentAutomation(boss, 'admin', { operationId: randomUUID(), shippingRunId: existing.shippingRunId })).rejects.toMatchObject({ code: 'DOCUMENT_AUTOMATION_BUSY', details: { jobId: existing.id } });
    expect(boss.send).not.toHaveBeenCalled();
  });
  it('binds existing draft adoption to its expected version and shipping run without creating another document', async () => {
    const shippingRunId = randomUUID(), id = randomUUID(), source = candidate();
    mocks.locked.mockResolvedValue({ record: { id, version: 7, status: 'draft' }, revision: { data: { shippingRunId, members: [{ demand: source.demand, source: { demandId: source.demandId } }] } as DocumentRevisionData } });
    const response = await startDocumentAutomation(boss, 'admin', { operationId: randomUUID(), shippingRunId, documentId: id, expectedVersion: 7 });
    expect(mocks.locked).toHaveBeenCalledWith(tx, id, 'admin', 7); expect(response.job.items[0]).toMatchObject({ documentId: id, documentVersion: 7, stage: 'preview' });
    expect(mocks.candidates).not.toHaveBeenCalled(); expect(response.job.counts.queued).toBe(1);
  });
  it('never starts regeneration of an existing draft with a published file', async () => {
    const shippingRunId = randomUUID(), id = randomUUID(); mocks.locked.mockResolvedValue({ record: { id, version: 2, status: 'pending_review' }, revision: { data: { shippingRunId } } });
    selectionReturns.set(documentExports, [{ fileId: randomUUID() }]);
    await expect(startDocumentAutomation(boss, 'admin', { operationId: randomUUID(), shippingRunId, documentId: id, expectedVersion: 2 })).rejects.toMatchObject({ code: 'DOCUMENT_CORRECTION_REQUIRED' });
    expect(jobs).toEqual([]); expect(boss.send).not.toHaveBeenCalled();
  });
  it('persists a selected blocked-ticket retry separately from other running checkpoints', async () => {
    const row = job({ status: 'running', leaseUntil: new Date(Date.now() + 60_000) }), other = structuredClone(row.items[0]!); other.id = randomUUID(); other.status = 'running'; other.stage = 'apply'; other.operations = { '1:apply': { input: { operationId: randomUUID(), expectedVersion: 3 } } }; row.items.push(other); jobs = [row];
    const before = structuredClone(row.items), operationId = randomUUID();
    const response = await retryDocumentAutomation(boss, row.id, 'admin', { operationId, expectedVersion: 4, itemIds: [row.items[0]!.id] });
    expect(jobs[0]!.items).toEqual(before); expect(jobs[0]!.retryRequests).toEqual([{ operationId, itemIds: [row.items[0]!.id] }]);
    expect(response.job.items.map((item) => item.status)).toEqual(['queued', 'running']); expect(response.job.counts).toMatchObject({ queued: 1, running: 1 }); expect(boss.send).toHaveBeenCalledOnce();
  });
  it('marks a fatal job retry to resume the exact checkpoint even after the row becomes queued', async () => {
    const row = job({ status: 'failed', error: { code: 'DATABASE_UNAVAILABLE', message: 'checkpoint interrupted' } }); row.items[0]!.status = 'running';
    row.items[0]!.operations = { '1:prepare': { input: { operationId: randomUUID(), expectedVersion: 3 } } }; jobs = [row];
    const original = structuredClone(row.items), operationId = randomUUID();
    await retryDocumentAutomation(boss, row.id, 'admin', { operationId, expectedVersion: 4 });
    expect(jobs[0]!.status).toBe('queued'); expect(jobs[0]!.items).toEqual(original);
    expect(jobs[0]!.retryRequests).toEqual([{ operationId, itemIds: [row.items[0]!.id], resumeExact: true }]);
  });
  it('never resets a completed file and protects retry actor/version/scope boundaries', async () => {
    const row = job(), complete = structuredClone(row.items[0]!); complete.id = randomUUID(); complete.status = 'completed'; complete.fileId = randomUUID(); complete.stage = 'done'; row.items.push(complete); jobs = [row];
    await expect(retryDocumentAutomation(boss, row.id, 'other-admin', { operationId: randomUUID(), expectedVersion: 4 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(retryDocumentAutomation(boss, row.id, 'admin', { operationId: randomUUID(), expectedVersion: 3 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(retryDocumentAutomation(boss, row.id, 'admin', { operationId: randomUUID(), expectedVersion: 4, itemIds: [randomUUID()] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const response = await retryDocumentAutomation(boss, row.id, 'admin', { operationId: randomUUID(), expectedVersion: 4, itemIds: [complete.id] });
    expect(response.job.items[1]).toMatchObject({ status: 'completed', fileId: complete.fileId }); expect(boss.send).not.toHaveBeenCalled();
  });
  it('requires an active admin for reads and lists recent jobs only for the authenticated actor', async () => {
    const row = job(); jobs = [row];
    expect((await getDocumentAutomation(row.id, 'admin')).job.id).toBe(row.id);
    expect((await listDocumentAutomations('admin')).items).toHaveLength(1); expect(mocks.actor).toHaveBeenCalledWith(tx, 'admin');
    const publicItem = serializeDocumentAutomation(row).items[0]!;
    expect(publicItem).not.toHaveProperty('operations'); expect(publicItem).not.toHaveProperty('sourceDigest');
  });
  it('requeues an orphaned active lease only after acquiring the same session lock used by the worker', async () => {
    const row = job({ status: 'running', leaseUntil: new Date(Date.now() - 60_000) }); jobs = [row];
    Object.assign(db, { select: tx.select, update: tx.update });
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ locked: false }] }).mockResolvedValue({ rows: [{ locked: true }] }); const release = vi.fn(); mocks.connect.mockResolvedValue({ query, release });
    await reconcileDocumentAutomations(boss); expect(boss.send).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    await reconcileDocumentAutomations(boss); expect(boss.send).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), [`document-automation:${row.id}`]);
  });
});
