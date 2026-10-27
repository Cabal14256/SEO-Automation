import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { workflowExportInputSchema, workflowWriteSchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { BatchError } from '../batches/service.js';
import { ImportError } from '../imports/service.js';
import { ArchiveValidationError } from '../imports/zip-preflight.js';
import { financeImportTemplate, parseFinanceWorkbook } from '../finance/workbook.js';
import { attachWorkflowFile, readWorkflowFile } from './files.js';
import { getWorkflowDetail, listWorkflowRecords, listWorkflowSources, writeWorkflow } from './service.js';
import { getWorkflowExport, readWorkflowExport, requestWorkflowExport } from './exports.js';
import type { WorkflowPolicy } from './policy.js';
import { requireWorkflowAvailable } from './maintenance.js';

type Variables = { actorId: string };
const uuid = (value: unknown) => z.uuid().parse(value);
export function workflowRouter() {
  const routes = new Hono<{ Variables: Variables }>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new BatchError('UNAUTHORIZED', 401, '请先登录。');
    if (session.user.banned || session.user.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '需要有效管理员身份。');
    if (c.req.method !== 'GET') { const origin = c.req.header('Origin'), config = readConfig(); if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && ![new URL(config.WEB_ORIGIN).origin, new URL(config.BETTER_AUTH_URL).origin].includes(origin)) throw new BatchError('FORBIDDEN', 403, '请求来源不受信任。'); }
    c.set('actorId', session.user.id); await next();
  });
  routes.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 + 65536, onError: (c) => c.json({ error: { code: 'FILE_TOO_LARGE', message: '请求不能超过10 MiB。' } }, 413) }));
  routes.onError((error, c) => {
    if (error instanceof BatchError || error instanceof ImportError) return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof ArchiveValidationError) return c.json({ error: { code: 'VALIDATION_ERROR', message: error instanceof z.ZodError ? error.issues[0]?.message ?? '字段无效。' : '文件或请求格式无效。' } }, 422);
    logError('Workflow request failed', error); return c.json({ error: { code: isDatabaseUnavailable(error) ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: '处理失败，请保留输入和原操作编号重试。', traceId: randomUUID() } }, isDatabaseUnavailable(error) ? 503 : 500);
  });
  return routes;
}
export function createWorkflowRoutes(policy: WorkflowPolicy, getBoss: () => PgBoss | null) {
  const routes = workflowRouter();
  routes.use('*', async (_c, next) => { requireWorkflowAvailable(policy.kind); await next(); });
  if (policy.kind === 'finance') {
    routes.get('/import-template', async () => { const artifact = await financeImportTemplate(); return new Response(new Uint8Array(artifact.bytes), { headers: { 'Content-Type': artifact.mimeType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`, 'X-Content-Type-Options': 'nosniff' } }); });
    routes.post('/:id/import-preview', async (c) => {
      const form = await c.req.parseBody(), upload = form.file; if (!(upload instanceof File) || !/\.xlsx$/i.test(upload.name)) throw new BatchError('INVALID_FILE_TYPE', 422, '费用预检仅接受标准 XLSX。');
      const bytes = Buffer.from(await upload.arrayBuffer()), parsed = await parseFinanceWorkbook(bytes);
      const result = await attachWorkflowFile(c.get('actorId'), { recordId: uuid(c.req.param('id')), operationId: uuid(form.operationId), purpose: 'bill', bytes, name: upload.name, mimeType: upload.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      return c.json({ ...parsed, file: result.file });
    });
  }
  routes.get('/', async (c) => c.json(await listWorkflowRecords(c.get('actorId'), policy.kind, c.req.query(), policy)));
  routes.post('/', async (c) => c.json(await writeWorkflow(c.get('actorId'), policy, workflowWriteSchema.parse(await c.req.json())), 201));
  routes.get('/:id', async (c) => c.json(await getWorkflowDetail(uuid(c.req.param('id')), c.get('actorId'), policy)));
  routes.put('/:id', async (c) => c.json(await writeWorkflow(c.get('actorId'), policy, workflowWriteSchema.parse(await c.req.json()), uuid(c.req.param('id')))));
  routes.post('/:id/actions', async (c) => c.json(await writeWorkflow(c.get('actorId'), policy, workflowWriteSchema.parse(await c.req.json()), uuid(c.req.param('id')))));
  routes.post('/:id/exports', async (c) => { const boss = getBoss(); if (!boss) throw new BatchError('QUEUE_UNAVAILABLE', 503, 'Worker 队列暂不可用。'); const record = await getWorkflowDetail(uuid(c.req.param('id')), c.get('actorId'), policy); return c.json(await requestWorkflowExport(boss, record.record.id, c.get('actorId'), workflowExportInputSchema.parse(await c.req.json())), 202); });
  return routes;
}
export function createWorkflowSourceRoutes() {
  const routes = workflowRouter();
  routes.get('/', async (c) => c.json(await listWorkflowSources(c.get('actorId'), z.uuid().optional().parse(c.req.query('shippingRunId')))));
  return routes;
}
export function createWorkflowFileRoutes() {
  const routes = workflowRouter();
  routes.post('/', async (c) => { const form = await c.req.parseBody(), upload = form.file; if (!(upload instanceof File)) throw new BatchError('FILE_REQUIRED', 422, '请选择附件。'); return c.json(await attachWorkflowFile(c.get('actorId'), { recordId: uuid(form.recordId), operationId: uuid(form.operationId), purpose: z.string().trim().min(1).max(60).parse(form.purpose), bytes: Buffer.from(await upload.arrayBuffer()), name: upload.name, mimeType: upload.type || 'application/octet-stream' }), 201); });
  routes.get('/:id/download', async (c) => { const { file, bytes } = await readWorkflowFile(uuid(c.req.param('id')), c.get('actorId')); return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } }); });
  return routes;
}
export function createWorkflowExportRoutes() {
  const routes = workflowRouter();
  routes.get('/:id', async (c) => c.json(await getWorkflowExport(uuid(c.req.param('id')), c.get('actorId'))));
  routes.get('/:id/download', async (c) => { const { file, bytes } = await readWorkflowExport(uuid(c.req.param('id')), c.get('actorId')); return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } }); });
  return routes;
}
