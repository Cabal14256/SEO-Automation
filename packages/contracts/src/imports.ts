import { z } from 'zod';

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_DATE_POLICY = 'import-date-shanghai-v1' as const;
export const IMPORT_PARSER_VERSION = 'xlsx-preview-v3' as const;
export const importStatusSchema = z.enum(['queued', 'parsing', 'awaiting_mapping', 'preview_ready', 'failed']);
export const importRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export const importMappingVersionSchema = z.enum(['feishu-v1', 'manual-v1', 'online-v1', 'fba-list-v1']);
export type ImportMappingVersion = z.infer<typeof importMappingVersionSchema>;
export const importIssueSchema = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string(), column: z.string().optional(), address: z.string().optional() });
export type ImportIssue = z.infer<typeof importIssueSchema>;
export const importSheetSchema = z.object({ name: z.string(), state: z.enum(['visible', 'hidden', 'veryHidden']), rowCount: z.number().int().nonnegative(), columnCount: z.number().int().nonnegative(), mergedRanges: z.array(z.string()), hiddenColumns: z.array(z.number().int()), headers: z.array(z.object({ column: z.string(), value: z.string().nullable() })) });
export type ImportSheet = z.infer<typeof importSheetSchema>;

export const importRawCellSchema = z.object({
  address: z.string(), column: z.string(), type: z.string(), rawValue: z.string().nullable(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]), numberFormat: z.string(),
  formula: z.string().nullable(), formulaCache: z.enum(['not_formula', 'present', 'empty', 'absent']), hidden: z.boolean(),
});
export type ImportRawCell = z.infer<typeof importRawCellSchema>;
export const importNormalizedRowSchema = z.object({
  shop: z.string().nullable(), channel: z.string().nullable(), country: z.string().nullable(), destinationFc: z.string().nullable(),
  fba: z.string().nullable(), referenceQuantity: z.string().nullable(), sourceDate: z.string().nullable(), sourceRecordId: z.string().nullable(),
  notes: z.string().nullable(), subBatchName: z.string().nullable(), sellerMappingId: z.string().nullable(), sid: z.number().int().nullable(), sellerMappingVersion: z.number().int().nullable(),
  destinationAddress: z.string().nullable().optional(), shipmentCreatedAt: z.string().nullable().optional(), sourceFilledAt: z.string().nullable().optional(),
  metadataSource: z.string().nullable().optional(), metadataObservedAt: z.string().nullable().optional(),
  sourceTicketIndex: z.number().int().positive().optional(), sourceMemberIndex: z.number().int().positive().optional(),
});
export type ImportNormalizedRow = z.infer<typeof importNormalizedRowSchema>;
export const importRowSchema = z.object({ id: z.uuid(), parseRunId: z.uuid(), sheetName: z.string(), rowNumber: z.number().int().positive(), hidden: z.boolean(), status: z.enum(['valid', 'needs_review', 'error']), rawCells: z.array(importRawCellSchema), normalized: importNormalizedRowSchema, issues: z.array(importIssueSchema) });
export type ImportRow = z.infer<typeof importRowSchema>;
export const importCountsSchema = z.object({ totalRows: z.number().int().nonnegative(), validFbaRows: z.number().int().nonnegative(), errorRows: z.number().int().nonnegative(), warningRows: z.number().int().nonnegative() });
export type ImportCounts = z.infer<typeof importCountsSchema>;
export const importRunSchema = z.object({ id: z.uuid(), importId: z.uuid(), status: importRunStatusSchema, inputVersion: z.number().int().positive(), mappingVersion: importMappingVersionSchema.nullable(), sheetName: z.string().nullable(), parserVersion: z.string(), processedRows: z.number().int().nonnegative(), counts: importCountsSchema, issues: z.array(importIssueSchema), errorCode: z.string().nullable(), errorMessage: z.string().nullable(), createdAt: z.iso.datetime(), startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable() });
export type ImportRun = z.infer<typeof importRunSchema>;
export const sourceImportSchema = z.object({ id: z.uuid(), fileId: z.uuid(), sourceType: z.enum(['xlsx', 'online']).optional(), submissionStatus: z.enum(['not_submitted', 'partially_submitted', 'submitted']).optional(), submittedSourceRows: z.number().int().nonnegative().optional(), originalName: z.string(), sha256: z.string(), byteSize: z.number().int(), createdBy: z.string(), importedAt: z.iso.datetime(), businessDate: z.iso.date(), datePolicyVersion: z.literal(IMPORT_DATE_POLICY), weekStartDate: z.iso.date(), weekEndDate: z.iso.date(), status: importStatusSchema, version: z.number().int().positive(), sheets: z.array(importSheetSchema), latestRun: importRunSchema.nullable() });
export type SourceImport = z.infer<typeof sourceImportSchema>;
export const importAcceptedSchema = z.object({ import: sourceImportSchema, run: importRunSchema, taskId: z.uuid(), taskUrl: z.string(), replayed: z.boolean(), deduplicated: z.boolean() });
export type ImportAccepted = z.infer<typeof importAcceptedSchema>;
export const importListSchema = z.object({ items: z.array(sourceImportSchema), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });
export const importRowsResponseSchema = z.object({ items: z.array(importRowSchema), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(), parseRunId: z.uuid().nullable(), previewVersion: z.number().int().positive() });
export const importPageQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const importRowsQuerySchema = importPageQuerySchema.extend({ status: z.enum(['valid', 'needs_review', 'error']).optional(), parseRunId: z.uuid().optional() });
export const importParseInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), sheetName: z.string().min(1).max(128), mappingVersion: importMappingVersionSchema }).strict();
export type ImportParseInput = z.infer<typeof importParseInputSchema>;
