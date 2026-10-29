import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { fileIndex } from '../../db/schema.js';
import { batchOperations } from '../batches/schema.js';
import { BatchError, requireBatchActor, type BatchTx } from '../batches/service.js';
import { publishReportFile } from '../batches/report-service.js';
import { checkedFileBytes } from '../imports/service.js';
import { documentDigest } from './domain.js';
import { documentReferenceDatasets } from './reference-schema.js';
import { parseReferenceWorkbook, REFERENCE_WORKBOOK_PARSER_VERSION, type ReferenceWorkbookPlan } from './reference-workbook.js';
import { documentOperation } from './service.js';

export type ReferenceImportResult = {
  sourceFileId: string;
  sourceSha256: string;
  parserVersion: string;
  datasets: Array<{ id: string; kind: string; rowCount: number; reused: boolean }>;
  addressProfiles: Array<{ id: string; key: string; version: number; reused: boolean }>;
  summary: Record<string, unknown>;
};

/** Archive reference catalogs as immutable evidence. Address sheets remain
 * historical evidence and never create local address profiles; service/tax
 * choices and delivery dates are never inferred from a catalog. */
export async function importReferenceWorkbook(input: {
  actorId: string; operationId: string; bytes: Buffer; originalName: string; expectedSha256: string;
}): Promise<ReferenceImportResult & { replayed: boolean }> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  if (sha256 !== input.expectedSha256) throw new BatchError('SOURCE_CHANGED', 409, '参考工作簿在预检后已变化，请重新核对。');
  const plan = await parseReferenceWorkbook(input.bytes);
  const request = { sha256, parserVersion: REFERENCE_WORKBOOK_PARSER_VERSION, planDigest: documentDigest(plan), originalName: basename(input.originalName) };
  const action = 'document.reference.import';
  const [prior] = await db.select().from(batchOperations).where(eq(batchOperations.operationId, input.operationId));
  if (prior) {
    await db.transaction((tx) => requireBatchActor(tx, input.actorId));
    if (prior.actorId !== input.actorId || prior.requestHash !== documentDigest({ action, input: request })) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他导入。');
    return { ...prior.result, replayed: true } as ReferenceImportResult & { replayed: boolean };
  }
  // Reuse the archived original when importing the same source a second time.
  const [existingSource] = await db.select({ file: fileIndex }).from(documentReferenceDatasets)
    .innerJoin(fileIndex, eq(fileIndex.id, documentReferenceDatasets.sourceFileId))
    .where(and(eq(documentReferenceDatasets.sourceSha256, sha256), eq(documentReferenceDatasets.parserVersion, REFERENCE_WORKBOOK_PARSER_VERSION))).limit(1);
  const execute = async (tx: BatchTx, sourceFileId: string) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-reference:${sha256}:${REFERENCE_WORKBOOK_PARSER_VERSION}`},0))`);
    return savePlan(tx, input, plan, sha256, sourceFileId);
  };
  if (existingSource) {
    await checkedFileBytes(existingSource.file);
    return documentOperation(input.actorId, input.operationId, action, request, (tx) => execute(tx, existingSource.file.id));
  }
  let result: (ReferenceImportResult & { replayed: boolean }) | undefined;
  await publishReportFile({ bytes: input.bytes, originalName: basename(input.originalName), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: input.actorId }, async (file) => {
    result = await documentOperation(input.actorId, input.operationId, action, request, async (tx) => {
      await tx.insert(fileIndex).values(file);
      return execute(tx, file.id);
    });
  });
  if (!result) throw new Error('Reference import returned no result');
  return result;
}

async function savePlan(tx: BatchTx, input: { actorId: string; operationId: string; originalName: string }, plan: ReferenceWorkbookPlan, sha256: string, sourceFileId: string): Promise<ReferenceImportResult> {
  const datasets: ReferenceImportResult['datasets'] = [];
  for (const entry of plan.datasets) {
    const contentSha256 = documentDigest(entry.data);
    const [old] = await tx.select().from(documentReferenceDatasets).where(and(
      eq(documentReferenceDatasets.sourceSha256, sha256), eq(documentReferenceDatasets.kind, entry.kind),
      eq(documentReferenceDatasets.sheetName, entry.sheetName), eq(documentReferenceDatasets.parserVersion, REFERENCE_WORKBOOK_PARSER_VERSION),
    ));
    if (old && old.contentSha256 !== contentSha256) throw new BatchError('REFERENCE_CONTENT_CONFLICT', 409, '相同来源与解析版本产生不同参考资料，已拒绝覆盖。');
    const id = old?.id ?? randomUUID();
    if (!old) await tx.insert(documentReferenceDatasets).values({ id, kind: entry.kind, sourceFileId, sourceSha256: sha256, sheetName: entry.sheetName, sourceRange: entry.sourceRange, parserVersion: REFERENCE_WORKBOOK_PARSER_VERSION, data: entry.data, contentSha256, createdBy: input.actorId });
    datasets.push({ id, kind: entry.kind, rowCount: Array.isArray(entry.data.rows) ? entry.data.rows.length : 0, reused: Boolean(old) });
  }
  return { sourceFileId, sourceSha256: sha256, parserVersion: REFERENCE_WORKBOOK_PARSER_VERSION, datasets, addressProfiles: [], summary: { ...plan.summary, addressProfileCount: 0 } };
}
