import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fileIndex, user } from '../../db/schema.js';
import { shippingRuns } from '../shipping-runs/schema.js';
import type { StoredDocumentAutomationItem } from './automation-types.js';
import type { DocumentAutomationBundle, DocumentExportReference } from '@scm/contracts';
import type { BundleSheet } from './bundle-workbook.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const documentAutomationJobs = pgTable('document_automation_job', {
  id: uuid('id').primaryKey(), operationId: uuid('operation_id').notNull().unique(), requestHash: text('request_hash').notNull(),
  shippingRunId: uuid('shipping_run_id').notNull().references(() => shippingRuns.id), version: integer('version').notNull().default(1),
  status: text('status').notNull().default('queued'), fields: jsonb('fields').$type<Record<string, string | null>>().notNull().default({}), title: text('title'),
  mode: text('mode').notNull().default('legacy'), phase: text('phase').notNull().default('preparing'), bundle: jsonb('bundle').$type<DocumentAutomationBundle | null>(),
  items: jsonb('items').$type<StoredDocumentAutomationItem[]>().notNull(), error: jsonb('error').$type<{ code: string; message: string } | null>(),
  retryRequests: jsonb('retry_requests').$type<Array<{ operationId: string; itemIds: string[]; resumeExact?: boolean }>>().notNull().default([]),
  queueJobId: text('queue_job_id'), leaseUntil: at('lease_until'), createdBy: text('created_by').notNull().references(() => user.id),
  createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(), completedAt: at('completed_at'),
  deletedAt: at('deleted_at'), deletedBy: text('deleted_by').references(() => user.id), deletionReason: text('deletion_reason'),
}, (table) => [index('document_automation_actor_created_idx').on(table.createdBy, table.createdAt), index('document_automation_status_idx').on(table.status),
  check('document_automation_version_check', sql`${table.version} > 0`),
  check('document_automation_status_check', sql`${table.status} IN ('queued','running','completed','partial','blocked','failed')`),
  check('document_automation_mode_check', sql`${table.mode} IN ('legacy','single_workbook')`),
  check('document_automation_phase_check', sql`${table.phase} IN ('preparing','needs_input','ready','generating','completed','failed')`),
]);

export const documentInvoiceBundles = pgTable('document_invoice_bundle', {
  id: uuid('id').primaryKey(), jobId: uuid('job_id').notNull().unique().references(() => documentAutomationJobs.id),
  fileId: uuid('file_id').notNull().references(() => fileIndex.id), references: jsonb('references').$type<DocumentExportReference[]>().notNull(),
  sheets: jsonb('sheets').$type<BundleSheet[]>().notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
});
