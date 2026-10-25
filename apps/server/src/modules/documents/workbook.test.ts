import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_FIELD_OPTIONS, documentBoxFieldKey, documentBoxes, documentBoxSources, documentBoxValue, type DocumentRevisionData, type DocumentMemberSnapshot } from '@scm/contracts';
import { calculateInvoiceUnitPrice, cleanDocumentTemplate, createWorkbook, DOCUMENT_HEADER_FIELDS, DOCUMENT_HEADER_LABELS, DOCUMENT_MAIN_HEADERS, documentProductOverrideKey, projectDocumentLines, reviseDocumentProductFields, validateWorkbookData } from './workbook.js';
import { validateDocumentData } from './domain.js';
import { createDocumentBundleWorkbook } from './bundle-workbook.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const at = '2026-10-19T00:00:00.000Z';
function data(boxCount = 12): DocumentRevisionData {
  const demandId = randomUUID(), groupId = randomUUID(), shipmentId = randomUUID(), confirmationId = randomUUID();
  const items = [{ msku: 'M1', fnsku: 'F1', sku: 'S1', quantity: String(boxCount * 2), name: '一' }, { msku: 'M2', fnsku: 'F2', sku: 'S2', quantity: String(boxCount * 3), name: '二' }];
  const boxes = Array.from({ length: boxCount }, (_, index) => ({ id: randomUUID(), externalBoxId: String(index), packageId: null, localBoxId: String(index + 1), name: `B${index + 1}`, order: index + 1, items: items.map((item, i) => ({ ...item, quantity: String(i + 2) })) }));
  const member: DocumentMemberSnapshot = {
    source: { weekStartDate: '2026-10-19', groupId, groupVersion: 1, m2ConfirmationId: confirmationId, demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: randomUUID(), m3Version: 1, sourceFingerprint: 'fp' },
    demand: { id: demandId, version: 1, businessDate: '2026-10-19', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', snapshot: { sid: 12, shop: '测试店铺', fba: 'FBATEST', country: 'US', channel: 'HY', destinationFc: 'IND9', referenceQuantity: null, notes: null, subBatchName: null }, createdAt: at, updatedAt: at },
    shipment: { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: 12, fba: 'FBATEST', items, boxes, observedAt: at, issues: [] }, source: 'manual', snapshotIds: [], reason: 'fixture', createdBy: 'admin', createdAt: at },
    codes: [], physical: { id: randomUUID(), groupId, m2ConfirmationId: confirmationId, m3Version: 1, sourceFingerprint: 'fp', createdAt: at, createdBy: 'admin', snapshot: { ruleVersion: 'physical-review/v1', entries: [], source: { id: randomUUID(), groupId, m2ConfirmationId: confirmationId, origin: 'history', fingerprint: 'fp', identityValid: true, issues: [], createdAt: at, createdBy: 'admin', snapshotIds: [], boxes: boxes.map((box) => ({ demandId, shipmentRevisionId: shipmentId, boxId: box.id, sid: 12, fba: 'FBATEST', code: `A${box.order}`, order: box.order, po: 'PO1', range: '', raw: { weight: '1.25', weightUnit: 'KG', length: '2', width: '3', height: '4', dimensionUnit: 'CM' }, values: { weight: '1.25', length: '2.00', width: '3.00', height: '4.00' }, items: box.items, sourceObservedAt: at })) } } },
  };
  return { purpose: 'invoice', weekStartDate: '2026-10-19', title: '单票', members: [member], fields: { service: '示例物流服务', recipientName: 'IND9', addressLine1: '测试地址', city: 'Test', postalCode: '00000', countryCode: 'US', currency: 'USD', customsMode: '9810', clearanceMode: '一般贸易清关', deliveryStation: '深圳坂田仓库', taxMode: '包税', battery: '否', magnetic: '否', liquid: '否', powder: '否', dangerous: '否', remarks: '技术样例', deliveryWindow: '2000-01-04 至 2000-01-10' }, templateReference: null,
    profileReferences: items.map((item) => ({ category: 'product', profileId: randomUUID(), version: 1, data: { sid: 12, msku: item.msku, fnsku: item.fnsku, sku: item.sku, englishName: 'Test product', chineseName: '测试商品', unitPrice: '1.25', unitPriceConfirmed: true, material: 'glass', hsCode: '123456', use: 'test', brand: 'brand', model: item.sku, unit: 'PCS', currency: 'USD', salesLink: 'https://example.com/product', imageBase64: pixel, imageExtension: 'png' } })) };
}
function v2Data(boxCount = 1): DocumentRevisionData {
  const source = data(boxCount);
  source.generationRulesVersion = 'v2';
  source.productSourceFacts = source.members[0]!.shipment.data.items.map((item, index) => ({
    sid: 12, msku: item.msku, fnsku: item.fnsku, sku: item.sku, salesPrice: index === 0 ? '9.99' : '19.99', currency: 'USD',
    unitPrice: '999.99', cartonQuantity: index === 0 ? '500' : '600', sourceFileId: randomUUID(), sourceSha256: 'a'.repeat(64), fetchedAt: at,
  }));
  return source;
}
function withManualSalesPrice(source: DocumentRevisionData, salesPrice = '12.375') {
  const fact = source.productSourceFacts![0]!;
  source.manualSalesPrices = [{ sid: fact.sid, msku: fact.msku, fnsku: fact.fnsku, sku: fact.sku, salesPrice, currency: 'USD', reason: '核对售价', recordedBy: 'admin', recordedAt: at,
    sourceFileId: fact.sourceFileId, sourceSha256: fact.sourceSha256, memberSources: [structuredClone(source.members[0]!.source)] }];
  return source;
}
async function template() {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('清关单');
  DOCUMENT_MAIN_HEADERS.forEach((label, index) => { sheet.getCell(17, index + 1).value = label; });
  DOCUMENT_HEADER_LABELS.forEach(([left, right], index) => { sheet.getCell(index + 1, 1).value = left; sheet.getCell(index + 1, 5).value = right; });
  sheet.mergeCells('B6:D6'); sheet.getCell('B6').value = '旧地址'; sheet.getCell('A18').value = '旧订单'; sheet.getCell('Q19').value = '旧链接';
  book.addWorksheet('旧地址库').getCell('A1').value = '旧客户资料';
  const imageId = book.addImage({ base64: pixel, extension: 'png' }); sheet.addImage(imageId, 'P20:P20');
  return Buffer.from(await book.xlsx.writeBuffer());
}
function confirmDomainFixture(source: DocumentRevisionData) {
  source.fields.addressConfirmed = 'true'; source.fields.addressConfirmationReason = '技术测试地址已核对';
  source.templateReference = { templateId: randomUUID(), version: 1, sha256: '0'.repeat(64), fileId: randomUUID() };
  for (const member of source.members) {
    member.source.physicalConfirmationId = member.physical!.id;
    member.codes = member.shipment.data.boxes.map((box) => ({ id: randomUUID(), groupId: member.source.groupId, demandId: member.demand.id, boxId: box.id, prefix: 'A', sequence: box.order!, code: `A${box.order}`, valid: true, createdAt: at }));
  }
}
describe('丰信单票 XLSX', () => {
  it('renders marked/line-wrapped template headings then merges real invoices without losing dates, images, merges or data', async () => {
    const raw = new ExcelJS.Workbook(); await raw.xlsx.load(await template() as never);
    raw.worksheets[0]!.getCell('A17').value = '货箱编号 *'; raw.worksheets[0]!.getCell('G17').value = '产品\n英文品名*'; raw.worksheets[0]!.getCell('J17').value = '产品申报数量\n（单箱产品个数） *';
    const markedTemplate = Buffer.from(await raw.xlsx.writeBuffer()), first = v2Data(), second = v2Data(), third = v2Data();
    third.fields.addressLine1 = 'Different GB address'; third.fields.countryCode = 'GB'; third.members[0]!.demand.snapshot.country = 'GB'; third.productSourceFacts!.forEach((fact) => { fact.currency = 'GBP'; });
    const documents = [first, second, third], before = structuredClone(documents);
    const inputs = await Promise.all(documents.map(async (source, index) => ({ documentId: String(index), bytes: await createWorkbook(source, markedTemplate) })));
    const result = await createDocumentBundleWorkbook(inputs), book = new ExcelJS.Workbook(); await book.xlsx.load(result.bytes as never);
    expect(book.worksheets).toHaveLength(2); expect(result.sheets.map((sheet) => sheet.rows)).toEqual([2, 1]);
    const usd = book.worksheets[0]!, gbp = book.worksheets[1]!;
    expect(usd.getCell('A17').value).toBe('货箱编号'); expect(usd.getCell('G17').value).toBe('产品英文品名'); expect(usd.getCell('F14').value).toBe(first.fields.deliveryWindow);
    expect(usd.model.merges).toContain('B6:D6'); expect(usd.getImages()).toHaveLength(2); expect(gbp.getImages()).toHaveLength(1);
    expect(usd.getCell('B16').value).toBe(2); expect(usd.getCell('F15').value).toBe(10); expect(usd.getCell('I19').value).toBe(2);
    expect(gbp.getCell('F12').value).toBe('英镑'); expect(gbp.getCell('B6').value).toBe('Different GB address'); expect(gbp.getCell('F14').value).toBe(third.fields.deliveryWindow);
    expect(documents).toEqual(before);
  });
  it('exports an M2 invoice without M3 using exact unit conversion and per-box manual values', async () => {
    const source = data(2), member = source.members[0]!;
    confirmDomainFixture(source); member.physical = null;
    member.source.physicalConfirmationId = null; member.source.m3Version = null; member.source.sourceFingerprint = null;
    for (const box of member.shipment.data.boxes) {
      Object.assign(box, { weight: '2.5', weightUnit: 'LB', length: '10', width: '5', height: '4', dimensionUnit: 'IN' });
      source.fields[documentBoxFieldKey(box.id, 'po')] = 'MANUAL-PO';
    }
    member.boxSource = documentBoxSources(member);
    const boxId = member.shipment.data.boxes[1]!.id;
    source.fields[documentBoxFieldKey(boxId, 'length')] = '31.235';
    source.fields[documentBoxFieldKey(boxId, 'weight')] = '2.25';
    expect(validateDocumentData(source)).toEqual([]); expect(validateWorkbookData(source)).toEqual([]);
    const before = structuredClone(source), projected = projectDocumentLines(source);
    expect(projected.boxCount).toBe(2); expect(projected.totalWeight).toBe('3.38'); expect(projected.lines).toHaveLength(4);
    expect(documentBoxes(member, source.fields)[1]!.values).toMatchObject({ length: '31.24', weight: '2.25', width: '12.70', height: '10.16' });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await createWorkbook(source, await template()) as never);
    const sheet = workbook.worksheets[0]!;
    expect([sheet.getCell('B18').value, sheet.getCell('C18').value, sheet.getCell('D18').value]).toEqual(['MANUAL-PO', 1.13, 25.4]);
    expect([sheet.getCell('C20').value, sheet.getCell('D20').value]).toEqual([2.25, 31.24]);
    expect(source).toEqual(before); expect(member.boxSource[1]!.raw.length).toBe('10');
  });
  it('requires missing box values and respects blank versus restored overrides even with an automatic value', () => {
    const source = data(1), member = source.members[0]!, boxId = member.shipment.data.boxes[0]!.id;
    member.boxSource = structuredClone(member.physical!.snapshot.source.boxes); member.physical = null;
    source.fields[documentBoxFieldKey(boxId, 'length')] = '';
    expect(documentBoxes(member, source.fields)[0]!.values.length).toBeNull();
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_BOX_VALUES_REQUIRED' }));
    source.fields[documentBoxFieldKey(boxId, 'length')] = null;
    expect(validateWorkbookData(source)).toEqual([]); expect(documentBoxes(member, source.fields)[0]!.values.length).toBe('2.00');
    source.fields[documentBoxFieldKey(boxId, 'po')] = ' ';
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_BOX_VALUES_REQUIRED' }));
    delete source.fields[documentBoxFieldKey(boxId, 'po')];
    expect(validateWorkbookData(source)).toEqual([]);
  });
  it('blocks legacy and frozen automatic values whose cents cannot survive XLSX number conversion', () => {
    const source = data(1), member = source.members[0]!;
    member.physical!.snapshot.source.boxes[0]!.values.length = '90071992547409.99';
    expect(documentBoxes(member, source.fields)[0]!.values.length).toBeNull();
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_BOX_VALUES_REQUIRED' }));
    member.boxSource = structuredClone(member.physical!.snapshot.source.boxes); member.physical = null;
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_BOX_VALUES_REQUIRED' }));
  });
  it.each([
    ['1.005', 'KG', 'weight', '1.01'], ['2.5', 'LB', 'weight', '1.13'], ['10', 'IN', 'dimension', '25.40'],
    ['0.001', 'KG', 'weight', null], ['1', 'unknown', 'dimension', null], ['-1', 'KG', 'weight', null],
    ['9007199254740992', 'KG', 'weight', null], ['Infinity', 'CM', 'dimension', null],
    ['90071992547409.99', 'KG', 'weight', null],
  ] as const)('normalizes %s %s without floating-point rounding surprises', (value, unit, kind, expected) => {
    expect(documentBoxValue(value, unit, kind)).toBe(expected);
  });
  it('keeps shared field choices consistent with workbook validation and exported dropdowns', async () => {
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await cleanDocumentTemplate(await template()) as never);
    const sheet = book.worksheets[0]!, currencies: Record<string, string> = { USD: '美元', EUR: '欧元', GBP: '英镑' };
    for (const key of Object.keys(DOCUMENT_FIELD_OPTIONS) as Array<keyof typeof DOCUMENT_FIELD_OPTIONS>) {
      const expected = DOCUMENT_FIELD_OPTIONS[key].map((value) => key === 'currency' ? currencies[value]! : value);
      expect(sheet.getCell(DOCUMENT_HEADER_FIELDS[key]).dataValidation.formulae).toEqual([`"${expected.join(',')}"`]);
      const source = data(1); source.fields[key] = '未支持的选项';
      if (key === 'currency') source.members[0]!.demand.snapshot.country = 'CA';
      expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ message: key === 'currency' ? expect.stringContaining('币种') : expect.stringContaining(key === 'customsMode' ? '报关方式' : key === 'clearanceMode' ? '清关方式' : key === 'taxMode' ? '交税方式' : key === 'deliveryStation' ? '所在货站' : key) }));
    }
  });
  it('defaults five blank flags for legacy drafts consistently in validation and output without mutating their snapshot', async () => {
    const source = data(1);
    delete source.fields.battery; source.fields.magnetic = null; source.fields.liquid = ''; source.fields.powder = '  ';
    delete source.fields.dangerous;
    const original = structuredClone(source);
    expect(validateWorkbookData(source)).toEqual([]);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(['F1', 'F2', 'F3', 'F4', 'F5'].map((cell) => book.worksheets[0]!.getCell(cell).value)).toEqual(['否', '否', '否', '否', '否']);
    expect(book.worksheets[0]!.getCell('B1').value).toBeNull();
    expect(source).toEqual(original);
    source.fields.battery = '是'; source.fields.dangerous = '是'; source.fields.orderNumber = 'MANUAL-ORDER';
    expect(validateWorkbookData(source)).toEqual([]);
    const positive = new ExcelJS.Workbook(); await positive.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(positive.worksheets[0]!.getCell('F1').value).toBe('是');
    expect(positive.worksheets[0]!.getCell('F5').value).toBe('是');
    expect(positive.worksheets[0]!.getCell('B1').value).toBeNull();
  });
  it('compresses the complete twelve-box FBA, retaining mixed product rows and exact counts', () => {
    const source = data(); expect(validateWorkbookData(source)).toEqual([]);
    const projected = projectDocumentLines(source);
    expect(projected.lines).toHaveLength(2); expect(projected.lines.map((line) => line.range)).toEqual(['FBATESTU000001-12', 'FBATESTU000001-12']);
    expect(projected.lines[0]!.boxIds).toHaveLength(12); expect(projected.boxCount).toBe(12); expect(projected.totalQuantity).toBe('60'); expect(projected.totalWeight).toBe('15.00'); expect(projected.totalValue).toBe('75.00');
  });
  it('expands every box in an FBA when any weight, dimension, PO or composition differs', () => {
    for (const property of ['weight', 'length'] as const) {
      const source = data(); source.members[0]!.physical!.snapshot.source.boxes[1]!.values[property] = '3.00';
      const projected = projectDocumentLines(source); expect(projected.lines).toHaveLength(24); expect(projected.lines[2]!.range).toBe('FBATESTU000002');
    }
    const source = data(2); source.members[0]!.physical!.snapshot.source.boxes[1]!.po = 'other'; expect(projectDocumentLines(source).lines).toHaveLength(4);
  });
  it('clears old dynamic values, prior images and helper sheets, then writes numeric values and new images', async () => {
    const bytes = await template(), clean = new ExcelJS.Workbook(); await clean.xlsx.load(await cleanDocumentTemplate(bytes) as never);
    expect(clean.worksheets).toHaveLength(1); expect(clean.worksheets[0]!.getCell('B6').value).toBeNull(); expect(clean.worksheets[0]!.getCell('A18').value).toBeNull(); expect(clean.worksheets[0]!.getImages()).toHaveLength(0);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(data(), bytes) as never); const sheet = book.worksheets[0]!;
    expect(sheet.getCell('B16').value).toBe(12); expect(sheet.getCell('F15').value).toBe(60); expect(sheet.getCell('A18').value).toBe('FBATESTU000001-12'); expect(sheet.getCell('C18').value).toBe(1.25); expect(sheet.getCell('C18').numFmt).toBe('0.00'); expect(sheet.getCell('J18').value).toBe(2); expect(sheet.getImages()).toHaveLength(2);
    expect(Buffer.from(await book.xlsx.writeBuffer()).length).toBeGreaterThan(0);
  });
  it('exports a zero-image invoice with blank picture cells, warnings and unchanged quantities without retrieving image URLs', async () => {
    const source = data(2);
    for (const reference of source.profileReferences) {
      delete reference.data.imageBase64; delete reference.data.imageExtension;
      reference.data.imageUrl = 'https://example.com/product.png';
    }
    const before = structuredClone(source), request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Renderer must not retrieve images'));
    try {
      const issues = validateWorkbookData(source);
      expect(issues).toHaveLength(2);
      expect(issues.every((issue) => issue.code === 'PRODUCT_IMAGE_MISSING' && issue.severity === 'warning')).toBe(true);
      expect(issues[0]!.message).toContain('可补充图片或继续生成待复核文件');
      const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
      const sheet = book.worksheets[0]!;
      expect(sheet.getImages()).toHaveLength(0); expect(sheet.columnCount).toBe(17);
      expect([sheet.getCell('P18').value, sheet.getCell('P19').value]).toEqual([null, null]);
      expect([sheet.getCell('J18').value, sheet.getCell('J19').value]).toEqual([2, 3]);
      expect(sheet.getCell('B16').value).toBe(2); expect(sheet.getCell('F15').value).toBe(10);
      expect(request).not.toHaveBeenCalled(); expect(source).toEqual(before);
    } finally { request.mockRestore(); }
  });
  it('keeps partial images on their product rows across expanded boxes and FBAs, warning once per complete identity', async () => {
    const source = data(2), extra = data(1).members[0]!;
    extra.demand.snapshot.fba = 'FBAOTHER'; extra.shipment.data.fba = 'FBAOTHER';
    extra.physical!.snapshot.source.boxes.forEach((box) => { box.fba = 'FBAOTHER'; });
    source.members[0]!.physical!.snapshot.source.boxes[1]!.po = 'OTHER-PO';
    source.members.push(extra);
    delete source.profileReferences[0]!.data.imageBase64;
    const before = structuredClone(source), issues = validateWorkbookData(source);
    expect(issues).toEqual([expect.objectContaining({ code: 'PRODUCT_IMAGE_MISSING', severity: 'warning', message: expect.stringContaining('S1') })]);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    const sheet = book.worksheets[0]!, images = sheet.getImages();
    expect(images.map((entry) => [entry.range.tl.nativeCol, entry.range.tl.nativeRow])).toEqual([[15, 18], [15, 20], [15, 22]]);
    for (const entry of images) expect(Buffer.from(book.getImage(Number(entry.imageId)).buffer as unknown as Uint8Array)).toEqual(Buffer.from(pixel, 'base64'));
    expect(Array.from({ length: 6 }, (_, index) => sheet.getCell(`P${index + 18}`).value)).toEqual([null, null, null, null, null, null]);
    expect(Array.from({ length: 6 }, (_, index) => sheet.getCell(`J${index + 18}`).value)).toEqual([2, 3, 2, 3, 2, 3]);
    expect(sheet.getCell('B16').value).toBe(3); expect(sheet.getCell('F15').value).toBe(15);
    expect(source).toEqual(before);
  });
  it.each(['not-an-image', 'https://example.com/product.png', 'iVBORw0KGgo=', '/9j/2Q=='])('warns explicitly about a legacy invalid image %s and preserves other valid images', async (imageBase64) => {
    const source = data(1), item = source.members[0]!.shipment.data.items[0]!;
    source.fields[`product.${documentProductOverrideKey(12, item)}.imageBase64`] = imageBase64;
    confirmDomainFixture(source);
    expect(validateDocumentData(source)).toEqual([]);
    expect(validateWorkbookData(source)).toEqual([expect.objectContaining({ code: 'PRODUCT_IMAGE_INVALID', severity: 'warning', message: expect.stringContaining('现有图片无效，本次图片列留空') })]);
    const before = structuredClone(source), book = new ExcelJS.Workbook();
    await book.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(book.worksheets[0]!.getImages().map((entry) => entry.range.tl.nativeRow)).toEqual([18]);
    expect(book.worksheets[0]!.getCell('P18').value).toBeNull(); expect(source).toEqual(before);
  });
  it.each(['price', 'quantity'])('still blocks an invalid %s when missing images are only warnings', async (invalid) => {
    const source = data(1);
    source.profileReferences.forEach((reference) => { delete reference.data.imageBase64; });
    if (invalid === 'price') source.profileReferences[1]!.data.unitPrice = '0';
    else source.members[0]!.physical!.snapshot.source.boxes[0]!.items[0]!.quantity = '8';
    const issues = validateWorkbookData(source);
    expect(issues.filter((issue) => issue.code === 'PRODUCT_IMAGE_MISSING' && issue.severity === 'warning')).toHaveLength(2);
    expect(issues).toContainEqual(expect.objectContaining({ code: invalid === 'price' ? 'DECLARATION_PRICE_INVALID' : 'QUANTITY_MISMATCH', severity: 'error' }));
    await expect(createWorkbook(source, await template())).rejects.toThrow(invalid === 'price' ? '申报单价' : '数量不一致');
  });
  it('blocks missing links, unconfirmed prices, mismatched identities and non-conserving quantities', () => {
    const source = data(); delete source.profileReferences[0]!.data.salesLink; source.profileReferences[1]!.data.unitPriceConfirmed = false;
    expect(validateWorkbookData(source).map((issue) => issue.code)).toEqual(expect.arrayContaining(['DECLARATION_REQUIRED', 'DECLARATION_PRICE_UNCONFIRMED']));
    expect(validateWorkbookData(source).some((issue) => issue.code === 'SALES_LINK_INVALID')).toBe(false);
    source.profileReferences[0]!.data.salesLink = 'javascript:alert(1)';
    expect(validateWorkbookData(source).some((issue) => issue.code === 'SALES_LINK_INVALID')).toBe(true);
    source.members[0]!.physical!.snapshot.source.boxes[0]!.items[0]!.quantity = '8'; expect(validateWorkbookData(source).some((issue) => issue.code === 'QUANTITY_MISMATCH')).toBe(true);
    source.profileReferences[0]!.data.fnsku = 'different'; expect(validateWorkbookData(source).some((issue) => issue.code === 'PRODUCT_IMAGE_MISSING' && issue.severity === 'warning')).toBe(true);
  });
  it('does not compress across FBA and never counts repeated mixed-product weight twice', () => {
    const source = data(2), extra = structuredClone(source.members[0]!); extra.demand.id = randomUUID(); extra.shipment.id = randomUUID(); extra.source.demandId = extra.demand.id; extra.source.shipmentRevisionId = extra.shipment.id;
    extra.physical!.snapshot.source.boxes.forEach((box) => { box.demandId = extra.demand.id; box.shipmentRevisionId = extra.shipment.id; box.boxId = randomUUID(); box.fba = 'FBAOTHER'; });
    source.members.push(extra); const result = projectDocumentLines(source);
    expect(result.lines).toHaveLength(4); expect(result.boxCount).toBe(4); expect(result.totalWeight).toBe('5.00'); expect(result.totalQuantity).toBe('20');
  });
  it('numbers four separate FBAs with two, two, one and one boxes without changing the header order number', async () => {
    const source = data(2);
    source.members = [2, 2, 1, 1].map((count, index) => {
      const member = data(count).members[0]!, fba = `FBATECH${index + 1}`;
      member.demand.snapshot.fba = fba; member.shipment.data.fba = fba;
      member.physical!.snapshot.source.boxes.forEach((box) => { box.fba = fba; });
      return member;
    });
    delete source.fields.dangerous;
    const before = structuredClone(source), projected = projectDocumentLines(source);
    const expected = ['FBATECH1U000001-2', 'FBATECH1U000001-2', 'FBATECH2U000001-2', 'FBATECH2U000001-2', 'FBATECH3U000001', 'FBATECH3U000001', 'FBATECH4U000001', 'FBATECH4U000001'];
    expect(projected.lines.map((line) => line.range)).toEqual(expected);
    expect(projected).toMatchObject({ boxCount: 6, totalQuantity: '30', totalWeight: '7.50', totalValue: '37.50' });
    expect(projected.lines.map((line) => line.count)).toEqual([2, 2, 2, 2, 1, 1, 1, 1]);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    const sheet = book.worksheets[0]!;
    expect(expected.map((_, index) => sheet.getCell(`A${index + 18}`).value)).toEqual(expected);
    expect(sheet.getCell('B1').value).toBeNull(); expect(sheet.getCell('F5').value).toBe('否');
    expect(sheet.getCell('B16').value).toBe(6); expect(sheet.getCell('F15').value).toBe(30); expect(sheet.getImages()).toHaveLength(8);
    expect(source).toEqual(before);
  });
  it('uses actual six-digit box orders without a self-range suffix for expanded mixed-product boxes', async () => {
    const source = data(2), boxes = source.members[0]!.physical!.snapshot.source.boxes;
    boxes[0]!.order = 3; boxes[1]!.order = 7; boxes[1]!.po = 'DIFFERENT-PO';
    source.fields.orderNumber = 'MANUAL-HEADER'; source.fields.dangerous = '是';
    const expected = ['FBATESTU000003', 'FBATESTU000003', 'FBATESTU000007', 'FBATESTU000007'];
    expect(projectDocumentLines(source).lines.map((line) => line.range)).toEqual(expected);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(expected.map((_, index) => book.worksheets[0]!.getCell(`A${index + 18}`).value)).toEqual(expected);
    expect(book.worksheets[0]!.getCell('B1').value).toBeNull();
    expect(book.worksheets[0]!.getCell('F5').value).toBe('是');
  });
  it('rejects an unsafe whole-invoice quantity even when each product quantity is safe', async () => {
    const source = data(1), member = source.members[0]!;
    for (const items of [member.shipment.data.items, member.shipment.data.boxes[0]!.items, member.physical!.snapshot.source.boxes[0]!.items]) {
      items[0]!.quantity = String(Number.MAX_SAFE_INTEGER); items[1]!.quantity = '1';
    }
    expect(validateWorkbookData(source).map((issue) => issue.code)).toContain('DOCUMENT_TOTAL_QUANTITY_UNSAFE');
    expect(() => projectDocumentLines(source)).toThrow('安全整数范围');
    await expect(createWorkbook(source, await template())).rejects.toThrow('安全整数范围');
    for (const items of [member.shipment.data.items, member.shipment.data.boxes[0]!.items, member.physical!.snapshot.source.boxes[0]!.items]) items[0]!.quantity = String(Number.MAX_SAFE_INTEGER - 1);
    expect(projectDocumentLines(source).totalQuantity).toBe(String(Number.MAX_SAFE_INTEGER));
  });
  it.each(['1.005', '0.001', '90071992547409.91'])('rejects a declared price %s that XLSX would hide or change', (unitPrice) => {
    const source = data(1); source.profileReferences[0]!.data.unitPrice = unitPrice;
    expect(validateWorkbookData(source).map((issue) => issue.code)).toContain('DECLARATION_PRICE_INVALID');
  });
  it('keeps a confirmed two-decimal price and Decimal amount unchanged', () => {
    const source = data(1); source.profileReferences[0]!.data.unitPrice = '0.10'; source.profileReferences[1]!.data.unitPrice = '0.20';
    expect(validateWorkbookData(source).some((issue) => issue.code === 'DECLARATION_PRICE_INVALID')).toBe(false);
    expect(projectDocumentLines(source).totalValue).toBe('0.80');
  });
  it('rejects swapped detail mapping and changed header labels before cleaning', async () => {
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await template() as never); const sheet = book.worksheets[0]!;
    const previous = sheet.getCell('C17').value; sheet.getCell('C17').value = sheet.getCell('I17').value; sheet.getCell('I17').value = previous;
    await expect(cleanDocumentTemplate(Buffer.from(await book.xlsx.writeBuffer()))).rejects.toThrow('第 17 行第 3 列');
    sheet.getCell('C17').value = DOCUMENT_MAIN_HEADERS[2]!; sheet.getCell('I17').value = DOCUMENT_MAIN_HEADERS[8]!; sheet.getCell('E12').value = '其他字段';
    await expect(cleanDocumentTemplate(Buffer.from(await book.xlsx.writeBuffer()))).rejects.toThrow('第 12 行标签');
  });
  it.each(['remarks', 'deliveryWindow'])('exports an optional blank template field %s without inventing a value', async (field) => {
    const source = data(1); delete source.fields[field];
    const before = structuredClone(source);
    expect(validateWorkbookData(source)).toEqual([]);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(book.worksheets[0]!.getCell(DOCUMENT_HEADER_FIELDS[field as 'remarks' | 'deliveryWindow']).value).toBeNull();
    expect(source).toEqual(before);
  });
  it('exports manually completed product declarations without profiles or a declaration unit, inheriting the invoice currency', async () => {
    const source = data(1), member = source.members[0]!;
    for (const item of member.shipment.data.items) {
      const reference = source.profileReferences.find((profile) => profile.data.sku === item.sku)!, prefix = `product.${documentProductOverrideKey(member.demand.snapshot.sid, item)}.`;
      for (const [key, value] of Object.entries(reference.data)) if (!['sid', 'msku', 'fnsku', 'sku', 'unit', 'currency'].includes(key)) source.fields[prefix + key] = String(value);
    }
    source.profileReferences = [];
    const before = structuredClone(source);
    expect(validateWorkbookData(source)).toEqual([]);
    expect(projectDocumentLines(source).lines.map((line) => line.declaration.currency)).toEqual(['USD', 'USD']);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    const sheet = book.worksheets[0]!;
    expect(sheet.getCell('F12').value).toBe('美元');
    expect([sheet.getCell('I18').value, sheet.getCell('I19').value]).toEqual([1.25, 1.25]);
    expect(sheet.getImages()).toHaveLength(2);
    expect(source).toEqual(before);
  });
  it('keeps explicit product currencies and blocks a different invoice currency', () => {
    const source = data(1); source.profileReferences[0]!.data.currency = 'EUR';
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'CURRENCY_CONFLICT', message: expect.stringContaining('S1') }));
    expect(projectDocumentLines(source).lines[0]!.declaration.currency).toBe('EUR');
    source.profileReferences[0]!.data.currency = 'CNY';
    expect(projectDocumentLines(source).lines[0]!.declaration.currency).toBe('CNY');
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'CURRENCY_CONFLICT' }));
  });
  it('reports missing product fields once per complete identity across FBAs and keeps quantity errors per FBA', () => {
    const source = data(1), extra = data(1).members[0]!;
    extra.demand.snapshot.fba = 'FBAOTHER'; source.members.push(extra);
    source.profileReferences[0]!.data = { sid: 12, msku: 'M1', fnsku: 'F1', sku: 'S1' };
    for (const member of source.members) member.physical!.snapshot.source.boxes[0]!.items[0]!.quantity = '8';
    const before = structuredClone(source), issues = validateWorkbookData(source);
    expect(issues.filter((issue) => issue.code === 'DECLARATION_REQUIRED')).toEqual([expect.objectContaining({ message: expect.stringContaining('englishName、chineseName、unitPrice') })]);
    expect(issues.filter((issue) => issue.code === 'PRODUCT_IMAGE_MISSING')).toEqual([expect.objectContaining({ severity: 'warning' })]);
    expect(issues.filter((issue) => issue.code === 'QUANTITY_MISMATCH')).toHaveLength(2);
    expect(issues.some((issue) => ['DECLARATION_PRICE_UNCONFIRMED', 'SALES_LINK_INVALID'].includes(issue.code))).toBe(false);
    expect(source).toEqual(before);
    source.profileReferences[0]!.data.unitPrice = '-1'; source.profileReferences[0]!.data.salesLink = 'ftp://example.com/item';
    const invalid = validateWorkbookData(source);
    expect(invalid.filter((issue) => issue.code === 'DECLARATION_PRICE_INVALID')).toHaveLength(1);
    expect(invalid.filter((issue) => issue.code === 'SALES_LINK_INVALID')).toHaveLength(1);
    source.profileReferences[0]!.data.unitPrice = '1.25'; source.profileReferences[0]!.data.unitPriceConfirmed = false;
    expect(validateWorkbookData(source).filter((issue) => issue.code === 'DECLARATION_PRICE_UNCONFIRMED')).toHaveLength(1);
  });
  it('does not merge diagnostics for distinct MSKUs, FNSKUs or stores sharing a SKU', () => {
    const source = data(1), base = source.members[0]!;
    source.members = [base, ...['msku', 'fnsku', 'sid'].map((key) => {
      const member = data(1).members[0]!;
      if (key === 'sid') member.demand.snapshot.sid = 13;
      else member.shipment.data.items[0]![key as 'msku' | 'fnsku'] = 'DIFFERENT';
      member.shipment.data.items = [member.shipment.data.items[0]!];
      return member;
    })];
    base.shipment.data.items = [base.shipment.data.items[0]!]; source.profileReferences = [];
    expect(validateWorkbookData(source).filter((issue) => issue.code === 'DECLARATION_REQUIRED')).toHaveLength(4);
  });
  it('waits for a valid price before requesting price and currency confirmation', () => {
    const source = data(1); source.profileReferences[0]!.data.unitPriceConfirmed = false;
    delete source.profileReferences[0]!.data.unitPrice;
    const issues = validateWorkbookData(source);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'DECLARATION_REQUIRED', message: expect.stringContaining('unitPrice') }));
    expect(issues.some((issue) => issue.code === 'DECLARATION_PRICE_UNCONFIRMED')).toBe(false);
  });
  it.each([undefined, 'CNY'])('reports unknown-country manual invoice currency %s once at the header instead of repeating inherited currency gaps for each product', (currency) => {
    const source = data(1); source.members[0]!.demand.snapshot.country = 'CA';
    if (currency === undefined) delete source.fields.currency; else source.fields.currency = currency;
    for (const profile of source.profileReferences) { delete profile.data.currency; profile.data.unitPriceConfirmed = false; }
    const issues = validateWorkbookData(source);
    expect(issues).toEqual([expect.objectContaining({ code: currency === undefined ? 'DOCUMENT_FIELD_REQUIRED' : 'CURRENCY_UNSUPPORTED' })]);
    expect(issues.some((issue) => ['DECLARATION_REQUIRED', 'CURRENCY_CONFLICT', 'DECLARATION_PRICE_UNCONFIRMED'].includes(issue.code))).toBe(false);
  });
  it('does not call an explicit product currency conflicting before an unknown-country invoice currency is selected', () => {
    const source = data(1); source.members[0]!.demand.snapshot.country = 'CA'; delete source.fields.currency;
    const issues = validateWorkbookData(source);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_FIELD_REQUIRED', message: expect.stringContaining('currency') }));
    expect(issues.some((issue) => ['CURRENCY_CONFLICT', 'DECLARATION_PRICE_UNCONFIRMED'].includes(issue.code))).toBe(false);
  });
  it('withdraws confirmation when an inherited currency changes, but preserves explicit pairs and a valid explicit reconfirmation', () => {
    const previous = data(1), first = previous.members[0]!.shipment.data.items[0]!, prefix = `product.${documentProductOverrideKey(12, first)}.`;
    previous.members[0]!.demand.snapshot.country = 'CA';
    delete previous.profileReferences[0]!.data.currency;
    const next = structuredClone(previous); next.fields.currency = 'EUR';
    const before = structuredClone(previous), changed = structuredClone(next);
    expect(reviseDocumentProductFields(previous, next)[prefix + 'unitPriceConfirmed']).toBe('false');
    expect(reviseDocumentProductFields(previous, next)[`product.${documentProductOverrideKey(12, previous.members[0]!.shipment.data.items[1]!)}.unitPriceConfirmed`]).toBeUndefined();
    const confirmation = { ...next.fields, [prefix + 'unitPrice']: '1.25', [prefix + 'currency']: 'EUR', [prefix + 'unitPriceConfirmed']: 'true' };
    expect(reviseDocumentProductFields(previous, { ...next, fields: confirmation }, confirmation)[prefix + 'unitPriceConfirmed']).toBe('true');
    const staleConfirmation = { ...next.fields, [prefix + 'unitPriceConfirmed']: 'true' };
    expect(reviseDocumentProductFields(previous, { ...next, fields: staleConfirmation }, staleConfirmation)[prefix + 'unitPriceConfirmed']).toBe('false');
    const invalid = { ...confirmation, [prefix + 'unitPrice']: '-1' };
    expect(reviseDocumentProductFields(previous, { ...next, fields: invalid }, invalid)[prefix + 'unitPriceConfirmed']).toBe('false');
    expect(previous).toEqual(before); expect(next).toEqual(changed);
  });
  it('requires a new confirmation before exporting a changed inherited currency and keeps old snapshots intact', async () => {
    const previous = data(1); previous.members[0]!.demand.snapshot.country = 'CA'; previous.profileReferences.forEach((profile) => { delete profile.data.currency; });
    const next = structuredClone(previous); next.fields.currency = 'EUR';
    next.fields = reviseDocumentProductFields(previous, next);
    expect(validateWorkbookData(next).filter((issue) => issue.code === 'DECLARATION_PRICE_UNCONFIRMED')).toHaveLength(2);
    await expect(createWorkbook(next, await template())).rejects.toThrow('尚未人工确认');
    const fields = { ...next.fields };
    for (const item of next.members[0]!.shipment.data.items) {
      const prefix = `product.${documentProductOverrideKey(12, item)}.`;
      fields[prefix + 'unitPrice'] = '1.25'; fields[prefix + 'currency'] = 'EUR'; fields[prefix + 'unitPriceConfirmed'] = 'true';
    }
    const confirmed = { ...next, fields: reviseDocumentProductFields(previous, { ...next, fields }, fields) };
    expect(validateWorkbookData(confirmed)).toEqual([]);
    const before = structuredClone(previous), book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(confirmed, await template()) as never);
    expect(book.worksheets[0]!.getCell('F12').value).toBe('欧元'); expect(book.worksheets[0]!.getCell('I18').value).toBe(1.25);
    expect(previous).toEqual(before); expect(previous.fields.currency).toBe('USD');
    expect(previous.profileReferences.every((profile) => profile.data.unitPriceConfirmed === true && profile.data.currency === undefined)).toBe(true);
  });
  it('withdraws a legacy inherited EUR confirmation when the same US ticket adopts USD, and retains an explicit confirmation of the new pair', () => {
    const previous = data(1); previous.fields.currency = 'EUR';
    previous.profileReferences.forEach((profile) => { delete profile.data.currency; });
    const next = structuredClone(previous); next.fields.currency = 'USD';
    const original = structuredClone(previous), unchangedNext = structuredClone(next);
    const prefixes = next.members[0]!.shipment.data.items.map((item) => `product.${documentProductOverrideKey(12, item)}.`);
    const withdrawn = reviseDocumentProductFields(previous, next);
    for (const prefix of prefixes) expect(withdrawn[prefix + 'unitPriceConfirmed']).toBe('false');
    expect(validateWorkbookData({ ...next, fields: withdrawn }).filter((issue) => issue.code === 'DECLARATION_PRICE_UNCONFIRMED')).toHaveLength(2);
    const confirmedFields = { ...next.fields };
    for (const prefix of prefixes) {
      confirmedFields[prefix + 'unitPrice'] = '1.25'; confirmedFields[prefix + 'currency'] = 'USD'; confirmedFields[prefix + 'unitPriceConfirmed'] = 'true';
    }
    const confirmed = reviseDocumentProductFields(previous, { ...next, fields: confirmedFields }, confirmedFields);
    for (const prefix of prefixes) expect(confirmed[prefix + 'unitPriceConfirmed']).toBe('true');
    expect(validateWorkbookData({ ...next, fields: confirmed })).toEqual([]);
    expect(previous).toEqual(original); expect(next).toEqual(unchangedNext);
  });
});

describe('丰信 v2 发票规则', () => {
  it.each([
    ['9.99', '2.00'], ['5.025', '1.01'], ['0.025', '0.01'], [12.34, '2.47'], [' 10.00 ', '2.00'],
    ['0.024', null], ['0', null], ['-1', null], ['1e2', null], ['900719925474099100', null], [null, null], [Infinity, null],
  ])('calculates 20%% of ordinary Listing price %s with half-up cents', (input, expected) => {
    expect(calculateInvoiceUnitPrice(input)).toBe(expected);
  });

  it('compresses a complete mixed FBA to one representative row, keeping source product totals separate from declared defaults', async () => {
    const source = v2Data(12), member = source.members[0]!, first = member.shipment.data.items[0]!;
    source.profileReferences = [source.profileReferences[0]!];
    source.productSourceFacts = [source.productSourceFacts![0]!];
    source.profileReferences[0]!.data.unitPrice = '99'; source.profileReferences[0]!.data.currency = 'CNY'; source.profileReferences[0]!.data.unitPriceConfirmed = false;
    const prefix = `product.${documentProductOverrideKey(12, first)}.`;
    source.fields[prefix + 'unitPrice'] = '0'; source.fields[prefix + 'currency'] = 'EUR'; source.fields[prefix + 'unitPriceConfirmed'] = 'false';
    member.physical!.snapshot.source.boxes.forEach((box, index) => { if (index % 2) box.items.reverse(); });
    const before = structuredClone(source), issues = validateWorkbookData(source), projection = projectDocumentLines(source);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(issues.some((issue) => issue.code === 'DECLARATION_PRICE_UNCONFIRMED')).toBe(false);
    expect(projection.lines).toHaveLength(1);
    expect(projection.lines[0]).toMatchObject({ range: 'FBATESTU000001-12', count: 12, product: { sku: 'S1', quantity: '2' }, actualQuantity: '5', declaredQuantity: '500', declaration: { unitPrice: '2.00', currency: 'USD' } });
    expect(projection.lines[0]!.boxIds).toHaveLength(12);
    expect(projection).toMatchObject({ boxCount: 12, totalQuantity: '60', totalWeight: '15.00', totalValue: '12000.00' });
    expect(Object.values(projection.perProduct).sort()).toEqual(['24', '36']);
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Renderer must not retrieve remote data'));
    try {
      const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
      const sheet = book.worksheets[0]!;
      expect(sheet.rowCount).toBe(18); expect(sheet.getCell('A18').value).toBe('FBATESTU000001-12');
      expect(sheet.getCell('I18').value).toBe(2); expect(sheet.getCell('I18').numFmt).toBe('0.00'); expect(sheet.getCell('J18').value).toBe(500);
      expect(sheet.getCell('O18').value).toBe('S1'); expect(sheet.getCell('F15').value).toBe(60); expect(sheet.getCell('B16').value).toBe(12);
      expect(sheet.getImages().map((entry) => [entry.range.tl.nativeCol, entry.range.tl.nativeRow])).toEqual([[15, 17]]);
      expect(request).not.toHaveBeenCalled(); expect(source).toEqual(before);
    } finally { request.mockRestore(); }
  });

  it('defaults a mixed box containing 300 actual units to its representative product carton size of 500', async () => {
    const source = v2Data(), member = source.members[0]!;
    member.shipment.data.items[0]!.quantity = '200'; member.shipment.data.items[1]!.quantity = '100';
    member.physical!.snapshot.source.boxes[0]!.items[0]!.quantity = '200'; member.physical!.snapshot.source.boxes[0]!.items[1]!.quantity = '100';
    const issues = validateWorkbookData(source);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_MIXED_CARTON', severity: 'warning', message: expect.stringContaining('导出后手动') }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_CARTON_QUANTITY_DIFFERENCE', severity: 'warning', message: expect.stringContaining('500 与全箱实际数量 300') }));
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(book.worksheets[0]!.getCell('J18').value).toBe(500); expect(book.worksheets[0]!.getCell('F15').value).toBe(300);
  });

  it.each([null, '', '0', '-1', '1.5', '500.0', '9007199254740992'])('falls back to all actual products when carton size %s is not a safe positive integer', (quantity) => {
    const source = v2Data(); source.productSourceFacts![0]!.cartonQuantity = quantity;
    const issues = validateWorkbookData(source);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_CARTON_QUANTITY_FALLBACK', severity: 'warning' }));
    expect(issues.some((issue) => issue.code === 'DOCUMENT_CARTON_QUANTITY_DIFFERENCE')).toBe(false);
    expect(projectDocumentLines(source).lines[0]).toMatchObject({ actualQuantity: '5', declaredQuantity: '5' });
  });

  it('keeps one row per actual box when PO differs and one separate range per FBA', async () => {
    const source = v2Data(2), extra = v2Data(2).members[0]!;
    source.members[0]!.physical!.snapshot.source.boxes[1]!.po = 'OTHER-PO';
    extra.demand.snapshot.fba = 'FBAOTHER'; extra.shipment.data.fba = 'FBAOTHER';
    extra.physical!.snapshot.source.boxes.forEach((box) => { box.fba = 'FBAOTHER'; box.items.reverse(); });
    source.members.push(extra);
    const projection = projectDocumentLines(source);
    expect(projection.lines.map((line) => line.range)).toEqual(['FBATESTU000001', 'FBATESTU000002', 'FBAOTHERU000001-2']);
    expect(projection.lines.map((line) => line.product.sku)).toEqual(['S1', 'S1', 'S1']);
    expect(projection).toMatchObject({ boxCount: 4, totalQuantity: '20', totalWeight: '5.00' });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    const sheet = book.worksheets[0]!;
    expect(sheet.rowCount).toBe(20); expect(sheet.getImages()).toHaveLength(3);
    expect([sheet.getCell('J18').value, sheet.getCell('J19').value, sheet.getCell('J20').value]).toEqual([500, 500, 500]);
    expect(sheet.getCell('F15').value).toBe(20); expect(sheet.getCell('B16').value).toBe(4);
  });

  it('validates declaration fields only for representatives while retaining every source product quantity check', () => {
    const source = v2Data(); source.profileReferences.pop(); source.productSourceFacts!.pop();
    expect(validateWorkbookData(source).filter((issue) => issue.severity === 'error')).toEqual([]);
    source.members[0]!.physical!.snapshot.source.boxes[0]!.items[1]!.quantity = '4';
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'QUANTITY_MISMATCH', message: expect.stringContaining('S2') }));
    expect(validateWorkbookData(source).some((issue) => issue.code === 'DECLARATION_REQUIRED')).toBe(false);
    delete source.profileReferences[0]!.data.material;
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DECLARATION_REQUIRED', message: expect.stringContaining('material') }));
  });

  it('renders an audited missing-price fallback at 20% without altering remote facts or actual totals', async () => {
    const source = withManualSalesPrice(v2Data()); source.productSourceFacts![0]!.salesPrice = null; source.productSourceFacts![0]!.currency = null;
    const facts = structuredClone(source.productSourceFacts), errors = validateWorkbookData(source).filter((issue) => issue.severity === 'error');
    expect(errors).toEqual([]); expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_MANUAL_SALES_PRICE_USED', severity: 'warning' }));
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(book.worksheets[0]!.getCell('I18').value).toBe(2.48); expect(book.worksheets[0]!.getCell('F12').value).toBe('美元'); expect(book.worksheets[0]!.getCell('F15').value).toBe(5);
    expect(source.productSourceFacts).toEqual(facts);
  });
  it('uses a newly available remote price over manual fallback and still blocks a remote currency conflict', () => {
    const source = withManualSalesPrice(v2Data()); source.productSourceFacts![0]!.salesPrice = '20';
    expect(projectDocumentLines(source).lines[0]!.declaration.unitPrice).toBe('4.00');
    expect(validateWorkbookData(source).some((issue) => issue.code === 'DOCUMENT_MANUAL_SALES_PRICE_USED')).toBe(false);
    source.productSourceFacts![0]!.currency = 'EUR';
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'CURRENCY_CONFLICT', severity: 'error' }));
  });
  it.each(['source', 'currency', 'identity', 'price'])('blocks a stale/invalid manual %s without reading legacy declaration fields', (kind) => {
    const source = withManualSalesPrice(v2Data()); source.productSourceFacts![0]!.salesPrice = null;
    if (kind === 'source') source.members[0]!.source.demandVersion++;
    if (kind === 'currency') source.members[0]!.demand.snapshot.country = 'GB';
    if (kind === 'identity') source.manualSalesPrices![0]!.fnsku = 'OTHER';
    if (kind === 'price') source.manualSalesPrices![0]!.salesPrice = '0.01';
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DECLARATION_SALES_PRICE_INVALID', severity: 'error' }));
  });
  it.each([null, '', '0', '0.024', '-1', '1e2', '900719925474099100'])('blocks source sales price %s even when legacy/manual/fact prices claim to be usable', async (salesPrice) => {
    const source = v2Data(); source.productSourceFacts![0]!.salesPrice = salesPrice;
    source.productSourceFacts![0]!.unitPrice = '1.25';
    const prefix = `product.${documentProductOverrideKey(12, source.members[0]!.shipment.data.items[0]!)}.`;
    source.fields[prefix + 'unitPrice'] = '10'; source.fields[prefix + 'unitPriceConfirmed'] = 'true';
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DECLARATION_SALES_PRICE_INVALID', severity: 'error' }));
    await expect(createWorkbook(source, await template())).rejects.toThrow('售价缺失或无效');
  });

  it.each(['missing', 'duplicate'])('blocks %s source facts instead of guessing a representative price', (mode) => {
    const source = v2Data();
    if (mode === 'missing') source.productSourceFacts = [];
    else source.productSourceFacts!.push(structuredClone(source.productSourceFacts![0]!));
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DECLARATION_SALES_PRICE_INVALID', severity: 'error' }));
  });

  it.each([null, '', 'CNY'])('blocks an unsupported/missing Listing currency %s instead of inheriting the invoice currency', (currency) => {
    const source = v2Data(); source.productSourceFacts![0]!.currency = currency;
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DECLARATION_CURRENCY_UNSUPPORTED', severity: 'error' }));
  });

  it('blocks a supported Listing currency conflicting with the invoice and ignores old confirmation fields', () => {
    const source = v2Data(); source.productSourceFacts![0]!.currency = 'EUR';
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'CURRENCY_CONFLICT', severity: 'error' }));
    source.fields.currency = 'EUR';
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'CURRENCY_CONFLICT', severity: 'error' }));
    source.members[0]!.demand.snapshot.country = 'DE';
    expect(validateWorkbookData(source).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(reviseDocumentProductFields(v2Data(), source)).toEqual(source.fields);
  });

  it('warns about a missing representative image without warning about hidden products or blocking generation', async () => {
    const source = v2Data(); source.profileReferences.forEach((profile) => { delete profile.data.imageBase64; });
    const issues = validateWorkbookData(source);
    expect(issues.filter((issue) => issue.code === 'PRODUCT_IMAGE_MISSING')).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('S1') })]);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(book.worksheets[0]!.getImages()).toHaveLength(0); expect(book.worksheets[0]!.getCell('P18').value).toBeNull();
  });

  it('retains explicit v1 pricing, product rows and quantity behavior despite carrying newer source facts', async () => {
    const source = v2Data(); source.generationRulesVersion = 'v1';
    expect(validateWorkbookData(source)).toEqual([]);
    expect(projectDocumentLines(source).lines.map((line) => [line.product.sku, line.declaration.unitPrice, line.declaredQuantity])).toEqual([['S1', '1.25', '2'], ['S2', '1.25', '3']]);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(book.worksheets[0]!.getCell('I18').value).toBe(1.25); expect(book.worksheets[0]!.getCell('J18').value).toBe(2); expect(book.worksheets[0]!.getCell('J19').value).toBe(3);
  });

  it('rejects an unknown rule version instead of silently treating it as v1', () => {
    const source = { ...v2Data(), generationRulesVersion: 'future' } as unknown as DocumentRevisionData;
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_GENERATION_RULES_UNSUPPORTED', severity: 'error' }));
    expect(() => projectDocumentLines(source)).toThrow('规则版本无法识别');
  });
});

describe('发票固定留空抬头与国家币种', () => {
  it.each(['v1', 'v2'] as const)('leaves all three retired headers blank for %s despite saved values or template contents, preserving box PO and the source snapshot', async (version) => {
    const source = version === 'v2' ? v2Data() : data(1);
    source.generationRulesVersion = version;
    Object.assign(source.fields, { orderNumber: 'OLD-ORDER', reference: 'OLD-REFERENCE', tradeTerms: 'DDP' });
    source.fields[documentBoxFieldKey(source.members[0]!.shipment.data.boxes[0]!.id, 'po')] = 'BOX-PO-RETAINED';
    const previous = structuredClone(source), templateBook = new ExcelJS.Workbook();
    await templateBook.xlsx.load(await template() as never);
    const original = templateBook.worksheets[0]!;
    original.getCell('B1').value = { formula: '"TEMPLATE-ORDER"', result: 'TEMPLATE-ORDER' };
    original.getCell('F11').value = { richText: [{ text: 'TEMPLATE-REFERENCE' }] };
    original.getCell('F9').value = 'TEMPLATE-TERMS';
    const templateBytes = Buffer.from(await templateBook.xlsx.writeBuffer());
    const clean = new ExcelJS.Workbook(); await clean.xlsx.load(await cleanDocumentTemplate(templateBytes) as never);
    expect(['B1', 'F11', 'F9'].map((address) => clean.worksheets[0]!.getCell(address).value)).toEqual([null, null, null]);
    const output = new ExcelJS.Workbook(); await output.xlsx.load(await createWorkbook(source, templateBytes) as never);
    expect(['B1', 'F11', 'F9'].map((address) => output.worksheets[0]!.getCell(address).value)).toEqual([null, null, null]);
    expect(output.worksheets[0]!.getCell('B18').value).toBe('BOX-PO-RETAINED');
    expect(source).toEqual(previous);
  });

  it.each([
    ['US', 'USD', '美元'], ['GB', 'GBP', '英镑'], ['UK', 'GBP', '英镑'],
    ['DE', 'EUR', '欧元'], ['FR', 'EUR', '欧元'], ['ES', 'EUR', '欧元'], ['IT', 'EUR', '欧元'],
    [' 美国 ', 'USD', '美元'], ['United States', 'USD', '美元'], ['英国', 'GBP', '英镑'],
    [' de ', 'EUR', '欧元'], ['法国', 'EUR', '欧元'], ['西班牙', 'EUR', '欧元'], ['意大利', 'EUR', '欧元'],
  ])('derives %s shipment currency as %s instead of trusting an old header or final address country', async (country, currency, label) => {
    const source = data(1); source.members[0]!.demand.snapshot.country = country!;
    source.fields.currency = 'CNY'; source.fields.countryCode = 'CA';
    source.profileReferences.forEach((profile) => { delete profile.data.currency; });
    const previous = structuredClone(source);
    expect(validateWorkbookData(source)).toEqual([]);
    expect(projectDocumentLines(source).lines.every((line) => line.declaration.currency === currency)).toBe(true);
    const output = new ExcelJS.Workbook(); await output.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(output.worksheets[0]!.getCell('F12').value).toBe(label);
    expect(output.worksheets[0]!.getCell('I18').value).toBe(1.25);
    expect(source).toEqual(previous);
  });

  it('derives EUR for a multi-country ticket when every member country uses EUR', async () => {
    const source = data(1), extra = data(1).members[0]!;
    source.members[0]!.demand.snapshot.country = 'DE'; extra.demand.snapshot.country = 'FR'; source.members.push(extra);
    source.fields.currency = 'USD'; source.profileReferences.forEach((profile) => { delete profile.data.currency; });
    expect(validateWorkbookData(source)).toEqual([]);
    expect(projectDocumentLines(source).lines.map((line) => line.declaration.currency)).toEqual(['EUR', 'EUR', 'EUR', 'EUR']);
    const output = new ExcelJS.Workbook(); await output.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(output.worksheets[0]!.getCell('F12').value).toBe('欧元');
  });

  it.each([['US', 'UK'], ['US', 'DE'], ['GB', 'IT']])('rejects a %s/%s ticket with different country currencies without converting or mutating it', async (first, second) => {
    const source = data(1), extra = data(1).members[0]!;
    source.members[0]!.demand.snapshot.country = first!; extra.demand.snapshot.country = second!; source.members.push(extra);
    const previous = structuredClone(source);
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_TICKET_CURRENCY_CONFLICT', severity: 'error', message: expect.stringContaining('按币种拆分') }));
    expect(() => projectDocumentLines(source)).toThrow('系统不自动换汇');
    await expect(createWorkbook(source, await template())).rejects.toThrow('按币种拆分');
    expect(source).toEqual(previous);
  });

  it('retains manual currency fallback for a country without a configured mapping', async () => {
    const source = data(1); source.members[0]!.demand.snapshot.country = 'CA'; source.fields.currency = 'GBP';
    source.profileReferences.forEach((profile) => { delete profile.data.currency; });
    const previous = structuredClone(source);
    expect(validateWorkbookData(source)).toEqual([]);
    const output = new ExcelJS.Workbook(); await output.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(output.worksheets[0]!.getCell('F12').value).toBe('英镑'); expect(source).toEqual(previous);
  });

  it('uses the country currency for v2 while retaining the archived Listing price and currency', async () => {
    const source = v2Data(); source.fields.currency = 'EUR'; const previous = structuredClone(source);
    expect(validateWorkbookData(source).filter((issue) => issue.severity === 'error')).toEqual([]);
    const output = new ExcelJS.Workbook(); await output.xlsx.load(await createWorkbook(source, await template()) as never);
    expect(output.worksheets[0]!.getCell('F12').value).toBe('美元'); expect(output.worksheets[0]!.getCell('I18').value).toBe(2);
    expect(source).toEqual(previous);
  });

  it.each([['US', 'EUR'], ['GB', 'USD'], ['DE', 'GBP']])('blocks archived Listing currency %s/%s conflicts even when the old header matches the fact', async (country, currency) => {
    const source = v2Data(); source.members[0]!.demand.snapshot.country = country!;
    source.productSourceFacts![0]!.currency = currency!; source.fields.currency = currency!;
    const previous = structuredClone(source);
    expect(validateWorkbookData(source)).toContainEqual(expect.objectContaining({ code: 'CURRENCY_CONFLICT', severity: 'error' }));
    expect(projectDocumentLines(source).lines[0]!.declaration).toMatchObject({ currency, unitPrice: '2.00' });
    await expect(createWorkbook(source, await template())).rejects.toThrow('申报币种与单票币种不一致');
    expect(source).toEqual(previous);
  });
});
