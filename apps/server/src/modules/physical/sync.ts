import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { z } from 'zod';
import { physicalSyncInputSchema, physicalSyncResultSchema, physicalSyncRetrySchema, type PhysicalSource, type PhysicalSyncInput, type PhysicalSyncRun } from '@scm/contracts';
import { readConfig } from '../../config.js';
import { db, pool } from '../../db/client.js';
import { fileIndex, operationAudit } from '../../db/schema.js';
import { logError } from '../../errors.js';
import { batchOperations } from '../batches/schema.js';
import { publishReportFile } from '../batches/report-service.js';
import { BatchError, requireBatchActor, type BatchTx } from '../batches/service.js';
import { BatchSyncError, fetchCompleteShipmentList } from '../batches/sync.js';
import { checkedFileBytes } from '../imports/service.js';
import { assertLingxingRequestsEnabled, createLingxingReadClient, LingxingReadError,
  type LingxingReadAttempt, type LingxingReadClient, type LingxingReadDependencies, type LingxingReadOperation } from '../lingxing/read-client.js';
import { buildPhysicalSource, physicalSourceFingerprint, type PhysicalEvidence } from './domain.js';
import { physicalSources, physicalSyncItems, physicalSyncRuns, physicalSyncSnapshots } from './schema.js';
import { assertPhysicalWrite, currentPhysicalSource, lockPhysical, publishPhysicalSource, type PhysicalBundle } from './service.js';
import { decodePhysicalCheckpoint, loadHistoricalSource, type PhysicalCheckpoint } from './sources.js';

export const PHYSICAL_SYNC_QUEUE = 'physical-shipment-sync';
type Run = typeof physicalSyncRuns.$inferSelect;
type Item = typeof physicalSyncItems.$inferSelect;
export type PhysicalSyncResult = z.infer<typeof physicalSyncResultSchema>;
export type PhysicalSyncDependencies = { createClient?: (dependencies: LingxingReadDependencies) => Promise<LingxingReadClient> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const serializeRun = (run: Run): PhysicalSyncRun => ({ ...run, status: run.status as PhysicalSyncRun['status'], createdAt: run.createdAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null });
const safeFailure = (error: unknown) => error instanceof BatchError || error instanceof BatchSyncError || error instanceof LingxingReadError
  ? { code: error.code, message: error.message } : { code: 'PHYSICAL_SYNC_FAILED', message: '实物来源采集未完成，已保留成功快照，可重试。' };
const advisory = (tx: BatchTx, operationId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`batch-operation:${operationId}`},0))`);

/** Incomplete observations are immutable barriers, never adoptable sources. */
export function buildPartialPhysicalObservation(bundle: PhysicalBundle, run: Pick<Run, 'id' | 'groupId' | 'm2ConfirmationId' | 'createdBy'>, observed: PhysicalEvidence, accepted: PhysicalSource | null): PhysicalSource | null {
  const input = { id: randomUUID(), groupId: run.groupId, m2ConfirmationId: run.m2ConfirmationId, origin: 'sync' as const, createdBy: run.createdBy,
    createdAt: new Date().toISOString(), shipments: bundle.confirmation.snapshot.shipments.filter((s) => s.demandId === observed.demandId),
    members: bundle.confirmation.snapshot.members.filter((m) => m.id === observed.demandId), codes: bundle.codes.filter((c) => c.demandId === observed.demandId), evidence: [observed] };
  const source = buildPhysicalSource(input);
  const acceptedFingerprint = accepted ? physicalSourceFingerprint({ boxes: accepted.boxes.filter((box) => box.demandId === observed.demandId),
    issues: accepted.issues.filter((issue) => !issue.demandId || issue.demandId === observed.demandId), identityValid: accepted.identityValid }) : null;
  if (source.identityValid && (!accepted || source.fingerprint === acceptedFingerprint)) return null;
  const partial = buildPhysicalSource({ ...input, shipments: bundle.confirmation.snapshot.shipments, members: bundle.confirmation.snapshot.members, codes: bundle.codes });
  partial.identityValid = false;
  partial.issues.push({ code: 'PHYSICAL_SYNC_INCOMPLETE', severity: 'error', message: '采集中已发现实质变化；此记录仅保存不完整观测，请完成或重试整组采集后再采用来源。' });
  partial.fingerprint = physicalSourceFingerprint(partial);
  return partial;
}

async function validateRun(tx: BatchTx, run: Run) {
  const context = await lockPhysical(tx, run.groupId, run.createdBy);
  if (context.bundle.confirmation.id !== run.m2ConfirmationId) throw new BatchError('VERSION_CONFLICT', 409, 'M2 确认已变化，请按当前确认新建实物采集。');
  const items = await tx.select().from(physicalSyncItems).where(eq(physicalSyncItems.runId, run.id));
  const shipments = context.bundle.confirmation.snapshot.shipments;
  if (items.length !== shipments.length || items.some((item) => !shipments.some((shipment) => shipment.demandId === item.demandId
    && shipment.revision.data.sid === item.sid && shipment.revision.data.fba === item.fba))) throw new BatchError('VERSION_CONFLICT', 409, '采集成员与绑定的 M2 确认不一致，旧结果不会发布。');
  return context;
}
export async function listPhysicalSyncRuns(tx: BatchTx, groupId: string): Promise<PhysicalSyncRun[]> {
  const runs = await tx.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.groupId, groupId)).orderBy(desc(physicalSyncRuns.createdAt)).limit(50);
  return runs.map(serializeRun);
}
export async function getPhysicalSyncRun(groupId: string, runId: string, actorId: string): Promise<PhysicalSyncResult> {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const [run] = await tx.select().from(physicalSyncRuns).where(and(eq(physicalSyncRuns.id, runId), eq(physicalSyncRuns.groupId, groupId)));
    if (!run) throw new BatchError('NOT_FOUND', 404, '实物来源采集任务不存在。');
    const items = await tx.select().from(physicalSyncItems).where(eq(physicalSyncItems.runId, runId)).orderBy(asc(physicalSyncItems.fba), asc(physicalSyncItems.sid));
    return physicalSyncResultSchema.parse({ run: serializeRun(run), items });
  });
}
export async function requestPhysicalSync(boss: PgBoss, groupId: string, raw: PhysicalSyncInput, actorId: string): Promise<PhysicalSyncResult> {
  assertLingxingRequestsEnabled();
  const input = physicalSyncInputSchema.parse(raw), requestHash = digest({ groupId, input });
  const runId = await db.transaction(async (tx) => {
    await advisory(tx, input.operationId); await requireBatchActor(tx, actorId);
    const [old] = await tx.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.operationId, input.operationId));
    if (old) { if (old.createdBy !== actorId || old.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他实物采集。'); return old.id; }
    const [used] = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, input.operationId));
    if (used) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他请求，请勿复用。');
    const context = await lockPhysical(tx, groupId, actorId); await assertPhysicalWrite(context, input, tx);
    const [active] = await tx.select().from(physicalSyncRuns).where(and(eq(physicalSyncRuns.groupId, groupId), inArray(physicalSyncRuns.status, ['queued', 'running']))).limit(1);
    if (active) throw new BatchError('SYNC_ACTIVE', 409, '该子批次已有实物采集任务，请等待结果。');
    const id = randomUUID();
    await tx.insert(physicalSyncRuns).values({ id, groupId, m2ConfirmationId: input.m2ConfirmationId, operationId: input.operationId, requestHash,
      startDate: input.startDate, endDate: input.endDate, requestBudget: input.requestBudget, maxPages: input.maxPages, createdBy: actorId });
    await tx.insert(physicalSyncItems).values(context.bundle.confirmation.snapshot.shipments.map((shipment) => ({
      id: randomUUID(), runId: id, demandId: shipment.demandId, sid: shipment.revision.data.sid, fba: shipment.revision.data.fba,
    })));
    const queueJobId = await boss.send(PHYSICAL_SYNC_QUEUE, { runId: id }, { db: fromDrizzle(tx, sql) });
    if (!queueJobId) throw new BatchError('QUEUE_UNAVAILABLE', 503, '实物采集入队失败，请重试。');
    await tx.update(physicalSyncRuns).set({ queueJobId }).where(eq(physicalSyncRuns.id, id));
    await tx.insert(batchOperations).values({ operationId: input.operationId, actorId, action: 'physical.sync.submit', requestHash, result: { runId: id } });
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'physical.sync.submit', targetId: id, actorUserId: actorId, requestHash, details: { groupId, m2ConfirmationId: input.m2ConfirmationId, readOnly: 'true' } });
    return id;
  });
  return getPhysicalSyncRun(groupId, runId, actorId);
}
export async function retryPhysicalSync(boss: PgBoss, groupId: string, runId: string, raw: z.input<typeof physicalSyncRetrySchema>, actorId: string): Promise<PhysicalSyncResult> {
  assertLingxingRequestsEnabled();
  const input = physicalSyncRetrySchema.parse(raw), requestHash = digest({ action: 'physical.sync.retry', groupId, runId, input });
  await db.transaction(async (tx) => {
    await advisory(tx, input.operationId); await requireBatchActor(tx, actorId);
    const [old] = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, input.operationId));
    if (old) { if (old.actorId !== actorId || old.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他重试。'); return; }
    // Preserve the common week -> group -> physical state -> task lock order.
    const context = await lockPhysical(tx, groupId, actorId);
    const [run] = await tx.select().from(physicalSyncRuns).where(and(eq(physicalSyncRuns.id, runId), eq(physicalSyncRuns.groupId, groupId))).for('update');
    if (!run) throw new BatchError('NOT_FOUND', 404, '实物采集任务不存在。');
    if (context.bundle.confirmation.id !== run.m2ConfirmationId) throw new BatchError('VERSION_CONFLICT', 409, 'M2 确认已变化，请新建实物采集。');
    if (!['failed', 'partial'].includes(run.status)) throw new BatchError('SYNC_NOT_RETRYABLE', 409, '只能重试失败或部分成功的采集任务。');
    const [active] = await tx.select().from(physicalSyncRuns).where(and(eq(physicalSyncRuns.groupId, groupId), inArray(physicalSyncRuns.status, ['queued', 'running']))).limit(1);
    if (active) throw new BatchError('SYNC_ACTIVE', 409, '该组已有采集任务，请等待结果。');
    const requestBudget = run.requestBudget + input.additionalRequestBudget;
    if (requestBudget > 1000) throw new BatchError('REQUEST_BUDGET_LIMIT', 422, '单次采集总预算最多为 1000 次请求。');
    const items = await tx.select().from(physicalSyncItems).where(eq(physicalSyncItems.runId, runId));
    if (run.requestsUsed >= requestBudget && items.some((item) => item.status !== 'completed')) throw new BatchError('REQUEST_BUDGET_EXHAUSTED', 409, '请求预算已用完，请明确增加重试预算。');
    await tx.update(physicalSyncItems).set({ status: 'queued' }).where(and(eq(physicalSyncItems.runId, runId), inArray(physicalSyncItems.status, ['failed', 'running', 'queued'])));
    const queueJobId = await boss.send(PHYSICAL_SYNC_QUEUE, { runId }, { db: fromDrizzle(tx, sql) });
    if (!queueJobId) throw new BatchError('QUEUE_UNAVAILABLE', 503, '实物采集重试入队失败。');
    await tx.update(physicalSyncRuns).set({ status: 'queued', queueJobId, requestBudget, errorCode: null, errorMessage: null, completedAt: null }).where(eq(physicalSyncRuns.id, runId));
    await tx.insert(batchOperations).values({ operationId: input.operationId, actorId, action: 'physical.sync.retry', requestHash, result: { runId } });
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'physical.sync.retry', targetId: runId, actorUserId: actorId, requestHash, details: { additionalRequestBudget: String(input.additionalRequestBudget), readOnly: 'true' } });
  });
  return getPhysicalSyncRun(groupId, runId, actorId);
}

async function archiveAttempt(run: Run, item: Item, context: { page: number; params: Record<string, unknown>; collectionId?: string }, attempt: LingxingReadAttempt) {
  const id = randomUUID(), bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, runId: run.id, itemId: item.id, collectionId: context.collectionId,
    request: { operation: attempt.metadata.operation, params: context.params }, ...attempt }));
  await publishReportFile({ bytes, originalName: `physical-${item.fba}-${attempt.metadata.operation}-${context.page}-${id}.json`, mimeType: 'application/json', createdBy: run.createdBy }, async (file) => {
    await db.transaction(async (tx) => {
      await tx.insert(fileIndex).values(file);
      await tx.insert(physicalSyncSnapshots).values({ id, runId: run.id, itemId: item.id, operation: attempt.metadata.operation, page: context.page,
        attempt: attempt.metadata.attempt, fileId: file.id, successful: attempt.metadata.businessCode === '0' && attempt.metadata.httpStatus >= 200 && attempt.metadata.httpStatus < 300 ? 1 : 0 });
      await tx.update(physicalSyncItems).set({ snapshotIds: sql`${physicalSyncItems.snapshotIds} || ${JSON.stringify([id])}::jsonb` }).where(eq(physicalSyncItems.id, item.id));
    });
  });
}
async function readCheckpoint(item: Item, operation: LingxingReadOperation, page: number, params: Record<string, unknown>, collectionId?: string): Promise<PhysicalCheckpoint | null> {
  const records = await db.select({ file: fileIndex }).from(physicalSyncSnapshots).innerJoin(fileIndex, eq(fileIndex.id, physicalSyncSnapshots.fileId))
    .where(and(eq(physicalSyncSnapshots.itemId, item.id), eq(physicalSyncSnapshots.operation, operation), eq(physicalSyncSnapshots.page, page), eq(physicalSyncSnapshots.successful, 1)))
    .orderBy(desc(physicalSyncSnapshots.createdAt));
  for (const { file } of records) {
    const checkpoint = decodePhysicalCheckpoint(await checkedFileBytes(file), { sid: item.sid, fba: item.fba, operation });
    if (Object.keys(params).some((key) => String(checkpoint.params[key]) !== String(params[key]))) continue;
    if (collectionId && checkpoint.collectionId !== collectionId) continue;
    return checkpoint;
  }
  return null;
}
async function readEvidence(run: Run, item: Item, query: (operation: LingxingReadOperation, params: Record<string, unknown>, page?: number) => Promise<PhysicalCheckpoint>): Promise<PhysicalEvidence> {
  const observed: string[] = [];
  const listing = await fetchCompleteShipmentList(async (pagination, page) => {
    const result = await query('listShipments', { sid: String(item.sid), shipment_id: item.fba, start_date: run.startDate, end_date: run.endDate, ...pagination }, page);
    observed.push(result.observedAt); return result.payload;
  }, run.maxPages);
  const matches = listing.rows.filter((row) => String(row.sid) === String(item.sid) && typeof row.shipment_id === 'string' && row.shipment_id.trim().toUpperCase() === item.fba);
  if (matches.length !== 1) throw new BatchSyncError(matches.length ? 'SHIPMENT_NOT_UNIQUE_IN_RANGE' : 'SHIPMENT_NOT_FOUND', matches.length ? '完整范围内目标货件不唯一，请核对店铺和 FBA。' : '创建日期范围内查无货件，请核对范围、店铺和 FBA。');
  const details = await query('getShipmentDetails', { sid: item.sid, shipmentConfirmationId: item.fba });
  const packing = await query('getShipmentBoxes', { sid: item.sid, shipmentConfirmationId: item.fba });
  observed.push(details.observedAt, packing.observedAt);
  return { demandId: item.demandId, listing: matches[0]!, details: details.payload, packing: packing.payload, observedAt: observed.sort().at(-1)!, snapshotIds: item.snapshotIds };
}
async function finishIncomplete(tx: BatchTx, runId: string, failure?: { code: string; message: string }) {
  const items = await tx.select().from(physicalSyncItems).where(eq(physicalSyncItems.runId, runId));
  const completed = items.filter((item) => item.status === 'completed').length, first = items.find((item) => item.status !== 'completed');
  await tx.update(physicalSyncRuns).set({ status: completed ? 'partial' : 'failed', completedAt: new Date(),
    errorCode: failure?.code ?? first?.errorCode ?? 'SOURCE_PUBLICATION_INTERRUPTED', errorMessage: failure?.message ?? first?.errorMessage ?? '成功步骤已保留，来源尚未发布，请重试。' }).where(eq(physicalSyncRuns.id, runId));
}
export async function executePhysicalSync(runId: string, dependencies: PhysicalSyncDependencies = {}) {
  const connection = await pool.connect(); let locked = false;
  try {
    const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`physical-sync-run:${runId}`]);
    locked = result.rows[0]?.locked ?? false; if (!locked) return;
    try { await executeLockedSync(runId, dependencies); }
    catch (error) {
      const failure = safeFailure(error);
      await db.transaction(async (tx) => {
        const [run] = await tx.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.id, runId)).for('update');
        if (!run || !['queued', 'running'].includes(run.status)) return;
        await tx.update(physicalSyncItems).set({ status: 'failed', errorCode: failure.code, errorMessage: failure.message }).where(and(eq(physicalSyncItems.runId, runId), inArray(physicalSyncItems.status, ['queued', 'running'])));
        await finishIncomplete(tx, runId, failure);
      });
      throw error;
    }
  } finally {
    let failedUnlock = false;
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`physical-sync-run:${runId}`]); }
    catch { failedUnlock = true; }
    finally { connection.release(failedUnlock); }
  }
}
async function executeLockedSync(runId: string, dependencies: PhysicalSyncDependencies) {
  assertLingxingRequestsEnabled();
  const [initial] = await db.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.id, runId));
  if (!initial || initial.status !== 'queued') return;
  let historicalBundle: PhysicalBundle | null = null;
  const run = await db.transaction(async (tx) => {
    const physical = await validateRun(tx, initial);
    if (!physical.state?.sourceId || physical.state.m2ConfirmationId !== initial.m2ConfirmationId) historicalBundle = physical.bundle;
    const [record] = await tx.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.id, runId)).for('update');
    if (!record || record.status !== 'queued') return null;
    await tx.update(physicalSyncRuns).set({ status: 'running', startedAt: record.startedAt ?? new Date() }).where(eq(physicalSyncRuns.id, runId));
    return record;
  });
  if (!run) return;
  const historical = historicalBundle ? await loadHistoricalSource(historicalBundle, run.createdBy) : null;
  const baseline = historical?.identityValid ? historical : null;
  const items = await db.select().from(physicalSyncItems).where(and(eq(physicalSyncItems.runId, runId), eq(physicalSyncItems.status, 'queued'))).orderBy(asc(physicalSyncItems.fba), asc(physicalSyncItems.sid));
  let stopNetwork = false;
  for (const item of items) {
    try {
      await db.transaction(async (tx) => { await validateRun(tx, run); await tx.update(physicalSyncItems).set({ status: 'running' }).where(eq(physicalSyncItems.id, item.id)); });
      let context: { page: number; params: Record<string, unknown>; collectionId?: string } = { page: 0, params: {} };
      const freshList = ['PAGINATION_CHANGED', 'REPEATED_PAGE', 'INCOMPLETE_PAGINATION', 'PAGE_LIMIT'].includes(item.errorCode ?? '');
      let collectionId: string | undefined;
      const clientDependencies: LingxingReadDependencies = {
        onAuthAttempt: async () => { await db.update(physicalSyncRuns).set({ authRequests: sql`${physicalSyncRuns.authRequests}+1` }).where(eq(physicalSyncRuns.id, runId)); },
        beforeRequest: async () => {
          if (stopNetwork) throw new BatchSyncError('RATE_LIMIT_PAUSED', '本轮已触发限流，其余步骤保留待重试。');
          await db.transaction(async (tx) => {
            await validateRun(tx, run);
            const [current] = await tx.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.id, runId)).for('update');
            if (!current || current.status !== 'running' || current.requestsUsed >= current.requestBudget) throw new BatchSyncError('REQUEST_BUDGET_EXHAUSTED', '本次采集预算已用完，成功步骤已保留。');
            await tx.update(physicalSyncRuns).set({ requestsUsed: current.requestsUsed + 1 }).where(eq(physicalSyncRuns.id, runId));
          });
        },
        onAttempt: async (attempt) => {
          // Stop later requests even when persisting the rate-limit evidence
          // itself fails (for example, if file storage becomes unavailable).
          if (attempt.errorCode === 'LINGXING_RATE_LIMITED') stopNetwork = true;
          await archiveAttempt(run, item, context, attempt);
          if (attempt.errorCode === 'LINGXING_RATE_LIMITED') throw new BatchSyncError('RATE_LIMIT_PAUSED', '领星限流，本轮停止新请求，已保留成功快照。');
        },
      };
      let client: LingxingReadClient | undefined;
      const query = async (operation: LingxingReadOperation, params: Record<string, unknown>, page = 0): Promise<PhysicalCheckpoint> => {
        if (!(freshList && operation === 'listShipments')) {
          const cached = await readCheckpoint(item, operation, page, params, operation === 'listShipments' ? collectionId : undefined);
          if (cached) {
            if (operation === 'listShipments') collectionId = cached.collectionId;
            await db.update(physicalSyncRuns).set({ cacheHits: sql`${physicalSyncRuns.cacheHits}+1` }).where(eq(physicalSyncRuns.id, runId));
            return cached;
          }
        }
        if (operation === 'listShipments') collectionId ??= randomUUID();
        context = { params, page, ...(operation === 'listShipments' ? { collectionId } : {}) };
        client ??= dependencies.createClient ? await dependencies.createClient(clientDependencies) : await createLingxingReadClient(readConfig(), clientDependencies);
        const result = await client.read(operation, params);
        return { payload: result.payload, observedAt: result.metadata.requestedAt, params, ...(operation === 'listShipments' ? { collectionId } : {}) };
      };
      const observed = await readEvidence(run, item, query);
      await db.transaction(async (tx) => {
        const physical = await validateRun(tx, run), accepted = await currentPhysicalSource(tx, physical);
        const [currentItem] = await tx.select().from(physicalSyncItems).where(eq(physicalSyncItems.id, item.id));
        if (!currentItem) throw new BatchError('VERSION_CONFLICT', 409, '采集成员记录已变化，观测未发布。');
        observed.snapshotIds = currentItem.snapshotIds;
        // Detect a changed successful member immediately, even if another
        // shipment later fails. Partial evidence is never offered for adoption.
        const partial = buildPartialPhysicalObservation(physical.bundle, run, observed, accepted ?? baseline);
        if (partial) await publishPhysicalSource(tx, partial);
        await tx.update(physicalSyncItems).set({ status: 'completed', errorCode: null, errorMessage: null }).where(eq(physicalSyncItems.id, item.id));
      });
    } catch (error) {
      const failure = safeFailure(error);
      if (['LINGXING_RATE_LIMITED', 'RATE_LIMIT_PAUSED'].includes(failure.code)) stopNetwork = true;
      await db.update(physicalSyncItems).set({ status: 'failed', errorCode: failure.code, errorMessage: failure.message }).where(eq(physicalSyncItems.id, item.id));
    }
  }
  const complete = await db.select().from(physicalSyncItems).where(eq(physicalSyncItems.runId, runId)).orderBy(asc(physicalSyncItems.fba), asc(physicalSyncItems.sid));
  if (!complete.length || complete.some((item) => item.status !== 'completed')) { await db.transaction((tx) => finishIncomplete(tx, runId)); return; }
  const evidence: PhysicalEvidence[] = [];
  for (const item of complete) {
    let collectionId: string | undefined;
    evidence.push(await readEvidence(run, item, async (operation, params, page = 0) => {
      const checkpoint = await readCheckpoint(item, operation, page, params, operation === 'listShipments' ? collectionId : undefined);
      if (!checkpoint) throw new BatchSyncError('SNAPSHOT_INVALID', '成功步骤缺少可信检查点，来源未发布。');
      if (operation === 'listShipments') collectionId = checkpoint.collectionId;
      return checkpoint;
    }));
  }
  await db.transaction(async (tx) => {
    const { bundle } = await validateRun(tx, run);
    const [current] = await tx.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.id, runId)).for('update');
    if (!current || current.queueJobId !== run.queueJobId || current.status !== 'running') return;
    const [latest] = await tx.select().from(physicalSources).where(and(eq(physicalSources.groupId, run.groupId), eq(physicalSources.m2ConfirmationId, run.m2ConfirmationId)))
      .orderBy(desc(physicalSources.createdAt)).limit(1);
    const createdAt = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1)).toISOString();
    const source = buildPhysicalSource({ id: run.id, groupId: run.groupId, m2ConfirmationId: run.m2ConfirmationId, origin: 'sync', createdBy: run.createdBy,
      createdAt, shipments: bundle.confirmation.snapshot.shipments, members: bundle.confirmation.snapshot.members, codes: bundle.codes, evidence });
    await publishPhysicalSource(tx, source);
    await tx.update(physicalSyncRuns).set({ status: 'completed', errorCode: null, errorMessage: null, completedAt: new Date() }).where(eq(physicalSyncRuns.id, runId));
  });
}
export async function reconcilePhysicalSyncRuns(boss: PgBoss) {
  const runs = await db.select().from(physicalSyncRuns).where(inArray(physicalSyncRuns.status, ['queued', 'running'])).limit(100);
  for (const run of runs) {
    if (!run.queueJobId) continue;
    const [job] = await boss.findJobs(PHYSICAL_SYNC_QUEUE, { id: run.queueJobId });
    const orphanedActive = run.status === 'running' && job?.state === 'active';
    if (!orphanedActive && job && !['failed', 'cancelled', 'completed'].includes(job.state)) continue;
    const connection = await pool.connect(); let locked = false;
    try {
      const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`physical-sync-run:${run.id}`]);
      locked = result.rows[0]?.locked ?? false; if (!locked) continue;
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.id, run.id)).for('update');
        if (!current || current.queueJobId !== run.queueJobId || !['queued', 'running'].includes(current.status) || orphanedActive && current.status !== 'running') return;
        await tx.update(physicalSyncItems).set({ status: 'failed', errorCode: 'SYNC_INTERRUPTED', errorMessage: '采集已中断，成功检查点已保留，可立即重试。' })
          .where(and(eq(physicalSyncItems.runId, run.id), inArray(physicalSyncItems.status, ['queued', 'running'])));
        await finishIncomplete(tx, run.id);
      });
    } finally {
      let failedUnlock = false;
      try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`physical-sync-run:${run.id}`]); }
      catch { failedUnlock = true; }
      finally { connection.release(failedUnlock); }
    }
  }
}
export async function registerPhysicalSyncWorker(boss: PgBoss) {
  await boss.createQueue(PHYSICAL_SYNC_QUEUE, { retryLimit: 0, expireInSeconds: 7200, deleteAfterSeconds: 0 });
  await boss.work<{ runId: string }>(PHYSICAL_SYNC_QUEUE, async ([job]) => { if (job) await executePhysicalSync(z.uuid().parse(job.data.runId)); });
  const interval = setInterval(() => void reconcilePhysicalSyncRuns(boss).catch((error) => logError('Physical sync reconciliation failed', error)), 5_000); interval.unref();
  return () => clearInterval(interval);
}
