import { createHash } from 'node:crypto';
import { and, count, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { saveImportDraftInputSchema, type ImportDraft, type ImportDraftListQuery, type ImportDraftSummary, type SaveImportDraftInput } from '@scm/contracts';
import { db } from '../../db/client.js';
import { sourceImports, user } from '../../db/schema.js';
import { importDrafts } from './drafts-schema.js';
import { canImport, ImportError } from './service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DraftRecord = typeof importDrafts.$inferSelect;
async function requireActor(tx: Tx, actorId: string) {
  const [actor] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
  if (!actor || actor.banned || !canImport(actor.role)) throw new ImportError('FORBIDDEN', 403, '当前账号没有需求草稿权限。');
}
function summary(row: DraftRecord): ImportDraftSummary {
  return { id: row.id, title: row.title, source: row.content.source, importId: row.content.progress.importId,
    rowCount: row.content.source === 'online' ? row.content.online?.rows.length ?? 0 : null,
    version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
const detail = (row: DraftRecord): ImportDraft => ({ ...summary(row), content: row.content });
const missing = () => new ImportError('NOT_FOUND', 404, '草稿不存在或不可访问。');
const conflict = () => new ImportError('VERSION_CONFLICT', 409, '草稿已在其他位置更新。当前输入仍可保留，请先读取最新草稿后再决定如何保存。');

export async function listImportDrafts(actorId: string, query: ImportDraftListQuery) {
  return db.transaction(async (tx) => {
    await requireActor(tx, actorId);
    const search = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    const where = and(eq(importDrafts.ownerId, actorId), isNull(importDrafts.deletedAt), query.q ? or(ilike(importDrafts.title, search), sql`(${importDrafts.content}->'online'->'rows')::text ILIKE ${search}`, sql`${importDrafts.content}->'file'->>'name' ILIKE ${search}`) : undefined);
    const [rows, totals] = await Promise.all([
      tx.select({ id: importDrafts.id, title: importDrafts.title, source: sql<ImportDraftSummary['source']>`${importDrafts.content}->>'source'`,
        importId: sql<string | null>`${importDrafts.content}->'progress'->>'importId'`, rowCount: sql<number | null>`CASE WHEN ${importDrafts.content}->>'source'='online' THEN jsonb_array_length(COALESCE(${importDrafts.content}->'online'->'rows','[]'::jsonb)) ELSE NULL END`,
        version: importDrafts.version, createdAt: importDrafts.createdAt, updatedAt: importDrafts.updatedAt,
      }).from(importDrafts).where(where).orderBy(desc(importDrafts.updatedAt), desc(importDrafts.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize),
      tx.select({ total: count() }).from(importDrafts).where(where),
    ]);
    return { items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })), total: Number(totals[0]?.total ?? 0) };
  });
}
export async function getImportDraft(id: string, actorId: string) {
  return db.transaction(async (tx) => {
    await requireActor(tx, actorId);
    const [row] = await tx.select().from(importDrafts).where(and(eq(importDrafts.id, id), eq(importDrafts.ownerId, actorId), isNull(importDrafts.deletedAt)));
    if (!row) throw missing();
    return detail(row);
  });
}
export async function saveImportDraft(id: string, rawInput: SaveImportDraftInput, actorId: string) {
  const parsed = saveImportDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '草稿格式无效，请检查标题、行数或文件大小。', parsed.error.flatten());
  const input = parsed.data;
  const requestHash = createHash('sha256').update(JSON.stringify({ title: input.title, content: input.content })).digest('hex');
  return db.transaction(async (tx) => {
    await requireActor(tx, actorId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`import-draft:${id}`},0))`);
    const [row] = await tx.select().from(importDrafts).where(eq(importDrafts.id, id)).for('update');
    if (row && (row.ownerId !== actorId || row.deletedAt)) throw missing();
    if (row && row.lastExpectedVersion === input.expectedVersion && row.requestHash === requestHash && row.version === input.expectedVersion + 1) return { draft: detail(row), replayed: true };
    if (row ? row.version !== input.expectedVersion : input.expectedVersion !== 0) throw conflict();
    const importId = input.content.progress.importId;
    if (importId) {
      const [record] = await tx.select({ id: sourceImports.id }).from(sourceImports).where(eq(sourceImports.id, importId)).for('share');
      if (!record) throw new ImportError('NOT_FOUND', 404, '关联导入不存在或不可访问。');
    }
    const values = { title: input.title, content: input.content, version: input.expectedVersion + 1, lastExpectedVersion: input.expectedVersion, requestHash, updatedAt: new Date() };
    const [saved] = row
      ? await tx.update(importDrafts).set(values).where(and(eq(importDrafts.id, id), eq(importDrafts.ownerId, actorId), eq(importDrafts.version, input.expectedVersion))).returning()
      : await tx.insert(importDrafts).values({ id, ownerId: actorId, ...values }).returning();
    if (!saved) throw conflict();
    return { draft: detail(saved), replayed: false };
  });
}
export async function deleteImportDraft(id: string, version: number, actorId: string): Promise<{ deleted: true }> {
  return db.transaction(async (tx) => {
    await requireActor(tx, actorId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`import-draft:${id}`},0))`);
    const [row] = await tx.select().from(importDrafts).where(and(eq(importDrafts.id, id), eq(importDrafts.ownerId, actorId))).for('update');
    if (!row) throw missing();
    if (row.deletedAt && row.version === version + 1) return { deleted: true };
    if (row.deletedAt) throw missing();
    if (row.version !== version) throw conflict();
    await tx.update(importDrafts).set({ version: version + 1, title: '已删除草稿', content: { source: null, progress: { importId: null, source: null } }, deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(importDrafts.id, id), eq(importDrafts.ownerId, actorId), eq(importDrafts.version, version)));
    return { deleted: true };
  });
}
