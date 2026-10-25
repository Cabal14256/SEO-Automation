import { z } from 'zod';

export const sellerMappingStatusSchema = z.enum(['candidate', 'approved', 'disabled']);
export const sellerCatalogModeSchema = z.enum(['lingxing', 'manual']);
export const sellerCatalogSettingsSchema = z.object({ mode: sellerCatalogModeSchema, version: z.number().int().positive(), catalogVersion: z.number().int().nonnegative(), lastSyncedAt: z.iso.datetime().nullable(), lastError: z.object({ code: z.string(), message: z.string() }).nullable(), configured: z.boolean(), readOnly: z.literal(true) });
export type SellerCatalogSettings = z.infer<typeof sellerCatalogSettingsSchema>;
export const sellerCatalogModeInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), mode: sellerCatalogModeSchema }).strict();
export type SellerCatalogModeInput = z.infer<typeof sellerCatalogModeInputSchema>;
export const sellerCatalogSyncInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive() }).strict();
export type SellerCatalogSyncInput = z.infer<typeof sellerCatalogSyncInputSchema>;
const optionalId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/).nullable();
const aliasRevisionFields = {
  aliases: z.array(z.string().trim().min(1).max(160)).max(50),
  status: sellerMappingStatusSchema,
  reason: z.string().trim().max(500).default(''),
  identityConfirmed: z.boolean().optional(),
};
function validateAliases(value: { aliases: string[]; status: string; reason: string; identityConfirmed?: boolean }, context: z.RefinementCtx) {
  const aliases = value.aliases.map((alias) => alias.normalize('NFKC').trim().toLowerCase());
  if (new Set(aliases).size !== aliases.length) context.addIssue({ code: 'custom', path: ['aliases'], message: '别名规范化后不能重复' });
  if (!value.reason && !(value.status === 'approved' && value.identityConfirmed === true)) {
    context.addIssue({ code: 'custom', path: ['reason'], message: '请填写修改原因；首次批准可勾选“已核对店铺身份”' });
  }
}
export const sellerAliasRevisionSchema = z.object({
  operationId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  expectedCatalogSettingsVersion: z.number().int().positive(),
  expectedCatalogVersion: z.number().int().nonnegative(),
  ...aliasRevisionFields,
  status: z.enum(['approved', 'disabled']),
}).strict().superRefine(validateAliases);
export type SellerAliasRevisionInput = z.infer<typeof sellerAliasRevisionSchema>;

export const sellerMappingRevisionSchema = z.object({
  operationId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  sid: z.number().int().positive().max(2147483647).optional(),
  name: z.string().trim().min(1).max(160),
  country: z.string().trim().min(1).max(80),
  marketplaceId: optionalId,
  wid: z.string().trim().regex(/^[1-9]\d{0,19}$/, '仓库 wid 必须为正整数编号').nullable(),
  ...aliasRevisionFields,
}).strict().superRefine(validateAliases);
export type SellerMappingRevisionInput = z.infer<typeof sellerMappingRevisionSchema>;
export const manualSellerCreateSchema = z.object({ operationId: z.uuid(), sid: z.number().int().positive().max(2147483647), name: z.string().trim().min(1).max(160), country: z.string().trim().min(1).max(80) }).strict();
export type ManualSellerCreateInput = z.infer<typeof manualSellerCreateSchema>;

export const sellerMappingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).default(''),
  status: sellerMappingStatusSchema.optional(),
});

export const sellerMappingSchema = z.object({
  id: z.uuid(), sid: z.number().int().positive(), name: z.string(), country: z.string(),
  marketplaceId: z.string().nullable(), wid: z.string().nullable(), aliases: z.array(z.string()),
  status: sellerMappingStatusSchema, version: z.number().int().positive(),
  updatedAt: z.iso.datetime(), sourceObservedAt: z.iso.datetime(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  dataSource: sellerCatalogModeSchema.default('manual'), manualEnabled: z.boolean().default(true),
  lingxingName: z.string().nullable().default(null), lingxingStatus: z.string().nullable().default(null), identityLocked: z.boolean().default(true),
  hasApprovedBefore: z.boolean().default(false),
  autoApproved: z.boolean().default(false),
});
export type SellerMapping = z.infer<typeof sellerMappingSchema>;
