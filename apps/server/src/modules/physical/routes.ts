import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { physicalAdoptSchema, physicalSaveSchema, physicalSyncInputSchema, physicalSyncRetrySchema, physicalWriteSchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { db } from '../../db/client.js';
import { fileIndex } from '../../db/schema.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { BatchError, requireBatchActor } from '../batches/service.js';
import { batchOperations } from '../batches/schema.js';
import { publishReportFile } from '../batches/report-service.js';
import { checkedFileBytes } from '../imports/service.js';
import { LingxingReadError } from '../lingxing/read-client.js';
import { PhysicalValidationError, pendingEntries } from './domain.js';
import { createPhysicalTemplate, parsePhysicalTemplate, readPhysicalTemplateId } from './workbook.js';
import { physicalIntakePreviews, physicalRevisions, physicalTemplates } from './schema.js';
import { adoptPhysicalSource, assertPhysicalWrite, confirmPhysicalReview, currentPhysicalSource, getPhysicalHistory, getPhysicalReview, lockPhysical, physicalDigest, physicalOperation, savePhysicalRevision, savePhysicalRevisionInTx } from './service.js';
import { getPhysicalSyncRun, requestPhysicalSync, retryPhysicalSync } from './sync.js';
import { getPhysicalExport, listPhysicalExports, reconcilePhysicalExports, requestPhysicalExport } from './exports.js';

type Variables = { actorId: string };
function authenticatedRouter() {
  const routes = new Hono<{ Variables: Variables }>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new BatchError('UNAUTHORIZED', 401, '请先登录。');
    if (session.user.banned || session.user.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '需要有效管理员身份。');
    await db.transaction((tx) => requireBatchActor(tx, session.user.id)); c.set('actorId', session.user.id);
    if (c.req.method === 'POST') {
      const config = readConfig(), origin = c.req.header('Origin');
      if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && ![new URL(config.WEB_ORIGIN).origin, new URL(config.BETTER_AUTH_URL).origin].includes(origin)) throw new BatchError('FORBIDDEN', 403, '请求来源不受信任。');
    }
    await next();
  });
  routes.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 + 64 * 1024, onError: (c) => c.json({ error: { code: 'FILE_TOO_LARGE', message: '核对文件不能超过10 MiB。' } }, 413) }));
  routes.onError((error, c) => {
    if (error instanceof LingxingReadError) return c.json({ error: { code: error.code, message: error.message } }, 503);
    if (error instanceof BatchError || error instanceof PhysicalValidationError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对对象编号、版本和请求内容。' } }, 422);
    if ('code' in error && 'status' in error && typeof error.code === 'string' && typeof error.status === 'number' && [403, 404, 409, 422, 503].includes(error.status)) return c.json({ error: { code: error.code, message: error.message } }, error.status as 422);
    logError('Physical review failed', error);
    return c.json({ error: { code: isDatabaseUnavailable(error) ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: '实物核对处理失败，请保持原操作编号重试。', traceId: randomUUID() } }, isDatabaseUnavailable(error) ? 503 : 500);
  });
  return routes;
}
const uuid = (value: unknown) => z.uuid().parse(value);
function queue(getBoss: () => PgBoss | null) { const boss = getBoss(); if (!boss) throw new BatchError('QUEUE_UNAVAILABLE', 503, '任务队列暂不可用。'); return boss; }

export function createPhysicalReviewRoutes(getBoss: () => PgBoss | null) {
  const routes = authenticatedRouter();
  routes.get('/', async (c) => c.json(await getPhysicalReview(uuid(c.req.param('id')), c.get('actorId'))));
  routes.get('/history', async (c) => c.json(await getPhysicalHistory(uuid(c.req.param('id')), c.get('actorId'))));
  routes.post('/sources', async (c) => c.json(await adoptPhysicalSource(uuid(c.req.param('id')), physicalAdoptSchema.parse(await c.req.json()), c.get('actorId'))));
  routes.post('/revisions', async (c) => c.json(await savePhysicalRevision(uuid(c.req.param('id')), physicalSaveSchema.parse(await c.req.json()), c.get('actorId'))));
  routes.post('/confirmations', async (c) => c.json(await confirmPhysicalReview(uuid(c.req.param('id')), physicalWriteSchema.parse(await c.req.json()), c.get('actorId'))));
  routes.post('/sync', async (c) => c.json(await requestPhysicalSync(queue(getBoss), uuid(c.req.param('id')), physicalSyncInputSchema.parse(await c.req.json()), c.get('actorId')), 202));
  routes.get('/sync/:runId', async (c) => c.json(await getPhysicalSyncRun(uuid(c.req.param('id')), uuid(c.req.param('runId')), c.get('actorId'))));
  routes.post('/sync/:runId/retry', async (c) => c.json(await retryPhysicalSync(queue(getBoss), uuid(c.req.param('id')), uuid(c.req.param('runId')), physicalSyncRetrySchema.parse(await c.req.json()), c.get('actorId')), 202));
  routes.get('/template.xlsx', async (c) => {
    const groupId = uuid(c.req.param('id')), actorId = c.get('actorId');
    const manifest = await db.transaction(async (tx) => {
      const context = await lockPhysical(tx, groupId, actorId), source = await currentPhysicalSource(tx, context);
      if (!source) throw new BatchError('SOURCE_REQUIRED', 422, '请先采用来源再下载核对模板。');
      const [revision] = context.state?.revisionId ? await tx.select().from(physicalRevisions).where(eq(physicalRevisions.id, context.state.revisionId)) : [];
      const manifest = { templateId: randomUUID(), source, entries: revision?.data.entries ?? pendingEntries(source), version: context.state?.version ?? 0, m2ConfirmationId: context.bundle.confirmation.id };
      await tx.insert(physicalTemplates).values({ id: manifest.templateId, groupId, manifest, createdBy: actorId }); return manifest;
    });
    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); c.header('Content-Disposition', 'attachment; filename="physical-review.xlsx"'); c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(await createPhysicalTemplate(manifest)));
  });
  routes.post('/intake', async (c) => {
    const groupId = uuid(c.req.param('id')), actorId = c.get('actorId'), form = await c.req.formData();
    const file = form.get('file'), phase = z.enum(['preview', 'commit']).parse(form.get('phase'));
    if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024 || !/\.xlsx$/i.test(file.name) || [...form.keys()].some((key) => form.getAll(key).length !== 1)) throw new BatchError('VALIDATION_ERROR', 422, '请选择不超过10 MiB的XLSX核对文件。');
    const allowed = new Set(['file', 'phase', 'operationId', 'm2ConfirmationId', 'expectedVersion', 'sourceFingerprint', 'previewId', 'sha256']);
    if ([...form.keys()].some((key) => !allowed.has(key))) throw new BatchError('VALIDATION_ERROR', 422, '核对上传包含不支持的参数。');
    const input = physicalWriteSchema.parse({ operationId: form.get('operationId'), m2ConfirmationId: form.get('m2ConfirmationId'), expectedVersion: Number(form.get('expectedVersion')), sourceFingerprint: form.get('sourceFingerprint') || null });
    const bytes = Buffer.from(await file.arrayBuffer()), sha256 = createHash('sha256').update(bytes).digest('hex');
    if (phase === 'commit') {
      const previewId = uuid(form.get('previewId'));
      if (form.get('sha256') !== sha256) throw new BatchError('FILE_CHANGED', 409, '预检后的文件已变化，请重新预检。');
      return c.json(await physicalOperation(actorId, input.operationId, 'physical.intake.commit', { groupId, ...input, previewId, sha256 }, async (tx) => {
        const [preview] = await tx.select().from(physicalIntakePreviews).where(eq(physicalIntakePreviews.id, previewId));
        if (!preview || preview.groupId !== groupId || preview.createdBy !== actorId || preview.sha256 !== sha256) throw new BatchError('PREVIEW_CONFLICT', 409, '预检不存在或不属于当前上传。');
        const [template] = await tx.select().from(physicalTemplates).where(eq(physicalTemplates.id, preview.templateId));
        if (!template || template.manifest.version !== input.expectedVersion || template.manifest.m2ConfirmationId !== input.m2ConfirmationId || template.manifest.source.fingerprint !== input.sourceFingerprint) throw new BatchError('VERSION_CONFLICT', 409, '核对模板版本已变化，请下载新模板。');
        const [sourceFile] = await tx.select().from(fileIndex).where(eq(fileIndex.id, preview.fileId));
        if (!sourceFile) throw new BatchError('FILE_UNAVAILABLE', 503, '预检原件丢失。');
        await checkedFileBytes(sourceFile);
        const entries = await parsePhysicalTemplate(bytes, template.manifest);
        return savePhysicalRevisionInTx(tx, groupId, { ...input, entries }, actorId);
      }));
    }
    const previewRequest = { groupId, ...input, sha256 };
    const [replayed] = await db.select().from(batchOperations).where(eq(batchOperations.operationId, input.operationId));
    if (replayed) {
      if (replayed.actorId !== actorId || replayed.requestHash !== physicalDigest({ action: 'physical.intake.preview', input: previewRequest })) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于不同请求。');
      return c.json(replayed.result);
    }
    const templateId = await readPhysicalTemplateId(bytes);
    const [template] = await db.select().from(physicalTemplates).where(eq(physicalTemplates.id, templateId));
    if (!template || template.groupId !== groupId) throw new BatchError('TEMPLATE_UNKNOWN', 422, '请使用该批次下载的原始核对模板。');
    if (template.manifest.version !== input.expectedVersion || template.manifest.m2ConfirmationId !== input.m2ConfirmationId || template.manifest.source.fingerprint !== input.sourceFingerprint) throw new BatchError('VERSION_CONFLICT', 409, '模板不属于当前确认版本，请重新下载。');
    const entries = await parsePhysicalTemplate(bytes, template.manifest), previewId = randomUUID();
    let result: Record<string, unknown> = {};
    await publishReportFile({ bytes, originalName: file.name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: actorId }, async (savedFile) => {
      result = await physicalOperation(actorId, input.operationId, 'physical.intake.preview', previewRequest, async (tx) => {
        const context = await lockPhysical(tx, groupId, actorId); await assertPhysicalWrite(context, input, tx);
        await tx.insert(fileIndex).values(savedFile);
        await tx.insert(physicalIntakePreviews).values({ id: previewId, groupId, templateId, sha256, fileId: savedFile.id, entries, createdBy: actorId });
        return { previewId, sha256, entries, boxCount: entries.length };
      });
      if (result.replayed) throw new BatchError('PREVIEW_REPLAY', 409, '预检已完成，返回原结果。');
    }).catch((error: unknown) => { if (!(error instanceof BatchError) || error.code !== 'PREVIEW_REPLAY') throw error; });
    return c.json(result);
  });
  return routes;
}
export function createPhysicalExportRoutes(getBoss: () => PgBoss | null) {
  const routes = authenticatedRouter();
  routes.get('/', async (c) => { const subBatchId = c.req.query('subBatchId'); const boss = getBoss(); if (boss) await reconcilePhysicalExports(boss); return c.json(await listPhysicalExports(c.get('actorId'), subBatchId ? uuid(subBatchId) : undefined)); });
  routes.get('/:id', async (c) => c.json(await getPhysicalExport(uuid(c.req.param('id')), c.get('actorId'))));
  routes.post('/', async (c) => c.json(await requestPhysicalExport(queue(getBoss), await c.req.json(), c.get('actorId')), 202));
  return routes;
}
