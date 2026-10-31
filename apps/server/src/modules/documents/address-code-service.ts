import { createHash } from 'node:crypto';
import type { DocumentRevisionData, DocumentValidation } from '@scm/contracts';
import type { BatchTx } from '../batches/service.js';
import { resolveDocumentAddressCode, type DocumentAddressCodeCatalog } from './address-code.js';
import { loadDocumentAddressCodeCatalog } from './address-code-catalog.js';
import { loadDocumentSourceCandidates } from './sources.js';
import type { DocumentReadContext } from './read-context.js';

type Resolution = ReturnType<typeof resolveDocumentAddressCode>;
const trusted = new Set(['listShipments', 'getShipmentDetails']);

/** Re-read only an invoice's bound immutable files; never query Lingxing here. */
export async function hydrateDocumentAddressCodeSourcesInTx(tx: BatchTx, data: DocumentRevisionData, verifyArchives = false, context?: DocumentReadContext): Promise<DocumentRevisionData> {
  if (data.generationRulesVersion !== 'v2') return data;
  const members = [];
  for (const member of data.members) {
    const addresses = member.sourceCandidates?.addresses ?? [];
    const candidates = addresses.filter((entry) => trusted.has(entry.source));
    const parsedFc = candidates.length > 0 && candidates.every((entry) => Object.hasOwn(entry.data, 'destinationFc'));
    if (parsedFc && !verifyArchives || !member.shipment?.snapshotIds?.length) { members.push(member); continue; }
    const historical = await (context ? loadDocumentSourceCandidates(tx, member, context) : loadDocumentSourceCandidates(tx, member));
    if (!historical) { members.push(member); continue; }
    members.push({ ...member, sourceCandidates: { ...member.sourceCandidates, ...historical } });
  }
  return { ...data, members };
}

export function withDocumentAddressCodeResolution(data: DocumentRevisionData, result: Resolution): DocumentRevisionData {
  const manual = data.fields.addressSelectionMode === 'manual';
  const fields: DocumentRevisionData['fields'] = { ...data.fields,
    addressCode: result.status === 'resolved' ? result.code : manual ? data.fields.addressCode ?? '' : '',
    addressCodeRuleVersion: 'lingxing-fc/v1', addressCodeStatus: result.status, addressCodeSource: result.source,
    addressCodeReason: result.reason,
    addressCodeSourceDigest: createHash('sha256').update(JSON.stringify([...result.sourceSnapshotIds].sort())).digest('hex'),
    addressCodeReferenceSha256: result.source === 'freight_reference' || result.sourceRows.length ? result.catalogSha256 ?? '' : '', addressCodeReferenceRows: result.sourceRows.join(','),
  };
  if (result.status === 'needs_review') fields.addressConfirmed = 'false';
  return { ...data, fields };
}

export async function applyDocumentAddressCodeDefaults(data: DocumentRevisionData): Promise<DocumentRevisionData> {
  if (data.generationRulesVersion !== 'v2' || !data.members.length) return data;
  const catalog = await loadDocumentAddressCodeCatalog();
  return withDocumentAddressCodeResolution(data, resolveDocumentAddressCode(data, catalog));
}

/** A saved code and its adopted reference must still agree before a new export. */
export function validateDocumentAddressCode(data: DocumentRevisionData, catalog: DocumentAddressCodeCatalog | null): DocumentValidation['issues'] {
  if (data.generationRulesVersion !== 'v2' || !data.members.length) return [];
  const result = resolveDocumentAddressCode(data, catalog);
  if (result.status === 'needs_review') return [{ code: 'DOCUMENT_ADDRESS_CODE_UNRESOLVED', severity: 'error', profileCategory: 'address', message: result.reason }];
  const referenceChanged = result.source === 'freight_reference' && (data.fields.addressCodeSource !== result.source
    || data.fields.addressCodeReferenceSha256 !== result.catalogSha256 || data.fields.addressCodeReferenceRows !== result.sourceRows.join(','))
    || data.fields.addressCodeSource === 'freight_reference' && data.fields.addressCodeReferenceSha256 !== catalog?.sha256;
  const adoptionMissing = data.fields.addressCodeRuleVersion !== 'lingxing-fc/v1' || data.fields.addressCodeStatus !== 'resolved' || data.fields.addressCodeSource !== result.source;
  if (data.fields.addressCode?.trim() !== result.code || referenceChanged || adoptionMissing) return [{ code: 'DOCUMENT_ADDRESS_CODE_STALE', severity: 'error', profileCategory: 'address', message: 'B3 地址库编码或参考版本已变化，请重新保存采用当前资料，或人工核实编码并确认本票地址。' }];
  return [];
}
