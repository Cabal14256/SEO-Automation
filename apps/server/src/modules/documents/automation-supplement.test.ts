import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentAutomationJobSchema, documentAutomationSupplementInputSchema, documentAutomationSupplementSchema, type Document, type DocumentProfile, type DocumentRevisionData, type DocumentTemplate } from '@scm/contracts';
import { applyDocumentAutomationSupplementInTx, buildDocumentAutomationRequirements, getDocumentAutomationRequirementsInTx, planDocumentAutomationSupplement, type DocumentAutomationSupplementTicket } from './automation-supplement.js';
import { documentProductOverrideKey } from './workbook.js';

const service = vi.hoisted(() => ({ lockedDocument: vi.fn(), reviseDocumentInTx: vi.fn(), serializeDocument: vi.fn(), serializeProfile: vi.fn(), DocumentError: class extends Error { constructor(public code: string, public status: number, message: string) { super(message); } } }));
vi.mock('./service.js', () => service);
const now = '2026-10-25T00:00:00.000Z', runId = randomUUID();
const address = { addressCode: 'ONT8', destinationFc: 'ONT8', countryCode: 'US', recipientName: 'Receiver', addressLine1: '1 Test Road', city: 'City', postalCode: '12345' };
const product = { msku: 'M1', fnsku: 'F1', sku: 'S1', quantity: '10', name: '商品' };
function profile(category: DocumentProfile['category'], data: Record<string, unknown>): DocumentProfile { return { id: randomUUID(), category, key: `${category}资料`, version: 1, status: 'active', data, createdBy: 'admin', createdAt: now }; }
function template(): DocumentTemplate { return { id: randomUUID(), purpose: 'invoice', name: '模板', version: 1, status: 'active', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: 'a'.repeat(64), fileId: randomUUID(), createdBy: 'admin', createdAt: now }; }
function ticket(): DocumentAutomationSupplementTicket {
  const demandId = randomUUID(), shipmentId = randomUUID(), groupId = randomUUID(), boxId = randomUUID(), documentId = randomUUID();
  const data: DocumentRevisionData = { purpose: 'invoice', shippingRunId: runId, weekStartDate: '2026-10-19', title: '自动出单', generationRulesVersion: 'v2',
    fields: { ...address, currency: 'USD', customsMode: '9810', taxMode: '包税', service: 'EXPRESS', addressConfirmed: 'true', addressConfirmationReason: '已人工核对', addressSelectionMode: 'manual' }, profileReferences: [], templateReference: null,
    members: [{ source: { shippingRunId: runId, weekStartDate: '2026-10-19', groupId, groupVersion: 1, m2ConfirmationId: randomUUID(), demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null },
      demand: { id: demandId, version: 1, businessDate: '2026-10-19', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', snapshot: { sid: 101, fba: `FBA${demandId.slice(0, 6)}`, shop: '测试店铺', country: 'US', channel: 'HY', destinationFc: 'ONT8', referenceQuantity: null, notes: null, subBatchName: null }, createdAt: now, updatedAt: now },
      shipment: { id: shipmentId, demandId, version: 1, demandVersion: 1, source: 'manual', snapshotIds: [], reason: 'fixture', createdBy: 'admin', createdAt: now, data: { sid: 101, fba: `FBA${demandId.slice(0, 6)}`, items: [{ ...product }], boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: null, name: null, order: 1, items: [{ ...product }] }], observedAt: now, issues: [] } },
      codes: [{ id: randomUUID(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: now }], physical: null,
      boxSource: [{ demandId, shipmentRevisionId: shipmentId, boxId, sid: 101, fba: `FBA${demandId.slice(0, 6)}`, code: 'A1', order: 1, po: 'PO', range: '', raw: { weight: '1', length: '2', width: '3', height: '4', weightUnit: 'KG', dimensionUnit: 'CM' }, values: { weight: '1.00', length: '2.00', width: '3.00', height: '4.00' }, items: [{ ...product }], sourceObservedAt: now }], sourceCandidates: { addresses: [], products: [], issues: [] } }],
    productSourceFacts: [{ sid: 101, msku: product.msku, fnsku: product.fnsku, sku: product.sku, salesPrice: '10', currency: 'USD', unitPrice: '2.00', cartonQuantity: '10', sourceFileId: randomUUID(), sourceSha256: 'b'.repeat(64), fetchedAt: now }],
  };
  const document: Document = { id: documentId, purpose: 'invoice', status: 'draft', version: 2, currentRevision: { id: randomUUID(), documentId, version: 2, reason: 'fixture', data, createdBy: 'admin', createdAt: now }, createdBy: 'admin', createdAt: now, updatedAt: now };
  return { item: { id: randomUUID(), documentId, documentVersion: 2, status: 'blocked', issues: [] }, document };
}
const fields = (value: DocumentAutomationSupplementTicket) => value.document.currentRevision.data.fields;
const data = (value: DocumentAutomationSupplementTicket) => value.document.currentRevision.data;
function input(tickets: DocumentAutomationSupplementTicket[], values: { id: string; value: string | boolean | null }[]) { return { operationId: randomUUID(), expectedVersion: 3, documentVersions: Object.fromEntries(tickets.map(({ document }) => [document.id, document.version])), values }; }
const descriptors = (tickets: DocumentAutomationSupplementTicket[], profiles: DocumentProfile[] = [], templates: DocumentTemplate[] = []) => buildDocumentAutomationRequirements(tickets, profiles, templates).descriptors;
function field(tickets: DocumentAutomationSupplementTicket[], key: string, profiles: DocumentProfile[] = [], templates: DocumentTemplate[] = []) { return descriptors(tickets, profiles, templates).find((entry) => entry.targets.some((target) => target.fieldKey === key))!; }
function missingSellingPrice(value: DocumentAutomationSupplementTicket, salesPrice: string | null = null) { const fact = data(value).productSourceFacts![0]!; fact.salesPrice = salesPrice; fact.unitPrice = null; }
const sellingPriceFields = (tickets: DocumentAutomationSupplementTicket[]) => descriptors(tickets).filter((entry) => entry.targets[0]!.fieldKey.startsWith('@sellingPrice.'));

describe('central automatic document requirements', () => {
  it('requires a pending B3 code together with explicit human address confirmation', () => {
    const value = ticket(); Object.assign(fields(value), { addressCode: '', addressCodeStatus: 'needs_review', addressCodeReason: 'Special warehouse needs verification', addressConfirmed: 'false' });
    expect(field([value], 'addressCode').required).toBe(true);
    const values = [{ id: field([value], 'addressConfirmationReason').id, value: 'Carrier reference version and row checked' }, { id: field([value], 'addressConfirmed').id, value: true }];
    expect(() => planDocumentAutomationSupplement([value], [], [], input([value], values))).toThrow('B3');
    const plan = planDocumentAutomationSupplement([value], [], [], input([value], [...values, { id: field([value], 'addressCode').id, value: 'VERIFIED-CODE' }]));
    expect(plan[0]!.fields).toMatchObject({ addressCode: 'VERIFIED-CODE', addressSelectionMode: 'manual', addressConfirmed: 'true' });
  });
  it('merges missing common fields only for the same member scope and current value', () => {
    const first = ticket(), second = ticket(), otherShop = ticket(); fields(first).customsMode = ''; fields(second).customsMode = ''; fields(otherShop).customsMode = ''; data(otherShop).members[0]!.demand.snapshot.sid = 999;
    const result = descriptors([first, second, otherShop]).filter((entry) => entry.targets[0]!.fieldKey === 'customsMode');
    expect(result).toHaveLength(2); expect(result.find((entry) => entry.targets.length === 2)?.targets.map((target) => target.documentId)).toEqual(expect.arrayContaining([first.document.id, second.document.id]));
    const revisions = planDocumentAutomationSupplement([first, second, otherShop], [], [], input([first, second, otherShop], [{ id: result.find((entry) => entry.targets.length === 2)!.id, value: '9710' }]));
    expect(revisions.map((revision) => revision.documentId)).toEqual(expect.arrayContaining([first.document.id, second.document.id])); expect(revisions).toHaveLength(2); expect(revisions.every((revision) => revision.fields.customsMode === '9710')).toBe(true); expect(fields(first).customsMode).toBe('');
  });
  it('shares declarations by the complete product identity and keeps every box independent', () => {
    const first = ticket(), second = ticket(), other = ticket(); data(other).members[0]!.shipment.data.items[0]!.fnsku = 'OTHER'; data(other).members[0]!.boxSource![0]!.items[0]!.fnsku = 'OTHER';
    for (const value of [first, second, other]) data(value).members[0]!.boxSource![0]!.values.weight = null;
    const result = descriptors([first, second, other]); const materials = result.filter((entry) => entry.targets[0]!.fieldKey.endsWith('.material')), weights = result.filter((entry) => entry.targets[0]!.fieldKey.endsWith('.weight'));
    expect(materials).toHaveLength(2); expect(materials.map((entry) => entry.targets.length).sort()).toEqual([1, 2]); expect(weights).toHaveLength(3); expect(weights.every((entry) => entry.targets.length === 1 && entry.scope === 'box')).toBe(true);
  });
  it('requests product supplements only for the global representative while inspecting every actual box', () => {
    const value = ticket(), member = data(value).members[0]!, hidden = { ...product, msku: 'Z', fnsku: 'Z', sku: 'Z' };
    const first = member.boxSource![0]!, second = { ...structuredClone(first), boxId: randomUUID(), order: 2, code: 'A2' };
    first.items = [{ ...hidden }]; member.boxSource!.push(second);
    member.shipment.data.boxes[0]!.items = [{ ...hidden }];
    member.shipment.data.boxes.push({ ...structuredClone(member.shipment.data.boxes[0]!), id: second.boxId, order: 2, items: [{ ...product }] });
    member.shipment.data.items.push(hidden);
    member.codes.push({ ...member.codes[0]!, id: randomUUID(), boxId: second.boxId, code: 'A2', sequence: 2 });
    missingSellingPrice(value);
    const key = documentProductOverrideKey(101, product), hiddenKey = documentProductOverrideKey(101, hidden);
    const hiddenProfiles = [profile('product', { sid: 101, ...hidden }), profile('product', { sid: 101, ...hidden })];
    const before = structuredClone(value), result = descriptors([value], hiddenProfiles);
    const productFields = result.filter((entry) => entry.scope === 'product');
    expect(productFields.length).toBeGreaterThan(0);
    expect(productFields.every((entry) => entry.targets.every((target) => target.fieldKey.endsWith(key) || target.fieldKey.startsWith(`product.${key}.`)))).toBe(true);
    expect(result.some((entry) => entry.targets.some((target) => target.fieldKey.includes(hiddenKey)))).toBe(false);
    expect(value).toEqual(before);
    second.values.weight = null;
    const expanded = descriptors([value], hiddenProfiles);
    expect(expanded.some((entry) => entry.targets.some((target) => target.fieldKey === `box.${second.boxId}.weight`))).toBe(true);
    expect(expanded.some((entry) => entry.targets.some((target) => target.fieldKey === `@profile.product.${hiddenKey}`))).toBe(true);
  });
  it('binds stable field identifiers to every current target version and candidate set', () => {
    const value = ticket(); fields(value).taxMode = ''; const first = field([value], 'taxMode'); expect(field([value], 'taxMode').id).toBe(first.id);
    value.document.version++; expect(field([value], 'taxMode').id).not.toBe(first.id);
    expect(() => planDocumentAutomationSupplement([value], [], [], input([value], [{ id: first.id, value: '包税' }]))).toThrow('补充字段或适用范围已变化');
  });
  it('keeps a genuinely confirmed manual address when the public address book has several matches', () => {
    const value = ticket(), profiles = [profile('address', address), profile('address', { ...address, city: 'Different City' })];
    expect(descriptors([value], profiles).some((entry) => entry.targets.some((target) => target.fieldKey === '@profile.address' || target.fieldKey === 'addressConfirmed'))).toBe(false);
  });
  it('offers current scoped profile and template versions rather than silently choosing ambiguous records', () => {
    const value = ticket(), channels = [profile('channel', { businessChannel: 'HY', allowedServices: ['A'] }), profile('channel', { businessChannel: 'HY', allowedServices: ['B'] })], templates = [template(), template()];
    const requirements = buildDocumentAutomationRequirements([value], channels, templates); expect(documentAutomationSupplementSchema.safeParse(requirements).success).toBe(true);
    const channel = field([value], '@profile.channel', channels, templates), templateField = field([value], '@template', channels, templates);
    expect(channel.options).toHaveLength(2); expect(templateField.options).toHaveLength(2);
    fields(value).service = '';
    const result = planDocumentAutomationSupplement([value], channels, templates, input([value], [{ id: field([value], '@profile.channel', channels, templates).id, value: `${channels[1]!.id}:1` }, { id: templateField.id, value: `${templates[1]!.id}:1` }]));
    expect(result[0]!.profileReferences.map((entry) => entry.profileId)).toContain(channels[1]!.id); expect(result[0]!.fields.service).toBe('B'); expect(result[0]!.templateReference?.templateId).toBe(templates[1]!.id);
  });
  it('keeps fixed pricing independent of Listing currency without fabricating source inputs', () => {
    const value = ticket(); data(value).productSourceFacts![0]!.currency = 'EUR'; fields(value).currency = 'EUR'; value.item.issues = [{ code: 'DOCUMENT_SOURCE_STALE', severity: 'error', message: '来源已变化' }];
    const result = buildDocumentAutomationRequirements([value], [], []); expect(result.descriptors.some((entry) => entry.targets.some((target) => /unitPrice|currency|quantity|SourceFact|^source/.test(target.fieldKey)))).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'CURRENCY_CONFLICT')).toBe(false); expect(result.issues.some((issue) => issue.code === 'DOCUMENT_SOURCE_STALE')).toBe(true); expect(result.issues.find((issue) => issue.code === 'PRODUCT_IMAGE_MISSING')?.severity).toBe('warning');
  });
  it('offers a manual currency only when the country cannot supply one', () => {
    const value = ticket(); data(value).members[0]!.demand.snapshot.country = 'XX'; fields(value).currency = '';
    expect(field([value], 'currency').options?.map((option) => option.value)).toEqual(['EUR', 'GBP', 'USD']);
  });
  it('keeps already saved per-ticket values and profiles immutable while accepting a partial save', () => {
    const value = ticket(), key = `product.${documentProductOverrideKey(101, product)}.material`; fields(value).customsMode = ''; fields(value)[key] = '票内材质'; const before = structuredClone(value);
    const result = planDocumentAutomationSupplement([value], [], [], input([value], [{ id: field([value], 'customsMode').id, value: '' }]));
    expect(result[0]!.fields.customsMode).toBe(''); expect(result[0]!.fields[key]).toBe('票内材质'); expect(value).toEqual(before); expect(result[0]!.confirmAddress).toBe(false);
  });
  it('requires a real complete address, fresh reason and explicit confirmation together', () => {
    const value = ticket(); fields(value).recipientName = ''; fields(value).addressConfirmed = 'false'; fields(value).addressConfirmationReason = '';
    const result = planDocumentAutomationSupplement([value], [], [], input([value], [{ id: field([value], 'recipientName').id, value: '核对后的收件人' }, { id: field([value], 'addressConfirmationReason').id, value: '已与本批收件资料核对' }, { id: field([value], 'addressConfirmed').id, value: true }]));
    expect(result[0]).toMatchObject({ confirmAddress: true, fields: { recipientName: '核对后的收件人', addressConfirmationReason: '已与本批收件资料核对', addressConfirmed: 'true', addressSelectionMode: 'manual' } });
    expect(() => planDocumentAutomationSupplement([value], [], [], input([value], [{ id: field([value], 'addressConfirmed').id, value: true }]))).toThrow('确认地址时须同次填写采用原因');
  });
  it('does not carry an old confirmation onto a partially changed address', () => {
    const value = ticket(); fields(value).city = ''; fields(value).addressConfirmed = 'false';
    const result = planDocumentAutomationSupplement([value], [], [], input([value], [{ id: field([value], 'city').id, value: 'New City' }]));
    expect(result[0]!.fields).toMatchObject({ city: 'New City', addressConfirmed: 'false', addressConfirmationReason: '' }); expect(result[0]!.confirmAddress).toBe(false);
  });
  it('offers ticket address confirmation without any local address profile choice', () => {
    const value = ticket(); fields(value).addressConfirmed = 'false'; fields(value).addressConfirmationReason = '';
    const profiles = [profile('address', address), profile('address', { ...address, recipientName: 'Other Receiver' })];
    expect(descriptors([value], profiles).some((entry) => entry.targets.some((target) => target.fieldKey === '@profile.address'))).toBe(false);
    const result = planDocumentAutomationSupplement([value], profiles, [], input([value], [{ id: field([value], 'addressConfirmationReason', profiles).id, value: '已核对领星货件地址' }, { id: field([value], 'addressConfirmed', profiles).id, value: true }]));
    expect(result[0]!.fields.recipientName).toBe('Receiver'); expect(result[0]!.confirmAddress).toBe(true); expect(result[0]!.profileReferences).toEqual([]);
  });
  it('rejects forged descriptors, types, choices and invalid numbers before any target can be saved', () => {
    const value = ticket(); fields(value).taxMode = ''; data(value).members[0]!.boxSource![0]!.values.weight = null; const tax = field([value], 'taxMode'), weight = descriptors([value]).find((entry) => entry.targets[0]!.fieldKey.endsWith('.weight'))!;
    for (const entry of [{ id: 'product.fact.unitPrice', value: '1' }, { id: tax.id, value: '自行推断' }, { id: tax.id, value: true }, { id: weight.id, value: '-1' }]) expect(() => planDocumentAutomationSupplement([value], [], [], input([value], [entry]))).toThrow();
    const result = planDocumentAutomationSupplement([value], [], [], input([value], [{ id: weight.id, value: '2.345' }])); expect(result[0]!.fields[weight.targets[0]!.fieldKey]).toBe('2.35');
  });
  it('requires versions for every ticket, including one with no submitted field', () => {
    const first = ticket(), second = ticket(); fields(first).taxMode = ''; const request = input([first, second], [{ id: field([first, second], 'taxMode').id, value: '包税' }]); second.document.version++;
    expect(() => planDocumentAutomationSupplement([first, second], [], [], request)).toThrow('整批单据版本已变化');
    delete request.documentVersions[second.document.id]; expect(() => planDocumentAutomationSupplement([first, second], [], [], request)).toThrow('整批单据版本已变化');
  });
});

describe('central supplement transaction boundary', () => {
  const tx = { select: vi.fn() };
  function state(tickets: DocumentAutomationSupplementTicket[], profiles: DocumentProfile[] = [], templates: DocumentTemplate[] = []) {
    service.lockedDocument.mockImplementation(async (_tx, id, _actor, expected) => { const value = tickets.find((entry) => entry.document.id === id)!; if (expected !== undefined && expected !== value.document.version) throw new service.DocumentError('VERSION_CONFLICT', 409, '单据版本已变化'); return { record: { document: value.document }, revision: value.document.currentRevision }; });
    service.serializeDocument.mockImplementation((record) => record.document); service.serializeProfile.mockImplementation((value) => value);
    let query = 0; tx.select.mockImplementation(() => { const result = query++ % 2 === 0 ? profiles : templates.map((value) => ({ template: { ...value, createdAt: new Date(value.createdAt) }, version: value })); const chain = { from: () => chain, innerJoin: () => chain, for: async () => result }; return chain; });
    service.reviseDocumentInTx.mockImplementation(async (_tx, id, _actor, revision) => ({ document: { ...tickets.find((entry) => entry.document.id === id)!.document, version: revision.expectedVersion + 1 } }));
  }
  beforeEach(() => { vi.clearAllMocks(); });
  it('returns current saved versions even for a ticket without an editable requirement', async () => {
    const value = ticket(); value.item.documentVersion = 1; state([value]);
    const result = await getDocumentAutomationRequirementsInTx(tx as never, 'admin', { shippingRunId: runId, items: [value.item] }); expect(result.documentVersions).toEqual({ [value.document.id]: 2 }); expect(service.lockedDocument).toHaveBeenCalledWith(tx, value.document.id, 'admin', undefined);
  });
  it('locks and validates all documents before revision writes and reuses the caller transaction', async () => {
    const first = ticket(), second = ticket(); fields(first).taxMode = ''; fields(second).taxMode = ''; state([first, second]);
    const request = input([first, second], [{ id: field([first, second], 'taxMode').id, value: '包税' }]);
    const result = await applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [first.item, second.item] }, request);
    expect(result.documents).toHaveLength(2); expect(service.lockedDocument).toHaveBeenCalledTimes(2); expect(service.reviseDocumentInTx).toHaveBeenCalledTimes(2); expect(service.lockedDocument.mock.invocationCallOrder.every((order) => order < service.reviseDocumentInTx.mock.invocationCallOrder[0]!)).toBe(true); expect(service.reviseDocumentInTx.mock.calls.every(([target]) => target === tx)).toBe(true);
  });
  it('makes no revision writes after any current-version or submitted-value conflict', async () => {
    const first = ticket(), second = ticket(); fields(first).taxMode = ''; state([first, second]); const request = input([first, second], [{ id: field([first, second], 'taxMode').id, value: '包税' }]); request.documentVersions[second.document.id] = 1;
    await expect(applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [first.item, second.item] }, request)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }); expect(service.reviseDocumentInTx).not.toHaveBeenCalled();
    request.documentVersions[second.document.id] = 2; request.values[0]!.value = '无效选项';
    await expect(applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [first.item, second.item] }, request)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 }); expect(service.reviseDocumentInTx).not.toHaveBeenCalled();
  });
  it('propagates a later revision failure through the same transaction so the caller can roll back the whole batch', async () => {
    const first = ticket(), second = ticket(); fields(first).taxMode = ''; fields(second).taxMode = ''; state([first, second]);
    service.reviseDocumentInTx.mockResolvedValueOnce({ document: { ...first.document, version: 3 } }).mockRejectedValueOnce(new service.DocumentError('DOCUMENT_PROFILE_UNAVAILABLE', 422, '资料版本已变化'));
    await expect(applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [first.item, second.item] }, input([first, second], [{ id: field([first, second], 'taxMode').id, value: '包税' }]))).rejects.toMatchObject({ code: 'DOCUMENT_PROFILE_UNAVAILABLE' });
    expect(service.reviseDocumentInTx).toHaveBeenCalledTimes(2); expect(service.reviseDocumentInTx.mock.calls.every(([target]) => target === tx)).toBe(true);
  });
  it('cannot write a submitted document outside the actual job scope', async () => {
    const first = ticket(), other = ticket(); fields(first).taxMode = ''; state([first]); const request = input([first, other], [{ id: field([first], 'taxMode').id, value: '包税' }]);
    await expect(applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [first.item] }, request)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }); expect(service.reviseDocumentInTx).not.toHaveBeenCalled();
  });
  it('saves missing declaration material without requiring or writing a manual sales price', async () => {
    const value = ticket(); missingSellingPrice(value); state([value]);
    const material = field([value], `product.${documentProductOverrideKey(101, product)}.material`);
    const request = input([value], [{ id: material.id, value: 'Glass' }]);
    await applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [value.item] }, request);
    const revision = service.reviseDocumentInTx.mock.calls[0]![3];
    expect(revision.fields[material.targets[0]!.fieldKey]).toBe('Glass');
    expect(revision).not.toHaveProperty('manualSalesPrices'); expect(revision).not.toHaveProperty('productSourceFacts');
    expect(Object.keys(revision.fields).some((key) => key.startsWith('@sellingPrice'))).toBe(false);
  });
  it('rejects removed selling-price virtual fields before writing an otherwise valid batch', async () => {
    const first = ticket(), second = ticket(); missingSellingPrice(first); fields(second).customsMode = ''; state([first, second]);
    const request = input([first, second], [{ id: field([first, second], 'customsMode').id, value: '9810' }, { id: `@sellingPrice.USD.${documentProductOverrideKey(101, product)}`, value: '19.99' }]);
    await expect(applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [first.item, second.item] }, request)).rejects.toMatchObject({ code: 'DOCUMENT_SUPPLEMENT_STALE', status: 409 }); expect(service.reviseDocumentInTx).not.toHaveBeenCalled();
  });
});

describe('fixed invoice pricing in the unified missing form', () => {
  it.each([null, '', '0', '-1', 'abc', '1e3', '0.001'])('does not request a selling price or reason when Listing price is %s', (salesPrice) => {
    const value = ticket(); missingSellingPrice(value, salesPrice); const before = structuredClone(value);
    const result = buildDocumentAutomationRequirements([value], [], []);
    expect(result.descriptors.some((entry) => entry.targets.some((target) => /^@sellingPrice|unitPrice|\.currency$/.test(target.fieldKey)))).toBe(false);
    expect(result.issues.some((issue) => /SALES_PRICE|MANUAL_SALES|CURRENCY_CONFLICT/.test(issue.code))).toBe(false);
    expect(value).toEqual(before);
  });
  it('keeps complete invoice requirements ready without any archived sales price', () => {
    const value = ticket(), currentTemplate = template(), current = data(value);
    const key = `product.${documentProductOverrideKey(101, product)}.`;
    for (const [name, entry] of Object.entries({ englishName: 'Glass cover', chineseName: '玻璃保护片', material: 'Glass', hsCode: '700719', use: 'Screen protection', brand: 'TEST', model: 'T1', salesLink: 'https://example.invalid/product' })) fields(value)[key + name] = entry;
    current.templateReference = { templateId: currentTemplate.id, version: currentTemplate.version, sha256: currentTemplate.sha256, fileId: currentTemplate.fileId };
    current.productSourceFacts = [];
    const result = buildDocumentAutomationRequirements([value], [], [currentTemplate]);
    expect(result.descriptors).toEqual([]);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.issues.some((issue) => issue.code === 'PRODUCT_IMAGE_MISSING' && issue.severity === 'warning')).toBe(true);
  });
  it('ignores mismatched Listing currency while keeping invoice currency derived from its country', () => {
    const value = ticket(); data(value).productSourceFacts![0]!.currency = 'EUR';
    const result = buildDocumentAutomationRequirements([value], [], []);
    expect(sellingPriceFields([value])).toHaveLength(0);
    expect(result.issues.some((issue) => issue.code === 'CURRENCY_CONFLICT')).toBe(false);
    expect(fields(value).currency).toBe('USD');
  });
  it('does not revive manual-price inputs or stale-record errors from historical audit data', () => {
    const value = ticket(); missingSellingPrice(value); const fact = data(value).productSourceFacts![0]!;
    data(value).manualSalesPrices = [{ sid: 101, msku: 'M1', fnsku: 'F1', sku: 'S1', salesPrice: '12.34', currency: 'GBP', reason: '旧价', recordedBy: 'admin', recordedAt: now, sourceFileId: fact.sourceFileId, sourceSha256: fact.sourceSha256, memberSources: [] }];
    const before = structuredClone(value), result = buildDocumentAutomationRequirements([value], [], []);
    expect(result.descriptors.some((entry) => entry.targets.some((target) => target.fieldKey.startsWith('@sellingPrice')))).toBe(false);
    expect(result.issues.some((issue) => issue.code.startsWith('DOCUMENT_MANUAL_SALES_PRICE'))).toBe(false);
    expect(value).toEqual(before);
  });
  it('does not create price inputs for missing or ambiguous source facts or an unknown country', () => {
    const value = ticket(); missingSellingPrice(value); data(value).productSourceFacts!.push(structuredClone(data(value).productSourceFacts![0]!)); expect(sellingPriceFields([value])).toHaveLength(0);
    data(value).productSourceFacts = []; expect(sellingPriceFields([value])).toHaveLength(0);
    const unknown = ticket(); missingSellingPrice(unknown); data(unknown).members[0]!.demand.snapshot.country = 'UNKNOWN'; expect(sellingPriceFields([unknown])).toHaveLength(0);
  });
  it('rejects former price and reason descriptor identifiers rather than treating them as ordinary fields', () => {
    const value = ticket(); missingSellingPrice(value); const before = structuredClone(value), key = documentProductOverrideKey(101, product);
    for (const id of [`@sellingPrice.USD.${key}`, `@sellingPriceReason.USD.${key}`, 'field-removed-selling-price']) {
      expect(() => planDocumentAutomationSupplement([value], [], [], input([value], [{ id, value: '19.99' }]))).toThrow('补充字段或适用范围已变化');
    }
    expect(value).toEqual(before);
  });
});
describe('central supplement contracts', () => {
  it('accepts partial scalar edits while rejecting duplicate identifiers and forged targets', () => {
    const request = input([ticket()], [{ id: 'field-test', value: '' }]); expect(documentAutomationSupplementInputSchema.safeParse(request).success).toBe(true);
    expect(documentAutomationSupplementInputSchema.safeParse({ ...request, values: [request.values[0], request.values[0]] }).success).toBe(false);
    expect(documentAutomationSupplementInputSchema.safeParse({ ...request, values: [{ ...request.values[0], targets: [] }] }).success).toBe(false);
  });
  it('parses ready barrier and bundle metadata without requiring an early ticket export', () => {
    const item = { id: randomUUID(), demandIds: [randomUUID()], fbas: ['FBA1'], documentId: randomUUID(), documentVersion: 2, exportId: null, fileId: null, stage: 'ready', status: 'ready', issues: [], error: null, attempt: 1 };
    expect(documentAutomationJobSchema.parse({ id: randomUUID(), shippingRunId: runId, version: 1, mode: 'single_workbook', phase: 'ready', status: 'running', items: [item], counts: { total: 1, queued: 0, running: 0, ready: 1, exporting: 0, completed: 0, blocked: 0 }, bundle: { status: 'pending', fileId: null, fileName: null, sheetCount: null, completedAt: null, error: null }, supplement: null, createdAt: now, updatedAt: now, completedAt: null, error: null }).items[0]!.exportId).toBeNull();
  });
});
