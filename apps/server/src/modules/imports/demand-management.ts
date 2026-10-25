import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { demandCancelInputSchema, demandRevisionInputSchema, type DemandCancelInput, type DemandManagement, type DemandManagementOperation, type DemandRevisionInput } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demands, demandRevisions, operationAudit } from '../../db/schema.js';
import { batchOperations, subBatchMembers, subBatches, weeklyBatches } from '../batches/schema.js';
import { batchExports } from '../batches/export-schema.js';
import { BatchError, lockBatchRunScopesInTx, requireBatchActor, reviseGroupAfterDemandMutationInTx, serializeDemand, type BatchTx } from '../batches/service.js';
import { batchSyncRuns } from '../lingxing/sync-schema.js';
import { physicalExports, physicalSyncRuns } from '../physical/schema.js';
import { documentExports, documentMemberClaims } from '../documents/schema.js';
import { documentDigest } from '../documents/domain.js';
import { workflowExports, workflowRecords } from '../workflow/schema.js';
import { loadDemandCancellationsInTx } from './demand-lifecycle.js';

type Group = typeof subBatches.$inferSelect;
async function demandGroupsInTx(tx: BatchTx, demandId: string): Promise<Group[]> {
  const rows = await tx.select({ group: subBatches }).from(subBatchMembers).innerJoin(subBatches, eq(subBatchMembers.groupId, subBatches.id))
    .where(and(eq(subBatchMembers.demandId, demandId), eq(subBatchMembers.active, true))).orderBy(asc(subBatches.id));
  return [...new Map(rows.map(({ group }) => [group.id, group])).values()];
}
async function managementInTx(tx: BatchTx, demandId: string, groups: Group[]): Promise<DemandManagement> {
  const cancelled = (await loadDemandCancellationsInTx(tx, [demandId])).get(demandId);
  const base = { lifecycle: cancelled ? 'cancelled' as const : 'active' as const, groupId: groups[0]?.id ?? null, batchId: groups[0]?.batchId ?? null };
  const blocked = (reason: string): DemandManagement => ({ ...base, canEdit: false, canDelete: false, reason });
  if (cancelled) return blocked(`需求已取消：${cancelled.reason}`);
  if (groups.some((group) => group.status === 'superseded')) return blocked('需求所属批次已被替代，请读取当前更正批次。');
  if (groups.some((group) => group.frozenAt || group.status === 'frozen')) return blocked('需求所属批次已导出或打印并冻结，请通过批次更正处理。');
  const [claim] = await tx.select({ id: documentMemberClaims.id }).from(documentMemberClaims).where(and(eq(documentMemberClaims.demandId, demandId), isNull(documentMemberClaims.releasedAt))).limit(1);
  if (claim) return blocked('需求已被有效发票与单据占用，请先处理下游单据。');
  const [workflow] = await tx.select({ id: workflowRecords.id }).from(workflowRecords).where(and(ne(workflowRecords.status, 'cancelled'), sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${workflowRecords.source}->'members') AS member WHERE member->'demand'->>'id' = ${demandId} OR member->'source'->>'demandId' = ${demandId})`)).limit(1);
  if (workflow) return blocked('需求已有有效的履约、物流、清关、财务或归档记录，请先处理下游记录。');
  const [documentTask] = await tx.select({ id: documentExports.id }).from(documentExports).where(and(inArray(documentExports.status, ['queued', 'running']), sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${documentExports.reference}->'sources') AS source WHERE source->>'demandId' = ${demandId})`)).limit(1);
  if (documentTask) return blocked('需求相关单据正在生成，请等待任务结束。');
  const [workflowTask] = await tx.select({ id: workflowExports.id }).from(workflowExports).where(and(inArray(workflowExports.status, ['queued', 'running']), sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${workflowExports.snapshot}->'source'->'members') AS member WHERE member->'demand'->>'id' = ${demandId} OR member->'source'->>'demandId' = ${demandId})`)).limit(1);
  if (workflowTask) return blocked('需求相关业务文件正在生成，请等待任务结束。');
  const ids = groups.map((group) => group.id);
  if (ids.length) {
    const [sync] = await tx.select({ id: batchSyncRuns.id }).from(batchSyncRuns).where(and(inArray(batchSyncRuns.subBatchId, ids), inArray(batchSyncRuns.status, ['queued', 'running']))).limit(1);
    if (sync) return blocked('所属批次正在同步，请等待任务结束后再修改或删除需求。');
    const [physicalSync] = await tx.select({ id: physicalSyncRuns.id }).from(physicalSyncRuns).where(and(inArray(physicalSyncRuns.groupId, ids), inArray(physicalSyncRuns.status, ['queued', 'running']))).limit(1);
    if (physicalSync) return blocked('所属批次正在同步实物箱，请等待任务结束。');
    const [report] = await tx.select({ id: batchExports.id }).from(batchExports).where(and(inArray(batchExports.status, ['queued', 'running']), sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${batchExports.groupIds}) AS group_id WHERE group_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))`)).limit(1);
    if (report) return blocked('所属批次正在导出发货成品表，请等待任务结束。');
    const [physical] = await tx.select({ id: physicalExports.id }).from(physicalExports).where(and(inArray(physicalExports.status, ['queued', 'running']), sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${physicalExports.references}) AS reference WHERE reference->>'groupId' IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))`)).limit(1);
    if (physical) return blocked('所属批次正在导出实物箱文件，请等待任务结束。');
  }
  return { ...base, canEdit: true, canDelete: true, reason: null };
}
export async function getDemandManagement(demandId: string, actorId: string) {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const [record] = await tx.select({ id: demands.id }).from(demands).where(eq(demands.id, demandId));
    if (!record) throw new BatchError('NOT_FOUND', 404, '需求不存在。');
    const management = await managementInTx(tx, demandId, await demandGroupsInTx(tx, demandId));
    const rows = await tx.select().from(operationAudit).where(and(eq(operationAudit.targetId, demandId), inArray(operationAudit.action, ['demand.revise', 'demand.cancel']))).orderBy(desc(operationAudit.createdAt), desc(operationAudit.id));
    const operations: DemandManagementOperation[] = rows.map((row) => ({ action: row.action, reason: row.details?.reason ?? '', createdBy: row.actorUserId, createdAt: row.createdAt.toISOString(), ...(row.details?.version ? { version: Number(row.details.version) } : {}) }));
    return { management, operations };
  }, { isolationLevel: 'repeatable read' });
}
async function lockDemandMutationInTx(tx: BatchTx, demandId: string, expectedVersion: number) {
  const [initial] = await tx.select().from(demands).where(eq(demands.id, demandId));
  if (!initial) throw new BatchError('NOT_FOUND', 404, '需求不存在。');
  const originalGroups = await demandGroupsInTx(tx, demandId);
  const batchIds = [...new Set(originalGroups.map((group) => group.batchId))].sort();
  for(const batchId of batchIds)await lockBatchRunScopesInTx(tx,batchId);
  if (batchIds.length) await tx.select({ id: weeklyBatches.id }).from(weeklyBatches).where(inArray(weeklyBatches.id, batchIds)).orderBy(asc(weeklyBatches.id)).for('update');
  const groupIds = originalGroups.map((group) => group.id).sort();
  const groups = groupIds.length ? await tx.select().from(subBatches).where(inArray(subBatches.id, groupIds)).orderBy(asc(subBatches.id)).for('update') : [];
  // Import commits use the same identity lock. Publishers use the shipment lock.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`demand:${JSON.stringify([initial.sid, initial.fba])}`},0))`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipment:${demandId}`},0))`);
  const [record] = await tx.select().from(demands).where(eq(demands.id, demandId)).for('update');
  if (!record || record.version !== expectedVersion) throw new BatchError('DEMAND_VERSION_CONFLICT', 409, '需求版本已变化，请保留输入并重新读取。', { currentVersion: record?.version ?? null });
  const currentGroups = await demandGroupsInTx(tx, demandId);
  if (groups.length !== currentGroups.length || currentGroups.some((group) => !groupIds.includes(group.id))) throw new BatchError('DEMAND_ASSIGNMENT_CONFLICT', 409, '需求所属批次已变化，请重新读取。');
  const management = await managementInTx(tx, demandId, groups);
  if (!management.canEdit) throw new BatchError(management.lifecycle === 'cancelled' ? 'DEMAND_CANCELLED' : 'DEMAND_READ_ONLY', 409, management.reason ?? '需求目前只读。');
  return { record, groups };
}
async function mutateDemand(demandId: string, actorId: string, input: DemandCancelInput | DemandRevisionInput, cancelled: boolean) {
  const action = cancelled ? 'demand.cancel' : 'demand.revise', requestHash = documentDigest({ action, demandId, input });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`demand-operation:${input.operationId}`},0))`);
    await requireBatchActor(tx, actorId);
    const [existing] = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, input.operationId));
    if (existing) {
      if (existing.actorId !== actorId || existing.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于不同请求。');
      return { ...existing.result, replayed: true } as { demand: ReturnType<typeof serializeDemand>; replayed: boolean };
    }
    const { record, groups } = await lockDemandMutationInTx(tx, demandId, input.expectedVersion);
    const patch = 'fields' in input ? Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [key, value === '' ? null : value])) : {};
    if ('channel' in patch && patch.channel !== record.snapshot.channel && groups.length) {
      const peers = await tx.select({ snapshot: demands.snapshot }).from(subBatchMembers).innerJoin(demands, eq(subBatchMembers.demandId, demands.id))
        .where(and(inArray(subBatchMembers.groupId, groups.map((group) => group.id)), eq(subBatchMembers.active, true), ne(subBatchMembers.demandId, demandId)));
      if (peers.some((peer) => peer.snapshot.channel !== patch.channel)) throw new BatchError('GROUP_SCOPE_MISMATCH', 422, '修改后的渠道须与同批次其他货件一致，请先调整分组。');
    }
    const snapshot = { ...record.snapshot, ...patch };
    const changed = cancelled || documentDigest(snapshot) !== documentDigest(record.snapshot);
    let demand = serializeDemand(record);
    if (changed) {
      const version = record.version + 1;
      await tx.insert(demandRevisions).values({ id: randomUUID(), demandId, version, snapshot, createdBy: actorId });
      const [updated] = await tx.update(demands).set({ snapshot, version, updatedAt: new Date() }).where(eq(demands.id, demandId)).returning();
      for (const group of groups) await reviseGroupAfterDemandMutationInTx(tx, group, demandId, version, actorId, cancelled, input.reason);
      demand = serializeDemand(updated!);
    }
    const result = { demand };
    await tx.insert(batchOperations).values({ operationId: input.operationId, actorId, action, requestHash, result });
    await tx.insert(operationAudit).values({ id: randomUUID(), action, targetId: demandId, actorUserId: actorId, requestHash, details: { operationId: input.operationId, reason: input.reason, version: String(demand.version) } });
    return { ...result, replayed: false };
  });
}
export async function reviseDemand(demandId: string, actorId: string, input: DemandRevisionInput) { return mutateDemand(demandId, actorId, demandRevisionInputSchema.parse(input), false); }
export async function cancelDemand(demandId: string, actorId: string, input: DemandCancelInput) { return mutateDemand(demandId, actorId, demandCancelInputSchema.parse(input), true); }
