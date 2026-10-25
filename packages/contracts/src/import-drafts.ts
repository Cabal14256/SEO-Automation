import { z } from 'zod';
import { importCommitInputSchema } from './demands.js';
import { onlineImportInputSchema, onlineImportRowSchema } from './online-imports.js';

export const IMPORT_DRAFT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_DRAFT_MAX_BODY_BYTES = 20 * 1024 * 1024;
const maxBase64Length = Math.ceil(IMPORT_DRAFT_MAX_FILE_BYTES / 3) * 4;
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64FileSchema = z.string().min(4).max(maxBase64Length).superRefine((value, context) => {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length > maxBase64Length || value.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))) {
    context.addIssue({ code: 'custom', message: '文件内容必须是有效的标准 Base64。' }); return;
  }
  const byteLength = value.length / 4 * 3 - padding;
  const last = base64Alphabet.indexOf(value[value.length - padding - 1] ?? '');
  if (byteLength <= 0 || byteLength > IMPORT_DRAFT_MAX_FILE_BYTES || padding === 2 && last % 16 !== 0 || padding === 1 && last % 4 !== 0) {
    context.addIssue({ code: 'custom', message: '文件内容必须非空、不超过 10 MiB，且采用规范 Base64 编码。' });
  }
});

export const importDraftSourceSchema = z.enum(['online', 'file']).nullable();
export const importDraftProgressSchema = z.object({
  importId: z.uuid().nullable(), source: importDraftSourceSchema,
  step: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  reviewedRunId: z.uuid().optional(), reviewedVersion: z.number().int().positive().optional(), resultOperationId: z.uuid().optional(),
}).strict();
export type ImportDraftProgress = z.infer<typeof importDraftProgressSchema>;
const autofilledRowSchema = z.object({ shop: z.string().max(2000).optional(), channel: z.string().max(2000).optional(), country: z.string().max(2000).optional(), destinationFc: z.string().max(2000).optional(), destinationAddress: z.string().max(2000).optional(), shipmentCreatedAt: z.string().max(2000).optional() }).strict();
export const importDraftContentSchema = z.object({
  source: importDraftSourceSchema, progress: importDraftProgressSchema,
  shipping: z.object({
    enabled: z.boolean(), numberingDate: z.iso.date(), operationId: z.uuid(), runId: z.uuid().optional(),
    pending: z.object({ operationId: z.uuid(), importId: z.uuid(), parseRunId: z.uuid(), numberingDate: z.iso.date() }).strict().optional(),
  }).strict().optional(),
  online: z.object({ rows: z.array(onlineImportRowSchema).max(1000), startDate: z.string().max(100), endDate: z.string().max(100), operationId: z.uuid().optional(), autofilled: z.array(autofilledRowSchema).max(1000).optional(), pendingSubmission: onlineImportInputSchema.optional() }).strict().superRefine((value, context) => {
    if (!value.pendingSubmission) return;
    if (value.pendingSubmission.operationId !== value.operationId) context.addIssue({ code: 'custom', path: ['pendingSubmission', 'operationId'], message: '待确认提交必须使用草稿原操作编号。' });
    if (JSON.stringify(value.pendingSubmission.rows) !== JSON.stringify(value.rows)) context.addIssue({ code: 'custom', path: ['pendingSubmission', 'rows'], message: '待确认提交必须保留草稿原始提交内容。' });
  }).optional(),
  file: z.object({ name: z.string().min(1).max(255), lastModified: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), type: z.string().max(255), base64: base64FileSchema, operationId: z.uuid().optional() }).strict().optional(),
  confirmation: z.object({
    version: z.literal(1), importId: z.uuid(), previewId: z.uuid().nullable(), pending: importCommitInputSchema.nullable(), lastOperationId: z.uuid().nullable(),
    shopSelections: z.record(z.string(), z.object({ sellerMappingId: z.union([z.uuid(), z.literal('')]), confirmed: z.boolean(),
      confirmedVersion: z.number().int().positive().optional(), catalogSettingsVersion: z.number().int().positive().optional(), catalogVersion: z.number().int().nonnegative().optional() }).strict()).optional(),
    baselineImportId: z.uuid().optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.source !== value.progress.source) context.addIssue({ code: 'custom', path: ['progress', 'source'], message: '草稿方式与向导方式不一致。' });
  if (value.confirmation && value.confirmation.importId !== value.progress.importId) context.addIssue({ code: 'custom', path: ['confirmation', 'importId'], message: '确认进度不属于草稿关联的导入。' });
  if (value.shipping?.pending) {
    const pending = value.shipping.pending;
    if (pending.operationId !== value.shipping.operationId || pending.importId !== value.progress.importId || pending.numberingDate !== value.shipping.numberingDate) {
      context.addIssue({ code: 'custom', path: ['shipping', 'pending'], message: '待确认整理请求必须保留原操作编号、来源和编号日期。' });
    }
  }
});
export type ImportDraftContent = z.infer<typeof importDraftContentSchema>;
export const saveImportDraftInputSchema = z.object({ expectedVersion: z.number().int().nonnegative(), title: z.string().trim().min(1).max(120), content: importDraftContentSchema }).strict();
export type SaveImportDraftInput = z.infer<typeof saveImportDraftInputSchema>;
export const importDraftSummarySchema = z.object({
  id: z.uuid(), title: z.string(), source: importDraftSourceSchema, importId: z.uuid().nullable(), rowCount: z.number().int().nonnegative().nullable(),
  version: z.number().int().positive(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type ImportDraftSummary = z.infer<typeof importDraftSummarySchema>;
export const importDraftSchema = importDraftSummarySchema.extend({ content: importDraftContentSchema });
export type ImportDraft = z.infer<typeof importDraftSchema>;
export const importDraftListQuerySchema = z.object({ q: z.string().trim().max(200).default(''), page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export type ImportDraftListQuery = z.infer<typeof importDraftListQuerySchema>;
export const importDraftListSchema = z.object({ items: z.array(importDraftSummarySchema), total: z.number().int().nonnegative() });
export const deleteImportDraftQuerySchema = z.object({ version: z.coerce.number().int().positive() }).strict();
