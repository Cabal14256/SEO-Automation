import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { WorkflowRecord, WorkflowSource } from '@scm/contracts';
import { fileIndex, user } from '../../db/schema.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const workflowRecords = pgTable('workflow_record', {
  id: uuid('id').primaryKey(), kind: text('kind').notNull(), title: text('title').notNull(), status: text('status').notNull().default('draft'), version: integer('version').notNull().default(1),
  source: jsonb('source').$type<WorkflowSource>().notNull(), boxIds: jsonb('box_ids').$type<string[]>().notNull(), data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [index('workflow_record_kind_idx').on(t.kind, t.createdAt), check('workflow_record_version_check', sql`${t.version} > 0`), check('workflow_record_kind_check', sql`${t.kind} in ('fulfillment','logistics','customs','finance','archive')`)]);
export const workflowRevisions = pgTable('workflow_revision', {
  id: uuid('id').primaryKey(), recordId: uuid('record_id').notNull().references(() => workflowRecords.id), version: integer('version').notNull(), action: text('action').notNull(), reason: text('reason').notNull(), record: jsonb('record').$type<WorkflowRecord>().notNull(), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('workflow_revision_version_uq').on(t.recordId, t.version)]);
export const workflowAttachments = pgTable('workflow_attachment', {
  fileId: uuid('file_id').primaryKey().references(() => fileIndex.id), recordId: uuid('record_id').notNull().references(() => workflowRecords.id), purpose: text('purpose').notNull(), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [index('workflow_attachment_record_idx').on(t.recordId)]);
export const workflowClaims = pgTable('workflow_box_claim', {
  id: uuid('id').primaryKey(), purpose: text('purpose').notNull(), boxId: uuid('box_id').notNull(), recordId: uuid('record_id').notNull().references(() => workflowRecords.id), releasedAt: at('released_at'),
}, (t) => [uniqueIndex('workflow_box_claim_active_uq').on(t.purpose, t.boxId).where(sql`${t.releasedAt} IS NULL`), index('workflow_box_claim_record_idx').on(t.recordId)]);
export const workflowExports = pgTable('workflow_export', {
  id: uuid('id').primaryKey(), recordId: uuid('record_id').notNull().references(() => workflowRecords.id), version: integer('version').notNull(), purpose: text('purpose').notNull(), status: text('status').notNull().default('queued'), dependencyHash: text('dependency_hash').notNull(), snapshot: jsonb('snapshot').$type<WorkflowRecord>().notNull(), fileId: uuid('file_id').references(() => fileIndex.id), error: text('error'), queueJobId: text('queue_job_id'), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(), completedAt: at('completed_at'),
}, (t) => [index('workflow_export_record_idx').on(t.recordId), check('workflow_export_status_check', sql`${t.status} in ('queued','running','completed','failed','stale')`)]);
