import { Decimal } from 'decimal.js';
import { calculateInvoiceUnitPrice } from './workbook.js';

export type LingxingProductIdentity = { sid: number; msku: string; fnsku: string; sku: string; country: string };
export type LingxingMappedProduct = { data: Record<string, unknown>; imageUrls: string[]; issues: string[] };
type Row = Record<string, unknown>;
type PriceCandidate = { source: string; kind: 'country-clearance' | 'default-clearance' | 'declaration' | 'legacy-declaration'; unitPrice: string; currency: string };
const Exact = Decimal.clone({ precision: 100 });
const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string => typeof value === 'string' && !/^(?:null|undefined|n\/?a|&nbsp;|-)$/i.test(value.trim()) ? value.trim() : '';
const firstText = (...values: unknown[]) => values.map(text).find(Boolean) ?? '';
const id = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const currency = (value: unknown) => /^[A-Z]{3}$/.test(text(value).toUpperCase()) ? text(value).toUpperCase() : '';
const hsCode = (value: unknown) => /^\d{6,12}$/.test(text(value)) ? text(value) : '';
function positivePrice(value: unknown): string {
  const input = typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
  if (!/^\d+(?:\.\d+)?$/.test(input)) return '';
  const exact = new Exact(input);
  // The existing invoice renderer accepts at most two decimal places. Never
  // silently round a remote price or allow a lossy XLSX numeric conversion.
  if (exact.lte(0) || exact.gt(Number.MAX_SAFE_INTEGER) || exact.decimalPlaces() > 2 || !new Exact(String(Number(input))).equals(exact)) return '';
  return exact.toFixed(exact.decimalPlaces());
}
function webUrl(value: unknown): string {
  const input = text(value);
  try {
    const url = new URL(input);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

const countries: Record<string, string> = {
  US: 'US', USA: 'US', 'UNITED STATES': 'US', '美国': 'US', GB: 'UK', UK: 'UK', 'UNITED KINGDOM': 'UK', '英国': 'UK',
  CA: 'CA', CANADA: 'CA', '加拿大': 'CA', MX: 'MX', MEXICO: 'MX', '墨西哥': 'MX',
  DE: 'DE', GERMANY: 'DE', '德国': 'DE', FR: 'FR', FRANCE: 'FR', '法国': 'FR', ES: 'ES', SPAIN: 'ES', '西班牙': 'ES',
  IT: 'IT', ITALY: 'IT', '意大利': 'IT', NL: 'NL', NETHERLANDS: 'NL', '荷兰': 'NL', JP: 'JP', JAPAN: 'JP', '日本': 'JP',
  AU: 'AU', AUSTRALIA: 'AU', '澳大利亚': 'AU', '澳洲': 'AU', SG: 'SG', SINGAPORE: 'SG', '新加坡': 'SG',
  IN: 'IN', INDIA: 'IN', '印度': 'IN', AE: 'AE', '阿联酋': 'AE', SA: 'SA', '沙特阿拉伯': 'SA', BR: 'BR', BRAZIL: 'BR', '巴西': 'BR',
  SE: 'SE', SWEDEN: 'SE', '瑞典': 'SE', PL: 'PL', POLAND: 'PL', '波兰': 'PL', BE: 'BE', BELGIUM: 'BE', '比利时': 'BE',
  TR: 'TR', '土耳其': 'TR', UA: 'UA', '乌克兰': 'UA', HU: 'HU', '匈牙利': 'HU', PK: 'PK', '巴基斯坦': 'PK', LB: 'LB', '黎巴嫩': 'LB',
  AT: 'AT', '奥地利': 'AT', CH: 'CH', '瑞士': 'CH', CZ: 'CZ', '捷克': 'CZ', DK: 'DK', '丹麦': 'DK',
  IE: 'IE', IRELAND: 'IE', '爱尔兰': 'IE', LU: 'LU', '卢森堡': 'LU', NO: 'NO', '挪威': 'NO', PT: 'PT', '葡萄牙': 'PT',
  SK: 'SK', '斯洛伐克': 'SK', RU: 'RU', '俄罗斯': 'RU', KZ: 'KZ', '哈萨克斯坦': 'KZ', BY: 'BY', '白俄罗斯': 'BY',
  CL: 'CL', '智利': 'CL', KR: 'KR', '韩国': 'KR',
};

/** Lingxing logistics fields use UK, whereas invoice country codes use GB. */
export function lingxingLogisticsCountry(country: string): string | null { return countries[country.trim().toUpperCase()] ?? null; }

/** The official endpoint is a fuzzy search; callers must filter every result. */
export function matchLingxingFbaProduct(identity: Pick<LingxingProductIdentity, 'sid' | 'msku' | 'fnsku' | 'sku'>, candidate: unknown): boolean {
  const value = row(candidate);
  return Boolean(value && id(identity.sid) && id(value.sid) === identity.sid
    && (['msku', 'fnsku', 'sku'] as const).every((key) => Boolean(text(identity[key])) && text(value[key]) === text(identity[key])));
}

/** Pure, conservative candidates. This function never confirms a price or flag. */
export function mapLingxingProduct(identity: LingxingProductIdentity, fbaProduct: unknown, localDetail: unknown, includeLegacyPrice = true): LingxingMappedProduct {
  const data: Row = { sid: identity.sid, msku: identity.msku, fnsku: identity.fnsku, sku: identity.sku, unitPriceConfirmed: false };
  const issues: string[] = [];
  let fba = row(fbaProduct), local = row(localDetail);
  if (fba && !matchLingxingFbaProduct(identity, fba)) { issues.push('FBA 商品店铺、MSKU、FNSKU 或 SKU 与本票商品不一致，未采用其资料。'); fba = null; }
  if (local && (!text(identity.sku) || text(local.sku) !== text(identity.sku)
    || fba && id(fba.product_id) !== null && id(local.id) !== id(fba.product_id))) {
    issues.push('本地产品 SKU 或产品 ID 与本票商品不一致，未采用其资料。'); local = null;
  }
  const clearance = row(local?.clearance) ?? {}, declaration = row(local?.declaration) ?? {};
  const country = lingxingLogisticsCountry(identity.country);
  const logistics = Array.isArray(local?.product_logistics_relation) ? local.product_logistics_relation.map(row).filter((entry): entry is Row => entry !== null) : [];
  const prices: PriceCandidate[] = [];
  const addPrice = (amount: unknown, code: unknown, source: string, kind: PriceCandidate['kind']) => {
    const unitPrice = positivePrice(amount), priceCurrency = currency(code);
    if (unitPrice && priceCurrency) prices.push({ source, kind, unitPrice, currency: priceCurrency });
    else if (unitPrice || text(typeof amount === 'number' ? String(amount) : amount)) issues.push(`${source} 的价格或币种缺失、无效，未作为本票申报价格。`);
  };
  if (includeLegacyPrice && country) {
    for (const entry of logistics) if (entry[`${country}_clearance_price`] !== undefined) addPrice(entry[`${country}_clearance_price`], entry[`${country}_clearance_price_currency`], `product_logistics_relation.${country}_clearance_price`, 'country-clearance');
  }
  if (includeLegacyPrice) {
    addPrice(clearance.customs_clearance_price, clearance.customs_clearance_price_currency, 'clearance.customs_clearance_price', 'default-clearance');
    addPrice(declaration.customs_import_price, declaration.customs_import_price_currency, 'declaration.customs_import_price', 'declaration');
  }
  // Legacy amount and top-level procurement currency are distinct fields. The
  // legacy amount stays visible for review but cannot acquire a guessed currency.
  const legacyPrice = positivePrice(local?.bg_customs_import_price);
  if (includeLegacyPrice && legacyPrice) prices.push({ source: 'bg_customs_import_price', kind: 'legacy-declaration', unitPrice: legacyPrice, currency: '' });
  const countryPrices = prices.filter((entry) => entry.kind === 'country-clearance');
  const countryAmbiguous = new Set(countryPrices.map((entry) => `${entry.currency}:${entry.unitPrice}`)).size > 1;
  if (countryAmbiguous) issues.push('同一目的国存在不同清关价格，未自动选择目的国价格。');
  const chosenPrice = countryAmbiguous ? undefined : prices.find((entry) => entry.currency && entry.kind !== 'legacy-declaration');
  if (chosenPrice) Object.assign(data, { unitPrice: chosenPrice.unitPrice, currency: chosenPrice.currency, unitPriceSource: chosenPrice.source, unitPriceKind: chosenPrice.kind,
    unitPriceSourceLabel: chosenPrice.kind === 'country-clearance' ? `领星 ${country} 目的国清关价` : chosenPrice.kind === 'default-clearance' ? '领星默认清关价' : '领星报关价' });
  if (prices.length) data.priceCandidates = prices;
  const countryHs = country ? [...new Set(logistics.map((entry) => hsCode(entry[`${country}_bg_import_hs_code`])).filter(Boolean))] : [];
  if (countryHs.length > 1) issues.push('同一目的国存在不同进口 HS 编码，未自动选择目的国编码。');
  const fields: Row = {
    englishName: text(local?.bg_customs_import_name), chineseName: text(local?.bg_customs_export_name),
    material: firstText(clearance.customs_clearance_en_material, clearance.customs_clearance_material, local?.cg_product_material),
    use: text(clearance.customs_clearance_usage), brand: text(local?.brand_name),
    model: firstText(clearance.customs_clearance_product_pattern, local?.model, declaration.customs_declaration_spec),
    unit: firstText(declaration.customs_declaration_unit, local?.unit),
    hsCode: countryHs.length > 1 ? '' : (countryHs.length === 1 ? countryHs[0] : '') || hsCode(clearance.customs_clearance_hs_code) || (country === 'US' ? hsCode(local?.bg_import_hs_code) : ''),
    salesLink: webUrl(fba?.asin_url),
  };
  for (const [key, value] of Object.entries(fields)) if (value) data[key] = value;
  if (id(local?.id)) data.lingxingProductId = id(local?.id);
  if (hsCode(local?.bg_export_hs_code)) data.exportHsCode = hsCode(local?.bg_export_hs_code);
  if (country) data.lingxingCountry = country;
  const attrs = Array.isArray(local?.special_attr) ? [...new Set(local.special_attr.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry >= 1 && entry <= 6))] : [];
  if (attrs.length) data.specialAttributes = attrs;
  if (attrs.some((entry) => entry === 1 || entry === 2)) data.battery = '是';
  if (attrs.includes(6)) data.magnetic = '是';
  if (attrs.includes(3)) data.liquid = '是';
  if (attrs.includes(4)) data.powder = '是';
  if (attrs.includes(5)) data.paste = '是';
  const pictures = Array.isArray(local?.picture_list) ? local.picture_list.map(row).filter((entry): entry is Row => entry !== null).sort((left, right) => Number(right.is_primary === 1) - Number(left.is_primary === 1)) : [];
  const imageUrls = [...new Set([clearance.customs_clearance_pic_url, local?.pic_url, ...pictures.map((entry) => entry.pic_url), fba?.image].map(webUrl).filter(Boolean))];
  for (const key of ['englishName', 'chineseName', ...(includeLegacyPrice ? ['unitPrice', 'currency'] : []), 'material', 'hsCode', 'use', 'brand', 'model', 'unit', 'salesLink']) if (!data[key]) issues.push(`领星未提供可采用的 ${key}，仍需补充。`);
  if (!imageUrls.length) issues.push('领星未提供可采用的图片链接，仍需补充图片。');
  return { data, imageUrls, issues };
}

/** Listing search is exact on sid + seller_sku; the remaining identity must also agree. */
export function matchLingxingListingProduct(identity: Pick<LingxingProductIdentity, 'sid' | 'msku' | 'fnsku' | 'sku'>, candidate: unknown): boolean {
  const value = row(candidate);
  return Boolean(value && id(identity.sid) && id(value.sid) === identity.sid
    && text(identity.msku) && text(value.seller_sku) === text(identity.msku)
    && text(identity.fnsku) && text(value.fnsku) === text(identity.fnsku)
    && text(identity.sku) && text(value.local_sku) === text(identity.sku)
    && Number(value.is_delete ?? 0) === 0);
}

/** Current invoices use the regular Listing price and a separate standard carton size. */
export function mapLingxingInvoiceProduct(identity: LingxingProductIdentity, fbaProduct: unknown, localDetail: unknown, listing: unknown): LingxingMappedProduct {
  const mapped = mapLingxingProduct(identity, fbaProduct, localDetail, false);
  Object.assign(mapped.data, { salesPrice: null, unitPrice: null, currency: null, cartonQuantity: null, unitPriceConfirmed: false, _salesPriceObservationVersion: 'raw/v1' });
  const candidate = row(listing);
  if (candidate && matchLingxingListingProduct(identity, candidate)) {
    const amount = typeof candidate.price === 'number' && Number.isFinite(candidate.price) ? String(candidate.price) : text(candidate.price);
    const code = currency(candidate.currency_code), calculated = calculateInvoiceUnitPrice(amount);
    Object.assign(mapped.data, { salesPrice: amount || null, currency: code || text(candidate.currency_code) || null, unitPrice: calculated });
    if (calculated && code) Object.assign(mapped.data, { salesPrice: amount, unitPrice: calculated, currency: code, unitPriceConfirmed: true,
      unitPriceSource: 'listing.price', unitPriceKind: 'sales-price-20-percent', unitPriceSourceLabel: '领星售价 × 20%' });
    else mapped.issues.push('LISTING_PRICE_INVALID');
  } else mapped.issues.push(candidate ? 'LISTING_PRODUCT_IDENTITY_MISMATCH' : 'LISTING_PRICE_UNAVAILABLE');
  const fba = matchLingxingFbaProduct(identity, fbaProduct) ? row(fbaProduct) : null, local = row(localDetail);
  const matchesLocal = local && text(identity.sku) && text(local.sku) === text(identity.sku)
    && (!fba || id(fba.product_id) === null || id(local.id) === id(fba.product_id));
  const carton = matchesLocal ? (typeof local.cg_box_pcs === 'number' && Number.isFinite(local.cg_box_pcs) ? String(local.cg_box_pcs) : text(local.cg_box_pcs)) : '';
  if (/^\d+$/.test(carton) && BigInt(carton) > 0n && BigInt(carton) <= BigInt(Number.MAX_SAFE_INTEGER)) mapped.data.cartonQuantity = BigInt(carton).toString();
  else mapped.issues.push('CARTON_QUANTITY_UNAVAILABLE');
  return mapped;
}

/** Stock subjects are names/IDs only, not an invoice party or a VAT profile. */
export function mapLingxingStockSubjects(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.map(row).filter((entry): entry is Row => entry !== null && Number(entry.status) === 1
    && ['PLATFORM', 'TEAM'].includes(text(entry.subjectType)) && /^\d+$/.test(text(entry.subjectId)) && Boolean(text(entry.subjectName)))
    .map((entry) => ({ companyId: text(entry.companyId), subjectType: text(entry.subjectType), subjectId: text(entry.subjectId),
      subjectName: text(entry.subjectName), remark: text(entry.remark), source: 'lingxing-stock-subject', requiresPartyConfirmation: true }));
}
