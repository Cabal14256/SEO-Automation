import { DOCUMENT_ADDRESS_FIELDS, documentAddressDifferences, documentCountryCode, hasCompleteDocumentAddress, hasDocumentAddressConflict, resolveDocumentLingxingAddress, type DocumentMemberSnapshot } from '@scm/contracts';
export type AddressCandidateData = Record<string, string | null>;

/** A missing field can be supplemented; only two different nonempty values
 * are conflicting evidence. Neither source order nor completeness wins a conflict. */
export function hasAddressConflict(addresses: AddressCandidateData[]): boolean {
  return hasDocumentAddressConflict(addresses);
}

export function mergeCompatibleAddresses(addresses: AddressCandidateData[]): AddressCandidateData | null {
  if (!addresses.length || hasAddressConflict(addresses)) return null;
  const merged: AddressCandidateData = {};
  // Prefer the most complete record for labels/contact fields while filling
  // missing geographic fields from compatible evidence.
  const completeFirst = [...addresses].sort((a, b) => Object.values(b).filter((value) => value?.trim()).length - Object.values(a).filter((value) => value?.trim()).length);
  for (const address of completeFirst) for (const [key, value] of Object.entries(address)) if (!merged[key]?.trim() && value?.trim()) merged[key] = value.trim();
  return merged;
}

/** An old checkbox cannot confirm a newly edited address. */
export function reviseDocumentAddressFields(previous: Readonly<AddressCandidateData>, fields: Readonly<AddressCandidateData>, confirmAddress = false, referenceChanged = false): AddressCandidateData {
  const changed = referenceChanged || documentAddressDifferences(previous, fields).length > 0;
  const adoption: AddressCandidateData = changed || confirmAddress ? { addressAdoptionVersion: 'explicit/v1' } : {};
  if (confirmAddress && hasCompleteDocumentAddress(fields) && fields.addressConfirmed === 'true' && fields.addressConfirmationReason?.trim()) return { ...fields, ...adoption };
  if (changed || confirmAddress) return { ...fields, ...adoption, addressConfirmed: 'false', addressConfirmationReason: '' };
  return { ...fields };
}

export function haveDocumentAddressSourcesChanged(previous: readonly DocumentMemberSnapshot[], current: readonly DocumentMemberSnapshot[]): boolean {
  const normalized = (value: string | null | undefined) => value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase() ?? '';
  const memberKey = (member: DocumentMemberSnapshot) => JSON.stringify([member.demand.id, member.demand.snapshot?.sid, normalized(member.demand.snapshot?.fba), documentCountryCode(member.demand.snapshot?.country ?? '') ?? normalized(member.demand.snapshot?.country)]);
  type Candidate = NonNullable<DocumentMemberSnapshot['sourceCandidates']>['addresses'][number];
  const candidateKey = (candidate: Candidate) => JSON.stringify([candidate.source, candidate.snapshotId]);
  // Confirmation follows semantic address values, not snapshot IDs or labels.
  const evidence = (members: readonly DocumentMemberSnapshot[]) => [...new Set(members.flatMap((member) => (member.sourceCandidates?.addresses ?? []).map((candidate) => JSON.stringify([
    DOCUMENT_ADDRESS_FIELDS.map((key) => normalized(candidate.data[key])), Object.hasOwn(candidate.data, 'destinationFc'), normalized(candidate.data.destinationFc),
  ]))))].sort();
  if (JSON.stringify(evidence(previous)) === JSON.stringify(evidence(current))) return false;

  // A parser upgrade may expose an FC or a missing list street already supplied
  // by the same bound detail file. Preserve confirmation only when every FBA's
  // complete adopted address and all previously parsed evidence remain intact.
  if (previous.length !== current.length || !previous.length) return true;
  if ([...previous, ...current].some((member) => !member.demand?.id || !member.demand.snapshot || !member.demand.snapshot.fba || !member.demand.snapshot.country)) return true;
  const knownFcs = (members: readonly DocumentMemberSnapshot[]) => new Set(members.flatMap((member) => (member.sourceCandidates?.addresses ?? []).map((candidate) => normalized(candidate.data.destinationFc))).filter(Boolean));
  if (knownFcs(previous).size > 1 || knownFcs(current).size > 1) return true;
  const currentMembers = new Map(current.map((member) => [memberKey(member), member]));
  if (currentMembers.size !== current.length || new Set(previous.map(memberKey)).size !== previous.length) return true;
  for (const member of previous) {
    const next = currentMembers.get(memberKey(member)); if (!next) return true;
    const before = member.sourceCandidates?.addresses ?? [], after = next.sourceCandidates?.addresses ?? [];
    const nextCandidates = new Map(after.map((candidate) => [candidateKey(candidate), candidate]));
    if (before.length !== after.length || nextCandidates.size !== after.length || new Set(before.map(candidateKey)).size !== before.length) return true;
    for (const candidate of before) {
      const updated = nextCandidates.get(candidateKey(candidate));
      if (!updated || !['listShipments', 'getShipmentDetails'].includes(candidate.source)) return true;
      if (DOCUMENT_ADDRESS_FIELDS.some((key) => normalized(candidate.data[key]) && normalized(candidate.data[key]) !== normalized(updated.data[key]))) return true;
      if (Object.hasOwn(candidate.data, 'destinationFc') && (!Object.hasOwn(updated.data, 'destinationFc') || normalized(candidate.data.destinationFc) !== normalized(updated.data.destinationFc))) return true;
    }
    const oldAddress = resolveDocumentLingxingAddress([member]), newAddress = resolveDocumentLingxingAddress([next]);
    if (!oldAddress || !newAddress || documentAddressDifferences(oldAddress, newAddress).length) return true;
  }
  return false;
}
