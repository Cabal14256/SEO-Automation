import { DOCUMENT_ADDRESS_FIELDS, documentAddressDifferences, hasCompleteDocumentAddress, hasDocumentAddressConflict, type DocumentMemberSnapshot } from '@scm/contracts';
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
  const evidence = (members: readonly DocumentMemberSnapshot[]) => [...new Set(members.flatMap((member) => member.sourceCandidates?.addresses.map((candidate) => JSON.stringify(DOCUMENT_ADDRESS_FIELDS.map((key) => candidate.data[key]?.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase() ?? ''))) ?? []))].sort();
  return JSON.stringify(evidence(previous)) !== JSON.stringify(evidence(current));
}
