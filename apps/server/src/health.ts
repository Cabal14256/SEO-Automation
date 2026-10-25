import { count, eq, sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { demoTasks, workerHeartbeat } from './db/schema.js';

export async function databaseHealthy(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export async function workerHealth(): Promise<'ok' | 'stale' | 'unknown'> {
  const [record] = await db.select().from(workerHeartbeat)
    .where(eq(workerHeartbeat.name, 'demo-worker')).limit(1);
  if (!record) return 'unknown';
  return Date.now() - record.lastSeenAt.getTime() < 30_000 ? 'ok' : 'stale';
}

export async function taskCounts() {
  const rows = await db.select({ status: demoTasks.status, total: count() })
    .from(demoTasks).groupBy(demoTasks.status);
  const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row.total;
    }
  }
  return counts;
}
