import { createHash } from 'node:crypto';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { DOCUMENT_INVOICE_UNIT_PRICE } from '@scm/contracts';
import { createDocumentBundleWorkbook, type BundleSheet, type BundleWorkbookInput } from './bundle-workbook.js';
import { DocumentWorkbookError } from './workbook-errors.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const safeFileName = (name: string) => name.length <= 200 && !/[\\/:*?"<>|]/.test(name) && !Array.from(name).some((character) => character.charCodeAt(0) < 32) && !name.startsWith('.') && /\.xlsx$/i.test(name);

/** Extract a pinned child Excel without reading or changing any database state. */
export function extractDocumentArchiveInvoice(bytes: Buffer, fileName: string): Buffer {
  if (!safeFileName(fileName)) throw new DocumentWorkbookError('整批压缩包的单票文件映射无效。');
  let entries: ReturnType<typeof unzipSync>;
  try { entries = unzipSync(bytes, { filter: (entry) => entry.name === fileName }); }
  catch { throw new DocumentWorkbookError('整批发票压缩包损坏，无法读取已归档单票文件。'); }
  if (!entries[fileName]?.length) throw new DocumentWorkbookError('整批压缩包缺少已映射的单票 Excel 文件。');
  return Buffer.from(entries[fileName]);
}

/** Read only the mapped invoice file; legacy bundles continue to use XLSX row selections. */
export function documentBundleInvoiceBytes(input: BundleWorkbookInput): Buffer {
  const fileNames = [...new Set(input.selections?.flatMap((selection) => selection.fileName ? [selection.fileName] : []) ?? [])];
  if (!fileNames.length) return input.bytes;
  if (fileNames.length !== 1 || input.selections?.some((selection) => !selection.fileName)) throw new DocumentWorkbookError('整批压缩包的单票文件映射无效。');
  const bytes = extractDocumentArchiveInvoice(input.bytes, fileNames[0]!);
  if (input.selections?.some((selection) => selection.fileSha256 && selection.fileSha256 !== digest(bytes))) throw new DocumentWorkbookError('整批压缩包的单票 Excel 文件哈希与范围映射不一致。');
  return bytes;
}

/** One independent, single-sheet XLSX per invoice, including invoices with identical headers. */
export async function createDocumentBundleArchive(inputs: BundleWorkbookInput[]): Promise<{ bytes: Buffer; sheets: BundleSheet[]; fileCount: number }> {
  if (!inputs.length || new Set(inputs.map((input) => input.documentId)).size !== inputs.length) throw new DocumentWorkbookError('整批发票范围为空或存在重复单据。');
  const entries: Zippable = {}, sheets: BundleSheet[] = [], expected = new Map<string, string>();
  for (const [index, input] of inputs.entries()) {
    const workbook = await createDocumentBundleWorkbook([{ ...input, bytes: documentBundleInvoiceBytes(input), expectedUnitPrice: Number(DOCUMENT_INVOICE_UNIT_PRICE) }]);
    if (workbook.sheets.length !== 1) throw new DocumentWorkbookError('同一张发票包含不一致的表头，无法输出为独立单工作表 Excel 文件。');
    const identity = input.documentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'invoice';
    const fileName = `发票-${String(index + 1).padStart(3, '0')}-${identity}.xlsx`;
    entries[fileName] = [workbook.bytes, { level: 0, mtime: new Date('2026-10-25T00:00:00Z') }];
    const fileSha256 = digest(workbook.bytes);
    expected.set(fileName, fileSha256);
    sheets.push({ ...workbook.sheets[0]!, fileName, fileSha256 });
  }
  const bytes = Buffer.from(zipSync(entries, { level: 0 })), verified = unzipSync(bytes);
  if (Object.keys(verified).length !== inputs.length || [...expected].some(([name, hash]) => !verified[name] || digest(verified[name]) !== hash)) throw new DocumentWorkbookError('整批发票压缩包文件数量或内容回读不符。');
  return { bytes, sheets, fileCount: inputs.length };
}
