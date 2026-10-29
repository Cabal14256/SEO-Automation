import { describe, expect, it } from 'vitest';
import type { DocumentMemberSnapshot } from '@scm/contracts';
import { hasAddressConflict, haveDocumentAddressSourcesChanged, mergeCompatibleAddresses } from './address.js';

describe('address evidence comparison', () => {
  it('supplements an incomplete list address from shipment details without a conflict', () => {
    const list = { addressLine1: null, city: 'GREENWOOD', state: 'IN', postalCode: '46143-7830', countryCode: 'US' };
    const detail = { ...list, addressLine1: '1151 S GRAHAM RD' };
    expect(hasAddressConflict([list, detail])).toBe(false);
    expect(mergeCompatibleAddresses([list, detail])).toEqual(detail);
  });
  it('retains nonempty street, suite, postcode and country conflicts', () => {
    for (const key of ['addressLine1', 'addressLine2', 'postalCode', 'countryCode']) {
      const addresses = [{ [key]: 'A' }, { [key]: 'B' }];
      expect(hasAddressConflict(addresses)).toBe(true);
      expect(mergeCompatibleAddresses(addresses)).toBeNull();
    }
  });
  it('checks every candidate and ignores case or whitespace differences', () => {
    expect(hasAddressConflict([{ city: ' Greenwood ' }, { city: 'GREENWOOD' }, { city: '' }])).toBe(false);
    expect(hasAddressConflict([{ city: 'A' }, {}, { city: 'B' }])).toBe(true);
    expect(mergeCompatibleAddresses([])).toBeNull();
  });
});

describe('bound address evidence parser upgrades', () => {
  const address = { recipientName: 'Test Receiver', addressLine1: '10 Test Road', addressLine2: '', city: 'Test City', state: 'CA', postalCode: '90001', countryCode: 'US' };
  const members = (): DocumentMemberSnapshot[] => [{ demand: { id: 'technical-demand', snapshot: { sid: 12, fba: 'FBATECHPARSER', country: 'US' } }, sourceCandidates: {
    addresses: [{ source: 'listShipments', snapshotId: 'bound-list', data: { ...address, addressLine1: null } }, { source: 'getShipmentDetails', snapshotId: 'bound-detail', data: { ...address } }], products: [], issues: [],
  } }] as DocumentMemberSnapshot[];
  const upgraded = (previous: DocumentMemberSnapshot[]) => {
    const next = structuredClone(previous);
    for (const candidate of next[0]!.sourceCandidates!.addresses) { candidate.data.destinationFc = 'TEST1'; candidate.data.addressLine1 = address.addressLine1; }
    return next;
  };
  it('preserves confirmation for the same files after FC and already-known street extraction is completed', () => {
    const previous = members(), next = upgraded(previous), before = structuredClone(previous);
    expect(haveDocumentAddressSourcesChanged(previous, next)).toBe(false);
    expect(haveDocumentAddressSourcesChanged(previous, structuredClone(previous))).toBe(false);
    expect(previous).toEqual(before);
  });
  it('ignores source labels and snapshot metadata when semantic addresses have not changed', () => {
    const previous = [{ sourceCandidates: { addresses: [{ source: 'list', snapshotId: 'old-file', data: address }] } }] as DocumentMemberSnapshot[];
    const same = [{ sourceCandidates: { addresses: [{ source: 'detail', snapshotId: 'new-file', data: { ...address, addressLine1: ' 10 TEST ROAD ' } }] } }] as DocumentMemberSnapshot[];
    expect(haveDocumentAddressSourcesChanged(previous, same)).toBe(false);
  });
  it('conservatively requires rechecking changed values when member identity is unavailable', () => {
    const previous = [{ sourceCandidates: { addresses: [{ source: 'getShipmentDetails', snapshotId: 'bound-detail', data: address }] } }] as DocumentMemberSnapshot[];
    const next = structuredClone(previous); next[0]!.sourceCandidates!.addresses[0]!.data.destinationFc = 'TEST1';
    expect(haveDocumentAddressSourcesChanged(previous, next)).toBe(true);
  });
  it('treats normalization and candidate order as equivalent evidence', () => {
    const previous = members(), next = upgraded(previous);
    next[0]!.sourceCandidates!.addresses.reverse(); next[0]!.sourceCandidates!.addresses[0]!.data.city = '  TEST   CITY ';
    expect(haveDocumentAddressSourcesChanged(previous, next)).toBe(false);
  });
  it.each(['known-value', 'known-null', 'removed-key'])('does not exempt a changed %s FC from source-change handling', (kind) => {
    const previous = members(); previous[0]!.sourceCandidates!.addresses[0]!.data.destinationFc = kind === 'known-null' ? null : 'TEST1';
    const next = upgraded(previous);
    if (kind === 'known-value') next[0]!.sourceCandidates!.addresses[0]!.data.destinationFc = 'TEST2';
    if (kind === 'removed-key') delete next[0]!.sourceCandidates!.addresses[0]!.data.destinationFc;
    expect(haveDocumentAddressSourcesChanged(previous, next)).toBe(true);
  });
  it('requires rechecking when newly parsed FCs expose conflicting list and detail evidence', () => {
    const previous = members(), next = upgraded(previous);
    next[0]!.sourceCandidates!.addresses[0]!.data.destinationFc = 'TEST2';
    expect(haveDocumentAddressSourcesChanged(previous, next)).toBe(true);
  });
  it.each(['member', 'snapshot', 'operation', 'removed-candidate'])('detects a changed %s even when the final address is the same', (kind) => {
    const previous = members(), next = upgraded(previous);
    if (kind === 'member') next[0]!.demand.id = 'another-demand';
    if (kind === 'snapshot') next[0]!.sourceCandidates!.addresses[0]!.snapshotId = 'another-original-file';
    if (kind === 'operation') next[0]!.sourceCandidates!.addresses[0]!.source = 'getShipmentDetails';
    if (kind === 'removed-candidate') next[0]!.sourceCandidates!.addresses.shift();
    expect(haveDocumentAddressSourcesChanged(previous, next)).toBe(true);
  });
  it.each(['street', 'postal', 'contact', 'conflict', 'incomplete-old', 'incomplete-new'])('requires rechecking changed %s evidence', (kind) => {
    const previous = members();
    if (kind === 'incomplete-old') previous[0]!.sourceCandidates!.addresses.forEach((candidate) => { candidate.data.addressLine1 = ''; });
    const next = upgraded(previous);
    if (kind === 'street') next[0]!.sourceCandidates!.addresses.forEach((candidate) => { candidate.data.addressLine1 = '20 Updated Test Road'; });
    if (kind === 'postal') next[0]!.sourceCandidates!.addresses.forEach((candidate) => { candidate.data.postalCode = '90002'; });
    if (kind === 'contact') next[0]!.sourceCandidates!.addresses[0]!.data.phone = '123456789';
    if (kind === 'conflict') next[0]!.sourceCandidates!.addresses[0]!.data.addressLine1 = '20 Conflicting Road';
    if (kind === 'incomplete-new') next[0]!.sourceCandidates!.addresses.forEach((candidate) => { candidate.data.city = ''; });
    expect(haveDocumentAddressSourcesChanged(previous, next)).toBe(true);
  });
  it('does not ignore a changed nonempty candidate label hidden by a more complete detail record', () => {
    const previous = members(), candidates = previous[0]!.sourceCandidates!.addresses;
    candidates[0]!.data.recipientName = 'Old List Label'; candidates[1]!.data.phone = '123456789';
    const next = upgraded(previous); next[0]!.sourceCandidates!.addresses[0]!.data.recipientName = 'New List Label';
    expect(haveDocumentAddressSourcesChanged(previous, next)).toBe(true);
  });
  it('does not apply the parser exemption to non-Lingxing candidates', () => {
    const previous = members(); previous[0]!.sourceCandidates!.addresses[0]!.source = 'manual';
    expect(haveDocumentAddressSourcesChanged(previous, upgraded(previous))).toBe(true);
  });
});
