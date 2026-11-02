import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ read: vi.fn(), config: vi.fn() }));
vi.mock('../../config.js', () => ({ readConfig: state.config }));
vi.mock('../lingxing/read-client.js', async (original) => ({ ...await original<typeof import('../lingxing/read-client.js')>(),
  createLingxingReadClient: vi.fn(async () => ({ listLogisticsChannels: state.read })),
}));

const item = (overrides = {}) => ({ id: 'test-channel', channel_name: ' 专线服务 ', enabled: 1, method_name: '海派', ...overrides });
const result = (data: unknown[], total = data.length) => ({ payload: { data, total } });

beforeEach(() => {
  vi.resetModules(); state.read.mockReset(); state.config.mockReset(); state.config.mockReturnValue({ LINGXING_REQUESTS_ENABLED: true });
  vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'true');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Lingxing channel service dictionary', () => {
  it('uses actual enabled channel names, deduplicates names, and keeps transport methods separate', async () => {
    const { getLogisticsChannelOptions } = await import('./logistics-channels.js');
    state.read.mockResolvedValue(result([item(), item({ id: 2, channel_name: '专线服务', enabled: '1' }), item({ id: 'disabled', channel_name: '已停用', enabled: 0 })]));
    expect(await getLogisticsChannelOptions()).toEqual({ services: ['专线服务'], queriedAt: expect.any(String) });
    expect(state.read).toHaveBeenCalledWith({ offset: 0, length: 200 });
  });

  it('reads every page using the actual received offset before publishing suggestions', async () => {
    const { getLogisticsChannelOptions } = await import('./logistics-channels.js');
    state.read.mockResolvedValueOnce(result([item()], 3)).mockResolvedValueOnce(result([
      item({ id: 'second', channel_name: '服务二', enabled: true }), item({ id: 'third', channel_name: '已停用', enabled: false }),
    ], 3));
    expect((await getLogisticsChannelOptions()).services).toEqual(['专线服务', '服务二']);
    expect(state.read.mock.calls).toEqual([[{ offset: 0, length: 200 }], [{ offset: 1, length: 200 }]]);
  });

  it('rejects missing or malformed totals, IDs, names, states and oversized pages', async () => {
    const { parseLogisticsChannelPage } = await import('./logistics-channels.js');
    for (const payload of [
      { data: [item()] }, { total: '', data: [] }, { total: true, data: [] }, { total: -1, data: [] },
      { total: 4001, data: [] }, { total: 1, data: {} },
      { total: 1, data: [item({ id: 9007199254740992 })] }, { total: 1, data: [item({ id: '' })] },
      { total: 1, data: [item({ channel_name: '' })] }, { total: 1, data: [item({ channel_name: 'x'.repeat(4001) })] },
      { total: 1, data: [item({ enabled: undefined })] }, { total: 1, data: [item({ enabled: 2 })] },
      { total: 2, data: [item(), item()] }, { total: 201, data: Array.from({ length: 201 }, (_, i) => item({ id: String(i) })) },
    ]) expect(() => parseLogisticsChannelPage(payload)).toThrow('渠道列表不完整');
    expect(parseLogisticsChannelPage({ total: '0', data: [] })).toEqual({ total: 0, items: [] });
  });

  it('rejects changed totals, duplicate IDs across pages, empty partial pages, and count overflow', async () => {
    for (const second of [result([item({ id: 'two' })], 3), result([item()], 2), result([], 2), result([item({ id: 'two' }), item({ id: 'three' })], 2)]) {
      vi.resetModules(); state.read.mockReset();
      const { getLogisticsChannelOptions } = await import('./logistics-channels.js');
      state.read.mockResolvedValueOnce(result([item()], 2)).mockResolvedValueOnce(second);
      await expect(getLogisticsChannelOptions()).rejects.toMatchObject({ code: 'LINGXING_INVALID_RESPONSE' });
      state.read.mockResolvedValueOnce(result([item({ channel_name: '重新读取' })]));
      expect((await getLogisticsChannelOptions()).services).toEqual(['重新读取']);
    }
  });

  it('caps the page budget and never publishes partial data', async () => {
    const { getLogisticsChannelOptions } = await import('./logistics-channels.js');
    state.read.mockImplementation(async ({ offset }: { offset: number }) => result([item({ id: String(offset + 1) })], 21));
    await expect(getLogisticsChannelOptions()).rejects.toMatchObject({ code: 'LINGXING_INVALID_RESPONSE' });
    expect(state.read).toHaveBeenCalledTimes(20);
  });

  it('coalesces concurrent reads, expires success cache, retries failures and honors outbound disable with cache', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T01:00:00Z'));
    const { getLogisticsChannelOptions } = await import('./logistics-channels.js');
    state.read.mockResolvedValue(result([item()]));
    const [first, second] = await Promise.all([getLogisticsChannelOptions(), getLogisticsChannelOptions()]);
    expect(first).toEqual(second); expect(state.read).toHaveBeenCalledTimes(1);
    await getLogisticsChannelOptions(); expect(state.read).toHaveBeenCalledTimes(1);
    state.config.mockReturnValueOnce({ LINGXING_REQUESTS_ENABLED: false });
    await expect(getLogisticsChannelOptions()).rejects.toMatchObject({ code: 'LINGXING_REQUESTS_DISABLED' });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    state.read.mockRejectedValueOnce(new Error('private upstream failure'));
    await expect(getLogisticsChannelOptions()).rejects.toThrow('private upstream failure');
    await getLogisticsChannelOptions(); expect(state.read).toHaveBeenCalledTimes(3);
  });

  it('maps permission, configuration and unknown failures to safe actionable messages', async () => {
    const { logisticsChannelFailureMessage } = await import('./logistics-channels.js');
    const { LingxingReadError: CurrentReadError } = await import('../lingxing/read-client.js');
    const denied = new CurrentReadError('LINGXING_READ_FAILED', 'private token', {
      operation: 'listLogisticsChannels', method: 'POST', path: '/erp/sc/data/local_inventory/channelList', requestedAt: '', elapsedMs: 0, attempt: 1,
      httpStatus: 200, businessCode: '403', readOnly: true,
    });
    expect(logisticsChannelFailureMessage(denied)).toContain('查询头程物流渠道列表');
    expect(logisticsChannelFailureMessage(new CurrentReadError('LINGXING_NOT_CONFIGURED', 'private token'))).toContain('连接配置或授权无效');
    expect(logisticsChannelFailureMessage(new Error('private token'))).not.toContain('private token');
  });
});
