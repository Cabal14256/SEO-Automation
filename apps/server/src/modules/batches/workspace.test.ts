import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { batchWorkspaceQuerySchema, batchWorkspaceSchema, type DemandRecord, type SubBatchRecord, type WeeklyBatch } from '@scm/contracts';
import { projectBatchWorkspace, type BatchWorkspaceInput, type WorkspaceConfirmation } from './workspace-projection.js';

const at = '2026-10-18T00:00:00.000Z';
const query = (input: Record<string, unknown> = {}) => batchWorkspaceQuerySchema.parse(input);
function demand(overrides: Partial<DemandRecord> = {}): DemandRecord {
  return { id: randomUUID(), version: 1, businessDate: '2026-09-05', weekStartDate: '2026-08-31', weekEndDate: '2026-09-06', createdAt: at, updatedAt: at,
    snapshot: { sid: 11, shop: '美国店', country: '美国', channel: 'HY', fba: 'FBA111', destinationFc: null, referenceQuantity: null, notes: null, subBatchName: null }, ...overrides };
}
function fixture() {
  const member = demand();
  const batch: WeeklyBatch = { id: randomUUID(), weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate, version: 3, sortMode: 'fba', nextPrefix: 0, createdAt: at };
  const group: SubBatchRecord = { id: randomUUID(), batchId: batch.id, name: '九月美国批次', version: 2, status: 'confirmed', position: 0, demandIds: [member.id], prefix: null,
    confirmedVersion: 2, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: at, updatedAt: at };
  const revision = { id: randomUUID(), demandId: member.id, demandVersion: 1, version: 1 };
  const confirmation: WorkspaceConfirmation = { id: randomUUID(), groupId: group.id, groupVersion: 2, createdAt: at, members: [structuredClone(member)], shipments: [{ demandId: member.id, revisionId: revision.id }] };
  const input: BatchWorkspaceInput = { batches: [batch], groups: [group], demands: [member], shipments: [revision], confirmations: [confirmation], syncRuns: [] };
  const run = { id: randomUUID(), month: '2026-09', sequence: 1, numberingDate: '2026-09-05' };
  batch.shippingRunId = run.id; input.shippingRuns = [run]; input.shippingMemberships = [{ groupId: group.id, demandId: member.id, runId: run.id }];
  return { input, member, batch, group, revision, confirmation };
}
const project = (input: BatchWorkspaceInput, filters: Record<string, unknown> = {}) => batchWorkspaceSchema.parse(projectBatchWorkspace(input, query(filters)));

describe('batch workspace metadata projection', () => {
  it('shows all explicit occurrence references of a shared historical group without using its original week', () => {
    const f = fixture(); f.batch.shippingRunId = null;
    const second = { id: randomUUID(), month: '2026-11', sequence: 2, numberingDate: '2026-11-04' };
    f.input.shippingRuns!.push(second); f.input.shippingMemberships!.push({ groupId: f.group.id, demandId: randomUUID(), runId: second.id });
    const result = project(f.input, { month: '2026-11', shippingRunId: second.id });
    expect(result.rows[0]!.shippingRuns.map((run) => run.id)).toEqual([f.input.shippingRuns![0]!.id, second.id]);
    expect(project(f.input, { month: '2026-08' }).total).toBe(0);
    expect(project(f.input).filters.weeks).toEqual([]);
  });

  it('lists every effective group once and excludes a superseded correction predecessor', () => {
    const f = fixture();
    f.input.groups.push({ ...f.group, id: randomUUID(), name: '旧批次', status: 'superseded', replacedById: f.group.id });
    const result = project(f.input);
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(result.rows[0]).toMatchObject({ rowKind: 'group', id: f.group.id, memberCount: 1, status: 'confirmed', confirmation: { current: true }, sync: { syncedMemberCount: 1, staleMemberCount: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/"(items|boxes|snapshot|products)":/);
  });

  it('keeps an occurrence container placeholder without inferring demand ownership', () => {
    const f = fixture(); f.group.status = 'superseded';
    const result = project(f.input);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: f.batch.id, rowKind: 'batch', group: null, status: 'empty', memberCount: 0, fbas: [], confirmation: null });
    expect(result.availableWeeks).toEqual([]);
    expect(project(f.input, { status: 'empty', month: '2026-09' }).total).toBe(1);
  });

  it('does not create a placeholder merely because all real groups are filtered out', () => {
    const f = fixture();
    expect(project(f.input, { status: 'draft' }).rows).toEqual([]);
    expect(project(f.input, { status: 'empty' }).rows).toEqual([]);
  });

  it('does not offer import weeks as shipment occurrences', () => {
    const f = fixture();
    const other = demand({ businessDate: '2026-10-02', weekStartDate: '2026-09-28', weekEndDate: '2026-10-04' });
    f.input.demands.push(other, { ...other, id: randomUUID(), snapshot: { ...other.snapshot, fba: 'FBA999' } });
    const result = project(f.input, { status: 'frozen', month: '2026-10', q: 'fba111' });
    expect(result.rows).toEqual([]);
    expect(result.availableWeeks).toEqual([]);
    expect(project(f.input, { sid: 99 }).availableWeeks).toEqual([]);
  });

  it('applies all member predicates to the same shipment and finds names or FBAs case-insensitively', () => {
    const f = fixture();
    const second = demand({ snapshot: { ...f.member.snapshot, sid: 22, shop: '英国店', country: '英国', channel: 'KP', fba: 'FBA222' } });
    f.input.demands.push(second); f.group.demandIds.push(second.id);
    expect(project(f.input, { month: '2026-09', sid: 11, country: '美国', channel: 'HY', q: 'fba111' }).total).toBe(1);
    expect(project(f.input, { sid: 11, country: '英国' }).total).toBe(0);
    expect(project(f.input, { sid: 11, q: 'fba222' }).total).toBe(0);
    expect(project(f.input, { q: '九月美国' }).total).toBe(1);
    expect(project(f.input, { month: '2026-08' }).total).toBe(0);
  });

  it('keeps complete filter choices and totals while paginating matching rows', () => {
    const f = fixture(); f.input.confirmations = [];
    f.input.groups = Array.from({ length: 52 }, (_, index) => ({ ...f.group, id: randomUUID(), name: `批次${index}`, status: 'draft', confirmedVersion: null, position: index }));
    f.batch.sortMode = 'manual';
    const first = project(f.input, { page: 1 }), second = project(f.input, { page: 2 }), last = project(f.input, { pageSize: 50, page: 2 });
    expect(first.rows).toHaveLength(20); expect(second.rows).toHaveLength(20); expect(last.rows).toHaveLength(2);
    expect(first.total).toBe(52); expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(40);
    expect(project(f.input, { q: '无结果' }).filters).toEqual(first.filters);
    expect(first.filters.shops).toEqual([{ sid: 11, name: '美国店' }]);
  });

  it('filters the numbered shipment month instead of historical import-week metadata', () => {
    const f = fixture();
    f.batch.weekStartDate = '2026-12-28'; f.batch.weekEndDate = '2027-01-03';
    expect(project(f.input, { weekFrom: '2026-12-31', weekTo: '2027-01-01' }).total).toBe(1);
    expect(project(f.input, { weekFrom: '2027-01-04' }).total).toBe(1);
    f.input.shippingRuns![0]!.month = '2027-01'; f.input.shippingRuns![0]!.numberingDate = '2027-01-02';
    expect(project(f.input, { month: '2027-01' }).total).toBe(1);
    expect(project(f.input, { month: '2026-12' }).total).toBe(0);
    expect(batchWorkspaceQuerySchema.safeParse({ weekFrom: '2027-01-01', weekTo: '2026-12-31' }).success).toBe(false);
    expect(batchWorkspaceQuerySchema.safeParse({ weekFrom: '2026-02-30' }).success).toBe(false);
    expect(batchWorkspaceQuerySchema.safeParse({ pageSize: 21 }).success).toBe(false);
  });

  it('shows stale confirmation and stale shipment counts after a demand or candidate revision changes', () => {
    const f = fixture();
    f.member.version = 2;
    expect(project(f.input).rows[0]).toMatchObject({ confirmation: { current: false }, sync: { syncedMemberCount: 0, staleMemberCount: 1 } });
    f.member.version = 1; f.input.shipments.push({ ...f.revision, id: randomUUID(), version: 2 });
    expect(project(f.input).rows[0]).toMatchObject({ confirmation: { current: false }, sync: { syncedMemberCount: 1, staleMemberCount: 0 } });
    f.group.demandIds = [];
    expect(project(f.input).rows[0]!.confirmation?.current).toBe(false);
  });

  it('keeps frozen snapshot metadata and counts after live demand/candidate changes', () => {
    const f = fixture(); f.group.status = 'frozen'; f.group.frozenAt = at;
    f.member.version = 2; f.member.businessDate = '2026-10-02'; f.member.snapshot = { ...f.member.snapshot, sid: 22, shop: '更名店', country: '英国', channel: 'KP' };
    f.input.shipments = [];
    expect(project(f.input, { sid: 11, month: '2026-09', country: '美国' }).rows[0]).toMatchObject({ sids: [11], shops: ['美国店'], status: 'frozen', confirmation: { current: true }, sync: { syncedMemberCount: 1, staleMemberCount: 0 } });
    expect(project(f.input, { sid: 22 }).total).toBe(0);
  });

  it('shows only the latest sync attempt and retains its group version for stale-run display', () => {
    const f = fixture();
    const run = { id: randomUUID(), subBatchId: f.group.id, groupVersion: 1, status: 'failed' as const, createdAt: '2026-10-17T00:00:00.000Z', completedAt: at };
    const latest = { ...run, id: randomUUID(), status: 'running' as const, createdAt: at, completedAt: null };
    f.input.syncRuns = [latest, run];
    expect(project(f.input).rows[0]!.sync.latestRun).toMatchObject({ id: latest.id, groupVersion: 1, status: 'running' });
  });
});
