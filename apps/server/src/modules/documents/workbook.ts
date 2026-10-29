import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createFbaRowFill } from '../../xlsx-fba-fill.js';
import { Decimal } from 'decimal.js';
import { DOCUMENT_BLANK_OUTPUT_FIELDS, DOCUMENT_FIELD_OPTIONS, DOCUMENT_REQUIRED_FIELDS, DOCUMENT_PRODUCT_FIELDS, calculateDocumentInvoiceUnitPrice, documentInvoicePrice, documentBoxes, documentCurrencyForCountry, documentInvoiceBoxGroups, documentProductCurrency, documentProductImageInfo, documentProductSourceFact, withDocumentDefaults, withDocumentInvoiceDefaults, type DocumentMemberSnapshot, type DocumentRevisionData, type PhysicalBox } from '@scm/contracts';
export { DOCUMENT_REQUIRED_FIELDS, DOCUMENT_PRODUCT_FIELDS } from '@scm/contracts';
import { validateImportArchive } from '../imports/zip-preflight.js';
import { documentBoxFieldIssues } from './domain.js';
import { DocumentWorkbookError } from './workbook-errors.js';

export const DOCUMENT_WORKBOOK_VERSION = 'fengxin-b2b/v2';
export const DOCUMENT_HEADER_FIELDS = {
  orderNumber: 'B1', service: 'B2', addressCode: 'B3', recipientName: 'B4', recipientCompany: 'B5', addressLine1: 'B6', addressLine2: 'B7', addressLine3: 'B8',
  city: 'B9', state: 'B10', postalCode: 'B11', countryCode: 'B12', phone: 'B13', email: 'B14', deliveryStation: 'B15',
  battery: 'F1', magnetic: 'F2', liquid: 'F3', powder: 'F4', dangerous: 'F5', customsMode: 'F6', clearanceMode: 'F7', taxMode: 'F8', tradeTerms: 'F9', vat: 'F10',
  reference: 'F11', currency: 'F12', remarks: 'F13', deliveryWindow: 'F14',
} as const;
export const DOCUMENT_MAIN_HEADERS = ['货箱编号', 'PONumber', '货箱重量(KG)', '货箱长度(CM)', '货箱宽度(CM)', '货箱高度(CM)', '产品英文品名', '产品中文品名', '产品申报单价', '产品申报数量（单箱产品个数）', '产品材质', '产品海关编码', '产品用途', '产品品牌', '产品型号', '产品图片', '产品销售链接'];
export const DOCUMENT_HEADER_LABELS = [
  ['客户订单号', '带电'], ['服务', '带磁'], ['地址库编码', '液体'], ['收件人姓名', '粉末'], ['收件人公司', '危险品'], ['收件人地址一', '报关方式'], ['收件人地址二', '清关方式'], ['收件人地址三', '交税方式'], ['收件人城市', '交货条款'], ['收件人省份/州', 'VAT号'], ['收件人邮编', '参考号一'], ['收件人国家代码(二字代码)', '申报币种'], ['收件人电话', '备注'], ['收件人邮箱', '亚马逊预约配送时段（必填）'], ['所在货站', '亚马逊上架总数量（必填）'], ['箱数', ''],
];
type Issue = { code: string; severity: 'error' | 'warning'; message: string; demandId?: string };
type Product = { msku: string; fnsku: string; sku: string };
type Declaration = Record<string, string>;
type Line = { member: DocumentMemberSnapshot; box: PhysicalBox; boxIds: string[]; range: string; count: number; product: Product & { quantity: string }; actualQuantity: string; actualTotalQuantity: string; declaredQuantity: string; declaration: Declaration };
const Exact = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP });
const scalar = (value: unknown) => typeof value === 'string' ? value.trim() : typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const productKey = (item: Product) => JSON.stringify([item.msku, item.fnsku, item.sku]);
export const documentProductOverrideKey = (sid: number, item: Product) => createHash('sha256').update(JSON.stringify([sid, item.msku, item.fnsku, item.sku])).digest('hex');
const positive = (value: string) => /^\d+(?:\.\d+)?$/.test(value) && new Exact(value).gt(0) && new Exact(value).lte(Number.MAX_SAFE_INTEGER);
const integer = (value: string | null) => value !== null && /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const price = (value: string) => /^\d+(?:\.\d{1,2})?$/.test(value) && positive(value) && new Exact(String(Number(value))).equals(value);
/** Retained for reading historical Listing price observations and manual entries. */
export const calculateInvoiceUnitPrice = calculateDocumentInvoiceUnitPrice;
const currencyLabels: Record<string, string> = { USD: '美元', EUR: '欧元', GBP: '英镑' };
const mixedCurrencyMessage = '本票 FBA 所属国家对应多个币种，请按币种拆分出单；系统不自动换汇。';
function workbookData(data: DocumentRevisionData): DocumentRevisionData {
  return { ...data, fields: withDocumentInvoiceDefaults(data.fields, data.members) };
}
const ticketCurrencies = (data: DocumentRevisionData) => new Set(data.members.flatMap((member) => {
  const currency = documentCurrencyForCountry(member.demand.snapshot.country);
  return currency ? [currency] : [];
}));
const fieldOptionErrors: Record<keyof typeof DOCUMENT_FIELD_OPTIONS, [string, string]> = {
  battery: ['FLAG_INVALID', 'battery 只接受“是”或“否”。'],
  magnetic: ['FLAG_INVALID', 'magnetic 只接受“是”或“否”。'],
  liquid: ['FLAG_INVALID', 'liquid 只接受“是”或“否”。'],
  powder: ['FLAG_INVALID', 'powder 只接受“是”或“否”。'],
  dangerous: ['FLAG_INVALID', 'dangerous 只接受“是”或“否”。'],
  taxMode: ['TAX_MODE_INVALID', '交税方式不属于当前丰信模板选项。'],
  customsMode: ['CUSTOMS_MODE_INVALID', '报关方式不属于当前丰信模板选项。'],
  clearanceMode: ['CLEARANCE_MODE_INVALID', '清关方式不属于当前丰信模板选项。'],
  deliveryStation: ['DELIVERY_STATION_INVALID', '所在货站不属于当前丰信模板选项。'],
  currency: ['CURRENCY_UNSUPPORTED', '当前受控模板仅已核实 USD、EUR、GBP 的币种映射。'],
};
function declaration(data: DocumentRevisionData, member: DocumentMemberSnapshot, item: Product): Declaration {
  const matches = data.profileReferences.filter((ref) => ref.category === 'product' && Number(ref.data.sid) === member.demand.snapshot.sid && ['msku', 'fnsku', 'sku'].every((field) => scalar(ref.data[field]) === item[field as keyof Product]));
  if (matches.length > 1) throw new DocumentWorkbookError('同一完整商品身份引用了多份申报资料。');
  const values = Object.fromEntries(Object.entries(matches[0]?.data ?? {}).map(([key, value]) => [key, scalar(value)]));
  const prefix = `product.${documentProductOverrideKey(member.demand.snapshot.sid, item)}.`;
  for (const [key, value] of Object.entries(data.fields)) if (key.startsWith(prefix) && value !== null) values[key.slice(prefix.length)] = scalar(value);
  if (data.generationRulesVersion === 'v2') {
    const effective = documentInvoicePrice(data);
    values.unitPrice = effective.unitPrice;
    values.currency = effective.currency;
    values.unitPriceConfirmed = 'true';
  } else values.currency = documentProductCurrency(values.currency, data.fields.currency);
  return values;
}
/** A confirmation belongs to the effective price/currency pair, not the draft. */
export function reviseDocumentProductFields(previous: DocumentRevisionData, next: DocumentRevisionData, submittedFields?: Readonly<Record<string, string | null>>, confirmPrices = false): Record<string, string | null> {
  const fields = { ...next.fields }, checked = new Set<string>();
  if (next.generationRulesVersion === 'v2') return fields;
  // A legacy confirmation belongs to the currency actually saved at the time.
  // Country defaults apply to the new pair, never to the historical pair.
  const previousOutput = { ...previous, fields: withDocumentDefaults(previous.fields) }, nextOutput = workbookData(next);
  for (const member of next.members) for (const item of member.shipment.data.items) {
    const key = documentProductOverrideKey(member.demand.snapshot.sid, item);
    if (checked.has(key)) continue;
    checked.add(key);
    const previousMember = previous.members.find((candidate) => candidate.demand.snapshot.sid === member.demand.snapshot.sid && candidate.shipment.data.items.some((product) => productKey(product) === productKey(item)));
    if (!previousMember) continue;
    let before: Declaration, after: Declaration;
    try { before = declaration(previousOutput, previousMember, item); after = declaration(nextOutput, member, item); } catch { continue; }
    if (before.unitPrice === after.unitPrice && before.currency === after.currency || after.unitPriceConfirmed !== 'true') continue;
    const prefix = `product.${key}.`;
    const validPair = price(after.unitPrice ?? '') && (DOCUMENT_FIELD_OPTIONS.currency as readonly string[]).includes(after.currency ?? '') && after.currency === nextOutput.fields.currency;
    const explicitlyConfirmed = submittedFields?.[`${prefix}unitPriceConfirmed`] === 'true' && submittedFields[`${prefix}unitPrice`]?.trim() === after.unitPrice && submittedFields[`${prefix}currency`]?.trim() === after.currency;
    if (!validPair || !explicitlyConfirmed && !confirmPrices) fields[`${prefix}unitPriceConfirmed`] = 'false';
  }
  return fields;
}
function signature(box: PhysicalBox) {
  return JSON.stringify({ po: box.po, values: box.values, items: box.items.map((item) => [productKey(item), item.quantity, item.expiration ?? null, item.prepOwner ?? null, item.labelOwner ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
}
const sourceBoxes = (member: DocumentMemberSnapshot, fields: DocumentRevisionData['fields']) => documentBoxes(member, fields);
function boxDeclarationQuantity(data: DocumentRevisionData, member: DocumentMemberSnapshot, box: PhysicalBox, product: Product) {
  const actualQuantity = box.items.reduce((sum, item) => sum + (integer(item.quantity) ? BigInt(item.quantity!) : 0n), 0n).toString();
  const candidate = scalar(documentProductSourceFact(data, member.demand.snapshot.sid, product)?.cartonQuantity);
  const fromCartonSpec = integer(candidate) && BigInt(candidate) > 0n;
  return { actualQuantity, declaredQuantity: fromCartonSpec ? BigInt(candidate).toString() : actualQuantity, fromCartonSpec };
}
function image(data: Declaration): { bytes: Buffer; extension: 'png' | 'jpeg' } | null {
  const parsed = documentProductImageInfo(data.imageBase64);
  return parsed ? { bytes: Buffer.from(parsed.base64, 'base64'), extension: parsed.extension } : null;
}

/** Pure validation shared by preflight and the final renderer. No remote calls. */
export function validateWorkbookData(data: DocumentRevisionData): Issue[] {
  data = workbookData(data);
  const issues: Issue[] = [];
  issues.push(...documentBoxFieldIssues(data));
  const add = (code: string, message: string, member?: DocumentMemberSnapshot, severity: Issue['severity'] = 'error') => issues.push({ code, severity, message, ...(member ? { demandId: member.demand.id } : {}) });
  if (ticketCurrencies(data).size > 1) add('DOCUMENT_TICKET_CURRENCY_CONFLICT', mixedCurrencyMessage);
  if (data.generationRulesVersion !== undefined && data.generationRulesVersion !== 'v1' && data.generationRulesVersion !== 'v2') add('DOCUMENT_GENERATION_RULES_UNSUPPORTED', '发票生成规则版本无法识别，请重新建立或升级草稿。');
  const v2 = data.generationRulesVersion === 'v2';
  for (const key of DOCUMENT_REQUIRED_FIELDS) if (!data.fields[key]?.trim()) add('DOCUMENT_FIELD_REQUIRED', `请补齐单票资料：${key}。`);
  if (data.fields.taxMode && /自主|递延/.test(data.fields.taxMode) && !data.fields.vat?.trim()) add('VAT_REQUIRED', '自主税号或递延方式必须填写已确认 VAT。');
  for (const key of Object.keys(DOCUMENT_FIELD_OPTIONS) as Array<keyof typeof DOCUMENT_FIELD_OPTIONS>) {
    const options: readonly string[] = DOCUMENT_FIELD_OPTIONS[key];
    if (data.fields[key] && !options.includes(data.fields[key]!)) add(...fieldOptionErrors[key]);
  }
  const validInvoiceCurrency = (DOCUMENT_FIELD_OPTIONS.currency as readonly string[]).includes(data.fields.currency ?? '');
  const seen = new Set<string>(), checkedProducts = new Set<string>(); let totalQuantity = 0n;
  for (const member of data.members) {
    if (seen.has(member.demand.id)) add('DUPLICATE_MEMBER', '同一完整 FBA 不能重复出现。', member);
    seen.add(member.demand.id);
    const boxes = sourceBoxes(member, data.fields), expected = member.shipment.data.boxes;
    if (!boxes.length || boxes.length !== expected.length || new Set(boxes.map((box) => box.boxId)).size !== boxes.length || expected.some((box) => !boxes.some((actual) => actual.boxId === box.id))) add('DOCUMENT_BOX_SET_MISMATCH', '发票箱清单须完整匹配本票已确认的实际箱。', member);
    if (new Set(boxes.map((box) => box.order)).size !== boxes.length || boxes.some((box) => !Number.isSafeInteger(box.order) || box.order < 1)) add('BOX_ORDER_INVALID', '箱序必须采用已确认且唯一的正整数。', member);
    const groups = v2 ? documentInvoiceBoxGroups(boxes) : [];
    const boxGroups = new Map(groups.flatMap((group) => group.boxes.map((box) => [box.boxId, group] as const)));
    const representativeKeys = new Set(groups.flatMap(({ representative }) => representative ? [productKey(representative)] : []));
    const counts = new Map<string, bigint>();
    for (const box of boxes) {
      if (!box.po?.trim() || box.po.length > 200 || Array.from(box.po).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || Object.values(box.values).some((value) => !value || !positive(value))) add('DOCUMENT_BOX_VALUES_REQUIRED', 'PO、KG 毛重和 CM 尺寸必须完整有效，可在本票逐箱补齐或修改。', member);
      const identities = new Set<string>();
      for (const item of box.items) {
        const key = productKey(item);
        if (identities.has(key) || !integer(item.quantity) || item.quantity === '0' || v2 && ![item.msku, item.fnsku, item.sku].every((value) => value.trim())) { add('BOX_PRODUCT_INVALID', '箱内商品身份须唯一且单箱数量为有效正整数。', member); continue; }
        identities.add(key); counts.set(key, (counts.get(key) ?? 0n) + BigInt(item.quantity!)); totalQuantity += BigInt(item.quantity!);
      }
      if (v2) {
        const group = boxGroups.get(box.boxId), representative = group?.representative;
        if (!representative || !box.items.length) { add('BOX_PRODUCT_INVALID', '箱内必须有可用于申报的商品。', member); continue; }
        const quantities = boxDeclarationQuantity(data, member, group!.box, representative), actualQuantity = boxDeclarationQuantity(data, member, box, representative).actualQuantity, label = `${box.fba} 第 ${box.order} 箱`;
        if (box.items.length > 1) add('DOCUMENT_MIXED_CARTON', `${label}为混装箱，仅显示代表商品 ${representative.sku}；默认申报数量为 ${quantities.declaredQuantity}，请导出后手动核对修改。`, member, 'warning');
        if (!quantities.fromCartonSpec) add('DOCUMENT_CARTON_QUANTITY_FALLBACK', `${label}代表商品缺少有效箱规装量，申报数量默认使用代表商品所在箱实际数量合计 ${quantities.declaredQuantity}。`, member, 'warning');
        if (quantities.declaredQuantity !== actualQuantity) add('DOCUMENT_CARTON_QUANTITY_DIFFERENCE', `${label}默认申报数量 ${quantities.declaredQuantity} 与全箱实际数量 ${actualQuantity} 不同，请导出后手动核对修改。`, member, 'warning');
      }
    }
    const products = new Set<string>();
    for (const item of member.shipment.data.items) {
      const key = productKey(item);
      if (v2 && (products.has(key) || ![item.msku, item.fnsku, item.sku].every((value) => value.trim()))) add('BOX_PRODUCT_INVALID', '来源商品须具有完整且唯一的 MSKU、FNSKU 和 SKU。', member);
      products.add(key);
      if (!integer(item.quantity) || counts.get(key) !== BigInt(item.quantity!)) add('QUANTITY_MISMATCH', `商品 ${item.sku} 的逐箱合计与 M2 数量不一致。`, member);
      if (v2 && !representativeKeys.has(key)) continue;
      const declarationKey = documentProductOverrideKey(member.demand.snapshot.sid, item);
      if (checkedProducts.has(declarationKey)) continue;
      checkedProducts.add(declarationKey);
      let values: Declaration;
      try { values = declaration(data, member, item); } catch (error) { add('DECLARATION_AMBIGUOUS', (error as Error).message, member); continue; }
      const missingFields = DOCUMENT_PRODUCT_FIELDS.filter((field) => (!v2 || field !== 'unitPrice' && field !== 'currency') && !values[field] && (field !== 'currency' || validInvoiceCurrency));
      if (missingFields.length) add('DECLARATION_REQUIRED', `商品 ${item.sku} 缺少 ${missingFields.join('、')}。`, member);
      if (v2 && !(DOCUMENT_FIELD_OPTIONS.currency as readonly string[]).includes(values.currency ?? '')) add('DECLARATION_CURRENCY_UNSUPPORTED', `商品 ${item.sku} 的发票币种缺失或不受支持，仅可采用 USD、EUR、GBP。`, member);
      if (values.unitPrice && !price(values.unitPrice)) add('DECLARATION_PRICE_INVALID', `商品 ${item.sku} 申报单价须为可安全写入 XLSX、最多两位小数的有效正数。`, member);
      const validCurrency = (DOCUMENT_FIELD_OPTIONS.currency as readonly string[]).includes(values.currency ?? '') && values.currency === data.fields.currency;
      if (!v2 && price(values.unitPrice ?? '') && validCurrency && values.unitPriceConfirmed !== 'true') add('DECLARATION_PRICE_UNCONFIRMED', `商品 ${item.sku} 申报单价与币种尚未人工确认。`, member);
      if (values.currency && data.fields.currency?.trim() && values.currency !== data.fields.currency) add('CURRENCY_CONFLICT', `商品 ${item.sku} 申报币种与单票币种不一致。`, member);
      if (values.salesLink) try { if (!/^https?:$/.test(new URL(values.salesLink).protocol)) throw new DocumentWorkbookError(); } catch { add('SALES_LINK_INVALID', `商品 ${item.sku} 需要有效销售链接。`, member); }
      if (!image(values)) {
        const invalid = Boolean(values.imageBase64);
        add(invalid ? 'PRODUCT_IMAGE_INVALID' : 'PRODUCT_IMAGE_MISSING', invalid
          ? `商品 ${item.sku} 现有图片无效，本次图片列留空；请清除或重新上传 PNG/JPEG 图片，也可继续生成待复核文件。`
          : `商品 ${item.sku} 暂无有效 PNG/JPEG 图片，可补充图片或继续生成待复核文件。`, member, 'warning');
      }
    }
    if ([...counts.keys()].some((key) => !products.has(key))) add('UNEXPECTED_PRODUCT', '实物箱中存在 M2 商品清单以外的商品。', member);
  }
  if (totalQuantity > BigInt(Number.MAX_SAFE_INTEGER)) add('DOCUMENT_TOTAL_QUANTITY_UNSAFE', '整票商品数量超过 XLSX 安全整数范围，请拆分完整货件后生成。');
  return issues;
}

/** Each complete FBA is compressed independently; box numbers never span FBAs. */
export function projectDocumentLines(data: DocumentRevisionData) {
  if (data.generationRulesVersion !== undefined && data.generationRulesVersion !== 'v1' && data.generationRulesVersion !== 'v2') throw new DocumentWorkbookError('发票生成规则版本无法识别。');
  if (ticketCurrencies(data).size > 1) throw new DocumentWorkbookError(mixedCurrencyMessage);
  data = workbookData(data);
  const v2 = data.generationRulesVersion === 'v2';
  const lines: Line[] = [];
  const perProduct: Record<string, string> = {};
  let boxCount = 0; let totalWeight = new Exact(0); let totalQuantity = 0n; let totalValue = new Exact(0);
  for (const member of data.members) {
    const boxes = sourceBoxes(member, data.fields);
    boxCount += boxes.length;
    for (const box of boxes) {
      totalWeight = totalWeight.plus(box.values.weight ?? '0');
      for (const item of box.items) { const quantity = BigInt(item.quantity ?? '0'); totalQuantity += quantity; const key = JSON.stringify([member.demand.id, item.msku, item.fnsku, item.sku]); perProduct[key] = (BigInt(perProduct[key] ?? '0') + quantity).toString(); }
    }
    const compress = boxes.length > 0 && boxes.every((box) => signature(box) === signature(boxes[0]!)) && boxes.every((box, index) => box.order === index + 1);
    const groups = v2 ? documentInvoiceBoxGroups(boxes) : (compress ? [boxes] : boxes.map((box) => [box])).map((selected) => ({ boxes: selected, box: selected[0]!, representative: undefined }));
    for (const { boxes: selected, box, representative } of groups) {
      const number = `${box.fba}U${String(selected[0]!.order).padStart(6, '0')}`;
      const range = selected.length > 1 ? `${number}-${selected.length}` : number;
      const actualTotalQuantity = selected.reduce((sum, entry) => sum + entry.items.reduce((quantity, item) => quantity + BigInt(item.quantity ?? '0'), 0n), 0n).toString();
      for (const item of v2 ? representative ? [representative] : [] : box.items) {
        const values = declaration(data, member, item), count = selected.length;
        const quantities = v2 ? boxDeclarationQuantity(data, member, box, item) : { actualQuantity: item.quantity ?? '0', declaredQuantity: item.quantity ?? '0' };
        totalValue = totalValue.plus(new Exact(values.unitPrice || '0').times(quantities.declaredQuantity).times(count));
        lines.push({ member, box, boxIds: selected.map((entry) => entry.boxId), range, count, product: { ...item, quantity: item.quantity ?? '0' }, ...quantities, actualTotalQuantity, declaration: values });
      }
    }
  }
  if (totalQuantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new DocumentWorkbookError('整票商品数量超过 XLSX 安全整数范围，不能写入舍入后的汇总。');
  return { lines, boxCount, totalWeight: totalWeight.toFixed(2), totalQuantity: totalQuantity.toString(), totalValue: totalValue.toFixed(2), perProduct };
}
const text = (cell: ExcelJS.Cell) => {
  const value = cell.value;
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : value && typeof value === 'object' && 'richText' in value ? value.richText.map((part) => part.text).join('') : '';
};
const addressLayoutError = '发票收件地址及表头过高，无法在每页完整打印。请核对并合理拆分到地址二、地址三，或调整模板列宽后重新生成。';
const fontSize = (cell: ExcelJS.Cell) => Number.isFinite(cell.font?.size) && cell.font.size! > 0 ? cell.font.size! : 11;
function glyphWidth(character: string, size: number) {
  if (/\p{Mark}/u.test(character)) return 0;
  const em = character.codePointAt(0)! > 0x024f ? 1.05 : /[MWmw@%]/.test(character) ? 1 : /[ilI.,'`:;!|\s]/.test(character) ? 0.35 : /[A-Z0-9]/.test(character) ? 0.75 : 0.65;
  return em * size * 4 / 3;
}
function wrappedLines(value: string, width: number, size: number) {
  let lines = 0;
  for (const paragraph of value.replace(/\t/g, '    ').split(/\r\n|\r|\n/)) {
    let used = 0; lines++;
    for (const token of paragraph.trimEnd().match(/\s+|\S+/gu) ?? []) {
      const characters = Array.from(token), tokenWidth = characters.reduce((sum, character) => sum + glyphWidth(character, size), 0);
      if (tokenWidth <= width) {
        if (used && used + tokenWidth > width) { lines++; used = 0; }
        used += tokenWidth;
      } else {
        if (used) { lines++; used = 0; }
        for (const character of characters) {
          const next = glyphWidth(character, size);
          if (used && used + next > width) { lines++; used = 0; }
          used += next;
        }
      }
    }
  }
  return lines;
}
function headerCellHeight(sheet: ExcelJS.Worksheet, cell: ExcelJS.Cell, firstColumn: number, lastColumn: number) {
  const value = text(cell); if (!value) return 0;
  const size = fontSize(cell);
  // Excel column widths use the default font's digit width. Keep padding and a
  // conservative glyph estimate because merged cells cannot reliably auto-fit.
  let width = -8 - (cell.alignment?.indent ?? 0) * size * 4;
  for (let column = firstColumn; column <= lastColumn; column++) {
    const source = sheet.getColumn(column);
    if (!source.hidden) width += (source.width ?? sheet.properties.defaultColWidth ?? 8.43) * 7 + 5;
  }
  if (!Number.isFinite(width) || width < size * 4 / 3) throw new DocumentWorkbookError('发票地址列宽不足，请调整模板列宽后重新生成。');
  const lines = cell.alignment?.wrapText ? wrappedLines(value, width, size) : value.split(/\r\n|\r|\n/).length;
  return Math.ceil((lines * size * 1.25 + 3) * 4) / 4;
}
/** Apply to fresh invoices and reused historical sheets without changing values. */
export function applyDocumentAddressLayout(sheet: ExcelJS.Worksheet) {
  const defaultHeight = sheet.properties.defaultRowHeight || 15;
  for (let row = 3; row <= 14; row++) {
    const address = sheet.getCell(row, 2), other = sheet.getCell(row, 6);
    address.alignment = { ...address.alignment, horizontal: 'left', vertical: 'middle', wrapText: true, shrinkToFit: false, textRotation: 0, indent: 0 };
    const height = Math.max(sheet.getRow(row).height ?? defaultHeight, headerCellHeight(sheet, address, 2, 4), headerCellHeight(sheet, other, 6, 8));
    if (height > 409) throw new DocumentWorkbookError(`${addressLayoutError}（Excel 单行高度上限 409 磅。）`);
    sheet.getRow(row).height = height;
  }
  // The controlled layout uses landscape A4/Letter defaults. Reserve space
  // below the repeated header for margins and at least one 64 pt detail row.
  const headerHeight = Array.from({ length: 17 }, (_, row) => sheet.getRow(row + 1).height ?? defaultHeight).reduce((sum, height) => sum + height, 0);
  if (headerHeight > 360) throw new DocumentWorkbookError(`${addressLayoutError}（重复表头高度上限 360 磅。）`);
  sheet.pageSetup.printTitlesRow = '1:17';
}
async function templateSheet(bytes: Buffer) {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new DocumentWorkbookError('单据模板必须是不超过 10 MiB 的 XLSX。');
  await validateImportArchive(bytes);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheets = book.worksheets.filter((sheet) => text(sheet.getCell('A17')).replace(/\s|\*/g, '') === '货箱编号' && text(sheet.getCell('B17')).replace(/\s|\*/g, '') === 'PONumber');
  if (sheets.length !== 1) throw new DocumentWorkbookError('模板必须有且只有一张符合丰信单票 A17:Q17 布局的主表。');
  const sheet = sheets[0]!;
  const normalize = (value: string) => value.replace(/\s|\*/g, '');
  for (let column = 1; column <= 17; column++) if (normalize(text(sheet.getCell(17, column))) !== DOCUMENT_MAIN_HEADERS[column - 1]) throw new DocumentWorkbookError(`单据模板第 17 行第 ${column} 列不匹配当前丰信布局。`);
  DOCUMENT_HEADER_LABELS.forEach((labels, index) => { for (const [labelIndex, column] of [[0, 1], [1, 5]] as const) if (normalize(text(sheet.getCell(index + 1, column))) !== labels[labelIndex]) throw new DocumentWorkbookError(`单据模板第 ${index + 1} 行标签与受控丰信布局不一致。`); });
  return sheet;
}
/** Rebuild only the approved layout, excluding prior contents, media and helpers. */
export async function cleanDocumentTemplate(bytes: Buffer) {
  const original = await templateSheet(bytes), book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(original.name, { properties: { defaultRowHeight: original.properties.defaultRowHeight } });
  book.created = new Date('2026-10-19T00:00:00.000Z'); book.modified = book.created;
  for (let column = 1; column <= 17; column++) sheet.getColumn(column).width = original.getColumn(column).width;
  for (let row = 1; row <= 17; row++) {
    sheet.getRow(row).height = original.getRow(row).height;
    for (let column = 1; column <= 17; column++) {
      const source = original.getCell(row, column), target = sheet.getCell(row, column);
      target.style = structuredClone(source.style);
      if (row === 17 || column === 1 || column === 5) target.value = row === 17 ? DOCUMENT_MAIN_HEADERS[column - 1]! : text(source);
    }
  }
  for (let row = 1; row <= 16; row++) { sheet.mergeCells(`B${row}:D${row}`); sheet.mergeCells(`F${row}:H${row}`); }
  for (const address of Object.values(DOCUMENT_HEADER_FIELDS)) sheet.getCell(address).value = null;
  sheet.getCell('B16').value = null; sheet.getCell('F15').value = null;
  for (const key of Object.keys(DOCUMENT_FIELD_OPTIONS) as Array<keyof typeof DOCUMENT_FIELD_OPTIONS>) {
    const values = DOCUMENT_FIELD_OPTIONS[key].map((value) => key === 'currency' ? currencyLabels[value]! : value);
    sheet.getCell(DOCUMENT_HEADER_FIELDS[key]).dataValidation = { type: 'list', allowBlank: key === 'clearanceMode' || key === 'deliveryStation', formulae: [`"${values.join(',')}"`] };
  }
  sheet.views = [{ state: 'frozen', ySplit: 17, showGridLines: false }];
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: 'A1:Q18', printTitlesRow: '1:17' };
  return Buffer.from(await book.xlsx.writeBuffer());
}
export async function createWorkbook(data: DocumentRevisionData, templateBytes: Buffer, _exportId?: string): Promise<Buffer> {
  void _exportId;
  data = workbookData(data);
  const issues = validateWorkbookData(data);
  const blockingIssue = issues.find((issue) => issue.severity === 'error');
  if (blockingIssue) throw new DocumentWorkbookError(blockingIssue.message);
  const projection = projectDocumentLines(data), book = new ExcelJS.Workbook();
  await book.xlsx.load(await cleanDocumentTemplate(templateBytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.worksheets[0]!;
  const fillFba = createFbaRowFill(projection.lines.map((line) => line.box.fba));
  for (const [key, address] of Object.entries(DOCUMENT_HEADER_FIELDS)) sheet.getCell(address).value = (DOCUMENT_BLANK_OUTPUT_FIELDS as readonly string[]).includes(key) ? null : data.fields[key] ?? null;
  sheet.getCell('F12').value = currencyLabels[data.fields.currency!] ?? null;
  sheet.getCell('B16').value = projection.boxCount;
  sheet.getCell('F15').value = Number(projection.totalQuantity);
  const expectedImages: Array<{ row: number; bytes: Buffer; extension: 'png' | 'jpeg' }> = [];
  projection.lines.forEach((line, index) => {
    const row = sheet.getRow(index + 18), p = line.declaration;
    row.values = [line.range, line.box.po, ...['weight', 'length', 'width', 'height'].map((key) => Number(line.box.values[key as keyof PhysicalBox['values']])), p.englishName, p.chineseName, Number(p.unitPrice), Number(line.declaredQuantity), p.material, p.hsCode, p.use, p.brand, p.model, null, p.salesLink];
    row.height = 64;
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cell.font = { name: '微软雅黑', size: 9 }; cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { top: { style: 'thin', color: { argb: 'FFD4D4D4' } }, bottom: { style: 'thin', color: { argb: 'FFD4D4D4' } }, left: { style: 'thin', color: { argb: 'FFD4D4D4' } }, right: { style: 'thin', color: { argb: 'FFD4D4D4' } } };
      cell.numFmt = [3, 4, 5, 6, 9].includes(column) ? '0.00' : column === 10 ? '0' : '@';
    });
    fillFba(row, line.box.fba, 17);
    const productImage = image(p);
    if (productImage) {
      const id = book.addImage({ buffer: productImage.bytes as unknown as ExcelJS.Image['buffer'], extension: productImage.extension });
      sheet.addImage(id, { tl: { col: 15, row: index + 17 }, ext: { width: 66, height: 78 }, editAs: 'oneCell' });
      expectedImages.push({ row: index + 17, ...productImage });
    }
  });
  sheet.pageSetup.printArea = `A1:Q${17 + projection.lines.length}`;
  applyDocumentAddressLayout(sheet);
  const bytes = Buffer.from(await book.xlsx.writeBuffer()), verify = new ExcelJS.Workbook();
  await verify.xlsx.load(bytes as unknown as Parameters<typeof verify.xlsx.load>[0]);
  const written = verify.worksheets[0]!;
  if (written.pageSetup.printTitlesRow !== '1:17') throw new DocumentWorkbookError('发票收件地址未完整设为每页重复打印表头。');
  if (DOCUMENT_BLANK_OUTPUT_FIELDS.some((key) => written.getCell(DOCUMENT_HEADER_FIELDS[key]).value !== null)) throw new DocumentWorkbookError('发票订单编号、参考号和贸易条款必须留空。');
  const expanded = new Map<string, bigint>(), coveredBoxes = new Set<string>();
  const v2 = data.generationRulesVersion === 'v2';
  let expandedActualQuantity = 0n;
  projection.lines.forEach((line, index) => {
    const row = written.getRow(index + 18), key = JSON.stringify([line.member.demand.id, line.product.msku, line.product.fnsku, line.product.sku]);
    if (row.getCell(1).value !== line.range || row.getCell(2).value !== line.box.po || row.getCell(10).value !== Number(line.declaredQuantity)) throw new DocumentWorkbookError('发票写入后回读明细不一致。');
    if (v2) {
      const p = line.declaration;
      const expected = [line.range, line.box.po, ...['weight', 'length', 'width', 'height'].map((field) => Number(line.box.values[field as keyof PhysicalBox['values']])), p.englishName, p.chineseName, Number(p.unitPrice), Number(line.declaredQuantity), p.material, p.hsCode, p.use, p.brand, p.model, null, p.salesLink];
      if (expected.some((value, column) => row.getCell(column + 1).value !== value) || row.getCell(9).numFmt !== '0.00' || row.getCell(10).numFmt !== '0' || line.boxIds.length !== line.count) throw new DocumentWorkbookError('发票写入后回读代表商品或默认申报数量不一致。');
      for (const boxId of line.boxIds) {
        const boxKey = JSON.stringify([line.member.demand.id, boxId]);
        if (coveredBoxes.has(boxKey)) throw new DocumentWorkbookError('发票输出重复包含同一个实际箱。');
        coveredBoxes.add(boxKey);
      }
      expandedActualQuantity += BigInt(line.actualTotalQuantity);
    } else expanded.set(key, (expanded.get(key) ?? 0n) + BigInt(String(row.getCell(10).value)) * BigInt(line.count));
  });
  const writtenImages = written.getImages();
  const imagesMatch = writtenImages.length === expectedImages.length && expectedImages.every((expected) => {
    const matching = writtenImages.filter((entry) => entry.range.tl.nativeRow === expected.row && entry.range.tl.nativeCol === 15);
    if (matching.length !== 1) return false;
    const media = verify.getImage(Number(matching[0]!.imageId));
    return media?.extension === expected.extension && media.buffer !== undefined && expected.bytes.equals(Buffer.from(media.buffer as unknown as Uint8Array));
  });
  const quantitiesMatch = v2
    ? coveredBoxes.size === projection.boxCount && expandedActualQuantity === BigInt(projection.totalQuantity) && data.members.every((member) => sourceBoxes(member, data.fields).every((box) => coveredBoxes.has(JSON.stringify([member.demand.id, box.boxId]))))
    : Object.entries(projection.perProduct).every(([key, value]) => expanded.get(key) === BigInt(value));
  if (!quantitiesMatch || !imagesMatch || written.getCell('B16').value !== projection.boxCount || written.getCell('F15').value !== Number(projection.totalQuantity)) throw new DocumentWorkbookError('发票压缩展开、图片或汇总对账失败。');
  return bytes;
}
