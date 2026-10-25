import { describe, expect, it } from 'vitest';
import { lingxingLogisticsCountry, mapLingxingProduct, mapLingxingInvoiceProduct, mapLingxingStockSubjects, matchLingxingFbaProduct, matchLingxingListingProduct } from './lingxing-mapping.js';

const identity = { sid: 17, msku: 'MSKU-1', fnsku: 'FNSKU-1', sku: 'SKU-1', country: '美国' };
const fba = { ...identity, product_id: 31, asin: 'ASIN-TECH', asin_url: 'https://example.invalid/product', image: 'https://m.media-amazon.com/fba.jpg' };
const local = () => ({
  id: 31, sku: 'SKU-1', bg_customs_import_name: 'Travel bag', bg_customs_export_name: '旅行包', brand_name: 'TECH-BRAND',
  model: 'M-31', unit: '个', currency: 'CNY', cg_price: '999.99', bg_import_hs_code: '4202920000', bg_export_hs_code: '4202920000',
  bg_customs_import_price: '8.88', pic_url: 'https://images.example.com/main.jpg',
  picture_list: [{ pic_url: 'https://images.example.com/main.jpg', is_primary: 1 }], special_attr: ['1', '6'],
  declaration: { customs_declaration_unit: 'PCS', customs_import_price: '3.22', customs_import_price_currency: 'CNY' },
  clearance: { customs_clearance_material: '涤纶', customs_clearance_en_material: 'Polyester', customs_clearance_usage: 'Storage',
    customs_clearance_product_pattern: 'Model 31', customs_clearance_price: '5.00', customs_clearance_price_currency: 'USD',
    customs_clearance_hs_code: '4202920000', customs_clearance_pic_url: 'https://images.example.com/clearance.jpg' },
  product_logistics_relation: [{ US_clearance_price: '12.340000', US_clearance_price_currency: 'USD', US_bg_import_hs_code: '4202924000',
    UK_clearance_price: '9.00', UK_clearance_price_currency: 'GBP', UK_bg_import_hs_code: '4202929000' }],
});

describe('current invoice sales price and standard carton mapping', () => {
  const listing = () => ({ sid: 17, seller_sku: 'MSKU-1', fnsku: 'FNSKU-1', local_sku: 'SKU-1', price: '12.375', listing_price: '1', list_price: '99', currency_code: 'USD', is_delete: 0 });
  it('uses regular selling price times twenty percent with half-up rounding, independent of clearance and discount prices', () => {
    const mapped = mapLingxingInvoiceProduct(identity, fba, { ...local(), cg_box_pcs: 480 }, listing());
    expect(mapped.data).toMatchObject({ salesPrice: '12.375', unitPrice: '2.48', currency: 'USD', cartonQuantity: '480', unitPriceConfirmed: true, unitPriceSource: 'listing.price', englishName: 'Travel bag' });
    expect(mapped.data).not.toHaveProperty('priceCandidates');
    expect(mapped.issues).toEqual([]);
  });
  it('requires every listing identity field and rejects deleted records', () => {
    for (const override of [{ sid: 18 }, { seller_sku: 'other' }, { fnsku: 'other' }, { local_sku: 'other' }, { fnsku: '' }, { is_delete: 1 }]) {
      expect(matchLingxingListingProduct(identity, { ...listing(), ...override })).toBe(false);
      expect(mapLingxingInvoiceProduct(identity, fba, local(), { ...listing(), ...override }).data).toMatchObject({ salesPrice: null, unitPrice: null, currency: null });
    }
  });
  it('preserves raw observations without falling back to declaration prices when sales price or currency is unavailable', () => {
    for (const override of [{ price: '' }, { price: '0' }, { price: '-1' }, { price: '1e3' }, { price: '0.001' }, { currency_code: '' }]) {
      const mapped = mapLingxingInvoiceProduct(identity, fba, { ...local(), cg_box_pcs: 0 }, { ...listing(), ...override });
      expect(mapped.data).toMatchObject({ salesPrice: ('price' in override ? override.price : listing().price) || null, currency: ('currency_code' in override ? override.currency_code : 'USD') || null, cartonQuantity: null, _salesPriceObservationVersion: 'raw/v1' });
      expect(mapped.data.unitPrice).toBe('currency_code' in override ? '2.48' : null);
      expect(mapped.issues).toContain('LISTING_PRICE_INVALID');
    }
  });
  it('keeps valid sales price when local details fail, and never takes carton size from a different product', () => {
    expect(mapLingxingInvoiceProduct(identity, null, null, listing()).data).toMatchObject({ unitPrice: '2.48', cartonQuantity: null });
    for (const override of [{ sku: 'other' }, { id: 32 }, { cg_box_pcs: '12.5' }, { cg_box_pcs: '9007199254740992' }]) {
      expect(mapLingxingInvoiceProduct(identity, fba, { ...local(), cg_box_pcs: '480', ...override }, listing()).data.cartonQuantity).toBeNull();
    }
  });
});

describe('Lingxing declaration candidate mapping', () => {
  it('filters fuzzy search results by the complete case-sensitive identity', () => {
    expect(matchLingxingFbaProduct(identity, fba)).toBe(true);
    for (const key of ['sid', 'msku', 'fnsku', 'sku'] as const) expect(matchLingxingFbaProduct(identity, { ...fba, [key]: key === 'sid' ? 18 : `${fba[key]}-other` })).toBe(false);
    expect(matchLingxingFbaProduct(identity, { ...fba, msku: 'msku-1' })).toBe(false);
    expect(matchLingxingFbaProduct({ ...identity, fnsku: '' }, { ...fba, fnsku: '' })).toBe(false);
    expect(matchLingxingFbaProduct(identity, null)).toBe(false);
  });

  it('prioritizes country clearance pairs and retains distinct price provenance without confirming', () => {
    const mapped = mapLingxingProduct(identity, fba, local());
    expect(mapped.data).toMatchObject({ sid: identity.sid, msku: identity.msku, fnsku: identity.fnsku, sku: identity.sku, unitPrice: '12.34', currency: 'USD', unitPriceConfirmed: false,
      unitPriceSource: 'product_logistics_relation.US_clearance_price', unitPriceKind: 'country-clearance',
      englishName: 'Travel bag', chineseName: '旅行包', material: 'Polyester', use: 'Storage', brand: 'TECH-BRAND', model: 'Model 31',
      unit: 'PCS', hsCode: '4202924000', battery: '是', magnetic: '是', salesLink: fba.asin_url, lingxingProductId: 31,
    });
    expect(mapped.data.priceCandidates).toEqual([
      { source: 'product_logistics_relation.US_clearance_price', kind: 'country-clearance', unitPrice: '12.34', currency: 'USD' },
      { source: 'clearance.customs_clearance_price', kind: 'default-clearance', unitPrice: '5', currency: 'USD' },
      { source: 'declaration.customs_import_price', kind: 'declaration', unitPrice: '3.22', currency: 'CNY' },
      { source: 'bg_customs_import_price', kind: 'legacy-declaration', unitPrice: '8.88', currency: '' },
    ]);
    expect(mapped.imageUrls).toEqual(['https://images.example.com/clearance.jpg', 'https://images.example.com/main.jpg', fba.image]);
    expect(mapped.data).not.toHaveProperty('liquid'); expect(mapped.data).not.toHaveProperty('dangerous');
    expect(mapped.issues).toEqual([]);
  });

  it('uses UK logistics keys for GB and never selects another country price or HS code', () => {
    expect(lingxingLogisticsCountry('GB')).toBe('UK'); expect(lingxingLogisticsCountry('英国')).toBe('UK');
    const uk = mapLingxingProduct({ ...identity, country: 'GB' }, fba, local());
    expect(uk.data).toMatchObject({ unitPrice: '9', currency: 'GBP', hsCode: '4202929000', unitPriceSource: 'product_logistics_relation.UK_clearance_price' });
    const product = local(); product.clearance.customs_clearance_hs_code = '';
    const ca = mapLingxingProduct({ ...identity, country: '加拿大' }, fba, product);
    expect(ca.data).toMatchObject({ unitPrice: '5', currency: 'USD', unitPriceSource: 'clearance.customs_clearance_price' });
    expect(ca.data).not.toHaveProperty('hsCode');
  });

  it('never pairs an incomplete country amount with default/procurement currency', () => {
    const product = local(); product.product_logistics_relation[0]!.US_clearance_price_currency = '';
    const mapped = mapLingxingProduct(identity, fba, product);
    expect(mapped.data).toMatchObject({ unitPrice: '5', currency: 'USD', unitPriceKind: 'default-clearance' });
    expect(mapped.issues.some((issue) => issue.includes('US_clearance_price'))).toBe(true);
    product.clearance.customs_clearance_price_currency = ''; product.declaration.customs_import_price_currency = '';
    const noPair = mapLingxingProduct(identity, fba, product);
    expect(noPair.data).not.toHaveProperty('unitPrice'); expect(noPair.data).not.toHaveProperty('currency');
    expect(noPair.data.unitPriceConfirmed).toBe(false);
  });

  it('does not silently round prices, accept placeholders, use purchase cost or infer negative flags', () => {
    const mapped = mapLingxingProduct(identity, { ...fba, asin_url: 'javascript:alert(1)', image: 'data:image/png;base64,abc' }, {
      id: 31, sku: 'SKU-1', bg_customs_import_name: null, bg_customs_export_name: ' &nbsp; ', brand_name: {}, cg_price: '12', currency: 'CNY',
      bg_import_hs_code: 'bad-code', special_attr: [], picture_list: [{ pic_url: '/relative.jpg' }],
      clearance: { customs_clearance_price: '1.234', customs_clearance_price_currency: 'USD' },
      declaration: { customs_import_price: '-1', customs_import_price_currency: 'USD' },
    });
    for (const key of ['unitPrice', 'currency', 'englishName', 'chineseName', 'brand', 'hsCode', 'salesLink', 'battery', 'magnetic', 'liquid', 'powder', 'dangerous']) expect(mapped.data).not.toHaveProperty(key);
    expect(mapped.imageUrls).toEqual([]); expect(mapped.data.unitPriceConfirmed).toBe(false);
    expect(mapped.issues.length).toBeGreaterThan(0);
  });

  it('rejects cross-store FBA data and cross-product local details', () => {
    const result = mapLingxingProduct(identity, { ...fba, sid: 999 }, { ...local(), sku: 'SKU-other' });
    expect(result.data).toEqual({ sid: 17, msku: 'MSKU-1', fnsku: 'FNSKU-1', sku: 'SKU-1', unitPriceConfirmed: false, lingxingCountry: 'US' });
    expect(result.imageUrls).toEqual([]);
    expect(result.issues.some((issue) => issue.includes('FBA 商品'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('本地产品 SKU'))).toBe(true);
    const idMismatch = mapLingxingProduct(identity, fba, { ...local(), id: 32 });
    expect(idMismatch.data).not.toHaveProperty('englishName'); expect(idMismatch.imageUrls).toEqual([fba.image]);
  });

  it('leaves conflicting country prices and HS codes unresolved instead of selecting a default', () => {
    const product = local();
    product.product_logistics_relation.push({ ...product.product_logistics_relation[0]!, US_clearance_price: '21.00', US_bg_import_hs_code: '4202926000' });
    const mapped = mapLingxingProduct(identity, fba, product);
    expect(mapped.data).not.toHaveProperty('unitPrice'); expect(mapped.data).not.toHaveProperty('currency'); expect(mapped.data).not.toHaveProperty('hsCode');
    expect(mapped.data.priceCandidates).toBeInstanceOf(Array);
    expect(mapped.issues.some((issue) => issue.includes('不同清关价格'))).toBe(true);
  });

  it('treats subject names as candidates and preserves 64-bit IDs as strings', () => {
    const subjects = mapLingxingStockSubjects([
      { companyId: '100001', subjectId: '2031234567890123456', subjectName: '备货主体', subjectType: 'PLATFORM', status: 1, remark: null },
      { subjectId: '2031234567890123457', subjectName: '停用主体', subjectType: 'TEAM', status: 0 },
      { subjectId: Number('2031234567890123456'), subjectName: '不安全数值 ID', subjectType: 'PLATFORM', status: 1 },
    ]);
    expect(subjects).toEqual([{ companyId: '100001', subjectId: '2031234567890123456', subjectName: '备货主体', subjectType: 'PLATFORM', remark: '', source: 'lingxing-stock-subject', requiresPartyConfirmation: true }]);
    expect(subjects[0]).not.toHaveProperty('vat'); expect(subjects[0]).not.toHaveProperty('addressLine1');
  });
});
