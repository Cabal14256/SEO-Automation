import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';

const state = vi.hoisted(() => ({ locked: true, order: [] as string[], records: new Map<unknown, Array<Record<string, unknown>>>(), updates: [] as Array<Record<string, unknown>>,
  transaction: vi.fn(), release: vi.fn(), query: vi.fn(), db: {} as Record<string, unknown> }));
vi.mock('../../auth.js', () => ({ auth: {} }));
vi.mock('../../db/client.js', () => {
  const select = () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => state.records.get(table) ?? [], for: async () => state.records.get(table) ?? [], then: (resolve: (rows: unknown) => void) => resolve(state.records.get(table) ?? []) }) }) });
  const update = (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
    state.updates.push(values);
    for (const record of state.records.get(table) ?? []) if (record.status !== 'completed') Object.assign(record, values);
  } }) });
  state.db = { select, update, transaction: state.transaction };
  state.query.mockImplementation(async (query: string) => { state.order.push(query.includes('try_advisory') ? 'lock' : 'unlock'); return { rows: [{ locked: state.locked }] }; });
  state.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => { state.order.push('transaction'); return work(state.db); });
  return { db: state.db, pool: { connect: async () => ({ query: state.query, release: state.release }) } };
});
import { batchSyncItems, batchSyncRuns } from '../lingxing/sync-schema.js';
import { executeBatchSync, reconcileBatchSyncRuns, requestBatchSync, retryBatchSync } from './sync-jobs.js';

beforeEach(() => { state.locked = true; state.order = []; state.records.clear(); state.updates = []; state.transaction.mockClear(); state.query.mockClear(); state.release.mockClear(); });
afterEach(() => vi.unstubAllEnvs());

describe('offline sync environment', () => {
  it('refuses to enqueue new or retried work before database or queue changes', async () => {
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    const send = vi.fn(); const boss = { send } as unknown as PgBoss;
    await expect(requestBatchSync(boss, 'group', { operationId: 'invalid', expectedVersion: 1, startDate: '2000-01-01', endDate: '2000-01-02' }, 'actor'))
      .rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    await expect(retryBatchSync(boss, 'run', { operationId: 'invalid' }, 'actor')).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(state.transaction).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('marks restored queued work failed without creating a network client or consuming request budget', async () => {
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    const run = { id: 'run', status: 'queued', requestsUsed: 0, authRequests: 0 };
    state.records.set(batchSyncRuns, [run]); state.records.set(batchSyncItems, [{ status: 'queued', requestCount: 0 }]);
    const createClient = vi.fn();
    await expect(executeBatchSync('run', { createClient })).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(createClient).not.toHaveBeenCalled(); expect(run).toMatchObject({ status: 'failed', requestsUsed: 0, authRequests: 0 });
    expect(state.updates.some((update) => update.errorCode === 'LINGXING_REQUESTS_DISABLED')).toBe(true);
    expect(state.order).toEqual(['lock', 'transaction', 'unlock']);
  });
});

describe('cross-process sync ownership', () => {
  it('acquires run ownership before trying the queued claim and releases it without a long SQL transaction', async () => {
    await executeBatchSync('00000000-0000-4000-8000-000000000001');
    expect(state.order).toEqual(['lock', 'transaction', 'unlock']); expect(state.release).toHaveBeenCalledOnce();
  });
  it('does not claim or mutate a run already owned by another process', async () => {
    state.locked = false; await executeBatchSync('00000000-0000-4000-8000-000000000001');
    expect(state.transaction).not.toHaveBeenCalled(); expect(state.order).toEqual(['lock']);
  });
  it('does not reconcile an active running task while its live worker owns the run lock', async () => {
    state.records.set(batchSyncRuns, [{ id: 'run', queueJobId: 'job', status: 'running' }]); state.locked = false;
    await reconcileBatchSyncRuns({ findJobs: async () => [{ state: 'active' }] } as unknown as PgBoss);
    expect(state.transaction).not.toHaveBeenCalled(); expect(state.updates).toEqual([]);
  });
  it('recovers a running orphan immediately even though its queue job remains active', async () => {
    const run = { id: 'run', queueJobId: 'job', status: 'running' }; state.records.set(batchSyncRuns, [run]);
    state.records.set(batchSyncItems, [{ status: 'completed' }, { status: 'running' }]);
    await reconcileBatchSyncRuns({ findJobs: async () => [{ state: 'active' }] } as unknown as PgBoss);
    expect(run.status).toBe('partial'); expect(state.updates.some((update) => update.errorCode === 'SYNC_INTERRUPTED')).toBe(true);
    expect(state.order).toEqual(['lock', 'transaction', 'unlock']);
  });
});
