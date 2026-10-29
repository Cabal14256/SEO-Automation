import { describe, expect, it } from 'vitest';
import type { DocumentRevisionData } from '@scm/contracts';
import { resolveDocumentAddressCode, type DocumentAddressCodeCatalog } from './address-code.js';

const address = { recipientName: 'Receiver', addressLine1: '10 Test Road', addressLine2: '', addressLine3: '', city: 'Test City', state: 'CA', postalCode: '90001', countryCode: 'US' };
function fixture(fcs = ['ONT8']): Pick<DocumentRevisionData, 'fields' | 'members'> {
  return { fields: { ...address, addressSelectionMode: 'lingxing' }, members: fcs.map((fc, index) => ({
    demand: { snapshot: { sid: index + 1, fba: `FBA${index + 1}`, country: 'US', destinationFc: 'UNVERIFIED-DEMAND-FC' } },
    sourceCandidates: { addresses: [{ source: 'getShipmentDetails', snapshotId: `snapshot-${index + 1}`, data: { ...address, destinationFc: fc } }], products: [], issues: [] },
  })) as DocumentRevisionData['members'] };
}
const row = (sourceRow: number, code = 'ONT8', values: Record<string, string> = {}) => ({ sourceRow, values: { ...address, destinationFc: 'ONT8', addressCode: code, ...values }, issues: [] as string[], hasFormula: false });
const catalog = (...rows: DocumentAddressCodeCatalog['rows']): DocumentAddressCodeCatalog => ({ sha256: 'a'.repeat(64), sourceLabel: 'Pinned freight reference', rows });
const candidate = (data: ReturnType<typeof fixture>) => data.members[0]!.sourceCandidates!.addresses[0]!;

describe('invoice B3 address code from archived shipment evidence', () => {
  it('uses the common trusted FC without a reference catalog and never changes input streets', () => {
    const data = fixture([' ont8 ', 'ONT8']), before = structuredClone(data);
    const result = resolveDocumentAddressCode(data);
    expect(result).toMatchObject({ status: 'resolved', code: 'ONT8', source: 'lingxing_fc', sourceSnapshotIds: ['snapshot-1', 'snapshot-2'], sourceRows: [] });
    expect(data).toEqual(before);
  });
  it('uses a normal FC when the pinned catalog has no applicable group', () => {
    expect(resolveDocumentAddressCode(fixture(), catalog(row(2, 'OTHER', { destinationFc: 'OTHER' })))).toMatchObject({ status: 'resolved', code: 'ONT8', source: 'lingxing_fc', catalogSha256: 'a'.repeat(64) });
  });
  it('keeps an explicit Lingxing code that agrees with the FC', () => {
    const data = fixture(); candidate(data).data.addressCode = ' ont8 ';
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'resolved', code: 'ONT8', source: 'lingxing_explicit' });
  });
  it('does not assume an explicit code different from the FC is valid without reference evidence', () => {
    const data = fixture(); candidate(data).data.addressCode = 'ONT8-90001';
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '', source: 'unresolved' });
    expect(resolveDocumentAddressCode(data, catalog(row(2, 'ONT8-90001')))).toMatchObject({ status: 'resolved', code: 'ONT8-90001', source: 'freight_reference', sourceRows: [2] });
  });
  it('rejects inconsistent explicit codes even when the FC is the same', () => {
    const data = fixture(['ONT8', 'ONT8']); candidate(data).data.addressCode = 'ONT8'; data.members[1]!.sourceCandidates!.addresses[0]!.data.addressCode = 'ONT8-90001';
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('does not substitute the demand FC for a member lacking archived FC evidence', () => {
    const data = fixture(['ONT8', '']);
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('can use one bound source to supplement a missing FC in another source for the same FBA', () => {
    const data = fixture(); data.members[0]!.sourceCandidates!.addresses.push({ source: 'listShipments', snapshotId: 'list-snapshot', data: { ...address, destinationFc: null } });
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'resolved', code: 'ONT8' });
  });
  it.each([['ONT8', 'LGB8'], ['ONT8', 'ont8-90001']])('rejects different FCs across complete FBAs (%s / %s)', (first, second) => {
    expect(resolveDocumentAddressCode(fixture([first, second]))).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('rejects contradictory list and detail FC evidence for one FBA', () => {
    const data = fixture(); data.members[0]!.sourceCandidates!.addresses.push({ source: 'listShipments', snapshotId: 'list-snapshot', data: { ...address, destinationFc: 'LGB8' } });
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('does not trust non-Lingxing candidates or borrow another FBA source evidence', () => {
    const data = fixture(['ONT8', 'ONT8']); data.members[1]!.sourceCandidates!.addresses[0]!.source = 'manual';
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '', sourceSnapshotIds: ['snapshot-1'] });
  });
  it('rejects edited final streets that claim Lingxing mode, including selecting another special reference code', () => {
    const data = fixture(); data.fields.addressLine1 = '20 Other Road';
    const before = structuredClone(data);
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '' });
    expect(resolveDocumentAddressCode(data, catalog(row(2, 'ONT8-OTHER', { addressLine1: '20 Other Road' })))).toMatchObject({ status: 'needs_review', code: '' });
    expect(data).toEqual(before);
  });
  it('requires each FBA to establish a complete address rather than merging complementary gaps across FBAs', () => {
    const data = fixture(['ONT8', 'ONT8']); candidate(data).data.addressLine1 = '';
    data.members[1]!.sourceCandidates!.addresses[0]!.data.city = '';
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '' });
    expect(resolveDocumentAddressCode(data, catalog(row(2, 'ONT8-90001')))).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('preserves an explicitly confirmed manual address and code when the final streets differ from incomplete Lingxing evidence', () => {
    const data = fixture(); candidate(data).data.addressLine1 = '';
    data.fields = { ...data.fields, addressLine1: '20 Checked Manual Road', addressCode: 'HUMAN-CODE', addressSelectionMode: 'manual', addressConfirmed: 'true', addressConfirmationReason: '已与货代核实本票人工地址及编码' };
    const before = structuredClone(data);
    expect(resolveDocumentAddressCode(data, catalog(row(2, 'ONT8-90001')))).toMatchObject({ status: 'resolved', code: 'HUMAN-CODE', source: 'manual', sourceRows: [] });
    expect(data).toEqual(before);
  });
  it.each(['missing', 'cross-member', 'source', 'header'])('rejects %s country evidence', (kind) => {
    const data = fixture(['ONT8', 'ONT8']);
    if (kind === 'missing') data.members[1]!.demand.snapshot.country = '';
    if (kind === 'cross-member') data.members[1]!.demand.snapshot.country = 'GB';
    if (kind === 'source') candidate(data).data.countryCode = 'GB';
    if (kind === 'header') data.fields.countryCode = 'GB';
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('preserves a human-confirmed code and address without guessing or replacing them', () => {
    const data = fixture(['ONT8', 'LGB8']);
    data.fields = { ...data.fields, addressCode: 'HUMAN-CODE', addressSelectionMode: 'manual', addressConfirmed: 'true', addressConfirmationReason: '核对货代提供的本票编码' };
    const before = structuredClone(data);
    expect(resolveDocumentAddressCode(data, catalog(row(2, 'OTHER')))).toMatchObject({ status: 'resolved', code: 'HUMAN-CODE', source: 'manual', sourceRows: [] });
    expect(data).toEqual(before);
  });
  it.each(['unconfirmed', 'reason', 'address', 'code'])('does not confirm an incomplete manual %s choice', (kind) => {
    const data = fixture(); data.fields = { ...data.fields, addressCode: 'HUMAN-CODE', addressSelectionMode: 'manual', addressConfirmed: 'true', addressConfirmationReason: 'Checked' };
    if (kind === 'unconfirmed') data.fields.addressConfirmed = 'false';
    if (kind === 'reason') data.fields.addressConfirmationReason = '';
    if (kind === 'address') data.fields.addressLine1 = '';
    if (kind === 'code') data.fields.addressCode = '';
    expect(resolveDocumentAddressCode(data)).toMatchObject({ status: 'needs_review', code: '', source: 'unresolved' });
  });
  it('matches a special code only by the complete normalized geography of a pinned reference', () => {
    const data = fixture(), reference = catalog(row(471, 'ONT8-90001', { addressLine1: '１０  TEST ROAD', city: 'TEST   CITY', countryCode: 'us' }));
    const before = structuredClone(data);
    expect(resolveDocumentAddressCode(data, reference)).toMatchObject({ status: 'resolved', code: 'ONT8-90001', source: 'freight_reference', sourceRows: [471], catalogSha256: reference.sha256 });
    expect(data).toEqual(before);
  });
  it('distinguishes multiple addresses for one FC and accepts their expected FC-conflict diagnostic', () => {
    const first = row(471, 'ONT8-90001'), second = row(479, 'ONT8', { addressLine1: '20 Other Road', postalCode: '90002' });
    first.issues = ['ADDRESS_FC_CONFLICT']; second.issues = ['ADDRESS_FC_CONFLICT'];
    expect(resolveDocumentAddressCode(fixture(), catalog(first, second))).toMatchObject({ status: 'resolved', code: 'ONT8-90001', source: 'freight_reference', sourceRows: [471] });
  });
  it('matches the FC code by geography even when every code equals the same FC but there are multiple addresses', () => {
    const result = resolveDocumentAddressCode(fixture(), catalog(row(2), row(3, 'ONT8', { addressLine1: '20 Other Road' })));
    expect(result).toMatchObject({ status: 'resolved', code: 'ONT8', source: 'freight_reference', sourceRows: [2] });
  });
  it('does not fall back to the FC when a special group has no full-address match, including a different postal code', () => {
    expect(resolveDocumentAddressCode(fixture(), catalog(row(2, 'ONT8-90002', { postalCode: '90002' })))).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('requires every geographic field of a special mapping to agree, including optional street lines', () => {
    const data = fixture(); data.fields.addressLine2 = 'Suite 2'; candidate(data).data.addressLine2 = 'Suite 2';
    expect(resolveDocumentAddressCode(data, catalog(row(2, 'ONT8-90001')))).toMatchObject({ status: 'needs_review', code: '' });
    data.fields.addressLine1 = '';
    expect(resolveDocumentAddressCode(data, catalog(row(2, 'ONT8-90001', { addressLine2: 'Suite 2' })))).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('does not choose the first of different codes matching the same full address', () => {
    expect(resolveDocumentAddressCode(fixture(), catalog(row(2, 'ONT8-ONE'), row(3, 'ONT8-TWO')))).toMatchObject({ status: 'needs_review', code: '', sourceRows: [2, 3] });
  });
  it('coalesces identical reference rows without creating false ambiguity', () => {
    expect(resolveDocumentAddressCode(fixture(), catalog(row(2, 'ONT8-90001'), row(3, 'ONT8-90001')))).toMatchObject({ status: 'resolved', code: 'ONT8-90001', sourceRows: [2, 3] });
  });
  it.each(['formula', 'error', 'incomplete'])('keeps a %s reference group unresolved without FC fallback', (kind) => {
    const uncertain = row(2);
    if (kind === 'formula') uncertain.hasFormula = true;
    if (kind === 'error') uncertain.issues = ['CELL_ERROR'];
    if (kind === 'incomplete') { uncertain.values.addressCode = 'ONT8-90001'; uncertain.values.postalCode = ''; }
    expect(resolveDocumentAddressCode(fixture(), catalog(uncertain))).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('rejects a formula row elsewhere in the same special group even when another row matches', () => {
    const uncertain = row(3, 'ONT8-OTHER', { addressLine1: '20 Other Road' }); uncertain.hasFormula = true;
    expect(resolveDocumentAddressCode(fixture(), catalog(row(2, 'ONT8-90001'), uncertain))).toMatchObject({ status: 'needs_review', code: '' });
  });
  it('does not adopt a reference code that contradicts explicit source code', () => {
    const data = fixture(); candidate(data).data.addressCode = 'ONT8-OTHER';
    expect(resolveDocumentAddressCode(data, catalog(row(2, 'ONT8-90001')))).toMatchObject({ status: 'needs_review', code: '' });
  });
});
