import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { fulfillmentDataSchema } from '@scm/contracts';
import { evaluateFulfillment, fulfillmentPolicy } from './domain.js';
import { allocatedFixture, workflowFixture } from './test-fixtures.js';

describe('M5 external read-only reconciliation', () => {
  it('confirms exact M4 preparation without claiming external allocation happened', () => {
    const f = workflowFixture(), result = evaluateFulfillment(f.preparation, f.context, 'confirm');
    expect(result.status).toBe('ready'); expect(result.issues).toEqual([]);
    expect(result.claims).toEqual([{ purpose: 'fulfillment', boxIds: f.boxIds }]);
  });
  it('reconciles several external orders into one preparation scope', () => {
    const f = allocatedFixture(), result = evaluateFulfillment(f.preparation, f.context, 'record_result');
    expect(result.status).toBe('complete'); expect(result.issues).toEqual([]);
  });
  it('records shortages and unknown results without reporting completion', () => {
    const f = allocatedFixture(), data = fulfillmentDataSchema.parse(f.preparation.data);
    data.externalOrders[0]!.status = 'shortage'; data.externalOrders[0]!.shortageReason = 'Stock unavailable';
    data.externalOrders[1]!.status = 'unknown'; f.preparation.data = data;
    const result = evaluateFulfillment(f.preparation, f.context, 'record_result');
    expect(result.status).toBe('pending'); expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });
  it('keeps warehouse, combination, material scope and quantity differences pending', () => {
    const f = allocatedFixture(), data = fulfillmentDataSchema.parse(f.preparation.data);
    data.externalOrders[0]!.warehouseCode = 'OTHER'; data.externalOrders[0]!.lines[0]!.quantity = '3';
    data.externalOrders[0]!.lines[0]!.components = [{ sku: 'CHILD', quantity: '1' }]; data.externalOrders[0]!.materials = [];
    f.preparation.data = data; const result = evaluateFulfillment(f.preparation, f.context, 'record_result');
    expect(result.status).toBe('pending'); expect(result.issues.filter((issue) => issue.code === 'FULFILLMENT_RESULT_MISMATCH')).toHaveLength(4);
  });
  it('rejects missing evidence, duplicate external numbers and foreign box references', () => {
    const f = allocatedFixture(), data = fulfillmentDataSchema.parse(f.preparation.data);
    delete data.externalOrders[0]!.evidenceFileId; data.externalOrders[1]!.externalOrderNo = data.externalOrders[0]!.externalOrderNo;
    data.externalOrders[0]!.lines[0]!.boxId = f.evidence.id; f.preparation.data = data;
    expect(evaluateFulfillment(f.preparation, f.context, 'record_result').issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['FULFILLMENT_RESULT_EVIDENCE_REQUIRED', 'INVALID_DUPLICATE_EXTERNAL_ORDER', 'INVALID_EXTERNAL_LINE_BOX']));
  });
  it('blocks preparation with stale source while preserving externally observed facts', () => {
    const f = allocatedFixture(); f.context.sourceValid = false;
    expect(evaluateFulfillment(f.preparation, f.context, 'confirm').issues).toContainEqual(expect.objectContaining({ code: 'FULFILLMENT_SOURCE_STALE', severity: 'error' }));
    const result = evaluateFulfillment(f.preparation, f.context, 'record_result');
    expect(result.status).toBe('pending'); expect(result.issues).toContainEqual(expect.objectContaining({ code: 'FULFILLMENT_SOURCE_STALE', severity: 'warning' }));
  });
  it('records an actual external order containing an extra known source box as pending', () => {
    const f = allocatedFixture(), data = fulfillmentDataSchema.parse(f.preparation.data);
    f.preparation.boxIds = [f.boxIds[0]!]; data.lines = data.lines.filter((line) => line.boxId === f.boxIds[0]); f.preparation.data = data;
    const result = evaluateFulfillment(f.preparation, f.context, 'record_result');
    expect(result.status).toBe('pending'); expect(result.issues).toContainEqual(expect.objectContaining({ code: 'FULFILLMENT_RESULT_MISMATCH', severity: 'warning' }));
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(false);
  });
  it('preserves old external facts and requires cancellation evidence', () => {
    const f = allocatedFixture(), updated = structuredClone(f.preparation), data = fulfillmentDataSchema.parse(updated.data);
    data.externalOrders = []; updated.data = data;
    expect(evaluateFulfillment(updated, f.context, 'save').issues).toContainEqual(expect.objectContaining({ code: 'IMMUTABLE_EXTERNAL_RESULT' }));
    const cancellation = fulfillmentDataSchema.parse(f.preparation.data); cancellation.externalOrders.forEach((order) => { order.status = 'cancelled'; }); updated.data = cancellation;
    expect(evaluateFulfillment(updated, f.context, 'cancel').issues).toContainEqual(expect.objectContaining({ code: 'FULFILLMENT_CANCEL_EVIDENCE_REQUIRED' }));
    cancellation.externalOrders.forEach((order) => { order.cancelEvidenceFileId = f.evidence.id; }); updated.data = cancellation;
    expect(evaluateFulfillment(updated, f.context, 'cancel').status).toBe('cancelled');
  });
  it('exports a usable workbook with preparation, actual results, materials and open issues', async () => {
    const f = allocatedFixture(), result = await fulfillmentPolicy.render!(f.preparation, f.context, 'reconciliation');
    const book = new ExcelJS.Workbook(); await book.xlsx.load(result.bytes as never);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['准备清单', '外部结果', '辅料', '核对问题']);
    expect(book.getWorksheet('外部结果')!.getCell('A2').value).toBe('LX-1');
  });
});
