import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentAutomationJobSchema, documentAutomationRetryInputSchema, documentAutomationStartInputSchema, type DocumentProfile, type DocumentRevisionData, type DocumentTemplate } from '@scm/contracts';
import { planAutomaticPreparation as planWithServiceMappings, planDocumentServiceMapping, prepareDocumentAutomation } from './automatic-preparation.js';
import type { ActiveServiceMapping } from '../service-mappings/repository.js';
import { validateDocumentData } from './domain.js';
import { documentProductOverrideKey, validateWorkbookData } from './workbook.js';

const service = vi.hoisted(() => ({ documentOperation: vi.fn(), lockedDocument: vi.fn(), reviseDocumentInTx: vi.fn(), serializeProfile: vi.fn() }));
const mappingRepository = vi.hoisted(() => ({ active: vi.fn() }));
vi.mock('./service.js', () => service);
vi.mock('../service-mappings/repository.js', () => ({ getActiveServiceMappingsInTx: mappingRepository.active }));

const now = '2026-10-25T00:00:00.000Z';
const mapping = (overrides: Partial<ActiveServiceMapping> = {}): ActiveServiceMapping => ({ id: randomUUID(), version: 1, countryCode: 'US', transportMethod: 'HY', service: 'EXPRESS', ...overrides });
const planAutomaticPreparation = (data: DocumentRevisionData, profiles: readonly DocumentProfile[], templates: readonly DocumentTemplate[], fields: DocumentRevisionData['fields'] = {}, mappings: readonly ActiveServiceMapping[] = [mapping()]) => planWithServiceMappings(data, profiles, templates, fields, mappings);
beforeEach(() => { mappingRepository.active.mockReset(); mappingRepository.active.mockResolvedValue([mapping()]); });
const address = { addressCode: 'ONT8', destinationFc: 'ONT8', countryCode: 'US', recipientName: 'Receiver', addressLine1: '1 Test Road', city: 'City', postalCode: '12345' };
function profile(category: DocumentProfile['category'], data: Record<string, unknown>): DocumentProfile {
  return { id: randomUUID(), category, key: `${category}资料`, version: 1, status: 'active', data, createdBy: 'admin', createdAt: now };
}
const reference = (value: DocumentProfile) => ({ category: value.category, profileId: value.id, version: value.version, data: structuredClone(value.data) });
function template(): DocumentTemplate { return { id: randomUUID(), purpose: 'invoice', name: '发票模板', version: 1, status: 'active', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: 'a'.repeat(64), fileId: randomUUID(), createdBy: 'admin', createdAt: now }; }
function fixture(mixed = false): DocumentRevisionData {
  const demandId = randomUUID(), shipmentId = randomUUID(), groupId = randomUUID(), m2 = randomUUID(), boxId = randomUUID();
  const first = { msku: 'M1', fnsku: 'F1', sku: 'S1', name: '测试商品', quantity: mixed ? '6' : '10' };
  const items = mixed ? [first, { msku: 'Z2', fnsku: 'F2', sku: 'S2', name: '混装商品', quantity: '4' }] : [first];
  return { purpose: 'invoice', weekStartDate: '2026-10-19', title: '自动发票', generationRulesVersion: 'v2', fields: {}, profileReferences: [], templateReference: null,
    members: [{ source: { weekStartDate: '2026-10-19', groupId, groupVersion: 1, m2ConfirmationId: m2, demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null },
      demand: { id: demandId, version: 1, businessDate: '2026-10-19', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', snapshot: { sid: 101, fba: 'FBAAUTOMATIC', shop: '测试店铺', country: 'US', channel: 'HY', destinationFc: 'ONT8', referenceQuantity: null, notes: null, subBatchName: null }, createdAt: now, updatedAt: now },
      shipment: { id: shipmentId, demandId, version: 1, demandVersion: 1, source: 'manual', snapshotIds: [], reason: 'fixture', createdBy: 'admin', createdAt: now,
        data: { sid: 101, fba: 'FBAAUTOMATIC', items, boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: null, name: null, order: 1, items }], observedAt: now, issues: [] } },
      codes: [{ id: randomUUID(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: now }], physical: null,
      boxSource: [{ demandId, shipmentRevisionId: shipmentId, boxId, sid: 101, fba: 'FBAAUTOMATIC', code: 'A1', order: 1, po: 'PO-KEPT', range: '', raw: { weight: '1', length: '2', width: '3', height: '4', weightUnit: 'KG', dimensionUnit: 'CM' }, values: { weight: '1.00', length: '2.00', width: '3.00', height: '4.00' }, items, sourceObservedAt: now }],
      sourceCandidates: { addresses: [{ source: 'getShipmentDetails', snapshotId: randomUUID(), data: address }], products: [], issues: [] } }],
    productSourceFacts: [{ sid: 101, msku: 'M1', fnsku: 'F1', sku: 'S1', salesPrice: '9.99', currency: 'USD', unitPrice: '2.00', cartonQuantity: '5', sourceFileId: randomUUID(), sourceSha256: 'b'.repeat(64), fetchedAt: now }],
  };
}
function catalog() {
  return [profile('party', { sid: 101, customsMode: '9810' }), profile('channel', { businessChannel: 'HY', sid: 101, countryCode: 'US', allowedServices: ['EXPRESS'], clearanceMode: '一般贸易清关' }),
    profile('tax', { sid: 101, countryCode: 'US', currency: 'USD', taxMode: '包税', vat: 'EXPLICIT-VAT' }), profile('address', address),
    profile('product', { sid: 101, msku: 'M1', fnsku: 'F1', sku: 'S1', englishName: 'Test product', chineseName: '测试商品', material: 'glass', hsCode: '123456', use: 'test', brand: 'Brand', model: 'Model', salesLink: 'https://example.com/item' })];
}
const errors = (plan: ReturnType<typeof planAutomaticPreparation>) => plan.issues.filter((issue) => issue.severity === 'error');

describe('invoice country and transport method service mappings', () => {
  it('matches a configured BR country while leaving unknown ZZ unresolved', () => {
    const data = fixture(); data.members[0]!.demand.snapshot.country = 'BR';
    expect(planDocumentServiceMapping(data, [mapping({ countryCode: 'BR' })])).toEqual({ service: 'EXPRESS', issues: [] });
    data.members[0]!.demand.snapshot.country = 'ZZ';
    expect(planDocumentServiceMapping(data, [mapping({ countryCode: 'ZZ' })])).toMatchObject({ issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_MISSING' }] });
  });
  it.each([['HY', '海运'], ['KP', '空派'], ['KH', '卡航']])('matches the confirmed legacy method %s to %s without modifying shipment snapshots', (code, name) => {
    const data = fixture(); data.members[0]!.demand.snapshot.channel = ` ${code.toLowerCase()} `;
    const original = structuredClone(data);
    expect(planDocumentServiceMapping(data, [mapping({ transportMethod: name })])).toEqual({ service: 'EXPRESS', issues: [] });
    expect(data).toEqual(original);
    data.members[0]!.demand.snapshot.channel = name;
    expect(planDocumentServiceMapping(data, [mapping({ transportMethod: code })])).toEqual({ service: 'EXPRESS', issues: [] });
  });
  it('does not broaden 海运 into 海派 and rejects ambiguous code/name mapping duplicates', () => {
    const data = fixture(); data.members[0]!.demand.snapshot.channel = 'HY';
    expect(planDocumentServiceMapping(data, [mapping({ transportMethod: '海派' })])).toMatchObject({ issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_MISSING' }] });
    expect(planDocumentServiceMapping(data, [mapping({ transportMethod: 'HY' }), mapping({ transportMethod: '海运' })])).toMatchObject({ issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_AMBIGUOUS' }] });
  });
  it('normalizes member country aliases and trims the method without guessing transport aliases', () => {
    const data = fixture(), mappings = [mapping({ transportMethod: '海派', service: '手写服务' })];
    data.members[0]!.demand.snapshot.country = '美国'; data.members[0]!.demand.snapshot.channel = ' 海派 ';
    const before = structuredClone({ data, mappings });
    expect(planDocumentServiceMapping(data, mappings)).toEqual({ service: '手写服务', issues: [] });
    expect({ data, mappings }).toEqual(before);
    data.members[0]!.demand.snapshot.channel = 'SEA';
    expect(planDocumentServiceMapping(data, mappings).issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_SERVICE_MAPPING_MISSING' }));
  });
  it.each(['no mapping', 'wrong country', 'wrong method', 'missing method', 'unknown country'])('leaves %s unresolved instead of falling back to generic channel services', (kind) => {
    const data = fixture(), mappings = kind === 'no mapping' ? [] : [mapping()];
    if (kind === 'wrong country') mappings[0]!.countryCode = 'GB';
    if (kind === 'wrong method') mappings[0]!.transportMethod = 'OTHER';
    if (kind === 'missing method') data.members[0]!.demand.snapshot.channel = '';
    if (kind === 'unknown country') data.members[0]!.demand.snapshot.country = '未知国家';
    const plan = planAutomaticPreparation(data, catalog(), [template()], {}, mappings);
    expect(plan.fields.service).toBeUndefined();
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_SERVICE_MAPPING_MISSING' }));
  });
  it('requires every member to have a unique mapping and the whole ticket to share one service', () => {
    const data = fixture(), second = structuredClone(data.members[0]!);
    second.demand.snapshot.country = '英国'; second.demand.snapshot.channel = '空派'; data.members.push(second);
    const mappings = [mapping(), mapping({ countryCode: 'GB', transportMethod: '空派' })];
    expect(planDocumentServiceMapping(data, mappings)).toEqual({ service: 'EXPRESS', issues: [] });
    expect(planDocumentServiceMapping(data, mappings.slice(0, 1))).toMatchObject({ issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_MISSING' }] });
    mappings[1]!.service = '英国服务';
    expect(planDocumentServiceMapping(data, mappings)).toMatchObject({ issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_CONFLICT' }] });
    expect(planDocumentServiceMapping(fixture(), [mapping(), mapping()])).toMatchObject({ issues: [{ code: 'DOCUMENT_SERVICE_MAPPING_AMBIGUOUS' }] });
  });
  it('preserves explicit ticket or operation fields even when the mapping differs or is absent', () => {
    const data = fixture(); data.fields.service = '本票服务';
    expect(planAutomaticPreparation(data, [], [], { service: '其它服务' }, []).fields.service).toBe('本票服务');
    expect(planAutomaticPreparation(data, [], [], {}, []).issues.some((issue) => issue.code.startsWith('DOCUMENT_SERVICE_MAPPING'))).toBe(false);
    delete data.fields.service;
    expect(planAutomaticPreparation(data, [], [], { service: '本次手填服务' }).fields.service).toBe('本次手填服务');
    expect(planAutomaticPreparation(data, [], [], { service: '本次手填服务' }, []).issues.some((issue) => issue.code.startsWith('DOCUMENT_SERVICE_MAPPING'))).toBe(false);
  });
  it('skips incompatible generic channel defaults while enforcing explicitly referenced service limits', () => {
    const data = fixture(), profiles = catalog(), channel = profiles.find((entry) => entry.category === 'channel')!;
    const mappings = [mapping({ service: '手写映射服务' })];
    let plan = planAutomaticPreparation(data, profiles, [template()], {}, mappings);
    expect(plan.fields.service).toBe('手写映射服务');
    expect(plan.profileReferences.some((entry) => entry.category === 'channel')).toBe(false);
    expect(plan.issues.some((issue) => issue.code === 'DOCUMENT_SERVICE_INVALID')).toBe(false);
    data.profileReferences = [reference(channel)];
    plan = planAutomaticPreparation(data, profiles, [template()], {}, mappings);
    expect(plan.fields.service).toBe('手写映射服务');
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_SERVICE_INVALID', profileCategory: 'channel' }));
    data.fields.service = 'EXPRESS';
    expect(planAutomaticPreparation(data, profiles, [template()], {}, mappings).fields.service).toBe('EXPRESS');
  });
  it('adopts a changed mapping only for a deliberately blank service and retains saved historical values', () => {
    const data = fixture(), first = mapping({ service: '原服务' });
    const initial = planAutomaticPreparation(data, [], [], {}, [first]);
    const saved = { ...data, fields: initial.fields }, previous = structuredClone(saved);
    const current = { ...first, version: 2, service: '新服务' };
    expect(planAutomaticPreparation(saved, [], [], {}, [current]).fields.service).toBe('原服务');
    expect(saved).toEqual(previous);
    saved.fields = { ...saved.fields, service: '' };
    expect(planAutomaticPreparation(saved, [], [], {}, [current]).fields.service).toBe('新服务');
  });
});

describe('automatic invoice preparation', () => {
  it('fixes flags to no despite explicit drafts, submitted overrides or conflicting profile defaults', () => {
    for (const explicit of [false, true]) {
      const data = fixture(), profiles = catalog(), templates = [template()];
      const flags = { battery: '是', magnetic: '是', liquid: '是', powder: '是', dangerous: '是' };
      if (explicit) Object.assign(data.fields, flags);
      Object.assign(profiles.find((entry) => entry.category === 'channel')!.data, flags);
      Object.assign(profiles.find((entry) => entry.category === 'party')!.data, { battery: '否', magnetic: '否', liquid: '否', powder: '否', dangerous: '否' });
      const original = structuredClone({ data, profiles, templates });
      const plan = planAutomaticPreparation(data, profiles, templates, explicit ? flags : {});
      expect(errors(plan)).toEqual([]);
      expect(plan.fields).toMatchObject({ battery: '否', magnetic: '否', liquid: '否', powder: '否', dangerous: '否' });
      expect({ data, profiles, templates }).toEqual(original);
    }
  });
  it('adopts scoped versions and confirms complete Lingxing shipment addresses without local address profiles', () => {
    const data = fixture(true), profiles = catalog(), templates = [template()];
    data.fields.orderNumber = 'OLD'; data.fields.currency = 'EUR';
    const original = structuredClone({ data, profiles, templates });
    const plan = planAutomaticPreparation(data, profiles, templates);
    expect(errors(plan)).toEqual([]); expect(plan.profileReferences).toHaveLength(4); expect(plan.templateReference?.templateId).toBe(templates[0]!.id);
    expect(plan.fields).toMatchObject({ orderNumber: null, reference: null, tradeTerms: null, currency: 'USD', service: 'EXPRESS', customsMode: '9810', taxMode: '包税', vat: 'EXPLICIT-VAT', addressConfirmed: 'true' });
    expect(plan.confirmAddress).toBe(true); expect(plan.fields.addressSelectionMode).toBe('lingxing'); expect(plan.profileReferences.some((entry) => entry.category === 'address')).toBe(false);
    const prepared = { ...data, fields: plan.fields, profileReferences: plan.profileReferences, templateReference: plan.templateReference };
    expect(validateDocumentData(prepared)).toEqual([]);
    const validation = validateWorkbookData(prepared);
    expect(validation.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validation.map((issue) => issue.code)).toEqual(expect.arrayContaining(['DOCUMENT_MIXED_CARTON', 'PRODUCT_IMAGE_MISSING', 'DOCUMENT_CARTON_QUANTITY_DIFFERENCE']));
    expect({ data, profiles, templates }).toEqual(original);
  });
  it.each(['party', 'channel', 'tax', 'product'] as const)('does not pick the first of multiple applicable %s records', (category) => {
    const profiles = catalog(), duplicate = structuredClone(profiles.find((entry) => entry.category === category)!); duplicate.id = randomUUID(); duplicate.key += '另一个'; profiles.push(duplicate);
    const plan = planAutomaticPreparation(fixture(), profiles, [template()]);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PROFILE_AMBIGUOUS', profileCategory: category }));
    expect(plan.profileReferences.some((entry) => entry.category === category)).toBe(false);
  });
  it('honors an explicitly pinned current profile even when other applicable profiles exist', () => {
    const data = fixture(), profiles = catalog(), channel = profiles.find((entry) => entry.category === 'channel')!;
    data.profileReferences = [reference(channel)]; profiles.push({ ...structuredClone(channel), id: randomUUID(), key: '另一个渠道' });
    expect(errors(planAutomaticPreparation(data, profiles, [template()]))).toEqual([]);
  });
  it('retains manual ticket fields and product overrides and can resume after an automatic source conflict is resolved', () => {
    const data = fixture(), profiles = catalog(), templates = [template()], prefix = `product.${documentProductOverrideKey(101, { msku: 'M1', fnsku: 'F1', sku: 'S1' })}.`;
    const tax = profiles.find((entry) => entry.category === 'tax')!; tax.data.customsMode = '普通报关';
    const blocked = planAutomaticPreparation(data, profiles, templates);
    expect(blocked.fields.customsMode).toBeUndefined();
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_AUTOMATION_FIELD_CONFLICT', message: expect.stringContaining('报关方式') }));
    const manuallySaved = { ...data, fields: { ...blocked.fields, customsMode: '9810', [prefix + 'material']: '本票材质', [prefix + 'brand']: '本票品牌' }, profileReferences: blocked.profileReferences, templateReference: blocked.templateReference };
    const resumed = planAutomaticPreparation(manuallySaved, profiles, templates, { customsMode: '普通报关', remarks: '全局默认备注' });
    expect(errors(resumed)).toEqual([]); expect(resumed.fields).toMatchObject({ customsMode: '9810', [prefix + 'material']: '本票材质', [prefix + 'brand']: '本票品牌', remarks: '全局默认备注' });
  });
  it('respects an existing allowed service override but blocks a service outside the scoped channel rules', () => {
    const data = fixture(), profiles = catalog(), channel = profiles.find((entry) => entry.category === 'channel')!;
    channel.data.allowedServices = ['EXPRESS', 'ECONOMY']; channel.data.service = 'EXPRESS'; data.fields.service = 'ECONOMY';
    data.profileReferences = [reference(channel)];
    expect(planAutomaticPreparation(data, profiles, [template()]).fields.service).toBe('ECONOMY');
    expect(errors(planAutomaticPreparation(data, profiles, [template()]))).toEqual([]);
    data.fields.service = 'UNLISTED'; expect(planAutomaticPreparation(data, profiles, [template()]).issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_SERVICE_INVALID' }));
    delete data.fields.service; delete channel.data.service;
    const unresolved = planAutomaticPreparation(data, profiles, [template()], {}, []);
    expect(unresolved.fields.service).toBeUndefined();
    expect(unresolved.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_SERVICE_MAPPING_MISSING' }));
  });
  it('does not infer tax or VAT from unbound profiles, country or parties', () => {
    const profiles = [profile('party', { recipientCompany: 'Unbound party', taxMode: '包税', vat: 'NOT-BOUND' }), profile('tax', { taxMode: '自主税号', vat: 'NOT-BOUND' })];
    const plan = planAutomaticPreparation(fixture(), profiles, [template()]);
    expect(plan.fields.taxMode).toBeUndefined(); expect(plan.fields.vat).toBeUndefined(); expect(plan.profileReferences).toEqual([]);
  });
  it('requires scope to match every member and uses complete product identity rather than SKU alone', () => {
    const data = fixture(), extra = structuredClone(data.members[0]!); extra.demand.snapshot.sid = 202; data.members.push(extra);
    const profiles = catalog(); expect(planAutomaticPreparation(data, profiles, []).profileReferences.some((entry) => ['party', 'channel', 'tax'].includes(entry.category))).toBe(false);
    const product = profiles.find((entry) => entry.category === 'product')!; product.data.fnsku = 'OTHER';
    expect(planAutomaticPreparation(fixture(), profiles, []).profileReferences.some((entry) => entry.category === 'product')).toBe(false);
  });
  it.each(['manual-empty', 'manual-complete', 'confirmed'] as const)('preserves %s human address choices without auto-confirming them', (mode) => {
    const data = fixture(); data.fields = { addressSelectionMode: 'manual', ...(mode === 'manual-empty' ? {} : address), ...(mode === 'confirmed' ? { addressConfirmed: 'true', addressConfirmationReason: '人工核对依据' } : {}) };
    const original = structuredClone(data.fields), plan = planAutomaticPreparation(data, catalog(), [template()]);
    expect(plan.confirmAddress).toBe(false); expect(plan.fields.addressSelectionMode).toBe('manual');
    for (const [key, value] of Object.entries(original)) expect(plan.fields[key]).toBe(key === 'recipientName' && original.addressCode ? original.addressCode : value);
    expect(data.fields).toEqual(original);
    expect(plan.profileReferences.some((entry) => entry.category === 'address')).toBe(false);
    expect(plan.issues.some((issue) => issue.code === 'DOCUMENT_ADDRESS_UNCONFIRMED')).toBe(mode !== 'confirmed');
  });
  it('blocks conflicting Lingxing sources and ignores duplicate local address profiles', () => {
    const data = fixture(), profiles = catalog(), addressProfile = profiles.find((entry) => entry.category === 'address')!;
    data.members[0]!.sourceCandidates!.addresses = [address, { ...address, addressLine1: '2 Other Road' }].map((entry) => ({ source: 'fixture', snapshotId: randomUUID(), data: entry }));
    const conflicting = planAutomaticPreparation(data, profiles, [template()]); expect(conflicting.confirmAddress).toBe(false);
    expect(conflicting.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_CONFLICT' }));
    profiles.push({ ...structuredClone(addressProfile), id: randomUUID() });
    expect(planAutomaticPreparation(fixture(), profiles, [template()]).confirmAddress).toBe(true);
  });
  it('does not confirm bare fields or untrusted candidates without Lingxing evidence', () => {
    const data = fixture(); Object.assign(data.fields, address); data.members[0]!.sourceCandidates!.addresses = [{ source: 'fixture', snapshotId: randomUUID(), data: address }];
    const plan = planAutomaticPreparation(data, [], [template()]); expect(plan.confirmAddress).toBe(false); expect(plan.fields.addressConfirmed).not.toBe('true');
  });
  it('migrates historical address references without requiring a local profile version', () => {
    const data = fixture(); data.profileReferences = [reference(profile('address', { ...address, addressLine1: 'Old Local Road' }))];
    data.fields = { ...address, addressLine1: 'Old Local Road', addressSelectionMode: 'profile', addressConfirmed: 'true', addressConfirmationReason: 'Old directory' };
    const plan = planAutomaticPreparation(data, [], [template()]);
    expect(plan.issues).toEqual([]); expect(plan.fields.addressLine1).toBe(address.addressLine1); expect(plan.fields.addressSelectionMode).toBe('lingxing'); expect(plan.profileReferences).toEqual([]);
    data.members[0]!.sourceCandidates!.addresses = [];
    expect(planAutomaticPreparation(data, [], [template()]).issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_UNCONFIRMED' }));
  });
  it('blocks stale pinned profile and template versions without adopting new values', () => {
    const data = fixture(), profiles = catalog(), chosen = profiles.find((entry) => entry.category === 'channel')!, oldTemplate = template();
    data.profileReferences = [reference(chosen)]; data.templateReference = { templateId: oldTemplate.id, version: 1, sha256: oldTemplate.sha256, fileId: oldTemplate.fileId };
    chosen.version = 2; chosen.data.service = 'NEW'; const currentTemplate = { ...oldTemplate, version: 2, fileId: randomUUID() };
    const plan = planAutomaticPreparation(data, profiles, [currentTemplate]);
    expect(plan.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['DOCUMENT_PROFILE_STALE', 'DOCUMENT_TEMPLATE_STALE']));
    expect(plan.profileReferences.find((entry) => entry.profileId === chosen.id)?.version).toBe(1); expect(plan.fields.service).toBe('EXPRESS'); expect(plan.templateReference?.version).toBe(1);
  });
  it('does not gate a merged FBA on the stale profile of a product outside its global representative', () => {
    const data = fixture(true), member = data.members[0]!, [representative, hidden] = member.shipment.data.items;
    const first = member.boxSource![0]!, second = { ...structuredClone(first), boxId: randomUUID(), order: 2, code: 'A2', items: [{ ...representative! }] };
    first.items = [{ ...hidden! }]; member.boxSource!.push(second);
    member.shipment.data.boxes[0]!.items = [{ ...hidden! }];
    member.shipment.data.boxes.push({ ...structuredClone(member.shipment.data.boxes[0]!), id: second.boxId, order: 2, items: [{ ...representative! }] });
    member.codes.push({ ...member.codes[0]!, id: randomUUID(), boxId: second.boxId, code: 'A2', sequence: 2 });
    const stale = reference(profile('product', { sid: 101, ...hidden! })); data.profileReferences = [stale];
    const profiles = catalog(), templates = [template()], original = structuredClone(data);
    const plan = planAutomaticPreparation(data, profiles, templates);
    expect(errors(plan)).toEqual([]);
    expect(plan.profileReferences).toContainEqual(stale);
    expect(plan.profileReferences.some((entry) => entry.category === 'product' && entry.data.sku === representative!.sku)).toBe(true);
    expect(data).toEqual(original);
    second.values.weight = '2.00';
    expect(planAutomaticPreparation(data, profiles, templates).issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PROFILE_STALE', profileCategory: 'product' }));
  });
  it('does not choose the first of several active templates', () => {
    const plan = planAutomaticPreparation(fixture(), catalog(), [template(), template()]); expect(plan.templateReference).toBeNull();
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_TEMPLATE_AMBIGUOUS' }));
  });
});

describe('automatic preparation revision boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  function transaction(profiles: DocumentProfile[], templates: DocumentTemplate[]) {
    const rows = [profiles, templates.map((entry) => ({ template: { ...entry, createdAt: new Date(entry.createdAt) }, version: entry }))];
    const locks: string[] = [];
    const tx = { select: vi.fn(() => {
      const result = { from: () => result, innerJoin: () => result, where: () => result, for: (mode: string) => { locks.push(mode); return Promise.resolve(rows.shift() ?? []); } };
      return result;
    }) };
    service.documentOperation.mockImplementation(async (_actor, _operation, _action, _input, execute) => ({ ...await execute(tx), replayed: false }));
    service.serializeProfile.mockImplementation((entry) => entry);
    return { tx, locks };
  }
  it('plans under shared catalog locks and saves through the existing versioned revision gate in the same transaction', async () => {
    const data = fixture(), profiles = catalog(), templates = [template()], id = randomUUID(), input = { operationId: randomUUID(), expectedVersion: 3, reason: '自动准备资料' };
    const { tx, locks } = transaction(profiles, templates);
    service.lockedDocument.mockResolvedValue({ record: { version: 3 }, revision: { data } });
    service.reviseDocumentInTx.mockResolvedValue({ documentId: id, document: { id, version: 4 } });
    const result = await prepareDocumentAutomation(id, 'admin', input);
    expect(locks).toEqual(['share', 'share']);
    expect(service.lockedDocument).toHaveBeenCalledWith(tx, id, 'admin', 3);
    expect(mappingRepository.active).toHaveBeenCalledWith(tx);
    expect(service.reviseDocumentInTx).toHaveBeenCalledWith(tx, id, 'admin', expect.objectContaining({ expectedVersion: 3, operationId: input.operationId, confirmAddress: true, fields: expect.objectContaining({ addressConfirmed: 'true', currency: 'USD' }) }));
    expect(result).toMatchObject({ documentId: id, document: { version: 4 }, replayed: false, issues: [] });
  });
  it('does not plan or save after the saved document version has changed', async () => {
    const { tx } = transaction(catalog(), [template()]);
    service.lockedDocument.mockRejectedValue(new Error('VERSION_CONFLICT'));
    await expect(prepareDocumentAutomation(randomUUID(), 'admin', { operationId: randomUUID(), expectedVersion: 2, reason: '自动准备资料' })).rejects.toThrow('VERSION_CONFLICT');
    expect(tx.select).not.toHaveBeenCalled(); expect(service.reviseDocumentInTx).not.toHaveBeenCalled();
    expect(mappingRepository.active).not.toHaveBeenCalled();
  });
  it('returns ambiguity issues beside the saved safe partial revision for durable blocking', async () => {
    const data = fixture(), profiles = catalog(), channel = profiles.find((entry) => entry.category === 'channel')!; profiles.push({ ...structuredClone(channel), id: randomUUID() });
    transaction(profiles, [template()]); service.lockedDocument.mockResolvedValue({ record: { version: 1 }, revision: { data } });
    service.reviseDocumentInTx.mockResolvedValue({ documentId: randomUUID(), document: { version: 2 } });
    const result = await prepareDocumentAutomation(randomUUID(), 'admin', { operationId: randomUUID(), expectedVersion: 1, reason: '自动准备资料' });
    expect(result.document.version).toBe(2); expect(result.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PROFILE_AMBIGUOUS', profileCategory: 'channel' }));
  });
});

describe('document automation contracts', () => {
  it('validates new-run and existing-draft starts with explicit, non-duplicate scopes', () => {
    const base = { operationId: randomUUID(), shippingRunId: randomUUID() }, documentId = randomUUID(), demandId = randomUUID();
    expect(documentAutomationStartInputSchema.safeParse(base).success).toBe(true);
    expect(documentAutomationStartInputSchema.safeParse({ ...base, documentId, expectedVersion: 2 }).success).toBe(true);
    for (const invalid of [{ documentId }, { expectedVersion: 2 }, { documentId, expectedVersion: 2, demandIds: [demandId] }, { demandIds: [demandId, demandId] }, { demandIds: [] }]) expect(documentAutomationStartInputSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    expect(documentAutomationRetryInputSchema.safeParse({ operationId: base.operationId, expectedVersion: 1, itemIds: [documentId, documentId] }).success).toBe(false);
  });
  it('retains nullable durable results, warnings and retry attempt state', () => {
    const job = { id: randomUUID(), shippingRunId: randomUUID(), version: 1, status: 'blocked', items: [{ id: randomUUID(), demandIds: [randomUUID()], fbas: ['FBA1'], documentId: null, documentVersion: null, exportId: null, fileId: null, stage: 'prepare', status: 'blocked', issues: [{ code: 'PRODUCT_IMAGE_MISSING', severity: 'warning', message: '缺图提醒' }], error: { code: 'NEEDS_INPUT', message: '需补齐' }, attempt: 1 }], counts: { total: 1, queued: 0, running: 0, exporting: 0, completed: 0, blocked: 1 }, createdAt: now, updatedAt: now, completedAt: null, error: null };
    expect(documentAutomationJobSchema.parse(job)).toMatchObject({ ...job, mode: 'legacy', phase: 'preparing', bundle: null, supplement: null, counts: { ...job.counts, ready: 0 } });
    expect(documentAutomationJobSchema.safeParse({ ...job, items: [{ ...job.items[0], attempt: 0 }] }).success).toBe(false);
  });
});
