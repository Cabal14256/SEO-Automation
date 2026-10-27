import { boolean, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Lifecycle is independent of the immutable processing/publication history. */
export const shippingLifecycleColumns = () => ({
  lifecycle: text('lifecycle').notNull().default('active'),
  lifecycleChangedAt: timestamp('lifecycle_changed_at', { withTimezone: true, mode: 'date' }),
  lifecycleChangedBy: text('lifecycle_changed_by'), lifecycleReason: text('lifecycle_reason'),
  lifecycleOperationId: uuid('lifecycle_operation_id'), lifecycleSnapshotId: uuid('lifecycle_snapshot_id'),
  lifecyclePending: boolean('lifecycle_pending').notNull().default(false),
});
