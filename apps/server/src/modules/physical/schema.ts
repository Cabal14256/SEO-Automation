import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { PhysicalConfirmation, PhysicalEntry, PhysicalExportReference, PhysicalRevision, PhysicalSource } from '@scm/contracts';
import { fileIndex, user } from '../../db/schema.js';
import { groupConfirmations, subBatches } from '../batches/schema.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const physicalReviewStates = pgTable('physical_review_state', {
  groupId: uuid('group_id').primaryKey().references(() => subBatches.id),
  m2ConfirmationId: uuid('m2_confirmation_id').notNull().references(() => groupConfirmations.id),
  version: integer('version').notNull().default(0), sourceId: uuid('source_id'), revisionId: uuid('revision_id'), confirmationId: uuid('confirmation_id'),
  pendingChange: boolean('pending_change').notNull().default(false), updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [check('physical_review_version_check', sql`${t.version} >= 0`)]);
export const physicalSources = pgTable('physical_source', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id),
  m2ConfirmationId: uuid('m2_confirmation_id').notNull().references(() => groupConfirmations.id),
  fingerprint: text('fingerprint').notNull(), data: jsonb('data').$type<PhysicalSource>().notNull(), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [index('physical_source_group_idx').on(t.groupId, t.createdAt)]);
export const physicalRevisions = pgTable('physical_revision', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id),
  m2ConfirmationId: uuid('m2_confirmation_id').notNull().references(() => groupConfirmations.id),
  version: integer('version').notNull(), data: jsonb('data').$type<PhysicalRevision>().notNull(), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('physical_revision_group_version_idx').on(t.groupId, t.version)]);
export const physicalConfirmations = pgTable('physical_confirmation', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id),
  m2ConfirmationId: uuid('m2_confirmation_id').notNull().references(() => groupConfirmations.id),
  m3Version: integer('m3_version').notNull(), data: jsonb('data').$type<PhysicalConfirmation>().notNull(), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('physical_confirmation_group_version_idx').on(t.groupId, t.m3Version)]);
export const physicalSyncRuns = pgTable('physical_sync_run', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id),
  m2ConfirmationId: uuid('m2_confirmation_id').notNull().references(() => groupConfirmations.id),
  operationId: uuid('operation_id').notNull().unique(), requestHash: text('request_hash').notNull(),
  status: text('status').notNull().default('queued'), queueJobId: uuid('queue_job_id'), startDate: text('start_date').notNull(), endDate: text('end_date').notNull(),
  requestBudget: integer('request_budget').notNull(), requestsUsed: integer('requests_used').notNull().default(0), authRequests: integer('auth_requests').notNull().default(0),
  cacheHits: integer('cache_hits').notNull().default(0), maxPages: integer('max_pages').notNull().default(10),
  errorCode: text('error_code'), errorMessage: text('error_message'), createdBy: text('created_by').notNull().references(() => user.id),
  createdAt: at('created_at').notNull().defaultNow(), startedAt: at('started_at'), completedAt: at('completed_at'),
}, (t) => [index('physical_sync_group_idx').on(t.groupId, t.createdAt),
  check('physical_sync_status_check', sql`${t.status} IN ('queued','running','completed','partial','failed')`),
  check('physical_sync_budget_check', sql`${t.requestBudget} BETWEEN 1 AND 1000 AND ${t.requestsUsed} BETWEEN 0 AND ${t.requestBudget} AND ${t.maxPages} BETWEEN 1 AND 100`),
  check('physical_sync_range_check', sql`${t.startDate} < ${t.endDate}`)]);
export const physicalSyncItems = pgTable('physical_sync_item', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => physicalSyncRuns.id), demandId: uuid('demand_id').notNull(), sid: integer('sid').notNull(), fba: text('fba').notNull(),
  status: text('status').notNull().default('queued'), snapshotIds: jsonb('snapshot_ids').$type<string[]>().notNull().default([]), errorCode: text('error_code'), errorMessage: text('error_message'),
}, (t) => [uniqueIndex('physical_sync_item_member_idx').on(t.runId, t.demandId), check('physical_sync_item_status_check', sql`${t.status} IN ('queued','running','completed','failed')`)]);
export const physicalSyncSnapshots = pgTable('physical_sync_snapshot', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => physicalSyncRuns.id), itemId: uuid('item_id').notNull().references(() => physicalSyncItems.id),
  operation: text('operation').notNull(), page: integer('page').notNull().default(0), attempt: integer('attempt').notNull(), fileId: uuid('file_id').notNull().references(() => fileIndex.id),
  successful: integer('successful').notNull(), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [index('physical_sync_checkpoint_idx').on(t.itemId, t.operation, t.page), check('physical_snapshot_success_check', sql`${t.successful} IN (0,1)`)]);
export const physicalExports = pgTable('physical_export', {
  id: uuid('id').primaryKey(), operationId: uuid('operation_id').notNull().unique(), requestHash: text('request_hash').notNull(),
  references: jsonb('references').$type<PhysicalExportReference[]>().notNull(), projection: jsonb('projection').$type<PhysicalConfirmation[]>().notNull(),
  status: text('status').notNull().default('queued'), queueJobId: uuid('queue_job_id'), fileId: uuid('file_id').references(() => fileIndex.id),
  boxCount: integer('box_count').notNull(), error: text('error'), createdBy: text('created_by').notNull().references(() => user.id),
  createdAt: at('created_at').notNull().defaultNow(), completedAt: at('completed_at'),
}, (t) => [check('physical_export_status_check', sql`${t.status} IN ('queued','running','completed','failed','stale')`)]);
export type PhysicalTemplateManifest = { source: PhysicalSource; entries: PhysicalEntry[]; version: number; m2ConfirmationId: string; templateId: string };
export const physicalTemplates = pgTable('physical_template', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id), manifest: jsonb('manifest').$type<PhysicalTemplateManifest>().notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
});
export const physicalIntakePreviews = pgTable('physical_intake_preview', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id), templateId: uuid('template_id').notNull().references(() => physicalTemplates.id),
  sha256: text('sha256').notNull(), fileId: uuid('file_id').notNull().references(() => fileIndex.id), entries: jsonb('entries').$type<PhysicalEntry[]>().notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
});
