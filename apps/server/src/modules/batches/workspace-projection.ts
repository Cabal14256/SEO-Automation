import type { BatchWorkspace, BatchWorkspaceQuery, BatchWorkspaceRow, DemandRecord, SubBatchRecord, WeeklyBatch, ShippingOccurrence } from '@scm/contracts';

export type WorkspaceRevision = { id: string; demandId: string; version: number; demandVersion: number };
export type WorkspaceConfirmation = { id: string; groupId: string; groupVersion: number; createdAt: string; members: DemandRecord[];
  shipments: Array<{ demandId: string; revisionId: string }> };
export type BatchWorkspaceInput = {
  shippingRuns?: ShippingOccurrence[]; shippingMemberships?: Array<{ groupId: string | null; demandId: string | null; runId: string }>;
  batches: WeeklyBatch[]; groups: SubBatchRecord[]; demands: DemandRecord[];
  shipments: WorkspaceRevision[]; confirmations: WorkspaceConfirmation[];
  syncRuns: Array<NonNullable<BatchWorkspaceRow['sync']['latestRun']> & { subBatchId: string }>;
};
const unique = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'zh-CN'));
const memberMatches = (member: DemandRecord, query: BatchWorkspaceQuery) =>
  (query.sid === undefined || member.snapshot.sid === query.sid) &&
  (!query.country || member.snapshot.country === query.country) && (!query.channel || member.snapshot.channel === query.channel);

/** Projects metadata only; neither shipment products/boxes nor report eligibility are needed. */
export function projectBatchWorkspace(input: BatchWorkspaceInput, query: BatchWorkspaceQuery): BatchWorkspace {
  const demands = new Map(input.demands.map((member) => [member.id, member]));
  const latestShipments = new Map<string, WorkspaceRevision>();
  for (const revision of input.shipments) {
    const previous = latestShipments.get(revision.demandId);
    if (!previous || previous.version < revision.version) latestShipments.set(revision.demandId, revision);
  }
  const latestRuns = new Map<string, BatchWorkspaceInput['syncRuns'][number]>();
  for (const run of input.syncRuns) {
    const previous = latestRuns.get(run.subBatchId);
    if (!previous || previous.createdAt < run.createdAt || previous.createdAt === run.createdAt && previous.id < run.id) latestRuns.set(run.subBatchId, run);
  }
  const confirmations = new Map(input.confirmations.map((confirmation) => [`${confirmation.groupId}:${confirmation.groupVersion}`, confirmation]));
  const runs = new Map((input.shippingRuns ?? []).map((run) => [run.id, run]));
  const groupsByBatch = new Map<string, SubBatchRecord[]>();
  for (const group of input.groups) {
    if (group.status === 'superseded') continue;
    const groups = groupsByBatch.get(group.batchId) ?? [];
    groups.push(group); groupsByBatch.set(group.batchId, groups);
  }
  const entries: Array<{ row: BatchWorkspaceRow; members: DemandRecord[] }> = [];
  for (const batch of input.batches) {
    const groups = groupsByBatch.get(batch.id) ?? [];
    const entriesForBatch = groups.length ? groups : batch.shippingRunId ? [null] : [];
    for (const group of entriesForBatch) {
      const runIds = new Set([...(batch.shippingRunId ? [batch.shippingRunId] : []), ...(group ? (input.shippingMemberships ?? []).filter((member) => member.groupId === group.id).map((member) => member.runId) : [])]);
      const occurrences = [...runIds].flatMap((id) => { const run = runs.get(id); return run ? [run] : []; });
      const confirmation = group?.confirmedVersion ? confirmations.get(`${group.id}:${group.confirmedVersion}`) : undefined;
      const currentMembers = group ? group.demandIds.flatMap((id) => { const member = demands.get(id); return member ? [member] : []; }) : [];
      const frozen = Boolean(group?.frozenAt || group?.status === 'frozen');
      const members = frozen && confirmation ? confirmation.members : currentMembers;
      const confirmationCurrent = Boolean(confirmation && group && (frozen || (
        group.version === confirmation.groupVersion && group.demandIds.length === confirmation.members.length &&
        currentMembers.length === group.demandIds.length && currentMembers.every((member) => {
          const accepted = confirmation.members.find((candidate) => candidate.id === member.id);
          const revision = latestShipments.get(member.id);
          return accepted?.version === member.version && revision?.demandVersion === member.version &&
            confirmation.shipments.some((candidate) => candidate.demandId === member.id && candidate.revisionId === revision.id);
        })
      )));
      const latestRun = group ? latestRuns.get(group.id) : undefined;
      entries.push({ members, row: {
        id: group?.id ?? batch.id, rowKind: group ? 'group' : 'batch', batch, group, shippingRuns: occurrences,
        memberCount: members.length, status: group ? group.status as 'draft' | 'confirmed' | 'frozen' : 'empty',
        sids: [...new Set(members.map((member) => member.snapshot.sid))].sort((a, b) => a - b),
        shops: unique(members.map((member) => member.snapshot.shop)), countries: unique(members.map((member) => member.snapshot.country)),
        channels: unique(members.flatMap((member) => member.snapshot.channel ? [member.snapshot.channel] : [])), fbas: unique(members.map((member) => member.snapshot.fba)),
        sync: {
          syncedMemberCount: group ? (frozen && confirmation ? confirmation.shipments.length : currentMembers.filter((member) => latestShipments.get(member.id)?.demandVersion === member.version).length) : 0,
          staleMemberCount: group && !frozen ? currentMembers.filter((member) => { const revision = latestShipments.get(member.id); return revision && revision.demandVersion !== member.version; }).length : 0,
          latestRun: latestRun ? { id: latestRun.id, status: latestRun.status, groupVersion: latestRun.groupVersion, createdAt: latestRun.createdAt, completedAt: latestRun.completedAt } : null,
        },
        confirmation: confirmation ? { id: confirmation.id, groupVersion: confirmation.groupVersion, createdAt: confirmation.createdAt, current: confirmationCurrent } : null,
      } });
    }
  }
  entries.sort((a, b) => (b.row.shippingRuns[0]?.numberingDate ?? b.row.batch.createdAt).localeCompare(a.row.shippingRuns[0]?.numberingDate ?? a.row.batch.createdAt) ||
    (a.row.batch.sortMode === 'manual' ? (a.row.group?.position ?? 0) - (b.row.group?.position ?? 0) : (a.row.fbas[0] ?? '').localeCompare(b.row.fbas[0] ?? '')) || a.row.id.localeCompare(b.row.id));
  const shops = new Map<number, string>();
  for (const { members } of entries) for (const member of members) if (!shops.has(member.snapshot.sid)) shops.set(member.snapshot.sid, member.snapshot.shop);
  const filtered = entries.filter(({ row, members }) => {
    if (query.status && row.status !== query.status) return false;
    if (query.month && !row.shippingRuns.some((run) => run.month === query.month)) return false;
    if (query.shippingRunId && !row.shippingRuns.some((run) => run.id === query.shippingRunId)) return false;
    const hasMemberFilters = Boolean(query.sid !== undefined || query.country || query.channel);
    // All member predicates must match the same shipment; don't combine two shops' attributes.
    if (hasMemberFilters && !members.some((member) => memberMatches(member, query))) return false;
    if (query.q) {
      const q = query.q.toLocaleLowerCase();
      const nameMatches = row.group?.name.toLocaleLowerCase().includes(q);
      if (!nameMatches && !members.some((member) => memberMatches(member, query) && member.snapshot.fba.toLocaleLowerCase().includes(q))) return false;
    }
    return true;
  });
  return {
    rows: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(({ row }) => row),
    total: filtered.length, page: query.page, pageSize: query.pageSize, availableWeeks: [],
    filters: {
      shippingRuns: [...runs.values()].sort((a, b) => b.numberingDate.localeCompare(a.numberingDate) || (b.sequence ?? 0) - (a.sequence ?? 0)), weeks: [],
      shops: [...shops].sort(([a], [b]) => a - b).map(([sid, name]) => ({ sid, name })),
      countries: unique(entries.flatMap(({ row }) => row.countries)), channels: unique(entries.flatMap(({ row }) => row.channels)),
    },
  };
}
