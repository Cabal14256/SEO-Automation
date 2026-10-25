import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { documentListQuerySchema, documentStatusSchema } from '@scm/contracts';
import { documentListWhere, needsDocumentStatusFilter } from './query.js';

const compile = (input: Record<string, unknown>) => {
  const condition = documentListWhere(documentListQuerySchema.parse(input));
  return condition ? new PgDialect().sqlToQuery(condition) : null;
};

describe('document list query contract and SQL predicates', () => {
  it('defaults to active history with bounded pagination and normalizes the search text', () => {
    expect(documentListQuerySchema.parse({})).toEqual({ status: 'active', page: 1, pageSize: 20 });
    expect(documentListQuerySchema.parse({ q: '  Invoice  ', page: '2', pageSize: '100', weekStartDate: '2026-10-19' }))
      .toEqual({ q: 'Invoice', page: 2, pageSize: 100, weekStartDate: '2026-10-19', status: 'active' });
    expect(documentListQuerySchema.parse({ q: ` ${'x'.repeat(200)} ` }).q).toHaveLength(200);
    for (const input of [{ q: 'x'.repeat(201) }, { weekStartDate: '2026-02-30' }, { status: 'deleted' }, { page: 0 }, { pageSize: 101 }]) {
      expect(documentListQuerySchema.safeParse(input).success).toBe(false);
    }
    for (const status of ['active', 'all', ...documentStatusSchema.options]) expect(documentListQuerySchema.safeParse({ status }).success).toBe(true);
  });

  it('searches the current revision title, order number, FBA, shop and the document ID case-insensitively and literally', () => {
    const q = "Invoice_100%\\' OR true --", compiled = compile({ status: 'all', q })!;
    expect(compiled.params).toEqual(Array(5).fill(q));
    expect(compiled.sql).not.toContain(q);
    expect(compiled.sql).not.toMatch(/\bI?LIKE\b/i);
    expect(compiled.sql.match(/strpos\(lower\(/g)).toHaveLength(5);
    expect(compiled.sql).toContain('"document"."id"::text');
    expect(compiled.sql).toContain("->>'title'");
    expect(compiled.sql).toContain("->'fields'->>'orderNumber'");
    expect(compiled.sql).toContain("->'demand'->'snapshot'->>'fba'");
    expect(compiled.sql).toContain("->'demand'->'snapshot'->>'shop'");
  });

  it('keeps cheap filters in SQL without reducing the stale candidate set to stored stale rows', () => {
    const stale = compile({ status: 'stale', month: '2026-10' })!;
    expect(stale.sql).toContain("->>'shippingRunMonth'");
    expect(stale.sql).toContain('not in');
    expect(stale.params).toEqual(['2026-10', 'cancelled', 'superseded']);
    const runId = 'bc4f3726-1298-4569-93c0-67dd166018f6';
    expect(compile({ shippingRunId: runId })!.params).toEqual([runId, 'cancelled', 'superseded']);
    expect(compile({ weekStartDate: '2026-10-19' })!.sql).not.toContain("->>'weekStartDate'");
    expect(compile({})!.params).toEqual(['cancelled', 'superseded']);
    expect(compile({ status: 'all', q: '   ' })).toBeNull();
    for (const status of ['draft', 'pending_review', 'approved', 'returned', 'stale'] as const) expect(needsDocumentStatusFilter(status)).toBe(true);
    for (const status of ['active', 'all', 'cancelled', 'superseded'] as const) expect(needsDocumentStatusFilter(status)).toBe(false);
    expect(compile({ status: 'cancelled' })!.params).toEqual(['cancelled']);
  });
});
