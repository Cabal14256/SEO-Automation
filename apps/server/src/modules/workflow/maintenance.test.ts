import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchTx } from '../batches/service.js';

const state = vi.hoisted(() => ({ results: [] as unknown[][], publish: vi.fn(), checkedBytes: vi.fn(), actor: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { transaction: async (execute: (tx: unknown) => unknown) => execute(tx) }, pool: {} }));
vi.mock('../batches/service.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../batches/service.js')>(), requireBatchActor: state.actor }));
vi.mock('../batches/report-service.js', () => ({ publishReportFile: state.publish }));
vi.mock('../imports/service.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../imports/service.js')>(), checkedFileBytes: state.checkedBytes }));

import { lockedWorkflow } from './service.js';
import { attachWorkflowFile, readWorkflowFile } from './files.js';
import { getWorkflowExport } from './exports.js';

// Drizzle's awaited select chain returns the next synthetic query result.
const query = {
  from: () => query, where: () => query, limit: () => query, for: () => query,
  then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(state.results.shift() ?? []).then(resolve),
};
const tx = { select: () => query } as unknown as BatchTx;
const now = new Date('2026-10-26T00:00:00.000Z');
const record = (kind: string) => ({ id: 'synthetic-record', kind, version: 1, createdAt: now, updatedAt: now });
const maintenance = { code: 'FEATURE_UNDER_MAINTENANCE', status: 503, message: '（待维护）' };

beforeEach(() => { state.results = []; vi.clearAllMocks(); state.actor.mockResolvedValue({ role: 'admin' }); state.checkedBytes.mockResolvedValue(Buffer.from('synthetic')); });

describe('workflow maintenance resource boundary', () => {
  it.each(['fulfillment', 'logistics', 'customs', 'archive'])('blocks locking a %s record for shared file, export and worker operations', async (kind) => {
    state.results = [[record(kind)]];
    await expect(lockedWorkflow(tx, 'synthetic-record', 'synthetic-admin')).rejects.toMatchObject(maintenance);
    expect(state.actor).toHaveBeenCalledWith(tx, 'synthetic-admin');
  });
  it('retains active finance locking and version checks', async () => {
    state.results = [[record('finance')]];
    await expect(lockedWorkflow(tx, 'synthetic-record', 'synthetic-admin', 1)).resolves.toMatchObject({ kind: 'finance' });
    state.results = [[record('finance')]];
    await expect(lockedWorkflow(tx, 'synthetic-record', 'synthetic-admin', 2)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('rejects uploads before staging any bytes or replaying an old operation', async () => {
    state.results = [[record('customs')]];
    await expect(attachWorkflowFile('synthetic-admin', { recordId: 'synthetic-record', operationId: 'synthetic-operation', purpose: 'evidence', bytes: Buffer.from('synthetic'), name: 'synthetic.txt', mimeType: 'text/plain' })).rejects.toMatchObject(maintenance);
    expect(state.publish).not.toHaveBeenCalled();
  });
  it('blocks shared export status access before loading its context or file bytes', async () => {
    state.results = [[{ recordId: 'synthetic-record' }], [record('archive')]];
    await expect(getWorkflowExport('synthetic-export', 'synthetic-admin')).rejects.toMatchObject(maintenance);
    expect(state.checkedBytes).not.toHaveBeenCalled();
  });
  it.each(['attachment', 'export', 'source'] as const)('blocks shared downloads owned only by a maintained %s', async (relation) => {
    state.results = [relation === 'attachment' ? [{ recordId: 'synthetic-record' }] : [], relation === 'source' ? [{ kind: 'logistics' }] : [], relation === 'export' ? [{ recordId: 'synthetic-record' }] : [], ...(relation !== 'source' ? [[record('logistics')]] : [])];
    await expect(readWorkflowFile('synthetic-file', 'synthetic-admin')).rejects.toMatchObject(maintenance);
    expect(state.checkedBytes).not.toHaveBeenCalled();
  });
  it('keeps a reviewed source shared with finance downloadable', async () => {
    state.results = [[], [{ kind: 'fulfillment' }, { kind: 'finance' }], [], [{ id: 'synthetic-file' }]];
    await expect(readWorkflowFile('synthetic-file', 'synthetic-admin')).resolves.toMatchObject({ file: { id: 'synthetic-file' }, bytes: Buffer.from('synthetic') });
    expect(state.checkedBytes).toHaveBeenCalledOnce();
  });
});
