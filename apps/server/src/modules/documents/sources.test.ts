import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { resolveDocumentLingxingAddress, type DocumentCandidate } from '@scm/contracts';
import type { BatchTx } from '../batches/service.js';
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: vi.fn() }));
import { checkedFileBytes } from '../imports/service.js';
import { extractDocumentSourceCandidates, loadDocumentSourceCandidates } from './sources.js';
const member = { demand: { snapshot: { sid: 12, fba: 'FBA1', country: 'US' } }, shipment: { data: { items: [{ msku: 'M', fnsku: 'F', sku: 'S' }] } } } as Pick<DocumentCandidate, 'demand' | 'shipment'>;
const sourceAddress = (operation: 'listShipments' | 'getShipmentDetails', address: Record<string, unknown>) => extractDocumentSourceCandidates({ snapshotId: randomUUID(), operation,
  payload: operation === 'listShipments' ? { data: { list: [{ sid: 12, shipment_id: 'FBA1', destination_fulfillment_center_id: 'TEST1', ship_to_address: address }] } }
    : { data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBA1', warehouseId: 'TEST1', shippingAddress: address }] } },
}, member);
const listAddress = { name: 'Receiver', address_line1: '10 Test Road', address_line2: 'Suite 2', city: 'Test City', state_or_province_code: 'CA', postal_code: '90001', country_code: 'US' };
describe('bound document source candidates', () => {
  it.each(['listShipments', 'getShipmentDetails'] as const)('archives the real %s FC separately from the explicit address code', (operation) => {
    const raw = { name: 'Receiver', address_line1: '10 Road', addressCode: ' CUSTOM-CODE ' };
    const payload = operation === 'listShipments' ? { data: { list: [{ sid: 12, shipment_id: 'FBA1', destination_fulfillment_center_id: ' ont8 ', ship_to_address: raw }] } }
      : { data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBA1', warehouseId: ' ont8 ', shippingAddress: raw }] } };
    expect(extractDocumentSourceCandidates({ snapshotId: randomUUID(), operation, payload }, member).addresses[0]?.data).toMatchObject({ destinationFc: 'ONT8', addressCode: 'CUSTOM-CODE' });
    expect(sourceAddress(operation, listAddress).addresses[0]?.data).toMatchObject({ destinationFc: 'TEST1', addressCode: null });
  });
  it.each([
    ['camelCase', { addressLine1: ' 10 Road ', addressLine2: ' Suite 2 ', addressLine3: ' Floor 3 ' }],
    ['list snake_case', { address_line1: ' 10 Road ', address_line2: ' Suite 2 ', address_line3: ' Floor 3 ' }],
    ['legacy snake_case', { address_line_1: ' 10 Road ', address_line_2: ' Suite 2 ', address_line_3: ' Floor 3 ' }],
  ])('preserves trimmed street lines from %s addresses', (_name, address) => {
    for (const operation of ['listShipments', 'getShipmentDetails'] as const) {
      expect(sourceAddress(operation, address).addresses[0]?.data).toMatchObject({ addressLine1: '10 Road', addressLine2: 'Suite 2', addressLine3: 'Floor 3' });
    }
  });
  it('uses the first nonblank street alias while preserving existing camelCase precedence', () => {
    const address = { addressLine1: ' ', address_line1: ' 10 Actual Road ', address_line_1: '20 Legacy Road',
      addressLine2: ' Camel Suite ', address_line2: 'Actual Suite', address_line_2: 'Legacy Suite',
      addressLine3: '', address_line3: ' ', address_line_3: ' Legacy Floor ' };
    for (const operation of ['listShipments', 'getShipmentDetails'] as const) {
      expect(sourceAddress(operation, address).addresses[0]?.data).toMatchObject({ addressLine1: '10 Actual Road', addressLine2: 'Camel Suite', addressLine3: 'Legacy Floor' });
    }
  });
  it('can adopt a complete real-shape list address without relying on shipment details', () => {
    const sourceCandidates = sourceAddress('listShipments', listAddress);
    expect(resolveDocumentLingxingAddress([{ ...member, sourceCandidates }])).toMatchObject({ recipientName: 'Receiver', addressLine1: '10 Test Road', addressLine2: 'Suite 2', city: 'Test City', state: 'CA', postalCode: '90001', countryCode: 'US', addressCode: '' });
  });
  it('completes a compatible partial detail address from the list street lines', () => {
    const list = sourceAddress('listShipments', listAddress), details = sourceAddress('getShipmentDetails', { addressName: 'Receiver', addressLine1: ' ', city: 'Test City', postalCode: '90001', countryCode: 'US', phoneNumber: '123456789' });
    const sourceCandidates = { addresses: [...list.addresses, ...details.addresses], products: [], issues: [] };
    expect(resolveDocumentLingxingAddress([{ ...member, sourceCandidates }])).toMatchObject({ addressLine1: '10 Test Road', addressLine2: 'Suite 2', phone: '123456789', addressCode: '' });
  });
  it('does not adopt an incomplete list address when no source supplies a required street', () => {
    const sourceCandidates = sourceAddress('listShipments', { ...listAddress, address_line1: ' ' });
    expect(resolveDocumentLingxingAddress([{ ...member, sourceCandidates }])).toBeNull();
  });
  it.each(['addressLine1', 'addressLine2'])('keeps a real list/detail %s conflict unresolved', (field) => {
    const list = sourceAddress('listShipments', listAddress), details = sourceAddress('getShipmentDetails', { addressName: 'Receiver', addressLine1: '10 Test Road', addressLine2: 'Suite 2', city: 'Test City', postalCode: '90001', countryCode: 'US', [field]: 'Different Address' });
    const sourceCandidates = { addresses: [...list.addresses, ...details.addresses], products: [], issues: [] };
    expect(resolveDocumentLingxingAddress([{ ...member, sourceCandidates }])).toBeNull();
  });
  it.each(['listShipments', 'getShipmentDetails'] as const)('isolates %s street aliases by shop and FBA', (operation) => {
    const shipments = [{ sid: 13, fba: 'FBA1', fc: 'WRONG-SHOP-FC', address: { ...listAddress, address_line1: 'Wrong Shop Road' } },
      { sid: 12, fba: 'FBA2', fc: 'WRONG-FBA-FC', address: { ...listAddress, address_line1: 'Wrong FBA Road' } },
      { sid: 12, fba: ' fba1 ', fc: ' ont8 ', address: listAddress }];
    const payload = operation === 'listShipments' ? { data: { list: shipments.map(({ sid, fba, fc, address }) => ({ sid, shipment_id: fba, destination_fulfillment_center_id: fc, ship_to_address: address })) } }
      : { data: { shipmentList: shipments.map(({ sid, fba, fc, address }) => ({ sid, shipmentConfirmationId: fba, warehouseId: fc, shippingAddress: address })) } };
    const sourceCandidates = extractDocumentSourceCandidates({ snapshotId: randomUUID(), operation, payload }, member);
    expect(sourceCandidates.addresses).toHaveLength(1);
    expect(sourceCandidates.addresses[0]?.data).toMatchObject({ addressLine1: '10 Test Road', destinationFc: 'ONT8' });
  });
  it.each(['addressCode', 'address_code'])('archives the explicit source %s address key alongside the shipment candidate', (key) => {
    for (const operation of ['listShipments', 'getShipmentDetails']) {
      const raw = { [key]: ' ADDR-42 ', name: 'Receiver', addressLine1: '10 Road' };
      const payload = operation === 'listShipments' ? { data: { list: [{ sid: 12, shipment_id: 'FBA1', ship_to_address: raw }] } }
        : { data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBA1', shippingAddress: raw }] } };
      expect(extractDocumentSourceCandidates({ snapshotId: randomUUID(), operation, payload }, member).addresses[0]?.data.addressCode).toBe('ADDR-42');
    }
  });
  it('extracts PO only from the uniquely matched FBA', () => {
    for (const operation of ['listShipments', 'getShipmentDetails']) {
      const payload = operation === 'listShipments' ? { data: { list: [{ sid: 12, shipment_id: 'FBA1', reference_id: 'PO1' }, { sid: 13, shipment_id: 'FBA1', reference_id: 'WRONG-SHOP' }] } }
        : { data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBA1', amazonReferenceId: 'PO1' }, { sid: 12, shipmentConfirmationId: 'FBA2', amazonReferenceId: 'WRONG-FBA' }] } };
      expect(extractDocumentSourceCandidates({ snapshotId: randomUUID(), operation, payload }, member).po).toBe('PO1');
    }
  });
  it('clears conflicting archived PO candidates with a resolvable warning and never queries M3 for a new invoice', async () => {
    const records = ['listShipments', 'getShipmentDetails'].map((operation) => ({ snapshot: { id: randomUUID(), operation }, file: { id: randomUUID() } }));
    for (const { snapshot } of records) {
      const payload = snapshot.operation === 'listShipments' ? { code: 0, data: { list: [{ sid: 12, shipment_id: 'FBA1', reference_id: 'PO-LIST' }] } }
        : { code: 0, data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBA1', amazonReferenceId: 'PO-DETAIL' }] } };
      vi.mocked(checkedFileBytes).mockResolvedValueOnce(Buffer.from(JSON.stringify({ request: { operation: snapshot.operation, params: { sid: 12, shipment_id: 'FBA1', shipmentConfirmationId: 'FBA1' } }, metadata: { operation: snapshot.operation, readOnly: true, businessCode: 0, httpStatus: 200, requestedAt: '2026-10-19T00:00:00Z' }, payload })));
    }
    const query = Object.assign(Promise.resolve(records), { from() { return query; }, innerJoin() { return query; }, where() { return query; } });
    const select = vi.fn(() => query), tx = { select } as unknown as BatchTx;
    const result = await loadDocumentSourceCandidates(tx, { ...member, physical: null, shipment: { ...member.shipment, snapshotIds: records.map((record) => record.snapshot.id) } });
    expect(select).toHaveBeenCalledTimes(1); expect(result.po).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PO_CONFLICT', severity: 'warning' }));
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(false);
  });
  it('only extracts the uniquely matched shop/FBA and full product identity', () => { const result = extractDocumentSourceCandidates({ snapshotId: randomUUID(), operation: 'getShipmentDetails', payload: { data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBA1', shippingAddress: { addressLine1: '10 Road', city: 'City', countryCode: 'US', postalCode: '12345' }, itemList: [{ msku: 'M', fnsku: 'F', sku: 'S', asin: 'ASIN1', url: 'https://image.invalid/p.jpg' }, { msku: 'OTHER', fnsku: 'F', sku: 'S', asin: 'WRONG' }] }, { sid: 13, shipmentConfirmationId: 'FBA1', itemList: [{ msku: 'M', fnsku: 'F', sku: 'S', asin: 'WRONGSHOP' }] }] } } }, member); expect(result.addresses[0]?.data).toMatchObject({ addressLine1: '10 Road', city: 'City', countryCode: 'US' }); expect(result.products).toHaveLength(1); expect(result.products[0]).toMatchObject({ sid: 12, msku: 'M', fnsku: 'F', sku: 'S', asin: 'ASIN1', imageUrl: 'https://image.invalid/p.jpg', salesLink: null }); expect(result.issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PRODUCT_IDENTITY_INVALID' })); });
  it('refuses absent or ambiguous shipment matches instead of adopting another FBA', () => { for (const shipmentList of [[{ sid: 12, shipmentConfirmationId: 'FBA2' }], [{ sid: 12, shipmentConfirmationId: 'FBA1' }, { sid: 12, shipmentConfirmationId: 'FBA1' }]]) { const result = extractDocumentSourceCandidates({ snapshotId: randomUUID(), operation: 'getShipmentDetails', payload: { data: { shipmentList } } }, member); expect(result.addresses).toEqual([]); expect(result.products).toEqual([]); expect(result.issues[0]?.code).toBe('DOCUMENT_SOURCE_IDENTITY_INVALID'); } });
  it('keeps explicit sales links as candidates and never guesses one from ASIN', () => { const result = extractDocumentSourceCandidates({ snapshotId: randomUUID(), operation: 'getShipmentDetails', payload: { data: { shipmentList: [{ sid: 12, shipmentConfirmationId: 'FBA1', itemList: [{ msku: 'M', fnsku: 'F', sku: 'S', asin: 'ASIN1', asin_url: 'https://shop.invalid/item', image: 'https://image.invalid/i.png' }] }] } } }, member); expect(result.products[0]).toMatchObject({ asin: 'ASIN1', salesLink: 'https://shop.invalid/item', imageUrl: 'https://image.invalid/i.png' }); });
});
