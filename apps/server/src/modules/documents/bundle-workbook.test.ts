import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { createDocumentBundleWorkbook } from './bundle-workbook.js';
import { DOCUMENT_MAIN_HEADERS } from './workbook.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function invoice(id: string, rows = 1, overrides: Record<string, ExcelJS.CellValue> = {}) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('清关单');
  for (let row = 1; row <= 16; row++) { sheet.mergeCells(`B${row}:D${row}`); sheet.mergeCells(`F${row}:H${row}`); }
  sheet.getCell('B4').value = 'Receiver'; sheet.getCell('B6').value = '10 Road'; sheet.getCell('B12').value = 'US'; sheet.getCell('F12').value = '美元';
  sheet.getCell('B16').value = rows; sheet.getCell('F15').value = rows * 5;
  for (const [cell, value] of Object.entries(overrides)) sheet.getCell(cell).value = value;
  DOCUMENT_MAIN_HEADERS.forEach((label, index) => { sheet.getCell(17, index + 1).value = label; });
  for (let column = 1; column <= 17; column++) sheet.getColumn(column).width = 18 + column;
  for (let index = 0; index < rows; index++) {
    const row = sheet.getRow(18 + index); row.height = 64;
    row.values = [`${id}-${index}`, `PO-${id}`, 1.25, 20, 30, 40, 'Product', '测试商品', 1.25, 500, 'Glass', '123456', 'Use', 'Brand', 'Model', null, 'https://example.invalid/item'];
    for (let column = 1; column <= 17; column++) { row.getCell(column).numFmt = column === 9 ? '0.00' : column === 10 ? '0' : '@'; row.getCell(column).font = { name: '微软雅黑', size: 9 }; row.getCell(column).alignment = { wrapText: true, vertical: 'middle' }; }
  }
  const image = book.addImage({ base64: pixel, extension: 'png' }); sheet.addImage(image, { tl: { col: 15, row: 17 }, ext: { width: 66, height: 78 } });
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: `A1:Q${17 + rows}`, printTitlesRow: '17:17' };
  sheet.views = [{ state: 'frozen', ySplit: 17, showGridLines: false }];
  return { documentId: id, bytes: Buffer.from(await book.xlsx.writeBuffer()) };
}
const load = async (bytes: Buffer) => { const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]); return book; };
describe('one real XLSX for a complete invoice batch', () => {
  it('reassigns FBA colors across combined invoices and reuses the same color for repeated FBAs', async () => {
    const first = await invoice('A', 2), second = await invoice('B', 2);
    const prepare = async (input: typeof first, ranges: string[]) => {
      const book = await load(input.bytes), sheet = book.worksheets[0]!;
      ranges.forEach((range, index) => { sheet.getCell(index + 18, 1).value = range; sheet.getCell(index + 18, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } }; });
      return { ...input, bytes: Buffer.from(await book.xlsx.writeBuffer()) };
    };
    const result = await createDocumentBundleWorkbook([await prepare(first, ['FBAFIRSTU000001', 'FBAFIRSTU000002']), await prepare(second, ['FBASECONDU000001', 'FBAFIRSTU000003'])]);
    const sheet = (await load(result.bytes)).worksheets[0]!, firstFill = sheet.getCell('A18').fill, secondFill = sheet.getCell('A20').fill;
    expect(firstFill).toMatchObject({ type: 'pattern', pattern: 'solid' }); expect(secondFill).not.toEqual(firstFill);
    expect(sheet.getCell('Q18').fill).toEqual(firstFill); expect(sheet.getCell('A19').fill).toEqual(firstFill);
    expect(sheet.getCell('A21').fill).toEqual(firstFill); expect(sheet.getCell('Q20').fill).toEqual(secondFill);
    expect(sheet.getCell('I20').numFmt).toBe('0.00'); expect(sheet.getImages()).toHaveLength(2);
  });
  it('merges equal headers and adds actual boxes/quantities while preserving rows, styles, pictures and print settings', async () => {
    const first = await invoice('A', 2), second = await invoice('B', 3), result = await createDocumentBundleWorkbook([first, second]);
    const book = await load(result.bytes), sheet = book.worksheets[0]!;
    expect(book.worksheets).toHaveLength(1); expect(result.sheets[0]).toMatchObject({ documentIds: ['A', 'B'], rows: 5, boxes: 5, actualQuantity: 25 });
    expect(sheet.getCell('B16').value).toBe(5); expect(sheet.getCell('F15').value).toBe(25);
    expect(sheet.getCell('A18').value).toBe('A-0'); expect(sheet.getCell('A20').value).toBe('B-0'); expect(sheet.getCell('A22').value).toBe('B-2');
    expect(sheet.getCell('J18').value).toBe(500); expect(sheet.getCell('F15').value).not.toBe(2500);
    expect(sheet.getCell('I20').numFmt).toBe('0.00'); expect(sheet.getCell('J20').numFmt).toBe('0'); expect(sheet.getRow(20).height).toBe(64);
    expect(sheet.getCell('I20').font.name).toBe('微软雅黑'); expect(sheet.getColumn(17).width).toBe(35); expect(sheet.model.merges).toContain('B6:D6');
    expect(sheet.getImages().map((image) => image.range.tl.nativeRow)).toEqual([17, 19]);
    expect(Buffer.from(book.getImage(Number(sheet.getImages()[1]!.imageId)).buffer as unknown as Uint8Array).toString('base64')).toBe(pixel);
    expect(sheet.pageSetup).toMatchObject({ orientation: 'landscape', fitToWidth: 1, fitToHeight: 0, printArea: 'A1:Q22', printTitlesRow: '1:17' });
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 17 });
  });
  it('repairs address wrapping and repeated print headers when reusing a historical combined workbook', async () => {
    const address = 'Main Avenue Logistics Park, Industrial Estate, Receiving Building Number 123';
    const historical = await invoice('A', 2, { B6: address, B7: '楼栋 A\r\n二楼\n收货处' }), original = await load(historical.bytes), oldSheet = original.worksheets[0]!;
    [17.2, 7.77, 7.77].forEach((width, index) => { oldSheet.getColumn(index + 2).width = width; });
    for (const row of [6, 7]) { oldSheet.getRow(row).height = 14.25; oldSheet.getCell(row, 2).font = { name: '微软雅黑', size: 9 }; oldSheet.getCell(row, 2).alignment = { horizontal: 'center', wrapText: false }; }
    const input = { ...historical, bytes: Buffer.from(await original.xlsx.writeBuffer()) }, before = Buffer.from(input.bytes);
    const first = await createDocumentBundleWorkbook([input]), sheet = (await load(first.bytes)).worksheets[0]!;
    expect(sheet.getCell('B6').value).toBe(address); expect(sheet.getCell('B7').value).toBe('楼栋 A\n二楼\n收货处');
    expect(sheet.getCell('B6').alignment).toMatchObject({ horizontal: 'left', wrapText: true });
    expect(sheet.getRow(6).height).toBeGreaterThan(14.25); expect(sheet.getRow(7).height).toBeGreaterThanOrEqual(36.75);
    expect(sheet.pageSetup.printTitlesRow).toBe('1:17'); expect(sheet.getCell('A18').value).toBe('A-0'); expect(sheet.getImages()).toHaveLength(1); expect(input.bytes).toEqual(before);
    const range = first.sheets[0]!.ranges[0]!;
    const reused = await createDocumentBundleWorkbook([{ documentId: 'A', bytes: first.bytes, selections: [{ ...range, sheetName: first.sheets[0]!.name }] }]);
    const written = (await load(reused.bytes)).worksheets[0]!;
    expect(written.getRow(6).height).toBe(sheet.getRow(6).height); expect(written.getCell('B6').value).toBe(address); expect(written.pageSetup.printTitlesRow).toBe('1:17');
  });
  it('rejects historical addresses too tall to print completely on every page', async () => {
    await expect(createDocumentBundleWorkbook([await invoice('A', 1, { B6: '中'.repeat(4000) })])).rejects.toThrow(/地址二、地址三.*409/);
  });
  it('compares CRLF address headers as XML-normalized text without relaxing values or numeric types', async () => {
    const address = 'Receiving hall\r\nFloor 2', input = await invoice('A', 1, { B6: address });
    const result = await createDocumentBundleWorkbook([{ ...input, expectedHeaders: { B6: address, B16: 1 } }]);
    expect((await load(result.bytes)).worksheets[0]!.getCell('B6').value).toBe('Receiving hall\nFloor 2');
    await expect(createDocumentBundleWorkbook([{ ...input, expectedHeaders: { B6: 'Receiving hall\r\nFloor 3' } }])).rejects.toThrow('建立更正单据');
    await expect(createDocumentBundleWorkbook([{ ...input, expectedHeaders: { B6: address, B16: '1' } }])).rejects.toThrow('建立更正单据');
  });
  it('keeps different addresses, currencies or other header values on separate worksheets in the same workbook', async () => {
    const result = await createDocumentBundleWorkbook([await invoice('A'), await invoice('B', 1, { B6: '20 Other Road' }), await invoice('C', 1, { F12: '英镑', B12: 'GB' })]);
    const book = await load(result.bytes); expect(book.worksheets).toHaveLength(3); expect(new Set(book.worksheets.map((sheet) => sheet.name)).size).toBe(3);
    expect(book.worksheets.map((sheet) => sheet.getCell('B6').value)).toEqual(['10 Road', '20 Other Road', '10 Road']);
    expect(book.worksheets.map((sheet) => sheet.getCell('F12').value)).toEqual(['美元', '美元', '英镑']);
  });
  it('accepts the same whitespace and mandatory-marker headings allowed by the template renderer', async () => {
    const first = await invoice('A'), book = await load(first.bytes), sheet = book.worksheets[0]!;
    sheet.getCell('A17').value = '货箱编号*'; sheet.getCell('G17').value = '产品\n英文品名 *';
    const marked = { ...first, bytes: Buffer.from(await book.xlsx.writeBuffer()) };
    const result = await createDocumentBundleWorkbook([marked, await invoice('B')]);
    expect(result.sheets).toHaveLength(1); expect(result.sheets[0]).toMatchObject({ rows: 2, documentIds: ['A', 'B'] });
  });
  it('reuses only the selected document rows from an older combined sheet, without duplicating the old batch', async () => {
    const old = await createDocumentBundleWorkbook([await invoice('A', 2), await invoice('B', 1)]), range = old.sheets[0]!.ranges.find((entry) => entry.documentId === 'B')!;
    const result = await createDocumentBundleWorkbook([{ documentId: 'B', bytes: old.bytes, selections: [{ ...range, sheetName: old.sheets[0]!.name }] }, await invoice('C', 1)]);
    const sheet = (await load(result.bytes)).worksheets[0]!;
    expect(result.sheets[0]).toMatchObject({ documentIds: ['B', 'C'], rows: 2, boxes: 2, actualQuantity: 10 });
    expect(sheet.getCell('A18').value).toBe('B-0'); expect(sheet.getCell('A19').value).toBe('C-0'); expect(sheet.getImages()).toHaveLength(2);
  });
  it('ignores styled empty tail rows and keeps the genuine detail/print range compact', async () => {
    const source = await invoice('A', 2), book = await load(source.bytes), sheet = book.worksheets[0]!;
    sheet.getCell('C100').numFmt = '0.00'; sheet.getRow(100).height = 64;
    expect(sheet.rowCount).toBe(100);
    const result = await createDocumentBundleWorkbook([{ ...source, bytes: Buffer.from(await book.xlsx.writeBuffer()) }]);
    expect(result.sheets[0]).toMatchObject({ rows: 2, boxes: 2, actualQuantity: 10 });
    const written = (await load(result.bytes)).worksheets[0]!; expect(written.rowCount).toBe(19); expect(written.pageSetup.printArea).toBe('A1:Q19');
  });
  it('refuses to reuse historical v2 headers with obsolete order numbers or the wrong country currency', async () => {
    const input = await invoice('A', 1, { B1: 'OLD-ORDER' });
    await expect(createDocumentBundleWorkbook([{ ...input, expectedHeaders: { B1: null, F12: '美元' } }])).rejects.toThrow('建立更正单据');
    const wrongCurrency = await invoice('B', 1, { F12: '英镑' });
    await expect(createDocumentBundleWorkbook([{ ...wrongCurrency, expectedHeaders: { B1: null, F12: '美元' } }])).rejects.toThrow('建立更正单据');
  });
  it('rejects incomplete scope, formulas or unrecognized source columns instead of publishing a partial-looking workbook', async () => {
    const input = await invoice('A'); await expect(createDocumentBundleWorkbook([input, input])).rejects.toThrow('重复单据');
    const book = await load(input.bytes); book.worksheets[0]!.getCell('I18').value = { formula: '1+1', result: 2 };
    await expect(createDocumentBundleWorkbook([{ ...input, bytes: Buffer.from(await book.xlsx.writeBuffer()) }])).rejects.toThrow('公式');
    book.worksheets[0]!.getCell('I18').value = 2; book.worksheets[0]!.getCell('A17').value = 'Wrong format';
    await expect(createDocumentBundleWorkbook([{ ...input, bytes: Buffer.from(await book.xlsx.writeBuffer()) }])).rejects.toThrow('受控制单格式');
  });
});
