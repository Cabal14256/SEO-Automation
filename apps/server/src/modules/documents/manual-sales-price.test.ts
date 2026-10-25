import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateDocumentInvoiceUnitPrice, documentCanManuallySupplySalesPrice, documentCorrectInputSchema, documentEffectiveSalesPrice, documentManualSalesPriceInputSchema, documentRevisionInputSchema,
  type DocumentManualSalesPriceInput, type DocumentRevisionData } from '@scm/contracts';
const mocks = vi.hoisted(() => ({ checked: vi.fn() }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: mocks.checked }));
import { applyDocumentManualSalesPricesInTx } from './manual-sales-price.js';
import type { BatchTx } from '../batches/service.js';

const identity = { sid: 12, msku: 'M1', fnsku: 'F1', sku: 'S1' }, at = '2026-10-25T00:00:00.000Z';
let data: DocumentRevisionData, change: DocumentManualSalesPriceInput, archive: Record<string, unknown>, files: Record<string, unknown>[];
const tx = { select: () => ({ from: () => ({ where: async () => files }) }) } as unknown as BatchTx;
beforeEach(() => {
  vi.clearAllMocks();
  const sourceFileId = randomUUID(), demandId = randomUUID();
  const source = { weekStartDate: '2026-10-19', groupId: randomUUID(), groupVersion: 1, m2ConfirmationId: randomUUID(), demandId, demandVersion: 1, shipmentRevisionId: randomUUID(), physicalConfirmationId: null, m3Version: null, sourceFingerprint: null };
  data = { purpose: 'invoice', weekStartDate: '2026-10-19', title: 'Invoice', generationRulesVersion: 'v2', profileReferences: [], templateReference: null, fields: { currency: 'USD' },
    members: [{ demand: { id: demandId, snapshot: { sid: 12, country: 'US' } }, source, shipment: { data: { items: [identity] } } }],
    productSourceFacts: [{ ...identity, salesPrice: null, currency: null, unitPrice: null, cartonQuantity: null, sourceFileId, sourceSha256: 'a'.repeat(64), fetchedAt: at }] } as unknown as DocumentRevisionData;
  change = { ...identity, salesPrice: '12.375', reason: '已核对真实销售售价' };
  archive = { fetchedAt: at, suggestions: { products: [{ ...identity, data: { salesPrice: null }, imageUrls: [], issues: ['LISTING_PRICE_UNAVAILABLE'] }] } };
  files = [{ id: sourceFileId, sha256: 'a'.repeat(64) }]; mocks.checked.mockImplementation(async () => Buffer.from(JSON.stringify(archive)));
});
describe('authenticated manual selling price fallback', () => {
  it('adds an exact identity and country-currency bound audited fallback while leaving every remote fact unchanged', async () => {
    const original = structuredClone(data), result = await applyDocumentManualSalesPricesInTx(tx, data, 'operator', [change]);
    expect(result.manualSalesPrices).toEqual([{ ...identity, salesPrice: '12.375', currency: 'USD', reason: change.reason, recordedBy: 'operator', recordedAt: expect.any(String), sourceFileId: files[0]!.id, sourceSha256: 'a'.repeat(64), memberSources: [data.members[0]!.source] }]);
    expect(result.productSourceFacts).toEqual(original.productSourceFacts); expect(data).toEqual(original);
    expect(documentEffectiveSalesPrice(result, 12, identity)).toMatchObject({ source: 'manual', salesPrice: '12.375', unitPrice: '2.48', currency: 'USD' });
  });
  it.each(['0', '-2', 'no price', '1e2', '0.01', '0.024', '900719925474099100'])('rejects manual price %s before creating provenance', async (salesPrice) => {
    expect(documentManualSalesPriceInputSchema.safeParse({ ...change, salesPrice }).success).toBe(false);
    await expect(applyDocumentManualSalesPricesInTx(tx, data, 'operator', [{ ...change, salesPrice }])).rejects.toBeTruthy(); expect(data.manualSalesPrices).toBeUndefined(); expect(mocks.checked).not.toHaveBeenCalled();
  });
  it('requires a human reason and disallows client provenance on the revision command', () => {
    expect(documentManualSalesPriceInputSchema.safeParse({ ...change, reason: '' }).success).toBe(false);
    const input = { operationId: randomUUID(), expectedVersion: 1, reason: '补充售价', manualSalesPrices: [change] };
    expect(documentRevisionInputSchema.safeParse(input).success).toBe(true); expect(documentCorrectInputSchema.safeParse({ ...input, demandIds: [data.members[0]!.demand.id] }).success).toBe(true);
    expect(documentRevisionInputSchema.safeParse({ ...input, manualSalesPrices: [{ ...change, recordedBy: 'forged' }] }).success).toBe(false);
    expect(documentManualSalesPriceInputSchema.safeParse({ ...change, fnsku: '' }).success).toBe(true);
  });
  it.each(['sid', 'msku', 'fnsku', 'sku'] as const)('does not apply another %s identity even when the label is similar', async (field) => {
    const incorrect = { ...change, [field]: field === 'sid' ? 99 : 'other' };
    await expect(applyDocumentManualSalesPricesInTx(tx, data, 'operator', [incorrect])).rejects.toMatchObject({ code: 'DOCUMENT_MANUAL_SALES_PRICE_SCOPE' });
  });
  it('refuses duplicate manual commands, absent/duplicate facts, mixed currency, unknown countries and v1', async () => {
    await expect(applyDocumentManualSalesPricesInTx(tx, data, 'operator', [change, change])).rejects.toMatchObject({ code: 'DOCUMENT_MANUAL_SALES_PRICE_DUPLICATE' });
    for (const altered of [ { ...data, productSourceFacts: [] }, { ...data, productSourceFacts: [...data.productSourceFacts!, ...data.productSourceFacts!] }, { ...data, generationRulesVersion: 'v1' as const } ]) {
      await expect(applyDocumentManualSalesPricesInTx(tx, altered, 'operator', [change])).rejects.toMatchObject({ code: 'DOCUMENT_MANUAL_SALES_PRICE_UNAVAILABLE' });
    }
    data.members[0]!.demand.snapshot.country = 'CA'; expect(documentCanManuallySupplySalesPrice(data, 12, identity)).toBe(false);
    data.members[0]!.demand.snapshot.country = 'US'; const other = structuredClone(data.members[0]!); other.demand.snapshot.country = 'GB'; data.members.push(other);
    await expect(applyDocumentManualSalesPricesInTx(tx, data, 'operator', [change])).rejects.toMatchObject({ code: 'DOCUMENT_MANUAL_SALES_PRICE_UNAVAILABLE' });
  });
  it('gives valid remote amount priority even when its currency is invalid or conflicts', async () => {
    const result = await applyDocumentManualSalesPricesInTx(tx, data, 'operator', [change]);
    result.productSourceFacts![0]!.salesPrice = '20'; result.productSourceFacts![0]!.currency = 'GBP';
    expect(documentEffectiveSalesPrice(result, 12, identity)).toMatchObject({ source: 'lingxing', unitPrice: '4.00', currency: 'GBP' });
    expect(documentCanManuallySupplySalesPrice(result, 12, identity)).toBe(false);
    await expect(applyDocumentManualSalesPricesInTx(tx, result, 'operator', [change])).rejects.toMatchObject({ code: 'DOCUMENT_MANUAL_SALES_PRICE_UNAVAILABLE' });
  });
  it('reads the verified archive to prevent a historical null fact hiding a valid remote amount', async () => {
    (archive.suggestions as { products: Array<{ data: Record<string, unknown> }> }).products[0]!.data = { salesPrice: '20', currency: null };
    await expect(applyDocumentManualSalesPricesInTx(tx, data, 'operator', [change])).rejects.toMatchObject({ code: 'DOCUMENT_REMOTE_SALES_PRICE_AVAILABLE' });
  });
  it('lets existing legacy null-price archives be manually supplemented with explicit audit provenance', async () => {
    const product = (archive.suggestions as { products: Array<{ data: Record<string, unknown>; issues: string[] }> }).products[0]!; product.issues = ['LISTING_PRICE_INVALID'];
    const saved = await applyDocumentManualSalesPricesInTx(tx, data, 'operator', [change]);
    expect(saved.manualSalesPrices?.[0]).toMatchObject({ salesPrice: '12.375', reason: change.reason, recordedBy: 'operator', sourceFileId: files[0]!.id });
    expect(documentEffectiveSalesPrice(saved, 12, identity).source).toBe('manual');
  });
  it.each(['missing', 'hash', 'contents', 'identity', 'time'])('refuses a %s archive without fabricating a missing price', async (failure) => {
    if (failure === 'missing') files = [];
    if (failure === 'hash') files[0]!.sha256 = 'b'.repeat(64);
    if (failure === 'contents') mocks.checked.mockRejectedValue(new Error('hash mismatch'));
    if (failure === 'identity') (archive.suggestions as { products: unknown[] }).products = [];
    if (failure === 'time') archive.fetchedAt = '2026-10-24T00:00:00.000Z';
    await expect(applyDocumentManualSalesPricesInTx(tx, data, 'operator', [change])).rejects.toMatchObject({ code: 'DOCUMENT_SOURCE_FILE_INVALID' });
  });
  it('retains fallback across missing-price refresh and correction with identical scope, invalidates changed source/currency and permits explicit clearing', async () => {
    const result = await applyDocumentManualSalesPricesInTx(tx, data, 'operator', [change]), corrected = structuredClone(result);
    corrected.productSourceFacts![0]!.sourceFileId = randomUUID();
    expect(documentEffectiveSalesPrice(corrected, 12, identity).source).toBe('manual');
    corrected.members[0]!.source.demandVersion++;
    expect(documentEffectiveSalesPrice(corrected, 12, identity)).toMatchObject({ source: 'missing', issue: 'DOCUMENT_MANUAL_SALES_PRICE_STALE' });
    const changed = structuredClone(result); changed.members[0]!.demand.snapshot.country = 'GB';
    expect(documentEffectiveSalesPrice(changed, 12, identity)).toMatchObject({ source: 'missing', issue: 'DOCUMENT_MANUAL_SALES_PRICE_STALE' });
    const cleared = await applyDocumentManualSalesPricesInTx(tx, result, 'operator', [{ ...change, salesPrice: null, reason: '撤回补充售价' }]);
    expect(cleared.manualSalesPrices).toEqual([]); expect(result.manualSalesPrices).toHaveLength(1); expect(cleared.productSourceFacts).toEqual(result.productSourceFacts);
  });
  it.each([['0.025', '0.01'], ['12.375', '2.48'], ['9.99', '2.00'], ['20.00', '4.00']])('shares exact rounding for %s → %s', (price, expected) => expect(calculateDocumentInvoiceUnitPrice(price)).toBe(expected));
});
