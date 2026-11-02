import { randomUUID } from 'node:crypto';
import { getTableColumns, getTableName, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceMappingCreateInputSchema, serviceMappingMutationResultSchema, type ServiceMappingCreateInput } from '@scm/contracts';
import { operationAudit, sellerMappings, user } from '../../db/schema.js';
import { batchOperations } from '../batches/schema.js';
import { serviceMappings } from './schema.js';
import { getActiveServiceMappingsInTx } from './repository.js';
import { createServiceMapping, deleteServiceMapping, getServiceMappingOptions, listServiceMappings, reviseServiceMapping } from './service.js';
import type { BatchTx } from '../batches/service.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), methods: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('../imports/transport-methods.js', () => ({ getTransportMethods: mocks.methods }));
type Row = Record<string, unknown>;
type State = Record<string, Row[]>;
interface Query extends PromiseLike<Row[]> { where(value: SQL): Query; for(value: string): Query; orderBy(...values: unknown[]): Query; returning(): Query }
const dialect = new PgDialect(), actor = 'mapping-admin';
let state: State, inTransaction: boolean;
const rows = (table: PgTable, source = state): Row[] => source[getTableName(table)] ??= [];
function matches(table: PgTable, row: Row, condition?: SQL) {
  if (!condition) return true;
  const { sql, params } = dialect.sqlToQuery(condition), columns = getTableColumns(table);
  const key = (name: string) => { const found = Object.keys(columns).find((value) => columns[value]!.name === name); if (!found) throw new Error('Unknown predicate column'); return found; };
  const comparisons = [...sql.matchAll(/"[^"]+"\."([^"]+)" (=|<>) \$(\d+)/g)];
  const nulls = [...sql.matchAll(/"[^"]+"\."([^"]+)" is null/gi)];
  if (comparisons.length !== params.length || !comparisons.length && !nulls.length) throw new Error(`Unsupported predicate: ${sql}`);
  return comparisons.every((match) => match[2] === '=' ? row[key(match[1]!)] === params[Number(match[3]) - 1] : row[key(match[1]!)] !== params[Number(match[3]) - 1])
    && nulls.every((match) => row[key(match[1]!)] === null || row[key(match[1]!)] === undefined);
}
function query(run: (condition?: SQL) => Row[]): Query {
  let condition: SQL | undefined;
  const builder: Query = { where(value) { condition = value; return builder; }, for() { return builder; }, orderBy() { return builder; }, returning() { return builder; },
    then(resolve, reject) { return Promise.resolve().then(() => structuredClone(run(condition))).then(resolve, reject); } };
  return builder;
}
function transaction(source: State) {
  return {
    execute: async () => [],
    select: (fields?: Record<string, { name: string }>) => ({ from: (table: PgTable) => query((condition) => rows(table, source).filter((row) => matches(table, row, condition)).map((row) => {
      if (!fields) return row;
      const columns = getTableColumns(table);
      return Object.fromEntries(Object.entries(fields).map(([alias, column]) => [alias, row[Object.keys(columns).find((key) => columns[key]!.name === column.name)!]]));
    })) }),
    insert: (table: PgTable) => ({ values: (value: Row) => query(() => {
      const now = new Date('2026-11-02T01:00:00Z');
      const row = table === serviceMappings ? { createdAt: now, updatedAt: now, deletedAt: null, version: 1, ...value } : value;
      rows(table, source).push(row); return [row];
    }) }),
    update: (table: PgTable) => ({ set: (value: Row) => query((condition) => {
      const selected = rows(table, source).filter((row) => matches(table, row, condition));
      selected.forEach((row) => Object.assign(row, value)); return selected;
    }) }),
  };
}
const input = (extra: Partial<ServiceMappingCreateInput> = {}): ServiceMappingCreateInput => ({ operationId: randomUUID(), countryCode: 'US', transportMethod: '领星自定义海运', transportMethodId: 'method-01', service: '手写发票服务', ...extra });
beforeEach(() => {
  state = {}; inTransaction = false; mocks.transaction.mockReset(); mocks.methods.mockReset();
  rows(user).push({ id: actor, role: 'admin', banned: false });
  rows(sellerMappings).push({ lingxingData: { country: '美国', present: true, status: '1', observedAt: '2026-11-02T00:00:00Z' } });
  mocks.methods.mockImplementation(async () => {
    expect(inTransaction).toBe(false);
    return { items: [{ id: 'method-01', name: '领星自定义海运', enabled: true, remark: '' }], queriedAt: '2026-11-02T01:00:00Z' };
  });
  mocks.transaction.mockImplementation(async (action) => {
    const working = structuredClone(state); inTransaction = true;
    try { const result = await action(transaction(working)); state = working; return result; } finally { inTransaction = false; }
  });
});

describe('country and transport method invoice service settings', () => {
  it('creates a versioned handwritten service and records the immutable operation and audit before/after', async () => {
    const result = await createServiceMapping(actor, input());
    expect(serviceMappingMutationResultSchema.parse(result)).toMatchObject({ replayed: false, mapping: { countryCode: 'US', transportMethod: '领星自定义海运', service: '手写发票服务', version: 1 } });
    expect(rows(batchOperations)).toHaveLength(1); expect(rows(operationAudit)[0]).toMatchObject({ action: 'service_mapping.create', targetId: result.mapping.id });
    const details = rows(operationAudit)[0]!.details as Record<string, string>;
    expect(details.before).toBe(''); expect(JSON.parse(details.after!)).toEqual(result.mapping);
  });

  it('replays the original result without querying a now unavailable remote dictionary or duplicating audit', async () => {
    const request = input(), first = await createServiceMapping(actor, request);
    mocks.methods.mockRejectedValue(new Error('offline'));
    expect(await createServiceMapping(actor, request)).toEqual({ ...first, replayed: true });
    expect(mocks.methods).toHaveBeenCalledTimes(1); expect(rows(serviceMappings)).toHaveLength(1); expect(rows(operationAudit)).toHaveLength(1);
    await expect(createServiceMapping(actor, { ...request, service: '其他服务' })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });

  it('rejects a duplicate active combination without writing another mapping', async () => {
    await createServiceMapping(actor, input());
    await expect(createServiceMapping(actor, input({ service: '第二条服务' }))).rejects.toMatchObject({ code: 'SERVICE_MAPPING_DUPLICATE', status: 409 });
    expect(rows(serviceMappings)).toHaveLength(1); expect(rows(operationAudit)).toHaveLength(1);
  });

  it('distinguishes database combination races from operation ID collisions and unrelated constraints', async () => {
    const remove = () => deleteServiceMapping(randomUUID(), actor, { operationId: randomUUID(), expectedVersion: 1 });
    mocks.transaction.mockRejectedValueOnce({ cause: { code: '23505', constraint: 'service_mapping_active_combination_uq' } });
    await expect(remove()).rejects.toMatchObject({ code: 'SERVICE_MAPPING_DUPLICATE', status: 409 });
    mocks.transaction.mockRejectedValueOnce({ code: '23505', constraint: 'batch_operation_pkey' });
    await expect(remove()).rejects.toMatchObject({ code: 'OPERATION_CONFLICT', status: 409 });
    const unrelated = { code: '23505', constraint: 'operation_audit_pkey' };
    mocks.transaction.mockRejectedValueOnce(unrelated);
    await expect(remove()).rejects.toBe(unrelated);
  });

  it('rejects unknown countries, disabled methods and mismatched auxiliary IDs', async () => {
    await expect(createServiceMapping(actor, input({ countryCode: 'DE' }))).rejects.toMatchObject({ code: 'SERVICE_MAPPING_COUNTRY_INVALID' });
    await expect(createServiceMapping(actor, input({ transportMethodId: 'other' }))).rejects.toMatchObject({ code: 'SERVICE_MAPPING_METHOD_INVALID' });
    mocks.methods.mockResolvedValue({ items: [{ id: 'method-01', name: '领星自定义海运', enabled: false, remark: '' }] });
    await expect(createServiceMapping(actor, input())).rejects.toMatchObject({ code: 'SERVICE_MAPPING_METHOD_INVALID' });
    expect(rows(serviceMappings)).toEqual([]);
  });

  it('retains an obsolete combination for service-only editing while the remote directory is unavailable', async () => {
    const created = await createServiceMapping(actor, input());
    rows(sellerMappings).splice(0); mocks.methods.mockRejectedValue(new Error('offline'));
    const result = await reviseServiceMapping(created.mapping.id, actor, { ...input(), expectedVersion: 1, service: '修改后的服务' });
    expect(result.mapping).toMatchObject({ service: '修改后的服务', version: 2, countryCode: 'US' });
    expect(mocks.methods).toHaveBeenCalledTimes(1);
    await expect(reviseServiceMapping(created.mapping.id, actor, { ...input(), expectedVersion: 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('requires current valid directory choices when the combination changes and preserves input on failure', async () => {
    const created = await createServiceMapping(actor, input());
    mocks.methods.mockRejectedValue(new Error('private token'));
    await expect(reviseServiceMapping(created.mapping.id, actor, { ...input({ countryCode: 'DE' }), expectedVersion: 1 })).rejects.toMatchObject({ code: 'SERVICE_MAPPING_DIRECTORY_UNAVAILABLE' });
    expect((await listServiceMappings(actor)).items[0]).toEqual(created.mapping);
  });

  it('soft deletes with optimistic locking, replays deletion, and allows recreating a released combination', async () => {
    const created = await createServiceMapping(actor, input()), remove = { operationId: randomUUID(), expectedVersion: 1 };
    await expect(deleteServiceMapping(created.mapping.id, actor, { ...remove, expectedVersion: 2 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const deleted = await deleteServiceMapping(created.mapping.id, actor, remove);
    expect(deleted.mapping).toMatchObject({ deletedAt: expect.any(String), version: 2 });
    expect(await deleteServiceMapping(created.mapping.id, actor, remove)).toEqual({ ...deleted, replayed: true });
    expect((await listServiceMappings(actor)).items).toEqual([]);
    const replacement = await createServiceMapping(actor, input());
    expect(replacement.mapping.id).not.toBe(created.mapping.id); expect(rows(serviceMappings)).toHaveLength(2);
  });

  it('reads only active projection fields used by new invoice snapshots', async () => {
    const created = await createServiceMapping(actor, input());
    const active = await getActiveServiceMappingsInTx(transaction(state) as unknown as BatchTx);
    expect(active).toEqual([{ id: created.mapping.id, version: 1, countryCode: 'US', transportMethod: '领星自定义海运', service: '手写发票服务' }]);
    await deleteServiceMapping(created.mapping.id, actor, { operationId: randomUUID(), expectedVersion: 1 });
    expect(await getActiveServiceMappingsInTx(transaction(state) as unknown as BatchTx)).toEqual([]);
  });

  it('authenticates before returning records or calling remote dictionaries, including operation replay', async () => {
    const request = input(); await createServiceMapping(actor, request); rows(user)[0]!.banned = true;
    await expect(createServiceMapping(actor, request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(listServiceMappings(actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getServiceMappingOptions(actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.methods).toHaveBeenCalledTimes(1);
  });

  it('reports failed directories explicitly while keeping existing records independently readable', async () => {
    await createServiceMapping(actor, input()); rows(sellerMappings).splice(0); mocks.methods.mockRejectedValue(new Error('private token'));
    const options = await getServiceMappingOptions(actor);
    expect(options.countries).toMatchObject({ status: 'unavailable', items: [], message: expect.stringContaining('同步领星店铺') });
    expect(options.transportMethods).toMatchObject({ status: 'unavailable', items: [] });
    expect(JSON.stringify(options)).not.toContain('private token');
    expect((await listServiceMappings(actor)).items).toHaveLength(1);
  });

  it('validates handwritten service and normalized country at the public contract boundary', () => {
    expect(serviceMappingCreateInputSchema.parse(input({ countryCode: ' us ', service: ' 手写服务 ' }))).toMatchObject({ countryCode: 'US', service: '手写服务' });
    expect(serviceMappingCreateInputSchema.safeParse(input({ service: ' ' })).success).toBe(false);
    expect(serviceMappingCreateInputSchema.safeParse(input({ service: 'x'.repeat(4001) })).success).toBe(false);
    expect(serviceMappingCreateInputSchema.safeParse({ ...input(), enabled: true }).success).toBe(false);
  });
});
