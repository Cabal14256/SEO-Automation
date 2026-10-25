import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { manualSellerCreateSchema, sellerAliasRevisionSchema, sellerCatalogModeInputSchema, sellerCatalogSyncInputSchema, sellerMappingQuerySchema, sellerMappingRevisionSchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { knownRole } from '../../permissions.js';
import { readConfig } from '../../config.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { createManualSeller, history, listSellerMappings, MappingError, reviseSellerAliases, reviseSellerMapping } from './service.js';
import { CatalogError, getSellerCatalogSettings, setSellerCatalogMode, syncSellerCatalog } from './catalog.js';

type Variables = { actorUserId: string; role: string; traceId: string };
export const sellerMappingRoutes = new Hono<{ Variables: Variables }>();
sellerMappingRoutes.use('*', async (c, next) => {
  c.set('traceId', randomUUID());
  c.header('Cache-Control', 'no-store');
  const current = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!current) return c.json({ error: { code: 'UNAUTHORIZED', message: '请先登录。', traceId: c.get('traceId') } }, 401);
  if (current.user.banned || !knownRole(current.user.role)) return c.json({ error: { code: 'FORBIDDEN', message: '账号不可用。', traceId: c.get('traceId') } }, 403);
  c.set('actorUserId', current.user.id);
  c.set('role', current.user.role!);
  if (c.req.method === 'POST') {
    const origin = c.req.header('Origin');
    const config = readConfig();
    if ((origin && ![new URL(config.BETTER_AUTH_URL).origin, new URL(config.WEB_ORIGIN).origin].includes(origin)) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw new MappingError('FORBIDDEN', 403, '请求来源不受信任。');
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new MappingError('VALIDATION_ERROR', 422, '请提交 JSON 数据。');
  }
  await next();
});
sellerMappingRoutes.get('/', async (c) => {
  const parsed = sellerMappingQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw new MappingError('VALIDATION_ERROR', 422, '分页或筛选条件无效。');
  return c.json(await listSellerMappings(parsed.data));
});
sellerMappingRoutes.get('/catalog-settings', async (c) => c.json(await getSellerCatalogSettings(c.get('actorUserId'))));
sellerMappingRoutes.post('/catalog-settings', async (c) => {
  const parsed = sellerCatalogModeInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对店铺来源设置和版本。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
  return c.json(await setSellerCatalogMode(parsed.data, c.get('actorUserId')));
});
sellerMappingRoutes.post('/sync', async (c) => {
  const parsed = sellerCatalogSyncInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对店铺同步版本和操作编号。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
  return c.json(await syncSellerCatalog(parsed.data, c.get('actorUserId')));
});
sellerMappingRoutes.post('/manual', async (c) => {
  const parsed = manualSellerCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请核对人工店铺 sid、显示名称和国家。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
  return c.json(await createManualSeller(parsed.data, c.get('actorUserId')), 201);
});
sellerMappingRoutes.get('/:id/history', async (c) => {
  if (!z.uuid().safeParse(c.req.param('id')).success) throw new MappingError('VALIDATION_ERROR', 422, '店铺标识无效。');
  return c.json(await history(c.req.param('id')));
});
sellerMappingRoutes.post('/:id/revise', async (c) => {
  if (c.get('role') !== 'admin') throw new MappingError('FORBIDDEN', 403, '仅管理员可以维护店铺映射。');
  if (!z.uuid().safeParse(c.req.param('id')).success) throw new MappingError('VALIDATION_ERROR', 422, '店铺标识无效。');
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new MappingError('VALIDATION_ERROR', 422, '请提交 JSON 数据。');
  const parsed = sellerMappingRevisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请检查店铺字段、别名和变更原因。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
  return c.json(await reviseSellerMapping(c.req.param('id'), parsed.data, c.get('actorUserId')));
});
sellerMappingRoutes.post('/:id/aliases', async (c) => {
  if (c.get('role') !== 'admin') throw new MappingError('FORBIDDEN', 403, '仅管理员可以维护店铺别名及批准状态。');
  if (!z.uuid().safeParse(c.req.param('id')).success) throw new MappingError('VALIDATION_ERROR', 422, '店铺标识无效。');
  const parsed = sellerAliasRevisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请检查需求别名、批准状态和变更原因。', details: parsed.error.flatten(), traceId: c.get('traceId') } }, 422);
  return c.json(await reviseSellerAliases(c.req.param('id'), parsed.data, c.get('actorUserId')));
});
sellerMappingRoutes.onError((error, c) => {
  if (error instanceof MappingError || error instanceof CatalogError) return c.json({ error: { code: error.code, message: error.message, traceId: c.get('traceId') } }, error.status);
  logError('Seller mapping request failed', error);
  const unavailable = isDatabaseUnavailable(error);
  return c.json({ error: { code: unavailable ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: unavailable ? '数据库暂不可用，请稍后重试。' : '保存失败，请保留当前内容并重试。', traceId: c.get('traceId') } }, unavailable ? 503 : 500);
});
