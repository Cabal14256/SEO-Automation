import { z } from 'zod';

export const shippingRunStatusSchema = z.enum(['draft', 'queued', 'running', 'needs_review', 'ready', 'failed']);
export const shippingRunStageSchema = z.enum(['lookup', 'commit', 'grouping', 'sync', 'confirmation', 'ready']);
export const shippingRunIssueSchema = z.object({ code: z.string(), message: z.string(), ticketIndex: z.number().int().positive().optional(), fba: z.string().optional(), demandId: z.uuid().optional(), groupId: z.uuid().optional() });
export type ShippingRunIssue = z.infer<typeof shippingRunIssueSchema>;
export const shippingRunSchema = z.object({
  lifecycle: z.enum(['active', 'cancelled', 'trashed']).optional(), lifecyclePending: z.boolean().optional(),
  id: z.uuid(), version: z.number().int().positive(), status: shippingRunStatusSchema, stage: shippingRunStageSchema,
  numberingDate: z.iso.date(), month: z.string(), sequence: z.number().int().positive().nullable(), importId: z.uuid().nullable(), parseRunId: z.uuid().nullable(),
  origin: z.enum(['import', 'manual']).default('import'), membershipFrozenAt: z.iso.datetime().nullable().default(null),
  error: z.object({ code: z.string(), message: z.string() }).nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type ShippingRun = z.infer<typeof shippingRunSchema>;
export const shippingTicketMemberSchema = z.object({ demandId: z.uuid().nullable(), fba: z.string(), sid: z.number().int().positive().nullable(), inputOrder: z.number().int().positive(), groupId: z.uuid().nullable() });
export const shippingTicketSchema = z.object({ id: z.uuid(), sourceTicketIndex: z.number().int().positive(), country: z.string().nullable(), ticketSequence: z.number().int().positive().nullable(), number: z.string().nullable(), members: z.array(shippingTicketMemberSchema) });
export const shippingRunDetailSchema = z.object({ run: shippingRunSchema, tickets: z.array(shippingTicketSchema), issues: z.array(shippingRunIssueSchema) });
export type ShippingRunDetail = z.infer<typeof shippingRunDetailSchema>;
export const shippingRunListSchema = z.object({ items: z.array(shippingRunSchema) });
export const createShippingRunInputSchema = z.object({ operationId: z.uuid(), importId: z.uuid(), parseRunId: z.uuid(), numberingDate: z.iso.date().optional() }).strict();
export type CreateShippingRunInput = z.infer<typeof createShippingRunInputSchema>;
export const retryShippingRunInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), importId: z.uuid().optional(), parseRunId: z.uuid().optional() }).strict().refine((input) => !input.importId || Boolean(input.parseRunId), { message: '更换导入来源必须提供解析编号。', path: ['parseRunId'] });
export type RetryShippingRunInput = z.infer<typeof retryShippingRunInputSchema>;

const manualMembers = {
  demandIds: z.array(z.uuid()).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, '需求不能重复。'),
  expectedDemandVersions: z.record(z.uuid(), z.number().int().positive()),
  reason: z.string().trim().min(1).max(2000),
};
const legacyGroup = { existingGroupId: z.uuid().optional(), expectedGroupVersion: z.number().int().positive().optional() };
const completeLegacyGroup = (input: { existingGroupId?: string; expectedGroupVersion?: number }) => Boolean(input.existingGroupId) === (input.expectedGroupVersion !== undefined);
export const createManualShippingRunInputSchema = z.object({ operationId: z.uuid(), numberingDate: z.iso.date().optional(), name: z.string().trim().min(1).max(120), ...manualMembers, ...legacyGroup }).strict().refine(completeLegacyGroup, '关联历史批次须同时提供批次编号和版本。');
export type CreateManualShippingRunInput = z.infer<typeof createManualShippingRunInputSchema>;
export const addShippingTicketInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(120), ...manualMembers, ...legacyGroup }).strict().refine(completeLegacyGroup, '关联历史批次须同时提供批次编号和版本。');
export type AddShippingTicketInput = z.infer<typeof addShippingTicketInputSchema>;
export const appendShippingTicketMembersInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), groupId: z.uuid(), expectedGroupVersion: z.number().int().positive(), ...manualMembers }).strict();
export type AppendShippingTicketMembersInput = z.infer<typeof appendShippingTicketMembersInputSchema>;
export const correctShippingRunInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) }).strict();
export type CorrectShippingRunInput = z.infer<typeof correctShippingRunInputSchema>;
