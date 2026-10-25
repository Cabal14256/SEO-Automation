import { randomUUID } from 'node:crypto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importRowSchema, importSheetSchema } from '@scm/contracts';
import { inspectWorkbook, parseImportWorkbook, parseWorkbook, shanghaiImportDates, validateImportWorkbook } from './parser.js';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const inline = (address: string, text: string) => `<c r="${address}" t="inlineStr"><is><t>${escape(text)}</t></is></c>`;
const headers = ['店铺', '渠道', '国家', '目的FC', 'FBA货件号', '参考数量', '业务日期', '子批次名称', '备注'];
function workbook(rows: string, options: { sheetName?: string; header?: string; beforeRows?: string; merges?: string; date1904?: boolean; extra?: Record<string, Uint8Array>; styles?: string } = {}) {
  const name = options.sheetName ?? '需求导入';
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${options.date1904 ? 1 : 0}"/><sheets><sheet name="${escape(name)}" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${options.beforeRows ?? ''}<sheetData><row r="1">${options.header ?? headers.map((header, index) => inline(`${String.fromCharCode(65 + index)}1`, header)).join('')}</row>${rows}</sheetData>${options.merges ?? ''}</worksheet>`),
    ...(options.styles ? { 'xl/styles.xml': strToU8(options.styles) } : {}), ...options.extra,
  });
}
const parse = (bytes: Uint8Array, options: Parameters<typeof parseWorkbook>[1] = { parseRunId: randomUUID(), sheetName: '需求导入', mappingVersion: 'manual-v1' }) => parseWorkbook(bytes, options);
const seller = { id: randomUUID(), sid: 1, country: '美国', version: 2, status: 'approved', aliases: ['Shop-US'] };
const row = (number: number, fba: string, shop = 'Shop-US', country = '美国') => `<row r="${number}">${inline(`A${number}`, shop)}${inline(`C${number}`, country)}${inline(`E${number}`, fba)}</row>`;
function multipleSheets(inputs: Array<{ name: string; rows?: string; header?: string; state?: string }>) {
  const entries = unzipSync(workbook(''));
  entries['xl/workbook.xml'] = strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${inputs.map((sheet, index) => `<sheet name="${escape(sheet.name)}" state="${sheet.state ?? 'visible'}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`);
  entries['xl/_rels/workbook.xml.rels'] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inputs.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>`).join('')}</Relationships>`);
  inputs.forEach((sheet, index) => { entries[`xl/worksheets/sheet${index + 1}.xml`] = unzipSync(workbook(sheet.rows ?? '', { header: sheet.header }))['xl/worksheets/sheet1.xml']!; });
  return zipSync(entries);
}

describe('XLSX import preview parser', () => {
  it('initial uploads recognize supported headers independently of worksheet names', () => {
    expect(parseImportWorkbook(workbook(row(2, 'FBA123')))).toMatchObject({ sheetName: '需求导入', mappingVersion: 'manual-v1', status: 'preview_ready' });
    expect(parseImportWorkbook(workbook(row(2, 'FBA123'), { sheetName: '原始数据' }))).toMatchObject({ sheetName: '原始数据', mappingVersion: 'manual-v1', status: 'preview_ready' });
    expect(parseImportWorkbook(workbook(row(2, 'FBA123'), { sheetName: '需求导入 ' }))).toMatchObject({ sheetName: '需求导入 ', status: 'preview_ready' });
    expect(() => parseImportWorkbook(workbook(row(2, 'FBA123'), { header: inline('A1', '无法确定的列') }))).toThrow('未找到支持的需求表头');
  });
  it('requests an explicit choice for multiple supported data sheets without preferring familiar names', () => {
    const bytes = multipleSheets([{ name: '需求导入', rows: row(2, 'FBAFIRST') }, { name: '在线需求导入', rows: row(2, 'FBASECOND') }]);
    expect(validateImportWorkbook(bytes)).toMatchObject({ selection: null, candidates: [{ sheetName: '需求导入', mappingVersion: 'manual-v1' }, { sheetName: '在线需求导入', mappingVersion: 'manual-v1' }] });
    expect(parseImportWorkbook(bytes)).toMatchObject({ sheetName: null, mappingVersion: null, status: 'awaiting_mapping', rows: [], issues: [{ code: 'SOURCE_MAPPING_REQUIRED' }] });
    expect(parseImportWorkbook(bytes, { sheetName: '在线需求导入', mappingVersion: 'manual-v1' }).rows[0]!.normalized.fba).toBe('FBASECOND');
    expect(() => parseImportWorkbook(bytes, { sheetName: '在线需求导入', mappingVersion: 'online-v1' })).toThrow('表头与映射版本不符');
  });
  it('does not automatically choose hidden input and permits an explicit reviewed hidden sheet', () => {
    const bytes = multipleSheets([{ name: '隐藏需求', rows: row(2, 'FBAHIDDEN'), state: 'hidden' }]);
    expect(validateImportWorkbook(bytes)).toMatchObject({ selection: null, candidates: [{ sheetName: '隐藏需求', mappingVersion: 'manual-v1' }] });
    const parsed = parseImportWorkbook(bytes, { sheetName: '隐藏需求', mappingVersion: 'manual-v1' });
    expect(parsed.status).toBe('preview_ready'); expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'HIDDEN_WORKSHEET' }));
  });
  it('ignores empty supported templates when one nonempty input sheet is available', () => {
    expect(validateImportWorkbook(multipleSheets([{ name: '模板' }, { name: '已填写', rows: row(2, 'FBAFILLED') }]))).toMatchObject({ selection: { sheetName: '已填写', mappingVersion: 'manual-v1' } });
  });
  it.each(['', `<row r="2">${inline('A2', '  ')}</row>`, `<row r="2">${inline('Z2', '仅在非输入列填写')}</row>`])('rejects header-only or business-empty input before parsing', (rows) => {
    expect(() => validateImportWorkbook(workbook(rows))).toThrow('请先填写至少一行需求');
  });
  it('does not treat metadata-only online rows as a demand or reject an erroneous nonempty business row', () => {
    const onlineHeaders = [...headers.slice(0, 6), '来源填写时间', '子批次名称', '备注', '仓库地址', '货件创建时间', '元数据来源', '查询时间'].map((header, index) => inline(`${String.fromCharCode(65 + index)}1`, header)).join('');
    expect(() => validateImportWorkbook(workbook(`<row r="2">${inline('L2', 'online')}</row>`, { header: onlineHeaders }))).toThrow('请先填写至少一行需求');
    const parsed = parseImportWorkbook(workbook(row(2, 'FBAOK') + row(3, '不是FBA')));
    expect(parsed).toMatchObject({ status: 'preview_ready', counts: { totalRows: 2, validFbaRows: 1, errorRows: 1 } });
    expect(validateImportWorkbook(workbook('<row r="2"><c r="F2"><v>0</v></c></row>')).selection).not.toBeNull();
  });
  it('enforces selected input limits without applying input column limits to unrelated sheets', () => {
    expect(() => validateImportWorkbook(workbook(row(10001, 'FBAOVER')))).toThrow('10000 行');
    expect(() => validateImportWorkbook(workbook(`<row r="2">${inline('A2', 'Shop-US')}${inline('IW2', '超出256列')}</row>`))).toThrow('256 列');
    expect(validateImportWorkbook(multipleSheets([{ name: '需求导入', rows: row(2, 'FBAOK') }, { name: '说明', header: inline('A1', '填写说明'), rows: `<row r="2">${inline('IW2', '非输入页')}</row>` }])).selection).toMatchObject({ sheetName: '需求导入' });
  });
  it('discovers exact sheet names and retains hidden, merged and raw typed cell facts', () => {
    const bytes = workbook(`<row r="2" hidden="1">${inline('A2', 'Shop-US')}${inline('E2', ' fba000001 ')}<c r="F2"><v>0</v></c><c r="G2" s="1"><v>61</v></c>${inline('I2', '  原始备注 & 文本  ')}</row>`, {
      sheetName: '需求导入 ', beforeRows: '<cols><col min="6" max="6" hidden="1"/></cols>', merges: '<mergeCells><mergeCell ref="A2:A3"/></mergeCells>',
      styles: '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    });
    const inspected = inspectWorkbook(bytes);
    expect(inspected.sheets[0]).toMatchObject({ name: '需求导入 ', rowCount: 2, columnCount: 9, hiddenColumns: [6], mergedRanges: ['A2:A3'] });
    expect(importSheetSchema.safeParse(inspected.sheets[0]).success).toBe(true);
    const result = parse(bytes, { parseRunId: randomUUID(), sheetName: '需求导入 ', mappingVersion: 'manual-v1', sellers: [seller] });
    const parsed = result.rows[0]!;
    expect(importRowSchema.safeParse(parsed).success).toBe(true);
    expect(parsed.normalized).toMatchObject({ fba: 'FBA000001', referenceQuantity: '0', sourceDate: '1900-03-01', notes: '原始备注 & 文本', sid: 1, sellerMappingVersion: 2 });
    expect(parsed.rawCells.find((cell) => cell.address === 'I2')?.value).toBe('  原始备注 & 文本  ');
    expect(parsed.rawCells.find((cell) => cell.address === 'G2')).toMatchObject({ type: 'n', rawValue: '61', value: 61, numberFormat: 'mm-dd-yy', formulaCache: 'not_formula' });
    expect(parsed.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['HIDDEN_MAPPED_COLUMN', 'HIDDEN_SOURCE_ROW', 'MERGED_MAPPED_CELL']));
  });

  it('preserves formula, cache state and source error without using formula text as an identifier', () => {
    const bytes = workbook(`<row r="2">${inline('A2', 'Shop-US')}<c r="E2" t="str"><f>"FBA001"</f></c><c r="F2"><f>SUM(1,2)</f><v/></c><c r="G2" t="str"><f>"2026-01-01"</f><v>2026-01-01</v></c><c r="I2" t="e"><v>#REF!</v></c></row>`);
    const parsed = parse(bytes).rows[0]!;
    expect(parsed.normalized.fba).toBeNull();
    expect(parsed.normalized.referenceQuantity).toBeNull();
    expect(parsed.normalized.sourceDate).toBe('2026-01-01');
    expect(parsed.rawCells.find((cell) => cell.column === 'E')).toMatchObject({ formula: '"FBA001"', formulaCache: 'absent' });
    expect(parsed.rawCells.find((cell) => cell.column === 'F')).toMatchObject({ formula: 'SUM(1,2)', formulaCache: 'empty' });
    expect(parsed.status).toBe('error');
    expect(parsed.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['FORMULA_CACHE_MISSING', 'FBA_REQUIRED', 'SOURCE_CELL_ERROR']));
  });

  it('keeps duplicate FBA rows and requires an approved exact seller name or alias', () => {
    const bytes = workbook(row(2, 'FBA0001') + row(3, 'FBA0001'));
    const result = parse(bytes, { parseRunId: randomUUID(), sheetName: '需求导入', mappingVersion: 'manual-v1', sellers: [{ ...seller, status: 'candidate' }] });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((item) => item.normalized.sid === null)).toBe(true);
    expect(result.rows.every((item) => item.issues.some((issue) => issue.code === 'DUPLICATE_SHIPMENT'))).toBe(true);
    expect(result.counts).toEqual({ totalRows: 2, validFbaRows: 2, errorRows: 0, warningRows: 2 });
  });

  it('resolves the normalized official name of a zero-alias approved seller', () => {
    const result = parse(workbook(row(2, 'FBA123', ' Ｓｈｏｐ-ＵＳ ')), { parseRunId: randomUUID(), sheetName: '需求导入', mappingVersion: 'manual-v1',
      sellers: [{ ...seller, name: 'Shop-US', aliases: [] }] });
    expect(result.rows[0]).toMatchObject({ status: 'valid', normalized: { sellerMappingId: seller.id, sid: 1, sellerMappingVersion: 2 }, issues: [] });
  });

  it('continues to resolve an optional source alias in addition to the official name', () => {
    const result = parse(workbook(row(2, 'FBA123')), { parseRunId: randomUUID(), sheetName: '需求导入', mappingVersion: 'manual-v1',
      sellers: [{ ...seller, name: '正式名称' }] });
    expect(result.rows[0]).toMatchObject({ status: 'valid', normalized: { sid: 1 }, issues: [] });
  });

  it.each(['candidate', 'disabled'])('keeps a %s official-name match unconfirmed', (status) => {
    const result = parse(workbook(row(2, 'FBA123')), { parseRunId: randomUUID(), sheetName: '需求导入', mappingVersion: 'manual-v1',
      sellers: [{ ...seller, name: 'Shop-US', status, aliases: [] }] });
    expect(result.rows[0]).toMatchObject({ status: 'needs_review', normalized: { sellerMappingId: null, sid: null, sellerMappingVersion: null } });
    expect(result.rows[0]!.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_MAPPING_REQUIRED', severity: 'warning',
      message: '来源店铺名称未匹配已批准店铺；请在本次导入中确认店铺。', address: 'A2' }));
  });

  it.each(['official name', 'optional alias'])('retains ambiguity when another seller matches by %s', (kind) => {
    const second = { ...seller, id: randomUUID(), sid: 2, country: '加拿大', name: kind === 'official name' ? 'Shop-US' : '另一正式名称',
      aliases: kind === 'optional alias' ? ['Shop-US'] : [] };
    const result = parse(workbook(row(2, 'FBA123')), { parseRunId: randomUUID(), sheetName: '需求导入', mappingVersion: 'manual-v1',
      sellers: [{ ...seller, name: 'Shop-US', aliases: [] }, second] });
    expect(result.rows[0]).toMatchObject({ status: 'needs_review', normalized: { sellerMappingId: null, sid: null, sellerMappingVersion: null } });
    expect(result.rows[0]!.issues).toContainEqual(expect.objectContaining({ code: 'SELLER_ALIAS_CONFLICT', severity: 'warning',
      message: '来源店铺名称对应多个已批准店铺，请人工确认。', address: 'A2' }));
  });

  it('does not treat repeated records of the same seller as different identities', () => {
    const named = { ...seller, name: 'Shop-US' };
    const result = parse(workbook(row(2, 'FBA123')), { parseRunId: randomUUID(), sheetName: '需求导入', mappingVersion: 'manual-v1', sellers: [named, named] });
    expect(result.rows[0]).toMatchObject({ status: 'valid', normalized: { sid: 1 }, issues: [] });
  });

  it('retains the existing country mismatch warning for a unique official-name match', () => {
    const result = parse(workbook(row(2, 'FBA123', 'Shop-US', '加拿大')), { parseRunId: randomUUID(), sheetName: '需求导入', mappingVersion: 'manual-v1',
      sellers: [{ ...seller, name: 'Shop-US', aliases: [] }] });
    expect(result.rows[0]).toMatchObject({ status: 'needs_review', normalized: { sid: 1 } });
    expect(result.rows[0]!.issues).toContainEqual(expect.objectContaining({ code: 'SELLER_COUNTRY_MISMATCH', severity: 'warning', address: 'C2' }));
  });

  it('preserves exact large numeric quantity text and exposes the precision limit', () => {
    const bytes = workbook(`<row r="2">${inline('A2', 'Shop-US')}${inline('E2', 'FBA123')}<c r="F2"><v>9007199254740993</v></c></row>`);
    const parsed = parse(bytes).rows[0]!;
    expect(parsed.normalized.referenceQuantity).toBe('9007199254740993');
    expect(parsed.rawCells.find((cell) => cell.column === 'F')?.rawValue).toBe('9007199254740993');
    expect(parsed.issues.map((item) => item.code)).toContain('UNSAFE_NUMERIC_QUANTITY');
    expect(parsed.status).toBe('error');
  });

  it('rejects output sheets whose positions do not match the selected input mapping', () => {
    const bytes = workbook(row(2, 'FBA0001'), { header: inline('B1', '店铺') + inline('F1', 'FBA货件号') });
    expect(() => parse(bytes)).toThrow('工作表表头与映射版本不符');
  });

  it('uses the explicit Feishu column map and keeps G as an unconfirmed reference', () => {
    const header = ['发货计划编号', '店铺', '渠道', 'fx国家', '仓库地址', 'FBA货件号', '追踪编码', '#数量', '完成发货', 'A:备注', '填写日期'].map((item, index) => inline(`${String.fromCharCode(65 + index)}1`, item)).join('');
    const bytes = workbook(`<row r="2">${inline('B2', 'Shop-US')}${inline('D2', '美国')}${inline('F2', 'fba123')}<c r="G2"><v>30</v></c><c r="H2"><v>99</v></c><c r="J2"><v>46000</v></c>${inline('K2', '人员文本')}</row>`, { header, sheetName: '飞书表格' });
    const result = parse(bytes, { parseRunId: randomUUID(), sheetName: '飞书表格', mappingVersion: 'feishu-v1', sellers: [seller] });
    expect(result.rows[0]?.normalized).toMatchObject({ fba: 'FBA123', referenceQuantity: '30', sourceRecordId: null });
    expect(result.rows[0]?.rawCells.find((cell) => cell.column === 'K')?.value).toBe('人员文本');
    expect(result.issues.map((item) => item.code)).toContain('REFERENCE_QUANTITY_UNCONFIRMED');
  });

  it('retains shared rich strings, numeric identifiers and the 1904 date system', () => {
    const bytes = workbook('<row r="2"><c r="A2" t="s"><v>0</v></c><c r="E2" t="n"><v>00123</v></c><c r="G2"><v>0</v></c></row>', {
      date1904: true, extra: { 'xl/sharedStrings.xml': strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Shop</t></r><r><t>-US</t></r></si></sst>') },
    });
    const parsed = parse(bytes).rows[0]!;
    expect(parsed.normalized).toMatchObject({ shop: 'Shop-US', fba: '00123', sourceDate: '1904-01-01' });
    expect(parsed.rawCells.find((cell) => cell.column === 'E')?.rawValue).toBe('00123');
    expect(parsed.issues.map((item) => item.code)).toContain('NUMERIC_IDENTIFIER');
  });

  it('rejects malformed ZIP, unsafe paths, DTD, mismatched row addresses and invalid shared strings', () => {
    expect(() => inspectWorkbook(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => inspectWorkbook(workbook('', { extra: { '../unsafe.xml': strToU8('<a/>') } }))).toThrow();
    expect(() => inspectWorkbook(workbook('', { extra: { 'xl/workbook.xml': strToU8('<!DOCTYPE x [<!ENTITY test "x">]><workbook/>') } }))).toThrow();
    expect(() => parse(workbook(`<row r="2">${inline('A3', 'Shop-US')}</row>`))).toThrow();
    expect(() => parse(workbook('<row r="2"><c r="A2" t="s"><v>999</v></c></row>'))).toThrow();
  });

  it('ignores external relationships and rejects macro enabled packages', () => {
    const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="https://example.invalid/private" TargetMode="External"/></Relationships>';
    const result = parse(workbook(row(2, 'FBA123'), { extra: { 'xl/_rels/workbook.xml.rels': strToU8(rels) } }));
    expect(result.issues[0]?.code).toBe('EXTERNAL_RELATIONSHIP_IGNORED');
    const bytes = workbook('', { extra: { '[Content_Types].xml': strToU8('<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>') } });
    expect(() => inspectWorkbook(bytes)).toThrow('只支持不含宏');
  });
});

describe('shipment ticket boundaries', () => {
  it('numbers only business rows, folding consecutive explicit, missing and whitespace-only separators', () => {
    const bytes = workbook(`<row r="2">${inline('A2', '   ')}</row>` + row(3, 'FBAFIRST') + row(4, 'FBASECOND')
      + '<row r="5"/>' + `<row r="6">${inline('I6', ' \t ')}</row>` + row(8, 'FBATHIRD') + row(10, 'FBAFOURTH') + '<row r="11"/>');
    const result = parse(bytes);
    expect(result.rows.map((item) => [item.rowNumber, item.normalized.sourceTicketIndex, item.normalized.sourceMemberIndex])).toEqual([
      [3, 1, 1], [4, 1, 2], [8, 2, 3], [10, 3, 4],
    ]);
    expect(result.counts.totalRows).toBe(4);
    expect(result.rows.every((item) => item.normalized.subBatchName === null && importRowSchema.safeParse(item).success)).toBe(true);
  });

  it('preserves malformed populated rows as members without silently changing ticket boundaries', () => {
    const bytes = workbook(row(2, 'FBAFIRST') + `<row r="3">${inline('I3', '只有备注，需要核对')}</row>` + row(4, 'FBASECOND'));
    const result = parse(bytes);
    expect(result.rows.map((item) => [item.normalized.sourceTicketIndex, item.normalized.sourceMemberIndex])).toEqual([[1, 1], [1, 2], [1, 3]]);
    expect(result.rows[1]).toMatchObject({ status: 'error', issues: expect.arrayContaining([expect.objectContaining({ code: 'FBA_REQUIRED' })]) });
  });

  it('ignores metadata-only rows as separators and preserves source labels separately from ticket positions', () => {
    const onlineHeaders = [...headers.slice(0, 6), '来源填写时间', '子批次名称', '备注', '仓库地址', '货件创建时间', '元数据来源', '查询时间'].map((header, index) => inline(`${String.fromCharCode(65 + index)}1`, header)).join('');
    const bytes = workbook(row(2, 'FBAFIRST') + `<row r="3">${inline('L3', 'online')}${inline('M3', '2026-10-23')}</row>`
      + `<row r="4">${inline('A4', 'Shop-US')}${inline('E4', 'FBASECOND')}${inline('H4', '保留原标签')}</row>`, { header: onlineHeaders });
    const result = parseImportWorkbook(bytes);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]?.normalized).toMatchObject({ fba: 'FBASECOND', sourceTicketIndex: 2, sourceMemberIndex: 2, subBatchName: '保留原标签' });
  });

  it('keeps duplicate FBA evidence in separate tickets for submission validation', () => {
    const result = parse(workbook(row(2, 'FBADUPLICATE') + row(4, 'FBADUPLICATE')));
    expect(result.rows.map((item) => item.normalized.sourceTicketIndex)).toEqual([1, 2]);
    expect(result.rows.every((item) => item.issues.some((issue) => issue.code === 'DUPLICATE_SHIPMENT'))).toBe(true);
  });
});

describe('single-column FBA intake', () => {
  const listRow = (number: number, fba: string) => `<row r="${number}">${inline(`A${number}`, fba)}</row>`;

  it.each(['FBA', 'FBA货件号', 'FBA 货件号', 'FBA号'])('recognizes the %s header and defers missing shop to lookup', (header) => {
    const result = parseImportWorkbook(workbook(listRow(2, ' fba001 ') + listRow(4, 'FBA002'), { header: inline('A1', header) }));
    expect(result).toMatchObject({ mappingVersion: 'fba-list-v1', status: 'preview_ready', counts: { totalRows: 2, errorRows: 0 } });
    expect(result.rows.map((item) => [item.normalized.fba, item.normalized.sourceTicketIndex, item.normalized.sourceMemberIndex])).toEqual([
      ['FBA001', 1, 1], ['FBA002', 2, 2],
    ]);
    expect(result.rows[0]).toMatchObject({ status: 'needs_review', normalized: { shop: null, sid: null }, issues: [{ code: 'SHOP_REQUIRED', severity: 'warning' }] });
  });

  it('keeps row one as the first member in a headerless list, including a one-FBA workbook', () => {
    const one = parseImportWorkbook(workbook('', { header: inline('A1', 'FBAONLY') }));
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({ rowNumber: 1, normalized: { fba: 'FBAONLY', sourceTicketIndex: 1, sourceMemberIndex: 1 } });
    const many = parseImportWorkbook(workbook(listRow(2, 'FBASECOND') + listRow(5, 'FBATHIRD'), { header: inline('A1', 'FBAFIRST') }));
    expect(many.rows.map((item) => [item.rowNumber, item.normalized.fba, item.normalized.sourceTicketIndex])).toEqual([
      [1, 'FBAFIRST', 1], [2, 'FBASECOND', 1], [5, 'FBATHIRD', 2],
    ]);
  });

  it.each([false, true])('ignores leading blank rows with optional later header: %s', (withHeader) => {
    const bytes = workbook((withHeader ? listRow(3, 'FBA货件号') : '') + listRow(5, 'FBAFIRST') + listRow(6, 'FBASECOND'), { header: '' });
    const result = parseImportWorkbook(bytes);
    expect(result.mappingVersion).toBe('fba-list-v1');
    expect(result.rows.map((item) => [item.rowNumber, item.normalized.sourceTicketIndex, item.normalized.sourceMemberIndex])).toEqual([[5, 1, 1], [6, 1, 2]]);
  });

  it('preserves invalid members and formula-cache errors after a supported list header', () => {
    const bytes = workbook(listRow(2, 'FBAOK') + listRow(3, 'invalid FBA') + '<row r="4"><c r="A4" t="str"><f>"FBAFORMULA"</f></c></row>', { header: inline('A1', 'FBA') });
    const result = parseImportWorkbook(bytes);
    expect(result.counts).toMatchObject({ totalRows: 3, validFbaRows: 1, errorRows: 2 });
    expect(result.rows[1]?.issues).toContainEqual(expect.objectContaining({ code: 'INVALID_FBA', address: 'A3' }));
    expect(result.rows[2]?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FORMULA_CACHE_MISSING', address: 'A4' }), expect.objectContaining({ code: 'FBA_REQUIRED', address: 'A4' })]));
    expect(result.rows.map((item) => item.normalized.sourceTicketIndex)).toEqual([1, 1, 1]);
  });

  it('requires sheet selection for multiple FBA lists and does not silently merge their tickets', () => {
    const bytes = multipleSheets([{ name: 'US', header: inline('A1', 'FBAUS') }, { name: 'DE', header: inline('A1', 'FBADE') }]);
    expect(validateImportWorkbook(bytes)).toMatchObject({ selection: null, candidates: [{ sheetName: 'US', mappingVersion: 'fba-list-v1' }, { sheetName: 'DE', mappingVersion: 'fba-list-v1' }] });
    expect(parseImportWorkbook(bytes)).toMatchObject({ status: 'awaiting_mapping', rows: [] });
    expect(parseImportWorkbook(bytes, { sheetName: 'DE', mappingVersion: 'fba-list-v1' }).rows[0]?.normalized).toMatchObject({ fba: 'FBADE', sourceTicketIndex: 1 });
  });

  it('accepts formatted empty columns but rejects extra populated columns instead of dropping source content', () => {
    const valid = workbook(`${listRow(2, 'FBAFIRST')}<row r="3"><c r="B3"/></row>${listRow(4, 'FBASECOND')}`, { header: inline('A1', 'FBA') });
    expect(parseImportWorkbook(valid).rows.map((item) => item.normalized.sourceTicketIndex)).toEqual([1, 2]);
    const invalid = workbook(`<row r="2">${inline('A2', 'FBAFIRST')}${inline('B2', '不能忽略的额外内容')}</row>`, { header: inline('A1', 'FBA') });
    expect(() => parseImportWorkbook(invalid)).toThrow('未找到支持的需求表头');
    expect(() => parseImportWorkbook(invalid, { sheetName: '需求导入', mappingVersion: 'fba-list-v1' })).toThrow('仅支持单列 FBA');
    expect(() => parseImportWorkbook(workbook('', { header: inline('A1', 'FBA') }))).toThrow('请先填写至少一行需求');
  });
});

describe('Shanghai import date policy', () => {
  it('uses Shanghai day and Monday-Sunday across year boundaries', () => {
    expect(shanghaiImportDates(new Date('2026-12-31T16:00:00Z'))).toMatchObject({ businessDate: '2027-01-01', weekStartDate: '2026-12-28', weekEndDate: '2027-01-03', datePolicyVersion: 'import-date-shanghai-v1' });
    expect(shanghaiImportDates(new Date('2026-10-18T15:59:59Z'))).toMatchObject({ businessDate: '2026-10-18', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18' });
    expect(shanghaiImportDates(new Date('2026-10-18T16:00:00Z'))).toMatchObject({ businessDate: '2026-10-19', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25' });
  });
});
