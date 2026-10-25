import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { CUSTOMS_SHEETS, customsDataSchema, logisticsDataSchema, type DocumentMemberSnapshot, type WorkflowContext, type WorkflowExport, type WorkflowRecord } from '@scm/contracts';
import { customsContentFingerprint, suggestCustomsGroups, validateCustomsContent } from './domain.js';
import { customsPolicy } from './policy.js';
import { cleanCustomsTemplate, createCustomsTemplate, createCustomsWorkbook, createFiling9810Checklist } from './workbook.js';

const at = '2026-10-19T00:00:00.000Z';
function fixture(boxCount = 2) {
  const demandId = randomUUID(), groupId = randomUUID(), shipmentId = randomUUID(), confirmationId = randomUUID();
  const boxes = Array.from({ length: boxCount }, (_, index) => ({ id: randomUUID(), externalBoxId: String(index), packageId: null, localBoxId: String(index + 1), name: `B${index + 1}`, order: index + 1, items: [{ msku: 'M1', fnsku: 'F1', sku: 'S1', quantity: '2' }] }));
  const member: DocumentMemberSnapshot = {
    source: { weekStartDate: '2026-10-19', groupId, groupVersion: 1, m2ConfirmationId: confirmationId, demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: randomUUID(), m3Version: 1, sourceFingerprint: 'synthetic' },
    demand: { id: demandId, version: 1, businessDate: '2026-10-19', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', snapshot: { sid: 12, shop: '合成店铺', fba: 'FBA-SYNTHETIC', country: 'US', channel: 'TEST', destinationFc: 'TEST', referenceQuantity: null, notes: null, subBatchName: null }, createdAt: at, updatedAt: at },
    shipment: { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: 12, fba: 'FBA-SYNTHETIC', items: [{ msku: 'M1', fnsku: 'F1', sku: 'S1', quantity: String(boxCount * 2), name: '合成商品' }], boxes, observedAt: at, issues: [] }, source: 'manual', snapshotIds: [], reason: 'synthetic', createdBy: 'admin', createdAt: at },
    codes: boxes.map((box) => ({ id: randomUUID(), groupId, demandId, boxId: box.id, prefix: 'A', sequence: box.order, code: `A${box.order}`, valid: true, createdAt: at })), physical: null,
  };
  const data = customsDataSchema.parse({ entity: '合成主体', countryCodes: ['US'], currency: 'USD', freightAmount: '0', freightCurrency: 'CNY', exportDate: '2026-10-22', contractNumber: 'TEST-CONTRACT', invoiceNumber: 'TEST-INVOICE', sellerName: '合成卖方', sellerAddress: '合成地址一', buyerName: 'Synthetic buyer', buyerAddress: 'Synthetic address two', portOfLoading: 'Test loading port', portOfDestination: 'Test destination port', tradeTerms: 'FOB', ecommerceOrderNumber: 'TEST-ECOMMERCE',
    lines: boxes.map((box) => ({ boxId: box.id, msku: 'M1', fnsku: 'F1', sku: 'S1', chineseName: '合成商品', englishName: 'Synthetic product', hsCode: '123456', material: '合成材质', use: '测试用途', brand: 'TEST', model: 'MODEL-1', quantity: '2', declaredQuantity: '2', unit: 'PCS', unitPrice: '1.25', currency: 'USD' })),
    boxWeights: boxes.map((box) => ({ boxId: box.id, grossWeight: '2.5', netWeight: '2', confirmed: true })),
  });
  const record: WorkflowRecord = { id: randomUUID(), kind: 'customs', title: '合成报关组', status: 'draft', version: 1, source: { documentId: randomUUID(), documentRevisionId: randomUUID(), documentVersion: 1, exportId: randomUUID(), fileId: randomUUID(), fileSha256: '0'.repeat(64), title: '合成M4', weekStartDate: '2026-10-19', fields: {}, members: [member] }, boxIds: boxes.map((box) => box.id), data, createdBy: 'admin', createdAt: at, updatedAt: at };
  const logistics: WorkflowRecord = { ...record, id: randomUUID(), kind: 'logistics', title: '合成物流', status: 'accepted', data: logisticsDataSchema.parse({ logisticsOrderNo: 'TEST-LOGISTICS', receipt: { status: 'accepted' }, boxes: boxes.map((box) => ({ boxId: box.id, grossWeightKg: '2.5', chargeableWeightKg: '3' })) }) };
  const context: WorkflowContext = { records: [logistics], files: [], exports: [], sourceValid: true, sourceInvalidReason: null };
  return { record, context, data, boxes, logistics };
}
function exported(record: WorkflowRecord, context: WorkflowContext, purpose = 'customs-package'): WorkflowExport {
  return { id: randomUUID(), recordId: record.id, version: record.version, purpose, status: 'completed', fileId: randomUUID(), fileSha256: 'a'.repeat(64), name: 'synthetic.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', error: null, dependencyHash: customsContentFingerprint(record, context, purpose), createdAt: at, completedAt: at };
}

describe('M7 报关与 9810', () => {
  it('keeps early drafts while formal generation requires accepted logistics and verified weights', () => {
    const { record, context } = fixture(); context.records = [];
    expect(customsPolicy.evaluate(record, context, 'save').status).toBe('draft');
    expect(customsPolicy.evaluate(record, context, 'export:customs-package').issues).toContainEqual(expect.objectContaining({ code: 'CUSTOMS_LOGISTICS_REQUIRED', severity: 'error' }));
  });
  it('validates exact per-box quantities, units, net weights and independent freight currency without conflating zero and missing', () => {
    const { record, context, data } = fixture(); expect(validateCustomsContent(record, context)).toEqual([]);
    data.lines[0]!.declaredQuantity = '1'; expect(validateCustomsContent(record, context).map((issue) => issue.code)).toContain('CUSTOMS_UNIT_CONVERSION');
    data.lines[0]!.conversionConfirmed = true; data.lines[0]!.conversionReason = '人工复核的成套换算'; expect(validateCustomsContent(record, context)).toEqual([]);
    data.boxWeights[0]!.netWeight = '3'; data.lines[0]!.currency = 'EUR'; data.freightAmount = '';
    expect(validateCustomsContent(record, context).map((issue) => issue.code)).toEqual(expect.arrayContaining(['CUSTOMS_WEIGHT_REQUIRED', 'CUSTOMS_PRODUCT_CURRENCY', 'CUSTOMS_FREIGHT_AMOUNT']));
  });
  it('splits default groups by country and requires explicit evidence for cross-country grouping', () => {
    expect(suggestCustomsGroups([{ entity: 'E', country: 'US', declarationMode: '9810', currency: 'USD', boxIds: ['A'] }, { entity: 'E', country: 'FR', declarationMode: '9810', currency: 'USD', boxIds: ['B'] }])).toHaveLength(2);
    const { record, context, data } = fixture(); const foreignMember = structuredClone(record.source.members[0]!); foreignMember.demand.id = randomUUID(); foreignMember.demand.snapshot.country = 'FR'; foreignMember.shipment.data.boxes = [foreignMember.shipment.data.boxes[1]!]; record.source.members[0]!.shipment.data.boxes.splice(1); record.source.members.push(foreignMember); data.countryCodes.push('FR');
    expect(validateCustomsContent(record, context).map((issue) => issue.code)).toContain('CUSTOMS_CROSS_COUNTRY_CONFIRMATION'); data.crossCountryConfirmation = { confirmed: true, reason: '逐组确认的合并依据' }; expect(validateCustomsContent(record, context)).toEqual([]);
  });
  it('binds reviews to content and logistics, permits a new export after invalidation, and rejects replayed review hashes', () => {
    const { record, context, data, logistics } = fixture(); const result = exported(record, context); context.exports.push(result); data.review = { exportId: result.id, fileSha256: result.fileSha256!, fingerprint: '' };
    expect(customsPolicy.evaluate(record, context, 'review').issues).toEqual([]);
    context.records.push(structuredClone(record));
    record.version++; expect(customsPolicy.evaluate(record, context, 'read').status).toBe('approved');
    logistics.version++; expect(customsPolicy.evaluate(record, context, 'read').status).toBe('stale');
    expect(customsPolicy.evaluate(record, context, 'export:customs-package').issues.some((issue) => issue.severity === 'error')).toBe(false);
    expect(customsPolicy.evaluate(record, context, 'review').issues.map((issue) => issue.code)).toContain('CUSTOMS_REVIEW_EXPORT');
  });
  it('records actual old-version external feedback even after source invalidation without marking the group complete', () => {
    const { record, context, data } = fixture(); const result = exported(record, context); context.exports.push(result); context.records.push(structuredClone(record)); context.sourceValid = false;
    const proof = randomUUID(); context.files.push({ id: proof, recordId: record.id, purpose: 'feedback', name: 'synthetic.pdf', mimeType: 'application/pdf', sha256: 'b'.repeat(64), byteSize: 50 });
    data.customsResult = { status: 'success', externalNumber: 'TEST-EXTERNAL', submittedExportId: result.id, submittedSha256: result.fileSha256!, feedbackFileIds: [proof], reason: '登记实际反馈' };
    expect(customsPolicy.evaluate(record, context, 'record-customs').issues.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(customsPolicy.evaluate(record, context, 'complete').issues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(customsPolicy.evaluate(record, context, 'save').issues.map((issue) => issue.code)).toContain('IMMUTABLE_CUSTOMS_RESULT_ACTION');
  });
  it('does not confuse saved, review passed or applied with confirmed success', () => {
    const { record, context, data } = fixture();
    for (const status of ['saved', 'review_passed', 'applied', 'unknown'] as const) { data.customsResult.status = status; expect(customsPolicy.evaluate(record, context, 'complete').issues.map((issue) => issue.code)).toContain('CUSTOMS_RESULT_PENDING'); }
  });
  it('completes only after both reviewed-package and independent 9810 submissions confirm success', () => {
    const { record, context, data } = fixture(); const reviewed = exported(record, context); context.exports.push(reviewed); data.review = { exportId: reviewed.id, fileSha256: reviewed.fileSha256!, fingerprint: '' };
    const proof = randomUUID(); context.files.push({ id: proof, recordId: record.id, purpose: 'feedback', name: 'feedback.pdf', mimeType: 'application/pdf', sha256: 'b'.repeat(64), byteSize: 100 });
    data.customsResult = { status: 'success', externalNumber: 'TEST-CUSTOMS', feedbackFileIds: [proof], submittedExportId: reviewed.id, submittedSha256: reviewed.fileSha256!, reason: '报关已核对成功' };
    context.records.push(structuredClone(record)); const checklist = exported(record, context, 'filing9810-checklist'); context.exports.push(checklist);
    data.filing9810Result = { status: 'success', externalNumber: 'TEST-9810', feedbackFileIds: [proof], submittedExportId: checklist.id, submittedSha256: checklist.fileSha256!, reason: '9810已核对成功' };
    expect(customsPolicy.evaluate(record, context, 'record-9810').issues).toEqual([]); context.records[1] = structuredClone(record);
    expect(customsPolicy.evaluate(record, context, 'complete')).toEqual(expect.objectContaining({ status: 'complete', issues: [] }));
    data.customsResult.externalNumber = 'TEST-CORRECTION'; expect(customsPolicy.evaluate(record, context, 'read').issues.map((issue) => issue.code)).toContain('CUSTOMS_SUBMISSION_STALE');
  });
  it('does not allow a draft save to approve files or clear old external facts, and releases cancelled draft claims', () => {
    const { record, context, data } = fixture(); const reviewed = exported(record, context); context.exports.push(reviewed); data.review = { exportId: reviewed.id, fileSha256: reviewed.fileSha256!, fingerprint: '' };
    expect(customsPolicy.evaluate(record, context, 'save').issues.map((issue) => issue.code)).toContain('INVALID_CUSTOMS_REVIEW_ACTION');
    data.review = null; expect(customsPolicy.evaluate(record, context, 'cancel').claims).toEqual([]);
  });
  it('rejects stale M6 records even if receipt and weight values remain populated', () => {
    const { record, context, logistics } = fixture(); context.invalidRecordIds = [logistics.id]; expect(validateCustomsContent(record, context).map((issue) => issue.code)).toContain('CUSTOMS_LOGISTICS_REQUIRED');
  });
  it('counts mixed product boxes and weights once while keeping each product declaration', async () => {
    const { record, data, boxes } = fixture(1); const extra = { ...data.lines[0]!, msku: 'M2', fnsku: 'F2', sku: 'S2', unit: 'SET', conversionConfirmed: true, conversionReason: '套装核对', chineseName: '合成商品二' }; data.lines.push(extra); boxes[0]!.items.push({ msku: extra.msku, fnsku: extra.fnsku, sku: extra.sku, quantity: '2' });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await createCustomsWorkbook(record, data) as never); const packing = book.getWorksheet('箱单')!;
    expect(packing.getCell('C10').value).toBe(1); expect(packing.getCell('C11').value).toBe(0); expect(packing.getCell('F10').value).toBe(2.5); expect(packing.getCell('F11').value).toBe(0); expect(packing.getCell('D26').value).toBe('分单位见明细');
  });
  it('retains the sample seven-sheet layouts, reconciles mixed-box weights once and supports many boxes by product aggregation', async () => {
    const { record, data } = fixture(40); const bytes = await createCustomsWorkbook(record, data); const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual([...CUSTOMS_SHEETS]);
    expect(book.getWorksheet('报关单')!.getCell('E12').value).toBe(40); expect(book.getWorksheet('报关单')!.getCell('F12').value).toBe(100);
    expect(book.getWorksheet('发票')!.getCell('D8').value).toBe(80); expect(book.getWorksheet('发票')!.getCell('H24').value).toEqual({ formula: 'SUM(H8:H23)', result: 100 });
    expect(book.getWorksheet('箱单')!.getCell('F26').value).toEqual({ formula: 'SUM(F10:F25)', result: 100 }); expect(book.getWorksheet('合同')!.getCell('C2').value).toBe(data.sellerName);
    expect(book.getWorksheet('报关单')!.pageSetup.printArea).toBe('A1:S22'); expect(book.getWorksheet('委托书')!.getCell('C21').isMerged).toBe(true);
  });
  it('cleans all historical values, formulas, images and extra sheets while keeping supported widths and static labels', async () => {
    const source = new ExcelJS.Workbook(); await source.xlsx.load(await createCustomsTemplate() as never);
    source.getWorksheet('发票')!.getCell('C3').value = 'PRIVATE-CUSTOMER'; source.getWorksheet('发票')!.getCell('H8').value = { formula: '1+1', result: 2 }; source.getWorksheet('发票')!.getColumn(3).width = 24;
    source.addWorksheet('客户历史').getCell('A1').value = 'PRIVATE-HISTORY';
    const clean = new ExcelJS.Workbook(); await clean.xlsx.load(await cleanCustomsTemplate(Buffer.from(await source.xlsx.writeBuffer())) as never);
    expect(clean.worksheets.map((sheet) => sheet.name)).toEqual([...CUSTOMS_SHEETS]); expect(clean.getWorksheet('发票')!.getCell('C3').value).toBeNull(); expect(clean.getWorksheet('发票')!.getCell('H8').value).toBeNull(); expect(clean.getWorksheet('发票')!.getColumn(3).width).toBe(24); expect(clean.getWorksheet('发票')!.getCell('A1').text).toContain('INVOICE');
  });
  it('renders a separate manual 9810 checklist with ecommerce and reviewed-file references', async () => {
    const { record, data } = fixture(); const book = new ExcelJS.Workbook(); await book.xlsx.load(await createFiling9810Checklist(record, data) as never); expect(book.worksheets).toHaveLength(1); expect(book.worksheets[0]!.getCell('B10').value).toBe('TEST-ECOMMERCE');
  });
});
