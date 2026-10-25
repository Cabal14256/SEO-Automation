import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { DOCUMENT_FIELD_OPTIONS } from '@scm/contracts';
import { validateImportArchive } from '../imports/zip-preflight.js';

export const REFERENCE_WORKBOOK_PARSER_VERSION = 'fengxin-reference/v1';
type Kind = 'address_catalog' | 'channel_catalog' | 'customs_options' | 'transit_reference';
export type ReferenceWorkbookPlan = {
  datasets: Array<{ kind: Kind; sheetName: string; sourceRange: string; data: Record<string, unknown> }>;
  addresses: Array<{ key: string; data: Record<string, unknown>; sourceRows: number[]; issues: string[] }>;
  summary: Record<string, unknown>;
};
type SourceCell = { address: string; value: unknown; type: number; numFmt: string; display: string; formula: boolean; mergedInto?: string };
type SourceRow = { sourceRow: number; values: Record<string, string>; cells: SourceCell[]; issues: string[] };
type SkippedRow = { sourceRow: number; reason: 'header' | 'region_title'; cells: SourceCell[] };
type ParsedSheet = { sheetName: string; sourceRange: string; columns: readonly string[]; rows: SourceRow[]; skippedRows: SkippedRow[] };
const addressFields = ['addressLabel', 'addressCode', 'destinationFc', 'recipientName', 'recipientCompany', 'telephone', 'mobile', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'state', 'countryCode', 'postalCode'] as const;
const addressHeaders = ['地址简称', '地址编码', 'FBA仓库代码', '联系人', '公司名', '联系电话', '联系手机', '地址一', '地址二', '地址三', '城市', '省/洲', '国家', '邮编'];
const customsOptions = new Set<string>(DOCUMENT_FIELD_OPTIONS.customsMode);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const header = (value: string) => value.replace(/[\s*]/g, '');
const normalized = (value: string) => value.normalize('NFKC').trim();
const identity = (value: string) => normalized(value).toUpperCase();

function primitiveDisplay(value: unknown, numFmt: string): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    // ExcelJS cell.text does not apply number formats. Preserve identifier zero
    // padding without interpreting dates, currencies or transit-time units.
    const mask = (numFmt.split(';')[0] ?? '').replace(/_.|\*./g, '').trim();
    if (/^0+$/.test(mask) && Number.isSafeInteger(value) && value >= 0) return String(value).padStart(mask.length, '0');
    return String(value);
  }
  if (typeof value === 'object') {
    if ('result' in value) return primitiveDisplay(value.result, numFmt);
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((part: { text?: string }) => part.text ?? '').join('');
    if ('text' in value) return String(value.text ?? '');
    if ('error' in value) return String(value.error ?? '');
    return '';
  }
  return String(value);
}

function sourceCell(cell: ExcelJS.Cell): SourceCell {
  const value = cell.value ?? null;
  const formula = typeof value === 'object' && value !== null && ('formula' in value || 'sharedFormula' in value);
  return { address: cell.address, value: JSON.parse(JSON.stringify(value)) as unknown, type: cell.type, numFmt: cell.numFmt ?? 'General',
    display: primitiveDisplay(value, cell.numFmt ?? 'General'), formula,
    ...(cell.isMerged && cell.master.address !== cell.address ? { mergedInto: cell.master.address } : {}) };
}

function readSheet(book: ExcelJS.Workbook, sheetName: string, fields: readonly string[], headers: readonly string[] | null, headerOffset = 0): ParsedSheet {
  const sheet = book.getWorksheet(sheetName);
  if (!sheet || sheet.rowCount > 10_000 || sheet.columnCount > fields.length) throw new Error(`参考工作表 ${sheetName} 缺失或超出支持的布局范围。`);
  const rows: SourceRow[] = [], skippedRows: SkippedRow[] = [];
  let lastRow = 0, headerFound = headers === null;
  for (let number = 1; number <= sheet.rowCount; number++) {
    const cells = fields.map((_, index) => sourceCell(sheet.getCell(number, index + 1)));
    if (!cells.some((cell) => cell.display || cell.formula)) continue;
    lastRow = number;
    const displays = cells.map((cell) => cell.display.trim());
    if (headers && headers.every((expected, index) => !cells[index + headerOffset]?.formula && header(displays[index + headerOffset] ?? '') === expected)) {
      skippedRows.push({ sourceRow: number, reason: 'header', cells }); headerFound = true; continue;
    }
    const unique = [...new Set(displays.filter(Boolean))];
    if (sheetName === '地址库' && unique.length === 1 && /(?:地址|仓库)$/.test(unique[0]!) && !cells.some((cell) => cell.formula)) {
      skippedRows.push({ sourceRow: number, reason: 'region_title', cells }); continue;
    }
    if (sheetName === '报关方式' && displays[0] === '报关方式') { skippedRows.push({ sourceRow: number, reason: 'header', cells }); continue; }
    const values = Object.fromEntries(fields.map((field, index) => [field, cells[index]!.formula || cells[index]!.type === ExcelJS.ValueType.Error ? '' : displays[index]!]));
    rows.push({ sourceRow: number, values, cells, issues: [] });
  }
  if (!headerFound || !rows.length) throw new Error(`参考工作表 ${sheetName} 表头不匹配或没有资料。`);
  return { sheetName, sourceRange: `A1:${sheet.getColumn(fields.length).letter}${lastRow}`, columns: fields, rows, skippedRows };
}

function grouped<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) { const id = key(row), group = groups.get(id) ?? []; group.push(row); groups.set(id, group); }
  return groups;
}

/** Read-only parser: cached formulas and reference catalogs never become business decisions. */
export async function parseReferenceWorkbook(bytes: Buffer): Promise<ReferenceWorkbookPlan> {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('参考资料须为不超过 10 MiB 的 XLSX。');
  await validateImportArchive(bytes);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  const addressesSheet = readSheet(book, '地址库', addressFields, addressHeaders);
  const channels = readSheet(book, '发货渠道', ['name', 'section'], ['渠道名称', '板块']);
  const customs = readSheet(book, '报关方式', ['customsMode'], null);
  const transit = readSheet(book, '预计送仓数据', ['sourceLookupKey', 'channelName', 'destinationFc', 'estimatedTransit', 'region'], ['渠道', 'FBA仓库代码', '预计送仓时效', '区域'], 1);
  const sourceDigest = createHash('sha256').update(bytes).digest('hex');
  const uniqueAddresses = [...grouped(addressesSheet.rows, (row) => digest(addressFields.map((field) => row.values[field]))).values()];
  const duplicates = uniqueAddresses.filter((rows) => rows.length > 1).map((rows) => ({ sourceRows: rows.map((row) => row.sourceRow), removedCount: rows.length - 1 }));
  const missingFcRows: number[] = [], invalidAddressRows: Array<{ sourceRows: number[]; issues: string[] }> = [];
  const prepared = uniqueAddresses.map((rows) => {
    const original = rows[0]!, values = { ...original.values }, sourceRows = rows.map((row) => row.sourceRow), issues: string[] = [];
    values.destinationFc = identity(values.destinationFc ?? ''); values.countryCode = identity(values.countryCode ?? '');
    if (!values.destinationFc) { issues.push('DESTINATION_FC_REQUIRED'); missingFcRows.push(...sourceRows); }
    for (const field of ['recipientName', 'addressLine1', 'city', 'countryCode', 'postalCode']) if (!values[field]) issues.push(`ADDRESS_REQUIRED:${field}`);
    if (values.countryCode && !/^[A-Z]{2}$/.test(values.countryCode)) issues.push('COUNTRY_CODE_NOT_ISO');
    if (rows.some((row) => row.cells.some((cell) => cell.formula))) issues.push('FORMULA_SOURCE_ONLY');
    if (rows.some((row) => row.cells.some((cell) => cell.type === ExcelJS.ValueType.Error))) issues.push('CELL_ERROR');
    return { values, sourceRows, issues, rows };
  });
  const conflicts = [...grouped(prepared.filter((row) => row.values.destinationFc), (row) => `${row.values.countryCode}:${row.values.destinationFc}`)]
    .filter(([, rows]) => rows.length > 1).map(([scope, rows]) => {
      for (const row of rows) row.issues.push('ADDRESS_FC_CONFLICT');
      return { scope, sourceRows: rows.flatMap((row) => row.sourceRows), differingFields: addressFields.filter((field) => new Set(rows.map((row) => row.values[field])).size > 1) };
    });
  const addresses: ReferenceWorkbookPlan['addresses'] = [];
  for (const row of prepared) {
    for (const source of row.rows) source.issues.push(...row.issues);
    if (row.issues.length) { invalidAddressRows.push({ sourceRows: row.sourceRows, issues: row.issues }); continue; }
    const values = row.values;
    const suffix = values.addressCode ? encodeURIComponent(normalized(values.addressCode)) : digest(addressFields.map((field) => values[field])).slice(0, 16);
    let key = `fengxin:address:${values.countryCode}:${encodeURIComponent(values.destinationFc!)}:${suffix}`;
    if (key.length > 200) key = `fengxin:address:${values.countryCode}:${digest([values.destinationFc, values.addressCode]).slice(0, 24)}`;
    addresses.push({ key, sourceRows: row.sourceRows, issues: [], data: {
      destinationFc: values.destinationFc!, addressCode: values.addressCode ?? '', recipientName: values.recipientName!, recipientCompany: values.recipientCompany ?? '',
      addressLine1: values.addressLine1!, addressLine2: values.addressLine2 ?? '', addressLine3: values.addressLine3 ?? '', city: values.city!, state: values.state ?? '',
      countryCode: values.countryCode!, postalCode: values.postalCode!, phone: values.telephone || values.mobile || '',
      source: { parserVersion: REFERENCE_WORKBOOK_PARSER_VERSION, sourceSha256: sourceDigest, sheetName: addressesSheet.sheetName, sourceRows: row.sourceRows,
        addressLabel: values.addressLabel ?? '', telephone: values.telephone ?? '', mobile: values.mobile ?? '', countryOriginal: row.rows[0]!.values.countryCode },
    } });
  }
  for (const row of channels.rows) {
    if (!row.values.name || !row.values.section) row.issues.push('CHANNEL_REFERENCE_INCOMPLETE');
    if (row.cells.some((cell) => cell.formula)) row.issues.push('FORMULA_SOURCE_ONLY');
  }
  const duplicateChannels = [...grouped(channels.rows.filter((row) => row.values.name), (row) => normalized(row.values.name!))]
    .filter(([, rows]) => rows.length > 1).map(([name, rows]) => ({ name, sourceRows: rows.map((row) => row.sourceRow) }));
  const channelNames = new Set(channels.rows.map((row) => row.values.name).filter(Boolean));
  const availableFcs = new Set(prepared.filter((row) => row.values.destinationFc).map((row) => row.values.destinationFc));
  for (const row of customs.rows) if (!customsOptions.has(row.values.customsMode ?? '')) row.issues.push('UNKNOWN_CUSTOMS_OPTION');
  for (const row of transit.rows) {
    for (const field of ['channelName', 'destinationFc', 'estimatedTransit', 'region']) if (!row.values[field]) row.issues.push(`TRANSIT_REFERENCE_REQUIRED:${field}`);
    if (!channelNames.has(row.values.channelName)) row.issues.push('TRANSIT_CHANNEL_NOT_FOUND');
    if (!availableFcs.has(identity(row.values.destinationFc ?? ''))) row.issues.push('TRANSIT_FC_ADDRESS_NOT_FOUND');
    if (row.cells.slice(1).some((cell) => cell.formula)) row.issues.push('FORMULA_SOURCE_ONLY');
  }
  const transitNames = new Set(transit.rows.map((row) => row.values.channelName));
  const unmatchedTransitFcs = [...grouped(transit.rows.filter((row) => row.issues.includes('TRANSIT_FC_ADDRESS_NOT_FOUND')), (row) => row.values.destinationFc!)]
    .map(([destinationFc, rows]) => ({ destinationFc, sourceRows: rows.map((row) => row.sourceRow) }));
  const missingTransitChannels = channels.rows.filter((row) => !transitNames.has(row.values.name)).map((row) => ({ name: row.values.name, sourceRow: row.sourceRow }));
  const specifications: Array<[Kind, ParsedSheet]> = [['address_catalog', addressesSheet], ['channel_catalog', channels], ['customs_options', customs], ['transit_reference', transit]];
  const datasets = specifications.map(([kind, sheet]) => ({ kind, sheetName: sheet.sheetName, sourceRange: sheet.sourceRange,
    data: { parserVersion: REFERENCE_WORKBOOK_PARSER_VERSION, sourceSha256: sourceDigest, columns: sheet.columns, rows: sheet.rows, skippedRows: sheet.skippedRows } }));
  return { datasets, addresses, summary: {
    parserVersion: REFERENCE_WORKBOOK_PARSER_VERSION, addressRecordCount: addressesSheet.rows.length, addressProfileCount: addresses.length,
    addressUniqueRecordCount: uniqueAddresses.length, addressDuplicateRemovedCount: duplicates.reduce((sum, group) => sum + group.removedCount, 0), duplicates, missingFcRows, conflicts, invalidAddressRows,
    countryCounts: Object.fromEntries([...grouped(addressesSheet.rows, (row) => row.values.countryCode ?? '')].map(([country, rows]) => [country, rows.length])),
    channelRecordCount: channels.rows.length, duplicateChannels, customsOptionCount: customs.rows.length, transitRecordCount: transit.rows.length,
    transitChannelCount: new Set(transit.rows.map((row) => row.values.channelName).filter(Boolean)).size, transitFcCount: new Set(transit.rows.map((row) => row.values.destinationFc).filter(Boolean)).size,
    unmatchedTransitFcs, unmatchedTransitChannels: transit.rows.filter((row) => row.issues.includes('TRANSIT_CHANNEL_NOT_FOUND')).map((row) => ({ sourceRow: row.sourceRow, channelName: row.values.channelName })),
    channelsWithoutTransit: missingTransitChannels, channelsWithoutTransitCount: missingTransitChannels.length,
    skippedRows: specifications.map(([, sheet]) => ({ sheetName: sheet.sheetName, rows: sheet.skippedRows.map((row) => ({ sourceRow: row.sourceRow, reason: row.reason })) })),
    missingBusinessData: ['product_declarations', 'seller_parties', 'confirmed_prices', 'currencies', 'tax_profiles', 'vat', 'business_channel_service_mapping', 'confirmed_delivery_windows'],
  } };
}
