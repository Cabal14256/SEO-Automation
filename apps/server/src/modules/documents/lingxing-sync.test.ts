import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentLingxingPreview, DocumentRevisionData } from '@scm/contracts';
import { LingxingReadError, type LingxingReadMetadata } from '../lingxing/read-client.js';
import { BatchError } from '../batches/service.js';
import { documentDigest } from './domain.js';

const mocks = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn(), actor: vi.fn(), locked: vi.fn(), operation: vi.fn(), append: vi.fn(), write: vi.fn(), checked: vi.fn(), createClient: vi.fn(), connect: vi.fn(), query: vi.fn(), release: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { select: mocks.select, transaction: mocks.transaction }, pool: { connect: mocks.connect } }));
vi.mock('../lingxing/read-client.js', async (original) => ({ ...await original<typeof import('../lingxing/read-client.js')>(), createLingxingReadClient: mocks.createClient }));
vi.mock('../batches/service.js', async (original) => ({ ...await original<typeof import('../batches/service.js')>(), requireBatchActor: mocks.actor }));
vi.mock('../batches/report-service.js', () => ({ publishReportFile: vi.fn() }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: mocks.checked }));
vi.mock('./service.js', () => ({ lockedDocument: mocks.locked, documentOperation: mocks.operation, appendDocumentRevisionInTx: mocks.append, writeDocumentProfileInTx: mocks.write }));
import { aggregateLingxingFields, applyDocumentLingxing, assertLingxingPreviewScope, collectLingxingDocumentPreview, documentLingxingProducts, documentLingxingSourceFacts, mergeLingxingProduct, previewDocumentLingxing, sameLingxingProduct } from './lingxing-sync.js';

const identity = { sid: 12, msku: 'M', fnsku: 'F', sku: 'S' };
const suggestion = (data: Record<string, unknown> = {}, ids = identity): DocumentLingxingPreview['products'][number] => ({ ...ids, data: { ...ids, ...data }, imageUrls: [], issues: [] });
function revision(identities = [identity]): DocumentRevisionData {
  return { purpose: 'invoice', weekStartDate: '2026-10-19', title: 'Test invoice', fields: {}, profileReferences: [], templateReference: null,
    members: identities.map((product) => ({ demand: { id: randomUUID(), snapshot: { sid: product.sid, country: '美国', destinationFc: 'IND9', channel: 'HY' } },
      shipment: { id: randomUUID(), data: { items: [product], boxes: [{ id: randomUUID(), order: 1, items: [{ ...product, quantity: '1' }] }] } }, codes: [], sourceCandidates: { products: [], addresses: [], issues: [] } })) } as unknown as DocumentRevisionData;
}
const metadata = (operation = 'getFbaProducts'): LingxingReadMetadata => ({ operation, method: 'POST', path: '/erp/sc/routing/fba/shipment/getFbaProductList', httpStatus: 200, businessCode: '0', attempt: 1, elapsedMs: 1, requestedAt: '2026-10-20T00:00:00.000Z', readOnly: true } as LingxingReadMetadata);
const response = (data: unknown, total?: number) => ({ payload: { code: '0', data, ...(total !== undefined ? { total } : {}) }, metadata: metadata() });
function client() {
  return { getListings: vi.fn().mockResolvedValue(response([])), getFbaProducts: vi.fn().mockResolvedValue(response([])), getLocalProductDetail: vi.fn().mockImplementation(({ sku }) => Promise.resolve(response({ id: 1, sku }))), listStockSubjects: vi.fn().mockResolvedValue(response([])) };
}
function query(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), { from: () => result, where: () => result, for: () => result, limit: () => result });
  return result;
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.transaction.mockImplementation(async (action) => action({ select: mocks.select }));
  mocks.actor.mockResolvedValue({});
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.query.mockResolvedValue({ rows: [{ locked: true }] });
  mocks.operation.mockImplementation(async (_actor, _operation, _action, _input, execute) => ({ ...await execute({ select: mocks.select }), replayed: false }));
});

describe('Lingxing invoice candidates preserve full identity and review semantics', () => {
  it('deduplicates full identities across shipments while retaining distinct stores and MSKUs', () => {
    const data = revision([identity, identity, { ...identity, sid: 13 }, { ...identity, msku: 'M2' }]);
    expect(documentLingxingProducts(data)).toHaveLength(3);
    expect(sameLingxingProduct(identity, { ...identity, msku: 'M2' })).toBe(false);
    expect(sameLingxingProduct(identity, { ...identity, sid: '12' })).toBe(true);
    expect(() => mergeLingxingProduct({ ...identity, sid: 13 }, suggestion({ englishName: 'Lamp' }), false)).toThrow('完整商品身份');
  });
  it('fills only empty declaration values and preserves complete manually confirmed pairs', () => {
    const existing = { ...identity, englishName: 'Manual name', unitPrice: '10', currency: 'USD', unitPriceConfirmed: true, material: '', provenance: 'manual' };
    expect(mergeLingxingProduct(existing, suggestion({ englishName: 'Remote name', unitPrice: '2', currency: 'EUR', material: 'Metal', taxMode: '包税' }), false)).toMatchObject({ ...existing, material: 'Metal' });
    expect(mergeLingxingProduct(existing, suggestion({ taxMode: '包税' }), false)).not.toHaveProperty('taxMode');
    expect(mergeLingxingProduct(existing, suggestion({ unitPrice: '2', currency: 'EUR', unitPriceSourceLabel: '领星默认清关价' }), false)).not.toHaveProperty('unitPriceSourceLabel');
    expect(existing.material).toBe('');
  });
  it('requires explicit confirmation of the exact valid candidate pair and resets incomplete old confirmation', () => {
    const candidate = suggestion({ unitPrice: '2', currency: 'USD', unitPriceSourceLabel: '领星默认清关价' });
    expect(mergeLingxingProduct({}, candidate, false)).toMatchObject({ unitPrice: '2', currency: 'USD', unitPriceConfirmed: false, unitPriceSourceLabel: '领星默认清关价' });
    expect(mergeLingxingProduct({}, candidate, true).unitPriceConfirmed).toBe(true);
    expect(mergeLingxingProduct({ ...identity, unitPrice: '100', unitPriceConfirmed: true }, candidate, false)).toMatchObject({ unitPrice: '100', currency: 'USD', unitPriceConfirmed: false });
    expect(mergeLingxingProduct({ ...identity, unitPrice: '100', unitPriceConfirmed: true }, candidate, true).unitPriceConfirmed).toBe(false);
    expect(mergeLingxingProduct({}, suggestion({ unitPrice: '0', currency: 'USD' }), true).unitPriceConfirmed).toBe(false);
    expect(mergeLingxingProduct({}, suggestion({ unitPrice: '2', currency: 'CNY' }), true).unitPriceConfirmed).toBe(false);
  });
  it('never converts unknown product flags or currencies to negative/default header values', () => {
    expect(aggregateLingxingFields([suggestion({ battery: '否', currency: 'USD' }), suggestion({})])).toEqual({});
    expect(aggregateLingxingFields([suggestion({ battery: '是' }), suggestion({})])).toEqual({ battery: '是' });
    expect(aggregateLingxingFields([suggestion({ liquid: false, currency: 'USD' }), suggestion({ liquid: '否', currency: 'USD' })])).toEqual({ liquid: '否', currency: 'USD' });
  });
});

describe('bounded independent Lingxing product queries', () => {
  it('batches exact listing reads by store in groups of ten and adopts price independently of local permission', async () => {
    const connection = client(), identities = Array.from({ length: 12 }, (_, index) => ({ ...identity, sid: index === 11 ? 13 : 12, msku: `M${index}`, fnsku: `F${index}`, sku: `S${index}` }));
    connection.getListings.mockImplementation(({ sid, search_value }) => Promise.resolve(response(identities.filter((entry) => String(entry.sid) === sid && search_value.includes(entry.msku)).map((entry) => ({ sid: entry.sid, seller_sku: entry.msku, fnsku: entry.fnsku, local_sku: entry.sku, price: '12.375', currency_code: 'USD' })))));
    connection.getLocalProductDetail.mockRejectedValue(new LingxingReadError('LINGXING_READ_FAILED', 'denied', { ...metadata('getLocalProductDetail'), businessCode: '403' }));
    const result = await collectLingxingDocumentPreview(revision(identities), connection);
    expect(connection.getListings.mock.calls.map(([params]) => [params.sid, params.search_value.length, params.exact_search, params.search_field])).toEqual([['12', 10, 1, 'seller_sku'], ['12', 1, 1, 'seller_sku'], ['13', 1, 1, 'seller_sku']]);
    expect(result.products.every((product) => product.data.unitPrice === '2.48' && product.data.cartonQuantity === null)).toBe(true);
  });
  it('rejects listing identity mismatches and duplicate sid/MSKU rows', async () => {
    const connection = client(), listing = { sid: 12, seller_sku: 'M', fnsku: 'F', local_sku: 'S', price: '15', currency_code: 'USD' };
    for (const rows of [[{ ...listing, local_sku: 'wrong' }], [{ ...listing, sid: 13 }], [listing, { ...listing, fnsku: 'another' }]]) {
      connection.getListings.mockResolvedValue(response(rows));
      const result = await collectLingxingDocumentPreview(revision(), connection);
      expect(result.products[0]!.data).toMatchObject({ salesPrice: null, unitPrice: null, currency: null });
    }
  });
  it('rejects repeated, incomplete or changing listing pages without retaining a superficially matching price', async () => {
    const connection = client(), listing = { sid: 12, seller_sku: 'M', fnsku: 'F', local_sku: 'S', price: '15', currency_code: 'USD' };
    connection.getListings.mockResolvedValue(response([listing, ...Array.from({ length: 99 }, (_, index) => ({ ...listing, seller_sku: `OTHER-${index}` }))], 300));
    const repeated = await collectLingxingDocumentPreview(revision(), connection);
    expect(connection.getListings).toHaveBeenCalledTimes(2); expect(repeated.products[0]!.data.unitPrice).toBeNull();
    expect(repeated.products[0]!.issues).toContain('LISTING_SEARCH_INCOMPLETE');
    connection.getListings.mockReset().mockImplementation(({ offset }) => Promise.resolve(response(Array.from({ length: 100 }, (_, index) => ({ ...listing, seller_sku: offset === 0 && index === 0 ? 'M' : `${offset}-${index}` })), offset === 0 ? 300 : 301)));
    const changed = await collectLingxingDocumentPreview(revision(), connection);
    expect(changed.products[0]!.data.unitPrice).toBeNull(); expect(changed.products[0]!.issues).toContain('LISTING_SEARCH_INCOMPLETE');
  });
  it('stops repeating denied listing reads while preserving independent product details and carton size', async () => {
    const connection = client(), identities = Array.from({ length: 11 }, (_, index) => ({ ...identity, msku: `M${index}` }));
    connection.getListings.mockRejectedValue(new LingxingReadError('LINGXING_READ_FAILED', 'denied', { ...metadata('getListings'), businessCode: '403' }));
    connection.getLocalProductDetail.mockResolvedValue(response({ sku: 'S', cg_box_pcs: 480 }));
    const result = await collectLingxingDocumentPreview(revision(identities), connection);
    expect(connection.getListings).toHaveBeenCalledOnce(); expect(result.products.every((product) => product.data.unitPrice === null && product.data.cartonQuantity === '480')).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ permission: '查询亚马逊 Listing', code: 'LINGXING_PERMISSION_REQUIRED' })]));
  });
  it('never sends a two-hundred-and-first business request and rejects any unfinished product page set', async () => {
    const connection = client(), identities = Array.from({ length: 50 }, (_, index) => ({ ...identity, msku: `M${index}`, fnsku: `F${index}`, sku: `S${index}` }));
    connection.getFbaProducts.mockImplementation(({ search_value, offset }) => {
      const product = identities.find((entry) => entry.msku === search_value)!;
      return Promise.resolve(response(Array.from({ length: 100 }, (_, index) => ({ ...product, msku: offset === 0 && index === 0 ? search_value : `${search_value}-OTHER-${offset}-${index}` })), 500));
    });
    const result = await collectLingxingDocumentPreview(revision(identities), connection);
    const calls = connection.getListings.mock.calls.length + connection.getFbaProducts.mock.calls.length + connection.getLocalProductDetail.mock.calls.length + connection.listStockSubjects.mock.calls.length;
    expect(calls).toBe(200); expect(result.requests).toHaveLength(200);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LINGXING_QUERY_BUDGET' })]));
    expect(result.products.at(-1)!.issues).toContain('LINGXING_QUERY_BUDGET');
  });
  it('continues FBA candidates when local permission is denied and stops repeating that denied endpoint', async () => {
    const connection = client(), second = { ...identity, msku: 'M2', fnsku: 'F2', sku: 'S2' };
    connection.getFbaProducts.mockImplementation(({ search_value }) => Promise.resolve(response([{ ...(search_value === 'M' ? identity : second), asin_url: `https://amazon.com/dp/${search_value}` }], 1)));
    connection.getLocalProductDetail.mockRejectedValue(new LingxingReadError('LINGXING_READ_FAILED', 'denied', { ...metadata('getLocalProductDetail'), businessCode: '403' }));
    connection.listStockSubjects.mockRejectedValue(new LingxingReadError('LINGXING_READ_FAILED', 'denied', { ...metadata('listStockSubjects'), businessCode: '403' }));
    const result = await collectLingxingDocumentPreview(revision([identity, second]), connection);
    expect(connection.getFbaProducts).toHaveBeenCalledTimes(2); expect(connection.getLocalProductDetail).toHaveBeenCalledTimes(1);
    expect(result.products.map((product) => product.data.salesLink)).toEqual(['https://amazon.com/dp/M', 'https://amazon.com/dp/M2']);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LINGXING_PERMISSION_REQUIRED', permission: '查询本地产品详情' }), expect.objectContaining({ code: 'LINGXING_PERMISSION_REQUIRED', permission: '主体列表查询' })]));
    expect(result.fields).not.toHaveProperty('battery');
  });
  it('discards fuzzy results with a different store or MSKU and rejects a malformed page', async () => {
    const connection = client();
    connection.getFbaProducts.mockResolvedValueOnce(response([{ ...identity, sid: 13, asin_url: 'https://wrong.example/product' }], 1));
    expect((await collectLingxingDocumentPreview(revision(), connection)).products[0]!.data).not.toHaveProperty('salesLink');
    connection.getFbaProducts.mockResolvedValueOnce(response([{ ...identity, asin_url: 'https://wrong.example/product' }, null], 2));
    const malformed = await collectLingxingDocumentPreview(revision(), connection);
    expect(malformed.products[0]!.data).not.toHaveProperty('salesLink');
    expect(malformed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LINGXING_INVALID_RESPONSE' })]));
  });
  it('does not adopt a superficially unique match from repeated or capped incomplete fuzzy pages', async () => {
    const connection = client(), row = { ...identity, asin_url: 'https://wrong.example/product' };
    connection.getFbaProducts.mockResolvedValue(response([row, ...Array.from({ length: 99 }, (_, index) => ({ ...identity, msku: `OTHER-${index}` }))], 1000));
    const repeated = await collectLingxingDocumentPreview(revision(), connection);
    expect(connection.getFbaProducts).toHaveBeenCalledTimes(2); expect(repeated.products[0]!.data).not.toHaveProperty('salesLink');
    connection.getFbaProducts.mockReset().mockImplementation(({ offset }) => Promise.resolve(response([...(offset === 0 ? [row] : [{ ...identity, msku: `NOT-M-${offset}` }]), ...Array.from({ length: 99 }, (_, index) => ({ ...identity, msku: `${offset}-${index}` }))], 1000)));
    const capped = await collectLingxingDocumentPreview(revision(), connection);
    expect(connection.getFbaProducts).toHaveBeenCalledTimes(5); expect(capped.products[0]!.data).not.toHaveProperty('salesLink');
    expect(capped.products[0]!.issues).toContain('FBA_PRODUCT_SEARCH_INCOMPLETE');
  });
  it('rejects changing totals across fuzzy pages before adopting any matching row', async () => {
    const connection = client();
    connection.getFbaProducts.mockImplementation(({ offset }) => Promise.resolve(response(Array.from({ length: 100 }, (_, index) => ({ ...identity, msku: offset === 0 && index === 0 ? 'M' : `${offset}-${index}` })), offset === 0 ? 300 : 301)));
    const result = await collectLingxingDocumentPreview(revision(), connection);
    expect(result.products[0]!.issues).toContain('FBA_PRODUCT_SEARCH_INCOMPLETE');
  });
  it('keeps failed image downloads missing and caps assigned image bytes even when URLs are shared', async () => {
    const connection = client(), download = vi.fn().mockRejectedValue(new Error('private image address'));
    connection.getFbaProducts.mockResolvedValue(response([{ ...identity, image: 'https://images.example/product.png' }], 1));
    const failed = await collectLingxingDocumentPreview(revision(), connection, [], download);
    expect(failed.products[0]!.data).not.toHaveProperty('imageBase64'); expect(failed.products[0]!.issues).toContain('PRODUCT_IMAGE_DOWNLOAD_FAILED');
    const identities = Array.from({ length: 5 }, (_, index) => ({ ...identity, msku: `M${index}`, fnsku: `F${index}`, sku: `S${index}` }));
    connection.getFbaProducts.mockImplementation(({ search_value }) => Promise.resolve(response([{ ...identities.find((entry) => entry.msku === search_value), image: 'https://images.example/shared.png' }], 1)));
    download.mockResolvedValue({ imageBase64: Buffer.alloc(2 * 1024 * 1024).toString('base64'), imageExtension: 'png' });
    const bounded = await collectLingxingDocumentPreview(revision(identities), connection, [], download);
    expect(bounded.products.filter((product) => product.data.imageBase64)).toHaveLength(4);
    expect(bounded.products[4]!.issues).toContain('PRODUCT_IMAGE_BUDGET'); expect(download).toHaveBeenCalledTimes(2);
  });
  it('removes resolved missing-link/image warnings after adopting matching source snapshot fallbacks', async () => {
    const connection = client(), data = revision();
    data.members[0]!.sourceCandidates!.products = [{ ...identity, source: 'source snapshot', snapshotId: randomUUID(), asin: null, imageUrl: 'https://images.example/product.png', salesLink: 'https://amazon.com/dp/PRODUCT' }];
    const result = await collectLingxingDocumentPreview(data, connection, [], vi.fn().mockResolvedValue({ imageBase64: 'aGVsbG8=', imageExtension: 'png' }));
    expect(result.products[0]!.data).toMatchObject({ salesLink: 'https://amazon.com/dp/PRODUCT', imageBase64: 'aGVsbG8=' });
    expect(result.products[0]!.issues).not.toContain('领星未提供可采用的 salesLink，仍需补充。');
    expect(result.products[0]!.issues).not.toContain('领星未提供可采用的图片链接，仍需补充图片。');
  });
  it('merges compatible missing address fields and refuses mixing an existing contradictory address', async () => {
    const data = revision(); data.members[0]!.sourceCandidates!.addresses = [
      { source: 'list', snapshotId: randomUUID(), data: { city: 'Greenwood', countryCode: 'US', addressLine1: null } },
      { source: 'detail', snapshotId: randomUUID(), data: { city: 'Greenwood', countryCode: 'US', addressLine1: '1151 S GRAHAM RD' } },
    ];
    const merged = await collectLingxingDocumentPreview(data, null); expect(merged.fields.addressLine1).toBe('1151 S GRAHAM RD');
    data.fields.addressLine1 = 'Other Road';
    const conflict = await collectLingxingDocumentPreview(data, null); expect(conflict.fields).not.toHaveProperty('addressLine1');
    expect(conflict.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DOCUMENT_ADDRESS_CONFLICT' })]));
  });
  it('rejects more than 50 full product identities before starting any remote query', async () => {
    const connection = client();
    await expect(collectLingxingDocumentPreview(revision(Array.from({ length: 51 }, (_, index) => ({ ...identity, msku: `M${index}` }))), connection)).rejects.toThrow('50');
    expect(connection.getFbaProducts).not.toHaveBeenCalled(); expect(connection.listStockSubjects).not.toHaveBeenCalled();
  });
});

describe('saved preview actor/version/scope and replay boundaries', () => {
  const makePreview = (documentId: string, documentVersion = 1): DocumentLingxingPreview => ({ documentId, documentVersion, operationId: randomUUID(), products: [suggestion({ englishName: 'Lamp' })], fields: {}, parties: [], issues: [], sourceFileId: randomUUID() });
  it('rebuilds source facts from sales price rather than supplied declaration price, preserving explicit missing values', () => {
    const preview = makePreview(randomUUID()), provenance = { sourceFileId: preview.sourceFileId, sourceSha256: 'a'.repeat(64), fetchedAt: '2026-10-24T00:00:00.000Z' };
    preview.products = [suggestion({ salesPrice: '12.375', currency: 'USD', unitPrice: '999', cartonQuantity: 480 }), suggestion({ unitPrice: '8', currency: 'USD', cartonQuantity: '0' }, { ...identity, msku: 'M2' })];
    expect(documentLingxingSourceFacts(preview, provenance)).toEqual([
      { ...identity, salesPrice: '12.375', currency: 'USD', unitPrice: '2.48', cartonQuantity: '480', ...provenance },
      { ...identity, msku: 'M2', salesPrice: null, currency: 'USD', unitPrice: null, cartonQuantity: null, ...provenance },
    ]);
  });
  it('retains valid remote amounts independently of missing or conflicting currency so manual fallback cannot hide them', () => {
    const preview = makePreview(randomUUID()), provenance = { sourceFileId: preview.sourceFileId, sourceSha256: 'a'.repeat(64), fetchedAt: '2026-10-24T00:00:00.000Z' };
    preview.products = [suggestion({ salesPrice: '20', currency: null }), suggestion({ salesPrice: '20', currency: 'GBP' }, { ...identity, msku: 'M2' })];
    const facts = documentLingxingSourceFacts(preview, provenance);
    expect(facts[0]).toMatchObject({ salesPrice: '20', unitPrice: '4.00', currency: null }); expect(facts[1]).toMatchObject({ salesPrice: '20', currency: 'GBP' });
  });
  it('replaces old per-invoice facts with missing observations and upgrades rules without price confirmation', async () => {
    const id = randomUUID(), preview = makePreview(id), data = revision(); preview.products = [suggestion({})];
    data.productSourceFacts = [{ ...identity, salesPrice: '100', currency: 'USD', unitPrice: '20.00', cartonQuantity: '480', sourceFileId: randomUUID(), sourceSha256: 'b'.repeat(64), fetchedAt: '2026-10-23T00:00:00.000Z' }];
    data.profileReferences = [{ category: 'channel', profileId: randomUUID(), version: 1, data: {} }];
    data.templateReference = { templateId: randomUUID(), fileId: randomUUID(), version: 1, sha256: 'c'.repeat(64) };
    const source = { id: preview.sourceFileId, sha256: 'a'.repeat(64) }, fetchedAt = '2026-10-24T00:00:00.000Z';
    const archive = { actorId: 'admin', documentId: id, operationId: preview.operationId, revisionDigest: documentDigest(data), fetchedAt,
      suggestions: { products: preview.products, fields: preview.fields, parties: preview.parties, issues: preview.issues } };
    mocks.locked.mockResolvedValue({ record: { version: 1, status: 'draft' }, revision: { data } });
    mocks.select.mockReturnValueOnce(query([])).mockReturnValueOnce(query([])).mockReturnValueOnce(query([{ actorId: 'admin', action: 'document.lingxing.preview', result: { preview } }])).mockReturnValueOnce(query([source])).mockReturnValueOnce(query([]));
    mocks.checked.mockResolvedValue(Buffer.from(JSON.stringify(archive))); mocks.append.mockResolvedValue({});
    await applyDocumentLingxing(id, 'admin', { operationId: randomUUID(), expectedVersion: 1, previewOperationId: preview.operationId, reason: 'Refresh source', confirmPrices: false });
    const saved = mocks.append.mock.calls[0]![3] as DocumentRevisionData;
    expect(saved.generationRulesVersion).toBe('v2');
    expect(saved.productSourceFacts).toEqual([{ ...identity, salesPrice: null, currency: null, unitPrice: null, cartonQuantity: null, sourceFileId: source.id, sourceSha256: source.sha256, fetchedAt }]);
    expect(data.productSourceFacts[0]!.salesPrice).toBe('100'); expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(['retired', 'updated'])('applies only the representative declaration while preserving a hidden %s reference and all source facts', async (state) => {
    const id = randomUUID(), preview = makePreview(id), data = revision(), hidden = { ...identity, msku: 'M2', fnsku: 'F2', sku: 'S2' };
    const items = [{ ...identity, quantity: '1' }, { ...hidden, quantity: '2' }];
    data.members[0]!.shipment.data.items = items as typeof data.members[number]['shipment']['data']['items'];
    data.members[0]!.shipment.data.boxes[0]!.items = items as typeof data.members[number]['shipment']['data']['boxes'][number]['items'];
    const hiddenReference = { category: 'product' as const, profileId: randomUUID(), version: 1, data: { ...hidden, englishName: 'Old hidden product' } };
    data.profileReferences = [{ category: 'channel', profileId: randomUUID(), version: 1, data: {} }, hiddenReference];
    data.templateReference = { templateId: randomUUID(), fileId: randomUUID(), version: 1, sha256: 'c'.repeat(64) };
    preview.products = [suggestion({ englishName: 'Representative', salesPrice: '10', unitPrice: '2.00', currency: 'USD', cartonQuantity: '500' }),
      suggestion({ englishName: 'New hidden product', salesPrice: '15', unitPrice: '3.00', currency: 'USD', cartonQuantity: '300' }, hidden)];
    const source = { id: preview.sourceFileId, sha256: 'a'.repeat(64) }, fetchedAt = '2026-10-24T00:00:00.000Z';
    const archive = { actorId: 'admin', documentId: id, operationId: preview.operationId, revisionDigest: documentDigest(data), fetchedAt,
      suggestions: { products: preview.products, fields: preview.fields, parties: preview.parties, issues: preview.issues } };
    mocks.locked.mockResolvedValue({ record: { version: 1, status: 'draft' }, revision: { data } });
    mocks.select.mockReturnValueOnce(query([])).mockReturnValueOnce(query([])).mockReturnValueOnce(query([{ actorId: 'admin', action: 'document.lingxing.preview', result: { preview } }])).mockReturnValueOnce(query([source]))
      .mockReturnValueOnce(query([{ id: hiddenReference.profileId, category: 'product', key: 'hidden', version: 2, status: state === 'retired' ? 'retired' : 'active', data: { ...hiddenReference.data, englishName: 'Updated hidden product' } }]));
    mocks.checked.mockResolvedValue(Buffer.from(JSON.stringify(archive))); mocks.append.mockResolvedValue({});
    mocks.write.mockImplementation(async (_tx, _actor, input) => ({ id: randomUUID(), version: 1, data: input.data }));
    const result = await applyDocumentLingxing(id, 'admin', { operationId: randomUUID(), expectedVersion: 1, previewOperationId: preview.operationId, reason: 'Refresh source', confirmPrices: false });
    expect(result.appliedProducts).toBe(1); expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls[0]![2].data).toMatchObject({ ...identity, englishName: 'Representative' });
    const saved = mocks.append.mock.calls[0]![3] as DocumentRevisionData;
    expect(saved.productSourceFacts).toHaveLength(2);
    expect(saved.productSourceFacts!.map((fact) => [fact.msku, fact.salesPrice, fact.unitPrice])).toEqual([['M', '10', '2.00'], ['M2', '15', '3.00']]);
    expect(saved.profileReferences.find((reference) => reference.profileId === hiddenReference.profileId)).toEqual(hiddenReference);
  });
  it('rejects stale versions, missing identities and additional products', () => {
    const id = randomUUID(), preview = makePreview(id);
    expect(() => assertLingxingPreviewScope(preview, id, 2, revision())).toThrow('当前单据版本');
    expect(() => assertLingxingPreviewScope({ ...preview, products: [suggestion({}, { ...identity, sid: 13 })] }, id, 1, revision())).toThrow('完整商品身份');
    expect(() => assertLingxingPreviewScope({ ...preview, products: [] }, id, 1, revision())).toThrow('完整商品身份');
  });
  it('replays a saved preview under its session lock without querying Lingxing again', async () => {
    const id = randomUUID(), input = { operationId: randomUUID(), expectedVersion: 1 }, preview = makePreview(id);
    mocks.select.mockReturnValue(query([{ actorId: 'admin', requestHash: documentDigest({ action: 'document.lingxing.preview', input: { id, ...input } }), result: { preview } }]));
    const result = await previewDocumentLingxing(id, 'admin', input);
    expect(result).toMatchObject({ preview, replayed: true }); expect(mocks.createClient).not.toHaveBeenCalled(); expect(mocks.locked).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(2); expect(mocks.release).toHaveBeenCalledWith(false);
  });
  it('rejects an operation owned by another actor before returning or applying its suggestions', async () => {
    const id = randomUUID(), input = { operationId: randomUUID(), expectedVersion: 1 }, preview = makePreview(id);
    mocks.select.mockReturnValue(query([{ actorId: 'other', result: { preview }, action: 'document.lingxing.preview' }]));
    await expect(previewDocumentLingxing(id, 'admin', input)).rejects.toBeInstanceOf(BatchError);
    mocks.locked.mockResolvedValue({ record: { version: 1, status: 'draft' }, revision: { data: revision() } });
    mocks.select.mockReturnValueOnce(query([])).mockReturnValueOnce(query([])).mockReturnValueOnce(query([{ actorId: 'other', action: 'document.lingxing.preview', result: { preview } }]));
    await expect(applyDocumentLingxing(id, 'admin', { ...input, previewOperationId: preview.operationId, reason: 'Review', confirmPrices: false })).rejects.toThrow('当前操作人');
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.checked).not.toHaveBeenCalled();
  });
  it('rejects an old saved preview before reading files or writing profiles', async () => {
    const id = randomUUID(), preview = makePreview(id), input = { operationId: randomUUID(), expectedVersion: 2, previewOperationId: preview.operationId, reason: 'Review', confirmPrices: false };
    mocks.locked.mockResolvedValue({ record: { version: 2, status: 'draft' }, revision: { data: revision() } });
    mocks.select.mockReturnValueOnce(query([])).mockReturnValueOnce(query([])).mockReturnValueOnce(query([{ actorId: 'admin', action: 'document.lingxing.preview', result: { preview } }]));
    await expect(applyDocumentLingxing(id, 'admin', input)).rejects.toThrow('当前单据版本');
    expect(mocks.checked).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.append).not.toHaveBeenCalled();
  });
});
