import { z } from 'zod';

const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, '请选择有效国家');
const transportMethod = z.string().trim().min(1).max(500);
const service = z.string().trim().min(1, '请填写发票服务').max(4000);
const fields = { countryCode, transportMethod, transportMethodId: z.string().trim().min(1).max(200).nullable().optional(), service };
const operation = { operationId: z.uuid(), reason: z.string().trim().max(1000).optional() };

export const serviceMappingSchema = z.object({
  id: z.uuid(), countryCode, transportMethod, transportMethodId: z.string().nullable(), service,
  version: z.number().int().positive(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), deletedAt: z.iso.datetime().nullable(),
}).strict();
export type ServiceMapping = z.infer<typeof serviceMappingSchema>;
export const serviceMappingListSchema = z.object({ items: z.array(serviceMappingSchema) }).strict();
export type ServiceMappingList = z.infer<typeof serviceMappingListSchema>;
export const serviceMappingCreateInputSchema = z.object({ ...operation, ...fields }).strict();
export type ServiceMappingCreateInput = z.infer<typeof serviceMappingCreateInputSchema>;
export const serviceMappingRevisionInputSchema = z.object({ ...operation, ...fields, expectedVersion: z.number().int().positive() }).strict();
export type ServiceMappingRevisionInput = z.infer<typeof serviceMappingRevisionInputSchema>;
export const serviceMappingDeleteInputSchema = z.object({ ...operation, expectedVersion: z.number().int().positive() }).strict();
export type ServiceMappingDeleteInput = z.infer<typeof serviceMappingDeleteInputSchema>;
export const serviceMappingMutationResultSchema = z.object({ mapping: serviceMappingSchema, replayed: z.boolean() }).strict();
export type ServiceMappingMutationResult = z.infer<typeof serviceMappingMutationResultSchema>;
const directory = <T extends z.ZodType>(item: T) => z.object({ status: z.enum(['available', 'unavailable']), items: z.array(item), message: z.string().optional() }).strict();
export const serviceMappingOptionsSchema = z.object({
  countries: directory(z.object({ code: countryCode, name: z.string() }).strict()),
  transportMethods: directory(z.object({ id: z.string(), name: transportMethod, enabled: z.boolean(), remark: z.string() }).strict()),
}).strict();
export type ServiceMappingOptions = z.infer<typeof serviceMappingOptionsSchema>;
