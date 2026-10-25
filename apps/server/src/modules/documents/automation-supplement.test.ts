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
function sellingPriceInput(tickets: DocumentAutomationSupplementTicket[], value = '9.99', reason = '已核对商品实际售价') { const price = sellingPriceFields(tickets)[0]!, key = price.targets[0]!.fieldKey.replace('@sellingPrice.', '@sellingPriceReason.'); return input(tickets, [{ id: price.id, value }, { id: field(tickets, key).id, value: reason }]); }

describe('central automatic document requirements', () => {
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
  it('does not fabricate price, currency, quantity or source inputs and retains warning severity', () => {
    const value = ticket(); data(value).productSourceFacts![0]!.currency = 'EUR'; fields(value).currency = 'EUR'; value.item.issues = [{ code: 'DOCUMENT_SOURCE_STALE', severity: 'error', message: '来源已变化' }];
    const result = buildDocumentAutomationRequirements([value], [], []); expect(result.descriptors.some((entry) => entry.targets.some((target) => /unitPrice|currency|quantity|SourceFact|^source/.test(target.fieldKey)))).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'CURRENCY_CONFLICT')).toBe(true); expect(result.issues.some((issue) => issue.code === 'DOCUMENT_SOURCE_STALE')).toBe(true); expect(result.issues.find((issue) => issue.code === 'PRODUCT_IMAGE_MISSING')?.severity).toBe('warning');
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
  it('permits an explicit address book choice with a genuine final-address confirmation', () => {
    const value = ticket(); fields(value).addressConfirmed = 'false'; fields(value).addressConfirmationReason = ''; const profiles = [profile('address', address), profile('address', { ...address, recipientName: 'Other Receiver' })];
    const result = planDocumentAutomationSupplement([value], profiles, [], input([value], [{ id: field([value], '@profile.address', profiles).id, value: `${profiles[1]!.id}:1` }, { id: field([value], 'addressConfirmationReason', profiles).id, value: '已核对选定地址' }, { id: field([value], 'addressConfirmed', profiles).id, value: true }]));
    expect(result[0]!.fields.recipientName).toBe('Other Receiver'); expect(result[0]!.confirmAddress).toBe(true); expect(result[0]!.profileReferences[0]!.profileId).toBe(profiles[1]!.id);
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
  it('passes only explicit exact-identity manual selling-price commands through the authenticated revision gate', async () => {
    const value = ticket(); missingSellingPrice(value); state([value]);
    const request = sellingPriceInput([value], '12.345', '以实际商品销售记录为依据');
    await applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [value.item] }, request);
    expect(service.reviseDocumentInTx).toHaveBeenCalledWith(tx, value.document.id, 'admin', expect.objectContaining({ operationId: request.operationId, expectedVersion: 2, manualSalesPrices: [{ sid: 101, msku: 'M1', fnsku: 'F1', sku: 'S1', salesPrice: '12.345', reason: '以实际商品销售记录为依据' }] }));
    const revision = service.reviseDocumentInTx.mock.calls[0]![3]; expect(revision).not.toHaveProperty('productSourceFacts'); expect(revision.manualSalesPrices[0]).not.toHaveProperty('recordedBy'); expect(revision.manualSalesPrices[0]).not.toHaveProperty('currency'); expect(Object.keys(revision.fields).some((key) => key.startsWith('@sellingPrice'))).toBe(false);
  });
  it('performs no target writes when one selling-price pair is invalid in an otherwise valid batch', async () => {
    const first = ticket(), second = ticket(); missingSellingPrice(first); fields(second).customsMode = ''; state([first, second]);
    const request = sellingPriceInput([first, second], '0'); request.values.push({ id: field([first, second], 'customsMode').id, value: '9810' });
    await expect(applyDocumentAutomationSupplementInTx(tx as never, 'admin', { shippingRunId: runId, items: [first.item, second.item] }, request)).rejects.toMatchObject({ code: 'DOCUMENT_MANUAL_SALES_PRICE_INVALID', status: 422 }); expect(service.reviseDocumentInTx).not.toHaveBeenCalled();
  });
});

describe('manual selling-price fallback in the unified missing form', () => {
  it('exposes selling price and reason only for unavailable prices and never exposes a declaration-price or currency override', () => {
    const value = ticket(); expect(sellingPriceFields([value])).toHaveLength(0);
    missingSellingPrice(value);
    const price = sellingPriceFields([value])[0]!; expect(price).toMatchObject({ label: '售价（USD）', kind: 'number', value: '', scope: 'product', required: true }); expect(price.help).toContain('20%'); expect(price.help).toContain('不换汇');
    expect(field([value], price.targets[0]!.fieldKey.replace('@sellingPrice.', '@sellingPriceReason.'))).toMatchObject({ label: '手工售价原因', kind: 'text', required: true });
    expect(descriptors([value]).some((entry) => entry.targets.some((target) => /unitPrice|^currency$|\.currency$/.test(target.fieldKey)))).toBe(false);
  });
  it('keeps a valid remote price immutable even when its currency conflicts with the ticket', () => {
    const value = ticket(); data(value).productSourceFacts![0]!.currency = 'EUR'; expect(sellingPriceFields([value])).toHaveLength(0);
    expect(buildDocumentAutomationRequirements([value], [], []).issues.some((issue) => issue.code === 'CURRENCY_CONFLICT')).toBe(true);
  });
  it('omits a selling-price input after an audited manual fallback has already supplied the missing value', () => {
    const value = ticket(); missingSellingPrice(value); const fact = data(value).productSourceFacts![0]!;
    data(value).manualSalesPrices = [{ sid: 101, msku: 'M1', fnsku: 'F1', sku: 'S1', salesPrice: '12.34', currency: 'USD', reason: '已核对', recordedBy: 'admin', recordedAt: now, sourceFileId: fact.sourceFileId, sourceSha256: fact.sourceSha256, memberSources: data(value).members.map((member) => member.source) }];
    expect(sellingPriceFields([value])).toHaveLength(0);
  });
  it('requires unique archived facts and a known country currency rather than inventing a price source', () => {
    const value = ticket(); missingSellingPrice(value); data(value).productSourceFacts!.push(structuredClone(data(value).productSourceFacts![0]!)); expect(sellingPriceFields([value])).toHaveLength(0);
    data(value).productSourceFacts = []; expect(sellingPriceFields([value])).toHaveLength(0);
    const unknown = ticket(); missingSellingPrice(unknown); data(unknown).members[0]!.demand.snapshot.country = 'UNKNOWN'; expect(sellingPriceFields([unknown])).toHaveLength(0);
  });
  it('merges only equal complete identities and currencies and applies to exactly those targets', () => {
    const first = ticket(), second = ticket(), otherIdentity = ticket(), otherCurrency = ticket();
    for (const value of [first, second, otherIdentity, otherCurrency]) missingSellingPrice(value);
    for (const item of [data(otherIdentity).members[0]!.shipment.data.items[0]!, data(otherIdentity).members[0]!.boxSource![0]!.items[0]!, data(otherIdentity).productSourceFacts![0]!]) item.fnsku = 'OTHER-FNSKU';
    data(otherCurrency).members[0]!.demand.snapshot.country = 'GB'; fields(otherCurrency).currency = 'GBP'; data(otherCurrency).productSourceFacts![0]!.currency = 'GBP';
    const tickets = [first, second, otherIdentity, otherCurrency], prices = sellingPriceFields(tickets); expect(prices).toHaveLength(3);
    const shared = prices.find((entry) => entry.targets.length === 2)!; expect(shared.label).toBe('售价（USD）'); expect(prices.find((entry) => entry.label === '售价（GBP）')?.targets).toHaveLength(1);
    const reason = field(tickets, shared.targets[0]!.fieldKey.replace('@sellingPrice.', '@sellingPriceReason.'));
    const revisions = planDocumentAutomationSupplement(tickets, [], [], input(tickets, [{ id: shared.id, value: '19.995' }, { id: reason.id, value: '同一商品已核对售价' }]));
    expect(revisions).toHaveLength(2); expect(revisions.map((revision) => revision.documentId)).toEqual(expect.arrayContaining([first.document.id, second.document.id])); expect(revisions.every((revision) => revision.manualSalesPrices?.[0]?.salesPrice === '19.995')).toBe(true);
  });
  it.each(['0', '-1', 'abc', '1e3', 'Infinity', '0.001', '0.024'])('rejects an invalid or round-to-zero selling price: %s', (price) => {
    const value = ticket(); missingSellingPrice(value);
    expect(() => planDocumentAutomationSupplement([value], [], [], sellingPriceInput([value], price))).toThrow('20%');
  });
  it('retains full entered precision for core derivation and requires the reason in the same save', () => {
    const value = ticket(); missingSellingPrice(value); const before = structuredClone(value);
    const result = planDocumentAutomationSupplement([value], [], [], sellingPriceInput([value], ' 0.025 ', ' 实际销售记录 '));
    expect(result[0]!.manualSalesPrices).toEqual([{ sid: 101, msku: 'M1', fnsku: 'F1', sku: 'S1', salesPrice: '0.025', reason: '实际销售记录' }]); expect(value).toEqual(before);
    for (const [price, reason] of [['9.99', ''], ['', '已有依据'], ['9.99', '长'.repeat(1001)]]) expect(() => planDocumentAutomationSupplement([value], [], [], sellingPriceInput([value], price, reason))).toThrow('同次填写');
  });
  it('invalidates a formerly missing-price descriptor as soon as a valid remote price or new revision appears', () => {
    const value = ticket(); missingSellingPrice(value); const request = sellingPriceInput([value]); data(value).productSourceFacts![0]!.salesPrice = '20';
    expect(() => planDocumentAutomationSupplement([value], [], [], request)).toThrow('补充字段或适用范围已变化');
    missingSellingPrice(value); value.document.version++; expect(() => planDocumentAutomationSupplement([value], [], [], request)).toThrow('整批单据版本已变化');
  });
  it('changes both virtual field identities across currency revisions and rejects the former amount and reason descriptors', () => {
    const value = ticket(); missingSellingPrice(value); const original = sellingPriceInput([value], '19.99', '美元销售记录');
    const usdPrice = sellingPriceFields([value])[0]!, usdReason = field([value], usdPrice.targets[0]!.fieldKey.replace('@sellingPrice.', '@sellingPriceReason.'));
    data(value).members[0]!.demand.snapshot.country = 'GB'; fields(value).currency = 'GBP'; data(value).productSourceFacts![0]!.currency = 'GBP'; value.document.version++;
    const gbpPrice = sellingPriceFields([value])[0]!, gbpReason = field([value], gbpPrice.targets[0]!.fieldKey.replace('@sellingPrice.', '@sellingPriceReason.'));
    expect(usdPrice.targets[0]!.fieldKey).toMatch(/^@sellingPrice\.USD\./); expect(gbpPrice.targets[0]!.fieldKey).toMatch(/^@sellingPrice\.GBP\./);
    expect(usdPrice.targets[0]!.fieldKey).not.toBe(gbpPrice.targets[0]!.fieldKey); expect(usdReason.targets[0]!.fieldKey).not.toBe(gbpReason.targets[0]!.fieldKey);
    const restoredKeys = new Set([usdPrice, usdReason].flatMap((descriptor) => descriptor.targets.map((target) => `${target.documentId}:${target.fieldKey}`)));
    expect([gbpPrice, gbpReason].some((descriptor) => descriptor.targets.some((target) => restoredKeys.has(`${target.documentId}:${target.fieldKey}`)))).toBe(false);
    original.documentVersions[value.document.id] = value.document.version;
    expect(() => planDocumentAutomationSupplement([value], [], [], original)).toThrow('补充字段或适用范围已变化');
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
