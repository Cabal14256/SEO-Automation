import type { AllocationCode, BatchIssue, DemandRecord, DemandWorkspace, DemandWorkspaceQuery, DemandWorkspaceRow, GroupConfirmation, ShipmentRevision, SubBatchRecord, WeeklyBatch } from '@scm/contracts';
import { shipmentIssuesForDisplay } from '@scm/contracts';
import { productKey, validateShipmentData } from '../batches/validation.js';
import { reportRegion } from '../batches/workbook.js';

export type WorkspaceMember = { demandId: string; groupId: string; batchId: string; demandVersion: number };
export type WorkspaceDecision = { groupId: string; demandId: string; shipmentVersion: number; issueCode: string };
export type WorkspaceSource = DemandWorkspaceRow['sources'][number] & { demandId: string; acceptedVersion: number; sourceFilledAt?: string | null };
export type WorkspaceGroup = Pick<SubBatchRecord, 'id' | 'batchId' | 'name' | 'version' | 'status' | 'confirmedVersion' | 'frozenAt' | 'actualShipDate' | 'updatedAt'>;
export type DemandWorkspaceInput = {
  shippingMemberships?: Array<{ demandId: string; groupId: string | null; runId: string; month: string; sequence: number | null; numberingDate: string; ticketNumber: string | null }>;
  cancelledDemandIds?: string[];
  demands: DemandRecord[]; members: WorkspaceMember[]; groups: WorkspaceGroup[]; shipments: ShipmentRevision[];
  confirmations: GroupConfirmation[]; codes: AllocationCode[]; decisions: WorkspaceDecision[]; batches: WeeklyBatch[]; sources: WorkspaceSource[];
};

const quantity = (value: string | null | undefined): number | null => value !== null && value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const nullableString = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const measure = (value: string | null | undefined): number | null => value === null || value === undefined || !value.trim() || !Number.isFinite(Number(value)) ? null : Number(value);
const sumQuantity = (left: number | null, right: number | null): number | null => left !== null && right !== null && Number.isSafeInteger(left + right) ? left + right : null;
function frozenShipmentIssues(accepted: ShipmentRevision, latest: ShipmentRevision | undefined): BatchIssue[] {
  if (!latest || latest.source !== 'lingxing' || latest.version < accepted.version || latest.data.sid !== accepted.data.sid || latest.data.fba !== accepted.data.fba) return shipmentIssuesForDisplay(accepted.data);
  const received = new Map<string, typeof latest.data.items>();
  for (const item of latest.data.items) {
    if (![item.msku, item.fnsku, item.sku].every((value) => value.trim())) continue;
    const key = productKey(item);
    received.set(key, [...received.get(key) ?? [], item]);
  }
  // Receiving progresses after preparation is frozen. Overlay only the live
  // receipt facts for this notice; accepted quantities and source IDs stay fixed.
  return shipmentIssuesForDisplay({ ...accepted.data, shipmentStatus: latest.data.shipmentStatus,
    items: accepted.data.items.map((item) => {
      const matches = [item.msku, item.fnsku, item.sku].every((value) => value.trim()) ? received.get(productKey(item)) : undefined;
      return { ...item, receivedQuantity: matches?.length === 1 ? matches[0]!.receivedQuantity ?? null : null };
    }),
  });
}
function daysBetween(end: string | null, start: string | null): number | null {
  if (!end || !start) return null;
  const date = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return NaN;
    const day = value.slice(0, 10); const parsed = Date.parse(`${day}T00:00:00.000Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day ? parsed : NaN;
  };
  const result = (date(end) - date(start)) / 86_400_000;
  return Number.isInteger(result) ? result : null;
}

/** Browsing uses candidates and placeholders too; report/code allocation gates do not apply. */
export function projectDemandWorkspace(input: DemandWorkspaceInput, query: DemandWorkspaceQuery, generatedAt = new Date().toISOString()): DemandWorkspace {
  const cancelledIds = new Set(input.cancelledDemandIds);
  const visibleDemands = input.demands.filter((demand) => query.lifecycle === 'all' || (cancelledIds.has(demand.id) ? query.lifecycle === 'cancelled' : query.lifecycle !== 'cancelled'));
  const demands = new Map(visibleDemands.map((demand) => [demand.id, demand]));
  const groups = new Map(input.groups.filter((group) => group.status !== 'superseded').map((group) => [group.id, group]));
  const shippingMemberships = new Map((input.shippingMemberships ?? []).map((member) => [member.demandId, member]));
  const latest = new Map<string, ShipmentRevision>();
  for (const revision of input.shipments) {
    const previous = latest.get(revision.demandId);
    if (!previous || revision.version > previous.version || revision.version === previous.version && compare(revision.id, previous.id) > 0) latest.set(revision.demandId, revision);
  }
  const memberships = input.members.filter((member) => groups.has(member.groupId));
  const membersByDemand = new Map<string, WorkspaceMember[]>(); const membersByGroup = new Map<string, WorkspaceMember[]>();
  for (const member of memberships) {
    membersByDemand.set(member.demandId, [...membersByDemand.get(member.demandId) ?? [], member]);
    membersByGroup.set(member.groupId, [...membersByGroup.get(member.groupId) ?? [], member]);
  }
  const sourcesByDemand = new Map<string, WorkspaceSource[]>();
  for (const source of input.sources) sourcesByDemand.set(source.demandId, [...sourcesByDemand.get(source.demandId) ?? [], source]);
  const decisions = new Set(input.decisions.map((decision) => JSON.stringify([decision.groupId, decision.demandId, decision.shipmentVersion, decision.issueCode])));
  const codes = new Map(input.codes.filter((code) => code.valid).map((code) => [JSON.stringify([code.groupId, code.demandId, code.boxId]), code]));
  const activeGroup = (demand: DemandRecord) => [...membersByDemand.get(demand.id) ?? []]
    .sort((left, right) => {
      const correctGroup = (member: WorkspaceMember) => Number(shippingMemberships.get(demand.id)?.groupId === member.groupId);
      return correctGroup(right) - correctGroup(left) || compare(groups.get(right.groupId)!.updatedAt, groups.get(left.groupId)!.updatedAt) || compare(left.groupId, right.groupId);
    })[0];
  function candidateIssues(demand: DemandRecord, revision: ShipmentRevision | undefined, groupId: string | undefined): BatchIssue[] {
    if (!revision) return [{ code: 'SHIPMENT_NOT_SYNCED', severity: 'warning', message: '货件尚未同步或补录。', demandId: demand.id }];
    const issues: BatchIssue[] = validateShipmentData(revision.data).map((issue) => {
      const resolved = issue.code === 'LIST_QUANTITY_MISMATCH' && decisions.has(JSON.stringify([groupId, demand.id, revision.version, issue.code]));
      return { ...issue, demandId: demand.id, ...(resolved ? { severity: 'warning' as const, message: `已人工决定：${issue.message}` } : {}) };
    });
    if (revision.demandVersion !== demand.version) issues.push({ code: 'DEMAND_VERSION_STALE', severity: 'error', message: '候选数据属于旧需求版本，请重新同步或补录。', demandId: demand.id });
    if (revision.data.sid !== demand.snapshot.sid || revision.data.fba !== demand.snapshot.fba) issues.push({ code: 'SHIPMENT_IDENTITY_MISMATCH', severity: 'error', message: '候选数据的店铺或 FBA 与需求不一致。', demandId: demand.id });
    for (const item of revision.data.items) if (quantity(item.quantity) === null) issues.push({ code: 'WORKSPACE_QUANTITY_UNAVAILABLE', severity: 'warning', message: '商品数量缺失或无效，列表保留为空。', demandId: demand.id, details: { key: productKey(item), value: item.quantity } });
    return issues;
  }
  const confirmationValidity = new Map<string, { confirmation: GroupConfirmation | undefined; valid: boolean; frozen: boolean }>();
  for (const group of groups.values()) {
    const confirmation = input.confirmations.find((entry) => entry.groupId === group.id && entry.groupVersion === group.confirmedVersion);
    const frozen = group.frozenAt !== null;
    let valid = Boolean(confirmation && ['confirmed', 'frozen'].includes(group.status));
    if (valid && !frozen && confirmation) {
      const current = (membersByGroup.get(group.id) ?? []).map((member) => demands.get(member.demandId)).filter((demand) => demand !== undefined);
      valid = current.length > 0 && current.length === confirmation.snapshot.members.length && current.length === confirmation.snapshot.shipments.length;
      for (const demand of current) {
        const old = confirmation.snapshot.members.find((member) => member.id === demand.id);
        const accepted = confirmation.snapshot.shipments.find((shipment) => shipment.demandId === demand.id)?.revision;
        const revision = latest.get(demand.id);
        if (!old || old.version !== demand.version || !revision || accepted?.id !== revision.id || candidateIssues(demand, revision, group.id).some((issue) => issue.severity === 'error')) valid = false;
      }
      const first = current[0];
      if (first && current.some((demand) => demand.snapshot.sid !== first.snapshot.sid || demand.snapshot.country !== first.snapshot.country || demand.snapshot.channel !== first.snapshot.channel)) valid = false;
    }
    confirmationValidity.set(group.id, { confirmation, valid, frozen });
  }
  const confirmedTotals = new Map<string, Map<string, { groupQuantity: number | null; monthQuantity: number | null }>>();
  for (const [groupId, state] of confirmationValidity) {
    if (!state.valid || !state.confirmation) continue;
    const totals = new Map<string, { groupQuantity: number | null; monthQuantity: number | null }>();
    let complete = true;
    for (const shipment of state.confirmation.snapshot.shipments) {
      const member = state.confirmation.snapshot.members.find((entry) => entry.id === shipment.demandId);
      if (!member) { complete = false; break; }
      for (const item of shipment.revision.data.items) {
        const key = `${member.snapshot.sid}:${productKey(item)}`;
        const total = totals.get(key) ?? { groupQuantity: 0, monthQuantity: 0 };
        const value = quantity(item.quantity);
        total.groupQuantity = sumQuantity(total.groupQuantity, value);
        const occurrence = shippingMemberships.get(member.id);
        if ((!query.month || occurrence?.month === query.month) && (!query.shippingRunId || occurrence?.runId === query.shippingRunId)) total.monthQuantity = sumQuantity(total.monthQuantity, value);
        totals.set(key, total);
      }
    }
    if (complete) confirmedTotals.set(groupId, totals);
  }
  const monthlyTotals = new Map<string, number | null>();
  for (const totals of confirmedTotals.values()) for (const [key, total] of totals) monthlyTotals.set(key, sumQuantity(monthlyTotals.has(key) ? monthlyTotals.get(key)! : 0, total.monthQuantity));
  const rows: DemandWorkspaceRow[] = [];
  for (const current of visibleDemands) {
    const cancelled = cancelledIds.has(current.id);
    const membership = cancelled ? undefined : activeGroup(current);
    const group = membership ? groups.get(membership.groupId) : undefined;
    const state = group ? confirmationValidity.get(group.id) : undefined;
    const acceptedDemand = state?.valid ? state.confirmation?.snapshot.members.find((member) => member.id === current.id) : undefined;
    const acceptedRevision = state?.valid ? state.confirmation?.snapshot.shipments.find((shipment) => shipment.demandId === current.id)?.revision : undefined;
    const accepted = Boolean(acceptedDemand && acceptedRevision);
    const demand = acceptedDemand && accepted ? acceptedDemand : current;
    const revision = cancelled ? undefined : acceptedRevision && accepted ? acceptedRevision : latest.get(current.id);
    const issues = cancelled ? [] : accepted && state?.frozen ? frozenShipmentIssues(revision!, latest.get(current.id)) : candidateIssues(current, revision, group?.id);
    if (state?.confirmation && !accepted) issues.push({ code: 'CONFIRMATION_STALE', severity: 'error', message: '原确认已失效，当前列表展示最新候选数据，请重新核对。', demandId: current.id });
    const status: DemandWorkspaceRow['status'] = accepted ? state!.frozen ? 'frozen' : 'confirmed' : issues.some((issue) => issue.severity === 'error') ? 'needs_review' : revision ? 'candidate' : 'unsynced';
    const snapshot = demand.snapshot;
    const occurrence = shippingMemberships.get(current.id);
    const sortedBoxes = revision ? [...revision.data.boxes].sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || compare(left.id, right.id)) : [];
    const eligibleSources = (sourcesByDemand.get(current.id) ?? []).filter((source) => source.acceptedVersion <= demand.version);
    const sourceFilledAt = nullableString(snapshot.sourceFilledAt) ?? nullableString(eligibleSources.find((source) => nullableString(source.sourceFilledAt))?.sourceFilledAt);
    const actualShipDate = group?.actualShipDate ?? null;
    const sources = [...eligibleSources]
      .sort((left, right) => compare(left.importId, right.importId) || compare(left.sheetName, right.sheetName) || left.rowNumber - right.rowNumber)
      .map(({ importId, fileName, sheetName, rowNumber }) => ({ importId, fileName, sheetName, rowNumber }));
    const base = {
      lifecycle: cancelled ? 'cancelled' as const : 'active' as const,
      demandId: current.id, demandVersion: demand.version, currentDemandVersion: current.version,
      businessDate: demand.businessDate, weekStartDate: demand.weekStartDate, weekEndDate: demand.weekEndDate,
      shippingRunId: occurrence?.runId ?? null, shippingMonth: occurrence?.month ?? null, shippingSequence: occurrence?.sequence ?? null, ticketNumber: occurrence?.ticketNumber ?? null,
      sid: snapshot.sid, shop: snapshot.shop, country: snapshot.country, channel: snapshot.channel,
      destinationFc: snapshot.destinationFc, destinationAddress: nullableString(snapshot.destinationAddress), fba: snapshot.fba,
      referenceQuantity: snapshot.referenceQuantity, totalBoxes: revision ? sortedBoxes.length : null, status,
      groupId: group?.id ?? null, groupName: group?.name ?? snapshot.subBatchName, groupVersion: group?.version ?? null,
      batchId: group?.batchId ?? null,
      confirmationId: accepted ? state!.confirmation!.id : null, dataRevisionId: revision?.id ?? null, dataVersion: revision?.version ?? null,
      actualShipDate, shipmentCreatedAt: nullableString(snapshot.shipmentCreatedAt), sourceFilledAt,
      packingDays: daysBetween(actualShipDate, sourceFilledAt), metadataSource: nullableString(snapshot.metadataSource), metadataObservedAt: nullableString(snapshot.metadataObservedAt),
      notes: snapshot.notes, issues, sources,
    };
    if (!revision?.data.items.length) {
      rows.push({ ...base, id: `${current.id}:placeholder`, rowKind: 'placeholder', msku: null, fnsku: null, sku: null, productName: null, quantity: null, groupQuantity: null, monthQuantity: null, boxes: [], codes: [] });
      continue;
    }
    for (const [index, item] of revision.data.items.entries()) {
      const boxes = sortedBoxes.flatMap((box, boxIndex) => {
        const items = box.items.filter((entry) => productKey(entry) === productKey(item));
        if (!items.length) return [];
        const values = items.map((entry) => quantity(entry.quantity));
        const total = values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
        const allocation = codes.get(JSON.stringify([group?.id, current.id, box.id]));
        const code = allocation?.code ?? null;
        return [{ boxId: box.id, boxOrder: boxIndex + 1, ...(allocation ? { displayBoxOrder: allocation.sequence } : {}), quantity: total !== null && Number.isSafeInteger(total) ? total : null, code,
          sourceLabel: box.name ?? box.externalBoxId ?? box.localBoxId ?? box.id, orderConfirmed: box.order !== null,
          boxName: box.name, externalBoxId: box.externalBoxId, localBoxId: box.localBoxId,
          weight: measure(box.weight), weightUnit: box.weightUnit ?? null, length: measure(box.length), width: measure(box.width), height: measure(box.height), lengthUnit: box.dimensionUnit ?? null }];
      });
      const total = accepted && group ? confirmedTotals.get(group.id)?.get(`${snapshot.sid}:${productKey(item)}`) : undefined;
      rows.push({ ...base, id: `${current.id}:${revision.id}:${index}`, rowKind: 'product', msku: item.msku || null, fnsku: item.fnsku || null, sku: item.sku || null, productName: item.name, quantity: quantity(item.quantity),
        groupQuantity: total?.groupQuantity ?? null, monthQuantity: accepted ? monthlyTotals.get(`${snapshot.sid}:${productKey(item)}`) ?? null : null, boxes, codes: boxes.flatMap((box) => box.code ? [box.code] : []) });
    }
  }
  rows.sort((left, right) => compare(right.businessDate, left.businessDate) || compare(left.fba, right.fba) || left.sid - right.sid || compare(left.demandId, right.demandId) || compare(left.id, right.id));
  const q = query.q?.toLocaleLowerCase();
  const filtered = rows.filter((row) => (query.grouping === 'ungrouped' || ((!query.month || row.shippingMonth === query.month) && (!query.shippingRunId || row.shippingRunId === query.shippingRunId))) && (!query.batchId || row.batchId === query.batchId)
    && (!query.groupId || row.groupId === query.groupId)
    && (query.grouping !== 'ungrouped' || row.groupId === null)
    && (!query.sid || row.sid === query.sid) && (!query.country || row.country === query.country) && (!query.channel || row.channel === query.channel)
    && (!query.region || query.region === 'all' || reportRegion(row.country) === query.region)
    && (!query.status || row.status === query.status) && (!q || [row.fba, row.shop, row.country, row.channel, row.destinationFc, row.destinationAddress, row.msku, row.fnsku, row.sku, row.productName, row.groupName, row.notes, ...row.codes].some((value) => value?.toLocaleLowerCase().includes(q))));
  const shops = new Map<number, string>();
  for (const row of rows) if (!shops.has(row.sid) || compare(row.shop, shops.get(row.sid)!) < 0) shops.set(row.sid, row.shop);
  const matchingDemandIds = [...new Set(filtered.map((row) => row.demandId))];
  const matchingDemands = new Set(matchingDemandIds);
  const completeRows = query.pageBy === 'demand' ? rows.filter((row) => matchingDemands.has(row.demandId)) : filtered;
  const pageDemandIds = new Set(matchingDemandIds.slice((query.page - 1) * query.pageSize, query.page * query.pageSize));
  return {
    rows: query.pageBy === 'demand' ? completeRows.filter((row) => pageDemandIds.has(row.demandId)) : filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: completeRows.length,
    demandTotal: matchingDemandIds.length, page: query.page, pageSize: query.pageSize,
    maxBoxes: completeRows.reduce((maximum, row) => row.boxes.reduce((max, box) => Math.max(max, box.displayBoxOrder ?? box.boxOrder), Math.max(maximum, row.totalBoxes ?? 0)), 10),
    filters: {
      shippingRuns: [...new Map((input.shippingMemberships ?? []).map((member) => [member.runId, { id: member.runId, month: member.month, sequence: member.sequence, numberingDate: member.numberingDate }])).values()].sort((left, right) => compare(right.numberingDate, left.numberingDate) || (right.sequence ?? 0) - (left.sequence ?? 0)),
      weeks: [],
      batches: [...input.batches].sort((left, right) => compare(right.weekStartDate, left.weekStartDate) || compare(left.id, right.id)).map(({ id, weekStartDate, weekEndDate }) => ({ id, weekStartDate, weekEndDate })),
      shops: [...shops].map(([sid, name]) => ({ sid, name })).sort((left, right) => compare(left.name, right.name) || left.sid - right.sid),
      countries: [...new Set(rows.map((row) => row.country))].sort(compare), channels: [...new Set(rows.flatMap((row) => row.channel ? [row.channel] : []))].sort(compare),
    }, generatedAt,
  };
}
