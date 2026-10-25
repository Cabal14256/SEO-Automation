import { Decimal } from 'decimal.js';
import { financeDataSchema, fulfillmentDataSchema, type FinanceData, type WorkflowContext, type WorkflowIssue, type WorkflowRecord } from '@scm/contracts';
import type { WorkflowPolicy } from '../workflow/policy.js';

const Exact = Decimal.clone({ precision: 100 });
const number = (s: string | null | undefined) => typeof s === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(s) && new Exact(s).abs().lte('999999999999999');
const feeKey = (id: string, type: string, currency: string, order = '') => JSON.stringify([id, order, type, currency]);
export function allocationTotals(data: FinanceData) {
  const totals = new Map<string, { fulfillmentId: string; externalOrderNo: string; feeType: string; currency: string; amount: string }>();
  for (const line of data.lines.filter((line) => line.nature !== 'estimate')) for (const allocation of line.allocations) {
    if (!number(allocation.amount)) continue;
    const key = feeKey(allocation.fulfillmentId, line.type, line.currency, allocation.externalOrderNo), previous = totals.get(key);
    totals.set(key, { fulfillmentId: allocation.fulfillmentId, externalOrderNo: allocation.externalOrderNo, feeType: line.type, currency: line.currency, amount: new Exact(previous?.amount ?? '0').plus(allocation.amount).toFixed() });
  }
  return [...totals.values()];
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function evaluateFinance(record: WorkflowRecord, context: WorkflowContext, action: string) {
  const data = financeDataSchema.parse(record.data), issues: WorkflowIssue[] = [];
  const issue = (code: string, message: string, severity: WorkflowIssue['severity'] = 'error') => issues.push({ code, message, severity });
  const previous = context.records.find((row) => row.id === record.id);
  const old = previous ? financeDataSchema.parse(previous.data) : null;
  const files = new Set(context.files.filter((file) => file.recordId === record.id).map((file) => file.id));
  const hasEvidence = (ids: string[]) => ids.length > 0 && ids.every((id) => files.has(id));
  if (!['save', 'read', 'confirm', 'record_result', 'settle', 'cancel', 'export:allocation-checklist'].includes(action)) issue('INVALID_ACTION', '不支持此费用操作。');
  if (old && old.externalResults.some((event) => !data.externalResults.some((candidate) => same(candidate, event)))) issue('IMMUTABLE_EXTERNAL_RESULT', '已登记外部费用事实不能删除或改写，请追加更正结果。');
  if (old && old.lines.some((line) => !data.lines.some((next) => same(next, line))) && previous && (['confirmed', 'pending', 'complete'].includes(previous.status) || old.externalResults.length > 0)) issue('IMMUTABLE_CONFIRMED_BILL', '已确认费用行不可覆盖，请追加补账或退款行。');
  if (new Set(data.lines.map((line) => line.id)).size !== data.lines.length || new Set(data.externalResults.map((result) => result.id)).size !== data.externalResults.length) issue('INVALID_DUPLICATE_LINE', '费用行和结果记录编号不能重复。');
  if (!context.sourceValid) issue('SOURCE_STALE', context.sourceInvalidReason ?? '来源已变化。', ['read', 'save', 'record_result'].includes(action) ? 'warning' : 'error');
  if (data.zeroCostConfirmed) {
    if (data.lines.some((line) => line.nature !== 'estimate')) issue('ZERO_COST_CONFLICT', '有实际费用时不能确认无需费用。');
    if (!data.zeroCostReason || !hasEvidence(data.zeroCostEvidenceFileIds)) issue('ZERO_COST_EVIDENCE_REQUIRED', '无需费用须填写依据并上传凭据。');
  } else {
    if (!data.billNumber || !data.provider || !data.billFileId || !files.has(data.billFileId)) issue('BILL_REQUIRED', '请填写账单编号、收费方并上传原始账单。');
    if (!data.lines.some((line) => line.nature !== 'estimate')) issue('ACTUAL_FEES_REQUIRED', '预估费用不能代替实际账单。');
  }
  const recordBoxes = new Set(record.boxIds);
  for (const line of data.lines) {
    if (!number(line.amount)) { issue('AMOUNT_REQUIRED', '每行费用须填写明确金额，空值不等于零。'); continue; }
    if (!/^[A-Z]{3}$/.test(line.currency)) issue('CURRENCY_REQUIRED', '每行费用须填写三位币种代码。');
    if (line.nature === 'refund' ? new Exact(line.amount).gte(0) : new Exact(line.amount).lt(0)) issue('AMOUNT_SIGN_INVALID', '退款须为负数，其他费用不能为负数。');
    if (!line.boxIds.length || new Set(line.boxIds).size !== line.boxIds.length || line.boxIds.some((boxId) => !recordBoxes.has(boxId))) issue('INVALID_FEE_SCOPE', '收费范围须为本记录内明确且不重复的箱子。');
    if (line.nature === 'estimate') continue;
    if (!line.allocations.length || new Set(line.allocations.map((row) => JSON.stringify([row.fulfillmentId, row.externalOrderNo]))).size !== line.allocations.length) issue('ALLOCATION_REQUIRED', '实际费用须逐单分摊，同一费用行不能重复指定一单。');
    let total = new Exact(0); const coveredBoxes = new Set<string>();
    for (const allocation of line.allocations) {
      if (!number(allocation.amount)) { issue('ALLOCATION_AMOUNT_REQUIRED', '分摊金额不能为空。'); continue; }
      if (new Exact(allocation.amount).isZero() ? false : new Exact(allocation.amount).isNegative() !== new Exact(line.amount).isNegative()) issue('ALLOCATION_SIGN_INVALID', '分摊金额方向必须与原费用一致。');
      total = total.plus(allocation.amount);
      const target = context.records.find((peer) => peer.id === allocation.fulfillmentId && peer.kind === 'fulfillment' && peer.status === 'complete' && !context.invalidRecordIds?.includes(peer.id));
      if (!target || !target.boxIds.some((box) => line.boxIds.includes(box))) issue('ALLOCATION_TARGET_REQUIRED', '分摊目标须为收费范围内已核对的领星发货准备单。');
      else { const result = fulfillmentDataSchema.safeParse(target.data); const orders = result.success ? result.data.externalOrders.filter((order) => order.status === 'allocated') : []; const selectedOrder = orders.find((order) => allocation.externalOrderNo ? order.externalOrderNo === allocation.externalOrderNo : orders.length === 1); if (!selectedOrder) issue('EXTERNAL_ORDER_REQUIRED', '分摊须指定已核对的外部发货单号；多单准备组不能仅指定准备组。'); else { if (!selectedOrder.lines.some((row) => line.boxIds.includes(row.boxId))) issue('ALLOCATION_ORDER_SCOPE_MISMATCH', '费用不能分摊给收费范围以外的外部单据。'); selectedOrder.lines.forEach((row) => coveredBoxes.add(row.boxId)); } }
    }
    if (!total.equals(line.amount)) issue('ALLOCATION_NOT_BALANCED', '同币种分摊合计必须严格等于原费用，不自动消化尾差。');
    if (line.boxIds.some((boxId) => !coveredBoxes.has(boxId))) issue('ALLOCATION_SCOPE_NOT_COVERED', '收费范围内各箱须明确分摊到对应外部单据；零分摊也须显式填写。');
  }
  const latest = new Map<string, FinanceData['externalResults'][number]>();
  for (const result of data.externalResults) latest.set(feeKey(result.fulfillmentId, result.feeType, result.currency, result.externalOrderNo), result);
  const pending: WorkflowIssue[] = [];
  for (const total of allocationTotals(data)) {
    const result = latest.get(feeKey(total.fulfillmentId, total.feeType, total.currency, total.externalOrderNo));
    if (!result || result.status !== 'verified' || !number(result.expectedAmount) || !number(result.afterAmount) || !new Exact(result.expectedAmount).equals(total.amount) || !new Exact(result.afterAmount!).equals(total.amount) || !hasEvidence(result.evidenceFileIds)) pending.push({ code: 'FEE_RESULT_PENDING', severity: 'error', message: '分摊费用尚未完成外部回填及金额、币种、费用类型核对。' });
  }
  if (['settle', 'read'].includes(action) || action === 'record_result') issues.push(...pending.map((entry) => action === 'record_result' ? { ...entry, severity: 'warning' as const } : entry));
  if (action === 'cancel') {
    if (data.externalResults.length) issue('IMMUTABLE_EXTERNAL_RESULT', '已有外部费用结果不能取消，请通过补账或退款更正。');
    return { status: 'cancelled', issues };
  }
  const blocking = issues.some((item) => item.severity === 'error');
  let status = record.status;
  if (action === 'save') status = old && same(old, data) ? previous!.status : 'draft';
  if (action === 'confirm') status = data.zeroCostConfirmed && !blocking ? 'complete' : 'confirmed';
  if (action === 'record_result') status = !blocking && !pending.length ? 'complete' : 'pending';
  if (action === 'settle') status = !blocking ? 'complete' : 'pending';
  return { status, issues };
}
export const financePolicy: WorkflowPolicy = {
  kind: 'finance', dataSchema: financeDataSchema, evaluate: evaluateFinance,
  async render(record, context, purpose) { const { renderAllocationWorkbook } = await import('./workbook.js'); return renderAllocationWorkbook(record, context, purpose); },
};
