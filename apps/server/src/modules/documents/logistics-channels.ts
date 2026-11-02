import { readConfig } from '../../config.js';
import { assertLingxingRequestsEnabled, createLingxingReadClient, LingxingReadError } from '../lingxing/read-client.js';

const CACHE_MS = 5 * 60_000;
const PAGE_LENGTH = 200;
const MAX_PAGES = 20;
const enabledValues = new Set<unknown>([1, '1', true]);
const disabledValues = new Set<unknown>([0, '0', false]);
type Channel = { id: string; name: string; enabled: boolean };
type ChannelOptions = { services: string[]; queriedAt: string };
let cached: ChannelOptions | undefined;
let pending: Promise<ChannelOptions> | undefined;

const invalid = () => new LingxingReadError('LINGXING_INVALID_RESPONSE', '领星头程物流渠道列表不完整或格式无效，请重试读取。');

export function parseLogisticsChannelPage(payload: Record<string, unknown>): { items: Channel[]; total: number } {
  const rawTotal = payload.total;
  if (!Array.isArray(payload.data) || !(typeof rawTotal === 'number' || typeof rawTotal === 'string' && /^\d+$/.test(rawTotal))) throw invalid();
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(total) || total < 0 || total > PAGE_LENGTH * MAX_PAGES || payload.data.length > PAGE_LENGTH) throw invalid();
  const seen = new Set<string>();
  const items = payload.data.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0 ? String(row.id) : '';
    const name = typeof row.channel_name === 'string' ? row.channel_name.trim() : '';
    if (!id || id.length > 4000 || !name || name.length > 4000 || seen.has(id)
      || !enabledValues.has(row.enabled) && !disabledValues.has(row.enabled)) throw invalid();
    seen.add(id);
    return { id, name, enabled: enabledValues.has(row.enabled) };
  });
  return { items, total };
}

/** Fetch the complete dictionary before publishing any service suggestions. */
export async function getLogisticsChannelOptions(): Promise<ChannelOptions> {
  const config = readConfig();
  assertLingxingRequestsEnabled(config.LINGXING_REQUESTS_ENABLED);
  if (cached && Date.now() - Date.parse(cached.queriedAt) < CACHE_MS) return cached;
  if (!pending) {
    pending = (async () => {
      const client = await createLingxingReadClient(config);
      const seen = new Set<string>();
      const services = new Set<string>();
      let expectedTotal: number | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await client.listLogisticsChannels({ offset: seen.size, length: PAGE_LENGTH });
        const { items, total } = parseLogisticsChannelPage(result.payload);
        if (expectedTotal !== undefined && total !== expectedTotal || seen.size + items.length > total) throw invalid();
        expectedTotal = total;
        for (const item of items) {
          if (seen.has(item.id)) throw invalid();
          seen.add(item.id);
          if (item.enabled) services.add(item.name);
        }
        if (seen.size === total) {
          const next = { services: [...services], queriedAt: new Date().toISOString() };
          cached = next;
          return next;
        }
        if (!items.length) throw invalid();
      }
      throw invalid();
    })();
  }
  const request = pending;
  try { return await request; } finally { if (pending === request) pending = undefined; }
}

export function logisticsChannelFailureMessage(error: unknown): string {
  if (error instanceof LingxingReadError) {
    if (error.metadata?.httpStatus === 403 || error.metadata?.businessCode === '403') return '领星渠道查询未获授权，请开通“查询头程物流渠道列表”接口权限后重试。';
    if (error.code === 'LINGXING_REQUESTS_DISABLED') return '当前环境已关闭领星查询，可手动填写渠道服务。';
    if (['LINGXING_NOT_CONFIGURED', 'LINGXING_INVALID_CONFIG', 'LINGXING_AUTH_FAILED'].includes(error.code)) return '领星连接配置或授权无效，请管理员检查后重试。';
    if (error.code === 'LINGXING_RATE_LIMITED') return '领星渠道查询达到限流，请稍后重试。';
    if (error.code === 'LINGXING_INVALID_RESPONSE') return '领星渠道目录不完整或格式无效，请重试读取。';
  }
  return '领星渠道目录暂时无法读取，请重试或手动填写已确认的服务。';
}
