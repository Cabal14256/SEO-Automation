import { and, eq, getTableColumns, inArray, ne, or, sql } from 'drizzle-orm';
import { demands } from '../../db/schema.js';
import { BatchError, type BatchTx } from '../batches/service.js';
import { subBatchMembers, subBatches } from '../batches/schema.js';

export type DemandCancellation = { reason: string; createdBy: string; createdAt: Date; version?: number; lifecycle?: 'active' | 'cancelled' | 'trashed' };
export function demandLifecycleCondition(lifecycle: 'active' | 'cancelled' | 'trashed' | 'all') {
  if (lifecycle === 'all') return undefined;
  return eq(demands.lifecycle, lifecycle);
}
export async function loadDemandCancellationsInTx(tx: BatchTx, ids?: string[]): Promise<Map<string, DemandCancellation>> {
  if (ids && !ids.length) return new Map();
  const scopePending = sql<boolean>`EXISTS (SELECT 1 FROM ${subBatchMembers} m JOIN ${subBatches} g ON g.id=m.group_id WHERE m.demand_id="demand"."id" AND m.active=true AND (g.lifecycle<>'active' OR g.lifecycle_pending=true))`;
  const rows = await tx.select({ ...getTableColumns(demands), scopePending }).from(demands).where(and(or(ne(demands.lifecycle, 'active'), eq(demands.lifecyclePending, true), scopePending), ids ? inArray(demands.id, ids) : undefined));
  return new Map(rows.filter((row) => row.lifecycle && row.lifecycle !== 'active' || row.lifecyclePending || row.scopePending).map((row) => [row.id, { reason: row.lifecycleReason ?? (row.scopePending ? '关联发货安排正在取消或删除。' : '需求已取消或移入回收站。'), createdBy: row.lifecycleChangedBy ?? '', createdAt: row.lifecycleChangedAt ?? row.updatedAt,
    version: row.version, lifecycle: row.lifecycle === 'trashed' ? 'trashed' as const : row.lifecycle === 'cancelled' ? 'cancelled' as const : 'active' as const }]));
}
export async function requireActiveDemandInTx(tx: BatchTx, id: string) {
  if ((await loadDemandCancellationsInTx(tx, [id])).has(id)) throw new BatchError('DEMAND_CANCELLED', 409, '需求已取消，不能编辑、重新导入或安排发货。');
}
