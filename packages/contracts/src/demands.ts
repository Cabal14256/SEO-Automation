import { z } from 'zod';
import { importIssueSchema } from './imports.js';
import { sellerCatalogModeSchema, sellerCatalogSettingsSchema } from './seller-mappings.js';

export const demandSnapshotSchema = z.object({
  sid: z.number().int().positive(), fba: z.string(), shop: z.string(), country: z.string(),
  channel: z.string().nullable(), destinationFc: z.string().nullable(), referenceQuantity: z.string().nullable(),
  notes: z.string().nullable(), subBatchName: z.string().nullable(),
  destinationAddress: z.string().nullable().optional(), shipmentCreatedAt: z.string().nullable().optional(), sourceFilledAt: z.string().nullable().optional(),
  metadataSource: z.string().nullable().optional(), metadataObservedAt: z.string().nullable().optional(),
});
export type DemandSnapshot = z.infer<typeof demandSnapshotSchema>;
export const importSourceLocationSchema = z.object({ rowId: z.uuid(), parseRunId: z.uuid(), importId: z.uuid(), fileName: z.string(), sheetName: z.string(), rowNumber: z.number().int().positive(), addresses: z.array(z.string()) });
export type ImportSourceLocation = z.infer<typeof importSourceLocationSchema>;
export const importDiffKindSchema = z.enum(['new', 'unchanged', 'changed', 'conflict', 'error', 'missing']);
export type ImportDiffKind = z.infer<typeof importDiffKindSchema>;
export const importDiffItemSchema = z.object({
  id: z.uuid(), kind: importDiffKindSchema, selectable: z.boolean(), sid: z.number().int().nullable(), fba: z.string().nullable(),
  demandId: z.uuid().nullable(), expectedDemandVersion: z.number().int().nonnegative(), before: demandSnapshotSchema.nullable(), after: demandSnapshotSchema.nullable(),
  sources: z.array(importSourceLocationSchema), issues: z.array(importIssueSchema), alreadyCommitted: z.boolean(),
});
export type ImportDiffItem = z.infer<typeof importDiffItemSchema>;
export const importSellerSelectionSchema = z.object({ sourceShop: z.string().min(1), sellerMappingId: z.uuid(), expectedVersion: z.number().int().positive(), confirmed: z.literal(true) }).strict();
export type ImportSellerSelection = z.infer<typeof importSellerSelectionSchema>;
export const importSellerConfirmationSchema = importSellerSelectionSchema.extend({ sid: z.number().int().positive(), name: z.string(), country: z.string(), confirmedBy: z.string(), confirmedAt: z.iso.datetime() });
export type ImportSellerConfirmation = z.infer<typeof importSellerConfirmationSchema>;
export const importDiffCountsSchema = z.object({ new: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), conflict: z.number().int().nonnegative(), error: z.number().int().nonnegative(), missing: z.number().int().nonnegative() });
export const importPreviewSchema = z.object({
  id: z.uuid(), importId: z.uuid(), parseRunId: z.uuid(), importVersion: z.number().int().positive(), mappings: z.array(importSellerConfirmationSchema),
  baselineImportId: z.uuid().nullable(), createdAt: z.iso.datetime(), createdBy: z.string(), counts: importDiffCountsSchema,
  selectableItemIds: z.array(z.uuid()), changedItemIds: z.array(z.uuid()),
  sellerCatalogMode: sellerCatalogModeSchema.default('manual'), sellerCatalogSettingsVersion: z.number().int().nonnegative().default(0), sellerCatalogVersion: z.number().int().nonnegative().default(0),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export const importPreviewPayloadSchema = z.object({ preview: importPreviewSchema, items: z.array(importDiffItemSchema) });
export type ImportPreviewPayload = z.infer<typeof importPreviewPayloadSchema>;
export const importPreviewInputSchema = z.object({ expectedVersion: z.number().int().positive(), parseRunId: z.uuid(), sellerSelections: z.array(importSellerSelectionSchema).max(10000), baselineImportId: z.uuid().optional(), expectedCatalogSettingsVersion: z.number().int().positive(), expectedCatalogVersion: z.number().int().nonnegative() }).strict();
export type ImportPreviewInput = z.infer<typeof importPreviewInputSchema>;
export const importPreviewQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), kind: importDiffKindSchema.optional() });
export type ImportPreviewQuery = z.infer<typeof importPreviewQuerySchema>;
export const importPreviewResponseSchema = importPreviewPayloadSchema.extend({ total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() });
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;
export const importCommitInputSchema = z.object({ operationId: z.uuid(), previewId: z.uuid(), selectedItemIds: z.array(z.uuid()).min(1).max(10000), confirmedChangedItemIds: z.array(z.uuid()).max(10000).default([]) }).strict();
export type ImportCommitInput = z.infer<typeof importCommitInputSchema>;
export const importCommitItemSchema = z.object({ itemId: z.uuid(), demandId: z.uuid(), version: z.number().int().positive(), action: z.enum(['created', 'updated', 'linked', 'already_committed']), sources: z.array(importSourceLocationSchema) });
export const importCommitResultSchema = z.object({
  operationId: z.uuid(), importId: z.uuid(), previewId: z.uuid(), createdAt: z.iso.datetime(), createdBy: z.string(), items: z.array(importCommitItemSchema),
  counts: z.object({ created: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), linked: z.number().int().nonnegative(), alreadyCommitted: z.number().int().nonnegative() }), replayed: z.boolean(),
});
export type ImportCommitResult = z.infer<typeof importCommitResultSchema>;
export const importCommitHistorySchema = z.object({ items: z.array(importCommitResultSchema) });
export const importShopResolutionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unique'), sellerMappingId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.enum(['fba_lookup', 'name_alias']) }),
  z.object({ status: z.literal('ambiguous'), sellerMappingId: z.null(), expectedVersion: z.null(), reason: z.enum(['multiple_matches', 'country_mismatch', 'conflicting_lookup_sids']) }),
  z.object({ status: z.literal('unmatched'), sellerMappingId: z.null(), expectedVersion: z.null(), reason: z.literal('not_found') }),
]);
export type ImportShopResolution = z.infer<typeof importShopResolutionSchema>;
export const importConfirmationContextSchema = z.object({
  shops: z.array(z.object({ sourceShop: z.string(), countries: z.array(z.string()), rowCount: z.number().int().nonnegative(), resolution: importShopResolutionSchema.optional() })),
  sellers: z.array(z.object({ id: z.uuid(), sid: z.number().int().positive(), name: z.string(), country: z.string(), status: z.enum(['candidate', 'approved', 'disabled']), version: z.number().int().positive() })),
  latestPreviewId: z.uuid().nullable(), submittedSourceRows: z.number().int().nonnegative(), totalSourceRows: z.number().int().nonnegative(),
  status: z.enum(['not_submitted', 'partially_submitted', 'submitted']), baselines: z.array(z.object({ id: z.uuid(), originalName: z.string(), businessDate: z.iso.date() })),
  catalog: sellerCatalogSettingsSchema,
});
export type ImportConfirmationContext = z.infer<typeof importConfirmationContextSchema>;
export const demandRecordSchema = z.object({ id: z.uuid(), snapshot: demandSnapshotSchema, version: z.number().int().positive(), businessDate: z.iso.date(), weekStartDate: z.iso.date(), weekEndDate: z.iso.date(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type DemandRecord = z.infer<typeof demandRecordSchema>;
export const demandLifecycleSchema = z.enum(['active', 'cancelled']);
export const demandManagementSchema = z.object({
  lifecycle: demandLifecycleSchema, canEdit: z.boolean(), canDelete: z.boolean(), reason: z.string().nullable(),
  groupId: z.uuid().nullable(), batchId: z.uuid().nullable(),
});
export type DemandManagement = z.infer<typeof demandManagementSchema>;
export const demandManagementOperationSchema = z.object({ action: z.string(), reason: z.string(), createdBy: z.string(), createdAt: z.iso.datetime(), version: z.number().int().positive().optional() });
export type DemandManagementOperation = z.infer<typeof demandManagementOperationSchema>;
const demandOperationInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict();
const demandEditableTextSchema = z.string().trim().max(2000).nullable();
export const demandRevisionInputSchema = demandOperationInputSchema.extend({ fields: z.object({
  channel: demandEditableTextSchema.optional(), destinationFc: demandEditableTextSchema.optional(), destinationAddress: demandEditableTextSchema.optional(),
  referenceQuantity: demandEditableTextSchema.optional(), notes: demandEditableTextSchema.optional(), sourceFilledAt: demandEditableTextSchema.optional(),
}).strict().refine((fields) => Object.keys(fields).length > 0, '请填写要修改的需求字段。') });
export type DemandRevisionInput = z.infer<typeof demandRevisionInputSchema>;
export const demandCancelInputSchema = demandOperationInputSchema;
export type DemandCancelInput = z.infer<typeof demandCancelInputSchema>;
export const demandDetailSchema = z.object({ demand: demandRecordSchema,
  revisions: z.array(z.object({ version: z.number().int().positive(), snapshot: demandSnapshotSchema, createdBy: z.string(), createdAt: z.iso.datetime() })),
  sources: z.array(z.object({ source: importSourceLocationSchema, acceptedVersion: z.number().int().positive(), createdBy: z.string(), createdAt: z.iso.datetime(), mapping: importSellerConfirmationSchema })),
  management: demandManagementSchema.default({ lifecycle: 'active', canEdit: false, canDelete: false, reason: '请重新读取需求操作权限。', groupId: null, batchId: null }),
  operations: z.array(demandManagementOperationSchema).default([]),
});
export type DemandDetail = z.infer<typeof demandDetailSchema>;
