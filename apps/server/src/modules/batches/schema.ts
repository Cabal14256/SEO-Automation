import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { GroupConfirmation, ShipmentData, SubBatchRecord } from '@scm/contracts';
import { demands, demandRevisions, user } from '../../db/schema.js';
import { shippingLifecycleColumns } from '../shipping-lifecycle/columns.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const weeklyBatches = pgTable('weekly_batch', {
  id: uuid('id').primaryKey(), weekStartDate: date('week_start_date').notNull(), weekEndDate: date('week_end_date').notNull(),
  // Legacy date columns remain for historical snapshots; new scopes belong to an occurrence.
  shippingRunId: uuid('shipping_run_id'),
  version: integer('version').notNull().default(1), sortMode: text('sort_mode').notNull().default('fba'), nextPrefix: integer('next_prefix').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('weekly_batch_week_idx').on(t.weekStartDate, t.weekEndDate).where(sql`${t.shippingRunId} IS NULL`), uniqueIndex('processing_batch_run_uq').on(t.shippingRunId), check('weekly_batch_range_check', sql`${t.weekEndDate} = ${t.weekStartDate} + 6 AND extract(isodow from ${t.weekStartDate}) = 1`), check('weekly_batch_version_check', sql`${t.version}>0 AND ${t.nextPrefix}>=0`)]);
export const subBatches = pgTable('sub_batch', {
  ...shippingLifecycleColumns(),
  id: uuid('id').primaryKey(), batchId: uuid('batch_id').notNull().references(() => weeklyBatches.id), name: text('name').notNull(), version: integer('version').notNull().default(1),
  status: text('status').notNull().default('draft'), position: integer('position').notNull().default(0), prefix: text('prefix'), confirmedVersion: integer('confirmed_version'), frozenAt: at('frozen_at'),
  correctionOfId: uuid('correction_of_id'), replacedById: uuid('replaced_by_id'), actualShipDate: date('actual_ship_date'),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [check('sub_batch_lifecycle_check', sql`${t.lifecycle} IN ('active','cancelled','trashed')`), index('sub_batch_week_idx').on(t.batchId), uniqueIndex('sub_batch_id_week_unique').on(t.id,t.batchId), check('sub_batch_status_check', sql`${t.status} IN ('draft','confirmed','frozen','superseded')`), check('sub_batch_version_check', sql`${t.version}>0 AND ${t.position}>=0`)]);
export const subBatchMembers = pgTable('sub_batch_member', {
  id: uuid('id').primaryKey(), batchId: uuid('batch_id').notNull().references(() => weeklyBatches.id), groupId: uuid('group_id').notNull().references(() => subBatches.id),
  demandId: uuid('demand_id').notNull().references(() => demands.id), demandVersion: integer('demand_version').notNull(), active: boolean('active').notNull().default(true),
  createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('sub_batch_member_active_unique').on(t.demandId).where(sql`${t.active} = true`), index('sub_batch_member_group_idx').on(t.groupId),
  foreignKey({columns:[t.groupId,t.batchId],foreignColumns:[subBatches.id,subBatches.batchId],name:'sub_batch_member_group_week_fk'}),
  foreignKey({ columns: [t.demandId, t.demandVersion], foreignColumns: [demandRevisions.demandId, demandRevisions.version], name: 'sub_batch_member_demand_revision_fk' })]);
export const subBatchRevisions = pgTable('sub_batch_revision', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id), version: integer('version').notNull(), action: text('action').notNull(), reason: text('reason').notNull(),
  snapshot: jsonb('snapshot').$type<SubBatchRecord>().notNull(), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('sub_batch_revision_version_idx').on(t.groupId, t.version)]);
export const shipmentRevisions = pgTable('shipment_revision', {
  id: uuid('id').primaryKey(), demandId: uuid('demand_id').notNull().references(() => demands.id), version: integer('version').notNull(), demandVersion: integer('demand_version').notNull(),
  data: jsonb('data').$type<ShipmentData>().notNull(), source: text('source').notNull(), snapshotIds: jsonb('snapshot_ids').$type<string[]>().notNull().default([]), reason: text('reason').notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('shipment_revision_version_idx').on(t.demandId, t.version), foreignKey({ columns: [t.demandId, t.demandVersion], foreignColumns: [demandRevisions.demandId, demandRevisions.version], name: 'shipment_revision_demand_fk' }), check('shipment_revision_source_check', sql`${t.source} IN ('lingxing','manual','xlsx')`)]);
export const groupConfirmations = pgTable('group_confirmation', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id), groupVersion: integer('group_version').notNull(),
  snapshot: jsonb('snapshot').$type<GroupConfirmation['snapshot']>().notNull(), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('group_confirmation_version_idx').on(t.groupId, t.groupVersion)]);
export const allocationCodes = pgTable('allocation_code', {
  id: uuid('id').primaryKey(), batchId: uuid('batch_id').notNull().references(() => weeklyBatches.id), groupId: uuid('group_id').notNull().references(() => subBatches.id),
  demandId: uuid('demand_id').notNull().references(() => demands.id), boxId: uuid('box_id').notNull(), prefix: text('prefix').notNull(), sequence: integer('sequence').notNull(),
  code: text('code').notNull(), valid: boolean('valid').notNull().default(true), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('allocation_code_week_code_idx').on(t.batchId, t.code), uniqueIndex('allocation_code_active_box_idx').on(t.groupId, t.boxId).where(sql`${t.valid}=true`), check('allocation_code_sequence_check', sql`${t.sequence}>0`)]);
export const batchDecisions = pgTable('batch_decision', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id), demandId: uuid('demand_id').notNull().references(() => demands.id),
  shipmentVersion: integer('shipment_version').notNull(), issueCode: text('issue_code').notNull(), note: text('note').notNull(), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [index('batch_decision_group_idx').on(t.groupId)]);
export const batchPrintRecords = pgTable('batch_print_record', {
  id: uuid('id').primaryKey(), groupId: uuid('group_id').notNull().references(() => subBatches.id), confirmationId: uuid('confirmation_id').notNull().references(() => groupConfirmations.id), note: text('note').notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
});
export const batchOperations = pgTable('batch_operation', {
  operationId: uuid('operation_id').primaryKey(), actorId: text('actor_id').notNull().references(() => user.id), action: text('action').notNull(), requestHash: text('request_hash').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(), createdAt: at('created_at').notNull().defaultNow(),
});
