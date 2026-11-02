import { describe, expect, it, vi } from 'vitest';
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../imports/transport-methods.js', () => ({ getTransportMethods: vi.fn() }));
import { countryOptions } from './options.js';

const seller = (country: string, extra = {}) => ({ lingxingData: { country, present: true, status: '1', observedAt: '2026-11-02T00:00:00Z', ...extra } });
describe('service mapping countries from the synchronized Lingxing catalog', () => {
  it('normalizes and deduplicates real catalog countries while excluding removed and unauthorized shops', () => {
    expect(countryOptions([seller('美国'), seller('US'), seller('英国'), seller('uk'), seller('德国'), seller('CA'),
      seller('法国', { present: false }), seller('日本', { status: '0' }), seller('西班牙', { observedAt: '' }), seller('未知'), { lingxingData: null },
    ])).toEqual({ status: 'available', items: [{ code: 'CA', name: '加拿大' }, { code: 'DE', name: '德国' }, { code: 'GB', name: '英国' }, { code: 'US', name: '美国' }] });
  });
  it('requires a successful local Lingxing observation instead of using manual seller metadata or invented defaults', () => {
    expect(countryOptions([])).toMatchObject({ status: 'unavailable', items: [], message: expect.stringContaining('同步') });
    expect(countryOptions([{ lingxingData: null }, seller('ZZ')])).toMatchObject({ status: 'unavailable', items: [] });
  });
});
