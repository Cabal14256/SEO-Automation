import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { fileIndex, user } from '../../db/schema.js';

export const documentReferenceKinds = ['customs_options', 'channel_catalog', 'address_catalog', 'transit_reference'] as const;
export type DocumentReferenceKind = typeof documentReferenceKinds[number];

// Immutable source datasets: a changed file or parser produces a new row.
// These records are reference material, not adopted business profiles.
export const documentReferenceDatasets = pgTable('document_reference_dataset', {
  id: uuid('id').primaryKey(),
  kind: text('kind').$type<DocumentReferenceKind>().notNull(),
  sourceFileId: uuid('source_file_id').notNull().references(() => fileIndex.id),
  sourceSha256: text('source_sha256').notNull(),
  sheetName: text('sheet_name').notNull(),
  sourceRange: text('source_range').notNull(),
  parserVersion: text('parser_version').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  contentSha256: text('content_sha256').notNull(),
  createdBy: text('created_by').notNull().references(() => user.id),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('document_reference_dataset_source_unique').on(table.sourceSha256, table.kind, table.sheetName, table.parserVersion),
  check('document_reference_dataset_kind_check', sql`${table.kind} IN ('customs_options', 'channel_catalog', 'address_catalog', 'transit_reference')`),
  check('document_reference_dataset_source_sha256_check', sql`${table.sourceSha256} ~ '^[a-f0-9]{64}$'`),
  check('document_reference_dataset_content_sha256_check', sql`${table.contentSha256} ~ '^[a-f0-9]{64}$'`),
]);
