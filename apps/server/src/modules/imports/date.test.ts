import { describe, expect, it } from 'vitest';
import { businessDateForReceipt } from './date.js';

describe('Shanghai import receipt date', () => {
  it('uses Shanghai midnight independently from UTC and preserves the receipt', () => {
    const before = businessDateForReceipt(new Date('2026-10-16T15:59:59Z'));
    const after = businessDateForReceipt(new Date('2026-10-16T16:00:00Z'));
    expect(before.businessDate).toBe('2026-10-16');
    expect(after.businessDate).toBe('2026-10-17');
    expect(after.importedAt.toISOString()).toBe('2026-10-16T16:00:00.000Z');
    expect(after.weekStartDate).toBe('2026-10-12');
    expect(after.weekEndDate).toBe('2026-10-18');
  });
  it('moves the week at Shanghai Monday midnight and keeps a cross-year range', () => {
    expect(businessDateForReceipt(new Date('2026-10-18T15:59:59Z')).weekStartDate).toBe('2026-10-12');
    expect(businessDateForReceipt(new Date('2026-10-18T16:00:00Z')).weekStartDate).toBe('2026-10-19');
    const year = businessDateForReceipt(new Date('2027-01-01T00:00:00Z'));
    expect([year.weekStartDate, year.weekEndDate]).toEqual(['2026-12-28', '2027-01-03']);
  });
});
