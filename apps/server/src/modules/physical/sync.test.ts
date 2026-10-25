import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import type { PhysicalSyncInput } from '@scm/contracts';

const state = vi.hoisted(() => ({ locked: true, order: [] as string[], records: new Map<unknown, Array<Record<string, unknown>>>(),
  updates: [] as Array<Record<string, unknown>>, inserts: [] as Array<{ table: unknown; values: unknown }>, transaction: vi.fn(), release: vi.fn(), query: vi.fn(), db: {} as Record<string, unknown>, lockPhysical: vi.fn() }));
vi.mock('../../db/client.js', () => {
  const select = () => ({ from: (table: unknown) => ({ where: () => {
    const result = { limit: async () => state.records.get(table) ?? [], for: async () => state.records.get(table) ?? [],
      orderBy: () => ({ limit: async () => state.records.get(table) ?? [], then: (resolve: (rows: unknown) => void) => resolve(state.records.get(table) ?? []) }),
      then: (resolve: (rows: unknown) => void) => resolve(state.records.get(table) ?? []) };
    return result;
  } }) });
  const update = (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
    state.updates.push(values);
    for (const record of state.records.get(table) ?? []) if (record.status !== 'completed') Object.assign(record, values);
  } }) });
  const insert = (table: unknown) => ({ values: async (input: Record<string, unknown> | Array<Record<string, unknown>>) => {
    state.inserts.push({ table, values: input });
    const values = (Array.isArray(input) ? input : [input]).map((value) => ({ status: 'queued', requestsUsed: 0, authRequests: 0, cacheHits: 0,
      errorCode: null, errorMessage: null, createdAt: new Date('2026-10-18T01:00:00Z'), completedAt: null, snapshotIds: [], ...value }));
    state.records.set(table, [...state.records.get(table) ?? [], ...values]);
  } });
  state.db = { select, update, insert, execute: vi.fn(), transaction: state.transaction };
  state.query.mockImplementation(async (query: string) => { state.order.push(query.includes('try_advisory') ? 'lock' : 'unlock'); return { rows: [{ locked: state.locked }] }; });
  state.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => { state.order.push('transaction'); return work(state.db); });
  return { db: state.db, pool: { connect: async () => ({ query: state.query, release: state.release }) } };
});
vi.mock('./service.js', () => ({ lockPhysical: state.lockPhysical, assertPhysicalWrite: vi.fn(), publishPhysicalSource: vi.fn(), currentPhysicalSource: vi.fn() }));
vi.mock('../batches/service.js', async (original) => ({ ...await original<typeof import('../batches/service.js')>(), requireBatchActor: vi.fn() }));

import { physicalSyncItems, physicalSyncRuns } from './schema.js';
import { batchOperations } from '../batches/schema.js';
import { decodePhysicalCheckpoint } from './sources.js';
import { buildPhysicalSource, type BuildPhysicalSourceInput } from './domain.js';
import type { PhysicalBundle } from './service.js';
import { normalizeShipment } from '../batches/sync.js';
import { buildPartialPhysicalObservation, executePhysicalSync, reconcilePhysicalSyncRuns, requestPhysicalSync, retryPhysicalSync } from './sync.js';

beforeEach(() => { state.locked = true; state.order = []; state.records.clear(); state.updates = []; state.inserts = []; state.transaction.mockClear(); state.query.mockClear(); state.release.mockClear(); state.lockPhysical.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
const id = '00000000-0000-4000-8000-000000000001';

function observationFixture() {
  const at = '2026-10-18T01:00:00.000Z', groupId = randomUUID(), m2ConfirmationId = randomUUID();
  const input: BuildPhysicalSourceInput = { id: randomUUID(), groupId, m2ConfirmationId, origin: 'history', createdBy: 'actor', createdAt: at, shipments: [], members: [], codes: [], evidence: [] };
  for (const sid of [123, 124]) {
    const demandId = randomUUID(), fba = `FBA${sid}`, internalId = `shipment-${sid}`;
    const product = { msku: 'M', fnsku: 'F', sku: 'S', productName: '商品' };
    const evidence = { demandId, observedAt: at, snapshotIds: [randomUUID()],
      listing: { sid, shipment_id: fba, sta_shipment_id: internalId, reference_id: 'REF', is_sta: 1, item_list: [{ ...product, quantity_shipped: 1 }] },
      details: { code: 0, data: { shipmentList: [{ sid, shipmentConfirmationId: fba, shipmentId: internalId, amazonReferenceId: 'REF', itemList: [{ ...product, quantity: 1 }] }] } },
      packing: { code: 0, data: { shipmentList: [{ shipmentId: internalId, shipmentPackingList: [{ boxId: `box-${sid}`, packageId: `package-${sid}`, localBoxId: 1,
        boxName: 'B1', total: 1, weight: '1', weightUnit: 'KG', length: '2', width: '3', height: '4', lengthUnit: 'CM', productList: [{ ...product, quantityInBox: 1 }] }] }] } } };
    const data = normalizeShipment({ sid, fba, ...evidence });
    input.shipments.push({ demandId, revision: { id: randomUUID(), demandId, version: 1, demandVersion: 1, data, source: 'lingxing', snapshotIds: evidence.snapshotIds, reason: 'fixture', createdBy: 'actor', createdAt: at } });
    input.members.push({ id: demandId, snapshot: { sid, fba, shop: '店铺', country: 'US', channel: null, destinationFc: null, referenceQuantity: null, notes: null, subBatchName: null }, version: 1,
      businessDate: '2026-10-18', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', createdAt: at, updatedAt: at });
    input.codes.push({ id: randomUUID(), groupId, demandId, boxId: data.boxes[0]!.id, prefix: 'A', sequence: sid, code: `A${sid}`, valid: true, createdAt: at });
    input.evidence.push(evidence);
  }
  const bundle = { confirmation: { snapshot: { shipments: input.shipments, members: input.members } }, codes: input.codes } as PhysicalBundle;
  return { input, bundle, run: { id: randomUUID(), groupId, m2ConfirmationId, createdBy: 'actor' } };
}

describe('partial observations cannot be adopted as complete sources', () => {
  it('keeps equal recollection intact and ignores another shipment in the comparison', () => {
    const { input, bundle, run } = observationFixture(), accepted = buildPhysicalSource(input);
    expect(accepted.identityValid).toBe(true);
    expect(buildPartialPhysicalObservation(bundle, run, input.evidence[0]!, accepted)).toBeNull();
    accepted.issues.push({ code: 'OTHER_SHIPMENT_ISSUE', severity: 'error', message: '其他票缺项', demandId: input.evidence[1]!.demandId });
    expect(buildPartialPhysicalObservation(bundle, run, input.evidence[0]!, accepted)).toBeNull();
  });
  it('persists the full group boundary with explicit missing evidence and blocks old source re-adoption', () => {
    const { input, bundle, run } = observationFixture(), accepted = buildPhysicalSource(input), changed = structuredClone(input.evidence[0]!);
    changed.listing.reference_id = 'NEW';
    (changed.details.data as { shipmentList: Record<string, unknown>[] }).shipmentList[0]!.amazonReferenceId = 'NEW';
    const observed = buildPartialPhysicalObservation(bundle, run, changed, accepted)!;
    expect(observed.id).not.toBe(run.id); expect(observed.identityValid).toBe(false); expect(observed.boxes).toHaveLength(2);
    expect(observed.issues.some((issue) => issue.code === 'PHYSICAL_EVIDENCE_MISSING')).toBe(true);
    expect(observed.issues.some((issue) => issue.code === 'PHYSICAL_SYNC_INCOMPLETE')).toBe(true);
  });
  it('records an observed identity conflict even before any source has been adopted', () => {
    const { input, bundle, run } = observationFixture(), changed = structuredClone(input.evidence[0]!);
    changed.listing.sid = 999;
    expect(buildPartialPhysicalObservation(bundle, run, changed, null)?.identityValid).toBe(false);
  });
});

describe('physical checkpoint trust boundary', () => {
  const make = (update: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
    request: { operation: 'listShipments', params: { sid: '123', shipment_id: 'FBA123', offset: 0, length: 100 } },
    metadata: { operation: 'listShipments', readOnly: true, requestedAt: '2026-10-18T01:00:00Z', httpStatus: 200, businessCode: '0' },
    payload: { code: 0, data: { list: [] }, total: 0 }, collectionId: id, ...update,
  }));
  const identity = { sid: 123, fba: 'FBA123', operation: 'listShipments' as const };
  it('keeps original payload, observation time and pagination generation', () => {
    expect(decodePhysicalCheckpoint(make(), identity)).toMatchObject({ observedAt: '2026-10-18T01:00:00.000Z', params: { sid: '123', shipment_id: 'FBA123' }, collectionId: id, payload: { code: 0 } });
  });
  it('rejects another shop or FBA rather than reusing an unrelated successful snapshot', () => {
    expect(() => decodePhysicalCheckpoint(make(), { ...identity, sid: 124 })).toThrow('身份');
    expect(() => decodePhysicalCheckpoint(make(), { ...identity, fba: 'FBA999' })).toThrow('身份');
  });
  it('rejects mismatching operation, business failure, or missing read-only evidence', () => {
    expect(() => decodePhysicalCheckpoint(make(), { ...identity, operation: 'getShipmentBoxes' })).toThrow();
    expect(() => decodePhysicalCheckpoint(make({ payload: { code: 1001 } }), identity)).toThrow();
    expect(() => decodePhysicalCheckpoint(make({ metadata: { operation: 'listShipments', requestedAt: '2026-10-18T01:00:00Z', httpStatus: 200, businessCode: '0' } }), identity)).toThrow();
  });
  it('rejects absent or invalid observation time', () => {
    expect(() => decodePhysicalCheckpoint(make({ metadata: { operation: 'listShipments', readOnly: true, requestedAt: 'bad', httpStatus: 200, businessCode: '0' } }), identity)).toThrow();
  });
});

describe('offline physical collection', () => {
  it('refuses submission and retry before queue or database changes', async () => {
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    const send = vi.fn(), boss = { send } as unknown as PgBoss;
    await expect(requestPhysicalSync(boss, id, {} as PhysicalSyncInput, 'actor')).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    await expect(retryPhysicalSync(boss, id, id, { operationId: id }, 'actor')).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(send).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
  });
  it('fails restored work without creating a network client or consuming budget', async () => {
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    const run = { id, status: 'queued', requestsUsed: 0, authRequests: 0 };
    state.records.set(physicalSyncRuns, [run]); state.records.set(physicalSyncItems, [{ status: 'queued' }]);
    const createClient = vi.fn();
    await expect(executePhysicalSync(id, { createClient })).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(createClient).not.toHaveBeenCalled(); expect(run).toMatchObject({ status: 'failed', requestsUsed: 0, authRequests: 0 });
    expect(state.lockPhysical).not.toHaveBeenCalled(); expect(state.order).toEqual(['lock', 'transaction', 'unlock']);
  });
});

describe('physical sync operation identity', () => {
  const input: PhysicalSyncInput = { operationId: id, m2ConfirmationId: id, expectedVersion: 0, sourceFingerprint: null,
    startDate: '2026-01-01', endDate: '2026-10-19', requestBudget: 100, maxPages: 10 };
  it('rejects an operation id already used by another action before queueing or locking the group', async () => {
    state.records.set(batchOperations, [{ operationId: id, actorId: 'actor', action: 'physical.review.save', requestHash: 'other', result: {} }]);
    const send = vi.fn();
    await expect(requestPhysicalSync({ send } as unknown as PgBoss, id, input, 'actor')).rejects.toMatchObject({ code: 'OPERATION_CONFLICT', status: 409 });
    expect(send).not.toHaveBeenCalled(); expect(state.lockPhysical).not.toHaveBeenCalled(); expect(state.inserts).toEqual([]);
  });
  it('replays an existing matching run before checking the shared operation marker', async () => {
    const requestHash = createHash('sha256').update(JSON.stringify({ groupId: id, input })).digest('hex');
    state.records.set(physicalSyncRuns, [{ id, groupId: id, m2ConfirmationId: id, operationId: id, requestHash, createdBy: 'actor', status: 'completed',
      startDate: input.startDate, endDate: input.endDate, requestBudget: 100, requestsUsed: 3, authRequests: 0, cacheHits: 0, maxPages: 10,
      errorCode: null, errorMessage: null, createdAt: new Date('2026-10-18T01:00:00Z'), completedAt: new Date('2026-10-18T01:01:00Z') }]);
    state.records.set(batchOperations, [{ operationId: id, actorId: 'actor', action: 'physical.sync.submit', requestHash, result: { runId: id } }]);
    const send = vi.fn();
    expect((await requestPhysicalSync({ send } as unknown as PgBoss, id, input, 'actor')).run.id).toBe(id);
    expect(send).not.toHaveBeenCalled(); expect(state.lockPhysical).not.toHaveBeenCalled(); expect(state.inserts).toEqual([]);
  });
  it('records a shared operation marker atomically with the new run', async () => {
    const { bundle } = observationFixture(); state.lockPhysical.mockResolvedValue({ bundle, state: undefined });
    const send = vi.fn(async () => id);
    const result = await requestPhysicalSync({ send } as unknown as PgBoss, id, input, 'actor');
    expect(send).toHaveBeenCalledOnce();
    expect(state.inserts.find((entry) => entry.table === batchOperations)?.values).toMatchObject({ operationId: id, actorId: 'actor',
      action: 'physical.sync.submit', result: { runId: result.run.id } });
  });
});

describe('physical collection ownership and interrupted publication', () => {
  it('does not claim a run owned by another worker', async () => {
    state.locked = false; await executePhysicalSync(id);
    expect(state.transaction).not.toHaveBeenCalled(); expect(state.order).toEqual(['lock']); expect(state.release).toHaveBeenCalledOnce();
  });
  it('leaves a live running task alone', async () => {
    state.records.set(physicalSyncRuns, [{ id, queueJobId: id, status: 'running' }]); state.locked = false;
    await reconcilePhysicalSyncRuns({ findJobs: async () => [{ state: 'active' }] } as unknown as PgBoss);
    expect(state.updates).toEqual([]);
  });
  it('recovers orphaned work even when pg-boss still calls the job active', async () => {
    const run = { id, queueJobId: id, status: 'running' };
    state.records.set(physicalSyncRuns, [run]); state.records.set(physicalSyncItems, [{ status: 'completed' }, { status: 'running' }]);
    await reconcilePhysicalSyncRuns({ findJobs: async () => [{ state: 'active' }] } as unknown as PgBoss);
    expect(run.status).toBe('partial'); expect(state.updates.some((update) => update.errorCode === 'SYNC_INTERRUPTED')).toBe(true);
  });
  it('does not mark all completed checkpoints as a published source after a crash', async () => {
    const run = { id, queueJobId: id, status: 'running' };
    state.records.set(physicalSyncRuns, [run]); state.records.set(physicalSyncItems, [{ status: 'completed' }]);
    await reconcilePhysicalSyncRuns({ findJobs: async () => [{ state: 'active' }] } as unknown as PgBoss);
    expect(run.status).toBe('partial'); expect(state.updates.some((update) => update.errorCode === 'SOURCE_PUBLICATION_INTERRUPTED')).toBe(true);
  });
});
