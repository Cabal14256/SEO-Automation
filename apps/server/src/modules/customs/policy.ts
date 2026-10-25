import { CUSTOMS_ACTIONS, CUSTOMS_EXPORT_PURPOSES, customsDataSchema, type WorkflowContext, type WorkflowIssue, type WorkflowRecord } from '@scm/contracts';
import type { WorkflowPolicy } from '../workflow/policy.js';
import { customsContentFingerprint, customsReviewValid, digestCustomsValue, validateCustomsContent, validateCustomsExternalResult } from './domain.js';
import { createCustomsWorkbook, createFiling9810Checklist } from './workbook.js';

export const customsPolicy: WorkflowPolicy = {
  kind: 'customs', dataSchema: customsDataSchema,
  fingerprint: customsContentFingerprint,
  evaluate(record, context, action) {
    const data = customsDataSchema.parse(record.data), contentIssues = validateCustomsContent(record, context), issues: WorkflowIssue[] = [];
    const previous = context.records.find((peer) => peer.id === record.id);
    const previousData = previous ? customsDataSchema.parse(previous.data) : null;
    const isFact = action === 'record-customs' || action === 'record-9810';
    const add = (code: string, message: string) => issues.push({ code, severity: 'error', message });
    if (action !== 'read' && !CUSTOMS_ACTIONS.includes(action as typeof CUSTOMS_ACTIONS[number]) && !CUSTOMS_EXPORT_PURPOSES.some((purpose) => action === `export:${purpose}`)) add('INVALID_CUSTOMS_ACTION', '不支持的报关操作。');
    if (action !== 'read' && action !== 'review' && data.review && digestCustomsValue(data.review) !== digestCustomsValue(previousData?.review ?? null)) add('INVALID_CUSTOMS_REVIEW_ACTION', '复核引用只能通过复核操作确认。');
    if (previous && previousData && [previousData.customsResult, previousData.filing9810Result].some((result) => result.status !== 'draft') && [...previous.boxIds].sort().join(',') !== [...record.boxIds].sort().join(',')) add('IMMUTABLE_CUSTOMS_SUBMITTED_SCOPE', '已登记外部结果的报关范围不能更换，请保留原范围并新建更正组。');
    if (action === 'cancel' && [data.customsResult, data.filing9810Result].some((result) => !['draft', 'returned'].includes(result.status))) add('CUSTOMS_CANCEL_EXTERNAL_RESULT', '外部业务已有有效或未知结果，请先登记取消或退回依据后再释放报关范围。');
    for (const key of ['customsResult', 'filing9810Result'] as const) {
      const allowed = action === (key === 'customsResult' ? 'record-customs' : 'record-9810');
      if (!allowed && digestCustomsValue(data[key]) !== digestCustomsValue(previousData?.[key] ?? customsDataSchema.parse({})[key])) add('IMMUTABLE_CUSTOMS_RESULT_ACTION', '外部事实须通过对应结果登记操作更新，历史事实不能随草稿清除。');
    }
    const preservesFactsOnly = isFact || action === 'cancel' || action === 'return';
    if (isFact) {
      if (previous && customsContentFingerprint(previous, context) !== customsContentFingerprint(record, context)) add('CUSTOMS_FACT_CONTENT', '登记外部结果时请保留原报关资料；内容修订须另行保存。');
      issues.push(...validateCustomsExternalResult(record, context, action === 'record-customs' ? data.customsResult : data.filing9810Result, action === 'record-customs' ? 'customs' : '9810'));
      if ((action === 'record-customs' ? data.customsResult : data.filing9810Result).status === 'draft') add('CUSTOMS_RESULT_EMPTY', '请选择实际外部结果，未知结果请登记为待核对。');
      issues.push(...contentIssues.map((issue) => ({ ...issue, severity: 'warning' as const })));
    } else issues.push(...contentIssues.map((issue) => preservesFactsOnly ? { ...issue, severity: 'warning' as const } : issue));
    const reviewValid = customsReviewValid(record, context, data);
    if (data.review && !reviewValid) issues.push({ code: 'CUSTOMS_REVIEW_STALE', severity: preservesFactsOnly || action === 'export:customs-package' ? 'warning' : 'error', message: '资料或物流来源已变化，原复核已失效，请重新生成并复核。' });
    if (action === 'return' && data.review) add('CUSTOMS_RETURN_REVIEW', '退回修订须清除当前复核引用，历史复核仍保留在版本记录中。');
    if (action === 'review' && !reviewValid) add('CUSTOMS_REVIEW_EXPORT', '复核须关联当前内容生成的七页文件及对应 SHA-256。');
    if (action === 'record-9810' && data.declarationMode !== '9810') add('CUSTOMS_9810_MODE', '当前申报方式不适用 9810 登记。');
    if (action === 'export:filing9810-checklist') {
      if (data.declarationMode !== '9810') add('CUSTOMS_9810_MODE', '当前申报方式不适用 9810 清单。');
      if (!data.ecommerceOrderNumber) add('CUSTOMS_ECOMMERCE_ORDER', '9810 填写清单须填写电商订单号。');
      if (!reviewValid) add('CUSTOMS_REVIEW_REQUIRED', '9810 填写清单须使用已复核的当前七页资料。');
    }
    const results = [['customs', data.customsResult], ...(data.declarationMode === '9810' ? [['9810', data.filing9810Result] as const] : [])] as const;
    if (action === 'complete' || action === 'read') {
      for (const [channel, result] of results) {
        if (result.status !== 'success') issues.push({ code: 'CUSTOMS_RESULT_PENDING', severity: 'error', message: `${channel === 'customs' ? '报关' : '9810'}尚未确认成功；已保存、复审通过、已申请分别保留为过程状态。` });
        else issues.push(...validateCustomsExternalResult(record, context, result, channel));
        if (result.status === 'success' && context.exports.find((item) => item.id === result.submittedExportId)?.dependencyHash !== customsContentFingerprint(record, context, channel === 'customs' ? 'customs-package' : 'filing9810-checklist')) issues.push({ code: 'CUSTOMS_SUBMISSION_STALE', severity: 'error', message: '外部成功结果对应旧资料，须核对当前修订后重新登记。' });
      }
      if (!reviewValid) issues.push({ code: 'CUSTOMS_REVIEW_REQUIRED', severity: 'error', message: '当前七页资料尚未复核通过。' });
    }
    let status = reviewValid ? 'approved' : 'draft';
    if (data.review && !reviewValid) status = 'stale';
    if (action === 'preflight') status = 'ready';
    if (isFact) status = 'pending';
    if (action === 'return') status = 'returned';
    if (action === 'cancel') status = 'cancelled';
    if (action === 'complete' && !issues.some((issue) => issue.severity === 'error')) status = 'complete';
    if (action === 'read' && record.status === 'complete' && !issues.some((issue) => issue.severity === 'error')) status = 'complete';
    if (action === 'read' && record.status === 'cancelled') status = 'cancelled';
    if (action === 'read' && record.status === 'returned') status = 'returned';
    return { status, issues, ...(action !== 'read' ? { claims: status === 'cancelled' ? [] : [{ purpose: 'customs-declaration', boxIds: record.boxIds }] } : {}) };
  },
  async render(record: WorkflowRecord, context: WorkflowContext, purpose: string, templateBytes?: Buffer) {
    const issues = customsPolicy.evaluate(record, context, `export:${purpose}`).issues;
    if (issues.some((issue) => issue.severity === 'error')) throw new Error(issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message).join('\n'));
    const data = customsDataSchema.parse(record.data);
    const bytes = purpose === 'customs-package' ? await createCustomsWorkbook(record, data, templateBytes) : await createFiling9810Checklist(record, data);
    return { bytes, name: `${purpose === 'customs-package' ? '报关七页资料' : '9810填写核对清单'}-${record.id}-v${record.version}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  },
};
