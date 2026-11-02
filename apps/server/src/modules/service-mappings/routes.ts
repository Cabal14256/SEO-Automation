import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { serviceMappingCreateInputSchema, serviceMappingDeleteInputSchema, serviceMappingRevisionInputSchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { db } from '../../db/client.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { BatchError, requireBatchActor } from '../batches/service.js';
import { createServiceMapping, deleteServiceMapping, getServiceMappingOptions, listServiceMappings, reviseServiceMapping } from './service.js';

export function createServiceMappingRoutes() {
  const routes = new Hono<{ Variables: { actorId: string } }>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new BatchError('UNAUTHORIZED', 401, '请先登录。');
    if (session.user.banned || session.user.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '需要有效管理员身份。');
    await db.transaction((tx) => requireBatchActor(tx, session.user.id));
    c.set('actorId', session.user.id);
    if (c.req.method !== 'GET') {
      const config = readConfig(), origin = c.req.header('Origin');
      if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && ![new URL(config.WEB_ORIGIN).origin, new URL(config.BETTER_AUTH_URL).origin].includes(origin)) throw new BatchError('FORBIDDEN', 403, '请求来源不受信任。');
      if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new BatchError('VALIDATION_ERROR', 422, '请提交 JSON 数据。');
    }
    await next();
  });
  routes.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: { code: 'REQUEST_TOO_LARGE', message: '服务映射请求过大。' } }, 413) }));
  routes.get('/options', async (c) => c.json(await getServiceMappingOptions(c.get('actorId'))));
  routes.get('/', async (c) => c.json(await listServiceMappings(c.get('actorId'))));
  routes.post('/', async (c) => c.json(await createServiceMapping(c.get('actorId'), serviceMappingCreateInputSchema.parse(await c.req.json())), 201));
  routes.post('/:id/revisions', async (c) => c.json(await reviseServiceMapping(z.uuid().parse(c.req.param('id')), c.get('actorId'), serviceMappingRevisionInputSchema.parse(await c.req.json()))));
  routes.post('/:id/delete', async (c) => c.json(await deleteServiceMapping(z.uuid().parse(c.req.param('id')), c.get('actorId'), serviceMappingDeleteInputSchema.parse(await c.req.json()))));
  routes.onError((error, c) => {
    if (error instanceof BatchError) return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对国家、运输方式、服务及版本。' } }, 422);
    logError('Service mapping request failed', error);
    return c.json({ error: { code: isDatabaseUnavailable(error) ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: '服务映射处理失败，请保留输入和操作编号重试。', traceId: randomUUID() } }, isDatabaseUnavailable(error) ? 503 : 500);
  });
  return routes;
}
