import { z } from 'zod';

export const CUSTOMS_TEMPLATE_VERSION = 'customs-seven/v1';
export const CUSTOMS_SHEETS = ['报关单', '申报要素', '填制规范', '发票', '箱单', '合同', '委托书'] as const;
export const CUSTOMS_ACTIONS = ['save', 'preflight', 'review', 'return', 'record-customs', 'record-9810', 'complete', 'cancel'] as const;
export const CUSTOMS_EXPORT_PURPOSES = ['customs-package', 'filing9810-checklist'] as const;
const text = z.string().trim().max(4000).default('');
const numberText = z.string().trim().max(40).default('');

export const customsLineSchema = z.object({
  boxId: z.uuid(), msku: text, fnsku: text, sku: text,
  chineseName: text, englishName: text, hsCode: text, material: text, use: text, brand: text, model: text,
  quantity: numberText, declaredQuantity: numberText, unit: text, unitPrice: numberText, currency: text,
  conversionConfirmed: z.boolean().default(false), conversionReason: text,
}).strict();
export type CustomsLine = z.infer<typeof customsLineSchema>;
export const customsBoxWeightSchema = z.object({ boxId: z.uuid(), grossWeight: numberText, netWeight: numberText, confirmed: z.boolean().default(false) }).strict();
export const customsExternalResultSchema = z.object({
  status: z.enum(['draft', 'saved', 'review_passed', 'applied', 'success', 'returned', 'unknown']).default('draft'),
  externalNumber: text, feedbackFileIds: z.array(z.uuid()).max(100).default([]),
  submittedExportId: text, submittedSha256: text, reason: text,
}).strict();
export type CustomsExternalResult = z.infer<typeof customsExternalResultSchema>;
export const customsDataSchema = z.object({
  entity: text, countryCodes: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(100).default([]),
  declarationMode: z.string().trim().max(120).default('9810'), currency: text, freightAmount: numberText, freightCurrency: text,
  exportDate: text, contractNumber: text, invoiceNumber: text,
  sellerName: text, sellerAddress: text, buyerName: text, buyerAddress: text,
  portOfLoading: text, portOfDestination: text, tradeTerms: text, ecommerceOrderNumber: text,
  lines: z.array(customsLineSchema).max(10000).default([]),
  boxWeights: z.array(customsBoxWeightSchema).max(5000).default([]),
  crossCountryConfirmation: z.object({ confirmed: z.boolean().default(false), reason: text }).strict().default({ confirmed: false, reason: '' }),
  templateFileId: z.uuid().nullable().default(null), templateVersion: z.literal(CUSTOMS_TEMPLATE_VERSION).default(CUSTOMS_TEMPLATE_VERSION),
  review: z.object({ exportId: z.uuid(), fileSha256: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().max(64).default('') }).strict().nullable().default(null),
  customsResult: customsExternalResultSchema.default({ status: 'draft', externalNumber: '', feedbackFileIds: [], submittedExportId: '', submittedSha256: '', reason: '' }),
  filing9810Result: customsExternalResultSchema.default({ status: 'draft', externalNumber: '', feedbackFileIds: [], submittedExportId: '', submittedSha256: '', reason: '' }),
}).strict();
export type CustomsData = z.infer<typeof customsDataSchema>;
