import { z } from 'zod';
export * from './seller-mappings.js';
export * from './imports.js';
export * from './demands.js';
export * from './batches.js';
export * from './reports.js';
export * from './report-presentation.js';
export * from './physical.js';
export * from './online-imports.js';
export * from './import-drafts.js';
export * from './demand-workspace.js';
export * from './documents.js';
export * from './document-boxes.js';
export * from './workflow.js';
export * from './maintenance.js';
export * from './fulfillment.js';
export * from './logistics.js';
export * from './customs.js';
export * from './finance.js';
export * from './shipping-runs.js';

export const roleSchema = z.enum(['admin']);
export type Role = z.infer<typeof roleSchema>;

export const demoTaskInputSchema = z.object({
  label: z.string().trim().min(1, '请输入任务名称').max(120, '任务名称不能超过 120 字'),
});
export type DemoTaskInput = z.infer<typeof demoTaskInputSchema>;

export const taskStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
