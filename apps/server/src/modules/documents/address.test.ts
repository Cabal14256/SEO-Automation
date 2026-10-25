import { describe, expect, it } from 'vitest';
import { hasAddressConflict, mergeCompatibleAddresses } from './address.js';

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
