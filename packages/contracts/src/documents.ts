import { z } from 'zod';
import { allocationCodeSchema, shipmentRevisionSchema } from './batches.js';
import { demandRecordSchema } from './demands.js';
import { physicalBoxSchema, physicalConfirmationSchema, type PhysicalBox } from './physical.js';
import { DOCUMENT_PRODUCT_IMAGE_MAX_BYTES, DOCUMENT_PRODUCT_IMAGES_MAX_BYTES, documentProductImageInfo } from './document-images.js';
export * from './document-images.js';

export const documentPurposeSchema = z.enum(['invoice']);
export const documentProfileCategorySchema = z.enum(['product', 'party', 'address', 'channel', 'tax']);
export const documentStatusSchema = z.enum(['draft', 'pending_review', 'approved', 'returned', 'cancelled', 'superseded', 'stale']);
export const documentExportStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'stale']);
export const documentListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  weekStartDate: z.iso.date().optional(),
  shippingRunId: z.uuid().optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  status: z.enum(['active', 'all', ...documentStatusSchema.options]).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const DOCUMENT_FIELD_OPTIONS = {
  customsMode: ['买单报关', '报关退税', '普通报关', '9710', '9810'],
  clearanceMode: ['一般贸易清关'],
  taxMode: ['包税', '不包税', '自主税号', '自税递延'],
  deliveryStation: ['交货仓库', '深圳坂田仓库', '义乌仓库'],
  currency: ['USD', 'EUR', 'GBP'],
  battery: ['否', '是'],
  magnetic: ['否', '是'],
  liquid: ['否', '是'],
  powder: ['否', '是'],
  dangerous: ['否', '是'],
} as const satisfies Readonly<Record<string, readonly string[]>>;
export const documentFieldOptionsSchema = z.object({ services: z.array(z.string()) }).strict();
export type DocumentFieldOptions = z.infer<typeof documentFieldOptionsSchema>;

// Shared by invoice preflight and the editor's live missing-field navigation.
export const DOCUMENT_REQUIRED_FIELDS = ['service', 'recipientName', 'addressLine1', 'city', 'postalCode', 'countryCode', 'currency', 'customsMode', 'taxMode', 'battery', 'magnetic', 'liquid', 'powder', 'dangerous'] as const;
export const DOCUMENT_PRODUCT_FIELDS = ['englishName', 'chineseName', 'unitPrice', 'material', 'hsCode', 'use', 'brand', 'model', 'salesLink', 'currency'] as const;
export const DOCUMENT_BLANK_OUTPUT_FIELDS = ['orderNumber', 'reference', 'tradeTerms'] as const;

/** Resolve an omitted product currency without changing its saved declaration. */
export function documentProductCurrency(productCurrency: string | null | undefined, invoiceCurrency: string | null | undefined): string {
  const explicit = productCurrency?.trim();
  if (explicit) return explicit;
  const fallback = invoiceCurrency?.trim() ?? '';
  return (DOCUMENT_FIELD_OPTIONS.currency as readonly string[]).includes(fallback) ? fallback : '';
}

export const DOCUMENT_ADDRESS_FIELDS = ['addressCode', 'recipientName', 'recipientCompany', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'state', 'postalCode', 'countryCode', 'phone', 'email'] as const;
export const DOCUMENT_ADDRESS_REQUIRED_FIELDS = ['recipientName', 'addressLine1', 'city', 'postalCode', 'countryCode'] as const;
export type DocumentAddressField = typeof DOCUMENT_ADDRESS_FIELDS[number];
const addressText = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase() : '';
export function documentAddressDifferences(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): DocumentAddressField[] {
  return DOCUMENT_ADDRESS_FIELDS.filter((key) => addressText(left[key]) !== addressText(right[key]));
}
export function hasCompleteDocumentAddress(fields: Readonly<Record<string, unknown>>): boolean {
  return DOCUMENT_ADDRESS_REQUIRED_FIELDS.every((key) => Boolean(addressText(fields[key]))) && /^[A-Z]{2}$/.test(addressText(fields.countryCode));
}
/** Replace the whole address so omitted lines cannot leak from an earlier choice. */
export function applyDocumentAddress(fields: Readonly<Record<string, string | null>>, address: Readonly<Record<string, unknown>>): Record<string, string | null> {
  const result: Record<string, string | null> = { ...fields, addressConfirmed: 'false', addressConfirmationReason: '', addressSelectionMode: 'manual', addressAdoptionVersion: 'explicit/v1' };
  for (const key of DOCUMENT_ADDRESS_FIELDS) result[key] = typeof address[key] === 'string' ? address[key].trim() : '';
  return result;
}
const addressValue = z.string().trim().max(4000);
export const documentAddressDataSchema = z.object({
  destinationFc: z.string().trim().toUpperCase().min(1).max(40).regex(/^[A-Z0-9][A-Z0-9_-]*(?:\/[A-Z0-9][A-Z0-9_-]*)*$/, '目的仓只接受英文字母、数字、下划线、短横线或分隔仓代码的斜线'),
  recipientName: addressValue.min(1), addressLine1: addressValue.min(1), city: addressValue.min(1), postalCode: addressValue.min(1),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, '国家代码须为两个英文字母'),
  addressCode: addressValue.optional(), recipientCompany: addressValue.optional(), addressLine2: addressValue.optional(), addressLine3: addressValue.optional(),
  state: addressValue.optional(), phone: addressValue.optional(), email: addressValue.optional(),
}).passthrough();

export const documentSourceReferenceSchema = z.object({
  shippingRunId: z.uuid().optional(), shippingRunMonth: z.string().optional(), shippingRunSequence: z.number().int().positive().nullable().optional(),
  weekStartDate: z.iso.date(), groupId: z.uuid(), groupVersion: z.number().int().positive(), m2ConfirmationId: z.uuid(),
  demandId: z.uuid(), demandVersion: z.number().int().positive(), shipmentRevisionId: z.uuid(),
  physicalConfirmationId: z.uuid().nullable(), m3Version: z.number().int().positive().nullable(), sourceFingerprint: z.string().nullable(),
}).strict();
export const documentSourceCandidatesSchema = z.object({
  po: z.string().nullable().optional(),
  addresses: z.array(z.object({ source: z.string(), snapshotId: z.uuid(), data: z.record(z.string(), z.string().nullable()) })),
  products: z.array(z.object({ source: z.string(), snapshotId: z.uuid(), sid: z.number().int().positive(), msku: z.string(), fnsku: z.string(), sku: z.string(), asin: z.string().nullable(), imageUrl: z.string().nullable(), salesLink: z.string().nullable() })),
  issues: z.array(z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string() })),
});
export const documentMemberSnapshotSchema = z.object({
  source: documentSourceReferenceSchema,
  demand: demandRecordSchema,
  shipment: shipmentRevisionSchema,
  codes: z.array(allocationCodeSchema),
  physical: physicalConfirmationSchema.nullable(),
  boxSource: z.array(physicalBoxSchema).optional(),
  sourceCandidates: documentSourceCandidatesSchema.optional(),
}).strict();
export const documentProfileReferenceSchema = z.object({ category: documentProfileCategorySchema, profileId: z.uuid(), version: z.number().int().positive(), data: z.record(z.string(), z.unknown()) }).strict();
export const documentFieldsSchema = z.record(z.string().trim().min(1).max(120), z.string().nullable()).superRefine((fields, context) => {
  let totalImageBytes = 0;
  for (const [key, value] of Object.entries(fields)) {
    const imageKey = /^product\.[a-f0-9]{64}\.imageBase64$/.test(key);
    if (!imageKey) { if (value && value.length > 4000) context.addIssue({ code: 'custom', path: [key], message: '普通单票字段不能超过4000个字符。' }); continue; }
    if (!value?.trim()) continue;
    const base64 = value.trim().replace(/^data:image\/(?:png|jpeg);base64,/, '');
    const byteLength = Math.ceil(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (byteLength > DOCUMENT_PRODUCT_IMAGE_MAX_BYTES) context.addIssue({ code: 'custom', path: [key], message: '单张商品图片不能超过2 MiB。' });
    totalImageBytes += byteLength;
  }
  if (totalImageBytes > DOCUMENT_PRODUCT_IMAGES_MAX_BYTES) context.addIssue({ code: 'custom', message: '本票手动图片合计不能超过8 MiB，请压缩图片后保存。' });
});
export const documentProductImageSchema = z.object({ imageBase64: z.string(), imageExtension: z.enum(['png', 'jpeg']) }).strict().superRefine((image, context) => {
  const info = documentProductImageInfo(image.imageBase64);
  if (!info || info.extension !== image.imageExtension) context.addIssue({ code: 'custom', path: ['imageBase64'], message: '图片须为不超过2 MiB的完整PNG/JPEG。' });
});
export const documentProductImagePreviewInputSchema = z.object({ expectedVersion: z.number().int().positive(), sid: z.number().int().positive(), msku: z.string().max(200), fnsku: z.string().max(200), sku: z.string().max(200), url: z.string().trim().min(1).max(4000) }).strict();
export const documentTemplateReferenceSchema = z.object({ templateId: z.uuid(), version: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), fileId: z.uuid() }).strict();
export const documentGenerationRulesVersionSchema = z.enum(['v1', 'v2']);
/** Server-owned facts adopted from an archived Lingxing preview, never draft inputs. */
export const documentProductSourceFactSchema = z.object({
  sid: z.number().int().positive(), msku: z.string(), fnsku: z.string(), sku: z.string(),
  salesPrice: z.string().nullable(), currency: z.string().nullable(), unitPrice: z.string().nullable(), cartonQuantity: z.string().nullable(),
  sourceFileId: z.uuid(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), fetchedAt: z.iso.datetime(),
}).strict();
export const documentManualSalesPriceInputSchema = z.object({
  sid: z.number().int().positive(), msku: z.string().max(200), fnsku: z.string().max(200), sku: z.string().max(200),
  salesPrice: z.string().trim().max(100).nullable(), reason: z.string().trim().min(1).max(1000),
}).strict().superRefine((value, context) => {
  if (value.salesPrice !== null && !calculateDocumentInvoiceUnitPrice(value.salesPrice)) context.addIssue({ code: 'custom', path: ['salesPrice'], message: '售价须为有效正数，且20%保留两位小数后为可安全导出的正数。' });
});
export const documentManualSalesPriceSchema = z.object({
  sid: z.number().int().positive(), msku: z.string(), fnsku: z.string(), sku: z.string(), salesPrice: z.string(), currency: z.enum(['USD', 'EUR', 'GBP']),
  reason: z.string().trim().min(1).max(1000), recordedBy: z.string().min(1), recordedAt: z.iso.datetime(),
  sourceFileId: z.uuid(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), memberSources: z.array(documentSourceReferenceSchema).min(1).max(500),
}).strict();
export const documentRevisionDataSchema = z.object({
  purpose: documentPurposeSchema,
  shippingRunId: z.uuid().optional(), shippingRunMonth: z.string().optional(), shippingRunSequence: z.number().int().positive().nullable().optional(),
  weekStartDate: z.iso.date(),
  title: z.string().trim().min(1).max(200),
  fields: documentFieldsSchema,
  members: z.array(documentMemberSnapshotSchema).min(1).max(500),
  profileReferences: z.array(documentProfileReferenceSchema),
  templateReference: documentTemplateReferenceSchema.nullable(),
  generationRulesVersion: documentGenerationRulesVersionSchema.optional(),
  productSourceFacts: z.array(documentProductSourceFactSchema).max(5000).optional(),
  manualSalesPrices: z.array(documentManualSalesPriceSchema).max(5000).optional(),
}).strict();
export const documentRevisionSchema = z.object({ id: z.uuid(), documentId: z.uuid(), version: z.number().int().positive(), reason: z.string(), data: documentRevisionDataSchema, createdBy: z.string(), createdAt: z.iso.datetime() });
export const documentValidationIssueSchema = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string(), demandId: z.uuid().optional(), groupId: z.uuid().optional(), profileCategory: documentProfileCategorySchema.optional(), profileKey: z.string().optional() });
export const documentCandidateSchema = z.object({
  shippingRunId: z.uuid().optional(), shippingRunMonth: z.string().optional(), shippingRunSequence: z.number().int().positive().nullable().optional(),
  demandId: z.uuid(), weekStartDate: z.iso.date(), weekEndDate: z.iso.date(), groupId: z.uuid(), groupName: z.string(), groupVersion: z.number().int().positive(), groupStatus: z.enum(['draft', 'confirmed', 'frozen', 'superseded']),
  m2ConfirmationId: z.uuid(), demandVersion: z.number().int().positive(), demand: demandRecordSchema, shipment: shipmentRevisionSchema, codes: z.array(allocationCodeSchema),
  physicalConfirmationId: z.uuid().nullable(), m3Version: z.number().int().positive().nullable(), sourceFingerprint: z.string().nullable(), physical: physicalConfirmationSchema.nullable(),
  boxSource: z.array(physicalBoxSchema).optional(),
  sourceCandidates: documentSourceCandidatesSchema.optional(),
  blockers: z.array(documentValidationIssueSchema),
});
export const documentCandidateQuerySchema = z.object({ shippingRunId: z.uuid().optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), weekStartDate: z.iso.date().optional() });
export type DocumentCandidateQuery = z.infer<typeof documentCandidateQuerySchema>;
export const documentCandidateListSchema = z.object({ items: z.array(documentCandidateSchema), total: z.number().int().nonnegative(), weekStartDate: z.iso.date().optional(), shippingRunId: z.uuid().optional(), month: z.string().optional() });
export const documentSchema = z.object({ id: z.uuid(), purpose: documentPurposeSchema, status: documentStatusSchema, version: z.number().int().positive(), currentRevision: documentRevisionSchema, createdBy: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export const documentProfileSchema = z.object({ id: z.uuid(), category: documentProfileCategorySchema, key: z.string(), version: z.number().int().positive(), status: z.enum(['active', 'retired']), data: z.record(z.string(), z.unknown()), createdBy: z.string(), createdAt: z.iso.datetime() });
export const documentTemplateSchema = z.object({ id: z.uuid(), purpose: documentPurposeSchema, name: z.string(), version: z.number().int().positive(), mimeType: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), fileId: z.uuid(), status: z.enum(['active', 'retired']), createdBy: z.string(), createdAt: z.iso.datetime() });
export const documentExportReferenceSchema = z.object({ documentId: z.uuid(), revisionId: z.uuid(), revisionVersion: z.number().int().positive(), templateId: z.uuid(), templateVersion: z.number().int().positive(), templateSha256: z.string().regex(/^[a-f0-9]{64}$/), sources: z.array(documentSourceReferenceSchema).min(1), generationRulesVersion: documentGenerationRulesVersionSchema.optional(), pricingRule: z.literal('fixed-2').optional(), bundleJobId: z.uuid().optional(), invoiceFileName: z.string().min(1).max(200).optional(), invoiceFileSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const documentExportSchema = z.object({ id: z.uuid(), status: documentExportStatusSchema, reference: documentExportReferenceSchema, fileId: z.uuid().nullable(), fileSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), error: z.string().nullable(), createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), valid: z.boolean(), invalidReason: z.string().nullable() });
export const documentValidationSchema = z.object({ documentId: z.uuid(), version: z.number().int().positive(), valid: z.boolean(), issues: z.array(documentValidationIssueSchema), checkedAt: z.iso.datetime() });

export const documentAutomationErrorSchema = z.object({ code: z.string(), message: z.string() }).strict();
export const documentAutomationCountsSchema = z.object({ total: z.number().int().nonnegative(), queued: z.number().int().nonnegative(), running: z.number().int().nonnegative(), ready: z.number().int().nonnegative().default(0), exporting: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), blocked: z.number().int().nonnegative() }).strict();
export const documentAutomationFieldTargetSchema = z.object({ itemId: z.uuid(), documentId: z.uuid(), expectedVersion: z.number().int().positive(), fieldKey: z.string().min(1).max(200) }).strict();
export const documentAutomationFieldDescriptorSchema = z.object({
  id: z.string().min(1).max(200), label: z.string().min(1), kind: z.enum(['text', 'select', 'checkbox', 'number']),
  value: z.union([z.string(), z.boolean(), z.null()]), required: z.boolean(),
  scope: z.enum(['common', 'product', 'box', 'document']), scopeLabel: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
  targets: z.array(documentAutomationFieldTargetSchema).min(1), help: z.string().optional(),
}).strict();
export const documentAutomationSupplementSchema = z.object({ descriptors: z.array(documentAutomationFieldDescriptorSchema), issues: z.array(documentValidationIssueSchema.extend({ itemId: z.uuid(), documentId: z.uuid().nullable() }).strict()) }).strict();
export const documentAutomationBundleSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']), fileId: z.uuid().nullable(), fileName: z.string().nullable(),
  sheetCount: z.number().int().positive().nullable(), completedAt: z.iso.datetime().nullable(), error: documentAutomationErrorSchema.nullable(),
  fileCount: z.number().int().positive().nullable().optional(),
}).strict();
export const documentAutomationItemSchema = z.object({
  id: z.uuid(), demandIds: z.array(z.uuid()).min(1).max(500), fbas: z.array(z.string()).min(1),
  documentId: z.uuid().nullable(), documentVersion: z.number().int().positive().nullable(), exportId: z.uuid().nullable(), fileId: z.uuid().nullable(),
  stage: z.enum(['create', 'preview', 'apply', 'prepare', 'validate', 'ready', 'export', 'done']), status: z.enum(['queued', 'running', 'ready', 'exporting', 'completed', 'blocked']),
  issues: z.array(documentValidationIssueSchema), error: documentAutomationErrorSchema.nullable(), attempt: z.number().int().positive(),
}).strict();
export const documentAutomationJobSchema = z.object({
  id: z.uuid(), shippingRunId: z.uuid(), version: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'completed', 'partial', 'blocked', 'failed']), items: z.array(documentAutomationItemSchema), counts: documentAutomationCountsSchema,
  phase: z.enum(['preparing', 'needs_input', 'ready', 'generating', 'completed', 'failed']).default('preparing'),
  mode: z.enum(['single_workbook', 'legacy']).default('legacy'),
  bundle: documentAutomationBundleSchema.nullable().default(null), supplement: documentAutomationSupplementSchema.nullable().default(null),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), error: documentAutomationErrorSchema.nullable(),
}).strict();
export const documentAutomationStartInputSchema = z.object({ operationId: z.uuid(), shippingRunId: z.uuid(), demandIds: z.array(z.uuid()).min(1).max(500).optional(), documentId: z.uuid().optional(), expectedVersion: z.number().int().positive().optional(), fields: documentFieldsSchema.optional(), title: z.string().trim().min(1).max(200).optional() }).strict().superRefine((value, context) => {
  if (value.demandIds && new Set(value.demandIds).size !== value.demandIds.length) context.addIssue({ code: 'custom', path: ['demandIds'], message: '自动出单货件范围不能重复。' });
  if (Boolean(value.documentId) !== (value.expectedVersion !== undefined)) context.addIssue({ code: 'custom', path: ['expectedVersion'], message: '继续已有草稿须同时指定单据编号和预期版本。' });
  if (value.documentId && value.demandIds) context.addIssue({ code: 'custom', path: ['demandIds'], message: '继续已有草稿时不能另外指定货件范围。' });
});
export const documentAutomationRetryInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), itemIds: z.array(z.uuid()).min(1).max(500).optional() }).strict().superRefine((value, context) => {
  if (value.itemIds && new Set(value.itemIds).size !== value.itemIds.length) context.addIssue({ code: 'custom', path: ['itemIds'], message: '重试范围不能重复。' });
});
export const documentAutomationSupplementInputSchema = z.object({
  operationId: z.uuid(), expectedVersion: z.number().int().positive(),
  documentVersions: z.record(z.uuid(), z.number().int().positive()),
  values: z.array(z.object({ id: z.string().min(1).max(200), value: z.union([z.string().max(4000), z.boolean(), z.null()]) }).strict()).min(1).max(10000),
}).strict().superRefine((value, context) => {
  if (new Set(value.values.map((entry) => entry.id)).size !== value.values.length) context.addIssue({ code: 'custom', path: ['values'], message: '同一补充字段不能重复提交。' });
});
export const documentAutomationResponseSchema = z.object({ job: documentAutomationJobSchema, replayed: z.boolean().optional() }).strict();
export const documentAutomationListSchema = z.object({ items: z.array(documentAutomationJobSchema) }).strict();
export const documentAutomationDeleteResponseSchema = z.object({
  automationId: z.uuid(), version: z.number().int().positive(), deleted: z.literal(true), deletedAt: z.iso.datetime(),
  cancelledDocumentIds: z.array(z.uuid()), preservedDocumentIds: z.array(z.uuid()), replayed: z.boolean(),
}).strict();

export const documentCreateInputSchema = z.object({ operationId: z.uuid(), purpose: documentPurposeSchema.default('invoice'), weekStartDate: z.iso.date().optional(), shippingRunId: z.uuid().optional(), demandIds: z.array(z.uuid()).min(1).max(500), title: z.string().trim().min(1).max(200), fields: documentFieldsSchema.default({}) }).strict().superRefine((value, context) => {
  if (new Set(value.demandIds).size !== value.demandIds.length) context.addIssue({ code: 'custom', path: ['demandIds'], message: '货件范围不能重复。' });
});
export const documentRevisionInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000), title: z.string().trim().min(1).max(200).optional(), fields: documentFieldsSchema.optional(), confirmAddress: z.boolean().optional(), demandIds: z.array(z.uuid()).min(1).max(500).optional(), profileReferences: z.array(documentProfileReferenceSchema).optional(), templateReference: documentTemplateReferenceSchema.nullable().optional(), manualSalesPrices: z.array(documentManualSalesPriceInputSchema).max(5000).optional() }).strict();
export const documentProfileWriteSchema = z.object({ operationId: z.uuid(), profileId: z.uuid().optional(), expectedVersion: z.number().int().positive().optional(), category: documentProfileCategorySchema, key: z.string().trim().min(1).max(200), data: z.record(z.string(), z.unknown()), reason: z.string().trim().min(1).max(1000) }).strict().superRefine((value, context) => {
  if (value.profileId) context.addIssue({ code: 'custom', path: ['profileId'], message: '本地地址簿已停用；其他资料请按原分类与标识维护。' });
  if (value.category === 'address') {
    context.addIssue({ code: 'custom', path: ['category'], message: '收件地址以领星货件资料为准，不再维护本地地址簿。' });
  }
});
export const documentTemplateWriteSchema = z.object({ operationId: z.uuid(), expectedVersion: z.coerce.number().int().positive().optional(), purpose: documentPurposeSchema.default('invoice'), name: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(1000) }).strict();
export const documentOperationInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000).default('人工操作') }).strict();
export const documentReviewInputSchema = documentOperationInputSchema.extend({ decision: z.enum(['approve', 'return']), exportId: z.uuid(), fileSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const documentCorrectInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000), demandIds: z.array(z.uuid()).min(1).max(500), title: z.string().trim().min(1).max(200).optional(), fields: documentFieldsSchema.optional(), confirmAddress: z.boolean().optional(), manualSalesPrices: z.array(documentManualSalesPriceInputSchema).max(5000).optional() }).strict();

export type DocumentPurpose = z.infer<typeof documentPurposeSchema>;
export type DocumentProfileCategory = z.infer<typeof documentProfileCategorySchema>;
export type DocumentSourceReference = z.infer<typeof documentSourceReferenceSchema>;
export type DocumentMemberSnapshot = z.infer<typeof documentMemberSnapshotSchema>;
export type DocumentProductSourceFact = z.infer<typeof documentProductSourceFactSchema>;
export type DocumentManualSalesPriceInput = z.infer<typeof documentManualSalesPriceInputSchema>;
export type DocumentManualSalesPrice = z.infer<typeof documentManualSalesPriceSchema>;
export type DocumentRevisionData = z.infer<typeof documentRevisionDataSchema>;
export type DocumentRevision = z.infer<typeof documentRevisionSchema>;
export type Document = z.infer<typeof documentSchema>;
export type DocumentProfile = z.infer<typeof documentProfileSchema>;
export type DocumentTemplate = z.infer<typeof documentTemplateSchema>;
export type DocumentExportReference = z.infer<typeof documentExportReferenceSchema>;
export type DocumentExport = z.infer<typeof documentExportSchema>;
export type DocumentValidation = z.infer<typeof documentValidationSchema>;
export type DocumentAutomationError = z.infer<typeof documentAutomationErrorSchema>;
export type DocumentAutomationCounts = z.infer<typeof documentAutomationCountsSchema>;
export type DocumentAutomationItem = z.infer<typeof documentAutomationItemSchema>;
export type DocumentAutomationJob = z.infer<typeof documentAutomationJobSchema>;
export type DocumentAutomationStartInput = z.infer<typeof documentAutomationStartInputSchema>;
export type DocumentAutomationRetryInput = z.infer<typeof documentAutomationRetryInputSchema>;
export type DocumentAutomationResponse = z.infer<typeof documentAutomationResponseSchema>;
export type DocumentAutomationList = z.infer<typeof documentAutomationListSchema>;
export type DocumentAutomationDeleteResponse = z.infer<typeof documentAutomationDeleteResponseSchema>;
export type DocumentAutomationFieldTarget = z.infer<typeof documentAutomationFieldTargetSchema>;
export type DocumentAutomationFieldDescriptor = z.infer<typeof documentAutomationFieldDescriptorSchema>;
export type DocumentAutomationSupplement = z.infer<typeof documentAutomationSupplementSchema>;
export type DocumentAutomationSupplementInput = z.infer<typeof documentAutomationSupplementInputSchema>;
export type DocumentAutomationBundle = z.infer<typeof documentAutomationBundleSchema>;
export type DocumentCandidate = z.infer<typeof documentCandidateSchema>;
export type DocumentCandidateList = z.infer<typeof documentCandidateListSchema>;

type DocumentProductIdentity = { msku: string; fnsku: string; sku: string };
/** Fixed text ordering keeps a box's representative independent of response order or locale. */
export function documentRepresentativeProduct<T extends DocumentProductIdentity>(items: readonly T[]): T | undefined {
  return items.reduce<T | undefined>((first, item) => {
    if (!first) return item;
    for (const key of ['msku', 'fnsku', 'sku'] as const) {
      if (item[key] < first[key]) return item;
      if (item[key] > first[key]) return first;
    }
    return first;
  }, undefined);
}

/** Invoice v2 keeps one representative across a complete FBA with matching physical values. */
export function documentInvoiceBoxGroups(boxes: readonly PhysicalBox[]) {
  const signature = (box: PhysicalBox) => JSON.stringify([box.po, box.values.weight, box.values.length, box.values.width, box.values.height]);
  const combine = boxes.length > 0 && boxes.every((box, index) => box.order === index + 1 && signature(box) === signature(boxes[0]!));
  return (combine ? [[...boxes]] : boxes.map((box) => [box])).map((selected) => {
    const representative = documentRepresentativeProduct(selected.flatMap((box) => box.items));
    const box = selected.find((candidate) => representative && candidate.items.includes(representative)) ?? selected[0]!;
    return { boxes: selected, box, representative };
  });
}
export function documentProductSourceFact(data: Pick<DocumentRevisionData, 'productSourceFacts'>, sid: number, item: DocumentProductIdentity): DocumentProductSourceFact | undefined {
  const matches = data.productSourceFacts?.filter((fact) => fact.sid === sid && fact.msku === item.msku && fact.fnsku === item.fnsku && fact.sku === item.sku) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}
/** Exact decimal arithmetic shared by the editor and the final invoice renderer. */
export function calculateDocumentInvoiceUnitPrice(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 100 || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole = '', fraction = ''] = text.split('.'), amount = BigInt(whole + fraction);
  if (amount <= 0n) return null;
  const divisor = 10n ** BigInt(fraction.length), numerator = amount * 20n;
  const cents = (numerator * 2n + divisor) / (divisor * 2n);
  if (cents <= 0n) return null;
  const result = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`, numeric = Number(result);
  const canonical = (input: string) => input.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return Number.isFinite(numeric) && numeric <= Number.MAX_SAFE_INTEGER && canonical(String(numeric)) === canonical(result) ? result : null;
}
export function documentManualSalesPriceSources(data: Pick<DocumentRevisionData, 'members'>, sid: number, item: DocumentProductIdentity): DocumentSourceReference[] {
  return data.members.filter((member) => member.demand.snapshot.sid === sid && member.shipment.data.items.some((entry) => entry.msku === item.msku && entry.fnsku === item.fnsku && entry.sku === item.sku)).map((member) => member.source);
}
const manualSalesPriceSourcesKey = (sources: DocumentSourceReference[]) => JSON.stringify(sources.map((source) => [source.shippingRunId ?? null, source.weekStartDate, source.groupId, source.groupVersion, source.m2ConfirmationId, source.demandId, source.demandVersion, source.shipmentRevisionId, source.physicalConfirmationId, source.m3Version, source.sourceFingerprint]).sort((a, b) => String(a[5]).localeCompare(String(b[5]))));
/** A manual fallback never makes a valid remote price or a currency conflict editable. */
export function documentCanManuallySupplySalesPrice(data: DocumentRevisionData, sid: number, item: DocumentProductIdentity): boolean {
  const fact = documentProductSourceFact(data, sid, item), currency = documentTicketCurrency(data.members);
  return data.generationRulesVersion === 'v2' && Boolean(fact && !calculateDocumentInvoiceUnitPrice(fact.salesPrice) && currency && documentManualSalesPriceSources(data, sid, item).length);
}
export type DocumentEffectiveSalesPrice = { source: 'lingxing' | 'manual' | 'missing'; salesPrice: string; currency: string; unitPrice: string; manual?: DocumentManualSalesPrice; issue?: string };
export function documentEffectiveSalesPrice(data: DocumentRevisionData, sid: number, item: DocumentProductIdentity): DocumentEffectiveSalesPrice {
  const fact = documentProductSourceFact(data, sid, item), unitPrice = calculateDocumentInvoiceUnitPrice(fact?.salesPrice);
  if (unitPrice) return { source: 'lingxing', salesPrice: fact!.salesPrice!, currency: fact!.currency?.trim().toUpperCase() ?? '', unitPrice };
  const currency = documentTicketCurrency(data.members) ?? '', matches = data.manualSalesPrices?.filter((entry) => entry.sid === sid && entry.msku === item.msku && entry.fnsku === item.fnsku && entry.sku === item.sku) ?? [];
  const manual = matches.length === 1 ? matches[0] : undefined;
  const missing = { source: 'missing' as const, salesPrice: '', currency: fact?.currency?.trim().toUpperCase() || currency, unitPrice: '' };
  if (!manual) return missing;
  if (!documentCanManuallySupplySalesPrice(data, sid, item) || manual.currency !== currency || manualSalesPriceSourcesKey(manual.memberSources) !== manualSalesPriceSourcesKey(documentManualSalesPriceSources(data, sid, item))) return { ...missing, issue: 'DOCUMENT_MANUAL_SALES_PRICE_STALE' };
  const derived = calculateDocumentInvoiceUnitPrice(manual.salesPrice);
  if (!derived || !manual.reason.trim() || !manual.recordedBy || !manual.recordedAt || !manual.sourceFileId || !manual.sourceSha256) return { ...missing, issue: 'DOCUMENT_MANUAL_SALES_PRICE_INVALID' };
  return { source: 'manual', salesPrice: manual.salesPrice, currency, unitPrice: derived, manual };
}

export const DOCUMENT_DEFAULT_FLAGS = ['battery', 'magnetic', 'liquid', 'powder', 'dangerous'] as const;
export function withDocumentDefaults(fields: Readonly<Record<string, string | null>>): Record<string, string | null> {
  const result = { ...fields };
  for (const key of DOCUMENT_DEFAULT_FLAGS) if (!result[key]?.trim()) result[key] = '否';
  return result;
}

const documentCountryAliases: Record<string, string> = {
  US: 'US', USA: 'US', 'UNITED STATES': 'US', '美国': 'US', GB: 'GB', UK: 'GB', 'UNITED KINGDOM': 'GB', '英国': 'GB',
  DE: 'DE', GERMANY: 'DE', '德国': 'DE', FR: 'FR', FRANCE: 'FR', '法国': 'FR', ES: 'ES', SPAIN: 'ES', '西班牙': 'ES',
  IT: 'IT', ITALY: 'IT', '意大利': 'IT', NL: 'NL', NETHERLANDS: 'NL', '荷兰': 'NL', PL: 'PL', POLAND: 'PL', '波兰': 'PL', SE: 'SE', SWEDEN: 'SE', '瑞典': 'SE',
  BE: 'BE', BELGIUM: 'BE', '比利时': 'BE', IE: 'IE', IRELAND: 'IE', '爱尔兰': 'IE', CA: 'CA', CANADA: 'CA', '加拿大': 'CA',
  JP: 'JP', JAPAN: 'JP', '日本': 'JP', AU: 'AU', AUSTRALIA: 'AU', '澳大利亚': 'AU', '澳洲': 'AU', MX: 'MX', '墨西哥': 'MX',
};
export function documentCountryCode(value: string): string | undefined { return documentCountryAliases[value.normalize('NFKC').trim().toUpperCase()]; }
export function documentCurrencyForCountry(country: string): 'USD' | 'GBP' | 'EUR' | undefined {
  const code = documentCountryCode(country);
  return code === 'US' ? 'USD' : code === 'GB' ? 'GBP' : code && ['DE', 'FR', 'ES', 'IT'].includes(code) ? 'EUR' : undefined;
}
/** Only a single supported currency can be adopted for the whole invoice. */
export function documentTicketCurrency(members: ReadonlyArray<Pick<DocumentMemberSnapshot, 'demand'>>): 'USD' | 'GBP' | 'EUR' | undefined {
  const currencies = members.map((member) => documentCurrencyForCountry(member.demand.snapshot.country));
  return currencies.length && currencies.every((currency) => currency && currency === currencies[0]) ? currencies[0] : undefined;
}
export const DOCUMENT_INVOICE_UNIT_PRICE = '2.00';
/** Current invoice declarations use a fixed amount in the ticket's currency. */
export function documentInvoicePrice(data: Pick<DocumentRevisionData, 'members' | 'fields'>): { unitPrice: string; currency: string } {
  return { unitPrice: DOCUMENT_INVOICE_UNIT_PRICE, currency: documentTicketCurrency(data.members) ?? data.fields.currency?.trim() ?? '' };
}
export function withDocumentInvoiceDefaults(fields: Readonly<Record<string, string | null>>, members: ReadonlyArray<Pick<DocumentMemberSnapshot, 'demand'>>): Record<string, string | null> {
  const result = withDocumentDefaults(fields);
  for (const key of DOCUMENT_BLANK_OUTPUT_FIELDS) result[key] = null;
  const currency = documentTicketCurrency(members);
  if (currency) result.currency = currency;
  return result;
}
type DocumentAddressMember = Pick<DocumentMemberSnapshot, 'demand'> & Partial<Pick<DocumentMemberSnapshot, 'sourceCandidates'>>;
/** FBA source address codes take precedence; destination FC is the legacy code. */
export function documentMemberAddressCode(member: DocumentAddressMember): string | undefined {
  const codes = [...new Set((member.sourceCandidates?.addresses ?? []).map((entry) => addressText(entry.data.addressCode)).filter(Boolean))];
  if (codes.length > 1) return undefined;
  return codes[0] || addressText(member.demand.snapshot.destinationFc) || undefined;
}
export function matchDocumentAddressProfiles<T extends { category: string; status: string; data: Record<string, unknown> }>(
  members: ReadonlyArray<DocumentAddressMember>, profiles: readonly T[],
): T[] {
  if (!members.length) return [];
  const code = documentMemberAddressCode(members[0]!), country = documentCountryCode(members[0]!.demand.snapshot.country);
  if (!code || !country || members.some((member) => documentMemberAddressCode(member) !== code || documentCountryCode(member.demand.snapshot.country) !== country)) return [];
  const available = profiles.filter((profile) => profile.category === 'address' && profile.status === 'active'
    && documentCountryCode(addressText(profile.data.countryCode)) === country && hasCompleteDocumentAddress(profile.data));
  const exact = available.filter((profile) => addressText(profile.data.addressCode) === code);
  return exact.length ? exact : available.filter((profile) => addressText(profile.data.destinationFc) === code || addressText(profile.data.fc) === code);
}

export function hasDocumentAddressConflict(addresses: ReadonlyArray<Record<string, string | null>>): boolean {
  const normalize = (value: string | null | undefined) => value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase() ?? '';
  return ['addressLine1', 'addressLine2', 'addressLine3', 'city', 'state', 'postalCode', 'countryCode']
    .some((key) => new Set(addresses.map((address) => normalize(address[key])).filter(Boolean)).size > 1);
}

/** Adopt only complete, compatible Lingxing shipment evidence covering every member. */
export function resolveDocumentLingxingAddress(members: ReadonlyArray<DocumentAddressMember>): Record<string, string | null> | null {
  const sources = members.map((member) => (member.sourceCandidates?.addresses ?? []).filter((candidate) => ['listShipments', 'getShipmentDetails'].includes(candidate.source)));
  if (!sources.length || sources.some((entries) => !entries.length)) return null;
  // Each FBA must establish its own complete address before cross-FBA comparison.
  const completeMembers = sources.every((entries) => DOCUMENT_ADDRESS_REQUIRED_FIELDS.every((key) => entries.some((entry) => Boolean(addressText(entry.data[key])))));
  if (!completeMembers) return null;
  const addresses = sources.flat().map((entry) => entry.data);
  if (hasDocumentAddressConflict(addresses)) return null;
  const merged: Record<string, string | null> = {};
  const completeFirst = [...addresses].sort((left, right) => DOCUMENT_ADDRESS_FIELDS.filter((key) => Boolean(right[key]?.trim())).length - DOCUMENT_ADDRESS_FIELDS.filter((key) => Boolean(left[key]?.trim())).length);
  for (const key of DOCUMENT_ADDRESS_FIELDS) merged[key] = completeFirst.find((address) => address[key]?.trim())?.[key]?.trim() ?? '';
  merged.countryCode = addressText(merged.countryCode);
  if (!hasCompleteDocumentAddress(merged) || members.some((member) => {
    const expected = documentCountryCode(member.demand.snapshot.country);
    return expected && expected !== merged.countryCode;
  })) return null;
  return merged;
}

// A preview is bound to the saved invoice version. Apply accepts only its
// operation ID; the server reloads the archived result instead of client data.
export const documentLingxingPreviewInputSchema = z.object({
  operationId: z.uuid(), expectedVersion: z.number().int().positive(),
}).strict();
export const documentLingxingApplyInputSchema = documentLingxingPreviewInputSchema.extend({
  previewOperationId: z.uuid(), reason: z.string().trim().min(1).max(1000),
  confirmPrices: z.boolean().default(false),
}).strict();
export const documentLingxingIssueSchema = z.object({ code: z.string(), message: z.string(), permission: z.string().optional() });
export const documentLingxingPreviewSchema = z.object({
  documentId: z.uuid(), documentVersion: z.number().int().positive(), operationId: z.uuid(),
  products: z.array(z.object({ sid: z.number().int().positive(), msku: z.string(), fnsku: z.string(), sku: z.string(),
    data: z.record(z.string(), z.unknown()), imageUrls: z.array(z.string()), issues: z.array(z.string()),
  })),
  fields: z.record(z.string(), z.string().nullable()),
  parties: z.array(z.record(z.string(), z.unknown())),
  issues: z.array(documentLingxingIssueSchema), sourceFileId: z.uuid(),
});
export type DocumentLingxingPreview = z.infer<typeof documentLingxingPreviewSchema>;
export type DocumentLingxingIssue = z.infer<typeof documentLingxingIssueSchema>;
