import { z } from 'zod';
import { batchIssueSchema, shipmentBoxItemSchema, shippingOccurrenceSchema } from './batches.js';

export const PHYSICAL_RULE_VERSION = 'physical-review/v1';
const nullableText = z.string().nullable();
export const physicalValuesSchema = z.object({ weight: nullableText, length: nullableText, width: nullableText, height: nullableText });
export const physicalRawSchema = physicalValuesSchema.extend({ weightUnit: nullableText, dimensionUnit: nullableText });
export const physicalBoxSchema = z.object({
  demandId: z.uuid(), shipmentRevisionId: z.uuid(), boxId: z.uuid(), sid: z.number().int().positive(), fba: z.string(),
  code: z.string(), order: z.number().int().positive(), po: nullableText, range: z.string(),
  raw: physicalRawSchema, values: physicalValuesSchema, items: z.array(shipmentBoxItemSchema), sourceObservedAt: z.iso.datetime(),
});
export const physicalSourceSchema = z.object({
  id: z.uuid(), groupId: z.uuid(), m2ConfirmationId: z.uuid(), origin: z.enum(['history', 'sync']),
  fingerprint: z.string(), boxes: z.array(physicalBoxSchema), issues: z.array(batchIssueSchema), identityValid: z.boolean(),
  snapshotIds: z.array(z.uuid()), createdBy: z.string(), createdAt: z.iso.datetime(),
});
export const physicalEntrySchema = z.object({
  shipmentRevisionId: z.uuid(), boxId: z.uuid(), status: z.enum(['pending', 'consistent', 'different']),
  measured: z.object({ weight: z.string().optional(), length: z.string().optional(), width: z.string().optional(), height: z.string().optional() }).strict(),
  reason: z.string().trim().max(1000),
}).strict();
export const physicalRevisionSchema = z.object({
  id: z.uuid(), groupId: z.uuid(), m2ConfirmationId: z.uuid(), version: z.number().int().positive(),
  sourceId: z.uuid(), sourceFingerprint: z.string(), entries: z.array(physicalEntrySchema), action: z.string(),
  createdBy: z.string(), createdAt: z.iso.datetime(),
});
export const physicalConfirmationSchema = z.object({
  id: z.uuid(), groupId: z.uuid(), m2ConfirmationId: z.uuid(), m3Version: z.number().int().positive(),
  sourceFingerprint: z.string(), snapshot: z.object({ source: physicalSourceSchema, entries: z.array(physicalEntrySchema), ruleVersion: z.string() }),
  createdBy: z.string(), createdAt: z.iso.datetime(),
});
export const physicalSyncRunSchema = z.object({
  id: z.uuid(), groupId: z.uuid(), m2ConfirmationId: z.uuid(), status: z.enum(['queued', 'running', 'completed', 'partial', 'failed']),
  startDate: z.string(), endDate: z.string(), requestBudget: z.number(), requestsUsed: z.number(), authRequests: z.number(), cacheHits: z.number(), maxPages: z.number(),
  errorCode: nullableText, errorMessage: nullableText, createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
});
export const physicalSyncItemSchema = z.object({
  id: z.uuid(), runId: z.uuid(), demandId: z.uuid(), sid: z.number(), fba: z.string(), status: z.enum(['queued', 'running', 'completed', 'failed']),
  snapshotIds: z.array(z.uuid()), errorCode: nullableText, errorMessage: nullableText,
});
export const physicalSyncResultSchema = z.object({ run: physicalSyncRunSchema, items: z.array(physicalSyncItemSchema) });
export const physicalReviewSchema = z.object({
  groupId: z.uuid(), m2ConfirmationId: z.uuid().nullable(), version: z.number().int().nonnegative(),
  source: physicalSourceSchema.nullable(), availableSources: z.array(physicalSourceSchema), revision: physicalRevisionSchema.nullable(),
  confirmation: physicalConfirmationSchema.nullable(), valid: z.boolean(), canConfirm: z.boolean(), canExport: z.boolean(),
  readOnly: z.boolean(), pendingChange: z.boolean(), blocked: z.array(batchIssueSchema), runs: z.array(physicalSyncRunSchema),
});
export const physicalWriteSchema = z.object({
  operationId: z.uuid(), m2ConfirmationId: z.uuid(), expectedVersion: z.number().int().nonnegative(), sourceFingerprint: z.string().nullable(),
}).strict();
export const physicalAdoptSchema = physicalWriteSchema.extend({ sourceId: z.uuid() }).strict();
export const physicalSaveSchema = physicalWriteSchema.extend({ entries: z.array(physicalEntrySchema).max(10000) }).strict();
export const physicalSyncInputSchema = physicalWriteSchema.extend({
  startDate: z.iso.date(), endDate: z.iso.date(), requestBudget: z.number().int().min(1).max(1000).default(100), maxPages: z.number().int().min(1).max(100).default(10),
}).strict().refine((v) => v.startDate < v.endDate, '结束日期必须晚于开始日期');
export const physicalSyncRetrySchema = z.object({ operationId: z.uuid(), additionalRequestBudget: z.number().int().min(0).max(1000).default(0) }).strict();
export const physicalExportReferenceSchema = z.object({
  groupId: z.uuid(), m2ConfirmationId: z.uuid(), physicalConfirmationId: z.uuid(), m3Version: z.number().int().positive(), sourceFingerprint: z.string(),
}).strict();
export const physicalExportInputSchema = z.object({ operationId: z.uuid(), references: z.array(physicalExportReferenceSchema).min(1).max(500) }).strict();
export const physicalExportRecordSchema = z.object({
  id: z.uuid(), status: z.enum(['queued', 'running', 'completed', 'failed', 'stale']), references: z.array(physicalExportReferenceSchema),
  fileId: z.uuid().nullable(), error: nullableText, createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  boxCount: z.number().int().nonnegative(), valid: z.boolean(), invalidReason: nullableText,
});
export const physicalHistorySchema = z.object({ sources: z.array(physicalSourceSchema), revisions: z.array(physicalRevisionSchema), confirmations: z.array(physicalConfirmationSchema) });
export const physicalWorkspaceStatusSchema = z.enum(['pending', 'blocked', 'confirmed', 'stale']);
export const physicalWorkspaceQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), shippingRunId: z.uuid().optional(),
  weekFrom: z.iso.date().optional(), weekTo: z.iso.date().optional(), sid: z.coerce.number().int().positive().optional(),
  country: z.string().trim().min(1).max(120).optional(), channel: z.string().trim().min(1).max(120).optional(),
  status: physicalWorkspaceStatusSchema.optional(), q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().pipe(z.union([z.literal(20), z.literal(50)])).default(20),
}).strict().superRefine((value, context) => {
  if (value.weekFrom && value.weekTo && value.weekFrom > value.weekTo) context.addIssue({ code: 'custom', path: ['weekTo'], message: '结束周不能早于开始周。' });
});
export const physicalWorkspaceRowSchema = z.object({
  shippingRuns: z.array(shippingOccurrenceSchema).default([]),
  id: z.uuid(), batch: z.object({ id: z.uuid(), weekStartDate: z.iso.date(), weekEndDate: z.iso.date() }),
  group: z.object({ id: z.uuid(), name: z.string(), status: z.enum(['draft', 'confirmed', 'frozen']) }),
  memberCount: z.number().int().nonnegative(), sids: z.array(z.number().int().positive()), shops: z.array(z.string()),
  countries: z.array(z.string()), channels: z.array(z.string()), fbas: z.array(z.string()),
  physical: z.object({ status: physicalWorkspaceStatusSchema, version: z.number().int().nonnegative(), checkedCount: z.number().int().nonnegative(), boxCount: z.number().int().nonnegative(),
    valid: z.boolean(), pendingChange: z.boolean(), blockedCount: z.number().int().nonnegative(), confirmationId: z.uuid().nullable(), confirmedAt: z.iso.datetime().nullable(),
    exportReference: physicalExportReferenceSchema.nullable().default(null) }),
});
export const physicalWorkspaceSchema = z.object({
  rows: z.array(physicalWorkspaceRowSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.union([z.literal(20), z.literal(50)]),
  filters: z.object({ shippingRuns: z.array(shippingOccurrenceSchema).default([]), weeks: z.array(z.object({ weekStartDate: z.iso.date(), weekEndDate: z.iso.date() })), shops: z.array(z.object({ sid: z.number().int().positive(), name: z.string() })), countries: z.array(z.string()), channels: z.array(z.string()) }),
});
export const physicalMutationSchema = z.object({ operationId: z.uuid(), replayed: z.boolean(), version: z.number().int().nonnegative() });
export const physicalIntakePreviewSchema = z.object({ previewId: z.uuid(), sha256: z.string(), entries: z.array(physicalEntrySchema), boxCount: z.number().int().nonnegative() });
export type PhysicalValues = z.infer<typeof physicalValuesSchema>;
export type PhysicalBox = z.infer<typeof physicalBoxSchema>;
export type PhysicalSource = z.infer<typeof physicalSourceSchema>;
export type PhysicalEntry = z.infer<typeof physicalEntrySchema>;
export type PhysicalRevision = z.infer<typeof physicalRevisionSchema>;
export type PhysicalConfirmation = z.infer<typeof physicalConfirmationSchema>;
export type PhysicalReview = z.infer<typeof physicalReviewSchema>;
export type PhysicalWrite = z.infer<typeof physicalWriteSchema>;
export type PhysicalSave = z.infer<typeof physicalSaveSchema>;
export type PhysicalAdopt = z.infer<typeof physicalAdoptSchema>;
export type PhysicalSyncInput = z.infer<typeof physicalSyncInputSchema>;
export type PhysicalSyncRun = z.infer<typeof physicalSyncRunSchema>;
export type PhysicalExportReference = z.infer<typeof physicalExportReferenceSchema>;
export type PhysicalExportRecord = z.infer<typeof physicalExportRecordSchema>;
export type PhysicalWorkspaceQuery = z.infer<typeof physicalWorkspaceQuerySchema>;
export type PhysicalWorkspaceRow = z.infer<typeof physicalWorkspaceRowSchema>;
export type PhysicalWorkspace = z.infer<typeof physicalWorkspaceSchema>;
