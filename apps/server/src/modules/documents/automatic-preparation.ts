import { DOCUMENT_ADDRESS_FIELDS, DOCUMENT_BLANK_OUTPUT_FIELDS, applyDocumentAddress, documentCountryCode, documentRevisionInputSchema, documentTicketCurrency, hasCompleteDocumentAddress, hasDocumentAddressConflict, resolveDocumentLingxingAddress, withDocumentInvoiceDefaults,
  type DocumentProfile, type DocumentRevisionData, type DocumentTemplate, type DocumentValidation } from '@scm/contracts';
import { documentDigest, documentUsesProfileReference } from './domain.js';
import { resolveUnchangedProductProfile } from './product-profile.js';
import { DOCUMENT_HEADER_FIELDS } from './workbook.js';
import type { ActiveServiceMapping } from '../service-mappings/repository.js';
import { normalizeServiceMappingCountry } from '../service-mappings/normalization.js';

type PreparationIssue = DocumentValidation['issues'][number];
export type AutomaticPreparationPlan = Pick<DocumentRevisionData, 'fields' | 'profileReferences' | 'templateReference'> & { confirmAddress: boolean; issues: PreparationIssue[] };
type PreparationInput = { operationId: string; expectedVersion: number; reason: string; fields?: DocumentRevisionData['fields'] };
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : '';
const blank = (value: unknown) => !text(value);
const country = (value: unknown) => documentCountryCode(text(value)) ?? text(value).toUpperCase();
const referenceOf = (profile: DocumentProfile): DocumentRevisionData['profileReferences'][number] => ({ category: profile.category, profileId: profile.id, version: profile.version, data: structuredClone(profile.data) });
const retiredHeaders = new Set<string>(DOCUMENT_BLANK_OUTPUT_FIELDS);
const addressFields = new Set<string>(DOCUMENT_ADDRESS_FIELDS);
const headerFields = new Set(Object.keys(DOCUMENT_HEADER_FIELDS));
const categoryNames = { party: '主体', channel: '渠道', tax: '税务', product: '商品', address: '地址' };
const fieldNames: Record<string, string> = { service: '渠道服务', customsMode: '报关方式', clearanceMode: '清关方式', taxMode: '税务方式', vat: 'VAT 税号', battery: '含电池', magnetic: '含磁性', liquid: '含液体', powder: '含粉末', dangerous: '危险品', deliveryStation: '交货仓站', deliveryWindow: '送仓时间', remarks: '备注', addressCode: '地址代码', recipientName: '收件人', recipientCompany: '收件公司', addressLine1: '地址第 1 行', addressLine2: '地址第 2 行', addressLine3: '地址第 3 行', city: '城市', state: '州 / 省', postalCode: '邮编', countryCode: '国家代码', phone: '电话', email: '邮箱', currency: '币种' };
const transportMethodAliases: Record<string, string> = { HY: '海运', KP: '空派', KH: '卡航' };
const serviceTransportMethod = (value: unknown) => { const name = text(value); return transportMethodAliases[name.toUpperCase()] ?? name; };

/** Every member must resolve to the same explicitly maintained service. */
export function planDocumentServiceMapping(data: Pick<DocumentRevisionData, 'members' | 'fields'>, mappings: readonly ActiveServiceMapping[]): { service?: string; issues: PreparationIssue[] } {
  if (!blank(data.fields.service)) return { issues: [] };
  const missing = (): { issues: PreparationIssue[] } => ({ issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_MISSING', severity: 'error', message: '本票国家与运输方式尚未完整维护服务映射，请维护映射后重新准备，或明确填写本票渠道服务。' }] });
  if (!data.members.length) return missing();
  const services = new Set<string>();
  for (const member of data.members) {
    const countryCode = normalizeServiceMappingCountry(member.demand.snapshot.country), transportMethod = serviceTransportMethod(member.demand.snapshot.channel);
    if (!countryCode || !transportMethod) return missing();
    const matches = mappings.filter((mapping) => mapping.countryCode === countryCode && serviceTransportMethod(mapping.transportMethod) === transportMethod);
    if (!matches.length || matches.some((mapping) => blank(mapping.service))) return missing();
    if (matches.length !== 1) return { issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_AMBIGUOUS', severity: 'error', message: '本票国家与运输方式匹配到多份服务映射，请修正映射或明确填写本票渠道服务。' }] };
    services.add(matches[0]!.service.trim());
  }
  if (services.size !== 1) return { issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_CONFLICT', severity: 'error', message: '本票货件对应不同渠道服务，尚未自动填入；请拆分范围或明确填写适用于整票的服务。' }] };
  return { service: [...services][0]!, issues: [] };
}

/** A deterministic plan only: no network calls, catalog writes, price inference or snapshots mutated. */
export function planAutomaticPreparation(data: DocumentRevisionData, profiles: readonly DocumentProfile[], templates: readonly DocumentTemplate[], overrideFields: DocumentRevisionData['fields'] = {}, serviceMappings: readonly ActiveServiceMapping[] = []): AutomaticPreparationPlan {
  const fields = withDocumentInvoiceDefaults(data.fields, data.members), references = structuredClone(data.profileReferences), issues: PreparationIssue[] = [];
  let templateReference = structuredClone(data.templateReference), confirmAddress = false;
  const add = (code: string, message: string, category?: DocumentProfile['category']) => issues.push({ code, message, severity: 'error', ...(category ? { profileCategory: category } : {}) });
  const fill = (key: string, value: unknown) => {
    if (retiredHeaders.has(key) || blank(value)) return;
    if (blank(fields[key])) fields[key] = text(value);
  };
  for (const [key, value] of Object.entries(overrideFields)) {
    // Address confirmation is evidence owned by this operation or a prior human action.
    if (key.startsWith('addressConfirm') || key === 'addressAdoptionVersion' || key === 'addressSelectionMode' || key === 'addressSourceLabel') continue;
    if (key === 'currency' && documentTicketCurrency(data.members)) continue;
    fill(key, value);
  }
  const automaticCurrency = documentTicketCurrency(data.members);
  if (automaticCurrency) fields.currency = automaticCurrency;
  for (const key of DOCUMENT_BLANK_OUTPUT_FIELDS) fields[key] = null;
  const mappedService = planDocumentServiceMapping({ members: data.members, fields }, serviceMappings);
  if (mappedService.service) fields.service = mappedService.service;
  issues.push(...mappedService.issues);
  const automaticHeaders = new Map<string, Map<string, string[]>>();
  const currentReference = (reference: DocumentRevisionData['profileReferences'][number]) => {
    const profile = profiles.find((entry) => entry.id === reference.profileId && entry.category === reference.category);
    if (!profile || profile.status !== 'active' || profile.version !== reference.version || documentDigest(profile.data) !== documentDigest(reference.data)) {
      const unchanged = resolveUnchangedProductProfile(reference, profiles);
      if (unchanged) { Object.assign(reference, referenceOf(unchanged)); return unchanged; }
      add('DOCUMENT_PROFILE_STALE', `已采用的${categoryNames[reference.category]}资料版本已变化或不可用，请明确采用当前版本后重试。`, reference.category); return undefined;
    }
    return profile;
  };
  const validReferences = new Map<string, DocumentProfile>();
  for (const reference of references) if (documentUsesProfileReference(data, reference)) {
    const profile = currentReference(reference); if (profile) validReferences.set(reference.profileId, profile);
  }
  const applies = (profile: DocumentProfile) => {
    const values = profile.data;
    return data.members.every((member) => {
      const scope = member.demand.snapshot;
      if (!blank(values.sid) && text(values.sid) !== String(scope.sid)) return false;
      if (!blank(values.countryCode) && country(values.countryCode) !== country(scope.country)) return false;
      if (!blank(values.country) && (profile.category === 'tax' ? text(values.country) !== scope.country : country(values.country) !== country(scope.country))) return false;
      if (!blank(values.currency) && text(values.currency).toUpperCase() !== fields.currency) return false;
      if (!blank(values.destinationFc ?? values.fc) && text(values.destinationFc ?? values.fc).toUpperCase() !== scope.destinationFc?.trim().toUpperCase()) return false;
      return profile.category !== 'channel' || text(values.businessChannel ?? values.channel) === scope.channel;
    });
  };
  for (const category of ['party', 'channel', 'tax'] as const) {
    const saved = references.filter((reference) => reference.category === category);
    let profile: DocumentProfile | undefined, newlySelected = false;
    if (saved.length > 1) { add('DOCUMENT_PROFILE_AMBIGUOUS', `${categoryNames[category]}资料已有多个引用，请人工选择。`, category); continue; }
    if (saved[0]) {
      profile = validReferences.get(saved[0].profileId);
      if (!profile) continue;
      if (!applies(profile)) { add('DOCUMENT_PROFILE_SCOPE_MISMATCH', `已采用的${categoryNames[category]}资料不适用于本票范围。`, category); continue; }
    } else {
      const matches = profiles.filter((entry) => {
        if (entry.category !== category || entry.status !== 'active' || !applies(entry)) return false;
        if (category === 'party') return !blank(entry.data.sid);
        if (category === 'tax') return !blank(entry.data.sid) || !blank(entry.data.country) || !blank(entry.data.countryCode);
        const services = (Array.isArray(entry.data.allowedServices) ? entry.data.allowedServices : [entry.data.service]).map(text).filter(Boolean);
        return !blank(entry.data.businessChannel ?? entry.data.channel) && (!services.length || !blank(fields.service) && services.includes(text(fields.service)));
      });
      if (matches.length > 1) { add('DOCUMENT_PROFILE_AMBIGUOUS', `${categoryNames[category]}匹配到多份适用资料，请人工选择。`, category); continue; }
      profile = matches[0];
      if (!profile) continue;
      newlySelected = true;
    }
    const proposed: Record<string, string> = {};
    for (const [key, value] of Object.entries(profile.data)) if (headerFields.has(key) && !addressFields.has(key) && !retiredHeaders.has(key) && key !== 'currency' && key !== 'service' && !blank(value)) proposed[key] = text(value);
    if (category === 'channel') {
      const services = [...new Set((Array.isArray(profile.data.allowedServices) ? profile.data.allowedServices : [profile.data.service]).map(text).filter(Boolean))];
      if (fields.service && services.length && !services.includes(fields.service)) { add('DOCUMENT_SERVICE_INVALID', '本票已有服务不在渠道资料维护范围内，已保留本票值。', category); continue; }
    }
    if (newlySelected) references.push(referenceOf(profile));
    for (const [key, value] of Object.entries(proposed)) {
      if (!blank(fields[key])) continue;
      const values = automaticHeaders.get(key) ?? new Map<string, string[]>();
      values.set(value, [...values.get(value) ?? [], `${categoryNames[category]}资料 ${profile.key}`]); automaticHeaders.set(key, values);
    }
  }
  for (const [key, values] of automaticHeaders) {
    if (values.size === 1) fill(key, [...values.keys()][0]);
    else add('DOCUMENT_AUTOMATION_FIELD_CONFLICT', `自动采用资料对空白的${fieldNames[key] ?? '单票资料'}提供了不同值，尚未填入；请在本票明确填写后重试。`);
  }
  const identities = new Map<string, { sid: number; msku: string; fnsku: string; sku: string }>();
  for (const member of data.members) for (const item of member.shipment.data.items) {
    const identity = { sid: member.demand.snapshot.sid, msku: item.msku, fnsku: item.fnsku, sku: item.sku };
    if (documentUsesProfileReference(data, { category: 'product', profileId: 'candidate', version: 1, data: identity })) identities.set(JSON.stringify(identity), identity);
  }
  for (const identity of identities.values()) {
    const same = (value: Record<string, unknown>) => ['sid', 'msku', 'fnsku', 'sku'].every((key) => text(value[key]) === text(identity[key as keyof typeof identity]));
    const saved = references.filter((reference) => reference.category === 'product' && same(reference.data));
    let profile: DocumentProfile | undefined, newlySelected = false;
    if (saved.length > 1) { add('DOCUMENT_PROFILE_AMBIGUOUS', `商品 ${identity.sku} 有多个完整身份资料引用。`, 'product'); continue; }
    if (saved[0]) profile = validReferences.get(saved[0].profileId);
    else {
      const matches = profiles.filter((entry) => entry.category === 'product' && entry.status === 'active' && same(entry.data));
      if (matches.length > 1) { add('DOCUMENT_PROFILE_AMBIGUOUS', `商品 ${identity.sku} 有多份相同完整身份资料，请人工选择。`, 'product'); continue; }
      profile = matches[0]; newlySelected = Boolean(profile);
    }
    if (!profile) continue;
    // A pinned product profile supplies defaults; explicit per-ticket declarations
    // remain authoritative, including legitimate material/brand/image overrides.
    if (newlySelected) references.push(referenceOf(profile));
  }
  const manualAddress = fields.addressSelectionMode === 'manual';
  const confirmed = fields.addressSelectionMode !== 'profile' && fields.addressConfirmed === 'true' && !blank(fields.addressConfirmationReason) && hasCompleteDocumentAddress(fields);
  if (manualAddress) {
    if (!confirmed) add('DOCUMENT_ADDRESS_UNCONFIRMED', '本票采用人工地址，请人工核对并确认；自动出单不会覆盖或代为确认。', 'address');
  } else {
    const address = resolveDocumentLingxingAddress(data.members);
    const sourceAddresses = data.members.flatMap((member) => member.sourceCandidates?.addresses.map((entry) => entry.data) ?? []);
    if (address) {
      for (let index = references.length - 1; index >= 0; index--) if (references[index]!.category === 'address') references.splice(index, 1);
      Object.assign(fields, applyDocumentAddress(fields, address), { addressSelectionMode: 'lingxing', addressSourceLabel: '领星货件地址', addressConfirmed: 'true', addressConfirmationReason: '自动出单核对：所有货件均有完整且无冲突的领星来源地址，按领星货件地址出单。' });
      confirmAddress = true;
    } else if (!confirmed) add(hasDocumentAddressConflict(sourceAddresses) ? 'DOCUMENT_ADDRESS_CONFLICT' : 'DOCUMENT_ADDRESS_UNCONFIRMED', '领星货件地址缺失、不完整或有冲突，请在领星维护后刷新，或人工确认本票地址。', 'address');
  }
  if (templateReference) {
    const current = templates.find((entry) => entry.id === templateReference!.templateId && entry.purpose === data.purpose);
    if (!current || current.status !== 'active' || current.version !== templateReference.version || current.fileId !== templateReference.fileId || current.sha256 !== templateReference.sha256) add('DOCUMENT_TEMPLATE_STALE', '已采用的模板版本已变化或不可用，请明确选择当前版本。');
  } else {
    const matches = templates.filter((entry) => entry.purpose === data.purpose && entry.status === 'active');
    if (matches.length > 1) add('DOCUMENT_TEMPLATE_AMBIGUOUS', '有多个有效发票模板，请人工选择。');
    else if (matches[0]) { const { id, version, sha256, fileId } = matches[0]; templateReference = { templateId: id, version, sha256, fileId }; }
  }
  return { fields: withDocumentInvoiceDefaults(fields, data.members), profileReferences: references, templateReference, confirmAddress, issues };
}

/** Catalog locks and the existing revision gates share one audited transaction. */
export async function prepareDocumentAutomation(id: string, actorId: string, raw: PreparationInput) {
  const input = documentRevisionInputSchema.pick({ operationId: true, expectedVersion: true, reason: true, fields: true }).parse(raw);
  const { and, eq } = await import('drizzle-orm');
  const { documentProfiles, documentTemplates, documentTemplateVersions } = await import('./schema.js');
  const { documentOperation, lockedDocument, reviseDocumentInTx, serializeProfile } = await import('./service.js');
  const { getActiveServiceMappingsInTx } = await import('../service-mappings/repository.js');
  return documentOperation(actorId, input.operationId, 'document.automation.prepare', { id, ...input }, async (tx) => {
    const { revision } = await lockedDocument(tx, id, actorId, input.expectedVersion);
    const profileRows = await tx.select().from(documentProfiles).for('share');
    const templateRows = await tx.select({ template: documentTemplates, version: documentTemplateVersions }).from(documentTemplates)
      .innerJoin(documentTemplateVersions, and(eq(documentTemplateVersions.templateId, documentTemplates.id), eq(documentTemplateVersions.version, documentTemplates.version)))
      .where(eq(documentTemplates.purpose, revision.data.purpose)).for('share');
    const templates: DocumentTemplate[] = templateRows.map(({ template, version }) => ({ id: template.id, purpose: template.purpose as DocumentTemplate['purpose'], name: template.name,
      version: template.version, status: template.status as DocumentTemplate['status'], fileId: version.fileId, sha256: version.sha256, mimeType: version.mimeType, createdBy: template.createdBy, createdAt: template.createdAt.toISOString() }));
    const serviceMappings = blank(revision.data.fields.service) && blank(input.fields?.service) ? await getActiveServiceMappingsInTx(tx) : [];
    const plan = planAutomaticPreparation(revision.data, profileRows.map(serializeProfile), templates, input.fields, serviceMappings);
    const result = await reviseDocumentInTx(tx, id, actorId, { ...input, fields: plan.fields, profileReferences: plan.profileReferences, templateReference: plan.templateReference, confirmAddress: plan.confirmAddress });
    return { ...result, issues: plan.issues };
  });
}
