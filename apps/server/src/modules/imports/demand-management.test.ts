import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demandCancelInputSchema, demandDetailSchema, demandRevisionInputSchema } from '@scm/contracts';
import { demands, demandRevisions, operationAudit } from '../../db/schema.js';
import { batchOperations, allocationCodes, subBatchMembers, subBatches, subBatchRevisions, weeklyBatches } from '../batches/schema.js';
import { documentDigest } from '../documents/domain.js';

const state = vi.hoisted(() => ({ transaction: vi.fn(), actor: vi.fn(), groupRevision: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: state.transaction } }));
vi.mock('../batches/service.js', async (original) => ({ ...await original<typeof import('../batches/service.js')>(), requireBatchActor: state.actor, reviseGroupAfterDemandMutationInTx: state.groupRevision }));
import { cancelDemand, getDemandManagement, reviseDemand } from './demand-management.js';

type Read = { table?: unknown; condition?: SQL; lock?: string };
type Write = { table: unknown; values: Record<string, unknown>; condition?: SQL };
let queued: unknown[][], reads: Read[], writes: Write[], inserts: Write[], locks: string[], tx: Record<string, unknown>, updateRows: Map<unknown, unknown[]>;
const dialect = new PgDialect();
function query(rows: unknown[], operation: Read | Write) {
  const result = Object.assign(Promise.resolve(rows), {
    from(table: unknown) { operation.table = table; return result; },
    where(condition: SQL) { operation.condition = condition; return result; },
    for(lock: string) { if ('values' in operation) throw new Error('Unexpected write lock'); operation.lock = lock; return result; },
    innerJoin() { return result; }, orderBy() { return result; }, limit() { return result; }, returning() { return result; },
  });
  return result;
}
function fixture(status = 'confirmed') {
  const at = new Date('2026-10-23T00:00:00Z'), id = randomUUID(), batchId = randomUUID();
  const record = { id, sid: 11, fba: 'FBA12345', version: 2, businessDate: '2026-10-23', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', createdAt: at, updatedAt: at,
    snapshot: { sid: 11, fba: 'FBA12345', shop: '原店铺', country: '美国', channel: 'HY', destinationFc: 'IND9', destinationAddress: '原地址', referenceQuantity: '12', notes: null, subBatchName: null, sourceFilledAt: '2026-10-20' } };
  const group = { id: randomUUID(), batchId, name: '测试批次', version: 5, status, position: 0, prefix: 'A', confirmedVersion: 5, frozenAt: status === 'frozen' ? at : null,
    correctionOfId: null, replacedById: null, actualShipDate: null, createdBy: 'admin', createdAt: at, updatedAt: at };
  return { record, group };
}
function input() { return { operationId: randomUUID(), expectedVersion: 2, reason: ' 核对原始需求后修改 ' }; }
function policyReads(blocker = -1, cancelled = false, grouped = true) {
  queued.push(cancelled ? [{ targetId: 'cancelled', actorUserId: 'admin', createdAt: new Date(), details: { reason: '误导入', version: '3' } }] : []);
  if (cancelled) return;
  for (let index = 0; index < (grouped ? 8 : 4); index++) {
    queued.push(index === blocker ? [{ id: randomUUID() }] : []);
    if (index === blocker) return;
  }
}
function mutationReads(value: ReturnType<typeof fixture>, options: { grouped?: boolean; blocker?: number; cancelled?: boolean; changedMembership?: boolean } = {}) {
  const grouped = options.grouped !== false, groups = grouped ? [{ group: value.group }] : [];
  queued.push([], [value.record], groups);
  if (grouped) queued.push([{ id: value.group.batchId }], [value.group]);
  queued.push([value.record], options.changedMembership ? [{ group: { ...value.group, id: randomUUID() } }] : groups);
  if (options.changedMembership) return;
  if (value.group.status === 'frozen' && grouped) { queued.push([]); return; }
  if (options.cancelled) {
    queued.push([{ targetId: value.record.id, actorUserId: 'admin', createdAt: new Date(), details: { reason: '误导入', version: '3' } }]); return;
  }
  policyReads(options.blocker, false, grouped);
}
beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset();
  queued = []; reads = []; writes = []; inserts = []; locks = []; updateRows = new Map();
  tx = {
    select: () => { if (!queued.length) throw new Error('Unexpected database read'); const read = {}; reads.push(read); return query(queued.shift()!, read); },
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => { const write = { table, values }; writes.push(write); return query(updateRows.get(table) ?? [], write); } }),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => { const insert = { table, values }; inserts.push(insert); return query([], insert); } }),
    execute: async (statement: SQL) => { locks.push(String(dialect.sqlToQuery(statement).params[0])); },
  };
  state.actor.mockResolvedValue({}); state.groupRevision.mockResolvedValue({});
  state.transaction.mockImplementation(async (action) => action(tx));
});

describe('demand CRUD contract', () => {
  it('accepts only editable metadata, requires operation/version/reason, and keeps detail fixtures safely read-only', () => {
    const valid = { ...input(), fields: { notes: '  修订  ', sourceFilledAt: '2026-10-22', referenceQuantity: null } };
    expect(demandRevisionInputSchema.parse(valid)).toMatchObject({ reason: '核对原始需求后修改', fields: { notes: '修订', referenceQuantity: null } });
    for (const fields of [{ sid: 12 }, { fba: 'FBA999' }, { shop: 'Other' }, { country: '英国' }, { businessDate: '2026-10-22' }, { weekStartDate: '2026-10-12' }, {}, { notes: 'x'.repeat(2001) }]) {
      expect(demandRevisionInputSchema.safeParse({ ...input(), fields }).success).toBe(false);
    }
    expect(demandCancelInputSchema.safeParse({ ...input(), reason: '' }).success).toBe(false);
    const value = fixture();
    const detail = demandDetailSchema.parse({ demand: { ...value.record, createdAt: value.record.createdAt.toISOString(), updatedAt: value.record.updatedAt.toISOString() }, revisions: [], sources: [] });
    expect(detail.management).toEqual({ lifecycle: 'active', canEdit: false, canDelete: false, reason: '请重新读取需求操作权限。', groupId: null, batchId: null });
    expect(detail.operations).toEqual([]);
  });
});

describe('audited demand mutations', () => {
  it('edits an unfrozen grouped demand with stable identity, ordered locks and one revision', async () => {
    const value = fixture(), operation = { ...input(), fields: { notes: ' 新备注 ', referenceQuantity: '13', sourceFilledAt: '2026-10-22' } };
    mutationReads(value);
    updateRows.set(demands, [{ ...value.record, version: 3, snapshot: { ...value.record.snapshot, notes: '新备注', referenceQuantity: '13', sourceFilledAt: '2026-10-22' } }]);
    const result = await reviseDemand(value.record.id, 'admin', operation);
    expect(result).toMatchObject({ demand: { id: value.record.id, version: 3, businessDate: value.record.businessDate, weekStartDate: value.record.weekStartDate,
      snapshot: { sid: 11, fba: 'FBA12345', shop: '原店铺', country: '美国', notes: '新备注', referenceQuantity: '13' } }, replayed: false });
    expect(reads.filter((read) => read.lock).map((read) => read.table)).toEqual([weeklyBatches, subBatches, demands]);
    expect(locks).toEqual([`demand-operation:${operation.operationId}`, value.group.batchId, `demand:${JSON.stringify([11, 'FBA12345'])}`, `shipment:${value.record.id}`]);
    expect(state.groupRevision).toHaveBeenCalledExactlyOnceWith(tx, value.group, value.record.id, 3, 'admin', false, '核对原始需求后修改');
    expect(inserts.map((insert) => insert.table)).toEqual([demandRevisions, batchOperations, operationAudit]);
    expect(inserts[2]!.values).toMatchObject({ action: 'demand.revise', targetId: value.record.id, details: { reason: '核对原始需求后修改', version: '3' } });
    expect(queued).toEqual([]);
  });

  it('cancels by appending the unchanged snapshot and a permanent audit marker, retaining the demand row', async () => {
    const value = fixture(), operation = input(); mutationReads(value); updateRows.set(demands, [{ ...value.record, version: 3 }]);
    expect(await cancelDemand(value.record.id, 'admin', operation)).toMatchObject({ demand: { id: value.record.id, version: 3, snapshot: value.record.snapshot }, replayed: false });
    expect(inserts[0]!.values).toMatchObject({ demandId: value.record.id, version: 3, snapshot: value.record.snapshot });
    expect(state.groupRevision).toHaveBeenCalledExactlyOnceWith(tx, value.group, value.record.id, 3, 'admin', true, '核对原始需求后修改');
    expect(inserts[2]!.values).toMatchObject({ action: 'demand.cancel', targetId: value.record.id, details: { reason: '核对原始需求后修改', version: '3' } });
    expect(writes.map((write) => write.table)).toEqual([demands]);
  });

  it('replays an operation without new revisions, audits or group changes', async () => {
    const value = fixture(), operation = demandCancelInputSchema.parse(input()), result = { demand: { id: value.record.id, version: 3 } };
    queued.push([{ actorId: 'admin', requestHash: documentDigest({ action: 'demand.cancel', demandId: value.record.id, input: operation }), result }]);
    expect(await cancelDemand(value.record.id, 'admin', operation)).toEqual({ ...result, replayed: true });
    expect(writes).toEqual([]); expect(inserts).toEqual([]); expect(state.groupRevision).not.toHaveBeenCalled();
  });

  it('rejects a fresh operation against a cancelled demand without another version increment', async () => {
    const value = fixture(); mutationReads(value, { cancelled: true });
    await expect(cancelDemand(value.record.id, 'admin', input())).rejects.toMatchObject({ code: 'DEMAND_CANCELLED', status: 409 });
    expect(writes).toEqual([]); expect(inserts).toEqual([]);
  });

  it('rejects stale versions and concurrent assignment changes before writing anything', async () => {
    const value = fixture(); mutationReads(value, { changedMembership: true });
    await expect(reviseDemand(value.record.id, 'admin', { ...input(), fields: { notes: '修订' } })).rejects.toMatchObject({ code: 'DEMAND_ASSIGNMENT_CONFLICT', status: 409 });
    expect(writes).toEqual([]); expect(inserts).toEqual([]);
    queued = [[], [value.record], [], [value.record]];
    await expect(cancelDemand(value.record.id, 'admin', { ...input(), expectedVersion: 1 })).rejects.toMatchObject({ code: 'DEMAND_VERSION_CONFLICT', status: 409 });
    expect(writes).toEqual([]);
  });

  it('rejects grouped channel changes that would split the group scope', async () => {
    const value = fixture(); mutationReads(value); queued.push([{ snapshot: { channel: 'HY' } }]);
    await expect(reviseDemand(value.record.id, 'admin', { ...input(), fields: { channel: 'SY' } })).rejects.toMatchObject({ code: 'GROUP_SCOPE_MISMATCH', status: 422 });
    expect(writes).toEqual([]); expect(inserts).toEqual([]);
  });

  it('keeps frozen groups read-only and returns an actionable management reason', async () => {
    const value = fixture('frozen'); mutationReads(value);
    await expect(cancelDemand(value.record.id, 'admin', input())).rejects.toMatchObject({ code: 'DEMAND_READ_ONLY', status: 409, message: expect.stringContaining('冻结') });
    expect(writes).toEqual([]); expect(inserts).toEqual([]);
    queued = [[{ id: value.record.id }], [{ group: value.group }], [], []];
    const detail = await getDemandManagement(value.record.id, 'admin');
    expect(detail.management).toMatchObject({ lifecycle: 'active', canEdit: false, canDelete: false, groupId: value.group.id, reason: expect.stringContaining('冻结') });
  });

  it.each(['live M4 claim', 'workflow reference', 'M4 generation', 'workflow generation', 'shipment sync', 'physical sync', 'report export', 'physical export'].map((name, index) => [name, index] as const))('protects %s from destructive edits and cancellation', async (_name, index) => {
    const value = fixture(); mutationReads(value, { blocker: index });
    await expect(cancelDemand(value.record.id, 'admin', input())).rejects.toMatchObject({ code: 'DEMAND_READ_ONLY', status: 409 });
    expect(writes).toEqual([]); expect(inserts).toEqual([]); expect(queued).toEqual([]);
  });

  it('returns cancellation reason and operation history while keeping the cancelled demand readable', async () => {
    const value = fixture(), now = new Date('2026-10-23T05:00:00Z');
    queued.push([{ id: value.record.id }], [], [{ targetId: value.record.id, actorUserId: 'admin', createdAt: now, details: { reason: '误导入', version: '3' } }],
      [{ action: 'demand.cancel', actorUserId: 'admin', createdAt: now, details: { reason: '误导入', version: '3' } }]);
    expect(await getDemandManagement(value.record.id, 'admin')).toEqual({ management: { lifecycle: 'cancelled', canEdit: false, canDelete: false, groupId: null, batchId: null, reason: '需求已取消：误导入' },
      operations: [{ action: 'demand.cancel', reason: '误导入', version: 3, createdBy: 'admin', createdAt: now.toISOString() }] });
  });
});

describe('group invalidation caused by demand changes', () => {
  it.each([false, true])('updates membership/version and retains historical group snapshots (cancelled=%s)', async (cancelled) => {
    const actual = await vi.importActual<typeof import('../batches/service.js')>('../batches/service.js'), value = fixture();
    updateRows.set(subBatches, [{ ...value.group, version: 6, status: 'draft', confirmedVersion: null }]);
    queued.push(cancelled ? [] : [{ demandId: value.record.id }], []);
    await actual.reviseGroupAfterDemandMutationInTx(tx as never, value.group, value.record.id, 3, 'admin', cancelled, '核对后处理');
    expect(writes.map((write) => write.table)).toEqual([subBatchMembers, allocationCodes, subBatches, weeklyBatches]);
    expect(writes[0]!.values).toEqual(cancelled ? { active: false } : { demandVersion: 3 });
    expect(writes[1]!.values).toEqual({ valid: false });
    expect(dialect.sqlToQuery(writes[1]!.condition!).params).toEqual([value.group.id, true, value.record.id]);
    expect(writes[2]!.values).toMatchObject({ version: 6, status: 'draft', confirmedVersion: null });
    expect(inserts[0]).toMatchObject({ table: subBatchRevisions, values: { action: cancelled ? 'demand_cancel' : 'demand_revise', reason: '核对后处理', snapshot: { demandIds: cancelled ? [] : [value.record.id] } } });
  });
});
