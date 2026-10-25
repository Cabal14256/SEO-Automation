import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import {
  IMPORT_MAX_BYTES, importCommitInputSchema, importPageQuerySchema, importParseInputSchema,
  importPreviewInputSchema, importPreviewQuerySchema, importRowsQuerySchema, onlineImportInputSchema, fbaLookupInputSchema, demandWorkspaceQuerySchema,
  IMPORT_DRAFT_MAX_BODY_BYTES, importDraftListQuerySchema, saveImportDraftInputSchema, deleteImportDraftQuerySchema, demandRevisionInputSchema, demandCancelInputSchema,
} from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { canImport, checkedFileBytes, createSourceImport, getSourceImport, ImportError, listImportRows, listImportRuns, listSourceImports, readImportFile, reconcileImportRuns, requestImportParse } from './service.js';
import { commitImport, createImportPreview, getConfirmationContext, getDemandDetail, getImportPreview, getImportPreviewCsv, listImportCommits } from './confirmation.js';
import { BatchError } from '../batches/service.js';
import { readExportFile } from '../batches/report-service.js';
import { readPhysicalExportFile } from '../physical/exports.js';
import { createOnlineImport } from './online.js';
import { requestFbaLookup, getFbaLookup, reconcileFbaLookups } from './fba-lookup.js';
import { getDemandWorkspace } from './workspace.js';
import { CatalogError } from '../seller-mappings/catalog.js';
import { buildImportTemplate, IMPORT_TEMPLATE_FILE_NAME } from './template.js';
import { deleteImportDraft, getImportDraft, listImportDrafts, saveImportDraft } from './drafts.js';
import { cancelDemand, getDemandManagement, reviseDemand } from './demand-management.js';
import { getTransportMethods } from './transport-methods.js';
import { LingxingReadError } from '../lingxing/read-client.js';

type Variables = { actorId: string; traceId: string };
export function createImportRoutes(getBoss: () => PgBoss | null) {
  const routes = new Hono<{ Variables: Variables }>();
  routes.use('*', async (c, next) => {
    c.set('traceId', randomUUID()); c.header('Cache-Control', 'no-store');
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!current) throw new ImportError('UNAUTHORIZED', 401, '请先登录。');
    if (current.user.banned || !canImport(current.user.role)) throw new ImportError('FORBIDDEN', 403, '当前账号没有需求导入权限。');
    c.set('actorId', current.user.id);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      const config = readConfig();
      const origin = c.req.header('Origin');
      if ((origin && ![new URL(config.BETTER_AUTH_URL).origin, new URL(config.WEB_ORIGIN).origin].includes(origin)) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw new ImportError('FORBIDDEN', 403, '请求来源不受信任。');
    }
    await next();
  });
  routes.use('*', (c, next) => bodyLimit({ maxSize: /\/drafts(?:\/|$)/.test(c.req.path) ? IMPORT_DRAFT_MAX_BODY_BYTES : IMPORT_MAX_BYTES + 64 * 1024, onError: (context) => context.json({ error: { code: 'FILE_TOO_LARGE', message: '请求超过保存限制，请选择不超过 10 MiB 的文件。', traceId: c.get('traceId') } }, 413) })(c, next));
  const uuid = (id: string) => { if (!z.uuid().safeParse(id).success) throw new ImportError('VALIDATION_ERROR', 422, '对象编号无效。'); return id; };
  const boss = () => { const value = getBoss(); if (!value) throw new ImportError('QUEUE_UNAVAILABLE', 503, '解析队列暂不可用，请稍后重试。'); return value; };
  routes.get('/', async (c) => {
    const parsed = importPageQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '分页条件无效。');
    return c.json(await listSourceImports(c.get('actorId'), parsed.data));
  });
  routes.get('/template', async (c) => {
    const bytes = await buildImportTemplate();
    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="demand-import-template.xlsx"; filename*=UTF-8''${encodeURIComponent(IMPORT_TEMPLATE_FILE_NAME)}`);
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(bytes));
  });
  routes.post('/', async (c) => {
    const queue = boss();
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('multipart/form-data')) throw new ImportError('VALIDATION_ERROR', 422, '请使用文件上传表单。');
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    const operationId = form?.get('operationId');
    if (!form || [...form.keys()].some((key) => !['file', 'operationId'].includes(key)) || form.getAll('file').length !== 1 || form.getAll('operationId').length !== 1 || !(file instanceof File) || !z.uuid().safeParse(operationId).success) throw new ImportError('VALIDATION_ERROR', 422, '需要一个 XLSX 文件和有效的操作编号。');
    if (!file.size || file.size > IMPORT_MAX_BYTES) throw new ImportError('FILE_TOO_LARGE', 413, '文件必须非空且不超过 10 MiB。');
    const bytes = Buffer.from(await file.arrayBuffer());
    const accepted = await createSourceImport(queue, { bytes, originalName: file.name, operationId: operationId as string, actorUserId: c.get('actorId'), receivedAt: new Date() });
    return c.json(accepted, 202);
  });
  routes.get('/transport-methods', async (c) => c.json(await getTransportMethods()));
  routes.post('/online', async (c) => {
    const parsed = onlineImportInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '在线表格格式无效，请检查行数和字段长度。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
    return c.json(await createOnlineImport(boss(), parsed.data, c.get('actorId')), 202);
  });
  routes.post('/fba-lookups', async (c) => {
    const parsed = fbaLookupInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对 FBA、创建日期范围和店铺目录版本。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
    return c.json(await requestFbaLookup(boss(), parsed.data, c.get('actorId')), 202);
  });
  routes.get('/fba-lookups/:lookupId', async (c) => {
    const id = uuid(c.req.param('lookupId'));
    const queue = getBoss();
    if (queue) await reconcileFbaLookups(queue, id);
    return c.json(await getFbaLookup(id, c.get('actorId')));
  });
  routes.get('/drafts', async (c) => {
    const parsed = importDraftListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '草稿筛选或分页条件无效。');
    return c.json(await listImportDrafts(c.get('actorId'), parsed.data));
  });
  routes.get('/drafts/:draftId', async (c) => c.json({ draft: await getImportDraft(uuid(c.req.param('draftId')), c.get('actorId')) }));
  routes.put('/drafts/:draftId', async (c) => {
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ImportError('VALIDATION_ERROR', 422, '请提交 JSON 草稿内容。');
    const parsed = saveImportDraftInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '草稿格式无效，请检查标题、行数或文件大小。', parsed.error.flatten());
    return c.json(await saveImportDraft(uuid(c.req.param('draftId')), parsed.data, c.get('actorId')));
  });
  routes.delete('/drafts/:draftId', async (c) => {
    const parsed = deleteImportDraftQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '删除草稿需要当前版本号。');
    return c.json(await deleteImportDraft(uuid(c.req.param('draftId')), parsed.data.version, c.get('actorId')));
  });
  routes.get('/:id', async (c) => {
    const id = uuid(c.req.param('id'));
    await getSourceImport(id, c.get('actorId'));
    const queue = getBoss(); if (queue) await reconcileImportRuns(queue, id);
    return c.json({ import: await getSourceImport(id, c.get('actorId')) });
  });
  routes.get('/:id/rows', async (c) => {
    const parsed = importRowsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '预览分页或筛选条件无效。');
    return c.json(await listImportRows(uuid(c.req.param('id')), c.get('actorId'), parsed.data));
  });
  routes.get('/:id/runs', async (c) => c.json(await listImportRuns(uuid(c.req.param('id')), c.get('actorId'))));
  routes.post('/:id/parse', async (c) => {
    const id = uuid(c.req.param('id'));
    await getSourceImport(id, c.get('actorId'));
    const queue = boss(); await reconcileImportRuns(queue, id);
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ImportError('VALIDATION_ERROR', 422, '请提交 JSON 解析选项。');
    const parsed = importParseInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对工作表、映射和版本。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
    return c.json(await requestImportParse(queue, id, parsed.data, c.get('actorId')), 202);
  });
  routes.get('/:id/confirmation', async (c) => c.json(await getConfirmationContext(uuid(c.req.param('id')), c.get('actorId'))));
  routes.post('/:id/preview', async (c) => {
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ImportError('VALIDATION_ERROR', 422, '请提交 JSON 店铺确认和预览选项。');
    const parsed = importPreviewInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对解析版本和本次店铺确认。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
    return c.json(await createImportPreview(uuid(c.req.param('id')), parsed.data, c.get('actorId')), 201);
  });
  routes.get('/:id/previews/:previewId', async (c) => {
    const parsed = importPreviewQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '差异分页或筛选条件无效。');
    return c.json(await getImportPreview(uuid(c.req.param('id')), uuid(c.req.param('previewId')), c.get('actorId'), parsed.data));
  });
  routes.get('/:id/previews/:previewId/errors.csv', async (c) => {
    const csv = await getImportPreviewCsv(uuid(c.req.param('id')), uuid(c.req.param('previewId')), c.get('actorId'));
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="import-issues.csv"');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(csv);
  });
  routes.post('/:id/commit', async (c) => {
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ImportError('VALIDATION_ERROR', 422, '请提交 JSON 确认范围。');
    const parsed = importCommitInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请选择提交范围，并核对变化确认。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
    return c.json(await commitImport(uuid(c.req.param('id')), parsed.data, c.get('actorId')));
  });
  routes.get('/:id/commits', async (c) => c.json(await listImportCommits(uuid(c.req.param('id')), c.get('actorId'))));
  routes.onError((error, c) => {
    if (error instanceof LingxingReadError) return c.json({ error: { code: error.code, message: error.message, traceId: c.get('traceId') } }, 503);
    if (error instanceof CatalogError) return c.json({ error: { code: error.code, message: error.message, traceId: c.get('traceId') } }, error.status);
    if (error instanceof ImportError || error instanceof BatchError) return c.json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }), traceId: c.get('traceId') } }, error.status);
    logError('Import API request failed', error);
    const unavailable = isDatabaseUnavailable(error);
    return c.json({ error: { code: unavailable ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: unavailable ? '数据库暂不可用，请稍后重试。' : '导入处理失败，请保留原文件并重试。', traceId: c.get('traceId') } }, unavailable ? 503 : 500);
  });
  return routes;
}

export function createDemandRoutes() {
  const routes = new Hono<{ Variables: Variables }>();
  routes.use('*', async (c, next) => {
    c.set('traceId', randomUUID()); c.header('Cache-Control', 'no-store');
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!current) throw new ImportError('UNAUTHORIZED', 401, '请先登录。');
    if (current.user.banned || !canImport(current.user.role)) throw new ImportError('FORBIDDEN', 403, '当前账号没有需求访问权限。');
    c.set('actorId', current.user.id);
    if (c.req.method !== 'GET') {
      const config = readConfig(), origin = c.req.header('Origin');
      if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && ![new URL(config.BETTER_AUTH_URL).origin, new URL(config.WEB_ORIGIN).origin].includes(origin)) throw new ImportError('FORBIDDEN', 403, '请求来源不受信任。');
    }
    await next();
  });
  routes.use('*', bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: { code: 'FILE_TOO_LARGE', message: '需求修改内容过大。' } }, 413) }));
  routes.get('/', async (c) => {
    const parsed = demandWorkspaceQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '需求列表筛选条件无效。', parsed.error.flatten());
    return c.json(await getDemandWorkspace(c.get('actorId'), parsed.data));
  });
  routes.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new ImportError('VALIDATION_ERROR', 422, '需求编号无效。');
    return c.json({ ...await getDemandDetail(id, c.get('actorId')), ...await getDemandManagement(id, c.get('actorId')) });
  });
  routes.post('/:id/revisions', async (c) => {
    const id = c.req.param('id'), input = demandRevisionInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(id).success || !input.success) throw new ImportError('VALIDATION_ERROR', 422, '请核对需求编号、版本、修改字段和原因。');
    return c.json(await reviseDemand(id, c.get('actorId'), input.data));
  });
  routes.post('/:id/cancel', async (c) => {
    const id = c.req.param('id'), input = demandCancelInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(id).success || !input.success) throw new ImportError('VALIDATION_ERROR', 422, '请核对需求编号、版本和删除原因。');
    return c.json(await cancelDemand(id, c.get('actorId'), input.data));
  });
  routes.onError((error, c) => {
    if (error instanceof ImportError || error instanceof BatchError) return c.json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }), traceId: c.get('traceId') } }, error.status);
    logError('Demand API request failed', error);
    const unavailable = isDatabaseUnavailable(error);
    return c.json({ error: { code: unavailable ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: unavailable ? '数据库暂不可用，请稍后重试。' : '需求读取失败，请稍后重试。', traceId: c.get('traceId') } }, unavailable ? 503 : 500);
  });
  return routes;
}

export function createImportFileRoutes() {
  const routes = new Hono();
  routes.get('/:fileId/download', async (c) => {
    const traceId = randomUUID();
    c.header('Cache-Control', 'no-store');
    try {
      const current = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!current) throw new ImportError('UNAUTHORIZED', 401, '请先登录。');
      if (current.user.banned || !canImport(current.user.role)) throw new ImportError('FORBIDDEN', 403, '当前账号没有原文件访问权限。');
      if (!z.uuid().safeParse(c.req.param('fileId')).success) throw new ImportError('VALIDATION_ERROR', 422, '文件编号无效。');
      const source = await readImportFile(c.req.param('fileId'), current.user.id).catch(async (error: unknown) => {
        if (error instanceof ImportError && error.code === 'NOT_FOUND') return readExportFile(c.req.param('fileId')).catch((failure: unknown) => {
          if (failure instanceof BatchError && failure.code === 'NOT_FOUND') return readPhysicalExportFile(c.req.param('fileId'), current.user.id);
          throw failure;
        });
        throw error;
      });
      const { file } = source;
      const bytes = await checkedFileBytes(file);
      c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      c.header('Content-Disposition', `attachment; filename="source.xlsx"; filename*=UTF-8''${encodeURIComponent(file.originalName).replace(/'/g, '%27')}`);
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(bytes));
    } catch (error) {
      if (error instanceof ImportError || error instanceof BatchError) return c.json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }), traceId } }, error.status);
      logError('Import source download failed', error);
      return c.json({ error: { code: isDatabaseUnavailable(error) ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: '原文件暂不可用。', traceId } }, isDatabaseUnavailable(error) ? 503 : 500);
    }
  });
  return routes;
}
