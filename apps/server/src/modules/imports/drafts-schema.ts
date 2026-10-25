import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ImportDraftContent } from '@scm/contracts';
import { user } from '../../db/schema.js';

export const importDrafts = pgTable('import_draft', {
  id: uuid('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => user.id),
  title: text('title').notNull(), content: jsonb('content').$type<ImportDraftContent>().notNull(),
  version: integer('version').notNull().default(1), lastExpectedVersion: integer('last_expected_version').notNull(), requestHash: text('request_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
}, (t) => [index('import_draft_owner_updated_idx').on(t.ownerId, t.updatedAt),
  check('import_draft_version_check', sql`${t.version}>0 AND ${t.lastExpectedVersion}>=0 AND ${t.lastExpectedVersion}<${t.version}`),
  check('import_draft_title_check', sql`length(trim(${t.title})) BETWEEN 1 AND 120`),
]);
