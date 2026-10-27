import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { z } from 'zod';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { db, pool } from '../../db/client.js';
import { demands, fileIndex, operationAudit } from '../../db/schema.js';
import { logError } from '../../errors.js';
import { checkedFileBytes } from '../imports/service.js';
import { assertLingxingRequestsEnabled, createLingxingReadClient, LingxingReadError, type LingxingReadClient, type LingxingReadDependencies, type LingxingReadOperation, type LingxingReadPayload, type LingxingReadAttempt } from '../lingxing/read-client.js';
import { batchSyncItems, batchSyncRetryOperations, batchSyncRuns, batchSyncSnapshots } from '../lingxing/sync-schema.js';
import { loadDemandCancellationsInTx } from '../imports/demand-lifecycle.js';
import { shipmentRevisions, subBatches, subBatchMembers } from './schema.js';
import { BatchError, getSubBatchDetail, publishCandidate, requireBatchActor } from './service.js';
import { BatchSyncError, fetchCompleteShipmentList, normalizeShipment } from './sync.js';
import { publishReportFile } from './report-service.js';

export const BATCH_SYNC_QUEUE = 'batch-shipment-sync';
const startInput = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), startDate: z.iso.date(), endDate: z.iso.date(),
  requestBudget: z.number().int().min(1).max(1000).default(100), maxPages: z.number().int().min(1).max(100).default(10) }).strict().refine((input) => input.startDate < input.endDate, '创建日期范围结束日期必须晚于开始日期');
const retryInput = z.object({ operationId: z.uuid(), additionalRequestBudget: z.number().int().min(0).max(1000).default(0) }).strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Run = typeof batchSyncRuns.$inferSelect;
type Item = typeof batchSyncItems.$inferSelect;
const serializeRun = (run: Run) => ({ ...run, requestHash: undefined, createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null, completedAt: run.completedAt?.toISOString() ?? null });
const serializeItem = (item: Item) => ({ ...item, startedAt: item.startedAt?.toISOString() ?? null, completedAt: item.completedAt?.toISOString() ?? null });
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function validateRun(tx: Tx, run: Run) {
  await requireBatchActor(tx, run.createdBy);
  const [group] = await tx.select().from(subBatches).where(eq(subBatches.id, run.subBatchId)).for('share');
  if (!group || group.version !== run.groupVersion || group.status === 'superseded' || group.lifecycle && group.lifecycle !== 'active' || group.lifecyclePending) throw new BatchSyncError('VERSION_CONFLICT', '同步期间子批次已变化、取消或删除，请按当前成员新建同步。', 409);
  const members = await tx.select({ demand: demands }).from(subBatchMembers).innerJoin(demands, eq(demands.id, subBatchMembers.demandId)).where(and(eq(subBatchMembers.groupId, run.subBatchId), eq(subBatchMembers.active, true)));
  const items = await tx.select().from(batchSyncItems).where(eq(batchSyncItems.runId, run.id));
  if ((await loadDemandCancellationsInTx(tx, members.map(({ demand }) => demand.id))).size) throw new BatchSyncError('DEMAND_CANCELLED', '同步范围包含已取消需求，旧结果不会发布。', 409);
  if (members.length !== items.length || items.some((item) => !members.some(({ demand }) => demand.id === item.demandId && demand.version === item.demandVersion && demand.sid === item.sid && demand.fba === item.fba))) throw new BatchSyncError('VERSION_CONFLICT', '同步需求或成员已变化，旧结果不会发布。', 409);
}
export async function getBatchSyncRun(runId: string, actorId: string) {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const [run] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, runId));
    if (!run) throw new BatchSyncError('NOT_FOUND', '同步任务不存在。', 404);
    const items = await tx.select().from(batchSyncItems).where(eq(batchSyncItems.runId, runId)).orderBy(asc(batchSyncItems.fba), asc(batchSyncItems.sid));
    return { run: serializeRun(run), items: items.map(serializeItem) };
  });
}
export async function listBatchSyncRuns(subBatchId: string, actorId: string) {
  await getSubBatchDetail(subBatchId, actorId);
  const runs = await db.select().from(batchSyncRuns).where(eq(batchSyncRuns.subBatchId, subBatchId)).orderBy(desc(batchSyncRuns.createdAt)).limit(50);
  return { runs: runs.map(serializeRun) };
}
export async function requestBatchSync(boss: PgBoss, subBatchId: string, raw: z.input<typeof startInput>, actorId: string) {
  assertLingxingRequestsEnabled();
  const input = startInput.parse(raw); const hash = digest({ subBatchId, actorId, input });
  const id = await db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sync-group:${subBatchId}`},0))`);
    const [old] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.operationId, input.operationId));
    if (old) { if (old.requestHash !== hash || old.createdBy !== actorId) throw new BatchSyncError('OPERATION_CONFLICT', '操作编号已用于其他同步。', 409); return old.id; }
    const [group] = await tx.select().from(subBatches).where(eq(subBatches.id, subBatchId)).for('share');
    if (!group || group.version !== input.expectedVersion || group.status === 'superseded' || group.lifecycle && group.lifecycle !== 'active' || group.lifecyclePending) throw new BatchSyncError('VERSION_CONFLICT', '子批次已变化、取消或删除，请刷新后同步。', 409);
    const [active] = await tx.select().from(batchSyncRuns).where(and(eq(batchSyncRuns.subBatchId, subBatchId), inArray(batchSyncRuns.status, ['queued', 'running']))).limit(1);
    if (active) throw new BatchSyncError('SYNC_ACTIVE', '该子批次已有同步任务，请等待结果。', 409);
    const members = await tx.select({ demand: demands }).from(subBatchMembers).innerJoin(demands, eq(demands.id, subBatchMembers.demandId)).where(and(eq(subBatchMembers.groupId, subBatchId), eq(subBatchMembers.active, true)));
    if (!members.length) throw new BatchSyncError('EMPTY_GROUP', '子批次没有成员。');
    if ((await loadDemandCancellationsInTx(tx, members.map(({ demand }) => demand.id))).size) throw new BatchSyncError('DEMAND_CANCELLED', '所选需求已取消，不能提交同步。', 409);
    const runId = randomUUID();
    await tx.insert(batchSyncRuns).values({ id: runId, subBatchId, groupVersion: group.version, operationId: input.operationId, requestHash: hash,
      startDate: input.startDate, endDate: input.endDate, requestBudget: input.requestBudget, maxPages: input.maxPages, createdBy: actorId });
    await tx.insert(batchSyncItems).values(members.map(({ demand }) => ({ id: randomUUID(), runId, demandId: demand.id, demandVersion: demand.version, sid: demand.sid, fba: demand.fba })));
    const jobId = await boss.send(BATCH_SYNC_QUEUE, { runId }, { db: fromDrizzle(tx, sql) });
    if (!jobId) throw new BatchSyncError('QUEUE_UNAVAILABLE', '同步任务入队失败，请稍后重试。', 503);
    await tx.update(batchSyncRuns).set({ queueJobId: jobId }).where(eq(batchSyncRuns.id, runId));
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'batch.sync.submit', targetId: runId, actorUserId: actorId, requestHash: hash, details: { subBatchId, members: String(members.length), readOnly: 'true' } });
    return runId;
  });
  return getBatchSyncRun(id, actorId);
}
export async function retryBatchSync(boss: PgBoss, runId: string, raw: z.input<typeof retryInput>, actorId: string) {
  assertLingxingRequestsEnabled();
  const input = retryInput.parse(raw);
  await db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const [run] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, runId)).for('update');
    if (!run) throw new BatchSyncError('NOT_FOUND', '同步任务不存在。', 404);
    const [old] = await tx.select().from(batchSyncRetryOperations).where(eq(batchSyncRetryOperations.operationId, input.operationId));
    if (old) { if (old.runId !== runId || old.actorId !== actorId || old.requestHash !== digest(input)) throw new BatchSyncError('OPERATION_CONFLICT', '操作编号已用于其他重试。', 409); return; }
    if (!['failed', 'partial'].includes(run.status)) throw new BatchSyncError('SYNC_NOT_RETRYABLE', '只可重试已失败或部分成功任务。', 409);
    await validateRun(tx, run);
    if (run.requestsUsed >= run.requestBudget + input.additionalRequestBudget) throw new BatchSyncError('REQUEST_BUDGET_EXHAUSTED', '本次请求预算已用完，请明确增加重试预算或新建同步。', 409);
    if (run.requestBudget + input.additionalRequestBudget > 1000) throw new BatchSyncError('REQUEST_BUDGET_LIMIT', '单次同步总请求预算最多为 1000。');
    await tx.update(batchSyncItems).set({ status: 'queued', completedAt: null }).where(and(eq(batchSyncItems.runId, runId), inArray(batchSyncItems.status, ['failed', 'running', 'queued'])));
    const jobId = await boss.send(BATCH_SYNC_QUEUE, { runId }, { db: fromDrizzle(tx, sql) });
    if (!jobId) throw new BatchSyncError('QUEUE_UNAVAILABLE', '同步重试入队失败。', 503);
    await tx.update(batchSyncRuns).set({ status: 'queued', queueJobId: jobId, requestBudget: run.requestBudget + input.additionalRequestBudget, errorCode: null, errorMessage: null, completedAt: null }).where(eq(batchSyncRuns.id, runId));
    await tx.insert(batchSyncRetryOperations).values({ operationId: input.operationId, runId, actorId, requestHash: digest(input) });
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'batch.sync.retry', targetId: runId, actorUserId: actorId, requestHash: digest(input), details: { additionalRequestBudget: String(input.additionalRequestBudget), readOnly: 'true' } });
  });
  return getBatchSyncRun(runId, actorId);
}

async function archiveAttempt(run: Run, item: Item, page: number, params: Record<string, unknown>, attempt: LingxingReadAttempt) {
  const id = randomUUID();
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, runId: run.id, itemId: item.id, request: { operation: attempt.metadata.operation, params }, ...attempt }));
  await publishReportFile({ bytes, originalName: `lingxing-${item.fba}-${attempt.metadata.operation}-${page}-${id}.json`, mimeType: 'application/json', createdBy: run.createdBy }, async (file) => {
    await db.transaction(async (tx) => {
      await tx.insert(fileIndex).values(file);
      await tx.insert(batchSyncSnapshots).values({ id, runId: run.id, itemId: item.id, operation: attempt.metadata.operation, page, attempt: attempt.metadata.attempt, fileId: file.id, successful: attempt.metadata.businessCode === '0' && attempt.metadata.httpStatus >= 200 && attempt.metadata.httpStatus < 300 ? 1 : 0 });
      await tx.update(batchSyncItems).set({ snapshotIds: sql`${batchSyncItems.snapshotIds} || ${JSON.stringify([id])}::jsonb` }).where(eq(batchSyncItems.id, item.id));
    });
  });
}
async function readCheckpoint(itemId: string, operation: LingxingReadOperation, page: number): Promise<{ payload: LingxingReadPayload; observedAt: string } | null> {
  const [record] = await db.select({ file: fileIndex }).from(batchSyncSnapshots).innerJoin(fileIndex, eq(fileIndex.id, batchSyncSnapshots.fileId)).where(and(eq(batchSyncSnapshots.itemId, itemId), eq(batchSyncSnapshots.operation, operation), eq(batchSyncSnapshots.page, page), eq(batchSyncSnapshots.successful, 1))).orderBy(desc(batchSyncSnapshots.createdAt)).limit(1);
  if (!record) return null;
  const decoded = JSON.parse((await checkedFileBytes(record.file)).toString('utf8')) as { payload?: LingxingReadPayload; metadata?: { requestedAt?: string } };
  if (!decoded.payload || !decoded.metadata?.requestedAt) throw new BatchSyncError('SNAPSHOT_INVALID', '已有同步快照缺少采集时间或数据，不能伪装新读取。');
  return { payload: decoded.payload, observedAt: decoded.metadata.requestedAt };
}
const safeFailure = (error: unknown) => error instanceof BatchSyncError || error instanceof LingxingReadError || error instanceof BatchError ? { code: error.code, message: error.message } : { code: 'SYNC_FAILED', message: '同步处理未完成，已保留快照，请检查后重试。' };
export type BatchSyncDependencies = { createClient?: (dependencies: LingxingReadDependencies) => Promise<LingxingReadClient> };
export async function executeBatchSync(runId: string, dependencies: BatchSyncDependencies = {}) {
  // The run lock is acquired before the queued -> running transition. A second
  // process can therefore distinguish an active worker from a killed one even
  // while pg-boss still considers its old job active for the two-hour timeout.
  const connection = await pool.connect(); let locked = false;
  try {
    const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`batch-sync-run:${runId}`]);
    locked = result.rows[0]?.locked ?? false; if (!locked) return;
    try { await executeLockedBatchSync(runId, dependencies); }
    catch (error) {
      const failure = safeFailure(error);
      await db.transaction(async (tx) => {
        const [run] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, runId)).for('update');
        if (!run || !['queued', 'running'].includes(run.status)) return;
        await tx.update(batchSyncItems).set({ status: 'failed', errorCode: failure.code, errorMessage: failure.message, completedAt: new Date() }).where(and(eq(batchSyncItems.runId, runId), inArray(batchSyncItems.status, ['queued', 'running'])));
        await finishRunInTransaction(tx, runId);
      });
      throw error;
    }
  } finally {
    let failedUnlock = false;
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`batch-sync-run:${runId}`]); }
    catch { failedUnlock = true; }
    finally { connection.release(failedUnlock); }
  }
}
async function executeLockedBatchSync(runId: string, dependencies: BatchSyncDependencies) {
  assertLingxingRequestsEnabled();
  const run = await db.transaction(async (tx) => {
    const [record] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, runId)).for('update');
    if (!record || record.status !== 'queued') return null;
    await validateRun(tx, record);
    await tx.update(batchSyncRuns).set({ status: 'running', startedAt: record.startedAt ?? new Date() }).where(eq(batchSyncRuns.id, runId));
    return record;
  });
  if (!run) return;
  const items = await db.select().from(batchSyncItems).where(and(eq(batchSyncItems.runId, runId), eq(batchSyncItems.status, 'queued'))).orderBy(asc(batchSyncItems.fba), asc(batchSyncItems.sid));
  let stopNetwork = false;
  for (const item of items) {
    try {
      await db.transaction(async (tx) => { await validateRun(tx, run); await tx.update(batchSyncItems).set({ status: 'running', attempts: item.attempts + 1, startedAt: new Date() }).where(eq(batchSyncItems.id, item.id)); });
      // Recover publication after a worker died between commit and task status.
      const reason = `领星只读同步:${item.id}`;
      const [published] = await db.select().from(shipmentRevisions).where(and(eq(shipmentRevisions.demandId, item.demandId), eq(shipmentRevisions.reason, reason))).limit(1);
      if (published) { await db.update(batchSyncItems).set({ status: 'completed', revisionId: published.id, errorCode: null, errorMessage: null, completedAt: new Date() }).where(eq(batchSyncItems.id, item.id)); continue; }
      let context: { page: number; params: Record<string, unknown> } = { page: 0, params: {} };
      const clientDeps: LingxingReadDependencies = {
        onAuthAttempt: async () => { await db.update(batchSyncRuns).set({ authRequests: sql`${batchSyncRuns.authRequests}+1` }).where(eq(batchSyncRuns.id, runId)); },
        beforeRequest: async () => {
          if (stopNetwork) throw new BatchSyncError('RATE_LIMIT_PAUSED', '本轮已触发限流，剩余货件保留待重试。');
          await db.transaction(async (tx) => {
            await validateRun(tx, run);
            const [current] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, runId)).for('update');
            if (!current || current.status !== 'running' || current.requestsUsed >= current.requestBudget) throw new BatchSyncError('REQUEST_BUDGET_EXHAUSTED', '本次请求预算已用完，已保存成功步骤。');
            await tx.update(batchSyncRuns).set({ requestsUsed: current.requestsUsed + 1 }).where(eq(batchSyncRuns.id, runId));
            await tx.update(batchSyncItems).set({ requestCount: sql`${batchSyncItems.requestCount}+1` }).where(eq(batchSyncItems.id, item.id));
          });
        },
        onAttempt: async (attempt) => {
          await archiveAttempt(run, item, context.page, context.params, attempt);
          if (attempt.errorCode === 'LINGXING_RATE_LIMITED') { stopNetwork = true; throw new BatchSyncError('RATE_LIMIT_PAUSED', '领星限流，本轮停止新请求，已保存成功步骤。'); }
        },
      };
      const client = dependencies.createClient ? await dependencies.createClient(clientDeps) : await createLingxingReadClient(readConfig(), clientDeps);
      const freshList = ['PAGINATION_CHANGED', 'REPEATED_PAGE', 'INCOMPLETE_PAGINATION', 'PAGE_LIMIT'].includes(item.errorCode ?? '');
      let observedAt = '';
      const query = async (operation: LingxingReadOperation, params: Record<string, unknown>, page = 0) => {
        if (!(freshList && operation === 'listShipments')) { const cached = await readCheckpoint(item.id, operation, page); if (cached) {
          await db.update(batchSyncRuns).set({ cacheHits: sql`${batchSyncRuns.cacheHits}+1` }).where(eq(batchSyncRuns.id, runId));
          if (cached.observedAt > observedAt) observedAt = cached.observedAt; return cached.payload;
        } }
        context = { params, page };
        const result = await client.read(operation, params); if (result.metadata.requestedAt > observedAt) observedAt = result.metadata.requestedAt;
        return result.payload;
      };
      const listing = await fetchCompleteShipmentList((pagination, page) => query('listShipments', { sid: String(item.sid), shipment_id: item.fba, start_date: run.startDate, end_date: run.endDate, ...pagination }, page), run.maxPages);
      const matched = listing.rows.filter((row) => String(row.sid) === String(item.sid) && String(row.shipment_id).trim().toUpperCase() === item.fba);
      if (matched.length !== 1) throw new BatchSyncError('SHIPMENT_NOT_UNIQUE_IN_RANGE', '完整创建日期范围内未找到唯一货件，请核对日期范围、店铺和 FBA。');
      const details = await query('getShipmentDetails', { sid: item.sid, shipmentConfirmationId: item.fba });
      const packing = await query('getShipmentBoxes', { sid: item.sid, shipmentConfirmationId: item.fba });
      const [previous] = await db.select().from(shipmentRevisions).where(eq(shipmentRevisions.demandId, item.demandId)).orderBy(desc(shipmentRevisions.version)).limit(1);
      const data = normalizeShipment({ sid: item.sid, fba: item.fba, listing: matched[0]!, details, packing, previous: previous?.data, observedAt });
      const [currentItem] = await db.select().from(batchSyncItems).where(eq(batchSyncItems.id, item.id));
      const revision = await publishCandidate({ demandId: item.demandId, subBatchId: run.subBatchId, expectedGroupVersion: run.groupVersion, expectedDemandVersion: item.demandVersion,
        actorId: run.createdBy, data, source: 'lingxing', snapshotIds: currentItem?.snapshotIds ?? [], reason });
      await db.update(batchSyncItems).set({ status: 'completed', revisionId: revision.id, errorCode: null, errorMessage: null, completedAt: new Date() }).where(eq(batchSyncItems.id, item.id));
    } catch (error) {
      const failure = safeFailure(error);
      if (['LINGXING_RATE_LIMITED', 'RATE_LIMIT_PAUSED'].includes(failure.code)) stopNetwork = true;
      await db.update(batchSyncItems).set({ status: 'failed', errorCode: failure.code, errorMessage: failure.message, completedAt: new Date() }).where(eq(batchSyncItems.id, item.id));
    }
  }
  await finishRun(runId, run.queueJobId);
}
async function finishRunInTransaction(tx: Tx, runId: string) {
  const items = await tx.select().from(batchSyncItems).where(eq(batchSyncItems.runId, runId));
  const completed = items.filter((item) => item.status === 'completed').length;
  const firstError = items.find((item) => item.status !== 'completed');
  await tx.update(batchSyncRuns).set({ status: completed === items.length ? 'completed' : completed ? 'partial' : 'failed', errorCode: firstError?.errorCode ?? null, errorMessage: firstError?.errorMessage ?? null, completedAt: new Date() }).where(eq(batchSyncRuns.id, runId));
}
async function finishRun(runId: string, queueJobId?: string | null) {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, runId)).for('update');
    if (!run || queueJobId && run.queueJobId !== queueJobId || !['queued', 'running'].includes(run.status)) return;
    await finishRunInTransaction(tx, runId);
  });
}
export async function reconcileBatchSyncRuns(boss: PgBoss) {
  const runs = await db.select().from(batchSyncRuns).where(inArray(batchSyncRuns.status, ['queued', 'running'])).limit(100);
  for (const run of runs) {
    if (!run.queueJobId) continue;
    const [job] = await boss.findJobs(BATCH_SYNC_QUEUE, { id: run.queueJobId });
    const orphanedActive = run.status === 'running' && job?.state === 'active';
    if (!orphanedActive && job && !['failed', 'cancelled', 'completed'].includes(job.state)) continue;
    const connection = await pool.connect(); let locked = false;
    try {
      const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`batch-sync-run:${run.id}`]);
      locked = result.rows[0]?.locked ?? false; if (!locked) continue;
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, run.id)).for('update');
        if (!current || current.queueJobId !== run.queueJobId || !['queued', 'running'].includes(current.status) || orphanedActive && current.status !== 'running') return;
        await tx.update(batchSyncItems).set({ status: 'failed', errorCode: 'SYNC_INTERRUPTED', errorMessage: '同步任务已中断，成功步骤已保留，可立即重试剩余货件。', completedAt: new Date() }).where(and(eq(batchSyncItems.runId, run.id), inArray(batchSyncItems.status, ['queued', 'running'])));
        await finishRunInTransaction(tx, run.id);
      });
    } finally {
      let failedUnlock = false;
      try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`batch-sync-run:${run.id}`]); }
      catch { failedUnlock = true; }
      finally { connection.release(failedUnlock); }
    }
  }
}
export async function registerBatchSyncWorker(boss: PgBoss) {
  await boss.createQueue(BATCH_SYNC_QUEUE, { retryLimit: 0, expireInSeconds: 7200, deleteAfterSeconds: 0 });
  await boss.work(BATCH_SYNC_QUEUE, async ([job]) => {
    if (!job) return;
    const { runId } = z.object({ runId: z.uuid() }).parse(job.data);
    try { await executeBatchSync(runId); }
    catch { throw new Error('Batch sync failed'); }
  });
  const interval = setInterval(() => void reconcileBatchSyncRuns(boss).catch((error) => logError('Batch sync reconciliation failed', error)), 5_000); interval.unref();
  return () => clearInterval(interval);
}
export function createSyncRoutes(getBoss: () => PgBoss | null) {
  const routes = new Hono<{ Variables: { actorId: string } }>();
  routes.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new BatchSyncError('UNAUTHORIZED', '请先登录。', 401);
    if (session.user.banned || session.user.role !== 'admin') throw new BatchSyncError('FORBIDDEN', '当前账号没有同步权限。', 403);
    c.set('actorId', session.user.id);
    if (c.req.method === 'POST') { const config = readConfig(); const origin = c.req.header('Origin');
      if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && ![new URL(config.BETTER_AUTH_URL).origin, new URL(config.WEB_ORIGIN).origin].includes(origin)) throw new BatchSyncError('FORBIDDEN', '请求来源不受信任。', 403); }
    await next();
  });
  const uuid = (id: string) => z.uuid().parse(id);
  const queue = () => { const boss = getBoss(); if (!boss) throw new BatchSyncError('QUEUE_UNAVAILABLE', '同步队列暂不可用。', 503); return boss; };
  routes.get('/runs/:runId', async (c) => c.json(await getBatchSyncRun(uuid(c.req.param('runId')), c.get('actorId'))));
  routes.post('/runs/:runId/retry', async (c) => c.json(await retryBatchSync(queue(), uuid(c.req.param('runId')), retryInput.parse(await c.req.json()), c.get('actorId')), 202));
  routes.get('/:subBatchId', async (c) => c.json(await listBatchSyncRuns(uuid(c.req.param('subBatchId')), c.get('actorId'))));
  routes.post('/:subBatchId', async (c) => c.json(await requestBatchSync(queue(), uuid(c.req.param('subBatchId')), startInput.parse(await c.req.json()), c.get('actorId')), 202));
  routes.onError((error, c) => {
    const failure = safeFailure(error); const status = error instanceof BatchSyncError ? error.status : error instanceof BatchError ? error.status : error instanceof LingxingReadError ? 503 : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 500;
    if (status === 500) logError('Batch sync API failed', error);
    return c.json({ error: { code: status === 422 ? 'VALIDATION_ERROR' : failure.code, message: status === 422 ? '请核对同步参数和货件创建日期范围。' : failure.message, traceId: randomUUID() } }, status as 400);
  });
  return routes;
}
