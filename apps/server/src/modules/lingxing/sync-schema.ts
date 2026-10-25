import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { demands, fileIndex, user } from '../../db/schema.js';
import { subBatches } from '../batches/schema.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const batchSyncRuns = pgTable('batch_sync_run', {
  id: uuid('id').primaryKey(), subBatchId: uuid('sub_batch_id').notNull().references(() => subBatches.id), groupVersion: integer('group_version').notNull(),
  operationId: uuid('operation_id').notNull().unique(), requestHash: text('request_hash').notNull(),
  status: text('status').notNull().default('queued'), queueJobId: uuid('queue_job_id'),
  startDate: text('start_date').notNull(), endDate: text('end_date').notNull(), maxPages: integer('max_pages').notNull().default(10),
  requestBudget: integer('request_budget').notNull(), requestsUsed: integer('requests_used').notNull().default(0),
  authRequests: integer('auth_requests').notNull().default(0), cacheHits: integer('cache_hits').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
  startedAt: at('started_at'), completedAt: at('completed_at'), errorCode: text('error_code'), errorMessage: text('error_message'),
}, (t) => [index('batch_sync_run_group_idx').on(t.subBatchId, t.createdAt), check('batch_sync_run_status_check', sql`${t.status} IN ('queued','running','completed','partial','failed')`),
  check('batch_sync_run_budget_check', sql`${t.requestBudget} BETWEEN 1 AND 1000 AND ${t.requestsUsed} BETWEEN 0 AND ${t.requestBudget} AND ${t.maxPages} BETWEEN 1 AND 100 AND ${t.groupVersion}>0`),
  check('batch_sync_run_range_check', sql`${t.startDate}<${t.endDate}`)]);
export const batchSyncItems = pgTable('batch_sync_item', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => batchSyncRuns.id),
  demandId: uuid('demand_id').notNull().references(() => demands.id), demandVersion: integer('demand_version').notNull(), sid: integer('sid').notNull(), fba: text('fba').notNull(),
  status: text('status').notNull().default('queued'), revisionId: uuid('revision_id'), attempts: integer('attempts').notNull().default(0),
  requestCount: integer('request_count').notNull().default(0), snapshotIds: jsonb('snapshot_ids').$type<string[]>().notNull().default([]),
  errorCode: text('error_code'), errorMessage: text('error_message'), startedAt: at('started_at'), completedAt: at('completed_at'),
}, (table) => [uniqueIndex('batch_sync_item_member_idx').on(table.runId, table.demandId), check('batch_sync_item_status_check', sql`${table.status} IN ('queued','running','completed','failed')`),
  check('batch_sync_item_identity_check', sql`${table.sid}>0 AND ${table.demandVersion}>0 AND ${table.fba} ~ '^FBA[A-Z0-9]+$' AND ${table.attempts}>=0 AND ${table.requestCount}>=0`)]);
export const batchSyncSnapshots = pgTable('batch_sync_snapshot', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => batchSyncRuns.id),
  itemId: uuid('item_id').notNull().references(() => batchSyncItems.id), operation: text('operation').notNull(),
  page: integer('page').notNull().default(0), attempt: integer('attempt').notNull(), fileId: uuid('file_id').notNull().references(() => fileIndex.id),
  successful: integer('successful').notNull(), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [index('batch_sync_snapshot_checkpoint_idx').on(t.itemId, t.operation, t.page, t.createdAt),
  check('batch_sync_snapshot_attempt_check', sql`${t.page}>=0 AND ${t.attempt}>0 AND ${t.successful} IN (0,1)`)]);
export const batchSyncRetryOperations = pgTable('batch_sync_retry_operation', {
  operationId: uuid('operation_id').primaryKey(), runId: uuid('run_id').notNull().references(() => batchSyncRuns.id),
  actorId: text('actor_id').notNull().references(() => user.id), requestHash: text('request_hash').notNull(), createdAt: at('created_at').notNull().defaultNow(),
});
// Token bytes are AES-GCM encrypted with a server-only key. Neither credentials
// nor the plaintext token are included in business snapshots or API responses.
export const lingxingTokenCache = pgTable('lingxing_token_cache', {
  key: text('key').primaryKey(), ciphertext: text('ciphertext').notNull(), updatedAt: at('updated_at').notNull().defaultNow(),
});
export const lingxingReadCooldown = pgTable('lingxing_read_cooldown', {
  key: text('key').primaryKey(), availableAt: at('available_at').notNull(),
});
