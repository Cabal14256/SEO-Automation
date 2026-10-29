import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { createFbaRowFill } from './xlsx-fba-fill.js';

describe('FBA row fills', () => {
  it('keeps repeated shipment identities consistent, skips missing FBAs and distinguishes large exports', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('货件'), fillFba = createFbaRowFill();
    sheet.addRow(['FBA', '数量', '备注']);
    for (let index = 0; index < 300; index++) {
      const row = sheet.addRow([`FBA${index}`, 12.5, null]);
      row.getCell(2).numFmt = '0.00'; row.getCell(2).border = { bottom: { style: 'thin' } };
      fillFba(row, `FBA${index}`, 3);
    }
    const repeated = sheet.addRow([' fba0 ', 2, null]); fillFba(repeated, ' fba0 ', 3);
    const missing = sheet.addRow([null, 3, null]); fillFba(missing, '  ', 3);
    const readback = new ExcelJS.Workbook(); await readback.xlsx.load(await book.xlsx.writeBuffer());
    const written = readback.worksheets[0]!, colors = new Set<string>();
    for (let row = 2; row <= 301; row++) {
      const fill = written.getCell(row, 1).fill as ExcelJS.FillPattern;
      expect(fill).toMatchObject({ type: 'pattern', pattern: 'solid' }); colors.add(fill.fgColor!.argb!);
      expect(written.getCell(row, 3).fill).toEqual(fill);
      expect(written.getCell(row, 2).numFmt).toBe('0.00'); expect(written.getCell(row, 2).border.bottom?.style).toBe('thin');
    }
    expect(colors.size).toBe(300); expect(written.getCell('A302').fill).toEqual(written.getCell('A2').fill);
    expect(written.getCell('A1').fill?.type).not.toBe('pattern'); expect(written.getCell('A303').fill?.type).not.toBe('pattern');
  });
});
