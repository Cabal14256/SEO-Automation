import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';

const state = vi.hoisted(() => ({ records: new Map<unknown, Array<Record<string, unknown>>>(), transaction: vi.fn(), catalog: vi.fn(), storeFile: vi.fn(),
  execute: vi.fn(), insert: vi.fn(), db: {} as Record<string, unknown> }));
vi.mock('../../db/client.js', () => {
  const select = () => ({ from: (table: unknown) => ({ where: () => ({ for: async () => state.records.get(table) ?? [],
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(state.records.get(table) ?? []).then(resolve) }) }) });
  state.db = { select, execute: state.execute, insert: state.insert, transaction: state.transaction };
  state.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(state.db));
  return { db: state.db };
});
vi.mock('../../file-store.js', () => ({ storeImmutableFile: state.storeFile }));
vi.mock('../seller-mappings/catalog.js', async (original) => ({ ...await original<typeof import('../seller-mappings/catalog.js')>(), getCatalogState: state.catalog }));
import { importOperations, importParseRuns, sourceImports, user } from '../../db/schema.js';
import { createSourceImport } from './service.js';

const actorId = 'technical-actor', fingerprint = 'normalized-online-rows';
const content = () => ({ bytes: Buffer.from('504b0304', 'hex'), originalName: '在线填写快照.xlsx', operationId: randomUUID(), actorUserId: actorId,
  sourceType: 'online' as const, requestFingerprint: fingerprint, expectedCatalog: { mode: 'lingxing', version: 1, catalogVersion: 2 } });
function previousSource() {
  const runId = randomUUID(), id = randomUUID();
  state.records.set(sourceImports, [{ id, fileId: randomUUID(), sourceType: 'online', sha256: createHash('sha256').update(Buffer.from('504b0304', 'hex')).digest('hex'),
    originalName: '在线填写快照.xlsx', byteSize: 4, createdBy: actorId, importedAt: new Date('2026-10-17T00:00:00Z'), businessDate: '2026-10-17', datePolicyVersion: 'import-date-shanghai-v1',
    weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', status: 'preview_ready', version: 1, sheets: [], latestRunId: runId }]);
  state.records.set(importParseRuns, [{ id: runId, importId: id, status: 'completed', inputVersion: 1, mappingVersion: 'online-v1', sheetName: '在线需求导入', parserVersion: 'xlsx-preview-v1',
    processedRows: 1, counts: { totalRows: 1, validFbaRows: 1, errorRows: 0, warningRows: 0 }, issues: [], createdAt: new Date('2026-10-17T00:00:00Z'),
    startedAt: new Date('2026-10-17T00:00:00Z'), completedAt: new Date('2026-10-17T00:00:01Z'), errorCode: null, errorMessage: null }]);
  return { id, runId };
}
beforeEach(() => {
  state.records.clear(); state.transaction.mockClear(); state.catalog.mockReset().mockResolvedValue({ mode: 'lingxing', version: 1, catalogVersion: 2 });
  state.storeFile.mockClear(); state.execute.mockReset().mockResolvedValue([]); state.insert.mockReset().mockReturnValue({ values: async () => undefined });
  state.records.set(user, [{ id: actorId, role: 'admin', banned: false }]);
});

describe('source acceptance catalog guard', () => {
  it('rejects a changed catalog before file/dedup/queue changes using only the acceptance transaction', async () => {
    const send = vi.fn(); state.catalog.mockResolvedValue({ mode: 'manual', version: 2, catalogVersion: 2 });
    await expect(createSourceImport({ send } as unknown as PgBoss, content())).rejects.toMatchObject({ code: 'CATALOG_VERSION_CONFLICT', status: 409 });
    expect(state.transaction).toHaveBeenCalledOnce(); expect(state.catalog).toHaveBeenCalledWith(state.db, true);
    expect(state.storeFile).not.toHaveBeenCalled(); expect(state.insert).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('returns an already accepted operation before consulting the now-stale catalog', async () => {
    const request = content(), previous = previousSource(), send = vi.fn();
    const requestHash = createHash('sha256').update(JSON.stringify({ kind: 'online', actorUserId: actorId, content: fingerprint })).digest('hex');
    state.records.set(importOperations, [{ operationId: request.operationId, actorUserId: actorId, requestHash, importId: previous.id, parseRunId: previous.runId, deduplicated: false }]);
    state.catalog.mockResolvedValue({ mode: 'manual', version: 99, catalogVersion: 99 });
    const accepted = await createSourceImport({ send } as unknown as PgBoss, request);
    expect(accepted.replayed).toBe(true); expect(accepted.import.id).toBe(previous.id);
    expect(state.transaction).toHaveBeenCalledOnce(); expect(state.catalog).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('locks the expected catalog on the existing transaction before same-content deduplication', async () => {
    const previous = previousSource(), send = vi.fn();
    const accepted = await createSourceImport({ send } as unknown as PgBoss, content());
    expect(accepted.deduplicated).toBe(true); expect(accepted.import.id).toBe(previous.id);
    expect(state.catalog).toHaveBeenCalledWith(state.db, true); expect(state.transaction).toHaveBeenCalledOnce();
    expect(state.storeFile).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});
