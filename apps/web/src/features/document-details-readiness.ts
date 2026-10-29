import { DOCUMENT_ADDRESS_FIELDS, DOCUMENT_ADDRESS_REQUIRED_FIELDS, DOCUMENT_FIELD_OPTIONS, DOCUMENT_PRODUCT_FIELDS, DOCUMENT_REQUIRED_FIELDS,
  documentBoxes, documentBoxFieldKey, documentCurrencyForCountry, documentInvoicePrice, documentProductCurrency, hasCompleteDocumentAddress, type DocumentRevisionData } from '@scm/contracts';

export type DetailSection = 'basic' | 'address' | 'products' | 'boxes';
export type DetailIssue = { field: string; message: string };
export type DetailProgress = { section: DetailSection; label: string; issues: DetailIssue[]; pending?: boolean };
export type DetailProduct = { sid: number; msku: string; fnsku: string; sku: string; prefix: string };
const text = (value: unknown) => value === null || value === undefined ? '' : String(value).trim();

export function documentDetailsReadiness({ data, fields, title, templateId, products, profiles, productKeyError, productsLoading }: {
  data: DocumentRevisionData; fields: Record<string, string | null>; title: string; templateId: string;
  products: DetailProduct[]; profiles: DocumentRevisionData['profileReferences']; productKeyError?: string; productsLoading: boolean;
  manualSalesPriceInputs?: Record<string, { salesPrice: string | null; reason: string; enteredCurrency: string }>;
}): DetailProgress[] {
  const sections: Record<DetailSection, DetailIssue[]> = { basic: [], address: [], products: [], boxes: [] };
  const add = (section: DetailSection, field: string, message: string) => { if (!sections[section].some((issue) => issue.field === field)) sections[section].push({ field, message }); };
  if (!title.trim()) add('basic', 'title', '请填写草稿名称');
  if (!templateId) add('basic', 'template', '请选择单据模板');
  if (new Set(data.members.map((member) => documentCurrencyForCountry(member.demand.snapshot.country)).filter(Boolean)).size > 1) add('basic', 'currency', '请按 FBA 所属国家对应的币种拆分出单');
  for (const key of DOCUMENT_REQUIRED_FIELDS) {
    if ((DOCUMENT_ADDRESS_FIELDS as readonly string[]).includes(key)) continue;
    if (!text(fields[key])) add('basic', key, '请补齐必填资料');
  }
  for (const [key, options] of Object.entries(DOCUMENT_FIELD_OPTIONS)) if (fields[key] && !(options as readonly string[]).includes(fields[key]!)) add('basic', key, '请采用有效选项');
  if (/自主|递延/.test(fields.taxMode ?? '') && !text(fields.vat)) add('basic', 'vat', '请填写 VAT');
  for (const key of DOCUMENT_ADDRESS_REQUIRED_FIELDS) if (!text(fields[key])) add('address', key, '请补齐收件地址');
  if (text(fields.countryCode) && !/^[A-Z]{2}$/i.test(text(fields.countryCode))) add('address', 'countryCode', '国家代码须为两个英文字母');
  if (fields.addressConfirmed !== 'true') add('address', 'addressConfirmed', '请确认最终收件地址');
  if (!text(fields.addressConfirmationReason)) add('address', 'addressConfirmationReason', '请填写地址核对依据');
  if (!hasCompleteDocumentAddress(fields) && !sections.address.length) add('address', 'addressConfirmed', '请核对完整地址');
  const v2 = data.generationRulesVersion === 'v2';
  for (const product of products) {
    const profile = profiles.find((reference) => reference.category === 'product' && Number(reference.data.sid) === product.sid && ['msku', 'fnsku', 'sku'].every((key) => text(reference.data[key]) === product[key as 'msku' | 'fnsku' | 'sku']));
    const value = (key: string) => text(fields[product.prefix + key] ?? profile?.data[key]);
    const fixedPrice = documentInvoicePrice({ ...data, fields });
    const price = v2 ? fixedPrice.unitPrice : value('unitPrice');
    const currency = v2 ? fixedPrice.currency : documentProductCurrency(value('currency'), fields.currency);
    for (const key of DOCUMENT_PRODUCT_FIELDS) if ((!v2 || !['unitPrice', 'currency'].includes(key)) && !(key === 'currency' ? currency : value(key))) add('products', product.prefix + key, `${product.msku || product.sku}：请补齐申报资料`);
    if (!/^\d+(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0 || !Number.isFinite(Number(price)) || Number(price) > Number.MAX_SAFE_INTEGER) add('products', product.prefix + 'unitPrice', '请核对有效申报单价');
    if (!(DOCUMENT_FIELD_OPTIONS.currency as readonly string[]).includes(currency) || currency !== fields.currency) add('products', product.prefix + 'currency', '请核对商品与整票币种');
    if (!v2 && value('unitPriceConfirmed') !== 'true') add('products', product.prefix + 'unitPriceConfirmed', '请确认商品单价和币种');
    if (value('salesLink')) try { if (!/^https?:$/.test(new URL(value('salesLink')).protocol)) throw new Error(); } catch { add('products', product.prefix + 'salesLink', '请填写有效销售链接'); }
  }
  if (productKeyError) add('products', 'product-key', productKeyError);
  if (!productsLoading && !products.length && !productKeyError) add('products', 'product-key', '请核对来源商品及箱内清单');
  const boxes = data.members.flatMap((member) => documentBoxes(member, fields));
  if (!boxes.length) add('boxes', 'boxes', '请核对来源箱清单');
  for (const box of boxes) {
    if (!box.po?.trim()) add('boxes', documentBoxFieldKey(box.boxId, 'po'), '请填写 PO / Reference ID');
    for (const key of ['weight', 'length', 'width', 'height'] as const) if (!box.values[key]) add('boxes', documentBoxFieldKey(box.boxId, key), '请补齐有效箱规');
  }
  return [
    { section: 'basic', label: '基础信息', issues: sections.basic },
    { section: 'address', label: '收件地址', issues: sections.address },
    { section: 'products', label: '商品申报', issues: sections.products, pending: productsLoading },
    { section: 'boxes', label: '箱规', issues: sections.boxes },
  ];
}
