import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AddShippingTicketInput, AppendShippingTicketMembersInput, CorrectShippingRunInput, CreateManualShippingRunInput } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demands, operationAudit } from '../../db/schema.js';
import { batchExports } from '../batches/export-schema.js';
import { subBatchMembers, subBatches, weeklyBatches } from '../batches/schema.js';
import { appendSubBatchMembersInTx, BatchError, bindLegacyGroupToRunInTx, createRunBatchInTx, createSubBatchInTx, requireBatchActor, type BatchTx } from '../batches/service.js';
import { loadDemandCancellationsInTx } from '../imports/demand-lifecycle.js';
import { businessDateForReceipt } from '../imports/date.js';
import { shippingCountry, shippingTicketNumber } from './domain.js';
import { shippingRunCorrections, shippingRunOperations, shippingRuns, shippingTicketMembers, shippingTickets } from './schema.js';
import { getShippingRun, getShippingRunReportScopeInTx, reserveShippingSequenceInTx, shippingHash } from './service.js';

type Run = typeof shippingRuns.$inferSelect;
type Selection = { demandIds: string[]; expectedDemandVersions: Record<string, number> };

async function operation(input: { operationId: string }, actorId: string, action: string, payload: unknown, execute: (tx: BatchTx) => Promise<string>) {
  const requestHash = shippingHash({ action, actorId, payload });
  const runId = await db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-operation:${input.operationId}`},0))`);
    const [previous] = await tx.select().from(shippingRunOperations).where(eq(shippingRunOperations.operationId, input.operationId));
    if (previous) {
      if (previous.actorId !== actorId || previous.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他发货请求。');
      return previous.runId;
    }
    const id = await execute(tx);
    await tx.insert(shippingRunOperations).values({ operationId: input.operationId, runId: id, actorId, requestHash });
    await tx.insert(operationAudit).values({ id: randomUUID(), action, targetId: id, actorUserId: actorId, requestHash, details: { operationId: input.operationId } });
    return id;
  });
  return getShippingRun(runId, actorId);
}

async function selectedDemands(tx: BatchTx, input: Selection) {
  for (const id of [...input.demandIds].sort()) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-demand:${id}`},0))`);
  const rows = await tx.select().from(demands).where(inArray(demands.id, input.demandIds)).orderBy(asc(demands.id)).for('share');
  if (!input.demandIds.length || new Set(input.demandIds).size !== input.demandIds.length || rows.length !== input.demandIds.length) throw new BatchError('VALIDATION_ERROR', 422, '请选择有效且不重复的需求。');
  if ((await loadDemandCancellationsInTx(tx, input.demandIds)).size) throw new BatchError('DEMAND_CANCELLED', 409, '所选需求已取消。');
  if (rows.some((row) => input.expectedDemandVersions[row.id] !== row.version)) throw new BatchError('DEMAND_VERSION_CONFLICT', 409, '需求版本已变化，请重新核对。');
  const [occupied] = await tx.select().from(shippingTicketMembers).where(inArray(shippingTicketMembers.demandId, input.demandIds)).limit(1);
  if (occupied) throw new BatchError('MEMBER_ALREADY_SHIPPED', 409, '所选需求已属于其他发货票，请打开原发货记录。', { demandId: occupied.demandId, runId: occupied.runId });
  const first = rows[0]!;
  if (rows.some((row) => row.sid !== first.sid || row.snapshot.country !== first.snapshot.country || row.snapshot.channel !== first.snapshot.channel)) throw new BatchError('GROUP_SCOPE_MISMATCH', 422, '人工批次的店铺、国家和业务渠道须一致。');
  const country = shippingCountry(first.snapshot.country);
  if (!country) throw new BatchError('UNKNOWN_COUNTRY', 422, '请先维护可识别的国家。');
  // Preserve the user's selected FBA order independently from lock ordering.
  const byId = new Map(rows.map((row) => [row.id, row]));
  return { rows: input.demandIds.map((id) => byId.get(id)!), country };
}

async function pendingExports(tx: BatchTx, runId: string) {
  const [pending] = await tx.select({ id: batchExports.id }).from(batchExports).where(and(inArray(batchExports.status, ['queued', 'running']), sql`(${batchExports.projection}->>'shippingRunId'=${runId} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${batchExports.groupIds}) AS export_group(id) WHERE export_group.id IN (SELECT ${shippingTicketMembers.groupId}::text FROM ${shippingTicketMembers} WHERE ${shippingTicketMembers.runId}=${runId})))`)).limit(1);
  if (pending) throw new BatchError('EXPORT_ACTIVE', 409, '本次发货正在导出，请等待完成后处理。');
}

async function lockRun(tx: BatchTx, runId: string, version: number, correction = false): Promise<Run> {
  const [run] = await tx.select().from(shippingRuns).where(eq(shippingRuns.id, runId)).for('update');
  if (!run) throw new BatchError('NOT_FOUND', 404, '发货次不存在。');
  if (run.version !== version) throw new BatchError('VERSION_CONFLICT', 409, '发货次版本已变化，请重新核对。');
  if (['queued', 'running'].includes(run.status)) throw new BatchError('SHIPPING_RUN_BUSY', 409, '本次发货正在整理，请等待完成后操作。');
  await pendingExports(tx, runId);
  if (!correction && run.membershipFrozenAt) throw new BatchError('SHIPPING_MEMBERSHIP_FROZEN', 409, '本次发货成员已冻结，请先发起发货次更正。');
  return run;
}

async function ticketAndGroup(tx: BatchTx, run: Run, input: Selection & { name: string; reason: string; existingGroupId?: string; expectedGroupVersion?: number }, actorId: string) {
  const { batchId } = await createRunBatchInTx(tx, run.id, actorId);
  const [legacy] = input.existingGroupId ? await tx.select().from(subBatches).where(eq(subBatches.id, input.existingGroupId)) : [];
  if (legacy) {
    const [linked] = await tx.select({ id: shippingTicketMembers.id }).from(shippingTicketMembers).where(eq(shippingTicketMembers.groupId, legacy.id)).limit(1);
    if (linked) throw new BatchError('GROUP_ALREADY_ASSIGNED', 409, '该历史批次已有发货次归属，请打开原记录。');
  }
  const batchIds = [...new Set([batchId, ...(legacy ? [legacy.batchId] : [])])].sort();
  await tx.select({ id: weeklyBatches.id }).from(weeklyBatches).where(inArray(weeklyBatches.id, batchIds)).orderBy(asc(weeklyBatches.id)).for('update');
  if (legacy) {
    await tx.select({ id: subBatches.id }).from(subBatches).where(eq(subBatches.id, legacy.id)).for('update');
    const [exporting] = await tx.select({ id: batchExports.id }).from(batchExports).where(and(inArray(batchExports.status, ['queued', 'running']), sql`${batchExports.groupIds} @> ${JSON.stringify([legacy.id])}::jsonb`)).limit(1);
    if (exporting) throw new BatchError('EXPORT_ACTIVE', 409, '历史批次正在导出，请等待完成后关联。');
  }
  const { rows, country } = await selectedDemands(tx, input);
  const sequence = await reserveShippingSequenceInTx(tx, run);
  const tickets = await tx.select().from(shippingTickets).where(eq(shippingTickets.runId, run.id));
  const sourceTicketIndex = tickets.reduce((max, ticket) => Math.max(max, ticket.sourceTicketIndex), 0) + 1;
  const ticketSequence = tickets.filter((ticket) => ticket.country === country).reduce((max, ticket) => Math.max(max, ticket.ticketSequence ?? 0), 0) + 1;
  const ticketId = randomUUID();
  await tx.insert(shippingTickets).values({ id: ticketId, runId: run.id, sourceTicketIndex, country, ticketSequence, number: shippingTicketNumber(run.numberingDate, sequence, country, ticketSequence) });
  const { groupId } = input.existingGroupId ? await bindLegacyGroupToRunInTx(tx, batchId, input.existingGroupId, { ...input, expectedGroupVersion: input.expectedGroupVersion! }, actorId) : await createSubBatchInTx(tx, batchId, input, actorId);
  for (const [index, row] of rows.entries()) await tx.insert(shippingTicketMembers).values({ id: randomUUID(), runId: run.id, ticketId, demandId: row.id, fba: row.fba, sid: row.sid, inputOrder: index + 1, groupId });
}

async function draftRun(tx: BatchTx, run: Run) {
  const checkpoint = structuredClone(run.checkpoint);
  for (const key of Object.keys(checkpoint.operations)) if (key.startsWith('confirm:') || key.startsWith('sync:')) delete checkpoint.operations[key];
  await tx.update(shippingRuns).set({ status: 'draft', stage: 'sync', version: run.version + 1, checkpoint, error: null, issues: [], updatedAt: new Date() }).where(eq(shippingRuns.id, run.id));
}

export async function createManualShippingRun(input: CreateManualShippingRunInput, actorId: string) {
  return operation(input, actorId, 'shipping_run.manual_create', input, async (tx) => {
    const id = randomUUID(), numberingDate = input.numberingDate ?? businessDateForReceipt(new Date()).businessDate;
    const [run] = await tx.insert(shippingRuns).values({ id, origin: 'manual', status: 'draft', stage: 'sync', numberingDate, month: numberingDate.slice(0, 7), createdBy: actorId }).returning();
    await ticketAndGroup(tx, run!, input, actorId);
    return id;
  });
}

export async function addShippingTicket(runId: string, input: AddShippingTicketInput, actorId: string) {
  return operation(input, actorId, 'shipping_run.add_ticket', { runId, input }, async (tx) => {
    const run = await lockRun(tx, runId, input.expectedVersion);
    await ticketAndGroup(tx, run, input, actorId);
    await draftRun(tx, run);
    return runId;
  });
}

export async function appendShippingTicketMembers(runId: string, ticketId: string, input: AppendShippingTicketMembersInput, actorId: string) {
  return operation(input, actorId, 'shipping_run.append_members', { runId, ticketId, input }, async (tx) => {
    // Include all runs sharing the source parent container, not just this
    // particular group's links, before taking the requested run lock.
    await getShippingRunReportScopeInTx(tx, runId, actorId);
    const links = await tx.select({ runId: shippingTicketMembers.runId }).from(shippingTicketMembers).where(eq(shippingTicketMembers.groupId, input.groupId));
    const run = await lockRun(tx, runId, input.expectedVersion);
    const [ticket] = await tx.select().from(shippingTickets).where(and(eq(shippingTickets.id, ticketId), eq(shippingTickets.runId, runId)));
    const [group] = await tx.select().from(subBatches).where(eq(subBatches.id, input.groupId));
    if (!ticket || !group) throw new BatchError('NOT_FOUND', 404, '发货票或内部批次不存在。');
    if (links.some((link) => link.runId !== runId)) throw new BatchError('GROUP_SCOPE_MISMATCH', 422, '跨发货次共用的历史批次须先建立更正组再追加。');
    const existing = await tx.select().from(shippingTicketMembers).where(and(eq(shippingTicketMembers.runId, runId), eq(shippingTicketMembers.groupId, group.id)));
    if (!existing.length || existing.some((member) => member.ticketId !== ticketId)) throw new BatchError('GROUP_SCOPE_MISMATCH', 422, '目标批次须完整属于所选发货票。');
    await tx.select({ id: weeklyBatches.id }).from(weeklyBatches).where(eq(weeklyBatches.id, group.batchId)).for('update');
    await tx.select({ id: subBatches.id }).from(subBatches).where(eq(subBatches.id, group.id)).for('update');
    const { rows, country } = await selectedDemands(tx, input);
    if (country !== ticket.country) throw new BatchError('TICKET_COUNTRY_MISMATCH', 422, '新增需求须与发货票国家一致。');
    const current = await tx.select({ demand: demands }).from(subBatchMembers).innerJoin(demands, eq(demands.id, subBatchMembers.demandId)).where(and(eq(subBatchMembers.groupId, group.id), eq(subBatchMembers.active, true)));
    const combined = [...current.map(({ demand }) => demand), ...rows];
    if (combined.length > 1000) throw new BatchError('VALIDATION_ERROR', 422, '单个批次最多1000票需求。');
    await appendSubBatchMembersInTx(tx, group.id, { expectedVersion: input.expectedGroupVersion, demandIds: combined.map((row) => row.id), expectedDemandVersions: Object.fromEntries(combined.map((row) => [row.id, row.version])), reason: input.reason }, actorId);
    const members = await tx.select().from(shippingTicketMembers).where(eq(shippingTicketMembers.ticketId, ticketId));
    const start = members.reduce((max, member) => Math.max(max, member.inputOrder), 0);
    for (const [index, row] of rows.entries()) await tx.insert(shippingTicketMembers).values({ id: randomUUID(), runId, ticketId, demandId: row.id, fba: row.fba, sid: row.sid, inputOrder: start + index + 1, groupId: group.id });
    await draftRun(tx, run);
    return runId;
  });
}

export async function correctShippingRun(runId: string, input: CorrectShippingRunInput, actorId: string) {
  return operation(input, actorId, 'shipping_run.correction', { runId, input }, async (tx) => {
    const run = await lockRun(tx, runId, input.expectedVersion, true);
    if (!run.membershipFrozenAt) throw new BatchError('CORRECTION_NOT_REQUIRED', 422, '本次发货成员尚未冻结，可直接调整。');
    const tickets = await tx.select().from(shippingTickets).where(eq(shippingTickets.runId, runId)).orderBy(asc(shippingTickets.sourceTicketIndex));
    const members = await tx.select().from(shippingTicketMembers).where(eq(shippingTicketMembers.runId, runId)).orderBy(asc(shippingTicketMembers.inputOrder));
    await tx.insert(shippingRunCorrections).values({ id: randomUUID(), runId, version: run.version, reason: input.reason, snapshot: { run: { ...run }, tickets: tickets.map((ticket) => ({ ...ticket, members: members.filter((member) => member.ticketId === ticket.id) })) }, createdBy: actorId });
    await tx.update(shippingRuns).set({ membershipFrozenAt: null }).where(eq(shippingRuns.id, runId));
    await draftRun(tx, run);
    return runId;
  });
}
