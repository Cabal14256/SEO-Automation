import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { ShipmentReport } from '@scm/contracts';
import { createIntakeTemplate, createReportWorkbook, parseIntakeWorkbook, reportRegion } from './workbook.js';

function report(): ShipmentReport {
  const groupId = randomUUID(), confirmationId = randomUUID(), demandId = randomUUID();
  const boxes = Array.from({ length: 12 }, (_, i) => ({ groupId, confirmationId, demandId, groupName: '技术十二箱', sid: 123, fba: 'FBA12BOX',
    boxId: randomUUID(), boxOrder: i + 1, code: `AA${i + 1}`, boxName: `P1 - B${i + 1}`, boxExternalId: `platform-${i}`, localBoxId: String(i + 1),
    weight: 35, weightUnit: 'LB', length: 19, width: 16, height: 17, lengthUnit: 'IN', items: [{ msku: '00001', fnsku: 'X001', sku: '001', quantity: 2 }] }));
  return { rows: [{ id: randomUUID(), groupId, confirmationId, groupName: '技术十二箱', weekStartDate: '2026-09-28', weekEndDate: '2026-10-04', businessDate: '2026-10-01', sid: 123,
    shop: '技术店铺', country: '英国', channel: 'HY', destinationFc: 'IND9', fba: 'FBA12BOX', msku: '00001', fnsku: 'X001', sku: '001', productName: '十二箱商品', quantity: 24,
    boxes: boxes.map((b) => ({ boxId: b.boxId, boxOrder: b.boxOrder, code: b.code, quantity: 2 })), codes: boxes.map((b) => b.code), groupQuantity: 24, monthQuantity: 24, status: '已确认', actualShipDate: null,
    sourceObservedAt: '2026-10-17T01:00:00Z', dataRevisionId: randomUUID() }], boxes, total: 1, page: 1, pageSize: 50, maxBoxes: 12,
    confirmations: [{ groupId, groupVersion: 2, confirmationId }], blocked: [], generatedAt: '2026-10-17T01:00:00Z' };
}
describe('shipment XLSX', () => {
  it('writes all twelve box columns, typed identifiers/dates and complete box products', async () => {
    const bytes = await createReportWorkbook(report(), { month: '2026-10' });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
    expect(book.worksheets.map((s) => s.name)).toEqual(['2026-10月汇总', '欧洲批次', '逐箱明细', '版本说明']);
    const sheet = book.worksheets[0]!; const headers = sheet.getRow(1).values as string[];
    expect(sheet.getCell(2, headers.indexOf('箱12')).value).toBe(2);
    expect(sheet.getCell(2, headers.indexOf('MSKU')).value).toBe('00001');
    expect(sheet.getCell(2, headers.indexOf('业务日期')).value).toBeInstanceOf(Date);
    expect(sheet.getCell(2, headers.indexOf('实际发货日期')).value).toBeNull();
    expect(book.getWorksheet('逐箱明细')!.rowCount).toBe(13);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });
  it('writes complete shipping ticket numbers and one product subtotal across internal source groups', async () => {
    const projection = report(), shippingRunId = randomUUID(), ticketId = randomUUID(), ticketNumber = '20261023-12-UK-3';
    Object.assign(projection, { shippingRunId, shippingRunVersion: 4, shippingRunDate: '2026-10-23', shippingRunSequence: 12 });
    Object.assign(projection.rows[0]!, { shippingRunId, shippingMonth:'2026-10',shippingRunSequence:12,ticketId, ticketNumber, sourceTicketIndex: 2, inputOrder: 0, groupQuantity: 48, monthQuantity: 48 });
    projection.rows.push({ ...projection.rows[0]!, id: randomUUID(), groupId: randomUUID(), groupName: '另一内部组', inputOrder: 1, fba: 'FBA12BOX-SECOND' });
    for (const box of projection.boxes) Object.assign(box, { shippingRunId, ticketId, ticketNumber, sourceTicketIndex: 2, inputOrder: 0 });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createReportWorkbook(projection) as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheet = book.worksheets[0]!, headers = sheet.getRow(1).values as string[];
    expect(sheet.name).toBe('20261023第12次发货');
    expect(headers[1]).toBe('发货票号');
    expect(headers).not.toContain('周范围');
    expect(sheet.getCell(2,headers.indexOf('发货月份 / 次数')).value).toBe('2026-10 第 12 次');
    expect(sheet.getCell(2, 1).value).toBe(ticketNumber); expect(sheet.getCell(2, 1).numFmt).toBe('@');
    expect(sheet.getCell(3, 1).value).toBe(ticketNumber);
    expect(sheet.getCell(2, headers.indexOf('箱12')).value).toBe(2);
    expect(sheet.getCell(2, headers.indexOf('本票商品合计')).value).toBe(48);
    expect(sheet.getCell(3, headers.indexOf('本票商品合计')).value).toBeNull();
    expect(book.getWorksheet('逐箱明细')!.getCell('A2').value).toBe(ticketNumber);
    expect(book.getWorksheet('版本说明')!.getColumn(2).values).toContain(`${shippingRunId} / 4`);
  });
  it('exports one ticket-wide product order even when each FBA has different local quantity rankings', async () => {
    const projection = report(), base = projection.rows[0]!, boxBase = projection.boxes[0]!;
    const identity = { shippingRunId: randomUUID(), ticketId: randomUUID(), ticketNumber: '20261027-1-US-1', sourceTicketIndex: 0 };
    const skus = ['SKU-Z', 'SKU-A', 'SKU-M'], totals = [110, 100, 100];
    projection.rows = []; projection.boxes = [];
    for (const [inputOrder, quantities] of [[100, 20, 40], [10, 80, 60]].entries()) {
      const shipment = { ...identity, demandId: randomUUID(), fba: `FBA-QUANTITY-${inputOrder}`, inputOrder };
      const box = { ...boxBase, ...shipment, boxId: randomUUID(), boxOrder: 1, displayBoxOrder: inputOrder + 1, code: `A${inputOrder + 1}`,
        items: skus.map((sku, index) => ({ msku: `M-${sku}`, fnsku: `FN-${sku}`, sku, quantity: quantities[index]! })) };
      projection.boxes.push(box);
      for (const product of [...box.items].reverse()) {
        const total = totals[skus.indexOf(product.sku)]!;
        projection.rows.push({ ...base, ...shipment, ...product, id: randomUUID(), country: '美国', groupQuantity: total, monthQuantity: total,
          codes: [box.code], boxes: [{ boxId: box.boxId, boxOrder: 1, displayBoxOrder: box.displayBoxOrder, code: box.code, quantity: product.quantity }] });
      }
    }
    Object.assign(projection, { shippingRunId: identity.shippingRunId, shippingRunVersion: 1, shippingRunDate: '2026-10-27', shippingRunSequence: 1, total: 6, maxBoxes: 1 });
    const before = structuredClone(projection), book = new ExcelJS.Workbook();
    await book.xlsx.load(await createReportWorkbook(projection) as unknown as Parameters<typeof book.xlsx.load>[0]);
    expect(projection).toEqual(before);
    for (const sheet of [book.worksheets[0]!, book.getWorksheet('美国批次')!]) {
      const headers = sheet.getRow(1).values as string[];
      expect(sheet.rowCount).toBe(7);
      const values = Array.from({ length: 6 }, (_, index) => ['FBA货件号', 'SKU', '发货数量', '箱1', '本票商品合计'].map((header) => sheet.getCell(index + 2, headers.indexOf(header)).value));
      expect(values).toEqual([
        ['FBA-QUANTITY-0', 'SKU-Z', 100, 100, 110], ['FBA-QUANTITY-0', 'SKU-A', 20, 20, 100], ['FBA-QUANTITY-0', 'SKU-M', 40, 40, 100],
        ['FBA-QUANTITY-1', 'SKU-Z', 10, 10, null], ['FBA-QUANTITY-1', 'SKU-A', 80, 80, null], ['FBA-QUANTITY-1', 'SKU-M', 60, 60, null],
      ]);
    }
  });
  it('preserves legacy per-FBA local box columns when display positions are absent, including F13 in box one', async () => {
    const projection = report(), base = projection.rows[0]!, boxBase = projection.boxes[0]!;
    const shippingRunId = randomUUID(), ticketId = randomUUID(), ticketNumber = '20261024-3-UK-1';
    const identity = { shippingRunId, ticketId, ticketNumber, sourceTicketIndex: 1 };
    // These literal grids are an already ordered output projection, independent
    // of the service's sorting implementation. Equal first-box positions keep
    // their source order, including the deliberately reversed text labels.
    const first = [
      ['shared', [200, 200, null, null, null, 50, null, null, null, null, null, null]],
      ['box-two', [null, 20, null, null, null, null, null, null, null, null, null, null]],
      ['z-source-first', [null, null, 100, null, null, null, null, null, null, null, null, null]],
      ['a-source-second', [null, null, 40, 20, null, null, null, null, null, null, null, null]],
      ['box-four', [null, null, null, 60, null, null, null, null, null, null, null, null]],
      ['box-five-and-six', [null, null, null, null, 140, 100, null, null, null, null, null, null]],
      ['box-five-only', [null, null, null, null, 60, null, null, null, null, null, null, null]],
      ['box-six', [null, null, null, null, null, 50, null, null, null, null, null, null]],
      ['box-seven', [null, null, null, null, null, null, 70, null, null, null, null, null]],
      ['box-eight', [null, null, null, null, null, null, null, 80, null, null, null, null]],
      ['box-nine', [null, null, null, null, null, null, null, null, 90, null, null, null]],
      ['box-ten', [null, null, null, null, null, null, null, null, null, 100, null, null]],
      ['box-eleven', [null, null, null, null, null, null, null, null, null, null, 110, null]],
      ['box-twelve', [null, null, null, null, null, null, null, null, null, null, null, 120]],
      ['explicit-zero', [0, null, null, null, null, null, null, null, null, null, null, null]],
    ] as Array<[string, Array<number | null>]>;
    const second = [
      ['shared', [9, null, null, null, null, null, null, null, null, null, null, null]],
      ['second-two', [null, 12, null, null, null, null, null, null, null, null, null, null]],
      ['second-three', [null, null, 13, null, null, null, null, null, null, null, null, null]],
      ['second-four', [null, null, null, 14, null, null, null, null, null, null, null, null]],
      ['second-five', [null, null, null, null, 15, null, null, null, null, null, null, null]],
      ['second-six', [null, null, null, null, null, 16, null, null, null, null, null, null]],
      ['second-seven', [null, null, null, null, null, null, 17, null, null, null, null, null]],
      ['second-eight', [null, null, null, null, null, null, null, 18, null, null, null, null]],
      ['second-nine', [null, null, null, null, null, null, null, null, 19, null, null, null]],
      ['second-ten', [null, null, null, null, null, null, null, null, null, 20, null, null]],
    ] as Array<[string, Array<number | null>]>;
    projection.rows = []; projection.boxes = [];
    const specifications = [
      { fba: 'FBASTAIR001', demandId: randomUUID(), inputOrder: 1, codeOffset: 0, boxCount: 12, products: first },
      { fba: 'FBASTAIR002', demandId: randomUUID(), inputOrder: 2, codeOffset: 12, boxCount: 10, products: second },
    ];
    for (const spec of specifications) {
      const boxes = Array.from({ length: spec.boxCount }, (_, index) => ({ ...boxBase, ...identity, inputOrder: spec.inputOrder,
        fba: spec.fba, demandId: spec.demandId, boxId: randomUUID(), boxOrder: index + 1, code: `F${spec.codeOffset + index + 1}`,
        boxName: `Synthetic box ${index + 1}`, boxExternalId: `synthetic-${spec.inputOrder}-${index + 1}`, localBoxId: String(index + 1),
        items: [] as ShipmentReport['boxes'][number]['items'] }));
      for (const [label, grid] of spec.products) {
        const product = { msku: `M-${label}`, fnsku: `FN-${label}`, sku: `S-${label}` };
        const quantities = grid.flatMap((quantity, index) => {
          if (quantity === null) return [];
          const box = boxes[index]!; box.items.push({ ...product, quantity });
          return [{ boxId: box.boxId, boxOrder: index + 1, code: box.code, quantity }];
        });
        const quantity = grid.reduce<number>((sum, value) => sum + (value ?? 0), 0);
        projection.rows.push({ ...base, ...identity, inputOrder: spec.inputOrder, id: randomUUID(), demandId: spec.demandId,
          fba: spec.fba, ...product, productName: label, quantity, boxes: quantities, codes: quantities.map((box) => box.code),
          groupQuantity: label === 'shared' ? 459 : quantity, monthQuantity: label === 'shared' ? 459 : quantity });
      }
      projection.boxes.push(...boxes);
    }
    Object.assign(projection, { shippingRunId, shippingRunVersion: 5, shippingRunDate: '2026-10-24', shippingRunSequence: 3, total: 25, maxBoxes: 12 });
    const before = structuredClone(projection);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createReportWorkbook(projection) as unknown as Parameters<typeof book.xlsx.load>[0]);
    expect(projection).toEqual(before);
    for (const sheet of [book.worksheets[0]!, book.getWorksheet('欧洲批次')!]) {
      expect(sheet.rowCount).toBe(projection.rows.length + 1);
      const headers = sheet.getRow(1).values as string[];
      for (const row of projection.rows) {
        const line = sheet.getColumn(headers.indexOf('FBA货件号')).values.findIndex((fba, index) => fba === row.fba && sheet.getCell(index, headers.indexOf('MSKU')).value === row.msku);
        expect(line).toBeGreaterThan(1);
        expect(sheet.getCell(line, headers.indexOf('FBA货件号')).value).toBe(row.fba);
        expect(sheet.getCell(line, headers.indexOf('MSKU')).value).toBe(row.msku);
        expect(sheet.getCell(line, headers.indexOf('FNSKU')).value).toBe(row.fnsku);
        expect(sheet.getCell(line, headers.indexOf('SKU')).value).toBe(row.sku);
        expect(sheet.getCell(line, headers.indexOf('发货数量')).value).toBe(row.quantity);
        const spec = specifications.find((spec) => spec.fba === row.fba)!;
        const expectedGrid = spec.products.find(([label]) => label === row.productName)![1];
        expect(Array.from({ length: 12 }, (_, offset) => sheet.getCell(line, headers.indexOf(`箱${offset + 1}`)).value)).toEqual(expectedGrid);
      }
      expect(sheet.getCell(2, headers.indexOf('FBA货件号')).value).toBe('FBASTAIR002');
      expect(sheet.getCell(2, headers.indexOf('内部编码')).value).toBe('F1-F22');
      expect(sheet.getColumn(headers.indexOf('内部编码')).values.filter((value, index) => index > 1 && value !== null)).toEqual(['F1-F22']);
      const sharedLines = sheet.getColumn(headers.indexOf('SKU')).values.flatMap((value, index) => value === 'S-shared' ? [index] : []);
      expect(sharedLines).toHaveLength(2);
      expect(sharedLines.map((line) => sheet.getCell(line, headers.indexOf('FBA货件号')).value).sort()).toEqual(['FBASTAIR001', 'FBASTAIR002']);
    }
    const detail = book.getWorksheet('逐箱明细')!, detailHeaders = detail.getRow(1).values as string[];
    const expectedDetails = projection.boxes.flatMap((box) => box.items.map((item) => [box.fba, box.boxId, box.boxOrder, box.code, item.msku, item.fnsku, item.sku, item.quantity]));
    const actualDetails = Array.from({ length: detail.rowCount - 1 }, (_, index) => ['FBA货件号', '内部箱ID', '货件内箱序', '内部编码', 'MSKU', 'FNSKU', 'SKU', '箱内数量'].map((header) => detail.getCell(index + 2, detailHeaders.indexOf(header)).value));
    expect(actualDetails).toEqual(expectedDetails);
    expect(new Set(actualDetails.map((line) => line[1])).size).toBe(22);
  });
  it('restarts each FBA at box one, ignores old allocation display positions and shows one complete ticket range', async () => {
    const projection = report(), base = projection.rows[0]!, boxBase = projection.boxes[0]!;
    const shippingRunId = randomUUID(), ticketId = randomUUID(), ticketNumber = '20261024-4-UK-1';
    const identity = { shippingRunId, ticketId, ticketNumber, sourceTicketIndex: 1 };
    const groups = [base.groupId, randomUUID()], confirmations = [base.confirmationId, randomUUID()];
    const examples = [
      { fba: 'FBADISPLAY001', group: 0, codes: ['G1', 'G2'], columns: [1, 2], quantities: [10, 20] },
      { fba: 'FBADISPLAY007', group: 0, codes: ['G7', 'G8'], columns: [7, 8], quantities: [70, 80] },
      { fba: 'FBADISPLAY009', group: 0, codes: ['G9', 'G10'], columns: [9, 10], quantities: [90, 100] },
      { fba: 'FBADISPLAY011', group: 0, codes: ['G11', 'G12'], columns: [11, 12], quantities: [110, 120] },
      { fba: 'FBADISPLAYH01', group: 1, codes: ['H1', 'H2'], columns: [1, 2], quantities: [1, 2] },
    ];
    projection.rows = []; projection.boxes = [];
    const total = examples.reduce((sum, example) => sum + example.quantities.reduce((subtotal, quantity) => subtotal + quantity, 0), 0);
    for (const [inputOrder, example] of examples.entries()) {
      const demandId = randomUUID();
      const boxes = example.codes.map((code, index) => ({ ...boxBase, ...identity, inputOrder: inputOrder + 1, groupId: groups[example.group]!, confirmationId: confirmations[example.group]!,
        demandId, fba: example.fba, boxId: randomUUID(), boxOrder: index + 1, displayBoxOrder: example.columns[index]!, code,
        boxName: `Local box ${index + 1}`, boxExternalId: `${example.fba}-${index + 1}`, localBoxId: String(index + 1),
        items: [{ msku: 'M-SHARED', fnsku: 'FN-SHARED', sku: 'S-SHARED', quantity: example.quantities[index]! }] }));
      projection.rows.push({ ...base, ...identity, id: randomUUID(), inputOrder: inputOrder + 1, groupId: groups[example.group]!, confirmationId: confirmations[example.group]!, demandId,
        fba: example.fba, msku: 'M-SHARED', fnsku: 'FN-SHARED', sku: 'S-SHARED', productName: example.codes.join(' / '),
        quantity: example.quantities.reduce((sum, quantity) => sum + quantity, 0),
        boxes: boxes.map((box, index) => ({ boxId: box.boxId, boxOrder: box.boxOrder, displayBoxOrder: box.displayBoxOrder, code: box.code, quantity: example.quantities[index]! })),
        codes: example.codes, groupQuantity: total, monthQuantity: total });
      projection.boxes.push(...boxes);
    }
    // A stale global maximum must not add empty allocation columns.
    Object.assign(projection, { shippingRunId, shippingRunVersion: 1, shippingRunDate: '2026-10-24', shippingRunSequence: 4, maxBoxes: 12, total: examples.length,
      confirmations: groups.map((groupId, index) => ({ groupId, groupVersion: 2, confirmationId: confirmations[index]! })) });
    const before = structuredClone(projection);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createReportWorkbook(projection) as unknown as Parameters<typeof book.xlsx.load>[0]);
    expect(projection).toEqual(before);
    for (const sheet of [book.worksheets[0]!, book.getWorksheet('欧洲批次')!]) {
      const headers = sheet.getRow(1).values as string[];
      expect(sheet.rowCount).toBe(examples.length + 1);
      expect(headers.filter((header) => /^箱\d+$/.test(header))).toEqual(['箱1', '箱2', '箱3', '箱4', '箱5']);
      for (const [index, example] of examples.entries()) {
        const expected = [...example.quantities, null, null, null];
        expect(Array.from({ length: 5 }, (_, offset) => sheet.getCell(index + 2, headers.indexOf(`箱${offset + 1}`)).value)).toEqual(expected);
        expect(sheet.getCell(index + 2, headers.indexOf('FBA货件号')).value).toBe(example.fba);
        expect(sheet.getCell(index + 2, headers.indexOf('SKU')).value).toBe('S-SHARED');
        expect(sheet.getCell(index + 2, headers.indexOf('内部编码')).value).toBe(index === 0 ? 'G1-G2、G7-G12、H1-H2' : null);
        expect(sheet.getCell(index + 2, headers.indexOf('发货数量')).value).toBe(example.quantities.reduce((sum, quantity) => sum + quantity, 0));
        expect(sheet.getCell(index + 2, headers.indexOf('本票商品合计')).value).toBe(index === 0 ? total : null);
      }
      expect(sheet.getCell(3, headers.indexOf('箱1')).value).toBe(70);
      expect(sheet.getCell(3, headers.indexOf('箱2')).value).toBe(80);
      expect(sheet.getCell(6, headers.indexOf('箱1')).value).toBe(1);
      expect(sheet.getCell(6, headers.indexOf('箱2')).value).toBe(2);
    }
    const detail = book.getWorksheet('逐箱明细')!, headers = detail.getRow(1).values as string[];
    const actual = Array.from({ length: detail.rowCount - 1 }, (_, index) => ['FBA货件号', '内部编码', '货件内箱序', '箱内数量', '发货表箱列'].map((header) => detail.getCell(index + 2, headers.indexOf(header)).value));
    expect(actual).toEqual(examples.flatMap((example) => example.codes.map((code, index) => [example.fba, code, index + 1, example.quantities[index], index + 1])));
    expect(book.getWorksheet('版本说明')!.getColumn(2).values).toContain('shipment-record-v6');
  });
  it('sorts FBA blocks by box count and input order while retaining real box codes and product totals', async () => {
    const projection = report(), base = projection.rows[0]!, boxBase = projection.boxes[0]!;
    const shippingRunId = randomUUID(), ticketId = randomUUID(), ticketNumber = '20261025-1-UK-1';
    const identity = { shippingRunId, ticketId, ticketNumber, sourceTicketIndex: 0 };
    const specs = [
      { prefix: 'AB', sequences: [2] }, { prefix: 'A', sequences: [10] }, { prefix: 'AA', sequences: [1] },
      { prefix: 'B', sequences: [1] }, { prefix: 'Z', sequences: [1] }, { prefix: 'A', sequences: [12, 2, 3] },
    ];
    const groups = new Map(['A', 'B', 'Z', 'AA', 'AB'].map((prefix) => [prefix, { groupId: randomUUID(), confirmationId: randomUUID() }]));
    const sharedTotal = 29;
    projection.rows = []; projection.boxes = [];
    for (const [inputOrder, spec] of specs.entries()) {
      const group = groups.get(spec.prefix)!, demandId = randomUUID();
      const fba = `FBACODE-${spec.prefix}${Math.min(...spec.sequences)}`;
      const boxes = spec.sequences.map((sequence, index) => ({ ...boxBase, ...identity, ...group, demandId, fba, inputOrder,
        boxId: randomUUID(), boxOrder: index + 1, displayBoxOrder: sequence, code: `${spec.prefix}${sequence}`,
        items: [{ msku: sequence === 3 ? 'SECOND' : base.msku, fnsku: sequence === 3 ? 'SECOND-FN' : base.fnsku,
          sku: sequence === 3 ? 'SECOND-SKU' : base.sku, quantity: sequence }] }));
      const sharedBoxes = boxes.filter((box) => box.displayBoxOrder !== 3);
      projection.rows.push({ ...base, ...identity, ...group, id: randomUUID(), demandId, fba, inputOrder,
        quantity: sharedBoxes.reduce((sum, box) => sum + box.displayBoxOrder, 0),
        boxes: sharedBoxes.map((box) => ({ boxId: box.boxId, boxOrder: box.boxOrder, displayBoxOrder: box.displayBoxOrder, code: box.code, quantity: box.displayBoxOrder })),
        codes: sharedBoxes.map((box) => box.code), groupQuantity: sharedTotal, monthQuantity: sharedTotal });
      const second = boxes.find((box) => box.displayBoxOrder === 3);
      if (second) projection.rows.push({ ...base, ...identity, ...group, id: randomUUID(), demandId, fba, inputOrder,
        msku: 'SECOND', fnsku: 'SECOND-FN', sku: 'SECOND-SKU', quantity: 3,
        boxes: [{ boxId: second.boxId, boxOrder: second.boxOrder, displayBoxOrder: 3, code: second.code, quantity: 3 }],
        codes: [second.code], groupQuantity: 3, monthQuantity: 3 });
      projection.boxes.push(...boxes);
    }
    Object.assign(projection, { shippingRunId, shippingRunVersion: 1, shippingRunDate: '2026-10-25', shippingRunSequence: 1,
      total: projection.rows.length, maxBoxes: 12, confirmations: [...groups.values()].map((group) => ({ ...group, groupVersion: 2 })) });
    const before = structuredClone(projection), book = new ExcelJS.Workbook();
    await book.xlsx.load(await createReportWorkbook(projection) as unknown as Parameters<typeof book.xlsx.load>[0]);
    expect(projection).toEqual(before);
    const expected = ['FBACODE-AB2', 'FBACODE-A10', 'FBACODE-AA1', 'FBACODE-B1', 'FBACODE-Z1', 'FBACODE-A2', 'FBACODE-A2'];
    for (const sheet of [book.worksheets[0]!, book.getWorksheet('欧洲批次')!]) {
      const headers = sheet.getRow(1).values as string[];
      expect(Array.from({ length: expected.length }, (_, index) => sheet.getCell(index + 2, headers.indexOf('FBA货件号')).value)).toEqual(expected);
      expect(sheet.getCell(2, headers.indexOf('内部编码')).value).toBe('A2-A3、A10、A12、B1、Z1、AA1、AB2');
      expect(sheet.getCell(3, headers.indexOf('内部编码')).value).toBeNull();
      expect(sheet.getCell(2, headers.indexOf('箱1')).value).toBe(2);
      expect(sheet.getCell(3, headers.indexOf('箱1')).value).toBe(10);
      expect(sheet.getCell(7, headers.indexOf('箱1')).value).toBe(12);
      expect(sheet.getCell(7, headers.indexOf('箱2')).value).toBe(2);
      expect(sheet.getCell(8, headers.indexOf('箱3')).value).toBe(3);
      expect(sheet.getCell(2, headers.indexOf('本票商品合计')).value).toBe(sharedTotal);
      expect(sheet.getCell(2, headers.indexOf('本月商品数量')).value).toBe(sharedTotal);
      expect(sheet.getCell(8, headers.indexOf('本票商品合计')).value).toBe(3);
      expect(Array.from({ length: expected.length - 2 }, (_, index) => sheet.getCell(index + 3, headers.indexOf('本票商品合计')).value)).toEqual([null, null, null, null, null]);
    }
    const detail = book.getWorksheet('逐箱明细')!, headers = detail.getRow(1).values as string[];
    expect(Array.from({ length: detail.rowCount - 1 }, (_, index) => detail.getCell(index + 2, headers.indexOf('内部编码')).value))
      .toEqual(['A2', 'A3', 'A10', 'A12', 'B1', 'Z1', 'AA1', 'AB2']);
    expect(Array.from({ length: detail.rowCount - 1 }, (_, index) => detail.getCell(index + 2, headers.indexOf('箱内数量')).value))
      .toEqual([2, 3, 10, 12, 1, 1, 1, 2]);
    expect(detail.getCell(2, headers.indexOf('货件内箱序')).value).toBe(2);
    expect(detail.getCell(2, headers.indexOf('发货表箱列')).value).toBe(2);
    expect(detail.getCell(5, headers.indexOf('货件内箱序')).value).toBe(1);
    expect(detail.getCell(5, headers.indexOf('发货表箱列')).value).toBe(1);
  });
  it('inserts one blank row between business tickets, including cross-group tickets and region-filtered sheets', async () => {
    const projection = report(), base = projection.rows[0]!, boxBase = projection.boxes[0]!, shippingRunId = randomUUID();
    const tickets = [randomUUID(), randomUUID(), randomUUID()];
    projection.rows = []; projection.boxes = [];
    const specs = [
      { ticket: 0, inputOrder: 0, fba: 'FBA-A-FIRST', country: '英国', codes: ['A1'] },
      { ticket: 2, inputOrder: 0, fba: 'FBA-C', country: '英国', codes: ['C1', 'C3'] },
      { ticket: 1, inputOrder: 0, fba: 'FBA-B', country: '美国', codes: ['B1'] },
      { ticket: 0, inputOrder: 1, fba: 'FBA-A-SECOND', country: '英国', codes: ['A2'] },
    ];
    for (const spec of specs) {
      const groupId = randomUUID(), demandId = randomUUID();
      const identity = { shippingRunId, ticketId: tickets[spec.ticket]!, ticketNumber: `20261027-1-${spec.ticket + 1}`, sourceTicketIndex: spec.ticket, inputOrder: spec.inputOrder, groupId, demandId, fba: spec.fba };
      const boxes = spec.codes.map((code, index) => ({ ...boxBase, ...identity, boxId: randomUUID(), boxOrder: index + 1, displayBoxOrder: Number(code.slice(1)), code,
        items: [{ msku: '00001', fnsku: 'X001', sku: '001', quantity: 2 }] }));
      projection.boxes.push(...boxes);
      projection.rows.push({ ...base, ...identity, id: randomUUID(), country: spec.country, quantity: boxes.length * 2,
        groupQuantity: spec.ticket === 0 ? 4 : boxes.length * 2, monthQuantity: spec.ticket === 0 ? 4 : boxes.length * 2,
        codes: spec.codes, boxes: boxes.map((box) => ({ boxId: box.boxId, boxOrder: box.boxOrder, displayBoxOrder: box.displayBoxOrder, code: box.code, quantity: 2 })) });
    }
    Object.assign(projection, { shippingRunId, shippingRunVersion: 1, shippingRunDate: '2026-10-27', shippingRunSequence: 1, total: 4, maxBoxes: 10 });
    const before = structuredClone(projection), book = new ExcelJS.Workbook();
    await book.xlsx.load(await createReportWorkbook(projection) as unknown as Parameters<typeof book.xlsx.load>[0]);
    expect(projection).toEqual(before);
    const checkSheet = (sheet: ExcelJS.Worksheet, expected: Array<string | null>, ranges: Array<string | null>) => {
      const headers = sheet.getRow(1).values as string[];
      expect(sheet.rowCount).toBe(expected.length + 1);
      expect(expected.map((_, index) => sheet.getCell(index + 2, headers.indexOf('FBA货件号')).value)).toEqual(expected);
      expect(expected.map((_, index) => sheet.getCell(index + 2, headers.indexOf('内部编码')).value)).toEqual(ranges);
      for (const [index, fba] of expected.entries()) if (fba === null) {
        expect(sheet.getRow(index + 2).hasValues).toBe(false);
        for (let column = 1; column <= headers.length - 1; column++) expect(sheet.getCell(index + 2, column).value).toBeNull();
      }
      expect(sheet.autoFilter).toBe(`A1:${sheet.getColumn(headers.length - 1).letter}${sheet.rowCount}`);
    };
    checkSheet(book.worksheets[0]!, ['FBA-A-FIRST', 'FBA-A-SECOND', null, 'FBA-B', null, 'FBA-C'], ['A1-A2', null, null, 'B1', null, 'C1、C3']);
    checkSheet(book.getWorksheet('欧洲批次')!, ['FBA-A-FIRST', 'FBA-A-SECOND', null, 'FBA-C'], ['A1-A2', null, null, 'C1、C3']);
    checkSheet(book.getWorksheet('美国批次')!, ['FBA-B'], ['B1']);
    const detail = book.getWorksheet('逐箱明细')!;
    expect(detail.rowCount).toBe(6);
    expect(Array.from({ length: detail.rowCount - 1 }, (_, index) => detail.getRow(index + 2).hasValues)).toEqual([true, true, true, true, true]);
  });
  it('imports two-sheet evidence without losing zero or leading zeros', async () => {
    const template = await createIntakeTemplate(); const book = new ExcelJS.Workbook(); await book.xlsx.load(template as unknown as Parameters<typeof book.xlsx.load>[0]);
    book.getWorksheet('货件商品')!.addRow(['123', 'FBA12BOX', '00001', 'X001', '001', '商品', 0]);
    book.getWorksheet('逐箱商品')!.addRow(['123', 'FBA12BOX', 'external-1', '1', 'P1 - B3', '00001', 'X001', '001', 0, 35, 'LB', 19, 16, 17, 'IN']);
    const bytes = Buffer.from(await book.xlsx.writeBuffer()); const parsed = await parseIntakeWorkbook(bytes, { sid: 123, fba: 'FBA12BOX' });
    expect(parsed.items[0]).toMatchObject({ msku: '00001', quantity: '0' }); expect(parsed.boxes[0]).toMatchObject({ name: 'P1 - B3', weight: '35', weightUnit: 'LB', dimensionUnit: 'IN' });
    expect(parsed.boxes[0]!.items[0]!.quantity).toBe('0');
    await expect(parseIntakeWorkbook(bytes, { sid: 124, fba: 'FBA12BOX' })).rejects.toThrow('sid/FBA');
  });
  it('rejects formulas and inconsistent repeated box metadata', async () => {
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createIntakeTemplate() as unknown as Parameters<typeof book.xlsx.load>[0]);
    book.getWorksheet('货件商品')!.addRow(['123', 'FBA12BOX', 'M', 'F', 'S', '商品', { formula: '1+1', result: 2 }]);
    book.getWorksheet('逐箱商品')!.addRow(['123', 'FBA12BOX', 'b', '1', 'B1', 'M', 'F', 'S', 2]);
    await expect(parseIntakeWorkbook(Buffer.from(await book.xlsx.writeBuffer()), { sid: 123, fba: 'FBA12BOX' })).rejects.toThrow('公式');
    book.getWorksheet('货件商品')!.getCell('G2').value = 2;
    book.getWorksheet('逐箱商品')!.addRow(['123', 'FBA12BOX', 'b', '2', 'B2', 'M', 'F', 'S', 2]);
    await expect(parseIntakeWorkbook(Buffer.from(await book.xlsx.writeBuffer()), { sid: 123, fba: 'FBA12BOX' })).rejects.toThrow('元数据不一致');
  });
  it('includes Britain in the European business view', () => { expect(reportRegion('英国')).toBe('EU'); expect(reportRegion('US')).toBe('US'); expect(reportRegion('未知')).toBe('other'); });
});
