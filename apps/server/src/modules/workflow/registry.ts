import { fulfillmentPolicy } from '../fulfillment/domain.js';
import { logisticsPolicy } from '../logistics/domain.js';
import { customsPolicy } from '../customs/policy.js';
import { financePolicy } from '../finance/domain.js';
import { archivePolicy } from '../finance/archive.js';
import type { WorkflowKind } from '@scm/contracts';
import type { WorkflowPolicy } from './policy.js';

export const workflowPolicies: Record<WorkflowKind, WorkflowPolicy> = { fulfillment: fulfillmentPolicy, logistics: logisticsPolicy, customs: customsPolicy, finance: financePolicy, archive: archivePolicy };
