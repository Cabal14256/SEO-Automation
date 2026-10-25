import { archiveDataSchema, financeDataSchema, logisticsDataSchema, customsDataSchema, workflowBoxes, type WorkflowContext, type WorkflowIssue, type WorkflowRecord } from '@scm/contracts';
import type { WorkflowPolicy } from '../workflow/policy.js';
import { evaluateFinance } from './domain.js';
import { evaluateFulfillment } from '../fulfillment/domain.js';
import { evaluateLogistics } from '../logistics/domain.js';
import { customsPolicy } from '../customs/policy.js';

export function evaluateArchive(record: WorkflowRecord, context: WorkflowContext, action: string) {
  const data = archiveDataSchema.parse(record.data), issues: WorkflowIssue[] = [];
  const add = (code: string, message: string, boxId?: string) => issues.push({ code, severity: 'error', message, ...(boxId ? { boxId } : {}) });
  if (!['save', 'read', 'check', 'archive', 'reopen', 'export:archive-package'].includes(action)) add('INVALID_ACTION', '不支持此归档操作。');
  if (!context.sourceValid) add('ARCHIVE_SOURCE_STALE', context.sourceInvalidReason ?? '来源已失效。');
  const expected = workflowBoxes(record.source).filter((box) => box.groupId === data.groupId).map((box) => box.id);
  if (!expected.length || expected.length !== record.boxIds.length || expected.some((boxId) => !record.boxIds.includes(boxId))) add('INVALID_ARCHIVE_SCOPE', '批次归档必须覆盖当前完整批次箱范围。');
  const applicableEvidence = context.files.filter((file) => file.recordId === record.id).map((file) => file.id);
  if ((data.customsNotApplicable || data.filing9810NotApplicable) && (!data.notApplicableReason || !data.notApplicableEvidenceFileIds.length || data.notApplicableEvidenceFileIds.some((id) => !applicableEvidence.includes(id)))) add('NOT_APPLICABLE_EVIDENCE_REQUIRED', '不适用申报步骤须填写明确依据并上传凭据。');
  const active = context.records.filter((peer) => !['cancelled', 'superseded'].includes(peer.status) && peer.id !== record.id && peer.boxIds.some((id) => expected.includes(id)));
  const effective = new Map(active.map((peer) => [peer.id, peer.kind === 'fulfillment' ? evaluateFulfillment(peer, context, 'read') : peer.kind === 'logistics' ? evaluateLogistics(peer, context, 'read') : peer.kind === 'customs' ? customsPolicy.evaluate(peer, context, 'read') : peer.kind === 'finance' ? evaluateFinance(peer, context, 'read') : { status: peer.status, issues: [] }]));
  const complete = (peer: WorkflowRecord) => { const state = effective.get(peer.id)!; return state.status === 'complete' && !state.issues.some((issue) => issue.severity === 'error'); };
  for (const peer of active) if (context.invalidRecordIds?.includes(peer.id)) add('ARCHIVE_DEPENDENCY_STALE', `${peer.title} 的来源已变化，需处理更正待办。`);
  for (const boxId of expected) {
    if (!active.some((peer) => peer.kind === 'fulfillment' && complete(peer) && peer.boxIds.includes(boxId))) add('FULFILLMENT_PENDING', '存在尚未核对库存分配的箱子。', boxId);
    const logistics = active.filter((peer) => peer.kind === 'logistics' && peer.boxIds.includes(boxId));
    if (!logistics.some((peer) => { const parsed = logisticsDataSchema.safeParse(peer.data); return parsed.success && complete(peer) && parsed.data.handovers.some((event) => event.boxIds.includes(boxId)) && parsed.data.lingxingResults.some((result) => result.boxId === boxId && result.status === 'shipped' && result.evidenceFileId); })) add('HANDOVER_PENDING', '存在交接或领星发货结果未完成的箱子。', boxId);
    const declarations = active.filter((peer) => peer.kind === 'customs' && peer.boxIds.includes(boxId));
    if (!data.customsNotApplicable && !declarations.some((peer) => { const parsed = customsDataSchema.safeParse(peer.data); return parsed.success && complete(peer) && parsed.data.customsResult.status === 'success'; })) add('CUSTOMS_PENDING', '存在报关结果未确认的箱子。', boxId);
    if (!data.filing9810NotApplicable && !declarations.some((peer) => { const parsed = customsDataSchema.safeParse(peer.data); return parsed.success && complete(peer) && parsed.data.filing9810Result.status === 'success'; })) add('FILING9810_PENDING', '存在9810结果未确认的箱子。', boxId);
    const finances = active.filter((peer) => peer.kind === 'finance' && peer.boxIds.includes(boxId));
    if (!finances.length || !finances.every((peer) => peer.status === 'complete' && !evaluateFinance(peer, context, 'read').issues.some((issue) => issue.severity === 'error'))) add('FINANCE_PENDING', '存在待账单、待分摊、待回填或待核对的费用。', boxId);
    else if (!finances.some((peer) => { const d = financeDataSchema.parse(peer.data); return d.zeroCostConfirmed || d.lines.some((line) => line.nature !== 'estimate' && line.boxIds.includes(boxId)); })) add('FINANCE_SCOPE_PENDING', '该箱尚无实际费用归属或无需费用依据。', boxId);
  }
  // Unresolved extra records cannot be hidden by a second completed record.
  for (const peer of active) if (['pending', 'returned', 'rejected', 'stale'].includes(effective.get(peer.id)!.status) || effective.get(peer.id)!.issues.some((issue) => issue.severity === 'error')) add('UNRESOLVED_WORKFLOW', `${peer.title} 仍有未处理结果。`);
  let status = record.status;
  if (action === 'save' || action === 'reopen') status = 'draft';
  if (['check', 'archive'].includes(action)) status = issues.length ? 'pending' : 'ready';
  return { status, issues };
}
export const archivePolicy: WorkflowPolicy = {
  kind: 'archive', dataSchema: archiveDataSchema, evaluate: evaluateArchive,
  async render(record, context, purpose) { if (purpose !== 'archive-package') throw new Error('不支持此归档文件用途。'); const { renderArchivePackage } = await import('./archive-files.js'); return renderArchivePackage(record, context); },
};
