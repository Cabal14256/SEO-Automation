import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ManualSellerCreateInput, SellerAliasRevisionInput, SellerMapping, SellerMappingRevisionInput } from '@scm/contracts';
import { manualSellerCreateSchema, sellerAliasRevisionSchema, sellerMappingRevisionSchema } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demands, operationAudit, sellerAliases, sellerCatalogOperations, sellerCatalogSettings, sellerMappingRevisions, sellerMappings, user } from '../../db/schema.js';
import { errorCode } from '../../errors.js';
import { activeSeller, catalogSettingsView, getCatalogState, lockCatalogState, replayCatalogOperation, type CatalogTx } from './catalog.js';
import { findApprovedSellers } from './resolution.js';

export class MappingError extends Error {
  constructor(public code: string, public status: 403 | 404 | 409 | 422, message: string) { super(message); }
}

export const normalizeAlias = (value: string) => value.normalize('NFKC').trim().toLowerCase();
type Row = typeof sellerMappings.$inferSelect;
const approvedSnapshot = (snapshot: Record<string, unknown>, mode: SellerMapping['dataSource']) => (snapshot.dataSource ?? 'manual') === mode
  && (snapshot.status === 'approved' || snapshot.hasApprovedBefore === true);
async function wasApproved(tx: CatalogTx, row: Row, mode: SellerMapping['dataSource']) {
  if (activeSeller(row, mode)?.status === 'approved') return true;
  const revisions = await tx.select({ before: sellerMappingRevisions.before, after: sellerMappingRevisions.after }).from(sellerMappingRevisions)
    .where(eq(sellerMappingRevisions.sellerMappingId, row.id));
  return revisions.some((revision) => approvedSnapshot(revision.before, mode) || approvedSnapshot(revision.after, mode));
}

function serialize(row: Row, aliases: string[], mode: SellerMapping['dataSource'], identityLocked: boolean, hasApprovedBefore: boolean): SellerMapping {
  return { id: row.id, sid: row.sid, name: row.name, country: row.country, marketplaceId: row.marketplaceId,
    wid: row.wid, aliases: aliases.sort(), status: row.status as SellerMapping['status'], version: row.version,
    updatedAt: row.updatedAt.toISOString(), sourceObservedAt: row.sourceObservedAt.toISOString(), sourceSha256: row.sourceSha256,
    dataSource: mode, manualEnabled: row.manualEnabled, lingxingName: row.lingxingData?.name ?? null,
    lingxingStatus: row.lingxingData?.status ?? null, identityLocked, hasApprovedBefore,
    autoApproved: mode === 'lingxing' && row.lingxingAutoApproved };
}

export async function listSellerMappings(query: { page: number; pageSize: number; search: string; status?: string }) {
  return db.transaction(async (tx) => {
    const state = await getCatalogState(tx);
    const mode = state.mode as SellerMapping['dataSource'];
    const allRows = await tx.select().from(sellerMappings).orderBy(asc(sellerMappings.sid), asc(sellerMappings.id));
    const aliases = allRows.length ? await tx.select().from(sellerAliases).where(inArray(sellerAliases.sellerMappingId, allRows.map((row) => row.id))) : [];
    const search = normalizeAlias(query.search);
    const matching = allRows.flatMap((row) => {
      const active = activeSeller(row, mode);
      if (!active || (query.status && active.status !== query.status)) return [];
      const names = aliases.filter((alias) => alias.sellerMappingId === row.id).map((alias) => alias.alias);
      return search && !normalizeAlias([active.name, active.country, active.sid, ...names].join(' ')).includes(search) ? [] : [{ row: active, aliases: names }];
    });
    const page = matching.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
    const referenced = page.length ? await tx.select({ sid: demands.sid }).from(demands).where(inArray(demands.sid, page.map((entry) => entry.row.sid))) : [];
    const lockedSids = new Set(referenced.map((demand) => demand.sid));
    const revisions = page.length ? await tx.select({ sellerMappingId: sellerMappingRevisions.sellerMappingId, before: sellerMappingRevisions.before, after: sellerMappingRevisions.after })
      .from(sellerMappingRevisions).where(inArray(sellerMappingRevisions.sellerMappingId, page.map((entry) => entry.row.id))) : [];
    const approvedIds = new Set([...allRows.filter((row) => activeSeller(row, mode)?.status === 'approved').map((row) => row.id),
      ...revisions.filter((revision) => approvedSnapshot(revision.before, mode) || approvedSnapshot(revision.after, mode)).map((revision) => revision.sellerMappingId)]);
    return { items: page.map((entry) => serialize(entry.row, entry.aliases, mode, Boolean(entry.row.lingxingData) || lockedSids.has(entry.row.sid), approvedIds.has(entry.row.id))),
      total: matching.length, page: query.page, pageSize: query.pageSize, settings: catalogSettingsView(state) };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function history(id: string) {
  const [mapping] = await db.select({ id: sellerMappings.id }).from(sellerMappings).where(eq(sellerMappings.id, id));
  if (!mapping) throw new MappingError('NOT_FOUND', 404, '店铺映射不存在。');
  const items = await db.select({ operationId: sellerMappingRevisions.operationId, version: sellerMappingRevisions.version,
    actorUserId: sellerMappingRevisions.actorUserId, reason: sellerMappingRevisions.reason, createdAt: sellerMappingRevisions.createdAt,
    before: sellerMappingRevisions.before, after: sellerMappingRevisions.after }).from(sellerMappingRevisions)
    .where(eq(sellerMappingRevisions.sellerMappingId, id)).orderBy(desc(sellerMappingRevisions.version)).limit(100);
  return { items: items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })) };
}

export async function reviseSellerMapping(id: string, input: SellerMappingRevisionInput, actorUserId: string) {
  const parsed = sellerMappingRevisionSchema.safeParse(input);
  if (!parsed.success) throw new MappingError('VALIDATION_ERROR', 422, '请检查店铺字段、别名和变更原因。');
  return saveSellerRevision(id, { kind: 'manual', input: parsed.data }, actorUserId);
}

export async function reviseSellerAliases(id: string, input: SellerAliasRevisionInput, actorUserId: string) {
  const parsed = sellerAliasRevisionSchema.safeParse(input);
  if (!parsed.success) throw new MappingError('VALIDATION_ERROR', 422, '请检查需求别名、批准状态和变更原因。');
  return saveSellerRevision(id, { kind: 'aliases', input: parsed.data }, actorUserId);
}

type SellerRevision = { kind: 'manual'; input: SellerMappingRevisionInput } | { kind: 'aliases'; input: SellerAliasRevisionInput };

async function saveSellerRevision(id: string, revision: SellerRevision, actorUserId: string) {
  const { input } = revision;
  const hash = createHash('sha256').update(JSON.stringify({ ...(revision.kind === 'aliases' ? { kind: 'aliases' } : {}), id, actorUserId, ...input })).digest('hex');
  try {
    return await db.transaction(async (tx) => {
      // Serialize operation IDs across processes before reading the replay result.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
      const [actor] = await tx.select().from(user).where(eq(user.id, actorUserId)).for('share');
      if (!actor || actor.banned || actor.role !== 'admin') throw new MappingError('FORBIDDEN', 403, '仅管理员可以维护店铺映射。');
      const [existing] = await tx.select().from(sellerMappingRevisions).where(eq(sellerMappingRevisions.operationId, input.operationId));
      if (existing) {
        if (existing.requestHash !== hash) throw new MappingError('OPERATION_CONFLICT', 409, '操作编号已用于另一请求，请刷新核对。');
        return { mapping: existing.after as unknown as SellerMapping, replayed: true };
      }
      const [otherOperation] = await tx.select({ operationId: sellerCatalogOperations.operationId }).from(sellerCatalogOperations).where(eq(sellerCatalogOperations.operationId, input.operationId));
      if (otherOperation) throw new MappingError('OPERATION_CONFLICT', 409, '操作编号已经用于其他店铺维护请求。');
      const state = await lockCatalogState(tx);
      if (revision.kind === 'manual' && state.mode !== 'manual') throw new MappingError('CATALOG_READ_ONLY', 409, '领星店铺身份字段只读；请使用本地别名审批入口，或切换人工维护后修改人工资料。');
      if (revision.kind === 'aliases' && (state.mode !== 'lingxing' || state.version !== revision.input.expectedCatalogSettingsVersion || state.catalogVersion !== revision.input.expectedCatalogVersion)) {
        throw new MappingError('SELLER_CATALOG_CONFLICT', 409, '店铺来源设置或领星目录已变化，请刷新目录后重新核对别名和批准状态。');
      }
      const [row] = await tx.select().from(sellerMappings).where(eq(sellerMappings.id, id)).for('update');
      if (!row) throw new MappingError('NOT_FOUND', 404, '店铺映射不存在。');
      if (revision.kind === 'manual' && !row.manualEnabled) throw new MappingError('MANUAL_PROFILE_REQUIRED', 409, '请先为该 sid 新增人工店铺资料。');
      if (row.version !== input.expectedVersion) throw new MappingError('VERSION_CONFLICT', 409, '店铺映射已被更新，请刷新核对后重新提交。');
      const mode = revision.kind === 'aliases' ? 'lingxing' : 'manual';
      const active = activeSeller(row, mode);
      if (revision.kind === 'aliases' && !active) throw new MappingError('SELLER_UNAVAILABLE', 409, '该店铺已不在当前领星目录中，请刷新目录后核对。');
      if (revision.kind === 'aliases' && input.status === 'approved' && (row.lingxingData?.status !== '1' || !row.lingxingAutoApproved)) {
        throw new MappingError('SELLER_NOT_AUTHORIZED', 409, '该店铺的领星授权当前不可用，不能批准；请恢复授权并同步目录后核对。');
      }
      const [referenced] = row.lingxingData ? [] : await tx.select({ id: demands.id }).from(demands).where(eq(demands.sid, row.sid)).limit(1);
      const identityLocked = Boolean(row.lingxingData) || Boolean(referenced);
      const sid = revision.kind === 'manual' ? revision.input.sid ?? row.sid : row.sid;
      if (sid !== row.sid) {
        if (identityLocked) throw new MappingError('SID_IMMUTABLE', 409, '该 sid 已有领星身份或需求引用，不能原地更改；历史需求身份保持不变。');
        const [duplicate] = await tx.select({ id: sellerMappings.id }).from(sellerMappings).where(eq(sellerMappings.sid, sid)).limit(1);
        if (duplicate) throw new MappingError('SID_CONFLICT', 409, '该 sid 已存在，请维护对应店铺，不能覆盖其身份。');
      }
      const oldAliases = await tx.select().from(sellerAliases).where(eq(sellerAliases.sellerMappingId, id));
      const hasApprovedBefore = await wasApproved(tx, row, mode);
      const firstApproval = revision.kind === 'manual' && row.status === 'candidate' && !hasApprovedBefore && input.status === 'approved';
      if (!input.reason && !(firstApproval && input.identityConfirmed === true)) {
        throw new MappingError('VALIDATION_ERROR', 422, '本次操作需填写修改原因；仅首次批准可勾选“已核对店铺身份”后保存。');
      }
      const identity = active ?? row;
      const before = serialize(identity, oldAliases.map((alias) => alias.alias), mode, identityLocked, hasApprovedBefore);
      // Local alias approval never changes remote identity or enables a manual profile.
      const changes = { ...(revision.kind === 'manual' ? { sid, name: revision.input.name, country: revision.input.country,
        marketplaceId: revision.input.marketplaceId, wid: revision.input.wid, status: input.status }
        : { lingxingDisabled: input.status === 'disabled' }), version: row.version + 1, updatedAt: new Date() };
      const [updated] = await tx.update(sellerMappings).set(changes)
        .where(and(eq(sellerMappings.id, id), eq(sellerMappings.version, input.expectedVersion))).returning();
      if (!updated) throw new MappingError('VERSION_CONFLICT', 409, '店铺映射已被更新，请刷新核对。');
      await tx.delete(sellerAliases).where(eq(sellerAliases.sellerMappingId, id));
      if (input.aliases.length) await tx.insert(sellerAliases).values(input.aliases.map((alias) => ({ alias, normalizedAlias: normalizeAlias(alias), sellerMappingId: id })));
      const after = serialize(activeSeller(updated, mode) ?? updated, [...input.aliases], mode, identityLocked, hasApprovedBefore || input.status === 'approved');
      const reason = input.reason || `首次批准：已核对店铺身份（${after.name}，sid ${after.sid}，${after.country}）。`;
      await tx.insert(sellerMappingRevisions).values({ operationId: input.operationId, sellerMappingId: id, version: after.version,
        actorUserId, requestHash: hash, reason, before: { ...before }, after: { ...after } });
      await tx.insert(operationAudit).values({ id: randomUUID(), action: revision.kind === 'aliases' ? 'seller_mapping.aliases' : 'seller_mapping.revise', targetId: id,
        actorUserId, requestHash: hash, details: { operationId: input.operationId, version: String(after.version), reason,
          ...(input.identityConfirmed === true ? { identityConfirmed: 'true' } : {}),
          ...(revision.kind === 'aliases' ? { source: 'lingxing', status: input.status, catalogVersion: String(state.catalogVersion) } : {}) } });
      await tx.update(sellerCatalogSettings).set({ catalogVersion: state.catalogVersion + 1, updatedBy: actorUserId, updatedAt: new Date() }).where(eq(sellerCatalogSettings.id, 'global'));
      return { mapping: after, replayed: false };
    });
  } catch (error) {
    if (errorCode(error) === '23505') {
      throw new MappingError('ALIAS_CONFLICT', 409, '别名已分配给其他店铺，请核对，不能自动覆盖。');
    }
    throw error;
  }
}

export async function createManualSeller(input: ManualSellerCreateInput, actorUserId: string) {
  const parsed = manualSellerCreateSchema.safeParse(input);
  if (!parsed.success) throw new MappingError('VALIDATION_ERROR', 422, '请核对人工店铺 sid、显示名称和国家。');
  input = parsed.data;
  const requestHash = createHash('sha256').update(JSON.stringify({ kind: 'manual_create', actorUserId, ...input })).digest('hex');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
    const [actor] = await tx.select().from(user).where(eq(user.id, actorUserId)).for('share');
    if (!actor || actor.banned || actor.role !== 'admin') throw new MappingError('FORBIDDEN', 403, '仅管理员可以新增人工店铺。');
    const replay = await replayCatalogOperation(tx, input.operationId, actorUserId, requestHash);
    if (replay) return replay as unknown as { mapping: SellerMapping; replayed: boolean };
    const state = await lockCatalogState(tx);
    if (state.mode !== 'manual') throw new MappingError('CATALOG_READ_ONLY', 409, '请切换到人工维护后新增人工店铺资料。');
    const [existing] = await tx.select().from(sellerMappings).where(eq(sellerMappings.sid, input.sid)).for('update');
    if (existing?.manualEnabled) throw new MappingError('SID_CONFLICT', 409, '该 sid 已有人工资料，请直接维护已有店铺。');
    const hasApprovedBefore = existing ? await wasApproved(tx, existing, 'manual') : false;
    const now = new Date();
    const sourceHash = createHash('sha256').update(JSON.stringify({ source: 'manual', sid: input.sid, name: input.name, country: input.country, operationId: input.operationId })).digest('hex');
    const [row] = existing ? await tx.update(sellerMappings).set({ name: input.name, country: input.country, manualEnabled: true, status: 'candidate',
      version: existing.version + 1, sourceObservedAt: now, sourceSha256: sourceHash, sourceFileId: null, updatedAt: now }).where(eq(sellerMappings.id, existing.id)).returning()
      : await tx.insert(sellerMappings).values({ id: randomUUID(), sid: input.sid, name: input.name, country: input.country,
        manualEnabled: true, status: 'candidate', sourceObservedAt: now, sourceSha256: sourceHash, updatedAt: now }).returning();
    const aliases = existing ? await tx.select().from(sellerAliases).where(eq(sellerAliases.sellerMappingId, existing.id)) : [];
    const [referenced] = await tx.select({ id: demands.id }).from(demands).where(eq(demands.sid, input.sid)).limit(1);
    const mapping = serialize(row!, aliases.map((alias) => alias.alias), 'manual', Boolean(row!.lingxingData) || Boolean(referenced), hasApprovedBefore);
    const result = { mapping, replayed: false };
    await tx.insert(sellerCatalogOperations).values({ operationId: input.operationId, kind: 'manual_create', actorUserId, requestHash, result });
    await tx.insert(sellerMappingRevisions).values({ operationId: input.operationId, sellerMappingId: row!.id, version: row!.version, actorUserId,
      requestHash, reason: existing ? '启用人工店铺资料' : '新增人工店铺资料', before: existing?.manualEnabled ? { ...serialize(existing, aliases.map((alias) => alias.alias), 'manual', true, hasApprovedBefore) } : {}, after: { ...mapping } });
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'seller_mapping.manual_create', targetId: row!.id, actorUserId,
      requestHash, details: { operationId: input.operationId, sid: String(input.sid), source: 'manual' } });
    await tx.update(sellerCatalogSettings).set({ catalogVersion: state.catalogVersion + 1, updatedBy: actorUserId, updatedAt: now }).where(eq(sellerCatalogSettings.id, 'global'));
    return result;
  });
}

// Only one approved exact name/alias match may resolve; ambiguity stays manual.
export async function resolveApprovedSeller(sourceName: string) {
  return db.transaction(async (tx) => {
    const state = await getCatalogState(tx);
    const stored = await tx.select().from(sellerMappings);
    const aliases = await tx.select().from(sellerAliases);
    const sellers = stored.flatMap((entry) => {
      const row = activeSeller(entry, state.mode);
      return row ? [{ ...row, aliases: aliases.filter((alias) => alias.sellerMappingId === row.id).map((alias) => alias.alias) }] : [];
    });
    const matches = findApprovedSellers(sourceName, sellers);
    const row = matches.length === 1 ? matches[0] : null;
    return row ? { id: row.id, sid: row.sid, country: row.country, marketplaceId: row.marketplaceId, wid: row.wid, version: row.version } : null;
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
