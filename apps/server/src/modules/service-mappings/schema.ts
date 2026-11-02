import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from '../../db/schema.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const serviceMappings = pgTable('service_mapping', {
  id: uuid('id').primaryKey(),
  countryCode: text('country_code').notNull(),
  transportMethod: text('transport_method').notNull(),
  transportMethodId: text('transport_method_id'),
  service: text('service').notNull(),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => user.id),
  updatedBy: text('updated_by').notNull().references(() => user.id),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
  deletedAt: at('deleted_at'),
}, (t) => [
  uniqueIndex('service_mapping_active_combination_uq').on(t.countryCode, t.transportMethod).where(sql`${t.deletedAt} IS NULL`),
  check('service_mapping_country_check', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
  check('service_mapping_fields_check', sql`length(btrim(${t.transportMethod})) BETWEEN 1 AND 500 AND length(btrim(${t.service})) BETWEEN 1 AND 4000`),
  check('service_mapping_version_check', sql`${t.version} > 0`),
]);
