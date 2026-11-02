import { describe, expect, it } from 'vitest';
import { normalizeServiceMappingCountry } from './normalization.js';

describe('service mapping country normalization', () => {
  it.each([['美国', 'US'], [' UK ', 'GB'], ['德国', 'DE'], [' br ', 'BR'], ['ＢＲ', 'BR']])('resolves %s as %s consistently across settings and invoices', (value, expected) => {
    expect(normalizeServiceMappingCountry(value)).toBe(expected);
  });
  it.each(['ZZ', 'XX', '', '未知国家', 'BRA', null, true])('rejects unknown country %s', (value) => {
    expect(normalizeServiceMappingCountry(value)).toBeUndefined();
  });
});
