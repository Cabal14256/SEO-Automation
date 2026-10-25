import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { archiveDataSchema, financeDataSchema, financeLineSchema, type WorkflowRecord } from '@scm/contracts';
import { allocatedFixture } from '../fulfillment/test-fixtures.js';
import { evaluateFinance, allocationTotals } from './domain.js';
import { evaluateArchive } from './archive.js';
import { financeImportTemplate, parseFinanceWorkbook, FINANCE_IMPORT_HEADERS } from './workbook.js';

function fixture() {
  const f = allocatedFixture(), record: WorkflowRecord = { ...structuredClone(f.preparation), id: randomUUID(), kind: 'finance', status: 'draft', title: 'Synthetic bill', data: {} };
  const bill = { ...f.evidence, id: randomUUID(), recordId: record.id }, feedback = { ...bill, id: randomUUID() };
  const data = financeDataSchema.parse({ billNumber: 'BILL-TEST', provider: 'Synthetic provider', billFileId: bill.id, lines: [{ id: randomUUID(), description: 'Combined freight', type: 'freight', nature: 'actual', amount: '0.30', currency: 'USD', boxIds: f.boxIds, allocations: [{ fulfillmentId: f.preparation.id, externalOrderNo: 'LX-1', amount: '0.10' }, { fulfillmentId: f.preparation.id, externalOrderNo: 'LX-2', amount: '0.20' }] }] });
  record.data = data; f.context.files.push(bill, feedback);
  return { ...f, record, data, bill, feedback };
}
describe('M8 explicit allocation and reconciliation', () => {
  it('uses exact decimals and separates each actual external order', () => {
    const f = fixture(), result = evaluateFinance(f.record, f.context, 'confirm');
    expect(result.issues).toEqual([]); expect(result.status).toBe('confirmed');
    expect(allocationTotals(f.data).map((row) => [row.externalOrderNo, row.amount])).toEqual([['LX-1', '0.1'], ['LX-2', '0.2']]);
  });
  it('does not absorb an unassigned remainder or infer missing currency', () => {
    const f = fixture(); f.data.lines[0]!.allocations[1]!.amount = '0.19'; f.data.lines[0]!.currency = ''; f.record.data = f.data;
    expect(evaluateFinance(f.record, f.context, 'confirm').issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['ALLOCATION_NOT_BALANCED', 'CURRENCY_REQUIRED']));
  });
  it('requires the selected actual order to overlap the charged boxes', () => {
    const f = fixture(); f.data.lines[0]!.boxIds = [f.boxIds[0]!]; f.data.lines[0]!.allocations = [{ fulfillmentId: f.preparation.id, externalOrderNo: 'LX-1', amount: '0.1' }, { fulfillmentId: f.preparation.id, externalOrderNo: 'LX-2', amount: '0.2' }]; f.record.data = f.data;
    expect(evaluateFinance(f.record, f.context, 'confirm').issues).toContainEqual(expect.objectContaining({ code: 'ALLOCATION_ORDER_SCOPE_MISMATCH' }));
  });
  it('keeps estimates separate and does not treat blank actual fees as zero', () => {
    const f = fixture(); f.data.lines[0]!.nature = 'estimate'; f.record.data = f.data;
    expect(allocationTotals(f.data)).toEqual([]); expect(evaluateFinance(f.record, f.context, 'confirm').issues).toContainEqual(expect.objectContaining({ code: 'ACTUAL_FEES_REQUIRED' }));
    f.data.lines[0]!.nature = 'actual'; f.data.lines[0]!.amount = '';
    expect(evaluateFinance(f.record, f.context, 'confirm').issues).toContainEqual(expect.objectContaining({ code: 'AMOUNT_REQUIRED' }));
  });
  it('requires original evidence for no-cost confirmation', () => {
    const f = fixture(); f.record.data = financeDataSchema.parse({ zeroCostConfirmed: true, zeroCostReason: 'No charge' });
    expect(evaluateFinance(f.record, f.context, 'confirm').issues).toContainEqual(expect.objectContaining({ code: 'ZERO_COST_EVIDENCE_REQUIRED' }));
    f.record.data = financeDataSchema.parse({ zeroCostConfirmed: true, zeroCostReason: 'No charge', zeroCostEvidenceFileIds: [f.feedback.id] });
    expect(evaluateFinance(f.record, f.context, 'confirm').status).toBe('complete');
  });
  it('only completes after amounts, currencies, types and actual orders have evidence', () => {
    const f = fixture(); f.data.externalResults = allocationTotals(f.data).map((total) => ({ id: randomUUID(), fulfillmentId: total.fulfillmentId, externalOrderNo: total.externalOrderNo, feeType: 'freight', currency: total.currency, beforeAmount: null, expectedAmount: total.amount, afterAmount: total.amount, status: 'verified', evidenceFileIds: [f.feedback.id], recordedAt: f.at, note: 'Checked externally' }));
    f.record.data = f.data; expect(evaluateFinance(f.record, f.context, 'record_result').status).toBe('complete');
    f.data.externalResults[0]!.afterAmount = '0.09'; expect(evaluateFinance(f.record, f.context, 'record_result').status).toBe('pending');
  });
  it('preserves confirmed lines and external facts while refunds reopen reconciliation', () => {
    const f = fixture(); f.record.status = 'confirmed'; f.context.records.push(structuredClone(f.record));
    const changed = structuredClone(f.record), data = financeDataSchema.parse(changed.data); data.lines = []; changed.data = data;
    expect(evaluateFinance(changed, f.context, 'save').issues).toContainEqual(expect.objectContaining({ code: 'IMMUTABLE_CONFIRMED_BILL' }));
    f.data.lines.push(financeLineSchema.parse({ ...f.data.lines[0], id: randomUUID(), nature: 'refund', amount: '-0.05', allocations: [{ fulfillmentId: f.preparation.id, externalOrderNo: 'LX-1', amount: '-0.05' }], boxIds: [f.boxIds[0]] })); f.record.data = f.data;
    expect(evaluateFinance(f.record, f.context, 'settle').issues).toContainEqual(expect.objectContaining({ code: 'FEE_RESULT_PENDING' }));
  });
});
describe('M8 bill import', () => {
  it('groups allocations from the same fee and preserves original amount precision', async () => {
    const f = fixture(), template = await financeImportTemplate(), workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(template.bytes as never);
    const sheet = workbook.getWorksheet('费用导入')!; expect(sheet.getRow(1).values).toEqual([undefined, ...FINANCE_IMPORT_HEADERS]);
    for (const [index, amount] of ['0.10', '0.20'].entries()) sheet.addRow(['Freight', 'freight', 'actual', '0.30', 'USD', f.boxIds.join(','), f.preparation.id, `LX-${index + 1}`, amount]);
    const result = await parseFinanceWorkbook(Buffer.from(await workbook.xlsx.writeBuffer())); expect(result.issues).toEqual([]); expect(result.lines).toHaveLength(1); expect(result.lines[0]!.allocations).toHaveLength(2);
  });
  it('rejects formula values instead of trusting cached results', async () => {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('费用导入'); sheet.addRow(FINANCE_IMPORT_HEADERS); sheet.addRow(['Freight', 'freight', 'actual', { formula: '1+1', result: 2 }, 'USD']);
    const result = await parseFinanceWorkbook(Buffer.from(await workbook.xlsx.writeBuffer())); expect(result.issues).toContainEqual(expect.objectContaining({ code: 'FINANCE_CELL_INVALID' }));
  });
});
describe('M8 archive gates', () => {
  it('does not archive a batch with only a source document', () => {
    const f = fixture(), record: WorkflowRecord = { ...f.record, kind: 'archive', data: archiveDataSchema.parse({ groupId: f.source.members[0]!.source.groupId }) };
    expect(evaluateArchive(record, f.context, 'archive').issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['HANDOVER_PENDING', 'CUSTOMS_PENDING', 'FILING9810_PENDING', 'FINANCE_PENDING']));
  });
  it('does not waive customs requirements without explicit evidence', () => {
    const f = fixture(), record: WorkflowRecord = { ...f.record, kind: 'archive', data: archiveDataSchema.parse({ groupId: f.source.members[0]!.source.groupId, customsNotApplicable: true, filing9810NotApplicable: true }) };
    expect(evaluateArchive(record, f.context, 'archive').issues).toContainEqual(expect.objectContaining({ code: 'NOT_APPLICABLE_EVIDENCE_REQUIRED' }));
  });
});
