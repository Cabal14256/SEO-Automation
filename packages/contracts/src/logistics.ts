import { z } from 'zod';

const text = z.string().trim().max(1000);
const weight = z.string().trim().max(40).refine((value) => !value || /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value), '重量必须是非负十进制数');
export const logisticsBoxSchema = z.object({
  boxId: z.uuid(), labelFileId: z.uuid().optional(), labelReference: text.default(''),
  grossWeightKg: weight.default(''), chargeableWeightKg: weight.default(''),
}).strict();
export const logisticsHandoverSchema = z.object({
  id: z.uuid(), boxIds: z.array(z.uuid()).min(1).max(5000), handedOverAt: z.iso.datetime(), receiver: text.min(1),
  evidenceFileId: z.uuid().optional(), exceptionReason: text.default(''),
}).strict();
export const logisticsLingxingResultSchema = z.object({
  boxId: z.uuid(), status: z.enum(['shipped', 'not_shipped', 'unknown']), externalOrderNo: text,
  evidenceFileId: z.uuid().optional(),
}).strict();
export const logisticsDataSchema = z.object({
  fulfillmentIds: z.array(z.uuid()).max(1000).default([]),
  logisticsOrderNo: text.default(''), trackingNo: text.default(''),
  submission: z.object({ exportId: z.uuid(), fileSha256: z.string().regex(/^[a-f0-9]{64}$/), submittedAt: z.iso.datetime() }).strict().optional(),
  receipt: z.object({ status: z.enum(['accepted', 'rejected', 'unknown']), reference: text.default(''), message: text.default(''), evidenceFileId: z.uuid().optional() }).strict().optional(),
  outboundReview: z.object({ passed: z.boolean(), checkedAt: z.iso.datetime(), checkedBy: text.optional(), evidenceFileId: z.uuid().optional(), note: text.default('') }).strict().optional(),
  boxes: z.array(logisticsBoxSchema).max(5000).default([]),
  handovers: z.array(logisticsHandoverSchema).max(5000).default([]),
  lingxingResults: z.array(logisticsLingxingResultSchema).max(5000).default([]),
}).strict();
export const logisticsActionSchema = z.enum(['save', 'submit', 'record_receipt', 'release', 'handover', 'record_lingxing', 'cancel']);
export type LogisticsData = z.infer<typeof logisticsDataSchema>;
export type LogisticsHandover = z.infer<typeof logisticsHandoverSchema>;
