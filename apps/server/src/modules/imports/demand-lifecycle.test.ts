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

describe('demand lifecycle audit tombstones', () => {
  it('scopes active and cancelled SQL to demand.cancel for the current demand identity', () => {
    const cancelled = compile(demandLifecycleCondition('cancelled')!);
    expect(cancelled.sql).toContain('EXISTS (SELECT 1 FROM "operation_audit"');
    expect(cancelled.sql).toContain('"operation_audit"."target_id" = "demand"."id"');
    expect(cancelled.sql).toContain('"operation_audit"."action" = \'demand.cancel\'');
    expect(cancelled.params).toEqual([]);
    const active = compile(demandLifecycleCondition('active')!);
    expect(active.sql).toBe(`NOT (${cancelled.sql})`);
    expect(active.params).toEqual([]);
    expect(demandLifecycleCondition('all')).toBeUndefined();
  });

  it('returns audit reasons, actors, times and optional version with an identity-scoped query', async () => {
    const demandId = randomUUID(), at = new Date('2026-10-23T00:00:00.000Z');
    const { tx, where } = transaction(new Map([[operationAudit, [{ targetId: demandId, actorUserId: 'admin', createdAt: at,
      details: { reason: '取消发货', version: '4' } }]]]));
    expect(await loadDemandCancellationsInTx(tx, [demandId])).toEqual(new Map([[demandId,
      { reason: '取消发货', createdBy: 'admin', createdAt: at, version: 4 }]]));
    const condition = compile(where.mock.calls[0]![1]);
    expect(condition.sql).toContain('"operation_audit"."action" = $1');
    expect(condition.sql).toContain('"operation_audit"."target_id" in ($2)');
    expect(condition.params).toEqual(['demand.cancel', demandId]);
  });

  it('supports legacy tombstones without reason/version and does not query for an empty identity set', async () => {
    const demandId = randomUUID(), at = new Date();
    const { tx, select, where } = transaction(new Map([[operationAudit, [{ targetId: demandId, actorUserId: 'admin', createdAt: at, details: {} }]]]));
    expect(await loadDemandCancellationsInTx(tx, [])).toEqual(new Map());
    expect(select).not.toHaveBeenCalled();
    expect(await loadDemandCancellationsInTx(tx)).toEqual(new Map([[demandId, { reason: '需求已取消。', createdBy: 'admin', createdAt: at }]]));
    expect(compile(where.mock.calls[0]![1]).params).toEqual(['demand.cancel']);
  });

  it('rejects cancelled demands with 409 and allows identities without a tombstone', async () => {
    const demandId = randomUUID();
    const cancelled = transaction(new Map([[operationAudit, [{ targetId: demandId, actorUserId: 'admin', createdAt: new Date(), details: {} }]]]));
    await expect(requireActiveDemandInTx(cancelled.tx, demandId)).rejects.toBeInstanceOf(BatchError);
    await expect(requireActiveDemandInTx(cancelled.tx, demandId)).rejects.toMatchObject({ code: 'DEMAND_CANCELLED', status: 409 });
    await expect(requireActiveDemandInTx(transaction(new Map()).tx, demandId)).resolves.toBeUndefined();
  });

  it('rejects publishing a candidate without a group for a cancelled demand before any insert', async () => {
    const demandId = randomUUID();
    const { tx, insert, execute } = transaction(new Map<unknown, unknown[]>([
      [user, [{ id: 'admin', role: 'admin', banned: false }]],
      [demands, [{ id: demandId, sid: 100, fba: 'FBA123', version: 2 }]],
      [operationAudit, [{ targetId: demandId, actorUserId: 'admin', createdAt: new Date(), details: {} }]],
    ]));
    await expect(publishCandidateInTx(tx, { actorId: 'admin', demandId, expectedDemandVersion: 2, source: 'manual',
      data: {} as Parameters<typeof publishCandidateInTx>[1]['data'] })).rejects.toMatchObject({ code: 'DEMAND_CANCELLED', status: 409 });
    expect(execute).toHaveBeenCalledOnce();
    expect(compile(execute.mock.calls[0]![0]).params).toContain(`shipment:${demandId}`);
    expect(insert).not.toHaveBeenCalled();
  });
});
