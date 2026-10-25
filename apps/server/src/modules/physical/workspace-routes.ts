import { Hono } from 'hono';
import { physicalWorkspaceQuerySchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { BatchError } from '../batches/service.js';
import { getPhysicalWorkspace } from './workspace.js';

export function createPhysicalWorkspaceRoutes() {
  const routes = new Hono();
  routes.get('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new BatchError('UNAUTHORIZED', 401, '请先登录。');
    if (session.user.banned || session.user.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '需要有效管理员身份。');
    const parsed = physicalWorkspaceQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new BatchError('VALIDATION_ERROR', 422, '请核对发货月份、发货次、核对状态和分页参数。');
    return c.json(await getPhysicalWorkspace(session.user.id, parsed.data));
  });
  routes.onError((error, c) => {
    if (error instanceof BatchError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    logError('Physical workspace failed', error);
    const unavailable = isDatabaseUnavailable(error);
    return c.json({ error: { code: unavailable ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: '实物箱确认列表读取失败，请重试。' } }, unavailable ? 503 : 500);
  });
  return routes;
}
