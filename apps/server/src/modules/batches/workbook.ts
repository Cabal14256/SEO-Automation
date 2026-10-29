import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import type { ShipmentData, ShipmentReport, ShipmentReportRow } from '@scm/contracts';
import { reportTicketKey } from '@scm/contracts';
import { validateImportArchive } from '../imports/zip-preflight.js';
import { sortReportBoxes, sortReportRows, summarizeReportTicketCodes } from './report-order.js';
import { createFbaRowFill } from '../../xlsx-fba-fill.js';

export const REPORT_TEMPLATE_VERSION = 'shipment-record-v8';
export const INTAKE_HEADERS = {
  products: ['sid', 'FBA', 'MSKU', 'FNSKU', 'SKU', '品名', '申报量'],
  boxes: ['sid', 'FBA', '箱关联键', 'localBoxId', '箱名', 'MSKU', 'FNSKU', 'SKU', '箱内数量', '重量', '重量单位', '长', '宽', '高', '尺寸单位'],
};
export function reportRegion(country: string): 'US' | 'EU' | 'other' {
  const normalized = country.trim().toUpperCase();
  if (['美国', 'US', 'USA', 'UNITED STATES'].includes(normalized)) return 'US';
  if (['英国', '法国', '德国', '西班牙', '意大利', '荷兰', '波兰', '瑞典', '比利时', '爱尔兰', 'GB', 'UK', 'FR', 'DE', 'ES', 'IT', 'NL', 'PL', 'SE', 'BE', 'IE'].includes(normalized)) return 'EU';
  return 'other';
}
function styleSheet(sheet: ExcelJS.Worksheet, headers: string[], widths?: number[]) {
  sheet.columns = headers.map((header, index) => ({ header, key: `c${index}`, width: widths?.[index] ?? Math.min(32, Math.max(14, header.length * 2 + 2)) }));
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 1, showGridLines: false }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  sheet.getRow(1).height = 30;
  sheet.getRow(1).eachCell((cell) => { cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF24344D' } }; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  sheet.properties.defaultRowHeight = 22;
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  sheet.pageSetup.printTitlesRow = '1:1';
}
function addRow(sheet: ExcelJS.Worksheet, values: ExcelJS.CellValue[]) {
  const row = sheet.addRow(values);
  let lines = 1;
  row.eachCell((cell, index) => { cell.font = { name: 'Arial', size: 10 }; cell.alignment = { vertical: 'middle', horizontal: typeof cell.value === 'number' ? 'right' : 'left', wrapText: typeof cell.value === 'string' }; if (cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd'; else if (typeof cell.value === 'string') { cell.numFmt = '@'; const length = [...cell.value].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0); lines = Math.max(lines, Math.ceil(length / Math.max(8, (sheet.getColumn(index).width ?? 16) - 2))); } });
  row.height = Math.min(120, 22 + (lines - 1) * 14);
  return row;
}
const date = (value: string | null) => value ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;
function createFirstFbaRowFill(fillFba: ReturnType<typeof createFbaRowFill>) {
  const filled = new Set<string>();
  return (row: ExcelJS.Row, fba: string, columns: number) => {
    const normalized = fba.trim().toUpperCase();
    if (!normalized || filled.has(normalized)) return;
    fillFba(row, normalized, columns);
    filled.add(normalized);
  };
}
function addProductSheet(book: ExcelJS.Workbook, name: string, rows: ShipmentReportRow[], maxBoxes: number, monthly: boolean, fillFba: ReturnType<typeof createFbaRowFill>) {
  const sheet = book.addWorksheet(name, { properties: { tabColor: { argb: 'FF24344D' } } });
  const fillFirstFba = createFirstFbaRowFill(fillFba);
  const hasTickets = rows.some((row) => row.ticketNumber), batchLabel = hasTickets ? '发货票号' : '打包批次';
  const headers = [...(monthly ? [batchLabel] : []), '店铺', '渠道', '国家', '目的FC', 'FBA货件号', 'MSKU', 'FNSKU', '品名', 'SKU', '发货数量',
    ...Array.from({ length: maxBoxes }, (_, i) => `箱${i + 1}`), '内部编码', hasTickets ? '本票商品合计' : '子批次商品合计', '流程状态', '实际发货日期', ...(monthly ? [] : [batchLabel]), '业务日期', '发货月份 / 次数', '本月商品数量', '数据版本'];
  styleSheet(sheet, headers);
  sheet.columns.forEach((column, index) => { const h = headers[index]!; column.width = ['品名', '内部编码', '数据版本', '发货票号'].includes(h) ? 32 : ['MSKU', 'FNSKU', 'SKU', 'FBA货件号', '店铺', '打包批次'].includes(h) ? 26 : h.startsWith('箱') ? 9 : h === '发货月份 / 次数' ? 26 : 17; });
  const displayed = new Set<string>(), displayedTickets = new Set<string>();
  let previousTicket: string | undefined;
  for (const item of rows) {
    const ticket = reportTicketKey(item);
    if (previousTicket !== undefined && previousTicket !== ticket) addRow(sheet, []);
    previousTicket = ticket;
    const firstTicket = !displayedTickets.has(ticket); displayedTickets.add(ticket);
    const key = JSON.stringify([ticket, item.sid, item.msku, item.fnsku, item.sku]);
    const first = !displayed.has(key); displayed.add(key);
    const quantities = Array.from({ length: maxBoxes }, (_, index) => item.boxes.find((box) => box.boxOrder === index + 1)?.quantity ?? null);
    const row = addRow(sheet, [...(monthly ? [item.ticketNumber ?? item.groupName] : []), item.shop, item.channel, item.country, item.destinationFc, item.fba, item.msku, item.fnsku, item.productName, item.sku, item.quantity,
      ...quantities, firstTicket ? item.ticketCodeRange ?? '' : null, first ? item.groupQuantity : null, item.status, date(item.actualShipDate), ...(monthly ? [] : [item.ticketNumber ?? item.groupName]), date(item.businessDate), item.shippingMonth ? `${item.shippingMonth} 第 ${item.shippingRunSequence ?? '待编号'} 次` : '历史批次 / 未关联发货次', first ? item.monthQuantity : null, item.dataRevisionId]);
    fillFirstFba(row, item.fba, headers.length);
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: headers.length } };
  return sheet;
}
export async function createReportWorkbook(projection: ShipmentReport, options: { month?: string | null; exportId?: string } = {}) {
  projection = { ...projection, rows: sortReportRows(summarizeReportTicketCodes(projection.rows, projection.boxes)), boxes: sortReportBoxes(projection.boxes) };
  const book = new ExcelJS.Workbook(); book.creator = 'SCM'; book.created = new Date(projection.generatedAt); book.modified = book.created;
  const fillFba = createFbaRowFill([...projection.rows.map((row) => row.fba), ...projection.boxes.map((box) => box.fba)]);
  const maxBoxes = projection.rows.reduce((maximum, row) => row.boxes.reduce((last, box) => Math.max(last, box.boxOrder), maximum),
    projection.boxes.reduce((maximum, box) => Math.max(maximum, box.boxOrder), 5));
  if (maxBoxes > 16_000) throw new Error('单票箱数超过 XLSX 列数上限，请改用逐箱明细导出。');
  addProductSheet(book, projection.shippingRunDate ? `${projection.shippingRunDate.replaceAll('-', '')}第${projection.shippingRunSequence}次发货` : options.month ? `${options.month}月汇总` : '发货汇总', projection.rows, maxBoxes, true, fillFba);
  for (const [region, name] of [['US', '美国批次'], ['EU', '欧洲批次'], ['other', '其他国家批次']] as const) {
    const rows = projection.rows.filter((row) => reportRegion(row.country) === region);
    if (rows.length) addProductSheet(book, name, rows, maxBoxes, false, fillFba);
  }
  const detail = book.addWorksheet('逐箱明细');
  const fillFirstDetailFba = createFirstFbaRowFill(fillFba);
  styleSheet(detail, [projection.shippingRunId ? '发货票号' : '打包批次', 'sid', 'FBA货件号', '内部箱ID', '平台箱ID', '平台箱名', '货件内箱序', '内部编码', 'MSKU', 'FNSKU', 'SKU', '箱内数量', '重量', '重量单位', '长', '宽', '高', '尺寸单位', '确认版本', '发货表箱列']);
  detail.columns.forEach((c, i) => { c.width = [3, 4, 18].includes(i) ? 38 : i === 2 || [0, 8, 9, 10].includes(i) ? 26 : 17; });
  for (const box of projection.boxes) for (const item of box.items) {
    const row = addRow(detail, [box.ticketNumber ?? box.groupName, box.sid.toString(), box.fba, box.boxId, box.boxExternalId, box.boxName, box.boxOrder, box.code, item.msku, item.fnsku, item.sku, item.quantity, box.weight, box.weightUnit, box.length, box.width, box.height, box.lengthUnit, box.confirmationId, box.boxOrder]);
    fillFirstDetailFba(row, box.fba, detail.columnCount);
  }
  const versions = book.addWorksheet('版本说明');
  styleSheet(versions, ['项目', '值'], [24, 95]);
  addRow(versions, ['导出编号', options.exportId ?? '预览']); addRow(versions, ['模板版本', REPORT_TEMPLATE_VERSION]);
  addRow(versions, ['生成时间（上海）', new Date(projection.generatedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })]);
  addRow(versions, ['归月口径', projection.shippingRunId ? '本次发货按编号日期归月；仅含本次票成员，货件首次业务日期独立保留' : '按发货次编号日期归月；首次导入业务日期独立保留，未关联历史批次不推算月份和次数']);
  addRow(versions, ['数量口径', '详情申报量逐商品与装箱合计一致；子批次商品合计仅首条展示']);
  addRow(versions, ['箱列口径', '每个 FBA 按货件内箱序从箱1开始，至少保留5个箱列，超过5箱动态扩列；实际内部箱码在逐箱明细保留']);
  addRow(versions, ['商品行顺序', '业务票保持连续并按来源票序排列；同票 FBA 按实际箱数升序，同箱数按输入顺序；按整票商品总数量降序建立统一商品顺序，同数量按 SKU 排序，票内所有 FBA 复用此顺序；同 SKU 的不同平台商品身份独立保留']);
  addRow(versions, ['整票编码范围', '每票首行展示完整编码范围，连续码压缩为 A1-A10，缺号分段保留；范围不替代逐箱真实编码']);
  addRow(versions, ['票间分隔', '商品表相邻两票之间保留一整行空白，同票内多个 FBA 连续展示；空白行不计入商品行数或数量']);
  addRow(versions, ['货件填色', '每张表仅对各完整 FBA 的首条记录整行填充浅色；相同 FBA 跨表同色，后续记录及票间空白行不填色']);
  addRow(versions, ['流程状态', '制表确认/导出/打印状态；不表示实物核验或实际发货完成']);
  if (projection.shippingRunId) {
    addRow(versions, ['发货次', `${projection.shippingRunDate} / 本月第 ${projection.shippingRunSequence} 次`]);
    addRow(versions, ['发货次版本', `${projection.shippingRunId} / ${projection.shippingRunVersion}`]);
    addRow(versions, ['票号与箱码', '发货票号按输入空行分段保存；内部箱码沿用原制表确认，不与票号混用']);
  }
  for (const ref of projection.confirmations) addRow(versions, ['子批次确认', `${ref.groupId} / 组版本 ${ref.groupVersion} / 确认 ${ref.confirmationId}`]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const verify = new ExcelJS.Workbook(); await verify.xlsx.load(bytes as unknown as Parameters<typeof verify.xlsx.load>[0]);
  const productSheets = verify.worksheets.filter((sheet) => !['逐箱明细', '版本说明'].includes(sheet.name));
  for (const sheet of productSheets) {
    const rows = sheet === verify.worksheets[0] ? projection.rows : projection.rows.filter((row) => reportRegion(row.country) === (sheet.name === '美国批次' ? 'US' : sheet.name === '欧洲批次' ? 'EU' : 'other'));
    const separators = rows.reduce((count, row, index) => count + (index > 0 && reportTicketKey(rows[index - 1]!) !== reportTicketKey(row) ? 1 : 0), 0);
    let populated = 0; sheet.eachRow(() => { populated++; });
    if (sheet.rowCount !== rows.length + separators + 1 || populated !== rows.length + 1) throw new Error('生成文件商品行或票间空行回读核对失败。');
  }
  if (verify.getWorksheet('逐箱明细')?.rowCount !== projection.boxes.reduce((n, box) => n + box.items.length, 1)) throw new Error('生成文件回读核对失败。');
  return bytes;
}

export async function createIntakeTemplate() {
  const book = new ExcelJS.Workbook(); book.creator = 'SCM';
  styleSheet(book.addWorksheet('货件商品'), INTAKE_HEADERS.products);
  styleSheet(book.addWorksheet('逐箱商品'), INTAKE_HEADERS.boxes);
  return Buffer.from(await book.xlsx.writeBuffer());
}
export async function parseIntakeWorkbook(bytes: Buffer, identity: { sid: number; fba: string }): Promise<ShipmentData> {
  await validateImportArchive(bytes);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  const products = book.getWorksheet('货件商品'); const boxSheet = book.getWorksheet('逐箱商品');
  if (!products || !boxSheet) throw new Error('请使用包含“货件商品”和“逐箱商品”的补录模板。');
  const headers = (sheet: ExcelJS.Worksheet, expected: string[]) => expected.forEach((h, i) => { if (sheet.getCell(1, i + 1).text.trim() !== h) throw new Error(`工作表 ${sheet.name} 第 ${i + 1} 列应为 ${h}。`); });
  headers(products, INTAKE_HEADERS.products); headers(boxSheet, INTAKE_HEADERS.boxes);
  if (products.rowCount > 10_001 || boxSheet.rowCount > 50_001) throw new Error('补录行数超过限制，请拆分文件。');
  const cell = (row: ExcelJS.Row, i: number): string => { const value = row.getCell(i).value; if (value && typeof value === 'object') throw new Error(`第 ${row.number} 行包含公式或非文本单元格，请粘贴值后上传。`); return value === null || value === undefined ? '' : String(value).trim(); };
  const qty = (value: string, label: string, required = true) => { if (!value && !required) return null; if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${label}应为非负数字。`); const n = Number(value); if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) throw new Error(`${label}超出有效范围。`); return n; };
  const count = (value: string, label: string) => { const n = qty(value, label)!; if (!Number.isSafeInteger(n)) throw new Error(`${label}应为非负整数。`); return n; };
  const match = (row: ExcelJS.Row) => { if (Number(cell(row, 1)) !== identity.sid || cell(row, 2).toUpperCase() !== identity.fba) throw new Error(`第 ${row.number} 行 sid/FBA 与选定货件不一致。`); };
  const result: ShipmentData = { ...identity, observedAt: new Date().toISOString(), issues: [], items: [], boxes: [] }; const boxes = new Map<string, ShipmentData['boxes'][number]>();
  products.eachRow((row, i) => { if (i === 1 || !row.values || row.actualCellCount === 0) return; match(row); const values = [3, 4, 5, 6].map((n) => cell(row, n)); if (values.some((v) => !v)) throw new Error(`货件商品第 ${i} 行缺少商品身份或品名。`); result.items.push({ msku: values[0]!, fnsku: values[1]!, sku: values[2]!, name: values[3]!, quantity: String(count(cell(row, 7), '申报量')) }); });
  const optionalNumber = (value: string, label: string) => { const n = qty(value, label, false); return n === null ? null : String(n); };
  boxSheet.eachRow((row, i) => { if (i === 1 || row.actualCellCount === 0) return; match(row); const key = cell(row, 3); if (!key) throw new Error(`逐箱商品第 ${i} 行缺少箱关联键。`); const metadata = { localBoxId: cell(row, 4) || null, name: cell(row, 5) || null, weight: optionalNumber(cell(row, 10), '重量'), weightUnit: cell(row, 11) || null, length: optionalNumber(cell(row, 12), '长'), width: optionalNumber(cell(row, 13), '宽'), height: optionalNumber(cell(row, 14), '高'), dimensionUnit: cell(row, 15) || null };
    let box = boxes.get(key); if (box && JSON.stringify(metadata) !== JSON.stringify({ localBoxId: box.localBoxId, name: box.name, weight: box.weight, weightUnit: box.weightUnit, length: box.length, width: box.width, height: box.height, dimensionUnit: box.dimensionUnit })) throw new Error(`箱 ${key} 的重复元数据不一致。`);
    if (!box) { box = { id: randomUUID(), externalBoxId: key, packageId: null, order: boxes.size + 1, ...metadata, items: [] }; boxes.set(key, box); }
    const values = [6, 7, 8].map((n) => cell(row, n)); if (values.some((v) => !v)) throw new Error(`逐箱商品第 ${i} 行缺少商品身份。`); box.items.push({ msku: values[0]!, fnsku: values[1]!, sku: values[2]!, quantity: String(count(cell(row, 9), '箱内数量')) });
  });
  if (!result.items.length || !boxes.size) throw new Error('补录文件必须包含商品和逐箱明细。');
  result.boxes = [...boxes.values()]; return result;
}
