import { z } from 'zod';
import { documentMemberSnapshotSchema } from './documents.js';
import { documentBoxes } from './document-boxes.js';

export const workflowKindSchema = z.enum(['fulfillment', 'logistics', 'customs', 'finance', 'archive']);
export type WorkflowKind = z.infer<typeof workflowKindSchema>;
export const workflowIssueSchema = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string(), boxId: z.string().optional() });
export type WorkflowIssue = z.infer<typeof workflowIssueSchema>;
export const workflowSourceSchema = z.object({
  documentId: z.uuid(), documentRevisionId: z.uuid(), documentVersion: z.number().int().positive(),
  exportId: z.uuid(), fileId: z.uuid(), fileSha256: z.string().regex(/^[a-f0-9]{64}$/), title: z.string(), weekStartDate: z.iso.date(),
  shippingRunId: z.uuid().optional(), shippingRunMonth: z.string().optional(), shippingRunSequence: z.number().int().positive().nullable().optional(),
  fields: z.record(z.string(), z.string().nullable()), members: z.array(documentMemberSnapshotSchema).min(1),
});
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;
export const workflowRecordSchema = z.object({
  id: z.uuid(), kind: workflowKindSchema, title: z.string(), status: z.string(), version: z.number().int().positive(),
  source: workflowSourceSchema, boxIds: z.array(z.uuid()), data: z.record(z.string(), z.unknown()),
  createdBy: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type WorkflowRecord = z.infer<typeof workflowRecordSchema>;
export const workflowFileSchema = z.object({ id: z.uuid(), recordId: z.uuid(), purpose: z.string(), name: z.string(), mimeType: z.string(), sha256: z.string(), byteSize: z.number().int().positive() });
export type WorkflowFile = z.infer<typeof workflowFileSchema>;
export const workflowExportSchema = z.object({ id: z.uuid(), recordId: z.uuid(), version: z.number().int().positive(), purpose: z.string(), status: z.enum(['queued', 'running', 'completed', 'failed', 'stale']), fileId: z.uuid().nullable(), fileSha256: z.string().nullable(), name: z.string().nullable(), mimeType: z.string().nullable(), error: z.string().nullable(), dependencyHash: z.string(), valid: z.boolean().optional(), invalidReason: z.string().nullable().optional(), createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable() });
export type WorkflowExport = z.infer<typeof workflowExportSchema>;
export const workflowContextSchema = z.object({ records: z.array(workflowRecordSchema), files: z.array(workflowFileSchema), exports: z.array(workflowExportSchema), sourceValid: z.boolean(), sourceInvalidReason: z.string().nullable(), invalidRecordIds: z.array(z.uuid()).optional() });
export type WorkflowContext = z.infer<typeof workflowContextSchema>;
export const workflowHistorySchema = z.object({ id: z.uuid(), version: z.number().int().positive(), action: z.string(), reason: z.string(), record: workflowRecordSchema, createdBy: z.string(), createdAt: z.iso.datetime() });
export const workflowDetailSchema = z.object({ record: workflowRecordSchema, context: workflowContextSchema, issues: z.array(workflowIssueSchema), history: z.array(workflowHistorySchema) });
export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;
export const workflowListSchema = z.object({ items: z.array(workflowRecordSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() });
export const workflowWriteSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive().optional(), sourceDocumentId: z.uuid().optional(), title: z.string().trim().min(1).max(200), boxIds: z.array(z.uuid()).min(1).max(5000), data: z.record(z.string(), z.unknown()), action: z.string().trim().min(1).max(60).default('save'), reason: z.string().trim().min(1).max(1000).default('保存资料') }).strict();
export type WorkflowWrite = z.infer<typeof workflowWriteSchema>;
export const workflowListQuerySchema = z.object({ q: z.string().trim().max(200).optional(), status: z.string().max(80).optional(), groupId: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const workflowExportInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), purpose: z.string().min(1).max(60) }).strict();
/** Downstream preparation uses the exact carton values adopted by the invoice. */
export const workflowBoxes = (source: WorkflowSource) => source.members.flatMap((member) => {
  const adopted = new Map(documentBoxes(member, source.fields).map((box) => [box.boxId, box]));
  return member.shipment.data.boxes.map((box) => {
    const values = adopted.get(box.id);
    return { ...box, ...(values ? { ...values.values, weightUnit: 'KG', dimensionUnit: 'CM' } : {}), po: values?.po ?? null,
      groupId: member.source.groupId, demandId: member.demand.id, sid: member.demand.snapshot.sid, fba: member.demand.snapshot.fba,
      country: member.demand.snapshot.country, channel: member.demand.snapshot.channel, code: member.codes.find((code) => code.boxId === box.id)?.code ?? '', member };
  });
});
