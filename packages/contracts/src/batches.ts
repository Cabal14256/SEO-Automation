import { z } from 'zod';
import { demandRecordSchema } from './demands.js';

const nullableText = z.string().nullable();
export const batchIssueSchema = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string(), demandId: z.uuid().optional(), boxId: z.uuid().optional(), details: z.record(z.string(), z.unknown()).optional() });
export type BatchIssue = z.infer<typeof batchIssueSchema>;
export const shipmentProductSchema = z.object({ msku: z.string(), fnsku: z.string(), sku: z.string(), name: nullableText, quantity: nullableText,
  listQuantity: nullableText.optional(), initialDeclaredQuantity: nullableText.optional(), localShippedQuantity: nullableText.optional(), receivedQuantity: nullableText.optional(), expiration: nullableText.optional(), prepOwner: nullableText.optional(), labelOwner: nullableText.optional() });
export type ShipmentProduct = z.infer<typeof shipmentProductSchema>;
export const shipmentBoxItemSchema = shipmentProductSchema.pick({ msku: true, fnsku: true, sku: true, quantity: true, expiration: true, prepOwner: true, labelOwner: true });
export const shipmentBoxSchema = z.object({ id: z.uuid(), externalBoxId: nullableText, packageId: nullableText, localBoxId: nullableText, name: nullableText, order: z.number().int().positive().nullable(), items: z.array(shipmentBoxItemSchema),
  weight: nullableText.optional(), weightUnit: nullableText.optional(), length: nullableText.optional(), width: nullableText.optional(), height: nullableText.optional(), dimensionUnit: nullableText.optional() });
export type ShipmentBox = z.infer<typeof shipmentBoxSchema>;
export const shipmentDataSchema = z.object({ sid: z.number().int().positive(), fba: z.string(), items: z.array(shipmentProductSchema), boxes: z.array(shipmentBoxSchema), isSta: z.boolean().nullable().optional(), staPlanId: nullableText.optional(), shipmentStatus: nullableText.optional(), observedAt: z.iso.datetime(), issues: z.array(batchIssueSchema).default([]) });
export type ShipmentData = z.infer<typeof shipmentDataSchema>;
/** CLOSED is Amazon's completed receiving status; quantities cannot establish completion. */
export function isShipmentReceiptComplete(data: Pick<ShipmentData, 'shipmentStatus'>): boolean {
  return typeof data.shipmentStatus === 'string' && data.shipmentStatus.trim().toUpperCase() === 'CLOSED';
}
/** Recompute receipt notices for display without rewriting immutable shipment snapshots. */
export function shipmentIssuesForDisplay(data: Pick<ShipmentData, 'shipmentStatus' | 'items' | 'issues'>): BatchIssue[] {
  const issues = data.issues.filter((issue) => !['RECEIPT_DIFFERENCE', 'RECEIVED_DIFFERENCE'].includes(issue.code));
  if (!isShipmentReceiptComplete(data)) return issues;
  const count = (value: string | null | undefined) => typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(value) : null;
  for (const item of data.items) {
    const declared = count(item.quantity), received = count(item.receivedQuantity);
    if (declared !== null && received !== null && declared !== received) issues.push({
      code: 'RECEIVED_DIFFERENCE', severity: 'warning', message: '亚马逊接收已完成，接收数量与申报量不同，未改变准备量。',
      details: { key: JSON.stringify([item.msku, item.fnsku, item.sku]), received: item.receivedQuantity, detail: item.quantity },
    });
  }
  return issues;
}
export const shipmentRevisionSchema = z.object({ id: z.uuid(), demandId: z.uuid(), version: z.number().int().positive(), demandVersion: z.number().int().positive(), data: shipmentDataSchema, source: z.enum(['lingxing', 'manual', 'xlsx']), snapshotIds: z.array(z.uuid()), reason: z.string(), createdBy: z.string(), createdAt: z.iso.datetime() });
export type ShipmentRevision = z.infer<typeof shipmentRevisionSchema>;
export const shippingOccurrenceSchema = z.object({ id: z.uuid(), month: z.string(), sequence: z.number().int().positive().nullable(), numberingDate: z.iso.date() });
export type ShippingOccurrence = z.infer<typeof shippingOccurrenceSchema>;
export const batchScopeSchema = z.object({ id: z.uuid(), /** Historical storage metadata only. */ weekStartDate: z.iso.date(), weekEndDate: z.iso.date(), version: z.number().int().positive(), sortMode: z.enum(['fba', 'manual']), nextPrefix: z.number().int().nonnegative(), createdAt: z.iso.datetime(), shippingRunId: z.uuid().nullable().optional(), month: z.string().nullable().optional(), sequence: z.number().int().positive().nullable().optional(), numberingDate: z.iso.date().nullable().optional() });
export type BatchScope = z.infer<typeof batchScopeSchema>;
/** @deprecated Use BatchScope; dates do not define membership. */
export const weeklyBatchSchema = batchScopeSchema;
export type WeeklyBatch = BatchScope;
export const subBatchRecordSchema = z.object({ id: z.uuid(), lifecycle: z.enum(['active', 'cancelled', 'trashed']).optional(), lifecyclePending: z.boolean().optional(), batchId: z.uuid(), name: z.string(), version: z.number().int().positive(), status: z.enum(['draft', 'confirmed', 'frozen', 'superseded']), position: z.number().int().nonnegative(), demandIds: z.array(z.uuid()), prefix: nullableText, confirmedVersion: z.number().int().positive().nullable(), frozenAt: z.iso.datetime().nullable(), correctionOfId: z.uuid().nullable(), replacedById: z.uuid().nullable(), actualShipDate: z.iso.date().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type SubBatchRecord = z.infer<typeof subBatchRecordSchema>;
export const allocationCodeSchema = z.object({ id: z.uuid(), groupId: z.uuid(), demandId: z.uuid(), boxId: z.uuid(), prefix: z.string(), sequence: z.number().int().positive(), code: z.string(), valid: z.boolean(), createdAt: z.iso.datetime() });
export type AllocationCode = z.infer<typeof allocationCodeSchema>;
export const groupConfirmationSnapshotSchema = z.object({ members: z.array(demandRecordSchema), shipments: z.array(z.object({ demandId: z.uuid(), revision: shipmentRevisionSchema })), ruleVersion: z.string() });
export const groupConfirmationSchema = z.object({ id: z.uuid(), groupId: z.uuid(), groupVersion: z.number().int().positive(), snapshot: groupConfirmationSnapshotSchema, createdBy: z.string(), createdAt: z.iso.datetime() });
export type GroupConfirmation = z.infer<typeof groupConfirmationSchema>;
export const groupHistorySchema = z.object({ version: z.number().int().positive(), action: z.string(), reason: z.string(), createdBy: z.string(), createdAt: z.iso.datetime(), snapshot: subBatchRecordSchema });
export const subBatchDetailSchema = z.object({ group: subBatchRecordSchema, shippingRunIds: z.array(z.uuid()).optional(), members: z.array(demandRecordSchema), shipments: z.array(z.object({ demandId: z.uuid(), revision: shipmentRevisionSchema.nullable() })), issues: z.array(batchIssueSchema), confirmation: groupConfirmationSchema.nullable(), codes: z.array(allocationCodeSchema), history: z.array(groupHistorySchema) });
export type SubBatchDetail = z.infer<typeof subBatchDetailSchema>;
export const batchScopeDetailSchema = z.object({ batch: batchScopeSchema, groups: z.array(subBatchRecordSchema), ungrouped: z.array(demandRecordSchema) });
export type BatchScopeDetail = z.infer<typeof batchScopeDetailSchema>;
export const batchScopeListSchema = z.object({ items: z.array(batchScopeSchema), availableWeeks: z.array(z.object({ weekStartDate: z.iso.date(), weekEndDate: z.iso.date(), demandCount: z.number().int().nonnegative() })).default([]) });
/** @deprecated Compatibility aliases for saved requests and historical callers. */
export const weeklyBatchDetailSchema = batchScopeDetailSchema;
export type WeeklyBatchDetail = BatchScopeDetail;
export const weeklyBatchListSchema = batchScopeListSchema;
export const batchOperationInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().max(1000).default('人工操作') });
export const createWeeklyBatchInputSchema = z.object({ operationId: z.uuid(), weekStartDate: z.iso.date() }).strict();
export const createSubBatchInputSchema = batchOperationInputSchema.extend({ name: z.string().trim().min(1).max(120), demandIds: z.array(z.uuid()).min(1).max(1000), expectedDemandVersions: z.record(z.string(), z.number().int().positive()) }).strict();
export const updateSubBatchMembersInputSchema = batchOperationInputSchema.extend({ demandIds: z.array(z.uuid()).min(1).max(1000), expectedDemandVersions: z.record(z.string(), z.number().int().positive()) }).strict();
export const reorderSubBatchesInputSchema = batchOperationInputSchema.extend({ groupIds: z.array(z.uuid()).min(1).max(1000) }).strict();
export const mergeSubBatchesInputSchema = batchOperationInputSchema.extend({ sourceGroupIds: z.array(z.uuid()).min(1), expectedGroupVersions: z.record(z.string(), z.number().int().positive()) }).strict();
export const splitSubBatchInputSchema = batchOperationInputSchema.extend({ groups: z.array(z.object({ name: z.string().trim().min(1).max(120), demandIds: z.array(z.uuid()).min(1) })).min(2).max(100) }).strict();
export const moveSubBatchMembersInputSchema = batchOperationInputSchema.extend({ targetGroupId: z.uuid(), expectedTargetVersion: z.number().int().positive(), demandIds: z.array(z.uuid()).min(1) }).strict();
export const manualShipmentInputSchema = batchOperationInputSchema.extend({ expectedDemandVersion: z.number().int().positive(), data: shipmentDataSchema }).strict();
export const batchDecisionInputSchema = batchOperationInputSchema.extend({ demandId: z.uuid(), expectedShipmentVersion: z.number().int().positive(), issueCode: z.string().min(1), note: z.string().trim().min(1).max(1000) }).strict();
export const boxMappingInputSchema = batchOperationInputSchema.extend({ demandId: z.uuid(), expectedShipmentVersion: z.number().int().positive(), mappings: z.array(z.object({ boxId: z.uuid(), existingBoxId: z.uuid().nullable(), order: z.number().int().positive() })).min(1) }).strict();
export const confirmSubBatchInputSchema = batchOperationInputSchema.extend({ expectedDemandVersions: z.record(z.string(), z.number().int().positive()), expectedShipmentVersions: z.record(z.string(), z.number().int().positive()) }).strict();
export const confirmAndAllocateSubBatchInputSchema = z.object({
  operationId: z.uuid(), expectedVersion: z.number().int().positive(), expectedBatchVersion: z.number().int().positive(),
  expectedDemandVersions: z.record(z.string(), z.number().int().positive()),
  expectedShipmentVersions: z.record(z.string(), z.number().int().positive()),
}).strict();
export type ConfirmAndAllocateSubBatchInput = z.infer<typeof confirmAndAllocateSubBatchInputSchema>;
export const allocateBatchCodesInputSchema = batchOperationInputSchema.extend({ groupIds: z.array(z.uuid()).min(1).max(1000), expectedGroupVersions: z.record(z.string(), z.number().int().positive()) }).strict();
export const actualShipDateInputSchema = batchOperationInputSchema.extend({ actualShipDate: z.iso.date().nullable() }).strict();
export const printRecordInputSchema = batchOperationInputSchema.extend({ confirmationId: z.uuid(), note: z.string().trim().min(1).max(1000) }).strict();
export const batchMutationResultSchema = z.object({ operationId: z.uuid(), groupId: z.uuid().optional(), batchId: z.uuid().optional(), groupIds: z.array(z.uuid()).optional(), replayed: z.boolean() });
export type BatchMutationResult = z.infer<typeof batchMutationResultSchema>;

export const batchWorkspaceStatusSchema = z.enum(['empty', 'draft', 'confirmed', 'frozen']);
export const batchWorkspaceQuerySchema = z.object({
  lifecycle: z.enum(['active', 'cancelled', 'trashed', 'all']).optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  shippingRunId: z.uuid().optional(),
  weekFrom: z.iso.date().optional(), weekTo: z.iso.date().optional(),
  sid: z.coerce.number().int().positive().optional(),
  country: z.string().trim().min(1).max(120).optional(), channel: z.string().trim().min(1).max(120).optional(),
  status: batchWorkspaceStatusSchema.optional(), q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().pipe(z.union([z.literal(20), z.literal(50)])).default(20),
}).strict().superRefine((value, context) => {
  if (value.weekFrom && value.weekTo && value.weekFrom > value.weekTo) {
    context.addIssue({ code: 'custom', path: ['weekTo'], message: '结束周不能早于开始周。' });
  }
});
export type BatchWorkspaceQuery = z.infer<typeof batchWorkspaceQuerySchema>;
export const batchWorkspaceRowSchema = z.object({
  id: z.uuid(), rowKind: z.enum(['group', 'batch', 'week']), batch: weeklyBatchSchema, group: subBatchRecordSchema.nullable(),
  shippingRuns: z.array(shippingOccurrenceSchema).default([]),
  memberCount: z.number().int().nonnegative(), status: batchWorkspaceStatusSchema,
  sids: z.array(z.number().int().positive()), shops: z.array(z.string()), countries: z.array(z.string()),
  channels: z.array(z.string()), fbas: z.array(z.string()),
  sync: z.object({ syncedMemberCount: z.number().int().nonnegative(), staleMemberCount: z.number().int().nonnegative(),
    latestRun: z.object({ id: z.uuid(), status: z.enum(['queued', 'running', 'completed', 'partial', 'failed']), groupVersion: z.number().int().positive(), createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable() }).nullable(),
  }),
  confirmation: z.object({ id: z.uuid(), groupVersion: z.number().int().positive(), createdAt: z.iso.datetime(), current: z.boolean() }).nullable(),
});
export type BatchWorkspaceRow = z.infer<typeof batchWorkspaceRowSchema>;
export const batchWorkspaceSchema = z.object({
  rows: z.array(batchWorkspaceRowSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.union([z.literal(20), z.literal(50)]),
  availableWeeks: z.array(z.object({ weekStartDate: z.iso.date(), weekEndDate: z.iso.date(), demandCount: z.number().int().nonnegative() })),
  filters: z.object({ shippingRuns: z.array(shippingOccurrenceSchema).default([]), weeks: z.array(z.object({ id: z.uuid(), weekStartDate: z.iso.date(), weekEndDate: z.iso.date() })),
    shops: z.array(z.object({ sid: z.number().int().positive(), name: z.string() })), countries: z.array(z.string()), channels: z.array(z.string()),
  }),
});
export type BatchWorkspace = z.infer<typeof batchWorkspaceSchema>;
