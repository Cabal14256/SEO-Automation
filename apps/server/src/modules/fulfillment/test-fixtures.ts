import { randomUUID } from 'node:crypto';
import { fulfillmentDataSchema, logisticsDataSchema, type DocumentMemberSnapshot, type WorkflowContext, type WorkflowFile, type WorkflowRecord, type WorkflowSource } from '@scm/contracts';
import { fulfillmentPreparation } from './domain.js';

export function workflowFixture() {
  const at = '2026-10-22T02:00:00.000Z', boxIds = [randomUUID(), randomUUID()], demandId = randomUUID(), groupId = randomUUID();
  const member = {
    source: { groupId, demandId }, demand: { id: demandId, snapshot: { sid: 1, fba: 'FBA-SYNTHETIC', country: 'US', channel: 'TEST' } },
    shipment: { data: { boxes: boxIds.map((id, index) => ({ id, items: [{ msku: 'M', fnsku: 'F', sku: 'S', quantity: String(index + 1) }] })) } }, codes: [],
  } as unknown as DocumentMemberSnapshot;
  const source: WorkflowSource = { documentId: randomUUID(), documentRevisionId: randomUUID(), documentVersion: 1, exportId: randomUUID(), fileId: randomUUID(), fileSha256: 'a'.repeat(64), title: 'Synthetic M4', weekStartDate: '2026-10-19', fields: {}, members: [member] };
  const preparation: WorkflowRecord = { id: randomUUID(), kind: 'fulfillment', title: 'Synthetic M5', version: 1, status: 'draft', source, boxIds, data: {}, createdBy: 'test', createdAt: at, updatedAt: at };
  const evidence: WorkflowFile = { id: randomUUID(), recordId: preparation.id, purpose: 'evidence', name: 'synthetic.pdf', mimeType: 'application/pdf', sha256: 'b'.repeat(64), byteSize: 100 };
  preparation.data = fulfillmentDataSchema.parse({ warehouseCode: 'W1', logistics: 'TEST', lines: fulfillmentPreparation(preparation), materials: [{ sku: 'TAPE', quantity: '2', scope: 'shipment' }] });
  const context: WorkflowContext = { records: [], files: [evidence], exports: [], sourceValid: true, sourceInvalidReason: null };
  return { preparation, source, boxIds, evidence, context, at };
}
export function allocatedFixture() {
  const fixture = workflowFixture(), data = fulfillmentDataSchema.parse(fixture.preparation.data);
  data.externalOrders = fixture.boxIds.map((boxId, index) => ({ externalOrderNo: `LX-${index + 1}`, warehouseCode: data.warehouseCode, status: 'allocated' as const, lines: data.lines.filter((line) => line.boxId === boxId), materials: index === 0 ? data.materials : [], evidenceFileId: fixture.evidence.id, shortageReason: '' }));
  fixture.preparation.data = data; fixture.preparation.status = 'complete';
  fixture.context.records.push(fixture.preparation);
  return fixture;
}
export function logisticsFixture() {
  const fixture = allocatedFixture();
  const logistics: WorkflowRecord = { ...structuredClone(fixture.preparation), id: randomUUID(), kind: 'logistics', title: 'Synthetic M6', status: 'accepted', data: {} };
  const evidence: WorkflowFile = { ...fixture.evidence, id: randomUUID(), recordId: logistics.id };
  fixture.context.files.push(evidence);
  logistics.data = logisticsDataSchema.parse({ fulfillmentIds: [fixture.preparation.id], logisticsOrderNo: 'LOG-1', trackingNo: 'TRACK-1', submission: { exportId: fixture.source.exportId, fileSha256: fixture.source.fileSha256, submittedAt: fixture.at }, receipt: { status: 'accepted', evidenceFileId: evidence.id }, outboundReview: { passed: true, checkedAt: fixture.at, checkedBy: 'Synthetic reviewer', evidenceFileId: evidence.id }, boxes: fixture.boxIds.map((boxId, index) => ({ boxId, labelFileId: evidence.id, labelReference: `LABEL-${index + 1}`, grossWeightKg: '1.25', chargeableWeightKg: '1.50' })) });
  fixture.context.records.push(structuredClone(logistics));
  return { ...fixture, logistics, logisticsEvidence: evidence };
}
