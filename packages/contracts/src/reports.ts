import { z } from 'zod';

export const reportRegionSchema = z.enum(['all', 'US', 'EU']);
export const reportReferenceSchema = z.object({ groupId: z.uuid(), groupVersion: z.number().int().positive(), confirmationId: z.uuid() });
export const reportBoxQuantitySchema = z.object({ boxId: z.uuid(), boxOrder: z.number().int().positive(), displayBoxOrder: z.number().int().positive().optional(), code: z.string(), quantity: z.number().int().nonnegative() });
const shippingTicketFields = {
  shippingRunId: z.uuid().optional(), shippingMonth:z.string().optional(), shippingRunSequence:z.number().int().positive().optional(), ticketId: z.uuid().optional(), ticketNumber: z.string().optional(),
  sourceTicketIndex: z.number().int().nonnegative().optional(), inputOrder: z.number().int().nonnegative().optional(),
};
export const reportRowSchema = z.object({
  ...shippingTicketFields, demandId: z.uuid().optional(),
  id: z.string(), groupId: z.uuid(), groupName: z.string(), confirmationId: z.uuid(),
  weekStartDate: z.string(), weekEndDate: z.string(), businessDate: z.string(), sid: z.number().int().positive(),
  shop: z.string(), country: z.string(), channel: z.string(), destinationFc: z.string().nullable(), fba: z.string(),
  msku: z.string(), fnsku: z.string(), sku: z.string(), productName: z.string(), quantity: z.number().int().nonnegative(),
  boxes: z.array(reportBoxQuantitySchema), codes: z.array(z.string()), groupQuantity: z.number().int().nonnegative(),
  monthQuantity: z.number().int().nonnegative(), status: z.string(), actualShipDate: z.string().nullable(),
  sourceObservedAt: z.string(), dataRevisionId: z.uuid(),
});
export const reportBoxSchema = z.object({
  ...shippingTicketFields,
  groupId: z.uuid(), groupName: z.string(), confirmationId: z.uuid(), demandId: z.uuid(), fba: z.string(), sid: z.number().int().positive(),
  boxId: z.uuid(), boxOrder: z.number().int().positive(), displayBoxOrder: z.number().int().positive().optional(), code: z.string(), boxName: z.string().nullable(),
  boxExternalId: z.string().nullable(), localBoxId: z.string().nullable(), weight: z.number().nullable(), weightUnit: z.string().nullable(),
  length: z.number().nullable(), width: z.number().nullable(), height: z.number().nullable(), lengthUnit: z.string().nullable(),
  items: z.array(z.object({ msku: z.string(), fnsku: z.string(), sku: z.string(), quantity: z.number().int().nonnegative() })),
});
export const reportResponseSchema = z.object({
  shippingRunId: z.uuid().optional(), shippingRunVersion: z.number().int().positive().optional(),
  shippingRunDate: z.iso.date().optional(), shippingRunSequence: z.number().int().positive().optional(),
  rows: z.array(reportRowSchema), boxes: z.array(reportBoxSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(),
  pageSize: z.number().int().positive(), maxBoxes: z.number().int().nonnegative(), confirmations: z.array(reportReferenceSchema),
  blocked: z.array(z.object({ groupId: z.uuid(), name: z.string(), code: z.string(), message: z.string() })),
  generatedAt: z.string(),
});
export const reportExportInputSchema = z.object({
  operationId: z.uuid(), groupIds: z.array(z.uuid()).min(1).max(1000),
  expectedConfirmations: z.array(reportReferenceSchema).min(1).max(1000),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), region: reportRegionSchema.default('all'),
  shippingRunId: z.uuid().optional(), expectedShippingRunVersion: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.shippingRunId) !== (value.expectedShippingRunVersion !== undefined)) context.addIssue({ code: 'custom', path: ['expectedShippingRunVersion'], message: '整次发货导出须同时提供发货次编号及版本。' });
  if (value.shippingRunId && (value.month || value.region !== 'all')) context.addIssue({ code: 'custom', path: ['shippingRunId'], message: '整次发货导出须包含本次全部票，不能按月或区域裁剪。' });
});
export const reportExportRecordSchema = z.object({
  shippingRunId: z.uuid().optional(), shippingRunVersion: z.number().int().positive().optional(),
  id: z.uuid(), status: z.enum(['queued', 'running', 'completed', 'failed', 'stale']), groupIds: z.array(z.uuid()),
  references: z.array(reportReferenceSchema), month: z.string().nullable(), region: reportRegionSchema,
  fileId: z.uuid().nullable(), error: z.string().nullable(), createdAt: z.string(), completedAt: z.string().nullable(),
  rowCount: z.number().int().nonnegative(), boxCount: z.number().int().nonnegative(),
  valid: z.boolean(), invalidReason: z.string().nullable(),
});
export type ShipmentReportRow = z.infer<typeof reportRowSchema>;
export type ShipmentReportBox = z.infer<typeof reportBoxSchema>;
export type ShipmentReport = z.infer<typeof reportResponseSchema>;
export type ReportReference = z.infer<typeof reportReferenceSchema>;
export type ReportExportInput = z.infer<typeof reportExportInputSchema>;
export type ReportExportRecord = z.infer<typeof reportExportRecordSchema>;
