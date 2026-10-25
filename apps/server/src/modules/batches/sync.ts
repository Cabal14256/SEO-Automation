import { randomUUID } from 'node:crypto';
import { isShipmentReceiptComplete, type BatchIssue, type ShipmentBox, type ShipmentData, type ShipmentProduct } from '@scm/contracts';
import type { LingxingReadPayload } from '../lingxing/read-client.js';

export class BatchSyncError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); this.name = 'BatchSyncError'; }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const measurement = (value: unknown): string | null => typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' && value.trim() ? value : null;
const identity = (item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([item.msku, item.fnsku, item.sku]);
const fba = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : '';
export function integerQuantity(value: unknown, positive = false): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  const quantity = BigInt(String(value));
  return positive && quantity === 0n ? null : quantity.toString();
}

/** A fresh read must re-start an incomplete mutable listing at offset zero.
 * Completed pages may be replayed only inside one explicit recovery run. */
export async function fetchCompleteShipmentList(request: (params: { offset: number; length: number }, page: number) => Promise<LingxingReadPayload>, maxPages: number, pageLength = 100) {
  if (!Number.isSafeInteger(pageLength) || pageLength < 1 || pageLength > 100) throw new BatchSyncError('INVALID_PAGE_SIZE', '货件分页长度无效。');
  const all: Record<string, unknown>[] = []; const seen = new Set<string>(); let total: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await request({ offset: all.length, length: pageLength }, page);
    const batch = object(result.data).list;
    if (!Array.isArray(batch)) throw new BatchSyncError('LINGXING_INVALID_RESPONSE', '货件列表未返回有效分页数组。');
    const rawTotal = integerQuantity(result.total);
    if (rawTotal === null || BigInt(rawTotal) > BigInt(Number.MAX_SAFE_INTEGER)) throw new BatchSyncError('INCOMPLETE_PAGINATION', '货件列表缺少可验证的总数。');
    const expected = Number(rawTotal);
    if (total !== undefined && total !== expected) throw new BatchSyncError('PAGINATION_CHANGED', '分页期间货件总数变化，请重新同步。');
    total = expected;
    const digest = JSON.stringify(batch);
    if (batch.length && seen.has(digest)) throw new BatchSyncError('REPEATED_PAGE', '领星返回重复分页，尚未完整取数。');
    seen.add(digest); all.push(...batch.map(object));
    if (all.length > total) throw new BatchSyncError('INCOMPLETE_PAGINATION', '货件分页返回行数超过总数。');
    if (all.length === total) return { rows: all, total, complete: true as const, pages: page + 1 };
    if (batch.length < pageLength) throw new BatchSyncError('INCOMPLETE_PAGINATION', '货件分页提前结束，累计行数与总数不一致。');
  }
  throw new BatchSyncError('PAGE_LIMIT', '达到分页上限，尚未确认完整取数；请调整范围或增加页数后重新同步。');
}

export type NormalizeShipmentInput = { sid: number; fba: string; listing: Record<string, unknown>; details: LingxingReadPayload; packing: LingxingReadPayload;
  previous?: ShipmentData | null; observedAt?: string; id?: () => string };
export function normalizeShipment(input: NormalizeShipmentInput): ShipmentData {
  const issues: BatchIssue[] = []; const add = (code: string, message: string, severity: 'error' | 'warning' = 'error', details?: Record<string, unknown>) => issues.push({ code, severity, message, ...(details ? { details } : {}) });
  const expectedFba = fba(input.fba);
  if (String(input.listing.sid) !== String(input.sid) || fba(input.listing.shipment_id) !== expectedFba) throw new BatchSyncError('SHIPMENT_IDENTITY_CONFLICT', '列表货件与目标 sid/FBA 不一致。');
  const detailMatches = rows(object(input.details.data).shipmentList).filter((row) => String(row.sid) === String(input.sid) && fba(row.shipmentConfirmationId) === expectedFba);
  if (detailMatches.length !== 1) throw new BatchSyncError('SHIPMENT_IDENTITY_CONFLICT', '货件详情必须按 sid/FBA 唯一匹配，未发布候选。');
  const detail = detailMatches[0]!;
  const shipmentStatus = text(input.listing.shipment_status)?.trim().toUpperCase() ?? null;
  const internalId = text(input.listing.sta_shipment_id) ?? text(detail.shipmentId);
  if (text(input.listing.sta_shipment_id) && text(detail.shipmentId) && text(input.listing.sta_shipment_id) !== text(detail.shipmentId)) add('SHIPMENT_INTERNAL_ID_CONFLICT', '列表与详情的内部货件标识不一致。');
  const boxGroups = rows(object(input.packing.data).shipmentList);
  const matchingGroups = internalId ? boxGroups.filter((group) => text(group.shipmentId) === internalId) : [];
  if (matchingGroups.length !== 1) throw new BatchSyncError('BOX_SHIPMENT_CONFLICT', '装箱分组不能唯一关联当前货件；禁止展平其他货件。');
  const isSta = ['0', '1'].includes(String(input.listing.is_sta)) ? String(input.listing.is_sta) === '1' : null;
  if (isSta === null) add('SHIPMENT_TYPE_UNKNOWN', '领星未返回有效 STA 类型。');
  if (isSta === false) add('NON_STA_CAPABILITY_UNVERIFIED', '非 STA 数据已读取，请核对完整商品与逐箱关系。', 'warning');
  const product = (row: Record<string, unknown>, quantityField: string, positive: boolean): ShipmentProduct => {
    const result = { msku: text(row.msku) ?? '', fnsku: text(row.fnsku) ?? '', sku: text(row.sku) ?? '', name: text(row.productName), quantity: integerQuantity(row[quantityField], positive),
      expiration: text(row.expiration), prepOwner: text(row.prepOwner ?? row.prep_owner), labelOwner: text(row.labelOwner ?? row.prep_label_owner) };
    if (!result.msku || !result.fnsku || !result.sku) add('MISSING_PRODUCT_IDENTITY', '商品缺少 MSKU/FNSKU/SKU，保留原始候选并阻止确认。');
    if (result.quantity === null) add('INVALID_QUANTITY', positive ? '箱内商品数量必须为正整数。' : '商品申报数量缺失或不是有效整数。');
    return result;
  };
  const items = rows(detail.itemList).map((row) => product(row, 'quantity', false));
  if (!items.length) add('EMPTY_PRODUCTS', '货件详情没有商品明细。');
  const listItems = rows(input.listing.item_list);
  const listByIdentity = new Map<string, Record<string, unknown>>();
  for (const row of listItems) {
    const key = identity({ msku: text(row.msku) ?? '', fnsku: text(row.fnsku) ?? '', sku: text(row.sku) ?? '' });
    if (listByIdentity.has(key)) add('DUPLICATE_LIST_PRODUCT', '列表中完整商品身份重复，未静默合并。');
    listByIdentity.set(key, row);
  }
  const productKeys = new Set<string>();
  for (const item of items) {
    const key = identity(item);
    if (productKeys.has(key)) add('DUPLICATE_PRODUCT', '同货件完整商品身份重复，需人工修改确认。');
    productKeys.add(key);
    const listItem = listByIdentity.get(key);
    if (!item.name) add('MISSING_PRODUCT_NAME', '商品品名缺失，请补录后确认。');
    if (!listItem) add('MISSING_LIST_PRODUCT', '详情商品未在货件列表中找到完整身份匹配。');
    item.listQuantity = integerQuantity(listItem?.quantity_shipped);
    item.initialDeclaredQuantity = integerQuantity(listItem?.init_quantity_shipped);
    item.localShippedQuantity = integerQuantity(listItem?.quantity_shipped_local);
    item.receivedQuantity = integerQuantity(listItem?.quantity_received);
    if (item.listQuantity === null) add('MISSING_CURRENT_DECLARATION', '列表当前申报量缺失。');
    if (item.quantity !== null && item.listQuantity !== null && item.quantity !== item.listQuantity) add('LIST_QUANTITY_MISMATCH', '详情申报量与列表当前申报量不一致，需人工处理。', 'error', { identity: key, detail: item.quantity, list: item.listQuantity });
    if (isShipmentReceiptComplete({ shipmentStatus }) && item.receivedQuantity !== null && item.quantity !== null && item.receivedQuantity !== item.quantity) add('RECEIPT_DIFFERENCE', '亚马逊接收已完成，接收数量与申报量不同，未改变准备量。', 'warning', { identity: key, declared: item.quantity, received: item.receivedQuantity });
  }
  for (const key of listByIdentity.keys()) if (!productKeys.has(key)) add('MISSING_DETAIL_PRODUCT', '列表商品未在详情中找到完整身份匹配。');
  const previous = input.previous?.boxes ?? [];
  const external = new Map<string, ShipmentBox[]>();
  for (const box of previous) for (const [kind, value] of [['box', box.externalBoxId], ['package', box.packageId]] as const) if (value) external.set(`${kind}:${value}`, [...external.get(`${kind}:${value}`) ?? [], box]);
  const usedIds = new Set<string>(); const strongSeen = new Set<string>(); const localSeen = new Set<string>();
  const rawBoxes = rows(matchingGroups[0]!.shipmentPackingList);
  const boxes: ShipmentBox[] = rawBoxes.map((row) => {
    const externalBoxId = text(row.boxId), packageId = text(row.packageId), localBoxId = text(row.localBoxId);
    const candidates = new Map<string, ShipmentBox>();
    for (const [kind, value] of [['box', externalBoxId], ['package', packageId]] as const) if (value) {
      const key = `${kind}:${value}`;
      if (strongSeen.has(key)) add('DUPLICATE_EXTERNAL_BOX', '同票外部箱标识重复。');
      strongSeen.add(key);
      for (const candidate of external.get(key) ?? []) candidates.set(candidate.id, candidate);
    }
    const match = candidates.size === 1 ? [...candidates.values()][0]! : undefined;
    if (candidates.size > 1 || match && (externalBoxId && match.externalBoxId && externalBoxId !== match.externalBoxId || packageId && match.packageId && packageId !== match.packageId)) add('BOX_MAPPING_CONFLICT', '外部箱标识对应多个旧箱或标识互相冲突，请人工映射。');
    if (!externalBoxId && !packageId) add('BOX_MAPPING_REQUIRED', '箱子只有弱标识或没有标识，需要人工确认内部箱映射。');
    const id = match && !usedIds.has(match.id) ? match.id : (input.id ?? randomUUID)(); usedIds.add(id);
    if (localBoxId && localSeen.has(localBoxId)) add('BOX_ORDER_REQUIRED', '货件内箱序重复，请人工确认顺序。');
    if (localBoxId) localSeen.add(localBoxId);
    if (text(row.box_name) && text(row.boxName) && text(row.box_name) !== text(row.boxName)) add('BOX_NAME_CONFLICT', 'box_name 与 boxName 不一致，原值保存在快照。');
    const boxItems = rows(row.productList).map((entry) => product(entry, 'quantityInBox', false));
    if (!boxItems.length) add('EMPTY_BOX', '箱子没有商品明细。');
    const duplicate = new Set<string>();
    for (const item of boxItems) { const key = identity(item); if (duplicate.has(key)) add('DUPLICATE_BOX_PRODUCT', '同箱完整商品身份重复，未静默合并。'); duplicate.add(key); }
    const sum = boxItems.every((item) => item.quantity !== null) ? boxItems.reduce((value, item) => value + BigInt(item.quantity!), 0n).toString() : null;
    const declaredTotal = integerQuantity(row.total);
    if (declaredTotal !== null && sum !== null && declaredTotal !== sum) add('BOX_TOTAL_CONFLICT', '箱总量与箱内商品合计不一致。');
    return { id, externalBoxId, packageId, localBoxId, name: text(row.box_name) ?? text(row.boxName), order: match?.order ?? null,
      items: boxItems.map((item) => ({ msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: item.quantity, expiration: item.expiration, prepOwner: item.prepOwner, labelOwner: item.labelOwner })), weight: measurement(row.weight), weightUnit: text(row.weightUnit),
      length: measurement(row.length), width: measurement(row.width), height: measurement(row.height), dimensionUnit: text(row.lengthUnit) };
  });
  if (!boxes.length) add('EMPTY_BOXES', '货件没有装箱明细，请通过带来源的人工或 XLSX 候选补齐。');
  const removed = previous.filter((box) => !usedIds.has(box.id));
  if (removed.length) add('BOX_MAPPING_CONFLICT', '刷新后有旧箱无法匹配，需人工确认移除或映射。', 'error', { boxIds: removed.map((box) => box.id) });
  let maxOrder = boxes.reduce((max, box) => Math.max(max, box.order ?? 0), 0);
  const newBoxes = boxes.filter((box) => box.order === null);
  const orderValid = newBoxes.every((box) => box.localBoxId && /^\d+$/.test(box.localBoxId) && BigInt(box.localBoxId) > 0n) && localSeen.size === boxes.length;
  if (orderValid) for (const box of newBoxes.sort((a, b) => BigInt(a.localBoxId!) < BigInt(b.localBoxId!) ? -1 : 1)) box.order = ++maxOrder;
  else if (newBoxes.length) add('BOX_ORDER_REQUIRED', '无法生成唯一货件内箱序建议，请人工确认箱顺序。');
  const packed = new Map<string, bigint>(); const unknownPacked = new Set<string>();
  for (const box of boxes) for (const item of box.items) {
    if (item.quantity === null) unknownPacked.add(identity(item));
    else packed.set(identity(item), (packed.get(identity(item)) ?? 0n) + BigInt(item.quantity));
  }
  for (const item of items) {
    const sum = packed.get(identity(item));
    if (unknownPacked.has(identity(item))) add('PACKED_QUANTITY_UNKNOWN', '部分箱内数量无效，逐箱合计尚不可确认。', 'error', { identity: identity(item), packed: null });
    else if (item.quantity !== null && (sum === undefined || sum.toString() !== item.quantity)) add('PACKED_QUANTITY_CONFLICT', '逐箱合计与详情申报量不一致，需修改候选并重新校验。', 'error', { identity: identity(item), declared: item.quantity, packed: sum?.toString() ?? null });
  }
  for (const key of packed.keys()) if (!productKeys.has(key)) add('UNKNOWN_BOX_PRODUCT', '箱内商品未在货件详情中找到完整身份匹配。');
  return { sid: input.sid, fba: expectedFba, items, boxes, isSta, shipmentStatus, staPlanId: text(input.listing.sta_inbound_plan_id) ?? text(object(input.details.data).inboundPlanId),
    observedAt: input.observedAt ?? new Date().toISOString(), issues };
}
