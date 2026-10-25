import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { PHYSICAL_RULE_VERSION, type PhysicalConfirmation, type PhysicalSource } from '@scm/contracts';
import { pendingEntries, physicalSourceFingerprint } from './domain.js';
import { createPhysicalTemplate, createPhysicalWorkbook, parsePhysicalTemplate, readPhysicalTemplateId, type PhysicalTemplateManifest } from './workbook.js';

function fixture(count = 12): PhysicalTemplateManifest {
  const source: PhysicalSource = { id: randomUUID(), groupId: randomUUID(), m2ConfirmationId: randomUUID(), origin: 'history', fingerprint: '', issues: [], identityValid: true, snapshotIds: [randomUUID()], createdBy: 'admin', createdAt: '2026-10-18T10:00:00.000Z',
    boxes: Array.from({ length: count }, (_, index) => ({ demandId: randomUUID(), shipmentRevisionId: randomUUID(), boxId: randomUUID(), sid: 12, fba: 'FBATEST1', code: `A${index + 1}`, order: index + 1, po: '000REF1', range: `FBATEST1000001-${count}`,
      raw: { weight: '1.005', weightUnit: 'KG', length: '2', width: '3', height: '4', dimensionUnit: 'IN' }, values: { weight: '1.01', length: '5.08', width: '7.62', height: '10.16' }, sourceObservedAt: '2026-10-18T10:00:00.000Z',
      items: [{ msku: 'MSKU', fnsku: 'FNSKU', sku: 'SKU', quantity: '2' }, { msku: 'OTHER', fnsku: 'FNSKU2', sku: 'SKU2', quantity: '1' }] })) };
  source.fingerprint = physicalSourceFingerprint(source);
  return { source, entries: pendingEntries(source), version: 2, m2ConfirmationId: source.m2ConfirmationId, templateId: randomUUID() };
}
async function load(bytes: Buffer) { const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]); return book; }
const bytes = async (book: ExcelJS.Workbook) => Buffer.from(await book.xlsx.writeBuffer());

describe('physical XLSX export', () => {
  it('writes one row per actual box and a separate product sheet without duplicated box weights', async () => {
    const manifest = fixture(), confirmation: PhysicalConfirmation = { id: randomUUID(), groupId: manifest.source.groupId, m2ConfirmationId: manifest.m2ConfirmationId, m3Version: 2, sourceFingerprint: manifest.source.fingerprint,
      snapshot: { source: manifest.source, entries: manifest.entries.map((entry) => ({ ...entry, status: 'consistent' })), ruleVersion: PHYSICAL_RULE_VERSION }, createdBy: '核对管理员', createdAt: '2026-10-18T11:00:00.000Z' };
    const book = await load(await createPhysicalWorkbook([confirmation]));
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['实物箱明细', '箱内商品', '版本与核对记录']);
    const physical = book.getWorksheet('实物箱明细')!;
    expect(physical.rowCount).toBe(13); expect(book.getWorksheet('箱内商品')!.rowCount).toBe(25); expect(book.getWorksheet('版本与核对记录')!.rowCount).toBe(2);
    expect(physical.getCell('I2').value).toBe(1.01); expect(physical.getCell('I2').numFmt).toBe('0.00'); expect(physical.getCell('D2').value).toBe('000REF1');
    expect(physical.getCell('T2').value).toBeNull();
    confirmation.snapshot.entries[0] = { ...confirmation.snapshot.entries[0]!, status: 'different', measured: { weight: '1.05' }, reason: '实测偏重' };
    const difference = (await load(await createPhysicalWorkbook([confirmation]))).getWorksheet('实物箱明细')!;
    expect(difference.getCell('T2').value).toBe(1.05); expect(difference.getCell('X2').value).toBe(0.04); expect(difference.getCell('T2').numFmt).toBe('0.00');
  });
});

describe('physical check template', () => {
  it('round trips incomplete drafts and binds the immutable server manifest', async () => {
    const manifest = fixture(); manifest.entries[0] = { ...manifest.entries[0]!, status: 'pending', measured: { weight: '2.00' }, reason: '待重新核对' };
    const template = await createPhysicalTemplate(manifest);
    expect(await readPhysicalTemplateId(template)).toBe(manifest.templateId);
    expect(await parsePhysicalTemplate(template, manifest)).toEqual(manifest.entries);
    const stored = structuredClone(manifest);
    stored.source.boxes.forEach((box) => { box.items = box.items.map((item) => Object.fromEntries(Object.entries(item).reverse()) as typeof item); });
    expect(await parsePhysicalTemplate(template, stored)).toEqual(manifest.entries);
    await expect(parsePhysicalTemplate(template, { ...manifest, version: 3 })).rejects.toMatchObject({ code: 'PHYSICAL_TEMPLATE_VERSION_CONFLICT' });
  });
  it('accepts reordered full rows and only editable review cells', async () => {
    const manifest = fixture(2), book = await load(await createPhysicalTemplate(manifest)), sheet = book.getWorksheet('逐箱核对')!;
    const first = sheet.getRow(2).values, second = sheet.getRow(3).values; sheet.getRow(2).values = second; sheet.getRow(3).values = first;
    sheet.getCell('V2').value = '有差异'; sheet.getCell('W2').value = 1.125; sheet.getCell('AA2').value = '实测'; sheet.getCell('V3').value = '一致';
    const entries = await parsePhysicalTemplate(await bytes(book), manifest);
    expect(entries[0]!.status).toBe('consistent'); expect(entries[1]).toMatchObject({ status: 'different', measured: { weight: '1.13' }, reason: '实测' });
  });
  it('rejects tampered source fields, missing or duplicate boxes and metadata changes', async () => {
    const manifest = fixture(2), template = await createPhysicalTemplate(manifest);
    for (const modify of [
      (book: ExcelJS.Workbook) => { book.getWorksheet('逐箱核对')!.getCell('P2').value = 999; },
      (book: ExcelJS.Workbook) => { book.getWorksheet('逐箱核对')!.spliceRows(2, 1); },
      (book: ExcelJS.Workbook) => { book.getWorksheet('逐箱核对')!.getRow(3).values = book.getWorksheet('逐箱核对')!.getRow(2).values; },
      (book: ExcelJS.Workbook) => { book.getWorksheet('模板元数据')!.getCell('B8').value = 'forged'; },
    ]) { const book = await load(template); modify(book); await expect(parsePhysicalTemplate(await bytes(book), manifest)).rejects.toBeInstanceOf(Error); }
  });
  it('rejects formulas and external links even in non-business cells', async () => {
    const manifest = fixture(1), template = await createPhysicalTemplate(manifest), book = await load(template);
    book.getWorksheet('逐箱核对')!.getCell('AA2').value = { formula: '1+1', result: 2 };
    await expect(parsePhysicalTemplate(await bytes(book), manifest)).rejects.toMatchObject({ code: 'PHYSICAL_TEMPLATE_CELL_INVALID' });
    const archive = unzipSync(template); archive['xl/externalLinks/externalLink1.xml'] = strToU8('<externalLink/>');
    await expect(parsePhysicalTemplate(Buffer.from(zipSync(archive)), manifest)).rejects.toMatchObject({ code: 'UNSUPPORTED_WORKBOOK' });
  });
  it('preserves raw numeric precision at half-rounding boundaries', async () => {
    const manifest = fixture(1), book = await load(await createPhysicalTemplate(manifest)), sheet = book.getWorksheet('逐箱核对')!;
    sheet.getCell('V2').value = '有差异'; sheet.getCell('W2').value = 1.005; sheet.getCell('AA2').value = '精度';
    const archive = unzipSync(await bytes(book));
    archive['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(archive['xl/worksheets/sheet1.xml']!).replace(/(<c r="W2"[^>]*><v>)[^<]+(<\/v>)/, '$11.004999999999999999999999$2'));
    const parsed = await parsePhysicalTemplate(Buffer.from(zipSync(archive)), manifest);
    expect(parsed[0]!.measured.weight).toBe('1.00');
  });
});
