import { z } from 'zod';
import { batchIssueSchema } from './batches.js';

export const demandWorkspaceStatusSchema = z.enum(['unsynced', 'candidate', 'needs_review', 'confirmed', 'frozen']);
export type DemandWorkspaceStatus = z.infer<typeof demandWorkspaceStatusSchema>;
export const demandWorkspaceQuerySchema = z.object({
  lifecycle: z.enum(['active', 'cancelled', 'all']).default('active'),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  shippingRunId: z.uuid().optional(),
  weekStartDate: z.iso.date().optional(), groupId: z.uuid().optional(),
  grouping: z.enum(['ungrouped']).optional(), pageBy: z.enum(['demand']).optional(),
  batchId: z.uuid().optional(), sid: z.coerce.number().int().positive().optional(),
  country: z.string().trim().min(1).max(120).optional(), channel: z.string().trim().min(1).max(120).optional(),
  region: z.enum(['all', 'US', 'EU']).optional(),
  status: demandWorkspaceStatusSchema.optional(), q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type DemandWorkspaceQuery = z.infer<typeof demandWorkspaceQuerySchema>;

const nullableText = z.string().nullable();
const nullableVersion = z.number().int().positive().nullable();
export const demandWorkspaceRowSchema = z.object({
  lifecycle: z.enum(['active', 'cancelled']).default('active'),
  id: z.string(), demandId: z.uuid(), rowKind: z.enum(['product', 'placeholder']),
  demandVersion: z.number().int().positive(), currentDemandVersion: z.number().int().positive(),
  businessDate: z.iso.date(), weekStartDate: z.iso.date(), weekEndDate: z.iso.date(),
  shippingRunId: z.uuid().nullable().optional(), shippingMonth: z.string().nullable().optional(), shippingSequence: z.number().int().positive().nullable().optional(), ticketNumber: z.string().nullable().optional(),
  sid: z.number().int().positive(), shop: z.string(), country: z.string(), channel: nullableText,
  destinationFc: nullableText, destinationAddress: nullableText, fba: z.string(),
  msku: nullableText, fnsku: nullableText, sku: nullableText, productName: nullableText,
  quantity: z.number().int().nonnegative().nullable(), referenceQuantity: nullableText,
  groupQuantity: z.number().int().nonnegative().nullable().optional(), monthQuantity: z.number().int().nonnegative().nullable().optional(),
  totalBoxes: z.number().int().nonnegative().nullable(),
  boxes: z.array(z.object({ boxId: z.uuid(), boxOrder: z.number().int().positive(), displayBoxOrder: z.number().int().positive().optional(), quantity: z.number().int().nonnegative().nullable(), code: nullableText,
    sourceLabel: z.string().optional(), orderConfirmed: z.boolean().optional(),
    boxName: nullableText.optional(), externalBoxId: nullableText.optional(), localBoxId: nullableText.optional(),
    weight: z.number().nullable().optional(), weightUnit: nullableText.optional(),
    length: z.number().nullable().optional(), width: z.number().nullable().optional(), height: z.number().nullable().optional(), lengthUnit: nullableText.optional() })),
  codes: z.array(z.string()), status: demandWorkspaceStatusSchema,
  groupId: z.uuid().nullable(), groupName: nullableText, groupVersion: nullableVersion,
  batchId: z.uuid().nullable(), confirmationId: z.uuid().nullable(),
  dataRevisionId: z.uuid().nullable(), dataVersion: nullableVersion,
  actualShipDate: z.iso.date().nullable(), shipmentCreatedAt: nullableText, sourceFilledAt: nullableText,
  packingDays: z.number().int().nullable(), metadataSource: nullableText, metadataObservedAt: nullableText,
  notes: nullableText, issues: z.array(batchIssueSchema),
  sources: z.array(z.object({ importId: z.uuid(), fileName: z.string(), sheetName: z.string(), rowNumber: z.number().int().positive() })),
});
export type DemandWorkspaceRow = z.infer<typeof demandWorkspaceRowSchema>;
export const demandWorkspaceSchema = z.object({
  rows: z.array(demandWorkspaceRowSchema), total: z.number().int().nonnegative(), demandTotal: z.number().int().nonnegative(),
  page: z.number().int().positive(), pageSize: z.number().int().positive(), maxBoxes: z.number().int().min(10),
  filters: z.object({
    shippingRuns: z.array(z.object({ id: z.uuid(), month: z.string(), sequence: z.number().int().positive().nullable(), numberingDate: z.iso.date() })).default([]),
    weeks: z.array(z.object({ weekStartDate: z.iso.date(), weekEndDate: z.iso.date(), demandCount: z.number().int().nonnegative() })).default([]),
    batches: z.array(z.object({ id: z.uuid(), weekStartDate: z.iso.date(), weekEndDate: z.iso.date() })),
    shops: z.array(z.object({ sid: z.number().int().positive(), name: z.string() })), countries: z.array(z.string()), channels: z.array(z.string()),
  }), generatedAt: z.iso.datetime(),
});
export type DemandWorkspace = z.infer<typeof demandWorkspaceSchema>;
