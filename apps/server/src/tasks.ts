import { createHash, randomUUID } from 'node:crypto';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { db } from './db/client.js';
import { demoTasks, operationAudit } from './db/schema.js';

export const DEMO_QUEUE = 'demo-task';

export type DemoTask = typeof demoTasks.$inferSelect;

export function serializeTask(task: DemoTask) {
  return {
    id: task.id,
    label: task.label,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    result: task.result,
    error: task.error,
  };
}

export async function listTasks(): Promise<DemoTask[]> {
  return db.select().from(demoTasks).orderBy(desc(demoTasks.createdAt)).limit(100);
}

export async function reconcileFailedJobs(boss: PgBoss): Promise<void> {
  const unsettled = await db.select({ id: demoTasks.id, jobId: demoTasks.queueJobId })
    .from(demoTasks)
    .where(inArray(demoTasks.status, ['queued', 'running']))
    .limit(100);
  for (const task of unsettled) {
    const [job] = await boss.findJobs(DEMO_QUEUE, { id: task.jobId });
    if (job?.state === 'failed' || job?.state === 'cancelled') {
      await db.update(demoTasks).set({
        status: 'failed',
        error: job.state === 'cancelled' ? '任务已取消' : '持久任务执行失败，请检查 Worker 日志',
        updatedAt: new Date(),
      }).where(eq(demoTasks.id, task.id));
    }
  }
}

export async function createDemoTask(boss: PgBoss, label: string, actorUserId: string): Promise<DemoTask> {
  const taskId = randomUUID();
  const requestHash = createHash('sha256').update(JSON.stringify({ label })).digest('hex');

  return db.transaction(async (tx) => {
    await tx.insert(demoTasks).values({
      id: taskId,
      label,
      status: 'queued',
      queueJobId: 'pending',
      createdBy: actorUserId,
    });

    await tx.insert(operationAudit).values({
      id: randomUUID(),
      action: 'demo_task.submit',
      targetId: taskId,
      actorUserId,
      requestHash,
      details: { label },
    });

    const jobId = await boss.send(DEMO_QUEUE, { taskId }, { db: fromDrizzle(tx, sql) });
    if (!jobId) {
      throw new Error('持久任务入队失败');
    }

    const [task] = await tx.update(demoTasks)
      .set({ queueJobId: jobId })
      .where(eq(demoTasks.id, taskId))
      .returning();
    if (!task) {
      throw new Error('任务保存失败');
    }
    return task;
  });
}

