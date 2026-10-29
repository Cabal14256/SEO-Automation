import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DocumentExportReference, WorkflowSource } from '@scm/contracts';
import type { BatchTx } from '../batches/service.js';

const mocks = vi.hoisted(() => ({ lockedDocument: vi.fn(), dependencyValidity: vi.fn(), checkedExport: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: {}, pool: {} }));
vi.mock('../documents/service.js', () => ({ lockedDocument: mocks.lockedDocument, documentDependencyValidityInTx: mocks.dependencyValidity, documentOperation: vi.fn(), documentCandidatesInTx: vi.fn() }));
vi.mock('../documents/export-file.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../documents/export-file.js')>(), checkedDocumentExportFile: mocks.checkedExport }));

import { ImportError } from '../imports/service.js';
import { getWorkflowSourceInTx, sourceValidityInTx } from './service.js';

const archiveHash = 'a'.repeat(64), invoiceHash = 'b'.repeat(64), dialect = new PgDialect();
const reference = { documentId: 'document', revisionId: 'revision', revisionVersion: 1 } as DocumentExportReference;
const file = { id: 'archive-file', sha256: archiveHash };

function sourceTx(exportReference: DocumentExportReference, approvedHash: string) {
  let queryIndex = 0;
  const reviewQueries: unknown[][] = [];
  const tx = { select: () => {
    const index = queryIndex++;
    let parameters: unknown[] = [];
    const query = {
      from: () => query,
      where: (condition: Parameters<typeof dialect.sqlToQuery>[0]) => { parameters = dialect.sqlToQuery(condition).params; if (index === 2) reviewQueries.push(parameters); return query; },
      orderBy: () => query, limit: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(index === 0 ? [{ id: 'export', fileId: file.id, reference: exportReference }] : index === 1 ? [file] : parameters.includes(approvedHash) ? [{ id: 'review', fileSha256: approvedHash }] : []).then(resolve),
    };
    return query;
  } } as unknown as BatchTx;
  return { tx, reviewQueries };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockedDocument.mockResolvedValue({ record: { status: 'approved', version: 2 }, revision: { id: 'revision', data: { title: 'Invoice', weekStartDate: '2026-10-26', fields: {}, members: [] } } });
  mocks.dependencyValidity.mockResolvedValue({ valid: true, invalidReason: null });
  mocks.checkedExport.mockResolvedValue(Buffer.from('checked invoice'));
});

describe('approved invoice workflow source', () => {
  it('matches the reviewed child Excel hash and verifies child bytes for a ZIP-backed invoice', async () => {
    const childReference = { ...reference, invoiceFileName: 'invoice.xlsx', invoiceFileSha256: invoiceHash };
    const { tx, reviewQueries } = sourceTx(childReference, invoiceHash);
    await expect(getWorkflowSourceInTx(tx, 'document', 'admin')).resolves.toMatchObject({ exportId: 'export', fileId: file.id, fileSha256: invoiceHash });
    expect(reviewQueries[0]).toContain(invoiceHash); expect(reviewQueries[0]).not.toContain(archiveHash);
    expect(mocks.checkedExport).toHaveBeenCalledExactlyOnceWith(file, childReference);
  });
  it('retains the archive hash for a legacy standalone or workbook invoice', async () => {
    const { tx, reviewQueries } = sourceTx(reference, archiveHash);
    await expect(getWorkflowSourceInTx(tx, 'document', 'admin')).resolves.toMatchObject({ fileSha256: archiveHash });
    expect(reviewQueries[0]).toContain(archiveHash);
    expect(mocks.checkedExport).toHaveBeenCalledExactlyOnceWith(file, reference);
  });
  it('does not accept a ZIP-container review as approval of its independently hashed child Excel', async () => {
    const { tx } = sourceTx({ ...reference, invoiceFileName: 'invoice.xlsx', invoiceFileSha256: invoiceHash }, archiveHash);
    await expect(getWorkflowSourceInTx(tx, 'document', 'admin')).rejects.toMatchObject({ code: 'SOURCE_REVIEW_REQUIRED' });
    expect(mocks.checkedExport).not.toHaveBeenCalled();
  });
  it('marks a source stale when its reviewed child bytes fail verification', async () => {
    const { tx } = sourceTx({ ...reference, invoiceFileName: 'invoice.xlsx', invoiceFileSha256: invoiceHash }, invoiceHash);
    mocks.checkedExport.mockRejectedValue(new ImportError('FILE_INTEGRITY_ERROR', 503, 'Child invoice hash mismatch'));
    await expect(sourceValidityInTx(tx, { documentId: 'document' } as WorkflowSource, 'admin')).resolves.toMatchObject({ valid: false });
  });
});
