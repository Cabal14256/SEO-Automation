import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { shipmentDataSchema, type AllocationCode, type BatchIssue, type BatchMutationResult, type ConfirmAndAllocateSubBatchInput, type DemandRecord, type GroupConfirmation, type ShipmentData, type ShipmentRevision, type SubBatchDetail, type SubBatchRecord, type WeeklyBatch } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demands, operationAudit, user } from '../../db/schema.js';
import { batchSyncItems, batchSyncRuns } from '../lingxing/sync-schema.js';
import { allocationCodes, batchDecisions, batchOperations, batchPrintRecords, groupConfirmations, shipmentRevisions, subBatchMembers, subBatchRevisions, subBatches, weeklyBatches } from './schema.js';
import { alphabeticPrefix, BATCH_RULE_VERSION, validateShipmentData } from './validation.js';
import { demandLifecycleCondition, loadDemandCancellationsInTx, requireActiveDemandInTx } from '../imports/demand-lifecycle.js';
import { shippingRuns, shippingTicketMembers } from '../shipping-runs/schema.js';
import { batchExports } from './export-schema.js';

export type BatchTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class BatchError extends Error {
  constructor(public code: string, public status: 401 | 403 | 404 | 409 | 422 | 503, message: string, public details?: unknown) { super(message); }
}
export async function requireBatchActor(tx: BatchTx, actorId: string) {
  const [actor] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
  if (!actor || actor.banned || actor.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '当前账号没有批次操作权限。');
  return actor;
}
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function serializeDemand(row: typeof demands.$inferSelect): DemandRecord { return { id: row.id, snapshot: row.snapshot, version: row.version, businessDate: row.businessDate, weekStartDate: row.weekStartDate, weekEndDate: row.weekEndDate, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
export function serializeShipment(row: typeof shipmentRevisions.$inferSelect): ShipmentRevision { return { ...row, source: row.source as ShipmentRevision['source'], createdAt: row.createdAt.toISOString() }; }
const serializeBatch = (row: typeof weeklyBatches.$inferSelect): WeeklyBatch => ({ ...row, sortMode: row.sortMode as WeeklyBatch['sortMode'], createdAt: row.createdAt.toISOString() });
const serializeConfirmation = (row: typeof groupConfirmations.$inferSelect): GroupConfirmation => ({ ...row, createdAt: row.createdAt.toISOString() });
const serializeCode = (row: typeof allocationCodes.$inferSelect): AllocationCode => ({ ...row, createdAt: row.createdAt.toISOString() });
async function groupRecord(tx: BatchTx, row: typeof subBatches.$inferSelect): Promise<SubBatchRecord> {
  const members = await tx.select({ demandId: subBatchMembers.demandId }).from(subBatchMembers).where(and(eq(subBatchMembers.groupId, row.id), eq(subBatchMembers.active, true))).orderBy(asc(subBatchMembers.demandId));
  let demandIds = members.map((m) => m.demandId);
  if (!demandIds.length && row.status === 'superseded') { const [historical] = await tx.select().from(subBatchRevisions).where(eq(subBatchRevisions.groupId,row.id)).orderBy(desc(subBatchRevisions.version)).limit(1); demandIds = historical?.snapshot.demandIds ?? []; }
  return { ...row, status: row.status as SubBatchRecord['status'], demandIds, frozenAt: row.frozenAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
async function operation(actorId: string, operationId: string, action: string, input: unknown, execute: (tx: BatchTx) => Promise<Omit<BatchMutationResult, 'operationId' | 'replayed'>>, auditDetails: Record<string, string> = {}) {
  const requestHash = hash({ action, input });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`batch-operation:${operationId}`},0))`);
    await requireBatchActor(tx, actorId);
    const [existing] = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, operationId));
    if (existing) {
      if (existing.actorId !== actorId || existing.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他请求。');
      return { ...existing.result, replayed: true } as BatchMutationResult;
    }
    if(['sub_batch.members','sub_batch.merge','sub_batch.split','sub_batch.move','sub_batch.correction'].includes(action)){
      const request=input as {groupId?:string;targetGroupId?:string;sourceGroupIds?:string[]};
      const ids=[request.groupId,request.targetGroupId,...request.sourceGroupIds??[]].filter((id):id is string=>Boolean(id));
      if(ids.length){
        const groups=await tx.select({batchId:subBatches.batchId}).from(subBatches).where(inArray(subBatches.id,ids));
        const batchIds=[...new Set(groups.map((group)=>group.batchId))].sort();
        if(batchIds.length){
          const values=sql.join(batchIds.map((id)=>sql`${id}::uuid`),sql`,`);
          await tx.execute(sql`SELECT id FROM shipping_run WHERE id IN (SELECT shipping_run_id FROM weekly_batch WHERE id IN (${values}) UNION SELECT m.run_id FROM shipping_ticket_member m JOIN sub_batch g ON g.id=m.group_id WHERE g.batch_id IN (${values})) ORDER BY id FOR UPDATE`);
          await tx.select({id:weeklyBatches.id}).from(weeklyBatches).where(inArray(weeklyBatches.id,batchIds)).orderBy(asc(weeklyBatches.id)).for('update');
          const references=await tx.select({runId:shippingTicketMembers.runId}).from(shippingTicketMembers).where(inArray(shippingTicketMembers.groupId,ids));
          for(const runId of [...new Set(references.map((reference)=>reference.runId))].sort())await createRunBatchInTx(tx,runId,actorId);
        }
      }
    }
    const result: BatchMutationResult = { operationId, ...await execute(tx), replayed: false };
    if (['sub_batch.members','sub_batch.merge','sub_batch.split','sub_batch.move','sub_batch.correction'].includes(action)) {
      const source = input as {groupId?:string;sourceGroupIds?:string[];targetGroupId?:string};
      await refreshShippingGroupLinksInTx(tx,[source.groupId,source.targetGroupId,...source.sourceGroupIds??[],result.groupId,...result.groupIds??[]].filter((id):id is string=>Boolean(id)),action==='sub_batch.members');
    }
    await tx.insert(batchOperations).values({ operationId, actorId, action, requestHash, result });
    await tx.insert(operationAudit).values({ id: randomUUID(), action, targetId: result.groupId ?? result.batchId ?? result.groupIds?.[0] ?? operationId, actorUserId: actorId, requestHash, details: { operationId, ...auditDetails } });
    return result;
  });
}
export async function lockBatchRunScopesInTx(tx: BatchTx, batchId: string) {
  // All writers, including legacy shared groups, take occurrence locks before container locks.
  await tx.execute(sql`SELECT id FROM shipping_run WHERE id IN (
    SELECT shipping_run_id FROM weekly_batch WHERE id=${batchId}::uuid
    UNION SELECT m.run_id FROM shipping_ticket_member m JOIN sub_batch g ON g.id=m.group_id WHERE g.batch_id=${batchId}::uuid
  ) ORDER BY id FOR UPDATE`);
}
async function lockBatch(tx: BatchTx, batchId: string, version?: number) {
  await lockBatchRunScopesInTx(tx, batchId);
  const [batch] = await tx.select().from(weeklyBatches).where(eq(weeklyBatches.id, batchId)).for('update');
  if (!batch) throw new BatchError('NOT_FOUND', 404, '处理批次不存在。');
  if (version !== undefined && batch.version !== version) throw new BatchError('VERSION_CONFLICT', 409, '处理批次已经变化，请刷新。', { currentVersion: batch.version });
  return batch;
}
async function lockGroup(tx: BatchTx, groupId: string, version?: number, allowFrozen = false) {
  const [initial] = await tx.select().from(subBatches).where(eq(subBatches.id, groupId));
  if (!initial) throw new BatchError('NOT_FOUND', 404, '子批次不存在。');
  const batch = await lockBatch(tx, initial.batchId);
  const [group] = await tx.select().from(subBatches).where(eq(subBatches.id, groupId)).for('update');
  if (!group) throw new BatchError('NOT_FOUND', 404, '子批次不存在。');
  if (version !== undefined && group.version !== version) throw new BatchError('VERSION_CONFLICT', 409, '子批次已经变化，请刷新。', { currentVersion: group.version });
  if (group.status === 'superseded') throw new BatchError('GROUP_SUPERSEDED', 409, '子批次已经被更正版本替代。');
  if ((group.frozenAt || group.status === 'frozen') && !allowFrozen) throw new BatchError('GROUP_FROZEN', 409, '子批次已导出或打印，请发起更正。');
  return { group, batch };
}
async function saveRevision(tx: BatchTx, group: typeof subBatches.$inferSelect, actorId: string, action: string, reason: string) {
  await tx.insert(subBatchRevisions).values({ id: randomUUID(), groupId: group.id, version: group.version, snapshot: await groupRecord(tx, group), action, reason, createdBy: actorId });
}
async function selectedDemands(tx: BatchTx, _batch: typeof weeklyBatches.$inferSelect, ids: string[], expected?: Record<string, number>, enforceScope = true) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new BatchError('VALIDATION_ERROR', 422, '成员范围为空或包含重复需求。');
  const rows = await tx.select().from(demands).where(inArray(demands.id, ids)).orderBy(asc(demands.id)).for('share');
  if (rows.length !== ids.length) throw new BatchError('NOT_FOUND', 404, '所选需求不存在。');
  if ((await loadDemandCancellationsInTx(tx, ids)).size) throw new BatchError('DEMAND_CANCELLED', 409, '所选需求已取消，不能安排发货。');
  for (const row of rows) {
    if (expected && expected[row.id] !== row.version) throw new BatchError('DEMAND_VERSION_CONFLICT', 409, '所选需求版本已经变化。', { demandId: row.id, currentVersion: row.version });
  }
  const first = rows[0]!;
  if (enforceScope && rows.some((r) => r.sid !== first.sid || r.snapshot.country !== first.snapshot.country || r.snapshot.channel !== first.snapshot.channel)) throw new BatchError('GROUP_SCOPE_MISMATCH', 422, '人工合组要求店铺、国家和业务渠道一致。');
  return rows;
}
async function setMembers(tx: BatchTx, group: typeof subBatches.$inferSelect, rows: Array<typeof demands.$inferSelect>) {
  for (const row of [...rows].sort((a,b)=>a.id.localeCompare(b.id))) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-demand:${row.id}`},0))`);
  const occupied = await tx.select().from(subBatchMembers).where(and(eq(subBatchMembers.active, true), inArray(subBatchMembers.demandId, rows.map((r) => r.id))));
  if (occupied.some((m) => m.groupId !== group.id)) throw new BatchError('MEMBER_ALREADY_GROUPED', 409, '需求已属于其他有效批次。', { demandIds: occupied.filter((m) => m.groupId !== group.id).map((m) => m.demandId) });
  const ticketMembers = await tx.select().from(shippingTicketMembers).where(inArray(shippingTicketMembers.demandId, rows.map((r)=>r.id)));
  const [scope] = await tx.select().from(weeklyBatches).where(eq(weeklyBatches.id, group.batchId));
  if (scope?.shippingRunId && ticketMembers.some((member)=>member.runId !== scope.shippingRunId)) throw new BatchError('MEMBER_ALREADY_SHIPPED',409,'需求已属于其他发货次。');
  await tx.update(subBatchMembers).set({ active: false }).where(and(eq(subBatchMembers.groupId, group.id), eq(subBatchMembers.active, true)));
  for (const row of rows) await tx.insert(subBatchMembers).values({ id: randomUUID(), batchId: group.batchId, groupId: group.id, demandId: row.id, demandVersion: row.version });
}

export async function assertMutableBatchArrangementInTx(tx: BatchTx, batchId: string, groupId?:string) {
  const [scope] = await tx.select().from(weeklyBatches).where(eq(weeklyBatches.id,batchId));
  const references = await tx.select({ runId: shippingTicketMembers.runId }).from(shippingTicketMembers).innerJoin(subBatches,eq(subBatches.id,shippingTicketMembers.groupId)).where(and(eq(subBatches.batchId,batchId),groupId?eq(subBatches.id,groupId):undefined));
  const ids = [...new Set([scope?.shippingRunId,...references.map((m)=>m.runId)].filter((id):id is string=>Boolean(id)))];
  if (!ids.length) throw new BatchError('SHIPPING_RUN_REQUIRED',409,'请先将历史批次关联到发货次，再调整发货安排。');
  const runs = await tx.select().from(shippingRuns).where(inArray(shippingRuns.id,ids));
  if (runs.some((run)=>run.membershipFrozenAt)) throw new BatchError('SHIPPING_RUN_FROZEN',409,'本次发货安排已冻结，请先发起发货次更正。');
  if (runs.some((run)=>['queued','running'].includes(run.status))) throw new BatchError('SHIPPING_RUN_BUSY',409,'本次发货正在整理，请完成后调整安排。');
  const pending = await tx.select({id:batchExports.id}).from(batchExports).where(and(inArray(batchExports.status,['queued','running']),or(sql`${batchExports.projection}->>'shippingRunId' IN (${sql.join(ids.map((id)=>sql`${id}`),sql`,`)})`,sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${batchExports.groupIds}) item WHERE item IN (SELECT id::text FROM sub_batch WHERE batch_id=${batchId}::uuid ${groupId?sql`AND id=${groupId}::uuid`:sql``}))`))).limit(1);
  if (pending.length) throw new BatchError('EXPORT_IN_PROGRESS',409,'本次发货正在导出，请等待导出结束。');
}

export async function createRunBatchInTx(tx: BatchTx, runId: string, actorId: string): Promise<{batchId:string}> {
  const [run] = await tx.select().from(shippingRuns).where(eq(shippingRuns.id,runId)).for('update');
  if (!run) throw new BatchError('NOT_FOUND',404,'发货次不存在。');
  const [existing] = await tx.select().from(weeklyBatches).where(eq(weeklyBatches.shippingRunId,runId));
  const legacyCodes=await tx.select({prefix:allocationCodes.prefix}).from(allocationCodes).where(sql`${allocationCodes.groupId} IN (SELECT group_id FROM shipping_ticket_member WHERE run_id=${runId}::uuid)`);
  const reserved=legacyCodes.reduce((last,{prefix})=>/^[A-Z]+$/.test(prefix)?Math.max(last,[...prefix].reduce((value,char)=>value*26+char.charCodeAt(0)-64,0)):last,0);
  if (existing) {if(reserved>existing.nextPrefix)await tx.update(weeklyBatches).set({nextPrefix:reserved}).where(eq(weeklyBatches.id,existing.id));return {batchId:existing.id};}
  const start = new Date(`${run.numberingDate}T00:00:00Z`); start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
  const weekStartDate = start.toISOString().slice(0,10); start.setUTCDate(start.getUTCDate()+6);
  const id=randomUUID(); await tx.insert(weeklyBatches).values({id,shippingRunId:runId,weekStartDate,weekEndDate:start.toISOString().slice(0,10),nextPrefix:reserved,createdBy:actorId});
  return {batchId:id};
}
export async function createRunBatch(runId:string, actorId:string) { return db.transaction(async(tx)=>{await requireBatchActor(tx,actorId);return createRunBatchInTx(tx,runId,actorId);}); }

type GroupMembersInput = {name:string;demandIds:string[];expectedDemandVersions:Record<string,number>;reason:string};
export async function createSubBatchInTx(tx:BatchTx,batchId:string,input:GroupMembersInput,actorId:string):Promise<{groupId:string;batchId:string}> {
  const batch=await lockBatch(tx,batchId);const rows=await selectedDemands(tx,batch,input.demandIds,input.expectedDemandVersions);
  const [group]=await tx.insert(subBatches).values({id:randomUUID(),batchId,name:input.name,position:batch.version,createdBy:actorId}).returning();
  await setMembers(tx,group!,rows);await saveRevision(tx,group!,actorId,'create',input.reason);
  await tx.update(weeklyBatches).set({version:batch.version+1}).where(eq(weeklyBatches.id,batchId));return {groupId:group!.id,batchId};
}
export async function appendSubBatchMembersInTx(tx:BatchTx,groupId:string,input:Omit<GroupMembersInput,'name'>&{expectedVersion:number},actorId:string):Promise<void> {
  const {group,batch}=await lockGroup(tx,groupId,input.expectedVersion);const previous=await groupRecord(tx,group);
  const rows=await selectedDemands(tx,batch,input.demandIds,input.expectedDemandVersions);
  const removed=previous.demandIds.filter((id)=>!input.demandIds.includes(id));if(removed.length)await invalidateCodes(tx,groupId,removed);
  await setMembers(tx,group,rows);await revise(tx,group,actorId,'members',input.reason);await tx.update(weeklyBatches).set({version:batch.version+1}).where(eq(weeklyBatches.id,batch.id));
}
export async function bindLegacyGroupToRunInTx(tx:BatchTx,batchId:string,existingGroupId:string,input:GroupMembersInput&{expectedGroupVersion:number},actorId:string):Promise<{groupId:string;batchId:string}> {
  const {group}=await lockGroup(tx,existingGroupId,input.expectedGroupVersion);
  const [sync]=await tx.select({id:batchSyncRuns.id}).from(batchSyncRuns).where(and(eq(batchSyncRuns.subBatchId,existingGroupId),inArray(batchSyncRuns.status,['queued','running']))).limit(1);
  if(sync)throw new BatchError('SYNC_ACTIVE',409,'历史批次正在同步，请完成后关联发货次。');
  const linked=await tx.select({id:shippingTicketMembers.id}).from(shippingTicketMembers).where(eq(shippingTicketMembers.groupId,existingGroupId)).limit(1);
  if(linked.length)throw new BatchError('GROUP_ALREADY_ASSIGNED',409,'该批次已有发货次归属，请打开原发货次。');
  const previous=await groupRecord(tx,group);
  if(previous.demandIds.length!==input.demandIds.length||previous.demandIds.some((id)=>!input.demandIds.includes(id)))throw new BatchError('GROUP_SCOPE_MISMATCH',422,'关联历史批次必须包含其全部当前成员。');
  await tx.update(subBatchMembers).set({active:false}).where(and(eq(subBatchMembers.groupId,existingGroupId),eq(subBatchMembers.active,true)));
  await invalidateCodes(tx,existingGroupId);
  const result=await createSubBatchInTx(tx,batchId,input,actorId);
  const [old]=await tx.update(subBatches).set({version:group.version+1,status:'superseded',confirmedVersion:null,replacedById:result.groupId,updatedAt:new Date()}).where(eq(subBatches.id,existingGroupId)).returning();
  await saveRevision(tx,old!,actorId,'assign_shipping_run',input.reason);
  await tx.update(weeklyBatches).set({version:sql`${weeklyBatches.version}+1`}).where(eq(weeklyBatches.id,group.batchId));
  return result;
}
async function refreshShippingGroupLinksInTx(tx:BatchTx,groupIds:string[],addMembers=false) {
  if(!groupIds.length)return;
  const members=await tx.select().from(shippingTicketMembers).where(inArray(shippingTicketMembers.groupId,groupIds));
  if(!members.length)return;
  const ids=members.flatMap((member)=>member.demandId?[member.demandId]:[]);
  const active=ids.length?await tx.select().from(subBatchMembers).where(and(inArray(subBatchMembers.demandId,ids),eq(subBatchMembers.active,true))):[];
  for(const member of members){const current=active.find((entry)=>entry.demandId===member.demandId);if(current)await tx.update(shippingTicketMembers).set({groupId:current.groupId}).where(eq(shippingTicketMembers.id,member.id));else await tx.delete(shippingTicketMembers).where(eq(shippingTicketMembers.id,member.id));}
  const current=addMembers?await tx.select({membership:subBatchMembers,demand:demands}).from(subBatchMembers).innerJoin(demands,eq(demands.id,subBatchMembers.demandId)).where(and(inArray(subBatchMembers.groupId,groupIds),eq(subBatchMembers.active,true))):[];
  for(const {membership,demand} of current){
    const [already]=await tx.select({id:shippingTicketMembers.id}).from(shippingTicketMembers).where(eq(shippingTicketMembers.demandId,demand.id));if(already)continue;
    const anchors=members.filter((member)=>member.groupId===membership.groupId),tickets=[...new Set(anchors.map((member)=>member.ticketId))];
    if(tickets.length!==1)throw new BatchError('TICKET_REQUIRED',409,'追加需求须选择明确的发货票，请使用加入批次入口。');
    const anchor=anchors[0]!;const ticketMembers=await tx.select({order:shippingTicketMembers.inputOrder}).from(shippingTicketMembers).where(eq(shippingTicketMembers.ticketId,anchor.ticketId));
    await tx.insert(shippingTicketMembers).values({id:randomUUID(),runId:anchor.runId,ticketId:anchor.ticketId,demandId:demand.id,fba:demand.fba,sid:demand.sid,inputOrder:ticketMembers.reduce((last,item)=>Math.max(last,item.order),0)+1,groupId:membership.groupId});
  }
  for(const ticketId of new Set(members.map((member)=>member.ticketId))){const [remaining]=await tx.select({id:shippingTicketMembers.id}).from(shippingTicketMembers).where(eq(shippingTicketMembers.ticketId,ticketId)).limit(1);if(!remaining)throw new BatchError('EMPTY_TICKET',422,'调整后发货票不能为空，请保留至少一个货件。');}
  for(const runId of [...new Set(members.map((member)=>member.runId))].sort()){
    const [run]=await tx.select().from(shippingRuns).where(eq(shippingRuns.id,runId));if(!run)continue;
    const operations=Object.fromEntries(Object.entries(run.checkpoint.operations).filter(([key])=>!groupIds.some((id)=>key===`confirm:${id}`||key===`sync:${id}`)));
    await tx.update(shippingRuns).set({version:run.version+1,status:run.origin==='manual'?'draft':'needs_review',stage:'sync',issues:[],error:null,checkpoint:{...run.checkpoint,operations},updatedAt:new Date()}).where(eq(shippingRuns.id,runId));
  }
}
async function requireSameOccurrenceInTx(tx:BatchTx,leftBatchId:string,rightBatchId:string,leftGroupId:string,rightGroupId:string){
  const runIds=async(batchId:string,groupId:string)=>{const [scope]=await tx.select().from(weeklyBatches).where(eq(weeklyBatches.id,batchId));const linked=await tx.select({runId:shippingTicketMembers.runId}).from(shippingTicketMembers).where(eq(shippingTicketMembers.groupId,groupId));return [...new Set([scope?.shippingRunId,...linked.map((entry)=>entry.runId)].filter(Boolean))];};
  const left=await runIds(leftBatchId,leftGroupId),right=await runIds(rightBatchId,rightGroupId);
  if(left.length!==1||right.length!==1||left[0]!==right[0])throw new BatchError('SHIPPING_RUN_SCOPE_MISMATCH',422,'只能调整同一次发货内的处理组。');
}
async function invalidateCodes(tx: BatchTx, groupId: string, demandIds?: string[]) {
  await tx.update(allocationCodes).set({ valid: false }).where(and(eq(allocationCodes.groupId, groupId), eq(allocationCodes.valid, true), demandIds ? inArray(allocationCodes.demandId, demandIds) : undefined));
}
async function revise(tx: BatchTx, group: typeof subBatches.$inferSelect, actorId: string, action: string, reason: string, clearPrefix = false) {
  const [updated] = await tx.update(subBatches).set({ version: group.version + 1, status: 'draft', confirmedVersion: null, updatedAt: new Date(), ...(clearPrefix ? { prefix: null } : {}) }).where(eq(subBatches.id, group.id)).returning();
  await saveRevision(tx, updated!, actorId, action, reason); return updated!;
}
/** The caller holds occurrence, container, group and demand locks and has appended the demand revision. */
export async function reviseGroupAfterDemandMutationInTx(tx: BatchTx, group: typeof subBatches.$inferSelect, demandId: string, demandVersion: number, actorId: string, cancelled: boolean, reason: string) {
  await tx.update(subBatchMembers).set(cancelled ? { active: false } : { demandVersion }).where(and(eq(subBatchMembers.groupId, group.id), eq(subBatchMembers.demandId, demandId), eq(subBatchMembers.active, true)));
  await invalidateCodes(tx, group.id, [demandId]);
  await revise(tx, group, actorId, cancelled ? 'demand_cancel' : 'demand_revise', reason);
  await tx.update(weeklyBatches).set({ version: sql`${weeklyBatches.version}+1` }).where(eq(weeklyBatches.id, group.batchId));
  await refreshShippingGroupLinksInTx(tx,[group.id]);
}
export async function listWeeklyBatches(actorId: string) {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const batches = await tx.select({batch:weeklyBatches,run:shippingRuns}).from(weeklyBatches).leftJoin(shippingRuns,eq(shippingRuns.id,weeklyBatches.shippingRunId)).orderBy(desc(weeklyBatches.createdAt));
    return { items: batches.map(({batch,run})=>({...serializeBatch(batch),month:run?.month??null,sequence:run?.sequence??null,numberingDate:run?.numberingDate??null})), availableWeeks: [] };
  });
}
export async function createWeeklyBatch(input: { operationId: string; weekStartDate: string }, actorId: string) {
  return operation(actorId, input.operationId, 'batch.create', input, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`week:${input.weekStartDate}`},0))`);
    const [existing] = await tx.select().from(weeklyBatches).where(and(eq(weeklyBatches.weekStartDate, input.weekStartDate),isNull(weeklyBatches.shippingRunId)));
    if (existing) return { batchId: existing.id };
    const [demand] = await tx.select().from(demands).where(and(eq(demands.weekStartDate, input.weekStartDate), demandLifecycleCondition('active'))).limit(1);
    if (!demand) throw new BatchError('NO_DEMANDS', 422, '该周没有已提交需求。');
    const id = randomUUID(); await tx.insert(weeklyBatches).values({ id, weekStartDate: demand.weekStartDate, weekEndDate: demand.weekEndDate, createdBy: actorId });
    return { batchId: id };
  });
}
export async function getWeeklyBatch(batchId: string, actorId: string) {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const [batch] = await tx.select().from(weeklyBatches).where(eq(weeklyBatches.id, batchId)); if (!batch) throw new BatchError('NOT_FOUND', 404, '处理批次不存在。');
    const [run] = batch.shippingRunId ? await tx.select().from(shippingRuns).where(eq(shippingRuns.id,batch.shippingRunId)) : [];
    const rows = await tx.select().from(subBatches).where(eq(subBatches.batchId, batchId)).orderBy(asc(subBatches.position), asc(subBatches.id));
    const groups = await Promise.all(rows.map((g) => groupRecord(tx, g)));
    const members = await tx.select({ demandId: subBatchMembers.demandId }).from(subBatchMembers).where(eq(subBatchMembers.active, true));
    const assigned = new Set(members.map((m) => m.demandId));
    const rows2 = await tx.select().from(demands).where(demandLifecycleCondition('active')).orderBy(asc(demands.fba), asc(demands.sid));
    const activeGroups = groups.filter((g) => g.status !== 'superseded');
    if (batch.sortMode === 'fba') { const fbaMap = new Map(rows2.map((d) => [d.id, d.fba])); const key=(g:SubBatchRecord)=>g.demandIds.map((id)=>fbaMap.get(id)??'').sort()[0]??'';activeGroups.sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0); }
    return { batch: {...serializeBatch(batch),month:run?.month??null,sequence:run?.sequence??null,numberingDate:run?.numberingDate??null}, groups: [...activeGroups, ...groups.filter((g) => g.status === 'superseded')], ungrouped: rows2.filter((d) => !assigned.has(d.id)).map(serializeDemand) };
  }, { isolationLevel: 'repeatable read' });
}
export async function createSubBatch(batchId: string, input: { operationId: string; expectedVersion: number; name: string; demandIds: string[]; expectedDemandVersions: Record<string,number>; reason: string }, actorId: string) {
  return operation(actorId, input.operationId, 'sub_batch.create', { batchId,...input }, async (tx) => {
    const batch = await lockBatch(tx,batchId,input.expectedVersion); const rows = await selectedDemands(tx,batch,input.demandIds,input.expectedDemandVersions);
    const [group] = await tx.insert(subBatches).values({ id:randomUUID(),batchId,name:input.name,position:batch.version,createdBy:actorId }).returning();
    await setMembers(tx,group!,rows); await saveRevision(tx,group!,actorId,'create',input.reason);
    await tx.update(weeklyBatches).set({ version:batch.version+1 }).where(eq(weeklyBatches.id,batchId)); return { groupId:group!.id,batchId };
  });
}
export async function replayRetiredBatchOperation(actorId:string,operationId:string,action:string,input:unknown):Promise<BatchMutationResult> {
  return db.transaction(async(tx)=>{
    await requireBatchActor(tx,actorId);
    const [existing]=await tx.select().from(batchOperations).where(eq(batchOperations.operationId,operationId));
    if(!existing)throw new BatchError('LEGACY_FLOW_RETIRED',409,'旧版建立流程已停用，原请求尚未执行，请保留需求选择并改用发货次建立。');
    if(existing.actorId!==actorId||existing.requestHash!==hash({action,input}))throw new BatchError('OPERATION_CONFLICT',409,'操作编号已用于其他请求。');
    return {...existing.result,replayed:true} as BatchMutationResult;
  });
}
export async function updateMembers(groupId: string, input: {operationId:string;expectedVersion:number;demandIds:string[];expectedDemandVersions:Record<string,number>;reason:string}, actorId:string) {
  return operation(actorId,input.operationId,'sub_batch.members',{groupId,...input},async(tx)=>{
    const {group,batch}=await lockGroup(tx,groupId,input.expectedVersion); await assertMutableBatchArrangementInTx(tx,batch.id,group.id); const previous=await groupRecord(tx,group); const rows=await selectedDemands(tx,batch,input.demandIds,input.expectedDemandVersions);
    const removed=previous.demandIds.filter((id)=>!input.demandIds.includes(id)); if(removed.length) await invalidateCodes(tx,groupId,removed);
    await setMembers(tx,group,rows); await revise(tx,group,actorId,'members',input.reason); await tx.update(weeklyBatches).set({version:batch.version+1}).where(eq(weeklyBatches.id,batch.id)); return {groupId,batchId:batch.id};
  });
}
export async function reorderGroups(batchId:string,input:{operationId:string;expectedVersion:number;groupIds:string[];reason:string},actorId:string){
  return operation(actorId,input.operationId,'batch.reorder',{batchId,...input},async(tx)=>{const batch=await lockBatch(tx,batchId,input.expectedVersion);const groups=await tx.select().from(subBatches).where(and(eq(subBatches.batchId,batchId),sql`${subBatches.status}<>'superseded'`));
    if(new Set(input.groupIds).size!==groups.length||input.groupIds.length!==groups.length||groups.some((g)=>!input.groupIds.includes(g.id)))throw new BatchError('VALIDATION_ERROR',422,'排序必须包含本次发货全部有效处理组且不能重复。');
    const previousOrder=[...groups].sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id)).map((g)=>g.id);await tx.insert(operationAudit).values({id:randomUUID(),action:'batch.order_saved',targetId:batchId,actorUserId:actorId,requestHash:hash(input),details:{operationId:input.operationId,oldSortMode:batch.sortMode,oldOrder:JSON.stringify(previousOrder),newOrder:JSON.stringify(input.groupIds),sortVersion:String(batch.version+1),reason:input.reason}});
    for(const [position,id] of input.groupIds.entries())await tx.update(subBatches).set({position,updatedAt:new Date()}).where(eq(subBatches.id,id));
    await tx.update(weeklyBatches).set({version:batch.version+1,sortMode:'manual'}).where(eq(weeklyBatches.id,batchId));return{batchId};});
}
async function detailInTx(tx:BatchTx,groupId:string):Promise<SubBatchDetail>{
  const [row]=await tx.select().from(subBatches).where(eq(subBatches.id,groupId));if(!row)throw new BatchError('NOT_FOUND',404,'子批次不存在。'); const group=await groupRecord(tx,row);
  const memberRows=group.demandIds.length?await tx.select().from(demands).where(inArray(demands.id,group.demandIds)).orderBy(asc(demands.fba),asc(demands.sid)):[];
  const ships=group.demandIds.length?await tx.select().from(shipmentRevisions).where(inArray(shipmentRevisions.demandId,group.demandIds)).orderBy(desc(shipmentRevisions.version)):[];
  const latest=new Map<string,ShipmentRevision>();for(const s of ships)if(!latest.has(s.demandId))latest.set(s.demandId,serializeShipment(s));
  const decisions=await tx.select().from(batchDecisions).where(eq(batchDecisions.groupId,groupId));
  const issues:BatchIssue[]=[];const first=memberRows[0];if(first&&memberRows.some((m)=>m.sid!==first.sid||m.snapshot.country!==first.snapshot.country||m.snapshot.channel!==first.snapshot.channel))issues.push({code:'GROUP_SCOPE_MISMATCH',severity:'error',message:'当前成员的店铺、国家或业务渠道不同，请调整分组。'}); const shipments=memberRows.map((d)=>{const revision=latest.get(d.id)??null;
    if(!revision)issues.push({code:'SHIPMENT_NOT_SYNCED',severity:'error',message:'货件尚未同步或补录。',demandId:d.id});
    else {if(revision.demandVersion!==d.version)issues.push({code:'DEMAND_VERSION_STALE',severity:'error',message:'货件候选未绑定当前需求版本，请重新同步或补录。',demandId:d.id});
      for(const issue of validateShipmentData(revision.data)){const resolved=issue.code==='LIST_QUANTITY_MISMATCH'&&decisions.some((decision)=>decision.demandId===d.id&&decision.shipmentVersion===revision.version&&decision.issueCode===issue.code);issues.push({...issue,severity:resolved?'warning':issue.severity,demandId:d.id,...(resolved?{message:`已人工决定：${issue.message}`}:{})});}}
    return{demandId:d.id,revision};});
  const [confirmation]=row.confirmedVersion?await tx.select().from(groupConfirmations).where(and(eq(groupConfirmations.groupId,groupId),eq(groupConfirmations.groupVersion,row.confirmedVersion))):[];
  const codes=await tx.select().from(allocationCodes).where(eq(allocationCodes.groupId,groupId)).orderBy(asc(allocationCodes.sequence));
  const history=await tx.select().from(subBatchRevisions).where(eq(subBatchRevisions.groupId,groupId)).orderBy(desc(subBatchRevisions.version));
  const linkedRuns=await tx.select({runId:shippingTicketMembers.runId}).from(shippingTicketMembers).where(eq(shippingTicketMembers.groupId,groupId));
  const [scope]=await tx.select({runId:weeklyBatches.shippingRunId}).from(weeklyBatches).where(eq(weeklyBatches.id,group.batchId));
  const shippingRunIds=[...new Set([scope?.runId,...linkedRuns.map((entry)=>entry.runId)].filter((id):id is string=>Boolean(id)))];
  return{group,shippingRunIds,members:memberRows.map(serializeDemand),shipments,issues,confirmation:confirmation?serializeConfirmation(confirmation):null,codes:codes.map(serializeCode),history:history.map((h)=>({...h,createdAt:h.createdAt.toISOString()}))};
}
export async function getSubBatchDetail(groupId:string,actorId:string){return db.transaction(async(tx)=>{await requireBatchActor(tx,actorId);return detailInTx(tx,groupId);},{isolationLevel:'repeatable read'});}
export type PublishCandidateInput={demandId:string;subBatchId?:string;expectedGroupVersion?:number;expectedDemandVersion:number;actorId:string;data:ShipmentData;source:ShipmentRevision['source'];snapshotIds?:string[];reason?:string};
export async function publishCandidate(input:PublishCandidateInput):Promise<ShipmentRevision>{
  return db.transaction((tx)=>publishCandidateInTx(tx,input));
}
export async function publishCandidateInTx(tx:BatchTx,input:PublishCandidateInput):Promise<ShipmentRevision>{
    await requireBatchActor(tx,input.actorId);
    if(input.subBatchId){if(input.expectedGroupVersion===undefined)throw new BatchError('VERSION_CONFLICT',409,'发布候选需要绑定子批次版本。');const {group}=await lockGroup(tx,input.subBatchId,input.expectedGroupVersion,true);const members=await groupRecord(tx,group);if(!members.demandIds.includes(input.demandId))throw new BatchError('VERSION_CONFLICT',409,'同步成员已变化，结果未发布。');}
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipment:${input.demandId}`},0))`);
    const [demand]=await tx.select().from(demands).where(eq(demands.id,input.demandId)).for('share');
    if(!demand)throw new BatchError('NOT_FOUND',404,'需求不存在。');await requireActiveDemandInTx(tx,demand.id);if(demand.version!==input.expectedDemandVersion)throw new BatchError('DEMAND_VERSION_CONFLICT',409,'需求已变化，候选结果未发布。');
    const data=shipmentDataSchema.parse(input.data);if(data.sid!==demand.sid||data.fba!==demand.fba)throw new BatchError('SHIPMENT_IDENTITY_MISMATCH',422,'查询或补录结果的店铺/FBA与需求不一致。');
    const [latest]=await tx.select().from(shipmentRevisions).where(eq(shipmentRevisions.demandId,demand.id)).orderBy(desc(shipmentRevisions.version)).limit(1);
    const [row]=await tx.insert(shipmentRevisions).values({id:randomUUID(),demandId:demand.id,version:(latest?.version??0)+1,demandVersion:demand.version,data,source:input.source,snapshotIds:input.snapshotIds??[],reason:input.reason??'领星只读同步',createdBy:input.actorId}).returning();
    await tx.insert(operationAudit).values({id:randomUUID(),action:'shipment.candidate',targetId:demand.id,actorUserId:input.actorId,requestHash:hash({demandId:demand.id,version:row!.version}),details:{source:input.source,version:String(row!.version)}});
    return serializeShipment(row!);
}
function assertConfirmationVersions(detail: SubBatchDetail, input: Pick<ConfirmAndAllocateSubBatchInput, 'expectedDemandVersions' | 'expectedShipmentVersions'>, exact = false) {
  if (exact && [input.expectedDemandVersions, input.expectedShipmentVersions].some((versions) => Object.keys(versions).length !== detail.members.length || Object.keys(versions).some((id) => !detail.members.some((member) => member.id === id)))) {
    throw new BatchError('VERSION_CONFLICT', 409, '确认成员范围已变化，请刷新后重试。');
  }
  for (const member of detail.members) {
    if (input.expectedDemandVersions[member.id] !== member.version || input.expectedShipmentVersions[member.id] !== detail.shipments.find((s) => s.demandId === member.id)?.revision?.version) {
      throw new BatchError('VERSION_CONFLICT', 409, '需求或商品箱数据已变化，请重新确认。');
    }
  }
  if (!detail.members.length || detail.issues.some((issue) => issue.severity === 'error')) throw new BatchError('VALIDATION_BLOCKED', 422, '仍有阻塞差异，不能确认。', { issues: detail.issues });
}
function confirmationMatchesCurrent(detail: SubBatchDetail) {
  const snapshot = detail.confirmation?.snapshot;
  return detail.group.status === 'confirmed' && snapshot?.ruleVersion === BATCH_RULE_VERSION
    && snapshot.members.length === detail.members.length && snapshot.shipments.length === detail.shipments.length
    && detail.members.every((member) => snapshot.members.some((accepted) => accepted.id === member.id && accepted.version === member.version))
    && detail.shipments.every((shipment) => shipment.revision && snapshot.shipments.some((accepted) => accepted.demandId === shipment.demandId && accepted.revision.id === shipment.revision!.id));
}
async function confirmGroupInTx(tx: BatchTx, group: typeof subBatches.$inferSelect, detail: SubBatchDetail, actorId: string, reason: string) {
  const version = group.version + 1;
  const snapshot: GroupConfirmation['snapshot'] = { members: detail.members, shipments: detail.shipments.map((s) => ({ demandId: s.demandId, revision: s.revision! })), ruleVersion: BATCH_RULE_VERSION };
  await tx.insert(groupConfirmations).values({ id: randomUUID(), groupId: group.id, groupVersion: version, snapshot, createdBy: actorId });
  const [updated] = await tx.update(subBatches).set({ version, confirmedVersion: version, status: 'confirmed', updatedAt: new Date() }).where(eq(subBatches.id, group.id)).returning();
  await saveRevision(tx, updated!, actorId, 'confirm', reason);
  const currentBoxIds = new Set(snapshot.shipments.flatMap((s) => s.revision.data.boxes.map((box) => box.id)));
  const oldCodes = await tx.select().from(allocationCodes).where(and(eq(allocationCodes.groupId, group.id), eq(allocationCodes.valid, true)));
  for (const code of oldCodes) if (!currentBoxIds.has(code.boxId)) await tx.update(allocationCodes).set({ valid: false }).where(eq(allocationCodes.id, code.id));
  return updated!;
}
export async function confirmGroup(groupId:string,input:{operationId:string;expectedVersion:number;expectedDemandVersions:Record<string,number>;expectedShipmentVersions:Record<string,number>;reason:string},actorId:string){
  return operation(actorId,input.operationId,'sub_batch.confirm',{groupId,...input},async(tx)=>{
    const {group}=await lockGroup(tx,groupId,input.expectedVersion);const record=await groupRecord(tx,group);
    if(record.demandIds.length)await tx.select({id:demands.id}).from(demands).where(inArray(demands.id,record.demandIds)).orderBy(asc(demands.id)).for('share');
    const detail=await detailInTx(tx,groupId);assertConfirmationVersions(detail,input);
    await confirmGroupInTx(tx,group,detail,actorId,input.reason);return{groupId,batchId:group.batchId};
  });
}

async function assertAutomaticSyncSettled(tx: BatchTx, detail: SubBatchDetail) {
  // Do not lock run rows while holding the group lock: retry/worker transactions
  // lock their run before requesting a group share lock. New submissions use the
  // sync-group advisory lock held by confirmAndAllocateGroup.
  const runs = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.subBatchId, detail.group.id)).orderBy(desc(batchSyncRuns.createdAt), desc(batchSyncRuns.id));
  if (runs.some((run) => run.status === 'queued' || run.status === 'running')) throw new BatchError('SYNC_ACTIVE', 409, '同步尚未完成，系统将在同步结束后确认并分配编码。');
  const latest = runs[0];
  if (!latest || !['partial', 'failed'].includes(latest.status)) return;
  const failed = await tx.select().from(batchSyncItems).where(and(eq(batchSyncItems.runId, latest.id), sql`${batchSyncItems.status}<>'completed'`));
  const candidateIds = detail.shipments.flatMap((shipment) => shipment.revision ? [shipment.revision.id] : []);
  // Compare in PostgreSQL so sub-millisecond ordering survives serialization.
  const replacements = candidateIds.length ? await tx.select({ id: shipmentRevisions.id }).from(shipmentRevisions).where(and(inArray(shipmentRevisions.id, candidateIds), sql`${shipmentRevisions.createdAt} > (SELECT ${batchSyncRuns.completedAt} FROM ${batchSyncRuns} WHERE ${batchSyncRuns.id}=${latest.id})`)) : [];
  const replacementIds = new Set(replacements.map((revision) => revision.id));
  const unresolved = failed.filter((item) => {
    const current = detail.shipments.find((shipment) => shipment.demandId === item.demandId)?.revision;
    if (!detail.members.some((member) => member.id === item.demandId)) return false;
    return !current || !replacementIds.has(current.id);
  });
  if (!failed.length || unresolved.length) throw new BatchError('SYNC_FAILED', 409, '最近一次同步存在未解决的失败，请重试同步或补录当前货件后再分配编码。', { runId: latest.id, demandIds: unresolved.map((item) => item.demandId) });
}

const AUTO_CONFIRM_REASON = '系统自动确认当前有效数据版本并分配箱码';
export async function confirmAndAllocateGroup(groupId: string, input: ConfirmAndAllocateSubBatchInput, actorId: string) {
  return operation(actorId, input.operationId, 'sub_batch.confirm_and_allocate', { groupId, ...input }, async (tx) => {
    // Match sync submission order, then serialize all mutations batch -> group ->
    // shipment -> demand. A publisher outside this group cannot change candidates.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sync-group:${groupId}`},0))`);
    const { group, batch } = await lockGroup(tx, groupId, input.expectedVersion);
    if (batch.version !== input.expectedBatchVersion) throw new BatchError('VERSION_CONFLICT', 409, '处理批次已经变化，请刷新。', { currentVersion: batch.version });
    const record = await groupRecord(tx, group);
    for (const demandId of [...record.demandIds].sort()) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipment:${demandId}`},0))`);
    if (record.demandIds.length) await tx.select({ id: demands.id }).from(demands).where(inArray(demands.id, record.demandIds)).orderBy(asc(demands.id)).for('share');
    const detail = await detailInTx(tx, groupId);
    assertConfirmationVersions(detail, input, true);
    await assertAutomaticSyncSettled(tx, detail);
    const changedConfirmation = !confirmationMatchesCurrent(detail);
    const confirmedGroup = changedConfirmation ? await confirmGroupInTx(tx, group, detail, actorId, AUTO_CONFIRM_REASON) : group;
    const confirmed = await confirmedInTx(tx, groupId, false);
    const allocation = await allocateGroupCodesInTx(tx, batch.id, confirmedGroup, confirmed, batch.nextPrefix);
    if (changedConfirmation || allocation.changed) await tx.update(weeklyBatches).set({ nextPrefix: allocation.nextPrefix, version: batch.version + 1 }).where(eq(weeklyBatches.id, batch.id));
    return { groupId, batchId: batch.id };
  }, { reason: AUTO_CONFIRM_REASON });
}
async function confirmedInTx(tx:BatchTx,groupId:string,requireCodes=true){const detail=await detailInTx(tx,groupId);if(!detail.confirmation||!['confirmed','frozen'].includes(detail.group.status))throw new BatchError('CONFIRMATION_REQUIRED',409,'请先确认子批次。');
  if((await loadDemandCancellationsInTx(tx,detail.confirmation.snapshot.members.map((member)=>member.id))).size)throw new BatchError('DEMAND_CANCELLED',409,'确认范围包含已取消需求，不能安排或导出。');
  const snapshot=detail.confirmation.snapshot;if(!detail.group.frozenAt){for(const m of detail.members){const old=snapshot.members.find((d)=>d.id===m.id);const current=detail.shipments.find((s)=>s.demandId===m.id)?.revision;const accepted=snapshot.shipments.find((s)=>s.demandId===m.id)?.revision;if(!old||old.version!==m.version||!current||current.id!==accepted?.id)throw new BatchError('CONFIRMATION_STALE',409,'确认之后需求或候选数据发生变化，请重新确认。');}
  if(detail.issues.some((i)=>i.severity==='error'))throw new BatchError('VALIDATION_BLOCKED',422,'子批次存在阻塞差异。',{issues:detail.issues});}
  const codes=detail.codes.filter((c)=>c.valid);const boxes=snapshot.shipments.flatMap((s)=>s.revision.data.boxes);if(requireCodes&&(codes.length!==boxes.length||boxes.some((b)=>!codes.some((c)=>c.boxId===b.id))))throw new BatchError('CODES_REQUIRED',409,'请先分配全部箱码。');
  return{group:detail.group,members:snapshot.members,shipments:snapshot.shipments,confirmation:detail.confirmation,codes};}
export async function getConfirmedGroup(groupId:string,actorId:string,requireCodes=true){return db.transaction(async(tx)=>{await requireBatchActor(tx,actorId);return confirmedInTx(tx,groupId,requireCodes);},{isolationLevel:'repeatable read'});}
export async function getConfirmedGroupInTx(tx:BatchTx,groupId:string,actorId:string,requireCodes=true){await requireBatchActor(tx,actorId);const{group}=await lockGroup(tx,groupId,undefined,true);const record=await groupRecord(tx,group);if(record.demandIds.length)await tx.select({id:demands.id}).from(demands).where(inArray(demands.id,record.demandIds)).orderBy(asc(demands.id)).for('share');return confirmedInTx(tx,groupId,requireCodes);}
export async function freezeGroupForExport(tx:BatchTx,groupId:string,confirmationId:string,actorId:string){await requireBatchActor(tx,actorId);const {group}=await lockGroup(tx,groupId,undefined,true);const record=await groupRecord(tx,group);if(record.demandIds.length)await tx.select({id:demands.id}).from(demands).where(inArray(demands.id,record.demandIds)).orderBy(asc(demands.id)).for('share');const confirmed=await confirmedInTx(tx,groupId);if(confirmed.confirmation.id!==confirmationId)throw new BatchError('CONFIRMATION_STALE',409,'导出期间确认版本已变化。');await tx.update(subBatches).set({status:'frozen',frozenAt:group.frozenAt??new Date(),updatedAt:new Date()}).where(eq(subBatches.id,groupId));return confirmed;}
async function allocateGroupCodesInTx(tx: BatchTx, batchId: string, group: typeof subBatches.$inferSelect, detail: Awaited<ReturnType<typeof confirmedInTx>>, nextPrefix: number) {
  const [parent] = await tx.select().from(weeklyBatches).where(eq(weeklyBatches.id,batchId));
  const linked = await tx.select({runId:shippingTicketMembers.runId}).from(shippingTicketMembers).where(eq(shippingTicketMembers.groupId,group.id));
  const runIds=[...new Set([parent?.shippingRunId,...linked.map((entry)=>entry.runId)].filter((id):id is string=>Boolean(id)))].sort();
  let allocationBatchId=batchId;
  const occurrenceScopes:Array<typeof weeklyBatches.$inferSelect>=[];
  for(const runId of runIds){const scope=await createRunBatchInTx(tx,runId,group.createdBy);occurrenceScopes.push(await lockBatch(tx,scope.batchId));}
  if(runIds.length===1){allocationBatchId=occurrenceScopes[0]!.id;nextPrefix=occurrenceScopes[0]!.nextPrefix;}
  else for(const scope of occurrenceScopes)nextPrefix=Math.max(nextPrefix,scope.nextPrefix);
  const previous = await tx.select().from(allocationCodes).where(eq(allocationCodes.groupId, group.id));
  const boxes = detail.shipments.flatMap((shipment) => shipment.revision.data.boxes.map((box) => ({ demandId: shipment.demandId, box })));
  boxes.sort((a, b) => {
    const first = detail.members.find((member) => member.id === a.demandId)!.snapshot.fba;
    const second = detail.members.find((member) => member.id === b.demandId)!.snapshot.fba;
    return first < second ? -1 : first > second ? 1 : (a.box.order ?? 0) - (b.box.order ?? 0);
  });
  const missing = boxes.filter((entry) => !previous.some((code) => code.valid && code.boxId === entry.box.id));
  if (!missing.length && group.prefix) return { nextPrefix, changed: false };
  const reserved=await tx.select({prefix:allocationCodes.prefix}).from(allocationCodes).where(runIds.length
    ? sql`${allocationCodes.batchId} IN (${sql.join([allocationBatchId,...occurrenceScopes.map((scope)=>scope.id)].map((id)=>sql`${id}::uuid`),sql`,`)}) OR ${allocationCodes.groupId} IN (SELECT group_id FROM shipping_ticket_member WHERE run_id IN (${sql.join(runIds.map((id)=>sql`${id}::uuid`),sql`,`)}))`
    : eq(allocationCodes.batchId,allocationBatchId));
  const used=new Set(reserved.map((entry)=>entry.prefix));
  if(!group.prefix)while(used.has(alphabeticPrefix(nextPrefix)))nextPrefix++;
  const prefix = group.prefix ?? alphabeticPrefix(nextPrefix++);
  let sequence = previous.filter((code) => code.prefix === prefix).reduce((maximum, code) => Math.max(maximum, code.sequence), 0);
  for (const entry of missing) {
    sequence++;
    await tx.insert(allocationCodes).values({ id: randomUUID(), batchId:allocationBatchId, groupId: group.id, demandId: entry.demandId, boxId: entry.box.id, prefix, sequence, code: `${prefix}${sequence}` });
  }
  await tx.update(subBatches).set({ prefix, updatedAt: new Date() }).where(eq(subBatches.id, group.id));
  for(const scope of occurrenceScopes)if(scope.id!==batchId)await tx.update(weeklyBatches).set({nextPrefix:Math.max(scope.nextPrefix,nextPrefix),version:sql`${weeklyBatches.version}+1`}).where(eq(weeklyBatches.id,scope.id));
  return { nextPrefix, changed: true };
}
export async function allocateCodes(batchId:string,input:{operationId:string;expectedVersion:number;groupIds:string[];expectedGroupVersions:Record<string,number>;reason:string},actorId:string){return operation(actorId,input.operationId,'batch.allocate',{batchId,...input},async(tx)=>{
  const batch=await lockBatch(tx,batchId,input.expectedVersion);if(new Set(input.groupIds).size!==input.groupIds.length)throw new BatchError('VALIDATION_ERROR',422,'编码范围重复。');let next=batch.nextPrefix;
  const requested=new Set(input.groupIds);const groups=await tx.select().from(subBatches).where(and(eq(subBatches.batchId,batchId),inArray(subBatches.id,input.groupIds))).orderBy(asc(subBatches.position),asc(subBatches.id));if(groups.length!==requested.size)throw new BatchError('VALIDATION_ERROR',422,'编码范围不属于同一处理范围。');
  if(batch.sortMode==='fba'){const members=await tx.select({groupId:subBatchMembers.groupId,fba:demands.fba}).from(subBatchMembers).innerJoin(demands,eq(demands.id,subBatchMembers.demandId)).where(and(eq(subBatchMembers.batchId,batchId),eq(subBatchMembers.active,true)));const keys=new Map<string,string>();for(const m of members)if(!keys.has(m.groupId)||m.fba<keys.get(m.groupId)!)keys.set(m.groupId,m.fba);groups.sort((a,b)=>(keys.get(a.id)??'')<(keys.get(b.id)??'')?-1:1);}
  for(const group of groups){if(group.version!==input.expectedGroupVersions[group.id])throw new BatchError('VERSION_CONFLICT',409,'子批次版本已变化。');const detail=await confirmedInTx(tx,group.id,false);const allocated=await allocateGroupCodesInTx(tx,batchId,group,detail,next);next=allocated.nextPrefix;}
  await tx.update(weeklyBatches).set({nextPrefix:next,version:batch.version+1}).where(eq(weeklyBatches.id,batchId));return{batchId,groupIds:input.groupIds};});}

export async function mergeGroups(groupId:string,input:{operationId:string;expectedVersion:number;sourceGroupIds:string[];expectedGroupVersions:Record<string,number>;reason:string},actorId:string){return operation(actorId,input.operationId,'sub_batch.merge',{groupId,...input},async(tx)=>{
  const {group,batch}=await lockGroup(tx,groupId,input.expectedVersion);await assertMutableBatchArrangementInTx(tx,batch.id,group.id);if(input.sourceGroupIds.includes(groupId)||new Set(input.sourceGroupIds).size!==input.sourceGroupIds.length)throw new BatchError('VALIDATION_ERROR',422,'合并范围重复。');
  const sourceRows:Array<typeof subBatches.$inferSelect>=[];const targetRecord=await groupRecord(tx,group);const ids=[...targetRecord.demandIds];
  for(const id of [...input.sourceGroupIds].sort()){const version=input.expectedGroupVersions[id];if(version===undefined)throw new BatchError('VERSION_CONFLICT',409,'请绑定全部来源子批次版本。');const {group:source}=await lockGroup(tx,id,version);await requireSameOccurrenceInTx(tx,source.batchId,group.batchId,source.id,group.id);await assertMutableBatchArrangementInTx(tx,source.batchId,source.id);sourceRows.push(source);ids.push(...(await groupRecord(tx,source)).demandIds);}
  const rows=await selectedDemands(tx,batch,ids);for(const source of sourceRows){await tx.update(subBatchMembers).set({active:false}).where(and(eq(subBatchMembers.groupId,source.id),eq(subBatchMembers.active,true)));await invalidateCodes(tx,source.id);const [old]=await tx.update(subBatches).set({version:source.version+1,status:'superseded',confirmedVersion:null,replacedById:groupId,updatedAt:new Date()}).where(eq(subBatches.id,source.id)).returning();await saveRevision(tx,old!,actorId,'merged',input.reason);}
  await invalidateCodes(tx,groupId);await setMembers(tx,group,rows);await revise(tx,group,actorId,'merge',input.reason,true);for(const id of new Set(sourceRows.map((source)=>source.batchId)))if(id!==batch.id)await tx.update(weeklyBatches).set({version:sql`${weeklyBatches.version}+1`}).where(eq(weeklyBatches.id,id));await tx.update(weeklyBatches).set({version:batch.version+1}).where(eq(weeklyBatches.id,batch.id));return{groupId,batchId:batch.id};});}

export async function splitGroup(groupId:string,input:{operationId:string;expectedVersion:number;groups:Array<{name:string;demandIds:string[]}>;reason:string},actorId:string){return operation(actorId,input.operationId,'sub_batch.split',{groupId,...input},async(tx)=>{
  const {group,batch}=await lockGroup(tx,groupId,input.expectedVersion);await assertMutableBatchArrangementInTx(tx,batch.id,group.id);const record=await groupRecord(tx,group);const all=input.groups.flatMap((g)=>g.demandIds);if(all.length!==record.demandIds.length||new Set(all).size!==all.length||all.some((id)=>!record.demandIds.includes(id)))throw new BatchError('VALIDATION_ERROR',422,'拆分必须完整且不重复地覆盖原成员。');
  await tx.update(subBatchMembers).set({active:false}).where(and(eq(subBatchMembers.groupId,groupId),eq(subBatchMembers.active,true)));await invalidateCodes(tx,groupId);const created:string[]=[];
  for(const [index,part]of input.groups.entries()){const rows=await selectedDemands(tx,batch,part.demandIds);const[id]=await tx.insert(subBatches).values({id:randomUUID(),batchId:batch.id,name:part.name,position:group.position+index,createdBy:actorId}).returning();await setMembers(tx,id!,rows);await saveRevision(tx,id!,actorId,'split_from',input.reason);created.push(id!.id);}
  const[old]=await tx.update(subBatches).set({version:group.version+1,status:'superseded',confirmedVersion:null,replacedById:created[0]!,updatedAt:new Date()}).where(eq(subBatches.id,groupId)).returning();await saveRevision(tx,old!,actorId,'split',input.reason);await tx.update(weeklyBatches).set({version:batch.version+1}).where(eq(weeklyBatches.id,batch.id));return{groupIds:created,batchId:batch.id};});}

export async function moveMembers(groupId:string,input:{operationId:string;expectedVersion:number;targetGroupId:string;expectedTargetVersion:number;demandIds:string[];reason:string},actorId:string){return operation(actorId,input.operationId,'sub_batch.move',{groupId,...input},async(tx)=>{
  if(input.targetGroupId===groupId)throw new BatchError('VALIDATION_ERROR',422,'目标组必须与来源组不同。');const{group,batch}=await lockGroup(tx,groupId,input.expectedVersion);const{group:target}=await lockGroup(tx,input.targetGroupId,input.expectedTargetVersion);await requireSameOccurrenceInTx(tx,target.batchId,group.batchId,target.id,group.id);await assertMutableBatchArrangementInTx(tx,batch.id,group.id);await assertMutableBatchArrangementInTx(tx,target.batchId,target.id);const sourceRecord=await groupRecord(tx,group);const targetRecord=await groupRecord(tx,target);
  if(new Set(input.demandIds).size!==input.demandIds.length||input.demandIds.some((id)=>!sourceRecord.demandIds.includes(id)))throw new BatchError('VALIDATION_ERROR',422,'移动范围不属于来源组。');const remaining=sourceRecord.demandIds.filter((id)=>!input.demandIds.includes(id));if(!remaining.length)throw new BatchError('VALIDATION_ERROR',422,'移动后来源组为空，请使用合并。');const sourceRows=await selectedDemands(tx,batch,remaining);const targetRows=await selectedDemands(tx,batch,[...targetRecord.demandIds,...input.demandIds]);
  await tx.update(subBatchMembers).set({active:false}).where(and(inArray(subBatchMembers.groupId,[groupId,target.id]),eq(subBatchMembers.active,true)));await setMembers(tx,group,sourceRows);await setMembers(tx,target,targetRows);await invalidateCodes(tx,groupId);await invalidateCodes(tx,target.id);await revise(tx,group,actorId,'move_out',input.reason,true);await revise(tx,target,actorId,'move_in',input.reason,true);if(target.batchId!==batch.id)await tx.update(weeklyBatches).set({version:sql`${weeklyBatches.version}+1`}).where(eq(weeklyBatches.id,target.batchId));await tx.update(weeklyBatches).set({version:batch.version+1}).where(eq(weeklyBatches.id,batch.id));return{groupIds:[groupId,target.id],batchId:batch.id};});}

export async function correctGroup(groupId:string,input:{operationId:string;expectedVersion:number;reason:string},actorId:string){return operation(actorId,input.operationId,'sub_batch.correction',{groupId,...input},async(tx)=>{
  const {group,batch}=await lockGroup(tx,groupId,input.expectedVersion,true);const [linked]=await tx.select({id:shippingTicketMembers.id}).from(shippingTicketMembers).where(eq(shippingTicketMembers.groupId,groupId)).limit(1);if(batch.shippingRunId||linked)await assertMutableBatchArrangementInTx(tx,batch.id,group.id);if(!group.frozenAt)throw new BatchError('CORRECTION_NOT_REQUIRED',422,'未冻结子批次可直接调整。');const record=await groupRecord(tx,group);const rows=await selectedDemands(tx,batch,record.demandIds,undefined,false);
  const[newGroup]=await tx.insert(subBatches).values({id:randomUUID(),batchId:batch.id,name:`${group.name}（更正）`,position:group.position,correctionOfId:groupId,actualShipDate:group.actualShipDate,createdBy:actorId}).returning();
  await tx.update(subBatchMembers).set({active:false}).where(and(eq(subBatchMembers.groupId,groupId),eq(subBatchMembers.active,true)));await setMembers(tx,newGroup!,rows);await saveRevision(tx,newGroup!,actorId,'correction',input.reason);
  const[old]=await tx.update(subBatches).set({version:group.version+1,status:'superseded',replacedById:newGroup!.id,updatedAt:new Date()}).where(eq(subBatches.id,groupId)).returning();await saveRevision(tx,old!,actorId,'replaced',input.reason);await tx.update(weeklyBatches).set({version:batch.version+1}).where(eq(weeklyBatches.id,batch.id));return{groupId:newGroup!.id,batchId:batch.id};});}

export async function recordDecision(groupId:string,input:{operationId:string;expectedVersion:number;demandId:string;expectedShipmentVersion:number;issueCode:string;note:string;reason:string},actorId:string){return operation(actorId,input.operationId,'sub_batch.decision',{groupId,...input},async(tx)=>{
  await lockGroup(tx,groupId,input.expectedVersion);const detail=await detailInTx(tx,groupId);const ship=detail.shipments.find((s)=>s.demandId===input.demandId)?.revision;if(!ship||ship.version!==input.expectedShipmentVersion)throw new BatchError('VERSION_CONFLICT',409,'货件候选版本已经变化。');
  if(input.issueCode!=='LIST_QUANTITY_MISMATCH'||!detail.issues.some((i)=>i.code===input.issueCode&&i.demandId===input.demandId))throw new BatchError('ISSUE_NOT_WAIVABLE',422,'该问题必须修正数据或箱映射，不能通过备注豁免。');
  await tx.insert(batchDecisions).values({id:randomUUID(),groupId,demandId:input.demandId,shipmentVersion:ship.version,issueCode:input.issueCode,note:input.note,createdBy:actorId});return{groupId};});}

export async function mapBoxes(groupId:string,input:{operationId:string;expectedVersion:number;demandId:string;expectedShipmentVersion:number;mappings:Array<{boxId:string;existingBoxId:string|null;order:number}>;reason:string},actorId:string){return operation(actorId,input.operationId,'sub_batch.box_mapping',{groupId,...input},async(tx)=>{
  await lockGroup(tx,groupId,input.expectedVersion);const detail=await detailInTx(tx,groupId);const ship=detail.shipments.find((s)=>s.demandId===input.demandId)?.revision;if(!ship||ship.version!==input.expectedShipmentVersion)throw new BatchError('VERSION_CONFLICT',409,'货件候选版本已经变化。');
  if(input.mappings.length!==ship.data.boxes.length||new Set(input.mappings.map((m)=>m.boxId)).size!==ship.data.boxes.length||ship.data.boxes.some((b)=>!input.mappings.some((m)=>m.boxId===b.id))||new Set(input.mappings.map((m)=>m.order)).size!==input.mappings.length)throw new BatchError('VALIDATION_ERROR',422,'请为全部箱指定唯一顺序和映射。');
  const history=await tx.select().from(shipmentRevisions).where(eq(shipmentRevisions.demandId,input.demandId));const historicalIds=new Set(history.flatMap((r)=>r.data.boxes.map((b)=>b.id)));
  const ids=input.mappings.map((m)=>m.existingBoxId??m.boxId);if(new Set(ids).size!==ids.length||input.mappings.some((m)=>m.existingBoxId&&!historicalIds.has(m.existingBoxId)))throw new BatchError('VALIDATION_ERROR',422,'人工箱映射必须唯一对应本货件既有内部箱。');
  const data:ShipmentData={...ship.data,boxes:ship.data.boxes.map((box)=>{const m=input.mappings.find((x)=>x.boxId===box.id)!;return{...box,id:m.existingBoxId??box.id,order:m.order};}),issues:ship.data.issues.filter((issue)=>!['BOX_MAPPING_REQUIRED','BOX_ORDER_REQUIRED','BOX_IDENTITY_AMBIGUOUS','BOX_MAPPING_CONFLICT'].includes(issue.code))};
  await tx.insert(shipmentRevisions).values({id:randomUUID(),demandId:input.demandId,version:ship.version+1,demandVersion:ship.demandVersion,data,source:'manual',snapshotIds:ship.snapshotIds,reason:input.reason,createdBy:actorId});return{groupId};});}

export async function manualShipment(groupId:string,demandId:string,input:{operationId:string;expectedVersion:number;expectedDemandVersion:number;data:ShipmentData;reason:string},actorId:string){return operation(actorId,input.operationId,'shipment.manual',{groupId,demandId,...input},async(tx)=>{
  const{group}=await lockGroup(tx,groupId,input.expectedVersion);if(!(await groupRecord(tx,group)).demandIds.includes(demandId))throw new BatchError('VALIDATION_ERROR',422,'需求不属于本组。');await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipment:${demandId}`},0))`);
  const[demand]=await tx.select().from(demands).where(eq(demands.id,demandId)).for('share');if(!demand||demand.version!==input.expectedDemandVersion)throw new BatchError('DEMAND_VERSION_CONFLICT',409,'需求版本已经变化。');await requireActiveDemandInTx(tx,demandId);const data=shipmentDataSchema.parse(input.data);if(data.sid!==demand.sid||data.fba!==demand.fba)throw new BatchError('SHIPMENT_IDENTITY_MISMATCH',422,'补录的店铺和FBA与需求不一致。');const[latest]=await tx.select().from(shipmentRevisions).where(eq(shipmentRevisions.demandId,demandId)).orderBy(desc(shipmentRevisions.version)).limit(1);
  await tx.insert(shipmentRevisions).values({id:randomUUID(),demandId,version:(latest?.version??0)+1,demandVersion:demand.version,data,source:'manual',snapshotIds:[],reason:input.reason,createdBy:actorId});return{groupId};});}

export async function setActualShipDate(groupId:string,input:{operationId:string;expectedVersion:number;actualShipDate:string|null;reason:string},actorId:string){return operation(actorId,input.operationId,'sub_batch.ship_date',{groupId,...input},async(tx)=>{const{group}=await lockGroup(tx,groupId,input.expectedVersion,true);const[updated]=await tx.update(subBatches).set({actualShipDate:input.actualShipDate,version:group.version+1,updatedAt:new Date()}).where(eq(subBatches.id,groupId)).returning();await saveRevision(tx,updated!,actorId,'ship_date',input.reason);return{groupId};});}
export async function recordPrint(groupId:string,input:{operationId:string;expectedVersion:number;confirmationId:string;note:string;reason:string},actorId:string){return operation(actorId,input.operationId,'sub_batch.print',{groupId,...input},async(tx)=>{await lockGroup(tx,groupId,input.expectedVersion,true);await freezeGroupForExport(tx,groupId,input.confirmationId,actorId);await tx.insert(batchPrintRecords).values({id:randomUUID(),groupId,confirmationId:input.confirmationId,note:input.note,createdBy:actorId});return{groupId};});}
