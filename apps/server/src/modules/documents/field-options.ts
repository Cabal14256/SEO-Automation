import { desc, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import type { DocumentFieldOptions } from '@scm/contracts';
import { db } from '../../db/client.js';
import { requireBatchActor } from '../batches/service.js';
import { documentReferenceDatasets } from './reference-schema.js';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A reference service name remains a suggestion, never a business-channel mapping. */
export function referenceServiceOptions(data: unknown): string[] {
  if (!object(data) || !Array.isArray(data.rows)) return [];
  const services = new Set<string>();
  for (const row of data.rows) {
    if (!object(row) || !Array.isArray(row.issues) || row.issues.length || !object(row.values)
      || !Array.isArray(row.cells) || !row.cells.length
      || row.cells.some((cell: unknown) => !object(cell) || cell.formula !== false || cell.type === ExcelJS.ValueType.Error)) continue;
    const name = typeof row.values.name === 'string' ? row.values.name.trim() : '';
    if (name) services.add(name);
  }
  return [...services];
}

export async function getDocumentFieldOptions(actorId: string): Promise<DocumentFieldOptions> {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const [catalog] = await tx.select({ data: documentReferenceDatasets.data }).from(documentReferenceDatasets)
      .where(eq(documentReferenceDatasets.kind, 'channel_catalog'))
      .orderBy(desc(documentReferenceDatasets.createdAt), desc(documentReferenceDatasets.id)).limit(1);
    return { services: referenceServiceOptions(catalog?.data) };
  });
}
