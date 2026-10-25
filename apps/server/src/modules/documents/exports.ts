import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type { z } from 'zod';
import { documentOperationInputSchema, type DocumentExport, type DocumentExportReference, type DocumentRevisionData } from '@scm/contracts';
import { db, pool } from '../../db/client.js';
import { fileIndex, operationAudit } from '../../db/schema.js';
import { logError } from '../../errors.js';
import { BatchError, freezeGroupForExport, requireBatchActor, type BatchTx } from '../batches/service.js';
import { publishReportFile } from '../batches/report-service.js';
import { checkedFileBytes } from '../imports/service.js';
import { documentDigest, documentExportRulesIssue } from './domain.js';
import { documentDependencyValidityInTx, documentOperation, lockedDocument, serializeDocument, validateDocumentInTx } from './service.js';
import { documentExports, documents } from './schema.js';

export const DOCUMENT_EXPORT_QUEUE = 'document-invoice-export';
export function serializeDocumentExport(row: typeof documentExports.$inferSelect, validity = { valid: row.status === 'completed', invalidReason: row.status === 'completed' ? null : '文件尚未成功发布。' } as { valid: boolean; invalidReason: string | null }, fileSha256: string | null = null): DocumentExport { return { id: row.id, status: row.status as DocumentExport['status'], reference: row.reference, fileId: row.fileId, fileSha256, error: row.error, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null, ...validity }; }
export async function requestDocumentExport(boss: PgBoss, id: string, actorId: string, input: z.infer<typeof documentOperationInputSchema>) {
  return documentOperation(actorId, input.operationId, 'document.export.request', { id, ...input }, async (tx) => {
    const { record, revision } = await lockedDocument(tx, id, actorId, input.expectedVersion);
    const rulesIssue = documentExportRulesIssue(revision.data);
    if (rulesIssue) throw new BatchError(rulesIssue.code, 422, rulesIssue.message);
    const validation = await validateDocumentInTx(tx, id, actorId, input.expectedVersion);
    if (!validation.valid) throw new BatchError('VALIDATION_BLOCKED', 422, '发票仍有阻塞项，不能生成待复核文件。', validation.issues);
    const template = revision.data.templateReference!;
    const reference: DocumentExportReference = { documentId: id, revisionId: revision.id, revisionVersion: revision.version, templateId: template.templateId, templateVersion: template.version, templateSha256: template.sha256, sources: revision.data.members.map((member) => member.source), generationRulesVersion: revision.data.generationRulesVersion };
    const [running] = await tx.select().from(documentExports).where(and(sql`${documentExports.reference}->>'documentId' = ${id}`, inArray(documentExports.status, ['queued', 'running']))).limit(1);
    if (running) throw new BatchError('DOCUMENT_EXPORT_BUSY', 409, '当前发票正在生成，请等待任务完成或失败后再重试。');
    const exportId = randomUUID();
    const [row] = await tx.insert(documentExports).values({ id: exportId, operationId: input.operationId, requestHash: documentDigest(reference), reference, createdBy: actorId }).returning();
    const jobId = await boss.send(DOCUMENT_EXPORT_QUEUE, { exportId }, { db: fromDrizzle(tx, sql), retryLimit: 2, retryDelay: 5, expireInSeconds: 180 });
    if (!jobId) throw new BatchError('QUEUE_UNAVAILABLE', 503, '发票生成任务入队失败，请保持操作编号重试。');
    await tx.update(documentExports).set({ queueJobId: jobId }).where(eq(documentExports.id, exportId));
    const [updated] = await tx.update(documents).set({ status: 'pending_review', updatedAt: new Date() }).where(eq(documents.id, id)).returning();
    return { documentId: id, document: serializeDocument(updated ?? record, revision), export: serializeDocumentExport(row!) };
  });
}
export type DocumentWorkbookFactory = (data: DocumentRevisionData, templateBytes: Buffer, exportId: string) => Promise<Buffer>;
export async function executeDocumentExport(id: string, options: { createWorkbook?: DocumentWorkbookFactory } = {}) {
  const connection = await pool.connect(); let locked = false;
  try {
  const lock = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`document-export:${id}`]);
  locked = lock.rows[0]?.locked === true; if (!locked) return;
  const [row] = await db.select().from(documentExports).where(eq(documentExports.id, id));
  if (!row || row.status === 'completed' || row.status === 'stale') return;
  try {
    const prepared = await db.transaction(async (tx) => {
      const { record, revision } = await lockedDocument(tx, row.reference.documentId, row.createdBy);
      const [current] = await tx.select().from(documentExports).where(eq(documentExports.id, id)).for('update');
      if (!current || current.status === 'completed') return null;
      if (record.currentRevisionId !== row.reference.revisionId || revision.version !== row.reference.revisionVersion || ['cancelled', 'superseded'].includes(record.status)) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '生成前单据修订已变化或被取消。');
      const rulesIssue = documentExportRulesIssue(revision.data, row.reference);
      if (rulesIssue) throw new BatchError(rulesIssue.code, 409, rulesIssue.message);
      const validation = await validateDocumentInTx(tx, record.id, row.createdBy);
      if (!validation.valid) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '生成前来源或资料版本已变化。', validation.issues);
      const reference = revision.data.templateReference;
      if (!reference || reference.templateId !== row.reference.templateId || reference.version !== row.reference.templateVersion || reference.sha256 !== row.reference.templateSha256 || documentDigest(revision.data.members.map((member) => member.source)) !== documentDigest(row.reference.sources)) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '生成引用与当前修订不一致。');
      const [template] = await tx.select().from(fileIndex).where(eq(fileIndex.id, reference.fileId));
      if (!template || template.sha256 !== reference.sha256) throw new BatchError('FILE_UNAVAILABLE', 503, '模板文件索引缺失或哈希不符。');
      const templateBytes = await checkedFileBytes(template);
      await tx.update(documentExports).set({ status: 'running', error: null }).where(eq(documentExports.id, id));
      return { data: revision.data, templateBytes };
    });
    if (!prepared) return;
    const createWorkbook = options.createWorkbook ?? (await import('./workbook.js')).createWorkbook;
    const bytes = await createWorkbook(prepared.data, prepared.templateBytes, id);
    await publishReportFile({ bytes, originalName: `${prepared.data.title}-${id.slice(0, 8)}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: row.createdBy }, async (file) => {
      await db.transaction(async (tx) => {
        const { record, revision } = await lockedDocument(tx, row.reference.documentId, row.createdBy);
        const [current] = await tx.select().from(documentExports).where(eq(documentExports.id, id)).for('update');
        if (!current || current.status !== 'running' || current.fileId) throw new BatchError('DOCUMENT_EXPORT_STATE', 409, '生成任务状态已变化，文件未重复发布。');
        if (record.currentRevisionId !== row.reference.revisionId || revision.version !== row.reference.revisionVersion || ['cancelled', 'superseded'].includes(record.status)) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '发布前单据修订已变化或被取消。');
        const rulesIssue = documentExportRulesIssue(revision.data, row.reference);
        if (rulesIssue) throw new BatchError(rulesIssue.code, 409, rulesIssue.message);
        const validation = await validateDocumentInTx(tx, record.id, row.createdBy); if (!validation.valid) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '发布前来源或资料版本已变化。', validation.issues);
        await tx.insert(fileIndex).values(file);
        for (const source of [...new Map(row.reference.sources.map((entry) => [entry.groupId, entry])).values()].sort((left, right) => left.groupId.localeCompare(right.groupId))) await freezeGroupForExport(tx, source.groupId, source.m2ConfirmationId, row.createdBy);
        await tx.update(documentExports).set({ status: 'completed', fileId: file.id, error: null, completedAt: new Date() }).where(eq(documentExports.id, id));
        await tx.insert(operationAudit).values({ id: randomUUID(), action: 'document.export.publish', targetId: record.id, actorUserId: row.createdBy, requestHash: file.sha256, details: { exportId: id, revisionId: revision.id, fileId: file.id, fileSha256: file.sha256 } });
      });
    });
  } catch (error) {
    const [published] = await db.select().from(documentExports).where(eq(documentExports.id, id)); if (published?.status === 'completed') return;
    const stale = error instanceof BatchError && [409, 422].includes(error.status), message = error instanceof BatchError ? error.message : '发票生成失败，请检查模板和 Worker 后重试。';
    if (error instanceof BatchError && error.code === 'DOCUMENT_EXPORT_RULES_STALE') {
      await db.transaction(async (tx) => {
        const { record } = await lockedDocument(tx, row.reference.documentId, row.createdBy);
        await tx.update(documentExports).set({ status: 'stale', error: message, completedAt: new Date() }).where(and(eq(documentExports.id, id), inArray(documentExports.status, ['queued', 'running', 'failed'])));
        const [completed] = await tx.select({ id: documentExports.id }).from(documentExports).where(and(eq(documentExports.status, 'completed'), sql`${documentExports.reference}->>'documentId' = ${record.id}`)).limit(1);
        if (!completed && record.status === 'pending_review' && record.currentRevisionId === row.reference.revisionId) await tx.update(documents).set({ status: 'draft', updatedAt: new Date() }).where(eq(documents.id, record.id));
      });
    } else await db.update(documentExports).set({ status: stale ? 'stale' : 'failed', error: message, completedAt: new Date() }).where(and(eq(documentExports.id, id), inArray(documentExports.status, ['queued', 'running', 'failed'])));
    if (!stale) { logError('Document export failed', error); throw error; }
  }
  } finally {
    let failedUnlock = false;
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`document-export:${id}`]); }
    catch { failedUnlock = true; }
    finally { connection.release(failedUnlock); }
  }
}
async function exportValidityInTx(tx: BatchTx, row: typeof documentExports.$inferSelect, actorId: string) {
  if (!row.reference.bundleJobId) return documentDependencyValidityInTx(tx, row.reference.documentId, row.reference.revisionId, actorId);
  try { await (await import('./document-bundle.js')).assertDocumentBundleValidInTx(tx, row.reference.bundleJobId, actorId, { historicalExport: true }); return { valid: true, invalidReason: null }; }
  catch (error) { if (error instanceof BatchError && [409, 422, 503].includes(error.status)) return { valid: false, invalidReason: error.message }; throw error; }
}
export async function getDocumentExport(id: string, actorId: string) { return db.transaction(async (tx) => { await requireBatchActor(tx, actorId); const [row] = await tx.select().from(documentExports).where(eq(documentExports.id, id)); if (!row) throw new BatchError('NOT_FOUND', 404, '发票生成任务不存在。'); const [file] = row.fileId ? await tx.select().from(fileIndex).where(eq(fileIndex.id, row.fileId)) : []; return { export: serializeDocumentExport(row, row.status === 'completed' ? await exportValidityInTx(tx, row, actorId) : undefined, file?.sha256 ?? null) }; }); }
export async function listDocumentExports(documentId: string, actorId: string) { return db.transaction(async (tx) => { await requireBatchActor(tx, actorId); const rows = await tx.select().from(documentExports).where(sql`${documentExports.reference}->>'documentId' = ${documentId}`).orderBy(desc(documentExports.createdAt)); const items: DocumentExport[] = []; for (const row of rows) { const [file] = row.fileId ? await tx.select().from(fileIndex).where(eq(fileIndex.id, row.fileId)) : []; items.push(serializeDocumentExport(row, row.status === 'completed' ? await exportValidityInTx(tx, row, actorId) : undefined, file?.sha256 ?? null)); } return { items }; }); }
export async function readDocumentExport(id: string, actorId: string) { await db.transaction((tx) => requireBatchActor(tx, actorId)); const [row] = await db.select().from(documentExports).where(and(eq(documentExports.id, id), eq(documentExports.status, 'completed'))); if (!row?.fileId) throw new BatchError('NOT_FOUND', 404, '发票文件尚未发布或不存在。'); if (row.reference.bundleJobId) { const result = await (await import('./document-bundle.js')).readDocumentBundle(row.reference.bundleJobId, actorId, { historicalExport: true }); if (result.file.id !== row.fileId) throw new BatchError('FILE_UNAVAILABLE', 503, '整批文件引用不符。'); return result; } const [file] = await db.select().from(fileIndex).where(eq(fileIndex.id, row.fileId)); if (!file) throw new BatchError('FILE_UNAVAILABLE', 503, '发票文件索引缺失。'); return { file, bytes: await checkedFileBytes(file) }; }
export async function reconcileDocumentExports(boss: PgBoss) {
  const rows = await db.select().from(documentExports).where(inArray(documentExports.status, ['queued', 'running'])).limit(100);
  for (const row of rows) {
    const [job] = row.queueJobId ? await boss.findJobs(DOCUMENT_EXPORT_QUEUE, { id: row.queueJobId }) : [];
    const orphaned = row.status === 'running' && job?.state === 'active';
    if (!orphaned && job && !['failed', 'cancelled', 'completed'].includes(job.state)) continue;
    const connection = await pool.connect(); let locked = false;
    try {
      const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`document-export:${row.id}`]);
      locked = result.rows[0]?.locked === true; if (!locked) continue;
      await db.transaction(async (tx) => { const [current] = await tx.select().from(documentExports).where(eq(documentExports.id, row.id)).for('update'); if (!current || current.queueJobId !== row.queueJobId || !['queued', 'running'].includes(current.status) || orphaned && current.status !== 'running') return; await tx.update(documentExports).set({ status: 'failed', error: '生成任务中断或超时，请核对后重新生成。', completedAt: new Date() }).where(eq(documentExports.id, row.id)); });
    } finally { let failedUnlock = false; try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`document-export:${row.id}`]); } catch { failedUnlock = true; } finally { connection.release(failedUnlock); } }
  }
}
export async function registerDocumentExportWorker(boss: PgBoss) { await boss.createQueue(DOCUMENT_EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 180, deleteAfterSeconds: 0 }); await boss.work<{ exportId: string }>(DOCUMENT_EXPORT_QUEUE, { batchSize: 1 }, async (jobs) => { for (const job of jobs) await executeDocumentExport(job.data.exportId); }); const interval = setInterval(() => void reconcileDocumentExports(boss).catch((error) => logError('Document export reconciliation failed', error)), 5000); interval.unref(); return () => clearInterval(interval); }
