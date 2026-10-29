import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { documentBoxFieldKey, documentCreateInputSchema, documentRevisionInputSchema, documentCorrectInputSchema, documentProductSourceFact, documentRepresentativeProduct, documentRevisionDataSchema, type DocumentMemberSnapshot, type DocumentRevisionData } from '@scm/contracts';
import { documentBoxFieldIssues, documentDependencyInvalidReason, documentDigest, documentExportRulesIssue, documentM2SourceReference, documentUsesProfileReference, reviseDocumentBoxFields, shipmentClaimKey, validateDocumentData } from './domain.js';

function fixture(): DocumentRevisionData {
  const at = '2026-10-19T02:00:00.000Z', demandId = randomUUID(), groupId = randomUUID(), shipmentId = randomUUID(), boxId = randomUUID(), m2ConfirmationId = randomUUID(), physicalId = randomUUID();
  const item = { msku: 'M', fnsku: 'F', sku: 'S', quantity: '2' }, values = { weight: '1.00', length: '2.00', width: '3.00', height: '4.00' };
  const source = { id: randomUUID(), groupId, m2ConfirmationId, origin: 'history' as const, fingerprint: 'source-fingerprint', boxes: [{ demandId, shipmentRevisionId: shipmentId, boxId, sid: 12, fba: 'FBA1', code: 'A1', order: 1, po: 'PO1', range: 'FBA1000001-1', raw: { ...values, weightUnit: 'KG', dimensionUnit: 'CM' }, values, items: [item], sourceObservedAt: at }], issues: [], identityValid: true, snapshotIds: [], createdBy: 'admin', createdAt: at };
  const member: DocumentMemberSnapshot = { source: { weekStartDate: '2026-10-19', groupId, groupVersion: 1, m2ConfirmationId, demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: physicalId, m3Version: 2, sourceFingerprint: source.fingerprint },
    demand: { id: demandId, snapshot: { sid: 12, fba: 'FBA1', shop: 'Store', channel: 'HY', country: 'US', destinationFc: 'ONT8', referenceQuantity: null, notes: null, subBatchName: null }, version: 1, businessDate: '2026-10-19', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', createdAt: at, updatedAt: at },
    shipment: { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: 12, fba: 'FBA1', items: [{ ...item, name: 'Product' }], boxes: [{ id: boxId, externalBoxId: 'B1', packageId: null, localBoxId: null, name: 'B1', order: 1, items: [item] }], observedAt: at, issues: [] }, source: 'lingxing', snapshotIds: [], reason: 'test', createdBy: 'admin', createdAt: at },
    codes: [{ id: randomUUID(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: at }],
    physical: { id: physicalId, groupId, m2ConfirmationId, m3Version: 2, sourceFingerprint: source.fingerprint, snapshot: { source, entries: [{ shipmentRevisionId: shipmentId, boxId, status: 'consistent', measured: {}, reason: '' }], ruleVersion: 'physical-review/v1' }, createdBy: 'admin', createdAt: at } };
  const address = { recipientName: 'Receiver', addressLine1: '10 Road', city: 'City', postalCode: '00123', countryCode: 'US' };
  return { purpose: 'invoice', weekStartDate: '2026-10-19', title: 'Invoice', fields: { service: 'Approved service', ...address, addressConfirmed: 'true', addressConfirmationReason: 'Verified fixture shipment address' }, members: [member], profileReferences: (['product', 'party', 'address', 'channel', 'tax'] as const).map((category) => ({ category, profileId: randomUUID(), version: 1, data: category === 'address' ? { destinationFc: 'ONT8', ...address } : category === 'channel' ? { businessChannel: 'HY', service: 'Approved service' } : {} })), templateReference: { templateId: randomUUID(), version: 1, fileId: randomUUID(), sha256: 'a'.repeat(64) } };
}
describe('document immutable snapshot validation', () => {
  it('pins new generation tasks to v2 without invalidating legacy snapshot validation', () => {
    const legacy = fixture();
    expect(validateDocumentData(legacy)).toEqual([]);
    expect(documentExportRulesIssue(legacy)?.code).toBe('DOCUMENT_GENERATION_UPGRADE_REQUIRED');
    const next = { ...legacy, generationRulesVersion: 'v2' as const };
    expect(documentExportRulesIssue(next)).toBeNull();
    expect(documentExportRulesIssue(next, {} as never)?.code).toBe('DOCUMENT_EXPORT_RULES_STALE');
    expect(documentExportRulesIssue(legacy, { generationRulesVersion: 'v2' })?.code).toBe('DOCUMENT_EXPORT_RULES_STALE');
    expect(documentExportRulesIssue(next, { generationRulesVersion: 'v2' })?.code).toBe('DOCUMENT_EXPORT_RULES_STALE');
    expect(documentExportRulesIssue(next, { generationRulesVersion: 'v2', pricingRule: 'fixed-2' })).toBeNull();
  });
  it('validates a saved exact address-code reference even when its legacy destination FC differs', () => {
    const data = fixture(), member = data.members[0]!;
    member.sourceCandidates = { addresses: [{ source: 'getShipmentDetails', snapshotId: randomUUID(), data: { addressCode: 'ADDR-42' } }], products: [], issues: [] };
    const reference = data.profileReferences.find((item) => item.category === 'address')!;
    reference.data = { ...reference.data, destinationFc: 'OTHER-FC', addressCode: 'ADDR-42' };
    data.fields = { ...data.fields, addressCode: 'ADDR-42', addressConfirmed: 'true', addressConfirmationReason: 'Checked current source code' };
    expect(validateDocumentData(data).filter((issue) => issue.code === 'DOCUMENT_PROFILE_SCOPE_MISMATCH')).toEqual([]);
    member.sourceCandidates.addresses.push({ source: 'listShipments', snapshotId: randomUUID(), data: { addressCode: 'CONFLICT' } });
    expect(validateDocumentData(data).some((issue) => issue.profileCategory === 'address')).toBe(false);
  });
  it('keeps an archived address reference valid through its matching legacy FC without requiring a current directory record', () => {
    const data = fixture(), reference = data.profileReferences.find((item) => item.category === 'address')!;
    reference.data = { ...reference.data, addressCode: 'PROFILE-ALIAS' };
    data.fields = { ...data.fields, addressCode: 'PROFILE-ALIAS', addressConfirmed: 'true', addressConfirmationReason: 'Retained archived address version' };
    expect(validateDocumentData(data).filter((issue) => issue.code === 'DOCUMENT_PROFILE_SCOPE_MISMATCH')).toEqual([]);
  });
  it('keeps the representative stable across source order and resolves only unique complete-identity facts', () => {
    const products = [{ msku: 'M2', fnsku: 'F', sku: 'S' }, { msku: 'M1', fnsku: 'F2', sku: 'S' }, { msku: 'M1', fnsku: 'F1', sku: 'S' }];
    expect(documentRepresentativeProduct(products)).toEqual(products[2]);
    expect(documentRepresentativeProduct([...products].reverse())).toEqual(products[2]);
    expect(documentRepresentativeProduct([])).toBeUndefined();
    const fact = { ...products[2]!, sid: 12, salesPrice: '19.99', unitPrice: '4.00', currency: 'USD', cartonQuantity: '500', sourceFileId: randomUUID(), sourceSha256: 'a'.repeat(64), fetchedAt: '2026-10-24T02:00:00.000Z' };
    expect(documentProductSourceFact({ productSourceFacts: [fact] }, 12, products[2]!)).toEqual(fact);
    expect(documentProductSourceFact({ productSourceFacts: [fact] }, 13, products[2]!)).toBeUndefined();
    expect(documentProductSourceFact({ productSourceFacts: [fact, fact] }, 12, products[2]!)).toBeUndefined();
    expect(documentRevisionDataSchema.safeParse({ ...fixture(), generationRulesVersion: 'v2', productSourceFacts: [fact] }).success).toBe(true);
  });
  it('rejects client-submitted calculation facts and rule versions on all draft write interfaces', () => {
    const operationId = randomUUID(), demandId = randomUUID();
    const create = { operationId, title: 'Invoice', weekStartDate: '2026-10-19', demandIds: [demandId] };
    for (const injected of [{ generationRulesVersion: 'v1' }, { productSourceFacts: [] }]) {
      expect(documentCreateInputSchema.safeParse({ ...create, ...injected }).success).toBe(false);
      expect(documentRevisionInputSchema.safeParse({ operationId, expectedVersion: 1, reason: 'Change', ...injected }).success).toBe(false);
      expect(documentCorrectInputSchema.safeParse({ operationId, expectedVersion: 1, reason: 'Correct', demandIds: [demandId], ...injected }).success).toBe(false);
    }
  });
  it('requires profile availability only for products represented in v2 output', () => {
    const data = fixture(), member = data.members[0]!, first = member.shipment.data.items[0]!;
    const hidden = { ...first, msku: 'Z', fnsku: 'Z', sku: 'Z' };
    member.physical!.snapshot.source.boxes[0]!.items.push(hidden);
    const reference = { category: 'product' as const, profileId: randomUUID(), version: 1, data: { ...hidden, sid: 12 } };
    expect(documentUsesProfileReference(data, reference)).toBe(true);
    data.generationRulesVersion = 'v2';
    expect(documentUsesProfileReference(data, reference)).toBe(false);
    expect(documentUsesProfileReference(data, { ...reference, data: { ...first, sid: 12 } })).toBe(true);
    member.physical!.snapshot.source.boxes[0]!.items[0]!.sku = '12345';
    expect(documentUsesProfileReference(data, { ...reference, data: { ...first, sku: 12345, sid: 12 } })).toBe(true);
    expect(documentUsesProfileReference(data, { ...reference, category: 'party' })).toBe(true);
  });
  it('uses only the global representative profile when different products share an invoice box range', () => {
    const data = fixture(), member = data.members[0]!, first = member.shipment.data.items[0]!;
    const hidden = { ...first, msku: 'Z', fnsku: 'Z', sku: 'Z' }, boxes = member.physical!.snapshot.source.boxes;
    const second = { ...structuredClone(boxes[0]!), boxId: randomUUID(), order: 2, code: 'A2' };
    boxes[0]!.items = [hidden]; boxes.push(second);
    const hiddenReference = { category: 'product' as const, profileId: randomUUID(), version: 1, data: { ...hidden, sid: 12 } };
    const representativeReference = { ...hiddenReference, data: { ...first, sid: 12 } };
    data.generationRulesVersion = 'v2';
    const before = structuredClone(data);
    expect(documentUsesProfileReference(data, hiddenReference)).toBe(false);
    expect(documentUsesProfileReference(data, representativeReference)).toBe(true);
    expect(data).toEqual(before);
    data.fields[documentBoxFieldKey(second.boxId, 'weight')] = '2.00';
    expect(documentUsesProfileReference(data, hiddenReference)).toBe(true);
    data.generationRulesVersion = 'v1';
    expect(documentUsesProfileReference(data, hiddenReference)).toBe(true);
  });
  it('uses the final ticket address and requires a reason for any departure from its referenced address version', () => {
    const data = fixture(); data.fields.addressLine1 = '20 Different Road'; data.fields.addressConfirmed = 'false';
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_UNCONFIRMED' }));
    data.fields.addressConfirmed = 'true'; data.fields.addressConfirmationReason = 'Verified a temporary delivery address';
    expect(validateDocumentData(data)).toEqual([]);
    data.fields.postalCode = '';
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_INCOMPLETE' }));
  });
  it('accepts a complete confirmed manual address without an address book reference', () => {
    const data = fixture(); data.profileReferences = data.profileReferences.filter((reference) => reference.category !== 'address'); data.fields.addressConfirmed = 'false';
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_UNCONFIRMED' }));
    expect(validateDocumentData(data)).not.toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PROFILE_REQUIRED', profileCategory: 'address' }));
    data.fields.addressConfirmed = 'true'; data.fields.addressConfirmationReason = 'Checked the original shipment snapshot';
    expect(validateDocumentData(data)).toEqual([]);
  });
  it('never dismisses a damaged raw source just because its address was confirmed', () => {
    const data = fixture(); data.fields.addressConfirmed = 'true'; data.fields.addressConfirmationReason = 'Address checked';
    data.members[0]!.sourceCandidates = { products: [], addresses: [], issues: [{ code: 'DOCUMENT_SOURCE_FILE_INVALID', severity: 'error', message: 'Damaged source' }] };
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_SOURCE_FILE_INVALID' }));
  });
  it('rechecks historical address diagnostics when the detail only supplements a blank list street', () => {
    const data = fixture(); data.fields.addressConfirmed = 'false';
    data.members[0]!.sourceCandidates = { products: [], addresses: [
      { source: 'listShipments', snapshotId: randomUUID(), data: { addressLine1: null, city: 'GREENWOOD', countryCode: 'US' } },
      { source: 'getShipmentDetails', snapshotId: randomUUID(), data: { addressLine1: '1151 S GRAHAM RD', city: 'GREENWOOD', countryCode: 'US' } },
    ], issues: [{ code: 'DOCUMENT_ADDRESS_CONFLICT', severity: 'error', message: 'Historical missing-field conflict' }] };
    expect(validateDocumentData(data).filter((issue) => issue.code === 'DOCUMENT_ADDRESS_CONFLICT')).toEqual([]);
    data.members[0]!.sourceCandidates.addresses[0]!.data.addressLine1 = 'ANOTHER ROAD';
    expect(validateDocumentData(data).some((issue) => issue.code === 'DOCUMENT_ADDRESS_CONFLICT')).toBe(true);
  });
  it('accepts a complete FBA snapshot with explicit source dependencies', () => { const data = fixture(); expect(documentRevisionDataSchema.safeParse(data).success).toBe(true); expect(validateDocumentData(data)).toEqual([]); });
  it('accepts an M2 snapshot without M3 while still requiring code and template', () => {
    const data = fixture(), member = data.members[0]!; member.physical = null;
    member.source.physicalConfirmationId = null; member.source.m3Version = null; member.source.sourceFingerprint = null;
    expect(validateDocumentData(data)).toEqual([]);
    member.codes = []; data.templateReference = null; data.profileReferences = [];
    expect(validateDocumentData(data).map((issue) => issue.code)).toEqual(expect.arrayContaining(['CODES_REQUIRED', 'DOCUMENT_TEMPLATE_REQUIRED']));
  });
  it('keeps historical M3 metadata outside the effective M2 dependency identity', () => {
    const source = fixture().members[0]!.source, next = { ...source, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null };
    expect(documentM2SourceReference(source)).toEqual(documentM2SourceReference(next));
    next.m2ConfirmationId = randomUUID(); expect(documentM2SourceReference(source)).not.toEqual(documentM2SourceReference(next));
  });
  it('validates override box identity and positive safe dimensions without treating empty drafts as inherited values', () => {
    const data = fixture(), id = data.members[0]!.shipment.data.boxes[0]!.id;
    for (const value of ['-1', 'Infinity', '9007199254740992', '0.001', 'unknown']) {
      data.fields[documentBoxFieldKey(id, 'weight')] = value;
      expect(documentBoxFieldIssues(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_BOX_VALUE_INVALID' }));
    }
    data.fields[documentBoxFieldKey(id, 'weight')] = '';
    expect(documentBoxFieldIssues(data)).toEqual([]);
    data.fields[documentBoxFieldKey(randomUUID(), 'length')] = '12';
    expect(documentBoxFieldIssues(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_BOX_OVERRIDE_UNKNOWN' }));
  });
  it('retains manual values across source changes by box ID and removes overrides for departed boxes', () => {
    const before = fixture(), next = structuredClone(before), id = before.members[0]!.shipment.data.boxes[0]!.id;
    next.fields[documentBoxFieldKey(id, 'length')] = '12.34'; next.members[0]!.shipment.id = randomUUID();
    expect(reviseDocumentBoxFields(before, next)[documentBoxFieldKey(id, 'length')]).toBe('12.34');
    next.members[0]!.shipment.data.boxes[0]!.id = randomUUID();
    expect(reviseDocumentBoxFields(before, next)[documentBoxFieldKey(id, 'length')]).toBeUndefined();
  });
  it('accepts a complete final ticket without requiring master data references', () => {
    const data = fixture(); data.profileReferences = []; data.fields.addressConfirmed = 'true'; data.fields.addressConfirmationReason = 'Verified the final ticket address';
    const before = structuredClone(data);
    expect(validateDocumentData(data)).toEqual([]);
    expect(data).toEqual(before);
  });
  it('still enforces the service scope of an explicitly selected channel profile', () => {
    const data = fixture(), channel = data.profileReferences.find((reference) => reference.category === 'channel')!;
    channel.data.allowedServices = ['A different service'];
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_SERVICE_INVALID', profileCategory: 'channel' }));
    channel.data.allowedServices = ['Approved service'];
    expect(validateDocumentData(data)).toEqual([]);
    delete channel.data.allowedServices; delete channel.data.service;
    expect(validateDocumentData(data)).toEqual([]);
  });
  it('allows different import weeks while still blocking quantity loss and duplicate complete FBA identity', () => { const data = fixture(); data.members[0]!.shipment.data.boxes[0]!.items[0]!.quantity = '1'; data.members.push(structuredClone(data.members[0]!)); data.members[0]!.demand.weekStartDate = '2026-10-12'; const codes = validateDocumentData(data).map((issue) => issue.code); expect(codes).toEqual(expect.arrayContaining(['DOCUMENT_QUANTITY_MISMATCH', 'DUPLICATE_DOCUMENT_MEMBER'])); expect(codes).not.toContain('CROSS_WEEK_MEMBER'); });
  it('checks explicit occurrence identity independently from historical import weeks', () => { const data = fixture(); data.shippingRunId = randomUUID(); data.members[0]!.source.shippingRunId = data.shippingRunId; data.members[0]!.demand.weekStartDate = '2026-09-07'; expect(validateDocumentData(data).map((issue) => issue.code)).not.toContain('CROSS_SHIPPING_RUN_MEMBER'); data.members[0]!.source.shippingRunId = randomUUID(); expect(validateDocumentData(data).map((issue) => issue.code)).toContain('CROSS_SHIPPING_RUN_MEMBER'); });
  it('claims complete FBA by shop and FBA, independent of local demand id', () => { const data = fixture(); const next = structuredClone(data.members[0]!); next.demand.id = randomUUID(); expect(shipmentClaimKey(next)).toBe(shipmentClaimKey(data.members[0]!)); next.demand.snapshot.sid = 13; expect(shipmentClaimKey(next)).not.toBe(shipmentClaimKey(data.members[0]!)); });
  it('canonicalizes nested maps for idempotency without collapsing member order', () => { expect(documentDigest({ a: 1, b: { x: 'x', y: 'y' } })).toBe(documentDigest({ b: { y: 'y', x: 'x' }, a: 1 })); expect(documentDigest(['a', 'b'])).not.toBe(documentDigest(['b', 'a'])); });
  it('marks a historical published file invalid when its bound raw source fails hash verification', () => { expect(documentDependencyInvalidReason([{ code: 'DOCUMENT_SOURCE_FILE_INVALID', severity: 'error', message: '原始来源文件哈希校验失败。' }])).toBe('原始来源文件哈希校验失败。'); expect(documentDependencyInvalidReason([{ code: 'DOCUMENT_SOURCE_FILE_INVALID', severity: 'warning', message: '候选缺项' }])).toBeNull(); expect(documentDependencyInvalidReason([])).toBeNull(); });
  it('rejects duplicate draft selections and unknown request keys', () => { const id = randomUUID(), value = { operationId: randomUUID(), weekStartDate: '2026-10-19', title: 'Draft', demandIds: [id, id] }; expect(documentCreateInputSchema.safeParse(value).success).toBe(false); expect(documentCreateInputSchema.safeParse({ ...value, demandIds: [id], extra: true }).success).toBe(false); });
  it('requires separate invoices for scope differences and deliberate resolution of address conflicts', () => { const data = fixture(); const next = structuredClone(data.members[0]!); next.demand.snapshot.sid = 13; data.members.push(next); expect(validateDocumentData(data).some((issue) => issue.code === 'DOCUMENT_SPLIT_REQUIRED')).toBe(true); data.members.pop(); data.fields.addressConfirmed = 'false'; data.members[0]!.sourceCandidates = { addresses: [{ source: 'a', snapshotId: randomUUID(), data: { addressLine1: 'Road 1' } }, { source: 'b', snapshotId: randomUUID(), data: { addressLine1: 'Road 2' } }], products: [], issues: [] }; expect(validateDocumentData(data).some((issue) => issue.code === 'DOCUMENT_ADDRESS_CONFLICT')).toBe(true); data.fields.addressConfirmed = 'true'; data.fields.addressConfirmationReason = 'Checked full address with receiver'; expect(validateDocumentData(data).some((issue) => issue.code === 'DOCUMENT_ADDRESS_CONFLICT')).toBe(false); });
  it('blocks ambiguous or out-of-scope master data references', () => { const data = fixture(); data.profileReferences.push({ category: 'party', profileId: randomUUID(), version: 1, data: { sid: 13 } }); data.profileReferences.find((ref) => ref.category === 'channel')!.data = { businessChannel: 'OTHER' }; expect(validateDocumentData(data).map((issue) => issue.code)).toEqual(expect.arrayContaining(['DOCUMENT_PROFILE_AMBIGUOUS', 'DOCUMENT_PROFILE_SCOPE_MISMATCH'])); });
  it('uses the same normalized FC scope as automatic address matching', () => {
    const data = fixture(); data.members[0]!.demand.snapshot.destinationFc = ' ont8 ';
    expect(validateDocumentData(data)).toEqual([]);
  });
  it.each(['tax'] as const)('blocks a %s country code for another country even when the FC and store match', (category) => {
    const data = fixture(), profile = data.profileReferences.find((reference) => reference.category === category)!;
    data.fields.countryCode = ' us '; profile.data.countryCode = 'DE';
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PROFILE_SCOPE_MISMATCH', profileCategory: category }));
    profile.data.countryCode = ' Us ';
    expect(validateDocumentData(data)).toEqual([]);
  });
  it.each(['channel', 'tax'] as const)('blocks a %s currency for another invoice currency', (category) => {
    const data = fixture(), profile = data.profileReferences.find((reference) => reference.category === category)!;
    data.fields.currency = ' usd '; profile.data.currency = 'EUR';
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PROFILE_SCOPE_MISMATCH', profileCategory: category }));
    profile.data.currency = ' UsD ';
    expect(validateDocumentData(data)).toEqual([]);
  });
  it('keeps optional currency scope while requiring confirmation for supplemented legacy addresses', () => {
    const data = fixture(); data.fields.countryCode = 'US'; data.fields.currency = 'USD';
    expect(validateDocumentData(data)).toEqual([]);
    for (const profile of data.profileReferences) { profile.data.countryCode = ' '; profile.data.currency = null; }
    data.fields.addressConfirmed = 'true'; data.fields.addressConfirmationReason = 'Verified missing legacy country';
    expect(validateDocumentData(data)).toEqual([]);
    delete data.fields.countryCode; delete data.fields.currency;
    for (const profile of data.profileReferences) { profile.data.countryCode = 'US'; profile.data.currency = 'USD'; }
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_INCOMPLETE' }));
  });
  it.each([
    ['美国', 'US'], [' usa ', 'US'], ['United States', 'US'], ['UK', 'GB'], ['英国', 'GB'], ['GB', 'GB'],
    ['法国', 'FR'], ['德国', 'DE'], ['西班牙', 'ES'], ['意大利', 'IT'], ['荷兰', 'NL'], ['波兰', 'PL'],
    ['瑞典', 'SE'], ['比利时', 'BE'], ['爱尔兰', 'IE'],
  ])('binds invoice country to the known source country %s', (sourceCountry, countryCode) => {
    const data = fixture(); data.members[0]!.demand.snapshot.country = sourceCountry; data.fields.countryCode = ` ${countryCode.toLowerCase()} `;
    data.profileReferences.find((reference) => reference.category === 'address')!.data.countryCode = countryCode;
    expect(validateDocumentData(data)).toEqual([]);
    data.fields.countryCode = countryCode === 'DE' ? 'US' : 'DE';
    expect(validateDocumentData(data)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_COUNTRY_SCOPE_MISMATCH', demandId: data.members[0]!.demand.id }));
  });
  it('does not infer an ISO country from an unknown source label', () => {
    const data = fixture(); data.members[0]!.demand.snapshot.country = 'Unmapped marketplace'; data.fields.countryCode = 'US';
    expect(validateDocumentData(data)).toEqual([]);
  });
});
