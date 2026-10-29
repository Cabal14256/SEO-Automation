import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { DocumentProfile } from '@scm/contracts';
import { createProfileImportTemplate, parseProfileImport, PROFILE_IMPORT_FIELDS } from './profile-import.js';

async function workbook(rows: unknown[][]) {
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await createProfileImportTemplate() as never);
  for (const row of rows) book.worksheets[0]!.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}
describe('single-purpose profile XLSX preflight', () => {
  it('preserves complete product identities and reports exact changed fields against a version', async () => {
    const profile: DocumentProfile = { id: '00000000-0000-4000-8000-000000000001', category: 'product', key: 'prod1', version: 2, status: 'active', data: { sid: '12', msku: 'M', fnsku: 'F', sku: 'S', englishName: 'Old' }, createdAt: '2026-10-19T00:00:00Z', createdBy: 'admin' };
    const rows = await parseProfileImport(await workbook([['product', 'prod1', 2, 12, 'M', 'F', 'S', 'New']]), [profile]);
    expect(rows[0]).toMatchObject({ row: 2, category: 'product', key: 'prod1', expectedVersion: 2, data: { sid: '12', msku: 'M', fnsku: 'F', sku: 'S', englishName: 'New' }, errors: [], changes: ['englishName'] });
  });
  it('reports all duplicate, version and formula errors rather than silently merging records', async () => {
    const bytes = await workbook([['product', 'same', '', 12, { formula: '1+1' }], ['product', 'same', 3, 12, 'M'], ['unknown', '', 'bad']]);
    const rows = await parseProfileImport(bytes);
    expect(rows).toHaveLength(3); expect(rows[0]!.errors.join()).toContain('不接受公式'); expect(rows[1]!.errors.join()).toContain('重复'); expect(rows[1]!.errors.join()).toContain('预期版本'); expect(rows[2]!.errors.length).toBeGreaterThan(1);
  });
  it('keeps channel and party imports while rejecting deprecated local address imports', async () => {
    const row = (category: string, key: string, data: Record<string, string>) => [category, key, '', ...PROFILE_IMPORT_FIELDS.map((field) => data[field] ?? '')];
    const data = [
      { category: 'channel', key: 'hy-service', fields: { sid: '12', businessChannel: 'HY', channel: 'HY', country: '美国', service: 'Confirmed service' } },
      { category: 'address', key: 'ont8-address', fields: { destinationFc: 'ONT8', fc: 'ONT8', addressCode: 'ONT8', country: '美国', countryCode: 'US', recipientName: 'Receiver', addressLine1: '10 Road', city: 'City', postalCode: '12345' } },
      { category: 'party', key: 'shop-12', fields: { sid: '12', companyName: 'Confirmed Company', taxNumber: 'TAX-12', address: 'Sender address', contact: 'Operator' } },
    ];
    const rows = await parseProfileImport(await workbook(data.map((entry) => row(entry.category, entry.key, entry.fields))));
    expect(rows).toHaveLength(3);
    data.forEach((entry, index) => { expect(rows[index]).toMatchObject({ category: entry.category, key: entry.key, data: entry.fields, errors: entry.category === 'address' ? [expect.stringContaining('领星')] : [] }); expect(rows[index]!.changes).toEqual(expect.arrayContaining(Object.keys(entry.fields))); });
  });
});
