import type { DocumentValidation } from '@scm/contracts';

export type AutomationStage = 'create' | 'preview' | 'apply' | 'prepare' | 'validate' | 'ready' | 'export' | 'done';
export type AutomationItemStatus = 'queued' | 'running' | 'ready' | 'exporting' | 'completed' | 'blocked';
export type AutomationError = { code: string; message: string };
export type StoredDocumentAutomationItem = {
  shippingRunId?: string;
  id: string; demandIds: string[]; fbas: string[]; documentId: string | null; documentVersion: number | null;
  exportId: string | null; fileId: string | null; stage: AutomationStage; status: AutomationItemStatus;
  issues: DocumentValidation['issues']; error: AutomationError | null; attempt: number;
  sourceDigest: string;
  retryExact?: boolean;
  operations: Record<string, { input: unknown; result?: unknown }>;
};

/** Historical jobs omit item scope and retain the job's original shipping run. */
export function documentAutomationRunIds(job: { shippingRunId: string; items: readonly { shippingRunId?: string }[] }): string[] {
  return [...new Set([job.shippingRunId, ...job.items.map((item) => item.shippingRunId ?? job.shippingRunId)])];
}
