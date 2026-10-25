import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { IMPORT_MAX_BYTES, IMPORT_PARSER_VERSION, type ImportAccepted, type ImportParseInput, type ImportRun, type SourceImport } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demandSources, fileIndex, importOperations, importParseRuns, operationAudit, sourceImports, sourceImportRows, user } from '../../db/schema.js';
import { readConfig } from '../../config.js';
import { storeImmutableFile, type NewFileIndex } from '../../file-store.js';
import { CatalogError, getCatalogState } from '../seller-mappings/catalog.js';
import { businessDateForReceipt } from './date.js';
import { WorkbookParseError, validateImportSheetSelection, validateImportWorkbook } from './parser.js';
import { ArchiveValidationError, validateImportArchive } from './zip-preflight.js';

export const IMPORT_QUEUE = 'import-parse';
export class ImportError extends Error {
  constructor(public code: string, public status: 401 | 403 | 404 | 409 | 413 | 415 | 422 | 503, message: string, public details?: unknown) { super(message); }
}
export const canImport = (role: unknown) => role === 'admin';
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ImportRecord = typeof sourceImports.$inferSelect;
type RunRecord = typeof importParseRuns.$inferSelect;
export function serializeImportRun(run: RunRecord): ImportRun {
  return { id: run.id, importId: run.importId, status: run.status as ImportRun['status'], inputVersion: run.inputVersion,
    mappingVersion: run.mappingVersion as ImportRun['mappingVersion'], sheetName: run.sheetName, parserVersion: run.parserVersion,
    processedRows: run.processedRows, counts: run.counts, issues: run.issues, errorCode: run.errorCode, errorMessage: run.errorMessage,
    createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null, completedAt: run.completedAt?.toISOString() ?? null };
}
export function serializeImport(record: ImportRecord, latestRun: RunRecord | null): SourceImport {
  return { id: record.id, fileId: record.fileId, sourceType: record.sourceType as 'xlsx' | 'online', originalName: record.originalName, sha256: record.sha256, byteSize: record.byteSize,
    createdBy: record.createdBy, importedAt: record.importedAt.toISOString(), businessDate: record.businessDate,
    datePolicyVersion: record.datePolicyVersion as SourceImport['datePolicyVersion'], weekStartDate: record.weekStartDate, weekEndDate: record.weekEndDate,
    status: record.status as SourceImport['status'], version: record.version, sheets: record.sheets, latestRun: latestRun ? serializeImportRun(latestRun) : null };
}
async function requireActor(tx: Tx, actorId: string) {
  const [actor] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
  if (!actor || actor.banned || !canImport(actor.role)) throw new ImportError('FORBIDDEN', 403, '当前账号没有需求导入权限。');
  return actor;
}
async function visibleRecord(tx: Tx, id: string, actorId: string, lock = false) {
  const actor = await requireActor(tx, actorId);
  const query = tx.select().from(sourceImports).where(and(eq(sourceImports.id, id), actor.role === 'admin' ? undefined : eq(sourceImports.createdBy, actorId)));
  const [record] = await (lock ? query.for('update') : query);
  if (!record) throw new ImportError('NOT_FOUND', 404, '导入记录不存在或不可访问。');
  return record;
}
async function response(tx: Tx, record: ImportRecord, runId: string, replayed: boolean, deduplicated: boolean): Promise<ImportAccepted> {
  const [run] = await tx.select().from(importParseRuns).where(eq(importParseRuns.id, runId));
  const [latest] = record.latestRunId === runId ? [run] : await tx.select().from(importParseRuns).where(eq(importParseRuns.id, record.latestRunId!));
  if (!run) throw new Error('Import parse run missing');
  return { import: serializeImport(record, latest ?? null), run: serializeImportRun(run), taskId: run.id,
    taskUrl: `/api/v1/imports/${record.id}/runs`, replayed, deduplicated };
}
async function replay(tx: Tx, operationId: string, hash: string, actorId: string) {
  const [previous] = await tx.select().from(importOperations).where(eq(importOperations.operationId, operationId));
  if (!previous) return null;
  if (previous.actorUserId !== actorId || previous.requestHash !== hash) throw new ImportError('OPERATION_CONFLICT', 409, '操作编号已用于其他请求，请核对。');
  const record = await visibleRecord(tx, previous.importId, actorId);
  return response(tx, record, previous.parseRunId, true, previous.deduplicated);
}
export async function replayOnlineImport(operationId: string, content: string, actorId: string) {
  const hash = createHash('sha256').update(JSON.stringify({ kind: 'online', actorUserId: actorId, content })).digest('hex');
  return db.transaction(async (tx) => { await requireActor(tx, actorId); return replay(tx, operationId, hash, actorId); });
}
async function saveOperation(tx: Tx, values: { operationId: string; kind: 'upload' | 'parse'; actorUserId: string; requestHash: string; importId: string; parseRunId: string; deduplicated: boolean }) {
  await tx.insert(importOperations).values(values);
  await tx.insert(operationAudit).values({ id: randomUUID(), action: `source_import.${values.kind}`, targetId: values.importId,
    actorUserId: values.actorUserId, requestHash: values.requestHash,
    details: { operationId: values.operationId, parseRunId: values.parseRunId, deduplicated: String(values.deduplicated) } });
}
async function enqueue(tx: Tx, boss: PgBoss, runId: string) {
  const jobId = await boss.send(IMPORT_QUEUE, { runId }, { db: fromDrizzle(tx, sql), retryLimit: 0, expireInSeconds: 120 });
  if (!jobId) throw new ImportError('QUEUE_UNAVAILABLE', 503, '解析任务未能入队，请稍后重试。');
  await tx.update(importParseRuns).set({ queueJobId: jobId }).where(eq(importParseRuns.id, runId));
}

export type ImportCatalogExpectation = { mode: string; version: number; catalogVersion: number };
export async function createSourceImport(boss: PgBoss, input: { bytes: Buffer; originalName: string; operationId: string; actorUserId: string; receivedAt?: Date; sourceType?: 'xlsx' | 'online'; requestFingerprint?: string; expectedCatalog?: ImportCatalogExpectation }) {
  const { bytes, operationId, actorUserId } = input;
  const originalName = [...input.originalName.split(/[\\/]/).at(-1)!].filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, 200);
  if (!originalName.toLowerCase().endsWith('.xlsx')) throw new ImportError('UNSUPPORTED_FILE_TYPE', 415, '当前仅支持 XLSX 文件，旧 XLS 或宏文件不能改扩展名上传。');
  if (!bytes.length || bytes.length > IMPORT_MAX_BYTES) throw new ImportError('FILE_TOO_LARGE', 413, '请上传非空且不超过 10 MiB 的 XLSX 文件。');
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new ImportError('INVALID_WORKBOOK', 422, '文件不是有效的 XLSX 工作簿。');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const requestHash = createHash('sha256').update(JSON.stringify(input.sourceType === 'online'
    ? { kind: 'online', actorUserId, content: input.requestFingerprint ?? sha256 }
    : { kind: 'upload', actorUserId, sha256, originalName })).digest('hex');
  let stagedFile: NewFileIndex | undefined;
  try { return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`);
    await requireActor(tx, actorUserId);
    const existing = await replay(tx, operationId, requestHash, actorUserId);
    if (existing) return existing;
    if (input.expectedCatalog) {
      const current = await getCatalogState(tx, true).catch((error: unknown) => {
        if (error instanceof CatalogError) throw new ImportError(error.code, error.status, error.message);
        throw error;
      });
      const expected = input.expectedCatalog;
      if (current.mode !== expected.mode || current.version !== expected.version || current.catalogVersion !== expected.catalogVersion) throw new ImportError('CATALOG_VERSION_CONFLICT', 409, '提交期间店铺目录已变化，请重新查询补全后提交。');
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`import:${actorUserId}:${sha256}`}, 0))`);
    const [same] = await tx.select().from(sourceImports).where(and(eq(sourceImports.createdBy, actorUserId), eq(sourceImports.sha256, sha256)));
    if (same) {
      await saveOperation(tx, { operationId, kind: 'upload', actorUserId, requestHash, importId: same.id, parseRunId: same.latestRunId!, deduplicated: true });
      return response(tx, same, same.latestRunId!, false, true);
    }
    // Successful operation/content replays above remain authoritative. New input
    // must pass archive, OOXML and supported-header checks before saving or queuing.
    let validation: ReturnType<typeof validateImportWorkbook>;
    try { await validateImportArchive(bytes); validation = validateImportWorkbook(bytes); }
    catch (error) {
      if (error instanceof ArchiveValidationError || error instanceof WorkbookParseError) throw new ImportError(error.code, 422, error.message);
      throw error;
    }
    const selected = validation.selection;
    const id = randomUUID();
    const runId = randomUUID();
    let result: ImportAccepted | undefined;
    // Store only after deduplication; callback failure compensates the filesystem.
    // The enclosing transaction commits after this callback; a commit error is
    // handled by the outer compensation below using the staged storage key.
    await storeImmutableFile(readConfig().dataDir, { bytes, originalName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: actorUserId }, async (file) => {
      stagedFile = file;
      await tx.insert(fileIndex).values(file);
      const [record] = await tx.insert(sourceImports).values({ id, fileId: file.id, sha256, originalName, byteSize: bytes.length,
        sourceType: input.sourceType ?? 'xlsx', createdBy: actorUserId, ...businessDateForReceipt(input.receivedAt ?? new Date()), sheets: validation.sheets, status: selected ? 'queued' : 'awaiting_mapping' }).returning();
      await tx.insert(importParseRuns).values({ id: runId, importId: id, queueJobId: selected ? 'pending' : 'not-queued', createdBy: actorUserId, inputVersion: 1, parserVersion: IMPORT_PARSER_VERSION,
        sheetName: selected?.sheetName ?? null, mappingVersion: selected?.mappingVersion ?? null, issues: validation.issues,
        ...(selected ? {} : { status: 'completed', completedAt: new Date() }) });
      if (selected) await enqueue(tx, boss, runId);
      await tx.update(sourceImports).set({ latestRunId: runId }).where(eq(sourceImports.id, id));
      await saveOperation(tx, { operationId, kind: 'upload', actorUserId, requestHash, importId: id, parseRunId: runId, deduplicated: false });
      result = await response(tx, { ...record!, latestRunId: runId }, runId, false, false);
    });
    return result!;
  }); } catch (error) {
    // If commit outcome is unknown, retain the file for reconciliation. Never
    // delete a source that may already have a committed database index.
    if (stagedFile) {
      const file = stagedFile;
      try {
        const [indexed] = await db.select({ id: fileIndex.id }).from(fileIndex).where(eq(fileIndex.id, file.id));
        if (!indexed) await unlink(resolve(readConfig().dataDir, file.storageKey)).catch((cleanup: NodeJS.ErrnoException) => { if (cleanup.code !== 'ENOENT') throw cleanup; });
      } catch { /* Preserve an uncertain file rather than corrupt a committed source. */ }
    }
    throw error;
  }
}

export async function requestImportParse(boss: PgBoss, id: string, input: ImportParseInput, actorId: string) {
  const requestHash = createHash('sha256').update(JSON.stringify({ kind: 'parse', actorId, id, ...input })).digest('hex');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
    await requireActor(tx, actorId);
    const existing = await replay(tx, input.operationId, requestHash, actorId);
    if (existing) return existing;
    const record = await visibleRecord(tx, id, actorId, true);
    if (record.version !== input.expectedVersion) throw new ImportError('VERSION_CONFLICT', 409, '导入版本已变化，请刷新核对后重新解析。');
    if (record.status === 'queued' || record.status === 'parsing') throw new ImportError('IMPORT_BUSY', 409, '当前解析仍在执行，请等待完成或失败后重试。');
    if (record.sheets.length) {
      try { validateImportSheetSelection(record.sheets, input); }
      catch (error) { if (error instanceof WorkbookParseError) throw new ImportError(error.code, 422, error.message); throw error; }
    }
    const runId = randomUUID();
    const version = record.version + 1;
    await tx.insert(importParseRuns).values({ id: runId, importId: id, queueJobId: 'pending', createdBy: actorId, inputVersion: version,
      mappingVersion: input.mappingVersion, sheetName: input.sheetName, parserVersion: IMPORT_PARSER_VERSION });
    await enqueue(tx, boss, runId);
    const [updated] = await tx.update(sourceImports).set({ latestRunId: runId, status: 'queued', version }).where(eq(sourceImports.id, id)).returning();
    await saveOperation(tx, { operationId: input.operationId, kind: 'parse', actorUserId: actorId, requestHash, importId: id, parseRunId: runId, deduplicated: false });
    return response(tx, updated!, runId, false, false);
  });
}

export async function getSourceImport(id: string, actorId: string) {
  return db.transaction(async (tx) => {
    const record = await visibleRecord(tx, id, actorId);
    const [run] = record.latestRunId ? await tx.select().from(importParseRuns).where(eq(importParseRuns.id, record.latestRunId)) : [];
    return serializeImport(record, run ?? null);
  });
}
export async function listSourceImports(actorId: string, query: { page: number; pageSize: number }) {
  return db.transaction(async (tx) => {
    const actor = await requireActor(tx, actorId);
    const filter = actor.role === 'admin' ? undefined : eq(sourceImports.createdBy, actorId);
    const [total] = await tx.select({ value: count() }).from(sourceImports).where(filter);
    const records = await tx.select().from(sourceImports).where(filter).orderBy(desc(sourceImports.importedAt), desc(sourceImports.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize);
    const runs = records.length ? await tx.select().from(importParseRuns).where(inArray(importParseRuns.id, records.flatMap((record) => record.latestRunId ? [record.latestRunId] : []))) : [];
    const rows = runs.length ? await tx.select({ parseRunId: sourceImportRows.parseRunId, sheetName: sourceImportRows.sheetName, rowNumber: sourceImportRows.rowNumber, status: sourceImportRows.status }).from(sourceImportRows).where(inArray(sourceImportRows.parseRunId, runs.map((run) => run.id))) : [];
    const origins = records.length ? await tx.select({ importId: demandSources.importId, sheetName: demandSources.sheetName, rowNumber: demandSources.rowNumber }).from(demandSources).where(inArray(demandSources.importId, records.map((record) => record.id))) : [];
    return { items: records.map((record) => {
      const currentRows = rows.filter((row) => row.parseRunId === record.latestRunId);
      const committed = new Set(origins.filter((origin) => origin.importId === record.id).map((origin) => JSON.stringify([origin.sheetName, origin.rowNumber])));
      const submittedSourceRows = currentRows.filter((row) => committed.has(JSON.stringify([row.sheetName, row.rowNumber]))).length;
      const submissionStatus = !submittedSourceRows ? 'not_submitted' as const : currentRows.filter((row) => row.status !== 'error').every((row) => committed.has(JSON.stringify([row.sheetName, row.rowNumber]))) ? 'submitted' as const : 'partially_submitted' as const;
      return { ...serializeImport(record, runs.find((run) => run.id === record.latestRunId) ?? null), submittedSourceRows, submissionStatus };
    }), total: total!.value, ...query };
  }, { isolationLevel: 'repeatable read' });
}
export async function listImportRuns(id: string, actorId: string) {
  return db.transaction(async (tx) => { await visibleRecord(tx, id, actorId);
    const runs = await tx.select().from(importParseRuns).where(eq(importParseRuns.importId, id)).orderBy(desc(importParseRuns.createdAt), desc(importParseRuns.id)).limit(100);
    return { items: runs.map(serializeImportRun) }; });
}
export async function listImportRows(id: string, actorId: string, query: { page: number; pageSize: number; status?: string; parseRunId?: string }) {
  return db.transaction(async (tx) => {
    const record = await visibleRecord(tx, id, actorId);
    const runId = query.parseRunId ?? record.latestRunId;
    if (!runId) return { items: [], total: 0, page: query.page, pageSize: query.pageSize, parseRunId: null, previewVersion: record.version };
    const [run] = await tx.select().from(importParseRuns).where(and(eq(importParseRuns.id, runId), eq(importParseRuns.importId, id)));
    if (!run) throw new ImportError('NOT_FOUND', 404, '解析版本不存在。');
    const filter = and(eq(sourceImportRows.parseRunId, runId), query.status ? eq(sourceImportRows.status, query.status) : undefined);
    const [total] = await tx.select({ value: count() }).from(sourceImportRows).where(filter);
    const items = await tx.select().from(sourceImportRows).where(filter).orderBy(asc(sourceImportRows.rowNumber), asc(sourceImportRows.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize);
    return { items, total: total!.value, page: query.page, pageSize: query.pageSize, parseRunId: runId, previewVersion: run.inputVersion };
  }, { isolationLevel: 'repeatable read' });
}
export async function readImportFile(fileId: string, actorId: string) {
  return db.transaction(async (tx) => {
    const actor = await requireActor(tx, actorId);
    const [record] = await tx.select().from(sourceImports).where(and(eq(sourceImports.fileId, fileId), actor.role === 'admin' ? undefined : eq(sourceImports.createdBy, actorId)));
    if (!record) throw new ImportError('NOT_FOUND', 404, '文件不存在或不可访问。');
    const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, fileId));
    if (!file) throw new ImportError('FILE_UNAVAILABLE', 503, '原文件索引缺失，请联系管理员。');
    return { file, record };
  });
}
export async function checkedFileBytes(file: { storageKey: string; sha256: string; byteSize: number }) {
  const dataDir = readConfig().dataDir;
  const path = resolve(dataDir, file.storageKey);
  if (!path.startsWith(resolve(dataDir) + sep)) throw new ImportError('FILE_UNAVAILABLE', 503, '原文件存储索引无效。');
  const bytes = await readFile(path).catch(() => { throw new ImportError('FILE_UNAVAILABLE', 503, '原文件不可读取，请联系管理员。'); });
  if (bytes.length !== file.byteSize || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new ImportError('FILE_INTEGRITY_ERROR', 503, '原文件校验失败，请联系管理员。');
  return bytes;
}
export async function reconcileImportRuns(boss: PgBoss, importId?: string) {
  const runs = await db.select().from(importParseRuns).where(and(inArray(importParseRuns.status, ['queued', 'running']), importId ? eq(importParseRuns.importId, importId) : undefined)).limit(100);
  for (const run of runs) {
    const [job] = await boss.findJobs(IMPORT_QUEUE, { id: run.queueJobId });
    if (job?.state !== 'failed' && job?.state !== 'cancelled') continue;
    await db.transaction(async (tx) => {
      await tx.update(importParseRuns).set({ status: 'failed', errorCode: 'PARSE_INTERRUPTED', errorMessage: '解析任务已中断或超时，请核对后重新解析。', completedAt: new Date() })
        .where(and(eq(importParseRuns.id, run.id), inArray(importParseRuns.status, ['queued', 'running'])));
      await tx.update(sourceImports).set({ status: 'failed' }).where(and(eq(sourceImports.id, run.importId), eq(sourceImports.latestRunId, run.id), inArray(sourceImports.status, ['queued', 'parsing'])));
    });
  }
}
