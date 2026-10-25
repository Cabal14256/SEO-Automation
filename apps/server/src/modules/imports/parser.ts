import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { IMPORT_MAX_BYTES, type ImportCounts, type ImportIssue, type ImportMappingVersion, type ImportNormalizedRow, type ImportRawCell, type ImportRow, type ImportSheet } from '@scm/contracts';
import { findApprovedSellers } from '../seller-mappings/resolution.js';
import { businessDateForReceipt } from './date.js';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PART_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1_000;
const MAX_ROWS = 50_000;
const MAX_CELLS = 500_000;
type Xml = Record<string, unknown>;
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false,
  parseAttributeValue: false, trimValues: false, alwaysCreateTextNode: true, removeNSPrefix: true });

export class WorkbookParseError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export { WorkbookParseError as ImportParseError };
function fail(code: string, message = '文件结构无法解析，请使用原始 XLSX 文件重新导出。'): never { throw new WorkbookParseError(code, message); }
function record(value: unknown): Xml { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Xml : {}; }
function list(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function attr(value: unknown, name: string): string { const item = record(value)[`@${name}`]; return typeof item === 'string' ? item : ''; }
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const item = record(value)['#text'];
  return typeof item === 'string' ? item : '';
}
function richText(value: unknown): string {
  const node = record(value);
  if (node.t !== undefined) return text(node.t) ?? '';
  return list(node.r).map((part) => text(record(part).t) ?? '').join('');
}
function bool(value: string): boolean { return value === '1' || value === 'true'; }
function integer(value: string, fallback?: number): number {
  if (!value && fallback !== undefined) return fallback;
  if (!/^\d+$/.test(value)) fail('INVALID_WORKSHEET');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) fail('INVALID_WORKSHEET');
  return result;
}
export function columnName(value: number): string {
  let result = '';
  for (let number = value; number > 0; number = Math.floor((number - 1) / 26)) result = String.fromCharCode(65 + (number - 1) % 26) + result;
  return result;
}
function cellPosition(address: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
  if (!match) fail('INVALID_CELL_ADDRESS');
  let column = 0;
  for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16_384 || row > 1_048_576) fail('INVALID_CELL_ADDRESS');
  return { column, row };
}
function readXml(entries: Record<string, Uint8Array>, name: string): Xml {
  const bytes = entries[name];
  if (!bytes) fail('MISSING_WORKBOOK_PART');
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('INVALID_XML_ENCODING'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('XML_DTD_NOT_SUPPORTED');
  if (XMLValidator.validate(xml) !== true) fail('INVALID_XML');
  try { return record(xmlParser.parse(xml)); } catch { fail('INVALID_XML'); }
}
function readArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  if (!bytes.byteLength || bytes.byteLength > IMPORT_MAX_BYTES) fail('FILE_LIMIT_EXCEEDED', '文件不能为空，且大小不能超过 10 MB。');
  let total = 0;
  const seen = new Set<string>();
  try {
    return unzipSync(bytes, { filter: (entry) => {
      const name = entry.name;
      if (!name || seen.has(name) || name.startsWith('/') || /[\\:\0]/.test(name) || name.split('/').some((part) => part === '..' || part === '.')) fail('UNSAFE_ARCHIVE_PATH');
      seen.add(name);
      total += entry.originalSize;
      if (seen.size > MAX_ARCHIVE_ENTRIES || total > MAX_ARCHIVE_BYTES || entry.originalSize > MAX_PART_BYTES || entry.originalSize < 0) fail('ARCHIVE_LIMIT_EXCEEDED', '文件解压后超过解析限制，请拆分后重新上传。');
      // Keep only workbook XML. Nothing is executed or extracted onto the filesystem.
      return /\.xml$|\.rels$/i.test(name) && !name.endsWith('/');
    } });
  } catch (error) {
    if (error instanceof WorkbookParseError) throw error;
    fail('INVALID_XLSX');
  }
}
type WorkbookData = { sheets: SheetData[]; date1904: boolean; issues: ImportIssue[] };
type SheetData = { meta: ImportSheet; rows: { number: number; hidden: boolean; cells: ImportRawCell[] }[] };
const builtInFormats: Record<number, string> = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
  14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 49: '@' };

function loadWorkbook(bytes: Uint8Array): WorkbookData {
  const entries = readArchive(bytes);
  const types = record(readXml(entries, '[Content_Types].xml').Types);
  const overrides = list(types.Override);
  if (overrides.some((value) => /macroEnabled|vbaProject/i.test(attr(value, 'ContentType')))) fail('UNSUPPORTED_WORKBOOK', '只支持不含宏的 XLSX 工作簿。');
  if (!overrides.some((value) => attr(value, 'PartName') === '/xl/workbook.xml' && attr(value, 'ContentType') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')) fail('UNSUPPORTED_WORKBOOK');
  const book = record(readXml(entries, 'xl/workbook.xml').workbook);
  const relationships = list(record(readXml(entries, 'xl/_rels/workbook.xml.rels').Relationships).Relationship);
  const targets = new Map<string, string>();
  const issues: ImportIssue[] = [];
  for (const relation of relationships) {
    if (attr(relation, 'TargetMode') === 'External') {
      issues.push({ code: 'EXTERNAL_RELATIONSHIP_IGNORED', severity: 'warning', message: '工作簿包含外部链接；解析不访问外部内容。' });
      continue;
    }
    const target = attr(relation, 'Target');
    if (!target || /[\\:\0]/.test(target) || target.split('/').some((part) => part === '..')) fail('UNSAFE_RELATIONSHIP_TARGET');
    const fullPath = target.startsWith('/') ? target.slice(1) : posix.join('xl', target);
    const relationId = attr(relation, 'Id');
    if (!relationId || targets.has(relationId)) fail('INVALID_WORKBOOK_RELATIONSHIP');
    targets.set(relationId, fullPath);
  }
  const shared = entries['xl/sharedStrings.xml'] ? list(record(readXml(entries, 'xl/sharedStrings.xml').sst).si).map(richText) : [];
  const styles = entries['xl/styles.xml'] ? record(readXml(entries, 'xl/styles.xml').styleSheet) : {};
  const customFormats = new Map(list(record(styles.numFmts).numFmt).map((value) => [integer(attr(value, 'numFmtId')), attr(value, 'formatCode')]));
  const styleFormats = list(record(styles.cellXfs).xf).map((value) => integer(attr(value, 'numFmtId'), 0));
  if (!styleFormats.length) styleFormats.push(0);
  const sheets: SheetData[] = [];
  const names = new Set<string>();
  let cellsSeen = 0;
  let rowsSeen = 0;
  for (const sheet of list(record(book.sheets).sheet)) {
    if (sheets.length >= 100) fail('WORKSHEET_LIMIT_EXCEEDED', '工作簿超过 100 张工作表，请拆分后上传。');
    const name = attr(sheet, 'name');
    if (!name || names.has(name)) fail('INVALID_WORKSHEET');
    names.add(name);
    const target = targets.get(attr(sheet, 'id'));
    if (!target) fail('MISSING_WORKSHEET');
    const xml = record(readXml(entries, target).worksheet);
    if (!Object.keys(xml).length) fail('MISSING_WORKSHEET');
    const hiddenColumns = new Set<number>();
    for (const col of list(record(xml.cols).col)) {
      const min = integer(attr(col, 'min'));
      const max = integer(attr(col, 'max'));
      if (min < 1 || max < min || max > 16_384) fail('INVALID_WORKSHEET');
      if (bool(attr(col, 'hidden'))) for (let value = min; value <= max; value++) hiddenColumns.add(value);
    }
    let maxRow = 0;
    let maxColumn = 0;
    const rowNumbers = new Set<number>();
    const rows: SheetData['rows'] = [];
    for (const row of list(record(xml.sheetData).row)) {
      rowsSeen++;
      if (rowsSeen > MAX_ROWS) fail('WORKSHEET_LIMIT_EXCEEDED', '工作簿总行数超过 50000 行，请拆分后上传。');
      const rowNumber = integer(attr(row, 'r'), maxRow + 1);
      if (rowNumber < 1 || rowNumber > 1_048_576 || rowNumbers.has(rowNumber)) fail('INVALID_WORKSHEET');
      rowNumbers.add(rowNumber);
      maxRow = Math.max(maxRow, rowNumber);
      const cells: ImportRawCell[] = [];
      const cellAddresses = new Set<string>();
      for (const source of list(record(row).c)) {
        if (++cellsSeen > MAX_CELLS) fail('WORKSHEET_LIMIT_EXCEEDED', '工作簿单元格数超过 500000 个，请拆分后上传。');
        const address = attr(source, 'r');
        const position = cellPosition(address);
        if (position.row !== rowNumber || cellAddresses.has(address)) fail('INVALID_CELL_ADDRESS');
        cellAddresses.add(address);
        maxColumn = Math.max(maxColumn, position.column);
        const node = record(source);
        const kind = attr(source, 't') || 'n';
        const raw = kind === 'inlineStr' ? richText(node.is) : text(node.v);
        let value: ImportRawCell['value'] = raw;
        if (kind === 's' && raw !== null) {
          const index = integer(raw);
          if (index >= shared.length) fail('INVALID_SHARED_STRING');
          value = shared[index]!;
        } else if (kind === 'b' && raw !== null && raw !== '') {
          if (raw !== '0' && raw !== '1') fail('INVALID_CELL_VALUE');
          value = raw === '1';
        } else if (kind === 'n' && raw !== null && raw !== '') {
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) fail('INVALID_CELL_VALUE');
          value = Number(raw);
        }
        const style = integer(attr(source, 's'), 0);
        const formatId = styleFormats[style];
        if (formatId === undefined) fail('INVALID_STYLE_INDEX');
        const hasFormula = Object.prototype.hasOwnProperty.call(node, 'f');
        cells.push({ address, column: columnName(position.column), type: kind, rawValue: raw, value,
          numberFormat: customFormats.get(formatId) ?? builtInFormats[formatId] ?? `builtin:${formatId}`,
          formula: hasFormula ? text(node.f) ?? '' : null,
          formulaCache: !hasFormula ? 'not_formula' : node.v === undefined ? 'absent' : raw === null || raw === '' ? 'empty' : 'present',
          hidden: hiddenColumns.has(position.column) });
      }
      rows.push({ number: rowNumber, hidden: bool(attr(row, 'hidden')), cells });
    }
    const mergedRanges = list(record(xml.mergeCells).mergeCell).map((value) => {
      const ref = attr(value, 'ref');
      const parts = ref.split(':');
      if (parts.length !== 2) fail('INVALID_MERGED_RANGE');
      const first = cellPosition(parts[0]!);
      const last = cellPosition(parts[1]!);
      if (first.column > last.column || first.row > last.row) fail('INVALID_MERGED_RANGE');
      return ref;
    });
    const state = attr(sheet, 'state') || 'visible';
    if (!['visible', 'hidden', 'veryHidden'].includes(state)) fail('INVALID_WORKSHEET');
    sheets.push({ meta: { name, state: state as ImportSheet['state'], rowCount: maxRow, columnCount: maxColumn, mergedRanges,
      hiddenColumns: [...hiddenColumns].sort((a, b) => a - b), headers: (rows.find((row) => row.number === 1)?.cells ?? []).map((cell) => ({ column: cell.column, value: cell.value === null ? null : String(cell.value) })) }, rows });
  }
  if (!sheets.length) fail('MISSING_WORKSHEET');
  return { sheets, date1904: bool(attr(book.workbookPr, 'date1904')), issues };
}

export function inspectWorkbook(bytes: Uint8Array): { sheets: ImportSheet[] } {
  return { sheets: loadWorkbook(bytes).sheets.map((sheet) => sheet.meta) };
}

export type ImportSeller = { id: string; name?: string; sid: number; country: string; version: number; status: string; aliases: string[] };
export type ParseWorkbookInput = { parseRunId: string; sheetName: string; mappingVersion: ImportMappingVersion; sellers?: ImportSeller[] };
type Field = Exclude<keyof ImportNormalizedRow, 'sellerMappingId' | 'sellerMappingVersion' | 'sid' | 'sourceTicketIndex' | 'sourceMemberIndex'>;
const fieldMaps: Record<ParseWorkbookInput['mappingVersion'], Partial<Record<Field, string>>> = {
  'fba-list-v1': { fba: 'A' },
  'feishu-v1': { sourceRecordId: 'A', shop: 'B', channel: 'C', country: 'D', destinationFc: 'E', fba: 'F', referenceQuantity: 'G', sourceDate: 'J' },
  'manual-v1': { shop: 'A', channel: 'B', country: 'C', destinationFc: 'D', fba: 'E', referenceQuantity: 'F', sourceDate: 'G', subBatchName: 'H', notes: 'I' },
  'online-v1': { shop: 'A', channel: 'B', country: 'C', destinationFc: 'D', fba: 'E', referenceQuantity: 'F', sourceFilledAt: 'G', subBatchName: 'H', notes: 'I', destinationAddress: 'J', shipmentCreatedAt: 'K', metadataSource: 'L', metadataObservedAt: 'M' },
};
const headerRules = {
  'fba-list-v1': {},
  'feishu-v1': { B: ['店铺'], C: ['渠道'], D: ['fx国家', '国家'], E: ['仓库地址', '目的FC'], F: ['FBA货件号'] },
  'manual-v1': { A: ['店铺'], B: ['渠道'], C: ['国家'], D: ['目的FC'], E: ['FBA货件号'], F: ['参考数量'], G: ['业务日期'], H: ['子批次名称'], I: ['备注'] },
  'online-v1': { A: ['店铺'], B: ['渠道'], C: ['国家'], D: ['目的FC'], E: ['FBA货件号'], F: ['参考数量'], G: ['来源填写时间'], H: ['子批次名称'], I: ['备注'], J: ['仓库地址'], K: ['货件创建时间'], L: ['元数据来源'], M: ['查询时间'] },
};
export type ImportSheetSelection = Pick<ParseWorkbookInput, 'sheetName' | 'mappingVersion'>;
const fbaListHeaders = new Set(['FBA', 'FBA货件号', 'FBA号']);
const fbaHeaderText = (value: string) => value.normalize('NFKC').trim().toUpperCase().replace(/\s+/g, '');
const hasCellContent = (cell: ImportRawCell) => cell.formula !== null || cell.value !== null && String(cell.value).trim() !== '';
function fbaListLayout(sheet: SheetData) {
  const populated = [...sheet.rows].sort((a, b) => a.number - b.number).filter((row) => row.cells.some(hasCellContent));
  if (populated.some((row) => row.cells.some((cell) => cell.column !== 'A' && hasCellContent(cell)))) return null;
  const first = populated[0];
  const value = first?.cells.find((cell) => cell.column === 'A')?.value;
  const text = value === null || value === undefined ? '' : fbaHeaderText(String(value));
  if (!fbaListHeaders.has(text) && !text.startsWith('FBA')) return null;
  return { headerRow: fbaListHeaders.has(text) ? first!.number : 0 };
}
function headerMismatches(sheet: ImportSheet, mappingVersion: ImportSheetSelection['mappingVersion']) {
  // Full single-column validation uses source cells when loading the workbook.
  // Stored metadata also supports a list whose first populated row follows blank rows.
  if (mappingVersion === 'fba-list-v1') {
    const populated = sheet.headers.filter((header) => header.value?.trim());
    return populated.some((header) => header.column !== 'A' || !fbaHeaderText(header.value!).startsWith('FBA')) ? [['A', ['FBA']]] as [string, string[]][] : [];
  }
  const headerMap = new Map(sheet.headers.map((header) => [header.column, header.value?.trim()]));
  return Object.entries(headerRules[mappingVersion]).filter(([column, values]) => !(values as string[]).includes(headerMap.get(column) ?? ''));
}
export function validateImportSheetSelection(sheets: ImportSheet[], input: ImportSheetSelection) {
  const sheet = sheets.find((candidate) => candidate.name === input.sheetName);
  if (!sheet) fail('WORKSHEET_NOT_FOUND', '选择的工作表不存在，请刷新工作表列表。');
  if (sheet.rowCount > 10_000 || sheet.columnCount > 256) fail('WORKSHEET_LIMIT_EXCEEDED', '输入工作表最多支持 10000 行及 256 列，请拆分后上传。');
  if (!headerRules[input.mappingVersion]) fail('SOURCE_MAPPING_REQUIRED', '请选择已登记的字段映射版本。');
  const mismatches = headerMismatches(sheet, input.mappingVersion);
  if (mismatches.length) fail('SOURCE_MAPPING_REQUIRED', `工作表表头与映射版本不符，请核对 ${mismatches.map(([column]) => column).join('、')} 列。`);
  return sheet;
}
function hasDemandRows(sheet: SheetData, mappingVersion: ImportSheetSelection['mappingVersion']) {
  const columns = new Set(Object.entries(fieldMaps[mappingVersion]).filter(([field]) => !['metadataSource', 'metadataObservedAt'].includes(field)).map(([, column]) => column));
  const headerRow = mappingVersion === 'fba-list-v1' ? fbaListLayout(sheet)?.headerRow ?? 0 : 1;
  // A malformed business row still belongs in row review. Only completely blank
  // input (including whitespace/formatting-only rows) is rejected as an empty file.
  return sheet.rows.some((row) => row.number > headerRow && row.cells.some((cell) => columns.has(cell.column) && hasCellContent(cell)));
}
export function validateImportWorkbook(bytes: Uint8Array, input?: ImportSheetSelection) {
  const workbook = loadWorkbook(bytes), sheets = workbook.sheets.map((sheet) => sheet.meta);
  if (input) {
    validateImportSheetSelection(sheets, input);
    const source = workbook.sheets.find((sheet) => sheet.meta.name === input.sheetName)!;
    if (input.mappingVersion === 'fba-list-v1' && !fbaListLayout(source)) fail('SOURCE_MAPPING_REQUIRED', 'FBA 清单仅支持单列 FBA，可保留 FBA 表头并使用空行分票。');
    if (!hasDemandRows(source, input.mappingVersion)) fail('EMPTY_WORKSHEET', '请先填写至少一行需求。');
    return { sheets, candidates: [input], selection: input, issues: workbook.issues };
  }
  const supported = workbook.sheets.flatMap((sheet) => (Object.keys(headerRules) as ImportSheetSelection['mappingVersion'][])
    .filter((mappingVersion) => mappingVersion === 'fba-list-v1' ? fbaListLayout(sheet) !== null : !headerMismatches(sheet.meta, mappingVersion).length)
    .map((mappingVersion) => ({ sheet, mappingVersion })));
  if (!supported.length) fail('UNSUPPORTED_IMPORT_HEADERS', '未找到支持的需求表头。请下载需求导入模板，保留第一行的列名和顺序后填写。');
  for (const candidate of supported) validateImportSheetSelection(sheets, { sheetName: candidate.sheet.meta.name, mappingVersion: candidate.mappingVersion });
  const candidates = supported.filter(({ sheet, mappingVersion }) => hasDemandRows(sheet, mappingVersion))
    .map(({ sheet, mappingVersion }) => ({ sheetName: sheet.meta.name, mappingVersion }));
  if (!candidates.length) fail('EMPTY_WORKSHEET', '请先填写至少一行需求。');
  const candidate = candidates.length === 1 ? candidates[0]! : null;
  const selection = candidate && sheets.find((sheet) => sheet.name === candidate.sheetName)?.state === 'visible' ? candidate : null;
  return { sheets, candidates, selection, issues: selection ? workbook.issues : [...workbook.issues, issue('SOURCE_MAPPING_REQUIRED',
    candidates.length > 1 ? '检测到多个可用需求工作表，请选择工作表和字段映射后解析。' : '需求工作表处于隐藏状态，请人工选择工作表和字段映射后解析。')] };
}
function normalizedText(value: string): string { return value.normalize('NFKC').trim().toLowerCase(); }
function issue(code: string, message: string, severity: ImportIssue['severity'] = 'warning', cell?: ImportRawCell): ImportIssue {
  return { code, message, severity, ...(cell ? { column: cell.column, address: cell.address } : {}) };
}
function dateValue(cell: ImportRawCell | undefined, date1904: boolean): string | null {
  if (!cell || cell.value === null || cell.value === '') return null;
  if (cell.type === 'n' && typeof cell.value === 'number') {
    const days = cell.value;
    if (days < 0 || days > 2_958_465) return null;
    // Excel's fictitious 1900-02-29 has no valid Gregorian equivalent.
    if (!date1904 && Math.floor(days) === 60) return null;
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const date = new Date(epoch + Math.round((days - (!date1904 && days >= 61 ? 1 : 0)) * 86_400_000));
    return date.toISOString().replace(/T00:00:00\.000Z$/, '').replace(/\.000Z$/, 'Z');
  }
  return String(cell.value).trim() || null;
}

export function parseWorkbook(bytes: Uint8Array, input: ParseWorkbookInput): { sheets: ImportSheet[]; rows: ImportRow[]; counts: ImportCounts; issues: ImportIssue[] } {
  const workbook = loadWorkbook(bytes);
  const source = workbook.sheets.find((sheet) => sheet.meta.name === input.sheetName);
  if (!source) fail('WORKSHEET_NOT_FOUND', '选择的工作表不存在，请刷新工作表列表。');
  const mapping = fieldMaps[input.mappingVersion];
  if (!mapping) fail('SOURCE_MAPPING_REQUIRED', '请选择已登记的字段映射版本。');
  validateImportSheetSelection(workbook.sheets.map((sheet) => sheet.meta), input);
  const listLayout = input.mappingVersion === 'fba-list-v1' ? fbaListLayout(source) : null;
  if (input.mappingVersion === 'fba-list-v1' && !listLayout) fail('SOURCE_MAPPING_REQUIRED', 'FBA 清单仅支持单列 FBA，可保留 FBA 表头并使用空行分票。');
  const runIssues = [...workbook.issues];
  if (input.mappingVersion === 'feishu-v1') runIssues.push(issue('REFERENCE_QUANTITY_UNCONFIRMED', 'G 列仅作待确认参考数量，不参与正式商品数量、申报量或已发量计算。'));
  if (source.meta.state !== 'visible') runIssues.push(issue('HIDDEN_WORKSHEET', '所选工作表处于隐藏状态，原始状态已保留。'));
  const usedColumns = new Set(Object.values(mapping));
  const mappedMerges = source.meta.mergedRanges.map((ref) => {
    const [start, end] = ref.split(':').map(cellPosition);
    return { start: start!, end: end! };
  }).filter(({ start, end }) => [...usedColumns].some((column) => {
    const number = cellPosition(`${column}1`).column;
    return number >= start.column && number <= end.column;
  }));
  const rows: ImportRow[] = [];
  const businessColumns = new Set(Object.entries(mapping).filter(([field]) => !['metadataSource', 'metadataObservedAt'].includes(field)).map(([, column]) => column));
  const headerRow = listLayout?.headerRow ?? 1;
  let previousMemberRow: number | undefined;
  let sourceTicketIndex = 1;
  for (const row of [...source.rows].sort((a, b) => a.number - b.number).filter((item) => item.number > headerRow && item.cells.some((cell) => businessColumns.has(cell.column) && hasCellContent(cell)))) {
    if (previousMemberRow !== undefined && row.number > previousMemberRow + 1) sourceTicketIndex += 1;
    previousMemberRow = row.number;
    const cells = new Map(row.cells.map((cell) => [cell.column, cell]));
    const issues: ImportIssue[] = [];
    const normalized: ImportNormalizedRow = { shop: null, channel: null, country: null, destinationFc: null, fba: null, referenceQuantity: null,
      sourceDate: null, sourceRecordId: null, notes: null, subBatchName: null, sellerMappingId: null, sid: null, sellerMappingVersion: null,
      sourceTicketIndex, sourceMemberIndex: rows.length + 1 };
    for (const [field, column] of Object.entries(mapping) as [Field, string][]) {
      const cell = cells.get(column);
      if (!cell) continue;
      if (cell.hidden) issues.push(issue('HIDDEN_MAPPED_COLUMN', '映射字段位于隐藏列，请核对原始值。', 'warning', cell));
      if (cell.formula !== null && cell.formulaCache !== 'present') {
        issues.push(issue('FORMULA_CACHE_MISSING', '公式没有可用缓存结果，请重新导出或人工核对。', ['shop', 'fba', 'referenceQuantity'].includes(field) ? 'error' : 'warning', cell));
        continue;
      }
      if (cell.type === 'e') { issues.push(issue('SOURCE_CELL_ERROR', '来源单元格包含 Excel 错误值。', 'error', cell)); continue; }
      if (cell.value === null || cell.value === '') continue;
      if (typeof cell.value === 'boolean') { issues.push(issue('INVALID_FIELD_TYPE', '该字段不能使用布尔值。', 'error', cell)); continue; }
      if (['shop', 'fba', 'sourceRecordId', 'destinationFc'].includes(field) && typeof cell.value === 'number') {
        issues.push(issue('NUMERIC_IDENTIFIER', '编号或店铺按文本处理；来源为数字，需核对前导零和精度。', 'warning', cell));
        normalized[field] = cell.rawValue?.trim() || null;
      } else if (field === 'referenceQuantity' && typeof cell.value === 'number' && !Number.isSafeInteger(cell.value) && Number.isInteger(cell.value)) {
        normalized.referenceQuantity = cell.rawValue?.trim() || null;
        issues.push(issue('UNSAFE_NUMERIC_QUANTITY', '参考数量超过安全整数范围，已保留原始数字文本，请核对后改为文本。', 'error', cell));
      } else if (['sourceDate', 'sourceFilledAt', 'shipmentCreatedAt'].includes(field)) normalized[field] = dateValue(cell, workbook.date1904);
      else normalized[field] = String(cell.value).trim() || null;
      if (field === 'referenceQuantity' && normalized.referenceQuantity !== null && !/^\d+$/.test(normalized.referenceQuantity)) issues.push(issue('INVALID_REFERENCE_QUANTITY', '参考数量应为非负整数，原始值已保留。', 'error', cell));
    }
    if (normalized.fba) normalized.fba = normalized.fba.toUpperCase();
    if (!normalized.shop) issues.push(issue('SHOP_REQUIRED', input.mappingVersion === 'fba-list-v1' ? '店铺待 FBA 查询补全。' : '缺少店铺。', input.mappingVersion === 'fba-list-v1' ? 'warning' : 'error', cells.get(mapping.shop!)));
    if (!normalized.fba) issues.push(issue('FBA_REQUIRED', '缺少 FBA 货件号。', 'error', cells.get(mapping.fba!)));
    else if (!/^FBA[A-Z0-9]+$/.test(normalized.fba)) issues.push(issue('INVALID_FBA', 'FBA 货件号应以 FBA 开头且只包含字母和数字。', 'error', cells.get(mapping.fba!)));
    if (normalized.shop) {
      const sellers = findApprovedSellers(normalized.shop, input.sellers ?? []);
      if (sellers.length === 1) {
        const seller = sellers[0]!;
        normalized.sellerMappingId = seller.id; normalized.sid = seller.sid; normalized.sellerMappingVersion = seller.version;
        if (normalized.country && normalizedText(normalized.country) !== normalizedText(seller.country)) issues.push(issue('SELLER_COUNTRY_MISMATCH', '来源国家与已批准店铺国家不一致，请核对。', 'warning', cells.get(mapping.country!)));
      } else issues.push(issue(sellers.length ? 'SELLER_ALIAS_CONFLICT' : 'SOURCE_MAPPING_REQUIRED', sellers.length ? '来源店铺名称对应多个已批准店铺，请人工确认。' : '来源店铺名称未匹配已批准店铺；请在本次导入中确认店铺。', 'warning', cells.get(mapping.shop!)));
    }
    if (row.hidden) issues.push(issue('HIDDEN_SOURCE_ROW', '来源行处于隐藏状态，已保留且需要核对。'));
    if (mappedMerges.some(({ start, end }) => row.number >= start.row && row.number <= end.row)) issues.push(issue('MERGED_MAPPED_CELL', '映射字段涉及合并单元格；解析保留原值，不向其他行填充。'));
    rows.push({ id: randomUUID(), parseRunId: input.parseRunId, sheetName: input.sheetName, rowNumber: row.number, hidden: row.hidden,
      status: issues.some((item) => item.severity === 'error') ? 'error' : issues.length ? 'needs_review' : 'valid', rawCells: row.cells, normalized, issues });
  }
  const duplicateKeys = new Map<string, ImportRow[]>();
  for (const row of rows) {
    if (!row.normalized.fba) continue;
    const key = `${normalizedText(row.normalized.shop ?? '')}\0${row.normalized.fba}`;
    duplicateKeys.set(key, [...duplicateKeys.get(key) ?? [], row]);
  }
  for (const group of duplicateKeys.values()) if (group.length > 1) for (const row of group) {
    row.issues.push(issue('DUPLICATE_SHIPMENT', `同一来源店铺及 FBA 在工作表中出现 ${group.length} 行，保留全部行并等待核对。`));
    if (row.status === 'valid') row.status = 'needs_review';
  }
  return { sheets: workbook.sheets.map((sheet) => sheet.meta), rows, issues: runIssues, counts: { totalRows: rows.length,
    validFbaRows: rows.filter((row) => row.normalized.fba && /^FBA[A-Z0-9]+$/.test(row.normalized.fba)).length,
    errorRows: rows.filter((row) => row.status === 'error').length, warningRows: rows.filter((row) => row.issues.some((item) => item.severity === 'warning')).length } };
}

// Initial uploads discover an unambiguous supported header layout, independently
// of sheet names. Later parses bind an explicit sheet/mapping pair. The worker resolves seller snapshots
// in its publishing transaction, so a changed approval cannot leak through a stale parse.
export function parseImportWorkbook(bytes: Uint8Array, input?: { sheetName: string; mappingVersion: ParseWorkbookInput['mappingVersion'] }) {
  const inspected = validateImportWorkbook(bytes, input);
  const { sheets } = inspected;
  const selected = inspected.selection;
  if (!selected) return { sheets, sheetName: null, mappingVersion: null, status: 'awaiting_mapping' as const,
    rows: [] as ImportRow[], counts: { totalRows: 0, validFbaRows: 0, errorRows: 0, warningRows: 0 },
    issues: inspected.issues };
  try {
    const parsed = parseWorkbook(bytes, { ...selected, parseRunId: randomUUID() });
    return { ...parsed, ...selected, status: 'preview_ready' as const };
  } catch (error) {
    if (!(error instanceof WorkbookParseError) || error.code !== 'SOURCE_MAPPING_REQUIRED') throw error;
    return { sheets, ...selected, status: 'awaiting_mapping' as const, rows: [] as ImportRow[],
      counts: { totalRows: 0, validFbaRows: 0, errorRows: 0, warningRows: 0 }, issues: [issue(error.code, error.message)] };
  }
}

export function shanghaiImportDates(importedAt: Date) {
  const dates = businessDateForReceipt(importedAt);
  return { businessDate: dates.businessDate, weekStartDate: dates.weekStartDate, weekEndDate: dates.weekEndDate, datePolicyVersion: dates.datePolicyVersion };
}
