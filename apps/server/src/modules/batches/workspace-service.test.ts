import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { batchWorkspaceQuerySchema, batchWorkspaceSchema } from '@scm/contracts';
const state = vi.hoisted(() => ({ records: new Map<unknown, unknown[]>(), selects: [] as Array<Record<string, unknown> | undefined>, transactions: vi.fn(), requireActor: vi.fn(), tx: {} as Record<string, unknown> }));
vi.mock('../../db/client.js', () => {
  const select = (fields?: Record<string, unknown>) => {
    state.selects.push(fields);
    return { from: (table: unknown) => {
      const builder = { where: () => builder, orderBy: () => builder, innerJoin: () => builder,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(state.records.get(table) ?? []).then(resolve) };
      return builder;
    } };
  };
  state.tx = { select, selectDistinctOn: (_columns: unknown, fields: Record<string, unknown>) => select(fields) };
  state.transactions.mockImplementation(async (work: (tx: unknown) => unknown) => work(state.tx));
  return { db: { transaction: state.transactions } };
});
vi.mock('./service.js', () => ({ requireBatchActor: state.requireActor,
  serializeDemand: (row: Record<string, unknown> & { createdAt: Date; updatedAt: Date }) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }),
}));
import { demands } from '../../db/schema.js';
import { batchSyncRuns } from '../lingxing/sync-schema.js';
import { groupConfirmations, shipmentRevisions, subBatchMembers, subBatches, weeklyBatches } from './schema.js';
import { getBatchWorkspace } from './workspace.js';

beforeEach(() => { state.records.clear(); state.selects = []; state.transactions.mockClear(); state.requireActor.mockReset().mockResolvedValue({ id: 'technical-admin' }); });
describe('batch workspace service reads', () => {
  it('checks authorization inside one repeatable-read transaction even for an empty workspace', async () => {
    const result = await getBatchWorkspace('technical-admin', batchWorkspaceQuerySchema.parse({}));
    expect(batchWorkspaceSchema.parse(result)).toMatchObject({ rows: [], total: 0, availableWeeks: [] });
    expect(state.transactions).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { isolationLevel: 'repeatable read' });
    expect(state.requireActor).toHaveBeenCalledWith(state.tx, 'technical-admin');
  });
  it('loads only revision identities and small confirmation metadata to summarize sync/confirmation', async () => {
    const batchId = randomUUID(), groupId = randomUUID(), demandId = randomUUID(), revisionId = randomUUID(), at = new Date('2026-10-18T00:00:00Z');
    const member = { id: demandId, sid: 11, fba: 'FBA111', snapshot: { sid: 11, shop: '测试店', country: '美国', channel: 'HY', fba: 'FBA111', destinationFc: null, referenceQuantity: null, notes: null, subBatchName: null }, version: 1,
      businessDate: '2026-09-05', weekStartDate: '2026-08-31', weekEndDate: '2026-09-06', createdAt: at, updatedAt: at };
    state.records.set(demands, [member]);
    state.records.set(weeklyBatches, [{ id: batchId, weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate, version: 2, sortMode: 'fba', nextPrefix: 0, createdAt: at }]);
    state.records.set(subBatches, [{ id: groupId, batchId, name: '测试组', version: 2, status: 'confirmed', position: 0, prefix: null, confirmedVersion: 2, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: at, updatedAt: at }]);
    state.records.set(subBatchMembers, [{ groupId, demandId }]);
    state.records.set(shipmentRevisions, [{ id: revisionId, demandId, version: 1, demandVersion: 1 }]);
    state.records.set(groupConfirmations, [{ id: randomUUID(), groupId, groupVersion: 2, createdAt: at,
      members: [{ ...member, createdAt: at.toISOString(), updatedAt: at.toISOString() }], shipments: [{ demandId, revisionId }] }]);
    state.records.set(batchSyncRuns, [{ id: randomUUID(), subBatchId: groupId, groupVersion: 1, status: 'completed', createdAt: at, completedAt: at }]);
    const result = batchWorkspaceSchema.parse(await getBatchWorkspace('technical-admin', batchWorkspaceQuerySchema.parse({})));
    expect(result.rows[0]).toMatchObject({ memberCount: 1, status: 'confirmed', confirmation: { current: true }, sync: { syncedMemberCount: 1, latestRun: { groupVersion: 1, status: 'completed' } } });
    const identities = state.selects.find((fields) => fields && 'demandVersion' in fields);
    expect(Object.keys(identities!)).toEqual(['id', 'demandId', 'version', 'demandVersion']);
    const confirmation = state.selects.find((fields) => fields && 'shipments' in fields);
    expect(Object.keys(confirmation!)).toEqual(['id', 'groupId', 'groupVersion', 'createdAt', 'members', 'shipments']);
    expect(JSON.stringify(result)).not.toMatch(/"(snapshot|products|boxes|items|requestHash)":/);
  });
  it('stops before any data read when transactional authorization is revoked', async () => {
    state.requireActor.mockRejectedValue(new Error('forbidden'));
    await expect(getBatchWorkspace('technical-admin', batchWorkspaceQuerySchema.parse({}))).rejects.toThrow('forbidden');
    expect(state.selects).toEqual([]);
  });
});
