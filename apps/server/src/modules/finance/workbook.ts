import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { financeDataSchema, financeLineSchema, type FinanceLine, type WorkflowContext, type WorkflowIssue, type WorkflowRecord } from '@scm/contracts';
import { validateImportArchive } from '../imports/zip-preflight.js';
import { allocationTotals } from './domain.js';

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const FINANCE_IMPORT_HEADERS = ['费用说明', '费用类型', '费用性质', '金额', '币种', '内部箱ID（逗号分隔）', '准备单ID', '外部单号', '分摊金额'];
export function formatSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF314B5E' } };
  sheet.getRow(1).height = 28;
  sheet.columns.forEach((column) => { column.width = 24; column.numFmt = '@'; });
  sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + sheet.columnCount)}1` };
}
export async function financeImportTemplate() {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('费用导入');
  sheet.addRow(FINANCE_IMPORT_HEADERS); formatSheet(sheet);
  sheet.getCell('A2').note = '同一费用说明、类型、性质、金额、币种及箱范围构成同一费用行；多张准备单分别填写分摊。类型使用freight/customs/clearance/tax/materials/other，性质使用actual/estimate/refund/supplement。';
  return { bytes: Buffer.from(await workbook.xlsx.writeBuffer()), name: '费用导入模板.xlsx', mimeType: MIME };
}
export async function parseFinanceWorkbook(bytes: Buffer): Promise<{ lines: FinanceLine[]; issues: WorkflowIssue[] }> {
  await validateImportArchive(bytes);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet('费用导入'), issues: WorkflowIssue[] = [], grouped = new Map<string, FinanceLine>();
  if (!sheet || sheet.rowCount > 10001) return { lines: [], issues: [{ code: 'INVALID_FINANCE_SHEET', severity: 'error', message: '费用导入须包含费用导入页，最多10000行。' }] };
  const scalar = (row: number, col: number) => { const value = sheet.getCell(row, col).value; if (value && typeof value === 'object') throw new Error('公式及复合单元格不作为账单金额或编号输入，请提供实际值。'); return value === null ? '' : String(value).trim(); };
  if (FINANCE_IMPORT_HEADERS.some((header, index) => scalar(1, index + 1) !== header)) return { lines: [], issues: [{ code: 'INVALID_FINANCE_HEADERS', severity: 'error', message: '表头与标准费用导入模板不一致。' }] };
  for (let row = 2; row <= sheet.rowCount; row++) {
    try {
      const values = Array.from({ length: 9 }, (_, col) => scalar(row, col + 1)); if (values.every((value) => !value)) continue;
      const [description, type, nature, amount, currency, boxText, fulfillmentId, externalOrderNo, allocated] = values;
      const parsed = financeLineSchema.safeParse({ id: randomUUID(), description, type, nature, amount, currency, boxIds: boxText!.split(/[,，\s]+/).filter(Boolean), allocations: fulfillmentId ? [{ fulfillmentId, externalOrderNo, amount: allocated }] : [] });
      if (!parsed.success) { issues.push({ code: 'FINANCE_ROW_INVALID', severity: 'error', message: `第${row}行：${parsed.error.issues[0]?.message ?? '字段无效'}` }); continue; }
      const line = parsed.data, key = JSON.stringify([description, type, nature, amount, line.currency, [...line.boxIds].sort()]);
      const existing = grouped.get(key); if (existing) existing.allocations.push(...line.allocations); else grouped.set(key, line);
    } catch (error) { issues.push({ code: 'FINANCE_CELL_INVALID', severity: 'error', message: `第${row}行：${error instanceof Error ? error.message : '字段无效'}` }); }
  }
  return { lines: [...grouped.values()], issues };
}
export async function renderAllocationWorkbook(record: WorkflowRecord, context: WorkflowContext, purpose: string) {
  if (purpose !== 'allocation-checklist') throw new Error('不支持此费用文件用途。');
  const data = financeDataSchema.parse(record.data), workbook = new ExcelJS.Workbook();
  const detail = workbook.addWorksheet('账单与分摊'); detail.addRow(['账单编号', '收费方', '费用说明', '费用类型', '性质', '原金额', '币种', '准备单', '分摊金额', '收费箱范围']);
  for (const line of data.lines) for (const allocation of line.allocations.length ? line.allocations : [{ fulfillmentId: '', amount: '' }]) detail.addRow([data.billNumber, data.provider, line.description, line.type, line.nature, line.amount, line.currency, context.records.find((peer) => peer.id === allocation.fulfillmentId)?.title ?? allocation.fulfillmentId, allocation.amount, line.boxIds.join(',')]);
  formatSheet(detail);
  const results = workbook.addWorksheet('拟回填与核对'); results.addRow(['准备单ID', '外部单号', '费用类型', '币种', '拟回填金额', '原值', '回查值', '核对状态', '凭据ID']);
  for (const total of allocationTotals(data)) {
    const latest = [...data.externalResults].reverse().find((item) => item.fulfillmentId === total.fulfillmentId && item.externalOrderNo === total.externalOrderNo && item.feeType === total.feeType && item.currency === total.currency);
    const target = context.records.find((peer) => peer.id === total.fulfillmentId), orders = (target?.data.externalOrders as Array<{ externalOrderNo: string }> | undefined) ?? [];
    results.addRow([total.fulfillmentId, total.externalOrderNo || (orders.length === 1 ? orders[0]!.externalOrderNo : ''), total.feeType, total.currency, total.amount, latest?.beforeAmount ?? '', latest?.afterAmount ?? '', latest?.status ?? 'pending', latest?.evidenceFileIds.join(',') ?? '']);
  }
  formatSheet(results);
  return { bytes: Buffer.from(await workbook.xlsx.writeBuffer()), name: `费用核对-${record.id.slice(0, 8)}.xlsx`, mimeType: MIME };
}
