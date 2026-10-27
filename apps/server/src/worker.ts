import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { readConfig } from './config.js';
import { closeDatabase, db } from './db/client.js';
import { demoTasks, workerHeartbeat } from './db/schema.js';
import { logError } from './errors.js';
import { canCreateDemoTask } from './permissions.js';
import { DEMO_QUEUE } from './tasks.js';
import { registerImportWorker } from './modules/imports/jobs.js';
import { registerBatchExportWorker } from './modules/batches/report-service.js';
import { registerBatchSyncWorker } from './modules/batches/sync-jobs.js';
import { registerFbaLookupWorker } from './modules/imports/fba-lookup.js';
import { registerPhysicalSyncWorker } from './modules/physical/sync.js';
import { registerPhysicalExportWorker } from './modules/physical/exports.js';
import { registerDocumentExportWorker } from './modules/documents/exports.js';
import { registerDocumentAutomationWorker } from './modules/documents/automation.js';
import { registerWorkflowExportWorker } from './modules/workflow/exports.js';
import { registerShippingRunWorker } from './modules/shipping-runs/jobs.js';
import { finalizePendingShippingLifecycles } from './modules/shipping-lifecycle/service.js';

const config = readConfig();
const boss = new PgBoss({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5_000,
  options: '-c timezone=Asia/Shanghai' });
boss.on('error', (error) => logError('Worker queue connection failed', error));
await boss.start();
await boss.createQueue(DEMO_QUEUE, { retryLimit: 0, deleteAfterSeconds: 0 });
const stopImportWorker = await registerImportWorker(boss);
const stopBatchExportWorker = await registerBatchExportWorker(boss);
const stopBatchSyncWorker = await registerBatchSyncWorker(boss);
const stopFbaLookupWorker = await registerFbaLookupWorker(boss);
const stopPhysicalSyncWorker = await registerPhysicalSyncWorker(boss);
const stopPhysicalExportWorker = await registerPhysicalExportWorker(boss);
const stopDocumentExportWorker = await registerDocumentExportWorker(boss);
const stopDocumentAutomationWorker = await registerDocumentAutomationWorker(boss);
const stopWorkflowExportWorker = await registerWorkflowExportWorker(boss);
const stopShippingRunWorker = await registerShippingRunWorker(boss);
let finalizingLifecycles = false;
const lifecycleInterval = setInterval(() => {
  if (finalizingLifecycles) return;
  finalizingLifecycles = true;
  void finalizePendingShippingLifecycles().catch((error) => logError('Shipping lifecycle finalization failed', error)).finally(() => { finalizingLifecycles = false; });
}, 2000);
lifecycleInterval.unref();

async function heartbeat(): Promise<void> {
  await db.insert(workerHeartbeat).values({
    name: 'demo-worker',
    lastSeenAt: new Date(),
    processId: process.pid,
  }).onConflictDoUpdate({
    target: workerHeartbeat.name,
    set: { lastSeenAt: new Date(), processId: process.pid },
  });
}

await heartbeat();
const interval = setInterval(() => void heartbeat().catch((error) => logError('Worker heartbeat failed', error)), 10_000);

await boss.work(DEMO_QUEUE, { transactional: true }, async ([job], tx) => {
  if (!job) throw new Error('任务为空');
  const { taskId } = z.object({ taskId: z.uuid() }).parse(job.data);
  try {
    const creator = await tx.executeSql(
      `select u.role, u.banned from demo_tasks t join "user" u on u.id = t.created_by where t.id = $1`,
      [taskId],
    );
    const row = creator.rows[0] as { role?: string; banned?: boolean } | undefined;
    if (!row || row.banned || !canCreateDemoTask(row.role)) {
      throw new Error('提交人已失去任务执行权限');
    }

    const result = '任务已完成';
    await tx.executeSql(
      `update demo_tasks set status = 'completed', result = $2, error = null,
        completed_at = now(), updated_at = now() where id = $1`,
      [taskId, result],
    );
    return { taskId, result };
  } catch (error) {
    logError('Worker task failed', error);
    const message = error instanceof Error && error.message === '提交人已失去任务执行权限'
      ? error.message : '任务执行失败，请检查 Worker 状态';
    // The worker runs with retryLimit 0. Its application record remains visible
    // after pg-boss marks the job failed.
    await db.update(demoTasks).set({
      status: 'failed',
      error: message,
      updatedAt: new Date(),
    }).where(eq(demoTasks.id, taskId));
    throw new Error(message);
  }
});

console.log('Demo worker started');

async function shutdown() {
  stopImportWorker();
  stopBatchExportWorker();
  stopBatchSyncWorker();
  stopFbaLookupWorker();
  stopPhysicalSyncWorker();
  stopPhysicalExportWorker();
  stopDocumentExportWorker();
  stopDocumentAutomationWorker();
  stopWorkflowExportWorker();
  stopShippingRunWorker();
  clearInterval(lifecycleInterval);
  clearInterval(interval);
  await boss.stop();
  await closeDatabase();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
