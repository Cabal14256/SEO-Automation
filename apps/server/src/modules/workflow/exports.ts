import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type { z } from 'zod';
import type { WorkflowExport, workflowExportInputSchema } from '@scm/contracts';
import { db, pool } from '../../db/client.js';
import { fileIndex, operationAudit } from '../../db/schema.js';
import { logError } from '../../errors.js';
import { BatchError } from '../batches/service.js';
import { publishReportFile } from '../batches/report-service.js';
import { checkedFileBytes } from '../imports/service.js';
import { workflowPolicies } from './registry.js';
import { lockedWorkflow, workflowContextInTx, workflowFingerprint, workflowOperation } from './service.js';
import { workflowExports } from './schema.js';

export const WORKFLOW_EXPORT_QUEUE = 'workflow-file-export';
export async function getWorkflowExport(id: string, actorId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(workflowExports).where(eq(workflowExports.id, id));
    if (!row) throw new BatchError('NOT_FOUND', 404, '文件任务不存在。');
    const record = await lockedWorkflow(tx, row.recordId, actorId), context = await workflowContextInTx(tx, record, actorId);
    const item = context.exports.find((entry) => entry.id === id)!;
    const policy = workflowPolicies[record.kind];
    item.valid = item.status === 'completed' && context.sourceValid && row.dependencyHash === workflowFingerprint(policy, record, context, row.purpose);
    item.invalidReason = item.valid ? null : '文件未发布或依赖已有变化，历史文件仅供追溯。';
    return { export: item };
  });
}
export async function requestWorkflowExport(boss: PgBoss, id: string, actorId: string, input: z.infer<typeof workflowExportInputSchema>) {
  return workflowOperation(actorId, input.operationId, 'workflow.export.request', { id, ...input }, async (tx) => {
    const record = await lockedWorkflow(tx, id, actorId, input.expectedVersion), policy = workflowPolicies[record.kind];
    if (!policy.render) throw new BatchError('EXPORT_UNSUPPORTED', 422, '此模块引用来源文件，无需重复生成。');
    const context = await workflowContextInTx(tx, record, actorId), evaluation = policy.evaluate(record, context, `export:${input.purpose}`);
    if (!context.sourceValid || evaluation.issues.some((issue) => issue.severity === 'error')) throw new BatchError('EXPORT_BLOCKED', 422, '文件仍有阻塞项，不能生成。', evaluation.issues);
    const [active] = await tx.select().from(workflowExports).where(and(eq(workflowExports.recordId, id), inArray(workflowExports.status, ['queued', 'running']))).limit(1);
    if (active) throw new BatchError('EXPORT_BUSY', 409, '当前已有文件正在生成。');
    const exportId = randomUUID();
    await tx.insert(workflowExports).values({ id: exportId, recordId: id, version: record.version, purpose: input.purpose, dependencyHash: workflowFingerprint(policy, record, context, input.purpose), snapshot: record, createdBy: actorId });
    const jobId = await boss.send(WORKFLOW_EXPORT_QUEUE, { exportId }, { db: fromDrizzle(tx, sql), retryLimit: 2, retryDelay: 5, expireInSeconds: 300 });
    if (!jobId) throw new BatchError('QUEUE_UNAVAILABLE', 503, '文件任务入队失败，请保留原操作编号重试。');
    await tx.update(workflowExports).set({ queueJobId: jobId }).where(eq(workflowExports.id, exportId));
    const item: WorkflowExport = { id: exportId, recordId: id, version: record.version, purpose: input.purpose, status: 'queued', fileId: null, fileSha256: null, name: null, mimeType: null, error: null, dependencyHash: workflowFingerprint(policy, record, context, input.purpose), createdAt: new Date().toISOString(), completedAt: null };
    return { recordId: id, export: item };
  });
}
export async function executeWorkflowExport(id: string) {
  const connection = await pool.connect(); let locked = false;
  try {
    const lock = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`workflow-export:${id}`]);
    locked = lock.rows[0]?.locked === true; if (!locked) return;
    const [existing] = await db.select().from(workflowExports).where(eq(workflowExports.id, id));
    if (!existing || ['completed', 'stale'].includes(existing.status)) return;
    try {
      const bundle = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('workflow-business',0))`);
        const record = await lockedWorkflow(tx, existing.recordId, existing.createdBy), context = await workflowContextInTx(tx, record, existing.createdBy), policy = workflowPolicies[record.kind];
        if (record.version !== existing.version || !context.sourceValid || existing.dependencyHash !== workflowFingerprint(policy, record, context, existing.purpose) || policy.evaluate(record, context, `export:${existing.purpose}`).issues.some((issue) => issue.severity === 'error')) throw new BatchError('EXPORT_STALE', 409, '来源或资料已变化，请重新校验生成。');
        let templateBytes: Buffer | undefined;
        if (typeof record.data.templateFileId === 'string') { const file = context.files.find((file) => file.id === record.data.templateFileId && file.recordId === record.id && file.purpose === 'template'); if (!file) throw new BatchError('TEMPLATE_REQUIRED', 422, '模板未关联当前资料组。'); const [index] = await tx.select().from(fileIndex).where(eq(fileIndex.id, file.id)); if (!index) throw new BatchError('FILE_UNAVAILABLE', 503, '模板索引缺失。'); templateBytes = await checkedFileBytes(index); }
        await tx.update(workflowExports).set({ status: 'running', error: null }).where(eq(workflowExports.id, id));
        return { record, context, policy, templateBytes };
      });
      const artifact = await bundle.policy.render!(bundle.record, bundle.context, existing.purpose, bundle.templateBytes);
      await publishReportFile({ bytes: artifact.bytes, originalName: artifact.name, mimeType: artifact.mimeType, createdBy: existing.createdBy }, async (file) => {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('workflow-business',0))`);
          const record = await lockedWorkflow(tx, existing.recordId, existing.createdBy), context = await workflowContextInTx(tx, record, existing.createdBy);
          if (record.version !== existing.version || !context.sourceValid || existing.dependencyHash !== workflowFingerprint(bundle.policy, record, context, existing.purpose) || bundle.policy.evaluate(record, context, `export:${existing.purpose}`).issues.some((issue) => issue.severity === 'error')) throw new BatchError('EXPORT_STALE', 409, '文件发布前依赖已变化，未发布过期文件。');
          const [current] = await tx.select().from(workflowExports).where(eq(workflowExports.id, id)).for('update');
          if (current?.status === 'completed') return;
          await tx.insert(fileIndex).values(file);
          await tx.update(workflowExports).set({ status: 'completed', fileId: file.id, error: null, completedAt: new Date() }).where(eq(workflowExports.id, id));
          await tx.insert(operationAudit).values({ id: randomUUID(), action: 'workflow.export.publish', targetId: record.id, actorUserId: existing.createdBy, requestHash: file.sha256, details: { exportId: id, fileId: file.id, purpose: existing.purpose } });
        });
      });
    } catch (error) {
      const [published] = await db.select().from(workflowExports).where(eq(workflowExports.id, id)); if (published?.status === 'completed') return;
      const stale = error instanceof BatchError && [409, 422, 403].includes(error.status);
      await db.update(workflowExports).set({ status: stale ? 'stale' : 'failed', error: error instanceof BatchError ? error.message : '文件生成失败，请核对资料后重试。', completedAt: new Date() }).where(eq(workflowExports.id, id));
      if (!stale) throw error;
    }
  } finally { try { if (locked) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`workflow-export:${id}`]); } finally { connection.release(); } }
}
export async function readWorkflowExport(id: string, actorId: string) {
  const { export: item } = await getWorkflowExport(id, actorId);
  if (!item.fileId || item.status !== 'completed') throw new BatchError('NOT_FOUND', 404, '文件尚未发布。');
  const [file] = await db.select().from(fileIndex).where(eq(fileIndex.id, item.fileId));
  if (!file) throw new BatchError('FILE_UNAVAILABLE', 503, '文件索引缺失。');
  return { file, bytes: await checkedFileBytes(file) };
}
export async function reconcileWorkflowExports(boss: PgBoss) {
  const pending = await db.select().from(workflowExports).where(inArray(workflowExports.status, ['queued', 'running']));
  for (const item of pending) {
    if (!item.queueJobId) continue;
    const job = await boss.getJobById(WORKFLOW_EXPORT_QUEUE, item.queueJobId);
    if (!job || ['failed', 'cancelled', 'completed'].includes(job.state)) await db.update(workflowExports).set({ status: 'failed', error: '生成任务已中断，请检查 Worker 后重新生成。', completedAt: new Date() }).where(and(eq(workflowExports.id, item.id), inArray(workflowExports.status, ['queued', 'running'])));
  }
}
export async function registerWorkflowExportWorker(boss: PgBoss) {
  await boss.createQueue(WORKFLOW_EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 300, deleteAfterSeconds: 0 });
  await boss.work<{ exportId: string }>(WORKFLOW_EXPORT_QUEUE, { batchSize: 1 }, async (jobs) => { for (const job of jobs) await executeWorkflowExport(job.data.exportId); });
  const interval = setInterval(() => void reconcileWorkflowExports(boss).catch((error) => logError('Workflow export reconciliation failed', error)), 5000); interval.unref(); return () => clearInterval(interval);
}
