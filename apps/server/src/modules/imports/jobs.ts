import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { ImportMappingVersion } from '@scm/contracts';
import { db } from '../../db/client.js';
import { fileIndex, importParseRuns, sellerAliases, sellerMappings, sourceImports, sourceImportRows, user } from '../../db/schema.js';
import { logError } from '../../errors.js';
import { normalizeAlias } from '../seller-mappings/service.js';
import { activeSeller, getCatalogState } from '../seller-mappings/catalog.js';
import { findApprovedSellers } from '../seller-mappings/resolution.js';
import { canImport, checkedFileBytes, IMPORT_QUEUE, ImportError, reconcileImportRuns } from './service.js';
import { ImportParseError, parseImportWorkbook } from './parser.js';
import { ArchiveValidationError, validateImportArchive } from './zip-preflight.js';

async function failRun(runId: string, code: string, message: string) {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(importParseRuns).where(eq(importParseRuns.id, runId)).for('update');
    if (!run || !['queued', 'running'].includes(run.status)) return;
    await tx.update(importParseRuns).set({ status: 'failed', errorCode: code, errorMessage: message, completedAt: new Date() }).where(eq(importParseRuns.id, runId));
    await tx.update(sourceImports).set({ status: 'failed' }).where(and(eq(sourceImports.id, run.importId), eq(sourceImports.latestRunId, runId)));
  });
}
export async function executeImportParse(runId: string) {
  const input = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(importParseRuns).where(eq(importParseRuns.id, runId)).for('update');
    if (!run || run.status === 'completed' || run.status === 'failed') return null;
    if (run.status === 'running') return null; // A reclaimed job requires explicit failure recovery, not a second parser.
    const [record] = await tx.select().from(sourceImports).where(eq(sourceImports.id, run.importId)).for('update');
    const [actor] = await tx.select().from(user).where(eq(user.id, run.createdBy)).for('share');
    if (!actor || actor.banned || !canImport(actor.role)) throw new ImportError('FORBIDDEN', 403, '提交人已失去导入解析权限。');
    if (!record || record.latestRunId !== runId || record.version !== run.inputVersion) throw new ImportError('VERSION_CONFLICT', 409, '解析输入版本已失效。');
    if (actor.role !== 'admin' && record.createdBy !== actor.id) throw new ImportError('FORBIDDEN', 403, '提交人已失去此文件的解析权限。');
    const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, record.fileId));
    if (!file) throw new ImportError('FILE_UNAVAILABLE', 503, '原文件索引不存在。');
    await tx.update(importParseRuns).set({ status: 'running', startedAt: new Date() }).where(eq(importParseRuns.id, runId));
    await tx.update(sourceImports).set({ status: 'parsing' }).where(eq(sourceImports.id, record.id));
    return { run, record, file };
  });
  if (!input) return;
  // Filesystem and workbook work happen outside any database transaction.
  const bytes = await checkedFileBytes(input.file);
  await validateImportArchive(bytes);
  const parsed = await parseImportWorkbook(bytes, input.run.sheetName && input.run.mappingVersion ? {
    sheetName: input.run.sheetName, mappingVersion: input.run.mappingVersion as ImportMappingVersion,
  } : undefined);
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(importParseRuns).where(eq(importParseRuns.id, runId)).for('update');
    const [record] = await tx.select().from(sourceImports).where(eq(sourceImports.id, input.record.id)).for('update');
    const [actor] = await tx.select().from(user).where(eq(user.id, input.run.createdBy)).for('share');
    if (!actor || actor.banned || !canImport(actor.role)) throw new ImportError('FORBIDDEN', 403, '提交人已失去导入解析权限。');
    if (!run || run.status !== 'running' || !record || record.latestRunId !== runId || record.version !== input.run.inputVersion) throw new ImportError('VERSION_CONFLICT', 409, '解析输入版本已失效，结果未发布。');
    if (actor.role !== 'admin' && record.createdBy !== actor.id) throw new ImportError('FORBIDDEN', 403, '提交人已失去此文件的解析权限，结果未发布。');
    const catalog = await getCatalogState(tx, true);
    const mappings = await tx.select().from(sellerMappings);
    const aliases = mappings.length ? await tx.select().from(sellerAliases).where(inArray(sellerAliases.sellerMappingId, mappings.map((mapping) => mapping.id))) : [];
    const aliasesByMapping = new Map<string, string[]>();
    for (const alias of aliases) aliasesByMapping.set(alias.sellerMappingId, [...aliasesByMapping.get(alias.sellerMappingId) ?? [], alias.alias]);
    const approved = mappings.flatMap((mapping) => {
      const active = activeSeller(mapping, catalog.mode);
      return active ? [{ ...active, aliases: aliasesByMapping.get(active.id) ?? [] }] : [];
    });
    const rows = parsed.rows.map((row) => {
      const matches = row.normalized.shop ? findApprovedSellers(row.normalized.shop, approved) : [];
      const mapping = matches.length === 1 ? matches[0] : undefined;
      const issues = [...row.issues.filter((issue) => !['SOURCE_MAPPING_REQUIRED', 'SELLER_ALIAS_CONFLICT'].includes(issue.code))];
      if (!mapping && row.normalized.shop) issues.push({ code: matches.length ? 'SELLER_ALIAS_CONFLICT' : 'SOURCE_MAPPING_REQUIRED', severity: 'warning',
        message: matches.length ? '来源店铺名称对应多个已批准店铺，请人工确认。' : '来源店铺名称未匹配已批准店铺；请在本次导入中确认店铺。' });
      if (mapping && row.normalized.country && normalizeAlias(row.normalized.country) !== normalizeAlias(mapping.country)) issues.push({ code: 'COUNTRY_MISMATCH', severity: 'error', message: '来源国家与已批准店铺国家不一致，请核对。' });
      return { id: randomUUID(), parseRunId: runId, sheetName: parsed.sheetName!, rowNumber: row.rowNumber, hidden: row.hidden,
        rawCells: row.rawCells, normalized: { ...row.normalized, sellerMappingId: mapping?.id ?? null, sid: mapping?.sid ?? null, sellerMappingVersion: mapping?.version ?? null },
        issues, status: issues.some((issue) => issue.severity === 'error') ? 'error' : issues.length ? 'needs_review' : 'valid' };
    });
    for (let start = 0; start < rows.length; start += 100) await tx.insert(sourceImportRows).values(rows.slice(start, start + 100));
    const counts = { totalRows: rows.length, validFbaRows: rows.filter((row) => row.normalized.fba && !row.issues.some((issue) => ['INVALID_FBA', 'MISSING_FBA'].includes(issue.code))).length,
      errorRows: rows.filter((row) => row.status === 'error').length, warningRows: rows.filter((row) => row.issues.some((issue) => issue.severity === 'warning')).length };
    await tx.update(importParseRuns).set({ status: 'completed', sheetName: parsed.sheetName, mappingVersion: parsed.mappingVersion,
      processedRows: rows.length, counts, issues: parsed.issues, completedAt: new Date() }).where(eq(importParseRuns.id, runId));
    await tx.update(sourceImports).set({ status: parsed.status, sheets: parsed.sheets }).where(eq(sourceImports.id, record.id));
  });
}
export async function registerImportWorker(boss: PgBoss) {
  await boss.createQueue(IMPORT_QUEUE, { retryLimit: 0, expireInSeconds: 120, deleteAfterSeconds: 0 });
  await boss.work(IMPORT_QUEUE, async ([job]) => {
    if (!job) return;
    const { runId } = z.object({ runId: z.uuid() }).parse(job.data);
    try { await executeImportParse(runId); }
    catch (error) {
      logError('Import parse failed', error);
      const code = error instanceof ImportError || error instanceof ImportParseError || error instanceof ArchiveValidationError ? error.code : 'PARSE_FAILED';
      const message = error instanceof ImportError || error instanceof ImportParseError || error instanceof ArchiveValidationError ? error.message : '解析失败，请核对文件后重新解析。';
      await failRun(runId, code, message);
      throw new Error('Import parse failed');
    }
  });
  // Queue expiry is reconciled even without an active browser watching the task.
  const interval = setInterval(() => void reconcileImportRuns(boss).catch((error) => logError('Import queue reconciliation failed', error)), 5_000);
  interval.unref();
  return () => clearInterval(interval);
}
