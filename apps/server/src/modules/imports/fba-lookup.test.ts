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
import { executeFbaLookup, getFbaLookup, inclusiveLookupEndDate, lookupMetadataSnapshot, projectFbaLookupRows, projectInboundShipmentChannels, requestFbaLookup } from './fba-lookup.js';

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

describe('linked inbound order channels', () => {
  const targets = [{ sid: 12, fba: 'FBA001' }, { sid: 12, fba: 'FBA002' }];
  it('uses the transportation method and merges different logistics channels with their source identities', () => {
    const channels = projectInboundShipmentChannels(targets, scope, [order(), order({ shipment_sn: 'ORDER002', logistics_channel_id: '19', logistics_channel_name: '另一海派渠道' }), order()]);
    expect(channels.get('12:FBA001')).toEqual({ channel: '海派', channelStatus: 'unique', channelOptions: [{
      name: '海派', shipmentNumbers: ['ORDER001', 'ORDER002'], channelIds: ['18', '19'], methodNames: ['海派'],
    }] });
    expect(channels.get('12:FBA002')).toEqual({ channel: null, channelStatus: 'not_found', channelOptions: [] });
    const rows = projectFbaLookupRows(['FBA001'], scope, [{ ...shipment(), alpha_name: '旧承运编码', shipping_mode: 'GROUND_SMALL_PARCEL' }], metadata().requestedAt, channels);
    expect(rows[0]!.candidates[0]).toMatchObject({ channel: '海派', channelStatus: 'unique' });
  });
  it('keeps different transportation methods ambiguous even when the logistics channel matches', () => {
    const result = projectInboundShipmentChannels(targets, scope, [order(), order({ shipment_sn: 'ORDER002', method_name: '自定义空派' })]).get('12:FBA001');
    expect(result).toMatchObject({ channel: null, channelStatus: 'ambiguous' });
    expect(result?.channelOptions.map((option) => option.name).sort()).toEqual(['海派', '自定义空派'].sort());
  });
  it('uses the transportation method independently of the logistics channel name and never falls back to logistics metadata', () => {
    const result = projectInboundShipmentChannels(targets, scope, [order({ logistics_channel_name: ' ', method_name: '海派', logistics: [{ transport_type: 2 }] })]);
    expect(result.get('12:FBA001')).toMatchObject({ channel: '海派', channelStatus: 'unique', channelOptions: [{ name: '海派' }] });
    for (const method_name of [undefined, null, '', ' ']) {
      expect(projectInboundShipmentChannels(targets, scope, [order({ method_name, logistics: [{ transport_type: 2 }] })]).get('12:FBA001'))
        .toEqual({ channel: null, channelStatus: 'not_found', channelOptions: [] });
    }
  });
  it('does not automatically select a partial method when another active linked order has an empty method', () => {
    const channels = projectInboundShipmentChannels(targets, scope, [order(), order({ shipment_sn: 'ORDER002', method_name: '' })]);
    expect(channels.get('12:FBA001')).toEqual({ channel: null, channelStatus: 'unavailable', channelOptions: [{
      name: '海派', shipmentNumbers: ['ORDER001'], channelIds: ['18'], methodNames: ['海派'],
    }] });
    const candidates = projectFbaLookupRows(['FBA001'], scope, [shipment()], metadata().requestedAt, channels)[0]!.candidates;
    expect(candidates[0]).toMatchObject({ channel: null, channelStatus: 'unavailable', channelOptions: [{ name: '海派' }] });
    expect(projectInboundShipmentChannels(targets, scope, [order({ method_name: '' }), order({ shipment_sn: 'ORDER002', method_name: null })]).get('12:FBA001'))
      .toEqual({ channel: null, channelStatus: 'not_found', channelOptions: [] });
  });
  it('accepts only the documented active statuses and excludes unknown status values', () => {
    const channels = projectInboundShipmentChannels(targets, scope, [
      ...[-1, 0, '1', '2'].map((status) => order({ status, shipment_sn: `ACTIVE${status}` })),
      ...[undefined, null, '', 9, 'unrecognized'].map((status) => order({ status, method_name: '未知状态运输方式' })),
    ]);
    expect(channels.get('12:FBA001')).toMatchObject({ channel: '海派', channelStatus: 'unique', channelOptions: [{ shipmentNumbers: ['ACTIVE-1', 'ACTIVE0', 'ACTIVE1', 'ACTIVE2'] }] });
    expect(projectInboundShipmentChannels(targets, scope, [order({ status: undefined })]).get('12:FBA001'))
      .toEqual({ channel: null, channelStatus: 'not_found', channelOptions: [] });
  });
  it('excludes cancelled and deleted order statuses without introducing a false conflict', () => {
    const result = projectInboundShipmentChannels(targets, scope, [order(), order({ status: '3', method_name: '已作废运输方式' }), order({ status: 4, method_name: '已删除运输方式' }),
      order({ status: 1, is_delete: 1, method_name: '已删除但状态未变运输方式' }), order({ status: 0, is_delete: '1', method_name: '已删除字符串标记运输方式' })]);
    expect(result.get('12:FBA001')).toMatchObject({ channel: '海派', channelStatus: 'unique' });
    expect(result.get('12:FBA001')?.channelOptions).toHaveLength(1);
  });
  it('associates each channel with the exact sid and FBA while allowing unrelated links in a shared order', () => {
    const other = { ...scope[0]!, id: 'other', sid: 13, name: '其他店铺', country: '英国' };
    const result = projectInboundShipmentChannels([{ sid: 12, fba: 'FBA001' }, { sid: 13, fba: 'FBA001' }], [...scope, other], [
      order({ relate_list: [{ sid: '12', shipment_id: ' fba001 ' }, { sid: 999, shipment_id: 'FBA999' }] }),
      order({ method_name: '英国空派', relate_list: [{ sid: 13, shipment_id: 'FBA001' }] }),
    ]);
    expect(result.get('12:FBA001')).toMatchObject({ channel: '海派', channelStatus: 'unique' });
    expect(result.get('13:FBA001')).toMatchObject({ channel: '英国空派', channelStatus: 'unique' });
    expect(() => projectInboundShipmentChannels(targets, scope, [order({ relate_list: [{ sid: 999, shipment_id: 'FBA001' }] })]))
      .toThrow('范围外的店铺');
  });
  it('records only channel evidence and linked shipment identities in immutable snapshots', () => {
    const result = lookupMetadataSnapshot({ metadata: metadata('listInboundShipments'), payload: { ...orderPayload([order({
      item_list: [{ sku: 'private-product' }], access_token: 'private-token', phone: 'private-phone',
      relate_list: [{ sid: 12, shipment_id: ' fba001 ', item_list: [{ sku: 'private-related-product' }] }],
    })]), message: 'private-error' } }, { sids: '12', senior_search_list: [{ search_field: 'shipment_id', search_value: ['FBA001'] }], offset: 0, length: 20, is_delete: 0, access_token: 'private-token' });
    expect(result).toMatchObject({ schemaVersion: 'fba-lookup-channels-v1', request: { sids: '12', offset: 0, length: 20, is_delete: 0 },
      response: { total: '1', list: [{ shipment_sn: 'ORDER001', logistics_channel_id: '18', logistics_channel_name: '领星海派渠道', method_name: '海派', relate_list: [{ sid: '12', shipment_id: 'FBA001' }] }] } });
    expect(JSON.stringify(result)).not.toMatch(/private-|item_list|phone|access_token|message/);
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
  it('preserves newly projected transportation methods and their field source when loading a completed lookup', async () => {
    const record = run();
    const channels = projectInboundShipmentChannels([{ sid: 12, fba: 'FBA001' }], scope, [order()]);
    const rows = projectFbaLookupRows(['FBA001'], scope, [shipment()], metadata().requestedAt, channels);
    Object.assign(record, { status: 'completed', rows, completedAt: new Date('2026-10-17T01:00:01Z') });

    const result = await getFbaLookup(record.id, 'actor');

    expect(result.rows).toEqual(rows);
    expect(result.rows[0]!.candidates[0]).toMatchObject({ channel: '海派', channelStatus: 'unique', channelSource: 'method_name',
      channelOptions: [{ name: '海派', shipmentNumbers: ['ORDER001'], channelIds: ['18'], methodNames: ['海派'] }] });
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
  it('publishes transportation method names only after both listings complete and archives separate metadata evidence', async () => {
    const record = run(), source = clientFor(payload(), undefined, orderPayload());
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(source.calls).toHaveBeenNthCalledWith(1, 'listShipments', { sid: '12', shipment_id: 'FBA001,FBA002', start_date: '2026-09-01', end_date: '2026-10-01', offset: 0, length: 100 });
    expect(source.calls).toHaveBeenNthCalledWith(2, 'listInboundShipments', { sids: '12', senior_search_list: [{ search_field: 'shipment_id', search_value: ['FBA001'] }], is_delete: 0, offset: 0, length: 20 });
    expect(record.status).toBe('completed');
    expect(record.rows).toMatchObject([{ fba: 'FBA001', status: 'unique', candidates: [{ channel: '海派', channelStatus: 'unique', observedAt: '2026-10-17T01:00:01.000Z' }] }, { fba: 'FBA002', status: 'not_found' }]);
    expect(record.requestsUsed).toBe(2);
    expect(state.records.get(fbaLookupSnapshots)?.map((snapshot) => snapshot.page)).toEqual([0, 20]);
    expect(state.files.flatMap((file) => file.bytes.toString('utf8'))).toHaveLength(2);
    expect(state.files.map((file) => file.bytes.toString('utf8')).join('')).not.toContain('item_list');
    expect(state.release).toHaveBeenCalledOnce();
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
  it('completes all inbound order pages before resolving different transportation methods', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => order({ shipment_sn: `ORDER${String(index).padStart(3, '0')}` }));
    const record = run(), source = clientFor(payload(), undefined, (params) => params.offset === 0
      ? orderPayload(firstPage, 21)
      : orderPayload([order({ shipment_sn: 'ORDER999', method_name: '第二页运输方式' })], 21));
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(record).toMatchObject({ status: 'completed', requestsUsed: 3, rows: [{ candidates: [{ channel: null, channelStatus: 'ambiguous' }] }, { candidates: [] }] });
    expect(source.calls).toHaveBeenNthCalledWith(3, 'listInboundShipments', expect.objectContaining({ offset: 20, length: 20 }));
    expect(state.records.get(fbaLookupSnapshots)?.map((snapshot) => snapshot.page)).toEqual([0, 20, 21]);
  });
  it('discards partial channel values when inbound pagination ends early while retaining verified FBA metadata', async () => {
    const record = run(), source = clientFor(payload(), undefined, orderPayload([order()], 21));
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(record).toMatchObject({ status: 'completed', requestsUsed: 2, errorCode: null,
      rows: [{ fba: 'FBA001', candidates: [{ channel: null, channelStatus: 'unavailable', channelOptions: [], destinationFc: 'TEST1' }] }, { fba: 'FBA002', candidates: [] }] });
    expect(state.records.get(fbaLookupSnapshots)).toHaveLength(2);
  });
  it('does not accept an overlapping final inbound page as evidence of a unique channel', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => order({ shipment_sn: `ORDER${String(index).padStart(3, '0')}` }));
    const record = run(), source = clientFor(payload(), undefined, (params) => params.offset === 0
      ? orderPayload(firstPage, 21)
      : orderPayload([firstPage[0]!], 21));
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(record).toMatchObject({ status: 'completed', requestsUsed: 3, rows: [{ candidates: [{ channel: null, channelStatus: 'unavailable', channelOptions: [] }] }, { candidates: [] }] });
    expect(source.calls).toHaveBeenNthCalledWith(3, 'listInboundShipments', expect.objectContaining({ offset: 20, length: 20 }));
    expect(state.records.get(fbaLookupSnapshots)?.map((snapshot) => snapshot.page)).toEqual([0, 20, 21]);
  });
  it('does not publish a unique channel when an inbound order is missing its shipment number', async () => {
    const record = run(), source = clientFor(payload(), undefined, orderPayload([order(), order({ shipment_sn: '' })]));
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(record).toMatchObject({ status: 'completed', requestsUsed: 2, rows: [{ candidates: [{ channel: null, channelStatus: 'unavailable', channelOptions: [] }] }, { candidates: [] }] });
    expect(state.records.get(fbaLookupSnapshots)).toHaveLength(2);
  });
  it('publishes incomplete linked-order evidence as options for review without auto-filling a channel', async () => {
    const record = run(), source = clientFor(payload(), undefined, orderPayload([order(), order({ shipment_sn: 'ORDER002', method_name: '' })]));
    await executeFbaLookup(record.id, { createClient: source.createClient });
    expect(record).toMatchObject({ status: 'completed', rows: [{ candidates: [{ channel: null, channelStatus: 'unavailable', channelOptions: [{ name: '海派', shipmentNumbers: ['ORDER001'] }] }] }, { candidates: [] }] });
  });
  it.each(['LINGXING_READ_FAILED', 'LINGXING_INVALID_RESPONSE', 'LINGXING_NETWORK_ERROR', 'LINGXING_TIMEOUT'] as const)(
    'retains FBA metadata and marks the channel unavailable after %s', async (code) => {
      const record = run(), source = clientFor(payload(), undefined, new LingxingReadError(code, '离线模拟读取失败'));
      await executeFbaLookup(record.id, { createClient: source.createClient });
      expect(record).toMatchObject({ status: 'completed', requestsUsed: 2, rows: [{ candidates: [{ channel: null, channelStatus: 'unavailable', channelOptions: [] }] }, { candidates: [] }] });
      expect(state.records.get(fbaLookupSnapshots)?.[1]).toMatchObject({ page: 20, successful: 0 });
    },
  );
  it('stops the whole lookup on inbound rate limiting rather than publishing degraded candidates', async () => {
    const record = run(), source = clientFor(payload(), undefined, new LingxingReadError('LINGXING_RATE_LIMITED', '离线模拟限流'));
    await expect(executeFbaLookup(record.id, { createClient: source.createClient })).rejects.toMatchObject({ code: 'LINGXING_RATE_LIMITED' });
    expect(record).toMatchObject({ status: 'failed', rows: [], requestsUsed: 2, errorCode: 'LINGXING_RATE_LIMITED' });
    expect(source.calls).toHaveBeenCalledTimes(2);
    expect(state.records.get(fbaLookupSnapshots)?.[1]).toMatchObject({ page: 20, successful: 0 });
  });
  it('stops before an inbound request would exceed the shared request budget', async () => {
    const record = run(); record.requestsUsed = 39;
    const source = clientFor(payload(), undefined, orderPayload());
    await expect(executeFbaLookup(record.id, { createClient: source.createClient })).rejects.toMatchObject({ code: 'REQUEST_BUDGET_EXHAUSTED' });
    expect(record).toMatchObject({ status: 'failed', rows: [], requestsUsed: 40, errorCode: 'REQUEST_BUDGET_EXHAUSTED' });
    expect(source.calls).toHaveBeenCalledOnce();
    expect(state.records.get(fbaLookupSnapshots)).toHaveLength(1);
  });
  it('rejects a catalog change observed after inbound evidence was archived', async () => {
    const record = run(), source = clientFor(payload(), (operation) => {
      if (operation === 'listInboundShipments') state.records.get(sellerCatalogSettings)![0]!.catalogVersion = 3;
    }, orderPayload());
    await expect(executeFbaLookup(record.id, { createClient: source.createClient })).rejects.toMatchObject({ code: 'CATALOG_VERSION_CONFLICT' });
    expect(record).toMatchObject({ status: 'failed', rows: [], errorCode: 'CATALOG_VERSION_CONFLICT' });
    expect(state.records.get(fbaLookupSnapshots)).toHaveLength(2);
  });
  it('does not request inbound orders when no FBA identity is found', async () => {
    const record = run(), source = clientFor(payload([], 0), undefined, orderPayload());
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
