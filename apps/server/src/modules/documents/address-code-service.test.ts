import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentRevisionData } from '@scm/contracts';
import type { BatchTx } from '../batches/service.js';
import type { DocumentAddressCodeCatalog } from './address-code.js';
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), sources: vi.fn() }));
vi.mock('./address-code-catalog.js', () => ({ loadDocumentAddressCodeCatalog: mocks.catalog }));
vi.mock('./sources.js', () => ({ loadDocumentSourceCandidates: mocks.sources }));
import { applyDocumentAddressCodeDefaults, hydrateDocumentAddressCodeSourcesInTx, validateDocumentAddressCode, withDocumentAddressCodeResolution } from './address-code-service.js';
import { resolveDocumentAddressCode } from './address-code.js';

const address = { recipientName: 'Example Receiver', addressLine1: '10 Example Road', addressLine2: '', addressLine3: '', city: 'Example City', state: 'CA', postalCode: '12345', countryCode: 'US' };
function fixture(): DocumentRevisionData {
  const snapshotId = randomUUID();
  return { purpose: 'invoice', weekStartDate: '2026-10-26', title: 'Fixture', generationRulesVersion: 'v2', fields: { ...address, addressSelectionMode: 'lingxing', addressConfirmed: 'true', addressConfirmationReason: 'Checked shipment' }, profileReferences: [], templateReference: null,
    members: [{ demand: { snapshot: { country: 'US', destinationFc: 'WRONG-INPUT' } }, shipment: { snapshotIds: [snapshotId] }, sourceCandidates: { addresses: [{ source: 'getShipmentDetails', snapshotId, data: { ...address, destinationFc: 'TEST1' } }], products: [], issues: [] } }] as unknown as DocumentRevisionData['members'] };
}
function catalog(): DocumentAddressCodeCatalog { return { sha256: 'a'.repeat(64), sourceLabel: 'fixture-reference.xlsx', rows: [{ sourceRow: 3, values: { ...address, destinationFc: 'TEST1', addressCode: 'TEST1-12345' }, issues: [], hasFormula: false }] }; }
beforeEach(() => { mocks.catalog.mockReset().mockResolvedValue(null); mocks.sources.mockReset(); });

describe('saved invoice B3 adoption and validation', () => {
  it('uses archived FC rather than the demand input and records provenance without changing streets', async () => {
    const data = fixture(), before = structuredClone(data), next = await applyDocumentAddressCodeDefaults(data);
    expect(next.fields).toMatchObject({ ...address, addressCode: 'TEST1', addressCodeStatus: 'resolved', addressCodeSource: 'lingxing_fc', addressCodeRuleVersion: 'lingxing-fc/v1' });
    expect(next.fields.addressCodeSourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(next.members).toEqual(data.members); expect(data).toEqual(before);
    expect(validateDocumentAddressCode(next, null)).toEqual([]);
    expect(validateDocumentAddressCode(data, null)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_CODE_STALE' }));
  });
  it('pins special mappings to a verified reference hash and exact source rows', async () => {
    const data = fixture(), reference = catalog(); mocks.catalog.mockResolvedValue(reference);
    const next = await applyDocumentAddressCodeDefaults(data);
    expect(next.fields).toMatchObject({ ...address, addressCode: 'TEST1-12345', addressCodeSource: 'freight_reference', addressCodeReferenceSha256: reference.sha256, addressCodeReferenceRows: '3' });
    expect(validateDocumentAddressCode(next, reference)).toEqual([]);
    expect(validateDocumentAddressCode(next, { ...reference, sha256: 'b'.repeat(64) })).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_CODE_STALE' }));
    expect(validateDocumentAddressCode(next, null)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_CODE_STALE' }));
  });
  it('does not export a guessed FC when a special reference address does not match', async () => {
    const data = fixture(); data.fields.postalCode = '99999'; mocks.catalog.mockResolvedValue(catalog());
    const next = await applyDocumentAddressCodeDefaults(data);
    expect(next.fields).toMatchObject({ addressCode: '', addressCodeStatus: 'needs_review', addressConfirmed: 'false', postalCode: '99999' });
    expect(validateDocumentAddressCode(next, catalog())).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_CODE_UNRESOLVED' }));
  });
  it('requires a saved reference adoption even when its code equals the old FC value', async () => {
    const data = fixture(), reference = catalog();
    reference.rows[0]!.values.addressCode = 'TEST1';
    reference.rows.push({ ...structuredClone(reference.rows[0]!), sourceRow: 4, values: { ...reference.rows[0]!.values, postalCode: '99999' } });
    data.fields.addressCode = 'TEST1';
    expect(validateDocumentAddressCode(data, reference)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_CODE_STALE' }));
    mocks.catalog.mockResolvedValue(reference);
    const adopted = await applyDocumentAddressCodeDefaults(data);
    expect(validateDocumentAddressCode(adopted, reference)).toEqual([]);
    adopted.fields.addressCodeReferenceRows = '4';
    expect(validateDocumentAddressCode(adopted, reference)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_ADDRESS_CODE_STALE' }));
  });
  it('preserves an unconfirmed manual code for review, then accepts explicit human confirmation', async () => {
    const data = fixture(); Object.assign(data.fields, { addressSelectionMode: 'manual', addressCode: 'CARRIER-CODE', addressConfirmed: 'false', addressConfirmationReason: 'Reference version and row checked' });
    const next = await applyDocumentAddressCodeDefaults(data);
    expect(next.fields).toMatchObject({ addressCode: 'CARRIER-CODE', addressCodeStatus: 'needs_review', addressConfirmed: 'false' });
    next.fields.addressConfirmed = 'true';
    const confirmed = await applyDocumentAddressCodeDefaults(next);
    expect(confirmed.fields).toMatchObject({ addressCode: 'CARRIER-CODE', addressCodeStatus: 'resolved', addressCodeSource: 'manual', addressConfirmed: 'true' });
    expect(validateDocumentAddressCode(confirmed, null)).toEqual([]);
  });
  it('replaces client-supplied automatic provenance with the server resolution', async () => {
    const data = fixture(); Object.assign(data.fields, { addressCode: 'FORGED', addressCodeSource: 'freight_reference', addressCodeReferenceSha256: 'f'.repeat(64), addressCodeReferenceRows: '99' });
    const next = await applyDocumentAddressCodeDefaults(data);
    expect(next.fields).toMatchObject({ addressCode: 'TEST1', addressCodeSource: 'lingxing_fc', addressCodeReferenceSha256: '', addressCodeReferenceRows: '' });
  });
  it('restores legacy FC evidence only from the invoice-bound archive and keeps the input immutable', async () => {
    const data = fixture(), originalCandidate = data.members[0]!.sourceCandidates!.addresses[0]!;
    delete originalCandidate.data.destinationFc;
    const before = structuredClone(data);
    mocks.sources.mockResolvedValue({ addresses: [{ ...originalCandidate, data: { ...address, destinationFc: 'TEST1' } }], products: [], issues: [] });
    const tx = {} as BatchTx, hydrated = await hydrateDocumentAddressCodeSourcesInTx(tx, data);
    expect(mocks.sources).toHaveBeenCalledWith(tx, data.members[0]);
    expect(hydrated.members[0]!.sourceCandidates!.addresses[0]!.data.destinationFc).toBe('TEST1');
    expect(data).toEqual(before);
    expect((await applyDocumentAddressCodeDefaults(hydrated)).fields.addressCode).toBe('TEST1');
    mocks.sources.mockClear(); await hydrateDocumentAddressCodeSourcesInTx(tx, hydrated); expect(mocks.sources).not.toHaveBeenCalled();
  });
  it('keeps legacy v1 records outside the new rule without reading reference files', async () => {
    const data = fixture(); data.generationRulesVersion = 'v1';
    expect(await applyDocumentAddressCodeDefaults(data)).toBe(data);
    expect(await hydrateDocumentAddressCodeSourcesInTx({} as BatchTx, data)).toBe(data);
    expect(validateDocumentAddressCode(data, null)).toEqual([]); expect(mocks.catalog).not.toHaveBeenCalled(); expect(mocks.sources).not.toHaveBeenCalled();
  });
  it('rechecks mixed old/new candidates and forces archive verification before export', async () => {
    const data = fixture(), second = structuredClone(data.members[0]!.sourceCandidates!.addresses[0]!);
    second.source = 'listShipments'; second.snapshotId = randomUUID(); delete second.data.destinationFc;
    data.members[0]!.sourceCandidates!.addresses.push(second);
    const fresh = structuredClone(data.members[0]!.sourceCandidates!); fresh.addresses[1]!.data.destinationFc = 'DIFFERENT-FC';
    mocks.sources.mockResolvedValue(fresh);
    const hydrated = await hydrateDocumentAddressCodeSourcesInTx({} as BatchTx, data);
    expect(mocks.sources).toHaveBeenCalledTimes(1); expect(resolveDocumentAddressCode(hydrated).status).toBe('needs_review');
    mocks.sources.mockClear();
    await hydrateDocumentAddressCodeSourcesInTx({} as BatchTx, hydrated, true);
    expect(mocks.sources).toHaveBeenCalledTimes(1);
  });
  it('uses a stable snapshot digest regardless of source ordering', () => {
    const data = fixture(), other = structuredClone(data.members[0]!.sourceCandidates!.addresses[0]!); other.snapshotId = randomUUID();
    data.members[0]!.sourceCandidates!.addresses.push(other);
    const first = withDocumentAddressCodeResolution(data, resolveDocumentAddressCode(data));
    data.members[0]!.sourceCandidates!.addresses.reverse();
    expect(withDocumentAddressCodeResolution(data, resolveDocumentAddressCode(data)).fields.addressCodeSourceDigest).toBe(first.fields.addressCodeSourceDigest);
  });
});
