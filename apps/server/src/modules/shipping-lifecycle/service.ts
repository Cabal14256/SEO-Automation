import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ShippingLifecycle, ShippingLifecycleAction, ShippingLifecycleImpact, ShippingLifecycleInput, ShippingLifecycleResult, ShippingLifecycleType, ShippingRecycleList, ShippingRecycleQuery } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demandRevisions, demands, operationAudit } from '../../db/schema.js';
import { allocationCodes, subBatchMembers, subBatches, weeklyBatches } from '../batches/schema.js';
import { BatchError, requireBatchActor, type BatchTx } from '../batches/service.js';
import { documentRevisions, documents } from '../documents/schema.js';
import { documentAutomationJobs } from '../documents/automation-schema.js';
import { batchSyncRuns } from '../lingxing/sync-schema.js';
import { physicalSyncRuns } from '../physical/schema.js';
import { shippingRuns, shippingTicketMembers } from '../shipping-runs/schema.js';
import { workflowRecords } from '../workflow/schema.js';
import { shippingLifecycleOperations, shippingLifecycleSnapshots, type LifecycleSnapshot } from './schema.js';
import { inspectPurgeInTx, purgeEntityInTx } from './purge.js';
import { invalidateShippingSourcesInTx } from './dependencies.js';

type Run = typeof shippingRuns.$inferSelect;
type Group = typeof subBatches.$inferSelect;
type Demand = typeof demands.$inferSelect;
type Entity = Run | Group | Demand;
type Scope = { type: ShippingLifecycleType; id: string; target: Entity; runs: Run[]; groups: Group[]; demands: Demand[]; ticketMembers: Array<typeof shippingTicketMembers.$inferSelect>; groupMembers: Array<typeof subBatchMembers.$inferSelect>; snapshot: typeof shippingLifecycleSnapshots.$inferSelect | null };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = (values: string[]) => [...new Set(values)].sort();
const tableFor = (type: ShippingLifecycleType) => type === 'run' ? shippingRuns : type === 'group' ? subBatches : demands;
const state = (row: Entity): ShippingLifecycle => (row.lifecycle ?? 'active') as ShippingLifecycle;
const name = (type: ShippingLifecycleType, row: Entity): string => type === 'run' ? `${(row as Run).month} · ${(row as Run).sequence ? `第 ${(row as Run).sequence} 次发货` : '待编号发货'}` : type === 'group' ? (row as Group).name : (row as Demand).fba;
const byIds = <T extends { id: string }>(ids: string[], read: (ids: string[]) => Promise<T[]>) => ids.length ? read(unique(ids)).then((rows) => rows.sort((a, b) => a.id.localeCompare(b.id))) : Promise.resolve([] as T[]);

/** Read links first, then lock the complete occurrence -> batch -> group -> demand scope. */
async function loadScope(tx: BatchTx, type: ShippingLifecycleType, id: string, lock = false): Promise<Scope> {
  const table = tableFor(type);
  const [initial] = await tx.select().from(table).where(eq(table.id, id));
  if (!initial) throw new BatchError('NOT_FOUND', 404, '记录不存在或已永久删除。');
  const target = initial as Entity;
  const [snapshot] = target.lifecycleSnapshotId ? await tx.select().from(shippingLifecycleSnapshots).where(eq(shippingLifecycleSnapshots.id, target.lifecycleSnapshotId)) : [];
  let ticketMembers = type === 'run' ? await tx.select().from(shippingTicketMembers).where(eq(shippingTicketMembers.runId, id)) : type === 'group' ? await tx.select().from(shippingTicketMembers).where(eq(shippingTicketMembers.groupId, id)) : await tx.select().from(shippingTicketMembers).where(and(eq(shippingTicketMembers.demandId, id), isNull(shippingTicketMembers.releasedAt)));
  const ownedBatches = type === 'run' ? await tx.select().from(weeklyBatches).where(eq(weeklyBatches.shippingRunId, id)) : [];
  const ownedGroups = ownedBatches.length ? await tx.select().from(subBatches).where(inArray(subBatches.batchId, ownedBatches.map((batch) => batch.id))) : [];
  let groupIds = unique([...(type === 'group' ? [id] : []), ...ownedGroups.map((group) => group.id), ...ticketMembers.flatMap((member) => member.groupId ? [member.groupId] : []), ...snapshot?.data?.groupIds ?? []]);
  if (type === 'demand') {
    const memberships = await tx.select().from(subBatchMembers).where(and(eq(subBatchMembers.demandId, id), eq(subBatchMembers.active, true)));
    groupIds = unique([...groupIds, ...memberships.map((member) => member.groupId)]);
  }
  const groups = await byIds(groupIds, (ids) => tx.select().from(subBatches).where(inArray(subBatches.id, ids)));
  const allLinks = await byIds(groupIds, (ids) => tx.select().from(shippingTicketMembers).where(inArray(shippingTicketMembers.groupId, ids)));
  const batches = await byIds(groups.map((group) => group.batchId), (ids) => tx.select().from(weeklyBatches).where(inArray(weeklyBatches.id, ids)));
  const runIds = unique([...(type === 'run' ? [id] : []), ...ticketMembers.map((member) => member.runId), ...allLinks.filter((member) => !member.releasedAt).map((member) => member.runId), ...batches.flatMap((batch) => batch.shippingRunId ? [batch.shippingRunId] : []), ...snapshot?.data?.runIds ?? []]);
  const groupMembers = await byIds(groupIds, (ids) => tx.select().from(subBatchMembers).where(inArray(subBatchMembers.groupId, ids)));
  const demandIds = unique([...(type === 'demand' ? [id] : []), ...ticketMembers.flatMap((member) => member.demandId ? [member.demandId] : []), ...groupMembers.filter((member) => member.active).map((member) => member.demandId), ...snapshot?.data?.demandIds ?? []]);
  if (lock) {
    if (runIds.length) await tx.select({ id: shippingRuns.id }).from(shippingRuns).where(inArray(shippingRuns.id, runIds)).orderBy(asc(shippingRuns.id)).for('update');
    if (batches.length) await tx.select({ id: weeklyBatches.id }).from(weeklyBatches).where(inArray(weeklyBatches.id, batches.map((batch) => batch.id))).orderBy(asc(weeklyBatches.id)).for('update');
    if (groupIds.length) await tx.select({ id: subBatches.id }).from(subBatches).where(inArray(subBatches.id, groupIds)).orderBy(asc(subBatches.id)).for('update');
    for (const demandId of demandIds) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-demand:${demandId}`},0))`);
    if (demandIds.length) await tx.select({ id: demands.id }).from(demands).where(inArray(demands.id, demandIds)).orderBy(asc(demands.id)).for('update');
    // Re-read after taking locks so a concurrently completed writer changes the impact token.
    return loadScope(tx, type, id, false);
  }
  if (type === 'demand' && snapshot?.data?.ticketMemberIds.length) ticketMembers = await tx.select().from(shippingTicketMembers).where(or(eq(shippingTicketMembers.demandId, id), inArray(shippingTicketMembers.id, snapshot.data.ticketMemberIds)));
  const runRows = await byIds(runIds, (ids) => tx.select().from(shippingRuns).where(inArray(shippingRuns.id, ids)));
  const demandRows = await byIds(demandIds, (ids) => tx.select().from(demands).where(inArray(demands.id, ids)));
  return { type, id, target, runs: runRows, groups, demands: demandRows, ticketMembers: ticketMembers.sort((a, b) => a.id.localeCompare(b.id)), groupMembers, snapshot: snapshot ?? null };
}

function releasedMemberships(scope: Scope) {
  const tickets = scope.ticketMembers.filter((member) => !member.releasedAt && (scope.type === 'run' ? member.runId === scope.id : scope.type === 'group' ? member.groupId === scope.id : member.demandId === scope.id));
  const demandIds = new Set(scope.type === 'demand' ? [scope.id] : tickets.flatMap((member) => member.demandId ? [member.demandId] : []));
  // An unlinked member of an explicitly cancelled group is also released.
  const groups = scope.groupMembers.filter((member) => member.active && (scope.type === 'group' ? member.groupId === scope.id : scope.type === 'demand' ? member.demandId === scope.id : demandIds.has(member.demandId)));
  return { tickets, groups, demandIds: unique([...demandIds, ...groups.map((member) => member.demandId)]) };
}

async function restorePlan(tx: BatchTx, scope: Scope, ignorePending = false) {
  const conflicts: ShippingLifecycleImpact['conflicts'] = [];
  const snapshot = scope.snapshot;
  // Legacy demand deletion never retained arrangements. Its identity can be restored unassigned.
  if (!snapshot?.data && scope.type === 'demand' && state(scope.target) === 'trashed') return { conflicts, entities: [{ type: 'demand' as const, id: scope.id, lifecycle: 'active', snapshotId: null }], ticketIds: [], groupMemberIds: [], to: 'active' as ShippingLifecycle };
  if (!snapshot?.data) return { conflicts: [{ code: 'RESTORE_HISTORY_MISSING', message: '恢复快照不存在，无法自动恢复原安排。' }], entities: [], ticketIds: [], groupMemberIds: [], to: 'active' as ShippingLifecycle };
  const data = snapshot.data, to = data.lifecycle as ShippingLifecycle;
  const entities = data.entities.filter((entry) => {
    const current = entry.type === 'run' ? scope.runs.find((row) => row.id === entry.id) : entry.type === 'group' ? scope.groups.find((row) => row.id === entry.id) : scope.demands.find((row) => row.id === entry.id);
    return current && (entry.id === scope.id && entry.type === scope.type || current.lifecycleSnapshotId === snapshot.id && current.lifecycleOperationId === snapshot.operationId);
  });
  if (to !== 'active') return { conflicts, entities: entities.filter((entry) => entry.type === scope.type && entry.id === scope.id), ticketIds: [], groupMemberIds: [], to };
  const restoredGroups = new Set(entities.filter((entry) => entry.type === 'group' && entry.lifecycle === 'active').map((entry) => entry.id));
  const restoredRuns = new Set(entities.filter((entry) => entry.type === 'run' && entry.lifecycle === 'active').map((entry) => entry.id));
  const available = (demandId: string) => {
    const demand = scope.demands.find((row) => row.id === demandId);
    return demand && (state(demand) === 'active' || scope.type === 'demand' && demand.id === scope.id);
  };
  const ticketRows = await byIds(data.ticketMemberIds, (ids) => tx.select().from(shippingTicketMembers).where(inArray(shippingTicketMembers.id, ids)));
  const groupRows = await byIds(data.groupMemberIds, (ids) => tx.select().from(subBatchMembers).where(inArray(subBatchMembers.id, ids)));
  const explicitlyChangedGroups = new Set(data.entities.filter((entry) => entry.type === 'group' && scope.groups.some((group) => group.id === entry.id) && !entities.some((candidate) => candidate.type === 'group' && candidate.id === entry.id)).map((entry) => entry.id));
  for (const entry of data.entities) if (entry.type === 'group' && !scope.groups.some((group) => group.id === entry.id)) conflicts.push({ code: 'GROUP_NOT_FOUND', message: '原内部组已永久删除，无法恢复原安排。', id: entry.id });
  for (const demandId of data.demandIds) {
    const demand = scope.demands.find((row) => row.id === demandId);
    const affectedMemberships = groupRows.filter((row) => row.demandId === demandId && !explicitlyChangedGroups.has(row.groupId));
    if (!affectedMemberships.length && groupRows.some((row) => row.demandId === demandId)) continue;
    if (!demand) conflicts.push({ code: 'DEMAND_NOT_FOUND', message: '原 FBA 已永久删除，无法恢复原安排。', id: demandId });
    else if (!ignorePending && demand.lifecyclePending) conflicts.push({ code: 'DEMAND_PENDING', message: 'FBA 正在执行其他生命周期操作。', fba: demand.fba, id: demandId });
    else if (state(demand) === 'active' && scope.type !== 'demand' && data.demandVersions?.[demandId] !== undefined && data.demandVersions[demandId] !== demand.version) conflicts.push({ code: 'DEMAND_VERSION_CONFLICT', message: 'FBA 需求版本已变化，请核对当前需求后重新安排。', fba: demand.fba, id: demandId });
    else if (scope.type === 'demand' && demandId === scope.id) {
      const original = data.entities.find((entry) => entry.type === 'demand' && entry.id === demandId)?.record?.snapshot;
      if (original && digest(original) !== digest(demand.snapshot)) conflicts.push({ code: 'DEMAND_VERSION_CONFLICT', message: 'FBA 需求内容已变化，请核对后重新安排。', fba: demand.fba, id: demandId });
    }
    // Independent child cancellation/deletion is preserved, rather than undone by a parent restore.
  }
  for (const groupId of unique(groupRows.map((row) => row.groupId))) {
    if (explicitlyChangedGroups.has(groupId)) continue;
    const group = scope.groups.find((row) => row.id === groupId);
    if (!group) conflicts.push({ code: 'GROUP_NOT_FOUND', message: '原内部组已永久删除，无法恢复原安排。', id: groupId });
    else if (!ignorePending && group.lifecyclePending) conflicts.push({ code: 'GROUP_PENDING', message: '原内部组正在执行其他操作。', id: groupId });
    else if (state(group) !== 'active' && !restoredGroups.has(groupId)) conflicts.push({ code: 'GROUP_INACTIVE', message: '原内部组已独立取消或删除，请先恢复该组。', id: groupId });
  }
  const candidates = groupRows.filter((member) => available(member.demandId) && (restoredGroups.has(member.groupId) || scope.groups.find((group) => group.id === member.groupId)?.lifecycle === 'active'));
  const ticketCandidates = ticketRows.filter((member) => (!member.demandId || available(member.demandId)) && (!member.groupId || restoredGroups.has(member.groupId) || scope.groups.find((group) => group.id === member.groupId)?.lifecycle === 'active'));
  for (const member of ticketCandidates) {
    const run = scope.runs.find((entry) => entry.id === member.runId);
    if (!run || state(run) !== 'active' && !restoredRuns.has(run.id)) conflicts.push({ code: 'PARENT_INACTIVE', message: '原发货次尚未恢复或已永久删除，请先处理上级记录。', fba: member.fba, id: member.runId });
  }
  const ids = unique([...candidates.map((member) => member.demandId), ...ticketCandidates.flatMap((member) => member.demandId ? [member.demandId] : [])]);
  const occupiedTickets = await byIds(ids, (values) => tx.select().from(shippingTicketMembers).where(and(inArray(shippingTicketMembers.demandId, values), isNull(shippingTicketMembers.releasedAt))));
  const occupiedGroups = await byIds(ids, (values) => tx.select().from(subBatchMembers).where(and(inArray(subBatchMembers.demandId, values), eq(subBatchMembers.active, true))));
  for (const member of ticketCandidates) if (member.demandId && occupiedTickets.some((current) => current.demandId === member.demandId && current.id !== member.id)) conflicts.push({ code: 'MEMBER_ALREADY_SHIPPED', message: 'FBA 已重新安排到其他发货次，不能覆盖新安排。', fba: member.fba, id: member.demandId });
  for (const member of candidates) if (occupiedGroups.some((current) => current.demandId === member.demandId && current.id !== member.id)) conflicts.push({ code: 'MEMBER_ALREADY_GROUPED', message: 'FBA 已加入其他有效批次，不能覆盖新安排。', fba: scope.demands.find((row) => row.id === member.demandId)?.fba, id: member.demandId });
  return { conflicts, entities, ticketIds: ticketCandidates.map((row) => row.id), groupMemberIds: candidates.map((row) => row.id), to };
}

async function impactInTx(tx: BatchTx, scope: Scope, action: ShippingLifecycleAction): Promise<ShippingLifecycleImpact> {
  const targetState = state(scope.target), blockingReasons: string[] = [];
  if (scope.target.lifecyclePending || scope.runs.some((row) => row.lifecyclePending) || scope.groups.some((row) => row.lifecyclePending)) blockingReasons.push('已有生命周期操作正在处理，请等待完成。');
  if (action === 'cancel' && targetState !== 'active') blockingReasons.push('仅当前有效记录可以取消。');
  if (action === 'trash' && targetState === 'trashed') blockingReasons.push('记录已在回收站。');
  if (action === 'restore' && targetState === 'active') blockingReasons.push('当前有效记录不需要恢复。');
  if (action === 'purge' && targetState !== 'trashed') blockingReasons.push('请先移入回收站，再永久删除。');
  const restore = action === 'restore' ? await restorePlan(tx, scope) : null;
  if (action === 'purge') blockingReasons.push(...(await inspectPurgeInTx(tx, scope.type, scope.id)).reasons);
  const demandIds = scope.demands.map((row) => row.id), groupIds = scope.groups.map((row) => row.id);
  const revisions = demandIds.length || groupIds.length || scope.type === 'run' ? await tx.select({ record: documents, revision: documentRevisions }).from(documents).innerJoin(documentRevisions, eq(documentRevisions.id, documents.currentRevisionId)).where(sql`(${scope.type === 'run'} AND ${documentRevisions.data}->>'shippingRunId'=${scope.id}) OR EXISTS (SELECT 1 FROM jsonb_array_elements(${documentRevisions.data}->'members') m WHERE m->'demand'->>'id' = ANY(${sql.param(demandIds)}::text[]) OR m->'source'->>'groupId' = ANY(${sql.param(groupIds)}::text[]))`) : [];
  const workflows = demandIds.length || groupIds.length || scope.type === 'run' ? await tx.select({ id: workflowRecords.id, version: workflowRecords.version }).from(workflowRecords).where(sql`(${scope.type === 'run'} AND ${workflowRecords.source}->>'shippingRunId'=${scope.id}) OR EXISTS (SELECT 1 FROM jsonb_array_elements(${workflowRecords.source}->'members') m WHERE m->'demand'->>'id' = ANY(${sql.param(demandIds)}::text[]) OR m->'source'->>'groupId' = ANY(${sql.param(groupIds)}::text[]))`) : [];
  const conflicts = restore?.conflicts ?? [];
  const result = { type: scope.type, id: scope.id, name: name(scope.type, scope.target), version: scope.target.version, lifecycle: targetState, action,
    members: scope.demands.map((row) => ({ id: row.id, fba: row.fba })).sort((a, b) => a.id.localeCompare(b.id)), affectedRuns: scope.runs.map((row) => ({ id: row.id, name: name('run', row) })), groups: scope.groups.map((row) => ({ id: row.id, name: row.name })), documents: revisions.map(({ record, revision }) => ({ id: record.id, title: revision.data.title })), workflowCount: workflows.length, conflicts, canExecute: !blockingReasons.length && !conflicts.length, blockingReasons, ...(restore ? { willRestoreTo: restore.to } : {}) };
  const versions = { target: scope.target, runs: scope.runs.map((row) => [row.id, row.version, row.lifecycle, row.lifecyclePending]), groups: scope.groups.map((row) => [row.id, row.version, row.lifecycle, row.lifecyclePending]), demands: scope.demands.map((row) => [row.id, row.version, row.lifecycle]), members: scope.ticketMembers.map((row) => [row.id, row.demandId, row.groupId, row.releasedAt]), groupMembers: scope.groupMembers.map((row) => [row.id, row.active, row.demandVersion]), documents: revisions.map(({ record }) => [record.id, record.version]), workflows };
  return { ...result, impactToken: digest({ result, versions }) };
}

export async function getShippingLifecycleImpact(type: ShippingLifecycleType, id: string, action: ShippingLifecycleAction, actorId: string) {
  return db.transaction(async (tx) => { await requireBatchActor(tx, actorId); return impactInTx(tx, await loadScope(tx, type, id), action); }, { isolationLevel: 'repeatable read' });
}

async function setEntity(tx: BatchTx, type: ShippingLifecycleType, id: string, values: Partial<Pick<Entity, 'lifecycle' | 'lifecycleChangedAt' | 'lifecycleChangedBy' | 'lifecycleReason' | 'lifecycleOperationId' | 'lifecyclePending' | 'lifecycleSnapshotId'>> & { version?: number }) {
  const table = tableFor(type);
  if (type === 'demand' && values.version !== undefined) {
    const [demand] = await tx.select().from(demands).where(eq(demands.id, id));
    if (demand) await tx.insert(demandRevisions).values({ id: randomUUID(), demandId: id, version: values.version, snapshot: demand.snapshot, createdBy: values.lifecycleChangedBy! });
  }
  await tx.update(table).set(values).where(eq(table.id, id));
}

async function makeSnapshot(tx: BatchTx, scope: Scope, operationId: string): Promise<typeof shippingLifecycleSnapshots.$inferSelect> {
  const released = releasedMemberships(scope), releasedIds = new Set(released.groups.map((member) => member.id));
  const entities: LifecycleSnapshot['entities'] = [{ type: scope.type, id: scope.id, lifecycle: state(scope.target), ...('status' in scope.target ? { status: scope.target.status } : {}), snapshotId: scope.target.lifecycleSnapshotId, record: { ...scope.target } }];
  if (scope.type === 'run' && state(scope.target) === 'active') for (const group of scope.groups) {
    const active = scope.groupMembers.filter((member) => member.groupId === group.id && member.active);
    if (state(group) === 'active' && group.status !== 'superseded' && active.every((member) => releasedIds.has(member.id))) entities.push({ type: 'group', id: group.id, lifecycle: state(group), status: group.status, snapshotId: group.lifecycleSnapshotId, record: { ...group } });
  }
  const codeRows = released.groups.length ? await tx.select().from(allocationCodes).where(and(inArray(allocationCodes.groupId, unique(released.groups.map((member) => member.groupId))), inArray(allocationCodes.demandId, released.demandIds), eq(allocationCodes.valid, true))) : [];
  const data: LifecycleSnapshot = { type: scope.type, id: scope.id, lifecycle: state(scope.target), previousSnapshotId: scope.target.lifecycleSnapshotId, entities, ticketMemberIds: released.tickets.map((row) => row.id), groupMemberIds: released.groups.map((row) => row.id), codeIds: codeRows.map((row) => row.id), runIds: scope.runs.map((row) => row.id), groupIds: scope.groups.map((row) => row.id), demandIds: released.demandIds, demandVersions: Object.fromEntries(scope.demands.filter((demand) => released.demandIds.includes(demand.id)).map((demand) => [demand.id, demand.version])) };
  const [snapshot] = await tx.insert(shippingLifecycleSnapshots).values({ id: randomUUID(), type: scope.type, entityId: scope.id, operationId, data }).returning();
  return snapshot!;
}

async function workerLocksAvailable(tx: BatchTx, scope: Scope) {
  const groupIds = scope.groups.map((row) => row.id), runIds = scope.runs.map((row) => row.id);
  const sync = await byIds(groupIds, (ids) => tx.select({ id: batchSyncRuns.id }).from(batchSyncRuns).where(and(inArray(batchSyncRuns.subBatchId, ids), inArray(batchSyncRuns.status, ['queued', 'running']))));
  const physical = await byIds(groupIds, (ids) => tx.select({ id: physicalSyncRuns.id }).from(physicalSyncRuns).where(and(inArray(physicalSyncRuns.groupId, ids), inArray(physicalSyncRuns.status, ['queued', 'running']))));
  const automations = await byIds(runIds, (ids) => tx.select({ id: documentAutomationJobs.id }).from(documentAutomationJobs).where(and(inArray(documentAutomationJobs.shippingRunId, ids), isNull(documentAutomationJobs.deletedAt))));
  const keys = [...runIds.map((id) => `shipping-run:${id}`), ...sync.map(({ id }) => `batch-sync-run:${id}`), ...physical.map(({ id }) => `physical-sync-run:${id}`), ...automations.map(({ id }) => `document-automation:${id}`)].sort();
  for (const key of keys) {
    const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS locked`);
    if (!(result as unknown as { rows: Array<{ locked: boolean }> }).rows[0]?.locked) return false;
  }
  return true;
}

async function markPending(tx: BatchTx, scope: Scope, operationId: string) {
  for (const type of ['run', 'group'] as const) for (const row of type === 'run' ? scope.runs : scope.groups) {
    if (row.lifecyclePending && row.lifecycleOperationId !== operationId) throw new BatchError('SHIPPING_LIFECYCLE_BUSY', 409, '关联记录已有取消、删除或恢复正在处理。');
    await setEntity(tx, type, row.id, { lifecyclePending: true });
  }
  if (scope.type === 'demand') await setEntity(tx, 'demand', scope.id, { lifecyclePending: true });
}

async function finishInTx(tx: BatchTx, operation: typeof shippingLifecycleOperations.$inferSelect, scope: Scope): Promise<ShippingLifecycleResult> {
  const input = operation.input!;
  const now = new Date();
  if (operation.action === 'purge') {
    const eligibility = await inspectPurgeInTx(tx, scope.type, scope.id);
    if (!eligibility.canPurge) throw new BatchError('SHIPPING_PURGE_PROTECTED', 409, eligibility.reasons.join('；'));
    await purgeEntityInTx(tx, scope.type, scope.id);
    const purgedGroupIds = scope.type === 'demand' ? [] : scope.groups.map((group) => group.id);
    await tx.update(shippingLifecycleSnapshots).set({ data: null }).where(or(and(eq(shippingLifecycleSnapshots.type, scope.type), eq(shippingLifecycleSnapshots.entityId, scope.id)), purgedGroupIds.length ? sql`${shippingLifecycleSnapshots.data}->'groupIds' ?| ${sql.param(purgedGroupIds)}::text[]` : undefined));
    await tx.update(shippingLifecycleOperations).set({ input: null, pending: 0, result: sql`jsonb_set(jsonb_set(${shippingLifecycleOperations.result},'{purged}','true'::jsonb),'{pending}','false'::jsonb)` }).where(or(and(eq(shippingLifecycleOperations.type, scope.type), eq(shippingLifecycleOperations.entityId, scope.id)), purgedGroupIds.length ? and(eq(shippingLifecycleOperations.type, 'group'), inArray(shippingLifecycleOperations.entityId, purgedGroupIds)) : undefined));
  } else if (operation.action === 'restore') {
    const plan = await restorePlan(tx, scope, true);
    if (plan.conflicts.length) throw new BatchError('SHIPPING_RESTORE_CONFLICT', 409, '原安排已变化，请处理冲突后重新恢复。', { conflicts: plan.conflicts });
    if (plan.ticketIds.length) await tx.update(shippingTicketMembers).set({ releasedAt: null }).where(inArray(shippingTicketMembers.id, plan.ticketIds));
    for (const entry of plan.entities) {
      const current = entry.type === 'run' ? scope.runs.find((row) => row.id === entry.id) : entry.type === 'group' ? scope.groups.find((row) => row.id === entry.id) : scope.demands.find((row) => row.id === entry.id);
      if (!current) continue;
      await setEntity(tx, entry.type, entry.id, { lifecycle: entry.lifecycle, lifecycleChangedAt: now, lifecycleChangedBy: operation.actorId, lifecycleReason: input.reason, lifecycleOperationId: operation.operationId, lifecycleSnapshotId: entry.snapshotId, version: current.version + 1 });
      if (entry.type === 'group' && entry.lifecycle === 'active' && entry.status !== 'superseded') await tx.update(subBatches).set({ status: 'draft', confirmedVersion: null, frozenAt: null, updatedAt: now }).where(eq(subBatches.id, entry.id));
      if (entry.type === 'run' && entry.lifecycle === 'active') {
        const run = current as Run;
        const checkpoint = { ...run.checkpoint, operations: Object.fromEntries(Object.entries(run.checkpoint.operations).filter(([key]) => !key.startsWith('confirm:') && !key.startsWith('sync:') && !key.startsWith('sync-retry:'))) };
        await tx.update(shippingRuns).set({ status: 'draft', stage: run.sequence === null ? run.stage : 'sync', checkpoint, membershipFrozenAt: null, issues: [], error: null, updatedAt: now }).where(eq(shippingRuns.id, entry.id));
      }
    }
    if (plan.groupMemberIds.length) {
      const rows = await tx.select().from(subBatchMembers).where(inArray(subBatchMembers.id, plan.groupMemberIds));
      for (const row of rows) {
        const [current] = await tx.select({ version: demands.version }).from(demands).where(eq(demands.id, row.demandId));
        await tx.update(subBatchMembers).set({ active: true, demandVersion: current!.version }).where(eq(subBatchMembers.id, row.id));
      }
    }
  } else {
    const snapshot = scope.snapshot;
    if (!snapshot?.data || snapshot.operationId !== operation.operationId) throw new BatchError('SHIPPING_LIFECYCLE_SNAPSHOT_MISSING', 409, '生命周期快照缺失，请联系管理员。');
    const data = snapshot.data;
    if (data.ticketMemberIds.length) await tx.update(shippingTicketMembers).set({ releasedAt: now }).where(and(inArray(shippingTicketMembers.id, data.ticketMemberIds), isNull(shippingTicketMembers.releasedAt)));
    if (data.groupMemberIds.length) await tx.update(subBatchMembers).set({ active: false }).where(inArray(subBatchMembers.id, data.groupMemberIds));
    if (data.codeIds.length) await tx.update(allocationCodes).set({ valid: false }).where(inArray(allocationCodes.id, data.codeIds));
    for (const entry of data.entities) {
      const current = entry.type === 'run' ? scope.runs.find((row) => row.id === entry.id) : entry.type === 'group' ? scope.groups.find((row) => row.id === entry.id) : scope.demands.find((row) => row.id === entry.id);
      if (!current) continue;
      await setEntity(tx, entry.type, entry.id, { lifecycle: operation.action === 'cancel' ? 'cancelled' : 'trashed', lifecycleChangedAt: now, lifecycleChangedBy: operation.actorId, lifecycleReason: input.reason, lifecycleOperationId: operation.operationId, lifecycleSnapshotId: snapshot.id, version: current.version + 1 });
    }
  }
  // Changing one FBA invalidates the entire confirmation; its immutable snapshot is retained.
  const changedGroups = scope.groups.filter((row) => row.status !== 'superseded').map((row) => row.id), changedRuns = scope.runs.map((row) => row.id);
  if (operation.action !== 'purge' && !(operation.action === 'restore' && scope.snapshot?.data?.lifecycle !== 'active')) {
    if (changedGroups.length) await tx.update(subBatches).set({ confirmedVersion: null, status: 'draft', frozenAt: null, updatedAt: now, version: sql`${subBatches.version}+1` }).where(inArray(subBatches.id, changedGroups));
    if (changedRuns.length) await tx.update(shippingRuns).set({ status: 'needs_review', stage: sql`CASE WHEN ${shippingRuns.sequence} IS NULL THEN ${shippingRuns.stage} ELSE 'sync' END`, membershipFrozenAt: null, issues: [], error: null, updatedAt: now, version: sql`${shippingRuns.version}+1` }).where(and(inArray(shippingRuns.id, changedRuns), eq(shippingRuns.lifecycle, 'active')));
    await invalidateShippingSourcesInTx(tx, { runIds: scope.type === 'run' ? [scope.id] : [], groupIds: changedGroups, demandIds: scope.type === 'demand' ? [scope.id] : releasedMemberships(scope).demandIds, operationId: operation.operationId, reason: input.reason, actorId: operation.actorId });
  }
  for (const type of ['run', 'group', 'demand'] as const) {
    const table = tableFor(type);
    const ids = type === 'run' ? scope.runs.map((row) => row.id) : type === 'group' ? scope.groups.map((row) => row.id) : scope.type === 'demand' ? [scope.id] : [];
    if (ids.length) await tx.update(table).set({ lifecyclePending: false }).where(inArray(table.id, ids));
  }
  const table = tableFor(scope.type);
  const [current] = operation.action === 'purge' ? [] : await tx.select({ version: table.version, lifecycle: table.lifecycle }).from(table).where(eq(table.id, scope.id));
  const result: ShippingLifecycleResult = { type: scope.type, id: scope.id, version: current?.version ?? scope.target.version + 1, lifecycle: (current?.lifecycle ?? 'trashed') as ShippingLifecycle, pending: false, purged: operation.action === 'purge', replayed: false };
  await tx.update(shippingLifecycleOperations).set({ result, pending: 0, input: operation.action === 'purge' ? null : input, error: null }).where(eq(shippingLifecycleOperations.operationId, operation.operationId));
  await tx.insert(operationAudit).values({ id: randomUUID(), action: `shipping_lifecycle.${operation.action}`, targetId: scope.id, actorUserId: operation.actorId, requestHash: operation.requestHash, details: { operationId: operation.operationId, type: scope.type, reason: input.reason } });
  return result;
}

export async function changeShippingLifecycle(type: ShippingLifecycleType, id: string, action: ShippingLifecycleAction, input: ShippingLifecycleInput, actorId: string): Promise<ShippingLifecycleResult> {
  const requestHash = digest({ type, id, action, input, actorId });
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-lifecycle-operation:${input.operationId}`},0))`);
    const [existing] = await tx.select().from(shippingLifecycleOperations).where(eq(shippingLifecycleOperations.operationId, input.operationId));
    if (existing) {
      if (existing.actorId !== actorId || existing.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于不同的生命周期请求。');
      if (existing.error) throw new BatchError('SHIPPING_LIFECYCLE_FAILED', 409, existing.error);
      return { ...existing.result, replayed: true };
    }
    let scope = await loadScope(tx, type, id, true);
    if (scope.target.version !== input.expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '记录版本已变化，请重新查看操作影响。');
    const impact = await impactInTx(tx, scope, action);
    if (impact.impactToken !== input.impactToken) throw new BatchError('SHIPPING_IMPACT_CHANGED', 409, '操作影响已变化，请重新核对后确认。', { impact });
    if (!impact.canExecute) throw new BatchError('SHIPPING_LIFECYCLE_BLOCKED', 409, impact.blockingReasons.join('；') || '存在恢复冲突，请先处理。', { conflicts: impact.conflicts, blockingReasons: impact.blockingReasons });
    if (action === 'cancel' || action === 'trash') {
      const snapshot = await makeSnapshot(tx, scope, input.operationId);
      await setEntity(tx, type, id, { lifecycleSnapshotId: snapshot.id });
      scope = { ...scope, snapshot };
    }
    await markPending(tx, scope, input.operationId);
    const pending: ShippingLifecycleResult = { type, id, version: scope.target.version, lifecycle: state(scope.target), pending: true, purged: false, replayed: false };
    const [operation] = await tx.insert(shippingLifecycleOperations).values({ operationId: input.operationId, type, entityId: id, action, actorId, requestHash, input, result: pending, pending: 1 }).returning();
    if (!(await workerLocksAvailable(tx, scope))) return pending;
    return finishInTx(tx, operation!, scope);
  });
}

/** Called by the worker ticker. Failed recovery leaves the record in its previous lifecycle. */
export async function finalizePendingShippingLifecycles() {
  const pending = await db.select({ operationId: shippingLifecycleOperations.operationId }).from(shippingLifecycleOperations).where(eq(shippingLifecycleOperations.pending, 1)).orderBy(asc(shippingLifecycleOperations.createdAt)).limit(25);
  for (const { operationId } of pending) {
    try { await db.transaction(async (tx) => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`shipping-lifecycle-operation:${operationId}`},0)) AS locked`);
    if (!(lock as unknown as { rows: Array<{ locked: boolean }> }).rows[0]?.locked) return;
    const [operation] = await tx.select().from(shippingLifecycleOperations).where(eq(shippingLifecycleOperations.operationId, operationId)).for('update');
    if (!operation?.pending) return;
    const scope = await loadScope(tx, operation.type, operation.entityId, true);
    if (!(await workerLocksAvailable(tx, scope))) return;
    await finishInTx(tx, operation, scope);
    }); } catch (error) {
      if (!(error instanceof BatchError)) throw error;
      await db.transaction(async (tx) => {
        const [operation] = await tx.select().from(shippingLifecycleOperations).where(eq(shippingLifecycleOperations.operationId, operationId)).for('update');
        if (!operation?.pending) return;
        const scope = await loadScope(tx, operation.type, operation.entityId, true);
        for (const type of ['run', 'group', 'demand'] as const) {
          const ids = type === 'run' ? scope.runs.map((row) => row.id) : type === 'group' ? scope.groups.map((row) => row.id) : scope.type === 'demand' ? [scope.id] : [];
          const table = tableFor(type);
          if (ids.length) await tx.update(table).set({ lifecyclePending: false }).where(inArray(table.id, ids));
        }
        await tx.update(shippingLifecycleOperations).set({ pending: 0, error: error.message, result: { ...operation.result, pending: false } }).where(eq(shippingLifecycleOperations.operationId, operationId));
      });
    }
  }
}

export async function listShippingRecycleBin(actorId: string, query: ShippingRecycleQuery): Promise<ShippingRecycleList> {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const candidates: Array<{ type: ShippingLifecycleType; row: Entity }> = [];
    for (const type of ['run', 'group', 'demand'] as const) {
      if (query.type && query.type !== type) continue;
      const table = tableFor(type);
      const rows = await tx.select().from(table).where(eq(table.lifecycle, 'trashed')).orderBy(desc(table.lifecycleChangedAt));
      candidates.push(...rows.map((row) => ({ type, row: row as Entity })));
    }
    const cachedScopes = new Map<string, Scope>(), filtered: typeof candidates = [], search = query.q.toLowerCase();
    for (const candidate of candidates) {
      const { type, row } = candidate;
      if (!search || name(type, row).toLowerCase().includes(search)) { filtered.push(candidate); continue; }
      if (type === 'demand') continue;
      const scope = await loadScope(tx, type, row.id);
      cachedScopes.set(`${type}:${row.id}`, scope);
      if (scope.demands.some((demand) => demand.fba.toLowerCase().includes(search)) || scope.ticketMembers.some((member) => member.fba.toLowerCase().includes(search))) filtered.push(candidate);
    }
    filtered.sort((a, b) => (b.row.lifecycleChangedAt?.getTime() ?? 0) - (a.row.lifecycleChangedAt?.getTime() ?? 0) || a.row.id.localeCompare(b.row.id));
    const items = [];
    for (const { type, row } of filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)) {
      const scope = cachedScopes.get(`${type}:${row.id}`) ?? await loadScope(tx, type, row.id), eligibility = await inspectPurgeInTx(tx, type, row.id);
      items.push({ type, id: row.id, name: name(type, row), version: row.version, lifecycle: state(row), changedAt: (row.lifecycleChangedAt ?? row.createdAt).toISOString(), changedBy: row.lifecycleChangedBy, reason: row.lifecycleReason ?? '', pending: row.lifecyclePending, memberCount: scope.demands.length, canPurge: eligibility.canPurge && !row.lifecyclePending, purgeBlockingReasons: eligibility.reasons });
    }
    return { items, total: filtered.length, page: query.page, pageSize: query.pageSize };
  }, { isolationLevel: 'repeatable read' });
}
