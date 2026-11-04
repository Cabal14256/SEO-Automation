import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ShipmentReportRow } from '@scm/contracts';
import { sortReportRows } from './report-order.js';

function fixture() {
  const shippingRunId = randomUUID(), ticketId = randomUUID(), groupId = randomUUID();
  let sequence = 0;
  return (sku: string, quantity: number, fields: Partial<ShipmentReportRow> = {}): ShipmentReportRow => {
    const fba = fields.fba ?? 'FBA-SAMPLE-FIRST';
    return { id: `row-${sequence++}`, shippingRunId, ticketId, groupId, groupName: '排序技术样例', confirmationId: randomUUID(),
      sourceTicketIndex: 0, inputOrder: 0, demandId: fba, ticketNumber: '20261027-1-US-1',
      weekStartDate: '2026-10-26', weekEndDate: '2026-11-01', businessDate: '2026-10-27', sid: 11,
      shop: 'Sample Store', country: '美国', channel: 'HY', destinationFc: 'DEMO', fba,
      sku, msku: `MS-${sku}`, fnsku: `FN-${sku}`, productName: sku, quantity,
      boxes: [{ boxId: `box-${fba}`, boxOrder: 1, code: 'A1', quantity }], codes: ['A1'],
      // A cached subtotal must not replace the sum of the actual complete-ticket rows.
      groupQuantity: 999, monthQuantity: 999, status: '已确认', actualShipDate: null,
      sourceObservedAt: '2026-10-27T00:00:00Z', dataRevisionId: randomUUID(), ...fields };
  };
}

const productsIn = (rows: ShipmentReportRow[], fba: string) => rows.filter((row) => row.fba === fba).map((row) => row.sku);

describe('complete-ticket product ordering', () => {
  it('uses one ticket total order across FBAs and internal groups despite reversed local quantities', () => {
    const row = fixture(), second = { fba: 'FBA-SAMPLE-SECOND', groupId: randomUUID(), inputOrder: 1 };
    const input = [row('A', 100), row('C', 20), row('B', 10), row('C', 30, second), row('A', 1, second), row('B', 200, second)];
    const before = structuredClone(input), sorted = sortReportRows(input);
    expect(productsIn(sorted, 'FBA-SAMPLE-FIRST')).toEqual(['B', 'A', 'C']);
    expect(productsIn(sorted, 'FBA-SAMPLE-SECOND')).toEqual(['B', 'A', 'C']);
    expect(sorted.map((item) => item.quantity)).toEqual([10, 100, 20, 200, 1, 30]);
    expect(input).toEqual(before);
    expect(sorted).toHaveLength(input.length);
    expect(sorted.map((item) => item.id).sort()).toEqual(input.map((item) => item.id).sort());
  });

  it('breaks equal ticket totals by SKU even when each FBA locally prefers a different product', () => {
    const row = fixture(), second = { fba: 'FBA-SAMPLE-SECOND', inputOrder: 1 };
    const sorted = sortReportRows([row('B', 11), row('A', 1), row('B', 1, second), row('A', 11, second)]);
    expect(productsIn(sorted, 'FBA-SAMPLE-FIRST')).toEqual(['A', 'B']);
    expect(productsIn(sorted, 'FBA-SAMPLE-SECOND')).toEqual(['A', 'B']);
  });

  it('keeps identical SKU labels separate by seller, FNSKU and MSKU when adding ticket totals', () => {
    const row = fixture(), second = { fba: 'FBA-SAMPLE-SECOND', groupId: randomUUID(), sid: 22, inputOrder: 1 };
    const sorted = sortReportRows([
      row('SHARED', 10), row('SHARED', 20, { fnsku: 'FN-OTHER' }), row('SHARED', 25, { msku: 'MS-OTHER' }), row('OTHER', 40),
      row('OTHER', 1, second), row('SHARED', 50, second),
    ]);
    expect(sorted.filter((item) => item.fba === 'FBA-SAMPLE-FIRST').map((item) => [item.sku, item.msku, item.fnsku, item.quantity])).toEqual([
      ['OTHER', 'MS-OTHER', 'FN-OTHER', 40],
      ['SHARED', 'MS-OTHER', 'FN-SHARED', 25],
      ['SHARED', 'MS-SHARED', 'FN-OTHER', 20],
      ['SHARED', 'MS-SHARED', 'FN-SHARED', 10],
    ]);
    expect(productsIn(sorted, 'FBA-SAMPLE-SECOND')).toEqual(['SHARED', 'OTHER']);
  });

  it('isolates tickets and retains real zero rows without adding products absent from an FBA', () => {
    const row = fixture(), second = { fba: 'FBA-SAMPLE-SECOND', inputOrder: 1 };
    const nextTicket = { fba: 'FBA-SAMPLE-NEXT-TICKET', ticketId: randomUUID(), ticketNumber: '20261027-1-US-2', sourceTicketIndex: 1 };
    const input = [row('B', 999, nextTicket), row('B', 1), row('A', 0, second), row('A', 1, nextTicket), row('A', 10), row('C', 50, second)];
    const sorted = sortReportRows(input);
    expect(productsIn(sorted, 'FBA-SAMPLE-FIRST')).toEqual(['A', 'B']);
    expect(productsIn(sorted, 'FBA-SAMPLE-SECOND')).toEqual(['C', 'A']);
    expect(productsIn(sorted, 'FBA-SAMPLE-NEXT-TICKET')).toEqual(['B', 'A']);
    expect(sorted.filter((item) => item.fba === 'FBA-SAMPLE-SECOND').map((item) => item.quantity)).toEqual([50, 0]);
    expect(sorted).toHaveLength(6);
    expect(sorted.map((item) => item.sourceTicketIndex)).toEqual([0, 0, 0, 0, 1, 1]);
  });

  it('compares exact ticket totals beyond safe integer range while each individual quantity remains safe', () => {
    const row = fixture(), second = { fba: 'FBA-SAMPLE-SECOND', inputOrder: 1 };
    const sorted = sortReportRows([row('A', Number.MAX_SAFE_INTEGER), row('B', Number.MAX_SAFE_INTEGER), row('A', 1, second), row('B', 2, second)]);
    expect(productsIn(sorted, 'FBA-SAMPLE-FIRST')).toEqual(['B', 'A']);
    expect(productsIn(sorted, 'FBA-SAMPLE-SECOND')).toEqual(['B', 'A']);
  });
});

describe('European carton product ordering', () => {
  const distribution = (quantities: Array<number | null>) => quantities.flatMap((quantity, index) => quantity === null ? []
    : [{ boxId: `box-${index + 1}`, boxOrder: index + 1, code: `K${index + 1}`, quantity }]);

  it.each(['德国', '法国', '英国', 'DE', 'FR', ' uk '])('follows carton transitions for %s instead of total product quantities', (country) => {
    const row = fixture();
    const product = (sku: string, quantities: Array<number | null>) => {
      const boxes = distribution(quantities);
      return row(sku, boxes.reduce((sum, box) => sum + box.quantity, 0), { country, boxes, codes: boxes.map((box) => box.code) });
    };
    const input = [product('split-350', [50, 300]), product('first-380', [380, null]), product('second-300', [null, 300]),
      product('first-120', [120, null]), product('first-50', [50, null])];
    const before = structuredClone(input), sorted = sortReportRows(input);
    expect(sorted.map((item) => item.sku)).toEqual(['first-380', 'first-120', 'first-50', 'split-350', 'second-300']);
    expect(sorted.map((item) => item.quantity)).toEqual([380, 120, 50, 350, 300]);
    expect(input).toEqual(before);
    expect(sorted.map((item) => item.id).sort()).toEqual(input.map((item) => item.id).sort());
  });

  it('preserves source order for a shared carton span and places single-carton products before transitions', () => {
    const row = fixture();
    const product = (sku: string, quantities: Array<number | null>) => {
      const boxes = distribution(quantities);
      return row(sku, boxes.reduce((sum, box) => sum + box.quantity, 0), { country: '法国', boxes, codes: boxes.map((box) => box.code) });
    };
    const sorted = sortReportRows([
      product('split-300', [null, 100, 200]), product('z-first-60', [60]), product('a-first-70', [70]),
      product('split-170', [70, 100]), product('fourth-200', [null, null, null, 200]),
      product('split-fifth-sixth', [null, null, null, null, 100, 100]), product('fifth-only', [null, null, null, null, 80]),
      product('sixth-only', [null, null, null, null, null, 200]), product('seventh-only', [null, null, null, null, null, null, 200]),
    ]);
    expect(sorted.map((item) => item.sku)).toEqual(['z-first-60', 'a-first-70', 'split-170', 'split-300', 'fourth-200',
      'fifth-only', 'split-fifth-sixth', 'sixth-only', 'seventh-only']);
  });

  it('ignores explicit zero quantities when locating a carton and retains unboxed zero rows at the end', () => {
    const row = fixture();
    const product = (sku: string, quantities: Array<number | null>) => {
      const boxes = distribution(quantities);
      return row(sku, boxes.reduce((sum, box) => sum + box.quantity, 0), { country: '德国', boxes, codes: boxes.map((box) => box.code) });
    };
    const sorted = sortReportRows([product('explicit-zero', [0]), product('third', [0, null, 10]), product('no-boxes', []), product('second', [null, 10])]);
    expect(sorted.map((item) => item.sku)).toEqual(['second', 'third', 'explicit-zero', 'no-boxes']);
    expect(sorted.find((item) => item.sku === 'third')!.boxes.map((box) => box.quantity)).toEqual([0, 10]);
  });
});
