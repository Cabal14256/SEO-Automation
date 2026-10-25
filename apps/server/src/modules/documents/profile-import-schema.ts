import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { fileIndex, user } from '../../db/schema.js';
export const documentProfileImports = pgTable('document_profile_import', {
  id: uuid('id').primaryKey(), actorId: text('actor_id').notNull().references(() => user.id), fileId: uuid('file_id').notNull().references(() => fileIndex.id), sha256: text('sha256').notNull(), rows: jsonb('rows').$type<Array<Record<string, unknown>>>().notNull(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(), committedAt: timestamp('committed_at', { withTimezone: true, mode: 'date' }),
});
