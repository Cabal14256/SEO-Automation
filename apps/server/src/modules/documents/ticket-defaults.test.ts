import { describe, expect, it } from 'vitest';
import { documentCurrencyForCountry, documentMemberAddressCode, documentTicketCurrency, matchDocumentAddressProfiles, withDocumentInvoiceDefaults, type DocumentMemberSnapshot } from '@scm/contracts';

function member(country = '美国', destinationFc = 'TEST1', codes: string[] = []): DocumentMemberSnapshot {
  return { demand: { snapshot: { country, destinationFc } }, sourceCandidates: { addresses: codes.map((addressCode) => ({ data: { addressCode } })) } } as DocumentMemberSnapshot;
}
function profile(addressCode: string, destinationFc = 'TEST1') {
  return { category: 'address', status: 'active', data: { addressCode, destinationFc, countryCode: 'US', recipientName: 'Receiver', addressLine1: '1 Fixture Road', city: 'City', postalCode: '00123' } };
}

describe('country currency and shipment address-code defaults', () => {
  it.each([['美国', 'USD'], [' us ', 'USD'], ['USA', 'USD'], ['UNITED STATES', 'USD'], ['英国', 'GBP'], ['UK', 'GBP'], ['gb', 'GBP'], ['United Kingdom', 'GBP'], ['德国', 'EUR'], ['DE', 'EUR'], ['France', 'EUR'], ['FR', 'EUR'], ['西班牙', 'EUR'], ['ES', 'EUR'], ['意大利', 'EUR'], ['IT', 'EUR']])('maps %s to %s', (country, currency) => {
    expect(documentCurrencyForCountry(country)).toBe(currency);
  });
  it('adopts a single known currency and leaves unsupported or mixed ranges unresolved', () => {
    expect(documentTicketCurrency([member('德国'), member('法国'), member('ES'), member('IT')])).toBe('EUR');
    expect(documentTicketCurrency([member('US'), member('GB')])).toBeUndefined();
    expect(documentTicketCurrency([member('US'), member('CA')])).toBeUndefined();
    expect(documentTicketCurrency([])).toBeUndefined();
    expect(documentCurrencyForCountry('加拿大')).toBeUndefined();
  });
  it('clears only retired headers and normalizes currency without mutating the original fields', () => {
    const fields = { orderNumber: 'old order', reference: 'old ref', tradeTerms: 'old term', currency: 'EUR', service: 'Kept', 'box.fixture.po': 'KEPT-PO' };
    expect(withDocumentInvoiceDefaults(fields, [member('US')])).toMatchObject({ orderNumber: null, reference: null, tradeTerms: null, currency: 'USD', service: 'Kept', 'box.fixture.po': 'KEPT-PO' });
    expect(fields).toMatchObject({ orderNumber: 'old order', reference: 'old ref', tradeTerms: 'old term', currency: 'EUR' });
    expect(withDocumentInvoiceDefaults(fields, [member('CA')]).currency).toBe('EUR');
  });
  it('uses the archived FBA address code before destination FC and prefers the exact address-book code', () => {
    const shipment = member('US', 'AMAZON-FC', [' addr-1 ', 'ＡＤＤＲ-１']);
    const exact = profile('ADDR-1', 'TRANSIT-FC'), legacy = profile('OTHER', 'ADDR-1');
    expect(documentMemberAddressCode(shipment)).toBe('ADDR-1');
    expect(matchDocumentAddressProfiles([shipment], [legacy, exact])).toEqual([exact]);
  });
  it('supports legacy FC-only address books while retaining ambiguity for human selection', () => {
    const first = profile('', 'TEST1'), second = profile('OTHER', 'TEST1');
    expect(matchDocumentAddressProfiles([member()], [first])).toEqual([first]);
    expect(matchDocumentAddressProfiles([member()], [first, second])).toEqual([first, second]);
  });
  it('does not resolve conflicting source codes, mismatched countries, incomplete or retired addresses', () => {
    const valid = profile('ADDR-1');
    expect(documentMemberAddressCode(member('US', 'TEST1', ['ADDR-1', 'ADDR-2']))).toBeUndefined();
    expect(matchDocumentAddressProfiles([member('US', 'TEST1', ['ADDR-1', 'ADDR-2'])], [valid])).toEqual([]);
    expect(matchDocumentAddressProfiles([member('US', 'TEST1', ['ADDR-1']), member('US', 'TEST1', ['ADDR-2'])], [valid])).toEqual([]);
    const retired = { ...valid, status: 'retired' }, incomplete = { ...valid, data: { ...valid.data, city: '' } }, foreign = { ...valid, data: { ...valid.data, countryCode: 'GB' } };
    expect(matchDocumentAddressProfiles([member('US', 'TEST1', ['ADDR-1'])], [retired, incomplete, foreign])).toEqual([]);
  });
});
