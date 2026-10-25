import { fulfillmentDataSchema, logisticsActionSchema, logisticsDataSchema, workflowBoxes, type LogisticsData, type WorkflowContext, type WorkflowIssue, type WorkflowRecord } from '@scm/contracts';
import { workflowEvidence } from '../fulfillment/domain.js';
import type { WorkflowPolicy } from '../workflow/policy.js';

const positiveWeight = (value: string) => /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value) && /[1-9]/.test(value);
const releaseData = (data: LogisticsData) => JSON.stringify({ fulfillmentIds: [...data.fulfillmentIds].sort(), logisticsOrderNo: data.logisticsOrderNo, trackingNo: data.trackingNo, submission: data.submission, receipt: data.receipt, outboundReview: data.outboundReview, boxes: [...data.boxes].sort((a, b) => a.boxId.localeCompare(b.boxId)) });
export function evaluateLogistics(record: WorkflowRecord, context: WorkflowContext, action: string) {
  const issues: WorkflowIssue[] = [];
  const add = (code: string, message: string, severity: WorkflowIssue['severity'] = 'error', boxId?: string) => issues.push({ code, severity, message, ...(boxId ? { boxId } : {}) });
  const parsed = logisticsDataSchema.safeParse(record.data);
  if (!parsed.success) return { status: 'draft', issues: [{ code: 'INVALID_LOGISTICS_DATA', severity: 'error' as const, message: '物流与交接数据格式无效。' }] };
  const data = parsed.data, selected = new Set(record.boxIds), sourceBoxes = new Set(workflowBoxes(record.source).map((box) => box.id));
  const previous = context.records.find((entry) => entry.id === record.id), oldParsed = previous ? logisticsDataSchema.safeParse(previous.data) : null, old = oldParsed?.success ? oldParsed.data : undefined;
  const factAction = ['record_receipt', 'handover', 'record_lingxing', 'cancel'].includes(action);
  if (action !== 'read' && !logisticsActionSchema.safeParse(action).success) add('INVALID_ACTION', '不支持该物流操作。');
  if (!record.boxIds.length || selected.size !== record.boxIds.length || record.boxIds.some((id) => !sourceBoxes.has(id))) add('INVALID_BOX_SCOPE', '物流范围必须由来源中不重复的内部箱 ID 组成。');
  if (previous?.status === 'cancelled' && action !== 'read') add('IMMUTABLE_CANCELLED_RECORD', '已取消物流记录不能继续编辑。');
  if (old) {
    for (const handover of old.handovers) if (!data.handovers.some((entry) => entry.id === handover.id && JSON.stringify(entry) === JSON.stringify(handover))) add('IMMUTABLE_HANDOVER', '已发生的交接不能删除或改写；请保留原记录并登记更正待办。');
    for (const result of old.lingxingResults) if (!data.lingxingResults.some((entry) => entry.boxId === result.boxId)) add('IMMUTABLE_LINGXING_RESULT', '已登记的领星发货结果不能删除。');
    if ((old.handovers.length || old.lingxingResults.length) && JSON.stringify([...record.boxIds].sort()) !== JSON.stringify([...previous!.boxIds].sort())) add('IMMUTABLE_RESULT_SCOPE', '已有交接或领星结果的物流记录不能改变箱范围。');
    if (old.submission && !data.submission) add('IMMUTABLE_SUBMISSION', '已登记的提交记录不能删除。');
    if (old.receipt && !data.receipt) add('IMMUTABLE_RECEIPT', '已登记的物流反馈不能删除。');
  }
  if (!context.sourceValid) add('LOGISTICS_SOURCE_STALE', context.sourceInvalidReason ?? 'M4 来源或复核已失效。', factAction ? 'warning' : 'error');
  if (new Set(data.fulfillmentIds).size !== data.fulfillmentIds.length) add('INVALID_DUPLICATE_FULFILLMENT', '关联准备组不能重复。');
  const fulfillment = data.fulfillmentIds.map((id) => context.records.find((entry) => entry.id === id));
  const covered = new Set<string>();
  for (const preparation of fulfillment) {
    if (!preparation || preparation.kind !== 'fulfillment' || preparation.status !== 'complete' || context.invalidRecordIds?.includes(preparation.id) || preparation.source.documentId !== record.source.documentId || preparation.source.documentVersion !== record.source.documentVersion || preparation.source.fileSha256 !== record.source.fileSha256 || !fulfillmentDataSchema.safeParse(preparation.data).success) { add('LOGISTICS_FULFILLMENT_REQUIRED', '关联单据准备须已完成核对且引用相同 M4 版本。'); continue; }
    preparation.boxIds.forEach((id) => { if (selected.has(id)) covered.add(id); });
  }
  if (record.boxIds.some((id) => !covered.has(id))) add('LOGISTICS_FULFILLMENT_REQUIRED', '物流范围内每箱须有已完成核对的领星单据与库存分配。');
  const submissionValid = Boolean(data.submission && data.submission.exportId === record.source.exportId && data.submission.fileSha256 === record.source.fileSha256);
  if (!submissionValid) add('LOGISTICS_SUBMISSION_REQUIRED', '请登记当前已复核 M4 丰信文件的提交版本和哈希。');
  if (!data.logisticsOrderNo) add('LOGISTICS_ORDER_REQUIRED', '请登记物流订单号。');
  if (!data.trackingNo) add('LOGISTICS_TRACKING_REQUIRED', '请登记跟踪号。');
  if (data.receipt?.status !== 'accepted') add('LOGISTICS_ACCEPTANCE_REQUIRED', '物流订单尚未明确接收。');
  if (data.receipt && !workflowEvidence(context, record.id, data.receipt.evidenceFileId)) add('LOGISTICS_RECEIPT_EVIDENCE_REQUIRED', '物流反馈需要接单回执或拒绝凭据。');
  if (!data.outboundReview?.passed || !workflowEvidence(context, record.id, data.outboundReview.evidenceFileId)) add('LOGISTICS_OUTBOUND_REVIEW_REQUIRED', '放行前须明确完成线下出货复核，登记核对时间并上传复核凭据。');
  if (new Set(data.boxes.map((box) => box.boxId)).size !== data.boxes.length) add('INVALID_DUPLICATE_BOX', '每箱只能登记一个当前箱唛及重量记录。');
  const labelReferences = data.boxes.map((box) => box.labelReference).filter(Boolean);
  if (new Set(labelReferences).size !== labelReferences.length) add('INVALID_DUPLICATE_LABEL_REFERENCE', '不同内部箱不能使用同一箱唛编号，请核对标签对应关系。');
  for (const box of data.boxes) if (!selected.has(box.boxId)) add('INVALID_LABEL_BOX', '箱唛与重量引用了物流范围外的箱。', 'error', box.boxId);
  for (const boxId of record.boxIds) {
    const box = data.boxes.find((entry) => entry.boxId === boxId);
    const label = context.files.find((file) => file.id === box?.labelFileId && file.recordId === record.id);
    if (!box || !box.labelReference || !workflowEvidence(context, record.id, box.labelFileId) || label?.mimeType !== 'application/pdf') add('LOGISTICS_LABEL_REQUIRED', '每箱须关联原始 PDF 箱唛及人工核对的标签编号。', 'error', boxId);
    if (!box || !positiveWeight(box.grossWeightKg) || !positiveWeight(box.chargeableWeightKg)) add('LOGISTICS_WEIGHT_REQUIRED', '每箱物流毛重和计费重须明确且大于零（kg）。', 'error', boxId);
  }
  if (new Set(data.handovers.map((entry) => entry.id)).size !== data.handovers.length) add('INVALID_DUPLICATE_HANDOVER', '交接记录 ID 不能重复。');
  const handed = new Set<string>(), newHandovers = data.handovers.filter((entry) => !old?.handovers.some((prior) => prior.id === entry.id));
  for (const handover of data.handovers) {
    if (!workflowEvidence(context, record.id, handover.evidenceFileId)) add('LOGISTICS_HANDOVER_EVIDENCE_REQUIRED', '实际交接须上传签收或交接凭据。');
    for (const boxId of handover.boxIds) {
      if (!selected.has(boxId)) add('INVALID_HANDOVER_BOX', '交接引用了物流范围以外的内部箱。', 'error', boxId);
      if (handed.has(boxId)) add('INVALID_DUPLICATE_HANDED_BOX', '同一内部箱不能重复交接。', 'error', boxId);
      handed.add(boxId);
    }
  }
  if (new Set(data.lingxingResults.map((entry) => entry.boxId)).size !== data.lingxingResults.length) add('INVALID_DUPLICATE_LINGXING_RESULT', '每箱只能登记一个当前领星发货结果。');
  for (const result of data.lingxingResults) {
    if (!selected.has(result.boxId)) add('INVALID_LINGXING_BOX', '领星结果引用了范围外的箱。', 'error', result.boxId);
    if (!result.externalOrderNo || !workflowEvidence(context, record.id, result.evidenceFileId)) add('LOGISTICS_LINGXING_EVIDENCE_REQUIRED', '领星发货结果须有外部单号及核对凭据。', 'error', result.boxId);
    const externalOrderMatches = fulfillment.some((entry) => {
      if (!entry || entry.kind !== 'fulfillment') return false;
      const parsedPreparation = fulfillmentDataSchema.safeParse(entry.data);
      return parsedPreparation.success && parsedPreparation.data.externalOrders.some((order) => order.externalOrderNo === result.externalOrderNo && order.status !== 'cancelled' && order.lines.some((line) => line.boxId === result.boxId));
    });
    if (!externalOrderMatches) add('LOGISTICS_LINGXING_ORDER_MISMATCH', '领星结果单号与该箱关联的实际单据不同，继续待核对。', 'warning', result.boxId);
    if (result.status !== 'shipped' || !handed.has(result.boxId)) add('LOGISTICS_SHIPPING_MISMATCH', '实际交接与领星发货结果尚未一致。', 'warning', result.boxId);
  }
  const releaseCodes = new Set(['LOGISTICS_SOURCE_STALE', 'LOGISTICS_FULFILLMENT_REQUIRED', 'LOGISTICS_SUBMISSION_REQUIRED', 'LOGISTICS_ORDER_REQUIRED', 'LOGISTICS_TRACKING_REQUIRED', 'LOGISTICS_ACCEPTANCE_REQUIRED', 'LOGISTICS_RECEIPT_EVIDENCE_REQUIRED', 'LOGISTICS_OUTBOUND_REVIEW_REQUIRED', 'LOGISTICS_LABEL_REQUIRED', 'LOGISTICS_WEIGHT_REQUIRED']);
  const ready = context.sourceValid && !issues.some((issue) => releaseCodes.has(issue.code) || issue.code.startsWith('INVALID_') || issue.code.startsWith('IMMUTABLE_'));
  const previouslyReleased = ['released', 'partial_handover', 'complete'].includes(previous?.status ?? '') && old && releaseData(old) === releaseData(data);
  if (action === 'submit') {
    // Submission precedes acceptance, labels and weights. Only its own dependency
    // and valid source are gates; the remaining checklist stays visible as warnings.
    for (const issue of issues) if (releaseCodes.has(issue.code) && !['LOGISTICS_SOURCE_STALE', 'LOGISTICS_SUBMISSION_REQUIRED'].includes(issue.code)) issue.severity = 'warning';
  }
  if (action === 'record_receipt' || action === 'record_lingxing' || action === 'handover') {
    for (const issue of issues) if (releaseCodes.has(issue.code)) issue.severity = 'warning';
  }
  if (action === 'record_receipt' && !data.receipt) add('LOGISTICS_RECEIPT_REQUIRED', '请登记接收、拒绝或待核对反馈。');
  if (action === 'record_lingxing' && !data.lingxingResults.length) add('LOGISTICS_LINGXING_RESULT_REQUIRED', '请登记领星发货结果。');
  if (action === 'handover') {
    if (!newHandovers.length) add('LOGISTICS_HANDOVER_REQUIRED', '请增加本次实际交接箱及签收凭据。');
    for (const handover of newHandovers) if ((!previouslyReleased || !ready) && !handover.exceptionReason) add('LOGISTICS_HANDOVER_EXCEPTION_REQUIRED', '未满足有效放行条件时，登记已发生的交接须填写异常原因。');
  } else if (newHandovers.length && action !== 'read') add('INVALID_HANDOVER_ACTION', '新增实际交接请使用交接登记操作。');
  if (action === 'cancel' && (data.handovers.length || data.lingxingResults.some((entry) => entry.status === 'shipped'))) add('LOGISTICS_CANCEL_PHYSICAL_FACT', '已有实际交接或领星发货事实，不能取消掩盖；请保留记录处理差异。');
  const allHanded = record.boxIds.every((id) => handed.has(id));
  const allShipped = record.boxIds.every((id) => data.lingxingResults.some((entry) => entry.boxId === id && entry.status === 'shipped'));
  const complete = ready && allHanded && allShipped && !issues.some((issue) => issue.severity === 'error' || issue.code === 'LOGISTICS_LINGXING_ORDER_MISMATCH');
  let status = data.handovers.length ? (complete ? 'complete' : allHanded ? 'pending' : 'partial_handover') : action === 'release' && ready || previouslyReleased && ready ? 'released' : data.receipt?.status === 'rejected' ? 'rejected' : data.receipt?.status === 'accepted' ? 'accepted' : submissionValid ? 'submitted' : 'draft';
  if (action === 'cancel' && !issues.some((issue) => issue.code === 'LOGISTICS_CANCEL_PHYSICAL_FACT' || issue.code.startsWith('INVALID_') || issue.code.startsWith('IMMUTABLE_'))) { status = 'cancelled'; for (const issue of issues) if (releaseCodes.has(issue.code)) issue.severity = 'warning'; }
  if (previous?.status === 'cancelled') status = 'cancelled';
  if (data.handovers.length && !complete) for (const boxId of handed) if (!data.lingxingResults.some((entry) => entry.boxId === boxId && entry.status === 'shipped')) add('LOGISTICS_LINGXING_PENDING', '该箱已实际交接，领星发货结果仍待核对。', 'warning', boxId);
  return { status, issues, claims: status === 'draft' || status === 'cancelled' ? [] : [{ purpose: 'logistics', boxIds: record.boxIds }] };
}

export const logisticsPolicy: WorkflowPolicy = { kind: 'logistics', dataSchema: logisticsDataSchema, evaluate: evaluateLogistics };
