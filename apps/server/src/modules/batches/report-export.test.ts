import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipmentReport } from '@scm/contracts';

const state = vi.hoisted(() => ({
  reads: [] as unknown[][], updates: [] as Record<string, unknown>[], inserts: [] as unknown[], ready: vi.fn(), confirmed: vi.fn(), freeze: vi.fn(), store: vi.fn(), unlink: vi.fn(),
}));
vi.mock('../../db/client.js', () => {
  const select = () => {
    const query = { from: () => query, where: () => query, orderBy: () => query, for: () => query,
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(state.reads.shift() ?? []).then(resolve, reject) };
    return query;
  };
  const tx = { select, update: () => ({ set: (value: Record<string, unknown>) => { state.updates.push(value); return { where: async () => undefined }; } }),
    insert: () => ({ values: async (value: unknown) => { state.inserts.push(value); } }) };
  return { db: { ...tx, transaction: async (work: (input: typeof tx) => unknown) => work(tx) }, pool: { connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release: vi.fn() }) } };
});
vi.mock('node:fs/promises', () => ({ unlink: state.unlink }));
vi.mock('../../config.js', () => ({ readConfig: () => ({ dataDir: 'D:\\SCM-Automation-test-exports' }) }));
vi.mock('../../file-store.js', () => ({ storeImmutableFile: state.store }));
vi.mock('../imports/service.js', () => ({ checkedFileBytes: vi.fn() }));
vi.mock('../shipping-runs/service.js', () => ({ getReadyShippingRunInTx: state.ready, getShippingRunReportScopeInTx: vi.fn() }));
vi.mock('./service.js', () => ({ getConfirmedGroup: vi.fn(), getConfirmedGroupInTx: state.confirmed, freezeGroupForExport: state.freeze, lockBatchRunScopesInTx:vi.fn().mockResolvedValue(undefined),
  BatchError: class extends Error { constructor(public code: string, public status: number, message: string) { super(message); } } }));
import { BatchError } from './service.js';
import { executeReportExport } from './report-service.js';

function fixture() {
  const runId = randomUUID(), groupId = randomUUID(), demandId = randomUUID(), ticketId = randomUUID(), confirmationId = randomUUID(), batchId = randomUUID();
  const member = { demandId, groupId, ticketId, inputOrder: 1 };
  const run = { run: { id: runId, version: 4, status: 'ready', numberingDate: '2026-10-23', month: '2026-10', sequence: 2 },
    tickets: [{ id: ticketId, number: '20261023-2-US-1', sourceTicketIndex: 1, members: [member] }], groupIds: [groupId] };
  const projection = { shippingRunId: runId, shippingRunVersion: 4, shippingRunDate: '2026-10-23', shippingRunSequence: 2,
    rows: [{ demandId, groupId, ticketId, ticketNumber: '20261023-2-US-1', sourceTicketIndex: 1, inputOrder: 1, status: '已确认',
      sid: 11, msku: 'M', fnsku: 'FN', sku: 'SKU', quantity: 1 }], boxes: [] } as unknown as ShipmentReport;
  const record = { id: randomUUID(), status: 'queued', groupIds: [groupId], references: [{ groupId, groupVersion: 2, confirmationId }], projection,
    createdBy: 'admin', month: null, region: 'all', fileId: null, rowCount: 1 };
  const group = { id: groupId, batchId, version: 2 };
  const bundle = { group, confirmation: { id: confirmationId } };
  return { run, record, group, bundle };
}
function boxColumnFixture(status = 'queued', legacyRow = false) {
  const data = fixture(), { record, group } = data;
  record.status = status;
  const demandId = record.projection.rows[0]!.demandId!, firstBoxId = randomUUID(), secondBoxId = randomUUID();
  const first = { boxId: firstBoxId, boxOrder: 1, code: 'G7', quantity: 11 };
  const second = { boxId: secondBoxId, boxOrder: 2, code: 'G8', quantity: 20 };
  const source = record.projection.rows[0]!;
  record.projection.rows = [
    { ...source, id: 'source-z-first', msku: 'Z', fnsku: 'FN-Z', sku: 'SKU-Z', quantity: 31, codes: ['G7', 'G8'], boxes: [first, second] },
    { ...source, id: 'source-a-second', msku: 'A', fnsku: 'FN-A', sku: 'SKU-A', quantity: 7, codes: ['G8'], boxes: [{ ...second, quantity: 7 }] },
  ];
  record.projection.boxes = [
    { groupId: group.id, demandId, boxId: firstBoxId, boxOrder: 1, code: 'G7', items: [{ msku: 'Z', fnsku: 'FN-Z', sku: 'SKU-Z', quantity: 11 }] },
    { groupId: group.id, demandId, boxId: secondBoxId, boxOrder: 2, code: 'G8', items: [{ msku: 'Z', fnsku: 'FN-Z', sku: 'SKU-Z', quantity: 20 }, { msku: 'A', fnsku: 'FN-A', sku: 'SKU-A', quantity: 7 }] },
  ] as ShipmentReport['boxes'];
  record.projection.maxBoxes = 2; record.rowCount = 2;
  if (legacyRow) {
    delete record.projection.shippingRunId;
    for (const row of record.projection.rows) delete row.demandId;
  }
  const bundle = { ...data.bundle, confirmation: { ...data.bundle.confirmation, snapshot: { shipments: [{ demandId,
    revision: { data: { boxes: [{ id: firstBoxId, order: 1 }, { id: secondBoxId, order: 2 }] } } }] } }, codes: [
    { id: randomUUID(), groupId: group.id, demandId, boxId: firstBoxId, code: 'G7', prefix: 'G', sequence: 7, valid: true },
    { id: randomUUID(), groupId: group.id, demandId, boxId: secondBoxId, code: 'G8', prefix: 'G', sequence: 8, valid: true },
  ] };
  return { ...data, bundle };
}
function allowPublication(data: ReturnType<typeof boxColumnFixture>) {
  const { record, run, group, bundle } = data;
  state.reads.push([record], [group], [], [group], [{ id: 'admin', role: 'admin', banned: false }], [group], [], [group], [{ ...record, status: 'running' }]);
  state.ready.mockResolvedValue(run); state.confirmed.mockResolvedValue(bundle); state.freeze.mockResolvedValue(bundle);
}
beforeEach(() => {
  state.reads = []; state.updates = []; state.inserts = [];
  state.ready.mockReset(); state.confirmed.mockReset(); state.freeze.mockReset(); state.unlink.mockReset().mockResolvedValue(undefined);
  state.store.mockReset().mockResolvedValue({ id: randomUUID(), storageKey: 'staged.xlsx', sha256: 'test-hash' });
});

describe('shipping-run report publication', () => {
  it('refuses a run that lost readiness before rendering or freezing any source group', async () => {
    const { record } = fixture(); state.reads.push([record], [record]);
    state.ready.mockRejectedValue(new BatchError('SHIPPING_RUN_NOT_READY', 409, '本次发货仍有待处理异常'));
    const createWorkbook = vi.fn();
    await expect(executeReportExport(record.id, { createWorkbook })).rejects.toThrow('本次发货仍有待处理异常');
    expect(createWorkbook).not.toHaveBeenCalled(); expect(state.freeze).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled();
    expect(state.updates.at(-1)).toMatchObject({ status: 'stale' });
  });

  it('checks the run version again after XLSX generation and does not publish or freeze on a race', async () => {
    const { record, run, group, bundle } = fixture();
    state.reads.push([record], [group], [], [group], [{ id: 'admin', role: 'admin', banned: false }], [], [record]);
    state.ready.mockResolvedValueOnce(run).mockRejectedValueOnce(new BatchError('VERSION_CONFLICT', 409, '本次发货版本已变化'));
    state.confirmed.mockResolvedValue(bundle);
    const createWorkbook = vi.fn().mockResolvedValue(Buffer.from('xlsx'));
    await expect(executeReportExport(record.id, { createWorkbook })).rejects.toThrow('本次发货版本已变化');
    expect(createWorkbook).toHaveBeenCalledOnce(); expect(state.ready).toHaveBeenCalledTimes(2);
    expect(state.freeze).not.toHaveBeenCalled(); expect(state.inserts).toEqual([]); expect(state.unlink).toHaveBeenCalledOnce();
    expect(state.updates.some((update)=>'membershipFrozenAt' in update)).toBe(false);
    expect(state.updates.at(-1)).toMatchObject({ status: 'stale' });
  });

  it('detects member reassignment even if a corrupted writer did not change the run version', async () => {
    const { record, run } = fixture(); state.reads.push([record], [record]);
    run.tickets[0]!.members[0]!.inputOrder = 2;
    state.ready.mockResolvedValue(run);
    const createWorkbook = vi.fn();
    await expect(executeReportExport(record.id, { createWorkbook })).rejects.toThrow('票成员已变化');
    expect(createWorkbook).not.toHaveBeenCalled(); expect(state.freeze).not.toHaveBeenCalled();
  });

  it('publishes only after both readiness checks and freezes all referenced groups in the publication transaction', async () => {
    const { record, run, group, bundle } = fixture();
    state.reads.push([record], [group], [], [group], [{ id: 'admin', role: 'admin', banned: false }], [group], [], [group], [{ ...record, status: 'running' }]);
    state.ready.mockResolvedValue(run); state.confirmed.mockResolvedValue(bundle); state.freeze.mockResolvedValue(bundle);
    const createWorkbook = vi.fn().mockResolvedValue(Buffer.from('xlsx'));
    await executeReportExport(record.id, { createWorkbook });
    expect(state.ready).toHaveBeenCalledTimes(2);
    expect(state.ready).toHaveBeenLastCalledWith(expect.anything(), run.run.id, 4, 'admin');
    expect(state.freeze).toHaveBeenCalledExactlyOnceWith(expect.anything(), group.id, record.references[0]!.confirmationId, 'admin');
    expect(state.inserts).toHaveLength(2);
    expect(state.updates.filter((update)=>'membershipFrozenAt' in update)).toHaveLength(1);
    expect(state.updates.at(-1)).toMatchObject({ status: 'completed', projection: { shippingRunId: run.run.id, rows: [expect.objectContaining({ status: '已冻结' })] } });
    expect(state.unlink).not.toHaveBeenCalled();
  });
});

describe('queued report box-column compatibility', () => {
  it.each(['queued', 'failed'])('backfills an old %s projection from valid codes without changing source order, quantities or local box identities', async (status) => {
    const data = boxColumnFixture(status); allowPublication(data);
    const before = structuredClone(data.record.projection), createWorkbook = vi.fn().mockResolvedValue(Buffer.from('xlsx'));
    await executeReportExport(data.record.id, { createWorkbook });
    const rendered = createWorkbook.mock.calls[0]![0] as ShipmentReport;
    expect(rendered.maxBoxes).toBe(2);
    expect(rendered.rows.map((row) => [row.id, row.quantity, row.boxes.map((box) => [box.boxId, box.boxOrder, box.code, box.quantity, box.displayBoxOrder])])).toEqual([
      ['source-z-first', 31, [[before.rows[0]!.boxes[0]!.boxId, 1, 'G7', 11, 1], [before.rows[0]!.boxes[1]!.boxId, 2, 'G8', 20, 2]]],
      ['source-a-second', 7, [[before.rows[1]!.boxes[0]!.boxId, 2, 'G8', 7, 2]]],
    ]);
    expect(rendered.boxes.map((box) => [box.boxOrder, box.displayBoxOrder, box.items])).toEqual([[1, 1, before.boxes[0]!.items], [2, 2, before.boxes[1]!.items]]);
    expect(rendered.rows.map((row) => [row.demandId, row.ticketId, row.inputOrder])).toEqual(before.rows.map((row) => [row.demandId, row.ticketId, row.inputOrder]));
    expect(data.record.projection).toEqual(before);
    expect(state.updates.at(-1)).toMatchObject({ status: 'completed', projection: rendered });
    expect(state.freeze).toHaveBeenCalledOnce();
  });

  it('backfills a legacy row without demandId by its exact group, box and code while retaining the legacy shape', async () => {
    const data = boxColumnFixture('queued', true); allowPublication(data);
    const before = structuredClone(data.record.projection), createWorkbook = vi.fn().mockResolvedValue(Buffer.from('xlsx'));
    await executeReportExport(data.record.id, { createWorkbook });
    const rendered = createWorkbook.mock.calls[0]![0] as ShipmentReport;
    expect(rendered.rows.map((row) => row.boxes.map((box) => box.displayBoxOrder))).toEqual([[1, 2], [2]]);
    expect(rendered.rows.every((row) => !Object.hasOwn(row, 'demandId'))).toBe(true);
    expect(rendered.shippingRunId).toBeUndefined(); expect(state.ready).not.toHaveBeenCalled();
    expect(data.record.projection).toEqual(before); expect(state.updates.at(-1)).toMatchObject({ status: 'completed' });
  });

  it.each(['missing', 'wrong code', 'wrong group', 'wrong demand', 'duplicate', 'invalid'])('refuses %s allocation evidence before rendering or freezing', async (problem) => {
    const data = boxColumnFixture(), { record, bundle, group, run } = data;
    if (problem === 'missing') bundle.codes.shift();
    else if (problem === 'wrong code') bundle.codes[0]!.code = 'G70';
    else if (problem === 'wrong group') bundle.codes[0]!.groupId = randomUUID();
    else if (problem === 'wrong demand') bundle.codes[0]!.demandId = randomUUID();
    else if (problem === 'invalid') bundle.codes[0]!.valid = false;
    else bundle.codes.push({ ...bundle.codes[0]!, id: randomUUID() });
    state.reads.push([record], [group], [], [group], [record]);
    state.ready.mockResolvedValue(run); state.confirmed.mockResolvedValue(bundle);
    const before = structuredClone(record.projection), createWorkbook = vi.fn();
    await expect(executeReportExport(record.id, { createWorkbook })).rejects.toMatchObject({ code: 'REPORT_BOX_COLUMNS_STALE', status: 409 });
    expect(createWorkbook).not.toHaveBeenCalled(); expect(state.freeze).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]); expect(record.projection).toEqual(before); expect(state.updates.at(-1)).toMatchObject({ status: 'stale' });
  });

  it.each(['row', 'box'])('rejects an existing %s display position unrelated to local or legacy allocation order', async (location) => {
    const { record, bundle, group, run } = boxColumnFixture();
    if (location === 'row') record.projection.rows[0]!.boxes[0]!.displayBoxOrder = 5;
    else record.projection.boxes[0]!.displayBoxOrder = 5;
    state.reads.push([record], [group], [], [group], [record]); state.ready.mockResolvedValue(run); state.confirmed.mockResolvedValue(bundle);
    const createWorkbook = vi.fn();
    await expect(executeReportExport(record.id, { createWorkbook })).rejects.toMatchObject({ code: 'REPORT_BOX_COLUMNS_STALE', status: 409 });
    expect(createWorkbook).not.toHaveBeenCalled(); expect(state.freeze).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled();
  });

  it('converts legacy allocation columns to local columns without extending to the old maximum', async () => {
    const data = boxColumnFixture();
    data.record.projection.maxBoxes = 80;
    for (const row of data.record.projection.rows) for (const box of row.boxes) box.displayBoxOrder = box.boxOrder + 6;
    for (const box of data.record.projection.boxes) box.displayBoxOrder = box.boxOrder + 6;
    allowPublication(data);
    const createWorkbook = vi.fn().mockResolvedValue(Buffer.from('xlsx'));
    await executeReportExport(data.record.id, { createWorkbook });
    expect(createWorkbook.mock.calls[0]![0]).toMatchObject({ maxBoxes: 2, rows: [
      { ticketCodeRange: 'G7-G8', boxes: [{ displayBoxOrder: 1 }, { displayBoxOrder: 2 }] },
      { ticketCodeRange: 'G7-G8', boxes: [{ displayBoxOrder: 2 }] },
    ] });
  });

  it.each(['row', 'box'])('rejects a changed %s local order against its accepted shipment snapshot', async (location) => {
    const { record, bundle, group, run } = boxColumnFixture();
    if (location === 'row') record.projection.rows[0]!.boxes[0]!.boxOrder = 2;
    else record.projection.boxes[0]!.boxOrder = 2;
    state.reads.push([record], [group], [], [group], [record]); state.ready.mockResolvedValue(run); state.confirmed.mockResolvedValue(bundle);
    const createWorkbook = vi.fn();
    await expect(executeReportExport(record.id, { createWorkbook })).rejects.toMatchObject({ code: 'REPORT_BOX_COLUMNS_STALE', status: 409 });
    expect(createWorkbook).not.toHaveBeenCalled(); expect(state.freeze).not.toHaveBeenCalled();
  });

  it('refuses publication when allocation sequences change after rendering, without storing a completed projection or file index', async () => {
    const data = boxColumnFixture(); allowPublication(data);
    state.freeze.mockResolvedValue({ ...data.bundle, codes: data.bundle.codes.map((code) => ({ ...code, sequence: code.sequence + 10 })) });
    const before = structuredClone(data.record.projection), createWorkbook = vi.fn().mockResolvedValue(Buffer.from('xlsx'));
    await expect(executeReportExport(data.record.id, { createWorkbook })).rejects.toMatchObject({ code: 'REPORT_BOX_COLUMNS_STALE', status: 409 });
    expect(createWorkbook).toHaveBeenCalledOnce(); expect(state.freeze).toHaveBeenCalledOnce(); expect(state.store).toHaveBeenCalledOnce();
    expect(state.inserts).toEqual([]); expect(state.updates.some((update) => update.status === 'completed')).toBe(false);
    expect(state.updates.at(-1)).toMatchObject({ status: 'stale' }); expect(state.unlink).toHaveBeenCalledOnce(); expect(data.record.projection).toEqual(before);
  });

  it.each(['completed', 'stale'])('leaves historical %s exports untouched without rendering or backfilling', async (status) => {
    const { record } = boxColumnFixture(status); state.reads.push([record]);
    const before = structuredClone(record.projection), createWorkbook = vi.fn();
    await executeReportExport(record.id, { createWorkbook });
    expect(createWorkbook).not.toHaveBeenCalled(); expect(state.ready).not.toHaveBeenCalled(); expect(state.confirmed).not.toHaveBeenCalled();
    expect(state.freeze).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled(); expect(state.updates).toEqual([]); expect(record.projection).toEqual(before);
  });
});
