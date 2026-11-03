import { describe, expect, it } from 'vitest';
import { documentInvoiceFileName, type InvoiceFileNameData } from './invoice-file-name.js';

function invoice(snapshot = { shop: '16店铺', country: 'US', channel: 'UPS' }, addressCode = 'ONT8'): InvoiceFileNameData {
  return { members: [{ demand: { snapshot } }], fields: { addressCode, service: '丰信渠道服务', countryCode: 'GB' } } as InvoiceFileNameData;
}

describe('invoice business file names matching the reference file list', () => {
  it('uses a configured code verbatim and falls back to the saved shop when cleared', () => {
    const data = invoice(), before = structuredClone(data), at = new Date('2026-11-03T10:00:00Z');
    expect(documentInvoiceFileName(data, 1, at, '001')).toBe('11.3号001-US-UPS-1件（ONT8）.xlsx');
    expect(documentInvoiceFileName(data, 1, at, '')).toBe('11.3号16店铺-US-UPS-1件（ONT8）.xlsx');
    expect(data).toEqual(before);
  });
  it('uses the Shanghai generation day and the saved shop, country, business channel and address code', () => {
    const data = invoice();
    expect(documentInvoiceFileName(data, 2, new Date('2026-10-30T15:59:59Z'))).toBe('10.30号16店铺-US-UPS-2件（ONT8）.xlsx');
    expect(documentInvoiceFileName(data, 2, new Date('2026-10-30T16:00:00Z'))).toBe('10.31号16店铺-US-UPS-2件（ONT8）.xlsx');
    expect(documentInvoiceFileName(data, 3, new Date('2027-01-01T16:00:00Z'))).toBe('1.2号16店铺-US-UPS-3件（ONT8）.xlsx');
  });

  it('sanitizes Windows filename characters and retains every field within the archive name limit', () => {
    const name = documentInvoiceFileName(invoice({ shop: ' 店/铺:*?"<>|\\\u0000\n ', country: 'US', channel: '海运'.repeat(100) }, 'ADDR/'.repeat(100)), 999, new Date('2026-10-31T00:00:00Z'));
    expect(name).not.toMatch(/[\\/:*?"<>|\p{Cc}]/u);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name).toMatch(/^10\.31号店_铺/); expect(name).toContain('-US-'); expect(name).toContain('-999件（ADDR_'); expect(name).toMatch(/）\.xlsx$/);
  });

  it('keeps missing optional labels visible and rejects an invalid actual box count', () => {
    const data = invoice({ shop: ' ', country: '', channel: '' }, '');
    expect(documentInvoiceFileName(data, 1, new Date('2026-10-31T00:00:00Z'))).toBe('10.31号未填店铺-未填国家-未填渠道-1件（未填地址编码）.xlsx');
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => documentInvoiceFileName(data, count)).toThrow('实际箱数');
  });
});
