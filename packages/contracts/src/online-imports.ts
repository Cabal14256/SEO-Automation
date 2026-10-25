import { z } from 'zod';
import { sellerCatalogModeSchema } from './seller-mappings.js';

const cell = z.string().max(2000).default('');
export const onlineImportRowSchema = z.object({
  fba: cell, shop: cell, channel: cell, country: cell, destinationFc: cell,
  destinationAddress: cell, shipmentCreatedAt: cell, sourceFilledAt: cell,
  referenceQuantity: cell, notes: cell,
  lookupId: z.uuid().optional(), lookupSid: z.number().int().positive().optional(),
}).strict();
export type OnlineImportRow = z.infer<typeof onlineImportRowSchema>;
export const onlineImportInputSchema = z.object({ operationId: z.uuid(), rows: z.array(onlineImportRowSchema).min(1).max(1000) }).strict();
export type OnlineImportInput = z.infer<typeof onlineImportInputSchema>;

export const transportMethodSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), enabled: z.boolean(), remark: z.string(),
});
export type TransportMethod = z.infer<typeof transportMethodSchema>;
export const transportMethodsResponseSchema = z.object({ items: z.array(transportMethodSchema), queriedAt: z.iso.datetime() });
export type TransportMethodsResponse = z.infer<typeof transportMethodsResponseSchema>;

export const fbaLookupInputSchema = z.object({
  operationId: z.uuid(), fbas: z.array(z.string().trim().toUpperCase().regex(/^FBA[A-Z0-9]+$/).max(100)).min(1).max(100),
  startDate: z.iso.date(), endDate: z.iso.date(),
  expectedCatalogSettingsVersion: z.number().int().positive(), expectedCatalogVersion: z.number().int().nonnegative(),
}).strict().refine((value) => value.startDate <= value.endDate, { message: '开始日期不能晚于结束日期。', path: ['endDate'] });
export type FbaLookupInput = z.infer<typeof fbaLookupInputSchema>;
export const fbaLookupChannelOptionSchema = z.object({
  // name is the transport method (method_name); channelIds are logistics-channel evidence only.
  name: z.string(), shipmentNumbers: z.array(z.string()), channelIds: z.array(z.string()), methodNames: z.array(z.string()),
});
export type FbaLookupChannelOption = z.infer<typeof fbaLookupChannelOptionSchema>;
export const fbaLookupCandidateSchema = z.object({
  sid: z.number().int().positive(), shop: z.string(), country: z.string(),
  destinationFc: z.string().nullable(), destinationAddress: z.string().nullable(),
  shipmentCreatedAt: z.string().nullable(), channel: z.string().nullable().default(null),
  channelSource: z.literal('method_name').optional(),
  channelStatus: z.enum(['unique', 'ambiguous', 'not_found', 'unavailable']).default('unavailable'),
  channelOptions: z.array(fbaLookupChannelOptionSchema).default([]), observedAt: z.string(),
});
export type FbaLookupCandidate = z.infer<typeof fbaLookupCandidateSchema>;
export const fbaLookupRowSchema = z.object({ fba: z.string(), status: z.enum(['unique', 'ambiguous', 'not_found']), candidates: z.array(fbaLookupCandidateSchema) });
export type FbaLookupRow = z.infer<typeof fbaLookupRowSchema>;
export const fbaLookupRecordSchema = z.object({
  id: z.uuid(), status: z.enum(['queued', 'running', 'completed', 'failed']),
  startDate: z.iso.date(), endDate: z.iso.date(), fbas: z.array(z.string()),
  catalogMode: sellerCatalogModeSchema, catalogSettingsVersion: z.number().int().positive(), catalogVersion: z.number().int().nonnegative(),
  createdAt: z.string(), completedAt: z.string().nullable(),
  errorCode: z.string().nullable(), errorMessage: z.string().nullable(), rows: z.array(fbaLookupRowSchema),
});
export type FbaLookupRecord = z.infer<typeof fbaLookupRecordSchema>;
