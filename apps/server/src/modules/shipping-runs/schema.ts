import { check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ShippingRunIssue } from '@scm/contracts';
import { demands, importParseRuns, sourceImports, sourceImportRows, user } from '../../db/schema.js';
import { subBatches } from '../batches/schema.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export type ShippingCheckpoint = { operations: Record<string, { input: unknown; resultId?: string }>; lookupAttempt: number };
export const shippingRuns = pgTable('shipping_run', {
  id: uuid('id').primaryKey(), importId: uuid('import_id').references(() => sourceImports.id), parseRunId: uuid('parse_run_id').references(() => importParseRuns.id),
  origin: text('origin').notNull().default('import'), membershipFrozenAt: at('membership_frozen_at'),
  version: integer('version').notNull().default(1), status: text('status').notNull().default('queued'), stage: text('stage').notNull().default('lookup'),
  numberingDate: date('numbering_date').notNull(), month: text('month').notNull(), sequence: integer('sequence'), queueJobId: text('queue_job_id'),
  checkpoint: jsonb('checkpoint').$type<ShippingCheckpoint>().notNull().default({ operations: {}, lookupAttempt: 0 }), issues: jsonb('issues').$type<ShippingRunIssue[]>().notNull().default([]),
  error: jsonb('error').$type<{ code: string; message: string }>(), createdBy: text('created_by').notNull().references(() => user.id),
  createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('shipping_run_import_uq').on(t.importId), uniqueIndex('shipping_run_month_sequence_uq').on(t.month, t.sequence), index('shipping_run_status_idx').on(t.status, t.createdAt),
  check('shipping_run_status_check', sql`${t.status} IN ('draft','queued','running','needs_review','ready','failed')`), check('shipping_run_stage_check', sql`${t.stage} IN ('lookup','commit','grouping','sync','confirmation','ready')`),
  check('shipping_run_origin_check', sql`(${t.origin}='import' AND ${t.importId} IS NOT NULL AND ${t.parseRunId} IS NOT NULL) OR (${t.origin}='manual' AND ${t.importId} IS NULL AND ${t.parseRunId} IS NULL)`),
  check('shipping_run_number_check', sql`${t.version}>0 AND (${t.sequence} IS NULL OR ${t.sequence}>0) AND ${t.month}=to_char(${t.numberingDate},'YYYY-MM')`)]);
export const shippingTickets = pgTable('shipping_ticket', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => shippingRuns.id), sourceTicketIndex: integer('source_ticket_index').notNull(),
  country: text('country'), ticketSequence: integer('ticket_sequence'), number: text('number'),
}, (t) => [uniqueIndex('shipping_ticket_source_uq').on(t.runId, t.sourceTicketIndex), uniqueIndex('shipping_ticket_number_uq').on(t.number),
  check('shipping_ticket_order_check', sql`${t.sourceTicketIndex}>0 AND (${t.ticketSequence} IS NULL OR ${t.ticketSequence}>0)`)]);
export const shippingTicketMembers = pgTable('shipping_ticket_member', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => shippingRuns.id), ticketId: uuid('ticket_id').notNull().references(() => shippingTickets.id),
  sourceRowId: uuid('source_row_id').references(() => sourceImportRows.id), demandId: uuid('demand_id').references(() => demands.id),
  fba: text('fba').notNull(), sid: integer('sid'), inputOrder: integer('input_order').notNull(), groupId: uuid('group_id').references(() => subBatches.id),
}, (t) => [uniqueIndex('shipping_ticket_member_demand_uq').on(t.demandId), uniqueIndex('shipping_ticket_member_run_fba_uq').on(t.runId, t.fba), uniqueIndex('shipping_ticket_member_order_uq').on(t.ticketId, t.inputOrder), index('shipping_ticket_member_run_idx').on(t.runId),
  check('shipping_ticket_member_order_check', sql`${t.inputOrder}>0 AND (${t.sid} IS NULL OR ${t.sid}>0)`)]);
export const shippingMonthCounters = pgTable('shipping_month_counter', { month: text('month').primaryKey(), lastSequence: integer('last_sequence').notNull().default(0) }, (t) => [check('shipping_month_counter_value_check', sql`${t.lastSequence}>=0`)]);
export const shippingRunOperations = pgTable('shipping_run_operation', {
  operationId: uuid('operation_id').primaryKey(), runId: uuid('run_id').notNull().references(() => shippingRuns.id), actorId: text('actor_id').notNull().references(() => user.id), requestHash: text('request_hash').notNull(), createdAt: at('created_at').notNull().defaultNow(),
});
export const shippingRunCorrections = pgTable('shipping_run_correction', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => shippingRuns.id), version: integer('version').notNull(),
  reason: text('reason').notNull(), snapshot: jsonb('snapshot').$type<{ run: Record<string, unknown>; tickets: Array<Record<string, unknown>> }>().notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('shipping_run_correction_version_uq').on(t.runId, t.version)]);
