import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import type { FbaLookupInput } from '@scm/contracts';
import { LingxingReadError, type LingxingReadDependencies, type LingxingReadMetadata, type LingxingReadOperation, type LingxingReadPayload } from '../lingxing/read-client.js';

const state = vi.hoisted(() => ({ records: new Map<unknown, Array<Record<string, unknown>>>(), locked: true,
  transaction: vi.fn(), query: vi.fn(), release: vi.fn(), files: [] as Array<{ bytes: Buffer; originalName: string }>, db: {} as Record<string, unknown> }));
vi.mock('../../db/client.js', () => {
  const from = (table: unknown) => {
    const builder = { where: () => builder, orderBy: () => builder, for: async () => state.records.get(table) ?? [],
      limit: async () => state.records.get(table) ?? [], then: (resolve: (value: unknown) => unknown) => Promise.resolve(state.records.get(table) ?? []).then(resolve) };
    return builder;
  };
  const select = () => ({ from });
  const insert = (table: unknown) => ({ values: async (input: Record<string, unknown> | Array<Record<string, unknown>>) => {
    const records = state.records.get(table) ?? [];
    for (const value of Array.isArray(input) ? input : [input]) records.push({ createdAt: new Date('2026-10-17T00:00:00Z'), status: 'queued', queueJobId: null,
      startedAt: null, completedAt: null, rows: [], requestsUsed: 0, errorCode: null, errorMessage: null, ...value });
    state.records.set(table, records);
  } });
  const update = (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: () => {
    const records = state.records.get(table) ?? [];
    for (const row of records) Object.assign(row, values);
    return { returning: async () => records, then: (resolve: (value: unknown) => unknown) => Promise.resolve(records).then(resolve) };
  } }) });
  state.db = { select, insert, update, transaction: state.transaction, execute: async () => [] };
  state.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(state.db));
  state.query.mockImplementation(async () => ({ rows: [{ locked: state.locked }] }));
  return { db: state.db, pool: { connect: async () => ({ query: state.query, release: state.release }) } };
});
vi.mock('../../file-store.js', () => ({ storeImmutableFile: async (_directory: string, input: { bytes: Buffer; originalName: string }, callback: (file: unknown) => Promise<void>) => {
  state.files.push(input);
  const file = { id: randomUUID(), storageKey: `files/test/${randomUUID()}`, sha256: '1'.repeat(64), byteSize: input.bytes.length, originalName: input.originalName,
    mimeType: 'application/json', createdBy: 'actor' };
  await callback(file);
  return file;
} }));

import { sellerCatalogSettings, sellerMappings, user } from '../../db/schema.js';
import { fbaLookupRuns, fbaLookupSnapshots, type FbaLookupSellerScope } from './fba-lookup-schema.js';
import { executeFbaLookup, getFbaLookup, inclusiveLookupEndDate, lookupMetadataSnapshot, projectFbaLookupRows, requestFbaLookup } from './fba-lookup.js';

const scope: FbaLookupSellerScope[] = [{ id: 'mapping', sid: 12, name: '已批准店铺', country: '美国', version: 1 }];
const metadata = (operation: LingxingReadOperation = 'listShipments'): LingxingReadMetadata => ({ operation,
  path: operation === 'listInboundShipments' ? '/erp/sc/routing/storage/shipment/getInboundShipmentList' : '/erp/sc/data/fba_report/shipmentList',
  method: 'POST', requestedAt: operation === 'listInboundShipments' ? '2026-10-17T01:00:01.000Z' : '2026-10-17T01:00:00.000Z',
  elapsedMs: 10, attempt: 1, httpStatus: 200, businessCode: '0', readOnly: true });
const shipment = (fba = 'FBA001', sid = 12) => ({ sid, shipment_id: fba, seller: '远端名称', gmt_create: '2026-09-10 10:00', destination_fulfillment_center_id: 'TEST1',
  ship_to_address: { address_line1: 'Warehouse Road', city: 'City', country_code: 'US' }, item_list: [{ msku: 'unneeded', quantity_shipped: 2 }] });
const payload = (list = [shipment()], total = list.length): LingxingReadPayload => ({ code: 0, total, data: { list } });
const order = (overrides: Record<string, unknown> = {}) => ({ shipment_sn: 'ORDER001', logistics_channel_id: 18,
  logistics_channel_name: '领星海派渠道', method_id: 3, method_name: '海派', status: 1,
  relate_list: [{ sid: 12, shipment_id: 'FBA001' }], ...overrides });
const orderPayload = (list: Record<string, unknown>[] = [order()], total = list.length): LingxingReadPayload => ({ code: 0, data: { list, total } });
const input = (): FbaLookupInput => ({ operationId: randomUUID(), fbas: ['FBA001', 'FBA002'], startDate: '2026-09-01', endDate: '2026-09-30',
  expectedCatalogSettingsVersion: 1, expectedCatalogVersion: 2 });

function run() {
  const value = { id: randomUUID(), operationId: randomUUID(), requestHash: 'hash', status: 'queued', queueJobId: randomUUID(), fbas: ['FBA001', 'FBA002'],
    startDate: '2026-09-01', endDate: '2026-09-30', catalogMode: 'manual', catalogSettingsVersion: 1, catalogVersion: 2, sellerScope: scope,
    rows: [], requestsUsed: 0, requestBudget: 40, maxPages: 20, createdBy: 'actor', createdAt: new Date('2026-10-17T00:00:00Z'), startedAt: null,
    completedAt: null, errorCode: null, errorMessage: null };
  state.records.set(fbaLookupRuns, [value]);
  return value;
}
type SourceResult = LingxingReadPayload | LingxingReadError;
type PageSource = SourceResult | ((params: Readonly<Record<string, unknown>>) => SourceResult);
function clientFor(result: PageSource, afterRead?: (operation: LingxingReadOperation) => void, inbound: PageSource = orderPayload([])) {
  const calls = vi.fn();
  const createClient = async (hooks: LingxingReadDependencies) => ({ read: async (operation: LingxingReadOperation, params: Readonly<Record<string, unknown>>) => {
    await hooks.beforeRequest?.(operation);
    calls(operation, params);
    const source = operation === 'listInboundShipments' ? inbound : result;
    const response = typeof source === 'function' ? source(params) : source;
    const observed = metadata(operation);
    if (response instanceof LingxingReadError) {
      await hooks.onAttempt?.({ metadata: { ...observed, httpStatus: 503, businessCode: 'failure' }, payload: null, errorCode: response.code });
      throw response;
    }
    await hooks.onAttempt?.({ metadata: observed, payload: response });
    afterRead?.(operation);
    return { payload: response, metadata: observed };
  } });
  return { calls, createClient };
}

beforeEach(() => {
  state.records.clear(); state.files = []; state.locked = true; state.transaction.mockClear(); state.query.mockClear(); state.release.mockClear();
  state.records.set(user, [{ id: 'actor', role: 'admin', banned: false }]);
  state.records.set(sellerCatalogSettings, [{ id: 'global', mode: 'manual', version: 1, catalogVersion: 2 }]);
  state.records.set(sellerMappings, [{ id: 'mapping', sid: 12, name: '已批准店铺', country: '美国', version: 1, manualEnabled: true, status: 'approved' }]);
  vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'true');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/test');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-with-at-least-32-characters');
  vi.stubEnv('DATA_DIR', 'D:/SCM-Automation-test-data');
});
afterEach(() => vi.unstubAllEnvs());

describe('FBA metadata projection', () => {
  it('keeps inclusive end dates across month/year boundaries and rejects an unrepresentable exclusive end', () => {
    expect(inclusiveLookupEndDate('2026-09-30')).toBe('2026-10-01');
    expect(inclusiveLookupEndDate('2026-12-31')).toBe('2027-01-01');
    expect(() => inclusiveLookupEndDate('9999-12-31')).toThrow('超出支持范围');
  });
  it('returns unique, ambiguous and absent results without guessing a shop or dropping empty metadata', () => {
    const other = { ...scope[0]!, id: 'other', sid: 13, name: '其他店铺', country: '英国' };
    const rows = projectFbaLookupRows(['FBA001', 'FBA002', 'FBA003'], [...scope, other], [shipment(), shipment('FBA002'), shipment('FBA002', 13)], metadata().requestedAt);
    expect(rows.map((row) => row.status)).toEqual(['unique', 'ambiguous', 'not_found']);
    expect(rows[0]!.candidates[0]).toMatchObject({ sid: 12, shop: '已批准店铺', country: '美国', destinationAddress: 'Warehouse Road, City, US' });
    expect(rows[1]!.candidates.map((candidate) => candidate.sid)).toEqual([12, 13]);
    expect(projectFbaLookupRows(['FBA001'], scope, [{ sid: 12, shipment_id: 'FBA001' }], metadata().requestedAt)[0]!.candidates[0])
      .toMatchObject({ destinationFc: null, destinationAddress: null, shipmentCreatedAt: null });
  });
  it('rejects unexpected identities and same-shop duplicate rows rather than publishing false uniqueness', () => {
    expect(() => projectFbaLookupRows(['FBA001'], scope, [shipment('FBA001', 999)], metadata().requestedAt)).toThrow('不属于');
    expect(() => projectFbaLookupRows(['FBA001'], scope, [shipment('FBA999')], metadata().requestedAt)).toThrow('不属于');
    expect(() => projectFbaLookupRows(['FBA001'], scope, [shipment(), shipment()], metadata().requestedAt)).toThrow('重复');
  });
  it('archives only whitelisted metadata, omitting products, credentials, contact details and echoed errors', () => {
    const data = payload([{ ...shipment(), ship_to_address: { ...shipment().ship_to_address, phone: 'private-phone' } }]);
    const evidence = lookupMetadataSnapshot({ metadata: metadata(), payload: { ...data, message: 'secret-token', access_token: 'secret-token' } },
      { sid: '12', shipment_id: 'FBA001', start_date: '2026-09-01', end_date: '2026-10-01', offset: 0, length: 100, access_token: 'secret-token' });
    expect(JSON.stringify(evidence)).not.toMatch(/secret-token|private-phone|item_list|quantity_shipped|unneeded/);
    expect(evidence.response.list?.[0]).toMatchObject({ sid: 12, shipment_id: 'FBA001', gmt_create: '2026-09-10 10:00' });
  });
});

describe('FBA lookup requests', () => {
  it('does not expose legacy logistics channels as transportation methods or mutate the stored history', async () => {
    const record = run();
    const rows = projectFbaLookupRows(['FBA001'], scope, [shipment()], metadata().requestedAt);
    const candidate = rows[0]!.candidates[0]!;
    delete candidate.channelSource;
    Object.assign(candidate, { channel: '领星海派渠道', channelStatus: 'unique', channelOptions: [{
      name: '领星海派渠道', shipmentNumbers: ['ORDER001'], channelIds: ['18'], methodNames: ['海派'],
    }] });
    Object.assign(record, { status: 'completed', rows, completedAt: new Date('2026-10-17T01:00:01Z') });
    const storedRows = structuredClone(rows);

    const result = await getFbaLookup(record.id, 'actor');

    expect(result.rows[0]!.candidates[0]).toMatchObject({ channel: null, channelStatus: 'unavailable', channelOptions: [],
      destinationFc: 'TEST1', destinationAddress: 'Warehouse Road, City, US', observedAt: metadata().requestedAt });
    expect(record.rows).toEqual(storedRows);
  });
  it.each(['unique', 'ambiguous', 'not_found', 'unavailable'] as const)('discards historical %s transportation-method output without changing stored evidence', async (channelStatus) => {
    const record = run();
    const rows = projectFbaLookupRows(['FBA001'], scope, [shipment()], metadata().requestedAt);
    Object.assign(rows[0]!.candidates[0]!, { channel: '海派', channelStatus, channelSource: 'method_name',
      channelOptions: [{ name: '海派', shipmentNumbers: ['ORDER001'], channelIds: ['18'], methodNames: ['海派'] }],
      channelIssue: { code: 'METHOD_MISSING', message: '旧查询提示' } });
    Object.assign(record, { status: 'completed', rows, completedAt: new Date('2026-10-17T01:00:01Z') });
    const storedRows = structuredClone(rows);
    const result = await getFbaLookup(record.id, 'actor');
    expect(result.rows[0]!.candidates[0]).toMatchObject({ channel: null, channelStatus: 'unavailable', channelOptions: [], destinationFc: 'TEST1' });
    expect(result.rows[0]!.candidates[0]!.channelSource).toBeUndefined();
    expect(result.rows[0]!.candidates[0]!.channelIssue).toBeUndefined();
    expect(record.rows).toEqual(storedRows);
  });
  it('queries automatically approved remote shops while preserving manual candidates and excluding local disable or revoked authorization', async () => {
    state.records.set(sellerCatalogSettings, [{ id: 'global', mode: 'lingxing', version: 1, catalogVersion: 2 }]);
    const seller = { id: 'mapping', sid: 12, name: '人工店铺', country: '美国', version: 1, manualEnabled: false, status: 'candidate', lingxingAutoApproved: true, lingxingDisabled: false,
      lingxingData: { present: true, status: '1', name: '实际店铺', country: '美国', observedAt: '2026-10-17T00:00:00Z' } };
    state.records.set(sellerMappings, [seller, { ...seller, id: 'disabled', sid: 13, lingxingDisabled: true },
      { ...seller, id: 'unauthorized', sid: 14, lingxingData: { ...seller.lingxingData, status: '2' } }]);
    await requestFbaLookup({ send: vi.fn().mockResolvedValue(randomUUID()) } as unknown as PgBoss, input(), 'actor');
    expect(state.records.get(fbaLookupRuns)?.[0]?.sellerScope).toMatchObject([{ sid: 12, name: '实际店铺' }]);
    expect(seller.status).toBe('candidate');
  });
  it('normalizes and deduplicates FBA values, then replays the same operation without a second queue job', async () => {
    const send = vi.fn().mockResolvedValue(randomUUID());
    const request = { ...input(), fbas: [' fba001 ', 'FBA001', 'fba002'] };
    const first = await requestFbaLookup({ send } as unknown as PgBoss, request, 'actor');
    const second = await requestFbaLookup({ send } as unknown as PgBoss, { ...request, fbas: ['FBA002', 'FBA001'] }, 'actor');
    expect(first.id).toBe(second.id); expect(first.fbas).toEqual(['FBA001', 'FBA002']); expect(send).toHaveBeenCalledOnce();
    expect(state.records.get(fbaLookupRuns)?.[0]).toMatchObject({ maxPages: 20, requestBudget: 40, requestsUsed: 0 });
    await expect(requestFbaLookup({ send } as unknown as PgBoss, { ...request, endDate: '2026-09-29' }, 'actor')).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });
  it('rejects disabled requests and stale catalogs before enqueueing work', async () => {
    const send = vi.fn();
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    await expect(requestFbaLookup({ send } as unknown as PgBoss, input(), 'actor')).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(state.transaction).not.toHaveBeenCalled();
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'true');
    await expect(requestFbaLookup({ send } as unknown as PgBoss, { ...input(), expectedCatalogVersion: 99 }, 'actor')).rejects.toMatchObject({ code: 'CATALOG_VERSION_CONFLICT' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('FBA lookup execution', () => {
  it('reads shipment metadata only and never requests transportation methods or linked orders', async () => {
    const record = run(), source = clientFor(payload(), undefined, new LingxingReadError('LINGXING_RATE_LIMITED', 'must never read inbound orders'));
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(source.calls).toHaveBeenCalledExactlyOnceWith('listShipments', { sid: '12', shipment_id: 'FBA001,FBA002', start_date: '2026-09-01', end_date: '2026-10-01', offset: 0, length: 100 });
    expect(record.status).toBe('completed');
    expect(record.rows).toMatchObject([{ fba: 'FBA001', status: 'unique', candidates: [{ channel: null, channelStatus: 'unavailable', channelOptions: [], destinationFc: 'TEST1', observedAt: metadata().requestedAt }] }, { fba: 'FBA002', status: 'not_found' }]);
    expect(record.requestsUsed).toBe(1);
    expect(state.records.get(fbaLookupSnapshots)?.map((snapshot) => snapshot.page)).toEqual([0]);
    expect(state.files).toHaveLength(1);
    expect(state.files[0]!.bytes.toString('utf8')).not.toMatch(/item_list|method_name|logistics_channel_name/);
    expect(state.release).toHaveBeenCalledOnce();
  });
  it('completes every shipment page before publishing metadata', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...shipment(), shipment_id: index ? 'FBA002' : 'FBA001', sid: index + 12 }));
    const record = run();
    record.sellerScope = firstPage.map((row) => ({ ...scope[0]!, sid: row.sid }));
    state.records.set(sellerMappings, record.sellerScope.map((seller) => ({ ...seller, manualEnabled: true, status: 'approved' })));
    const source = clientFor((params) => params.offset === 0 ? payload(firstPage, 101) : payload([shipment('FBA001', 112)], 101));
    record.sellerScope.push({ ...scope[0]!, sid: 112 });
    state.records.set(sellerMappings, record.sellerScope.map((seller) => ({ ...seller, manualEnabled: true, status: 'approved' })));
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(source.calls.mock.calls.map(([operation]) => operation)).toEqual(['listShipments', 'listShipments']);
    expect(source.calls).toHaveBeenNthCalledWith(2, 'listShipments', expect.objectContaining({ offset: 100, length: 100 }));
    expect(record).toMatchObject({ status: 'completed', requestsUsed: 2 });
    expect(state.records.get(fbaLookupSnapshots)?.map((snapshot) => snapshot.page)).toEqual([0, 1]);
  });
  it('keeps no selectable results when paging is incomplete', async () => {
    const record = run(), source = clientFor(payload([shipment()], 101));
    await expect(executeFbaLookup(record.id, { createClient: source.createClient })).rejects.toMatchObject({ code: 'INCOMPLETE_PAGINATION' });
    expect(record).toMatchObject({ status: 'failed', rows: [], errorCode: 'INCOMPLETE_PAGINATION' });
    expect(state.records.get(fbaLookupSnapshots)).toHaveLength(1);
  });
  it('rejects publication after a source/catalog switch and retains the observed snapshot', async () => {
    const record = run(), source = clientFor(payload(), () => { state.records.get(sellerCatalogSettings)![0]!.catalogVersion = 3; });
    await expect(executeFbaLookup(record.id, { createClient: source.createClient })).rejects.toMatchObject({ code: 'CATALOG_VERSION_CONFLICT' });
    expect(record).toMatchObject({ status: 'failed', rows: [], errorCode: 'CATALOG_VERSION_CONFLICT' });
    expect(state.records.get(fbaLookupSnapshots)).toHaveLength(1);
  });
  it('stops before a shipment request would exceed the request budget', async () => {
    const record = run(); record.requestsUsed = record.requestBudget;
    const source = clientFor(payload());
    await expect(executeFbaLookup(record.id, { createClient: source.createClient })).rejects.toMatchObject({ code: 'REQUEST_BUDGET_EXHAUSTED' });
    expect(record).toMatchObject({ status: 'failed', rows: [], requestsUsed: 40, errorCode: 'REQUEST_BUDGET_EXHAUSTED' });
    expect(source.calls).not.toHaveBeenCalled(); expect(state.files).toHaveLength(0);
  });
  it('blocks a client from reading linked orders through metadata lookup hooks', async () => {
    const record = run();
    await expect(executeFbaLookup(record.id, { createClient: async (hooks) => ({ read: async () => {
      await hooks.beforeRequest?.('listInboundShipments');
      throw new Error('unreachable');
    } }) })).rejects.toMatchObject({ code: 'LOOKUP_OPERATION_DENIED' });
    expect(record).toMatchObject({ status: 'failed', rows: [], requestsUsed: 0 });
  });
  it('does not request additional data when no FBA identity is found', async () => {
    const record = run(), source = clientFor(payload([], 0));
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(record).toMatchObject({ status: 'completed', requestsUsed: 1, rows: [{ status: 'not_found', candidates: [] }, { status: 'not_found', candidates: [] }] });
    expect(source.calls).toHaveBeenCalledOnce();
  });
  it('does not create a client or publish old queued work when external requests are disabled', async () => {
    const record = run(), createClient = vi.fn(); vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    await expect(executeFbaLookup(record.id, { createClient })).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(record).toMatchObject({ status: 'failed', rows: [], requestsUsed: 0 }); expect(createClient).not.toHaveBeenCalled();
  });
  it('does not claim a lookup owned by another live worker', async () => {
    const record = run(), createClient = vi.fn(); state.locked = false;
    await executeFbaLookup(record.id, { createClient });
    expect(record.status).toBe('queued'); expect(state.transaction).not.toHaveBeenCalled(); expect(createClient).not.toHaveBeenCalled();
  });
});
