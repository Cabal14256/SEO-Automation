import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentListQuerySchema, type DocumentRevisionData } from '@scm/contracts';
import { operationAudit } from '../../db/schema.js';
import { batchOperations, subBatches, weeklyBatches } from '../batches/schema.js';
import { documentDigest } from './domain.js';
import { documentExports, documentMemberClaims, documentProfiles, documentRevisions, documents } from './schema.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn(), actor: vi.fn(), execute: vi.fn(), update: vi.fn(), insert: vi.fn(), confirmedGroup: vi.fn(), physical: vi.fn(), sourceCandidates: vi.fn(), checked: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('../batches/service.js', async (original) => ({ ...await original<typeof import('../batches/service.js')>(), requireBatchActor: mocks.actor, getConfirmedGroupInTx: mocks.confirmedGroup }));
vi.mock('../physical/service.js', () => ({ getValidPhysicalConfirmationInTx: mocks.physical }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: mocks.checked }));
vi.mock('./sources.js', () => ({ loadDocumentSourceCandidates: mocks.sourceCandidates }));
vi.mock('./domain.js', async (original) => ({ ...await original<typeof import('./domain.js')>(), validateDocumentData: () => [] }));
vi.mock('./workbook.js', () => ({ validateWorkbookData: () => [], reviseDocumentProductFields: (_previous: DocumentRevisionData, next: DocumentRevisionData) => ({ ...next.fields }) }));
import { appendDocumentRevisionInTx, applyDocumentAutomaticDefaultsInTx, cancelDocument, listDocumentCandidates, listDocuments, reviseDocumentInTx, serializeDocument } from './service.js';
import type { BatchTx } from '../batches/service.js';

type Selection = { fields: unknown; table?: unknown; condition?: SQL; limit?: number; offset?: number; joined?: boolean };
const dialect = new PgDialect();
let selected: unknown[][], selections: Selection[], updated: { table: unknown; values: Record<string, unknown> }[], inserted: { table: unknown; values: Record<string, unknown> }[];
let updateResult: unknown[];

function query(rows: unknown[], selection?: Selection) {
  const result = Object.assign(Promise.resolve(rows), {
    from(table: unknown) { if (selection) selection.table = table; return result; },
    innerJoin() { if (selection) selection.joined = true; return result; },
    where(condition: SQL) { if (selection) selection.condition = condition; return result; },
    for() { return result; },
    orderBy() { return result; },
    limit(value: number) { if (selection) selection.limit = value; return result; },
    offset(value: number) { if (selection) selection.offset = value; return result; },
    returning() { return result; },
  });
  return result;
}

function fixture(status = 'draft', stale = false) {
  const id = randomUUID(), revisionId = randomUUID(), at = new Date('2026-10-21T00:00:00Z');
  const data: DocumentRevisionData = { purpose: 'invoice', weekStartDate: '2026-10-19', title: 'Invoice', fields: { orderNumber: 'Order-123' }, profileReferences: [], templateReference: null,
    members: stale ? [{ demand: { id: randomUUID() }, source: { groupId: randomUUID() } }] as unknown as DocumentRevisionData['members'] : [] };
  const record = { id, purpose: 'invoice', status, version: 3, currentRevisionId: revisionId, createdBy: 'admin', createdAt: at, updatedAt: at };
  const revision = { id: revisionId, documentId: id, version: 3, data, reason: 'fixture', createdBy: 'admin', createdAt: at };
  return { record, revision, candidate: { id, status, revisionId } };
}

// The real dependency projection runs; these reads represent a saved file whose
// source is either still available (no members) or has disappeared (one member).
function dependencyReads(value: ReturnType<typeof fixture>) {
  selected.push([value.record], [value.revision], [value.record], [value.revision], []);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  selected = []; selections = []; updated = []; inserted = []; updateResult = [];
  mocks.actor.mockResolvedValue({}); mocks.execute.mockResolvedValue({});
  mocks.select.mockImplementation((fields: unknown) => {
    if (!selected.length) throw new Error('Unexpected database selection');
    const selection = { fields }; selections.push(selection);
    return query(selected.shift()!, selection);
  });
  mocks.update.mockImplementation((table: unknown) => ({ set: (values: Record<string, unknown>) => { updated.push({ table, values }); return query(updateResult); } }));
  mocks.insert.mockImplementation((table: unknown) => ({ values: (values: Record<string, unknown>) => { inserted.push({ table, values }); return query([]); } }));
  mocks.transaction.mockImplementation(async (action) => action({ select: mocks.select, execute: mocks.execute, update: mocks.update, insert: mocks.insert }));
});

describe('revision service authenticated manual selling-price input', () => {
  function manualFixture() {
    const value = fixture(), identity = { sid: 12, msku: 'M1', fnsku: 'F1', sku: 'S1' }, sourceFileId = randomUUID(), demandId = randomUUID();
    const source = { weekStartDate: '2026-10-19', groupId: randomUUID(), groupVersion: 1, m2ConfirmationId: randomUUID(), demandId, demandVersion: 1, shipmentRevisionId: randomUUID(), physicalConfirmationId: null, m3Version: null, sourceFingerprint: null };
    Object.assign(value.revision.data, { generationRulesVersion: 'v2', fields: { currency: 'USD', recipientName: 'Manual Receiver', addressSelectionMode: 'manual' },
      members: [{ source, demand: { id: demandId, snapshot: { sid: 12, country: 'US', fba: 'FBA1' } }, shipment: { data: { items: [identity], boxes: [] } }, physical: null }],
      productSourceFacts: [{ ...identity, salesPrice: null, currency: null, unitPrice: null, cartonQuantity: null, sourceFileId, sourceSha256: 'a'.repeat(64), fetchedAt: '2026-10-25T00:00:00.000Z' }] });
    const change = { ...identity, salesPrice: '12.375', reason: '按销售记录补充' };
    mocks.checked.mockResolvedValue(Buffer.from(JSON.stringify({ fetchedAt: '2026-10-25T00:00:00.000Z', suggestions: { products: [{ ...identity, data: { salesPrice: null }, imageUrls: [], issues: [] }] } })));
    return { value, change, sourceFileId };
  }
  it('writes provenance in a new revision and retains the source facts through the normal claim/version path', async () => {
    const { value, change, sourceFileId } = manualFixture(), facts = structuredClone(value.revision.data.productSourceFacts);
    selected.push([value.record], [value.revision], [], [{ id: sourceFileId, sha256: 'a'.repeat(64) }], []);
    mocks.insert.mockImplementation((table: unknown) => ({ values: (values: Record<string, unknown>) => { inserted.push({ table, values }); return query(table === documentRevisions ? [{ ...values, createdAt: new Date() }] : []); } }));
    updateResult = [{ ...value.record, version: 4 }];
    const result = await reviseDocumentInTx({ select: mocks.select, execute: mocks.execute, update: mocks.update, insert: mocks.insert } as unknown as BatchTx, value.record.id, 'admin', { operationId: randomUUID(), expectedVersion: 3, reason: '补充售价', manualSalesPrices: [change] });
    expect(result.document.version).toBe(4); expect(result.document.currentRevision.data.productSourceFacts).toEqual(facts);
    expect(result.document.currentRevision.data.manualSalesPrices?.[0]).toMatchObject({ ...change, currency: 'USD', recordedBy: 'admin', recordedAt: expect.any(String), sourceFileId });
    expect(inserted.some((entry) => entry.table === documentMemberClaims)).toBe(true); expect(selected).toEqual([]);
  });
  it('does not allow manual prices to bypass expected-version or existing-file correction gates', async () => {
    const { value, change } = manualFixture(), input = { operationId: randomUUID(), expectedVersion: 2, reason: '补充售价', manualSalesPrices: [change] }, tx = { select: mocks.select } as unknown as BatchTx;
    selected.push([value.record]); await expect(reviseDocumentInTx(tx, value.record.id, 'admin', input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    selected.push([value.record], [value.revision], [{ id: randomUUID() }]);
    await expect(reviseDocumentInTx(tx, value.record.id, 'admin', { ...input, expectedVersion: 3 })).rejects.toMatchObject({ code: 'DOCUMENT_CORRECTION_REQUIRED' });
    expect(mocks.checked).not.toHaveBeenCalled(); expect(inserted).toEqual([]); expect(updated).toEqual([]);
  });
});

describe('document list effective-status pagination', () => {
  it('filters newly stale rows before counting and paging, including rows beyond a stored-status page', async () => {
    const valid = fixture('approved'), stale = fixture('approved', true), storedStale = fixture('stale');
    selected.push([valid.candidate, stale.candidate, storedStale.candidate], [{ documentId: valid.record.id }, { documentId: stale.record.id }]);
    dependencyReads(valid); dependencyReads(stale);
    selected.push([{ record: storedStale.record, revision: storedStale.revision }]);
    const response = await listDocuments('admin', documentListQuerySchema.parse({ status: 'stale', page: 2, pageSize: 1 }));
    expect(response).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(response.items.map((item) => [item.id, item.status])).toEqual([[storedStale.record.id, 'stale']]);
    expect(selections[0]).toMatchObject({ table: documents, joined: true });
    expect(selections[0]!.limit).toBeUndefined(); expect(selections[0]!.offset).toBeUndefined();
    const initial = dialect.sqlToQuery(selections[0]!.condition!);
    expect(initial.params).toEqual(['cancelled', 'superseded']);
    expect(selections.filter((item) => item.table === documentExports)).toHaveLength(1);
    expect(selections.filter((item) => item.table === weeklyBatches)).toHaveLength(2);
    expect(selected).toEqual([]);
  });

  it('removes projected stale rows from an exact approved page and total', async () => {
    const stale = fixture('approved', true), valid = fixture('approved');
    selected.push([stale.candidate, valid.candidate], [{ documentId: stale.record.id }, { documentId: valid.record.id }]);
    dependencyReads(stale); dependencyReads(valid);
    selected.push([{ record: valid.record, revision: valid.revision }]);
    const response = await listDocuments('admin', documentListQuerySchema.parse({ status: 'approved', pageSize: 1 }));
    expect(response.total).toBe(1);
    expect(response.items.map((item) => [item.id, item.status])).toEqual([[valid.record.id, 'approved']]);
    expect(dialect.sqlToQuery(selections[0]!.condition!).params).toEqual(['approved']);
    expect(selected).toEqual([]);
  });

  it('uses database pagination for active lists and projects only the current page', async () => {
    const value = fixture('approved', true);
    selected.push([{ value: 25 }], [{ record: value.record, revision: value.revision }], [{ documentId: value.record.id }]); dependencyReads(value);
    const response = await listDocuments('admin', documentListQuerySchema.parse({ page: 2, pageSize: 10, q: '  ORDER-123  ', weekStartDate: '2026-10-19' }));
    expect(response).toMatchObject({ total: 25, page: 2, pageSize: 10, q: 'ORDER-123', weekStartDate: '2026-10-19', status: 'active' });
    expect(response.items[0]).toMatchObject({ id: value.record.id, status: 'stale' });
    expect(selections[1]).toMatchObject({ limit: 10, offset: 10, joined: true });
    expect(dialect.sqlToQuery(selections[0]!.condition!)).toEqual(dialect.sqlToQuery(selections[1]!.condition!));
    expect(selected).toEqual([]);
  });

  it.each(['cancelled', 'superseded'] as const)('lists %s history without checking live dependencies', async (status) => {
    const value = fixture(status);
    selected.push([{ value: 1 }], [{ record: value.record, revision: value.revision }]);
    const response = await listDocuments('admin', documentListQuerySchema.parse({ status }));
    expect(response.total).toBe(1); expect(response.items[0]!.status).toBe(status);
    expect(selections).toHaveLength(2); expect(selected).toEqual([]);
  });

  it('returns an empty effective-status page without loading revision snapshots', async () => {
    selected.push([]);
    expect(await listDocuments('admin', documentListQuerySchema.parse({ status: 'stale', page: 9 }))).toMatchObject({ items: [], total: 0, page: 9 });
    expect(selections).toHaveLength(1);
  });
});

describe('invoice M2 box sources', () => {
  it('selects exact occurrence members across import weeks and excludes unlinked members of a legacy source group', async () => {
    const runId = randomUUID(), groupId = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()];
    const members = ids.map((id, index) => ({ id, version: 1, weekStartDate: index === 0 ? '2026-09-07' : '2026-10-19', weekEndDate: index === 0 ? '2026-09-13' : '2026-10-25', snapshot: { sid: 12, fba: `FBA${index}` } }));
    selected.push([{ id: randomUUID(), shippingRunId: runId }], [{ id: runId, month: '2026-10', sequence: 3 }], ids.slice(0, 2).map((demandId) => ({ runId, groupId, demandId })), [{ id: groupId, name: 'Source', status: 'confirmed' }]);
    mocks.confirmedGroup.mockResolvedValue({ members, shipments: members.map((demand) => ({ demandId: demand.id, revision: { id: randomUUID(), data: { sid: 12, fba: demand.snapshot.fba, items: [], boxes: [], observedAt: '2026-10-24T00:00:00Z' } } })), codes: [], confirmation: { id: randomUUID(), groupVersion: 1 } });
    mocks.sourceCandidates.mockResolvedValue({ addresses: [], products: [], issues: [], po: null });
    const result = await listDocumentCandidates('admin', { shippingRunId: runId });
    expect(result.items.map((item) => item.demandId)).toEqual(ids.slice(0, 2));
    expect(result.items.map((item) => item.weekStartDate)).toEqual(['2026-09-07', '2026-10-19']);
    expect(result.items.every((item) => item.shippingRunId === runId && item.shippingRunMonth === '2026-10' && item.shippingRunSequence === 3)).toBe(true);
    expect(selected).toEqual([]);
  });
  it('builds candidates from confirmed M2 with no M3 lookup and freezes the archived PO beside original dimensions', async () => {
    const demandId = randomUUID(), groupId = randomUUID(), shipmentId = randomUUID(), boxId = randomUUID(), confirmationId = randomUUID();
    const demand = { id: demandId, version: 1, snapshot: { sid: 12, fba: 'FBA1' } };
    const shipment = { id: shipmentId, data: { sid: 12, fba: 'FBA1', observedAt: '2026-10-19T00:00:00Z', boxes: [{ id: boxId, order: 1, items: [], weight: '2.5', weightUnit: 'LB', length: '10', width: '5', height: '4', dimensionUnit: 'IN' }] } };
    selected.push([{ id: randomUUID(), weekStartDate: '2026-10-19', weekEndDate: '2026-10-25' }], [{ id: groupId, name: 'Group', status: 'confirmed' }]);
    mocks.confirmedGroup.mockResolvedValue({ members: [demand], shipments: [{ demandId, revision: shipment }], codes: [{ demandId, boxId, valid: true, code: 'A1' }], confirmation: { id: confirmationId, groupVersion: 1 } });
    mocks.sourceCandidates.mockResolvedValue({ addresses: [], products: [], issues: [], po: 'ARCHIVED-PO' });
    const result = await listDocumentCandidates('admin', '2026-10-19');
    expect(result.items[0]).toMatchObject({ physical: null, physicalConfirmationId: null, m3Version: null, blockers: [], boxSource: [{ boxId, po: 'ARCHIVED-PO', raw: { weight: '2.5', weightUnit: 'LB' }, values: { weight: '1.13', length: '25.40', width: '12.70', height: '10.16' } }] });
    expect(mocks.physical).not.toHaveBeenCalled(); expect(selections.map((entry) => entry.table)).toEqual([weeklyBatches, subBatches]);
  });
  it('rejects a forged box override before persisting a revision or changing claims', async () => {
    const data = fixture().revision.data;
    data.fields[`box.${randomUUID()}.length`] = '12';
    await expect(appendDocumentRevisionInTx({} as BatchTx, randomUUID(), 1, data, 'admin', 'invalid box')).rejects.toMatchObject({ code: 'DOCUMENT_BOX_OVERRIDE_UNKNOWN', status: 422 });
    expect(inserted).toEqual([]); expect(updated).toEqual([]);
  });
});

describe('server-derived invoice currency and address defaults', () => {
  const address = { recipientName: 'Address Book Receiver', addressLine1: '10 Profile Road', city: 'Profile City', postalCode: '12345', countryCode: 'US', addressCode: 'ADDR1', destinationFc: 'OTHER-FC' };
  const profile = (changes: Record<string, unknown> = {}) => ({ id: randomUUID(), category: 'address', key: 'ADDR1 US', version: 7, status: 'active', data: address, ...changes });
  const dataFor = (country = '美国', addressCode = 'ADDR1'): DocumentRevisionData => {
    const data = fixture().revision.data;
    data.members = [{ demand: { id: randomUUID(), snapshot: { sid: 12, fba: 'FBA1', country, destinationFc: addressCode } } }] as DocumentRevisionData['members'];
    data.fields = { orderNumber: 'OLD-ORDER', reference: 'OLD-REFERENCE', tradeTerms: 'DDP', currency: 'GBP' };
    return data;
  };
  const tx = () => ({ select: mocks.select }) as unknown as BatchTx;
  it('fills a new ticket from one exact address-code match and freezes its current version without confirming', async () => {
    const data = dataFor(), saved = profile(); selected.push([saved]);
    const next = await applyDocumentAutomaticDefaultsInTx(tx(), data);
    expect(next.fields).toMatchObject({ currency: 'USD', orderNumber: null, reference: null, tradeTerms: null, ...Object.fromEntries(Object.entries(address).filter(([key]) => key !== 'destinationFc')),
      addressConfirmed: 'false', addressConfirmationReason: '', addressSelectionMode: 'profile', addressSourceLabel: '地址簿 · ADDR1 US · v7' });
    expect(next.profileReferences).toEqual([{ category: 'address', profileId: saved.id, version: 7, data: address }]);
    expect(data.fields).toMatchObject({ orderNumber: 'OLD-ORDER', currency: 'GBP' });
    expect(selections[0]?.table).toBe(documentProfiles);
    expect(dialect.sqlToQuery(selections[0]!.condition!).params).toEqual(['address', 'active']);
  });
  it.each([['美国', 'USD'], ['UK', 'GBP'], ['德国', 'EUR'], ['法国', 'EUR'], ['西班牙', 'EUR'], ['意大利', 'EUR'], ['Canada', 'GBP']])('derives %s currency as %s, preserving an explicit fallback for unmapped countries', async (country, currency) => {
    const data = dataFor(country); data.fields.recipientName = 'Manual Receiver';
    expect((await applyDocumentAutomaticDefaultsInTx(tx(), data)).fields.currency).toBe(currency);
    expect(selections).toEqual([]);
  });
  it('preserves the explicit fallback for mixed-currency tickets without adopting a first-country result', async () => {
    const data = dataFor(); data.members.push(dataFor('英国').members[0]!); data.fields.recipientName = 'Manual Receiver';
    expect((await applyDocumentAutomaticDefaultsInTx(tx(), data)).fields.currency).toBe('GBP');
  });
  it('does not overwrite an existing manual address, confirmation or historical reference during ordinary saves', async () => {
    const previous = dataFor(); previous.fields = { ...previous.fields, ...address, recipientName: 'Explicit Manual Receiver', addressSelectionMode: 'manual', addressConfirmed: 'true', addressConfirmationReason: 'Checked with receiver' };
    previous.profileReferences = [{ category: 'address', profileId: randomUUID(), version: 2, data: address }];
    const next = await applyDocumentAutomaticDefaultsInTx(tx(), structuredClone(previous), previous);
    expect(next.fields).toMatchObject({ recipientName: 'Explicit Manual Receiver', addressConfirmed: 'true', addressConfirmationReason: 'Checked with receiver' });
    expect(next.profileReferences).toEqual(previous.profileReferences); expect(selections).toEqual([]);
  });
  it('preserves explicit address edits supplied together with a source-code change', async () => {
    const previous = dataFor(); previous.fields = { ...previous.fields, ...address };
    const data = structuredClone(previous); data.members[0]!.demand.snapshot.destinationFc = 'NEWCODE'; data.fields.addressLine1 = 'Manual New Road'; data.fields.addressSelectionMode = 'manual';
    expect((await applyDocumentAutomaticDefaultsInTx(tx(), data, previous)).fields.addressLine1).toBe('Manual New Road'); expect(selections).toEqual([]);
  });
  it('keeps an intentionally empty manual address empty on a later unrelated save', async () => {
    const previous = dataFor(); previous.fields = { ...previous.fields, addressSelectionMode: 'manual', addressConfirmed: 'false', recipientName: '', addressLine1: '', city: '', postalCode: '', countryCode: '' };
    const data = structuredClone(previous); data.fields.notes = 'Only unrelated notes changed';
    const next = await applyDocumentAutomaticDefaultsInTx(tx(), data, previous);
    expect(next.fields.recipientName).toBe(''); expect(next.profileReferences).toEqual([]); expect(selections).toEqual([]);
  });
  it('allows a fresh address-code match after the scope of a previously empty manual address changes', async () => {
    const previous = dataFor(); previous.fields.addressSelectionMode = 'manual';
    const data = structuredClone(previous); data.members[0]!.demand.snapshot.destinationFc = 'NEWCODE';
    const saved = profile({ data: { ...address, addressCode: 'NEWCODE' } }); selected.push([saved]);
    const next = await applyDocumentAutomaticDefaultsInTx(tx(), data, previous);
    expect(next.fields).toMatchObject({ recipientName: address.recipientName, addressCode: 'NEWCODE', addressConfirmed: 'false' });
    expect(next.profileReferences[0]?.profileId).toBe(saved.id);
  });
  it('rematches a changed FBA source address code, replacing the whole address and requiring fresh confirmation', async () => {
    const previous = dataFor(); previous.fields = { ...previous.fields, ...address, phone: 'OLD-PHONE', addressConfirmed: 'true', addressConfirmationReason: 'Old scope checked' };
    previous.profileReferences = [{ category: 'address', profileId: randomUUID(), version: 2, data: address }];
    const data = structuredClone(previous); data.members[0]!.sourceCandidates = { addresses: [{ source: 'getShipmentDetails', snapshotId: randomUUID(), data: { addressCode: 'NEWCODE' } }], products: [], issues: [] };
    const saved = profile({ key: 'NEWCODE US', version: 9, data: { ...address, addressCode: 'NEWCODE', addressLine1: '20 New Road' } }); selected.push([saved]);
    const next = await applyDocumentAutomaticDefaultsInTx(tx(), data, previous);
    expect(next.fields).toMatchObject({ addressCode: 'NEWCODE', addressLine1: '20 New Road', phone: '', addressConfirmed: 'false', addressConfirmationReason: '' });
    expect(next.profileReferences).toEqual([{ category: 'address', profileId: saved.id, version: 9, data: saved.data }]);
  });
  it.each(['missing', 'ambiguous', 'retired', 'incomplete'] as const)('keeps %s address matching unresolved', async (kind) => {
    const data = dataFor();
    selected.push(kind === 'missing' ? [] : kind === 'ambiguous' ? [profile(), profile()] : kind === 'retired' ? [profile({ status: 'retired' })] : [profile({ data: { ...address, city: '' } })]);
    const next = await applyDocumentAutomaticDefaultsInTx(tx(), data);
    expect(next.profileReferences).toEqual([]); expect(next.fields.recipientName).toBeUndefined(); expect(next.fields.addressConfirmed).not.toBe('true');
  });
  it('does not retain an old address reference or confirmation when a new code has no unique match', async () => {
    const previous = dataFor(); previous.fields = { ...previous.fields, ...address, addressConfirmed: 'true', addressConfirmationReason: 'Old scope' };
    previous.profileReferences = [{ category: 'address', profileId: randomUUID(), version: 2, data: address }];
    const data = structuredClone(previous); data.members[0]!.demand.snapshot.destinationFc = 'UNKNOWN'; selected.push([]);
    const next = await applyDocumentAutomaticDefaultsInTx(tx(), data, previous);
    expect(next.profileReferences).toEqual([]); expect(next.fields).toMatchObject({ addressLine1: '10 Profile Road', addressConfirmed: 'false', addressConfirmationReason: '' });
  });
});

describe('document cancel audit, claims and generation protection', () => {
  it.each(['queued', 'running'])('rejects deletion while a %s generation exists before releasing claims', async (status) => {
    const value = fixture('pending_review'), input = { operationId: randomUUID(), expectedVersion: 3, reason: '删除单据' };
    selected.push([], [value.record], [value.revision], [{ id: randomUUID(), status }]);
    await expect(cancelDocument(value.record.id, 'admin', input)).rejects.toMatchObject({ code: 'DOCUMENT_EXPORT_BUSY', status: 409 });
    expect(updated).toEqual([]); expect(inserted).toEqual([]);
    const active = dialect.sqlToQuery(selections[3]!.condition!);
    expect(active.params).toEqual(['queued', 'running', value.record.id]);
  });

  it.each(['cancelled', 'superseded'])('treats %s as read-only for a fresh operation without another version increment', async (status) => {
    const value = fixture(status);
    selected.push([], [value.record], [value.revision]);
    await expect(cancelDocument(value.record.id, 'admin', { operationId: randomUUID(), expectedVersion: 3, reason: '再次删除' })).rejects.toMatchObject({ code: 'DOCUMENT_READ_ONLY', status: 409 });
    expect(updated).toEqual([]); expect(inserted).toEqual([]); expect(selections).toHaveLength(3);
  });

  it('releases live claims, retains the immutable revision and records one versioned audited operation', async () => {
    const value = fixture(), input = { operationId: randomUUID(), expectedVersion: 3, reason: '删除测试单据' };
    const cancelled = { ...value.record, status: 'cancelled', version: 4 };
    selected.push([], [value.record], [value.revision], []); updateResult = [cancelled];
    const response = await cancelDocument(value.record.id, 'admin', input);
    expect(response).toMatchObject({ documentId: value.record.id, document: { status: 'cancelled', version: 4, currentRevision: { id: value.revision.id } }, replayed: false });
    expect(updated).toEqual([{ table: documentMemberClaims, values: { releasedAt: expect.any(Date) } }, { table: documents, values: { status: 'cancelled', version: 4, updatedAt: expect.any(Date) } }]);
    expect(inserted.map((item) => item.table)).toEqual([batchOperations, operationAudit]);
    expect(inserted[0]!.values).toMatchObject({ operationId: input.operationId, action: 'document.cancel', actorId: 'admin' });
    expect(inserted[1]!.values).toMatchObject({ action: 'document.cancel', targetId: value.record.id, actorUserId: 'admin', details: { operationId: input.operationId, reason: input.reason } });
    expect(inserted[1]!.values.details).toEqual({ operationId: input.operationId, reason: input.reason });
    expect(inserted.some((item) => item.table === documentRevisions)).toBe(false);
  });

  it('replays the same cancellation operation before touching the document or claims again', async () => {
    const value = fixture('cancelled'), input = { operationId: randomUUID(), expectedVersion: 2, reason: '删除测试单据' };
    const result = { documentId: value.record.id, document: serializeDocument(value.record, value.revision) };
    selected.push([{ actorId: 'admin', requestHash: documentDigest({ action: 'document.cancel', input: { id: value.record.id, ...input } }), result }]);
    expect(await cancelDocument(value.record.id, 'admin', input)).toEqual({ ...result, replayed: true });
    expect(selections).toHaveLength(1); expect(updated).toEqual([]); expect(inserted).toEqual([]);
  });
});
