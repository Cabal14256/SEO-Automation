import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { FbaLookupRow } from '@scm/contracts';
import { fileIndex, user } from '../../db/schema.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export type FbaLookupSellerScope = { id: string; sid: number; name: string; country: string; version: number };

export const fbaLookupRuns = pgTable('fba_lookup_run', {
  id: uuid('id').primaryKey(), operationId: uuid('operation_id').notNull().unique(), requestHash: text('request_hash').notNull(),
  status: text('status').notNull().default('queued'), queueJobId: uuid('queue_job_id'),
  startDate: text('start_date').notNull(), endDate: text('end_date').notNull(), fbas: jsonb('fbas').$type<string[]>().notNull(),
  catalogMode: text('catalog_mode').notNull(), catalogSettingsVersion: integer('catalog_settings_version').notNull(), catalogVersion: integer('catalog_version').notNull(),
  sellerScope: jsonb('seller_scope').$type<FbaLookupSellerScope[]>().notNull(), rows: jsonb('rows').$type<FbaLookupRow[]>().notNull().default([]),
  maxPages: integer('max_pages').notNull().default(20), requestBudget: integer('request_budget').notNull().default(20), requestsUsed: integer('requests_used').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
  startedAt: at('started_at'), completedAt: at('completed_at'), errorCode: text('error_code'), errorMessage: text('error_message'),
}, (t) => [index('fba_lookup_run_owner_time_idx').on(t.createdBy, t.createdAt),
  check('fba_lookup_run_status_check', sql`${t.status} IN ('queued','running','completed','failed')`),
  check('fba_lookup_run_catalog_check', sql`${t.catalogMode} IN ('manual','lingxing') AND ${t.catalogSettingsVersion}>0 AND ${t.catalogVersion}>=0`),
  check('fba_lookup_run_request_check', sql`${t.startDate}<=${t.endDate} AND jsonb_array_length(${t.fbas}) BETWEEN 1 AND 100 AND jsonb_array_length(${t.sellerScope})>0`),
  check('fba_lookup_run_budget_check', sql`${t.maxPages} BETWEEN 1 AND 100 AND ${t.requestBudget} BETWEEN 1 AND 1000 AND ${t.requestsUsed} BETWEEN 0 AND ${t.requestBudget}`),
  check('fba_lookup_run_results_check', sql`${t.status}='completed' OR ${t.rows}='[]'::jsonb`),
]);

export const fbaLookupSnapshots = pgTable('fba_lookup_snapshot', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => fbaLookupRuns.id),
  page: integer('page').notNull(), attempt: integer('attempt').notNull(), fileId: uuid('file_id').notNull().references(() => fileIndex.id),
  successful: integer('successful').notNull(), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('fba_lookup_snapshot_attempt_idx').on(t.runId, t.page, t.attempt),
  check('fba_lookup_snapshot_attempt_check', sql`${t.page}>=0 AND ${t.attempt}>0 AND ${t.successful} IN (0,1)`),
]);
