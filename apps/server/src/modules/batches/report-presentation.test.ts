import { describe, expect, it } from 'vitest';
import { formatReportCodeRanges, getReportRowCodeLabel, getReportTicketCodeDisplays, reportTicketKey, type ShipmentReportBox, type ShipmentReportRow } from '@scm/contracts';

function productRow(overrides: Partial<ShipmentReportRow> = {}): ShipmentReportRow {
  return { id: 'row', groupId: 'group', groupName: 'group', confirmationId: 'confirmation', weekStartDate: '2026-11-02', weekEndDate: '2026-11-08', businessDate: '2026-11-04', sid: 1,
    shop: 'shop', country: '美国', channel: 'HY', destinationFc: null, fba: 'FBA', msku: 'MSKU', fnsku: 'FNSKU', sku: 'SKU', productName: 'product', quantity: 200,
    boxes: [], codes: [], groupQuantity: 200, monthQuantity: 200, status: 'confirmed', actualShipDate: null, sourceObservedAt: '2026-11-04T00:00:00Z', dataRevisionId: 'revision', ...overrides };
}
function carton(code: string, overrides: Partial<ShipmentReportBox> = {}): ShipmentReportBox {
  return { groupId: 'group', groupName: 'group', confirmationId: 'confirmation', demandId: 'demand', fba: 'FBA', sid: 1, boxId: code, boxOrder: Number(code.slice(1)), code,
    boxName: null, boxExternalId: null, localBoxId: null, weight: null, weightUnit: null, length: null, width: null, height: null, lengthUnit: null,
    items: [{ msku: 'MSKU', fnsku: 'FNSKU', sku: 'SKU', quantity: 100 }], ...overrides };
}

describe('report ticket presentation', () => {
  it('compresses only actual contiguous codes and retains missing allocations', () => {
    expect(formatReportCodeRanges(['A10', 'A1', 'A3', 'A4', 'A4', 'B2', 'B1', 'A9']))
      .toBe('A1、A3-A4、A9-A10、B1-B2');
    expect(formatReportCodeRanges(Array.from({ length: 10 }, (_, index) => `A${index + 1}`))).toBe('A1-A10');
    expect(formatReportCodeRanges([])).toBe('');
  });

  it('orders alphabetic prefixes like allocated codes and preserves unusual codes', () => {
    expect(formatReportCodeRanges(['AA1', 'Z1', 'AB2', 'B1', 'A10', 'A2', 'legacy-box', 'A01', '']))
      .toBe('A2、A10、B1、Z1、AA1、AB2、A01、legacy-box');
    expect(formatReportCodeRanges(['A9007199254740993', 'A9007199254740992'])).toBe('A9007199254740992-A9007199254740993');
  });

  it('joins internal groups by ticket identity, supports legacy ticket numbers and separates runs', () => {
    const row = { groupId: 'group-a', shippingRunId: 'run-a', ticketId: 'ticket-a', ticketNumber: 'number-a' };
    expect(reportTicketKey(row)).toBe(reportTicketKey({ ...row, groupId: 'group-b' }));
    expect(reportTicketKey(row)).not.toBe(reportTicketKey({ ...row, shippingRunId: 'run-b' }));
    expect(reportTicketKey({ groupId: 'group-a', ticketNumber: 'number-a' }))
      .toBe(reportTicketKey({ groupId: 'group-b', ticketNumber: 'number-a' }));
    expect(reportTicketKey({ groupId: 'group-a' })).not.toBe(reportTicketKey({ groupId: 'group-b' }));
    expect(reportTicketKey({ groupId: 'group-a', ticketId: 'number-a' }))
      .not.toBe(reportTicketKey({ groupId: 'group-a', ticketNumber: 'number-a' }));
  });

  it('uses one range only for identical US carton contents across all FBAs of a ticket', () => {
    const ticketId = 'ticket';
    const boxes = Array.from({ length: 7 }, (_, index) => carton(`B${index + 1}`, { ticketId, groupId: `group-${index}`, fba: `FBA-${index}`, boxOrder: 1 }));
    // Only one FBA's row is on this page; all seven actual cartons remain available.
    const row = productRow({ ticketId, groupId: 'group-3', fba: 'FBA-3', ticketCodeRange: 'B1-B7', boxes: [{ boxId: 'B4', boxOrder: 1, code: 'B4', quantity: 100 }], codes: ['B4'] });
    const display = getReportTicketCodeDisplays({ rows: [row], boxes }).get(reportTicketKey(row));
    expect(display).toEqual({ range: 'B1-B7', uniform: true });
    expect(getReportRowCodeLabel(row, display, true)).toBe('B1-B7');
    expect(getReportRowCodeLabel(row, display, false)).toBe('');
  });

  it('lists positive local box codes on each uneven air row without merging them into ranges', () => {
    const boxes = [carton('A1'), carton('A2', { items: [{ msku: 'MSKU-MAX', fnsku: 'FNSKU-MAX', sku: 'SKU-MAX', quantity: 100 }] })];
    const rows = boxes.map((box) => productRow({ channel: 'KP', boxes: [{ boxId: box.boxId, boxOrder: box.boxOrder, code: box.code, quantity: 100 }], codes: [box.code] }));
    const display = getReportTicketCodeDisplays({ rows, boxes }).get(reportTicketKey(rows[0]!));
    expect(display).toEqual({ range: 'A1-A2', uniform: false });
    expect(rows.map((row, index) => getReportRowCodeLabel(row, display, index === 0))).toEqual(['A1', 'A2']);
  });

  it('uses row carton codes for Europe, including split products, zero quantities and unordered allocations', () => {
    const row = productRow({ country: '德国', boxes: [
      { boxId: 'h2', boxOrder: 2, code: 'H2', quantity: 80 },
      { boxId: 'h3', boxOrder: 3, code: 'H3', quantity: 0 },
      { boxId: 'h1', boxOrder: 1, code: 'H1', quantity: 60 },
      { boxId: 'h1', boxOrder: 1, code: 'H1', quantity: 60 },
    ] });
    const display = getReportTicketCodeDisplays({ rows: [row], boxes: [carton('H1'), carton('H2')] }).get(reportTicketKey(row));
    expect(display?.uniform).toBe(false);
    expect(getReportRowCodeLabel(row, display, true)).toBe('H1H2');
    expect(getReportRowCodeLabel(row, display, false)).toBe('H1H2');
  });

  it('compares product identities and quantities rather than only carton totals', () => {
    const row = productRow();
    const initial = carton('A1');
    for (const changed of [
      carton('A2', { sid: 2 }),
      carton('A2', { items: [{ ...initial.items[0]!, quantity: 99 }] }),
      carton('A2', { items: [{ ...initial.items[0]!, fnsku: 'OTHER' }] }),
    ]) {
      expect(getReportTicketCodeDisplays({ rows: [row], boxes: [initial, changed] }).get(reportTicketKey(row))?.uniform).toBe(false);
    }
  });

  it('compares combined positive quantities independent of product entry order', () => {
    const row = productRow(), initial = carton('A1');
    const split = carton('A2', { items: [{ ...initial.items[0]!, quantity: 40 }, { ...initial.items[0]!, quantity: 60 }, { ...initial.items[0]!, sku: 'ZERO', quantity: 0 }] });
    expect(getReportTicketCodeDisplays({ rows: [row], boxes: [initial, split] }).get(reportTicketKey(row))?.uniform).toBe(true);
  });

  it('does not assume equal packing without actual carton data or with empty cartons', () => {
    const row = productRow({ boxes: [{ boxId: 'A1', boxOrder: 1, code: 'A1', quantity: 100 }], codes: ['A1'], ticketCodeRange: 'A1-A7' });
    const display = getReportTicketCodeDisplays({ rows: [row], boxes: [] }).get(reportTicketKey(row));
    expect(display).toEqual({ range: 'A1-A7', uniform: false });
    expect(getReportRowCodeLabel(row, display, false)).toBe('A1');
    expect(getReportTicketCodeDisplays({ rows: [row], boxes: [carton('A1', { items: [] })] }).get(reportTicketKey(row))?.uniform).toBe(false);
  });
});
