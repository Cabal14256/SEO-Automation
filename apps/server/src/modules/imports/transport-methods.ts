import type { TransportMethodsResponse } from '@scm/contracts';
import { readConfig } from '../../config.js';
import { assertLingxingRequestsEnabled, createLingxingReadClient, LingxingReadError } from '../lingxing/read-client.js';

const CACHE_MS = 5 * 60_000;
const enabledValues = new Set<unknown>([1, '1', true]);
const disabledValues = new Set<unknown>([0, '0', false]);
let cached: TransportMethodsResponse | undefined;
let pending: Promise<TransportMethodsResponse> | undefined;

export function parseTransportMethods(payload: Record<string, unknown>, queriedAt: string): TransportMethodsResponse {
  const invalid = () => new LingxingReadError('LINGXING_INVALID_RESPONSE', '领星运输方式列表不完整或格式无效，请重试读取。');
  if (!Array.isArray(payload.data) || payload.total === null || payload.total === undefined ||
      !Number.isSafeInteger(Number(payload.total)) || Number(payload.total) !== payload.data.length) throw invalid();
  const seen = new Set<string>();
  const items = payload.data.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw invalid();
    const row = value as Record<string, unknown>;
    const id = typeof row.method_id === 'string' ? row.method_id.trim() : typeof row.method_id === 'number' && Number.isSafeInteger(row.method_id) ? String(row.method_id) : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!id || !name || seen.has(id) || (!enabledValues.has(row.enabled) && !disabledValues.has(row.enabled))) throw invalid();
    seen.add(id);
    return { id, name, enabled: enabledValues.has(row.enabled), remark: typeof row.remark === 'string' ? row.remark : '' };
  });
  return { items, queriedAt };
}

export async function getTransportMethods(): Promise<TransportMethodsResponse> {
  const config = readConfig();
  assertLingxingRequestsEnabled(config.LINGXING_REQUESTS_ENABLED);
  if (cached && Date.now() - Date.parse(cached.queriedAt) < CACHE_MS) return cached;
  if (!pending) {
    pending = (async () => {
      const client = await createLingxingReadClient(config);
      const result = await client.listTransportMethods();
      const next = parseTransportMethods(result.payload, new Date().toISOString());
      cached = next;
      return next;
    })();
  }
  try { return await pending; } finally { pending = undefined; }
}
