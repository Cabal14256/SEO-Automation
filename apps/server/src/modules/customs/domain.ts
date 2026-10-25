import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { customsDataSchema, documentCountryCode, logisticsDataSchema, workflowBoxes, type CustomsData, type CustomsExternalResult, type WorkflowContext, type WorkflowIssue, type WorkflowRecord } from '@scm/contracts';

const Exact = Decimal.clone({ precision: 100 });
export const decimalValue = (value: string, allowZero = false): boolean => /^\d+(?:\.\d{1,6})?$/.test(value) && new Exact(value).lte(Number.MAX_SAFE_INTEGER) && (allowZero ? new Exact(value).gte(0) : new Exact(value).gt(0));
export const customsExcelNumberSafe = (value: Decimal): boolean => value.isFinite() && value.sd() <= 15 && new Exact(value.toNumber()).eq(value);
const identity = (item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([item.msku, item.fnsku, item.sku]);
const currencyValid = (value: string) => /^[A-Z]{3}$/.test(value);
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
export const digestCustomsValue = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function groupCustomsPrintLines(data: CustomsData) {
  const groups = new Map<string, { line: CustomsData['lines'][number]; quantity: Decimal; declaredQuantity: Decimal; boxIds: string[] }>();
  for (const line of data.lines) {
    const key = JSON.stringify([line.msku, line.fnsku, line.sku, line.chineseName, line.englishName, line.hsCode, line.material, line.use, line.brand, line.model, line.unit, line.unitPrice, line.currency]);
    const current = groups.get(key);
    if (current) { current.quantity = current.quantity.plus(line.quantity); current.declaredQuantity = current.declaredQuantity.plus(line.declaredQuantity); current.boxIds.push(line.boxId); }
    else groups.set(key, { line, quantity: new Exact(line.quantity), declaredQuantity: new Exact(line.declaredQuantity), boxIds: [line.boxId] });
  }
  return [...groups.values()];
}
export const customsLogisticsDependencies = (record: WorkflowRecord, context: WorkflowContext) => context.records.filter((peer) => peer.kind === 'logistics' && peer.source.documentId === record.source.documentId && peer.boxIds.some((id) => record.boxIds.includes(id))).sort((a, b) => a.id.localeCompare(b.id));
export function customsContentFingerprint(record: WorkflowRecord, context: WorkflowContext, purpose = 'customs-package'): string {
  const data = customsDataSchema.parse(record.data);
  const content = Object.fromEntries(Object.entries(data).filter(([key]) => !['review', 'customsResult', 'filing9810Result'].includes(key)));
  return digestCustomsValue({ source: record.source, boxIds: [...record.boxIds].sort(), data: content, logistics: customsLogisticsDependencies(record, context).map((peer) => ({ id: peer.id, version: peer.version, data: peer.data, source: peer.source })), ...(purpose === 'filing9810-checklist' ? { checklist: { customsExternalNumber: data.customsResult.externalNumber, reviewExportId: data.review?.exportId ?? '', reviewSha256: data.review?.fileSha256 ?? '' } } : {}) });
}

/** Defaults split on the business keys; combining countries always needs explicit evidence. */
export function suggestCustomsGroups(members: ReadonlyArray<{ entity: string; country: string; declarationMode: string; currency: string; boxIds: string[] }>): Array<{ key: string; boxIds: string[] }> {
  const groups = new Map<string, string[]>();
  for (const member of members) {
    const key = JSON.stringify([member.entity, documentCountryCode(member.country) ?? member.country.toUpperCase(), member.declarationMode, member.currency]);
    groups.set(key, [...(groups.get(key) ?? []), ...member.boxIds]);
  }
  return [...groups].map(([key, boxIds]) => ({ key, boxIds: [...new Set(boxIds)] }));
}

export function validateCustomsContent(record: WorkflowRecord, context: WorkflowContext): WorkflowIssue[] {
  const data = customsDataSchema.parse(record.data), issues: WorkflowIssue[] = [];
  const add = (code: string, message: string, boxId?: string) => issues.push({ code, severity: 'error', message, ...(boxId ? { boxId } : {}) });
  if (!context.sourceValid) add('CUSTOMS_SOURCE_STALE', context.sourceInvalidReason ?? 'M4 来源已变化，请重新采用有效单据。');
  const boxes = workflowBoxes(record.source).filter((box) => record.boxIds.includes(box.id));
  if (!record.boxIds.length || new Set(record.boxIds).size !== record.boxIds.length || boxes.length !== record.boxIds.length) add('CUSTOMS_BOX_SCOPE', '报关箱范围必须唯一且属于当前 M4 单据。');
  const countries = [...new Set(boxes.map((box) => documentCountryCode(box.country) ?? box.country.toUpperCase()))].sort();
  if (countries.join(',') !== [...new Set(data.countryCodes)].sort().join(',')) add('CUSTOMS_COUNTRY_SCOPE', '报关国家必须与所选箱子的目的国家一致。');
  if (countries.length > 1 && (!data.crossCountryConfirmation.confirmed || !data.crossCountryConfirmation.reason)) add('CUSTOMS_CROSS_COUNTRY_CONFIRMATION', '跨国合并必须逐组确认依据，默认按国家拆组。');
  for (const key of ['entity', 'declarationMode', 'sellerName', 'sellerAddress', 'buyerName', 'buyerAddress', 'contractNumber', 'invoiceNumber', 'tradeTerms', 'portOfLoading', 'portOfDestination'] as const) if (!data[key]) add('CUSTOMS_FIELD_REQUIRED', `请补齐报关资料：${key}。`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.exportDate) || Number.isNaN(Date.parse(`${data.exportDate}T00:00:00Z`)) || new Date(`${data.exportDate}T00:00:00Z`).toISOString().slice(0, 10) !== data.exportDate) add('CUSTOMS_EXPORT_DATE', '出口日期须为有效日期。');
  if (!currencyValid(data.currency)) add('CUSTOMS_CURRENCY', '商品币种须为三个大写英文字母。');
  if (!decimalValue(data.freightAmount, true)) add('CUSTOMS_FREIGHT_AMOUNT', '运费须填写非负金额；无运费请明确填写 0。');
  if (!currencyValid(data.freightCurrency)) add('CUSTOMS_FREIGHT_CURRENCY', '请独立填写运费币种。');
  const lineKeys = new Set<string>();
  for (const line of data.lines) {
    const key = `${line.boxId}:${identity(line)}`;
    const box = boxes.find((candidate) => candidate.id === line.boxId), item = box?.items.find((candidate) => identity(candidate) === identity(line));
    if (lineKeys.has(key)) add('CUSTOMS_DUPLICATE_PRODUCT', '同一箱内商品不能重复申报。', line.boxId);
    lineKeys.add(key);
    if (!box || !item || !/^\d+$/.test(line.quantity) || !item.quantity || !decimalValue(line.quantity) || !new Exact(line.quantity).eq(item.quantity)) add('CUSTOMS_QUANTITY_MISMATCH', '报关商品身份与数量必须逐箱匹配有效 M4 来源。', line.boxId);
    if (!decimalValue(line.declaredQuantity) || !line.unit) add('CUSTOMS_DECLARED_UNIT', '请填写有效申报数量和单位。', line.boxId);
    if (decimalValue(line.quantity) && decimalValue(line.declaredQuantity) && (!new Exact(line.quantity).eq(line.declaredQuantity) || !['PCS', '件', '个'].includes(line.unit)) && (!line.conversionConfirmed || !line.conversionReason)) add('CUSTOMS_UNIT_CONVERSION', '申报数量或单位转换必须人工确认并记录依据。', line.boxId);
    if (!decimalValue(line.unitPrice, true)) add('CUSTOMS_UNIT_PRICE', '请填写有效商品单价。', line.boxId);
    if (line.currency !== data.currency || !currencyValid(line.currency)) add('CUSTOMS_PRODUCT_CURRENCY', '商品币种须与本报关组一致；不同币种应拆组。', line.boxId);
    for (const field of ['chineseName', 'englishName', 'hsCode', 'material', 'use', 'brand', 'model'] as const) if (!line[field]) add('CUSTOMS_DECLARATION_REQUIRED', `请补齐商品申报资料：${field}。`, line.boxId);
    if (line.hsCode && !/^\d{6,10}$/.test(line.hsCode)) add('CUSTOMS_HS_CODE', '海关编码须为 6 至 10 位数字。', line.boxId);
  }
  for (const box of boxes) {
    for (const item of box.items) if (!lineKeys.has(`${box.id}:${identity(item)}`)) add('CUSTOMS_PRODUCT_MISSING', '所选箱内商品未全部纳入申报。', box.id);
    const weights = data.boxWeights.filter((weight) => weight.boxId === box.id);
    if (weights.length !== 1 || !weights[0]!.confirmed || !decimalValue(weights[0]!.grossWeight) || !decimalValue(weights[0]!.netWeight) || new Exact(weights[0]!.netWeight).gt(weights[0]!.grossWeight)) add('CUSTOMS_WEIGHT_REQUIRED', '每箱须人工确认有效毛重与净重，且净重不能大于毛重。', box.id);
  }
  if (data.lines.length && data.lines.every((line) => decimalValue(line.quantity) && decimalValue(line.declaredQuantity))) {
    const groups = groupCustomsPrintLines(data);
    if (groups.length > 16) add('CUSTOMS_TEMPLATE_CAPACITY', '当前七页版式每组最多支持 16 种完整申报商品，请进一步拆组。');
    if (data.lines.every((line) => decimalValue(line.unitPrice, true))) {
      const amounts = groups.map((group) => group.declaredQuantity.times(group.line.unitPrice));
      if ([...groups.flatMap((group) => [group.quantity, group.declaredQuantity, new Exact(group.line.unitPrice)]), ...amounts, amounts.reduce((sum, value) => sum.plus(value), new Exact(0))].some((value) => !customsExcelNumberSafe(value))) add('CUSTOMS_EXCEL_PRECISION', '数量或金额超过当前XLSX数值精度，不能生成会损失精度的报关资料。');
    }
  }
  if (data.boxWeights.length && data.boxWeights.every((weight) => decimalValue(weight.grossWeight) && decimalValue(weight.netWeight))) {
    const values = data.boxWeights.flatMap((weight) => [new Exact(weight.grossWeight), new Exact(weight.netWeight)]);
    values.push(data.boxWeights.reduce((sum, weight) => sum.plus(weight.grossWeight), new Exact(0)), data.boxWeights.reduce((sum, weight) => sum.plus(weight.netWeight), new Exact(0)));
    if (values.some((value) => !customsExcelNumberSafe(value))) add('CUSTOMS_EXCEL_WEIGHT_PRECISION', '箱重或合计超过当前XLSX数值精度，请核对后再生成。');
  }
  if (data.boxWeights.some((weight) => !record.boxIds.includes(weight.boxId))) add('CUSTOMS_WEIGHT_SCOPE', '重量记录不能包含报关范围以外的箱子。');
  const peers = customsLogisticsDependencies(record, context);
  for (const box of boxes) {
    const peersWithBox = peers.filter((peer) => peer.boxIds.includes(box.id) && peer.status !== 'cancelled' && !context.invalidRecordIds?.includes(peer.id) && peer.source.documentRevisionId === record.source.documentRevisionId && peer.source.exportId === record.source.exportId && peer.source.fileSha256 === record.source.fileSha256).map((peer) => logisticsDataSchema.safeParse(peer.data)).filter((parsed) => parsed.success).map((parsed) => parsed.data);
    const available = peersWithBox.find((peer) => peer.receipt?.status === 'accepted' && peer.logisticsOrderNo && peer.boxes.some((weight) => weight.boxId === box.id && decimalValue(weight.grossWeightKg) && decimalValue(weight.chargeableWeightKg)));
    if (!available) add('CUSTOMS_LOGISTICS_REQUIRED', '正式报关资料须等待接单成功的物流订单、每箱毛重与计费重。', box.id);
    const actualWeight = available?.boxes.find((weight) => weight.boxId === box.id), declaredWeight = data.boxWeights.find((weight) => weight.boxId === box.id);
    if (actualWeight && declaredWeight && decimalValue(declaredWeight.grossWeight) && !new Exact(actualWeight.grossWeightKg).eq(declaredWeight.grossWeight)) add('CUSTOMS_LOGISTICS_WEIGHT_MISMATCH', '报关毛重与当前物流回传毛重不一致，请核对后修订。', box.id);
  }
  const overlapping = context.records.filter((peer) => peer.id !== record.id && peer.kind === 'customs' && peer.status !== 'cancelled' && peer.boxIds.some((id) => record.boxIds.includes(id)));
  if (overlapping.length) add('CUSTOMS_DUPLICATE_SCOPE', '所选箱子已属于其他有效报关组，不能重复申报。');
  return issues;
}

export function validateCustomsExternalResult(record: WorkflowRecord, context: WorkflowContext, result: CustomsExternalResult, channel: 'customs' | '9810'): WorkflowIssue[] {
  if (result.status === 'draft') return [];
  const issues: WorkflowIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, severity: 'error', message });
  const submitted = context.exports.find((item) => item.id === result.submittedExportId && item.recordId === record.id && item.status === 'completed' && item.fileSha256 === result.submittedSha256 && item.purpose === (channel === 'customs' ? 'customs-package' : 'filing9810-checklist'));
  if (!submitted) add('CUSTOMS_SUBMISSION_VERSION', `${channel === 'customs' ? '报关' : '9810'}结果必须关联实际提交的导出版本与哈希。`);
  if (!result.reason) add('CUSTOMS_FEEDBACK_NOTE', '请填写外部反馈或人工核对说明。');
  if (['saved', 'review_passed', 'applied', 'success'].includes(result.status) && !result.externalNumber) add('CUSTOMS_EXTERNAL_NUMBER', '已保存、复审通过、已申请或成功结果须填写外部编号。');
  if (!result.feedbackFileIds.length || result.feedbackFileIds.some((id) => !context.files.some((file) => file.id === id && file.recordId === record.id && file.purpose !== 'template'))) add('CUSTOMS_FEEDBACK_EVIDENCE', '外部反馈须关联本报关组的原始反馈附件。');
  return issues;
}

export function customsReviewValid(record: WorkflowRecord, context: WorkflowContext, data: CustomsData): boolean {
  const exported = context.exports.find((item) => item.id === data.review?.exportId && item.recordId === record.id && item.purpose === 'customs-package' && item.status === 'completed' && item.fileSha256 === data.review?.fileSha256);
  return Boolean(exported && exported.dependencyHash === customsContentFingerprint(record, context));
}
