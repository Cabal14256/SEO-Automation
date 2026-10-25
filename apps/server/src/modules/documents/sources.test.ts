import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentCandidate } from '@scm/contracts';
import type { BatchTx } from '../batches/service.js';
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: vi.fn() }));
import { checkedFileBytes } from '../imports/service.js';
import { extractDocumentSourceCandidates, loadDocumentSourceCandidates } from './sources.js';
const member = { demand: { snapshot: { sid: 12, fba: 'FBA1' } }, shipment: { data: { items: [{ msku: 'M', fnsku: 'F', sku: 'S' }] } } } as Pick<DocumentCandidate, 'demand' | 'shipment'>;
describe('bound document source candidates', () => {
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
