import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { documentAutomationJobSchema, documentCreateInputSchema, documentLingxingPreviewSchema, type DocumentAutomationJob, type DocumentAutomationRetryInput, type DocumentAutomationStartInput, type DocumentAutomationSupplementInput, type DocumentCandidate, type DocumentRevisionData } from '@scm/contracts';
import { db, pool } from '../../db/client.js';
import { logError } from '../../errors.js';
import { operationAudit } from '../../db/schema.js';
import { batchOperations } from '../batches/schema.js';
import { BatchError, requireBatchActor, type BatchTx } from '../batches/service.js';
import { ImportError } from '../imports/service.js';
import { LingxingReadError } from '../lingxing/read-client.js';
import { documentDigest, memberFromCandidate } from './domain.js';
import { documentAutomationJobs } from './automation-schema.js';
import { advanceAutomationItem, automationOperationId, automationSourceDigest, automationSummary, candidateItem, groupAutomationCandidates, resetAutomationRetry, shouldReplayAutomationRequest, type AutomationServices } from './automation-engine.js';
import { documentExports, documentMemberClaims, documents } from './schema.js';
import { createDocument, documentCandidatesInTx, documentOperation, getDocument, listDocumentCandidates, lockedDocument, validateDocument } from './service.js';
import { applyDocumentLingxing, previewDocumentLingxing } from './lingxing-sync.js';
import { getDocumentExport, listDocumentExports, requestDocumentExport } from './exports.js';
import { prepareDocumentAutomation } from './automatic-preparation.js';
import type { StoredDocumentAutomationItem } from './automation-types.js';
import { applyDocumentAutomationSupplementInTx, getDocumentAutomationRequirementsInTx } from './automation-supplement.js';
import { preflightDocumentBundle, publishDocumentBundle } from './document-bundle.js';
import { DocumentWorkbookError } from './workbook-errors.js';
import { assertLifecycleActiveInTx } from '../shipping-lifecycle/guards.js';

export const DOCUMENT_AUTOMATION_QUEUE = 'document-invoice-automation';
type Job = typeof documentAutomationJobs.$inferSelect;
const automationListColumns = {
  id: documentAutomationJobs.id, shippingRunId: documentAutomationJobs.shippingRunId, version: documentAutomationJobs.version,
  status: documentAutomationJobs.status, mode: documentAutomationJobs.mode, phase: documentAutomationJobs.phase, bundle: documentAutomationJobs.bundle,
  items: documentAutomationJobs.items, error: documentAutomationJobs.error, retryRequests: documentAutomationJobs.retryRequests,
  createdAt: documentAutomationJobs.createdAt, updatedAt: documentAutomationJobs.updatedAt, completedAt: documentAutomationJobs.completedAt, deletedAt: documentAutomationJobs.deletedAt,
};
type AutomationReadRow = Pick<Job, keyof typeof automationListColumns>;
const leaseTime = () => new Date(Date.now() + 120_000);
const activeStatuses = ['queued', 'running'];
export const documentAutomationError = (error: unknown) => error instanceof DocumentWorkbookError || error instanceof BatchError || error instanceof ImportError || error instanceof LingxingReadError
  ? { code: error.code, message: error.message } : { code: 'DOCUMENT_AUTOMATION_FAILED', message: '自动出单暂未完成，已保存成功步骤，请续跑。' };

/** Retry intentions are a separate column, so an in-flight checkpoint cannot overwrite them. */
function visibleItems(row: AutomationReadRow): StoredDocumentAutomationItem[] {
  const requested = new Set(row.retryRequests.flatMap((request) => request.itemIds));
  return row.items.map((item) => requested.has(item.id) && item.status === 'blocked' ? { ...item, status: 'queued', error: null } : item);
}
export function serializeDocumentAutomation(row: AutomationReadRow): DocumentAutomationJob {
  const items = visibleItems(row), summary = automationSummary(items);
  const phase = row.mode === 'single_workbook' ? row.bundle?.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : row.bundle?.status === 'running' ? 'generating'
    : summary.counts.queued || summary.counts.running || summary.counts.exporting ? 'preparing' : summary.counts.blocked ? 'needs_input' : 'ready'
    : row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : row.phase ?? 'preparing';
  return documentAutomationJobSchema.parse({ id: row.id, shippingRunId: row.shippingRunId, version: row.version,
    status: row.status === 'failed' && !row.retryRequests.length ? 'failed' : summary.status,
    items: items.map(({ id, demandIds, fbas, documentId, documentVersion, exportId, fileId, stage, status, issues, error, attempt }) => ({ id, demandIds, fbas, documentId, documentVersion, exportId, fileId, stage, status, issues, error, attempt })), counts: summary.counts,
    mode: row.mode ?? 'legacy', phase, bundle: row.bundle ?? null, supplement: null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), completedAt: row.retryRequests.length ? null : row.completedAt?.toISOString() ?? null, error: row.error });
}
async function enqueue(tx: BatchTx, boss: PgBoss, id: string) {
  const queueJobId = await boss.send(DOCUMENT_AUTOMATION_QUEUE, { automationId: id }, { db: fromDrizzle(tx, sql), retryLimit: 0, expireInSeconds: 7200 });
  if (!queueJobId) throw new BatchError('QUEUE_UNAVAILABLE', 503, '自动出单队列暂不可用，请保持操作编号重试。');
  await tx.update(documentAutomationJobs).set({ queueJobId }).where(eq(documentAutomationJobs.id, id)); return queueJobId;
}
async function availableCandidates(tx: BatchTx, actorId: string, input: DocumentAutomationStartInput): Promise<DocumentCandidate[]> {
  const scope = await documentCandidatesInTx(tx, actorId, { shippingRunId: input.shippingRunId });
  if (!input.demandIds) return scope.items;
  const ids = new Set(input.demandIds), result = scope.items.filter((item) => ids.has(item.demandId));
  if (result.length !== ids.size) throw new BatchError('DOCUMENT_MEMBER_UNAVAILABLE', 422, '所选 FBA 不属于本次发货的有效完整制表确认，请刷新后选择。');
  return result;
}
export async function startDocumentAutomation(boss: PgBoss, actorId: string, input: DocumentAutomationStartInput) {
  return documentOperation(actorId, input.operationId, 'document.automation.start', input, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-automation-run:${input.shippingRunId}`},0))`);
    let items: StoredDocumentAutomationItem[];
    if (input.documentId) {
      const { record, revision } = await lockedDocument(tx, input.documentId, actorId, input.expectedVersion);
      if (revision.data.shippingRunId !== input.shippingRunId) throw new BatchError('DOCUMENT_SCOPE_MISMATCH', 422, '所选草稿不属于本次发货。');
      if (['cancelled', 'superseded'].includes(record.status)) throw new BatchError('DOCUMENT_READ_ONLY', 409, '该单据已结束，请查看历史或建立更正单据。');
      const existing = await tx.select().from(documentExports).where(sql`${documentExports.reference}->>'documentId' = ${record.id}`);
      if (existing.some((entry) => entry.fileId)) throw new BatchError('DOCUMENT_CORRECTION_REQUIRED', 409, '该票已有生成文件，请查看文件或通过更正单据处理。');
      const item: StoredDocumentAutomationItem = { id: randomUUID(), demandIds: revision.data.members.map((member) => member.demand.id), fbas: revision.data.members.map((member) => member.demand.snapshot.fba),
        documentId: record.id, documentVersion: record.version, exportId: null, fileId: null, stage: 'preview', status: 'queued', issues: [], error: null, attempt: 1, sourceDigest: automationSourceDigest(revision.data.members), operations: {} };
      items = [item];
    } else {
      const candidates = await availableCandidates(tx, actorId, input);
      if (!candidates.length) throw new BatchError('DOCUMENT_MEMBER_UNAVAILABLE', 422, '本次发货尚无可出单的完整 FBA，请先完成制表确认。');
      items = groupAutomationCandidates(candidates).map((group) => candidateItem(group, randomUUID()));
    }
    const ids = new Set(items.flatMap((item) => item.demandIds));
    const others = await tx.select().from(documentAutomationJobs).where(and(isNull(documentAutomationJobs.deletedAt), eq(documentAutomationJobs.shippingRunId, input.shippingRunId), inArray(documentAutomationJobs.status, ['queued', 'running', 'partial', 'blocked', 'failed'])));
    const occupied = others.find((job) => !job.deletedAt && job.items.some((item) => item.status !== 'completed' && item.demandIds.some((id) => ids.has(id))));
    if (occupied) throw new BatchError('DOCUMENT_AUTOMATION_BUSY', 409, '所选 FBA 已有自动出单任务，请继续该任务。', { jobId: occupied.id });
    const summary = automationSummary(items), id = randomUUID();
    const [row] = await tx.insert(documentAutomationJobs).values({ id, operationId: input.operationId, requestHash: documentDigest(input), shippingRunId: input.shippingRunId,
      status: summary.status, mode: 'single_workbook', phase: 'preparing', fields: input.fields ?? {}, title: input.title ?? null, items, createdBy: actorId,
      completedAt: null }).returning();
    if (summary.counts.queued) await enqueue(tx, boss, id);
    return { job: serializeDocumentAutomation(row!) };
  });
}
export async function getDocumentAutomation(id: string, actorId: string) {
  return db.transaction(async (tx) => { await requireBatchActor(tx, actorId); const [row] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, id));
    if (!row || row.deletedAt) throw new BatchError('NOT_FOUND', 404, '自动出单任务不存在。'); return { job: serializeDocumentAutomation(row) }; });
}
export async function listDocumentAutomations(actorId: string, shippingRunId?: string) {
  return db.transaction(async (tx) => { await requireBatchActor(tx, actorId);
    const rows = await tx.select(automationListColumns).from(documentAutomationJobs).where(and(isNull(documentAutomationJobs.deletedAt), eq(documentAutomationJobs.createdBy, actorId), shippingRunId ? eq(documentAutomationJobs.shippingRunId, shippingRunId) : undefined)).orderBy(desc(documentAutomationJobs.createdAt)).limit(30);
    return { items: rows.filter((row) => !row.deletedAt).map(serializeDocumentAutomation) }; });
}
/** The prepared create input is not ownership: only its committed, exact idempotency result is. */
async function automationOwnedDraftsInTx(tx: BatchTx, row: Job) {
  const owned: Array<{ item: StoredDocumentAutomationItem; documentId: string; createdVersion: number }> = [];
  for (const item of row.items) {
    const input = item.operations.create?.input, parsed = documentCreateInputSchema.safeParse(input);
    const operationId = automationOperationId(row.id, item.id, 'create');
    if (!parsed.success || parsed.data.operationId !== operationId || parsed.data.shippingRunId !== row.shippingRunId || parsed.data.purpose !== 'invoice'
      || documentDigest([...parsed.data.demandIds].sort()) !== documentDigest([...item.demandIds].sort())) continue;
    const entries = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, operationId));
    const creation = entries.find((entry) => entry.operationId === operationId);
    if (!creation || creation.action !== 'document.create' || creation.actorId !== row.createdBy || creation.requestHash !== documentDigest({ action: 'document.create', input })) continue;
    const initial = creation.result.document as { id?: string; version?: number; currentRevision?: { data?: DocumentRevisionData } } | undefined;
    const data = initial?.currentRevision?.data, documentId = creation.result.documentId;
    if (typeof documentId !== 'string' || initial?.id !== documentId || !initial.version || !data || data.shippingRunId !== row.shippingRunId || !Array.isArray(data.members)
      || documentDigest(data.members.map((member) => member.demand.id).sort()) !== documentDigest([...item.demandIds].sort())
      || item.documentId && item.documentId !== documentId) continue;
    owned.push({ item, documentId, createdVersion: initial.version });
  }
  return owned.sort((left, right) => left.documentId.localeCompare(right.documentId));
}
/** Soft deletion shares the worker lock. A busy worker must finish its current pass before deletion can commit. */
export async function deleteDocumentAutomation(id: string, actorId: string, input: { operationId: string; expectedVersion: number; reason: string }) {
  return documentOperation(actorId, input.operationId, 'document.automation.delete', { id, ...input }, async (tx) => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`document-automation:${id}`},0)) AS locked`);
    if (!(lock as unknown as { rows: Array<{ locked: boolean }> }).rows?.[0]?.locked) throw new BatchError('DOCUMENT_AUTOMATION_BUSY', 409, '自动出单正在处理，请等待本轮结束后取消并删除。');
    const [row] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, id)).for('update');
    if (!row || row.deletedAt) throw new BatchError('NOT_FOUND', 404, '自动出单任务不存在或已删除。');
    if (row.createdBy !== actorId) throw new BatchError('FORBIDDEN', 403, '只能删除当前账号提交的自动出单任务。');
    if (row.version !== input.expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '自动出单进度已变化，请刷新后取消并删除。');
    const owned = await automationOwnedDraftsInTx(tx, row), cancelledDocumentIds: string[] = [], preservedDocumentIds = new Set(row.items.flatMap((item) => item.documentId ? [item.documentId] : []));
    const documentIds = [...new Set([...preservedDocumentIds, ...owned.map((entry) => entry.documentId)])];
    if (documentIds.length) {
      const exports = await tx.select().from(documentExports).where(and(inArray(sql<string>`${documentExports.reference}->>'documentId'`, documentIds), inArray(documentExports.status, ['queued', 'running'])));
      if (exports.some((entry) => ['queued', 'running'].includes(entry.status))) throw new BatchError('DOCUMENT_EXPORT_BUSY', 409, '本任务的单据仍有文件正在生成，请等待完成后取消并删除；既有文件将保留。');
    }
    for (const { item, documentId, createdVersion } of owned) {
      preservedDocumentIds.add(documentId);
      const { record, revision } = await lockedDocument(tx, documentId, actorId);
      if (record.createdBy !== row.createdBy || record.purpose !== 'invoice' || record.status !== 'draft' || record.version !== (item.documentVersion ?? createdVersion)
        || revision.data.shippingRunId !== row.shippingRunId || documentDigest(revision.data.members.map((member) => member.demand.id).sort()) !== documentDigest([...item.demandIds].sort())) continue;
      // Even failed/queued exports and another task's adoption retain the document and every claim.
      const exports = await tx.select().from(documentExports).where(sql`${documentExports.reference}->>'documentId' = ${documentId}`);
      if (exports.length) continue;
      const users = await tx.select().from(documentAutomationJobs).where(sql`${documentAutomationJobs.id} <> ${id} AND ${documentAutomationJobs.items} @> ${JSON.stringify([{ documentId }])}::jsonb`);
      if (users.some((other) => other.id !== id && other.items.some((entry) => entry.documentId === documentId))) continue;
      await tx.update(documentMemberClaims).set({ releasedAt: new Date() }).where(and(eq(documentMemberClaims.documentId, documentId), isNull(documentMemberClaims.releasedAt)));
      await tx.update(documents).set({ status: 'cancelled', version: record.version + 1, updatedAt: new Date() }).where(eq(documents.id, documentId));
      await tx.insert(operationAudit).values({ id: randomUUID(), action: 'document.cancel', targetId: documentId, actorUserId: actorId, requestHash: documentDigest({ id, documentId, ...input }),
        details: { operationId: input.operationId, automationId: id, reason: input.reason } });
      cancelledDocumentIds.push(documentId); preservedDocumentIds.delete(documentId);
    }
    const deletedAt = new Date(), version = row.version + 1;
    await tx.update(documentAutomationJobs).set({ deletedAt, deletedBy: actorId, deletionReason: input.reason, retryRequests: [], queueJobId: null, leaseUntil: null,
      status: 'failed', error: { code: 'DOCUMENT_AUTOMATION_DELETED', message: '自动出单任务已取消并删除。' }, completedAt: row.completedAt ?? deletedAt, updatedAt: deletedAt, version }).where(eq(documentAutomationJobs.id, id));
    const preserved = [...preservedDocumentIds].sort();
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'document.automation.delete.result', targetId: id, actorUserId: actorId, requestHash: documentDigest({ id, ...input }),
      details: { operationId: input.operationId, reason: input.reason, cancelledDocumentIds: cancelledDocumentIds.join(','), preservedDocumentIds: preserved.join(',') } });
    return { automationId: id, version, deleted: true, deletedAt: deletedAt.toISOString(), cancelledDocumentIds, preservedDocumentIds: preserved };
  });
}
export async function getDocumentAutomationRequirements(id: string, actorId: string) {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const [row] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, id));
    if (!row || row.deletedAt) throw new BatchError('NOT_FOUND', 404, '自动出单任务不存在。');
    const { documentVersions, ...supplement } = await getDocumentAutomationRequirementsInTx(tx, actorId, row);
    const job = serializeDocumentAutomation(row); job.supplement = supplement;
    job.items = job.items.map((item) => item.documentId && documentVersions[item.documentId] ? { ...item, documentVersion: documentVersions[item.documentId]! } : item);
    return { job };
  });
}
export async function supplementDocumentAutomation(boss: PgBoss, id: string, actorId: string, input: DocumentAutomationSupplementInput) {
  return documentOperation(actorId, input.operationId, 'document.automation.supplement', { id, ...input }, async (tx) => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`document-automation:${id}`},0)) AS locked`);
    if (!(lock as unknown as { rows: Array<{ locked: boolean }> }).rows?.[0]?.locked) throw new BatchError('DOCUMENT_AUTOMATION_BUSY', 409, '整批任务正在检查，请等待本轮检查结束后保存补充。');
    const [row] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, id)).for('update');
    if (!row || row.deletedAt) throw new BatchError('NOT_FOUND', 404, '自动出单任务不存在。');
    if (row.createdBy !== actorId) throw new BatchError('FORBIDDEN', 403, '只能补充当前账号提交的整批任务。');
    if (row.version !== input.expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '整批检查进度已变化，请保留输入并重新读取。');
    if (row.status === 'completed' || row.bundle?.status === 'completed' || row.phase === 'generating') throw new BatchError('DOCUMENT_READ_ONLY', 409, '任务已完成或整批文件正在生成；调整须建立更正。');
    const result = await applyDocumentAutomationSupplementInTx(tx, actorId, row, input);
    const updatedVersions = new Map(result.documents.map((document) => [document.documentId, document.documentVersion]));
    const items = row.items.map((item) => {
      if (!item.documentId) return item;
      const version = updatedVersions.get(item.documentId) ?? input.documentVersions[item.documentId];
      if (!version || !updatedVersions.has(item.documentId) && item.documentVersion === version) return item.status === 'completed' ? { ...item, status: 'ready' as const, stage: 'ready' as const } : item;
      return { ...item, attempt: item.attempt + 1, documentVersion: version, status: 'queued' as const, stage: 'prepare' as const,
        error: null, retryExact: false, issues: item.issues.filter((issue) => issue.severity === 'warning') };
    });
    const [updated] = await tx.update(documentAutomationJobs).set({ items, mode: 'single_workbook', status: 'queued', phase: 'preparing', bundle: null,
      retryRequests: [], error: null, completedAt: null, updatedAt: new Date(), version: sql`${documentAutomationJobs.version}+1` }).where(eq(documentAutomationJobs.id, id)).returning();
    await enqueue(tx, boss, id); return { job: serializeDocumentAutomation(updated!) };
  });
}
export async function retryDocumentAutomation(boss: PgBoss, id: string, actorId: string, input: DocumentAutomationRetryInput) {
  return documentOperation(actorId, input.operationId, 'document.automation.retry', { id, ...input }, async (tx) => {
    const [row] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, id)).for('update');
    if (!row || row.deletedAt) throw new BatchError('NOT_FOUND', 404, '自动出单任务不存在。');
    if (row.createdBy !== actorId) throw new BatchError('FORBIDDEN', 403, '只能续跑当前账号提交的自动出单任务。');
    if (row.version !== input.expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '自动出单进度已变化，请刷新后续跑。');
    if (row.mode === 'single_workbook' && row.bundle?.status === 'completed') return { job: serializeDocumentAutomation(row) };
    const restartPreparation = ['VERSION_CONFLICT', 'DOCUMENT_SOURCE_STALE', 'DOCUMENT_EXPORT_STALE', 'FILE_UNAVAILABLE'].includes(row.error?.code ?? '');
    if (row.mode === 'single_workbook' && row.items.every((item) => item.status === 'ready') && row.status === 'failed' && !restartPreparation) {
      const [updated] = await tx.update(documentAutomationJobs).set({ status: 'queued', phase: 'ready', bundle: null, error: null, completedAt: null, updatedAt: new Date(), version: sql`${documentAutomationJobs.version}+1` }).where(eq(documentAutomationJobs.id, id)).returning();
      await enqueue(tx, boss, id); return { job: serializeDocumentAutomation(updated!) };
    }
    const eligible = (item: StoredDocumentAutomationItem) => item.status === 'blocked' || row.status === 'failed' && !['completed', 'exporting'].includes(item.status);
    const selected = input.itemIds ? new Set(input.itemIds) : new Set(row.items.filter(eligible).map((item) => item.id));
    if ([...selected].some((itemId) => !row.items.some((item) => item.id === itemId))) throw new BatchError('VALIDATION_ERROR', 422, '续跑范围含其他任务的票。');
    const itemIds = row.items.filter((item) => selected.has(item.id) && eligible(item)).map((item) => item.id);
    if (!itemIds.length) return { job: serializeDocumentAutomation(row) };
    const [updated] = await tx.update(documentAutomationJobs).set({ retryRequests: [...row.retryRequests, { operationId: input.operationId, itemIds, ...(row.status === 'failed' && !restartPreparation ? { resumeExact: true } : {}) }], status: 'queued', mode: 'single_workbook', phase: 'preparing', bundle: null,
      version: sql`${documentAutomationJobs.version}+1`, error: null, completedAt: null, updatedAt: new Date() }).where(eq(documentAutomationJobs.id, id)).returning();
    // Even when another worker is active this is an independent durable intention.
    await enqueue(tx, boss, id); return { job: serializeDocumentAutomation(updated!) };
  });
}

async function existingDocument(item: StoredDocumentAutomationItem, actorId: string, shippingRunId: string) {
  const claims = await db.select().from(documentMemberClaims).where(and(inArray(documentMemberClaims.demandId, item.demandIds), isNull(documentMemberClaims.releasedAt)));
  if (!claims.length) return null;
  const ids = new Set(claims.map((claim) => claim.documentId));
  if (ids.size !== 1 || new Set(claims.map((claim) => claim.demandId)).size !== item.demandIds.length) throw new BatchError('DOCUMENT_MEMBER_CLAIMED', 409, '部分 FBA 已被其他发票占用，请核对已有单据范围。');
  const documentId = [...ids][0]!, current = await getDocument(documentId, actorId);
  if (current.document.currentRevision.data.shippingRunId !== shippingRunId) throw new BatchError('DOCUMENT_SCOPE_MISMATCH', 409, 'FBA 已被另一发货次的发票占用，请查看原单据或建立更正。', { documentId });
  const members = current.document.currentRevision.data.members;
  if (members.length !== item.demandIds.length || members.some((member) => !item.demandIds.includes(member.demand.id))) throw new BatchError('DOCUMENT_MEMBER_CLAIMED', 409, 'FBA 已属于不同范围的发票，请继续原单据或建立更正。', { documentId });
  return { document: current.document, exports: (await listDocumentExports(documentId, actorId)).items };
}
function servicesFor(boss: PgBoss, row: Job): AutomationServices {
  const actorId = row.createdBy;
  return {
    current: async (id) => ({ document: (await getDocument(id, actorId)).document, exports: (await listDocumentExports(id, actorId)).items }),
    existing: (item) => existingDocument(item, actorId, row.shippingRunId),
    sourceDigest: async (ids) => { const scope = await listDocumentCandidates(actorId, { shippingRunId: row.shippingRunId }); const members = scope.items.filter((item) => ids.includes(item.demandId));
      if (members.length !== ids.length) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '部分 FBA 已不在当前有效制表确认中，请核对来源。');
      const issues = members.flatMap((member) => member.blockers).filter((issue) => issue.severity === 'error');
      if (issues.length) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '当前来源仍有阻塞项，请处理后续跑。', issues);
      return automationSourceDigest(members.map(memberFromCandidate)); },
    create: (input) => createDocument(actorId, input), preview: async (id, input) => { const result = await previewDocumentLingxing(id, actorId, input); return { preview: documentLingxingPreviewSchema.parse(result.preview) }; },
    apply: async (id, input) => { const result = await applyDocumentLingxing(id, actorId, input); return { ...result, issues: result.issues.map((issue) => ({ ...issue, severity: 'error' as const })) }; },
    prepare: (id, input) => prepareDocumentAutomation(id, actorId, input), validate: (id, input) => validateDocument(id, actorId, input),
    export: (id, input) => requestDocumentExport(boss, id, actorId, input),
    exportStatus: async (id) => { const result = await getDocumentExport(id, actorId); return { status: result.export.status, fileId: result.export.fileId, error: result.export.error, valid: result.export.valid, invalidReason: result.export.invalidReason }; },
  };
}
async function save(row: Job) {
  const summary = automationSummary(row.items), terminal = !summary.counts.queued && !summary.counts.running && !summary.counts.exporting && !summary.counts.ready;
  const phase = summary.counts.queued || summary.counts.running || summary.counts.exporting ? 'preparing' : summary.counts.blocked ? 'needs_input' : summary.counts.ready ? 'ready' : 'completed';
  const [saved] = await db.update(documentAutomationJobs).set({ items: row.items, status: sql`CASE WHEN jsonb_array_length(${documentAutomationJobs.retryRequests}) > 0 THEN 'queued' ELSE ${summary.status} END`, version: sql`${documentAutomationJobs.version}+1`, updatedAt: new Date(),
    phase, completedAt: sql`CASE WHEN jsonb_array_length(${documentAutomationJobs.retryRequests}) > 0 THEN NULL ELSE ${terminal && row.mode !== 'single_workbook' ? new Date() : null}::timestamptz END`, error: null }).where(and(eq(documentAutomationJobs.id, row.id), isNull(documentAutomationJobs.deletedAt))).returning();
  if (saved) { row.version = saved.version; row.retryRequests = saved.retryRequests; }
}
/** A successor is adopted only by an explicit new retry attempt, never while replaying an uncertain request. */
export async function resolveAutomationSuccessorInTx(tx: BatchTx, row: Pick<Job, 'shippingRunId' | 'createdBy'>, item: StoredDocumentAutomationItem) {
  if (!item.documentId) return;
  const original = await lockedDocument(tx, item.documentId, row.createdBy);
  if (!['superseded', 'cancelled'].includes(original.record.status)) return;
  const claims = await tx.select().from(documentMemberClaims).where(and(inArray(documentMemberClaims.demandId, item.demandIds), isNull(documentMemberClaims.releasedAt))).for('share');
  const ids = [...new Set(claims.map((claim) => claim.documentId))];
  if (ids.length !== 1 || ids[0] === item.documentId || new Set(claims.map((claim) => claim.demandId)).size !== item.demandIds.length) return;
  const successor = await lockedDocument(tx, ids[0]!, row.createdBy), data = successor.revision.data;
  if (['cancelled', 'superseded'].includes(successor.record.status) || data.shippingRunId !== row.shippingRunId || data.members.length !== item.demandIds.length || data.members.some((member) => !item.demandIds.includes(member.demand.id))) return;
  item.documentId = successor.record.id; item.documentVersion = successor.record.version; item.sourceDigest = automationSourceDigest(data.members);
  item.stage = 'preview'; item.exportId = null; item.fileId = null;
}
async function consumeRetries(row: Job) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, row.id)).for('update');
    if (!current?.retryRequests.length || current.deletedAt) return;
    if (current.mode === 'single_workbook' && current.bundle?.status !== 'completed') {
      row.mode = 'single_workbook';
      for (const item of row.items) if (item.status === 'completed') { item.status = 'ready'; item.stage = 'ready'; }
    }
    const ids = new Set(current.retryRequests.flatMap((request) => request.itemIds));
    const exactIds = new Set(current.retryRequests.filter((request) => request.resumeExact).flatMap((request) => request.itemIds));
    for (const item of row.items) if (ids.has(item.id) && !['completed', 'exporting'].includes(item.status)) {
      const resumeExact = item.retryExact || exactIds.has(item.id);
      resetAutomationRetry(item, Boolean(resumeExact));
      if (item.documentId && !resumeExact) await resolveAutomationSuccessorInTx(tx, row, item);
      if (!item.documentId && !resumeExact) {
        const candidates = (await documentCandidatesInTx(tx, row.createdBy, { shippingRunId: row.shippingRunId })).items.filter((candidate) => item.demandIds.includes(candidate.demandId));
        if (candidates.length === item.demandIds.length) item.sourceDigest = automationSourceDigest(candidates.map(memberFromCandidate));
      }
    }
    row.retryRequests = [];
    await tx.update(documentAutomationJobs).set({ items: row.items, retryRequests: [], status: automationSummary(row.items).status, completedAt: null, version: sql`${documentAutomationJobs.version}+1`, updatedAt: new Date() }).where(eq(documentAutomationJobs.id, row.id));
  });
}
export async function executeDocumentAutomation(boss: PgBoss, id: string) {
  const connection = await pool.connect(); let locked = false; let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const lock = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`document-automation:${id}`]);
    locked = lock.rows[0]?.locked === true; if (!locked) return;
    const [row] = await db.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, id));
    if (!row || row.deletedAt || !activeStatuses.includes(row.status) && !row.retryRequests.length) return;
    await db.transaction(async (tx) => { await requireBatchActor(tx, row.createdBy); await assertLifecycleActiveInTx(tx, 'run', row.shippingRunId); });
    await db.update(documentAutomationJobs).set({ leaseUntil: leaseTime(), status: 'running', updatedAt: new Date() }).where(eq(documentAutomationJobs.id, id));
    heartbeat = setInterval(() => void db.update(documentAutomationJobs).set({ leaseUntil: leaseTime() }).where(eq(documentAutomationJobs.id, id)).catch((error) => logError('Automatic invoice lease refresh failed', error)), 30_000); heartbeat.unref();
    const services = servicesFor(boss, row);
    await consumeRetries(row);
    let processed = 0;
    for (const item of [...row.items].sort((left, right) => Number(left.status === 'exporting') - Number(right.status === 'exporting'))) {
      await db.transaction((tx) => assertLifecycleActiveInTx(tx, 'run', row.shippingRunId));
      if (item.status === 'blocked' || item.status === 'completed' || item.status === 'ready') continue;
      try { await advanceAutomationItem(row, item, services, () => save(row)); }
      catch (error) { const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
        item.status = 'blocked'; item.error = documentAutomationError(error); item.retryExact = shouldReplayAutomationRequest({ code: item.error.code, status }, error instanceof BatchError || error instanceof ImportError || error instanceof LingxingReadError);
        if (!item.issues.some((issue) => issue.code === item.error!.code)) item.issues.push({ ...item.error, severity: 'error' });
        await save(row); if (!(error instanceof BatchError || error instanceof ImportError || error instanceof LingxingReadError)) logError('Automatic invoice ticket failed', error); }
      await consumeRetries(row);
      if (++processed >= 3) break;
    }
    await consumeRetries(row); await save(row);
    if (row.mode === 'single_workbook' && row.items.length && row.items.every((item) => item.status === 'ready')) {
      const preflight = await preflightDocumentBundle(row); row.items = preflight.items; await save(row);
      if (row.items.some((item) => item.status !== 'ready')) return;
      const pending = { status: 'running' as const, fileId: null, fileName: null, sheetCount: null, completedAt: null, error: null };
      row.bundle = pending; row.phase = 'generating';
      await db.update(documentAutomationJobs).set({ phase: 'generating', bundle: pending, status: 'running', updatedAt: new Date(), version: sql`${documentAutomationJobs.version}+1` }).where(eq(documentAutomationJobs.id, id));
      await publishDocumentBundle(row, preflight.sources);
    }
  } catch (error) {
    // A lost COMMIT response must never replace an atomically published bundle with a failed checkpoint.
    if (locked) await db.update(documentAutomationJobs).set({ status: 'failed', phase: 'failed', error: documentAutomationError(error), bundle: { status: 'failed', fileId: null, fileName: null, sheetCount: null, completedAt: null, error: documentAutomationError(error) }, completedAt: new Date(), version: sql`${documentAutomationJobs.version}+1`, updatedAt: new Date() }).where(and(eq(documentAutomationJobs.id, id), isNull(documentAutomationJobs.deletedAt), sql`COALESCE(${documentAutomationJobs.bundle}->>'status','') <> 'completed'`));
    logError('Automatic invoice job failed', error);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked && heartbeat) await db.update(documentAutomationJobs).set({ leaseUntil: null }).where(eq(documentAutomationJobs.id, id)).catch(() => undefined);
    let failed = false; try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`document-automation:${id}`]); } catch { failed = true; } finally { connection.release(failed); }
  }
}
export async function reconcileDocumentAutomations(boss: PgBoss) {
  const rows = await db.select().from(documentAutomationJobs).where(and(isNull(documentAutomationJobs.deletedAt), inArray(documentAutomationJobs.status, activeStatuses), or(isNull(documentAutomationJobs.leaseUntil), sql`${documentAutomationJobs.leaseUntil} < now()`))).limit(100);
  for (const row of rows) {
    const [job] = row.queueJobId ? await boss.findJobs(DOCUMENT_AUTOMATION_QUEUE, { id: row.queueJobId }) : [];
    if (job && ['created', 'retry'].includes(job.state)) continue;
    const connection = await pool.connect(); let locked = false;
    try {
      const lock = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`document-automation:${row.id}`]); locked = lock.rows[0]?.locked === true; if (!locked) continue;
      await db.transaction(async (tx) => { const [current] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, row.id)).for('update');
        if (!current || current.deletedAt || !activeStatuses.includes(current.status) || current.queueJobId !== row.queueJobId) return;
        await enqueue(tx, boss, row.id); });
    } finally { let failed = false; try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`document-automation:${row.id}`]); } catch { failed = true; } finally { connection.release(failed); } }
  }
}
export async function registerDocumentAutomationWorker(boss: PgBoss) {
  await boss.createQueue(DOCUMENT_AUTOMATION_QUEUE, { retryLimit: 0, expireInSeconds: 7200, deleteAfterSeconds: 0 });
  await boss.work<{ automationId: string }>(DOCUMENT_AUTOMATION_QUEUE, { batchSize: 1 }, async (jobs) => { for (const job of jobs) await executeDocumentAutomation(boss, job.data.automationId); });
  const interval = setInterval(() => void reconcileDocumentAutomations(boss).catch((error) => logError('Automatic invoice reconciliation failed', error)), 5000); interval.unref();
  return () => clearInterval(interval);
}
