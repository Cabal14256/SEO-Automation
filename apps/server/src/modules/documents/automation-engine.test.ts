import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Document, DocumentCandidate, DocumentExport, DocumentMemberSnapshot } from '@scm/contracts';
vi.mock('../../db/client.js', () => ({ db: {} }));
import { advanceAutomationItem, automationOperationId, automationSourceDigest, automationSummary, candidateItem, groupAutomationCandidates, resetAutomationRetry, shouldReplayAutomationRequest, type AutomationContext, type AutomationServices } from './automation-engine.js';
import type { StoredDocumentAutomationItem } from './automation-types.js';

function member(fba = 'FBA1'): DocumentMemberSnapshot {
  const demandId = randomUUID();
  return { demand: { id: demandId, snapshot: { sid: 12, fba, country: '美国', destinationFc: 'ONT8', channel: 'SEA' } },
    source: { demandId, weekStartDate: '2026-10-19', groupId: randomUUID(), groupVersion: 1, m2ConfirmationId: randomUUID(), demandVersion: 1, shipmentRevisionId: randomUUID() } } as DocumentMemberSnapshot;
}
function fixture() {
  const members = [member()], item: StoredDocumentAutomationItem = { id: randomUUID(), demandIds: members.map((entry) => entry.demand.id), fbas: ['FBA1'], documentId: null, documentVersion: null,
    exportId: null, fileId: null, stage: 'create', status: 'queued', issues: [], error: null, attempt: 1, sourceDigest: automationSourceDigest(members), operations: {} };
  const context: AutomationContext = { id: randomUUID(), shippingRunId: randomUUID(), createdBy: 'admin', fields: { customsMode: '普通报关' }, title: null };
  const document = { id: randomUUID(), status: 'draft', version: 1, currentRevision: { data: { members } } } as Document;
  const state = { document, exports: [] as DocumentExport[], mutations: 0 };
  const replay = new Map<string, unknown>();
  const mutate = async (input: { operationId: string }, execute: () => unknown) => { if (replay.has(input.operationId)) return structuredClone(replay.get(input.operationId)); const result = execute(); replay.set(input.operationId, structuredClone(result)); return result; };
  const services: AutomationServices = {
    current: vi.fn(async () => structuredClone({ document: state.document, exports: state.exports })), existing: vi.fn(async () => null), sourceDigest: vi.fn(async () => item.sourceDigest),
    create: vi.fn((input) => mutate(input, () => { state.mutations++; return { document: structuredClone(state.document) }; }) as ReturnType<AutomationServices['create']>),
    preview: vi.fn(async () => ({ preview: {} as never })),
    apply: vi.fn((id, input) => mutate(input, () => { state.document.version++; state.mutations++; return { document: structuredClone(state.document) }; }) as ReturnType<AutomationServices['apply']>),
    prepare: vi.fn((id, input) => mutate(input, () => { state.document.version++; state.mutations++; return { document: structuredClone(state.document), issues: [] }; }) as ReturnType<AutomationServices['prepare']>),
    validate: vi.fn(async () => ({ validation: { documentId: state.document.id, version: state.document.version, valid: true, issues: [], checkedAt: '2026-10-25T01:00:00Z' } })),
    export: vi.fn(async () => ({ export: { id: randomUUID(), status: 'queued', fileId: null } as DocumentExport })),
    exportStatus: vi.fn(async () => ({ status: 'completed', fileId: randomUUID(), error: null })),
  };
  return { item, context, state, services, replay };
}
describe('durable automatic invoice stages', () => {
  it('stops every new-mode ticket at ready without requesting any per-document export', async () => {
    const first = fixture(), second = fixture(); first.context.mode = 'single_workbook'; second.context.mode = 'single_workbook';
    vi.mocked(first.services.prepare).mockResolvedValue({ document: first.state.document, issues: [{ code: 'VAT_REQUIRED', severity: 'error', message: 'VAT missing' }] });
    await advanceAutomationItem(first.context, first.item, first.services, async () => undefined);
    await advanceAutomationItem(second.context, second.item, second.services, async () => undefined);
    expect(first.item.status).toBe('blocked'); expect(second.item).toMatchObject({ status: 'ready', stage: 'ready' });
    expect(first.services.export).not.toHaveBeenCalled(); expect(second.services.export).not.toHaveBeenCalled();
    expect(automationSummary([first.item, second.item])).toMatchObject({ status: 'blocked', counts: { ready: 1, blocked: 1, completed: 0 } });
  });
  it('keeps a valid existing file ready for batch reuse until the whole batch passes', async () => {
    const { context, item, services, state } = fixture(); context.mode = 'single_workbook'; item.documentId = state.document.id; item.documentVersion = 1; item.stage = 'preview';
    state.exports.push({ id: randomUUID(), fileId: randomUUID(), status: 'completed', valid: true } as DocumentExport);
    await advanceAutomationItem(context, item, services, async () => undefined);
    expect(item.status).toBe('ready'); expect(item.fileId).toBe(state.exports[0]!.fileId); expect(services.export).not.toHaveBeenCalled();
  });
  it('does not replay a legacy export checkpoint before the whole-batch barrier', async () => {
    const { context, item, services, state } = fixture(); context.mode = 'single_workbook'; item.documentId = state.document.id; item.documentVersion = 1; item.stage = 'export';
    item.operations['1:export'] = { input: { operationId: randomUUID(), expectedVersion: 1, reason: 'old export request' } };
    const blocked = { ...structuredClone(item), id: randomUUID(), status: 'blocked' as const };
    await advanceAutomationItem(context, item, services, async () => undefined);
    expect(item).toMatchObject({ status: 'ready', stage: 'ready', attempt: 2 }); expect(services.export).not.toHaveBeenCalled(); expect(services.validate).toHaveBeenCalledOnce();
    expect(automationSummary([item, blocked])).toMatchObject({ status: 'blocked', counts: { ready: 1, blocked: 1 } });
  });
  it('chains create, archived lookup/apply, preparation, validation and asynchronous export', async () => {
    const { context, item, services } = fixture(); const persist = vi.fn(async () => undefined);
    await advanceAutomationItem(context, item, services, persist);
    expect(item).toMatchObject({ status: 'exporting', stage: 'export', documentVersion: 3 });
    expect(services.create).toHaveBeenCalledOnce(); expect(services.preview).toHaveBeenCalledOnce(); expect(services.apply).toHaveBeenCalledOnce(); expect(services.prepare).toHaveBeenCalledOnce();
    expect(Object.keys(item.operations)).toEqual(['create', '1:preview', '1:apply', '1:prepare', '1:validate', '1:export']);
    await advanceAutomationItem(context, item, services, persist);
    expect(item.status).toBe('completed'); expect(item.fileId).toBeTruthy(); expect(services.export).toHaveBeenCalledOnce();
    await advanceAutomationItem(context, item, services, persist); expect(services.export).toHaveBeenCalledOnce();
  });
  it('replays the original request after a committed create loses its response', async () => {
    const { context, item, services, state } = fixture(); let durable = structuredClone(item), lose = true;
    const original = services.create;
    services.create = vi.fn(async (input) => { const result = await original(input); if (lose) { lose = false; throw new Error('network interrupted'); } return result; });
    await expect(advanceAutomationItem(context, item, services, async () => { durable = structuredClone(item); })).rejects.toThrow('network interrupted');
    const originalRequest = structuredClone(durable.operations.create!.input);
    expect(durable.documentId).toBeNull();
    await advanceAutomationItem(context, durable, services, async () => undefined);
    expect(vi.mocked(services.create).mock.calls.map(([input]) => input)).toEqual([originalRequest, originalRequest]);
    expect(state.mutations).toBe(3); expect(durable.status).toBe('exporting');
  });
  it('replays an uncertain apply before checking the newer version produced by that apply', async () => {
    const { context, item, services, state } = fixture(); let durable = structuredClone(item), lose = true;
    const original = services.apply;
    services.apply = vi.fn(async (id, input) => { const result = await original(id, input); if (lose) { lose = false; throw new Error('apply response lost'); } return result; });
    await expect(advanceAutomationItem(context, item, services, async () => { durable = structuredClone(item); })).rejects.toThrow('apply response lost');
    expect(durable.stage).toBe('apply'); expect(durable.documentVersion).toBe(1); expect(state.document.version).toBe(2);
    const request = structuredClone(durable.operations['1:apply']!.input);
    await advanceAutomationItem(context, durable, services, async () => undefined);
    expect(vi.mocked(services.apply).mock.calls.map(([, input]) => input)).toEqual([request, request]); expect(state.document.version).toBe(3);
  });
  it('stops on an intervening manual revision before starting the next unchecked stage', async () => {
    const { context, item, services, state } = fixture(); let durable = structuredClone(item);
    await expect(advanceAutomationItem(context, item, services, async () => { durable = structuredClone(item); if (item.stage === 'apply' && !item.operations['1:apply']) throw new Error('worker stopped'); })).rejects.toThrow('worker stopped');
    state.document.version++;
    await expect(advanceAutomationItem(context, durable, services, async () => undefined)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(services.apply).not.toHaveBeenCalled();
  });
  it('takes a fresh preview after a known missing apply archive, while retaining exact replay for unknown commits', async () => {
    const { context, item, services, state } = fixture(); item.documentId = state.document.id; item.documentVersion = 1; item.stage = 'apply';
    item.operations['1:apply'] = { input: { operationId: automationOperationId(context.id, item.id, '1:apply'), expectedVersion: 1, previewOperationId: randomUUID(), reason: 'apply', confirmPrices: true } };
    const original = services.apply; let missing = true;
    services.apply = vi.fn(async (id, input) => { if (missing) { missing = false; throw Object.assign(new Error('归档缺失'), { code: 'FILE_UNAVAILABLE', status: 503 }); } return original(id, input); });
    await expect(advanceAutomationItem(context, item, services, async () => undefined)).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
    item.status = 'blocked';
    const exact = shouldReplayAutomationRequest({ code: 'FILE_UNAVAILABLE', status: 503 }, true); expect(exact).toBe(false);
    resetAutomationRetry(item, exact); expect(item).toMatchObject({ attempt: 2, stage: 'preview', status: 'queued' });
    await advanceAutomationItem(context, item, services, async () => undefined);
    expect(services.preview).toHaveBeenCalledOnce(); expect(vi.mocked(services.apply).mock.calls[1]?.[1].operationId).toBe(automationOperationId(context.id, item.id, '2:apply'));
    expect(item.status).toBe('exporting'); expect(shouldReplayAutomationRequest({ code: 'NETWORK_FAILED', status: 503 }, false)).toBe(true);
    expect(shouldReplayAutomationRequest({ code: 'QUEUE_UNAVAILABLE', status: 503 }, true)).toBe(true);
  });
  it('retains mixed cartons, images and carton-quantity warnings without blocking output', async () => {
    const { context, item, services } = fixture();
    vi.mocked(services.validate).mockResolvedValue({ validation: { documentId: randomUUID(), version: 3, valid: true, checkedAt: '2026-10-25T01:00:00Z', issues: [
      { code: 'DOCUMENT_MIXED_CARTON', severity: 'warning', message: 'mixed carton' }, { code: 'PRODUCT_IMAGE_MISSING', severity: 'warning', message: 'no image' }, { code: 'DOCUMENT_CARTON_QUANTITY_FALLBACK', severity: 'warning', message: 'actual quantity fallback' },
    ] } });
    await advanceAutomationItem(context, item, services, async () => undefined);
    expect(item.status).toBe('exporting'); expect(item.issues).toHaveLength(3);
  });
  it('blocks an incomplete ticket while an independent complete ticket still reaches export', async () => {
    const first = fixture(), second = fixture();
    vi.mocked(first.services.prepare).mockResolvedValue({ document: first.state.document, issues: [{ code: 'VAT_REQUIRED', severity: 'error', message: '缺少 VAT' }] });
    await advanceAutomationItem(first.context, first.item, first.services, async () => undefined);
    await advanceAutomationItem(second.context, second.item, second.services, async () => undefined);
    expect(first.item).toMatchObject({ status: 'blocked', error: { code: 'VAT_REQUIRED' } }); expect(first.services.export).not.toHaveBeenCalled();
    expect(second.item.status).toBe('exporting'); expect(automationSummary([first.item, { ...second.item, status: 'completed' }]).status).toBe('partial');
  });
  it('reuses an existing completed file without lookup, revision, approval or another export', async () => {
    const { context, item, services, state } = fixture();
    item.documentId = state.document.id; item.documentVersion = 1; item.stage = 'preview';
    state.exports.push({ id: randomUUID(), fileId: randomUUID(), status: 'completed' } as DocumentExport);
    await advanceAutomationItem(context, item, services, async () => undefined);
    expect(item.status).toBe('completed'); expect(item.fileId).toBe(state.exports[0]!.fileId);
    expect(services.preview).not.toHaveBeenCalled(); expect(services.prepare).not.toHaveBeenCalled(); expect(services.export).not.toHaveBeenCalled();
  });
  it('preserves an invalid existing file for correction instead of treating it as successful or regenerating', async () => {
    const { context, item, services, state } = fixture(); item.documentId = state.document.id; item.documentVersion = 1; item.stage = 'preview';
    const file = { id: randomUUID(), fileId: randomUUID(), status: 'completed', valid: false, invalidReason: '来源已变化，请更正' } as DocumentExport; state.exports.push(file);
    await advanceAutomationItem(context, item, services, async () => undefined);
    expect(item).toMatchObject({ status: 'blocked', exportId: file.id, fileId: file.fileId, error: { code: 'DOCUMENT_EXPORT_STALE' } });
    expect(services.preview).not.toHaveBeenCalled(); expect(services.export).not.toHaveBeenCalled();
  });
  it('blocks a completed export that became invalid while the asynchronous task was running', async () => {
    const { context, item, services } = fixture(); item.status = 'exporting'; item.stage = 'export'; item.exportId = randomUUID(); const fileId = randomUUID();
    vi.mocked(services.exportStatus).mockResolvedValue({ status: 'completed', fileId, error: null, valid: false, invalidReason: '模板版本无法核验' });
    await advanceAutomationItem(context, item, services, async () => undefined);
    expect(item).toMatchObject({ status: 'blocked', fileId, error: { code: 'DOCUMENT_EXPORT_STALE', message: '模板版本无法核验' } });
    expect(services.export).not.toHaveBeenCalled();
  });
  it('does not treat a directly replayed stale export response as a successful file', async () => {
    const { context, item, services } = fixture(), exportId = randomUUID(), fileId = randomUUID();
    vi.mocked(services.export).mockResolvedValue({ export: { id: exportId, fileId, status: 'completed', valid: false, invalidReason: '引用版本已失效' } as DocumentExport });
    await advanceAutomationItem(context, item, services, async () => undefined);
    expect(item).toMatchObject({ status: 'blocked', exportId, fileId, error: { code: 'DOCUMENT_EXPORT_STALE', message: '引用版本已失效' } });
  });
});
describe('invoice automation deterministic splitting', () => {
  const candidate = (overrides: Record<string, unknown> = {}) => ({ ...member(), demandId: randomUUID(), groupId: randomUUID(), groupVersion: 1, m2ConfirmationId: randomUUID(), shipment: { id: randomUUID() }, codes: [], physical: null, blockers: [], ...overrides }) as unknown as DocumentCandidate;
  it('uses stable operation IDs and splits differing addresses, countries, shops and channels', () => {
    const first = candidate(), same = structuredClone(first); same.demandId = randomUUID();
    const changed = (key: string, value: unknown) => { const next = structuredClone(first); next.demandId = randomUUID(); Object.assign(next.demand.snapshot, { [key]: value }); return next; };
    const address = candidate({ demand: first.demand, sourceCandidates: { addresses: [{ data: { addressLine1: 'Different road' } }], products: [], issues: [] } });
    const groups = groupAutomationCandidates([first, same, changed('country', '英国'), changed('channel', 'AIR'), changed('sid', 13), address]);
    expect(groups.map((group) => group.length).sort()).toEqual([1, 1, 1, 1, 2]);
    const item = candidateItem([first], randomUUID()); expect(item.status).toBe('queued');
    expect(automationOperationId('job', item.id, 'create')).toBe(automationOperationId('job', item.id, 'create'));
    expect(automationOperationId('job', item.id, '1:prepare')).not.toBe(automationOperationId('job', item.id, '2:prepare'));
  });
  it('splits 51 distinct query identities into two tickets without splitting any FBA', () => {
    const base = candidate();
    const candidates = Array.from({ length: 51 }, (_, index) => ({ ...structuredClone(base), demandId: randomUUID(), shipment: { ...base.shipment, data: { items: [{ msku: `M${index}`, fnsku: `F${index}`, sku: `S${index}` }] } } })) as DocumentCandidate[];
    const groups = groupAutomationCandidates(candidates);
    expect(groups.map((group) => group.length)).toEqual([50, 1]); expect(groups.flat()).toHaveLength(51);
    const repeated = candidates.map((entry) => ({ ...entry, shipment: { ...entry.shipment, data: { ...entry.shipment.data, items: [{ msku: 'SHARED', fnsku: 'SHARED', sku: 'SHARED' }] } } })) as DocumentCandidate[];
    expect(groupAutomationCandidates(repeated)).toHaveLength(1);
  });
  it('keeps an over-budget single FBA whole and exposes an actionable blocked item', () => {
    const base = candidate(), oversized = { ...base, shipment: { ...base.shipment, data: { items: Array.from({ length: 51 }, (_, index) => ({ msku: `M${index}`, fnsku: `F${index}`, sku: `S${index}` })) } } } as DocumentCandidate;
    const other = candidate({ demand: base.demand });
    const groups = groupAutomationCandidates([oversized, other]); expect(groups).toHaveLength(2); expect(groups.find((group) => group.includes(oversized))).toEqual([oversized]);
    const item = candidateItem([oversized], randomUUID()); expect(item.status).toBe('blocked'); expect(item.error?.code).toBe('DOCUMENT_PRODUCT_LIMIT'); expect(item.demandIds).toEqual([oversized.demandId]);
  });
});
