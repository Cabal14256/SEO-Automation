import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { logisticsDataSchema } from '@scm/contracts';
import { logisticsFixture } from '../fulfillment/test-fixtures.js';
import { evaluateLogistics } from './domain.js';

describe('M6 release, physical handover and external shipping', () => {
  it('releases only with complete M5, current submitted M4, acceptance, labels and positive weights', () => {
    const f = logisticsFixture(); expect(evaluateLogistics(f.logistics, f.context, 'release')).toMatchObject({ status: 'released', issues: [] });
    const data = logisticsDataSchema.parse(f.logistics.data); data.boxes[0]!.grossWeightKg = ''; delete data.boxes[1]!.labelFileId; f.logistics.data = data;
    expect(evaluateLogistics(f.logistics, f.context, 'release').issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['LOGISTICS_WEIGHT_REQUIRED', 'LOGISTICS_LABEL_REQUIRED']));
  });
  it('accepts file submission before the downstream release checklist exists', () => {
    const f = logisticsFixture(); f.context.records = f.context.records.filter((entry) => entry.id !== f.logistics.id); f.logistics.data = logisticsDataSchema.parse({ submission: { exportId: f.source.exportId, fileSha256: f.source.fileSha256, submittedAt: f.at } });
    const result = evaluateLogistics(f.logistics, f.context, 'submit');
    expect(result.status).toBe('submitted'); expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });
  it('binds submission to the exact M4 export and hash', () => {
    const f = logisticsFixture(), data = logisticsDataSchema.parse(f.logistics.data); data.submission!.fileSha256 = 'c'.repeat(64); f.logistics.data = data;
    expect(evaluateLogistics(f.logistics, f.context, 'submit').issues).toContainEqual(expect.objectContaining({ code: 'LOGISTICS_SUBMISSION_REQUIRED', severity: 'error' }));
  });
  it('blocks duplicate label mappings and preparations whose sources became invalid', () => {
    const f = logisticsFixture(), data = logisticsDataSchema.parse(f.logistics.data);
    data.boxes[1]!.labelReference = data.boxes[0]!.labelReference; f.logistics.data = data; f.context.invalidRecordIds = [f.preparation.id];
    expect(evaluateLogistics(f.logistics, f.context, 'release').issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['INVALID_DUPLICATE_LABEL_REFERENCE', 'LOGISTICS_FULFILLMENT_REQUIRED']));
  });
  it('requires explicit offline outbound review and evidence before release', () => {
    const f = logisticsFixture(), data = logisticsDataSchema.parse(f.logistics.data); delete data.outboundReview; f.logistics.data = data;
    expect(evaluateLogistics(f.logistics, f.context, 'release').issues).toContainEqual(expect.objectContaining({ code: 'LOGISTICS_OUTBOUND_REVIEW_REQUIRED', severity: 'error' }));
    expect(evaluateLogistics(f.logistics, f.context, 'submit').issues).toContainEqual(expect.objectContaining({ code: 'LOGISTICS_OUTBOUND_REVIEW_REQUIRED', severity: 'warning' }));
  });
  it('allows partial handover after release and independently keeps Lingxing shipping pending', () => {
    const f = logisticsFixture(); f.context.records.find((entry) => entry.id === f.logistics.id)!.status = 'released';
    const data = logisticsDataSchema.parse(f.logistics.data); data.handovers.push({ id: randomUUID(), boxIds: [f.boxIds[0]!], handedOverAt: f.at, receiver: 'Synthetic receiver', evidenceFileId: f.logisticsEvidence.id, exceptionReason: '' }); f.logistics.data = data;
    const result = evaluateLogistics(f.logistics, f.context, 'handover');
    expect(result.status).toBe('partial_handover'); expect(result.issues).toContainEqual(expect.objectContaining({ code: 'LOGISTICS_LINGXING_PENDING', boxId: f.boxIds[0] }));
  });
  it('records actual handover on stale or unready data only with an exception reason', () => {
    const f = logisticsFixture(); f.context.sourceValid = false;
    const data = logisticsDataSchema.parse(f.logistics.data); data.handovers.push({ id: randomUUID(), boxIds: f.boxIds, handedOverAt: f.at, receiver: 'Synthetic receiver', evidenceFileId: f.logisticsEvidence.id, exceptionReason: '' }); f.logistics.data = data;
    expect(evaluateLogistics(f.logistics, f.context, 'handover').issues).toContainEqual(expect.objectContaining({ code: 'LOGISTICS_HANDOVER_EXCEPTION_REQUIRED', severity: 'error' }));
    data.handovers[0]!.exceptionReason = 'Actual physical event confirmed'; f.logistics.data = data;
    const result = evaluateLogistics(f.logistics, f.context, 'handover'); expect(result.status).toBe('pending'); expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });
  it('rejects duplicate and out-of-scope handovers and refuses to erase physical facts', () => {
    const f = logisticsFixture(), data = logisticsDataSchema.parse(f.logistics.data);
    data.handovers.push({ id: randomUUID(), boxIds: [f.boxIds[0]!, f.boxIds[0]!, randomUUID()], handedOverAt: f.at, receiver: 'Synthetic receiver', evidenceFileId: f.logisticsEvidence.id, exceptionReason: 'Already handed over' }); f.logistics.data = data;
    expect(evaluateLogistics(f.logistics, f.context, 'handover').issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['INVALID_DUPLICATE_HANDED_BOX', 'INVALID_HANDOVER_BOX']));
    data.handovers[0]!.boxIds = [f.boxIds[0]!]; f.context.records.find((entry) => entry.id === f.logistics.id)!.data = structuredClone(data); f.logistics.data = logisticsDataSchema.parse({});
    expect(evaluateLogistics(f.logistics, f.context, 'save').issues).toContainEqual(expect.objectContaining({ code: 'IMMUTABLE_HANDOVER' }));
  });
  it('requires all physical and external shipment facts before completing', () => {
    const f = logisticsFixture(), data = logisticsDataSchema.parse(f.logistics.data);
    data.handovers.push({ id: randomUUID(), boxIds: f.boxIds, handedOverAt: f.at, receiver: 'Synthetic receiver', evidenceFileId: f.logisticsEvidence.id, exceptionReason: 'Confirmed physical event' });
    data.lingxingResults = f.boxIds.map((boxId, index) => ({ boxId, status: 'shipped', externalOrderNo: `LX-${index + 1}`, evidenceFileId: f.logisticsEvidence.id })); f.logistics.data = data;
    f.context.records.find((entry) => entry.id === f.logistics.id)!.data = structuredClone(data);
    expect(evaluateLogistics(f.logistics, f.context, 'record_lingxing').status).toBe('complete');
    data.lingxingResults[0]!.externalOrderNo = 'DIFFERENT'; f.logistics.data = data;
    expect(evaluateLogistics(f.logistics, f.context, 'record_lingxing').status).toBe('pending');
    expect(evaluateLogistics(f.logistics, f.context, 'cancel').issues).toContainEqual(expect.objectContaining({ code: 'LOGISTICS_CANCEL_PHYSICAL_FACT' }));
  });
});
