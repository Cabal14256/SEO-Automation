import { eq } from 'drizzle-orm';
import type { ShippingLifecycleType } from '@scm/contracts';
import { demands } from '../../db/schema.js';
import { subBatches } from '../batches/schema.js';
import { shippingRuns } from '../shipping-runs/schema.js';
import { BatchError, type BatchTx } from '../batches/service.js';

export async function assertLifecycleActiveInTx(tx: BatchTx, type: ShippingLifecycleType, id: string): Promise<void> {
  const table = type === 'run' ? shippingRuns : type === 'group' ? subBatches : demands;
  const [row] = await tx.select({ lifecycle: table.lifecycle, pending: table.lifecyclePending }).from(table).where(eq(table.id, id));
  if (!row) throw new BatchError('NOT_FOUND', 404, '记录不存在或已永久删除。');
  if (row.pending || row.lifecycle && row.lifecycle !== 'active') throw new BatchError('SHIPPING_LIFECYCLE_INACTIVE', 409, row.pending ? '记录正在取消或删除，不能继续处理。' : '记录已取消或移入回收站，请先恢复。');
}
