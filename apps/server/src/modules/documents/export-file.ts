import { createHash } from 'node:crypto';
import type { DocumentExportReference } from '@scm/contracts';
import type { fileIndex } from '../../db/schema.js';
import { checkedFileBytes, ImportError } from '../imports/service.js';
import { extractDocumentArchiveInvoice } from './bundle-archive.js';

export function documentExportFileSha256(reference: DocumentExportReference, archiveSha256: string | null): string | null {
  return reference.invoiceFileSha256 ?? archiveSha256;
}

/** Verify the stored archive and the exact Excel bytes selected for review. */
export async function checkedDocumentExportFile(file: typeof fileIndex.$inferSelect, reference: DocumentExportReference): Promise<Buffer> {
  const bytes = await checkedFileBytes(file);
  if (!reference.invoiceFileName && !reference.invoiceFileSha256) return bytes;
  if (!reference.bundleJobId || !reference.invoiceFileName || !reference.invoiceFileSha256 || file.mimeType !== 'application/zip') throw new ImportError('FILE_INTEGRITY_ERROR', 503, '单票 Excel 的归档引用不完整或文件类型不符。');
  let invoice: Buffer;
  try { invoice = extractDocumentArchiveInvoice(bytes, reference.invoiceFileName); }
  catch { throw new ImportError('FILE_INTEGRITY_ERROR', 503, '归档压缩包中的单票 Excel 无法读取。'); }
  if (createHash('sha256').update(invoice).digest('hex') !== reference.invoiceFileSha256) throw new ImportError('FILE_INTEGRITY_ERROR', 503, '归档压缩包中的单票 Excel 哈希不符。');
  return invoice;
}
