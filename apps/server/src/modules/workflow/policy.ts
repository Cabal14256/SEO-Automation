import type { z } from 'zod';
import type { WorkflowContext, WorkflowIssue, WorkflowKind, WorkflowRecord } from '@scm/contracts';

export type WorkflowEvaluation = { status: string; issues: WorkflowIssue[]; claims?: { purpose: string; boxIds: string[] }[] };
export type WorkflowArtifact = { bytes: Buffer; name: string; mimeType: string };
export interface WorkflowPolicy {
  kind: WorkflowKind;
  dataSchema: z.ZodType<Record<string, unknown>>;
  evaluate(record: WorkflowRecord, context: WorkflowContext, action: string): WorkflowEvaluation;
  fingerprint?(record: WorkflowRecord, context: WorkflowContext, purpose: string): string;
  render?(record: WorkflowRecord, context: WorkflowContext, purpose: string, templateBytes?: Buffer): Promise<WorkflowArtifact>;
}
