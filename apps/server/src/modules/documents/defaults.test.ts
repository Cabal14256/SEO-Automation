import { describe, expect, it } from 'vitest';
import { applyDocumentAddress, documentAddressDataSchema, documentAddressDifferences, documentProductCurrency, documentProfileWriteSchema, hasCompleteDocumentAddress, withDocumentDefaults, type DocumentMemberSnapshot } from '@scm/contracts';
import { haveDocumentAddressSourcesChanged, reviseDocumentAddressFields } from './address.js';

const address = { recipientName: 'Receiver', addressLine1: '10 Road', city: 'City', postalCode: '00123', countryCode: 'US' };

describe('explicit invoice address adoption and confirmation', () => {
  it('inherits only a supported invoice currency for blank product currencies', () => {
    for (const currency of ['USD', 'EUR', 'GBP']) for (const blank of [undefined, null, '', '  ']) expect(documentProductCurrency(blank, currency)).toBe(currency);
    for (const currency of [undefined, null, '', 'CNY', 'usd']) expect(documentProductCurrency('', currency)).toBe('');
    expect(documentProductCurrency(' EUR ', 'USD')).toBe('EUR');
    expect(documentProductCurrency('CNY', 'USD')).toBe('CNY');
  });
  it('defaults all five blank flags while keeping explicit values', () => {
    expect(withDocumentDefaults({ battery: null, magnetic: '', liquid: '  ', dangerous: null })).toEqual({ battery: '否', magnetic: '否', liquid: '否', powder: '否', dangerous: '否' });
    expect(withDocumentDefaults({}).dangerous).toBe('否');
    const fields = { battery: '是', magnetic: '否', liquid: '是', powder: '否', dangerous: '是', remarks: 'Reviewed' };
    expect(withDocumentDefaults(fields)).toEqual(fields);
    expect(withDocumentDefaults(fields)).not.toBe(fields);
  });

  it('replaces the whole chosen address without carrying old lines or an old confirmation', () => {
    const previous = { ...address, addressLine2: 'Old apartment', phone: 'Old phone', service: 'Kept', addressConfirmed: 'true', addressConfirmationReason: 'Old check' };
    const result = applyDocumentAddress(previous, { ...address, addressLine1: '20 Road' });
    expect(result).toMatchObject({ addressLine1: '20 Road', addressLine2: '', phone: '', service: 'Kept', addressConfirmed: 'false', addressConfirmationReason: '', addressSelectionMode: 'manual' });
    expect(previous.addressLine1).toBe('10 Road');
    expect(documentAddressDifferences(address, { ...address, addressLine1: ' 10  ROAD ', countryCode: 'us' })).toEqual([]);
    expect(documentAddressDifferences(address, { ...address, postalCode: '00124' })).toEqual(['postalCode']);
  });

  it('withdraws stale confirmation after editing or changing the address reference', () => {
    const previous = { ...address, addressConfirmed: 'true', addressConfirmationReason: 'Old check' };
    const changed = { ...previous, addressLine1: '20 Road' };
    expect(reviseDocumentAddressFields(previous, changed)).toMatchObject({ addressConfirmed: 'false', addressConfirmationReason: '' });
    expect(reviseDocumentAddressFields(previous, previous, false, true)).toMatchObject({ addressConfirmed: 'false', addressConfirmationReason: '' });
    expect(reviseDocumentAddressFields(previous, { ...previous, remarks: 'Only a note' })).toMatchObject({ addressConfirmed: 'true', addressConfirmationReason: 'Old check' });
    expect(reviseDocumentAddressFields(previous, { ...changed, addressConfirmationReason: 'Checked final address' }, true)).toMatchObject({ addressConfirmed: 'true', addressConfirmationReason: 'Checked final address' });
    expect(reviseDocumentAddressFields(previous, { ...changed, city: '' }, true)).toMatchObject({ addressConfirmed: 'false', addressConfirmationReason: '' });
    expect(reviseDocumentAddressFields(previous, { ...changed, addressConfirmationReason: ' ' }, true)).toMatchObject({ addressConfirmed: 'false', addressConfirmationReason: '' });
  });

  it('validates complete address book entries and preserves numeric postal identifiers', () => {
    expect(hasCompleteDocumentAddress(address)).toBe(true);
    expect(hasCompleteDocumentAddress({ ...address, countryCode: 'USA' })).toBe(false);
    expect(documentAddressDataSchema.parse({ ...address, countryCode: ' us ', destinationFc: ' ind9 ' })).toMatchObject({ destinationFc: 'IND9', countryCode: 'US', postalCode: '00123' });
    for (const destinationFc of ['DTM9/ITM9', 'MHG9/IDU4', 'LBA8/IMN1']) expect(documentAddressDataSchema.parse({ ...address, destinationFc }).destinationFc).toBe(destinationFc);
    for (const data of [{ ...address }, { ...address, destinationFc: 'bad warehouse' }, { ...address, destinationFc: 'IND9', city: '' }]) expect(documentAddressDataSchema.safeParse(data).success).toBe(false);
    expect(documentProfileWriteSchema.safeParse({ operationId: '00000000-0000-4000-8000-000000000001', profileId: '00000000-0000-4000-8000-000000000002', category: 'address', key: 'Rename', data: { ...address, destinationFc: 'IND9' }, reason: 'Edit without version' }).success).toBe(false);
  });

  it('withdraws confirmation when adopted source address data changes, while ignoring snapshot-only changes', () => {
    const previous = [{ sourceCandidates: { addresses: [{ snapshotId: 'old-snapshot', source: 'list', data: address }] } }] as DocumentMemberSnapshot[];
    const sameAddress = [{ sourceCandidates: { addresses: [{ snapshotId: 'new-snapshot', source: 'detail', data: { ...address, addressLine1: ' 10 ROAD ' } }] } }] as DocumentMemberSnapshot[];
    const newAddress = [{ sourceCandidates: { addresses: [{ snapshotId: 'new-snapshot', source: 'detail', data: { ...address, addressLine1: '20 Road' } }] } }] as DocumentMemberSnapshot[];
    expect(haveDocumentAddressSourcesChanged(previous, sameAddress)).toBe(false);
    const changed = haveDocumentAddressSourcesChanged(previous, newAddress);
    expect(changed).toBe(true);
    const confirmed = { ...address, addressConfirmed: 'true', addressConfirmationReason: 'Checked old source' };
    expect(reviseDocumentAddressFields(confirmed, confirmed, false, changed)).toMatchObject({ addressConfirmed: 'false', addressConfirmationReason: '' });
  });
});

