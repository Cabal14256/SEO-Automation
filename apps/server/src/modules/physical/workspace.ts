import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { DemandRecord, PhysicalReview, PhysicalWorkspace, PhysicalWorkspaceQuery, PhysicalWorkspaceRow } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demands } from '../../db/schema.js';
import { groupConfirmations, subBatchMembers, subBatches, weeklyBatches } from '../batches/schema.js';
import { requireBatchActor, serializeDemand } from '../batches/service.js';
import { getPhysicalReview } from './service.js';
import { shippingRuns, shippingTicketMembers } from '../shipping-runs/schema.js';

export type PhysicalWorkspaceEntry = {
  shippingRuns?: PhysicalWorkspaceRow['shippingRuns'];
  batch: PhysicalWorkspaceRow['batch']; group: PhysicalWorkspaceRow['group']; members: DemandRecord[];
  review: Pick<PhysicalReview, 'version' | 'revision' | 'source' | 'valid' | 'canExport' | 'pendingChange' | 'blocked' | 'confirmation'>;
};
const unique = (values: string[]) => [...new Set(values)].sort((left, right) => left.localeCompare(right, 'zh-CN'));

/** Filtering is applied to one shipment at a time, so store/country/channel cannot be mixed across members. */
export function projectPhysicalWorkspace(entries: PhysicalWorkspaceEntry[], query: PhysicalWorkspaceQuery): PhysicalWorkspace {
  const shops = new Map<number, string>();
  for (const { members } of entries) for (const member of members) shops.set(member.snapshot.sid, member.snapshot.shop);
  const projected = entries.map(({ batch, group, members, review, shippingRuns: occurrences = [] }) => {
    const status: PhysicalWorkspaceRow['physical']['status'] = review.valid ? 'confirmed' : review.confirmation || review.pendingChange ? 'stale' : review.blocked.some((issue) => !['SOURCE_REQUIRED', 'REVIEW_INCOMPLETE'].includes(issue.code)) ? 'blocked' : 'pending';
    const row: PhysicalWorkspaceRow = { id: group.id, batch, group, shippingRuns: occurrences, memberCount: members.length,
      sids: [...new Set(members.map((member) => member.snapshot.sid))].sort((left, right) => left - right), shops: unique(members.map((member) => member.snapshot.shop)),
      countries: unique(members.map((member) => member.snapshot.country)), channels: unique(members.flatMap((member) => member.snapshot.channel ? [member.snapshot.channel] : [])), fbas: unique(members.map((member) => member.snapshot.fba)),
      physical: { status, version: review.version, checkedCount: review.revision?.entries.filter((entry) => entry.status !== 'pending').length ?? 0, boxCount: review.source?.boxes.length ?? 0,
        valid: review.valid, pendingChange: review.pendingChange, blockedCount: review.blocked.length, confirmationId: review.confirmation?.id ?? null, confirmedAt: review.confirmation?.createdAt ?? null,
        exportReference: review.valid && review.canExport && review.confirmation ? {
          groupId: group.id, m2ConfirmationId: review.confirmation.m2ConfirmationId, physicalConfirmationId: review.confirmation.id,
          m3Version: review.confirmation.m3Version, sourceFingerprint: review.confirmation.sourceFingerprint,
        } : null },
    };
    return { row, members };
  }).sort((left, right) => (right.row.shippingRuns[0]?.numberingDate ?? '').localeCompare(left.row.shippingRuns[0]?.numberingDate ?? '') || left.row.group.name.localeCompare(right.row.group.name, 'zh-CN') || left.row.id.localeCompare(right.row.id));
  const filtered = projected.filter(({ row, members }) => {
    if (query.status && row.physical.status !== query.status) return false;
    if (query.month && !row.shippingRuns.some((run) => run.month === query.month) || query.shippingRunId && !row.shippingRuns.some((run) => run.id === query.shippingRunId)) return false;
    const matching = members.filter((member) => (query.sid === undefined || member.snapshot.sid === query.sid) && (!query.country || member.snapshot.country === query.country) && (!query.channel || member.snapshot.channel === query.channel));
    if ((query.sid !== undefined || query.country || query.channel) && !matching.length) return false;
    const q = query.q?.toLocaleLowerCase();
    return !q || row.group.name.toLocaleLowerCase().includes(q) || matching.some((member) => member.snapshot.fba.toLocaleLowerCase().includes(q));
  });
  const occurrences = new Map(entries.flatMap((entry) => (entry.shippingRuns ?? []).map((run) => [run.id, run] as const)));
  return { rows: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(({ row }) => row), total: filtered.length, page: query.page, pageSize: query.pageSize,
    filters: { shippingRuns: [...occurrences.values()].sort((a, b) => b.numberingDate.localeCompare(a.numberingDate)), weeks: [], shops: [...shops].sort(([left], [right]) => left - right).map(([sid, name]) => ({ sid, name })),
      countries: unique(projected.flatMap(({ row }) => row.countries)), channels: unique(projected.flatMap(({ row }) => row.channels)) } };
}

export async function getPhysicalWorkspace(actorId: string, query: PhysicalWorkspaceQuery): Promise<PhysicalWorkspace> {
  const groups = await db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const rows = await tx.select({ group: subBatches, batch: weeklyBatches }).from(subBatches).innerJoin(weeklyBatches, eq(subBatches.batchId, weeklyBatches.id))
      .where(and(ne(subBatches.status, 'superseded'), eq(subBatches.lifecycle, 'active'), eq(subBatches.lifecyclePending, false))).orderBy(desc(weeklyBatches.weekStartDate), asc(subBatches.position), asc(subBatches.id));
    const ids = rows.map(({ group }) => group.id);
    const memberships = ids.length ? await tx.select({ groupId: subBatchMembers.groupId, demandId: subBatchMembers.demandId, active: subBatchMembers.active }).from(subBatchMembers).where(inArray(subBatchMembers.groupId, ids)) : [];
    const demandIds = memberships.filter((member) => member.active).map((member) => member.demandId);
    const current = demandIds.length ? await tx.select().from(demands).where(inArray(demands.id, demandIds)) : [];
    const confirmations = ids.length ? await tx.select().from(groupConfirmations).where(inArray(groupConfirmations.groupId, ids)) : [];
    const occurrences = await tx.select({ id: shippingRuns.id, month: shippingRuns.month, sequence: shippingRuns.sequence, numberingDate: shippingRuns.numberingDate }).from(shippingRuns).where(eq(shippingRuns.lifecycle, 'active'));
    const ticketMembers = ids.length ? await tx.select({ groupId: shippingTicketMembers.groupId, runId: shippingTicketMembers.runId }).from(shippingTicketMembers).where(and(inArray(shippingTicketMembers.groupId, ids), isNull(shippingTicketMembers.releasedAt))) : [];
    return rows.map(({ group, batch }) => {
      const confirmation = confirmations.find((candidate) => candidate.groupId === group.id && candidate.groupVersion === group.confirmedVersion);
      const members = group.frozenAt && confirmation ? confirmation.snapshot.members : memberships.filter((member) => member.active && member.groupId === group.id).flatMap((member) => {
        const demand = current.find((candidate) => candidate.id === member.demandId); return demand ? [serializeDemand(demand)] : [];
      });
      const runIds = new Set([...(batch.shippingRunId ? [batch.shippingRunId] : []), ...ticketMembers.filter((member) => member.groupId === group.id).map((member) => member.runId)]);
      return { shippingRuns: occurrences.filter((run) => runIds.has(run.id)), batch: { id: batch.id, weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate }, group: { id: group.id, name: group.name, status: group.status as PhysicalWorkspaceRow['group']['status'] }, members };
    });
  }, { isolationLevel: 'repeatable read' });
  const entries: PhysicalWorkspaceEntry[] = [];
  for (const group of groups) entries.push({ ...group, review: await getPhysicalReview(group.group.id, actorId) });
  return projectPhysicalWorkspace(entries, query);
}
