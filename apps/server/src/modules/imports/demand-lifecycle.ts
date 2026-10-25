import { and, eq, inArray, sql } from 'drizzle-orm';
import { demands, operationAudit } from '../../db/schema.js';
import { BatchError, type BatchTx } from '../batches/service.js';

export type DemandCancellation = { reason: string; createdBy: string; createdAt: Date; version?: number };
export function demandLifecycleCondition(lifecycle: 'active' | 'cancelled' | 'all') {
  if (lifecycle === 'all') return undefined;
  const cancelled = sql`EXISTS (SELECT 1 FROM ${operationAudit} WHERE ${operationAudit.targetId} = ${demands.id} AND ${operationAudit.action} = 'demand.cancel')`;
  return lifecycle === 'cancelled' ? cancelled : sql`NOT (${cancelled})`;
}
export async function loadDemandCancellationsInTx(tx: BatchTx, ids?: string[]): Promise<Map<string, DemandCancellation>> {
  if (ids && !ids.length) return new Map();
  const rows = await tx.select().from(operationAudit).where(and(eq(operationAudit.action, 'demand.cancel'), ids ? inArray(operationAudit.targetId, ids) : undefined));
  return new Map(rows.map((row) => [row.targetId, { reason: row.details?.reason ?? '需求已取消。', createdBy: row.actorUserId, createdAt: row.createdAt,
    ...(row.details?.version ? { version: Number(row.details.version) } : {}) }]));
}
export async function requireActiveDemandInTx(tx: BatchTx, id: string) {
  if ((await loadDemandCancellationsInTx(tx, [id])).has(id)) throw new BatchError('DEMAND_CANCELLED', 409, '需求已取消，不能编辑、重新导入或安排发货。');
}
