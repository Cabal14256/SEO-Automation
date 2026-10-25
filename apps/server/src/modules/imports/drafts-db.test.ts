import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importDraftListQuerySchema, saveImportDraftInputSchema } from '@scm/contracts';

const state = vi.hoisted(() => ({ schemaName: `import_draft_test_${crypto.randomUUID().replaceAll('-', '')}`, pool: null as Pool | null }));
vi.mock('../../db/client.js', async () => {
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { readConfig } = await import('../../config.js');
  state.pool = new Pool({ connectionString: readConfig().DATABASE_URL, options: `-c search_path=${state.schemaName} -c timezone=Asia/Shanghai`, max: 5 });
  return { db: drizzle({ client: state.pool }) };
});
import { deleteImportDraft, getImportDraft, listImportDrafts, saveImportDraft } from './drafts.js';

const actor = 'draft-owner', other = 'another-owner';
const request = (title = '美国第一批', expectedVersion = 0, fba = 'FBA-DRAFT-ONLY') => saveImportDraftInputSchema.parse({
  expectedVersion, title, content: { source: 'online', progress: { source: 'online', importId: null, step: 2 }, online: { rows: [{ fba }], startDate: '', endDate: '' } },
});
const list = (q = '') => listImportDrafts(actor, importDraftListQuerySchema.parse({ q }));

describe.runIf(process.env.IMPORT_DRAFT_DB_TEST === '1')('import draft service with isolated PostgreSQL schema', () => {
  beforeAll(async () => {
    await state.pool!.query(`CREATE SCHEMA "${state.schemaName}"`);
    await state.pool!.query('CREATE TABLE "user" (LIKE public."user" INCLUDING ALL)');
    await state.pool!.query('CREATE TABLE source_import (id uuid PRIMARY KEY, created_by text NOT NULL)');
    const migration = await readFile(new URL('../../../drizzle/0013_daily_random.sql', import.meta.url), 'utf8');
    await state.pool!.query(migration.replace('"public"."user"', `"${state.schemaName}"."user"`));
    await state.pool!.query('INSERT INTO "user" (id,name,email,role,banned) VALUES ($1,$1,$1,\'admin\',false),($2,$2,$2,\'admin\',false)', [actor, other]);
  });
  afterAll(async () => {
    if (state.pool) {
      await state.pool.query(`DROP SCHEMA IF EXISTS "${state.schemaName}" CASCADE`);
      await state.pool.end();
    }
  });
  it('creates, reads and searches an incomplete draft while leaving formal imports empty', async () => {
    const id = randomUUID(), input = request();
    const result = await saveImportDraft(id, input, actor);
    expect(result).toMatchObject({ replayed: false, draft: { id, version: 1, rowCount: 1, title: input.title } });
    expect((await getImportDraft(id, actor)).content).toEqual(input.content);
    const found = await list('FBA-DRAFT-ONLY');
    expect(found.items.map((item) => item.id)).toContain(id);
    expect(found.items[0]).not.toHaveProperty('content');
    expect((await list('美国第一批')).items.map((item) => item.id)).toContain(id);
    expect((await state.pool!.query('SELECT count(*) AS total FROM source_import')).rows[0].total).toBe('0');
  });
  it('isolates read, list, update and deletion from another administrator', async () => {
    const id = randomUUID(); await saveImportDraft(id, request('隔离草稿'), actor);
    await expect(getImportDraft(id, other)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listImportDrafts(other, importDraftListQuerySchema.parse({}))).items).toHaveLength(0);
    await expect(saveImportDraft(id, request('侵入', 1), other)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteImportDraft(id, 1, other)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getImportDraft(id, actor)).title).toBe('隔离草稿');
  });
  it('serializes concurrent creates and replays the identical original request', async () => {
    const id = randomUUID(), input = request('并发新建');
    const results = await Promise.all([saveImportDraft(id, input, actor), saveImportDraft(id, input, actor)]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(results.map((result) => result.draft.version)).toEqual([1, 1]);
    await expect(saveImportDraft(id, request('不同原请求'), actor)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('permits one concurrent editor and rejects stale overwrites while replaying the winning update', async () => {
    const id = randomUUID(); await saveImportDraft(id, request('原始'), actor);
    const edits = [request('编辑一', 1), request('编辑二', 1)];
    const results = await Promise.allSettled(edits.map((input) => saveImportDraft(id, input, actor)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
    const winning = results[0]!.status === 'fulfilled' ? edits[0]! : edits[1]!;
    expect((await saveImportDraft(id, winning, actor)).replayed).toBe(true);
    expect((await getImportDraft(id, actor)).version).toBe(2);
  });
  it('keeps a deletion tombstone, clears sensitive contents and prevents stale save resurrection', async () => {
    const id = randomUUID(), input = request('待删除', 0, 'SENSITIVE-ROW'); await saveImportDraft(id, input, actor);
    await expect(deleteImportDraft(id, 2, actor)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await deleteImportDraft(id, 1, actor)).toEqual({ deleted: true });
    expect(await deleteImportDraft(id, 1, actor)).toEqual({ deleted: true });
    await expect(getImportDraft(id, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(saveImportDraft(id, input, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(saveImportDraft(id, request('企图重建', 2), actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await list('SENSITIVE-ROW')).items).toHaveLength(0);
    const raw = (await state.pool!.query('SELECT content,version,deleted_at FROM import_draft WHERE id=$1', [id])).rows[0];
    expect(raw.content).toEqual({ source: null, progress: { source: null, importId: null } });
    expect(raw.version).toBe(2); expect(raw.deleted_at).not.toBeNull();
  });
  it('allows an administrator to resume a visible import, rejects missing imports and blocks a disabled account', async () => {
    const importId = randomUUID(); await state.pool!.query('INSERT INTO source_import(id,created_by) VALUES($1,$2)', [importId, other]);
    const input = request('跨账号关联'); input.content.progress.importId = importId;
    expect((await saveImportDraft(randomUUID(), input, actor)).draft.importId).toBe(importId);
    input.content.progress.importId = randomUUID();
    await expect(saveImportDraft(randomUUID(), input, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await state.pool!.query('UPDATE "user" SET banned=true WHERE id=$1', [other]);
    await expect(listImportDrafts(other, importDraftListQuerySchema.parse({}))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await state.pool!.query('UPDATE "user" SET banned=false WHERE id=$1', [other]);
  });
  it('treats search wildcard characters literally', async () => {
    const id = randomUUID(); await saveImportDraft(id, request('百分号%草稿_单个'), actor);
    expect((await list('%草稿_')).items.map((item) => item.id)).toEqual([id]);
    expect((await list('%')).total).toBe(1);
  });
});
