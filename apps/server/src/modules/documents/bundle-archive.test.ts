import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createDocumentBundleArchive, extractDocumentArchiveInvoice } from './bundle-archive.js';
import { createDocumentBundleWorkbook } from './bundle-workbook.js';
import { DOCUMENT_MAIN_HEADERS } from './workbook.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function invoice(id: string, address = '10 Road', unitPrice = 2) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('清关单');
  sheet.mergeCells('B6:D6'); sheet.getCell('B6').value = address; sheet.getCell('B12').value = 'US'; sheet.getCell('F12').value = '美元';
  sheet.getCell('B16').value = 1; sheet.getCell('F15').value = 5;
  DOCUMENT_MAIN_HEADERS.forEach((label, index) => { sheet.getCell(17, index + 1).value = label; });
  for (let column = 1; column <= 17; column++) sheet.getColumn(column).width = 25;
  const row = sheet.getRow(18); row.values = [`${id}-box`, `PO-${id}`, 1, 2, 3, 4, 'Product', '商品', unitPrice, 500, 'Glass', '123', 'Use', 'Brand', 'Model', null, 'https://example.invalid']; row.height = 64;
  row.getCell(9).numFmt = '0.00'; row.getCell(10).numFmt = '0'; row.getCell(9).font = { name: '微软雅黑', size: 9 };
  sheet.addImage(book.addImage({ base64: pixel, extension: 'png' }), { tl: { col: 15, row: 17 }, ext: { width: 66, height: 78 } });
  sheet.pageSetup = { printArea: 'A1:Q18', printTitlesRow: '1:17', orientation: 'landscape' };
  return { documentId: id, bytes: Buffer.from(await book.xlsx.writeBuffer()) };
}
async function load(bytes: Uint8Array) { const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(bytes) as never); return book; }

describe('independent invoice Excel files in a ZIP archive', () => {
  it('keeps every invoice in its own single-sheet XLSX even when all headers match', async () => {
    const first = await invoice('A'), second = await invoice('B'), original = Buffer.from(first.bytes);
    const archive = await createDocumentBundleArchive([first, second]), entries = unzipSync(archive.bytes);
    expect(archive.fileCount).toBe(2); expect(Object.keys(entries)).toHaveLength(2); expect(archive.sheets.map((sheet) => sheet.documentIds)).toEqual([['A'], ['B']]);
    for (const [index, metadata] of archive.sheets.entries()) {
      expect(metadata.fileName).toMatch(/\.xlsx$/); const book = await load(entries[metadata.fileName!]!), sheet = book.worksheets[0]!;
      expect(metadata.fileSha256).toBe(createHash('sha256').update(entries[metadata.fileName!]!).digest('hex'));
      expect(extractDocumentArchiveInvoice(archive.bytes, metadata.fileName!)).toEqual(Buffer.from(entries[metadata.fileName!]!));
      expect(book.worksheets).toHaveLength(1); expect(sheet.getCell('A18').value).toBe(`${index === 0 ? 'A' : 'B'}-box`);
      expect(sheet.getCell('B16').value).toBe(1); expect(sheet.getCell('F15').value).toBe(5); expect(sheet.getCell('J18').value).toBe(500);
      expect(sheet.getCell('I18').value).toBe(2); expect(sheet.getCell('I18').numFmt).toBe('0.00'); expect(sheet.getCell('I18').font.name).toBe('微软雅黑'); expect(sheet.getRow(18).height).toBe(64);
      expect(sheet.model.merges).toContain('B6:D6'); expect(sheet.pageSetup).toMatchObject({ printArea: 'A1:Q18', printTitlesRow: '1:17', orientation: 'landscape' });
      expect(sheet.getImages()).toHaveLength(1); expect(Buffer.from(book.getImage(Number(sheet.getImages()[0]!.imageId)).buffer as unknown as Uint8Array).toString('base64')).toBe(pixel);
    }
    expect(first.bytes).toEqual(original);
  });

  it('keeps different recipient addresses in distinct Excel files', async () => {
    const archive = await createDocumentBundleArchive([await invoice('A'), await invoice('B', '20 Road')]), entries = unzipSync(archive.bytes);
    expect(await Promise.all(Object.values(entries).map(async (bytes) => (await load(bytes)).worksheets[0]!.getCell('B6').value))).toEqual(['10 Road', '20 Road']);
  });

  it('extracts just the selected invoice from an old merged workbook', async () => {
    const old = await createDocumentBundleWorkbook([await invoice('A'), await invoice('B')]), sheet = old.sheets[0]!, range = sheet.ranges.find((range) => range.documentId === 'B')!;
    const archive = await createDocumentBundleArchive([{ documentId: 'B', bytes: old.bytes, selections: [{ ...range, sheetName: sheet.name }] }, await invoice('C')]), entries = unzipSync(archive.bytes);
    const books = await Promise.all(Object.values(entries).map(load));
    expect(books.map((book) => book.worksheets[0]!.getCell('A18').value)).toEqual(['B-box', 'C-box']);
    expect(books.every((book) => book.worksheets.length === 1 && book.worksheets[0]!.getImages().length === 1)).toBe(true);
  });

  it('reuses only the mapped Excel entry from an existing archive', async () => {
    const old = await createDocumentBundleArchive([await invoice('A'), await invoice('B')]), sheet = old.sheets[1]!;
    const archive = await createDocumentBundleArchive([{ documentId: 'B', bytes: old.bytes, selections: sheet.ranges.map((range) => ({ ...range, sheetName: sheet.name, fileName: sheet.fileName })) }]);
    const entries = unzipSync(archive.bytes); expect(Object.keys(entries)).toHaveLength(1);
    const book = await load(Object.values(entries)[0]!); expect(book.worksheets).toHaveLength(1); expect(book.worksheets[0]!.getCell('A18').value).toBe('B-box'); expect(book.worksheets[0]!.getCell('B16').value).toBe(1);
  });

  it('rejects historical variable prices and damaged archive mappings', async () => {
    await expect(createDocumentBundleArchive([await invoice('A', '10 Road', 1.25)])).rejects.toThrow('固定单价规则');
    const input = { documentId: 'A', bytes: Buffer.from(zipSync({ 'other.xlsx': new Uint8Array([1]) })), selections: [{ sheetName: '清关单', fileName: 'missing.xlsx', startRow: 18, endRow: 18, boxes: 1, actualQuantity: 5 }] };
    await expect(createDocumentBundleArchive([input])).rejects.toThrow('缺少已映射');
    await expect(createDocumentBundleArchive([{ ...input, selections: [{ ...input.selections[0]!, fileName: '../other.xlsx' }] }])).rejects.toThrow('映射无效');
    await expect(createDocumentBundleArchive([{ ...input, bytes: Buffer.from('corrupt') }])).rejects.toThrow('压缩包损坏');
    const existing = await createDocumentBundleArchive([await invoice('A')]), metadata = existing.sheets[0]!;
    await expect(createDocumentBundleArchive([{ documentId: 'A', bytes: existing.bytes, selections: metadata.ranges.map((range) => ({ ...range, sheetName: metadata.name, fileName: metadata.fileName, fileSha256: '0'.repeat(64) })) }])).rejects.toThrow('文件哈希与范围映射不一致');
    await expect(createDocumentBundleArchive([await invoice('A'), await invoice('A')])).rejects.toThrow('重复单据');
  });
});
