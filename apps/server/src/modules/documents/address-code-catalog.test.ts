import { createHash } from 'node:crypto';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentAddressCodeCatalogError, loadDocumentAddressCodeCatalog } from './address-code-catalog.js';

const temporary: Array<{ directory: string; file: string }> = [];
afterEach(async () => {
  for (const { directory, file } of temporary.splice(0)) { await rm(file, { force: true }); await rmdir(directory); }
});
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const address = (code: string, line = '10 Example Road'): ExcelJS.CellValue[] => ['示例地址', code, 'SPECIAL1', 'Example Receiver', '', '', '', line, '', '', 'Example City', 'CA', 'US', '00123'];
async function fixture(edit?: (book: ExcelJS.Workbook) => void) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('地址库');
  sheet.addRows([
    ['地址简称', '地址编码', 'FBA仓库代码', '联系人', '公司名', '联系电话', '联系手机', '地址一', '地址二', '地址三', '城市', '省/洲', '国家', '邮编'],
    address('SPECIAL-A'),
  ]);
  book.addWorksheet('发货渠道').addRows([['渠道名称', '板块'], ['Example service', 'Example section']]);
  book.addWorksheet('报关方式').addRow(['普通报关']);
  book.addWorksheet('预计送仓数据').addRows([['', '渠道', 'FBA仓库代码', '预计送仓时效', '区域'], ['', 'Example service', 'SPECIAL1', '10', 'Example area']]);
  edit?.(book);
  const bytes = Buffer.from(await book.xlsx.writeBuffer()), directory = await mkdtemp(join(tmpdir(), 'scm-address-code-catalog-')), file = join(directory, 'controlled-reference.xlsx');
  temporary.push({ directory, file }); await writeFile(file, bytes);
  return { file, bytes, env: { DOCUMENT_ADDRESS_CODE_CATALOG_FILE: file, DOCUMENT_ADDRESS_CODE_CATALOG_SHA256: digest(bytes) } };
}

describe('explicit hash-pinned invoice address-code reference', () => {
  it('stays disabled when no reference is configured', async () => {
    await expect(loadDocumentAddressCodeCatalog({})).resolves.toBeNull();
    await expect(loadDocumentAddressCodeCatalog({ DOCUMENT_ADDRESS_CODE_CATALOG_FILE: '', DOCUMENT_ADDRESS_CODE_CATALOG_SHA256: ' ' })).resolves.toBeNull();
  });
  it('rejects incomplete configuration, relative paths and malformed hashes before reading a file', async () => {
    const file = join(tmpdir(), 'not-read.xlsx'), hash = 'a'.repeat(64);
    for (const env of [
      { DOCUMENT_ADDRESS_CODE_CATALOG_FILE: file }, { DOCUMENT_ADDRESS_CODE_CATALOG_SHA256: hash },
      { DOCUMENT_ADDRESS_CODE_CATALOG_FILE: 'relative/reference.xlsx', DOCUMENT_ADDRESS_CODE_CATALOG_SHA256: hash },
      { DOCUMENT_ADDRESS_CODE_CATALOG_FILE: file, DOCUMENT_ADDRESS_CODE_CATALOG_SHA256: 'not-a-sha256' },
    ]) await expect(loadDocumentAddressCodeCatalog(env)).rejects.toBeInstanceOf(DocumentAddressCodeCatalogError);
  });
  it('retains raw rows for multiple addresses at the same FC, including formula and diagnostic evidence', async () => {
    const input = await fixture((book) => {
      const sheet = book.getWorksheet('地址库')!; sheet.addRow(address('SPECIAL-B', '20 Other Road'));
      sheet.addRow(address('FORMULA')); sheet.getCell('B4').value = { formula: '"CACHED-CODE"', result: 'CACHED-CODE' };
      sheet.addRow(address('INCOMPLETE')); sheet.getCell('K5').value = null;
    });
    const catalog = await loadDocumentAddressCodeCatalog(input.env);
    expect(catalog).toMatchObject({ sha256: digest(input.bytes), sourceLabel: basename(input.file) });
    expect(catalog!.sourceLabel).not.toContain(tmpdir()); expect(catalog!.rows).toHaveLength(4);
    expect(catalog!.rows.slice(0, 2)).toEqual([
      expect.objectContaining({ sourceRow: 2, values: expect.objectContaining({ destinationFc: 'SPECIAL1', addressCode: 'SPECIAL-A', addressLine1: '10 Example Road' }), issues: expect.arrayContaining(['ADDRESS_FC_CONFLICT']), hasFormula: false }),
      expect.objectContaining({ sourceRow: 3, values: expect.objectContaining({ destinationFc: 'SPECIAL1', addressCode: 'SPECIAL-B', addressLine1: '20 Other Road' }), issues: expect.arrayContaining(['ADDRESS_FC_CONFLICT']), hasFormula: false }),
    ]);
    expect(catalog!.rows[2]).toMatchObject({ sourceRow: 4, values: { addressCode: '' }, issues: expect.arrayContaining(['FORMULA_SOURCE_ONLY']), hasFormula: true });
    expect(catalog!.rows[3]!.issues).toContain('ADDRESS_REQUIRED:city');
  });
  it('rechecks the original hash on every call even after a successful cached parse', async () => {
    const input = await fixture(); await expect(loadDocumentAddressCodeCatalog(input.env)).resolves.not.toBeNull();
    await writeFile(input.file, Buffer.concat([input.bytes, Buffer.from('changed')]));
    await expect(loadDocumentAddressCodeCatalog(input.env)).rejects.toThrow('锁定哈希');
  });
  it('accepts uppercase hashes and keeps cached evidence isolated from caller mutations', async () => {
    const input = await fixture(), first = await loadDocumentAddressCodeCatalog({ ...input.env, DOCUMENT_ADDRESS_CODE_CATALOG_SHA256: input.env.DOCUMENT_ADDRESS_CODE_CATALOG_SHA256.toUpperCase() });
    first!.rows[0]!.values.addressCode = 'MUTATED'; first!.rows[0]!.issues.push('MUTATED');
    const again = await loadDocumentAddressCodeCatalog(input.env);
    expect(again!.rows[0]).toMatchObject({ values: { addressCode: 'SPECIAL-A' }, issues: [] });
  });
  it('fails explicitly for unreadable, mismatched or malformed originals', async () => {
    const input = await fixture();
    await expect(loadDocumentAddressCodeCatalog({ ...input.env, DOCUMENT_ADDRESS_CODE_CATALOG_FILE: `${input.file}-missing` })).rejects.toThrow('无法读取');
    await expect(loadDocumentAddressCodeCatalog({ ...input.env, DOCUMENT_ADDRESS_CODE_CATALOG_SHA256: '0'.repeat(64) })).rejects.toThrow('锁定哈希');
    const bytes = Buffer.from('not an XLSX original'); await writeFile(input.file, bytes);
    await expect(loadDocumentAddressCodeCatalog({ ...input.env, DOCUMENT_ADDRESS_CODE_CATALOG_SHA256: digest(bytes) })).rejects.toThrow('无法解析');
  });
});
