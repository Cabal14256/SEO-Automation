import { z } from 'zod';

const text = z.string().trim().max(1000);
const quantity = z.string().trim().max(30).regex(/^(0|[1-9]\d*)$/, '数量必须是非负整数字符串');
export const fulfillmentComponentSchema = z.object({ sku: text.min(1), quantity }).strict();
export const fulfillmentLineSchema = z.object({
  boxId: z.uuid(), msku: text, fnsku: text, sku: text, quantity,
  components: z.array(fulfillmentComponentSchema).max(100).default([]),
}).strict();
export const fulfillmentMaterialSchema = z.object({
  sku: text.min(1), quantity, scope: z.enum(['box', 'shipment']), boxId: z.uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.scope === 'box' && !value.boxId) context.addIssue({ code: 'custom', path: ['boxId'], message: '按箱辅料必须指定内部箱 ID' });
  if (value.scope === 'shipment' && value.boxId) context.addIssue({ code: 'custom', path: ['boxId'], message: '整单辅料不能指定箱 ID' });
});
export const fulfillmentExternalOrderSchema = z.object({
  externalOrderNo: text.min(1), warehouseCode: text,
  status: z.enum(['allocated', 'shortage', 'unknown', 'cancelled']),
  lines: z.array(fulfillmentLineSchema).max(10000).default([]),
  materials: z.array(fulfillmentMaterialSchema).max(1000).default([]),
  evidenceFileId: z.uuid().optional(), cancelEvidenceFileId: z.uuid().optional(), shortageReason: text.default(''),
}).strict();
export const fulfillmentDataSchema = z.object({
  warehouseCode: text.default(''), logistics: text.default(''), remark: text.default(''),
  lines: z.array(fulfillmentLineSchema).max(10000).default([]),
  materials: z.array(fulfillmentMaterialSchema).max(1000).default([]),
  externalOrders: z.array(fulfillmentExternalOrderSchema).max(1000).default([]),
}).strict();
export const fulfillmentActionSchema = z.enum(['save', 'confirm', 'record_result', 'cancel']);
export type FulfillmentData = z.infer<typeof fulfillmentDataSchema>;
export type FulfillmentLine = z.infer<typeof fulfillmentLineSchema>;
export type FulfillmentMaterial = z.infer<typeof fulfillmentMaterialSchema>;
export type FulfillmentExternalOrder = z.infer<typeof fulfillmentExternalOrderSchema>;
