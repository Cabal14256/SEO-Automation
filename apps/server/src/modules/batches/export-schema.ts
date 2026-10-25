import { integer, jsonb, pgTable, text, timestamp, uuid, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ReportReference, ShipmentReport } from '@scm/contracts';
import { demands, fileIndex, user } from '../../db/schema.js';
import { subBatches } from './schema.js';
export const batchExports = pgTable('batch_export', {
  id: uuid('id').primaryKey(), operationId: uuid('operation_id').notNull().unique(), requestHash: text('request_hash').notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), queueJobId: text('queue_job_id').notNull(), status: text('status').notNull().default('queued'),
  groupIds: jsonb('group_ids').$type<string[]>().notNull(), references: jsonb('references').$type<ReportReference[]>().notNull(),
  month: text('month'), region: text('region').notNull().default('all'), projection: jsonb('projection').$type<ShipmentReport>().notNull(),
  fileId: uuid('file_id').references(() => fileIndex.id), error: text('error'), rowCount: integer('row_count').notNull().default(0), boxCount: integer('box_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [index('batch_export_created_idx').on(t.createdAt), check('batch_export_status_check', sql`${t.status} in ('queued','running','completed','failed','stale')`)]);

export const batchIntakes = pgTable('batch_intake', {
  operationId: uuid('operation_id').primaryKey(), actorId: text('actor_id').notNull().references(() => user.id), requestHash: text('request_hash').notNull(),
  groupId: uuid('group_id').notNull().references(() => subBatches.id), demandId: uuid('demand_id').notNull().references(() => demands.id), sourceFileId: uuid('source_file_id').notNull().references(() => fileIndex.id),
  result: jsonb('result').$type<Record<string, unknown>>(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
