import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importConfirmationContextSchema, type DemandSnapshot, type ImportCommitResult, type ImportPreviewPayload } from '@scm/contracts';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({ records: new Map<unknown, Array<Record<string, unknown>>>(), transaction: vi.fn(), catalog: vi.fn(),
  cancellations: vi.fn(), execute: vi.fn(), insert: vi.fn(), update: vi.fn(), db: {} as Record<string, unknown> }));
vi.mock('../../db/client.js', () => {
  const select = () => ({ from: (table: unknown) => {
    const result = () => Promise.resolve(state.records.get(table) ?? []);
    const chain = { where: () => chain, orderBy: () => chain, for: () => chain, limit: () => chain,
      then: (resolve: (value: unknown) => unknown) => result().then(resolve) };
    return chain;
  } });
  state.db = { select, execute: state.execute, insert: state.insert, update: state.update, transaction: state.transaction };
  state.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(state.db));
  return { db: state.db };
});
vi.mock('../seller-mappings/catalog.js', async (original) => ({ ...await original<typeof import('../seller-mappings/catalog.js')>(), getCatalogState: state.catalog,
  catalogSettingsView: () => ({ mode: 'manual', version: 1, catalogVersion: 2, lastSyncedAt: null, lastError: null, configured: false, readOnly: true }) }));
vi.mock('./demand-lifecycle.js', () => ({ loadDemandCancellationsInTx: state.cancellations }));
import { demands, demandSources, importCommits, importParseRuns, importPreviews, sellerAliases, sellerMappings, sourceImportRows, sourceImports, user } from '../../db/schema.js';
import { commitImport, createImportPreview, getConfirmationContext } from './confirmation.js';

const actorId = 'administrator';
const at = new Date('2026-10-23T00:00:00.000Z');
const snapshot: DemandSnapshot = { sid: 100, fba: 'FBA123', shop: '来源店铺', country: '美国', channel: 'HY', destinationFc: 'ONT8',
  referenceQuantity: '100', notes: null, subBatchName: null };
function fixture() {
  const importId = randomUUID(), runId = randomUUID(), demandId = randomUUID(), rowId = randomUUID(), mappingId = randomUUID(), itemId = randomUUID();
  const mapping = { sourceShop: snapshot.shop, sellerMappingId: mappingId, expectedVersion: 1, confirmed: true as const,
    sid: snapshot.sid, name: '目录店铺', country: snapshot.country, confirmedBy: actorId, confirmedAt: at.toISOString() };
  const source = { rowId, parseRunId: runId, importId, fileName: '需求.xlsx', sheetName: '需求', rowNumber: 2, addresses: ['F2'] };
  const payload: ImportPreviewPayload = { preview: { id: randomUUID(), importId, parseRunId: runId, importVersion: 1, mappings: [mapping], baselineImportId: null,
    createdAt: at.toISOString(), createdBy: actorId, counts: { new: 0, changed: 0, unchanged: 1, conflict: 0, error: 0, missing: 0 },
    selectableItemIds: [itemId], changedItemIds: [], sellerCatalogMode: 'manual', sellerCatalogSettingsVersion: 1, sellerCatalogVersion: 2 },
  items: [{ id: itemId, kind: 'unchanged', selectable: true, sid: snapshot.sid, fba: snapshot.fba, demandId, expectedDemandVersion: 2,
    before: snapshot, after: snapshot, sources: [source], issues: [], alreadyCommitted: false }] };
  state.records.set(sourceImports, [{ id: importId, originalName: source.fileName, version: 1, latestRunId: runId, status: 'preview_ready',
    businessDate: '2026-10-23', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25' }]);
  state.records.set(importParseRuns, [{ id: runId, importId, status: 'completed', mappingVersion: 'feishu-v1' }]);
  state.records.set(importPreviews, [{ id: payload.preview.id, payload }]);
  state.records.set(sourceImportRows, [{ id: rowId, parseRunId: runId, sheetName: source.sheetName, rowNumber: source.rowNumber, rawCells: [], issues: [],
    normalized: { ...snapshot, sourceDate: null, sourceRecordId: null, sellerMappingId: null, sid: null, sellerMappingVersion: null } }]);
  state.records.set(sellerMappings, [{ id: mappingId, sid: snapshot.sid, version: 1, manualEnabled: true, name: mapping.name, country: snapshot.country, status: 'approved' }]);
  state.records.set(demands, [{ id: demandId, sid: snapshot.sid, fba: snapshot.fba, snapshot, version: 2 }]);
  const input = { operationId: randomUUID(), previewId: payload.preview.id, selectedItemIds: [itemId], confirmedChangedItemIds: [] };
  return { importId, runId, demandId, mapping, source, payload, input };
}
beforeEach(() => {
  state.records.clear(); state.transaction.mockClear(); state.catalog.mockReset().mockResolvedValue({ mode: 'manual', version: 1, catalogVersion: 2 });
  state.cancellations.mockReset().mockResolvedValue(new Map()); state.execute.mockReset().mockResolvedValue([]);
  state.insert.mockReset().mockReturnValue({ values: async () => undefined }); state.update.mockReset();
  state.records.set(user, [{ id: actorId, role: 'admin', banned: false }]);
});

describe('import confirmation shop context', () => {
  it('publishes approved alias suggestions while keeping blank shops as source-row errors', async () => {
    const f = fixture();
    state.records.set(sellerAliases, [{ sellerMappingId: f.mapping.sellerMappingId, alias: snapshot.shop }]);
    const rows = state.records.get(sourceImportRows)!;
    const first = rows[0]!;
    rows.push({ ...first, id: randomUUID(), rowNumber: 3, status: 'error', normalized: { ...(first.normalized as object), shop: null } });
    const result = await getConfirmationContext(f.importId, actorId);
    expect(importConfirmationContextSchema.safeParse(result).success).toBe(true);
    expect(result.totalSourceRows).toBe(2);
    expect(result.shops).toEqual([{ sourceShop: snapshot.shop, countries: [snapshot.country], rowCount: 1,
      resolution: { status: 'unique', sellerMappingId: f.mapping.sellerMappingId, expectedVersion: 1, reason: 'name_alias' } }]);
    expect(result.sellers[0]).not.toHaveProperty('aliases');
    const legacy = { ...result, shops: result.shops.map(({ sourceShop, countries, rowCount }) => ({ sourceShop, countries, rowCount })) };
    expect(importConfirmationContextSchema.safeParse(legacy).success).toBe(true);
  });

  it('aggregates lookup evidence across all source-shop rows before suggesting an identity', async () => {
    const f = fixture();
    state.records.get(sourceImports)![0]!.sourceType = 'online';
    const rows = state.records.get(sourceImportRows)!;
    const first = rows[0]!;
    first.normalized = { ...(first.normalized as object), metadataSource: `lingxing:${f.runId}:sid=100` };
    rows.push({ ...first, id: randomUUID(), rowNumber: 3, normalized: { ...(first.normalized as object), metadataSource: `lingxing:${f.runId}:sid=200` } });
    expect((await getConfirmationContext(f.importId, actorId)).shops[0]).toMatchObject({ rowCount: 2,
      resolution: { status: 'ambiguous', sellerMappingId: null, expectedVersion: null, reason: 'conflicting_lookup_sids' } });
  });
});

describe('import cancellation lifecycle guard', () => {
  it('loads the cancellation tombstone for the preview baseline without dropping its demand', async () => {
    const f = fixture();
    state.cancellations.mockResolvedValue(new Map([[f.demandId, { reason: '不再发货', createdBy: actorId, createdAt: at }]]));
    const result = await createImportPreview(f.importId, { expectedVersion: 1, parseRunId: f.runId,
      sellerSelections: [{ sourceShop: f.mapping.sourceShop, sellerMappingId: f.mapping.sellerMappingId, expectedVersion: 1, confirmed: true }],
      expectedCatalogSettingsVersion: 1, expectedCatalogVersion: 2 }, actorId);
    expect(state.cancellations).toHaveBeenCalledWith(state.db, [f.demandId]);
    expect(result.items[0]).toMatchObject({ kind: 'error', selectable: false, demandId: f.demandId, expectedDemandVersion: 2, before: snapshot });
    expect(result.items[0]!.issues).toContainEqual(expect.objectContaining({ code: 'DEMAND_CANCELLED', severity: 'error' }));
    expect(result.preview.selectableItemIds).toEqual([]);
  });

  it.each([false, true])('rejects an old selectable preview after cancellation, even when source already committed: %s', async (alreadyCommitted) => {
    const f = fixture();
    if (alreadyCommitted) state.records.set(demandSources, [{ demandId: f.demandId, sheetName: f.source.sheetName, rowNumber: f.source.rowNumber }]);
    state.cancellations.mockImplementation(async () => {
      const lockQueries = state.execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query));
      expect(lockQueries.some((query) => query.params.includes(`demand:${JSON.stringify([snapshot.sid, snapshot.fba])}`))).toBe(true);
      return new Map([[f.demandId, { reason: '不再发货', createdBy: actorId, createdAt: at }]]);
    });
    await expect(commitImport(f.importId, f.input, actorId)).rejects.toMatchObject({ code: 'DEMAND_CANCELLED', status: 409,
      details: { currentDemandId: f.demandId, currentDemandVersion: 2 } });
    expect(state.cancellations).toHaveBeenCalledWith(state.db, [f.demandId]);
    expect(state.insert).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
  });

  it('replays the exact accepted operation before consulting a later cancellation', async () => {
    const f = fixture();
    const result: ImportCommitResult = { operationId: f.input.operationId, importId: f.importId, previewId: f.input.previewId, createdAt: at.toISOString(),
      createdBy: actorId, items: [{ itemId: f.input.selectedItemIds[0]!, demandId: f.demandId, version: 2, action: 'linked', sources: [f.source] }],
      counts: { created: 0, updated: 0, linked: 1, alreadyCommitted: 0 }, replayed: false };
    const requestHash = createHash('sha256').update(JSON.stringify({ actorId, importId: f.importId, previewId: f.input.previewId,
      selectedItemIds: [...f.input.selectedItemIds].sort(), confirmedChangedItemIds: [] })).digest('hex');
    state.records.set(importCommits, [{ operationId: f.input.operationId, actorUserId: actorId, requestHash, result }]);
    state.cancellations.mockResolvedValue(new Map([[f.demandId, {}]]));
    expect(await commitImport(f.importId, f.input, actorId)).toEqual({ ...result, replayed: true });
    expect(state.cancellations).not.toHaveBeenCalled(); expect(state.catalog).not.toHaveBeenCalled(); expect(state.insert).not.toHaveBeenCalled();
  });

  it('still links active demands when no cancellation tombstone exists', async () => {
    const f = fixture();
    const result = await commitImport(f.importId, f.input, actorId);
    expect(result.counts).toEqual({ created: 0, updated: 0, linked: 1, alreadyCommitted: 0 });
    expect(result.items[0]).toMatchObject({ demandId: f.demandId, version: 2, action: 'linked' });
    expect(state.update).not.toHaveBeenCalled();
  });
});
