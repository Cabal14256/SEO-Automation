import { DOCUMENT_ADDRESS_FIELDS, DOCUMENT_ADDRESS_REQUIRED_FIELDS, DOCUMENT_BOX_FIELDS, DOCUMENT_FIELD_OPTIONS, DOCUMENT_PRODUCT_FIELDS, DOCUMENT_REQUIRED_FIELDS, documentAddressDifferences, documentBoxFieldKey, documentBoxes, documentBoxValue, documentCountryCode, documentInvoiceBoxGroups, documentRepresentativeProduct, documentTicketCurrency, documentAutomationSupplementInputSchema, hasCompleteDocumentAddress, withDocumentInvoiceDefaults,
  type Document, type DocumentAutomationFieldDescriptor, type DocumentAutomationSupplement, type DocumentAutomationSupplementInput, type DocumentProfile, type DocumentRevisionData, type DocumentTemplate, type DocumentValidation } from '@scm/contracts';
import type { BatchTx } from '../batches/service.js';
import { documentDigest, validateDocumentData } from './domain.js';
import { planAutomaticPreparation } from './automatic-preparation.js';
import { DOCUMENT_HEADER_FIELDS, documentProductOverrideKey, validateWorkbookData } from './workbook.js';

type ContextItem = { id: string; documentId: string | null; documentVersion?: number | null; status?: string; issues?: DocumentValidation['issues'] };
export type DocumentAutomationSupplementContext = { shippingRunId: string; items: readonly ContextItem[] };
export type DocumentAutomationSupplementTicket = { item: ContextItem; document: Document };
type Descriptor = DocumentAutomationFieldDescriptor;
type Field = Omit<Descriptor, 'id' | 'targets'> & { group: string; fieldKey: string };
const labels: Record<string, string> = { service: '渠道服务', customsMode: '报关方式', clearanceMode: '清关方式', taxMode: '税务方式', vat: 'VAT 税号', currency: '币种', battery: '含电池', magnetic: '含磁性', liquid: '含液体', powder: '含粉末', dangerous: '危险品', recipientName: '收件人', recipientCompany: '收件公司', addressLine1: '地址第 1 行', addressLine2: '地址第 2 行', addressLine3: '地址第 3 行', addressCode: '地址代码', city: '城市', state: '州 / 省', postalCode: '邮编', countryCode: '国家代码', phone: '电话', email: '邮箱', addressConfirmationReason: '地址采用原因', addressConfirmed: '已核对最终收件地址', englishName: '英文品名', chineseName: '中文品名', material: '材质', hsCode: '海关编码', use: '用途', brand: '品牌', model: '型号', salesLink: '销售链接', weight: '毛重（KG）', length: '长（CM）', width: '宽（CM）', height: '高（CM）', po: 'PO / Reference ID', deliveryStation: '交货仓站', deliveryWindow: '送仓时间', remarks: '备注' };
const categories = { party: '主体资料', channel: '渠道资料', tax: '税务资料', product: '商品资料' };
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : '';
const country = (value: unknown) => documentCountryCode(text(value)) ?? text(value).toUpperCase();
const options = (values: readonly string[]) => [...new Set(values)].sort().map((value) => ({ value, label: value }));
const profileValue = (profile: Pick<DocumentProfile, 'id' | 'version'>) => `${profile.id}:${profile.version}`;
const referenceOf = (profile: DocumentProfile) => ({ category: profile.category, profileId: profile.id, version: profile.version, data: structuredClone(profile.data) });
const identityMatches = (values: Record<string, unknown>, sid: number, item: { msku: string; fnsku: string; sku: string }) => Number(values.sid) === sid && values.msku === item.msku && values.fnsku === item.fnsku && values.sku === item.sku;
const ticketScope = (data: DocumentRevisionData) => documentDigest([...new Set(data.members.map((member) => JSON.stringify([member.demand.snapshot.sid, member.demand.snapshot.channel ?? '', country(member.demand.snapshot.country), member.demand.snapshot.destinationFc ?? '', data.fields.currency ?? ''])))].sort());
const scopeLabel = (data: DocumentRevisionData) => [...new Set(data.members.map((member) => [member.demand.snapshot.shop, member.demand.snapshot.country, member.demand.snapshot.channel, member.demand.snapshot.destinationFc].filter(Boolean).join(' · ')))].join(' / ');
function applicableProfiles(data: DocumentRevisionData, profiles: readonly DocumentProfile[], category: 'party' | 'channel' | 'tax'): DocumentProfile[] {
  return profiles.filter((profile) => profile.category === category && profile.status === 'active'
    && (category === 'party' ? Boolean(text(profile.data.sid)) : category === 'tax' ? Boolean(text(profile.data.sid) || text(profile.data.country) || text(profile.data.countryCode)) : Boolean(text(profile.data.businessChannel ?? profile.data.channel)))
    && data.members.every((member) => { const scope = member.demand.snapshot, values = profile.data;
      return (!text(values.sid) || text(values.sid) === String(scope.sid))
        && (!text(values.countryCode) || country(values.countryCode) === country(scope.country))
        && (!text(values.country) || (category === 'tax' ? text(values.country) === scope.country : country(values.country) === country(scope.country)))
        && (!text(values.currency) || text(values.currency).toUpperCase() === data.fields.currency)
        && (!text(values.destinationFc ?? values.fc) || text(values.destinationFc ?? values.fc).toUpperCase() === scope.destinationFc?.trim().toUpperCase())
        && (category !== 'channel' || text(values.businessChannel ?? values.channel) === scope.channel);
    }));
}
function currentReference(data: DocumentRevisionData, profiles: readonly DocumentProfile[], category: DocumentProfile['category'], identity?: { sid: number; msku: string; fnsku: string; sku: string }) {
  const refs = data.profileReferences.filter((ref) => ref.category === category && (!identity || identityMatches(ref.data, identity.sid, identity)));
  const selected = refs.length === 1 ? profiles.find((profile) => profile.id === refs[0]!.profileId && profile.version === refs[0]!.version && profile.status === 'active' && documentDigest(profile.data) === documentDigest(refs[0]!.data)) : undefined;
  return { refs, selected };
}

/** Archived facts stay immutable; a missing selling price has a separate audited fallback command. */
export function buildDocumentAutomationRequirements(tickets: readonly DocumentAutomationSupplementTicket[], profiles: readonly DocumentProfile[], templates: readonly DocumentTemplate[]): DocumentAutomationSupplement {
  const descriptors = new Map<string, Descriptor>(), issues: DocumentAutomationSupplement['issues'] = [];
  for (const { item, document } of tickets) {
    const data = { ...document.currentRevision.data, fields: withDocumentInvoiceDefaults(document.currentRevision.data.fields, document.currentRevision.data.members) }, commonScope = ticketScope(data), commonLabel = scopeLabel(data);
    const add = (field: Field) => { const { group, fieldKey, ...metadata } = field;
      const key = documentDigest([group, fieldKey, metadata.value, metadata.options ?? []]);
      const target = { itemId: item.id, documentId: document.id, expectedVersion: document.version, fieldKey };
      const current = descriptors.get(key); if (current) current.targets.push(target); else descriptors.set(key, { ...metadata, id: '', targets: [target] });
    };
    const header = (key: string, required = true, selectable?: string[]) => {
      const choices = selectable ?? (key in DOCUMENT_FIELD_OPTIONS ? [...DOCUMENT_FIELD_OPTIONS[key as keyof typeof DOCUMENT_FIELD_OPTIONS]] : undefined);
      add({ group: commonScope, fieldKey: key, label: labels[key] ?? '单票资料', kind: choices?.length ? 'select' : 'text', value: data.fields[key] ?? '', required, scope: 'common', scopeLabel: commonLabel, ...(choices?.length ? { options: options(choices) } : {}) });
    };
    const observed: DocumentValidation['issues'] = [...item.issues ?? [], ...planAutomaticPreparation(data, profiles, templates).issues, ...validateDocumentData(data), ...validateWorkbookData(data)];
    const seen = new Set<string>();
    for (const issue of observed) { const key = documentDigest(issue); if (seen.has(key)) continue; seen.add(key); issues.push({ ...issue, itemId: item.id, documentId: document.id }); }
    if (item.status === 'completed' || ['cancelled', 'superseded', 'approved', 'pending_review'].includes(document.status)) continue;
    const selectedChannel = currentReference(data, profiles, 'channel').selected;
    const channels = selectedChannel ? [selectedChannel] : applicableProfiles(data, profiles, 'channel');
    const services = [...new Set(channels.flatMap((profile) => Array.isArray(profile.data.allowedServices) ? profile.data.allowedServices.map(text).filter(Boolean) : [text(profile.data.service)].filter(Boolean)))];
    for (const key of DOCUMENT_REQUIRED_FIELDS) {
      if ((DOCUMENT_ADDRESS_FIELDS as readonly string[]).includes(key)) continue;
      if (key === 'currency' && documentTicketCurrency(data.members)) continue;
      const choices = key === 'service' ? services : key in DOCUMENT_FIELD_OPTIONS ? [...DOCUMENT_FIELD_OPTIONS[key as keyof typeof DOCUMENT_FIELD_OPTIONS]] : [];
      if (!text(data.fields[key]) || choices.length && !choices.includes(text(data.fields[key]))) header(key, true, choices);
    }
    if (/自主|递延/.test(data.fields.taxMode ?? '') && !text(data.fields.vat)) header('vat');
    // A conflict between adopted automatic defaults remains an explicit ticket choice.
    for (const key of Object.keys(DOCUMENT_HEADER_FIELDS)) {
      if (text(data.fields[key]) || (DOCUMENT_REQUIRED_FIELDS as readonly string[]).includes(key) || (DOCUMENT_ADDRESS_FIELDS as readonly string[]).includes(key) || ['orderNumber', 'reference', 'tradeTerms', 'currency'].includes(key)) continue;
      const defaults = [...new Set(data.profileReferences.filter((ref) => ['party', 'channel', 'tax'].includes(ref.category)).map((ref) => text(ref.data[key])).filter(Boolean))];
      if (defaults.length > 1) header(key, true, defaults);
    }
    for (const category of ['party', 'channel', 'tax'] as const) {
      const candidates = applicableProfiles(data, profiles, category), saved = currentReference(data, profiles, category);
      if (!candidates.length || saved.selected && candidates.some((profile) => profile.id === saved.selected!.id) && saved.refs.length === 1 || !saved.refs.length && candidates.length === 1) continue;
      add({ group: commonScope, fieldKey: `@profile.${category}`, label: `采用${categories[category]}`, kind: 'select', value: saved.selected ? profileValue(saved.selected) : '', required: true, scope: 'common', scopeLabel: commonLabel,
        options: candidates.map((profile) => ({ value: profileValue(profile), label: `${profile.key} · v${profile.version}` })).sort((a, b) => a.value.localeCompare(b.value)), help: '仅采用所选版本；不会修改公共资料。' });
    }
    const unresolvedAddress = !hasCompleteDocumentAddress(data.fields) || data.fields.addressConfirmed !== 'true' || !text(data.fields.addressConfirmationReason) || observed.some((issue) => issue.severity === 'error' && (issue.profileCategory === 'address' || issue.code.startsWith('DOCUMENT_ADDRESS') || issue.code === 'DOCUMENT_COUNTRY_SCOPE_MISMATCH'));
    if (unresolvedAddress) {
      for (const key of DOCUMENT_ADDRESS_FIELDS) header(key, (DOCUMENT_ADDRESS_REQUIRED_FIELDS as readonly string[]).includes(key) || key === 'addressCode' && data.fields.addressCodeStatus === 'needs_review');
      header('addressConfirmationReason');
      add({ group: commonScope, fieldKey: 'addressConfirmed', label: labels.addressConfirmed!, kind: 'checkbox', value: false, required: true, scope: 'common', scopeLabel: commonLabel, help: '请核对以上最终完整地址并填写采用原因；勾选后将按本次提交的地址逐票留存确认记录。' });
    }
    const identities = new Set<string>();
    for (const member of data.members) {
      const boxes = documentBoxes(member, data.fields);
      for (const box of boxes) for (const field of DOCUMENT_BOX_FIELDS) {
        const value = field === 'po' ? box.po : box.values[field]; if (text(value)) continue;
        const fieldKey = documentBoxFieldKey(box.boxId, field);
        add({ group: `${document.id}:${box.boxId}`, fieldKey, label: `${box.code || `箱 ${box.order}`} ${labels[field]}`, kind: field === 'po' ? 'text' : 'number', value: data.fields[fieldKey] ?? '', required: true, scope: 'box', scopeLabel: `${member.demand.snapshot.fba} · ${box.code || `箱 ${box.order}`}`, ...(field !== 'po' ? { help: '填写有效正数；毛重 KG，尺寸 CM。' } : {}) });
      }
      const groups = data.generationRulesVersion === 'v2' ? documentInvoiceBoxGroups(boxes) : boxes.map((box) => ({ representative: documentRepresentativeProduct(box.items) }));
      for (const { representative: product } of groups) {
        if (!product) continue;
        const identity = { sid: member.demand.snapshot.sid, msku: product.msku, fnsku: product.fnsku, sku: product.sku }, key = documentProductOverrideKey(identity.sid, product); if (identities.has(key)) continue; identities.add(key);
        const saved = currentReference(data, profiles, 'product', identity), candidates = profiles.filter((profile) => profile.category === 'product' && profile.status === 'active' && identityMatches(profile.data, identity.sid, product));
        const productLabel = `${member.demand.snapshot.shop} · ${product.sku} · ${product.msku} / ${product.fnsku}`;
        if (candidates.length && (saved.refs.length > 1 || saved.refs.length === 1 && !saved.selected || !saved.refs.length && candidates.length > 1)) add({ group: key, fieldKey: `@profile.product.${key}`, label: '采用商品资料', kind: 'select', value: saved.selected ? profileValue(saved.selected) : '', required: true, scope: 'product', scopeLabel: productLabel, options: candidates.map((profile) => ({ value: profileValue(profile), label: `${profile.key} · v${profile.version}` })).sort((a, b) => a.value.localeCompare(b.value)) });
        const declaration = { ...saved.refs[0]?.data };
        const prefix = `product.${key}.`;
        for (const [field, value] of Object.entries(data.fields)) if (field.startsWith(prefix) && value !== null) declaration[field.slice(prefix.length)] = value;
        for (const field of DOCUMENT_PRODUCT_FIELDS) {
          if (field === 'unitPrice' || field === 'currency') continue;
          const value = text(declaration[field]); let invalid = false;
          if (field === 'salesLink' && value) try { invalid = !/^https?:$/.test(new URL(value).protocol); } catch { invalid = true; }
          if (value && !invalid) continue;
          add({ group: key, fieldKey: `${prefix}${field}`, label: labels[field]!, kind: 'text', value, required: true, scope: 'product', scopeLabel: productLabel });
        }
      }
    }
    const template = data.templateReference, activeTemplates = templates.filter((entry) => entry.purpose === data.purpose && entry.status === 'active');
    if (!template || !activeTemplates.some((entry) => entry.id === template.templateId && entry.version === template.version && entry.fileId === template.fileId && entry.sha256 === template.sha256)) {
      if (activeTemplates.length) add({ group: commonScope, fieldKey: '@template', label: '采用发票模板', kind: 'select', value: '', required: true, scope: 'common', scopeLabel: commonLabel, options: activeTemplates.map((entry) => ({ value: `${entry.id}:${entry.version}`, label: `${entry.name} · v${entry.version}` })).sort((a, b) => a.value.localeCompare(b.value)) });
    }
  }
  return { descriptors: [...descriptors.values()].map((descriptor) => { descriptor.targets.sort((a, b) => a.documentId.localeCompare(b.documentId) || a.fieldKey.localeCompare(b.fieldKey)); return { ...descriptor, id: `field-${documentDigest([descriptor.scope, descriptor.targets, descriptor.value, descriptor.options ?? []])}` }; }), issues };
}

class SupplementPlanError extends Error { constructor(public code: string, public status: 409 | 422, message: string) { super(message); } }
type SupplementRevision = { itemId: string; documentId: string; expectedVersion: number; fields: DocumentRevisionData['fields']; profileReferences: DocumentRevisionData['profileReferences']; templateReference: DocumentRevisionData['templateReference']; confirmAddress: boolean };
/** Validate every submitted value before any target revision is written. Empty values may remain missing. */
export function planDocumentAutomationSupplement(tickets: readonly DocumentAutomationSupplementTicket[], profiles: readonly DocumentProfile[], templates: readonly DocumentTemplate[], raw: DocumentAutomationSupplementInput): SupplementRevision[] {
  const input = documentAutomationSupplementInputSchema.parse(raw), requirements = buildDocumentAutomationRequirements(tickets, profiles, templates), descriptors = new Map(requirements.descriptors.map((field) => [field.id, field])), revisions = new Map<string, SupplementRevision>();
  const documentIds = new Set(tickets.map(({ document }) => document.id));
  if (Object.keys(input.documentVersions).length !== documentIds.size || Object.keys(input.documentVersions).some((id) => !documentIds.has(id)) || tickets.some(({ document }) => input.documentVersions[document.id] !== document.version)) throw new SupplementPlanError('VERSION_CONFLICT', 409, '整批单据版本已变化，请保留输入并重新读取缺项。');
  const submitted = input.values.map((entry) => { const descriptor = descriptors.get(entry.id); if (!descriptor) throw new SupplementPlanError('DOCUMENT_SUPPLEMENT_STALE', 409, '补充字段或适用范围已变化，请保留输入并重新读取。');
    if (descriptor.kind === 'checkbox' ? typeof entry.value !== 'boolean' : entry.value !== null && typeof entry.value !== 'string') throw new SupplementPlanError('VALIDATION_ERROR', 422, `${descriptor.label}的数据类型无效。`);
    let value = typeof entry.value === 'boolean' ? String(entry.value) : text(entry.value);
    if (descriptor.kind === 'select' && value && !descriptor.options?.some((option) => option.value === value)) throw new SupplementPlanError('VALIDATION_ERROR', 422, `${descriptor.label}不是当前可采用的选项。`);
    if (descriptor.kind === 'number' && value) {
      const weight = descriptor.targets[0]!.fieldKey.endsWith('.weight'), normalized = documentBoxValue(value, weight ? 'KG' : 'CM', weight ? 'weight' : 'dimension'); if (!normalized) throw new SupplementPlanError('DOCUMENT_BOX_VALUE_INVALID', 422, `${descriptor.label}须为有效正数。`); value = normalized;
    }
    if (descriptor.targets.some((target) => target.fieldKey.endsWith('.po')) && (value.length > 200 || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new SupplementPlanError('DOCUMENT_BOX_PO_INVALID', 422, 'PO / Reference ID 不能超过200字符或包含控制字符。');
    if (descriptor.targets[0]!.fieldKey === 'countryCode' && value) { value = value.toUpperCase(); if (!/^[A-Z]{2}$/.test(value)) throw new SupplementPlanError('VALIDATION_ERROR', 422, '国家代码须为两个英文字母。'); }
    if (descriptor.targets[0]!.fieldKey.endsWith('.salesLink') && value) try { if (!/^https?:$/.test(new URL(value).protocol)) throw new Error(); } catch { throw new SupplementPlanError('SALES_LINK_INVALID', 422, '请填写有效的商品销售链接。'); }
    return { descriptor, value };
  });
  const revisionFor = (target: Descriptor['targets'][number]) => { let revision = revisions.get(target.documentId); if (!revision) { const ticket = tickets.find((entry) => entry.document.id === target.documentId && entry.item.id === target.itemId); if (!ticket || ticket.document.version !== target.expectedVersion) throw new SupplementPlanError('DOCUMENT_SUPPLEMENT_STALE', 409, '补充字段不属于当前任务。'); const data = ticket.document.currentRevision.data; revision = { itemId: ticket.item.id, documentId: ticket.document.id, expectedVersion: ticket.document.version, fields: structuredClone(data.fields), profileReferences: structuredClone(data.profileReferences), templateReference: structuredClone(data.templateReference), confirmAddress: false }; revisions.set(target.documentId, revision); } return revision; };
  // Apply catalog choices first so explicit fields in the same submission remain authoritative.
  for (const { descriptor, value } of submitted.filter((entry) => entry.descriptor.targets[0]!.fieldKey === '@template' || entry.descriptor.targets[0]!.fieldKey.startsWith('@profile.'))) for (const target of descriptor.targets) {
    const revision = revisionFor(target);
    if (target.fieldKey === '@template') { const selected = templates.find((entry) => `${entry.id}:${entry.version}` === value); revision.templateReference = selected ? { templateId: selected.id, version: selected.version, fileId: selected.fileId, sha256: selected.sha256 } : null; continue; }
    const category = target.fieldKey.split('.')[1] as DocumentProfile['category'], identity = target.fieldKey.split('.')[2];
    revision.profileReferences = revision.profileReferences.filter((ref) => ref.category !== category || category === 'product' && documentProductOverrideKey(Number(ref.data.sid), { msku: text(ref.data.msku), fnsku: text(ref.data.fnsku), sku: text(ref.data.sku) }) !== identity);
    const selected = profiles.find((entry) => profileValue(entry) === value); if (!selected) continue; revision.profileReferences.push(referenceOf(selected));
    if (category !== 'product') {
      for (const [key, value] of Object.entries(selected.data)) if (key in DOCUMENT_HEADER_FIELDS && !text(revision.fields[key]) && !(DOCUMENT_ADDRESS_FIELDS as readonly string[]).includes(key) && !['currency', 'orderNumber', 'reference', 'tradeTerms'].includes(key) && text(value)) revision.fields[key] = text(value);
      if (category === 'channel' && !text(revision.fields.service)) { const services = Array.isArray(selected.data.allowedServices) ? selected.data.allowedServices.map(text).filter(Boolean) : []; if (services.length === 1) revision.fields.service = services[0]!; }
    }
  }
  for (const { descriptor, value } of submitted.filter((entry) => !entry.descriptor.targets[0]!.fieldKey.startsWith('@'))) for (const target of descriptor.targets) revisionFor(target).fields[target.fieldKey] = value;
  for (const revision of revisions.values()) {
    const before = tickets.find((entry) => entry.document.id === revision.documentId)!.document.currentRevision.data;
    if (submitted.some(({ descriptor }) => descriptor.targets.some((target) => target.documentId === revision.documentId && target.fieldKey === 'countryCode')) && text(revision.fields.countryCode) && before.members.some((member) => { const expected = documentCountryCode(member.demand.snapshot.country); return expected && expected !== revision.fields.countryCode; })) throw new SupplementPlanError('DOCUMENT_COUNTRY_SCOPE_MISMATCH', 422, '收件国家代码须与本票所有 FBA 所属国家一致。');
    const addressChanged = documentAddressDifferences(before.fields, revision.fields).length > 0;
    const explicitConfirmation = submitted.some(({ descriptor, value }) => value === 'true' && descriptor.targets.some((target) => target.documentId === revision.documentId && target.fieldKey === 'addressConfirmed'));
    const explicitReason = submitted.some(({ descriptor, value }) => Boolean(value) && descriptor.targets.some((target) => target.documentId === revision.documentId && target.fieldKey === 'addressConfirmationReason'));
    if (explicitConfirmation && (!hasCompleteDocumentAddress(revision.fields) || !text(revision.fields.addressConfirmationReason) || !explicitReason || before.fields.addressCodeStatus === 'needs_review' && !text(revision.fields.addressCode))) throw new SupplementPlanError('DOCUMENT_ADDRESS_CONFIRMATION_INVALID', 422, '确认地址时须同次填写采用原因，并补齐最终收件地址及待核实的 B3 地址代码。');
    if (addressChanged) { revision.fields.addressSelectionMode = 'manual'; revision.fields.addressSourceLabel = '本票手工地址'; }
    if (explicitConfirmation) { revision.fields.addressConfirmed = 'true'; revision.confirmAddress = true; }
    else if (addressChanged) { revision.fields.addressConfirmed = 'false'; revision.fields.addressConfirmationReason = ''; }
  }
  return [...revisions.values()];
}

async function supplementState(tx: BatchTx, actorId: string, context: DocumentAutomationSupplementContext, versions?: Record<string, number>) {
  const { and, eq } = await import('drizzle-orm'); const { documentProfiles, documentTemplates, documentTemplateVersions } = await import('./schema.js'); const { lockedDocument, serializeDocument, serializeProfile, DocumentError } = await import('./service.js');
  const tickets: DocumentAutomationSupplementTicket[] = [], ids = context.items.flatMap((item) => item.documentId ? [item.documentId] : []);
  if (new Set(ids).size !== ids.length) throw new DocumentError('DOCUMENT_SCOPE_MISMATCH', 422, '任务包含重复单据，请重新读取任务。');
  if (versions && (Object.keys(versions).length !== ids.length || Object.keys(versions).some((id) => !ids.includes(id)))) throw new DocumentError('VERSION_CONFLICT', 409, '整批单据范围已变化，请保留输入并重新读取。');
  for (const item of [...context.items].filter((item) => item.documentId).sort((a, b) => a.documentId!.localeCompare(b.documentId!))) { const { record, revision } = await lockedDocument(tx, item.documentId!, actorId, versions?.[item.documentId!]); if (revision.data.shippingRunId !== context.shippingRunId) throw new DocumentError('DOCUMENT_SCOPE_MISMATCH', 422, '补充单据不属于当前发货次。'); tickets.push({ item, document: serializeDocument(record, revision) }); }
  const rows = await tx.select().from(documentProfiles).for('share');
  const templateRows = await tx.select({ template: documentTemplates, version: documentTemplateVersions }).from(documentTemplates).innerJoin(documentTemplateVersions, and(eq(documentTemplateVersions.templateId, documentTemplates.id), eq(documentTemplateVersions.version, documentTemplates.version))).for('share');
  const templates: DocumentTemplate[] = templateRows.map(({ template, version }) => ({ id: template.id, purpose: template.purpose as DocumentTemplate['purpose'], name: template.name, version: template.version, status: template.status as DocumentTemplate['status'], fileId: version.fileId, sha256: version.sha256, mimeType: version.mimeType, createdBy: template.createdBy, createdAt: template.createdAt.toISOString() }));
  return { tickets, profiles: rows.map(serializeProfile), templates };
}
export async function getDocumentAutomationRequirementsInTx(tx: BatchTx, actorId: string, context: DocumentAutomationSupplementContext): Promise<DocumentAutomationSupplement & { documentVersions: Record<string, number> }> {
  const state = await supplementState(tx, actorId, context); const result = buildDocumentAutomationRequirements(state.tickets, state.profiles, state.templates);
  for (const item of context.items.filter((item) => !item.documentId)) for (const issue of item.issues ?? []) result.issues.push({ ...issue, itemId: item.id, documentId: null });
  return { ...result, documentVersions: Object.fromEntries(state.tickets.map(({ document }) => [document.id, document.version])) };
}
/** Caller owns the job lock, expected job version, operation audit and transaction. No export is requested here. */
export async function applyDocumentAutomationSupplementInTx(tx: BatchTx, actorId: string, context: DocumentAutomationSupplementContext, raw: DocumentAutomationSupplementInput) {
  const input = documentAutomationSupplementInputSchema.parse(raw), state = await supplementState(tx, actorId, context, input.documentVersions), { reviseDocumentInTx, DocumentError } = await import('./service.js');
  let revisions: SupplementRevision[]; try { revisions = planDocumentAutomationSupplement(state.tickets, state.profiles, state.templates, input); } catch (error) { if (error instanceof SupplementPlanError) throw new DocumentError(error.code, error.status, error.message); throw error; }
  const documents = [];
  for (const revision of revisions) { const { itemId, documentId, expectedVersion, ...changes } = revision; const result = await reviseDocumentInTx(tx, documentId, actorId, { operationId: input.operationId, expectedVersion, reason: '整批自动出单统一补充资料', ...changes }); documents.push({ itemId, documentId, documentVersion: result.document.version }); }
  return { documents };
}
