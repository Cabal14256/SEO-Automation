import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importAcceptedSchema } from '@scm/contracts';

const state = vi.hoisted(() => ({ records: new Map<unknown, Array<Record<string, unknown>>>(), transaction: vi.fn(), execute: vi.fn(), store: vi.fn(), session: vi.fn(), db: {} as Record<string, unknown> }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('../../db/client.js', () => {
  const records = (table: unknown, condition?: SQL) => {
    const rows = state.records.get(table) ?? [];
    if (!condition) return rows;
    const query = new PgDialect().sqlToQuery(condition);
    const predicates = [...query.sql.matchAll(/"[^"]+"\."([^"]+)"\s*=\s*\$(\d+)/g)];
    return rows.filter((row) => predicates.every((match) => row[match[1]!.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())] === query.params[Number(match[2]) - 1]));
  };
  const select = () => ({ from: (table: unknown) => {
    let condition: SQL | undefined;
    const builder = { where: (input: SQL) => { condition = input; return builder; }, for: async () => records(table, condition), orderBy: () => builder,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(records(table, condition)).then(resolve) };
    return builder;
  } });
  const insert = (table: unknown) => ({ values: (input: Record<string, unknown>) => {
    const at = new Date('2026-10-18T00:00:00.000Z');
    const row = { createdAt: at, startedAt: null, completedAt: null, status: 'queued', version: 1, sheets: [], latestRunId: null,
      sheetName: null, mappingVersion: null, processedRows: 0, counts: { totalRows: 0, validFbaRows: 0, errorRows: 0, warningRows: 0 }, issues: [], errorCode: null, errorMessage: null, ...input };
    const values = state.records.get(table) ?? []; values.push(row); state.records.set(table, values);
    return { returning: async () => [row], then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve) };
  } });
  const update = (table: unknown) => ({ set: (changes: Record<string, unknown>) => ({ where: (condition: SQL) => {
    const rows = records(table, condition); rows.forEach((row) => Object.assign(row, changes));
    return { returning: async () => rows, then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve) };
  } }) });
  state.db = { select, insert, update, execute: state.execute };
  state.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(state.db));
  return { db: { ...state.db, transaction: state.transaction }, pool: {} };
});
vi.mock('../../file-store.js', () => ({ storeImmutableFile: state.store }));

import { fileIndex, importOperations, importParseRuns, operationAudit, sourceImportRows, sourceImports, user } from '../../db/schema.js';
import { createSourceImport, requestImportParse } from './service.js';
import { createImportRoutes } from './routes.js';
import { inspectWorkbook } from './parser.js';

const actorId = 'technical-validation-admin';
const headers = ['店铺', '渠道', '国家', '目的FC', 'FBA货件号', '参考数量', '业务日期', '子批次名称', '备注'];
async function workbook(sheets: Array<{ name: string; headers?: string[]; rows?: unknown[][] }> = [{ name: '客户自定义表名', rows: [['测试店铺', 'HY', '美国', '', 'FBATEST001']] }]) {
  const book = new ExcelJS.Workbook();
  for (const input of sheets) { const sheet = book.addWorksheet(input.name); sheet.addRow(input.headers ?? headers); for (const row of input.rows ?? []) sheet.addRow(row); }
  return Buffer.from(await book.xlsx.writeBuffer());
}
const content = (bytes: Buffer) => ({ bytes, originalName: '技术需求.xlsx', operationId: randomUUID(), actorUserId: actorId });
const queue = () => ({ send: vi.fn().mockResolvedValue(randomUUID()) });
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/test'); vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-with-at-least-32-characters');
  vi.stubEnv('DATA_DIR', 'D:/SCM-Automation-test-data'); vi.stubEnv('LINGXING_REQUESTS_ENABLED', 'false');
  state.records.clear(); state.transaction.mockClear(); state.execute.mockReset().mockResolvedValue([]);
  state.records.set(user, [{ id: actorId, role: 'admin', banned: false }]);
  state.session.mockReset().mockResolvedValue({ user: { id: actorId, role: 'admin', banned: false } });
  state.store.mockReset().mockImplementation(async (_directory: string, input: { bytes: Buffer; originalName: string }, callback: (file: unknown) => Promise<unknown>) => {
    const file = { id: randomUUID(), storageKey: 'files/technical-validation.xlsx', originalName: input.originalName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: '0'.repeat(64), byteSize: input.bytes.length, createdBy: actorId, createdAt: new Date() };
    await callback(file); return file;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('validated XLSX admission and automatic parse scheduling', () => {
  it('binds the only valid header layout and saves inspected sheets before queuing exactly once', async () => {
    const boss = queue(), input = content(await workbook());
    const accepted = importAcceptedSchema.parse(await createSourceImport(boss as unknown as PgBoss, input));
    expect(accepted.import).toMatchObject({ status: 'queued', version: 1, sheets: [{ name: '客户自定义表名' }], latestRun: { status: 'queued', sheetName: '客户自定义表名', mappingVersion: 'manual-v1' } });
    expect(accepted.run).toMatchObject({ status: 'queued', sheetName: '客户自定义表名', mappingVersion: 'manual-v1', counts: { totalRows: 0 } });
    expect(boss.send).toHaveBeenCalledOnce(); expect(state.store).toHaveBeenCalledOnce();
    expect(state.records.get(sourceImportRows)).toBeUndefined();
    expect(state.records.get(operationAudit)).toHaveLength(1);
  });
  it('does not queue ambiguous valid sheets and retains the explicit mapping recovery path', async () => {
    const boss = queue(), input = content(await workbook([{ name: '需求导入', rows: [['测试店铺', '', '美国', '', 'FBAFIRST']] }, { name: '在线需求导入', rows: [['测试店铺', '', '美国', '', 'FBASECOND']] }]));
    const accepted = importAcceptedSchema.parse(await createSourceImport(boss as unknown as PgBoss, input));
    expect(accepted.import.status).toBe('awaiting_mapping'); expect(accepted.import.sheets).toHaveLength(2);
    expect(accepted.run).toMatchObject({ status: 'completed', sheetName: null, mappingVersion: null, processedRows: 0, issues: [{ code: 'SOURCE_MAPPING_REQUIRED' }] });
    expect(boss.send).not.toHaveBeenCalled(); expect(state.records.get(sourceImportRows)).toBeUndefined();
    const reparsed = importAcceptedSchema.parse(await requestImportParse(boss as unknown as PgBoss, accepted.import.id, { operationId: randomUUID(), expectedVersion: 1, sheetName: '在线需求导入', mappingVersion: 'manual-v1' }, actorId));
    expect(reparsed.run).toMatchObject({ status: 'queued', sheetName: '在线需求导入', mappingVersion: 'manual-v1', inputVersion: 2 }); expect(boss.send).toHaveBeenCalledOnce();
  });
  it('preserves operation replay and same-content deduplication without repeating validation publication or queueing', async () => {
    const boss = queue(), input = content(await workbook());
    const first = await createSourceImport(boss as unknown as PgBoss, input), replay = await createSourceImport(boss as unknown as PgBoss, input);
    expect(replay.replayed).toBe(true); expect(replay.import.id).toBe(first.import.id);
    const duplicate = await createSourceImport(boss as unknown as PgBoss, { ...input, operationId: randomUUID() });
    expect(duplicate.deduplicated).toBe(true); expect(duplicate.import.id).toBe(first.import.id);
    expect(state.store).toHaveBeenCalledOnce(); expect(boss.send).toHaveBeenCalledOnce(); expect(state.records.get(sourceImports)).toHaveLength(1);
  });
  it('keeps business-row errors for parsed row review instead of rejecting the complete file', async () => {
    const boss = queue(), accepted = await createSourceImport(boss as unknown as PgBoss, content(await workbook([{ name: '需求导入', rows: [['测试店铺', '', '美国', '', 'FBAOK'], ['', '', '', '', 'not-an-fba']] }])));
    expect(accepted.import.status).toBe('queued'); expect(boss.send).toHaveBeenCalledOnce();
  });
  it.each(['structure', 'headers', 'empty', 'whitespace'] as const)('rejects invalid %s before files, audit, source rows or queue writes', async (kind) => {
    const bytes = kind === 'structure' ? Buffer.from('504b03040001020304', 'hex') : await workbook([{ name: '需求导入', headers: kind === 'headers' ? ['不受支持的表头'] : undefined,
      rows: kind === 'empty' ? [] : kind === 'whitespace' ? [['  ', '', '']] : [['x']] }]);
    const boss = queue();
    await expect(createSourceImport(boss as unknown as PgBoss, content(bytes))).rejects.toMatchObject({ status: 422, code: kind === 'structure' ? 'INVALID_XLSX' : kind === 'headers' ? 'UNSUPPORTED_IMPORT_HEADERS' : 'EMPTY_WORKSHEET' });
    expect(state.store).not.toHaveBeenCalled(); expect(boss.send).not.toHaveBeenCalled();
    for (const table of [fileIndex, sourceImports, importParseRuns, importOperations, operationAudit, sourceImportRows]) expect(state.records.get(table)).toBeUndefined();
  });
  it('rejects an incompatible manual sheet mapping without creating another parse version or queue task', async () => {
    const boss = queue(), accepted = await createSourceImport(boss as unknown as PgBoss, content(await workbook()));
    const record = state.records.get(sourceImports)![0]!; record.status = 'preview_ready';
    await expect(requestImportParse(boss as unknown as PgBoss, accepted.import.id, { operationId: randomUUID(), expectedVersion: 1, sheetName: '客户自定义表名', mappingVersion: 'online-v1' }, actorId)).rejects.toMatchObject({ code: 'SOURCE_MAPPING_REQUIRED', status: 422 });
    expect(state.records.get(importParseRuns)).toHaveLength(1); expect(boss.send).toHaveBeenCalledOnce();
  });
});

describe('import validation HTTP and template download', () => {
  const app = (boss: ReturnType<typeof queue> | null = null) => new Hono().route('/api/v1/imports', createImportRoutes(() => boss as unknown as PgBoss | null));
  it('downloads a valid XLSX template without a parser queue or database mutation', async () => {
    const response = await app().request('/api/v1/imports/template');
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers.get('Content-Disposition')).toContain(encodeURIComponent('需求导入模板.xlsx'));
    const inspected = inspectWorkbook(new Uint8Array(await response.arrayBuffer())); expect(inspected.sheets.some((sheet) => sheet.name === '在线需求导入')).toBe(true);
    expect(state.transaction).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled();
  });
  it('requires a current administrator for template downloads', async () => {
    state.session.mockResolvedValueOnce(null); expect((await app().request('/api/v1/imports/template')).status).toBe(401);
    state.session.mockResolvedValueOnce({ user: { id: actorId, role: 'admin', banned: true } }); expect((await app().request('/api/v1/imports/template')).status).toBe(403);
    expect(state.store).not.toHaveBeenCalled();
  });
  it('returns specific HTTP 422 for an empty uploaded template without accepting an import', async () => {
    const form = new FormData(); form.set('operationId', randomUUID()); form.set('file', new File([new Uint8Array(await workbook([{ name: '需求导入' }]))], 'empty.xlsx'));
    const boss = queue(), response = await app(boss).request('/api/v1/imports', { method: 'POST', body: form });
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: { code: 'EMPTY_WORKSHEET', message: '请先填写至少一行需求。' } });
    expect(state.store).not.toHaveBeenCalled(); expect(boss.send).not.toHaveBeenCalled();
  });
});
