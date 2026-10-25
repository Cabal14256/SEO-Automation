import { shipmentIssuesForDisplay, type BatchIssue, type ShipmentData } from '@scm/contracts';

export const BATCH_RULE_VERSION = 'shipment-detail-quantity-v1';
export const productKey = (item: { msku: string; fnsku: string; sku: string }) => JSON.stringify([item.msku, item.fnsku, item.sku]);
const quantity = (value: string | null | undefined): bigint | null => value !== null && value !== undefined && /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(value) : null;
export function alphabeticPrefix(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('编码序号无效');
  let result = ''; let number = index + 1;
  while (number > 0) { number--; result = String.fromCharCode(65 + number % 26) + result; number = Math.floor(number / 26); }
  return result;
}
export function validateShipmentData(data: ShipmentData): BatchIssue[] {
  const issues: BatchIssue[] = shipmentIssuesForDisplay(data);
  const add = (code: string, message: string, details?: Record<string, unknown>, severity: 'error' | 'warning' = 'error') => issues.push({ code, message, severity, ...(details ? { details } : {}) });
  const products = new Map<string, typeof data.items[number]>();
  if (!data.items.length) add('NO_PRODUCTS', '货件缺少商品明细。');
  if (!data.boxes.length) add('NO_BOXES', '货件缺少逐箱明细。');
  for (const item of data.items) {
    const key = productKey(item);
    if (![item.msku, item.fnsku, item.sku].every((value) => value.trim())) add('PRODUCT_IDENTITY_REQUIRED', '商品必须保存 MSKU、FNSKU 和 SKU。', { key });
    if (!item.name?.trim()) add('PRODUCT_NAME_REQUIRED', '商品缺少品名，请补录后重新确认。', { key });
    if (products.has(key)) add('DUPLICATE_PRODUCT', '货件商品身份重复，需修正候选数据。', { key });
    products.set(key, item);
    if (quantity(item.quantity) === null) add('PRODUCT_QUANTITY_REQUIRED', '详情申报量缺失或不是可安全导出的非负整数。', { key });
    if (item.listQuantity !== undefined && item.listQuantity !== null && quantity(item.listQuantity) !== quantity(item.quantity)) add('LIST_QUANTITY_MISMATCH', '列表申报量与详情申报量不同，请明确采用详情量。', { key, detail: item.quantity, list: item.listQuantity });
  }
  const totals = new Map<string, bigint>(); const ids = new Set<string>(); const orders = new Set<number>();
  for (const box of data.boxes) {
    if (ids.has(box.id)) add('DUPLICATE_BOX_ID', '内部箱 ID 重复。', { boxId: box.id });
    ids.add(box.id);
    if (box.order === null || orders.has(box.order)) add('BOX_ORDER_REQUIRED', '每箱需要不重复的人工确认顺序。', { boxId: box.id });
    if (box.order !== null) orders.add(box.order);
    if (!box.items.length) add('EMPTY_BOX', '箱内商品为空。', { boxId: box.id });
    const boxProducts = new Set<string>();
    for (const item of box.items) {
      const key = productKey(item); const count = quantity(item.quantity);
      if (boxProducts.has(key)) add('DUPLICATE_BOX_PRODUCT', '同一箱内商品身份重复。', { boxId: box.id, key });
      boxProducts.add(key);
      if (!products.has(key)) add('BOX_PRODUCT_UNMATCHED', '箱内商品无法对应货件商品完整身份。', { boxId: box.id, key });
      if (count === null) add('BOX_QUANTITY_REQUIRED', '箱内数量缺失或不是可安全导出的非负整数。', { boxId: box.id, key });
      else totals.set(key, (totals.get(key) ?? 0n) + count);
    }
  }
  for (const [key, item] of products) if (quantity(item.quantity) !== null && quantity(item.quantity) !== (totals.get(key) ?? 0n)) add('PACKED_QUANTITY_MISMATCH', '商品申报量与所有箱内数量合计不一致。', { key, declared: item.quantity, packed: String(totals.get(key) ?? 0n) });
  return issues;
}
