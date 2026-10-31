import { and, eq, inArray } from 'drizzle-orm';
import type { DocumentMemberSnapshot, DocumentCandidate } from '@scm/contracts';
import { fileIndex } from '../../db/schema.js';
import type { BatchTx } from '../batches/service.js';
import { checkedFileBytes } from '../imports/service.js';
import { batchSyncItems, batchSyncSnapshots } from '../lingxing/sync-schema.js';
import { physicalSyncItems, physicalSyncSnapshots } from '../physical/schema.js';
import { decodePhysicalCheckpoint } from '../physical/sources.js';
import { hasAddressConflict } from './address.js';
import type { DocumentReadContext } from './read-context.js';

type Candidates = NonNullable<DocumentMemberSnapshot['sourceCandidates']>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const normalized = (value: unknown) => text(value)?.toUpperCase() ?? '';
const identity = (item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([item.msku, item.fnsku, item.sku]);
export function extractDocumentSourceCandidates(input: { snapshotId: string; operation: string; payload: Record<string, unknown> }, member: Pick<DocumentCandidate, 'demand' | 'shipment'>): Candidates {
  const result: Candidates = { addresses: [], products: [], issues: [] }, { sid, fba } = member.demand.snapshot;
  const data = object(input.payload.data), shipmentRows = input.operation === 'listShipments' ? rows(data.list) : rows(data.shipmentList);
  const matching = shipmentRows.filter((row) => String(row.sid) === String(sid) && normalized(input.operation === 'listShipments' ? row.shipment_id : row.shipmentConfirmationId) === normalized(fba));
  if (matching.length !== 1) { result.issues.push({ code: 'DOCUMENT_SOURCE_IDENTITY_INVALID', severity: 'warning', message: '绑定的原始快照未能唯一核验店铺和 FBA，候选资料未自动采用。' }); return result; }
  const shipment = matching[0]!, rawAddress = object(input.operation === 'listShipments' ? shipment.ship_to_address : shipment.shippingAddress);
  result.po = text(input.operation === 'listShipments' ? shipment.reference_id : shipment.amazonReferenceId);
  if (Object.keys(rawAddress).length) result.addresses.push({ source: input.operation, snapshotId: input.snapshotId, data: {
    destinationFc: text(input.operation === 'listShipments' ? shipment.destination_fulfillment_center_id : shipment.warehouseId)?.toUpperCase() ?? null,
    addressCode: text(rawAddress.addressCode) ?? text(rawAddress.address_code), recipientName: text(rawAddress.name) ?? text(rawAddress.addressName), recipientCompany: text(rawAddress.company), addressLine1: text(rawAddress.addressLine1) ?? text(rawAddress.address_line1) ?? text(rawAddress.address_line_1), addressLine2: text(rawAddress.addressLine2) ?? text(rawAddress.address_line2) ?? text(rawAddress.address_line_2), addressLine3: text(rawAddress.addressLine3) ?? text(rawAddress.address_line3) ?? text(rawAddress.address_line_3), city: text(rawAddress.city), state: text(rawAddress.stateOrProvinceCode) ?? text(rawAddress.state_or_province_code), postalCode: text(rawAddress.postalCode) ?? text(rawAddress.postal_code), countryCode: text(rawAddress.countryCode) ?? text(rawAddress.country_code), phone: text(rawAddress.phoneNumber) ?? text(rawAddress.phone), email: text(rawAddress.email),
  } });
  const expected = new Set(member.shipment.data.items.map(identity));
  for (const row of rows(input.operation === 'listShipments' ? shipment.item_list : shipment.itemList)) {
    const product = { msku: text(row.msku) ?? '', fnsku: text(row.fnsku) ?? '', sku: text(row.sku) ?? '' };
    if (!expected.has(identity(product))) { result.issues.push({ code: 'DOCUMENT_PRODUCT_IDENTITY_INVALID', severity: 'warning', message: '原始商品候选与已确认完整商品身份不一致，未自动采用。' }); continue; }
    const url = text(row.url), asin = text(row.asin);
    result.products.push({ source: input.operation, snapshotId: input.snapshotId, sid, ...product, asin, imageUrl: text(row.image) ?? (url && /\.(?:png|jpe?g)(?:\?|$)/i.test(url) ? url : null), salesLink: text(row.asin_url) ?? text(row.asinUrl) ?? (url && !/\.(?:png|jpe?g)(?:\?|$)/i.test(url) ? url : null) });
  }
  return result;
}
export async function loadDocumentSourceCandidates(tx: BatchTx, member: Pick<DocumentCandidate, 'demand' | 'shipment' | 'physical'>, context?: DocumentReadContext): Promise<Candidates> {
  if (context) {
    if (context.tx !== tx) throw new Error('Document read context belongs to another transaction');
    return context.memo('source-candidates', [member.demand.id, member.demand.version, member.demand.snapshot.sid, member.demand.snapshot.fba, member.shipment.id, member.shipment.snapshotIds, member.physical?.id],
      () => readDocumentSourceCandidates(tx, member, context));
  }
  return readDocumentSourceCandidates(tx, member);
}
async function readDocumentSourceCandidates(tx: BatchTx, member: Pick<DocumentCandidate, 'demand' | 'shipment' | 'physical'>, context?: DocumentReadContext): Promise<Candidates> {
  const result: Candidates = { addresses: [], products: [], issues: [] }, ids = [...new Set([...member.shipment.snapshotIds, ...member.physical?.snapshot.source.snapshotIds ?? []])];
  if (!ids.length) return result;
  const m2 = await tx.select({ snapshot: batchSyncSnapshots, file: fileIndex }).from(batchSyncSnapshots).innerJoin(batchSyncItems, eq(batchSyncItems.id, batchSyncSnapshots.itemId)).innerJoin(fileIndex, eq(fileIndex.id, batchSyncSnapshots.fileId)).where(and(inArray(batchSyncSnapshots.id, ids), eq(batchSyncItems.demandId, member.demand.id), eq(batchSyncSnapshots.successful, 1)));
  const m3 = member.physical ? await tx.select({ snapshot: physicalSyncSnapshots, file: fileIndex }).from(physicalSyncSnapshots).innerJoin(physicalSyncItems, eq(physicalSyncItems.id, physicalSyncSnapshots.itemId)).innerJoin(fileIndex, eq(fileIndex.id, physicalSyncSnapshots.fileId)).where(and(inArray(physicalSyncSnapshots.id, ids), eq(physicalSyncItems.demandId, member.demand.id), eq(physicalSyncSnapshots.successful, 1))) : [];
  const references = new Set<string>();
  for (const record of [...m2, ...m3]) {
    if (!['listShipments', 'getShipmentDetails'].includes(record.snapshot.operation)) continue;
    try {
      const operation = record.snapshot.operation as 'listShipments' | 'getShipmentDetails';
      const checkpoint = decodePhysicalCheckpoint(await (context ? context.fileBytes(record.file) : checkedFileBytes(record.file)), { sid: member.demand.snapshot.sid, fba: member.demand.snapshot.fba, operation });
      const candidates = extractDocumentSourceCandidates({ snapshotId: record.snapshot.id, operation, payload: checkpoint.payload }, member);
      if (candidates.po) references.add(candidates.po);
      result.addresses.push(...candidates.addresses); result.products.push(...candidates.products); result.issues.push(...candidates.issues);
    } catch { result.issues.push({ code: 'DOCUMENT_SOURCE_FILE_INVALID', severity: 'warning', message: '绑定原始快照无法读取、哈希校验失败或身份不符，需显式补录；未查询领星。' }); }
  }
  result.po = references.size === 1 ? [...references][0]! : null;
  if (references.size > 1) result.issues.push({ code: 'DOCUMENT_PO_CONFLICT', severity: 'warning', message: '领星列表与详情的 PO / Reference ID 不一致，请核对后在本票逐箱填写采用值。' });
  if (hasAddressConflict(result.addresses.map((entry) => entry.data))) result.issues.push({ code: 'DOCUMENT_ADDRESS_CONFLICT', severity: 'error', message: '绑定来源的完整收件地址存在冲突，请补齐每票收件资料并明确确认采用地址。' });
  return result;
}
