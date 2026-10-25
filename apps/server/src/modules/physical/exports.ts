import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { physicalExportInputSchema, type PhysicalConfirmation, type PhysicalExportRecord, type PhysicalExportReference } from '@scm/contracts';
import { db, pool } from '../../db/client.js';
import { fileIndex, operationAudit } from '../../db/schema.js';
import { logError } from '../../errors.js';
import { subBatches, weeklyBatches } from '../batches/schema.js';
import { BatchError, freezeGroupForExport, requireBatchActor, type BatchTx } from '../batches/service.js';
import { publishReportFile } from '../batches/report-service.js';
import { getValidPhysicalConfirmationInTx, physicalDigest, physicalOperation } from './service.js';
import { physicalExports } from './schema.js';
import { createPhysicalWorkbook } from './workbook.js';

export const PHYSICAL_EXPORT_QUEUE = 'physical-box-export';
type ExportRow = typeof physicalExports.$inferSelect;
export const physicalReference = (c: PhysicalConfirmation): PhysicalExportReference => ({ groupId: c.groupId, m2ConfirmationId: c.m2ConfirmationId,
  physicalConfirmationId: c.id, m3Version: c.m3Version, sourceFingerprint: c.sourceFingerprint });
async function lockExportGroups(tx: BatchTx, references: PhysicalExportReference[]) {
  const ids = references.map((r) => r.groupId);
  const groups = await tx.select().from(subBatches).where(inArray(subBatches.id, ids));
  if (groups.length !== ids.length) throw new BatchError('NOT_FOUND', 404, '部分实物导出批次不存在。');
  await tx.select().from(weeklyBatches).where(inArray(weeklyBatches.id, [...new Set(groups.map((g) => g.batchId))])).orderBy(asc(weeklyBatches.id)).for('update');
  await tx.select().from(subBatches).where(inArray(subBatches.id, ids)).orderBy(asc(subBatches.id)).for('update');
}
async function validateReferences(tx: BatchTx, references: PhysicalExportReference[], actorId: string) {
  await lockExportGroups(tx, references);
  const confirmations: PhysicalConfirmation[] = [];
  for (const reference of [...references].sort((a, b) => a.groupId.localeCompare(b.groupId))) {
    const confirmation = await getValidPhysicalConfirmationInTx(tx, reference.groupId, actorId);
    if (physicalDigest(physicalReference(confirmation)) !== physicalDigest(reference)) throw new BatchError('VERSION_CONFLICT', 409, '实物确认版本已经变化，请重新预览后导出。');
    confirmations.push(confirmation);
  }
  return confirmations;
}
async function serializeExport(row: ExportRow, actorId: string): Promise<PhysicalExportRecord> {
  let valid = true, invalidReason: string | null = null;
  try { await db.transaction((tx) => validateReferences(tx, row.references, actorId)); }
  catch (error) { if (!(error instanceof BatchError)) throw error; valid = false; invalidReason = error.message; }
  return { id: row.id, status: row.status as PhysicalExportRecord['status'], references: row.references, fileId: row.fileId, error: row.error,
    createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null, boxCount: row.boxCount, valid, invalidReason };
}
export async function getPhysicalExport(id: string, actorId: string) {
  await db.transaction((tx) => requireBatchActor(tx, actorId));
  const [row] = await db.select().from(physicalExports).where(eq(physicalExports.id, id));
  if (!row) throw new BatchError('NOT_FOUND', 404, '实物导出任务不存在。');
  return { export: await serializeExport(row, actorId) };
}
export async function listPhysicalExports(actorId: string, subBatchId?: string) {
  await db.transaction((tx) => requireBatchActor(tx, actorId));
  const rows = await db.select().from(physicalExports).where(subBatchId ? sql`${physicalExports.references} @> ${JSON.stringify([{ groupId: subBatchId }])}::jsonb` : undefined).orderBy(desc(physicalExports.createdAt)).limit(100);
  const items = [];
  for (const row of rows) items.push(await serializeExport(row, actorId));
  return { items };
}
export async function requestPhysicalExport(boss: PgBoss, raw: unknown, actorId: string) {
  const input = physicalExportInputSchema.parse(raw);
  if (new Set(input.references.map((r) => r.groupId)).size !== input.references.length) throw new BatchError('VALIDATION_ERROR', 422, '实物导出范围包含重复组。');
  const result = await physicalOperation(actorId, input.operationId, 'physical.export.submit', input, async (tx) => {
    const projection = await validateReferences(tx, input.references, actorId);
    const id = randomUUID();
    const jobId = await boss.send(PHYSICAL_EXPORT_QUEUE, { exportId: id }, { db: fromDrizzle(tx, sql) });
    if (!jobId) throw new BatchError('QUEUE_UNAVAILABLE', 503, '实物导出任务入队失败。');
    await tx.insert(physicalExports).values({ id, operationId: input.operationId, requestHash: physicalDigest(input), references: input.references, projection,
      queueJobId: jobId, boxCount: projection.reduce((sum, c) => sum + c.snapshot.source.boxes.length, 0), createdBy: actorId });
    return { exportId: id };
  });
  return getPhysicalExport(result.exportId, actorId);
}
export async function executePhysicalExport(id: string, dependencies: { createWorkbook?: typeof createPhysicalWorkbook } = {}) {
  const connection = await pool.connect(); let locked = false;
  try {
    const lock = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`physical-export:${id}`]);
    locked = lock.rows[0]?.locked === true; if (!locked) return;
    const [row] = await db.select().from(physicalExports).where(eq(physicalExports.id, id));
    if (!row || ['completed', 'stale'].includes(row.status)) return;
    await db.update(physicalExports).set({ status: 'running', error: null }).where(eq(physicalExports.id, id));
    try {
      await db.transaction((tx) => validateReferences(tx, row.references, row.createdBy));
      const bytes = await (dependencies.createWorkbook ?? createPhysicalWorkbook)(row.projection);
      await publishReportFile({ bytes, originalName: `实物箱明细-${id.slice(0, 8)}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: row.createdBy }, async (file) => {
        await db.transaction(async (tx) => {
          await requireBatchActor(tx, row.createdBy);
          await validateReferences(tx, row.references, row.createdBy);
          const [current] = await tx.select().from(physicalExports).where(eq(physicalExports.id, id)).for('update');
          if (current?.status !== 'running' || current.fileId) throw new BatchError('EXPORT_STATE_CONFLICT', 409, '任务状态已变化，文件未重复发布。');
          for (const ref of row.references) await freezeGroupForExport(tx, ref.groupId, ref.m2ConfirmationId, row.createdBy);
          await tx.insert(fileIndex).values(file);
          await tx.update(physicalExports).set({ status: 'completed', fileId: file.id, error: null, completedAt: new Date() }).where(eq(physicalExports.id, id));
          await tx.insert(operationAudit).values({ id: randomUUID(), action: 'physical.export.publish', targetId: id, actorUserId: row.createdBy, requestHash: file.sha256, details: { fileId: file.id, boxCount: String(row.boxCount) } });
        });
      });
    } catch (error) {
      const [published] = await db.select().from(physicalExports).where(eq(physicalExports.id, id));
      if (published?.status === 'completed' && published.fileId) return;
      await db.update(physicalExports).set({ status: error instanceof BatchError && error.status === 409 ? 'stale' : 'failed',
        error: error instanceof BatchError ? error.message : '实物明细生成或发布失败，已保留确认及来源。', completedAt: new Date() }).where(and(eq(physicalExports.id, id), inArray(physicalExports.status, ['queued', 'running', 'failed'])));
      throw error;
    }
  } finally {
    let failedUnlock = false;
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`physical-export:${id}`]); }
    catch { failedUnlock = true; }
    finally { connection.release(failedUnlock); }
  }
}
export async function reconcilePhysicalExports(boss: PgBoss) {
  const rows = await db.select().from(physicalExports).where(inArray(physicalExports.status, ['queued', 'running'])).limit(100);
  for (const row of rows) {
    const [job] = row.queueJobId ? await boss.findJobs(PHYSICAL_EXPORT_QUEUE, { id: row.queueJobId }) : [];
    const orphaned = row.status === 'running' && job?.state === 'active';
    if (!orphaned && job && !['failed', 'cancelled', 'completed'].includes(job.state)) continue;
    const connection = await pool.connect(); let locked = false;
    try {
      const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`physical-export:${row.id}`]);
      locked = result.rows[0]?.locked === true; if (!locked) continue;
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(physicalExports).where(eq(physicalExports.id, row.id)).for('update');
        if (!current || current.queueJobId !== row.queueJobId || !['queued', 'running'].includes(current.status) || orphaned && current.status !== 'running') return;
        await tx.update(physicalExports).set({ status: 'failed', error: '导出任务已中断，请重新提交导出；原确认和已发布文件保留。', completedAt: new Date() }).where(eq(physicalExports.id, row.id));
      });
    } finally {
      let failedUnlock = false;
      try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`physical-export:${row.id}`]); }
      catch { failedUnlock = true; }
      finally { connection.release(failedUnlock); }
    }
  }
}
export async function registerPhysicalExportWorker(boss: PgBoss) {
  await boss.createQueue(PHYSICAL_EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 180, deleteAfterSeconds: 0 });
  await boss.work<{ exportId: string }>(PHYSICAL_EXPORT_QUEUE, { batchSize: 1 }, async (jobs) => { for (const job of jobs) await executePhysicalExport(job.data.exportId); });
  const interval = setInterval(() => void reconcilePhysicalExports(boss).catch((e) => logError('Physical export reconciliation failed', e)), 5000); interval.unref();
  return () => clearInterval(interval);
}
export async function readPhysicalExportFile(fileId: string, actorId: string) {
  await db.transaction((tx) => requireBatchActor(tx, actorId));
  const [record] = await db.select().from(physicalExports).where(and(eq(physicalExports.fileId, fileId), eq(physicalExports.status, 'completed')));
  if (!record) throw new BatchError('NOT_FOUND', 404, '该实物明细文件不存在或未发布。');
  const [file] = await db.select().from(fileIndex).where(eq(fileIndex.id, fileId));
  if (!file) throw new BatchError('NOT_FOUND', 404, '文件索引不存在。');
  return { file };
}
