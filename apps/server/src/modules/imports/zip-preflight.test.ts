import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { validateImportArchive } from './zip-preflight.js';

describe('bounded XLSX archive preflight', () => {
  it('allows ordinary XML and harmless hyperlinks without fetching them', async () => {
    const archive = Buffer.from(zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'),
      'xl/worksheets/_rels/sheet1.xml.rels': strToU8('<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.invalid/"/></Relationships>') }));
    await expect(validateImportArchive(archive)).resolves.toBeUndefined();
  });
  it('rejects an expansion with a false declared size before the workbook parser', async () => {
    const archive = Buffer.from(zipSync({ 'xl/workbook.xml': strToU8('<workbook>' + 'a'.repeat(10000) + '</workbook>') }));
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(1, central + 24);
    await expect(validateImportArchive(archive)).rejects.toMatchObject({ code: 'INVALID_XLSX' });
  });
  it('rejects DTDs, macro parts, external workbook links and excess archive entries', async () => {
    for (const entries of [
      { 'xl/workbook.xml': strToU8('<!DOCTYPE x><workbook/>') },
      { 'xl/vbaProject.bin': new Uint8Array([1]) },
      { 'xl/externalLinks/externalLink1.xml': strToU8('<x/>') },
      { 'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship TargetMode="External" Type="externalLink" Target="file:///private"/></Relationships>') },
    ]) await expect(validateImportArchive(Buffer.from(zipSync(entries)))).rejects.toBeInstanceOf(Error);
    const entries = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`entry-${index}.xml`, strToU8('<x/>')]));
    await expect(validateImportArchive(Buffer.from(zipSync(entries)))).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT_EXCEEDED' });
  });
});
