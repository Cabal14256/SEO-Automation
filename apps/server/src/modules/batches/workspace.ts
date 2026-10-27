import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { BatchWorkspace, BatchWorkspaceQuery, DemandRecord, SubBatchRecord, WeeklyBatch } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demands } from '../../db/schema.js';
import { batchSyncRuns } from '../lingxing/sync-schema.js';
import { groupConfirmations, shipmentRevisions, subBatchMembers, subBatches, weeklyBatches } from './schema.js';
import { requireBatchActor, serializeDemand } from './service.js';
import { projectBatchWorkspace, type WorkspaceConfirmation } from './workspace-projection.js';
import { demandLifecycleCondition } from '../imports/demand-lifecycle.js';
import { shippingRuns, shippingTicketMembers } from '../shipping-runs/schema.js';

export async function getBatchWorkspace(actorId: string, query: BatchWorkspaceQuery): Promise<BatchWorkspace> {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const batches = await tx.select().from(weeklyBatches).orderBy(desc(weeklyBatches.weekStartDate));
    const groups = await tx.select().from(subBatches).where(and(ne(subBatches.status, 'superseded'), query.lifecycle === 'all' ? undefined : eq(subBatches.lifecycle, query.lifecycle ?? 'active'))).orderBy(asc(subBatches.position), asc(subBatches.id));
    const groupIds = groups.map((group) => group.id);
    const members = groupIds.length ? await tx.select({ groupId: subBatchMembers.groupId, demandId: subBatchMembers.demandId }).from(subBatchMembers)
      .where(and(inArray(subBatchMembers.groupId, groupIds), eq(subBatchMembers.active, true))) : [];
    const demandRows = await tx.select().from(demands).where(demandLifecycleCondition('active')).orderBy(asc(demands.id));
    const demandIds = members.map((member) => member.demandId);
    // Select only revision identities and versions. Large product/box JSON never leaves PostgreSQL here.
    const revisions = demandIds.length ? await tx.selectDistinctOn([shipmentRevisions.demandId], {
      id: shipmentRevisions.id, demandId: shipmentRevisions.demandId, version: shipmentRevisions.version, demandVersion: shipmentRevisions.demandVersion,
    }).from(shipmentRevisions).where(inArray(shipmentRevisions.demandId, demandIds)).orderBy(asc(shipmentRevisions.demandId), desc(shipmentRevisions.version)) : [];
    const confirmations = groupIds.length ? await tx.select({
      id: groupConfirmations.id, groupId: groupConfirmations.groupId, groupVersion: groupConfirmations.groupVersion, createdAt: groupConfirmations.createdAt,
      members: sql<DemandRecord[]>`${groupConfirmations.snapshot}->'members'`,
      shipments: sql<WorkspaceConfirmation['shipments']>`coalesce((select jsonb_agg(jsonb_build_object('demandId', entry->>'demandId', 'revisionId', entry->'revision'->>'id')) from jsonb_array_elements(${groupConfirmations.snapshot}->'shipments') as entry), '[]'::jsonb)`,
    }).from(groupConfirmations).innerJoin(subBatches, and(eq(subBatches.id, groupConfirmations.groupId), eq(subBatches.confirmedVersion, groupConfirmations.groupVersion)))
      .where(inArray(groupConfirmations.groupId, groupIds)) : [];
    const runs = groupIds.length ? await tx.selectDistinctOn([batchSyncRuns.subBatchId], {
      id: batchSyncRuns.id, subBatchId: batchSyncRuns.subBatchId, status: batchSyncRuns.status, groupVersion: batchSyncRuns.groupVersion,
      createdAt: batchSyncRuns.createdAt, completedAt: batchSyncRuns.completedAt,
    }).from(batchSyncRuns).where(inArray(batchSyncRuns.subBatchId, groupIds)).orderBy(asc(batchSyncRuns.subBatchId), desc(batchSyncRuns.createdAt), desc(batchSyncRuns.id)) : [];
    const occurrences = await tx.select({ id: shippingRuns.id, month: shippingRuns.month, sequence: shippingRuns.sequence, numberingDate: shippingRuns.numberingDate }).from(shippingRuns).where(eq(shippingRuns.lifecycle, 'active'));
    const shippingMemberships = groupIds.length ? await tx.select({ groupId: shippingTicketMembers.groupId, demandId: shippingTicketMembers.demandId, runId: shippingTicketMembers.runId }).from(shippingTicketMembers).where(and(inArray(shippingTicketMembers.groupId, groupIds), isNull(shippingTicketMembers.releasedAt))) : [];
    return projectBatchWorkspace({
      shippingRuns: occurrences, shippingMemberships,
      batches: batches.map((batch): WeeklyBatch => ({ ...batch, sortMode: batch.sortMode as WeeklyBatch['sortMode'], createdAt: batch.createdAt.toISOString() })),
      groups: groups.map((group): SubBatchRecord => ({ ...group, lifecycle: group.lifecycle as SubBatchRecord['lifecycle'], status: group.status as SubBatchRecord['status'],
        demandIds: members.filter((member) => member.groupId === group.id).map((member) => member.demandId).sort(),
        frozenAt: group.frozenAt?.toISOString() ?? null, createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString() })),
      demands: demandRows.map(serializeDemand), shipments: revisions,
      confirmations: confirmations.map((confirmation) => ({ ...confirmation, createdAt: confirmation.createdAt.toISOString() })),
      syncRuns: runs.map((run) => ({ ...run, status: run.status as NonNullable<BatchWorkspace['rows'][number]['sync']['latestRun']>['status'], createdAt: run.createdAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null })),
    }, query);
  }, { isolationLevel: 'repeatable read' });
}
