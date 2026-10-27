import { isWorkflowUnderMaintenance, workflowMaintenanceMessage } from '@scm/contracts';
import { BatchError } from '../batches/service.js';

export function requireWorkflowAvailable(kind: string): void {
  if (isWorkflowUnderMaintenance(kind)) {
    throw new BatchError('FEATURE_UNDER_MAINTENANCE', 503, workflowMaintenanceMessage);
  }
}
