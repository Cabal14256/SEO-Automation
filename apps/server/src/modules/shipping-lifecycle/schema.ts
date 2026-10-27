import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ShippingLifecycleAction, ShippingLifecycleInput, ShippingLifecycleResult, ShippingLifecycleType } from '@scm/contracts';

export type LifecycleSnapshot = {
  type: ShippingLifecycleType; id: string; lifecycle: string; previousSnapshotId: string | null;
  entities: Array<{ type: 'run' | 'group' | 'demand'; id: string; lifecycle: string; status?: string; snapshotId: string | null; record?: Record<string, unknown> }>;
  ticketMemberIds: string[]; groupMemberIds: string[]; codeIds: string[];
  runIds: string[]; groupIds: string[]; demandIds: string[];
  demandVersions?: Record<string, number>;
};
// Deliberately no entity FKs: minimal operation tombstones survive permanent purge.
export const shippingLifecycleOperations = pgTable('shipping_lifecycle_operation', {
  operationId: uuid('operation_id').primaryKey(), type: text('entity_type').$type<ShippingLifecycleType>().notNull(), entityId: uuid('entity_id').notNull(),
  action: text('action').$type<ShippingLifecycleAction>().notNull(), actorId: text('actor_id').notNull(), requestHash: text('request_hash').notNull(),
  input: jsonb('input').$type<ShippingLifecycleInput | null>(), result: jsonb('result').$type<ShippingLifecycleResult>().notNull(),
  pending: integer('pending').notNull().default(0), error: text('error'), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [index('shipping_lifecycle_pending_idx').on(t.pending, t.createdAt), check('shipping_lifecycle_pending_check', sql`${t.pending} IN (0,1)`)]);
export const shippingLifecycleSnapshots = pgTable('shipping_lifecycle_snapshot', {
  id: uuid('id').primaryKey(), type: text('entity_type').$type<ShippingLifecycleType>().notNull(), entityId: uuid('entity_id').notNull(), operationId: uuid('operation_id').notNull(),
  data: jsonb('data').$type<LifecycleSnapshot | null>(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [index('shipping_lifecycle_snapshot_entity_idx').on(t.type, t.entityId)]);
