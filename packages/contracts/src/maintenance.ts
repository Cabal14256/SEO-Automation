// Keep temporary workflow closures consistent across navigation and API access.
// Remove a kind here only after its workflow is ready to reopen.
const maintenanceKinds: ReadonlySet<string> = new Set(['fulfillment', 'logistics', 'customs', 'archive']);

export const workflowMaintenanceMessage = '（待维护）';

export function isWorkflowUnderMaintenance(kind: string): boolean {
  return maintenanceKinds.has(kind);
}
