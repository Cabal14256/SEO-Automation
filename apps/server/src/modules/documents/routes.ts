import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { documentCandidateQuerySchema } from '@scm/contracts';
import { DOCUMENT_IMAGE_FIELDS_JSON_MAX_BYTES, documentCorrectInputSchema, documentCreateInputSchema, documentLingxingApplyInputSchema, documentLingxingPreviewInputSchema, documentListQuerySchema, documentOperationInputSchema, documentProductImagePreviewInputSchema, documentProfileCategorySchema, documentProfileWriteSchema, documentRevisionInputSchema, documentReviewInputSchema, documentTemplateWriteSchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { db } from '../../db/client.js';
import { fileIndex } from '../../db/schema.js';
import { batchOperations } from '../batches/schema.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { BatchError, requireBatchActor } from '../batches/service.js';
import { publishReportFile } from '../batches/report-service.js';
import { checkedFileBytes, ImportError } from '../imports/service.js';
import { documentDigest } from './domain.js';
import { getDocumentExport, listDocumentExports, readDocumentExport, requestDocumentExport } from './exports.js';
import { cancelDocument, changeDocumentProfileStatus, correctDocument, createDocument, documentOperation, getDocument, getDocumentHistory, getDocumentProfile, listDocumentCandidates, listDocumentProfiles, listDocuments, listDocumentTemplates, reviewDocument, reviseDocument, validateDocument, writeDocumentProfile } from './service.js';
import { documentProfileVersions, documentTemplateVersions, documentTemplates } from './schema.js';
import { cleanDocumentTemplate } from './workbook.js';
import { commitProfileImport, createProfileImportTemplate, previewProfileImport } from './profile-import.js';
import { applyDocumentLingxing, previewDocumentLingxing } from './lingxing-sync.js';
import { getDocumentFieldOptions } from './field-options.js';
import { previewDocumentProductImage } from './product-image.js';
import { documentAutomationRetryInputSchema, documentAutomationStartInputSchema, documentAutomationSupplementInputSchema } from '@scm/contracts';
import { deleteDocumentAutomation, getDocumentAutomation, getDocumentAutomationRequirements, listDocumentAutomations, retryDocumentAutomation, startDocumentAutomation, supplementDocumentAutomation } from './automation.js';
import { readDocumentBundle } from './document-bundle.js';

type Variables = { actorId: string };
const uuid = (value: unknown) => z.uuid().parse(value);
function router(imageFields = false) {
  const routes = new Hono<{ Variables: Variables }>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new BatchError('UNAUTHORIZED', 401, '请先登录。');
    if (session.user.banned || session.user.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '需要有效管理员身份。');
    await db.transaction((tx) => requireBatchActor(tx, session.user.id)); c.set('actorId', session.user.id);
    if (c.req.method !== 'GET') { const config = readConfig(), origin = c.req.header('Origin'); if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && ![new URL(config.WEB_ORIGIN).origin, new URL(config.BETTER_AUTH_URL).origin].includes(origin)) throw new BatchError('FORBIDDEN', 403, '请求来源不受信任。'); }
    await next();
  });
  routes.use('*', async (c, next) => {
    const imageRequest = imageFields && c.req.method === 'POST' && /\/documents(?:\/?$|\/[^/]+\/(?:revisions|correct)\/?$)/.test(c.req.path);
    return bodyLimit({ maxSize: imageRequest ? DOCUMENT_IMAGE_FIELDS_JSON_MAX_BYTES : 10 * 1024 * 1024 + 64 * 1024, onError: (context) => context.json({ error: { code: 'FILE_TOO_LARGE', message: imageRequest ? '本票资料和图片请求不能超过12 MiB。' : '单据文件不能超过10 MiB。' } }, 413) })(c, next);
  });
  routes.onError((error, c) => { if (error instanceof BatchError || error instanceof ImportError) return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status); if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对对象编号、版本和请求内容。' } }, 422); logError('Document request failed', error); return c.json({ error: { code: isDatabaseUnavailable(error) ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: '单据处理失败，请保持操作编号重试。', traceId: randomUUID() } }, isDatabaseUnavailable(error) ? 503 : 500); });
  return routes;
}
export function createDocumentRoutes(getBoss: () => PgBoss | null) {
  const routes = router(true);
  routes.get('/field-options', async (c) => c.json(await getDocumentFieldOptions(c.get('actorId'))));
  routes.get('/candidates', async (c) => c.json(await listDocumentCandidates(c.get('actorId'), documentCandidateQuerySchema.parse(c.req.query()))));
  routes.get('/automations', async (c) => c.json(await listDocumentAutomations(c.get('actorId'), c.req.query('shippingRunId') ? uuid(c.req.query('shippingRunId')) : undefined)));
  routes.post('/automations', async (c) => { const boss = getBoss(); if (!boss) throw new BatchError('QUEUE_UNAVAILABLE', 503, '自动出单队列暂不可用，请保持操作编号重试。'); return c.json(await startDocumentAutomation(boss, c.get('actorId'), documentAutomationStartInputSchema.parse(await c.req.json())), 202); });
  routes.get('/automations/:id', async (c) => c.json(await getDocumentAutomation(uuid(c.req.param('id')), c.get('actorId'))));
  routes.post('/automations/:id/delete', async (c) => c.json(await deleteDocumentAutomation(uuid(c.req.param('id')), c.get('actorId'), documentOperationInputSchema.parse(await c.req.json()))));
  routes.get('/automations/:id/requirements', async (c) => c.json(await getDocumentAutomationRequirements(uuid(c.req.param('id')), c.get('actorId'))));
  routes.post('/automations/:id/supplement', async (c) => { const boss = getBoss(); if (!boss) throw new BatchError('QUEUE_UNAVAILABLE', 503, '自动出单队列暂不可用，请保留填写内容稍后重试。'); return c.json(await supplementDocumentAutomation(boss, uuid(c.req.param('id')), c.get('actorId'), documentAutomationSupplementInputSchema.parse(await c.req.json())), 202); });
  routes.get('/automations/:id/download', async (c) => { const { file, bytes } = await readDocumentBundle(uuid(c.req.param('id')), c.get('actorId')); c.header('Content-Type', file.mimeType); c.header('Content-Disposition', `attachment; filename="invoice-bundle.${file.mimeType === 'application/zip' ? 'zip' : 'xlsx'}"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`); c.header('X-Content-Type-Options', 'nosniff'); return c.body(new Uint8Array(bytes)); });
  routes.post('/automations/:id/retry', async (c) => { const boss = getBoss(); if (!boss) throw new BatchError('QUEUE_UNAVAILABLE', 503, '自动出单队列暂不可用，请稍后续跑。'); return c.json(await retryDocumentAutomation(boss, uuid(c.req.param('id')), c.get('actorId'), documentAutomationRetryInputSchema.parse(await c.req.json())), 202); });
  routes.get('/', async (c) => c.json(await listDocuments(c.get('actorId'), documentListQuerySchema.parse(c.req.query()))));
  routes.post('/', async (c) => c.json(await createDocument(c.get('actorId'), documentCreateInputSchema.parse(await c.req.json())), 201));
  routes.get('/:id', async (c) => { const id = uuid(c.req.param('id')); return c.json({ ...await getDocument(id, c.get('actorId')), exports: (await listDocumentExports(id, c.get('actorId'))).items }); });
  routes.get('/:id/history', async (c) => c.json(await getDocumentHistory(uuid(c.req.param('id')), c.get('actorId'))));
  routes.post('/:id/revisions', async (c) => c.json(await reviseDocument(uuid(c.req.param('id')), c.get('actorId'), documentRevisionInputSchema.parse(await c.req.json()))));
  routes.post('/:id/lingxing-preview', async (c) => c.json(await previewDocumentLingxing(uuid(c.req.param('id')), c.get('actorId'), documentLingxingPreviewInputSchema.parse(await c.req.json()))));
  routes.post('/:id/lingxing-apply', async (c) => c.json(await applyDocumentLingxing(uuid(c.req.param('id')), c.get('actorId'), documentLingxingApplyInputSchema.parse(await c.req.json()))));
  routes.post('/:id/product-image-preview', async (c) => c.json(await previewDocumentProductImage(uuid(c.req.param('id')), c.get('actorId'), documentProductImagePreviewInputSchema.parse(await c.req.json()))));
  routes.post('/:id/validate', async (c) => c.json(await validateDocument(uuid(c.req.param('id')), c.get('actorId'), documentOperationInputSchema.parse(await c.req.json()))));
  routes.post('/:id/cancel', async (c) => c.json(await cancelDocument(uuid(c.req.param('id')), c.get('actorId'), documentOperationInputSchema.parse(await c.req.json()))));
  routes.post('/:id/correct', async (c) => c.json(await correctDocument(uuid(c.req.param('id')), c.get('actorId'), documentCorrectInputSchema.parse(await c.req.json())), 201));
  routes.post('/:id/review', async (c) => c.json(await reviewDocument(uuid(c.req.param('id')), c.get('actorId'), documentReviewInputSchema.parse(await c.req.json()))));
  routes.get('/:id/exports', async (c) => c.json(await listDocumentExports(uuid(c.req.param('id')), c.get('actorId'))));
  routes.post('/:id/exports', async (c) => { const boss = getBoss(); if (!boss) throw new BatchError('QUEUE_UNAVAILABLE', 503, '发票生成队列暂不可用。'); return c.json(await requestDocumentExport(boss, uuid(c.req.param('id')), c.get('actorId'), documentOperationInputSchema.parse(await c.req.json())), 202); });
  return routes;
}
export function createDocumentExportRoutes() { const routes = router(); routes.get('/:id', async (c) => c.json(await getDocumentExport(uuid(c.req.param('id')), c.get('actorId')))); routes.get('/:id/download', async (c) => { const { file, bytes } = await readDocumentExport(uuid(c.req.param('id')), c.get('actorId')); c.header('Content-Type', file.mimeType); c.header('Content-Disposition', `attachment; filename="invoice.xlsx"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`); c.header('X-Content-Type-Options', 'nosniff'); return c.body(new Uint8Array(bytes)); }); return routes; }
export function createDocumentProfileRoutes() {
  const routes = router();
  routes.get('/import-template.xlsx', async (c) => { c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); c.header('Content-Disposition', 'attachment; filename="document-profiles.xlsx"'); return c.body(new Uint8Array(await createProfileImportTemplate())); });
  routes.post('/import', async (c) => {
    const form = await c.req.formData(), phase = z.enum(['preview', 'commit']).parse(form.get('phase')), operationId = uuid(form.get('operationId'));
    if ([...form.keys()].some((key) => form.getAll(key).length !== 1)) throw new BatchError('VALIDATION_ERROR', 422, '资料导入参数不能重复。');
    if (phase === 'commit') {
      if ([...form.keys()].some((key) => !['phase', 'operationId', 'previewId', 'sha256', 'reason'].includes(key))) throw new BatchError('VALIDATION_ERROR', 422, '资料提交参数无效。');
      return c.json(await commitProfileImport(c.get('actorId'), { operationId, previewId: uuid(form.get('previewId')), sha256: z.string().regex(/^[a-f0-9]{64}$/).parse(form.get('sha256')), reason: z.string().trim().min(1).max(1000).parse(form.get('reason')) }));
    }
    const file = form.get('file');
    if ([...form.keys()].some((key) => !['phase', 'operationId', 'file'].includes(key)) || !(file instanceof File) || !/\.xlsx$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) throw new BatchError('VALIDATION_ERROR', 422, '请选择不超过10 MiB的 XLSX 资料文件。');
    return c.json(await previewProfileImport(c.get('actorId'), operationId, Buffer.from(await file.arrayBuffer()), file.name));
  });
  routes.get('/', async (c) => c.json(await listDocumentProfiles(c.get('actorId'), c.req.query('category') ? documentProfileCategorySchema.parse(c.req.query('category')) : undefined)));
  routes.post('/', async (c) => c.json(await writeDocumentProfile(c.get('actorId'), documentProfileWriteSchema.parse(await c.req.json())), 201));
  routes.get('/:id', async (c) => c.json(await getDocumentProfile(uuid(c.req.param('id')), c.get('actorId'))));
  routes.get('/:id/history', async (c) => { const rows = await db.select().from(documentProfileVersions).where(eq(documentProfileVersions.profileId, uuid(c.req.param('id')))); return c.json({ items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) }); });
  routes.post('/:id/retire', async (c) => c.json(await changeDocumentProfileStatus(uuid(c.req.param('id')), c.get('actorId'), documentOperationInputSchema.parse(await c.req.json()), 'retired')));
  routes.post('/:id/restore', async (c) => c.json(await changeDocumentProfileStatus(uuid(c.req.param('id')), c.get('actorId'), documentOperationInputSchema.parse(await c.req.json()), 'active')));
  return routes;
}
export function createDocumentTemplateRoutes() {
  const routes = router(); routes.get('/', async (c) => c.json(await listDocumentTemplates(c.get('actorId'))));
  routes.get('/:id/history', async (c) => { const rows = await db.select().from(documentTemplateVersions).where(eq(documentTemplateVersions.templateId, uuid(c.req.param('id')))); return c.json({ items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) }); });
  routes.post('/:id/retire', async (c) => { const id = uuid(c.req.param('id')), actorId = c.get('actorId'), input = documentOperationInputSchema.parse(await c.req.json()); return c.json(await documentOperation(actorId, input.operationId, 'document.template.retire', { id, ...input }, async (tx) => { const [record] = await tx.select().from(documentTemplates).where(eq(documentTemplates.id, id)).for('update'); if (!record) throw new BatchError('NOT_FOUND', 404, '模板不存在。'); if (record.version !== input.expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '模板版本已变化。'); await tx.update(documentTemplates).set({ status: 'retired', updatedAt: new Date() }).where(eq(documentTemplates.id, id)); return { templateId: id }; })); });
  routes.post('/', async (c) => {
    const form = await c.req.formData(), file = form.get('file'), input = documentTemplateWriteSchema.parse(Object.fromEntries([...form.entries()].filter(([key]) => key !== 'file')));
    if (!(file instanceof File) || !/\.xlsx$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024 || [...form.keys()].some((key) => form.getAll(key).length !== 1)) throw new BatchError('VALIDATION_ERROR', 422, '请选择不超过10 MiB的 XLSX 模板。');
    const originalBytes = Buffer.from(await file.arrayBuffer()), sha256 = createHash('sha256').update(originalBytes).digest('hex'), actorId = c.get('actorId'); let result: unknown;
    const action = 'document.template.upload', operationInput = { ...input, sha256 }, requestHash = documentDigest({ action, input: operationInput });
    const [replayed] = await db.select().from(batchOperations).where(eq(batchOperations.operationId, input.operationId));
    if (replayed) { if (replayed.actorId !== actorId || replayed.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于不同请求。'); return c.json({ ...replayed.result, replayed: true }); }
    let bytes: Buffer;
    try { bytes = await cleanDocumentTemplate(originalBytes); }
    catch (error) { if (error instanceof ImportError) throw error; throw new BatchError('INVALID_TEMPLATE', 422, '模板布局或内容不符合当前受控单据模板，请使用已确认的 XLSX 模板。'); }
    await publishReportFile({ bytes, originalName: file.name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: actorId }, async (saved) => { result = await documentOperation(actorId, input.operationId, 'document.template.upload', { ...input, sha256 }, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-template:${input.purpose}:${input.name}`},0))`);
      const [old] = await tx.select().from(documentTemplates).where(and(eq(documentTemplates.purpose, input.purpose), eq(documentTemplates.name, input.name))).for('update');
      if (old && old.version !== input.expectedVersion || !old && input.expectedVersion !== undefined) throw new BatchError('VERSION_CONFLICT', 409, '模板版本已变化，请重新读取后提交；新模板不填写预期版本。');
      const version = (old?.version ?? 0) + 1, id = old?.id ?? randomUUID();
      await tx.insert(fileIndex).values(saved);
      if (old) await tx.update(documentTemplates).set({ version, status: 'active', updatedAt: new Date() }).where(eq(documentTemplates.id, id)); else await tx.insert(documentTemplates).values({ id, purpose: input.purpose, name: input.name, createdBy: actorId });
      await tx.insert(documentTemplateVersions).values({ id: randomUUID(), templateId: id, version, fileId: saved.id, sha256: saved.sha256, mimeType: saved.mimeType, originalName: saved.originalName, reason: input.reason, createdBy: actorId });
      return { template: { id, purpose: input.purpose, name: input.name, version, status: 'active', fileId: saved.id, sha256: saved.sha256, mimeType: saved.mimeType, createdBy: actorId, createdAt: new Date().toISOString() } };
    }); if (result && typeof result === 'object' && 'replayed' in result && result.replayed) throw new BatchError('DOCUMENT_TEMPLATE_REPLAY', 409, '模板已提交，请保持操作编号重试。'); }).catch(async (error: unknown) => { if (!(error instanceof BatchError) || error.code !== 'DOCUMENT_TEMPLATE_REPLAY') throw error; const [replay] = await db.select().from(batchOperations).where(eq(batchOperations.operationId, input.operationId)); if (!replay) throw error; result = { ...replay.result, replayed: true }; }); return c.json(result, 201);
  });
  routes.get('/:id/download', async (c) => { const id = uuid(c.req.param('id')), queryVersion = c.req.query('version'); const [template] = await db.select().from(documentTemplates).where(eq(documentTemplates.id, id)); if (!template) throw new BatchError('NOT_FOUND', 404, '模板不存在。'); const [version] = await db.select().from(documentTemplateVersions).where(and(eq(documentTemplateVersions.templateId, id), eq(documentTemplateVersions.version, queryVersion ? z.coerce.number().int().positive().parse(queryVersion) : template.version))); if (!version) throw new BatchError('NOT_FOUND', 404, '模板版本不存在。'); const [file] = await db.select().from(fileIndex).where(eq(fileIndex.id, version.fileId)); if (!file || file.sha256 !== version.sha256) throw new BatchError('FILE_UNAVAILABLE', 503, '模板文件索引缺失或不一致。'); c.header('Content-Type', version.mimeType); c.header('Content-Disposition', `attachment; filename="invoice-template.xlsx"; filename*=UTF-8''${encodeURIComponent(version.originalName)}`); c.header('X-Content-Type-Options', 'nosniff'); return c.body(new Uint8Array(await checkedFileBytes(file))); }); return routes;
}
