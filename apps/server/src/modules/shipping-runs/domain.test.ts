import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { businessDateForReceipt } from '../imports/date.js';
import { lookupDateRange, numberTickets, shippingCountry, shippingOperationId, shippingTicketNumber, sourceTicketLayout, type ShippingSourceRow } from './domain.js';

const source = (id: string, fba: string | null, ticket?: number, order?: number, issues: ShippingSourceRow['issues'] = []): ShippingSourceRow => ({
  id, rowNumber: Number(id.replace(/\D/g, '')) || 1,
  normalized: { fba, ...(ticket === undefined ? {} : { sourceTicketIndex: ticket }), ...(order === undefined ? {} : { sourceMemberIndex: order }) }, issues,
});

describe('shipping country identifiers', () => {
  it.each([
    ['美国', 'US'], ['us', 'US'], [' USA ', 'US'], ['United States', 'US'], ['United States of America', 'US'],
    ['英国', 'UK'], ['uk', 'UK'], [' GB ', 'UK'], ['GBR', 'UK'], ['United Kingdom', 'UK'], ['Great Britain', 'UK'],
    ['德国', 'DE'], ['Germany', 'DE'], ['法国', 'FR'], ['France', 'FR'], ['西班牙', 'ES'], ['Spain', 'ES'], ['意大利', 'IT'], ['Italy', 'IT'],
    ['加拿大', 'CA'], ['Canada', 'CA'], ['澳大利亚', 'AU'], ['Australia', 'AU'], ['日本', 'JP'], ['Japan', 'JP'],
    ['荷兰', 'NL'], ['Netherlands', 'NL'], ['波兰', 'PL'], ['Poland', 'PL'], ['瑞典', 'SE'], ['Sweden', 'SE'],
    ['比利时', 'BE'], ['Belgium', 'BE'], ['爱尔兰', 'IE'], ['Ireland', 'IE'], ['墨西哥', 'MX'], ['Mexico', 'MX'],
    ['阿联酋', 'AE'], ['United Arab Emirates', 'AE'], ['沙特阿拉伯', 'SA'], ['Saudi Arabia', 'SA'],
    ['新加坡', 'SG'], ['Singapore', 'SG'], ['印度', 'IN'], ['India', 'IN'],
  ])('normalizes %s to the ticket identifier %s', (value, country) => { expect(shippingCountry(value)).toBe(country); });

  it('preserves another two-letter country identifier without inventing an alias for unknown country text', () => {
    expect(shippingCountry(' ch ')).toBe('CH');
    for (const value of [null, undefined, '', '   ', '未知国家', 'EUROPE', 'U', 'U1', 'United Kingdom / US']) expect(shippingCountry(value)).toBeNull();
  });
});

describe('source ticket layout', () => {
  it('uses preserved blank-line segment and member metadata instead of sorting the FBA text', () => {
    const rows = [source('row12', ' fba19zzz ', 4, 2), source('row3', 'FBA19BBB', 2, 2), source('row11', 'FBA19AAA', 4, 1), source('row2', 'FBA19XXX', 2, 1)];
    const before = structuredClone(rows);
    const layout = sourceTicketLayout(rows);
    expect(layout).toEqual({ issues: [], tickets: [
      { sourceTicketIndex: 2, members: [{ sourceRowId: 'row2', fba: 'FBA19XXX', inputOrder: 1 }, { sourceRowId: 'row3', fba: 'FBA19BBB', inputOrder: 2 }] },
      { sourceTicketIndex: 4, members: [{ sourceRowId: 'row11', fba: 'FBA19AAA', inputOrder: 1 }, { sourceRowId: 'row12', fba: 'FBA19ZZZ', inputOrder: 2 }] },
    ] });
    expect(rows).toEqual(before);
  });

  it('keeps a legacy import without segment metadata as one ticket in its original input order', () => {
    expect(sourceTicketLayout([source('row8', 'FBAZZZ'), source('row9', 'FBAAAA')])).toEqual({ issues: [], tickets: [{
      sourceTicketIndex: 1, members: [{ sourceRowId: 'row8', fba: 'FBAZZZ', inputOrder: 1 }, { sourceRowId: 'row9', fba: 'FBAAAA', inputOrder: 2 }],
    }] });
  });

  it('numbers fallback member positions separately in each segment', () => {
    const layout = sourceTicketLayout([source('row1', 'FBAA', 1), source('row2', 'FBAB', 2), source('row3', 'FBAC', 1), source('row4', 'FBAD', 2)]);
    expect(layout.tickets.map((ticket) => ticket.members.map((member) => [member.fba, member.inputOrder]))).toEqual([
      [['FBAA', 1], ['FBAC', 2]], [['FBAB', 1], ['FBAD', 2]],
    ]);
  });

  it.each([null, '', ' ', 'ABC19TN', 'FBA', 'FBA19-TN', 'FBA19 TN', 'FBA19中文'])('reports missing or invalid FBA %s with the original segment and row', (fba) => {
    const layout = sourceTicketLayout([source('row17', fba, 3, 2)]);
    expect(layout.tickets).toEqual([]);
    expect(layout.issues).toContainEqual(expect.objectContaining({ code: 'INVALID_FBA', ticketIndex: 3, message: expect.stringContaining('第 17 行') }));
  });

  it('rejects duplicate FBA across segments after trimming and case normalization without changing the first member', () => {
    const layout = sourceTicketLayout([source('row1', 'FBA19DUP', 2, 1), source('row7', ' fba19dup ', 4, 1), source('row8', 'FBA19OTHER', 4, 2)]);
    expect(layout.issues).toEqual([{ code: 'DUPLICATE_FBA', fba: 'FBA19DUP', ticketIndex: 4, message: 'FBA 在第 2 票与第 4 票的输入中重复，请保留一次。' }]);
    expect(layout.tickets.flatMap((ticket) => ticket.members.map((member) => member.fba))).toEqual(['FBA19DUP', 'FBA19OTHER']);
    expect(layout.tickets[1]!.members[0]!.inputOrder).toBe(2);
  });

  it('also rejects repeated FBA inside the same ticket', () => {
    const layout = sourceTicketLayout([source('row1', 'FBA19DUP', 1, 1), source('row2', 'FBA19DUP', 1, 2)]);
    expect(layout.issues).toEqual([expect.objectContaining({ code: 'DUPLICATE_FBA', ticketIndex: 1, fba: 'FBA19DUP' })]);
    expect(layout.tickets[0]!.members).toHaveLength(1);
  });

  it('defers metadata that lookup can resolve and preserves unrelated blocking errors with source locations', () => {
    const resolvable = ['SHOP_REQUIRED', 'COUNTRY_REQUIRED', 'SOURCE_MAPPING_REQUIRED', 'SELLER_ALIAS_CONFLICT', 'SELLER_COUNTRY_MISMATCH', 'COUNTRY_MISMATCH'];
    const rows = [source('row23', 'FBA19VALID', 3, 1, [
      ...resolvable.map((code) => ({ code, severity: 'error', message: '待在线补齐' })),
      { code: 'HIDDEN_ROW', severity: 'warning', message: '隐藏行' },
      { code: 'FORMULA_CACHE_MISSING', severity: 'error', message: '请先刷新公式缓存' },
    ])];
    const before = structuredClone(rows);
    const layout = sourceTicketLayout(rows);
    expect(layout.issues).toEqual([{ code: 'FORMULA_CACHE_MISSING', message: '第 23 行：请先刷新公式缓存', ticketIndex: 3, fba: 'FBA19VALID' }]);
    expect(layout.tickets[0]!.members[0]!.sourceRowId).toBe('row23');
    expect(rows).toEqual(before);
  });

  it('reports an empty shipment instead of silently producing a ready empty layout', () => {
    expect(sourceTicketLayout([])).toEqual({ tickets: [], issues: [{ code: 'EMPTY_SHIPMENT', message: '本次发货没有有效 FBA，请填写后重新解析。' }] });
  });
});

describe('shipping ticket numbering', () => {
  it('shares the shipment sequence across countries and counts tickets independently within each country', () => {
    const input = [
      { id: 'uk-second', sourceTicketIndex: 7, country: 'UK' }, { id: 'us-first', sourceTicketIndex: 1, country: 'US' },
      { id: 'de-first', sourceTicketIndex: 6, country: 'DE' }, { id: 'us-second', sourceTicketIndex: 5, country: 'US' },
      { id: 'uk-first', sourceTicketIndex: 3, country: 'UK' },
    ];
    const before = structuredClone(input);
    expect(numberTickets(input, '2026-10-23', 12)).toEqual([
      { id: 'us-first', sourceTicketIndex: 1, country: 'US', ticketSequence: 1, number: '20261023-12-US-1' },
      { id: 'uk-first', sourceTicketIndex: 3, country: 'UK', ticketSequence: 1, number: '20261023-12-UK-1' },
      { id: 'us-second', sourceTicketIndex: 5, country: 'US', ticketSequence: 2, number: '20261023-12-US-2' },
      { id: 'de-first', sourceTicketIndex: 6, country: 'DE', ticketSequence: 1, number: '20261023-12-DE-1' },
      { id: 'uk-second', sourceTicketIndex: 7, country: 'UK', ticketSequence: 2, number: '20261023-12-UK-2' },
    ]);
    expect(input).toEqual(before);
  });

  it('starts country ticket counters afresh for each shipping run and retains multi-digit sequence values', () => {
    const input = [{ id: 'one', sourceTicketIndex: 1, country: 'FR' }];
    expect(numberTickets(input, '2026-10-31', 27)[0]!.number).toBe('20261031-27-FR-1');
    expect(numberTickets(input, '2026-11-01', 1)[0]!.number).toBe('20261101-1-FR-1');
    expect(shippingTicketNumber('2027-01-01', 2, 'ES', 123)).toBe('20270101-2-ES-123');
    expect(numberTickets([], '2026-10-23', 1)).toEqual([]);
  });
});

describe('shipping numbering and lookup dates', () => {
  it.each([
    ['2026-10-23', '2026-07-26', '2026-10-24'], ['2026-11-01', '2026-08-04', '2026-11-02'],
    ['2027-01-01', '2026-10-04', '2027-01-02'], ['2024-03-01', '2023-12-03', '2024-03-02'],
  ])('queries exactly 90 inclusive days for %s and exposes the exclusive sync boundary', (date, startDate, exclusiveEndDate) => {
    const range = lookupDateRange(date);
    expect(range).toEqual({ startDate, endDate: date, exclusiveEndDate });
    expect((Date.parse(`${range.exclusiveEndDate}T00:00:00Z`) - Date.parse(`${range.startDate}T00:00:00Z`)) / 86_400_000).toBe(90);
  });

  it.each([
    ['2026-10-31T15:59:59.999Z', '2026-10-31', '20261031-8-US-1'],
    ['2026-10-31T16:00:00.000Z', '2026-11-01', '20261101-1-US-1'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01', '20270101-1-US-1'],
    ['2024-02-28T16:00:00.000Z', '2024-02-29', '20240229-8-US-1'],
  ])('uses the Shanghai calendar date at the month/year/leap boundary %s', (receivedAt, date, number) => {
    const receipt = businessDateForReceipt(new Date(receivedAt));
    expect(receipt.businessDate).toBe(date);
    // Counter allocation is tested against the database; the formatter consumes
    // its saved month-specific sequence rather than deriving it from the day.
    const sequence = date.endsWith('-01') ? 1 : 8;
    expect(shippingTicketNumber(receipt.businessDate, sequence, 'US', 1)).toBe(number);
  });
});

describe('replayable shipping operation identifiers', () => {
  const runId = 'aa342870-96ce-43cf-a159-b84073726acc';
  it('reproduces the same valid UUID after process restarts and keeps operation steps separate', () => {
    const commitId = shippingOperationId(runId, 'commit:preview-1');
    expect(commitId).toBe('7a989e3e-ed18-5762-a947-c1f5c3ff96a5');
    expect(shippingOperationId(runId, 'commit:preview-1')).toBe(commitId);
    expect(z.uuid().safeParse(commitId).success).toBe(true);
    expect(shippingOperationId(runId, 'sync:group-1')).toBe('e434c708-a8fd-5986-a402-3f624ed48295');
    expect(shippingOperationId(runId, 'sync-retry:group-1:2')).toBe('245706e5-0699-5745-a205-f9f369ce72f0');
    expect(shippingOperationId('bb342870-96ce-43cf-a159-b84073726acc', 'commit:preview-1')).not.toBe(commitId);
    expect(shippingOperationId(runId, 'commit:preview-2')).not.toBe(commitId);
  });
});
