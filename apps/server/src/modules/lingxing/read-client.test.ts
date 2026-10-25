import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLingxingReadClient, LingxingReadClient, LingxingReadError, signLingxingReadParameters,
  type LingxingReadOperation,
  type LingxingReadCoordinator, type LingxingTokens,
} from './read-client.js';

const appId = '0123456789abcdef';
const token = 'offline-test/token+secret';
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const credentialKeys = /access_token|refresh_token|app_key|appid|appsecret|app_secret|sign[=:]/i;
const definitions = [
  ['listSellers', 'GET', '/erp/sc/data/seller/lists'],
  ['listShipments', 'POST', '/erp/sc/data/fba_report/shipmentList'],
  ['listInboundShipments', 'POST', '/erp/sc/routing/storage/shipment/getInboundShipmentList'],
  ['listLogisticsChannels', 'POST', '/erp/sc/data/local_inventory/channelList'],
  ['listTransportMethods', 'POST', '/basicOpen/businessConfig/transportMethod/list'],
  ['getShipmentDetails', 'POST', '/amzStaServer/openapi/inbound-shipment/shipmentDetailList'],
  ['getShipmentBoxes', 'POST', '/amzStaServer/openapi/inbound-shipment/listShipmentBoxes'],
  ['getInventory', 'POST', '/erp/sc/routing/data/local_inventory/inventoryDetails'],
  ['getFbaProducts', 'POST', '/erp/sc/routing/fba/shipment/getFbaProductList'],
  ['getListings', 'POST', '/erp/sc/data/mws/listing'],
  ['getLocalProductDetail', 'POST', '/erp/sc/routing/data/local_inventory/productInfo'],
  ['listStockSubjects', 'POST', '/basicOpen/stockSubject/list'],
] as const;
const queryFor = (operation: LingxingReadOperation): Record<string, unknown> => operation === 'getFbaProducts'
  ? { sids: [1], search_field: 'msku', search_value: 'SKU-1', offset: 0, length: 20 }
  : operation === 'getListings' ? { sid: '1', search_field: 'seller_sku', search_value: ['SKU-1'], exact_search: 1, is_delete: 0, offset: 0, length: 100 }
    : operation === 'getLocalProductDetail' ? { id: 1 } : operation === 'listStockSubjects' ? { subjectType: 'PLATFORM' }
    : operation === 'listSellers' ? {} : { sid: 1 };

afterEach(() => vi.unstubAllEnvs());

describe('restored environment outbound prohibition', () => {
  it('rejects disabled configuration before reading an explicit credentials file or persisted tokens', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const shared = coordinator({ accessToken: token, refreshToken: 'persisted-refresh', expiresAt: Date.now() + 3_600_000 });
    const loadTokens = vi.spyOn(shared.value, 'loadTokens');
    await expect(createLingxingReadClient({ LINGXING_REQUESTS_ENABLED: false, LINGXING_ENV_FILE: 'missing-probe.env' },
      { fetchImpl, coordinator: shared.value })).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(loadTokens).not.toHaveBeenCalled();
  });

  it.each(definitions)('blocks %s with both environment and cached credentials, without authentication', async (operation, method) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const shared = coordinator({ accessToken: token, refreshToken: 'persisted-refresh', expiresAt: 1 });
    const loadTokens = vi.spyOn(shared.value, 'loadTokens');
    const onAuthAttempt = vi.fn(); const beforeRequest = vi.fn();
    const client = new LingxingReadClient({ appId, appSecret: 'offline-secret', accessToken: token },
      { fetchImpl, coordinator: shared.value, onAuthAttempt, beforeRequest });
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    await expect(client.read(operation, method === 'GET' ? {} : { sid: 1 })).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(loadTokens).not.toHaveBeenCalled();
    expect(onAuthAttempt).not.toHaveBeenCalled(); expect(beforeRequest).not.toHaveBeenCalled();
  });

  it('does not let explicit enabled credentials or a probe file override the process prohibition', async () => {
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(createLingxingReadClient({ LINGXING_REQUESTS_ENABLED: true, LINGXING_APP_ID: appId,
      LINGXING_APP_SECRET: 'offline-secret', LINGXING_ENV_FILE: 'missing-probe.env' }, { fetchImpl }))
      .rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the final transport guard after asynchronous hooks for authentication and business reads', async () => {
    for (const authenticate of [false, true]) {
      vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'true');
      const fetchImpl = vi.fn<typeof fetch>();
      const disable = async () => { vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false'); };
      const client = new LingxingReadClient({ appId, appSecret: 'offline-secret', ...(authenticate ? {} : { accessToken: token }) },
        { fetchImpl, ...(authenticate ? { onAuthAttempt: disable } : { beforeRequest: disable }) });
      await expect(client.listSellers()).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('stops a rate-limit retry when outbound access is disabled during backoff', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 3001008 }));
    const beforeRequest = vi.fn().mockResolvedValue(undefined);
    const client = new LingxingReadClient({ appId, accessToken: token }, { fetchImpl, beforeRequest,
      pause: async () => { vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false'); } });
    await expect(client.listSellers()).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(beforeRequest).toHaveBeenCalledOnce();
  });
});

describe('Lingxing operation-scoped read client', () => {
  it('matches the independently verified probe signing vector', () => {
    const params = { timestamp: '1720408272', sid: 1, ids: ['a', 'b'], filter: { city: '上海' }, app_key: appId, access_token: 'test-token' };
    expect(signLingxingReadParameters(params, appId)).toBe('ne7C6/dNOj5FLjJj6r3YF89tpRPgNIF/xbzjcXMxJRU3ciLgYakkxZHNnCfqFj7U');
    expect(signLingxingReadParameters({ ...params, blank: '', absent: undefined }, appId)).toBe(signLingxingReadParameters(params, appId));
    expect(signLingxingReadParameters({ ...params, empty: null }, appId)).not.toBe(signLingxingReadParameters(params, appId));
  });

  it.each(definitions)('only performs the fixed %s query with its prescribed HTTP method', async (operation, method, path) => {
    const payload = { code: 0, data: [{ sid: 1, name: '离线店铺', country: '美国' }], response_time: '2026-10-17 16:00:00' };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://openapi.lingxing.com');
      expect(url.pathname).toBe(path);
      expect(options?.method).toBe(method);
      expect(options?.redirect).toBe('error');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const params = method === 'GET' ? {} : JSON.parse(String(options?.body));
      expect(url.searchParams.get('access_token')).toBe(token);
      expect(url.searchParams.get('sign')).toBe(signLingxingReadParameters({ ...params, ...Object.fromEntries(url.searchParams) }, appId));
      if (method === 'GET') expect(options?.body).toBeUndefined();
      else expect(params).toEqual(queryFor(operation));
      return json(payload);
    });
    const client = new LingxingReadClient({ appId, accessToken: token }, { fetchImpl, now: () => 1_760_688_000_000 });
    const result = await client.read(operation, queryFor(operation));
    expect(result.payload).toEqual(payload);
    expect(result.metadata).toMatchObject({ operation, method, path, readOnly: true, httpStatus: 200, businessCode: '0', attempt: 1, elapsedMs: 0 });
    expect(JSON.stringify(result.metadata)).not.toMatch(credentialKeys);
    expect(JSON.stringify(result.metadata)).not.toContain(token);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects every unknown operation before even authenticating', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new LingxingReadClient({ appId, appSecret: 'offline-secret' }, { fetchImpl });
    for (const operation of ['createShipment', 'ship', 'batchEditSellerName', '/erp/sc/data/seller/batchEditSellerName', 'authenticate', 'https://example.com', '/erp/sc/data/seller/lists', 'constructor', '__proto__', 'toString']) {
      await expect(client.read(operation as LingxingReadOperation)).rejects.toMatchObject({ code: 'LINGXING_OPERATION_DENIED' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects credential overrides and parameters unsupported by the seller GET before fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new LingxingReadClient({ appId, appSecret: 'offline-secret' }, { fetchImpl });
    await expect(client.read('getShipmentBoxes', { access_token: 'override' })).rejects.toMatchObject({ code: 'LINGXING_INVALID_REQUEST' });
    await expect(client.read('getInventory', { sign: 'override' })).rejects.toMatchObject({ code: 'LINGXING_INVALID_REQUEST' });
    await expect(client.read('listSellers', { path: '/write' })).rejects.toMatchObject({ code: 'LINGXING_INVALID_REQUEST' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates document queries before authentication and rejects unrestricted or malformed lookups', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new LingxingReadClient({ appId, appSecret: 'offline-secret' }, { fetchImpl });
    const invalid: Array<[LingxingReadOperation, Record<string, unknown>]> = [
      ['getFbaProducts', { sids: [], offset: 0, length: 20 }],
      ['getFbaProducts', { sids: [1, 1], offset: 0, length: 20 }],
      ['getFbaProducts', { sids: [1], offset: -1, length: 20 }],
      ['getFbaProducts', { sids: [1], offset: 0, length: 201 }],
      ['getFbaProducts', { sids: [1], offset: 0, length: 20, search_field: 'msku' }],
      ['getFbaProducts', { sids: [1], offset: 0, length: 20, path: '/write' }],
      ['getLocalProductDetail', {}], ['getLocalProductDetail', { id: 0 }],
      ['getLocalProductDetail', { id: 1, sku: 'different' }], ['getLocalProductDetail', { sku: ' ' }],
      ...[
        { sid: '1,2' }, { sid: 1 }, { search_value: [] }, { search_value: Array.from({ length: 11 }, (_, index) => `M${index}`) },
        { search_value: ['M', 'M'] }, { exact_search: 0 }, { search_field: 'asin' }, { is_delete: 1 }, { length: 1001 }, { path: '/write' },
      ].map((override) => ['getListings', { ...queryFor('getListings'), ...override }] as [LingxingReadOperation, Record<string, unknown>]),
      ['listStockSubjects', { subjectType: 'ALL' }], ['listStockSubjects', { offset: 0 }],
    ];
    for (const [operation, params] of invalid) await expect(client.read(operation, params)).rejects.toMatchObject({ code: 'LINGXING_INVALID_REQUEST' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('provides narrow typed document query helpers without changing the signed wire parameters', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({ code: 0, data: [] }));
    const client = new LingxingReadClient({ appId, accessToken: token }, { fetchImpl });
    await client.getFbaProducts({ sids: [17], search_field: 'msku', search_value: 'seller-SKU', offset: 20, length: 20 });
    await client.getLocalProductDetail({ sku: 'local-SKU' });
    await client.getListings({ sid: '17', search_field: 'seller_sku', search_value: ['seller-SKU'], exact_search: 1, is_delete: 0, offset: 0, length: 100 });
    await client.listStockSubjects();
    expect(fetchImpl.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([
      { sids: [17], search_field: 'msku', search_value: 'seller-SKU', offset: 20, length: 20 }, { sku: 'local-SKU' },
      { sid: '17', search_field: 'seller_sku', search_value: ['seller-SKU'], exact_search: 1, is_delete: 0, offset: 0, length: 100 }, {},
    ]);
  });

  it('authenticates separately using multipart and shares one in-memory token request', async () => {
    let authenticationRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/auth-server/oauth/access-token') {
        authenticationRequests += 1;
        expect(options?.method).toBe('POST');
        expect(options?.body).toBeInstanceOf(FormData);
        expect((options?.body as FormData).get('appId')).toBe(appId);
        expect((options?.body as FormData).get('appSecret')).toBe('offline-secret');
        return json({ code: '200', data: { access_token: token, refresh_token: 'offline-refresh-secret' } });
      }
      expect(url.searchParams.get('access_token')).toBe(token);
      return json({ code: 0, data: [] });
    });
    const client = new LingxingReadClient({ appId, appSecret: 'offline-secret' }, { fetchImpl });
    await Promise.all([client.listSellers(), client.listSellers()]);
    expect(authenticationRequests).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(client)).not.toMatch(/offline-secret|offline-refresh-secret/);
  });

  it('prefers an existing token and never calls authentication', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 0, data: [] }));
    const client = new LingxingReadClient({ appId, appSecret: 'unused-secret', accessToken: token }, { fetchImpl });
    await client.listSellers();
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).pathname).toBe('/erp/sc/data/seller/lists');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never includes echoed secrets, query strings or transport exception text in failures', async () => {
    const values = [appId, token, 'offline-private-secret', 'offline-private-sign'];
    const echoed = `app_key=${appId}&access_token=${token}&sign=offline-private-sign&appSecret=offline-private-secret`;
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(echoed))
      .mockResolvedValueOnce(json({ code: 403, message: echoed }))
      .mockResolvedValueOnce(new Response(echoed))
      .mockResolvedValueOnce(json({ code: echoed, message: echoed }));
    const client = new LingxingReadClient({ appId, accessToken: token }, { fetchImpl });
    for (let index = 0; index < 4; index++) {
      const error = await client.listSellers().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(LingxingReadError);
      const output = `${JSON.stringify(error)} ${(error as Error).message} ${(error as Error).stack}`;
      for (const value of values) expect(output).not.toContain(value);
      expect(output).not.toMatch(credentialKeys);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('sanitizes authentication failures without exposing token response bodies', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 403, message: `${token} ${appId}`, data: { access_token: token } }));
    const client = new LingxingReadClient({ appId, appSecret: 'offline-secret' }, { fetchImpl });
    const error = await client.listSellers().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'LINGXING_AUTH_FAILED' });
    expect(JSON.stringify(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(appId);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries only rate limits with bounded backoff and does not repeat timeouts', async () => {
    const pause = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ code: 3001008 }))
      .mockResolvedValueOnce(json({ code: 0 }, 429)).mockResolvedValueOnce(json({ code: '0', data: [] }));
    const client = new LingxingReadClient({ appId, accessToken: token }, { fetchImpl, pause });
    expect((await client.listSellers()).metadata.attempt).toBe(3);
    expect(pause.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1000, 2000]);
    fetchImpl.mockRejectedValueOnce(new DOMException('secret transport text', 'TimeoutError'));
    await expect(client.listSellers()).rejects.toMatchObject({ code: 'LINGXING_TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    fetchImpl.mockImplementation(async () => json({ code: 3001008 }));
    await expect(client.listSellers()).rejects.toMatchObject({ code: 'LINGXING_RATE_LIMITED', metadata: { attempt: 3 } });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('reports missing credentials without network or implicit credential file reads', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(createLingxingReadClient({}, { fetchImpl })).rejects.toMatchObject({ code: 'LINGXING_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('loads only an explicit credential file and gives complete server environment credentials priority', async () => {
    const path = join(tmpdir(), `scm-lingxing-read-${randomUUID()}.env`);
    await writeFile(path, `LINGXING_APP_ID=${appId}\nLINGXING_APP_SECRET=offline-file-secret\nLINGXING_ACCESS_TOKEN=offline-file-token\n`, { flag: 'wx' });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      expect(new URL(String(input)).searchParams.get('access_token')).toBe('offline-file-token');
      return json({ code: 0, data: [] });
    });
    try {
      const client = await createLingxingReadClient({ LINGXING_ENV_FILE: path }, { fetchImpl });
      await client.listSellers();
      const environmentFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        expect(new URL(String(input)).searchParams.get('access_token')).toBe('offline-environment-token');
        return json({ code: 0, data: [] });
      });
      const environment = await createLingxingReadClient({ LINGXING_APP_ID: appId, LINGXING_ACCESS_TOKEN: 'offline-environment-token', LINGXING_ENV_FILE: `${path}-does-not-exist` }, { fetchImpl: environmentFetch });
      await environment.listSellers();
      await expect(createLingxingReadClient({ LINGXING_ENV_FILE: `${path}-does-not-exist` }, { fetchImpl })).rejects.toMatchObject({ code: 'LINGXING_INVALID_CONFIG' });
    } finally { await unlink(path); }
  });
});

function coordinator(initial: LingxingTokens | null = null) {
  let tokens = initial; const locks = new Map<string, Promise<unknown>>(); const cooldowns = new Map<string, number>();
  const value: LingxingReadCoordinator = {
    async exclusive<T>(key: string, work: () => Promise<T>) { const previous = locks.get(key) ?? Promise.resolve(); const next = previous.catch(() => undefined).then(work); locks.set(key, next); return next; },
    async loadTokens() { return tokens; }, async saveTokens(next) { tokens = structuredClone(next); },
    async readyAt(operation) { return cooldowns.get(operation) ?? 0; }, async cooldown(operation, until) { cooldowns.set(operation, until); },
  };
  return { value, tokens: () => tokens };
}
describe('coordinated production token lifetime and observation', () => {
  it('counts acquisition and renewal separately through a credential-free auth hook', async () => {
    let now = 1_760_688_000_000;
    const onAuthAttempt = vi.fn<(kind: 'acquire' | 'refresh') => Promise<void>>().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ code: 200, data: { access_token: 'first-token', refresh_token: 'first-refresh', expires_in: 120 } }))
      .mockResolvedValueOnce(json({ code: 0 })).mockResolvedValueOnce(json({ code: 200, data: { access_token: 'second-token', refresh_token: 'second-refresh', expires_in: 7199 } })).mockResolvedValueOnce(json({ code: 0 }));
    const client = new LingxingReadClient({ appId, appSecret: 'private-secret' }, { fetchImpl, onAuthAttempt, now: () => now });
    await client.listSellers(); now += 90_000; await client.listSellers();
    expect(onAuthAttempt.mock.calls).toEqual([['acquire'], ['refresh']]);
    expect(JSON.stringify(onAuthAttempt.mock.calls)).not.toMatch(/token|secret|appid/i);
  });
  it('shares persisted tokens across distinct clients and performs a single authentication', async () => {
    const shared = coordinator(); let authCount = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (new URL(String(url)).pathname.includes('/oauth/')) { authCount++; return json({ code: 200, data: { access_token: token, refresh_token: 'shared-refresh', expires_in: 7199 } }); }
      return json({ code: 0, data: [] });
    });
    const a = new LingxingReadClient({ appId, appSecret: 'secret' }, { fetchImpl, coordinator: shared.value });
    const b = new LingxingReadClient({ appId, appSecret: 'secret' }, { fetchImpl, coordinator: shared.value });
    await Promise.all([a.listSellers(), b.listSellers()]);
    expect(authCount).toBe(1); expect(shared.tokens()?.accessToken).toBe(token);
  });
  it('refreshes before expiry, consumes one-use refresh before sending and stores replacement expiry', async () => {
    const now = 1_760_688_000_000;
    const shared = coordinator({ accessToken: 'old-token', refreshToken: 'one-use-refresh', expiresAt: now + 1000, refreshExpiresAt: now + 3_600_000 });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (new URL(String(url)).pathname === '/api/auth-server/oauth/refresh') {
        expect((options?.body as FormData).get('refreshToken')).toBe('one-use-refresh');
        expect(shared.tokens()?.refreshToken).toBeUndefined();
        return json({ code: 200, data: { access_token: 'new-token', refresh_token: 'replacement-refresh', expires_in: '7199' } });
      }
      expect(new URL(String(url)).searchParams.get('access_token')).toBe('new-token'); return json({ code: 0 });
    });
    await new LingxingReadClient({ appId, appSecret: 'secret' }, { fetchImpl, coordinator: shared.value, now: () => now }).listSellers();
    expect(shared.tokens()).toEqual({ accessToken: 'new-token', refreshToken: 'replacement-refresh', expiresAt: now + 7_199_000, refreshExpiresAt: now + 7_200_000 });
  });
  it('renews only code 2001003 once and never mistakes API authorization for token expiry', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ code: 2001003 }))
      .mockResolvedValueOnce(json({ code: 200, data: { access_token: 'renewed-token', expires_in: 7199 } }))
      .mockResolvedValueOnce(json({ code: 0 }));
    await new LingxingReadClient({ appId, appSecret: 'secret', accessToken: 'old-token' }, { fetchImpl }).listSellers();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const denied = vi.fn<typeof fetch>().mockImplementation(async () => json({ code: 2001004 }));
    await expect(new LingxingReadClient({ appId, appSecret: 'secret', accessToken: token }, { fetchImpl: denied }).listSellers()).rejects.toMatchObject({ code: 'LINGXING_READ_FAILED' });
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('records every rate-limited attempt, redacts echoed credential values and supports an explicit request budget', async () => {
    const attempts: unknown[] = []; let requests = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ code: 3001008, message: token }))
      .mockResolvedValueOnce(json({ code: 0, data: { access_token: token, description: token } }));
    const client = new LingxingReadClient({ appId, accessToken: token }, { fetchImpl, pause: async () => {}, beforeRequest: async () => { requests++; }, onAttempt: async (attempt) => { attempts.push(attempt); } });
    await client.listSellers(); expect(requests).toBe(2); expect(attempts).toHaveLength(2); expect(JSON.stringify(attempts)).not.toContain(token);
    const blockedFetch = vi.fn<typeof fetch>();
    await expect(new LingxingReadClient({ appId, accessToken: token }, { fetchImpl: blockedFetch, beforeRequest: async () => { throw new Error('budget reached'); } }).listSellers()).rejects.toThrow('budget reached');
    expect(blockedFetch).not.toHaveBeenCalled();
  });
  it('persists the two-minute uncertain-transport cooldown and does not send another request', async () => {
    const shared = coordinator(); const now = 1_760_688_000_000;
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('private transport', 'TimeoutError'));
    const client = new LingxingReadClient({ appId, accessToken: token }, { fetchImpl, coordinator: shared.value, now: () => now });
    await expect(client.listSellers()).rejects.toMatchObject({ code: 'LINGXING_TIMEOUT' });
    await expect(client.listSellers()).rejects.toMatchObject({ code: 'LINGXING_RATE_LIMITED' }); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
