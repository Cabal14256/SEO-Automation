import { createHash, randomUUID } from 'node:crypto';
import { getTableColumns, getTableName, type SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SellerAliasRevisionInput } from '@scm/contracts';
import { sellerAliasRevisionSchema } from '@scm/contracts';
import { demands, operationAudit, sellerAliases, sellerCatalogOperations, sellerCatalogSettings, sellerMappingRevisions, sellerMappings, user } from '../../db/schema.js';
import { createManualSeller, listSellerMappings, resolveApprovedSeller, reviseSellerAliases, reviseSellerMapping } from './service.js';

const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: database }));

type Row = Record<string, unknown>;
type State = Record<string, Row[]>;
interface Query extends PromiseLike<Row[]> {
  where(condition: SQL): Query;
  for(lock: string): Query;
  orderBy(...columns: unknown[]): Query;
  limit(limit: number): Query;
  returning(): Query;
}

const dialect = new PgDialect();
const actorId = 'alias-administrator';
const mappingId = randomUUID();
const observedAt = new Date('2026-10-17T01:00:00Z');
let state: State;

function rows(table: PgTable, source = state): Row[] {
  return source[getTableName(table)] ??= [];
}

// Only the service's equality predicates are supported. Unexpected SQL fails the
// test instead of silently matching every row. No real database is constructed.
function matches(table: PgTable, row: Row, condition?: SQL): boolean {
  if (!condition) return true;
  const query = dialect.sqlToQuery(condition);
  const columns = getTableColumns(table);
  const inColumn = query.sql.match(/"[^"]+"\."([^"]+)" in \(/);
  if (inColumn) {
    const key = Object.keys(columns).find((key) => columns[key]!.name === inColumn[1]);
    if (!key) throw new Error('Unknown test IN column');
    return query.params.includes(row[key]);
  }
  const comparisons = [...query.sql.matchAll(/"[^"]+"\."([^"]+)" = \$(\d+)/g)];
  if (!comparisons.length || comparisons.length !== query.params.length) throw new Error(`Unsupported test predicate: ${query.sql}`);
  return comparisons.every((comparison) => {
    const key = Object.keys(columns).find((key) => columns[key]!.name === comparison[1]);
    if (!key) throw new Error(`Unknown test column: ${comparison[1]}`);
    return row[key] === query.params[Number(comparison[2]) - 1];
  });
}

function query(run: (condition?: SQL) => Row[]): Query {
  let condition: SQL | undefined;
  let maximum = Infinity;
  const builder: Query = {
    where(value) { condition = value; return builder; },
    for() { return builder; },
    orderBy() { return builder; },
    limit(value) { maximum = value; return builder; },
    returning() { return builder; },
    then(resolve, reject) {
      return Promise.resolve().then(() => structuredClone(run(condition).slice(0, maximum))).then(resolve, reject);
    },
  };
  return builder;
}

function transaction(source: State) {
  return {
    execute: async () => [],
    select: () => ({ from: (table: PgTable) => query((condition) => rows(table, source).filter((row) => matches(table, row, condition))) }),
    update: (table: PgTable) => ({ set: (changes: Row) => query((condition) => {
      const selected = rows(table, source).filter((row) => matches(table, row, condition));
      for (const row of selected) Object.assign(row, changes);
      return selected;
    }) }),
    delete: (table: PgTable) => query((condition) => {
      const deleted = rows(table, source).filter((row) => matches(table, row, condition));
      source[getTableName(table)] = rows(table, source).filter((row) => !deleted.includes(row));
      return deleted;
    }),
    insert: (table: PgTable) => ({ values: (value: Row | Row[]) => query(() => {
      const inserted = Array.isArray(value) ? value : [value];
      if (table === sellerAliases) {
        const aliases = [...rows(table, source), ...inserted].map((row) => row.normalizedAlias);
        if (new Set(aliases).size !== aliases.length) throw Object.assign(new Error('Duplicate alias'), { code: '23505' });
      }
      rows(table, source).push(...structuredClone(inserted));
      return inserted;
    }) }),
  };
}

function input(overrides: Partial<SellerAliasRevisionInput> = {}): SellerAliasRevisionInput {
  return { operationId: randomUUID(), expectedVersion: 3, expectedCatalogSettingsVersion: 2, expectedCatalogVersion: 7,
    aliases: ['DEMO-SELLER-DE'], status: 'approved', reason: '核对领星店铺与需求表名称', ...overrides };
}

beforeEach(() => {
  database.transaction.mockReset();
  state = {};
  rows(user).push({ id: actorId, role: 'admin', banned: false });
  rows(sellerCatalogSettings).push({ id: 'global', mode: 'lingxing', version: 2, catalogVersion: 7, updatedAt: observedAt });
  rows(sellerMappings).push({ id: mappingId, sid: 910001, name: '人工名称', country: '人工国家', marketplaceId: 'manual-marketplace',
    wid: 'manual-warehouse', status: 'candidate', version: 3, updatedAt: observedAt, manualEnabled: false, lingxingAutoApproved: true, lingxingDisabled: false,
    sourceObservedAt: observedAt, sourceSha256: '1'.repeat(64), sourceFileId: randomUUID(),
    lingxingData: { name: 'DEMO-SELLER-DE', country: '德国', marketplaceId: 'A1PA6795UKMFR9', status: '1', present: true,
      observedAt: '2026-10-17T02:00:00.000Z', sha256: '2'.repeat(64), fileId: randomUUID() } });
  rows(sellerAliases).push({ sellerMappingId: mappingId, alias: '旧名称', normalizedAlias: '旧名称' });
  for (const table of [sellerMappingRevisions, sellerCatalogOperations, operationAudit, demands]) rows(table);
  database.transaction.mockImplementation(async (callback: (tx: ReturnType<typeof transaction>) => Promise<unknown>) => {
    const pending = structuredClone(state);
    const result = await callback(transaction(pending));
    state = pending;
    return result;
  });
});

describe('Lingxing seller local alias approval', () => {
  it('lists and resolves cached automatic approvals without a write or a remote request and keeps manual history independent', async () => {
    const original = structuredClone(state);
    const list = await listSellerMappings({ page: 1, pageSize: 20, search: '', status: 'approved' });
    expect(list).toMatchObject({ total: 1, items: [{ id: mappingId, status: 'approved', autoApproved: true, hasApprovedBefore: true }] });
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toMatchObject({ sid: 910001, version: 3 });
    expect(state).toEqual(original);
    rows(sellerMappings)[0]!.manualEnabled = true;
    rows(sellerCatalogSettings)[0]!.mode = 'manual';
    rows(sellerMappingRevisions).push({ sellerMappingId: mappingId, before: {}, after: { dataSource: 'lingxing', status: 'approved', hasApprovedBefore: true } });
    const manualList = await listSellerMappings({ page: 1, pageSize: 20, search: '' });
    expect(manualList.items[0]).toMatchObject({ status: 'candidate', autoApproved: false, hasApprovedBefore: false });
    expect(await resolveApprovedSeller('人工名称')).toBeNull();
  });

  it('disables and explicitly restores only the remote profile without approving the manual candidate', async () => {
    const disabled = await reviseSellerAliases(mappingId, input({ status: 'disabled' }), actorId);
    expect(disabled.mapping.status).toBe('disabled');
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toBeNull();
    expect(rows(sellerMappings)[0]).toMatchObject({ status: 'candidate', lingxingAutoApproved: true, lingxingDisabled: true });
    const restored = await reviseSellerAliases(mappingId, input({ expectedVersion: 4, expectedCatalogVersion: 8 }), actorId);
    expect(restored.mapping.status).toBe('approved');
    expect(rows(sellerMappings)[0]).toMatchObject({ status: 'candidate', lingxingDisabled: false });
  });

  it('rejects untrusted cached approval and the obsolete remote candidate status', async () => {
    rows(sellerMappings)[0]!.lingxingAutoApproved = false;
    await expect(reviseSellerAliases(mappingId, input(), actorId)).rejects.toMatchObject({ code: 'SELLER_NOT_AUTHORIZED', status: 409 });
    await expect(reviseSellerAliases(mappingId, { ...input(), status: 'candidate' } as unknown as SellerAliasRevisionInput, actorId))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(rows(sellerMappingRevisions)).toHaveLength(0);
  });

  it('requires first approval for a newly enabled manual profile even when a legacy remote-only row had raw approved status', async () => {
    rows(sellerCatalogSettings)[0]!.mode = 'manual';
    rows(sellerMappings)[0]!.status = 'approved';
    const result = await createManualSeller({ operationId: randomUUID(), sid: 910001, name: '新人工名称', country: '德国' }, actorId);
    expect(result.mapping).toMatchObject({ status: 'candidate', autoApproved: false, manualEnabled: true, hasApprovedBefore: false });
    expect(rows(sellerMappings)[0]).toMatchObject({ status: 'candidate', lingxingAutoApproved: true });
    expect(rows(sellerMappingRevisions)[0]!.before).toEqual({});
    const approved = await reviseSellerMapping(mappingId, { operationId: randomUUID(), expectedVersion: 4, name: '新人工名称', country: '德国', marketplaceId: null, wid: null,
      aliases: [], status: 'approved', reason: '', identityConfirmed: true }, actorId);
    expect(approved.mapping).toMatchObject({ status: 'approved', autoApproved: false });
  });
  it('approves a remote-only seller with actual identity, revision and audit without enabling or editing its manual profile', async () => {
    const original = structuredClone(rows(sellerMappings)[0]!);
    const request = input();
    const result = await reviseSellerAliases(mappingId, request, actorId);
    expect(result).toMatchObject({ replayed: false, mapping: { id: mappingId, sid: 910001, name: 'DEMO-SELLER-DE', country: '德国',
      marketplaceId: 'A1PA6795UKMFR9', status: 'approved', aliases: ['DEMO-SELLER-DE'], version: 4, dataSource: 'lingxing', manualEnabled: false, identityLocked: true, hasApprovedBefore: true } });
    expect(rows(sellerMappings)[0]).toEqual({ ...original, version: 4, updatedAt: expect.any(Date) });
    expect(rows(sellerAliases)).toEqual([{ sellerMappingId: mappingId, alias: 'DEMO-SELLER-DE', normalizedAlias: 'demo-seller-de' }]);
    expect(rows(sellerMappingRevisions)).toHaveLength(1);
    expect(rows(sellerMappingRevisions)[0]).toMatchObject({ sellerMappingId: mappingId, actorUserId: actorId, version: 4,
      reason: request.reason, before: { name: 'DEMO-SELLER-DE', country: '德国', aliases: ['旧名称'], status: 'approved', version: 3, hasApprovedBefore: true }, after: result.mapping });
    expect(rows(operationAudit)).toHaveLength(1);
    expect(rows(operationAudit)[0]).toMatchObject({ action: 'seller_mapping.aliases', targetId: mappingId, actorUserId: actorId,
      details: { source: 'lingxing', status: 'approved', catalogVersion: '7', reason: request.reason } });
    expect(rows(sellerCatalogSettings)[0]).toMatchObject({ mode: 'lingxing', version: 2, catalogVersion: 8, updatedBy: actorId });
  });

  it('audits alias changes against the automatically approved identity and replays the exact request', async () => {
    const request = input();
    const first = await reviseSellerAliases(mappingId, request, actorId);
    const reason = rows(sellerMappingRevisions)[0]!.reason;
    expect(reason).toBe(request.reason);
    expect(rows(operationAudit)[0]!.details).toMatchObject({ reason });
    expect(first.mapping).toMatchObject({ hasApprovedBefore: true, aliases: ['DEMO-SELLER-DE'], status: 'approved' });
    expect(rows(sellerMappingRevisions)[0]!.before).toMatchObject({ hasApprovedBefore: true, autoApproved: true, aliases: ['旧名称'] });
    const requestHash = createHash('sha256').update(JSON.stringify({ kind: 'aliases', id: mappingId, actorUserId: actorId, ...sellerAliasRevisionSchema.parse(request) })).digest('hex');
    expect(rows(sellerMappingRevisions)[0]!.requestHash).toBe(requestHash);
    const original = structuredClone(state);
    expect(await reviseSellerAliases(mappingId, request, actorId)).toEqual({ ...first, replayed: true });
    expect(state).toEqual(original);
  });

  it('does not accept the former first-approval checkbox as a reason to edit an automatically approved shop', async () => {
    const request = input({ identityConfirmed: true });
    Reflect.deleteProperty(request, 'reason');
    await expect(reviseSellerAliases(mappingId, request, actorId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(rows(sellerMappingRevisions)).toHaveLength(0);
  });

  it.each([
    { reason: '' },
    { reason: '   ', identityConfirmed: false },
    { reason: '', identityConfirmed: true, status: 'disabled' as const },
  ])('rejects missing reasons without first-approval checkbox conditions before a transaction: %j', async (changes) => {
    await expect(reviseSellerAliases(mappingId, input(changes), actorId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each(['approved', 'disabled'])('refuses a forged first-approval flag for current status %s without a reason', async (status) => {
    rows(sellerMappings)[0]!.status = status;
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, input({ identityConfirmed: true, reason: '' }), actorId))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(state).toEqual(original);
  });

  it.each(['before', 'after'])('checks complete %s approval history even when the last 100 revisions are candidates', async (side) => {
    rows(sellerCatalogSettings)[0]!.mode = 'manual';
    rows(sellerMappings)[0]!.manualEnabled = true;
    rows(sellerMappingRevisions).push({ operationId: randomUUID(), sellerMappingId: mappingId, version: 1,
      before: { status: 'candidate' }, after: { status: 'candidate' }, [side]: { status: 'approved' } });
    for (let index = 0; index < 101; index++) rows(sellerMappingRevisions).push({ operationId: randomUUID(), sellerMappingId: mappingId,
      version: index + 2, before: { status: 'candidate' }, after: { status: 'candidate' } });
    rows(sellerMappings)[0]!.version = 102;
    const manualRequest = { operationId: randomUUID(), expectedVersion: 102, name: '人工名称', country: '人工国家', marketplaceId: null, wid: null,
      aliases: [], status: 'approved' as const, identityConfirmed: true, reason: '' };
    const original = structuredClone(state);
    await expect(reviseSellerMapping(mappingId, manualRequest, actorId))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(state).toEqual(original);
    const result = await reviseSellerMapping(mappingId, { ...manualRequest, reason: '重新批准已有映射' }, actorId);
    expect(result.mapping).toMatchObject({ hasApprovedBefore: true });
    expect(rows(sellerMappingRevisions).at(-1)!.before).toMatchObject({ hasApprovedBefore: true });
  });

  it('requires a reason for alias changes after the first approval even with a forged confirmation flag', async () => {
    await reviseSellerAliases(mappingId, input(), actorId);
    const request = input({ expectedVersion: 4, expectedCatalogVersion: 8, aliases: ['改绑名称'], identityConfirmed: true, reason: '' });
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, request, actorId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(state).toEqual(original);
    const result = await reviseSellerAliases(mappingId, { ...request, reason: '源表店铺名称已经调整' }, actorId);
    expect(result.mapping).toMatchObject({ aliases: ['改绑名称'], version: 5, hasApprovedBefore: true });
    expect(rows(sellerMappingRevisions).at(-1)!.reason).toBe('源表店铺名称已经调整');
  });

  it('does not let remote auto-approval history disqualify a genuine manual first approval', async () => {
    rows(sellerCatalogSettings)[0]!.mode = 'manual';
    rows(sellerMappings)[0]!.manualEnabled = true;
    rows(sellerMappingRevisions).push({ operationId: randomUUID(), sellerMappingId: mappingId, before: { dataSource: 'lingxing', status: 'candidate' }, after: { dataSource: 'lingxing', status: 'approved', hasApprovedBefore: true } });
    rows(sellerMappingRevisions).push({ operationId: randomUUID(), sellerMappingId: randomUUID(), before: { status: 'approved' }, after: { status: 'approved' } });
    const result = await reviseSellerMapping(mappingId, { operationId: randomUUID(), expectedVersion: 3, name: '人工名称', country: '人工国家', marketplaceId: null, wid: null,
      aliases: [], status: 'approved', identityConfirmed: true, reason: '' }, actorId);
    expect(result.mapping).toMatchObject({ status: 'approved', hasApprovedBefore: true, autoApproved: false });
    expect(rows(sellerMappingRevisions).at(-1)!.before).toMatchObject({ hasApprovedBefore: false });
  });

  it.each(['sid', 'name', 'country', 'marketplaceId', 'wid', 'manualEnabled', 'lingxingData', 'dataSource', 'sourceSha256', 'lingxingAutoApproved', 'lingxingDisabled', 'autoApproved'])('rejects injected identity field %s before a transaction', async (field) => {
    const request = Object.assign(input(), { [field]: 'tampered' });
    await expect(reviseSellerAliases(mappingId, request, actorId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { aliases: ['   '] },
    { aliases: ['DEMO-SELLER-DE', 'ｄｅｍｏ-ｓｅｌｌｅｒ-DE'] },
    { aliases: ['DEMO-SELLER-DE', ' demo-seller-de '] },
  ])('rejects invalid or duplicate optional aliases: %j', async (changes) => {
    await expect(reviseSellerAliases(mappingId, input(changes), actorId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('approves without aliases and resolves the actual shop name without creating a redundant alias', async () => {
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toMatchObject({ sid: 910001 });
    const result = await reviseSellerAliases(mappingId, input({ aliases: [] }), actorId);
    expect(result.mapping).toMatchObject({ status: 'approved', aliases: [], hasApprovedBefore: true });
    expect(rows(sellerAliases)).toEqual([]);
    expect(await resolveApprovedSeller('  ｄｅｍｏ-ｓｅｌｌｅｒ-DE  ')).toMatchObject({ id: mappingId, sid: 910001, country: '德国' });
    expect(await resolveApprovedSeller('人工名称')).toBeNull();
  });

  it('uses the selected catalog name and keeps unavailable or disabled shops unresolved without aliases', async () => {
    await reviseSellerAliases(mappingId, input({ aliases: [] }), actorId);
    rows(sellerCatalogSettings)[0]!.mode = 'manual';
    expect(await resolveApprovedSeller('人工名称')).toBeNull();
    rows(sellerMappings)[0]!.manualEnabled = true;
    expect(await resolveApprovedSeller('人工名称')).toBeNull();
    rows(sellerMappings)[0]!.status = 'approved';
    expect(await resolveApprovedSeller('人工名称')).toMatchObject({ sid: 910001, country: '人工国家' });
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toBeNull();
    rows(sellerCatalogSettings)[0]!.mode = 'lingxing';
    (rows(sellerMappings)[0]!.lingxingData as Row).status = '0';
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toBeNull();
    (rows(sellerMappings)[0]!.lingxingData as Row).status = '1';
    rows(sellerMappings)[0]!.lingxingDisabled = true;
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toBeNull();
  });

  it('keeps exact name and another shop alias collisions unresolved instead of choosing either sid', async () => {
    await reviseSellerAliases(mappingId, input({ aliases: [] }), actorId);
    const otherId = randomUUID();
    const original = rows(sellerMappings)[0]!;
    rows(sellerMappings).push({ ...structuredClone(original), id: otherId, sid: 3150,
      lingxingData: { ...(original.lingxingData as Row), name: 'OTHER-DE' } });
    rows(sellerAliases).push({ sellerMappingId: otherId, alias: 'DEMO-SELLER-DE', normalizedAlias: 'demo-seller-de' });
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toBeNull();
    rows(sellerMappings)[1]!.status = 'candidate';
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toBeNull();
    rows(sellerMappings)[1]!.lingxingDisabled = true;
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toMatchObject({ sid: 910001 });
    rows(sellerMappings)[1]!.lingxingDisabled = false;
    (rows(sellerMappings)[1]!.lingxingData as Row).name = 'DEMO-SELLER-DE';
    state[getTableName(sellerAliases)] = [];
    expect(await resolveApprovedSeller('DEMO-SELLER-DE')).toBeNull();
  });

  it.each([
    { mode: 'manual' },
    { version: 3 },
    { catalogVersion: 8 },
  ])('rejects a changed catalog context atomically: %j', async (changes) => {
    Object.assign(rows(sellerCatalogSettings)[0]!, changes);
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, input(), actorId)).rejects.toMatchObject({ code: 'SELLER_CATALOG_CONFLICT', status: 409 });
    expect(state).toEqual(original);
  });

  it('rejects a stale mapping version without replacing aliases', async () => {
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, input({ expectedVersion: 2 }), actorId)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    expect(state).toEqual(original);
  });

  it.each([null, { present: false }])('rejects a seller absent from the actual catalog: %j', async (remote) => {
    const row = rows(sellerMappings)[0]!;
    row.lingxingData = remote ? { ...(row.lingxingData as Row), ...remote } : null;
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, input(), actorId)).rejects.toMatchObject({ code: 'SELLER_UNAVAILABLE', status: 409 });
    expect(state).toEqual(original);
  });

  it('refuses approval for an unauthorized remote seller but permits local disable', async () => {
    const remote = rows(sellerMappings)[0]!.lingxingData as Row;
    remote.status = '0';
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, input(), actorId)).rejects.toMatchObject({ code: 'SELLER_NOT_AUTHORIZED', status: 409 });
    expect(state).toEqual(original);
    const result = await reviseSellerAliases(mappingId, input({ status: 'disabled', aliases: [] }), actorId);
    expect(result.mapping).toMatchObject({ status: 'disabled', aliases: [], manualEnabled: false });
    expect(rows(sellerMappings)[0]).toMatchObject({ status: 'candidate', lingxingDisabled: true, lingxingData: { status: '0' } });
  });

  it('rolls back the mapping update and deleted old aliases when another seller owns the normalized alias', async () => {
    rows(sellerAliases).push({ sellerMappingId: randomUUID(), alias: 'ＤＥＭＯ-ＳＥＬＬＥＲ-DE', normalizedAlias: 'demo-seller-de' });
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, input(), actorId)).rejects.toMatchObject({ code: 'ALIAS_CONFLICT', status: 409 });
    expect(state).toEqual(original);
  });

  it('replays the exact result once even after catalog changes and does not increment versions or audit again', async () => {
    const request = input();
    const first = await reviseSellerAliases(mappingId, request, actorId);
    Object.assign(rows(sellerCatalogSettings)[0]!, { mode: 'manual', version: 3, catalogVersion: 9 });
    const original = structuredClone(state);
    const replayed = await reviseSellerAliases(mappingId, request, actorId);
    expect(replayed).toEqual({ ...first, replayed: true });
    expect(state).toEqual(original);
  });

  it('rejects operation reuse for a different alias revision or a manual revision', async () => {
    const request = input();
    await reviseSellerAliases(mappingId, request, actorId);
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, { ...request, reason: 'changed reason' }, actorId)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT', status: 409 });
    await expect(reviseSellerMapping(mappingId, { operationId: request.operationId, expectedVersion: 3, name: '人工名称', country: '人工国家',
      marketplaceId: null, wid: null, aliases: ['DEMO-SELLER-DE'], status: 'approved', reason: request.reason }, actorId)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT', status: 409 });
    expect(state).toEqual(original);
  });

  it('rejects an operation ID already used for catalog maintenance', async () => {
    const request = input();
    rows(sellerCatalogOperations).push({ operationId: request.operationId, kind: 'sync' });
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, request, actorId)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT', status: 409 });
    expect(state).toEqual(original);
  });

  it.each([{ role: 'viewer' }, { banned: true }])('checks current administrator permissions again before replay: %j', async (changes) => {
    const request = input();
    await reviseSellerAliases(mappingId, request, actorId);
    Object.assign(rows(user)[0]!, changes);
    const original = structuredClone(state);
    await expect(reviseSellerAliases(mappingId, request, actorId)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(state).toEqual(original);
  });

  it('rejects a missing actor and a missing mapping', async () => {
    await expect(reviseSellerAliases(mappingId, input(), 'missing-actor')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(reviseSellerAliases(randomUUID(), input(), actorId)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(rows(sellerMappingRevisions)).toHaveLength(0);
  });

  it('keeps manual revisions unavailable in Lingxing mode and requires an enabled manual profile in manual mode', async () => {
    const request = { operationId: randomUUID(), expectedVersion: 3, name: '更新人工名称', country: '德国', marketplaceId: null,
      wid: null, aliases: ['人工别名'], status: 'approved' as const, reason: '人工资料核对' };
    await expect(reviseSellerMapping(mappingId, request, actorId)).rejects.toMatchObject({ code: 'CATALOG_READ_ONLY', status: 409 });
    rows(sellerCatalogSettings)[0]!.mode = 'manual';
    await expect(reviseSellerMapping(mappingId, request, actorId)).rejects.toMatchObject({ code: 'MANUAL_PROFILE_REQUIRED', status: 409 });
    rows(sellerMappings)[0]!.manualEnabled = true;
    const result = await reviseSellerMapping(mappingId, request, actorId);
    expect(result.mapping).toMatchObject({ sid: 910001, name: '更新人工名称', country: '德国', dataSource: 'manual', aliases: ['人工别名'], version: 4 });
    expect(rows(operationAudit)[0]).toMatchObject({ action: 'seller_mapping.revise' });
    const requestHash = createHash('sha256').update(JSON.stringify({ id: mappingId, actorUserId: actorId, ...request })).digest('hex');
    expect(rows(sellerMappingRevisions)[0]!.requestHash).toBe(requestHash);
  });

  it('permits confirmed manual first approval and audits the newly saved identity', async () => {
    rows(sellerCatalogSettings)[0]!.mode = 'manual';
    Object.assign(rows(sellerMappings)[0]!, { manualEnabled: true, lingxingData: null });
    const request = { operationId: randomUUID(), expectedVersion: 3, sid: 3150, name: '新人工店铺', country: '加拿大', marketplaceId: null,
      wid: null, aliases: ['新人工别名'], status: 'approved' as const, identityConfirmed: true, reason: '' };
    const result = await reviseSellerMapping(mappingId, request, actorId);
    expect(result.mapping).toMatchObject({ sid: 3150, name: '新人工店铺', country: '加拿大', dataSource: 'manual', hasApprovedBefore: true });
    const reason = rows(sellerMappingRevisions)[0]!.reason;
    for (const identity of ['首次批准：已核对店铺身份', '新人工店铺', '3150', '加拿大']) expect(reason).toEqual(expect.stringContaining(identity));
    expect(rows(operationAudit)[0]!.details).toMatchObject({ reason });
    const original = structuredClone(state);
    expect(await reviseSellerMapping(mappingId, request, actorId)).toEqual({ ...result, replayed: true });
    expect(state).toEqual(original);
  });
});
