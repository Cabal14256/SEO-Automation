import type { DocumentRevisionData } from '@scm/contracts';
import { documentDigest } from './domain.js';

/** Source receipts are archived separately; every other field remains significant. */
export function sameProductProfileData(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const businessData = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([key]) => key !== '_lingxingSources'));
  return documentDigest(businessData(left)) === documentDigest(businessData(right));
}

/** Only refresh the same, uniquely matched product when its business data is unchanged. */
export function resolveUnchangedProductProfile<T extends { id: string; category: string; status: string; version: number; data: Record<string, unknown> }>(reference: DocumentRevisionData['profileReferences'][number], profiles: readonly T[]): T | undefined {
  if (reference.category !== 'product') return undefined;
  const sid = Number(reference.data.sid), identity = ['msku', 'fnsku', 'sku'] as const;
  if (!Number.isSafeInteger(sid) || sid <= 0 || identity.some((key) => typeof reference.data[key] !== 'string' || !reference.data[key].trim())) return undefined;
  const matches = profiles.filter((profile) => profile.category === 'product' && profile.status === 'active' && Number(profile.data.sid) === sid
    && identity.every((key) => profile.data[key] === reference.data[key]));
  const current = matches.length === 1 ? matches[0] : undefined;
  return current?.id === reference.profileId && sameProductProfileData(reference.data, current.data) ? current : undefined;
}
