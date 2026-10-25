import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { addShippingTicketInputSchema, appendShippingTicketMembersInputSchema, correctShippingRunInputSchema, createManualShippingRunInputSchema, createShippingRunInputSchema, retryShippingRunInputSchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { logError } from '../../errors.js';
import { BatchError } from '../batches/service.js';
import { createShippingRun, getShippingRun, listShippingRuns, retryShippingRun } from './service.js';
import { addShippingTicket, appendShippingTicketMembers, correctShippingRun, createManualShippingRun } from './manual.js';

export function createShippingRunRoutes(getBoss: () => PgBoss | null) {
  const routes = new Hono<{ Variables: { actorId: string } }>();
  routes.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '发货整理请求过大。', traceId: randomUUID() } }, 413) }));
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new BatchError('UNAUTHORIZED', 401, '请先登录。');
    if (session.user.banned || session.user.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '当前账号没有发货整理权限。');
    c.set('actorId', session.user.id);
    if (c.req.method === 'POST') {
      const config = readConfig(); const origin = c.req.header('Origin');
      if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && ![new URL(config.BETTER_AUTH_URL).origin, new URL(config.WEB_ORIGIN).origin].includes(origin)) throw new BatchError('FORBIDDEN', 403, '请求来源不受信任。');
    }
    await next();
  });
  const queue = () => { const boss = getBoss(); if (!boss) throw new BatchError('QUEUE_UNAVAILABLE', 503, '后台整理队列暂不可用。'); return boss; };
  routes.get('/', async (c) => c.json(await listShippingRuns(c.get('actorId'))));
  routes.post('/', async (c) => c.json(await createShippingRun(queue(), createShippingRunInputSchema.parse(await c.req.json()), c.get('actorId')), 202));
  routes.post('/manual', async (c) => c.json(await createManualShippingRun(createManualShippingRunInputSchema.parse(await c.req.json()), c.get('actorId')), 201));
  routes.get('/:id', async (c) => c.json(await getShippingRun(z.uuid().parse(c.req.param('id')), c.get('actorId'))));
  routes.post('/:id/retry', async (c) => c.json(await retryShippingRun(queue(), z.uuid().parse(c.req.param('id')), retryShippingRunInputSchema.parse(await c.req.json()), c.get('actorId')), 202));
  routes.post('/:id/tickets', async (c) => c.json(await addShippingTicket(z.uuid().parse(c.req.param('id')), addShippingTicketInputSchema.parse(await c.req.json()), c.get('actorId')), 201));
  routes.post('/:id/tickets/:ticketId/members', async (c) => c.json(await appendShippingTicketMembers(z.uuid().parse(c.req.param('id')), z.uuid().parse(c.req.param('ticketId')), appendShippingTicketMembersInputSchema.parse(await c.req.json()), c.get('actorId'))));
  routes.post('/:id/correction', async (c) => c.json(await correctShippingRun(z.uuid().parse(c.req.param('id')), correctShippingRunInputSchema.parse(await c.req.json()), c.get('actorId'))));
  routes.onError((error, c) => {
    const status = error instanceof BatchError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 500;
    if (status === 500) logError('Shipping run API failed', error);
    return c.json({ error: { code: error instanceof BatchError ? error.code : status === 422 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', message: error instanceof BatchError ? error.message : status === 422 ? '请核对发货整理参数。' : '发货整理暂不可用，请稍后重试。', ...(error instanceof BatchError && error.details ? { details: error.details } : {}), traceId: randomUUID() } }, status as 400);
  });
  return routes;
}
