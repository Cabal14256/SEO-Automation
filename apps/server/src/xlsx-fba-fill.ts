import type ExcelJS from 'exceljs';

const palette = ['FFE3EFFA', 'FFE7F2DF', 'FFFFEBD6', 'FFECE4F6', 'FFDDF2EE', 'FFFFE2EA', 'FFFFF3CC', 'FFE3E8F2'];
const key = (fba: string | null | undefined) => fba?.trim().toUpperCase() ?? '';

function color(index: number): string {
  if (index < palette.length) return palette[index]!;
  // Keep assigning distinct pale colors when an export contains more shipments
  // than the basic palette, rather than cycling unrelated FBAs to the same fill.
  // An odd stride traverses all 64^3 RGB combinations; every channel stays
  // between 192 and 255 so black body text remains readable.
  const value = (index - palette.length) * 46349 % 0x40000;
  return `FF${[12, 6, 0].map((shift) => (192 + (value >> shift & 63)).toString(16)).join('').toUpperCase()}`;
}

/** One registry per workbook keeps the same FBA consistent across its sheets. */
export function createFbaRowFill(fbas: Iterable<string> = []) {
  const colors = new Map<string, string>(), used = new Set<string>();
  let next = 0;
  const resolve = (fba: string | null | undefined) => {
    const normalized = key(fba);
    if (!normalized) return undefined;
    let value = colors.get(normalized);
    if (!value) {
      if (colors.size >= 65_000) throw new Error('FBA 货件数量超过 XLSX 可安全区分的样式数量，请拆分导出。');
      do { value = color(next++); } while (used.has(value));
      colors.set(normalized, value); used.add(value);
    }
    return value;
  };
  for (const fba of fbas) resolve(fba);
  return (row: ExcelJS.Row, fba: string | null | undefined, columns: number) => {
    const argb = resolve(fba);
    if (!argb) return;
    for (let column = 1; column <= columns; column++) row.getCell(column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  };
}
