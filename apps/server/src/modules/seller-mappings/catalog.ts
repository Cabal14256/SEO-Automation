import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SellerCatalogModeInput, SellerCatalogSettings, SellerCatalogSyncInput } from '@scm/contracts';
import { readConfig } from '../../config.js';
import { db } from '../../db/client.js';
import { fileIndex, operationAudit, sellerAliases, sellerCatalogOperations, sellerCatalogSettings, sellerMappingRevisions, sellerMappings, user } from '../../db/schema.js';
import { storeImmutableFile, type NewFileIndex } from '../../file-store.js';
import { assertLingxingRequestsEnabled, createLingxingReadClient, LingxingReadError, type LingxingReadResult } from '../lingxing/read-client.js';

export type CatalogTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CatalogRow = typeof sellerCatalogSettings.$inferSelect;
type SellerRow = typeof sellerMappings.$inferSelect;
type CatalogResult = { settings: SellerCatalogSettings; replayed: boolean; inserted?: number; updated?: number; total?: number };
export class CatalogError extends Error {
  constructor(public code: string, public status: 403 | 409 | 422 | 503, message: string) { super(message); }
}

export function hasValidLingxingIdentity(row: SellerRow): boolean {
  const remote = row.lingxingData;
  return Boolean(remote?.present === true && Number.isInteger(row.sid) && row.sid > 0 && typeof remote.name === 'string' && remote.name.trim() && remote.name.trim().length <= 160
    && typeof remote.country === 'string' && remote.country.trim() && remote.country.trim().length <= 80
    && typeof remote.observedAt === 'string' && remote.observedAt && Number.isFinite(Date.parse(remote.observedAt)));
}

export function activeSeller(row: SellerRow, mode: string): SellerRow | null {
  if (mode === 'manual') return row.manualEnabled ? row : null;
  const remote = row.lingxingData;
  if (!remote?.present) return null;
  if (!hasValidLingxingIdentity(row)) return { ...row, status: 'disabled' };
  return { ...row, name: remote.name, country: remote.country, marketplaceId: remote.marketplaceId,
    sourceObservedAt: new Date(remote.observedAt), sourceSha256: remote.sha256 ?? row.sourceSha256, sourceFileId: remote.fileId ?? row.sourceFileId,
    status: row.lingxingDisabled || remote.status !== '1' || !row.lingxingAutoApproved ? 'disabled' : 'approved' };
}

function autoApprovalSnapshot(row: SellerRow, aliases: string[]) {
  const active = activeSeller(row, 'lingxing') ?? row;
  return { id: active.id, sid: active.sid, name: active.name, country: active.country, marketplaceId: active.marketplaceId,
    wid: active.wid, aliases: [...aliases].sort(), status: active.status, version: active.version, updatedAt: active.updatedAt.toISOString(),
    sourceObservedAt: active.sourceObservedAt.toISOString(), sourceSha256: active.sourceSha256, dataSource: 'lingxing',
    manualEnabled: active.manualEnabled, lingxingName: row.lingxingData?.name ?? null, lingxingStatus: row.lingxingData?.status ?? null,
    identityLocked: true, hasApprovedBefore: active.status === 'approved', autoApproved: row.lingxingAutoApproved };
}

async function recordAutoApproval(tx: CatalogTx, before: SellerRow | null, after: SellerRow, actorId: string, sourceOperationId: string) {
  if (!after.lingxingAutoApproved || before?.lingxingAutoApproved) return;
  const aliases = before ? (await tx.select().from(sellerAliases).where(eq(sellerAliases.sellerMappingId, after.id))).map((alias) => alias.alias) : [];
  const operationId = randomUUID();
  const requestHash = createHash('sha256').update(JSON.stringify({ policy: 'lingxing-auto-approval-v1', sourceOperationId, id: after.id, version: after.version })).digest('hex');
  await tx.insert(sellerMappingRevisions).values({ operationId, sellerMappingId: after.id, version: after.version, actorUserId: actorId,
    requestHash, reason: '领星已授权店铺自动批准；人工资料审批与本地停用决定保留。',
    before: before?.lingxingData ? autoApprovalSnapshot(before, aliases) : {}, after: autoApprovalSnapshot(after, aliases) });
  await tx.insert(operationAudit).values({ id: randomUUID(), action: 'seller_mapping.auto_approve', targetId: after.id, actorUserId: actorId,
    requestHash, details: { operationId, sourceOperationId, source: 'lingxing', policy: 'lingxing-auto-approval-v1',
      version: String(after.version), sourceSha256: after.lingxingData?.sha256 ?? '', localDisabled: String(after.lingxingDisabled) } });
}

export async function getCatalogState(tx: CatalogTx, lock = false): Promise<CatalogRow> {
  const query = tx.select().from(sellerCatalogSettings).where(eq(sellerCatalogSettings.id, 'global'));
  const [row] = await (lock ? query.for('share') : query);
  if (!row) throw new CatalogError('CATALOG_NOT_INITIALIZED', 503, '店铺来源设置尚未初始化，请管理员完成迁移。');
  return row;
}

export async function lockCatalogState(tx: CatalogTx) {
  const [row] = await tx.select().from(sellerCatalogSettings).where(eq(sellerCatalogSettings.id, 'global')).for('update');
  if (!row) throw new CatalogError('CATALOG_NOT_INITIALIZED', 503, '店铺来源设置尚未初始化，请管理员完成迁移。');
  return row;
}

export function catalogSettingsView(row: CatalogRow): SellerCatalogSettings {
  const config = readConfig();
  const configured = Boolean(config.LINGXING_APP_ID?.trim() && (config.LINGXING_APP_SECRET?.trim() || config.LINGXING_ACCESS_TOKEN?.trim()))
    || Boolean(config.LINGXING_ENV_FILE?.trim() && existsSync(config.LINGXING_ENV_FILE));
  return { mode: row.mode as SellerCatalogSettings['mode'], version: row.version, catalogVersion: row.catalogVersion,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null, lastError: row.lastError, configured, readOnly: true };
}

export async function requireCatalogActor(tx: CatalogTx, actorId: string) {
  const [actor] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
  if (!actor || actor.banned || actor.role !== 'admin') throw new CatalogError('FORBIDDEN', 403, '仅有效管理员可以维护店铺来源。');
}

export async function replayCatalogOperation(tx: CatalogTx, operationId: string, actorId: string, requestHash: string) {
  const [previous] = await tx.select().from(sellerCatalogOperations).where(eq(sellerCatalogOperations.operationId, operationId));
  if (!previous) {
    const [revision] = await tx.select({ operationId: sellerMappingRevisions.operationId }).from(sellerMappingRevisions).where(eq(sellerMappingRevisions.operationId, operationId));
    if (revision) throw new CatalogError('OPERATION_CONFLICT', 409, '操作编号已经用于其他店铺维护请求。');
    return null;
  }
  if (previous.actorUserId !== actorId || previous.requestHash !== requestHash) throw new CatalogError('OPERATION_CONFLICT', 409, '操作编号已经用于其他店铺来源请求。');
  return { ...previous.result, replayed: true };
}

export async function getSellerCatalogSettings(actorId: string) {
  return db.transaction(async (tx) => {
    await requireCatalogActor(tx, actorId);
    return { settings: catalogSettingsView(await getCatalogState(tx)) };
  });
}

export async function setSellerCatalogMode(input: SellerCatalogModeInput, actorId: string): Promise<CatalogResult> {
  const requestHash = createHash('sha256').update(JSON.stringify({ kind: 'mode', actorId, ...input })).digest('hex');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
    await requireCatalogActor(tx, actorId);
    const replay = await replayCatalogOperation(tx, input.operationId, actorId, requestHash);
    if (replay) return replay as unknown as CatalogResult;
    const row = await lockCatalogState(tx);
    if (row.version !== input.expectedVersion) throw new CatalogError('VERSION_CONFLICT', 409, '店铺来源设置已经变化，请刷新后重新选择。');
    const [updated] = await tx.update(sellerCatalogSettings).set({ mode: input.mode, version: row.version + (row.mode === input.mode ? 0 : 1), updatedBy: actorId, updatedAt: new Date() }).where(eq(sellerCatalogSettings.id, 'global')).returning();
    const result: CatalogResult = { settings: catalogSettingsView(updated!), replayed: false };
    await tx.insert(sellerCatalogOperations).values({ operationId: input.operationId, kind: 'mode', actorUserId: actorId, requestHash, result });
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'seller_catalog.mode', targetId: input.operationId, actorUserId: actorId,
      requestHash, details: { mode: input.mode, version: String(updated!.version) } });
    return result;
  });
}

const remoteSellerSchema = z.object({ sid: z.number().int().positive().max(2147483647), name: z.string().trim().min(1).max(160),
  country: z.string().trim().min(1).max(80), marketplace_id: z.string().trim().min(1).nullable().optional(),
  status: z.union([z.string().trim().min(1).max(80), z.number().int()]).transform(String) });

export function validateLingxingSellers(payload: LingxingReadResult['payload']) {
  const parsed = z.array(remoteSellerSchema).min(1).max(10000).safeParse(payload.data);
  if (String(payload.code) !== '0' || !parsed.success || new Set(parsed.data.map((seller) => seller.sid)).size !== parsed.data.length) {
    throw new CatalogError('LINGXING_INVALID_CATALOG', 503, '领星店铺结果缺少有效身份、名称、国家或授权状态，或存在重复 sid；原目录已保留。');
  }
  return parsed.data;
}

type SyncDependencies = { querySellers?: () => Promise<LingxingReadResult> };
export async function syncSellerCatalog(input: SellerCatalogSyncInput, actorId: string, dependencies: SyncDependencies = {}): Promise<CatalogResult> {
  try { assertLingxingRequestsEnabled(); }
  catch (error) { if (error instanceof LingxingReadError) throw new CatalogError(error.code, 503, error.message); throw error; }
  const requestHash = createHash('sha256').update(JSON.stringify({ kind: 'sync', actorId, ...input })).digest('hex');
  const replay = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
    await requireCatalogActor(tx, actorId);
    const previous = await replayCatalogOperation(tx, input.operationId, actorId, requestHash);
    if (previous) return previous;
    const row = await getCatalogState(tx, true);
    if (row.version !== input.expectedVersion) throw new CatalogError('VERSION_CONFLICT', 409, '店铺来源设置已经变化，请刷新后重新同步。');
    return null;
  });
  if (replay) return replay as unknown as CatalogResult;
  let response: LingxingReadResult;
  let sellers: ReturnType<typeof validateLingxingSellers>;
  try {
    assertLingxingRequestsEnabled();
    response = await (dependencies.querySellers ? dependencies.querySellers() : (await createLingxingReadClient(readConfig())).listSellers());
    sellers = validateLingxingSellers(response.payload);
  } catch (error) {
    const safe = error instanceof LingxingReadError || error instanceof CatalogError
      ? { code: error.code, message: error.message } : { code: 'LINGXING_READ_FAILED', message: '领星店铺读取未完成，原目录与上次成功快照已保留。' };
    const completed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
      await requireCatalogActor(tx, actorId);
      const previous = await replayCatalogOperation(tx, input.operationId, actorId, requestHash);
      if (previous) return previous;
      const row = await lockCatalogState(tx);
      if (row.version === input.expectedVersion) await tx.update(sellerCatalogSettings).set({ lastError: safe, updatedBy: actorId, updatedAt: new Date() }).where(eq(sellerCatalogSettings.id, 'global'));
      return null;
    });
    if (completed) return completed as unknown as CatalogResult;
    throw new CatalogError(safe.code, 503, safe.message);
  }
  const observedAt = new Date();
  // Archive the observed business fields, never request URLs, tokens or secrets.
  const bytes = Buffer.from(JSON.stringify({ metadata: response.metadata, payload: { code: response.payload.code,
    data: sellers.map((seller) => ({ sid: seller.sid, name: seller.name, country: seller.country, marketplace_id: seller.marketplace_id ?? null, status: seller.status })) } }));
  let stagedFile: NewFileIndex | undefined;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
      await requireCatalogActor(tx, actorId);
      const previous = await replayCatalogOperation(tx, input.operationId, actorId, requestHash);
      if (previous) return previous as unknown as CatalogResult;
      const state = await lockCatalogState(tx);
      if (state.version !== input.expectedVersion) throw new CatalogError('VERSION_CONFLICT', 409, '同步期间店铺来源设置已经变化，结果未发布，请重新同步。');
      let result: CatalogResult | undefined;
      await storeImmutableFile(readConfig().dataDir, { bytes, originalName: `lingxing-sellers-${observedAt.toISOString().replace(/[:.]/g, '-')}.json`, mimeType: 'application/json', createdBy: actorId }, async (file) => {
        stagedFile = file;
        await tx.insert(fileIndex).values(file);
        const existing = await tx.select().from(sellerMappings).orderBy(asc(sellerMappings.id)).for('update');
        const bySid = new Map(sellers.map((seller) => [seller.sid, seller]));
        let updatedCount = 0;
        for (const row of existing) {
          const seller = bySid.get(row.sid);
          if (seller) {
            const promotes = !row.lingxingAutoApproved && seller.status === '1';
            const [updatedSeller] = await tx.update(sellerMappings).set({ lingxingAutoApproved: seller.status === '1',
              ...(promotes ? { version: row.version + 1, updatedAt: observedAt } : {}),
              lingxingData: { name: seller.name, country: seller.country, marketplaceId: seller.marketplace_id ?? null,
                status: seller.status, present: true, observedAt: observedAt.toISOString(), sha256: file.sha256, fileId: file.id } }).where(eq(sellerMappings.id, row.id)).returning();
            await recordAutoApproval(tx, row, updatedSeller!, actorId, input.operationId);
            updatedCount += 1;
            bySid.delete(row.sid);
          } else if (row.lingxingData) {
            await tx.update(sellerMappings).set({ lingxingAutoApproved: false, lingxingData: { ...row.lingxingData, present: false, observedAt: observedAt.toISOString(), sha256: file.sha256, fileId: file.id } }).where(eq(sellerMappings.id, row.id));
            updatedCount += 1;
          }
        }
        for (const seller of bySid.values()) {
          const [insertedSeller] = await tx.insert(sellerMappings).values({ id: randomUUID(), sid: seller.sid, name: seller.name, country: seller.country,
          marketplaceId: seller.marketplace_id ?? null, manualEnabled: false, status: 'candidate', version: 1, sourceObservedAt: observedAt,
          lingxingAutoApproved: seller.status === '1', lingxingDisabled: false,
          sourceSha256: file.sha256, sourceFileId: file.id, lingxingData: { name: seller.name, country: seller.country,
            marketplaceId: seller.marketplace_id ?? null, status: seller.status, present: true, observedAt: observedAt.toISOString(), sha256: file.sha256, fileId: file.id } }).returning();
          await recordAutoApproval(tx, null, insertedSeller!, actorId, input.operationId);
        }
        const [updated] = await tx.update(sellerCatalogSettings).set({ catalogVersion: state.catalogVersion + 1, sourceFileId: file.id,
          lastSyncedAt: observedAt, lastError: null, updatedBy: actorId, updatedAt: observedAt }).where(eq(sellerCatalogSettings.id, 'global')).returning();
        result = { settings: catalogSettingsView(updated!), inserted: bySid.size, updated: updatedCount, total: sellers.length, replayed: false };
        await tx.insert(sellerCatalogOperations).values({ operationId: input.operationId, kind: 'sync', actorUserId: actorId, requestHash, result });
        await tx.insert(operationAudit).values({ id: randomUUID(), action: 'seller_catalog.sync', targetId: file.id, actorUserId: actorId, requestHash,
          details: { operationId: input.operationId, count: String(sellers.length), catalogVersion: String(updated!.catalogVersion), sourceSha256: file.sha256, readOnly: 'true' } });
      });
      return result!;
    });
  } catch (error) {
    if (stagedFile) {
      const file = stagedFile;
      try {
        const [indexed] = await db.select({ id: fileIndex.id }).from(fileIndex).where(eq(fileIndex.id, file.id));
        if (!indexed) await unlink(resolve(readConfig().dataDir, file.storageKey)).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== 'ENOENT') throw failure; });
      } catch { /* Preserve a source file when the database commit outcome is unknown. */ }
    }
    throw error;
  }
}
