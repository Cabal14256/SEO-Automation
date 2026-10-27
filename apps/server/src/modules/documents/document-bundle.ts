import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withDocumentInvoiceDefaults, type DocumentExportReference, type DocumentRevisionData } from '@scm/contracts';
import { db } from '../../db/client.js';
import { fileIndex, operationAudit } from '../../db/schema.js';
import { BatchError, freezeGroupForExport, requireBatchActor, type BatchTx } from '../batches/service.js';
import { publishReportFile } from '../batches/report-service.js';
import { checkedFileBytes } from '../imports/service.js';
import { documentAutomationJobs, documentInvoiceBundles } from './automation-schema.js';
import { automationOperationId } from './automation-engine.js';
import { createDocumentBundleWorkbook, type BundleSelection, type BundleWorkbookInput } from './bundle-workbook.js';
import { documentDigest } from './domain.js';
import { documentExports, documents } from './schema.js';
import { lockedDocument, validateDocumentInTx } from './service.js';
import type { StoredDocumentAutomationItem } from './automation-types.js';

type Job = typeof documentAutomationJobs.$inferSelect;
type File = typeof fileIndex.$inferSelect;
type Source = { itemId: string; documentId: string; version: number; reference: DocumentExportReference; data: DocumentRevisionData; file: File;
  existingExportId: string | null; selections?: BundleSelection[] };
const bundleName = (id: string) => `整批发票-${id.slice(0, 8)}.xlsx`;
const scopeKey = (items: StoredDocumentAutomationItem[]) => documentDigest(items.map((item) => [item.id, item.documentId, item.documentVersion]).sort());
function assertReference(reference: DocumentExportReference, record: { status: string; currentRevisionId: string | null }, revision: { id: string; version: number; data: DocumentRevisionData }) {
  const template = revision.data.templateReference;
  if (['cancelled', 'superseded'].includes(record.status) || record.currentRevisionId !== reference.revisionId || revision.id !== reference.revisionId || revision.version !== reference.revisionVersion
    || reference.generationRulesVersion !== revision.data.generationRulesVersion
    || !template || template.templateId !== reference.templateId || template.version !== reference.templateVersion || template.sha256 !== reference.templateSha256
    || documentDigest(revision.data.members.map((member) => member.source)) !== documentDigest(reference.sources)) {
    throw new BatchError('DOCUMENT_EXPORT_STALE', 409, '整批工作簿的某票修订、来源或模板已变化，请建立更正单据。');
  }
}
/** Bundle access always checks every member, including access through a historical per-document export. */
export async function assertDocumentBundleValidInTx(tx: BatchTx, jobId: string, actorId: string, options: { historicalExport?: boolean; archiveOnly?: boolean } = {}) {
  await requireBatchActor(tx, actorId);
  const [job] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, jobId));
  if (!job || job.deletedAt && !options.historicalExport) throw new BatchError('NOT_FOUND', 404, '自动出单任务不存在或已删除。');
  const [bundle] = await tx.select().from(documentInvoiceBundles).where(eq(documentInvoiceBundles.jobId, jobId)).for('share');
  if (!bundle) throw new BatchError('FILE_UNAVAILABLE', 503, '整批工作簿的范围映射缺失，请联系管理员。');
  if (options.archiveOnly) {
    const published = await tx.select().from(documentExports).where(and(eq(documentExports.fileId, bundle.fileId), eq(documentExports.status, 'completed')));
    if (!bundle.references.length || bundle.references.some((reference) => !published.some((item) => documentDigest(item.reference) === documentDigest(reference)))) {
      throw new BatchError('FILE_UNAVAILABLE', 503, '历史工作簿的发布引用不完整，请联系管理员。');
    }
    return bundle;
  }
  for (const reference of [...bundle.references].sort((left, right) => left.documentId.localeCompare(right.documentId))) {
    const { record, revision } = await lockedDocument(tx, reference.documentId, actorId); assertReference(reference, record, revision);
    const validation = await validateDocumentInTx(tx, reference.documentId, actorId);
    if (!validation.valid) throw new BatchError('DOCUMENT_EXPORT_STALE', 409, '整批工作簿的某票资料或来源已失效，请先核对更正。', validation.issues);
  }
  return bundle;
}
export async function documentBundleValidity(jobId: string, actorId: string) {
  try { await db.transaction((tx) => assertDocumentBundleValidInTx(tx, jobId, actorId)); return { valid: true, invalidReason: null }; }
  catch (error) { if (error instanceof BatchError && [409, 422, 503].includes(error.status)) return { valid: false, invalidReason: error.message }; throw error; }
}
export async function readDocumentBundle(jobId: string, actorId: string, options: { historicalExport?: boolean } = {}) {
  const file = await db.transaction(async (tx) => {
    const [job] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, jobId));
    if (!job || job.deletedAt && !options.historicalExport || job.mode !== 'single_workbook' || job.bundle?.status !== 'completed' || !job.bundle.fileId) throw new BatchError('NOT_FOUND', 404, '整批工作簿尚未成功发布或任务已删除。');
    const bundle = await assertDocumentBundleValidInTx(tx, jobId, actorId, { ...options, archiveOnly: true });
    const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, bundle.fileId));
    if (!file || file.id !== job.bundle.fileId) throw new BatchError('FILE_UNAVAILABLE', 503, '整批工作簿归档缺失，请联系管理员。'); return file;
  });
  return { file, bytes: await checkedFileBytes(file) };
}

/** A complete second preflight. No file is rendered or published while even one ticket is blocked. */
export async function preflightDocumentBundle(job: Job): Promise<{ sources: Source[]; items: StoredDocumentAutomationItem[] }> {
  if (job.deletedAt) throw new BatchError('NOT_FOUND', 404, '自动出单任务已删除。');
  return db.transaction(async (tx) => {
    const sources: Source[] = [], items = structuredClone(job.items);
    const lockIds = new Set(items.flatMap((item) => item.documentId ? [item.documentId] : []));
    if (lockIds.size) {
      // Reusing part of an older bundle also validates its other members. Lock that closure in one stable order.
      const priorExports = await tx.select().from(documentExports).where(inArray(sql<string>`${documentExports.reference}->>'documentId'`, [...lockIds])).orderBy(desc(documentExports.createdAt));
      const latest = new Map<string, typeof documentExports.$inferSelect>();
      for (const entry of priorExports) if (entry.status === 'completed' && entry.fileId && !latest.has(entry.reference.documentId)) latest.set(entry.reference.documentId, entry);
      const bundleIds = [...new Set([...latest.values()].flatMap((entry) => entry.reference.bundleJobId ? [entry.reference.bundleJobId] : []))];
      if (bundleIds.length) {
        const priorBundles = await tx.select().from(documentInvoiceBundles).where(inArray(documentInvoiceBundles.jobId, bundleIds));
        for (const bundle of priorBundles) for (const reference of bundle.references) lockIds.add(reference.documentId);
      }
      for (const documentId of [...lockIds].sort()) await lockedDocument(tx, documentId, job.createdBy);
    }
    for (const item of [...items].sort((left, right) => (left.documentId ?? '').localeCompare(right.documentId ?? ''))) {
      if (!['ready', 'completed'].includes(item.status) || !item.documentId || item.documentVersion === null) continue;
      try {
        const { record, revision } = await lockedDocument(tx, item.documentId, job.createdBy, item.documentVersion);
        if (revision.data.generationRulesVersion !== 'v2') throw new BatchError('DOCUMENT_GENERATION_UPGRADE_REQUIRED', 422, '本票使用旧版发票规则；请通过更正建立采用当前规则的新单据，历史文件保持原样。');
        const validation = await validateDocumentInTx(tx, item.documentId, job.createdBy, item.documentVersion);
        const blockers = validation.issues.filter((issue) => issue.severity === 'error');
        item.issues = validation.issues;
        if (!validation.valid) { item.status = 'blocked'; item.error = { code: blockers[0]?.code ?? 'VALIDATION_BLOCKED', message: blockers[0]?.message ?? '本票仍有待补资料。' }; continue; }
        const template = revision.data.templateReference;
        if (!template) throw new BatchError('DOCUMENT_TEMPLATE_REQUIRED', 422, '请选择本票有效模板。');
        const reference: DocumentExportReference = { documentId: record.id, revisionId: revision.id, revisionVersion: revision.version, templateId: template.templateId,
          templateVersion: template.version, templateSha256: template.sha256, sources: revision.data.members.map((member) => member.source), generationRulesVersion: revision.data.generationRulesVersion, bundleJobId: job.id };
        const exports = await tx.select().from(documentExports).where(sql`${documentExports.reference}->>'documentId' = ${record.id}`).orderBy(desc(documentExports.createdAt)).for('share');
        const existing = exports.find((entry) => entry.fileId && entry.status === 'completed');
        if (exports.some((entry) => ['queued', 'running'].includes(entry.status))) throw new BatchError('DOCUMENT_EXPORT_BUSY', 409, '本票已有生成任务，请等待结束后整批续跑。');
        let fileId = template.fileId, selections: BundleSelection[] | undefined;
        if (existing?.fileId) {
          if (existing.reference.generationRulesVersion !== 'v2') throw new BatchError('DOCUMENT_GENERATION_UPGRADE_REQUIRED', 422, '已有文件使用旧版发票规则，请建立更正后再生成整批文件；不会修改旧文件。');
          assertReference(existing.reference, record, revision); fileId = existing.fileId;
          if (existing.reference.bundleJobId) {
            const old = await assertDocumentBundleValidInTx(tx, existing.reference.bundleJobId, job.createdBy, { historicalExport: true });
            selections = old.sheets.flatMap((sheet) => sheet.ranges.filter((range) => range.documentId === record.id).map((range) => ({ ...range, sheetName: sheet.name })));
            if (!selections.length) throw new BatchError('DOCUMENT_EXPORT_STALE', 409, '既有整批文件缺少本票范围映射，请核对历史文件。');
          }
        }
        const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, fileId));
        if (!file || !existing && file.sha256 !== template.sha256) throw new BatchError('FILE_UNAVAILABLE', 503, '本票模板或既有文件归档缺失或哈希不符。');
        sources.push({ itemId: item.id, documentId: record.id, version: record.version, reference, data: revision.data, file, existingExportId: existing?.id ?? null, selections });
        item.status = 'ready'; item.stage = 'ready'; item.error = null;
      } catch (error) {
        if (!(error instanceof BatchError)) throw error;
        item.status = 'blocked'; item.error = { code: error.code, message: error.message };
        item.issues.push({ ...item.error, severity: 'error' });
      }
    }
    return { sources, items };
  });
}

export async function publishDocumentBundle(job: Job, sources: Source[]) {
  if (!sources.length || sources.length !== job.items.length || job.items.some((item) => item.status !== 'ready')) throw new BatchError('VALIDATION_BLOCKED', 422, '整批所有货件须先完成资料检查，暂不生成文件。');
  const cache = new Map<string, Buffer>(), inputs: BundleWorkbookInput[] = [];
  const { createWorkbook, DOCUMENT_HEADER_FIELDS } = await import('./workbook.js');
  for (const source of sources) {
    let bytes = cache.get(source.file.id); if (!bytes) { bytes = await checkedFileBytes(source.file); cache.set(source.file.id, bytes); }
    const fields = withDocumentInvoiceDefaults(source.data.fields, source.data.members);
    const expectedHeaders = Object.fromEntries(Object.entries(DOCUMENT_HEADER_FIELDS).map(([key, address]) => [address, key === 'currency' ? ({ USD: '美元', EUR: '欧元', GBP: '英镑' } as Record<string, string>)[fields.currency ?? ''] ?? null : fields[key] ?? null]));
    inputs.push({ documentId: source.documentId, bytes: source.existingExportId ? bytes : await createWorkbook(source.data, bytes, automationOperationId(job.id, source.itemId, 'bundle-export')), selections: source.selections, expectedHeaders });
  }
  const workbook = await createDocumentBundleWorkbook(inputs), originalName = bundleName(job.id);
  let published = false;
  try {
    await publishReportFile({ bytes: workbook.bytes, originalName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: job.createdBy }, async (file) => {
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(documentAutomationJobs).where(eq(documentAutomationJobs.id, job.id)).for('update');
        if (!current || current.deletedAt || current.mode !== 'single_workbook') throw new BatchError('VERSION_CONFLICT', 409, '整批任务状态已变化，文件未发布。');
        if (current.bundle?.status === 'completed') throw new BatchError('DOCUMENT_BUNDLE_REPLAY', 409, '整批文件已经发布。');
        if (scopeKey(current.items) !== scopeKey(job.items) || current.items.some((item) => item.status !== 'ready')) throw new BatchError('VERSION_CONFLICT', 409, '整批票范围或资料版本已变化，文件未发布。');
        for (const source of [...sources].sort((left, right) => left.documentId.localeCompare(right.documentId))) {
          const { record, revision } = await lockedDocument(tx, source.documentId, job.createdBy, source.version); assertReference(source.reference, record, revision);
          const validation = await validateDocumentInTx(tx, source.documentId, job.createdBy, source.version);
          if (!validation.valid) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '发布前整批某票资料或来源已变化，未发布部分文件。', validation.issues);
        }
        await tx.insert(fileIndex).values(file);
        await tx.insert(documentInvoiceBundles).values({ id: automationOperationId(job.id, job.id, 'bundle'), jobId: job.id, fileId: file.id, references: sources.map((source) => source.reference), sheets: workbook.sheets, createdBy: job.createdBy });
        const items = structuredClone(current.items);
        for (const source of sources) {
          const item = items.find((entry) => entry.id === source.itemId)!;
          if (!source.existingExportId) {
            const exportId = automationOperationId(job.id, item.id, 'bundle-export');
            await tx.insert(documentExports).values({ id: exportId, operationId: exportId, requestHash: documentDigest(source.reference), reference: source.reference, status: 'completed', fileId: file.id, createdBy: job.createdBy, completedAt: new Date() });
            await tx.update(documents).set({ status: 'pending_review', updatedAt: new Date() }).where(eq(documents.id, source.documentId));
            item.exportId = exportId; item.fileId = file.id;
          } else { item.exportId = source.existingExportId; item.fileId = source.file.id; }
          item.status = 'completed'; item.stage = 'done'; item.error = null;
        }
        const groups = new Map<string, string>();
        for (const source of sources) for (const reference of source.reference.sources) {
          if (groups.has(reference.groupId) && groups.get(reference.groupId) !== reference.m2ConfirmationId) throw new BatchError('CONFIRMATION_STALE', 409, '整批来源组确认版本不一致，未发布文件。');
          groups.set(reference.groupId, reference.m2ConfirmationId);
        }
        for (const [groupId, confirmationId] of [...groups].sort(([left], [right]) => left.localeCompare(right))) await freezeGroupForExport(tx, groupId, confirmationId, job.createdBy);
        const completedAt = new Date();
        await tx.update(documentAutomationJobs).set({ items, status: 'completed', phase: 'completed', bundle: { status: 'completed', fileId: file.id, fileName: originalName, sheetCount: workbook.sheets.length, completedAt: completedAt.toISOString(), error: null }, error: null, completedAt, updatedAt: completedAt, version: sql`${documentAutomationJobs.version}+1` }).where(eq(documentAutomationJobs.id, job.id));
        await tx.insert(operationAudit).values({ id: randomUUID(), action: 'document.bundle.publish', targetId: job.id, actorUserId: job.createdBy, requestHash: file.sha256, details: { fileId: file.id, documents: sources.map((source) => source.documentId).join(','), sheetCount: String(workbook.sheets.length) } });
      });
      published = true;
    });
  } catch (error) { if (!(error instanceof BatchError) || error.code !== 'DOCUMENT_BUNDLE_REPLAY') throw error; }
  return published;
}
