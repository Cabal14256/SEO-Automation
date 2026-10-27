import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { workflowBoxes, workflowListQuerySchema, type WorkflowContext, type WorkflowExport, type WorkflowFile, type WorkflowKind, type WorkflowRecord, type WorkflowSource, type WorkflowWrite } from '@scm/contracts';
import { db } from '../../db/client.js';
import { fileIndex } from '../../db/schema.js';
import { BatchError, requireBatchActor, type BatchTx } from '../batches/service.js';
import { documentOperation, documentDependencyValidityInTx, lockedDocument, documentCandidatesInTx } from '../documents/service.js';
import { documentDigest, memberFromCandidate } from '../documents/domain.js';
import { documents, documentExports, documentReviews } from '../documents/schema.js';
import { checkedFileBytes, ImportError } from '../imports/service.js';
import { workflowAttachments, workflowClaims, workflowExports, workflowRecords, workflowRevisions } from './schema.js';
import type { WorkflowPolicy } from './policy.js';
import { requireWorkflowAvailable } from './maintenance.js';

export const workflowDigest = documentDigest;
export const serializeWorkflow = (row: typeof workflowRecords.$inferSelect): WorkflowRecord => ({ ...row, kind: row.kind as WorkflowKind, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
export async function workflowOperation<T extends Record<string, unknown>>(actorId: string, operationId: string, action: string, input: unknown, execute: (tx: BatchTx) => Promise<T>) {
  return documentOperation(actorId, operationId, action, input, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('workflow-business',0))`);
    return execute(tx);
  });
}
export async function getWorkflowSourceInTx(tx: BatchTx, documentId: string, actorId: string): Promise<WorkflowSource> {
  const { record, revision } = await lockedDocument(tx, documentId, actorId);
  if (record.status !== 'approved') throw new BatchError('SOURCE_NOT_APPROVED', 422, '请先生成并复核有效的 M4 丰信单据。');
  const validity = await documentDependencyValidityInTx(tx, documentId, revision.id, actorId);
  if (!validity.valid) throw new BatchError('SOURCE_STALE', 409, validity.invalidReason ?? '来源单据已失效。');
  const exports = await tx.select().from(documentExports).where(and(eq(documentExports.status, 'completed'), sql`${documentExports.reference}->>'revisionId' = ${revision.id}`)).orderBy(desc(documentExports.createdAt));
  for (const item of exports) {
    if (!item.fileId) continue;
    const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, item.fileId));
    const [review] = await tx.select().from(documentReviews).where(and(eq(documentReviews.exportId, item.id), eq(documentReviews.decision, 'approve'), eq(documentReviews.fileSha256, file?.sha256 ?? ''))).orderBy(desc(documentReviews.reviewedAt)).limit(1);
    if (file && review) { await checkedFileBytes(file); return { documentId, documentRevisionId: revision.id, documentVersion: record.version, exportId: item.id, fileId: file.id, fileSha256: file.sha256, title: revision.data.title, weekStartDate: revision.data.weekStartDate, ...(revision.data.shippingRunId ? { shippingRunId: revision.data.shippingRunId, shippingRunMonth: revision.data.shippingRunMonth, shippingRunSequence: revision.data.shippingRunSequence } : {}), fields: revision.data.fields, members: revision.data.members }; }
  }
  throw new BatchError('SOURCE_REVIEW_REQUIRED', 422, '来源单据没有已复核的有效文件。');
}
export async function sourceValidityInTx(tx: BatchTx, source: WorkflowSource, actorId: string) {
  try {
    const current = await getWorkflowSourceInTx(tx, source.documentId, actorId);
    const valid = current.documentRevisionId === source.documentRevisionId && current.documentVersion === source.documentVersion && current.exportId === source.exportId && current.fileSha256 === source.fileSha256;
    return { valid, invalidReason: valid ? null : '来源单据或已复核文件已变化，请保留外部事实并建立更正。' };
  } catch (error) {
    if (error instanceof ImportError && ['FILE_UNAVAILABLE', 'FILE_INTEGRITY_ERROR'].includes(error.code)) return { valid: false, invalidReason: '来源文件缺失或哈希不符，历史事实保留，请处理文件异常。' };
    if (!(error instanceof BatchError) || ![404, 409, 422].includes(error.status)) throw error;
    return { valid: false, invalidReason: error.message };
  }
}
export async function listWorkflowSources(actorId: string, shippingRunId?: string) {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const rows = await tx.select().from(documents).where(eq(documents.status, 'approved')).orderBy(desc(documents.createdAt));
    const items: WorkflowSource[] = [];
    for (const row of rows) {
      try { const source = await getWorkflowSourceInTx(tx, row.id, actorId); if (!shippingRunId || source.shippingRunId === shippingRunId) items.push(source); }
      catch (error) { if (error instanceof ImportError && ['FILE_UNAVAILABLE', 'FILE_INTEGRITY_ERROR'].includes(error.code)) continue; if (!(error instanceof BatchError) || ![404, 409, 422].includes(error.status)) throw error; }
    }
    return { items };
  });
}
export async function lockedWorkflow(tx: BatchTx, id: string, actorId: string, expectedVersion?: number) {
  await requireBatchActor(tx, actorId);
  const [row] = await tx.select().from(workflowRecords).where(eq(workflowRecords.id, id)).for('update');
  if (!row) throw new BatchError('NOT_FOUND', 404, '业务记录不存在。');
  requireWorkflowAvailable(row.kind);
  if (expectedVersion !== undefined && expectedVersion !== row.version) throw new BatchError('VERSION_CONFLICT', 409, '记录已变化，请保留输入并重新读取。', { currentVersion: row.version });
  return serializeWorkflow(row);
}
export async function workflowContextInTx(tx: BatchTx, record: WorkflowRecord, actorId: string): Promise<WorkflowContext> {
  const relatedBoxes = record.boxIds.length ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${workflowRecords.boxIds}) AS box(id) WHERE box.id IN (${sql.join(record.boxIds.map((id) => sql`${id}`), sql`, `)}))` : sql`false`;
  const rows = await tx.select().from(workflowRecords).where(sql`(${workflowRecords.source}->>'documentId' = ${record.source.documentId} OR ${relatedBoxes})`).orderBy(asc(workflowRecords.id));
  const records = rows.map(serializeWorkflow), ids = [...new Set([record.id, ...records.map((row) => row.id)])];
  const attachments = await tx.select({ attachment: workflowAttachments, file: fileIndex }).from(workflowAttachments).innerJoin(fileIndex, eq(fileIndex.id, workflowAttachments.fileId)).where(inArray(workflowAttachments.recordId, ids));
  const files: WorkflowFile[] = attachments.map(({ attachment, file }) => ({ id: file.id, recordId: attachment.recordId, purpose: attachment.purpose, name: file.originalName, mimeType: file.mimeType, sha256: file.sha256, byteSize: file.byteSize }));
  const exportRows = await tx.select({ row: workflowExports, file: fileIndex }).from(workflowExports).leftJoin(fileIndex, eq(fileIndex.id, workflowExports.fileId)).where(inArray(workflowExports.recordId, ids)).orderBy(desc(workflowExports.createdAt));
  const exports: WorkflowExport[] = exportRows.map(({ row, file }) => ({ id: row.id, recordId: row.recordId, version: row.version, purpose: row.purpose, status: row.status as WorkflowExport['status'], fileId: row.fileId, fileSha256: file?.sha256 ?? null, name: file?.originalName ?? null, mimeType: file?.mimeType ?? null, error: row.error, dependencyHash: row.dependencyHash, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null }));
  const validity = await sourceValidityInTx(tx, record.source, actorId), invalidRecordIds: string[] = [];
  const sourceStates = new Map<string, boolean>([[`${record.source.documentId}:${record.source.documentRevisionId}:${record.source.documentVersion}:${record.source.exportId}`, validity.valid]]);
  for (const peer of records) {
    const key = `${peer.source.documentId}:${peer.source.documentRevisionId}:${peer.source.documentVersion}:${peer.source.exportId}`;
    let valid = sourceStates.get(key);
    if (valid === undefined) { valid = (await sourceValidityInTx(tx, peer.source, actorId)).valid; sourceStates.set(key, valid); }
    if (!valid) invalidRecordIds.push(peer.id);
  }
  return { records, files, exports, sourceValid: validity.valid, sourceInvalidReason: validity.invalidReason, invalidRecordIds };
}
export function workflowFingerprint(policy: WorkflowPolicy, record: WorkflowRecord, context: WorkflowContext, purpose: string) {
  if (policy.fingerprint) return policy.fingerprint(record, context, purpose);
  const boxes = new Set(record.boxIds);
  const peers = context.records.filter((peer) => peer.id !== record.id && peer.boxIds.some((id) => boxes.has(id))), related = new Set([record.id, ...peers.map((peer) => peer.id)]);
  return workflowDigest({ record: { ...record, version: undefined, status: undefined, updatedAt: undefined }, peers: peers.map((peer) => [peer.id, peer.version, peer.status]), files: context.files.filter((file) => record.kind === 'archive' ? related.has(file.recordId) : file.recordId === record.id).map((file) => [file.id, file.sha256]).sort(), exports: record.kind === 'archive' ? context.exports.filter((item) => item.recordId !== record.id && related.has(item.recordId)).map((item) => [item.id, item.status, item.fileId, item.fileSha256]).sort() : undefined });
}
export async function getWorkflowDetail(id: string, actorId: string, policy: WorkflowPolicy) {
  return db.transaction(async (tx) => {
    const record = await lockedWorkflow(tx, id, actorId);
    if (record.kind !== policy.kind) throw new BatchError('NOT_FOUND', 404, '业务类型不匹配。');
    const context = await workflowContextInTx(tx, record, actorId);
    const evaluation = policy.evaluate(record, context, 'read'), issues = evaluation.issues;
    const rows = await tx.select().from(workflowRevisions).where(eq(workflowRevisions.recordId, id)).orderBy(desc(workflowRevisions.version));
    for (const item of context.exports.filter((item) => item.recordId === record.id)) {
      item.valid = item.status === 'completed' && context.sourceValid && item.dependencyHash === workflowFingerprint(policy, record, context, item.purpose);
      item.invalidReason = item.valid ? null : item.status !== 'completed' ? '文件尚未成功发布。' : '来源、资料或关联结果已有变化，历史文件仅供追溯。';
    }
    const status = effectiveStatus(policy, record, context, evaluation);
    return { record: { ...record, status }, context, issues, history: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  });
}
function effectiveStatus(policy: WorkflowPolicy, record: WorkflowRecord, context: WorkflowContext, evaluation = policy.evaluate(record, context, 'read')) {
  if (record.status === 'cancelled') return 'cancelled';
  if (!context.sourceValid) return 'stale';
  if (record.kind === 'archive') {
    if (evaluation.issues.some((issue) => issue.severity === 'error')) return 'pending';
    const archived = context.exports.some((item) => item.recordId === record.id && item.purpose === 'archive-package' && item.status === 'completed' && item.dependencyHash === workflowFingerprint(policy, record, context, item.purpose));
    if (archived) return 'archived';
  }
  if (evaluation.status === 'complete' && evaluation.issues.some((issue) => issue.severity === 'error')) return 'pending';
  return evaluation.status;
}
export async function listWorkflowRecords(actorId: string, kind: WorkflowKind, input: unknown, policy?: WorkflowPolicy) {
  const query = workflowListQuerySchema.parse(input);
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const conditions = [eq(workflowRecords.kind, kind)];
    if (!policy && query.status && query.status !== 'all') conditions.push(eq(workflowRecords.status, query.status));
    if (query.q) conditions.push(sql`(${workflowRecords.title} ILIKE ${`%${query.q}%`} OR ${workflowRecords.source}::text ILIKE ${`%${query.q}%`} OR ${workflowRecords.data}::text ILIKE ${`%${query.q}%`})`);
    if (query.groupId) conditions.push(sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${workflowRecords.source}->'members') m WHERE m->'source'->>'groupId' = ${query.groupId})`);
    const rows = await tx.select().from(workflowRecords).where(and(...conditions)).orderBy(desc(workflowRecords.updatedAt), asc(workflowRecords.id));
    let items = rows.map(serializeWorkflow);
    if (policy) { const evaluated: WorkflowRecord[] = []; for (const record of items) { const context = await workflowContextInTx(tx, record, actorId); evaluated.push({ ...record, status: effectiveStatus(policy, record, context) }); } items = evaluated; }
    if (query.status && query.status !== 'all') items = items.filter((record) => record.status === query.status);
    return { items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize };
  });
}
export async function writeWorkflow(actorId: string, policy: WorkflowPolicy, input: WorkflowWrite, id?: string) {
  return workflowOperation(actorId, input.operationId, `workflow.${policy.kind}.${input.action}`, { id, ...input }, async (tx) => {
    if (id && input.expectedVersion === undefined) throw new BatchError('VERSION_REQUIRED', 422, '修改记录必须提供当前版本。');
    const previous = id ? await lockedWorkflow(tx, id, actorId, input.expectedVersion) : null;
    if (previous && previous.kind !== policy.kind) throw new BatchError('NOT_FOUND', 404, '业务类型不匹配。');
    if (previous?.status === 'cancelled' && input.action !== 'cancel') throw new BatchError('RECORD_CANCELLED', 409, '已取消记录只读，请新建更正记录。');
    if (!previous && !input.sourceDocumentId) throw new BatchError('SOURCE_REQUIRED', 422, '请选择已复核 M4 来源单据。');
    if (previous && input.sourceDocumentId && input.sourceDocumentId !== previous.source.documentId) throw new BatchError('IMMUTABLE_SOURCE', 422, '已有记录不能替换来源，请建立更正记录。');
    let source = previous?.source ?? await getWorkflowSourceInTx(tx, input.sourceDocumentId!, actorId);
    if (!previous && policy.kind === 'archive') {
      const groupId = String(input.data.groupId ?? '');
      const candidates = await documentCandidatesInTx(tx, actorId, { shippingRunId: source.shippingRunId });
      const members = candidates.items.filter((candidate) => candidate.groupId === groupId).map(memberFromCandidate);
      if (!members.length) throw new BatchError('ARCHIVE_GROUP_REQUIRED', 422, '请选择当前有效的发货批次。');
      source = { ...source, members };
      input = { ...input, boxIds: workflowBoxes(source).map((box) => box.id) };
    }
    const boxSet = new Set(workflowBoxes(source).map((box) => box.id));
    if (new Set(input.boxIds).size !== input.boxIds.length || input.boxIds.some((box) => !boxSet.has(box))) throw new BatchError('INVALID_BOX_SCOPE', 422, '箱子范围重复或不属于来源确认。');
    const now = new Date().toISOString();
    const record: WorkflowRecord = { id: previous?.id ?? randomUUID(), kind: policy.kind, title: input.title, version: (previous?.version ?? 0) + 1, status: previous?.status ?? 'draft', source, boxIds: input.boxIds, data: policy.dataSchema.parse(input.data), createdBy: previous?.createdBy ?? actorId, createdAt: previous?.createdAt ?? now, updatedAt: now };
    if (previous && policy.kind === 'finance') {
      const history = await tx.select().from(workflowRevisions).where(eq(workflowRevisions.recordId, previous.id));
      const lines = Array.isArray(record.data.lines) ? record.data.lines : [];
      for (const entry of history.filter((entry) => ['confirmed', 'pending', 'complete'].includes(entry.record.status))) {
        const lockedLines = Array.isArray(entry.record.data.lines) ? entry.record.data.lines : [];
        if (lockedLines.some((line) => !lines.some((candidate) => workflowDigest(candidate) === workflowDigest(line)))) throw new BatchError('IMMUTABLE_CONFIRMED_BILL', 422, '已确认账单行永久保留，补账后也不能删除或改写，请追加退款或调整行。');
      }
    }
    const context = await workflowContextInTx(tx, record, actorId);
    // Evidence bytes are checked before facts relying on them can be accepted.
    for (const file of context.files.filter((file) => file.recordId === record.id)) { const [indexed] = await tx.select().from(fileIndex).where(eq(fileIndex.id, file.id)); if (!indexed) throw new BatchError('FILE_UNAVAILABLE', 503, '附件索引缺失。'); await checkedFileBytes(indexed); }
    const evaluation = policy.evaluate(record, context, input.action);
    const errors = evaluation.issues.filter((issue) => issue.severity === 'error' && (!['save', 'read'].includes(input.action) || /^(?:IMMUTABLE_|INVALID_)/.test(issue.code)));
    if (errors.length) throw new BatchError('WORKFLOW_VALIDATION', 422, errors[0]!.message, evaluation.issues);
    record.status = evaluation.status;
    const values = { ...record, createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt) };
    if (previous) await tx.update(workflowRecords).set(values).where(eq(workflowRecords.id, record.id)); else await tx.insert(workflowRecords).values(values);
    if (evaluation.claims) {
      await tx.update(workflowClaims).set({ releasedAt: new Date() }).where(and(eq(workflowClaims.recordId, record.id), isNull(workflowClaims.releasedAt)));
      for (const claim of evaluation.claims) for (const boxId of claim.boxIds) {
        if (!record.boxIds.includes(boxId)) throw new BatchError('INVALID_BOX_CLAIM', 422, '占用范围必须属于当前记录。');
        const [occupied] = await tx.select().from(workflowClaims).where(and(eq(workflowClaims.purpose, claim.purpose), eq(workflowClaims.boxId, boxId), isNull(workflowClaims.releasedAt)));
        if (occupied) throw new BatchError('BOX_ALREADY_CLAIMED', 409, '所选箱子已被其他有效记录占用。', { boxId, recordId: occupied.recordId });
        await tx.insert(workflowClaims).values({ id: randomUUID(), purpose: claim.purpose, boxId, recordId: record.id });
      }
    }
    await tx.insert(workflowRevisions).values({ id: randomUUID(), recordId: record.id, version: record.version, action: input.action, reason: input.reason, record, createdBy: actorId });
    return { recordId: record.id, record, issues: evaluation.issues };
  });
}
