import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DemandSnapshot, ImportSellerConfirmation } from '@scm/contracts';
import { importShopResolutionSchema } from '@scm/contracts';
import { confirmationCsvCell, demandContentFingerprint, deriveImportDiffItems, resolveImportShop } from './confirmation.js';

type Input = Parameters<typeof deriveImportDiffItems>[0];
const source = { id: randomUUID(), originalName: '实际需求.xlsx' };
const runId = randomUUID();
const mapping: ImportSellerConfirmation = { sourceShop: '来源店铺', sellerMappingId: randomUUID(), expectedVersion: 1,
  confirmed: true, sid: 100, name: '目录店铺', country: '美国', confirmedBy: 'administrator', confirmedAt: '2026-10-17T01:00:00.000Z' };
const snapshot: DemandSnapshot = { sid: 100, fba: 'FBA123', shop: '来源店铺', country: '美国', channel: 'HY', destinationFc: 'ONT8', referenceQuantity: '100', notes: null, subBatchName: null };
function row(number: number, fields: Partial<Input['rows'][number]['normalized']> = {}): Input['rows'][number] {
  return { id: randomUUID(), parseRunId: runId, sheetName: '飞书表格 ', rowNumber: number, hidden: false, status: 'needs_review',
    rawCells: [{ address: `F${number}`, column: 'F', type: 's', rawValue: 'FBA123', value: 'FBA123', numberFormat: '', formula: null, formulaCache: 'not_formula', hidden: false }],
    normalized: { shop: snapshot.shop, channel: snapshot.channel, country: snapshot.country, destinationFc: snapshot.destinationFc, fba: snapshot.fba,
      referenceQuantity: snapshot.referenceQuantity, sourceDate: '2026-09-01', sourceRecordId: null, notes: null, subBatchName: null, sellerMappingId: null, sid: null, sellerMappingVersion: null, ...fields },
    issues: [{ code: 'SOURCE_MAPPING_REQUIRED', severity: 'warning', message: '尚未批准全局别名' }] };
}
const derive = (rows: Input['rows'], overrides: Partial<Input> = {}) => deriveImportDiffItems({ source, rows, mappingVersion: 'feishu-v1', mappings: [mapping], demands: [], committedOrigins: [], ...overrides });

describe('automatic import shop resolution', () => {
  const seller = { id: randomUUID(), sid: 100, name: 'Catalog Shop', country: '美国', version: 4, status: 'approved', aliases: ['来源店铺'] };
  const otherSeller = { ...seller, id: randomUUID(), sid: 200, name: 'Other Shop', aliases: ['另一来源名'] };
  const resolve = (overrides: Partial<Parameters<typeof resolveImportShop>[0]> = {}) => resolveImportShop({
    sourceShop: snapshot.shop, sourceType: 'online', rows: [row(2)], sellers: [seller], ...overrides,
  });
  const lookupSource = (sid: number) => `lingxing:${runId}:sid=${sid}`;

  it('uses one approved exact name or alias after normalization without changing source data', () => {
    const rows = [row(2, { country: ' 美国 ' })];
    const original = structuredClone(rows);
    for (const sourceShop of ['来源店铺', ' ＣＡＴＡＬＯＧ ＳＨＯＰ ']) {
      expect(resolve({ sourceShop, rows })).toEqual({ status: 'unique', sellerMappingId: seller.id, expectedVersion: 4, reason: 'name_alias' });
    }
    expect(rows).toEqual(original);
  });

  it('leaves duplicate names and aliases ambiguous rather than taking the first match', () => {
    expect(resolve({ sellers: [seller, { ...otherSeller, aliases: seller.aliases }] })).toEqual({
      status: 'ambiguous', sellerMappingId: null, expectedVersion: null, reason: 'multiple_matches',
    });
  });

  it('does not automatically match unapproved or disabled names', () => {
    for (const status of ['candidate', 'disabled']) {
      expect(resolve({ sellers: [{ ...seller, status }] })).toMatchObject({ status: 'unmatched', sellerMappingId: null, reason: 'not_found' });
    }
    expect(resolve({ sourceShop: 'Unknown Shop' })).toMatchObject({ status: 'unmatched', sellerMappingId: null });
  });

  it('gives validated online lookup identity priority over name aliases, including enabled candidates', () => {
    const queried = { ...otherSeller, status: 'candidate' };
    for (const metadataSource of [lookupSource(queried.sid), `online+${lookupSource(queried.sid)}`]) {
      expect(resolve({ rows: [row(2, { metadataSource })], sellers: [seller, queried] })).toEqual({
        status: 'unique', sellerMappingId: queried.id, expectedVersion: queried.version, reason: 'fba_lookup',
      });
    }
  });

  it('ignores lookup-like file text and malformed online evidence', () => {
    expect(resolve({ sourceType: 'file', rows: [row(2, { metadataSource: lookupSource(otherSeller.sid) })], sellers: [seller, otherSeller] }))
      .toMatchObject({ status: 'unique', sellerMappingId: seller.id, reason: 'name_alias' });
    expect(resolve({ rows: [row(2, { metadataSource: 'lingxing:unverified:sid=200' })], sellers: [seller, otherSeller] }))
      .toMatchObject({ status: 'unique', sellerMappingId: seller.id, reason: 'name_alias' });
  });

  it('blocks a source shop containing different lookup SIDs instead of merging its identities', () => {
    expect(resolve({ rows: [row(2, { metadataSource: lookupSource(100) }), row(3, { metadataSource: lookupSource(200) })], sellers: [seller, otherSeller] }))
      .toEqual({ status: 'ambiguous', sellerMappingId: null, expectedVersion: null, reason: 'conflicting_lookup_sids' });
  });

  it('allows rows without lookup evidence to share a single verified source-shop identity', () => {
    expect(resolve({ rows: [row(2, { metadataSource: lookupSource(100) }), row(3)], sellers: [seller, otherSeller] }))
      .toMatchObject({ status: 'unique', sellerMappingId: seller.id, reason: 'fba_lookup' });
  });

  it('does not reassign obsolete or disabled lookup identity through an unrelated alias match', () => {
    const rows = [row(2, { metadataSource: lookupSource(200) })];
    expect(resolve({ rows })).toMatchObject({ status: 'unmatched', sellerMappingId: null });
    expect(resolve({ rows, sellers: [seller, { ...otherSeller, status: 'disabled' }] })).toMatchObject({ status: 'unmatched', sellerMappingId: null });
  });

  it('requires correction when any row country disagrees with the identified shop', () => {
    const mismatch = row(3, { country: '德国' });
    for (const rows of [[row(2), mismatch], [row(2, { metadataSource: lookupSource(100) }), mismatch]]) {
      expect(resolve({ rows })).toEqual({ status: 'ambiguous', sellerMappingId: null, expectedVersion: null, reason: 'country_mismatch' });
    }
    expect(resolve({ rows: [row(2, { country: null })] })).toMatchObject({ status: 'unique', sellerMappingId: seller.id });
  });

  it('leaves blank source shops as source-row errors even when lookup text exists', () => {
    const rows = [row(2, { shop: null, metadataSource: lookupSource(100) })];
    rows[0]!.issues.push({ code: 'SHOP_REQUIRED', message: '缺少店铺', severity: 'error' });
    expect(resolve({ sourceShop: ' ', rows })).toMatchObject({ status: 'unmatched', sellerMappingId: null });
    expect(derive(rows, { mappings: [], source: { ...source, sourceType: 'online' } })[0]).toMatchObject({ kind: 'error', selectable: false, after: null });
  });

  it('validates resolution states without allowing an unresolved shop to carry an automatic selection', () => {
    expect(importShopResolutionSchema.safeParse(resolve()).success).toBe(true);
    expect(importShopResolutionSchema.safeParse({ status: 'ambiguous', sellerMappingId: seller.id, expectedVersion: 4, reason: 'country_mismatch' }).success).toBe(false);
  });
});

describe('confirmed shipment demand differences', () => {
  it('matches approved identity across aliases, source dates and row reorder without mutating source rows', () => {
    const rows = [row(90, { shop: '另一来源名', sourceDate: '2026-10-17' })];
    const original = structuredClone(rows);
    const result = derive(rows, { mappings: [{ ...mapping, sourceShop: '另一来源名' }], demands: [{ id: randomUUID(), snapshot, version: 3 }] });
    expect(result[0]).toMatchObject({ kind: 'unchanged', expectedDemandVersion: 3, selectable: true });
    expect(result[0]!.sources[0]).toMatchObject({ fileName: source.originalName, sheetName: '飞书表格 ', rowNumber: 90, addresses: ['F90'] });
    expect(rows).toEqual(original);
  });
  it('retains every identical source and groups aliases by confirmed sid, never by FBA alone', () => {
    const rows = [row(2), row(3, { shop: '别名' }), row(4, { shop: '另一店' })];
    const result = derive(rows, { mappings: [mapping, { ...mapping, sourceShop: '别名' }, { ...mapping, sourceShop: '另一店', sid: 200, sellerMappingId: randomUUID() }] });
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.sources.length)).toEqual([2, 1]);
    expect(result.map((item) => item.sid)).toEqual([100, 200]);
  });
  it('groups legacy quantity differences without conflicts and preserves every source value', () => {
    const rows = [row(2, { referenceQuantity: '90' }), row(3, { referenceQuantity: null }), row(4, { referenceQuantity: '0' })];
    const original = structuredClone(rows);
    const result = derive(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'new', selectable: true, after: { referenceQuantity: '90' } });
    expect(result[0]!.sources.map((location) => location.rowNumber)).toEqual([2, 3, 4]);
    expect(rows).toEqual(original);
  });
  it('blocks an entire same-key group if one row has a cached formula error', () => {
    const bad = row(3);
    bad.issues.push({ code: 'FORMULA_CACHE_MISSING', severity: 'error', message: '公式无缓存', address: 'G3' });
    expect(derive([row(2), bad])[0]).toMatchObject({ kind: 'error', selectable: false, sources: expect.any(Array) });
    expect(derive([row(2), bad])[0]!.sources).toHaveLength(2);
  });
  it('does not reapply an old file after the demand has a newer confirmed version', () => {
    const demandId = randomUUID();
    const result = derive([row(2)], { demands: [{ id: demandId, snapshot: { ...snapshot, notes: 'newer confirmed content' }, version: 2 }], committedOrigins: [{ sheetName: '飞书表格 ', rowNumber: 2, demandId, acceptedVersion: 1 }] });
    expect(result[0]).toMatchObject({ kind: 'unchanged', alreadyCommitted: true, expectedDemandVersion: 2 });
  });
  it('retains cancelled shipment identity and version as a nonselectable error', () => {
    const demandId = randomUUID();
    const demand = { id: demandId, snapshot, version: 4 };
    const result = derive([row(2), row(3)], { demands: [demand], cancelledDemandIds: [demandId] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'error', selectable: false, demandId, expectedDemandVersion: 4, before: snapshot,
      alreadyCommitted: false, sources: expect.any(Array) });
    expect(result[0]!.sources).toHaveLength(2);
    expect(result[0]!.issues).toContainEqual(expect.objectContaining({ code: 'DEMAND_CANCELLED', severity: 'error' }));
    expect(demand).toEqual({ id: demandId, snapshot, version: 4 });
  });
  it('reports cancellation before the already committed shortcut', () => {
    const demandId = randomUUID();
    const result = derive([row(2)], { demands: [{ id: demandId, snapshot, version: 2 }], cancelledDemandIds: [demandId],
      committedOrigins: [{ sheetName: '飞书表格 ', rowNumber: 2, demandId, acceptedVersion: 1 }] });
    expect(result[0]).toMatchObject({ kind: 'error', selectable: false, alreadyCommitted: false, demandId, expectedDemandVersion: 2 });
    expect(result[0]!.issues).toContainEqual(expect.objectContaining({ code: 'DEMAND_CANCELLED', severity: 'error' }));
    expect(result[0]!.issues.some((issue) => issue.code === 'SOURCE_ALREADY_COMMITTED')).toBe(false);
  });
  it('does not confuse a cancelled shipment with another shop using the same FBA', () => {
    const demandId = randomUUID();
    const result = derive([row(2)], { mappings: [{ ...mapping, sid: 200 }], demands: [{ id: demandId, snapshot, version: 2 }], cancelledDemandIds: [demandId] });
    expect(result[0]).toMatchObject({ kind: 'new', selectable: true, sid: 200, demandId: null, expectedDemandVersion: 0 });
  });
  it('blocks reassignment of a committed physical origin to a different shipment', () => {
    const oldDemand = randomUUID();
    const result = derive([row(2, { fba: 'FBA999' })], { committedOrigins: [{ sheetName: '飞书表格 ', rowNumber: 2, demandId: oldDemand, acceptedVersion: 1 }] });
    expect(result[0]).toMatchObject({ kind: 'conflict', selectable: false });
    expect(result[0]!.issues.some((issue) => issue.code === 'SOURCE_ALREADY_COMMITTED')).toBe(true);
  });
  it('requires explicit seller confirmation and rejects conflicting countries with a cell address', () => {
    const absent = derive([row(2)], { mappings: [] })[0]!;
    expect(absent).toMatchObject({ kind: 'error', selectable: false });
    expect(absent.issues).toContainEqual(expect.objectContaining({ code: 'IMPORT_SELLER_CONFIRMATION_REQUIRED', address: 'B2' }));
    const mismatch = derive([row(3, { country: '德国' })])[0]!;
    expect(mismatch.issues).toContainEqual(expect.objectContaining({ code: 'COUNTRY_MISMATCH', address: 'D3', severity: 'error' }));
  });
  it('compares visible demand fields for both changes and same-shipment conflicts', () => {
    expect(demandContentFingerprint(snapshot)).toBe(demandContentFingerprint({ ...snapshot, shop: '别名', country: 'US' }));
    for (const field of ['channel', 'destinationFc', 'notes', 'subBatchName', 'destinationAddress', 'shipmentCreatedAt'] as const) {
      expect(demandContentFingerprint({ ...snapshot, [field]: 'changed' })).not.toBe(demandContentFingerprint(snapshot));
      expect(derive([row(2, { [field]: 'changed' })], { demands: [{ id: randomUUID(), snapshot, version: 1 }] })[0]).toMatchObject({ kind: 'changed', selectable: true });
      const conflict = derive([row(2), row(3, { [field]: 'changed' })])[0]!;
      expect(conflict).toMatchObject({ kind: 'conflict', selectable: false });
      expect(conflict.sources.map((location) => location.rowNumber)).toEqual([2, 3]);
    }
  });
  it('ignores missing, zero and changed legacy quantities when matching existing demands', () => {
    for (const referenceQuantity of [null, '0', '90']) {
      expect(demandContentFingerprint({ ...snapshot, referenceQuantity })).toBe(demandContentFingerprint(snapshot));
      const demand = { id: randomUUID(), snapshot: { ...snapshot }, version: 2 };
      const result = derive([row(2, { referenceQuantity })], { demands: [demand] })[0]!;
      expect(result).toMatchObject({ kind: 'unchanged', selectable: true, expectedDemandVersion: 2, before: { referenceQuantity: '100' }, after: { referenceQuantity } });
      expect(demand.snapshot.referenceQuantity).toBe('100');
    }
  });
  it('preserves intake metadata without trusting file text or a different confirmed shop as lookup evidence', () => {
    const evidence = { destinationAddress: '123 Main St', shipmentCreatedAt: '2026-09-01 10:00', sourceFilledAt: '2026-09-02', metadataSource: 'lingxing:lookup:sid=100', metadataObservedAt: '2026-10-17T01:00:00Z' };
    const file = derive([row(2, evidence)])[0]!;
    expect(file.after).toMatchObject({ destinationAddress: evidence.destinationAddress, metadataSource: 'file', metadataObservedAt: null });
    const online = derive([row(2, evidence)], { source: { ...source, sourceType: 'online' } })[0]!;
    expect(online.after).toMatchObject({ metadataSource: evidence.metadataSource, metadataObservedAt: evidence.metadataObservedAt });
    const reassigned = derive([row(2, evidence)], { source: { ...source, sourceType: 'online' }, mappings: [{ ...mapping, sid: 200 }] })[0]!;
    expect(reassigned.after).toMatchObject({ sid: 200, destinationAddress: evidence.destinationAddress, metadataSource: 'online', metadataObservedAt: null });
    expect(reassigned.issues.some((issue) => issue.code === 'LOOKUP_SHOP_REASSIGNED')).toBe(true);
    expect(demandContentFingerprint({ ...snapshot, destinationAddress: 'new' })).not.toBe(demandContentFingerprint(snapshot));
    expect(demandContentFingerprint({ ...snapshot, shipmentCreatedAt: '2026-09-01' })).not.toBe(demandContentFingerprint(snapshot));
    expect(demandContentFingerprint({ ...snapshot, sourceFilledAt: '2026-09-01' })).toBe(demandContentFingerprint(snapshot));
  });
  it('locates missing identity fields even when the original cell is absent', () => {
    const missing = row(12, { fba: null });
    missing.rawCells = [];
    missing.issues = [{ code: 'FBA_REQUIRED', severity: 'error', message: '缺少 FBA' }];
    const result = derive([missing])[0]!;
    expect(result).toMatchObject({ kind: 'error', selectable: false });
    expect(result.issues).toContainEqual(expect.objectContaining({ address: 'F12' }));
    expect(result.sources[0]).toMatchObject({ fileName: source.originalName, sheetName: '飞书表格 ', rowNumber: 12 });
  });
  it('escapes exported source text that Excel could interpret as a formula, including leading whitespace', () => {
    expect(confirmationCsvCell('  =HYPERLINK("https://example.invalid")')).toBe('"\'  =HYPERLINK(""https://example.invalid"")"');
    expect(confirmationCsvCell('\t123')).toBe('"\'\t123"');
    expect(confirmationCsvCell('普通"文件.xlsx')).toBe('"普通""文件.xlsx"');
  });
});
