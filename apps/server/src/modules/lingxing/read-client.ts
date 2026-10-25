import { createCipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import type { AppConfig } from '../../config.js';

const BASE_URL = 'https://openapi.lingxing.com';
const AUTH_PATH = '/api/auth-server/oauth/access-token';
const OPERATIONS = Object.freeze({
  listSellers: { method: 'GET', path: '/erp/sc/data/seller/lists' },
  listShipments: { method: 'POST', path: '/erp/sc/data/fba_report/shipmentList' },
  listInboundShipments: { method: 'POST', path: '/erp/sc/routing/storage/shipment/getInboundShipmentList' },
  listLogisticsChannels: { method: 'POST', path: '/erp/sc/data/local_inventory/channelList' },
  listTransportMethods: { method: 'POST', path: '/basicOpen/businessConfig/transportMethod/list' },
  getShipmentDetails: { method: 'POST', path: '/amzStaServer/openapi/inbound-shipment/shipmentDetailList' },
  getShipmentBoxes: { method: 'POST', path: '/amzStaServer/openapi/inbound-shipment/listShipmentBoxes' },
  getInventory: { method: 'POST', path: '/erp/sc/routing/data/local_inventory/inventoryDetails' },
  getFbaProducts: { method: 'POST', path: '/erp/sc/routing/fba/shipment/getFbaProductList' },
  getListings: { method: 'POST', path: '/erp/sc/data/mws/listing' },
  getLocalProductDetail: { method: 'POST', path: '/erp/sc/routing/data/local_inventory/productInfo' },
  listStockSubjects: { method: 'POST', path: '/basicOpen/stockSubject/list' },
} as const);

export type LingxingReadOperation = keyof typeof OPERATIONS;
export type LingxingFbaProductQuery = {
  sids: readonly number[];
  search_field?: 'msku' | 'fnsku' | 'asin' | 'sku' | 'title' | 'product_name';
  search_value?: string;
  offset: number;
  length: number;
};
export type LingxingLocalProductQuery = { id?: number; sku?: string; sku_identifier?: string };
export type LingxingListingQuery = { sid: string; search_field: 'seller_sku'; search_value: readonly string[]; exact_search: 1; is_delete: 0; offset: number; length: number };
export type LingxingStockSubjectQuery = { subjectType?: 'PLATFORM' | 'TEAM'; keyword?: string };
export type LingxingReadConfig = Partial<Pick<AppConfig,
  'LINGXING_REQUESTS_ENABLED' | 'LINGXING_APP_ID' | 'LINGXING_APP_SECRET' | 'LINGXING_ACCESS_TOKEN' | 'LINGXING_ENV_FILE' | 'LINGXING_TIMEOUT_MS' | 'DATABASE_URL' | 'BETTER_AUTH_SECRET'>>;
export type LingxingTokens = { accessToken: string; refreshToken?: string; expiresAt?: number; refreshExpiresAt?: number };
export interface LingxingReadCoordinator {
  exclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
  loadTokens(): Promise<LingxingTokens | null>;
  saveTokens(tokens: LingxingTokens): Promise<void>;
  readyAt(operation: string): Promise<number>;
  cooldown(operation: string, until: number): Promise<void>;
}
export type LingxingReadAttempt = { metadata: LingxingReadMetadata; payload: unknown; errorCode?: LingxingReadErrorCode };
export type LingxingReadDependencies = { fetchImpl?: typeof fetch; now?: () => number; pause?: (milliseconds: number) => Promise<void>;
  coordinator?: LingxingReadCoordinator; beforeRequest?: (operation: LingxingReadOperation) => Promise<void>;
  onAuthAttempt?: (kind: 'acquire' | 'refresh') => Promise<void>;
  onAttempt?: (attempt: LingxingReadAttempt) => Promise<void> };
export type LingxingReadPayload = { code: string | number; data?: unknown; [key: string]: unknown };
export type LingxingReadMetadata = {
  operation: LingxingReadOperation;
  method: 'GET' | 'POST';
  path: (typeof OPERATIONS)[LingxingReadOperation]['path'];
  requestedAt: string;
  elapsedMs: number;
  attempt: number;
  httpStatus: number;
  businessCode: string;
  readOnly: true;
};
export type LingxingReadResult = { payload: LingxingReadPayload; metadata: LingxingReadMetadata };
export type LingxingReadErrorCode = 'LINGXING_REQUESTS_DISABLED' | 'LINGXING_NOT_CONFIGURED' | 'LINGXING_INVALID_CONFIG' | 'LINGXING_OPERATION_DENIED'
  | 'LINGXING_INVALID_REQUEST' | 'LINGXING_AUTH_FAILED' | 'LINGXING_NETWORK_ERROR' | 'LINGXING_TIMEOUT'
  | 'LINGXING_INVALID_RESPONSE' | 'LINGXING_RATE_LIMITED' | 'LINGXING_READ_FAILED';

export class LingxingReadError extends Error {
  constructor(public readonly code: LingxingReadErrorCode, message: string, public readonly metadata?: LingxingReadMetadata) {
    super(message);
    this.name = 'LingxingReadError';
  }
}

export function assertLingxingRequestsEnabled(enabled = true) {
  // Check the process setting as well as the factory's parsed configuration:
  // direct clients and clients created before an offline switch cannot bypass it.
  if (!enabled || process.env.LINGXING_REQUESTS_ENABLED === 'false') {
    throw new LingxingReadError('LINGXING_REQUESTS_DISABLED', '当前环境已禁止领星外部请求，包括鉴权和令牌续约。');
  }
}

function nonBlank(value: string | undefined) { return value?.trim() ? value : undefined; }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function businessCode(value: unknown) {
  const code = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^-?\d{1,16}$/.test(code) ? code : 'unknown';
}
function timeout(error: unknown) { return error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name); }

// These new profile reads have deliberately small, explicit request schemas.
// Runtime callers cannot turn them into a broad search or override a path.
function validateDocumentReadParameters(operation: LingxingReadOperation, params: Readonly<Record<string, unknown>>) {
  const only = (keys: string[]) => Object.keys(params).every((key) => keys.includes(key));
  const positiveId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
  let valid = true;
  if (operation === 'getFbaProducts') valid = only(['sids', 'search_field', 'search_value', 'offset', 'length'])
    && Array.isArray(params.sids) && params.sids.length > 0 && params.sids.length <= 20 && params.sids.every(positiveId)
    && new Set(params.sids).size === params.sids.length
    && typeof params.offset === 'number' && Number.isSafeInteger(params.offset) && params.offset >= 0
    && typeof params.length === 'number' && Number.isSafeInteger(params.length) && params.length > 0 && params.length <= 200
    && (params.search_field === undefined && params.search_value === undefined
      || ['msku', 'fnsku', 'asin', 'sku', 'title', 'product_name'].includes(String(params.search_field)) && text(params.search_value));
  if (operation === 'getLocalProductDetail') valid = only(['id', 'sku', 'sku_identifier']) && Object.keys(params).length === 1
    && (positiveId(params.id) || text(params.sku) || text(params.sku_identifier));
  if (operation === 'getListings') valid = only(['sid', 'search_field', 'search_value', 'exact_search', 'is_delete', 'offset', 'length'])
    && typeof params.sid === 'string' && /^\d+$/.test(params.sid) && positiveId(Number(params.sid))
    && params.search_field === 'seller_sku' && params.exact_search === 1 && params.is_delete === 0
    && Array.isArray(params.search_value) && params.search_value.length > 0 && params.search_value.length <= 10
    && params.search_value.every(text) && new Set(params.search_value).size === params.search_value.length
    && typeof params.offset === 'number' && Number.isSafeInteger(params.offset) && params.offset >= 0
    && typeof params.length === 'number' && Number.isSafeInteger(params.length) && params.length > 0 && params.length <= 1000;
  if (operation === 'listStockSubjects') valid = only(['subjectType', 'keyword'])
    && (params.subjectType === undefined || ['PLATFORM', 'TEAM'].includes(String(params.subjectType)))
    && (params.keyword === undefined || text(params.keyword));
  if (!valid) throw new LingxingReadError('LINGXING_INVALID_REQUEST', '领星单据资料查询参数无效。');
}

// Keep this protocol identical to scripts/lingxing/probe.mjs. Its independently
// verified MD5/AES vector is also exercised by this adapter's offline tests.
export function signLingxingReadParameters(params: Readonly<Record<string, unknown>>, appId: string) {
  const key = Buffer.from(appId, 'utf8');
  if (![16, 24, 32].includes(key.length)) throw new LingxingReadError('LINGXING_INVALID_CONFIG', '领星应用标识配置无效，请管理员核对。');
  const source = Object.keys(params).filter((name) => params[name] !== '' && params[name] !== undefined && name !== 'sign').sort()
    .map((name) => `${name}=${typeof params[name] === 'object' ? JSON.stringify(params[name]) : String(params[name])}`).join('&');
  const digest = createHash('md5').update(source, 'utf8').digest('hex').toUpperCase();
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([cipher.update(digest, 'utf8'), cipher.final()]).toString('base64');
}

export class LingxingReadClient {
  #appId: string;
  #appSecret: string | undefined;
  #token: string | undefined;
  #fetch: typeof fetch;
  #now: () => number;
  #pause: (milliseconds: number) => Promise<void>;
  #timeoutMs: number;
  #authenticating: Promise<void> | null = null;
  #tokens: LingxingTokens;
  #coordinator: LingxingReadCoordinator | undefined;
  #beforeRequest: LingxingReadDependencies['beforeRequest'];
  #onAttempt: LingxingReadDependencies['onAttempt'];
  #onAuthAttempt: LingxingReadDependencies['onAuthAttempt'];
  #requestsEnabled: boolean;
  #secrets = new Set<string>();

  constructor(credentials: { appId: string; appSecret?: string; accessToken?: string; timeoutMs?: number; requestsEnabled?: boolean }, dependencies: LingxingReadDependencies = {}) {
    if (!nonBlank(credentials.appId) || (!nonBlank(credentials.appSecret) && !nonBlank(credentials.accessToken))) {
      throw new LingxingReadError('LINGXING_NOT_CONFIGURED', '尚未配置领星只读连接，请管理员配置应用标识和密钥或有效令牌。');
    }
    signLingxingReadParameters({}, credentials.appId);
    this.#appId = credentials.appId;
    this.#appSecret = nonBlank(credentials.appSecret);
    this.#token = nonBlank(credentials.accessToken);
    this.#tokens = { accessToken: this.#token ?? '' };
    this.#coordinator = dependencies.coordinator;
    this.#beforeRequest = dependencies.beforeRequest;
    this.#onAttempt = dependencies.onAttempt;
    this.#onAuthAttempt = dependencies.onAuthAttempt;
    this.#requestsEnabled = credentials.requestsEnabled ?? true;
    for (const value of [credentials.appId, credentials.appSecret, credentials.accessToken]) if (value) this.#secrets.add(value);
    const transport = dependencies.fetchImpl ?? fetch;
    this.#fetch = (input, init) => {
      assertLingxingRequestsEnabled(this.#requestsEnabled);
      return transport(input, init);
    };
    this.#now = dependencies.now ?? Date.now;
    this.#pause = dependencies.pause ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
    this.#timeoutMs = credentials.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 60_000) throw new LingxingReadError('LINGXING_INVALID_CONFIG', '领星请求超时配置无效。');
  }

  listSellers() { return this.read('listSellers'); }
  listShipments(params: Readonly<Record<string, unknown>>) { return this.read('listShipments', params); }
  listInboundShipments(params: Readonly<Record<string, unknown>>) { return this.read('listInboundShipments', params); }
  listLogisticsChannels(params: Readonly<Record<string, unknown>>) { return this.read('listLogisticsChannels', params); }
  listTransportMethods(params: Readonly<Record<string, unknown>> = {}) { return this.read('listTransportMethods', params); }
  getShipmentDetails(params: Readonly<Record<string, unknown>>) { return this.read('getShipmentDetails', params); }
  getShipmentBoxes(params: Readonly<Record<string, unknown>>) { return this.read('getShipmentBoxes', params); }
  getInventory(params: Readonly<Record<string, unknown>>) { return this.read('getInventory', params); }
  getFbaProducts(params: LingxingFbaProductQuery) { return this.read('getFbaProducts', params); }
  getListings(params: LingxingListingQuery) { return this.read('getListings', params); }
  getLocalProductDetail(params: LingxingLocalProductQuery) { return this.read('getLocalProductDetail', params); }
  listStockSubjects(params: LingxingStockSubjectQuery = {}) { return this.read('listStockSubjects', params); }

  redact(value: unknown): unknown {
    if (typeof value === 'string') {
      let result = value;
      for (const secret of this.#secrets) result = result.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]');
      return result.replace(/((?:access_token|refresh_token|appSecret|app_key|sign)=)[^&\s]+/gi, '$1[REDACTED]');
    }
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (object(value)) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
      [key, /^(access_token|refresh_token|refreshToken|appSecret|app_secret|appId|app_key|sign)$/i.test(key) ? '[REDACTED]' : this.redact(entry)]));
    return value;
  }

  async #authenticate(force = false) {
    assertLingxingRequestsEnabled(this.#requestsEnabled);
    if (!this.#coordinator && !force && this.#token && (!this.#tokens.expiresAt || this.#tokens.expiresAt > this.#now() + 60_000)) return;
    if (this.#authenticating) return this.#authenticating;
    const authenticate = async () => {
      const cached = await this.#coordinator?.loadTokens();
      if (cached && (!force || cached.accessToken !== this.#token) && (!cached.expiresAt || cached.expiresAt > this.#now() + 60_000)) {
        this.#tokens = cached; this.#token = cached.accessToken;
        this.#secrets.add(cached.accessToken); if (cached.refreshToken) this.#secrets.add(cached.refreshToken);
        return;
      }
      if (cached) this.#tokens = cached;
      if (!cached && !force && this.#token && (!this.#tokens.expiresAt || this.#tokens.expiresAt > this.#now() + 60_000)) return;
      const canRefresh = this.#tokens.refreshToken && (this.#tokens.refreshExpiresAt ?? 0) > this.#now();
      if (!canRefresh && !this.#appSecret) throw new LingxingReadError('LINGXING_AUTH_FAILED', '领星令牌已失效，请管理员更新服务端凭据。');
      const form = new FormData();
      form.set('appId', this.#appId);
      if (canRefresh) form.set('refreshToken', this.#tokens.refreshToken!);
      else form.set('appSecret', this.#appSecret!);
      if (canRefresh) {
        // Refresh tokens are one-use. Persist consumption before the request,
        // so a timeout or worker crash cannot replay an uncertain refresh.
        const remaining: LingxingTokens = { accessToken: this.#tokens.accessToken, ...(this.#tokens.expiresAt ? { expiresAt: this.#tokens.expiresAt } : {}) };
        this.#tokens = remaining;
        await this.#coordinator?.saveTokens(remaining);
      }
      let response: Response;
      await this.#onAuthAttempt?.(canRefresh ? 'refresh' : 'acquire');
      try {
        response = await this.#fetch(new URL(canRefresh ? '/api/auth-server/oauth/refresh' : AUTH_PATH, BASE_URL), { method: 'POST', body: form,
          redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (error) {
        if (error instanceof LingxingReadError) throw error;
        throw new LingxingReadError(timeout(error) ? 'LINGXING_TIMEOUT' : 'LINGXING_AUTH_FAILED', '领星鉴权未完成，请核对配置或稍后重试。');
      }
      const body: unknown = await response.json().catch(() => null);
      const payload = object(body);
      const token = object(payload?.data)?.access_token;
      const refreshToken = object(payload?.data)?.refresh_token;
      if (typeof token === 'string') this.#secrets.add(token);
      if (typeof refreshToken === 'string') this.#secrets.add(refreshToken);
      if (canRefresh && ['2001008', '2001009'].includes(businessCode(payload?.code)) && this.#appSecret) {
        this.#tokens = { accessToken: '' }; this.#token = undefined;
        // Never repeat a consumed refresh token. Acquire a new token once.
        const next = new FormData(); next.set('appId', this.#appId); next.set('appSecret', this.#appSecret);
        await this.#onAuthAttempt?.('acquire');
        try { response = await this.#fetch(new URL(AUTH_PATH, BASE_URL), { method: 'POST', body: next, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) }); }
        catch (error) { if (error instanceof LingxingReadError) throw error; throw new LingxingReadError('LINGXING_AUTH_FAILED', '领星鉴权未完成，请稍后重试。'); }
        return this.#acceptAuthentication(response);
      }
      if (!response.ok || businessCode(payload?.code) !== '200' || typeof token !== 'string' || !nonBlank(token)) {
        throw new LingxingReadError('LINGXING_AUTH_FAILED', '领星鉴权失败，请管理员核对连接配置和授权。');
      }
      await this.#storeAuthentication(payload!);
    };
    this.#authenticating = this.#coordinator ? this.#coordinator.exclusive('token', authenticate) : authenticate();
    try { await this.#authenticating; }
    finally { this.#authenticating = null; }
  }

  async #acceptAuthentication(response: Response) {
    const payload = object(await response.json().catch(() => null));
    if (!response.ok || businessCode(payload?.code) !== '200' || typeof object(payload?.data)?.access_token !== 'string') throw new LingxingReadError('LINGXING_AUTH_FAILED', '领星鉴权失败，请管理员核对连接配置。');
    await this.#storeAuthentication(payload!);
  }

  async #storeAuthentication(payload: Record<string, unknown>) {
    const data = object(payload.data)!;
    const token = String(data.access_token);
    const seconds = Number(data.expires_in);
    const refresh = typeof data.refresh_token === 'string' ? nonBlank(data.refresh_token) : undefined;
    this.#tokens = { accessToken: token, ...(refresh ? { refreshToken: refresh, refreshExpiresAt: this.#now() + 7_200_000 } : {}),
      ...(Number.isFinite(seconds) && seconds > 0 ? { expiresAt: this.#now() + seconds * 1000 } : {}) };
    this.#token = token; this.#secrets.add(token); if (refresh) this.#secrets.add(refresh);
    await this.#coordinator?.saveTokens(this.#tokens);
  }

  async read(operation: LingxingReadOperation, params: Readonly<Record<string, unknown>> = {}): Promise<LingxingReadResult> {
    assertLingxingRequestsEnabled(this.#requestsEnabled);
    // Runtime validation is essential: callers may be JavaScript or untrusted
    // deserialized input. It runs before authentication and every network call.
    if (!Object.hasOwn(OPERATIONS, operation)) throw new LingxingReadError('LINGXING_OPERATION_DENIED', '该操作不在领星只读查询白名单中。');
    if (!object(params) || Object.keys(params).some((key) => /^(access_token|refresh_token|app_key|appId|appSecret|app_secret|sign|timestamp)$/i.test(key))
      || (operation === 'listSellers' && Object.keys(params).length)) throw new LingxingReadError('LINGXING_INVALID_REQUEST', '领星只读查询参数无效。');
    validateDocumentReadParameters(operation, params);
    let body: string;
    try { body = JSON.stringify(params); }
    catch { throw new LingxingReadError('LINGXING_INVALID_REQUEST', '领星只读查询参数无法编码。'); }
    const execute = () => this.#execute(operation, params, body);
    return this.#coordinator ? this.#coordinator.exclusive(OPERATIONS[operation].path, execute) : execute();
  }

  async #execute(operation: LingxingReadOperation, params: Readonly<Record<string, unknown>>, body: string): Promise<LingxingReadResult> {
    const readyAt = await this.#coordinator?.readyAt(OPERATIONS[operation].path) ?? 0;
    if (readyAt > this.#now()) throw new LingxingReadError('LINGXING_RATE_LIMITED', '上次领星请求尚在恢复等待期，请稍后重试。');
    await this.#authenticate();
    const definition = OPERATIONS[operation];
    let refreshed = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      assertLingxingRequestsEnabled(this.#requestsEnabled);
      await this.#beforeRequest?.(operation);
      const started = this.#now();
      const common = { access_token: this.#token!, app_key: this.#appId, timestamp: String(Math.floor(started / 1000)) };
      const signature = signLingxingReadParameters({ ...params, ...common }, this.#appId);
      this.#secrets.add(signature);
      const url = new URL(definition.path, BASE_URL);
      url.search = new URLSearchParams({ ...common, sign: signature }).toString();
      let response: Response;
      try {
        response = await this.#fetch(url, { method: definition.method, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
          ...(definition.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body } : {}) });
      } catch (error) {
        if (error instanceof LingxingReadError) throw error;
        const code = timeout(error) ? 'LINGXING_TIMEOUT' : 'LINGXING_NETWORK_ERROR';
        const metadata: LingxingReadMetadata = { operation, method: definition.method, path: definition.path, requestedAt: new Date(started).toISOString(), elapsedMs: Math.max(0, this.#now() - started), attempt, httpStatus: 0, businessCode: 'unknown', readOnly: true };
        await this.#coordinator?.cooldown(definition.path, this.#now() + 120_000);
        await this.#onAttempt?.({ metadata, payload: null, errorCode: code });
        throw new LingxingReadError(code, '领星只读查询未完成，请稍后重试。', metadata);
      }
      const payload = object(await response.json().catch(() => null));
      const code = businessCode(payload?.code);
      const metadata: LingxingReadMetadata = { operation, method: definition.method, path: definition.path,
        requestedAt: new Date(started).toISOString(), elapsedMs: Math.max(0, this.#now() - started), attempt,
        httpStatus: response.status, businessCode: code, readOnly: true };
      const limited = response.status === 429 || code === '3001008';
      await this.#onAttempt?.({ metadata, payload: this.redact(payload), ...((limited || !response.ok || code !== '0') ? { errorCode: limited ? 'LINGXING_RATE_LIMITED' : 'LINGXING_READ_FAILED' } : {}) });
      if (limited && attempt < 3) { await this.#pause(1000 * 2 ** (attempt - 1)); continue; }
      if (limited) throw new LingxingReadError('LINGXING_RATE_LIMITED', '领星只读查询达到限流，请稍后重试。', metadata);
      if (!payload || code === 'unknown') throw new LingxingReadError('LINGXING_INVALID_RESPONSE', '领星返回了无法识别的查询结果。', metadata);
      if (code === '2001003' && !refreshed && attempt < 3) { refreshed = true; await this.#authenticate(true); continue; }
      if (!response.ok || code !== '0') throw new LingxingReadError('LINGXING_READ_FAILED', `领星只读查询失败（HTTP ${response.status}，业务码 ${code}）。`, metadata);
      return { payload: payload as LingxingReadPayload, metadata };
    }
    throw new LingxingReadError('LINGXING_READ_FAILED', '领星只读查询未完成。');
  }
}

export async function createLingxingReadClient(config: LingxingReadConfig, dependencies: LingxingReadDependencies = {}) {
  assertLingxingRequestsEnabled(config.LINGXING_REQUESTS_ENABLED);
  const environmentAppId = nonBlank(config.LINGXING_APP_ID);
  const environmentSecret = nonBlank(config.LINGXING_APP_SECRET);
  const environmentToken = nonBlank(config.LINGXING_ACCESS_TOKEN);
  if (environmentAppId && (environmentSecret || environmentToken)) {
    if (!dependencies.coordinator && config.DATABASE_URL && config.BETTER_AUTH_SECRET) dependencies = { ...dependencies,
      coordinator: await (await import('./coordination.js')).createLingxingCoordinator(environmentAppId, config.BETTER_AUTH_SECRET) };
    return new LingxingReadClient({ appId: environmentAppId, appSecret: environmentSecret, accessToken: environmentToken,
      timeoutMs: config.LINGXING_TIMEOUT_MS, requestsEnabled: config.LINGXING_REQUESTS_ENABLED }, dependencies);
  }
  let file: Record<string, string> = {};
  if (nonBlank(config.LINGXING_ENV_FILE)) {
    try {
      const bytes = await readFile(config.LINGXING_ENV_FILE!);
      if (bytes.byteLength > 64 * 1024) throw new Error('ENV_FILE_LIMIT');
      file = parse(bytes);
    } catch { throw new LingxingReadError('LINGXING_INVALID_CONFIG', '无法读取明确配置的领星凭据文件，请管理员核对服务端配置。'); }
  }
  const appId = environmentAppId ?? nonBlank(file.LINGXING_APP_ID) ?? '';
  if (!dependencies.coordinator && config.DATABASE_URL && config.BETTER_AUTH_SECRET && appId) dependencies = { ...dependencies,
    coordinator: await (await import('./coordination.js')).createLingxingCoordinator(appId, config.BETTER_AUTH_SECRET) };
  return new LingxingReadClient({
    appId,
    appSecret: environmentSecret ?? nonBlank(file.LINGXING_APP_SECRET),
    accessToken: environmentToken ?? (environmentSecret ? undefined : nonBlank(file.LINGXING_ACCESS_TOKEN)),
    timeoutMs: config.LINGXING_TIMEOUT_MS,
    requestsEnabled: config.LINGXING_REQUESTS_ENABLED,
  }, dependencies);
}
