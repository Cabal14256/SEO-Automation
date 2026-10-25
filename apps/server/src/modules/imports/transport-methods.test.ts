import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../lingxing/read-client.js', async (original) => ({ ...await original<typeof import('../lingxing/read-client.js')>(),
  createLingxingReadClient: vi.fn(async () => ({ listTransportMethods: state.read })),
}));
import { getTransportMethods, parseTransportMethods } from './transport-methods.js';

const at = '2026-10-24T10:00:00.000Z';
const item = (overrides = {}) => ({ method_id: 'test-method', name: '海派', enabled: 1, remark: '', ...overrides });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('Lingxing transport methods', () => {
  it('keeps enabled and disabled actual names, without exposing account metadata or guessing aliases', () => {
    const result = parseTransportMethods({ total: '2', data: [item({ creator_name: 'private' }), item({ method_id: 'disabled', name: '海卡', enabled: '0' })] }, at);
    expect(result).toEqual({ queriedAt: at, items: [{ id: 'test-method', name: '海派', enabled: true, remark: '' }, { id: 'disabled', name: '海卡', enabled: false, remark: '' }] });
  });
  it('rejects incomplete lists, unsafe numeric IDs, unknown states, missing names and duplicate IDs', () => {
    for (const payload of [
      { total: 2, data: [item()] }, { data: [item()] }, { total: 1, data: [item({ method_id: 241338472498582016 })] },
      { total: 1, data: [item({ enabled: 2 })] }, { total: 1, data: [item({ name: '' })] }, { total: 2, data: [item(), item()] },
    ]) expect(() => parseTransportMethods(payload, at)).toThrow('运输方式列表不完整');
  });
  it('coalesces concurrent requests, expires cached data, retries failures, and honors outbound prohibition even with cache', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(at));
    state.read.mockResolvedValue({ payload: { total: 1, data: [item()] } });
    const [first, second] = await Promise.all([getTransportMethods(), getTransportMethods()]);
    expect(first).toEqual(second); expect(state.read).toHaveBeenCalledTimes(1);
    await getTransportMethods(); expect(state.read).toHaveBeenCalledTimes(1);
    vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
    await expect(getTransportMethods()).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    vi.unstubAllEnvs(); vi.advanceTimersByTime(5 * 60_000 + 1);
    state.read.mockRejectedValueOnce(new Error('offline-test'));
    await expect(getTransportMethods()).rejects.toThrow('offline-test');
    await getTransportMethods(); expect(state.read).toHaveBeenCalledTimes(3);
  });
});
