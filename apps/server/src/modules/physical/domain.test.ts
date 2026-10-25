import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GroupConfirmation } from '@scm/contracts';
import { normalizeShipment } from '../batches/sync.js';
import { buildPhysicalSource, normalizePhysicalValue, pendingEntries, physicalSourceFingerprint, validatePhysicalEntries, type BuildPhysicalSourceInput } from './domain.js';

function fixture(count = 2): BuildPhysicalSourceInput {
  const at = '2026-10-18T10:00:00.000Z', demandId = randomUUID(), groupId = randomUUID();
  const product = { msku: 'MSKU', fnsku: 'FNSKU', sku: 'SKU', productName: '商品' }, second = { ...product, sku: 'SKU2', fnsku: 'FNSKU2' };
  const evidence = { demandId, observedAt: at, snapshotIds: [randomUUID()], listing: { sid: 12, shipment_id: 'FBATEST1', sta_shipment_id: 'shipment-1', reference_id: 'REF1', is_sta: 1,
    item_list: [{ ...product, quantity_shipped: count * 2 }, { ...second, quantity_shipped: count }] },
    details: { code: 0, data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBATEST1', shipmentId: 'shipment-1', amazonReferenceId: 'REF1', itemList: [{ ...product, quantity: count * 2 }, { ...second, quantity: count }] }] } },
    packing: { code: 0, data: { shipmentList: [{ shipmentId: 'shipment-1', shipmentPackingList: Array.from({ length: count }, (_, index) => ({ boxId: `box-${index + 1}`, packageId: `package-${index + 1}`, localBoxId: index + 1, boxName: `B${index + 1}`, total: 3, weight: '1.005', weightUnit: 'KG', length: '2', width: '3', height: '4', lengthUnit: 'IN', productList: [{ ...product, quantityInBox: 2 }, { ...second, quantityInBox: 1 }] })) }] } } };
  const normalized = normalizeShipment({ sid: 12, fba: 'FBATEST1', ...evidence });
  const revision = { id: randomUUID(), demandId, version: 1, demandVersion: 1, data: normalized, source: 'lingxing' as const, snapshotIds: evidence.snapshotIds, reason: 'test', createdBy: 'admin', createdAt: at };
  const member: GroupConfirmation['snapshot']['members'][number] = { id: demandId, snapshot: { sid: 12, fba: 'FBATEST1', shop: '店铺', country: 'US', channel: null, destinationFc: null, referenceQuantity: null, notes: null, subBatchName: null }, version: 1, businessDate: '2026-10-18', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', createdAt: at, updatedAt: at };
  return { id: randomUUID(), groupId, m2ConfirmationId: randomUUID(), origin: 'history', createdBy: 'admin', createdAt: at, shipments: [{ demandId, revision }], members: [member], evidence: [evidence], codes: normalized.boxes.map((box) => ({ id: randomUUID(), groupId, demandId, boxId: box.id, prefix: 'A', sequence: box.order!, code: `A${box.order}`, valid: true, createdAt: at })) };
}
function packing(input: BuildPhysicalSourceInput) { return (input.evidence[0]!.packing.data as { shipmentList: { shipmentPackingList: Record<string, unknown>[] }[] }).shipmentList[0]!.shipmentPackingList; }

describe('physical source calculations and identity', () => {
  it('converts exact decimals and rounds half up once, rejecting missing or unknown units and invalid values', () => {
    expect(normalizePhysicalValue('1.005', 'kg', 'weight')).toBe('1.01');
    expect(normalizePhysicalValue('1.004999999999999999999999', 'KG', 'weight')).toBe('1.00');
    expect(normalizePhysicalValue('1', 'LB', 'weight')).toBe('0.45');
    expect(normalizePhysicalValue('1.125', 'in', 'dimension')).toBe('2.86');
    for (const value of [null, '', '-1', '0', 'NaN', Infinity, '1e3', 9007199254740992]) expect(normalizePhysicalValue(value, 'KG', 'weight')).toBeNull();
    expect(normalizePhysicalValue('1', 'stone', 'weight')).toBeNull();
  });
  it('keeps twelve mixed boxes and their confirmed identities/order after source rows reorder', () => {
    const input = fixture(12); packing(input).reverse();
    const source = buildPhysicalSource(input);
    expect(source.identityValid).toBe(true); expect(source.issues).toEqual([]); expect(source.boxes).toHaveLength(12);
    expect(source.boxes.map((box) => box.order)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(source.boxes[0]).toMatchObject({ po: 'REF1', range: 'FBATEST1000001-12', raw: { weight: '1.005', weightUnit: 'KG' }, values: { weight: '1.01', length: '5.08', width: '7.62', height: '10.16' } });
    expect(source.boxes.every((box) => box.items.length === 2)).toBe(true);
  });
  it('reads exact raw measurements and original units directly from the matched packing row', () => {
    const input = fixture();
    packing(input)[0]!.weight = '1.004999999999999999999999'; packing(input)[0]!.weightUnit = 'kg ';
    packing(input)[0]!.length = '1.004999999999999999999999'; packing(input)[0]!.lengthUnit = 'cm';
    const source = buildPhysicalSource(input);
    expect(source.boxes[0]!.raw).toMatchObject({ weight: '1.004999999999999999999999', weightUnit: 'kg ', length: '1.004999999999999999999999', dimensionUnit: 'cm' });
    expect(source.boxes[0]!.values).toMatchObject({ weight: '1.00', length: '1.00' });
    expect(source.issues).toEqual([]);
  });
  it('allows only unique previously mapped weak identity tuples and never array positions', () => {
    const input = fixture();
    for (const box of input.shipments[0]!.revision.data.boxes) { box.externalBoxId = null; box.packageId = null; }
    for (const box of packing(input)) { box.boxId = ''; box.packageId = ''; }
    packing(input).reverse();
    expect(buildPhysicalSource(input).identityValid).toBe(true);
    packing(input)[0]!.boxName = 'unmatched';
    expect(buildPhysicalSource(input).identityValid).toBe(false);
  });
  it('blocks changed strong identities, quantities, missing evidence and conflicting references', () => {
    const changed = fixture(); packing(changed)[0]!.packageId = 'different'; expect(buildPhysicalSource(changed).identityValid).toBe(false);
    const quantityChanged = fixture(); (packing(quantityChanged)[0]!.productList as Record<string, unknown>[])[0]!.quantityInBox = 99; expect(buildPhysicalSource(quantityChanged).identityValid).toBe(false);
    const missing = fixture(); missing.evidence = []; const missingSource = buildPhysicalSource(missing); expect(missingSource.boxes).toHaveLength(2); expect(missingSource.boxes[0]!.values.weight).toBeNull(); expect(missingSource.identityValid).toBe(false);
    const reference = fixture(); reference.evidence[0]!.listing.reference_id = 'OTHER'; const source = buildPhysicalSource(reference); expect(source.boxes[0]!.po).toBeNull(); expect(source.issues.some((issue) => issue.code === 'PHYSICAL_REFERENCE_CONFLICT')).toBe(true);
    expect(() => validatePhysicalEntries(source, pendingEntries(source).map((entry) => ({ ...entry, status: 'consistent' })), true)).toThrow('阻塞');
  });
  it('respects the valid M2 detail-quantity decision while still blocking real detail or box quantity changes', () => {
    const input = fixture();
    (input.evidence[0]!.listing.item_list as Record<string, unknown>[])[0]!.quantity_shipped = 99;
    input.shipments[0]!.revision.data.items[0]!.listQuantity = '99';
    const source = buildPhysicalSource(input);
    expect(source.identityValid).toBe(true);
    expect(source.issues).toEqual([expect.objectContaining({ code: 'PHYSICAL_LIST_QUANTITY_MISMATCH', severity: 'warning' })]);
    const entries = pendingEntries(source).map((entry) => ({ ...entry, status: 'consistent' as const }));
    expect(validatePhysicalEntries(source, entries, true)).toHaveLength(2);
    const detailChanged = structuredClone(input);
    (detailChanged.evidence[0]!.details.data as { shipmentList: { itemList: Record<string, unknown>[] }[] }).shipmentList[0]!.itemList[0]!.quantity = 5;
    const changedSource = buildPhysicalSource(detailChanged);
    expect(changedSource.identityValid).toBe(false);
    expect(changedSource.issues.some((issue) => issue.code === 'PHYSICAL_PRODUCT_QUANTITY_CONFLICT')).toBe(true);
    const boxChanged = structuredClone(input);
    (packing(boxChanged)[0]!.productList as Record<string, unknown>[])[0]!.quantityInBox = 3;
    expect(buildPhysicalSource(boxChanged).identityValid).toBe(false);
  });
  it('ignores equivalent raw units, task/snapshot ids and timestamps in the business fingerprint', () => {
    const first = buildPhysicalSource(fixture()), changed = structuredClone(first);
    changed.id = randomUUID(); changed.snapshotIds = [randomUUID()]; changed.createdAt = '2026-10-19T10:00:00.000Z';
    changed.boxes.reverse(); changed.boxes.forEach((box) => { box.raw.weight = '2.226668848067263565'; box.raw.weightUnit = 'LB'; box.sourceObservedAt = changed.createdAt; box.items.reverse(); });
    changed.boxes[0]!.values = { height: changed.boxes[0]!.values.height, width: changed.boxes[0]!.values.width, length: changed.boxes[0]!.values.length, weight: changed.boxes[0]!.values.weight };
    expect(physicalSourceFingerprint(changed)).toBe(first.fingerprint);
    changed.boxes[0]!.values.weight = '2.00'; expect(physicalSourceFingerprint(changed)).not.toBe(first.fingerprint);
    changed.boxes[0]!.values.weight = first.boxes[0]!.values.weight; changed.boxes[0]!.po = 'new'; expect(physicalSourceFingerprint(changed)).not.toBe(first.fingerprint);
  });
});

describe('physical review validation', () => {
  it('supports incomplete drafts and pending rows retaining measurements after invalidation', () => {
    const source = buildPhysicalSource(fixture()), entries = pendingEntries(source);
    entries[0]!.measured = { weight: '2.345' }; entries[0]!.reason = '待重核'; entries[1]!.status = 'different';
    expect(validatePhysicalEntries(source, entries)[0]!.measured.weight).toBe('2.35');
    expect(() => validatePhysicalEntries(source, entries, true)).toThrow('全部箱');
  });
  it('requires a complete unique box list and forbids fabricated measurements on consistent rows', () => {
    const source = buildPhysicalSource(fixture()), entries = pendingEntries(source);
    expect(() => validatePhysicalEntries(source, entries.slice(1))).toThrow('完整箱');
    expect(() => validatePhysicalEntries(source, [entries[0]!, entries[0]!])).toThrow('重复');
    entries[0]!.status = 'consistent'; entries[0]!.measured.weight = '1.01'; expect(() => validatePhysicalEntries(source, entries)).toThrow('一致');
  });
  it('compares differences at two decimals and requires a reason only when finally confirming', () => {
    const source = buildPhysicalSource(fixture()), entries = pendingEntries(source).map((entry) => ({ ...entry, status: 'consistent' as const })) as ReturnType<typeof pendingEntries>;
    entries[0]!.status = 'different'; entries[0]!.measured.weight = '1.014'; entries[0]!.reason = '实测';
    expect(() => validatePhysicalEntries(source, entries, true)).toThrow('至少一项不同');
    entries[0]!.measured.weight = '1.02'; entries[0]!.reason = ''; expect(() => validatePhysicalEntries(source, entries, true)).toThrow('原因');
    entries[0]!.reason = '复核'; expect(validatePhysicalEntries(source, entries, true)[0]).toMatchObject({ measured: { weight: '1.02' }, reason: '复核' });
  });
});
