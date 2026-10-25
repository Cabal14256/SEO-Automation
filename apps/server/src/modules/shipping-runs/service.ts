import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type { CreateShippingRunInput, RetryShippingRunInput, ShippingRun, ShippingRunDetail } from '@scm/contracts';
import { db } from '../../db/client.js';
import { importCommits, importParseRuns, operationAudit, sourceImports } from '../../db/schema.js';
import { allocationCodes, batchOperations, groupConfirmations, shipmentRevisions, subBatchMembers, subBatches, weeklyBatches } from '../batches/schema.js';
import { batchSyncRuns } from '../lingxing/sync-schema.js';
import { fbaLookupRuns } from '../imports/fba-lookup-schema.js';
import { BatchError, requireBatchActor, type BatchTx } from '../batches/service.js';
import { businessDateForReceipt } from '../imports/date.js';
import { shippingMonthCounters, shippingRunOperations, shippingRuns, shippingTicketMembers, shippingTickets } from './schema.js';
import type { ShippingRunIssue } from '@scm/contracts';
import { demands } from '../../db/schema.js';
import { loadDemandCancellationsInTx } from '../imports/demand-lifecycle.js';

export const SHIPPING_RUN_QUEUE = 'shipping-run-organize';
export const shippingHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function serializeShippingRun(row: typeof shippingRuns.$inferSelect): ShippingRun {
  return { id: row.id, version: row.version, status: row.status as ShippingRun['status'], stage: row.stage as ShippingRun['stage'], numberingDate: row.numberingDate, month: row.month, sequence: row.sequence, importId: row.importId, parseRunId: row.parseRunId, origin: row.origin as ShippingRun['origin'], membershipFrozenAt: row.membershipFrozenAt?.toISOString() ?? null, error: row.error, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export async function getShippingRunReportScopeInTx(tx: BatchTx, runId: string, actorId: string) {
  await requireBatchActor(tx, actorId);
  // A historical parent container can be shared by several occurrences.
  // Discover its complete run set before locking any single run; readers and
  // publishers must use the same sorted order as group writers.
  await tx.execute(sql`WITH source_batches AS (
    SELECT g.batch_id AS id FROM ${shippingTicketMembers} m JOIN ${subBatches} g ON g.id=m.group_id WHERE m.run_id=${runId}
    UNION SELECT b.id FROM ${weeklyBatches} b WHERE b.shipping_run_id=${runId}
  ) SELECT r.id FROM ${shippingRuns} r WHERE r.id=${runId} OR r.id IN (
    SELECT b.shipping_run_id FROM ${weeklyBatches} b JOIN source_batches scope ON scope.id=b.id WHERE b.shipping_run_id IS NOT NULL
    UNION SELECT m.run_id FROM ${shippingTicketMembers} m JOIN ${subBatches} g ON g.id=m.group_id JOIN source_batches scope ON scope.id=g.batch_id
  ) ORDER BY r.id FOR UPDATE`);
  const [run] = await tx.select().from(shippingRuns).where(eq(shippingRuns.id, runId)).for('update');
  if (!run) throw new BatchError('NOT_FOUND', 404, '本次发货整理记录不存在。');
  const tickets = await tx.select().from(shippingTickets).where(eq(shippingTickets.runId, runId)).orderBy(asc(shippingTickets.sourceTicketIndex));
  const members = await tx.select().from(shippingTicketMembers).where(eq(shippingTicketMembers.runId, runId)).orderBy(asc(shippingTicketMembers.inputOrder));
  return { run, tickets: tickets.map((ticket) => ({ ...ticket, members: members.filter((member) => member.ticketId === ticket.id) })), groupIds: [...new Set(members.flatMap((member) => member.groupId ? [member.groupId] : []))] };
}
export async function getReadyShippingRunInTx(tx: BatchTx, runId: string, expectedVersion: number | undefined, actorId: string) {
  const scope = await getShippingRunReportScopeInTx(tx, runId, actorId);
  if (expectedVersion !== undefined && scope.run.version !== expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '本次发货版本已变化，请刷新后导出。');
  if (scope.run.status !== 'ready' || scope.run.sequence === null || !scope.tickets.length || scope.tickets.some((ticket) => !ticket.number || !ticket.members.length || ticket.members.some((member) => !member.demandId || !member.groupId))) throw new BatchError('SHIPPING_RUN_NOT_READY', 409, '本次发货仍在整理或存在待处理异常，暂不能导出完整发货表。');
  const issues = await shippingRunReadinessIssuesInTx(tx, scope);
  if (issues.length) throw new BatchError('SHIPPING_RUN_STALE', 409, '本次发货引用的分组、成员或数据版本已变化，请刷新整理记录并处理异常。', { issues });
  return scope;
}
export async function shippingRunReadinessIssuesInTx(tx: BatchTx, scope: Awaited<ReturnType<typeof getShippingRunReportScopeInTx>>): Promise<ShippingRunIssue[]> {
  const issues: ShippingRunIssue[] = [];
  if (!scope.groupIds.length) return [{ code: 'SHIPPING_GROUP_MISSING', message: '本次发货尚无可用的内部处理组。' }];
  const groups = await tx.select().from(subBatches).where(inArray(subBatches.id, scope.groupIds));
  const memberRows = await tx.select({ member: subBatchMembers, demand: demands }).from(subBatchMembers).innerJoin(demands, eq(demands.id, subBatchMembers.demandId)).where(and(inArray(subBatchMembers.groupId, scope.groupIds), eq(subBatchMembers.active, true)));
  const confirmations = await tx.select().from(groupConfirmations).where(inArray(groupConfirmations.groupId, scope.groupIds));
  const demandIds = [...new Set(memberRows.map(({ demand }) => demand.id))];
  const revisions = demandIds.length ? await tx.selectDistinctOn([shipmentRevisions.demandId]).from(shipmentRevisions).where(inArray(shipmentRevisions.demandId, demandIds)).orderBy(asc(shipmentRevisions.demandId), desc(shipmentRevisions.version)) : [];
  const codes = await tx.select().from(allocationCodes).where(and(inArray(allocationCodes.groupId, scope.groupIds), eq(allocationCodes.valid, true)));
  const activeSync = await tx.select().from(batchSyncRuns).where(and(inArray(batchSyncRuns.subBatchId, scope.groupIds), inArray(batchSyncRuns.status, ['queued', 'running'])));
  const cancelled = await loadDemandCancellationsInTx(tx, scope.tickets.flatMap((ticket) => ticket.members.flatMap((member) => member.demandId ? [member.demandId] : [])));
  for (const ticket of scope.tickets) for (const member of ticket.members) {
    const group = groups.find((entry) => entry.id === member.groupId); const extra = { ticketIndex: ticket.sourceTicketIndex, fba: member.fba, ...(member.demandId ? { demandId: member.demandId } : {}), ...(member.groupId ? { groupId: member.groupId } : {}) };
    if (cancelled.has(member.demandId!)) { issues.push({ code: 'DEMAND_CANCELLED', message: '本票的 FBA 已取消，请先核对需求。', ...extra }); continue; }
    if (!group || group.status === 'superseded') { issues.push({ code: 'GROUP_SUPERSEDED', message: '原内部处理组已不存在或被更正版本替代。', ...extra }); continue; }
    const current = memberRows.filter((entry) => entry.member.groupId === group.id);
    if (!current.some((entry) => entry.demand.id === member.demandId)) { issues.push({ code: 'SHIPPING_MEMBER_REMOVED', message: '本票的 FBA 已从其内部处理组移除，请恢复正确归属后重试。', ...extra }); continue; }
    const confirmation = confirmations.find((entry) => entry.groupId === group.id && entry.groupVersion === group.confirmedVersion);
    if (!confirmation || !['confirmed', 'frozen'].includes(group.status) || !confirmation.snapshot.members.some((entry) => entry.id === member.demandId)) { issues.push({ code: 'CONFIRMATION_STALE', message: '本票的内部处理组尚未完成当前版本确认。', ...extra }); continue; }
    if (activeSync.some((entry) => entry.subBatchId === group.id)) { issues.push({ code: 'SYNC_ACTIVE', message: '本票的内部处理组有未完成同步，请等待后重试。', ...extra }); continue; }
    const snapshot = confirmation.snapshot;
    if (!group.frozenAt && (snapshot.members.length !== current.length || current.some(({ demand }) => !snapshot.members.some((entry) => entry.id === demand.id && entry.version === demand.version) || !snapshot.shipments.some((entry) => entry.demandId === demand.id && entry.revision.id === revisions.find((revision) => revision.demandId === demand.id)?.id)))) { issues.push({ code: 'CONFIRMATION_STALE', message: '需求或货件数据在确认后发生变化，请重新同步确认。', ...extra }); continue; }
    const boxes = snapshot.shipments.find((entry) => entry.demandId === member.demandId)?.revision.data.boxes ?? [];
    if (!boxes.length || boxes.some((box) => !codes.some((code) => code.groupId === group.id && code.demandId === member.demandId && code.boxId === box.id))) issues.push({ code: 'CODES_REQUIRED', message: '本票的逐箱编码不完整，请重新确认编码。', ...extra });
  }
  return issues;
}
export async function getShippingRun(runId: string, actorId: string): Promise<ShippingRunDetail> {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const scope = await getShippingRunReportScopeInTx(tx, runId, actorId);
    if (scope.run.status === 'ready' || scope.run.origin === 'manual' && scope.run.status === 'draft') {
      const issues = await shippingRunReadinessIssuesInTx(tx, scope);
      if (issues.length && scope.run.status === 'ready') {
        const [updated] = await tx.update(shippingRuns).set({ status: 'needs_review', stage: 'sync', version: scope.run.version + 1, issues, error: { code: issues[0]!.code, message: issues[0]!.message }, updatedAt: new Date() }).where(eq(shippingRuns.id, runId)).returning();
        scope.run = updated!;
        await tx.insert(operationAudit).values({ id: randomUUID(), action: 'shipping_run.invalidate', targetId: runId, actorUserId: actorId, requestHash: shippingHash(issues), details: { reason: issues[0]!.code, issues: JSON.stringify(issues) } });
      } else if (!issues.length && scope.run.status === 'draft' && scope.run.sequence !== null) {
        const [updated] = await tx.update(shippingRuns).set({ status: 'ready', stage: 'ready', version: scope.run.version + 1, issues: [], error: null, updatedAt: new Date() }).where(eq(shippingRuns.id, runId)).returning();
        scope.run = updated!;
      }
    }
    return { run: serializeShippingRun(scope.run), tickets: scope.tickets.map((ticket) => ({ id: ticket.id, sourceTicketIndex: ticket.sourceTicketIndex, country: ticket.country, ticketSequence: ticket.ticketSequence, number: ticket.number, members: ticket.members.map(({ demandId, fba, sid, inputOrder, groupId }) => ({ demandId, fba, sid, inputOrder, groupId })) })), issues: scope.run.issues };
  });
}
export async function listShippingRuns(actorId: string) {
  return db.transaction(async (tx) => { await requireBatchActor(tx, actorId); const rows = await tx.select().from(shippingRuns).orderBy(desc(shippingRuns.createdAt)).limit(200); return { items: rows.map(serializeShippingRun) }; });
}
async function assertImport(tx: BatchTx, importId: string, parseRunId: string) {
  const [record] = await tx.select().from(sourceImports).where(eq(sourceImports.id, importId)).for('share');
  const [parse] = await tx.select().from(importParseRuns).where(and(eq(importParseRuns.id, parseRunId), eq(importParseRuns.importId, importId)));
  if (!record || !parse) throw new BatchError('NOT_FOUND', 404, '导入记录或解析任务不存在。');
  if (record.latestRunId !== parseRunId || record.version !== parse.inputVersion) throw new BatchError('VERSION_CONFLICT', 409, '请使用本次导入的最新解析版本整理发货。');
  return { record, parse };
}
async function enqueue(tx: BatchTx, boss: PgBoss, runId: string) {
  const jobId = await boss.send(SHIPPING_RUN_QUEUE, { runId }, { db: fromDrizzle(tx, sql), retryLimit: 0, expireInSeconds: 300 });
  if (!jobId) throw new BatchError('QUEUE_UNAVAILABLE', 503, '发货整理任务未能入队，请重试。');
  await tx.update(shippingRuns).set({ queueJobId: jobId, updatedAt: new Date() }).where(eq(shippingRuns.id, runId));
}
export async function createShippingRun(boss: PgBoss, input: CreateShippingRunInput, actorId: string) {
  const hash = shippingHash({ kind: 'create', actorId, input });
  const id = await db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-operation:${input.operationId}`},0))`);
    const [previous] = await tx.select().from(shippingRunOperations).where(eq(shippingRunOperations.operationId, input.operationId));
    if (previous) { if (previous.actorId !== actorId || previous.requestHash !== hash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他整理请求。'); return previous.runId; }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-import:${input.importId}`},0))`);
    const [existing] = await tx.select().from(shippingRuns).where(eq(shippingRuns.importId, input.importId));
    const numberingDate = input.numberingDate ?? businessDateForReceipt(new Date()).businessDate;
    if (existing) {
      if (existing.parseRunId !== input.parseRunId || existing.numberingDate !== numberingDate) throw new BatchError('SHIPPING_IMPORT_ALREADY_USED', 409, '该导入已创建本次发货，请打开原记录；修改解析请在原记录重试。', { runId: existing.id });
      await tx.insert(shippingRunOperations).values({ operationId: input.operationId, runId: existing.id, actorId, requestHash: hash }); return existing.id;
    }
    await assertImport(tx, input.importId, input.parseRunId);
    const runId = randomUUID();
    await tx.insert(shippingRuns).values({ id: runId, importId: input.importId, parseRunId: input.parseRunId, numberingDate, month: numberingDate.slice(0, 7), createdBy: actorId });
    await enqueue(tx, boss, runId);
    await tx.insert(shippingRunOperations).values({ operationId: input.operationId, runId, actorId, requestHash: hash });
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'shipping_run.create', targetId: runId, actorUserId: actorId, requestHash: hash, details: { importId: input.importId, parseRunId: input.parseRunId, numberingDate } });
    return runId;
  });
  return getShippingRun(id, actorId);
}
export async function retryShippingRun(boss: PgBoss, runId: string, input: RetryShippingRunInput, actorId: string) {
  const hash = shippingHash({ kind: 'retry', runId, actorId, input });
  await db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-operation:${input.operationId}`},0))`);
    const [previous] = await tx.select().from(shippingRunOperations).where(eq(shippingRunOperations.operationId, input.operationId));
    if (previous) { if (previous.runId !== runId || previous.actorId !== actorId || previous.requestHash !== hash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他重试请求。'); return; }
    const [run] = await tx.select().from(shippingRuns).where(eq(shippingRuns.id, runId)).for('update');
    if (!run) throw new BatchError('NOT_FOUND', 404, '发货整理任务不存在。');
    if (run.version !== input.expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '发货整理版本已变化，请刷新后重试。');
    if (!['draft', 'needs_review', 'failed'].includes(run.status)) throw new BatchError('SHIPPING_RUN_NOT_RETRYABLE', 409, '仅待处理或失败的发货整理任务可以继续。');
    if (run.origin === 'manual') {
      if (input.importId || input.parseRunId) throw new BatchError('MANUAL_RUN_SOURCE', 422, '人工发货次不支持替换导入来源。');
      const checkpoint = structuredClone(run.checkpoint);
      checkpoint.lookupAttempt++;
      for (const key of Object.keys(checkpoint.operations)) if (key.startsWith('confirm:')) delete checkpoint.operations[key];
      await tx.update(shippingRuns).set({ version: run.version + 1, status: 'queued', stage: 'sync', checkpoint, issues: [], error: null, updatedAt: new Date() }).where(eq(shippingRuns.id, runId));
      await enqueue(tx, boss, runId);
      await tx.insert(shippingRunOperations).values({ operationId: input.operationId, runId, actorId, requestHash: hash });
      await tx.insert(operationAudit).values({ id: randomUUID(), action: 'shipping_run.retry', targetId: runId, actorUserId: actorId, requestHash: hash, details: { origin: 'manual' } });
      return;
    }
    const importId = input.importId ?? run.importId;
    const parseRunId = input.parseRunId ?? run.parseRunId;
    const changingParse = parseRunId !== run.parseRunId || importId !== run.importId;
    const commitInput = run.checkpoint.operations['commit-request']?.input as { operationId?: string } | undefined;
    const committed = commitInput?.operationId ? await tx.select().from(importCommits).where(eq(importCommits.operationId, commitInput.operationId)).limit(1) : [];
    if (!importId || !parseRunId) throw new BatchError('SOURCE_NOT_FOUND', 409, '发货来源不存在，请核对记录。');
    if (changingParse || !committed.length) await assertImport(tx, importId, parseRunId);
    const linkedMembers = await tx.select({ id: shippingTicketMembers.id }).from(shippingTicketMembers).where(and(eq(shippingTicketMembers.runId, run.id), sql`${shippingTicketMembers.demandId} IS NOT NULL`)).limit(1);
    if (changingParse && (run.sequence !== null || committed.length || linkedMembers.length)) throw new BatchError('SHIPPING_RUN_NUMBERED', 409, '本次发货已提交需求或编号，请在现有分组中修正异常后重试，不能替换输入解析。');
    if (changingParse) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-import:${importId}`},0))`);
      const [occupied] = await tx.select().from(shippingRuns).where(eq(shippingRuns.importId, importId));
      if (occupied && occupied.id !== runId) throw new BatchError('SHIPPING_IMPORT_ALREADY_USED', 409, '新来源已经属于其他发货整理记录。');
    }
    const checkpoint = structuredClone(run.checkpoint);
    if (changingParse) {
      await tx.delete(shippingTicketMembers).where(eq(shippingTicketMembers.runId, runId)); await tx.delete(shippingTickets).where(eq(shippingTickets.runId, runId));
      checkpoint.operations = {}; checkpoint.lookupAttempt++;
    } else {
      // Failed lookups have immutable operation IDs. Retain successful batches,
      // create a new lookup only for a failed batch, and re-evaluate previews.
      checkpoint.lookupAttempt++;
      for (const key of Object.keys(checkpoint.operations)) if (key === 'commit-preview' || key.startsWith('confirm:')) delete checkpoint.operations[key];
      if (!committed.length) delete checkpoint.operations['commit-request'];
      for (const [key, operation] of Object.entries(checkpoint.operations)) {
        if (operation.resultId) continue;
        const operationId = (operation.input as { operationId?: string }).operationId;
        if (!operationId) continue;
        if (key.startsWith('group:')) {
          const completed = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, operationId)).limit(1);
          if (!completed.length) delete checkpoint.operations[key];
        } else if (key.startsWith('lookup:')) {
          const [lookup] = await tx.select().from(fbaLookupRuns).where(eq(fbaLookupRuns.operationId, operationId));
          if (lookup) operation.resultId = lookup.id; else delete checkpoint.operations[key];
        } else if (key.startsWith('sync:')) {
          const [sync] = await tx.select().from(batchSyncRuns).where(eq(batchSyncRuns.operationId, operationId));
          if (sync) operation.resultId = sync.id; else delete checkpoint.operations[key];
        }
      }
    }
    await tx.update(shippingRuns).set({ version: run.version + 1, importId, parseRunId, status: 'queued', stage: changingParse ? 'lookup' : run.stage, checkpoint, issues: [], error: null, updatedAt: new Date() }).where(eq(shippingRuns.id, runId));
    await enqueue(tx, boss, runId);
    await tx.insert(shippingRunOperations).values({ operationId: input.operationId, runId, actorId, requestHash: hash });
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'shipping_run.retry', targetId: runId, actorUserId: actorId, requestHash: hash, details: { parseRunId } });
  });
  return getShippingRun(runId, actorId);
}

export async function enqueueShippingRunInTx(tx: BatchTx, boss: PgBoss, runId: string) { return enqueue(tx, boss, runId); }
export async function activeShippingRuns() { return db.select().from(shippingRuns).where(inArray(shippingRuns.status, ['queued', 'running'])).orderBy(asc(shippingRuns.updatedAt)).limit(100); }

export async function reserveShippingSequenceInTx(tx: BatchTx, run: typeof shippingRuns.$inferSelect) {
  if (run.sequence !== null) return run.sequence;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-month:${run.month}`},0))`);
  await tx.insert(shippingMonthCounters).values({ month: run.month, lastSequence: 0 }).onConflictDoNothing();
  const [counter] = await tx.update(shippingMonthCounters).set({ lastSequence: sql`${shippingMonthCounters.lastSequence}+1` }).where(eq(shippingMonthCounters.month, run.month)).returning();
  const sequence = counter!.lastSequence;
  await tx.update(shippingRuns).set({ sequence, updatedAt: new Date() }).where(eq(shippingRuns.id, run.id));
  return sequence;
}
