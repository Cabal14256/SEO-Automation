import { createHash, randomUUID } from 'node:crypto';
import { getTableColumns, getTableName, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileIndex, operationAudit, sellerAliases, sellerCatalogOperations, sellerCatalogSettings, sellerMappingRevisions, sellerMappings, user } from '../../db/schema.js';
import { activeSeller, syncSellerCatalog } from './catalog.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), store: vi.fn(), remote: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('../../file-store.js', () => ({ storeImmutableFile: mocks.store }));
vi.mock('../lingxing/read-client.js', async (original) => ({ ...await original<object>(), createLingxingReadClient: mocks.remote }));

type Row = Record<string, unknown>;
type State = Record<string, Row[]>;
const dialect = new PgDialect();
const actor = 'automatic-approval-administrator';
const observedAt = new Date('2026-10-18T00:00:00Z');
let state: State;
const rows = (table: PgTable, source = state) => source[getTableName(table)] ??= [];
function matches(table: PgTable, row: Row, condition?: SQL) {
  if (!condition) return true;
  const compiled = dialect.sqlToQuery(condition), columns = getTableColumns(table);
  const predicates = [...compiled.sql.matchAll(/"[^"]+"\."([^"]+)" = \$(\d+)/g)];
  if (!predicates.length || predicates.length !== compiled.params.length) throw new Error('Unsupported mock predicate');
  return predicates.every((predicate) => {
    const key = Object.keys(columns).find((key) => columns[key]!.name === predicate[1]);
    return key !== undefined && row[key] === compiled.params[Number(predicate[2]) - 1];
  });
}
function query(run: (condition?: SQL) => Row[]) {
  let condition: SQL | undefined;
  const value = { where(input: SQL) { condition = input; return value; }, orderBy() { return value; }, for() { return value; }, returning() { return value; },
    then(resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve().then(() => structuredClone(run(condition))).then(resolve, reject); } };
  return value;
}
function transaction(source: State) {
  return { execute: async () => [], select: () => ({ from: (table: PgTable) => query((condition) => rows(table, source).filter((row) => matches(table, row, condition))) }),
    update: (table: PgTable) => ({ set: (changes: Row) => query((condition) => { const selected = rows(table, source).filter((row) => matches(table, row, condition)); for (const row of selected) Object.assign(row, changes); return selected; }) }),
    insert: (table: PgTable) => ({ values: (input: Row | Row[]) => query(() => {
      const inserted = (Array.isArray(input) ? input : [input]).map((row) => ({ ...(table === sellerMappings ? { updatedAt: observedAt, wid: null } : {}), ...row }));
      rows(table, source).push(...structuredClone(inserted)); return inserted;
    }) }) };
}
function seller(sid: number, changes: Row = {}) {
  return { id: randomUUID(), sid, name: '人工资料', country: '人工国家', marketplaceId: null, wid: null, status: 'candidate', version: 3,
    sourceObservedAt: observedAt, sourceSha256: '1'.repeat(64), sourceFileId: null, updatedAt: observedAt, manualEnabled: true,
    lingxingAutoApproved: false, lingxingDisabled: false, lingxingData: { name: '远程店铺', country: '德国', marketplaceId: 'DE', present: true, status: '1', observedAt: observedAt.toISOString() }, ...changes };
}
const remoteSeller = (sid: number, status = '1') => ({ sid, name: '领星-' + sid, country: '德国', marketplace_id: 'DE', status });
function response(data: Row[]) {
  return { payload: { code: 0, data }, metadata: { operation: 'listSellers', requestedAt: observedAt.toISOString(), responseSha256: '3'.repeat(64) } };
}
beforeEach(() => {
  vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'true');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/test');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-with-at-least-32-characters');
  state = {};
  for (const table of [sellerMappings, sellerAliases, fileIndex, operationAudit, sellerMappingRevisions, sellerCatalogOperations]) rows(table);
  rows(user).push({ id: actor, role: 'admin', banned: false });
  rows(sellerCatalogSettings).push({ id: 'global', mode: 'lingxing', version: 2, catalogVersion: 7, lastSyncedAt: null, lastError: null });
  mocks.transaction.mockReset().mockImplementation(async (run: (tx: ReturnType<typeof transaction>) => Promise<unknown>) => { const pending = structuredClone(state); const result = await run(transaction(pending)); state = pending; return result; });
  mocks.remote.mockReset().mockImplementation(() => { throw new Error('Unexpected external client construction'); });
  mocks.store.mockReset().mockImplementation(async (_directory, input, save) => save({ id: randomUUID(), storageKey: 'technical.json', originalName: input.originalName,
    sha256: createHash('sha256').update(input.bytes).digest('hex'), byteSize: input.bytes.length, mimeType: 'application/json', createdBy: actor, createdAt: observedAt }));
});
afterEach(() => vi.unstubAllEnvs());

describe('trusted Lingxing automatic approval publication', () => {
  it('approves authorized existing and new identities, preserving manual approval and explicit remote disable with per-mapping evidence', async () => {
    const candidate = seller(101), disabled = seller(102, { status: 'approved', lingxingDisabled: true }), revoked = seller(103), absent = seller(104);
    rows(sellerMappings).push(candidate, disabled, revoked, absent);
    rows(sellerAliases).push({ sellerMappingId: candidate.id, alias: '来源名称', normalizedAlias: '来源名称' });
    const querySellers = vi.fn().mockResolvedValue(response([remoteSeller(101), remoteSeller(102), remoteSeller(103, '0'), remoteSeller(105)]));
    const request = { operationId: randomUUID(), expectedVersion: 2 };
    const result = await syncSellerCatalog(request, actor, { querySellers });
    expect(result).toMatchObject({ inserted: 1, updated: 4, total: 4, settings: { catalogVersion: 8 }, replayed: false });
    const published = rows(sellerMappings);
    const current = (sid: number) => published.find((row) => row.sid === sid)!;
    expect(current(101)).toMatchObject({ status: 'candidate', manualEnabled: true, lingxingAutoApproved: true, lingxingDisabled: false, version: 4, name: '人工资料' });
    expect(activeSeller(current(101) as unknown as Parameters<typeof activeSeller>[0], 'lingxing')).toMatchObject({ status: 'approved', name: '领星-101' });
    expect(activeSeller(current(101) as unknown as Parameters<typeof activeSeller>[0], 'manual')?.status).toBe('candidate');
    expect(current(102)).toMatchObject({ status: 'approved', lingxingDisabled: true, lingxingAutoApproved: true });
    expect(activeSeller(current(102) as unknown as Parameters<typeof activeSeller>[0], 'lingxing')?.status).toBe('disabled');
    expect(current(103)).toMatchObject({ lingxingAutoApproved: false, lingxingData: { status: '0' } });
    expect(current(104)).toMatchObject({ lingxingAutoApproved: false, lingxingData: { present: false } });
    expect(current(105)).toMatchObject({ status: 'candidate', manualEnabled: false, lingxingAutoApproved: true });
    expect(rows(sellerMappingRevisions)).toHaveLength(3);
    expect(rows(sellerMappingRevisions).find((row) => row.sellerMappingId === candidate.id)).toMatchObject({ version: 4, actorUserId: actor,
      before: { dataSource: 'lingxing', aliases: ['来源名称'], autoApproved: false }, after: { dataSource: 'lingxing', status: 'approved', autoApproved: true, aliases: ['来源名称'] } });
    expect(rows(operationAudit).filter((row) => row.action === 'seller_mapping.auto_approve')).toHaveLength(3);
    expect(rows(fileIndex)).toHaveLength(1);
    const original = structuredClone(state);
    expect(await syncSellerCatalog(request, actor, { querySellers })).toEqual({ ...result, replayed: true });
    expect(state).toEqual(original); expect(querySellers).toHaveBeenCalledOnce(); expect(mocks.store).toHaveBeenCalledOnce(); expect(mocks.remote).not.toHaveBeenCalled();
  });

  it('preserves approvals and the last successful evidence after a failed remote query', async () => {
    rows(sellerMappings).push(seller(101, { lingxingAutoApproved: true, lingxingDisabled: true }));
    const original = structuredClone(rows(sellerMappings));
    await expect(syncSellerCatalog({ operationId: randomUUID(), expectedVersion: 2 }, actor, { querySellers: vi.fn().mockRejectedValue(new Error('technical failure')) }))
      .rejects.toMatchObject({ code: 'LINGXING_READ_FAILED', status: 503 });
    expect(rows(sellerMappings)).toEqual(original); expect(rows(sellerMappingRevisions)).toHaveLength(0); expect(rows(fileIndex)).toHaveLength(0); expect(mocks.store).not.toHaveBeenCalled();
    expect(rows(sellerCatalogSettings)[0]).toMatchObject({ catalogVersion: 7, lastError: { code: 'LINGXING_READ_FAILED' } });
  });
});
