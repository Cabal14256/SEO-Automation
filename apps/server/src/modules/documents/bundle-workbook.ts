import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { DOCUMENT_MAIN_HEADERS } from './workbook.js';
import { DocumentWorkbookError } from './workbook-errors.js';

export type BundleRange = { documentId: string; startRow: number; endRow: number; boxes: number; actualQuantity: number };
export type BundleSheet = { name: string; documentIds: string[]; rows: number; boxes: number; actualQuantity: number; ranges: BundleRange[] };
export type BundleSelection = { sheetName: string; startRow: number; endRow: number; boxes: number; actualQuantity: number };
export type BundleWorkbookInput = { documentId: string; bytes: Buffer; selections?: BundleSelection[]; expectedHeaders?: Record<string, ExcelJS.CellValue> };
const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sum = (left: number, right: number) => { const value = left + right; if (!Number.isSafeInteger(value) || value < 0) throw new DocumentWorkbookError('整批箱数或实际数量超过安全整数范围。'); return value; };
const integer = (value: ExcelJS.CellValue) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new DocumentWorkbookError('原始发票缺少可核验的箱数或实际数量汇总。'); return value; };
const rowValues = (sheet: ExcelJS.Worksheet, row: number) => Array.from({ length: 17 }, (_, index) => sheet.getCell(row, index + 1).value ?? null);
const normalizedHeading = (value: ExcelJS.CellValue) => String(value ?? '').replace(/\s|\*/g, '');
function headerKey(sheet: ExcelJS.Worksheet) {
  return digest(Array.from({ length: 17 }, (_, row) => rowValues(sheet, row + 1).map((value, column) => row === 16 ? DOCUMENT_MAIN_HEADERS[column] : row === 15 && column >= 1 && column <= 3 || row === 14 && column >= 5 && column <= 7 ? null : value)));
}
function lastDetailRow(sheet: ExcelJS.Worksheet) {
  let last = sheet.rowCount;
  while (last >= 18 && !String(sheet.findRow(last)?.getCell(1).value ?? '').trim()) last--;
  if (last < 18) throw new DocumentWorkbookError('原始发票没有有效货箱明细。');
  const printEnd = /\$?Q\$?(\d+)$/i.exec(sheet.pageSetup.printArea ?? '')?.[1];
  if (printEnd && last > Number(printEnd)) throw new DocumentWorkbookError('原始发票存在打印范围以外的货箱明细，请核对文件。');
  return last;
}
function assertValue(value: ExcelJS.CellValue) {
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) throw new DocumentWorkbookError('发票含不可安全移动的公式，整批文件未发布。');
}
function copyRow(source: ExcelJS.Worksheet, sourceRow: number, target: ExcelJS.Worksheet, targetRow: number) {
  target.getRow(targetRow).height = source.getRow(sourceRow).height;
  target.getRow(targetRow).hidden = source.getRow(sourceRow).hidden;
  for (let column = 1; column <= 17; column++) {
    const cell = source.getCell(sourceRow, column), output = target.getCell(targetRow, column); assertValue(cell.value);
    output.value = cell.isMerged && cell.master.address !== cell.address ? null : structuredClone(cell.value);
    output.style = structuredClone(cell.style);
    if (cell.dataValidation) output.dataValidation = structuredClone(cell.dataValidation);
    if (cell.note) output.note = structuredClone(cell.note);
  }
}
function addHeader(source: ExcelJS.Worksheet, output: ExcelJS.Worksheet) {
  for (let column = 1; column <= 17; column++) { output.getColumn(column).width = source.getColumn(column).width; output.getColumn(column).hidden = source.getColumn(column).hidden; }
  for (let row = 1; row <= 17; row++) copyRow(source, row, output, row);
  DOCUMENT_MAIN_HEADERS.forEach((label, index) => { output.getCell(17, index + 1).value = label; });
  for (const merge of source.model.merges) {
    const range = /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(merge);
    if (!range || Number(range[2]) > 17) throw new DocumentWorkbookError('发票合并单元格跨越明细区，不能安全合并。');
    output.mergeCells(merge);
  }
  output.properties = structuredClone(source.properties);
  output.pageSetup = structuredClone(source.pageSetup);
  output.headerFooter = structuredClone(source.headerFooter);
  output.views = structuredClone(source.views);
}
type ImageCheck = { sheet: string; row: number; column: number; hash: string; extension: string };
function addImages(book: ExcelJS.Workbook, source: ExcelJS.Worksheet, range: BundleSelection, targetBook: ExcelJS.Workbook, target: ExcelJS.Worksheet, firstRow: number, expected: ImageCheck[]) {
  for (const image of source.getImages()) {
    const row = image.range.tl.row + 1;
    if (row < range.startRow || row > range.endRow) continue;
    const media = book.getImage(Number(image.imageId));
    if (!media?.buffer || !['png', 'jpeg'].includes(media.extension)) throw new DocumentWorkbookError('原始发票图片无法完整复制，整批文件未发布。');
    const bytes = Buffer.from(media.buffer as unknown as Uint8Array), offset = firstRow - range.startRow;
    const imageId = targetBook.addImage({ buffer: bytes as unknown as ExcelJS.Image['buffer'], extension: media.extension });
    const position = { tl: { col: image.range.tl.col, row: image.range.tl.row + offset }, editAs: 'oneCell',
      ...('ext' in image.range && image.range.ext ? { ext: structuredClone(image.range.ext) } : {}),
      ...('br' in image.range && image.range.br ? { br: { col: image.range.br.col, row: image.range.br.row + offset } } : {}) };
    target.addImage(imageId, position as Parameters<ExcelJS.Worksheet['addImage']>[1]);
    expected.push({ sheet: target.name, row: image.range.tl.row + offset, column: image.range.tl.col, hash: digest(bytes), extension: media.extension });
  }
}

/** Produce one genuine XLSX. Identical complete headers share a sheet; totals remain actual, not declared, quantities. */
export async function createDocumentBundleWorkbook(inputs: BundleWorkbookInput[]): Promise<{ bytes: Buffer; sheets: BundleSheet[] }> {
  if (!inputs.length || new Set(inputs.map((input) => input.documentId)).size !== inputs.length) throw new DocumentWorkbookError('整批发票范围为空或存在重复单据。');
  const output = new ExcelJS.Workbook(), sheets: BundleSheet[] = [], groups = new Map<string, { sheet: ExcelJS.Worksheet; metadata: BundleSheet }>();
  const expectedRows: Array<{ sheet: string; row: number; values: ExcelJS.CellValue[]; formats: string[]; height: number | undefined }> = [], expectedImages: ImageCheck[] = [];
  output.created = new Date('2026-10-25T00:00:00.000Z'); output.modified = output.created;
  for (const input of inputs) {
    const sourceBook = new ExcelJS.Workbook(); await sourceBook.xlsx.load(input.bytes as unknown as Parameters<typeof sourceBook.xlsx.load>[0]);
    if (!input.selections && sourceBook.worksheets.length !== 1) throw new DocumentWorkbookError('已有多工作表文件缺少整批范围映射，不能当作单票重复加入。');
    const ranges = input.selections ?? sourceBook.worksheets.map((sheet) => ({ sheetName: sheet.name, startRow: 18, endRow: lastDetailRow(sheet), boxes: integer(sheet.getCell('B16').value), actualQuantity: integer(sheet.getCell('F15').value) }));
    for (const range of ranges) {
      const source = sourceBook.getWorksheet(range.sheetName);
      if (!source || range.startRow < 18 || range.endRow < range.startRow || range.endRow > source.rowCount) throw new DocumentWorkbookError('整批历史文件的单票明细范围无效。');
      if (input.expectedHeaders && Object.entries(input.expectedHeaders).some(([address, value]) => (source.getCell(address).value ?? '') !== (value ?? ''))) throw new DocumentWorkbookError('已有发票表头与当前规则或保存资料不一致，请建立更正单据后生成整批文件。');
      if (DOCUMENT_MAIN_HEADERS.some((label, index) => normalizedHeading(source.getCell(17, index + 1).value) !== label)) throw new DocumentWorkbookError('原始发票明细表头不属于当前受控制单格式。');
      integer(range.boxes); integer(range.actualQuantity);
      const key = headerKey(source);
      let group = groups.get(key);
      if (!group) {
        const currency = String(source.getCell('F12').value ?? '').replace(/[\\/*?:[\]]/g, '').slice(0, 8);
        const sheet = output.addWorksheet(`发票${groups.size + 1}${currency ? `-${currency}` : ''}`), metadata: BundleSheet = { name: sheet.name, documentIds: [], rows: 0, boxes: 0, actualQuantity: 0, ranges: [] };
        addHeader(source, sheet); group = { sheet, metadata }; groups.set(key, group); sheets.push(metadata);
      }
      const firstRow = 18 + group.metadata.rows;
      for (let row = range.startRow; row <= range.endRow; row++) {
        if (!String(source.getCell(row, 1).value ?? '').trim()) throw new DocumentWorkbookError('原始发票明细中存在缺少货箱编号的空行。');
        const targetRow = firstRow + row - range.startRow; copyRow(source, row, group.sheet, targetRow);
        expectedRows.push({ sheet: group.sheet.name, row: targetRow, values: rowValues(source, row), formats: Array.from({ length: 17 }, (_, column) => source.getCell(row, column + 1).numFmt), height: source.getRow(row).height });
      }
      addImages(sourceBook, source, range, output, group.sheet, firstRow, expectedImages);
      group.metadata.rows += range.endRow - range.startRow + 1; group.metadata.boxes = sum(group.metadata.boxes, range.boxes); group.metadata.actualQuantity = sum(group.metadata.actualQuantity, range.actualQuantity);
      if (!group.metadata.documentIds.includes(input.documentId)) group.metadata.documentIds.push(input.documentId);
      group.metadata.ranges.push({ documentId: input.documentId, startRow: firstRow, endRow: firstRow + range.endRow - range.startRow, boxes: range.boxes, actualQuantity: range.actualQuantity });
    }
  }
  for (const group of groups.values()) {
    group.sheet.getCell('B16').value = group.metadata.boxes; group.sheet.getCell('F15').value = group.metadata.actualQuantity;
    group.sheet.pageSetup = { ...group.sheet.pageSetup, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: `A1:Q${17 + group.metadata.rows}`, printTitlesRow: '17:17' };
  }
  const bytes = Buffer.from(await output.xlsx.writeBuffer()), verify = new ExcelJS.Workbook(); await verify.xlsx.load(bytes as unknown as Parameters<typeof verify.xlsx.load>[0]);
  if (verify.worksheets.length !== sheets.length) throw new DocumentWorkbookError('整批发票工作表回读数量不符。');
  for (const sheet of sheets) { const written = verify.getWorksheet(sheet.name); if (!written || written.getCell('B16').value !== sheet.boxes || written.getCell('F15').value !== sheet.actualQuantity || written.pageSetup.printArea !== `A1:Q${17 + sheet.rows}`) throw new DocumentWorkbookError('整批发票汇总或打印范围回读不符。'); }
  for (const expected of expectedRows) {
    const written = verify.getWorksheet(expected.sheet)!;
    if (JSON.stringify(rowValues(written, expected.row)) !== JSON.stringify(expected.values) || written.getRow(expected.row).height !== expected.height || expected.formats.some((format, column) => written.getCell(expected.row, column + 1).numFmt !== format)) throw new DocumentWorkbookError('整批发票明细或格式回读不符。');
  }
  const actualImages = verify.worksheets.flatMap((sheet) => sheet.getImages().map((image) => { const media = verify.getImage(Number(image.imageId)); return { sheet: sheet.name, row: image.range.tl.row, column: image.range.tl.col, hash: digest(Buffer.from(media.buffer as unknown as Uint8Array)), extension: media.extension }; }));
  if (actualImages.length !== expectedImages.length || expectedImages.some((image) => !actualImages.some((actual) => JSON.stringify(actual) === JSON.stringify(image)))) throw new DocumentWorkbookError('整批发票图片回读不符。');
  return { bytes, sheets };
}
