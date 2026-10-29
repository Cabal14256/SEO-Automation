import { createHash } from 'node:crypto';
import { DOCUMENT_ADDRESS_FIELDS, DOCUMENT_BOX_FIELDS, documentAddressDifferences, documentBoxes, documentBoxValue, documentCountryCode, documentInvoiceBoxGroups, documentMemberAddressCode, documentRevisionDataSchema, hasCompleteDocumentAddress, type DocumentCandidate, type DocumentExportReference, type DocumentMemberSnapshot, type DocumentRevisionData, type DocumentSourceReference, type DocumentValidation } from '@scm/contracts';
import { hasAddressConflict, haveDocumentAddressSourcesChanged } from './address.js';

export function documentDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export const shipmentClaimKey = (member: Pick<DocumentCandidate, 'demand'> | DocumentMemberSnapshot) => JSON.stringify([member.demand.snapshot.sid, member.demand.snapshot.fba.trim().toUpperCase()]);
/** Only new export requests require v2; reading/validating completed v1 files stays compatible. */
export function documentExportRulesIssue(data: Pick<DocumentRevisionData, 'generationRulesVersion'>, reference?: Pick<DocumentExportReference, 'generationRulesVersion' | 'pricingRule'>): DocumentValidation['issues'][number] | null {
  if (reference && (reference.generationRulesVersion !== 'v2' || reference.generationRulesVersion !== data.generationRulesVersion)) {
    return { code: 'DOCUMENT_EXPORT_RULES_STALE', severity: 'error', message: '该生成任务使用旧版规则或与单据修订不一致，请查询并采用领星资料后重新生成。' };
  }
  if (reference && reference.pricingRule !== 'fixed-2') return { code: 'DOCUMENT_EXPORT_RULES_STALE', severity: 'error', message: '该生成任务使用历史申报价格规则，请按固定单价 2.00 重新生成。' };
  return data.generationRulesVersion === 'v2' ? null : { code: 'DOCUMENT_GENERATION_UPGRADE_REQUIRED', severity: 'error', message: '旧草稿请先查询并采用领星商品及箱规资料升级；已有文件请建立更正单据后生成。' };
}
/** Local address profiles are historical; hidden product declarations do not gate v2 output. */
export function documentUsesProfileReference(data: DocumentRevisionData, reference: DocumentRevisionData['profileReferences'][number]): boolean {
  if (reference.category === 'address') return false;
  if (data.generationRulesVersion !== 'v2' || reference.category !== 'product') return true;
  const value = (key: string) => {
    const input = reference.data[key];
    return typeof input === 'string' ? input.trim() : typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input) ? String(input) : '';
  };
  return data.members.some((member) => Number(reference.data.sid) === member.demand.snapshot.sid
    && documentInvoiceBoxGroups(documentBoxes(member, data.fields)).some(({ representative: item }) => {
      return item && item.msku === value('msku') && item.fnsku === value('fnsku') && item.sku === value('sku');
    }));
}
export const documentDependencyInvalidReason = (issues: DocumentValidation['issues']): string | null => issues.find((issue) => issue.severity === 'error' && ['DOCUMENT_SOURCE_STALE', 'DOCUMENT_SOURCE_FILE_INVALID', 'DOCUMENT_PROFILE_STALE', 'DOCUMENT_TEMPLATE_STALE', 'CODES_REQUIRED', 'DOCUMENT_READ_ONLY'].includes(issue.code))?.message ?? null;
/** M3 no longer governs invoice validity; historical snapshots remain immutable. */
export function documentM2SourceReference(source: DocumentSourceReference): Omit<DocumentSourceReference, 'physicalConfirmationId' | 'm3Version' | 'sourceFingerprint'> {
  return { weekStartDate: source.weekStartDate, groupId: source.groupId, groupVersion: source.groupVersion, m2ConfirmationId: source.m2ConfirmationId,
    demandId: source.demandId, demandVersion: source.demandVersion, shipmentRevisionId: source.shipmentRevisionId };
}
export function documentBoxFieldIssues(data: Pick<DocumentRevisionData, 'members' | 'fields'>): DocumentValidation['issues'] {
  const boxes = new Set(data.members.flatMap((member) => member.shipment.data.boxes.map((box) => box.id))), issues: DocumentValidation['issues'] = [];
  for (const [key, value] of Object.entries(data.fields)) {
    if (!key.startsWith('box.')) continue;
    const match = /^box\.([^.]+)\.([^.]+)$/.exec(key), boxId = match?.[1], field = match?.[2];
    if (!boxId || !boxes.has(boxId) || !DOCUMENT_BOX_FIELDS.includes(field as typeof DOCUMENT_BOX_FIELDS[number])) {
      issues.push({ code: 'DOCUMENT_BOX_OVERRIDE_UNKNOWN', severity: 'error', message: '箱规修改引用了本票以外的箱或未知字段，请刷新箱清单后重试。' });
    } else if (value !== null && value.trim() && field !== 'po' && !documentBoxValue(value, field === 'weight' ? 'KG' : 'CM', field === 'weight' ? 'weight' : 'dimension')) {
      issues.push({ code: 'DOCUMENT_BOX_VALUE_INVALID', severity: 'error', message: '人工箱规必须为有效正数，毛重单位为 KG、尺寸单位为 CM，保留两位小数后须大于零。' });
    } else if (field === 'po' && value && (value.trim().length > 200 || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
      issues.push({ code: 'DOCUMENT_BOX_PO_INVALID', severity: 'error', message: 'PO / Reference ID 不能超过 200 个字符或包含控制字符。' });
    }
  }
  return issues;
}
/** Retain edits by stable box ID, removing edits only for boxes that left this ticket. */
export function reviseDocumentBoxFields(previous: DocumentRevisionData, next: DocumentRevisionData): Record<string, string | null> {
  const oldIds = new Set(previous.members.flatMap((member) => member.shipment.data.boxes.map((box) => box.id)));
  const currentIds = new Set(next.members.flatMap((member) => member.shipment.data.boxes.map((box) => box.id)));
  return Object.fromEntries(Object.entries(next.fields).filter(([key]) => {
    const boxId = /^box\.([^.]+)\./.exec(key)?.[1];
    return !boxId || !oldIds.has(boxId) || currentIds.has(boxId);
  }));
}
/** Address defaults follow the shipment's address code, rather than catalog response order. */
export function documentAddressSourceKey(members: DocumentRevisionData['members']): string {
  return documentDigest(members.map((member) => [member.demand.id, member.demand.snapshot.sid, member.demand.snapshot.fba.trim().toUpperCase(),
    documentCountryCode(member.demand.snapshot.country) ?? member.demand.snapshot.country.trim().toUpperCase(), documentMemberAddressCode(member) ?? '']).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

export function shouldResolveDocumentAddress(data: DocumentRevisionData, previous?: DocumentRevisionData): boolean {
  // A field edit supplied in this revision takes precedence over automatic source defaults.
  if (previous && documentAddressDifferences(previous.fields, data.fields).length > 0) return false;
  const sourceChanged = Boolean(previous && (documentAddressSourceKey(previous.members) !== documentAddressSourceKey(data.members) || haveDocumentAddressSourcesChanged(previous.members, data.members)));
  // An intentionally cleared manual address stays empty on subsequent saves in the same scope.
  if (previous && !sourceChanged && data.fields.addressSelectionMode === 'manual') return false;
  const hasAddress = DOCUMENT_ADDRESS_FIELDS.some((key) => !['addressCode', 'countryCode'].includes(key) && data.fields[key]?.trim());
  return data.fields.addressSelectionMode === 'profile' || !hasAddress || sourceChanged;
}
const countryAliases: Record<string, string> = {
  US: 'US', USA: 'US', 'UNITED STATES': 'US', '美国': 'US',
  GB: 'GB', UK: 'GB', 'UNITED KINGDOM': 'GB', '英国': 'GB',
  FR: 'FR', FRANCE: 'FR', '法国': 'FR', DE: 'DE', GERMANY: 'DE', '德国': 'DE',
  ES: 'ES', SPAIN: 'ES', '西班牙': 'ES', IT: 'IT', ITALY: 'IT', '意大利': 'IT',
  NL: 'NL', NETHERLANDS: 'NL', '荷兰': 'NL', PL: 'PL', POLAND: 'PL', '波兰': 'PL',
  SE: 'SE', SWEDEN: 'SE', '瑞典': 'SE', BE: 'BE', BELGIUM: 'BE', '比利时': 'BE',
  IE: 'IE', IRELAND: 'IE', '爱尔兰': 'IE', CA: 'CA', CANADA: 'CA', '加拿大': 'CA',
  JP: 'JP', JAPAN: 'JP', '日本': 'JP', AU: 'AU', AUSTRALIA: 'AU', '澳大利亚': 'AU',
};
function knownCountryCode(country: string): string | undefined { return countryAliases[country.trim().toUpperCase()]; }
export function memberFromCandidate(candidate: DocumentCandidate): DocumentMemberSnapshot {
  return { source: { ...(candidate.shippingRunId ? { shippingRunId: candidate.shippingRunId, shippingRunMonth: candidate.shippingRunMonth, shippingRunSequence: candidate.shippingRunSequence } : {}), weekStartDate: candidate.weekStartDate, groupId: candidate.groupId, groupVersion: candidate.groupVersion,
    m2ConfirmationId: candidate.m2ConfirmationId, demandId: candidate.demandId, demandVersion: candidate.demandVersion,
    shipmentRevisionId: candidate.shipment.id, physicalConfirmationId: candidate.physicalConfirmationId, m3Version: candidate.m3Version, sourceFingerprint: candidate.sourceFingerprint },
  demand: structuredClone(candidate.demand), shipment: structuredClone(candidate.shipment), codes: structuredClone(candidate.codes), physical: structuredClone(candidate.physical), ...(candidate.boxSource ? { boxSource: structuredClone(candidate.boxSource) } : {}), ...(candidate.sourceCandidates ? { sourceCandidates: structuredClone(candidate.sourceCandidates) } : {}) };
}
export function validateDocumentData(data: DocumentRevisionData): DocumentValidation['issues'] {
  const issues: DocumentValidation['issues'] = [];
  const add = (code: string, message: string, member?: DocumentMemberSnapshot) => issues.push({ code, severity: 'error', message, ...(member ? { demandId: member.source.demandId, groupId: member.source.groupId } : {}) });
  if (!documentRevisionDataSchema.safeParse(data).success) { add('DOCUMENT_DATA_INVALID', '单据快照结构无效，请重新建立草稿。'); return issues; }
  issues.push(...documentBoxFieldIssues(data));
  const first = data.members[0]!, scope = (member: DocumentMemberSnapshot) => JSON.stringify([member.demand.snapshot.sid, member.demand.snapshot.channel, member.demand.snapshot.destinationFc, member.demand.snapshot.country]);
  if (data.members.some((member) => scope(member) !== scope(first))) add('DOCUMENT_SPLIT_REQUIRED', '店铺、业务渠道、目的仓或国家不同的货件必须分开发票。');
  const resolvedAddress = data.fields.addressConfirmed === 'true' && Boolean(data.fields.addressConfirmationReason?.trim());
  if (!hasCompleteDocumentAddress(data.fields)) add('DOCUMENT_ADDRESS_INCOMPLETE', '请补齐本票收件人、地址第一行、城市、邮编及两字母国家代码。');
  if (!resolvedAddress) add('DOCUMENT_ADDRESS_UNCONFIRMED', '请核对领星货件地址或本票手工地址并填写采用原因后确认。');
  if (data.fields.addressCodeStatus === 'needs_review') add('DOCUMENT_ADDRESS_CODE_UNRESOLVED', data.fields.addressCodeReason || '请核实 B3 地址库编码并重新确认本票地址。');
  const addresses = data.members.flatMap((member) => member.sourceCandidates?.addresses.map((entry) => entry.data) ?? []);
  if (hasAddressConflict(addresses) && !resolvedAddress) add('DOCUMENT_ADDRESS_CONFLICT', '收件地址存在差异，请明确确认本票采用地址并填写原因后再出单。');
  const claims = new Set<string>();
  for (const member of data.members) {
    const sourceCountryCode = knownCountryCode(member.demand.snapshot.country), headerCountryCode = data.fields.countryCode?.trim().toUpperCase();
    if (sourceCountryCode && headerCountryCode && sourceCountryCode !== headerCountryCode) add('DOCUMENT_COUNTRY_SCOPE_MISMATCH', '本票国家代码须与来源货件国家一致。', member);
    if (data.shippingRunId && member.source.shippingRunId !== data.shippingRunId) add('CROSS_SHIPPING_RUN_MEMBER', '发票成员须属于所选发货次。', member);
    if (member.source.demandId !== member.demand.id || member.source.demandVersion !== member.demand.version || member.source.shipmentRevisionId !== member.shipment.id || member.shipment.demandId !== member.demand.id
      || member.shipment.data.sid !== member.demand.snapshot.sid || member.shipment.data.fba !== member.demand.snapshot.fba) add('DOCUMENT_MEMBER_IDENTITY_CONFLICT', '货件来源身份与快照不一致。', member);
    const claim = shipmentClaimKey(member); if (claims.has(claim)) add('DUPLICATE_DOCUMENT_MEMBER', '同一张发票不能重复包含相同店铺的完整 FBA。', member); claims.add(claim);
    const boxes = member.shipment.data.boxes;
    if (!boxes.length || new Set(boxes.map((box) => box.id)).size !== boxes.length) add('BOX_LIST_REQUIRED', '需要完整且不重复的实际箱清单。', member);
    const codes = member.codes.filter((code) => code.valid && code.demandId === member.demand.id);
    if (boxes.some((box) => box.order === null || codes.filter((code) => code.boxId === box.id).length !== 1)) add('CODES_REQUIRED', '该来源组尚未完成全部箱序和箱码。', member);
    // Old immutable draft snapshots may contain the previous missing-vs-present
    // address diagnostic. Re-evaluate its evidence using the current rule.
    for (const issue of member.sourceCandidates?.issues.filter((entry) => entry.severity === 'error') ?? []) {
      if (issue.code === 'DOCUMENT_ADDRESS_CONFLICT' && (resolvedAddress || !hasAddressConflict(member.sourceCandidates?.addresses.map((entry) => entry.data) ?? []))) continue;
      add(issue.code, issue.message, member);
    }
    const productKey = (item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([item.msku, item.fnsku, item.sku]);
    const totals = new Map<string, bigint>();
    for (const box of boxes) for (const item of box.items) {
      if (!item.quantity || !/^\d+$/.test(item.quantity)) { add('INVALID_QUANTITY', '箱内数量必须是有效非负整数。', member); continue; }
      totals.set(productKey(item), (totals.get(productKey(item)) ?? 0n) + BigInt(item.quantity));
    }
    for (const item of member.shipment.data.items) if (!item.quantity || !/^\d+$/.test(item.quantity) || totals.get(productKey(item)) !== BigInt(item.quantity)) add('DOCUMENT_QUANTITY_MISMATCH', '商品数量与逐箱数量不守恒。', member);
  }
  if (!data.templateReference) add('DOCUMENT_TEMPLATE_REQUIRED', '请选择已登记的单据模板。');
  const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const code = (value: unknown) => scalar(value).toUpperCase();
  for (const category of ['party', 'channel', 'tax'] as const) {
    const references = data.profileReferences.filter((reference) => reference.category === category);
    if (references.length > 1) issues.push({ code: 'DOCUMENT_PROFILE_AMBIGUOUS', severity: 'error', message: '同一张发票只能明确采用一份主体、渠道和税务资料。', profileCategory: category });
    const reference = references[0]; if (!reference) continue;
    const values = reference.data;
    const mismatch = category === 'party' ? values.sid !== undefined && scalar(values.sid) !== String(first.demand.snapshot.sid)
      : category === 'channel' ? scalar(values.businessChannel ?? values.channel) !== (first.demand.snapshot.channel ?? '')
          : values.sid !== undefined && scalar(values.sid) !== String(first.demand.snapshot.sid) || values.country !== undefined && scalar(values.country) !== first.demand.snapshot.country;
    const countryMismatch = category === 'tax' && Boolean(code(values.countryCode)) && Boolean(code(data.fields.countryCode)) && code(values.countryCode) !== code(data.fields.countryCode);
    const currencyMismatch = (category === 'channel' || category === 'tax') && Boolean(code(values.currency)) && Boolean(code(data.fields.currency)) && code(values.currency) !== code(data.fields.currency);
    if (mismatch || countryMismatch || currencyMismatch) issues.push({ code: 'DOCUMENT_PROFILE_SCOPE_MISMATCH', severity: 'error', message: '所选资料不适用于当前票的店铺、目的仓、业务渠道、国家或币种。', profileCategory: category });
    if (category === 'channel') {
      const allowed = Array.isArray(values.allowedServices) ? values.allowedServices.map(scalar).filter(Boolean) : [scalar(values.service)].filter(Boolean);
      if (allowed.length && !allowed.includes(data.fields.service ?? '')) issues.push({ code: 'DOCUMENT_SERVICE_INVALID', severity: 'error', message: '本票服务须采用已选择渠道资料版本中明确维护的服务。', profileCategory: category });
    }
  }
  return issues;
}
