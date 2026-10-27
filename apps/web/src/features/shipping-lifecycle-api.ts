import { request } from '../api';
import { shippingLifecycleImpactSchema, shippingLifecycleInputSchema, shippingLifecycleResultSchema, shippingRecycleListSchema, type ShippingLifecycleAction, type ShippingLifecycleType, type ShippingLifecycleImpact, type ShippingLifecycleInput, type ShippingLifecycleResult } from '@scm/contracts';

export type { ShippingLifecycleAction, ShippingLifecycleType };
export type LifecycleTarget = { type: ShippingLifecycleType; id: string; name: string; lifecycle?: string; lifecyclePending?: boolean };
export type LifecycleImpact = ShippingLifecycleImpact;
export type LifecycleInput = ShippingLifecycleInput;
export type LifecycleResult = ShippingLifecycleResult;
const paths = { run: 'shipping-runs', group: 'sub-batches', demand: 'demands' };
const base = (target: Pick<LifecycleTarget, 'type' | 'id'>) => `/api/v1/${paths[target.type]}/${encodeURIComponent(target.id)}`;
export const lifecycleOf = (value: { lifecycle?: string } | undefined) => value?.lifecycle ?? 'active';
export const lifecyclePending = (value: { lifecyclePending?: boolean } | undefined) => value?.lifecyclePending === true;
export const lifecycleApi = {
  impact: async (target: LifecycleTarget, action: ShippingLifecycleAction) => shippingLifecycleImpactSchema.parse(await request(`${base(target)}/lifecycle-impact?action=${action}`)),
  mutate: async (target: LifecycleTarget, action: ShippingLifecycleAction, input: LifecycleInput) => shippingLifecycleResultSchema.parse(await request(`${base(target)}/lifecycle/${action}`, { method: 'POST', body: JSON.stringify(shippingLifecycleInputSchema.parse(input)) })),
  recycle: async (type: ShippingLifecycleType, q: string, page: number) => shippingRecycleListSchema.parse(await request(`/api/v1/shipping-recycle-bin?${new URLSearchParams({ type, q, page: String(page), pageSize: '20' })}`)),
};
