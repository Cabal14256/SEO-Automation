import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { DocumentAddressCodeCatalog } from './address-code.js';
import { parseReferenceWorkbook } from './reference-workbook.js';

export class DocumentAddressCodeCatalogError extends Error {
  readonly code = 'DOCUMENT_ADDRESS_CODE_CATALOG_INVALID';
  constructor(message: string) { super(message); this.name = 'DocumentAddressCodeCatalogError'; }
}

const sourceRowsSchema = z.array(z.object({
  sourceRow: z.number().int().positive(), values: z.record(z.string(), z.string()), issues: z.array(z.string()),
  cells: z.array(z.object({ formula: z.boolean() })),
}));
let parsedCache: { sha256: string; rows: DocumentAddressCodeCatalog['rows'] } | null = null;

/** Read only an explicitly configured, hash-pinned original. The caller decides
 * which individual rows can support a business decision, including shared FCs. */
export async function loadDocumentAddressCodeCatalog(input: NodeJS.ProcessEnv = process.env): Promise<DocumentAddressCodeCatalog | null> {
  const file = input.DOCUMENT_ADDRESS_CODE_CATALOG_FILE?.trim(), expected = input.DOCUMENT_ADDRESS_CODE_CATALOG_SHA256?.trim();
  if (!file && !expected) return null;
  if (!file || !expected) throw new DocumentAddressCodeCatalogError('DOCUMENT_ADDRESS_CODE_CATALOG_FILE 和 DOCUMENT_ADDRESS_CODE_CATALOG_SHA256 必须同时配置。');
  if (!isAbsolute(file)) throw new DocumentAddressCodeCatalogError('DOCUMENT_ADDRESS_CODE_CATALOG_FILE 必须是受控 XLSX 原件的绝对路径。');
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new DocumentAddressCodeCatalogError('DOCUMENT_ADDRESS_CODE_CATALOG_SHA256 必须是 64 位十六进制 SHA-256。');
  let bytes: Buffer;
  try { bytes = await readFile(file); }
  catch { throw new DocumentAddressCodeCatalogError('地址编码参考文件无法读取，请检查 DOCUMENT_ADDRESS_CODE_CATALOG_FILE。'); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Always read and hash before consulting the cache: a changed original must
  // never keep supplying rows from an earlier, successfully parsed version.
  if (sha256 !== expected.toLowerCase()) throw new DocumentAddressCodeCatalogError('地址编码参考文件与 DOCUMENT_ADDRESS_CODE_CATALOG_SHA256 不一致，请重新核对原件和锁定哈希。');
  let rows = parsedCache?.sha256 === sha256 ? parsedCache.rows : null;
  if (!rows) {
    try {
      const plan = await parseReferenceWorkbook(bytes);
      const dataset = plan.datasets.find((entry) => entry.kind === 'address_catalog');
      const sourceRows = sourceRowsSchema.parse(dataset?.data.rows);
      // plan.addresses omits same-FC conflicts and formula rows. Keep the raw
      // dataset instead so the resolver can inspect those special cases.
      rows = sourceRows.map((row) => ({ sourceRow: row.sourceRow, values: row.values, issues: row.issues, hasFormula: row.cells.some((cell) => cell.formula) }));
      parsedCache = { sha256, rows };
    } catch { throw new DocumentAddressCodeCatalogError('地址编码参考文件无法解析，请核对受控 XLSX 原件的地址库、发货渠道、报关方式及预计送仓数据工作表。'); }
  }
  return { sha256, sourceLabel: basename(file), rows: structuredClone(rows) };
}
