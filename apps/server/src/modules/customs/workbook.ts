import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { CUSTOMS_SHEETS, CUSTOMS_TEMPLATE_VERSION, workflowBoxes, type CustomsData, type WorkflowRecord } from '@scm/contracts';
import { validateImportArchive } from '../imports/zip-preflight.js';
import { customsLayoutSheets, customsLayoutStyles } from './template-layout.js';
import { groupCustomsPrintLines } from './domain.js';

const Exact = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP });
const border = { top: { style: 'thin' as const, color: { argb: 'FFD6DCE2' } }, left: { style: 'thin' as const, color: { argb: 'FFD6DCE2' } }, bottom: { style: 'thin' as const, color: { argb: 'FFD6DCE2' } }, right: { style: 'thin' as const, color: { argb: 'FFD6DCE2' } } };
function addSheet(book: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = book.addWorksheet(name, { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } } });
  sheet.columns = [20, 16, 22, 28, 14, 12, 14, 16, 12].map((width) => ({ width }));
  sheet.mergeCells('A1:I1'); sheet.getCell('A1').value = name;
  sheet.getCell('A1').font = { name: 'Microsoft YaHei', size: 20, bold: true, color: { argb: 'FF193547' } };
  sheet.getRow(1).height = 38;
  sheet.views = [{ state: 'frozen', ySplit: 9, showGridLines: false }];
  sheet.pageSetup.printTitlesRow = '1:9';
  sheet.headerFooter.oddFooter = '&L&A&R第 &P / &N 页';
  return sheet;
}
function values(sheet: ExcelJS.Worksheet, row: number, cells: (string | number | null | ExcelJS.CellFormulaValue)[]) {
  const target = sheet.getRow(row); target.values = cells; target.height = row === 9 ? 32 : 30;
  target.eachCell((cell) => {
    cell.font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF172E3C' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = border;
    if (row === 9) { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF2' } }; cell.font.bold = true; }
  });
}
function header(sheet: ExcelJS.Worksheet, data: CustomsData) {
  const pairs = [
    ['境内主体', data.entity, '出口日期', data.exportDate], ['卖方', data.sellerName, '买方', data.buyerName],
    ['卖方地址', data.sellerAddress, '买方地址', data.buyerAddress], ['合同号', data.contractNumber, '发票号', data.invoiceNumber],
    ['起运港', data.portOfLoading, '目的港', data.portOfDestination],
    ['申报方式', data.declarationMode, '目的国家', data.countryCodes.join(' / ')],
    ['商品币种', data.currency, '贸易条款', data.tradeTerms],
  ];
  pairs.forEach(([left, leftValue, right, rightValue], index) => {
    const row = index + 2;
    sheet.mergeCells(`B${row}:D${row}`); sheet.mergeCells(`F${row}:I${row}`);
    values(sheet, row, [left!, leftValue!, null, null, right!, rightValue!]);
  });
}
const numeric = (value: string) => new Exact(value).toNumber();
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Exact(0));
function complete(sheet: ExcelJS.Worksheet) {
  sheet.pageSetup.printArea = `A1:I${Math.max(sheet.rowCount, 10)}`;
  for (let row = 10; row <= sheet.rowCount; row++) if (row % 2 === 0) sheet.getRow(row).eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FA' } }; });
}
/** Build a clean runtime template. Raw XLS samples are never embedded or executed. */
export async function createCustomsTemplate(): Promise<Buffer> {
  const book = new ExcelJS.Workbook(); book.creator = 'SCM'; book.subject = CUSTOMS_TEMPLATE_VERSION;
  for (const layout of customsLayoutSheets) {
    const sheet = book.addWorksheet(layout.name, { pageSetup: { paperSize: 9, orientation: layout.name === '报关单' ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.25, right: 0.25, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 } } });
    sheet.columns = layout.columns.map((width) => ({ width }));
    for (const [row, height] of Object.entries(layout.heights)) sheet.getRow(Number(row)).height = height;
    for (const [row, col, style, value] of layout.cells) { const cell = sheet.getCell(row, col); cell.style = structuredClone(customsLayoutStyles[style]!) as Partial<ExcelJS.Style>; cell.value = value; }
    for (const [top, left, bottom, right] of layout.merges) sheet.mergeCells(top!, left!, bottom!, right!);
    sheet.views = [{ showGridLines: false }];
    sheet.pageSetup.printArea = `A1:${layout.name === '报关单' ? 'S' : layout.name === '填制规范' ? 'B' : layout.columns.length === 10 ? 'J' : 'I'}${layout.rows}`;
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
/** Canonicalize supported templates from structure alone, stripping values, formulas, images and old customer sheets. */
export async function cleanCustomsTemplate(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > 10 * 1024 * 1024) throw new Error('报关模板不能超过 10 MiB。');
  await validateImportArchive(bytes);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never);
  if (book.subject !== CUSTOMS_TEMPLATE_VERSION || CUSTOMS_SHEETS.some((name) => !book.getWorksheet(name))) throw new Error('报关模板版本或七页结构不匹配，请使用 customs-seven/v1 清理后的 XLSX 模板。');
  const cleaned = new ExcelJS.Workbook(); await cleaned.xlsx.load(await createCustomsTemplate() as never);
  for (const layout of customsLayoutSheets) {
    const source = book.getWorksheet(layout.name)!, target = cleaned.getWorksheet(layout.name)!;
    for (let col = 1; col <= layout.columns.length; col++) target.getColumn(col).width = source.getColumn(col).width ?? layout.columns[col - 1];
    for (let row = 1; row <= layout.rows; row++) {
      target.getRow(row).height = source.getRow(row).height ?? target.getRow(row).height;
      for (let col = 1; col <= layout.columns.length; col++) target.getCell(row, col).style = structuredClone(source.getCell(row, col).style);
    }
    target.pageSetup.orientation = source.pageSetup.orientation ?? target.pageSetup.orientation;
    target.pageSetup.paperSize = source.pageSetup.paperSize ?? 9;
  }
  return Buffer.from(await cleaned.xlsx.writeBuffer());
}

export async function createCustomsWorkbook(record: WorkflowRecord, data: CustomsData, templateBytes?: Buffer): Promise<Buffer> {
  const book = new ExcelJS.Workbook(), printLines = groupCustomsPrintLines(data);
  if (!printLines.length || printLines.length > 16) throw new Error('当前七页模板每组支持 1 至 16 种完整申报商品，请按主体、国家、方式及币种进一步拆组。');
  const template = templateBytes ? await cleanCustomsTemplate(templateBytes) : await createCustomsTemplate();
  await book.xlsx.load(template as never); book.creator = 'SCM'; book.subject = CUSTOMS_TEMPLATE_VERSION;
  const boxes = workflowBoxes(record.source).filter((box) => record.boxIds.includes(box.id));
  const totalGross = sum(data.boxWeights.map((weight) => weight.grossWeight)).toNumber(), totalNet = sum(data.boxWeights.map((weight) => weight.netWeight)).toNumber();
  const totalAmount = printLines.reduce((amount, group) => amount.plus(group.declaredQuantity.times(group.line.unitPrice)), new Exact(0)).toNumber();
  const put = (sheet: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue) => { const cell = sheet.getCell(address); cell.style = structuredClone(cell.style); cell.value = value; cell.alignment = { ...cell.alignment, wrapText: true, vertical: 'middle' }; if (typeof value === 'number') cell.numFmt = '#,##0.00####'; };
  const date = new Date(`${data.exportDate}T00:00:00Z`);
  const report = book.getWorksheet('报关单')!;
  for (const [address, value] of Object.entries({ A4: data.sellerName, A6: data.buyerName, A8: data.entity, E8: data.declarationMode, A10: data.contractNumber, E10: data.countryCodes.join('/'), G10: data.countryCodes.join('/'), K10: data.portOfDestination, I12: data.tradeTerms, K12: `${data.freightCurrency} ${data.freightAmount}`, D14: data.buyerName, C15: [...new Set(boxes.map((box) => box.fba))].join(', ') })) put(report, address, value);
  put(report, 'G4', date); report.getCell('G4').numFmt = 'yyyy-mm-dd'; put(report, 'E12', boxes.length); put(report, 'F12', totalGross); put(report, 'G12', totalNet);
  const invoice = book.getWorksheet('发票')!, contract = book.getWorksheet('合同')!, packing = book.getWorksheet('箱单')!, elements = book.getWorksheet('申报要素')!;
  for (const [address, value] of Object.entries({ G2: data.invoiceNumber, C3: data.buyerName, C4: data.buyerAddress, G6: data.tradeTerms, H6: data.portOfLoading, G24: data.currency, C25: [...new Set(boxes.map((box) => box.fba))].join(', ') })) put(invoice, address, value);
  put(invoice, 'G3', date); invoice.getCell('G3').numFmt = 'yyyy-mm-dd'; invoice.getRow(6).height = Math.max(invoice.getRow(6).height ?? 0, 42);
  for (const [address, value] of Object.entries({ C2: data.sellerName, C4: data.sellerAddress, C8: data.buyerName, C10: data.buyerAddress, G5: data.contractNumber, G10: data.portOfLoading, G11: data.tradeTerms, H11: data.portOfLoading, G36: data.currency, B44: '装运口岸和目的地', B45: `${data.portOfLoading} → ${data.portOfDestination}` })) put(contract, address, value);
  put(contract, 'G8', date); contract.getCell('G8').numFmt = 'yyyy-mm-dd';
  contract.unMergeCells('G5'); contract.mergeCells('G5:I5'); contract.getRow(5).height = 34;
  for (const row of [38, 40, 41, 42, 43, 44, 45, 48, 49, 50, 51, 56, 57, 58, 59]) contract.getRow(row).height = Math.max(contract.getRow(row).height ?? 0, row === 45 ? 42 : 22);
  contract.getCell('B44').alignment = { ...contract.getCell('B44').alignment, wrapText: false }; contract.getCell('B45').alignment = { ...contract.getCell('B45').alignment, wrapText: false };
  for (const [address, value] of Object.entries({ G4: data.invoiceNumber, B5: data.buyerName, G5: data.contractNumber, C7: `${data.portOfLoading} →`, D7: data.portOfDestination, A10: boxes.map((box) => box.code || box.fba).join('\n') })) put(packing, address, value);
  put(packing, 'G3', date); packing.getCell('G3').numFmt = 'yyyy-mm-dd'; packing.getRow(7).height = Math.max(packing.getRow(7).height ?? 0, 60);
  const assignedBoxes = new Set<string>();
  printLines.forEach((group, index) => {
    const line = group.line, amount = group.declaredQuantity.times(line.unitPrice).toNumber(), reportRow = 20 + index * 3, invoiceRow = 8 + index, contractRow = 18 + index, packingRow = 10 + index;
    put(report, `A${reportRow}`, index + 1); report.getCell(`A${reportRow}`).numFmt = '0'; put(report, `B${reportRow}`, line.hsCode); report.getCell(`B${reportRow}`).numFmt = '@'; put(report, `D${reportRow}`, `${line.chineseName}\n${line.model}`); report.getRow(reportRow).height = Math.max(report.getRow(reportRow).height ?? 0, 32); put(report, `D${reportRow + 1}`, [line.use, line.material, line.brand, line.model].join(' | '));
    put(report, `G${reportRow}`, group.declaredQuantity.toNumber()); put(report, `H${reportRow}`, line.unit); put(report, `I${reportRow}`, numeric(line.unitPrice)); put(report, `I${reportRow + 1}`, amount); put(report, `I${reportRow + 2}`, line.currency); put(report, `M${reportRow}`, data.countryCodes.join('/'));
    for (const [sheet, row, nameColumn] of [[invoice, invoiceRow, 'C'], [contract, contractRow, 'B']] as const) {
      put(sheet, `${nameColumn}${row}`, `${line.chineseName}\n${line.englishName}`); put(sheet, `D${row}`, group.declaredQuantity.toNumber()); put(sheet, `E${row}`, line.unit); put(sheet, `F${row}`, numeric(line.unitPrice)); put(sheet, `G${row}`, line.currency); put(sheet, `H${row}`, { formula: `D${row}*F${row}`, result: amount }); sheet.getRow(row).height = Math.max(sheet.getRow(row).height ?? 0, 34);
    }
    const newBoxes = [...new Set(group.boxIds)].filter((boxId) => !assignedBoxes.has(boxId)); newBoxes.forEach((boxId) => assignedBoxes.add(boxId));
    const weights = newBoxes.map((boxId) => data.boxWeights.find((weight) => weight.boxId === boxId)!);
    put(packing, `B${packingRow}`, line.chineseName); put(packing, `C${packingRow}`, newBoxes.length); put(packing, `D${packingRow}`, group.declaredQuantity.toNumber()); put(packing, `E${packingRow}`, line.unit); put(packing, `F${packingRow}`, sum(weights.map((weight) => weight.grossWeight)).toNumber()); put(packing, `G${packingRow}`, sum(weights.map((weight) => weight.netWeight)).toNumber()); packing.getRow(packingRow).height = Math.max(packing.getRow(packingRow).height ?? 0, 32);
    const row = index + 10; [index + 1, line.chineseName, line.hsCode, null, line.brand, line.model, null, null, [line.material, line.use, line.conversionReason].filter(Boolean).join(' | ')].forEach((value, column) => put(elements, `${String.fromCharCode(65 + column)}${row}`, value)); elements.getCell(row, 1).numFmt = '0'; elements.getCell(row, 3).numFmt = '@'; elements.getRow(row).height = Math.max(elements.getRow(row).height ?? 0, 34);
  });
  put(invoice, 'H24', { formula: 'SUM(H8:H23)', result: totalAmount }); put(contract, 'H36', { formula: 'SUM(H18:H33)', result: totalAmount }); put(contract, 'E38', totalAmount);
  put(packing, 'C26', { formula: 'SUM(C10:C25)', result: boxes.length }); put(packing, 'D26', new Set(data.lines.map((line) => line.unit)).size === 1 ? sum(data.lines.map((line) => line.declaredQuantity)).toNumber() : '分单位见明细'); put(packing, 'F26', { formula: 'SUM(F10:F25)', result: totalGross }); put(packing, 'G26', { formula: 'SUM(G10:G25)', result: totalNet });
  const authority = book.getWorksheet('委托书')!;
  for (const [address, value] of Object.entries({ C21: data.entity, C22: [...new Set(printLines.map((group) => group.line.chineseName))].join('、'), C23: [...new Set(printLines.map((group) => group.line.hsCode))].join(' / '), C24: data.currency, C27: data.declarationMode })) put(authority, address, value);
  put(authority, 'D24', totalAmount); put(authority, 'C25', date); authority.getCell('C25').numFmt = 'yyyy-mm-dd';
  const specification = book.getWorksheet('填制规范')!;
  specification.getColumn(1).width = 26; specification.getColumn(2).width = 110;
  specification.eachRow((row) => { row.eachCell((cell) => { cell.style = structuredClone(cell.style); cell.alignment = { ...cell.alignment, wrapText: true, vertical: 'top' }; }); row.height = Math.max(20, Math.ceil(row.getCell(2).text.length / 55) * 22 + 12); });
  report.pageSetup.printArea = `A1:S${19 + printLines.length * 3}`; report.pageSetup.printTitlesRow = '1:19';
  elements.pageSetup.printArea = `A1:I${Math.max(17, printLines.length + 9)}`; elements.pageSetup.printTitlesRow = '8:9';
  invoice.pageSetup.printArea = 'A1:H33'; packing.pageSetup.printArea = 'A1:H28'; contract.pageSetup.printArea = 'A1:I59'; authority.pageSetup.printArea = 'A1:J48';
  book.calcProperties.fullCalcOnLoad = true;
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function createFiling9810Checklist(record: WorkflowRecord, data: CustomsData): Promise<Buffer> {
  const book = new ExcelJS.Workbook(), sheet = addSheet(book, '9810填写核对清单'); header(sheet, data);
  values(sheet, 9, ['填写项目', '内容', '核对结果']);
  [
    ['电商订单号', data.ecommerceOrderNumber, ''], ['报关七页文件', data.review?.exportId ?? '', ''], ['七页文件 SHA-256', data.review?.fileSha256 ?? '', ''],
    ['主体', data.entity, ''], ['目的国家', data.countryCodes.join(' / '), ''], ['商品币种', data.currency, ''], ['运费', data.freightAmount, data.freightCurrency],
    ['箱数', record.boxIds.length, ''], ['报关编号', data.customsResult.externalNumber, ''], ['9810外部编号', null, '平台提交后登记'],
  ].forEach((row, index) => values(sheet, index + 10, row));
  sheet.mergeCells('A22:I23'); sheet.getCell('A22').value = '此清单用于人工填写核对。平台提交后，请分别登记已保存、复审通过、已申请或确认成功的实际结果与反馈凭据。';
  sheet.getCell('A22').alignment = { wrapText: true, vertical: 'middle' }; complete(sheet);
  return Buffer.from(await book.xlsx.writeBuffer());
}
