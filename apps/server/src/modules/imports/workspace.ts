import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AllocationCode, DemandWorkspace, DemandWorkspaceQuery, GroupConfirmation, WeeklyBatch } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demands, demandSources, sourceImportRows } from '../../db/schema.js';
import { allocationCodes, batchDecisions, groupConfirmations, shipmentRevisions, subBatchMembers, subBatches, weeklyBatches } from '../batches/schema.js';
import { requireBatchActor, serializeDemand, serializeShipment } from '../batches/service.js';
import { projectDemandWorkspace } from './workspace-projection.js';
import { demandLifecycleCondition, loadDemandCancellationsInTx } from './demand-lifecycle.js';
import { shippingRuns, shippingTicketMembers, shippingTickets } from '../shipping-runs/schema.js';

export async function getDemandWorkspace(actorId: string, query: DemandWorkspaceQuery): Promise<DemandWorkspace> {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    // Start from every committed demand. Grouping, confirmation and box coding are optional.
    const demandRows = await tx.select().from(demands).where(demandLifecycleCondition(query.lifecycle)).orderBy(desc(demands.businessDate), asc(demands.fba), asc(demands.sid), asc(demands.id));
    const demandIds = demandRows.map((demand) => demand.id);
    const cancellations = await loadDemandCancellationsInTx(tx, demandIds);
    const batchRows = await tx.select().from(weeklyBatches).orderBy(desc(weeklyBatches.weekStartDate), asc(weeklyBatches.id));
    const memberRows = demandIds.length ? await tx.select({ member: subBatchMembers, group: subBatches }).from(subBatchMembers)
      .innerJoin(subBatches, eq(subBatchMembers.groupId, subBatches.id))
      .where(and(inArray(subBatchMembers.demandId, demandIds), eq(subBatchMembers.active, true), sql`${subBatches.status} <> 'superseded'`)) : [];
    const groupIds = [...new Set(memberRows.map((entry) => entry.group.id))];
    const revisions = demandIds.length ? await tx.selectDistinctOn([shipmentRevisions.demandId]).from(shipmentRevisions).where(inArray(shipmentRevisions.demandId, demandIds)).orderBy(asc(shipmentRevisions.demandId), desc(shipmentRevisions.version), desc(shipmentRevisions.id)) : [];
    const confirmations = groupIds.length ? await tx.select({ confirmation: groupConfirmations }).from(groupConfirmations)
      .innerJoin(subBatches, and(eq(groupConfirmations.groupId, subBatches.id), eq(groupConfirmations.groupVersion, subBatches.confirmedVersion)))
      .where(inArray(groupConfirmations.groupId, groupIds)) : [];
    const codes = groupIds.length ? await tx.select().from(allocationCodes).where(and(inArray(allocationCodes.groupId, groupIds), eq(allocationCodes.valid, true))) : [];
    const decisions = groupIds.length ? await tx.select().from(batchDecisions).where(inArray(batchDecisions.groupId, groupIds)) : [];
    const sources = demandIds.length ? await tx.select({ source: demandSources, normalized: sourceImportRows.normalized }).from(demandSources)
      .innerJoin(sourceImportRows, eq(demandSources.sourceRowId, sourceImportRows.id)).where(inArray(demandSources.demandId, demandIds)).orderBy(asc(demandSources.createdAt), asc(demandSources.id)) : [];
    const uniqueGroups = new Map(memberRows.map(({ group }) => [group.id, group]));
    const shippingMemberships = demandIds.length ? await tx.select({ demandId: shippingTicketMembers.demandId, groupId: shippingTicketMembers.groupId, runId: shippingRuns.id, month: shippingRuns.month, sequence: shippingRuns.sequence, numberingDate: shippingRuns.numberingDate, ticketNumber: shippingTickets.number }).from(shippingTicketMembers)
      .innerJoin(shippingRuns, eq(shippingRuns.id, shippingTicketMembers.runId)).innerJoin(shippingTickets, eq(shippingTickets.id, shippingTicketMembers.ticketId))
      .where(inArray(shippingTicketMembers.demandId, demandIds)) : [];
    return projectDemandWorkspace({
      demands: demandRows.map(serializeDemand), cancelledDemandIds: [...cancellations.keys()], members: memberRows.map(({ member }) => member),
      shippingMemberships: shippingMemberships.flatMap((member) => member.demandId ? [{ ...member, demandId: member.demandId }] : []),
      groups: [...uniqueGroups.values()].map((group) => ({ ...group, status: group.status as 'draft' | 'confirmed' | 'frozen' | 'superseded', frozenAt: group.frozenAt?.toISOString() ?? null, updatedAt: group.updatedAt.toISOString() })),
      batches: batchRows.map((batch): WeeklyBatch => ({ ...batch, sortMode: batch.sortMode as WeeklyBatch['sortMode'], createdAt: batch.createdAt.toISOString() })),
      shipments: revisions.map(serializeShipment),
      confirmations: confirmations.map(({ confirmation }): GroupConfirmation => ({ ...confirmation, createdAt: confirmation.createdAt.toISOString() })),
      codes: codes.map((entry): AllocationCode => ({ ...entry, createdAt: entry.createdAt.toISOString() })), decisions,
      sources: sources.map(({ source, normalized }) => ({ demandId: source.demandId, acceptedVersion: source.acceptedVersion, importId: source.importId, fileName: source.location.fileName, sheetName: source.sheetName, rowNumber: source.rowNumber, sourceFilledAt: normalized.sourceFilledAt ?? normalized.sourceDate })),
    }, query);
  }, { isolationLevel: 'repeatable read' });
}
