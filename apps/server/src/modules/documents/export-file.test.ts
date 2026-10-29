import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentExportReference } from '@scm/contracts';
import type { fileIndex } from '../../db/schema.js';

const mocks = vi.hoisted(() => ({ checked: vi.fn() }));
vi.mock('../imports/service.js', async (original) => ({ ...await original<typeof import('../imports/service.js')>(), checkedFileBytes: mocks.checked }));
import { checkedDocumentExportFile, documentExportFileSha256 } from './export-file.js';
import { serializeDocumentExport } from './exports.js';
import type { documentExports } from './schema.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invoice = Buffer.from('immutable invoice bytes'), other = Buffer.from('different invoice');
const archive = Buffer.from(zipSync({ 'invoice.xlsx': invoice, 'other.xlsx': other }));
const file = { id: 'file', sha256: sha256(archive), mimeType: 'application/zip' } as typeof fileIndex.$inferSelect;
const reference = { documentId: 'doc', bundleJobId: 'job', invoiceFileName: 'invoice.xlsx', invoiceFileSha256: sha256(invoice) } as DocumentExportReference;

beforeEach(() => { vi.clearAllMocks(); mocks.checked.mockResolvedValue(archive); });

describe('exact invoice file identity inside a stored ZIP', () => {
  it('exposes the downloadable Excel hash and verifies its bytes after checking the archive', async () => {
    expect(documentExportFileSha256(reference, file.sha256)).toBe(sha256(invoice));
    expect(await checkedDocumentExportFile(file, reference)).toEqual(invoice);
    expect(mocks.checked).toHaveBeenCalledWith(file);
    const row = { id: 'export', status: 'completed', reference, fileId: file.id, error: null, createdAt: new Date(), completedAt: new Date() } as typeof documentExports.$inferSelect;
    expect(serializeDocumentExport(row, undefined, file.sha256).fileSha256).toBe(sha256(invoice));
  });
  it('preserves historical standalone and merged XLSX file identity', async () => {
    const legacy = {} as DocumentExportReference;
    mocks.checked.mockResolvedValue(invoice);
    expect(documentExportFileSha256(legacy, sha256(invoice))).toBe(sha256(invoice));
    expect(await checkedDocumentExportFile({ ...file, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, legacy)).toEqual(invoice);
  });
  it.each([
    { invoiceFileName: 'other.xlsx' }, { invoiceFileName: 'missing.xlsx' }, { invoiceFileName: '../invoice.xlsx' },
    { invoiceFileSha256: '0'.repeat(64) }, { invoiceFileSha256: undefined }, { invoiceFileName: undefined }, { bundleJobId: undefined },
  ])('rejects missing or substituted per-invoice identity %j', async (override) => {
    await expect(checkedDocumentExportFile(file, { ...reference, ...override })).rejects.toMatchObject({ code: 'FILE_INTEGRITY_ERROR', status: 503 });
  });
  it('propagates archive integrity errors before reading an invoice', async () => {
    const error = new Error('archive hash mismatch'); mocks.checked.mockRejectedValue(error);
    await expect(checkedDocumentExportFile(file, reference)).rejects.toBe(error);
  });
});
