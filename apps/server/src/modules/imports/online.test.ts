import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fbaLookupRecordSchema, onlineImportInputSchema, type FbaLookupRecord } from '@scm/contracts';
import type { PgBoss } from 'pg-boss';
const controls = vi.hoisted(() => ({ replay: vi.fn(), persist: vi.fn(), lookup: vi.fn(), catalog: vi.fn(), transaction: vi.fn() }));
vi.mock('../../db/client.js', () => {
  controls.transaction.mockImplementation(async (work: (tx: object) => unknown) => work({}));
  return { db: { transaction: controls.transaction } };
});
vi.mock('../seller-mappings/catalog.js', async (original) => ({ ...await original<typeof import('../seller-mappings/catalog.js')>(), getCatalogState: controls.catalog }));
vi.mock('./fba-lookup.js', () => ({ getFbaLookup: controls.lookup }));
vi.mock('./service.js', async (original) => ({ ...await original<typeof import('./service.js')>(), replayOnlineImport: controls.replay, createSourceImport: controls.persist }));
import { buildOnlineWorkbook, canonicalOnlineRows, createOnlineImport, onlineContentHash } from './online.js';
import { parseImportWorkbook } from './parser.js';

const input = (overrides: Record<string, string> = {}) => onlineImportInputSchema.parse({ operationId: randomUUID(), rows: [{ fba: 'fba123', shop: '测试店铺', country: '美国', channel: 'HY', referenceQuantity: '0', destinationAddress: '123 Main St', shipmentCreatedAt: '2026-09-01 10:00', sourceFilledAt: '2026-09-02', notes: '=HYPERLINK("https://example.com")', ...overrides }] });
const lookupId = randomUUID();
const completedLookup = (): FbaLookupRecord => ({ id: lookupId, status: 'completed', startDate: '2026-09-01', endDate: '2026-09-30', fbas: ['FBA123'],
  catalogMode: 'lingxing', catalogSettingsVersion: 1, catalogVersion: 2, createdAt: '2026-10-17T00:00:00Z', completedAt: '2026-10-17T00:00:01Z', errorCode: null, errorMessage: null,
  rows: [{ fba: 'FBA123', status: 'unique', candidates: [{ sid: 12, shop: '测试店铺', country: '美国', destinationFc: null, destinationAddress: '123 Main St',
    shipmentCreatedAt: '2026-09-01 10:00', channel: 'HY', channelStatus: 'unique',
    channelOptions: [{ name: 'HY', shipmentNumbers: ['SP-TEST-001'], channelIds: [], methodNames: [] }], observedAt: '2026-10-17T00:00:01Z' }] }] });
function lookupInput(overrides: Record<string, string> = {}) {
  const request = input(overrides); request.rows[0]!.lookupId = lookupId; request.rows[0]!.lookupSid = 12; return request;
}
beforeEach(() => {
  controls.transaction.mockClear();
  controls.replay.mockReset().mockResolvedValue(null);
  controls.persist.mockReset().mockResolvedValue({ accepted: true });
  controls.lookup.mockReset().mockResolvedValue(completedLookup());
  controls.catalog.mockReset().mockResolvedValue({ mode: 'lingxing', version: 1, catalogVersion: 2 });
});
describe('online intake snapshots', () => {
  it('preserves internal ticket separators without manufacturing metadata-only demands', async () => {
    const first = input().rows[0]!;
    const blank = onlineImportInputSchema.parse({ operationId: randomUUID(), rows: [{}] }).rows[0]!;
    const request = onlineImportInputSchema.parse({ operationId: randomUUID(), rows: [blank, first, blank, blank, { ...first, fba: 'FBASECOND' }, blank] });
    const rows = canonicalOnlineRows(request);
    expect(rows).toHaveLength(5);
    const bytes = await buildOnlineWorkbook(rows, new Map([[4, { source: 'lingxing:lookup:sid=12', observedAt: '2026-10-23T01:00:00Z' }]]));
    const result = parseImportWorkbook(bytes);
    expect(result.rows.map((item) => [item.rowNumber, item.normalized.sourceTicketIndex, item.normalized.sourceMemberIndex])).toEqual([[3, 1, 1], [6, 2, 2]]);
    expect(result.rows[1]?.normalized).toMatchObject({ fba: 'FBASECOND', metadataSource: 'lingxing:lookup:sid=12', metadataObservedAt: '2026-10-23T01:00:00Z' });
    expect(result.counts).toMatchObject({ totalRows: 2, errorRows: 0 });
    expect(result.rows.every((item) => item.normalized.subBatchName === null)).toBe(true);
  });

  it('includes ticket boundaries in the content fingerprint', async () => {
    const first = input().rows[0]!;
    const blank = onlineImportInputSchema.parse({ operationId: randomUUID(), rows: [{}] }).rows[0]!;
    const continuous = [first, { ...first, fba: 'FBASECOND' }];
    const separated = [first, blank, { ...first, fba: 'FBASECOND' }];
    expect(onlineContentHash(continuous)).not.toBe(onlineContentHash(separated));
    expect(await buildOnlineWorkbook(continuous)).not.toEqual(await buildOnlineWorkbook(separated));
  });

  it('preserves literal pasted values, zero and independent dates through the real parser', async () => {
    const rows = canonicalOnlineRows(input());
    const result = parseImportWorkbook(await buildOnlineWorkbook(rows));
    expect(result.mappingVersion).toBe('online-v1');
    expect(result.rows[0]?.normalized).toMatchObject({ fba: 'FBA123', channel: 'HY', referenceQuantity: '0', destinationAddress: '123 Main St', shipmentCreatedAt: '2026-09-01 10:00', sourceFilledAt: '2026-09-02', notes: '=HYPERLINK("https://example.com")' });
    expect(result.rows[0]?.rawCells.find((cell) => cell.column === 'I')?.formula).toBeNull();
  });
  it('produces the same bytes and content hash for equal input, independent of operation ID', async () => {
    const a = canonicalOnlineRows(input()); const b = canonicalOnlineRows(input());
    expect(onlineContentHash(a)).toBe(onlineContentHash(b));
    expect(await buildOnlineWorkbook(a)).toEqual(await buildOnlineWorkbook(b));
    expect(onlineContentHash(a)).not.toBe(onlineContentHash(canonicalOnlineRows(input({ notes: '修改备注' }))));
  });
  it('keeps invalid populated rows for row-level validation and ignores only trailing empty rows', async () => {
    const parsed = input({ fba: '', referenceQuantity: 'invalid' });
    parsed.rows.push(onlineImportInputSchema.parse({ operationId: randomUUID(), rows: [{}] }).rows[0]!);
    const rows = canonicalOnlineRows(parsed);
    expect(rows).toHaveLength(1);
    const result = parseImportWorkbook(await buildOnlineWorkbook(rows));
    expect(result.rows[0]?.status).toBe('error');
    expect(result.rows[0]?.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['FBA_REQUIRED', 'INVALID_REFERENCE_QUANTITY']));
    expect(() => canonicalOnlineRows(onlineImportInputSchema.parse({ operationId: randomUUID(), rows: [{}] }))).toThrow('至少填写一行');
  });
});

describe('online lookup provenance and retries', () => {
  const boss = {} as PgBoss;
  it('loads earlier completed lookup snapshots without fabricating a channel result', () => {
    const lookup = structuredClone(completedLookup());
    const candidate = lookup.rows[0]!.candidates[0]!;
    const legacy = Object.fromEntries(Object.entries(candidate).filter(([key]) => !['channel', 'channelStatus', 'channelOptions'].includes(key)));
    expect(fbaLookupRecordSchema.parse({ ...lookup, rows: [{ ...lookup.rows[0], candidates: [legacy] }] }).rows[0]?.candidates[0])
      .toMatchObject({ channel: null, channelStatus: 'unavailable', channelOptions: [] });
  });
  it('records the adopted FBA candidate and query observation in the immutable source', async () => {
    await createOnlineImport(boss, lookupInput(), 'actor');
    const source = controls.persist.mock.calls[0]![1];
    const result = parseImportWorkbook(source.bytes);
    expect(result.rows[0]?.normalized).toMatchObject({ metadataSource: `lingxing:${lookupId}:sid=12`, metadataObservedAt: '2026-10-17T00:00:01Z' });
    expect(controls.lookup).toHaveBeenCalledWith(lookupId, 'actor');
    expect(source.expectedCatalog).toEqual({ mode: 'lingxing', version: 1, catalogVersion: 2 });
    expect(controls.catalog).toHaveBeenCalledOnce();
    expect(controls.transaction).toHaveBeenCalledOnce();
  });
  it('marks manually changed FC/country as a combined source rather than claiming unedited platform metadata', async () => {
    await createOnlineImport(boss, lookupInput({ destinationFc: 'MANUAL-FC', country: '英国' }), 'actor');
    const source = controls.persist.mock.calls[0]![1];
    expect(parseImportWorkbook(source.bytes).rows[0]?.normalized.metadataSource).toBe(`online+lingxing:${lookupId}:sid=12`);
  });
  it('preserves an adopted transportation method name and its provenance instead of requiring a short code', async () => {
    const lookup = completedLookup();
    Object.assign(lookup.rows[0]!.candidates[0]!, { channel: '自定义海派', channelOptions: [{ name: '自定义海派', shipmentNumbers: ['SP-TEST-001'], channelIds: ['22'], methodNames: ['自定义海派'] }] });
    controls.lookup.mockResolvedValue(lookup);
    await createOnlineImport(boss, lookupInput({ channel: '自定义海派' }), 'actor');
    expect(parseImportWorkbook(controls.persist.mock.calls[0]![1].bytes).rows[0]?.normalized).toMatchObject({ channel: '自定义海派', metadataSource: `lingxing:${lookupId}:sid=12` });
  });
  it('records manual channel overrides as combined evidence and accepts an explicitly chosen transportation method', async () => {
    await createOnlineImport(boss, lookupInput({ channel: '人工渠道' }), 'actor');
    expect(parseImportWorkbook(controls.persist.mock.calls[0]![1].bytes).rows[0]?.normalized.metadataSource).toBe(`online+lingxing:${lookupId}:sid=12`);
    const lookup = completedLookup();
    Object.assign(lookup.rows[0]!.candidates[0]!, { channel: null, channelStatus: 'ambiguous', channelOptions: [{ name: '海派', shipmentNumbers: ['SP-TEST-001'], channelIds: [], methodNames: ['海派'] }, { name: '空派', shipmentNumbers: ['SP-TEST-002'], channelIds: [], methodNames: ['空派'] }] });
    controls.lookup.mockResolvedValue(lookup); controls.persist.mockClear();
    await createOnlineImport(boss, lookupInput({ channel: '空派' }), 'actor');
    expect(parseImportWorkbook(controls.persist.mock.calls[0]![1].bytes).rows[0]?.normalized).toMatchObject({ channel: '空派', metadataSource: `lingxing:${lookupId}:sid=12` });
  });
  it('rejects reusing one shop candidate for another shop or another FBA', async () => {
    await expect(createOnlineImport(boss, lookupInput({ shop: '另一个店铺' }), 'actor')).rejects.toMatchObject({ code: 'LOOKUP_SHOP_MISMATCH' });
    await expect(createOnlineImport(boss, lookupInput({ fba: 'FBA999' }), 'actor')).rejects.toMatchObject({ code: 'LOOKUP_CANDIDATE_INVALID' });
    expect(controls.persist).not.toHaveBeenCalled();
  });
  it('rejects dangling candidate references and incomplete queries', async () => {
    const dangling = input(); dangling.rows[0]!.lookupSid = 12;
    await expect(createOnlineImport(boss, dangling, 'actor')).rejects.toMatchObject({ code: 'LOOKUP_CANDIDATE_INVALID' });
    controls.lookup.mockResolvedValue({ ...completedLookup(), status: 'failed', rows: [] });
    await expect(createOnlineImport(boss, lookupInput(), 'actor')).rejects.toMatchObject({ code: 'LOOKUP_INCOMPLETE' });
    expect(controls.persist).not.toHaveBeenCalled();
  });
  it('replays an already accepted request even after the current directory changes', async () => {
    const accepted = { accepted: true, replayed: true }; controls.replay.mockResolvedValue(accepted);
    controls.catalog.mockResolvedValue({ mode: 'manual', version: 99, catalogVersion: 100 });
    expect(await createOnlineImport(boss, lookupInput(), 'actor')).toBe(accepted);
    expect(controls.lookup).not.toHaveBeenCalled(); expect(controls.persist).not.toHaveBeenCalled(); expect(controls.catalog).not.toHaveBeenCalled();
  });
  it('passes the pre-query catalog expectation into the source transaction and propagates stale-catalog rejection', async () => {
    const { ImportError } = await import('./service.js');
    controls.persist.mockRejectedValueOnce(new ImportError('CATALOG_VERSION_CONFLICT', 409, '目录已变化'));
    await expect(createOnlineImport(boss, lookupInput(), 'actor')).rejects.toMatchObject({ code: 'CATALOG_VERSION_CONFLICT' });
    expect(controls.persist.mock.calls[0]![1].expectedCatalog).toEqual({ mode: 'lingxing', version: 1, catalogVersion: 2 });
    expect(controls.transaction).toHaveBeenCalledOnce();
  });
  it('delegates concurrent winning replay to the source transaction without opening another transaction around it', async () => {
    const accepted = { accepted: true, replayed: true }; controls.persist.mockResolvedValueOnce(accepted);
    expect(await createOnlineImport(boss, lookupInput(), 'actor')).toBe(accepted);
    expect(controls.replay).toHaveBeenCalledOnce(); expect(controls.persist).toHaveBeenCalledOnce(); expect(controls.transaction).toHaveBeenCalledOnce();
  });
});
