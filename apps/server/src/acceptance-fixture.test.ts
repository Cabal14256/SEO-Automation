import { describe, expect, it } from 'vitest';
import { acceptanceFixtureSchema, acceptanceSellerMatches } from './acceptance-fixture.js';

const seller = { sid: 910001, name: 'DEMO-SELLER-US', country: '美国' };
describe('private acceptance seller expectations', () => {
  it('uses exact normalized names by default and requires all configured identity fields for a source alias', () => {
    expect(acceptanceSellerMatches(' ｄｅｍｏ-ｓｅｌｌｅｒ-ｕｓ ', seller, [])).toBe(true);
    expect(acceptanceSellerMatches('DEMO-SOURCE-US', seller, [])).toBe(false);
    const selections = [{ sourceShop: 'DEMO-SOURCE-US', ...seller }];
    expect(acceptanceSellerMatches('demo-source-us', seller, selections)).toBe(true);
    expect(acceptanceSellerMatches('demo-source-us', { ...seller, sid: 910002 }, selections)).toBe(false);
    expect(acceptanceSellerMatches('demo-source-us', { ...seller, country: '加拿大' }, selections)).toBe(false);
    expect(() => acceptanceSellerMatches('demo-source-us', seller, [...selections, ...selections])).toThrow('duplicate');
  });
  it('requires an independently supplied source hash and row expectations', () => {
    expect(acceptanceFixtureSchema.safeParse({ sourceFile: 'synthetic.xlsx' }).success).toBe(false);
    expect(acceptanceFixtureSchema.safeParse({ sourceFile: 'synthetic.xlsx', sourceSha256: 'invalid', counts: { totalRows: 8, validFbaRows: 6, errorRows: 2, sellerCandidates: 3 } }).success).toBe(false);
  });
});
