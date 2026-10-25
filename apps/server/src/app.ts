import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { demoTaskInputSchema } from '@scm/contracts';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { PgBoss } from 'pg-boss';
import { auth } from './auth.js';
import { readConfig } from './config.js';
import { databaseHealthy, taskCounts, workerHealth } from './health.js';
import { isDatabaseUnavailable, logError } from './errors.js';
import { canCreateDemoTask, knownRole } from './permissions.js';
import { createDemoTask, listTasks, reconcileFailedJobs, serializeTask } from './tasks.js';
import { sellerMappingRoutes } from './modules/seller-mappings/routes.js';
import { createDemandRoutes, createImportFileRoutes, createImportRoutes } from './modules/imports/routes.js';
import { createWeeklyBatchRoutes, createProcessingBatchRoutes, createSubBatchRoutes, createBatchWorkspaceRoutes } from './modules/batches/routes.js';
import { createReportRoutes } from './modules/batches/report-routes.js';
import { createSyncRoutes } from './modules/batches/sync-jobs.js';
import { createPhysicalExportRoutes, createPhysicalReviewRoutes } from './modules/physical/routes.js';
import { createPhysicalWorkspaceRoutes } from './modules/physical/workspace-routes.js';
import { createDocumentExportRoutes, createDocumentProfileRoutes, createDocumentRoutes, createDocumentTemplateRoutes } from './modules/documents/routes.js';
import { createWorkflowRoutes, createWorkflowSourceRoutes, createWorkflowFileRoutes, createWorkflowExportRoutes } from './modules/workflow/routes.js';
import { workflowPolicies } from './modules/workflow/registry.js';
import { createShippingRunRoutes } from './modules/shipping-runs/routes.js';

const config = readConfig();

export function createApp(getBoss: () => PgBoss | null): Hono {
  const app = new Hono();
  app.route('/api/v1/seller-mappings', sellerMappingRoutes);
  app.route('/api/v1/imports', createImportRoutes(getBoss));
  app.route('/api/v1/demands', createDemandRoutes());
  app.route('/api/v1/files', createImportFileRoutes());
  app.route('/api/v1/weekly-batches', createWeeklyBatchRoutes());
  app.route('/api/v1/processing-batches', createProcessingBatchRoutes());
  app.route('/api/v1/batches', createBatchWorkspaceRoutes());
  app.route('/api/v1/sub-batches', createSubBatchRoutes());
  app.route('/api/v1/sub-batches/:id/physical-review', createPhysicalReviewRoutes(getBoss));
  app.route('/api/v1/physical-exports', createPhysicalExportRoutes(getBoss));
  app.route('/api/v1/physical-reviews', createPhysicalWorkspaceRoutes());
  app.route('/api/v1/batch-reports', createReportRoutes(getBoss));
  app.route('/api/v1/batch-sync', createSyncRoutes(getBoss));
  app.route('/api/v1/shipping-runs', createShippingRunRoutes(getBoss));
  app.route('/api/v1/documents', createDocumentRoutes(getBoss));
  app.route('/api/v1/document-profiles', createDocumentProfileRoutes());
  app.route('/api/v1/document-templates', createDocumentTemplateRoutes());
  app.route('/api/v1/document-exports', createDocumentExportRoutes());
  for (const [path, kind] of [['fulfillment', 'fulfillment'], ['logistics', 'logistics'], ['customs', 'customs'], ['finance', 'finance'], ['archives', 'archive']] as const) app.route(`/api/v1/${path}`, createWorkflowRoutes(workflowPolicies[kind], getBoss));
  app.route('/api/v1/workflow-sources', createWorkflowSourceRoutes());
  app.route('/api/v1/workflow-files', createWorkflowFileRoutes());
  app.route('/api/v1/workflow-exports', createWorkflowExportRoutes());

  app.all('/api/v1/auth/*', async (c) => {
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (current && (current.user.banned || !knownRole(current.user.role))) {
      return c.json({ code: 'ADMIN_ONLY', message: '仅管理员账户可以访问系统。' }, 403);
    }
    return auth.handler(c.req.raw);
  });

  app.get('/api/v1/health', async (c) => {
    if (!(await databaseHealthy())) {
      return c.json({ status: 'degraded', database: 'error', worker: 'unknown' }, 503);
    }
    return c.json({ status: 'ok', database: 'ok', worker: await workerHealth() });
  });

  app.get('/api/v1/session', async (c) => {
    if (!(await databaseHealthy())) return c.json({ error: 'DATABASE_UNAVAILABLE' }, 503);
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!current) return c.json({ user: null });
    if (current.user.banned) return c.json({ error: 'ACCOUNT_DISABLED' }, 403);
    const role = knownRole(current.user.role);
    if (!role) return c.json({ error: 'ROLE_NOT_ALLOWED' }, 403);
    return c.json({
      user: {
        id: current.user.id,
        name: current.user.name,
        email: current.user.email,
        role,
      },
    });
  });

  app.use('/api/v1/dashboard', requireSession);
  app.use('/api/v1/tasks', requireSession);

  app.get('/api/v1/dashboard', async (c) => {
    const boss = getBoss();
    if (boss) await reconcileFailedJobs(boss);
    const [tasks, worker] = await Promise.all([taskCounts(), workerHealth()]);
    return c.json({ tasks, health: { database: 'ok', worker } });
  });

  app.get('/api/v1/tasks', async (c) => {
    const boss = getBoss();
    if (boss) await reconcileFailedJobs(boss);
    const tasks = await listTasks();
    return c.json({ items: tasks.map(serializeTask) });
  });

  app.post('/api/v1/tasks', async (c) => {
    const boss = getBoss();
    if (!boss || !(await databaseHealthy())) {
      return c.json({ error: 'QUEUE_UNAVAILABLE' }, 503);
    }
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!current || current.user.banned || !canCreateDemoTask(current.user.role)) {
      return c.json({ error: 'FORBIDDEN' }, 403);
    }

    const body: unknown = await c.req.json().catch(() => null);
    const parsed = demoTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', issues: parsed.error.flatten() }, 400);
    }
    const task = await createDemoTask(boss, parsed.data.label, current.user.id);
    return c.json({ task: serializeTask(task) }, 201);
  });

  app.all('/api/*', (c) => c.json({ error: 'NOT_FOUND' }, 404));

  app.use('/*', serveStatic({ root: config.webDistDir }));
  app.get('*', serveStatic({ path: resolve(config.webDistDir, 'index.html') }));

  app.onError((error, c) => {
    logError('API request failed', error);
    if (isDatabaseUnavailable(error)) return c.json({ error: 'DATABASE_UNAVAILABLE' }, 503);
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });

  return app;
}

const requireSession = createMiddleware(async (c, next) => {
  const current = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!current) return c.json({ error: 'UNAUTHORIZED' }, 401);
  if (current.user.banned) return c.json({ error: 'ACCOUNT_DISABLED' }, 403);
  if (!knownRole(current.user.role)) return c.json({ error: 'ROLE_NOT_ALLOWED' }, 403);
  await next();
});
