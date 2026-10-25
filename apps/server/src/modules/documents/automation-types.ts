import type { DocumentValidation } from '@scm/contracts';

export type AutomationStage = 'create' | 'preview' | 'apply' | 'prepare' | 'validate' | 'ready' | 'export' | 'done';
export type AutomationItemStatus = 'queued' | 'running' | 'ready' | 'exporting' | 'completed' | 'blocked';
export type AutomationError = { code: string; message: string };
export type StoredDocumentAutomationItem = {
  id: string; demandIds: string[]; fbas: string[]; documentId: string | null; documentVersion: number | null;
  exportId: string | null; fileId: string | null; stage: AutomationStage; status: AutomationItemStatus;
  issues: DocumentValidation['issues']; error: AutomationError | null; attempt: number;
  sourceDigest: string;
  retryExact?: boolean;
  operations: Record<string, { input: unknown; result?: unknown }>;
};
