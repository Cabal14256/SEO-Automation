import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { DocumentListQuery } from '@scm/contracts';
import { documentRevisions, documents } from './schema.js';

/** Only stable predicates belong in SQL; stale is derived from current dependencies. */
export function documentListWhere(query: DocumentListQuery) {
  const conditions = [];
  if (query.shippingRunId) conditions.push(sql`${documentRevisions.data}->>'shippingRunId' = ${query.shippingRunId}`);
  if (query.month) conditions.push(sql`${documentRevisions.data}->>'shippingRunMonth' = ${query.month}`);
  if (query.status === 'active' || query.status === 'stale') conditions.push(notInArray(documents.status, ['cancelled', 'superseded']));
  else if (query.status !== 'all') conditions.push(eq(documents.status, query.status));
  if (query.q) {
    // strpos treats %, _ and backslashes literally, unlike LIKE/ILIKE patterns.
    const needle = sql`lower(${query.q})`;
    conditions.push(sql`(
      strpos(lower(${documents.id}::text), ${needle}) > 0
      OR strpos(lower(coalesce(${documentRevisions.data}->>'title', '')), ${needle}) > 0
      OR strpos(lower(coalesce(${documentRevisions.data}->'fields'->>'orderNumber', '')), ${needle}) > 0
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(${documentRevisions.data}->'members') AS member
        WHERE strpos(lower(coalesce(member->'demand'->'snapshot'->>'fba', '')), ${needle}) > 0
          OR strpos(lower(coalesce(member->'demand'->'snapshot'->>'shop', '')), ${needle}) > 0
      )
    )`);
  }
  return and(...conditions);
}

export function needsDocumentStatusFilter(status: DocumentListQuery['status']) {
  return !['active', 'all', 'cancelled', 'superseded'].includes(status);
}
