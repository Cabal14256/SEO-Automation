import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseReferenceWorkbook, REFERENCE_WORKBOOK_PARSER_VERSION } from './reference-workbook.js';

const headers = ['地址简称*', '地址编码*', 'FBA仓库代码', '联系人*', '公司名', '联系电话', '联系手机', '地址一*', '地址二', '地址三', '城市*', '省/洲', '国家*', '邮编*'];
const address = (fc: string, code = fc): ExcelJS.CellValue[] => ['示例地址', code, fc, '测试收件人', '示例收件公司', '5550001', '5550002', '10 Example Road', '', '', 'Example City', 'CA', 'US', '00123'];
async function fixture(edit?: (book: ExcelJS.Workbook) => void) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('地址库');
  sheet.mergeCells('A1:N1'); sheet.getCell('A1').value = '测试地区地址'; sheet.addRow(headers); sheet.addRow(address('TEST1'));
  const channel = book.addWorksheet('发货渠道'); channel.addRows([['渠道名称', '板块'], ['示例服务甲', '示例板块'], ['示例服务乙', '示例板块']]);
  const customs = book.addWorksheet('报关方式'); customs.addRows([['买单报关'], ['报关退税'], ['普通报关'], ['9710'], ['9810']]);
  const transit = book.addWorksheet('预计送仓数据'); transit.addRows([['', '渠道', 'FBA仓库代码', '预计送仓时效', '区域'], [{ formula: 'B2&C2', result: '示例服务甲TEST1' }, '示例服务甲', 'TEST1', '12-15', '一区']]);
  edit?.(book); return Buffer.from(await book.xlsx.writeBuffer());
}

describe('reference workbook parsing without business inference', () => {
  it('preserves all reference catalogs, source cells and cached formulas without treating transit as a delivery date', async () => {
    const plan = await parseReferenceWorkbook(await fixture());
    expect(plan.summary).toMatchObject({ parserVersion: REFERENCE_WORKBOOK_PARSER_VERSION, addressRecordCount: 1, addressProfileCount: 1, channelRecordCount: 2, customsOptionCount: 5, transitRecordCount: 1, channelsWithoutTransitCount: 1 });
    expect(plan.datasets.map((dataset) => dataset.kind)).toEqual(['address_catalog', 'channel_catalog', 'customs_options', 'transit_reference']);
    const transit = plan.datasets.find((dataset) => dataset.kind === 'transit_reference')!;
    expect(transit.data.rows).toEqual([expect.objectContaining({ sourceRow: 2, values: { sourceLookupKey: '', channelName: '示例服务甲', destinationFc: 'TEST1', estimatedTransit: '12-15', region: '一区' }, cells: expect.arrayContaining([expect.objectContaining({ address: 'A2', value: { formula: 'B2&C2', result: '示例服务甲TEST1' }, formula: true, display: '示例服务甲TEST1' })]) })]);
    expect(plan.addresses[0]!.data).not.toHaveProperty('deliveryWindow');
    expect(plan.addresses[0]!.data).not.toHaveProperty('currency');
    expect(plan.addresses[0]!.data).not.toHaveProperty('vat');
  });

  it('merges complete address duplicates and retains every source row while excluding missing and conflicting FCs', async () => {
    const plan = await parseReferenceWorkbook(await fixture((book) => {
      const sheet = book.getWorksheet('地址库')!; sheet.addRow(address('TEST1'));
      sheet.mergeCells('A5:N5'); sheet.getCell('A5').value = '另一区域地址'; sheet.addRow(headers);
      sheet.addRow(address('TEST2', 'A2')); const conflicting = address('TEST2', 'A3'); conflicting[7] = '20 Different Road'; sheet.addRow(conflicting);
      sheet.addRow(address('', 'NO-FC'));
      book.getWorksheet('预计送仓数据')!.addRows([['', '渠道', 'FBA仓库代码', '预计送仓时效', '区域'], ['', '示例服务甲', 'UNKNOWN', '19', '二区']]);
    }));
    expect(plan.addresses).toHaveLength(1); expect(plan.addresses[0]).toMatchObject({ key: 'fengxin:address:US:TEST1:TEST1', sourceRows: [3, 4], issues: [] });
    expect(plan.summary).toMatchObject({ addressRecordCount: 5, addressUniqueRecordCount: 4, addressDuplicateRemovedCount: 1, missingFcRows: [9], transitRecordCount: 2,
      conflicts: [{ scope: 'US:TEST2', sourceRows: [7, 8], differingFields: ['addressCode', 'addressLine1'] }], unmatchedTransitFcs: [{ destinationFc: 'UNKNOWN', sourceRows: [4] }] });
    expect(plan.datasets[0]!.data.skippedRows).toEqual(expect.arrayContaining([expect.objectContaining({ sourceRow: 5, reason: 'region_title' }), expect.objectContaining({ sourceRow: 6, reason: 'header' })]));
    const sourceRows = plan.datasets[0]!.data.rows as Array<{ sourceRow: number; issues: string[] }>;
    expect(sourceRows.find((row) => row.sourceRow === 7)!.issues).toContain('ADDRESS_FC_CONFLICT');
  });

  it('preserves padded postal identifiers and telephone precedence, and produces stable keys without an address code', async () => {
    const bytes = await fixture((book) => { const sheet = book.getWorksheet('地址库')!; sheet.getCell('B3').value = null; sheet.getCell('N3').value = 123; sheet.getCell('N3').numFmt = '00000'; });
    const first = await parseReferenceWorkbook(bytes), again = await parseReferenceWorkbook(bytes);
    expect(first.addresses[0]!.data).toMatchObject({ postalCode: '00123', phone: '5550001', addressCode: '', source: { telephone: '5550001', mobile: '5550002' } });
    expect(first.addresses[0]!.key).toMatch(/^fengxin:address:US:TEST1:[a-f0-9]{16}$/); expect(again.addresses).toEqual(first.addresses);
    const rows = first.datasets[0]!.data.rows as Array<{ cells: Array<Record<string, unknown>> }>;
    expect(rows[0]!.cells[13]).toMatchObject({ address: 'N3', value: 123, type: ExcelJS.ValueType.Number, numFmt: '00000', display: '00123' });
  });

  it('does not promote cached formula addresses or infer countries, while retaining rejected rows as reference evidence', async () => {
    const plan = await parseReferenceWorkbook(await fixture((book) => {
      const sheet = book.getWorksheet('地址库')!; sheet.getCell('H3').value = { formula: '"10 Example Road"', result: '10 Example Road' };
      const unknown = address('TEST2'); unknown[12] = '示例国家'; sheet.addRow(unknown);
    }));
    expect(plan.addresses).toEqual([]);
    expect(plan.summary.invalidAddressRows).toEqual(expect.arrayContaining([
      { sourceRows: [3], issues: ['ADDRESS_REQUIRED:addressLine1', 'FORMULA_SOURCE_ONLY'] },
      { sourceRows: [4], issues: ['COUNTRY_CODE_NOT_ISO'] },
    ]));
    const rows = plan.datasets[0]!.data.rows as Array<{ cells: Array<Record<string, unknown>> }>;
    expect(rows[0]!.cells[7]).toMatchObject({ value: { formula: '"10 Example Road"', result: '10 Example Road' }, display: '10 Example Road', formula: true });
  });

  it('reports duplicate channels and unmatched transit references without synthesizing service or customs settings', async () => {
    const plan = await parseReferenceWorkbook(await fixture((book) => {
      book.getWorksheet('发货渠道')!.addRow(['示例服务甲', '另一个板块']);
      book.getWorksheet('报关方式')!.addRow(['未确认方式']);
      book.getWorksheet('预计送仓数据')!.addRow(['', '未知服务', 'TEST1', '待确认', '三区']);
    }));
    expect(plan.summary.duplicateChannels).toEqual([{ name: '示例服务甲', sourceRows: [2, 4] }]);
    expect(plan.summary.unmatchedTransitChannels).toEqual([{ sourceRow: 3, channelName: '未知服务' }]);
    const customs = plan.datasets.find((dataset) => dataset.kind === 'customs_options')!.data.rows as Array<{ issues: string[] }>;
    expect(customs.at(-1)!.issues).toEqual(['UNKNOWN_CUSTOMS_OPTION']);
    expect(plan.addresses[0]!.data).not.toHaveProperty('customsMode');
  });

  it('rejects wrong layouts and non-XLSX bytes instead of returning partial import success', async () => {
    await expect(parseReferenceWorkbook(await fixture((book) => { book.getWorksheet('地址库')!.getCell('C2').value = '未知列'; }))).rejects.toThrow('表头不匹配');
    await expect(parseReferenceWorkbook(Buffer.from('not a workbook'))).rejects.toThrow();
  });
});
