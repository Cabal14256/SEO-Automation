import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { Decimal } from 'decimal.js';
import { IMPORT_MAX_BYTES, PHYSICAL_RULE_VERSION, type PhysicalConfirmation, type PhysicalEntry, type PhysicalSource } from '@scm/contracts';
import { validateImportArchive } from '../imports/zip-preflight.js';
import { PhysicalValidationError, validatePhysicalEntries } from './domain.js';
import { createFbaRowFill } from '../../xlsx-fba-fill.js';

export const PHYSICAL_TEMPLATE_VERSION = 'physical-intake/v1';
export type PhysicalTemplateManifest = { source: PhysicalSource; entries: PhysicalEntry[]; version: number; m2ConfirmationId: string; templateId: string };
const LIST_SHEET = '逐箱核对', META_SHEET = '模板元数据';
const READONLY_HEADERS = ['货件修订ID', '内部箱ID', '需求ID', 'sid', 'FBA货件号', '内部码', '箱序', 'PO Number', '范围箱号', '领星毛重', '重量单位', '领星长', '领星宽', '领星高', '尺寸单位', '采用毛重(KG)', '采用长(CM)', '采用宽(CM)', '采用高(CM)', '来源时间', '箱内商品'];
export const PHYSICAL_TEMPLATE_HEADERS = [...READONLY_HEADERS, '核对结果', '实测毛重(KG)', '实测长(CM)', '实测宽(CM)', '实测高(CM)', '原因'];
const fields = ['weight', 'length', 'width', 'height'] as const;
const entryKey = (value: { shipmentRevisionId: string; boxId: string }) => JSON.stringify([value.shipmentRevisionId, value.boxId]);
const numeric = (value: string | null | undefined) => value === null || value === undefined || value === '' ? null : Number(value);
function style(sheet: ExcelJS.Worksheet, headers: string[]) {
  sheet.columns = headers.map((header) => ({ header, width: /ID|版本|时间|来源|箱内商品/.test(header) ? 30 : /原因/.test(header) ? 36 : 19 }));
  sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1, showGridLines: false }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  sheet.getRow(1).height = 30;
  sheet.getRow(1).eachCell((cell) => { cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF24344D' } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
  sheet.properties.defaultRowHeight = 24;
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
}
function add(sheet: ExcelJS.Worksheet, values: ExcelJS.CellValue[], decimalColumns: number[] = []) {
  const row = sheet.addRow(values);
  row.eachCell((cell, column) => {
    cell.font = { name: 'Arial', size: 10 }; cell.alignment = { vertical: 'middle', wrapText: true };
    if (decimalColumns.includes(column)) cell.numFmt = '0.00';
    else if (typeof cell.value === 'string') cell.numFmt = '@';
  });
  return row;
}
const delta = (measured: string | undefined, adopted: string | null) => measured && adopted ? Number(new Decimal(measured).minus(adopted).toFixed(2)) : null;

export async function createPhysicalWorkbook(confirmations: PhysicalConfirmation[]): Promise<Buffer> {
  if (!confirmations.length) throw new PhysicalValidationError('PHYSICAL_EXPORT_EMPTY', '导出至少需要一份有效实物确认。');
  const book = new ExcelJS.Workbook(); book.creator = 'SCM';
  const fillFba = createFbaRowFill(confirmations.flatMap((confirmation) => confirmation.snapshot.source.boxes.map((box) => box.fba)));
  const boxes = book.addWorksheet('实物箱明细'), items = book.addWorksheet('箱内商品'), versions = book.addWorksheet('版本与核对记录');
  style(boxes, ['子批次ID', 'FBA货件号', 'sid', 'PO Number', '范围箱号', '内部箱ID', '内部码', '箱序', '采用毛重(KG)', '采用长(CM)', '采用宽(CM)', '采用高(CM)', '领星原毛重', '重量单位', '领星原长', '领星原宽', '领星原高', '尺寸单位', '核对结果', '实测毛重(KG)', '实测长(CM)', '实测宽(CM)', '实测高(CM)', '毛重差(KG)', '长差(CM)', '宽差(CM)', '高差(CM)', '原因', '来源时间', '确认人', '确认时间', 'M3确认ID']);
  style(items, ['子批次ID', 'FBA货件号', '内部箱ID', '内部码', '箱序', 'MSKU', 'FNSKU', 'SKU', '箱内数量', '有效期', '预处理责任方', '贴标责任方', '货件修订ID']);
  style(versions, ['子批次ID', 'M2确认ID', 'M3确认ID', 'M3版本', '来源ID', '来源指纹', '来源时间', '规则版本', '确认人', '确认时间', '原始快照ID']);
  let boxCount = 0, itemCount = 0;
  const unique = new Set<string>();
  for (const confirmation of confirmations) {
    if (unique.has(confirmation.groupId)) throw new PhysicalValidationError('PHYSICAL_EXPORT_DUPLICATE', '同一子批次不能重复导出。');
    unique.add(confirmation.groupId);
    const source = confirmation.snapshot.source;
    if (source.groupId !== confirmation.groupId || source.m2ConfirmationId !== confirmation.m2ConfirmationId || source.fingerprint !== confirmation.sourceFingerprint) throw new PhysicalValidationError('PHYSICAL_EXPORT_VERSION_CONFLICT', '确认快照与导出版本不一致。');
    const checked = validatePhysicalEntries(source, confirmation.snapshot.entries, true), byBox = new Map(checked.map((entry) => [entryKey(entry), entry]));
    for (const box of source.boxes) {
      const entry = byBox.get(entryKey(box))!;
      const row = add(boxes, [confirmation.groupId, box.fba, box.sid, box.po, box.range, box.boxId, box.code, box.order,
        ...fields.map((field) => numeric(box.values[field])), box.raw.weight, box.raw.weightUnit, box.raw.length, box.raw.width, box.raw.height, box.raw.dimensionUnit,
        entry.status === 'consistent' ? '一致' : '有差异', ...fields.map((field) => numeric(entry.measured[field])), ...fields.map((field) => delta(entry.measured[field], box.values[field])), entry.reason, box.sourceObservedAt, confirmation.createdBy, confirmation.createdAt, confirmation.id], [9, 10, 11, 12, 20, 21, 22, 23, 24, 25, 26, 27]);
      fillFba(row, box.fba, boxes.columnCount);
      boxCount++;
      for (const item of box.items) { const row = add(items, [confirmation.groupId, box.fba, box.boxId, box.code, box.order, item.msku, item.fnsku, item.sku, numeric(item.quantity), item.expiration ?? null, item.prepOwner ?? null, item.labelOwner ?? null, box.shipmentRevisionId]); fillFba(row, box.fba, items.columnCount); itemCount++; }
    }
    add(versions, [confirmation.groupId, confirmation.m2ConfirmationId, confirmation.id, confirmation.m3Version, source.id, source.fingerprint, [...new Set(source.boxes.map((box) => box.sourceObservedAt))].sort().join('\n'), confirmation.snapshot.ruleVersion, confirmation.createdBy, confirmation.createdAt, source.snapshotIds.join('\n')]);
  }
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const verify = new ExcelJS.Workbook(); await verify.xlsx.load(bytes as unknown as Parameters<typeof verify.xlsx.load>[0]);
  if (verify.getWorksheet('实物箱明细')?.rowCount !== boxCount + 1 || verify.getWorksheet('箱内商品')?.rowCount !== itemCount + 1) throw new Error('实物明细生成后回读核验失败。');
  return bytes;
}

function manifestMetadata(manifest: PhysicalTemplateManifest) {
  return [['模板版本', PHYSICAL_TEMPLATE_VERSION], ['模板ID', manifest.templateId], ['来源ID', manifest.source.id], ['子批次ID', manifest.source.groupId], ['M2确认ID', manifest.m2ConfirmationId], ['M3版本', String(manifest.version)], ['来源指纹', manifest.source.fingerprint], ['规则版本', PHYSICAL_RULE_VERSION]];
}
function readonlyRows(source: PhysicalSource): ExcelJS.CellValue[][] {
  return source.boxes.map((box) => [box.shipmentRevisionId, box.boxId, box.demandId, box.sid, box.fba, box.code, box.order, box.po, box.range, box.raw.weight, box.raw.weightUnit, box.raw.length, box.raw.width, box.raw.height, box.raw.dimensionUnit, ...fields.map((field) => numeric(box.values[field])), box.sourceObservedAt,
    JSON.stringify(box.items.map((item) => ({ msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: item.quantity, expiration: item.expiration ?? null, prepOwner: item.prepOwner ?? null, labelOwner: item.labelOwner ?? null })))]);
}
export async function createPhysicalTemplate(manifest: PhysicalTemplateManifest): Promise<Buffer> {
  const entries = validatePhysicalEntries(manifest.source, manifest.entries), byBox = new Map(entries.map((entry) => [entryKey(entry), entry]));
  if (manifest.source.m2ConfirmationId !== manifest.m2ConfirmationId) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_VERSION_CONFLICT', '模板来源与 M2 确认不一致。');
  const book = new ExcelJS.Workbook(); book.creator = 'SCM';
  const sheet = book.addWorksheet(LIST_SHEET); style(sheet, PHYSICAL_TEMPLATE_HEADERS);
  const fillFba = createFbaRowFill(manifest.source.boxes.map((box) => box.fba));
  const immutable = readonlyRows(manifest.source);
  manifest.source.boxes.forEach((box, index) => {
    const entry = byBox.get(entryKey(box))!;
    const row = add(sheet, [...immutable[index]!, entry.status === 'pending' ? '待核对' : entry.status === 'consistent' ? '一致' : '有差异', ...fields.map((field) => entry.measured[field] ?? null), entry.reason], [16, 17, 18, 19, 23, 24, 25, 26]);
    fillFba(row, box.fba, PHYSICAL_TEMPLATE_HEADERS.length);
    for (let column = READONLY_HEADERS.length + 1; column <= PHYSICAL_TEMPLATE_HEADERS.length; column++) row.getCell(column).protection = { locked: false };
    row.getCell(READONLY_HEADERS.length + 1).dataValidation = { type: 'list', allowBlank: false, formulae: ['"待核对,一致,有差异"'] };
  });
  const metadata = book.addWorksheet(META_SHEET); style(metadata, ['项目', '值']); metadata.getColumn(2).width = 72;
  for (const pair of manifestMetadata(manifest)) add(metadata, pair);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function scalar(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number') throw new PhysicalValidationError('PHYSICAL_TEMPLATE_CELL_INVALID', '核对模板只接受文本和数字值，不接受公式、外链或其他单元格对象。');
  return value === null || value === undefined ? '' : String(value);
}
async function load(bytes: Buffer) {
  if (!bytes.length || bytes.length > IMPORT_MAX_BYTES) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_TOO_LARGE', '文件不能为空且不能超过 10 MB。');
  await validateImportArchive(bytes);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  if (book.worksheets.length !== 2 || !book.getWorksheet(LIST_SHEET) || !book.getWorksheet(META_SHEET)) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_INVALID', '请上传系统生成的实物箱核对模板。');
  let cellCount = 0;
  for (const sheet of book.worksheets) {
    if (sheet.rowCount > 10001 || sheet.columnCount > PHYSICAL_TEMPLATE_HEADERS.length) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_TOO_LARGE', '核对模板超过行列限制。');
    sheet.eachRow((row) => row.eachCell((cell) => { if (++cellCount > 300000) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_TOO_LARGE', '核对模板单元格过多。'); scalar(cell); }));
  }
  return book;
}
function readMetadata(book: ExcelJS.Workbook): Map<string, string> {
  const sheet = book.getWorksheet(META_SHEET)!;
  if (sheet.rowCount !== 9 || sheet.columnCount !== 2 || scalar(sheet.getCell(1, 1)) !== '项目' || scalar(sheet.getCell(1, 2)) !== '值') throw new PhysicalValidationError('PHYSICAL_TEMPLATE_METADATA_INVALID', '模板元数据已被修改。');
  const values = new Map<string, string>();
  for (let row = 2; row <= 9; row++) { const label = scalar(sheet.getCell(row, 1)); if (values.has(label)) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_METADATA_INVALID', '模板元数据重复。'); values.set(label, scalar(sheet.getCell(row, 2))); }
  if (values.get('模板版本') !== PHYSICAL_TEMPLATE_VERSION) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_METADATA_INVALID', '模板版本不受支持。');
  return values;
}
export async function readPhysicalTemplateId(bytes: Buffer): Promise<string> {
  const id = readMetadata(await load(bytes)).get('模板ID');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_METADATA_INVALID', '模板 ID 无效。');
  return id;
}

/** Preserve raw OOXML numeric text instead of a binary floating-point round trip. */
function rawNumericCells(bytes: Buffer): Map<string, string> {
  const archive = unzipSync(bytes), parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false });
  const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const arr = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
  const xml = (name: string) => archive[name] ? obj(parser.parse(strFromU8(archive[name]!))) : {};
  const workbook = obj(xml('xl/workbook.xml').workbook), relationships = arr(obj(xml('xl/_rels/workbook.xml.rels').Relationships).Relationship).map(obj);
  const sheet = arr(obj(workbook.sheets).sheet).map(obj).find((entry) => entry['@_name'] === LIST_SHEET), relationship = relationships.find((entry) => entry['@_Id'] === sheet?.['@_r:id']);
  const target = String(relationship?.['@_Target'] ?? ''), path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  if (!path || path.split('/').some((part) => part === '..')) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_INVALID', '模板工作表关系无效。');
  const values = new Map<string, string>();
  for (const row of arr(obj(obj(xml(path).worksheet).sheetData).row).map(obj)) for (const cell of arr(row.c).map(obj)) {
    if ((!cell['@_t'] || cell['@_t'] === 'n') && cell.v !== undefined) values.set(String(cell['@_r']), String(cell.v));
  }
  return values;
}
export async function parsePhysicalTemplate(bytes: Buffer, manifest: PhysicalTemplateManifest): Promise<PhysicalEntry[]> {
  const book = await load(bytes), metadata = readMetadata(book), sheet = book.getWorksheet(LIST_SHEET)!;
  for (const [name, value] of manifestMetadata(manifest)) if (metadata.get(name!) !== value) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_VERSION_CONFLICT', '模板元数据与服务器保存的版本不一致，请重新下载。');
  if (sheet.rowCount !== manifest.source.boxes.length + 1 || sheet.columnCount !== PHYSICAL_TEMPLATE_HEADERS.length) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_BOX_LIST_CHANGED', '模板箱清单存在遗漏、新增或重复。');
  PHYSICAL_TEMPLATE_HEADERS.forEach((header, index) => { if (scalar(sheet.getCell(1, index + 1)) !== header) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_HEADERS_CHANGED', '请保留模板列名与顺序。'); });
  const expected = new Map(readonlyRows(manifest.source).map((row) => [JSON.stringify([String(row[0]), String(row[1])]), row])), seen = new Set<string>(), numericCells = rawNumericCells(bytes);
  const entries: PhysicalEntry[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber), shipmentRevisionId = scalar(row.getCell(1)), boxId = scalar(row.getCell(2)), identity = JSON.stringify([shipmentRevisionId, boxId]), immutable = expected.get(identity);
    if (!immutable || seen.has(identity)) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_BOX_LIST_CHANGED', '模板箱身份重复或不在服务器清单中。');
    seen.add(identity);
    immutable.forEach((value, index) => { if (scalar(row.getCell(index + 1)) !== (value === null || value === undefined ? '' : String(value))) throw new PhysicalValidationError('PHYSICAL_TEMPLATE_READONLY_CHANGED', `第 ${rowNumber} 行只读来源字段被修改。`); });
    const label = scalar(row.getCell(22)).trim(), status = ({ 待核对: 'pending', 一致: 'consistent', 有差异: 'different', pending: 'pending', consistent: 'consistent', different: 'different' } as Record<string, PhysicalEntry['status']>)[label];
    if (!status) throw new PhysicalValidationError('PHYSICAL_ENTRY_INVALID', `第 ${rowNumber} 行核对结果无效。`);
    const measured: PhysicalEntry['measured'] = {};
    fields.forEach((field, index) => { const cell = row.getCell(23 + index), value = numericCells.get(cell.address) ?? scalar(cell).trim(); if (value) measured[field] = value; });
    entries.push({ shipmentRevisionId, boxId, status, measured, reason: scalar(row.getCell(27)).trim() });
  }
  return validatePhysicalEntries(manifest.source, entries);
}
