import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentProfileWriteSchema, type DocumentRevisionData } from '@scm/contracts';
import type { BatchTx } from '../batches/service.js';
import { documentProfiles, documentProfileVersions } from './schema.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), requireActor: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('../batches/service.js', () => ({ BatchError: class extends Error { constructor(public code: string, public status: number, message: string) { super(message); } }, requireBatchActor: mocks.requireActor, getConfirmedGroupInTx: vi.fn() }));
import { changeDocumentProfileStatus, resolveDocumentReferencesInTx, writeDocumentProfileInTx } from './service.js';

const address = { destinationFc: 'IND9', recipientName: 'Receiver', addressLine1: '10 Road', city: 'City', postalCode: '00123', countryCode: 'US' };
const record = () => ({ id: randomUUID(), category: 'address' as const, key: 'Original label', version: 1, status: 'active', data: { ...address }, createdBy: 'admin', createdAt: new Date('2026-10-21T00:00:00Z'), updatedAt: new Date('2026-10-21T00:00:00Z') });
function fakeTx(results: unknown[][], current = record()) {
  const writes: Array<{ table: unknown; data: Record<string, unknown> }> = [];
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: () => ({ from: () => ({ where: () => { const rows = results.shift() ?? []; return Object.assign(Promise.resolve(rows), { for: async () => rows }); } }) }),
    update: (table: unknown) => ({ set: (data: Record<string, unknown>) => ({ where: () => { writes.push({ table, data }); return Object.assign(Promise.resolve(undefined), { returning: async () => [{ ...current, ...data }] }); } }) }),
    insert: (table: unknown) => ({ values: (data: Record<string, unknown>) => { writes.push({ table, data }); return Object.assign(Promise.resolve(undefined), { returning: async () => [{ ...record(), ...data }] }); } }),
  };
  return { tx: tx as unknown as BatchTx, writes };
}
beforeEach(() => { mocks.transaction.mockReset(); mocks.requireActor.mockReset(); mocks.requireActor.mockResolvedValue({}); });

describe('Lingxing-only addresses and historical profile compatibility', () => {
  it('rejects invalid new product images before writes while preserving unchanged legacy images during unrelated profile edits', async () => {
    const invalid = fakeTx([[]]);
    await expect(writeDocumentProfileInTx(invalid.tx, 'admin', documentProfileWriteSchema.parse({ operationId: randomUUID(), category: 'product', key: 'Product', reason: 'Image', data: { imageBase64: 'not an image' } }))).rejects.toMatchObject({ code: 'DOCUMENT_IMAGE_INVALID' });
    expect(invalid.writes).toEqual([]);
    const previous = { ...record(), category: 'product', data: { imageBase64: 'legacy invalid' } };
    const legacy = fakeTx([[previous]]);
    await expect(writeDocumentProfileInTx(legacy.tx, 'admin', documentProfileWriteSchema.parse({ operationId: randomUUID(), category: 'product', key: previous.key, expectedVersion: previous.version, reason: 'Name only', data: { ...previous.data, englishName: 'Updated name' } }))).resolves.toMatchObject({ data: { imageBase64: 'legacy invalid', englishName: 'Updated name' } });
    expect(previous.data.imageBase64).toBe('legacy invalid');
  });
  it('rejects address creation and editing before any mutation', async () => {
    const previous = record(), input = { operationId: randomUUID(), category: 'address' as const, key: 'Address', reason: 'Create', data: address };
    expect(documentProfileWriteSchema.safeParse(input).success).toBe(false);
    const fixture = fakeTx([]);
    await expect(writeDocumentProfileInTx(fixture.tx, 'admin', input)).rejects.toMatchObject({ code: 'DOCUMENT_ADDRESS_SOURCE_ONLY' });
    await expect(writeDocumentProfileInTx(fixture.tx, 'admin', { ...input, profileId: previous.id, expectedVersion: 1 })).rejects.toMatchObject({ code: 'DOCUMENT_ADDRESS_SOURCE_ONLY' });
    expect(fixture.writes).toEqual([]);
  });
  it.each(['retired', 'active'] as const)('rejects %s mutations of historical local addresses', async (status) => {
    const previous = record(), fixture = fakeTx([[], [previous]], previous);
    mocks.transaction.mockImplementationOnce((action: (tx: BatchTx) => unknown) => action(fixture.tx));
    await expect(changeDocumentProfileStatus(previous.id, 'admin', { operationId: randomUUID(), expectedVersion: 1, reason: 'Attempt change' }, status)).rejects.toMatchObject({ code: 'DOCUMENT_ADDRESS_SOURCE_ONLY' });
    expect(fixture.writes).toEqual([]);
  });

  it('keeps saved deleted address references traceable but rejects adopting them into another document', async () => {
    const profile = { ...record(), status: 'retired', version: 2 }, reference = { category: 'address' as const, profileId: profile.id, version: 1, data: { ...address } };
    const previous = { profileReferences: [reference], templateReference: null } as DocumentRevisionData;
    const saved = fakeTx([[profile], [{ version: 1, data: address }]], profile);
    expect(await resolveDocumentReferencesInTx(saved.tx, { profileReferences: [reference] }, previous)).toEqual({ profileReferences: [reference], templateReference: null });
    const fresh = fakeTx([[profile], [{ version: 1, data: address }]], profile);
    await expect(resolveDocumentReferencesInTx(fresh.tx, { profileReferences: [reference] }, { ...previous, profileReferences: [] })).rejects.toMatchObject({ code: 'DOCUMENT_ADDRESS_SOURCE_ONLY' });
  });

  it('retains the retirement behavior of other profile categories', async () => {
    const previous = { ...record(), category: 'party' as const }, fixture = fakeTx([[], [previous]], previous as ReturnType<typeof record>);
    mocks.transaction.mockImplementationOnce((action: (tx: BatchTx) => unknown) => action(fixture.tx));
    expect(await changeDocumentProfileStatus(previous.id, 'admin', { operationId: randomUUID(), expectedVersion: 1, reason: 'Retire party' }, 'retired')).toMatchObject({ profileId: previous.id });
    expect(fixture.writes.find((write) => write.table === documentProfiles)?.data).toMatchObject({ status: 'retired' });
    expect(fixture.writes.some((write) => write.table === documentProfileVersions)).toBe(false);
  });
  it('preserves server-owned hidden product references on v2 edits and rechecks them when they become representatives', async () => {
    const first = { msku: 'A', fnsku: 'FA', sku: 'SA', quantity: '2' }, hidden = { msku: 'Z', fnsku: 'FZ', sku: 'SZ', quantity: '3' };
    const profile = { ...record(), category: 'product' as const, status: 'retired', data: { sid: 12, ...hidden } };
    const reference = { category: 'product' as const, profileId: profile.id, version: 1, data: profile.data };
    const demandId = randomUUID(), shipmentId = randomUUID();
    const previous = { generationRulesVersion: 'v2', fields: {}, profileReferences: [reference], templateReference: null,
      members: [{ demand: { id: demandId, snapshot: { sid: 12 } }, shipment: { id: shipmentId }, boxSource: [{ demandId, shipmentRevisionId: shipmentId, boxId: randomUUID(), items: [first, hidden], values: {} }], physical: null }] } as unknown as DocumentRevisionData;
    const stale = fakeTx([]), forged = { ...reference, data: { sid: 12, ...first } };
    expect(await resolveDocumentReferencesInTx(stale.tx, { profileReferences: [forged] }, previous)).toEqual({ profileReferences: [reference], templateReference: null });
    const promoted = structuredClone(previous); promoted.members[0]!.boxSource![0]!.items = [hidden];
    const next = fakeTx([[profile], [{ version: 1, data: profile.data }]]);
    await expect(resolveDocumentReferencesInTx(next.tx, { profileReferences: [reference] }, previous, promoted)).rejects.toMatchObject({ code: 'DOCUMENT_PROFILE_UNAVAILABLE' });
  });
});
