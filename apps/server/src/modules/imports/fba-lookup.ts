import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { z } from 'zod';
import { fbaLookupInputSchema, fbaLookupRecordSchema, type FbaLookupCandidate, type FbaLookupInput, type FbaLookupRecord, type FbaLookupRow } from '@scm/contracts';
import { db, pool } from '../../db/client.js';
import { fileIndex, operationAudit, sellerMappings, user } from '../../db/schema.js';
import { readConfig } from '../../config.js';
import { logError } from '../../errors.js';
import { storeImmutableFile } from '../../file-store.js';
import { BatchSyncError, fetchCompleteShipmentList } from '../batches/sync.js';
import { activeSeller, CatalogError, getCatalogState } from '../seller-mappings/catalog.js';
import { assertLingxingRequestsEnabled, createLingxingReadClient, LingxingReadError, type LingxingReadAttempt, type LingxingReadClient, type LingxingReadDependencies, type LingxingReadPayload } from '../lingxing/read-client.js';
import { fbaLookupRuns, fbaLookupSnapshots, type FbaLookupSellerScope } from './fba-lookup-schema.js';
import { ImportError } from './service.js';

export const FBA_LOOKUP_QUEUE = 'fba-metadata-lookup';
const MAX_PAGES = 20;
const REQUEST_BUDGET = 40;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Run = typeof fbaLookupRuns.$inferSelect;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const normalizedFba = (value: unknown) => text(value)?.toUpperCase() ?? '';
const sidValue = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;

export function inclusiveLookupEndDate(endDate: string): string {
  const date = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== endDate) throw new ImportError('VALIDATION_ERROR', 422, '货件创建截止日期无效。');
  date.setUTCDate(date.getUTCDate() + 1);
  const exclusive = date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exclusive)) throw new ImportError('VALIDATION_ERROR', 422, '货件创建截止日期超出支持范围。');
  return exclusive;
}

export function formatLookupDestinationAddress(value: unknown): string | null {
  const address = object(value);
  const parts = ['name', 'address_line1', 'address_line2', 'doorplate', 'region', 'city', 'state_or_province_code', 'postal_code', 'country_code']
    .map((key) => text(address[key])).filter((part): part is string => part !== null);
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

/** A partial list is never passed here: only a completed, verified pagination can identify a shop. */
export function projectFbaLookupRows(
  fbas: readonly string[], scope: readonly FbaLookupSellerScope[], listing: readonly Record<string, unknown>[], observedAt: string,
): FbaLookupRow[] {
  const requested = new Set(fbas);
  const sellers = new Map(scope.map((seller) => [seller.sid, seller]));
  const candidates = new Map<string, FbaLookupCandidate[]>();
  const seen = new Set<string>();
  for (const row of listing) {
    const sid = sidValue(row.sid);
    const fba = normalizedFba(row.shipment_id);
    const seller = sellers.get(sid);
    if (!Number.isSafeInteger(sid) || !seller || !requested.has(fba)) throw new ImportError('LOOKUP_SCOPE_MISMATCH', 503, '领星返回的货件不属于本次店铺或 FBA 范围，未发布补全结果。');
    const identity = `${sid}:${fba}`;
    if (seen.has(identity)) throw new ImportError('LOOKUP_DUPLICATE_SHIPMENT', 503, '领星列表出现重复的店铺和 FBA，无法确认唯一结果。');
    seen.add(identity);
    const candidate: FbaLookupCandidate = { sid, shop: seller.name, country: seller.country,
      channel: null, channelStatus: 'unavailable', channelOptions: [],
      destinationFc: text(row.destination_fulfillment_center_id), destinationAddress: formatLookupDestinationAddress(row.ship_to_address),
      shipmentCreatedAt: text(row.gmt_create), observedAt };
    candidates.set(fba, [...candidates.get(fba) ?? [], candidate]);
  }
  return fbas.map((fba) => {
    const matches = (candidates.get(fba) ?? []).sort((left, right) => left.sid - right.sid);
    return { fba, status: matches.length === 1 ? 'unique' : matches.length ? 'ambiguous' : 'not_found', candidates: matches };
  });
}

/** Keep metadata evidence without persisting products, boxes, credentials or remote error text. */
export function lookupMetadataSnapshot(attempt: LingxingReadAttempt, params: Readonly<Record<string, unknown>>) {
  const payload = object(attempt.payload);
  const source = object(payload.data).list;
  const keys = ['sid', 'shipment_id', 'seller', 'destination_fulfillment_center_id', 'gmt_create', 'gmt_modified', 'shipping_mode', 'shipping_solution', 'alpha_code', 'alpha_name', 'sta_shipment_date', 'sta_delivery_start_date', 'sta_delivery_end_date', 'shipped_time'];
  const addressKeys = ['name', 'country_code', 'state_or_province_code', 'city', 'region', 'address_line1', 'address_line2', 'postal_code', 'doorplate'];
  return { schemaVersion: 'fba-lookup-metadata-v1', request: { sid: params.sid, shipment_id: params.shipment_id, start_date: params.start_date,
    end_date: params.end_date, offset: params.offset, length: params.length }, metadata: attempt.metadata, errorCode: attempt.errorCode ?? null,
    response: { code: attempt.metadata.businessCode, total: typeof payload.total === 'number' || typeof payload.total === 'string' ? payload.total : null,
      list: Array.isArray(source) ? source.map((value) => {
        const row = object(value), address = object(row.ship_to_address);
        return { ...Object.fromEntries(keys.map((key) => [key, typeof row[key] === 'string' || typeof row[key] === 'number' ? row[key] : null])),
          ship_to_address: Object.fromEntries(addressKeys.map((key) => [key, text(address[key])])) };
      }) : null } };
}

function serializeLookup(run: Run): FbaLookupRecord {
  // Transport methods are supplied by the source. Historical lookup values
  // remain in stored evidence, but are never replayed into manual channel input.
  const rows = run.status === 'completed' ? run.rows.map((row) => ({ ...row, candidates: row.candidates.map((candidate) => {
    return { ...candidate, channel: null, channelSource: undefined, channelStatus: 'unavailable' as const, channelOptions: [], channelIssue: undefined };
  }) })) : [];
  return fbaLookupRecordSchema.parse({ id: run.id, status: run.status as FbaLookupRecord['status'], startDate: run.startDate, endDate: run.endDate, fbas: run.fbas,
    catalogMode: run.catalogMode as FbaLookupRecord['catalogMode'], catalogSettingsVersion: run.catalogSettingsVersion, catalogVersion: run.catalogVersion,
    createdAt: run.createdAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null, errorCode: run.errorCode, errorMessage: run.errorMessage,
    rows });
}
async function requireActor(tx: Tx, actorId: string) {
  const [actor] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
  if (!actor || actor.banned || actor.role !== 'admin') throw new ImportError('FORBIDDEN', 403, '当前账号没有 FBA 查询权限。');
}
async function sellerScope(tx: Tx, mode: string) {
  const all = await tx.select().from(sellerMappings).orderBy(asc(sellerMappings.sid));
  return all.flatMap((row) => {
    const seller = activeSeller(row, mode);
    // Candidate/approved controls automatic alias matching, not permission to
    // read an enabled shop. Import confirmation can explicitly adopt either.
    return seller && seller.status !== 'disabled' ? [{ id: seller.id, sid: seller.sid, name: seller.name, country: seller.country, version: seller.version }] : [];
  });
}
async function validateRun(tx: Tx, run: Run) {
  await requireActor(tx, run.createdBy);
  const state = await getCatalogState(tx, true);
  if (state.mode !== run.catalogMode || state.version !== run.catalogSettingsVersion || state.catalogVersion !== run.catalogVersion) throw new ImportError('CATALOG_VERSION_CONFLICT', 409, '查询期间店铺来源或目录已经变化，请重新查询。');
  const current = await sellerScope(tx, state.mode);
  if (JSON.stringify(current) !== JSON.stringify(run.sellerScope)) throw new ImportError('CATALOG_VERSION_CONFLICT', 409, '查询期间可用店铺已经变化，请重新查询。');
}
function failure(error: unknown) {
  if (error instanceof ImportError || error instanceof CatalogError || error instanceof LingxingReadError || error instanceof BatchSyncError) return { code: error.code, message: error.message };
  return { code: 'FBA_LOOKUP_FAILED', message: 'FBA 查询未完成，已保留查询快照，请重新查询。' };
}

export async function requestFbaLookup(boss: PgBoss, raw: FbaLookupInput, actorId: string): Promise<FbaLookupRecord> {
  try { assertLingxingRequestsEnabled(); }
  catch (error) { const safe = failure(error); throw new ImportError(safe.code, 503, safe.message); }
  const parsed = fbaLookupInputSchema.safeParse(raw);
  if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '请核对 FBA、店铺来源版本和货件创建日期范围。');
  const input = { ...parsed.data, fbas: [...new Set(parsed.data.fbas)].sort() };
  inclusiveLookupEndDate(input.endDate);
  const requestHash = createHash('sha256').update(JSON.stringify({ actorId, ...input })).digest('hex');
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId},0))`);
      await requireActor(tx, actorId);
      const [old] = await tx.select().from(fbaLookupRuns).where(eq(fbaLookupRuns.operationId, input.operationId));
      if (old) {
        if (old.createdBy !== actorId || old.requestHash !== requestHash) throw new ImportError('OPERATION_CONFLICT', 409, '该操作编号已用于其他 FBA 查询。');
        return serializeLookup(old);
      }
      const state = await getCatalogState(tx, true);
      if (state.version !== input.expectedCatalogSettingsVersion || state.catalogVersion !== input.expectedCatalogVersion) throw new ImportError('CATALOG_VERSION_CONFLICT', 409, '店铺来源或目录已经变化，请刷新后重新查询。');
      const scope = await sellerScope(tx, state.mode);
      if (!scope.length) throw new ImportError('NO_AVAILABLE_SELLERS', 422, '当前店铺来源没有可用店铺，请先维护店铺目录。');
      const id = randomUUID();
      await tx.insert(fbaLookupRuns).values({ id, operationId: input.operationId, requestHash, startDate: input.startDate, endDate: input.endDate,
        fbas: input.fbas, catalogMode: state.mode, catalogSettingsVersion: state.version, catalogVersion: state.catalogVersion, sellerScope: scope,
        maxPages: MAX_PAGES, requestBudget: REQUEST_BUDGET, createdBy: actorId });
      const jobId = await boss.send(FBA_LOOKUP_QUEUE, { lookupId: id }, { db: fromDrizzle(tx, sql), retryLimit: 0, expireInSeconds: 1200 });
      if (!jobId) throw new ImportError('QUEUE_UNAVAILABLE', 503, 'FBA 查询未能入队，请稍后重试。');
      const [record] = await tx.update(fbaLookupRuns).set({ queueJobId: jobId }).where(eq(fbaLookupRuns.id, id)).returning();
      await tx.insert(operationAudit).values({ id: randomUUID(), action: 'fba_lookup.submit', targetId: id, actorUserId: actorId, requestHash,
        details: { operationId: input.operationId, fbaCount: String(input.fbas.length), sellerCount: String(scope.length), catalogMode: state.mode,
          catalogSettingsVersion: String(state.version), catalogVersion: String(state.catalogVersion), readOnly: 'true' } });
      return serializeLookup(record!);
    });
  } catch (error) {
    if (error instanceof CatalogError) throw new ImportError(error.code, error.status, error.message);
    throw error;
  }
}

export async function getFbaLookup(id: string, actorId: string): Promise<FbaLookupRecord> {
  if (!z.uuid().safeParse(id).success) throw new ImportError('VALIDATION_ERROR', 422, 'FBA 查询编号无效。');
  return db.transaction(async (tx) => {
    await requireActor(tx, actorId);
    const [record] = await tx.select().from(fbaLookupRuns).where(eq(fbaLookupRuns.id, id));
    if (!record) throw new ImportError('NOT_FOUND', 404, 'FBA 查询不存在。');
    return serializeLookup(record);
  });
}

async function archiveAttempt(run: Run, page: number, params: Readonly<Record<string, unknown>>, attempt: LingxingReadAttempt) {
  const bytes = Buffer.from(JSON.stringify(lookupMetadataSnapshot(attempt, params)));
  const file = await storeImmutableFile(readConfig().dataDir, { bytes, originalName: `fba-lookup-${run.id}-${page}-${attempt.metadata.attempt}.json`, mimeType: 'application/json', createdBy: run.createdBy }, async () => {});
  try {
    await db.transaction(async (tx) => {
      await tx.insert(fileIndex).values(file);
      await tx.insert(fbaLookupSnapshots).values({ id: randomUUID(), runId: run.id, page, attempt: attempt.metadata.attempt, fileId: file.id,
        successful: !attempt.errorCode && attempt.metadata.businessCode === '0' && attempt.metadata.httpStatus >= 200 && attempt.metadata.httpStatus < 300 ? 1 : 0 });
    });
  } catch (error) {
    // Only an explicit pre-commit application error proves rollback. Keep bytes
    // on uncertain database outcomes so a committed snapshot never loses its file.
    if (error instanceof ImportError) {
      const [indexed] = await db.select({ id: fileIndex.id }).from(fileIndex).where(eq(fileIndex.id, file.id));
      if (!indexed) {
        const path = resolve(readConfig().dataDir, file.storageKey), suffix = relative(readConfig().dataDir, path);
        if (suffix && !suffix.startsWith('..') && !isAbsolute(suffix)) await unlink(path).catch(() => undefined);
      }
    }
    throw error;
  }
}

export type FbaLookupDependencies = { createClient?: (dependencies: LingxingReadDependencies) => Promise<Pick<LingxingReadClient, 'read'>> };
export async function executeFbaLookup(id: string, dependencies: FbaLookupDependencies = {}) {
  const connection = await pool.connect(); let locked = false;
  try {
    const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`fba-lookup:${id}`]);
    locked = result.rows[0]?.locked ?? false;
    if (!locked) return;
    try { await executeLockedLookup(id, dependencies); }
    catch (error) {
      const safe = failure(error);
      await db.update(fbaLookupRuns).set({ status: 'failed', rows: [], errorCode: safe.code, errorMessage: safe.message, completedAt: new Date() })
        .where(and(eq(fbaLookupRuns.id, id), inArray(fbaLookupRuns.status, ['queued', 'running'])));
      throw error;
    }
  } finally {
    let failedUnlock = false;
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`fba-lookup:${id}`]); }
    catch { failedUnlock = true; }
    finally { connection.release(failedUnlock); }
  }
}

async function executeLockedLookup(id: string, dependencies: FbaLookupDependencies) {
  assertLingxingRequestsEnabled();
  const run = await db.transaction(async (tx) => {
    const [record] = await tx.select().from(fbaLookupRuns).where(eq(fbaLookupRuns.id, id)).for('update');
    if (!record || record.status !== 'queued') return null;
    await validateRun(tx, record);
    await tx.update(fbaLookupRuns).set({ status: 'running', startedAt: new Date() }).where(eq(fbaLookupRuns.id, id));
    return record;
  });
  if (!run) return;
  let page = 0, params: Record<string, unknown> = {}, observedAt = '';
  const hooks: LingxingReadDependencies = {
    beforeRequest: async (operation) => {
      if (operation !== 'listShipments') throw new ImportError('LOOKUP_OPERATION_DENIED', 422, 'FBA 补全只允许查询货件元数据。');
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(fbaLookupRuns).where(eq(fbaLookupRuns.id, id)).for('update');
        if (!current || current.status !== 'running') throw new ImportError('LOOKUP_NOT_RUNNING', 409, 'FBA 查询已中断，结果不会发布。');
        await validateRun(tx, current);
        if (current.requestsUsed >= current.requestBudget) throw new ImportError('REQUEST_BUDGET_EXHAUSTED', 422, '达到本次 FBA 查询请求上限，请缩小范围后重新查询。');
        await tx.update(fbaLookupRuns).set({ requestsUsed: current.requestsUsed + 1 }).where(eq(fbaLookupRuns.id, id));
      });
    },
    onAttempt: async (attempt) => {
      await archiveAttempt(run, page, params, attempt);
      if (attempt.errorCode === 'LINGXING_RATE_LIMITED') throw new ImportError('LINGXING_RATE_LIMITED', 503, '领星限流，本次补全已停止，请稍后重新查询。');
    },
  };
  const client = dependencies.createClient ? await dependencies.createClient(hooks) : await createLingxingReadClient(readConfig(), hooks);
  const listing = await fetchCompleteShipmentList(async (pagination, nextPage): Promise<LingxingReadPayload> => {
    page = nextPage;
    params = { sid: run.sellerScope.map((seller) => seller.sid).join(','), shipment_id: run.fbas.join(','), start_date: run.startDate,
      end_date: inclusiveLookupEndDate(run.endDate), ...pagination };
    const result = await client.read('listShipments', params);
    if (result.metadata.requestedAt > observedAt) observedAt = result.metadata.requestedAt;
    return result.payload;
  }, run.maxPages);
  const rows = projectFbaLookupRows(run.fbas, run.sellerScope, listing.rows, observedAt || new Date().toISOString());
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(fbaLookupRuns).where(eq(fbaLookupRuns.id, id)).for('update');
    if (!current || current.status !== 'running') throw new ImportError('LOOKUP_NOT_RUNNING', 409, 'FBA 查询已经中断，结果未发布。');
    await validateRun(tx, current);
    await tx.update(fbaLookupRuns).set({ status: 'completed', rows, completedAt: new Date(), errorCode: null, errorMessage: null }).where(eq(fbaLookupRuns.id, id));
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'fba_lookup.complete', targetId: id, actorUserId: run.createdBy,
      requestHash: run.requestHash, details: { fbaCount: String(rows.length), pages: String(listing.pages), channelLookup: 'manual', readOnly: 'true' } });
  });
}

export async function reconcileFbaLookups(boss: PgBoss, id?: string) {
  const runs = await db.select().from(fbaLookupRuns).where(and(inArray(fbaLookupRuns.status, ['queued', 'running']), id ? eq(fbaLookupRuns.id, id) : undefined)).limit(100);
  for (const run of runs) {
    if (!run.queueJobId) continue;
    const [job] = await boss.findJobs(FBA_LOOKUP_QUEUE, { id: run.queueJobId });
    const orphanedActive = run.status === 'running' && job?.state === 'active';
    if (!orphanedActive && job && !['failed', 'cancelled', 'completed'].includes(job.state)) continue;
    const connection = await pool.connect(); let locked = false;
    try {
      const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`fba-lookup:${run.id}`]);
      locked = result.rows[0]?.locked ?? false;
      if (!locked) continue;
      await db.update(fbaLookupRuns).set({ status: 'failed', rows: [], errorCode: 'LOOKUP_INTERRUPTED', errorMessage: 'FBA 查询已中断或超时，未发布补全结果，请重新查询。', completedAt: new Date() })
        .where(and(eq(fbaLookupRuns.id, run.id), eq(fbaLookupRuns.queueJobId, run.queueJobId), inArray(fbaLookupRuns.status, orphanedActive ? ['running'] : ['queued', 'running'])));
    } finally {
      let failedUnlock = false;
      try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`fba-lookup:${run.id}`]); }
      catch { failedUnlock = true; }
      finally { connection.release(failedUnlock); }
    }
  }
}

export async function registerFbaLookupWorker(boss: PgBoss) {
  await boss.createQueue(FBA_LOOKUP_QUEUE, { retryLimit: 0, expireInSeconds: 1200, deleteAfterSeconds: 0 });
  await boss.work(FBA_LOOKUP_QUEUE, async ([job]) => {
    if (!job) return;
    const { lookupId } = z.object({ lookupId: z.uuid() }).parse(job.data);
    try { await executeFbaLookup(lookupId); }
    catch { throw new Error('FBA metadata lookup failed'); }
  });
  const interval = setInterval(() => void reconcileFbaLookups(boss).catch((error) => logError('FBA lookup reconciliation failed', error)), 5_000);
  interval.unref();
  return () => clearInterval(interval);
}
