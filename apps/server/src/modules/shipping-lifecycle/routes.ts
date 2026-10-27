import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { shippingLifecycleActionSchema, shippingLifecycleInputSchema, shippingRecycleQuerySchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { logError } from '../../errors.js';
import { BatchError } from '../batches/service.js';
import { changeShippingLifecycle, getShippingLifecycleImpact, listShippingRecycleBin } from './service.js';

export function createShippingLifecycleRoutes() {
  const routes = new Hono<{ Variables: { actorId: string } }>();
  function protectedRouter() {
  const authorized = new Hono<{ Variables: { actorId: string } }>();
  authorized.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '生命周期请求过大。', traceId: randomUUID() } }, 413) }));
  authorized.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new BatchError('UNAUTHORIZED', 401, '请先登录。');
    if (session.user.banned || session.user.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '当前账号没有发货管理权限。');
    c.set('actorId', session.user.id);
    if (c.req.method === 'POST') {
      const config = readConfig(), origin = c.req.header('Origin');
      if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && ![new URL(config.BETTER_AUTH_URL).origin, new URL(config.WEB_ORIGIN).origin].includes(origin)) throw new BatchError('FORBIDDEN', 403, '请求来源不受信任。');
      if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new BatchError('VALIDATION_ERROR', 422, '请提交 JSON 操作内容。');
    }
    await next();
  });
  return authorized;
  }
  // Mount exact leaf routers, so middleware cannot intercept unrelated /api/v1 routes.
  for (const [resource, type] of [['shipping-runs', 'run'], ['sub-batches', 'group'], ['demands', 'demand']] as const) {
    const leaf = protectedRouter();
    leaf.get('/', async (c) => {
      return c.json(await getShippingLifecycleImpact(type, z.uuid().parse((c.req.param() as Record<string, string>).id), shippingLifecycleActionSchema.parse(c.req.query('action')), c.get('actorId')));
    });
    routes.route(`/${resource}/:id/lifecycle-impact`, leaf);
    const mutations = protectedRouter();
    mutations.post('/', async (c) => {
      const params = c.req.param() as Record<string, string>;
      const result = await changeShippingLifecycle(type, z.uuid().parse(params.id), shippingLifecycleActionSchema.parse(params.action), shippingLifecycleInputSchema.parse(await c.req.json()), c.get('actorId'));
      return c.json(result, result.pending ? 202 : 200);
    });
    routes.route(`/${resource}/:id/lifecycle/:action`, mutations);
  }
  const recycle = protectedRouter();
  recycle.get('/', async (c) => {
    return c.json(await listShippingRecycleBin(c.get('actorId'), shippingRecycleQuerySchema.parse(c.req.query())));
  });
  routes.route('/shipping-recycle-bin', recycle);
  routes.onError((error, c) => {
    const status = error instanceof BatchError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 500;
    if (status === 500) logError('Shipping lifecycle request failed', error);
    return c.json({ error: { code: error instanceof BatchError ? error.code : status === 422 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', message: error instanceof BatchError ? error.message : status === 422 ? '请核对操作参数。' : '发货管理暂不可用，请稍后重试。', ...(error instanceof BatchError && error.details ? { details: error.details } : {}), traceId: randomUUID() } }, status);
  });
  return routes;
}
