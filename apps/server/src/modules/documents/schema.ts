import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { DocumentExportReference, DocumentProfileCategory, DocumentRevisionData } from '@scm/contracts';
import { fileIndex, user } from '../../db/schema.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const documentProfiles = pgTable('document_profile', {
  id: uuid('id').primaryKey(), category: text('category').$type<DocumentProfileCategory>().notNull(), key: text('key').notNull(),
  version: integer('version').notNull().default(1), status: text('status').notNull().default('active'), data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('document_profile_category_key_idx').on(t.category, t.key), check('document_profile_version_check', sql`${t.version} > 0`), check('document_profile_status_check', sql`${t.status} IN ('active','retired')`)]);
export const documentProfileVersions = pgTable('document_profile_version', {
  id: uuid('id').primaryKey(), profileId: uuid('profile_id').notNull().references(() => documentProfiles.id), version: integer('version').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(), reason: text('reason').notNull(), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('document_profile_version_idx').on(t.profileId, t.version)]);
export const documentTemplates = pgTable('document_template', {
  id: uuid('id').primaryKey(), purpose: text('purpose').notNull(), name: text('name').notNull(), version: integer('version').notNull().default(1), status: text('status').notNull().default('active'),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('document_template_purpose_name_idx').on(t.purpose, t.name), check('document_template_version_check', sql`${t.version} > 0`), check('document_template_status_check', sql`${t.status} IN ('active','retired')`)]);
export const documentTemplateVersions = pgTable('document_template_version', {
  id: uuid('id').primaryKey(), templateId: uuid('template_id').notNull().references(() => documentTemplates.id), version: integer('version').notNull(),
  fileId: uuid('file_id').notNull().references(() => fileIndex.id), sha256: text('sha256').notNull(), mimeType: text('mime_type').notNull(),
  originalName: text('original_name').notNull(), reason: text('reason').notNull(), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('document_template_version_idx').on(t.templateId, t.version)]);
export const documents = pgTable('document', {
  id: uuid('id').primaryKey(), purpose: text('purpose').notNull(), status: text('status').notNull().default('draft'), version: integer('version').notNull().default(1), currentRevisionId: uuid('current_revision_id'),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [index('document_created_idx').on(t.createdAt), check('document_status_check', sql`${t.status} IN ('draft','pending_review','approved','returned','cancelled','superseded','stale')`), check('document_version_check', sql`${t.version} > 0`)]);
export const documentRevisions = pgTable('document_revision', {
  id: uuid('id').primaryKey(), documentId: uuid('document_id').notNull().references(() => documents.id), version: integer('version').notNull(), data: jsonb('data').$type<DocumentRevisionData>().notNull(),
  reason: text('reason').notNull(), createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('document_revision_version_idx').on(t.documentId, t.version)]);
export const documentMemberClaims = pgTable('document_member_claim', {
  id: uuid('id').primaryKey(), purpose: text('purpose').notNull(), sid: integer('sid').notNull(), fba: text('fba').notNull(), demandId: uuid('demand_id').notNull(), documentId: uuid('document_id').notNull().references(() => documents.id), revisionId: uuid('revision_id').notNull().references(() => documentRevisions.id),
  releasedAt: at('released_at'), createdAt: at('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('document_member_live_unique').on(t.purpose, t.sid, t.fba).where(sql`${t.releasedAt} IS NULL`), index('document_member_document_idx').on(t.documentId)]);
export const documentValidations = pgTable('document_validation', {
  id: uuid('id').primaryKey(), documentId: uuid('document_id').notNull().references(() => documents.id), revisionId: uuid('revision_id').notNull().references(() => documentRevisions.id), valid: boolean('valid').notNull(), issues: jsonb('issues').$type<Array<Record<string, unknown>>>().notNull(), checkedBy: text('checked_by').notNull().references(() => user.id), checkedAt: at('checked_at').notNull().defaultNow(),
}, (t) => [index('document_validation_document_idx').on(t.documentId, t.checkedAt)]);
export const documentExports = pgTable('document_export', {
  id: uuid('id').primaryKey(), operationId: uuid('operation_id').notNull().unique(), requestHash: text('request_hash').notNull(), reference: jsonb('reference').$type<DocumentExportReference>().notNull(),
  status: text('status').notNull().default('queued'), queueJobId: text('queue_job_id'), fileId: uuid('file_id').references(() => fileIndex.id), error: text('error'),
  createdBy: text('created_by').notNull().references(() => user.id), createdAt: at('created_at').notNull().defaultNow(), completedAt: at('completed_at'),
}, (t) => [index('document_export_document_idx').on(t.createdAt), check('document_export_status_check', sql`${t.status} IN ('queued','running','completed','failed','stale')`)]);
export const documentReviews = pgTable('document_review', {
  id: uuid('id').primaryKey(), documentId: uuid('document_id').notNull().references(() => documents.id), revisionId: uuid('revision_id').notNull().references(() => documentRevisions.id), exportId: uuid('export_id').notNull().references(() => documentExports.id), fileId: uuid('file_id').notNull().references(() => fileIndex.id), fileSha256: text('file_sha256').notNull(), decision: text('decision').notNull(), reason: text('reason').notNull(), dependencies: jsonb('dependencies').$type<DocumentExportReference>().notNull(), reviewedBy: text('reviewed_by').notNull().references(() => user.id), reviewedAt: at('reviewed_at').notNull().defaultNow(),
}, (t) => [index('document_review_document_idx').on(t.documentId, t.reviewedAt), check('document_review_decision_check', sql`${t.decision} IN ('approve','return')`)]);
