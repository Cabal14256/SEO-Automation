import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { activeSeller } from './catalog.js';
import { findApprovedSellers } from './resolution.js';

vi.mock('../../db/client.js', () => ({ db: {} }));

const seller = { id: 'seller-de', sid: 910001, name: 'DEMO-SELLER-DE', status: 'approved', aliases: [] as string[] };

describe('approved seller exact name resolution', () => {
  it('matches an approved official name without requiring any alias', () => {
    expect(findApprovedSellers('  ｄｅｍｏ-ｓｅｌｌｅｒ-DE  ', [seller])).toEqual([seller]);
    expect(findApprovedSellers('DEMO-SELLER-DE', [seller])[0]).toBe(seller);
  });

  it('accepts optional aliases and legacy fixtures without a name', () => {
    const named = { ...seller, aliases: ['来源店铺'] };
    const legacy = { id: 'legacy', status: 'approved', aliases: ['旧店铺'] };
    expect(findApprovedSellers('来源店铺', [named])).toEqual([named]);
    expect(findApprovedSellers('旧店铺', [legacy])).toEqual([legacy]);
    expect(findApprovedSellers('DEMO-SELLER-DE', [named])).toEqual([named]);
  });

  it.each(['DEMO-SELLER', 'DEMO-SELLER-DE-extra', 'DEMO SELLER DE', '910001', '', '   '])('does not guess from a partial name, sid or blank input: %j', (source) => {
    expect(findApprovedSellers(source, [seller])).toEqual([]);
  });

  it('preserves ambiguity between distinct sellers with the same normalized official name', () => {
    const second = { ...seller, id: 'seller-other', sid: 910002, name: 'ｄｅｍｏ-ｓｅｌｌｅｒ-DE' };
    expect(findApprovedSellers('DEMO-SELLER-DE', [seller, second])).toEqual([seller, second]);
  });

  it('preserves ambiguity when one seller alias is another seller official name', () => {
    const second = { ...seller, id: 'seller-other', sid: 9010, name: 'OTHER-DE', aliases: ['demo-seller-de'] };
    expect(findApprovedSellers('DEMO-SELLER-DE', [seller, second])).toEqual([seller, second]);
  });

  it('returns a seller only once when its name, aliases and repeated records all match', () => {
    const repeated = { ...seller, aliases: ['DEMO-SELLER-DE', 'ｄｅｍｏ-ｓｅｌｌｅｒ-DE'] };
    expect(findApprovedSellers('DEMO-SELLER-DE', [repeated, repeated, { ...repeated }])).toEqual([repeated]);
  });

  it.each(['candidate', 'disabled'])('ignores %s records even when both name and alias match', (status) => {
    const inactive = { ...seller, status, aliases: [seller.name] };
    expect(findApprovedSellers(seller.name, [inactive])).toEqual([]);
    expect(findApprovedSellers(seller.name, [inactive, seller])).toEqual([seller]);
  });

  it('leaves seller records and aliases unchanged', () => {
    const records = [seller, { ...seller, id: 'other', aliases: ['来源名称'] }];
    const original = structuredClone(records);
    findApprovedSellers('来源名称', records);
    expect(records).toEqual(original);
  });
});

describe('current seller catalog identity resolution', () => {
  const catalog: Parameters<typeof activeSeller>[0] = { id: randomUUID(), sid: 910001, name: '人工店铺名称', country: '人工国家',
    marketplaceId: null, wid: null, status: 'approved', version: 3, manualEnabled: true, lingxingAutoApproved: true, lingxingDisabled: false,
    updatedAt: new Date('2026-10-17T01:00:00Z'), sourceObservedAt: new Date('2026-10-17T01:00:00Z'), sourceSha256: '1'.repeat(64), sourceFileId: null,
    lingxingData: { name: '领星实际名称', country: '德国', marketplaceId: null, status: '1', present: true, observedAt: '2026-10-17T02:00:00Z' } };
  function current(mode: string, changes: Partial<typeof catalog> = {}) {
    const selected = activeSeller({ ...catalog, ...changes }, mode);
    return selected ? [{ ...selected, aliases: [] }] : [];
  }

  it('uses the current source official name and never substitutes the other profile', () => {
    expect(findApprovedSellers('领星实际名称', current('lingxing'))[0]).toMatchObject({ id: catalog.id, sid: 910001, country: '德国' });
    expect(findApprovedSellers('人工店铺名称', current('lingxing'))).toEqual([]);
    expect(findApprovedSellers('人工店铺名称', current('manual'))[0]).toMatchObject({ id: catalog.id, sid: 910001, country: '人工国家' });
    expect(findApprovedSellers('领星实际名称', current('manual'))).toEqual([]);
  });

  it('supports remote-only identities and excludes absent or unauthorized actual identities', () => {
    expect(findApprovedSellers('领星实际名称', current('lingxing', { manualEnabled: false }))).toHaveLength(1);
    expect(findApprovedSellers('人工店铺名称', current('manual', { manualEnabled: false }))).toEqual([]);
    for (const lingxingData of [null, { ...catalog.lingxingData!, present: false }, { ...catalog.lingxingData!, status: '0' }]) {
      expect(findApprovedSellers('领星实际名称', current('lingxing', { lingxingData }))).toEqual([]);
    }
    expect(findApprovedSellers('领星实际名称', current('lingxing', { lingxingDisabled: true }))).toEqual([]);
  });
});
