import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { inspectWorkbook, parseImportWorkbook, parseWorkbook } from './parser.js';
import { buildImportTemplate, IMPORT_TEMPLATE_SHEET_NAME } from './template.js';

async function editTemplate(values: ExcelJS.CellValue[]) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildImportTemplate() as unknown as ExcelJS.Buffer);
  workbook.getWorksheet(IMPORT_TEMPLATE_SHEET_NAME)!.getRow(2).values = values;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('downloadable demand import template', () => {
  it('ships one recognizable input sheet with blank data and a separate non-import instruction sheet', async () => {
    const bytes = await buildImportTemplate();
    const inspection = inspectWorkbook(bytes);
    expect(inspection.sheets.map((sheet) => sheet.name)).toEqual([IMPORT_TEMPLATE_SHEET_NAME, '填写说明']);
    const input = inspection.sheets[0]!;
    expect(input.headers.map((header) => header.value)).toEqual(['店铺', '渠道', '国家', '目的FC', 'FBA货件号', '参考数量', '来源填写时间', '子批次名称', '备注', '仓库地址', '货件创建时间', '元数据来源', '查询时间']);
    expect(input.hiddenColumns).toEqual([6, 12, 13]); expect(input.mergedRanges).toEqual([]);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet(IMPORT_TEMPLATE_SHEET_NAME)!;
    const filled: string[] = [];
    sheet.eachRow((row, number) => { if (number > 1) row.eachCell((cell) => { if (cell.value !== null) filled.push(cell.address); }); });
    expect(filled).toEqual([]);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(workbook.getWorksheet('填写说明')!.getCell('C22').text).toContain('先填写至少一行');
    expect(workbook.getWorksheet('填写说明')!.getColumn(1).values).not.toContain('参考数量');
    const members = unzipSync(bytes);
    expect(Object.keys(members).some((path) => /externalLinks|vbaProject|macrosheets/i.test(path))).toBe(false);
    expect(Object.entries(members).filter(([path]) => path.endsWith('.rels')).some(([, xml]) => strFromU8(xml).includes('TargetMode="External"'))).toBe(false);
    workbook.eachSheet((worksheet) => worksheet.eachRow((row) => row.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula))));
  });

  it('preserves legacy hidden quantity values alongside dates and metadata for source review', async () => {
    const bytes = await editTemplate(['模板技术店', 'HY', '美国', 'ONT8', 'fbatemplate001', 0, new Date('2026-10-18T07:08:09Z'), '来源标签', '=1+1', 'TECHNICAL ONLY destination address', new Date('2026-10-16T02:03:04Z')]);
    const discovered = parseImportWorkbook(bytes);
    expect(discovered).toMatchObject({ sheetName: IMPORT_TEMPLATE_SHEET_NAME, mappingVersion: 'online-v1', status: 'preview_ready', counts: { totalRows: 1, validFbaRows: 1, errorRows: 0 } });
    const seller = { id: randomUUID(), name: '模板技术店', sid: 101, country: '美国', version: 1, status: 'approved', aliases: [] };
    const parsed = parseWorkbook(bytes, { sheetName: IMPORT_TEMPLATE_SHEET_NAME, mappingVersion: 'online-v1', parseRunId: randomUUID(), sellers: [seller] });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ rowNumber: 2, status: 'needs_review', issues: [expect.objectContaining({ code: 'HIDDEN_MAPPED_COLUMN', column: 'F' })], normalized: {
      shop: '模板技术店', sid: 101, fba: 'FBATEMPLATE001', channel: 'HY', country: '美国', destinationFc: 'ONT8',
      referenceQuantity: '0', sourceFilledAt: '2026-10-18T07:08:09Z', shipmentCreatedAt: '2026-10-16T02:03:04Z',
      subBatchName: '来源标签', notes: '=1+1', destinationAddress: 'TECHNICAL ONLY destination address',
    } });
    expect(parsed.rows[0]!.rawCells.find((cell) => cell.column === 'G')).toMatchObject({ type: 'n', formula: null });
    expect(parsed.rows[0]!.rawCells.find((cell) => cell.column === 'I')).toMatchObject({ value: '=1+1', formula: null });
    expect(parsed.rows[0]!.normalized.metadataSource ?? null).toBeNull();
    expect(parsed.rows[0]!.normalized.metadataObservedAt ?? null).toBeNull();
  });

  it('keeps optional quantity and dates missing when only the required shipment identity is filled', async () => {
    const bytes = await editTemplate(['模板技术店', null, null, null, 'FBATEMPLATE002']);
    const result = parseImportWorkbook(bytes);
    expect(result).toMatchObject({ status: 'preview_ready', mappingVersion: 'online-v1', counts: { totalRows: 1, errorRows: 0 } });
    const row = result.rows[0]!;
    expect(row.normalized.referenceQuantity).toBeNull();
    expect(row.normalized.sourceFilledAt ?? null).toBeNull(); expect(row.normalized.shipmentCreatedAt ?? null).toBeNull();
    expect(row.normalized.destinationAddress ?? null).toBeNull();
    expect(row.issues.some((issue) => issue.code === 'HIDDEN_MAPPED_COLUMN')).toBe(false);
  });

  it('returns stable standalone bytes on repeated downloads without sharing a mutable buffer', async () => {
    const first = await buildImportTemplate(); const second = await buildImportTemplate();
    expect(first.equals(second)).toBe(true); first[0] = 0;
    expect(inspectWorkbook(second).sheets[0]!.name).toBe(IMPORT_TEMPLATE_SHEET_NAME);
  });
});
