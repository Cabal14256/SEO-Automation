import { describe, expect, it, vi } from 'vitest';
import { fetchCompleteShipmentList, integerQuantity, normalizeShipment } from './sync.js';

function fixture() {
  const product = { msku: 'MSKU', fnsku: 'FNSKU', sku: 'SKU', productName: '商品', expiration: '2028-01-01', prepOwner: 'SELLER', labelOwner: 'SELLER' };
  const other = { ...product, fnsku: 'OTHER-FNSKU' };
  return { sid: 12, fba: 'FBATEST1',
    listing: { sid: 12, shipment_id: 'FBATEST1', sta_shipment_id: 'shipment-1', sta_inbound_plan_id: 'plan-1', is_sta: 1, shipment_status: 'CLOSED' as string | undefined,
      item_list: [{ ...product, quantity_shipped: 5, init_quantity_shipped: 5, quantity_shipped_local: 0, quantity_received: 4 }, { ...other, quantity_shipped: 1, init_quantity_shipped: 1, quantity_shipped_local: 0, quantity_received: 1 }] },
    details: { code: 0, data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBATEST1', shipmentId: 'shipment-1', itemList: [{ ...product, quantity: 5 }, { ...other, quantity: 1 }] }] } },
    packing: { code: 0, data: { shipmentList: [{ shipmentId: 'other-shipment', shipmentPackingList: [] }, { shipmentId: 'shipment-1', shipmentPackingList: [
      { boxId: 'box-2', packageId: 'package-2', localBoxId: 2, boxName: 'P1 - B7', total: 2, weight: 2.5, weightUnit: 'LB', length: 16.5, lengthUnit: 'IN', productList: [{ ...product, quantityInBox: 2 }] },
      { boxId: 'box-1', packageId: 'package-1', localBoxId: 1, boxName: 'P1 - B3', total: 4, productList: [{ ...product, quantityInBox: 3 }, { ...other, quantityInBox: 1 }] },
    ] }] } },
  };
}
describe('shipment normalization', () => {
  it.each([undefined, 'WORKING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CANCELLED', 'ERROR', 'UNKNOWN'])('does not warn about receiving differences before completion (%s)', (status) => {
    const input = fixture(); input.listing.shipment_status = status;
    const before = structuredClone(input), data = normalizeShipment(input);
    expect(data.shipmentStatus).toBe(status ?? null);
    expect(data.issues.some((issue) => ['RECEIPT_DIFFERENCE', 'RECEIVED_DIFFERENCE'].includes(issue.code))).toBe(false);
    expect(data.items[0]).toMatchObject({ quantity: '5', receivedQuantity: '4', localShippedQuantity: '0' });
    expect(data.boxes[1]!.items[0]!.quantity).toBe('3');
    expect(input).toEqual(before);
  });
  it('normalizes CLOSED and warns only when completed received counts actually differ', () => {
    const input = fixture(); input.listing.shipment_status = ' closed ';
    expect(normalizeShipment(input)).toMatchObject({ shipmentStatus: 'CLOSED', issues: expect.arrayContaining([expect.objectContaining({ code: 'RECEIPT_DIFFERENCE', severity: 'warning' })]) });
    input.listing.item_list[0]!.quantity_received = 5;
    expect(normalizeShipment(input).issues.some((issue) => issue.code === 'RECEIPT_DIFFERENCE')).toBe(false);
  });
  it('preserves mixed boxes, cross-box products, distinct FNSKUs and zero independently', () => {
    const data = normalizeShipment(fixture());
    expect(data.items).toHaveLength(2); expect(data.boxes).toHaveLength(2);
    expect(data.items[0]).toMatchObject({ quantity: '5', localShippedQuantity: '0', receivedQuantity: '4', expiration: '2028-01-01' });
    expect(data.boxes.map((box) => box.order)).toEqual([2, 1]);
    expect(data.boxes[0]).toMatchObject({ name: 'P1 - B7', weight: '2.5', weightUnit: 'LB', length: '16.5', dimensionUnit: 'IN' });
    expect(data.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(data.issues.some((issue) => issue.code === 'RECEIPT_DIFFERENCE')).toBe(true);
  });
  it('keeps strong box IDs stable and preserves prior confirmed order after response reordering', () => {
    const input = fixture(); const previous = normalizeShipment(input);
    previous.boxes[0]!.order = 1; previous.boxes[1]!.order = 2;
    input.packing.data.shipmentList[1]!.shipmentPackingList.reverse();
    const refreshed = normalizeShipment({ ...input, previous });
    for (const box of refreshed.boxes) expect(box).toMatchObject({ id: previous.boxes.find((old) => old.externalBoxId === box.externalBoxId)!.id, order: previous.boxes.find((old) => old.externalBoxId === box.externalBoxId)!.order });
  });
  it('requires a manual mapping for weak-only IDs and detects conflicting strong IDs', () => {
    const input = fixture(); const previous = normalizeShipment(input);
    const box = input.packing.data.shipmentList[1]!.shipmentPackingList[0]!;
    box.packageId = 'package-1';
    expect(normalizeShipment({ ...input, previous }).issues.some((issue) => issue.code === 'BOX_MAPPING_CONFLICT')).toBe(true);
    box.boxId = ''; box.packageId = '';
    expect(normalizeShipment(input).issues.some((issue) => issue.code === 'BOX_MAPPING_REQUIRED')).toBe(true);
  });
  it('preserves missing/invalid quantities and duplicates as blockers rather than zero or deduplication', () => {
    const input = fixture(); const box = input.packing.data.shipmentList[1]!.shipmentPackingList[0]!;
    box.productList.push({ ...box.productList[0]! }); box.productList[0]!.quantityInBox = Number.NaN;
    const data = normalizeShipment(input);
    expect(data.boxes[0]!.items).toHaveLength(2); expect(data.boxes[0]!.items[0]!.quantity).toBeNull();
    expect(data.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['INVALID_QUANTITY', 'DUPLICATE_BOX_PRODUCT', 'PACKED_QUANTITY_UNKNOWN']));
    expect(integerQuantity('')).toBeNull(); expect(integerQuantity('9007199254740993')).toBe('9007199254740993'); expect(integerQuantity(9007199254740992)).toBeNull();
  });
  it('rejects mismatched detail identity and ambiguous packing ownership', () => {
    const input = fixture(); input.details.data.shipmentList[0]!.sid = 13;
    expect(() => normalizeShipment(input)).toThrow('唯一匹配');
    const second = fixture(); second.packing.data.shipmentList[1]!.shipmentId = 'unknown';
    expect(() => normalizeShipment(second)).toThrow('不能唯一关联');
  });
  it('does not truncate shipments containing more than ten boxes', () => {
    const input = fixture(); const boxes = input.packing.data.shipmentList[1]!.shipmentPackingList;
    for (let index = 3; index <= 12; index++) boxes.push({ ...boxes[0]!, boxId: `box-${index}`, packageId: `package-${index}`, localBoxId: index });
    expect(normalizeShipment(input).boxes).toHaveLength(12);
  });
});
describe('complete shipment pagination', () => {
  it('uses offset and fixed length 100 and verifies total before completing', async () => {
    const request = vi.fn().mockResolvedValueOnce({ code: 0, total: 101, data: { list: Array.from({ length: 100 }, (_, id) => ({ id })) } }).mockResolvedValueOnce({ code: 0, total: 101, data: { list: [{ id: 100 }] } });
    expect((await fetchCompleteShipmentList(request, 2)).rows).toHaveLength(101);
    expect(request.mock.calls.map(([params]) => params)).toEqual([{ offset: 0, length: 100 }, { offset: 100, length: 100 }]);
  });
  it('rejects changed total, missing total, short pages, repeats and page caps', async () => {
    const full = Array.from({ length: 100 }, (_, id) => ({ id }));
    for (const payloads of [
      [{ code: 0, data: { list: [] } }],
      [{ code: 0, total: 2, data: { list: [{}] } }],
      [{ code: 0, total: 200, data: { list: full } }, { code: 0, total: 201, data: { list: full } }],
      [{ code: 0, total: 200, data: { list: full } }, { code: 0, total: 200, data: { list: full } }],
    ]) { let index = 0; await expect(fetchCompleteShipmentList(async () => payloads[index++]!, 2)).rejects.toBeInstanceOf(Error); }
    await expect(fetchCompleteShipmentList(async () => ({ code: 0, total: 200, data: { list: full } }), 1)).rejects.toMatchObject({ code: 'PAGE_LIMIT' });
  });
});
