import ExcelJS from 'exceljs';
import { fulfillmentActionSchema, fulfillmentDataSchema, workflowBoxes, type FulfillmentData, type FulfillmentLine, type FulfillmentMaterial, type WorkflowContext, type WorkflowIssue, type WorkflowRecord } from '@scm/contracts';
import type { WorkflowPolicy } from '../workflow/policy.js';

const identity = (line: Pick<FulfillmentLine, 'boxId' | 'msku' | 'fnsku' | 'sku'>) => JSON.stringify([line.boxId, line.msku, line.fnsku, line.sku]);
const materialKey = (line: FulfillmentMaterial) => JSON.stringify([line.sku, line.scope, line.boxId ?? '']);
const componentTotals = (lines: FulfillmentLine[]) => quantities(lines.flatMap((line) => line.components.map((component) => ({ ...component, key: JSON.stringify([identity(line), component.sku]) }))), (component) => component.key);
function quantities<T extends { quantity: string }>(items: T[], key: (item: T) => string): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0n) + BigInt(item.quantity));
  return map;
}
const sameTotals = (left: Map<string, bigint>, right: Map<string, bigint>) => left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
export function workflowEvidence(context: WorkflowContext, recordId: string, fileId: string | undefined): boolean {
  return Boolean(fileId && context.files.some((file) => file.id === fileId && file.recordId === recordId && file.byteSize > 0 && /^[a-f0-9]{64}$/.test(file.sha256)));
}
export function fulfillmentPreparation(record: WorkflowRecord): FulfillmentLine[] {
  const selected = new Set(record.boxIds);
  return workflowBoxes(record.source).filter((box) => selected.has(box.id)).flatMap((box) => box.items.map((item) => ({ boxId: box.id, msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: item.quantity ?? '0', components: [] })));
}
export function evaluateFulfillment(record: WorkflowRecord, context: WorkflowContext, action: string) {
  const issues: WorkflowIssue[] = [];
  const add = (code: string, message: string, severity: WorkflowIssue['severity'] = 'error', boxId?: string) => issues.push({ code, severity, message, ...(boxId ? { boxId } : {}) });
  const parsed = fulfillmentDataSchema.safeParse(record.data);
  if (!parsed.success) return { status: 'draft', issues: [{ code: 'INVALID_FULFILLMENT_DATA', severity: 'error' as const, message: '单据准备数据格式无效。' }] };
  const data = parsed.data, selected = new Set(record.boxIds), sourceBoxes = new Set(workflowBoxes(record.source).map((box) => box.id));
  const previous = context.records.find((entry) => entry.id === record.id), old = previous ? fulfillmentDataSchema.safeParse(previous.data) : null;
  if (action !== 'read' && !['export:preparation', 'export:reconciliation'].includes(action) && !fulfillmentActionSchema.safeParse(action).success) add('INVALID_ACTION', '不支持该单据操作。');
  if (!record.boxIds.length || selected.size !== record.boxIds.length || record.boxIds.some((id) => !sourceBoxes.has(id))) add('INVALID_BOX_SCOPE', '准备范围必须由来源中不重复的内部箱 ID 组成。');
  if (previous?.status === 'cancelled' && action !== 'read') add('IMMUTABLE_CANCELLED_RECORD', '已取消的准备组保留历史，不能继续编辑。');
  if (old?.success) {
    for (const order of old.data.externalOrders) if (!data.externalOrders.some((entry) => entry.externalOrderNo === order.externalOrderNo)) add('IMMUTABLE_EXTERNAL_RESULT', '已经登记的外部单据不能删除；请登记取消结果或更正结果。');
    if (old.data.externalOrders.length && JSON.stringify([...record.boxIds].sort()) !== JSON.stringify([...previous!.boxIds].sort())) add('IMMUTABLE_RESULT_SCOPE', '已有外部结果的准备组不能改变箱范围。');
  }
  if (!context.sourceValid) add('FULFILLMENT_SOURCE_STALE', context.sourceInvalidReason ?? '来源文件或复核已失效。', ['record_result', 'cancel'].includes(action) ? 'warning' : 'error');
  if (!data.warehouseCode) add('FULFILLMENT_WAREHOUSE_REQUIRED', '请确认出库仓代码。');
  if (!data.logistics) add('FULFILLMENT_LOGISTICS_REQUIRED', '请填写物流方式。');
  if (!data.lines.length) add('FULFILLMENT_LINES_REQUIRED', '请填写准备商品明细。');
  if (new Set(data.lines.map(identity)).size !== data.lines.length) add('INVALID_DUPLICATE_PREPARATION_LINE', '同一箱内商品明细不能重复。');
  for (const line of data.lines) {
    if (!selected.has(line.boxId)) add('INVALID_LINE_BOX', '商品明细引用了准备范围以外的箱。', 'error', line.boxId);
    if (BigInt(line.quantity) <= 0n) add('FULFILLMENT_ZERO_QUANTITY', '准备商品数量必须大于零。', 'error', line.boxId);
    if (new Set(line.components.map((entry) => entry.sku)).size !== line.components.length || line.components.some((entry) => BigInt(entry.quantity) <= 0n)) add('INVALID_COMPONENTS', '组合明细中的子 SKU 不能重复，数量须大于零。', 'error', line.boxId);
  }
  if (!sameTotals(quantities(data.lines, identity), quantities(fulfillmentPreparation(record), identity))) add('FULFILLMENT_SOURCE_QUANTITY_MISMATCH', '准备商品、内部箱及数量须与 M4 来源逐项一致。');
  for (const material of data.materials) if (material.boxId && !selected.has(material.boxId)) add('INVALID_MATERIAL_BOX', '辅料引用了准备范围以外的箱。', 'error', material.boxId);
  if (new Set(data.externalOrders.map((order) => order.externalOrderNo)).size !== data.externalOrders.length) add('INVALID_DUPLICATE_EXTERNAL_ORDER', '同一外部单号只能登记一个当前结果。');
  const external = data.externalOrders.filter((order) => order.status !== 'cancelled');
  const mismatches: string[] = [];
  if (data.externalOrders.length) {
    for (const order of data.externalOrders) {
      if (!workflowEvidence(context, record.id, order.evidenceFileId)) add('FULFILLMENT_RESULT_EVIDENCE_REQUIRED', `外部单据 ${order.externalOrderNo} 缺少核对凭据。`);
      if (order.status === 'cancelled' && !workflowEvidence(context, record.id, order.cancelEvidenceFileId)) add('FULFILLMENT_CANCEL_EVIDENCE_REQUIRED', `外部单据 ${order.externalOrderNo} 缺少取消凭据。`);
      if (order.status !== 'cancelled' && order.warehouseCode !== data.warehouseCode) mismatches.push(`外部单据 ${order.externalOrderNo} 出库仓与准备仓不同`);
      if (order.status === 'shortage' || order.status === 'unknown') mismatches.push(`外部单据 ${order.externalOrderNo} 尚未完成库存分配`);
      if (order.status === 'shortage' && !order.shortageReason) add('FULFILLMENT_SHORTAGE_REASON_REQUIRED', `请记录 ${order.externalOrderNo} 的缺货原因。`);
      for (const line of order.lines) {
        if (!sourceBoxes.has(line.boxId)) add('INVALID_EXTERNAL_LINE_BOX', '外部实际明细引用了来源中不存在的内部箱。', 'error', line.boxId);
        else if (!selected.has(line.boxId)) mismatches.push(`外部单据 ${order.externalOrderNo} 包含准备范围以外的来源箱`);
      }
      for (const material of order.materials) if (material.boxId) {
        if (!sourceBoxes.has(material.boxId)) add('INVALID_EXTERNAL_MATERIAL_BOX', '外部辅料引用了来源中不存在的内部箱。', 'error', material.boxId);
        else if (!selected.has(material.boxId)) mismatches.push(`外部单据 ${order.externalOrderNo} 的辅料包含准备范围以外的来源箱`);
      }
    }
    if (!sameTotals(quantities(data.lines, identity), quantities(external.flatMap((order) => order.lines), identity))) mismatches.push('外部单据商品与准备数量不一致');
    if (!sameTotals(quantities(data.materials, materialKey), quantities(external.flatMap((order) => order.materials), materialKey))) mismatches.push('外部单据辅料数量或费用关联范围不一致');
    if (!sameTotals(componentTotals(data.lines), componentTotals(external.flatMap((order) => order.lines)))) mismatches.push('外部单据组合关系与准备明细不同');
  }
  for (const message of mismatches) add('FULFILLMENT_RESULT_MISMATCH', `${message}，继续待核对。`, 'warning');
  if (action === 'record_result' && !data.externalOrders.length) add('FULFILLMENT_RESULT_REQUIRED', '请登记至少一张外部单据及实际结果。');
  if (action === 'cancel' && data.externalOrders.some((order) => order.status !== 'cancelled')) add('FULFILLMENT_CANCEL_PENDING', '外部单据仍有效，请先登记每张单据的取消结果。');
  if (action === 'cancel') for (const issue of issues) if (!issue.code.startsWith('INVALID_') && !issue.code.startsWith('IMMUTABLE_') && !['FULFILLMENT_CANCEL_EVIDENCE_REQUIRED', 'FULFILLMENT_RESULT_EVIDENCE_REQUIRED', 'FULFILLMENT_CANCEL_PENDING'].includes(issue.code)) issue.severity = 'warning';
  const complete = context.sourceValid && external.length > 0 && external.every((order) => order.status === 'allocated') && !mismatches.length && !issues.some((issue) => issue.severity === 'error');
  let status = data.externalOrders.length ? (complete ? 'complete' : 'pending') : action === 'confirm' && !issues.some((issue) => issue.severity === 'error') ? 'ready' : previous?.status === 'ready' && !issues.some((issue) => issue.severity === 'error') ? 'ready' : 'draft';
  if (action === 'cancel' && !issues.some((issue) => issue.severity === 'error') || previous?.status === 'cancelled') status = 'cancelled';
  return { status, issues, claims: status === 'cancelled' || status === 'draft' ? [] : [{ purpose: 'fulfillment', boxIds: record.boxIds }] };
}

async function renderPreparation(record: WorkflowRecord, context: WorkflowContext, purpose: string) {
  if (purpose !== 'preparation' && purpose !== 'reconciliation') throw new Error('不支持的单据清单类型。');
  const data: FulfillmentData = fulfillmentDataSchema.parse(record.data), book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('准备清单');
  sheet.addRows([['单据准备与核对清单'], ['准备组', record.title, '版本', record.version], ['M4文件SHA-256', record.source.fileSha256], ['出库仓', data.warehouseCode, '物流', data.logistics], ['内部箱ID', 'MSKU', 'FNSKU', 'SKU', '数量', '组合明细']]);
  for (const line of data.lines) sheet.addRow([line.boxId, line.msku, line.fnsku, line.sku, line.quantity, line.components.map((entry) => `${entry.sku} × ${entry.quantity}`).join('; ')]);
  const actual = book.addWorksheet('外部结果');
  actual.addRow(['外部单号', '出库仓', '库存分配状态', '内部箱ID', 'SKU', '数量', '核对凭据ID', '取消凭据ID']);
  for (const order of data.externalOrders) {
    for (const line of order.lines.length ? order.lines : [null]) actual.addRow([order.externalOrderNo, order.warehouseCode, order.status, line?.boxId ?? '', line?.sku ?? '', line?.quantity ?? '', order.evidenceFileId ?? '', order.cancelEvidenceFileId ?? '']);
  }
  const materials = book.addWorksheet('辅料'); materials.addRow(['来源', '外部单号', 'SKU', '数量', '费用关联', '内部箱ID']);
  for (const material of data.materials) materials.addRow(['准备', '', material.sku, material.quantity, material.scope, material.boxId ?? '']);
  for (const order of data.externalOrders) for (const material of order.materials) materials.addRow(['实际', order.externalOrderNo, material.sku, material.quantity, material.scope, material.boxId ?? '']);
  const checks = book.addWorksheet('核对问题'); checks.addRow(['代码', '级别', '说明']);
  for (const issue of evaluateFulfillment(record, context, 'read').issues) checks.addRow([issue.code, issue.severity, issue.message]);
  for (const tab of book.worksheets) { tab.views = [{ state: 'frozen', ySplit: 1 }]; tab.columns.forEach((column) => { column.width = 28; }); tab.getRow(1).font = { bold: true }; tab.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }; }
  return { bytes: Buffer.from(await book.xlsx.writeBuffer()), name: `fulfillment-${record.id}-v${record.version}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}
export const fulfillmentPolicy: WorkflowPolicy = { kind: 'fulfillment', dataSchema: fulfillmentDataSchema, evaluate: evaluateFulfillment, render: renderPreparation };
