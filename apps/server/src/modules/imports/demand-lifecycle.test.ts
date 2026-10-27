import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { demands, operationAudit, user } from '../../db/schema.js';
import { BatchError, publishCandidateInTx, type BatchTx } from '../batches/service.js';
import { demandLifecycleCondition, loadDemandCancellationsInTx, requireActiveDemandInTx } from './demand-lifecycle.js';

const compile = (query: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(query);
function transaction(records: Map<unknown, unknown[]>) {
  const where = vi.fn(), insert = vi.fn(), execute = vi.fn().mockResolvedValue([]);
  const select = vi.fn(() => ({ from: (table: unknown) => {
    const chain = { where: (condition: unknown) => { where(table, condition); return chain; }, for: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(records.get(table) ?? []).then(resolve) };
    return chain;
  } }));
  const tx = { select, insert, execute } as unknown as BatchTx;
  return { tx, select, where, insert, execute };
}

describe('persisted demand lifecycle', () => {
  it('filters the current lifecycle rather than treating historical cancellation as permanent', () => {
    const cancelled = compile(demandLifecycleCondition('cancelled')!);
    expect(cancelled.sql).toContain('"demand"."lifecycle" = $1');
    expect(cancelled.params).toEqual(['cancelled']);
    const active = compile(demandLifecycleCondition('active')!);
    expect(active.params).toEqual(['active']);
    expect(compile(demandLifecycleCondition('trashed')!).params).toEqual(['trashed']);
    expect(demandLifecycleCondition('all')).toBeUndefined();
  });

  it('returns current reason and version with an identity-scoped inactive query', async () => {
    const demandId = randomUUID(), at = new Date('2026-10-23T00:00:00.000Z');
    const { tx, where } = transaction(new Map([[demands, [{ id: demandId, lifecycle: 'cancelled', lifecycleChangedBy: 'admin', lifecycleChangedAt: at, lifecycleReason: '取消发货', version: 4 }]]]));
    expect(await loadDemandCancellationsInTx(tx, [demandId])).toEqual(new Map([[demandId,
      { reason: '取消发货', createdBy: 'admin', createdAt: at, version: 4, lifecycle: 'cancelled' }]]));
    const condition = compile(where.mock.calls[0]![1]);
    expect(condition.sql).toContain('"demand"."id" in');
    expect(condition.params).toEqual(['active', true, demandId]);
  });

  it('includes trash and pending requests, ignores restored records and skips empty scopes', async () => {
    const demandId = randomUUID(), at = new Date();
    const restoredId = randomUUID(), pendingId = randomUUID();
    const { tx, select } = transaction(new Map([[demands, [{ id: demandId, lifecycle: 'trashed', lifecycleChangedBy: 'admin', updatedAt: at, version: 3 }, { id: restoredId, lifecycle: 'active' }, { id: pendingId, lifecycle: 'active', lifecyclePending: true, updatedAt: at, version: 1 }]], [operationAudit, [{ targetId: restoredId, action: 'demand.cancel' }]]]));
    expect(await loadDemandCancellationsInTx(tx, [])).toEqual(new Map());
    expect(select).not.toHaveBeenCalled();
    const result = await loadDemandCancellationsInTx(tx);
    expect([...result.keys()]).toEqual([demandId, pendingId]);
    expect(result.get(demandId)).toMatchObject({ lifecycle: 'trashed', version: 3 });
  });

  it('rejects cancelled demands with 409 and allows identities without a tombstone', async () => {
    const demandId = randomUUID();
    const cancelled = transaction(new Map([[demands, [{ id: demandId, lifecycle: 'cancelled', lifecycleChangedBy: 'admin', updatedAt: new Date() }]]]));
    await expect(requireActiveDemandInTx(cancelled.tx, demandId)).rejects.toBeInstanceOf(BatchError);
    await expect(requireActiveDemandInTx(cancelled.tx, demandId)).rejects.toMatchObject({ code: 'DEMAND_CANCELLED', status: 409 });
    await expect(requireActiveDemandInTx(transaction(new Map()).tx, demandId)).resolves.toBeUndefined();
  });

  it('rejects publishing a candidate without a group for a cancelled demand before any insert', async () => {
    const demandId = randomUUID();
    const { tx, insert, execute } = transaction(new Map<unknown, unknown[]>([
      [user, [{ id: 'admin', role: 'admin', banned: false }]],
      [demands, [{ id: demandId, sid: 100, fba: 'FBA123', version: 2, lifecycle: 'cancelled', lifecycleChangedBy: 'admin', updatedAt: new Date() }]],
    ]));
    await expect(publishCandidateInTx(tx, { actorId: 'admin', demandId, expectedDemandVersion: 2, source: 'manual',
      data: {} as Parameters<typeof publishCandidateInTx>[1]['data'] })).rejects.toMatchObject({ code: 'DEMAND_CANCELLED', status: 409 });
    expect(execute).toHaveBeenCalledOnce();
    expect(compile(execute.mock.calls[0]![0]).params).toContain(`shipment:${demandId}`);
    expect(insert).not.toHaveBeenCalled();
  });
});
