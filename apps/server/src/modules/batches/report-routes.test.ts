import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ session: vi.fn(), report: vi.fn(), authorize: vi.fn(), transaction: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('../../db/client.js', () => ({ db: { transaction: state.transaction } }));
vi.mock('./report-service.js', () => ({ getShipmentReport: state.report }));
vi.mock('./service.js', () => ({ requireBatchActor: state.authorize, BatchError: class extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
} }));
import { createReportRoutes } from './report-routes.js';

const app = () => new Hono().route('/api/v1/batch-reports', createReportRoutes(() => null));
beforeEach(() => {
  state.session.mockReset().mockResolvedValue({ user: { id: 'technical-admin', role: 'admin', banned: false } });
  state.report.mockReset().mockResolvedValue({ rows: [], boxes: [], confirmations: [], total: 0 });
  state.authorize.mockReset().mockResolvedValue({ id: 'technical-admin' });
  state.transaction.mockReset().mockImplementation(async (work: (tx: unknown) => unknown) => work({}));
});

describe('GET /batch-reports search', () => {
  it('passes a trimmed search with the applied filters and pagination', async () => {
    const response = await app().request('/api/v1/batch-reports?month=2026-09&region=US&q=%20%20FBA-Alpha%20%20&page=2&pageSize=20');
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(state.report).toHaveBeenCalledExactlyOnceWith('technical-admin', { month: '2026-09', region: 'US', q: 'FBA-Alpha', page: 2, pageSize: 20 });
  });

  it('preserves queries without a search and accepts the 200-character boundary', async () => {
    expect((await app().request('/api/v1/batch-reports')).status).toBe(200);
    expect(state.report).toHaveBeenLastCalledWith('technical-admin', { region: 'all', page: 1, pageSize: 50 });
    expect((await app().request('/api/v1/batch-reports?q=' + 'A'.repeat(200))).status).toBe(200);
    expect(state.report).toHaveBeenLastCalledWith('technical-admin', { region: 'all', q: 'A'.repeat(200), page: 1, pageSize: 50 });
  });

  it('rejects overlong searches before reading report data', async () => {
    const response = await app().request('/api/v1/batch-reports?q=' + 'A'.repeat(201));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(state.report).not.toHaveBeenCalled();
  });

  it('passes shared workspace identity filters with group and month scope', async () => {
    const weeklyBatchId = '271ad5d0-ccbd-44eb-b402-5538426c1df3', subBatchId = 'c8ed63cb-5413-4ac5-aa0a-8aa2e881a070';
    const params = new URLSearchParams({ month: '2026-09', weekStartDate: '2026-09-07', weeklyBatchId, subBatchId, sid: '11', country: ' 美国 ', channel: ' HY ', region: 'US' });
    const response = await app().request(`/api/v1/batch-reports?${params}`);
    expect(response.status).toBe(200);
    expect(state.report).toHaveBeenCalledExactlyOnceWith('technical-admin', { month: '2026-09', weekStartDate: '2026-09-07', weeklyBatchId, subBatchId, sid: 11, country: '美国', channel: 'HY', region: 'US', page: 1, pageSize: 50 });
  });

  it('passes an explicit shipping-run scope and rejects invalid run identifiers', async () => {
    const shippingRunId = '329243cc-f37c-45d9-ac72-69fd0f1df1fa';
    expect((await app().request(`/api/v1/batch-reports?shippingRunId=${shippingRunId}`)).status).toBe(200);
    expect(state.report).toHaveBeenLastCalledWith('technical-admin', { shippingRunId, region: 'all', page: 1, pageSize: 50 });
    state.report.mockClear();
    expect((await app().request('/api/v1/batch-reports?shippingRunId=bad')).status).toBe(422);
    expect(state.report).not.toHaveBeenCalled();
  });

  it.each(['weekStartDate=2026-02-30', 'weekStartDate=2026-9-7', 'sid=0', 'sid=11.5', 'sid=bad', 'country=%20%20', 'channel=%20%20', `country=${'a'.repeat(121)}`, `channel=${'a'.repeat(121)}`])('rejects invalid workspace filter %s before reading report data', async (query) => {
    const response = await app().request(`/api/v1/batch-reports?${query}`);
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(state.report).not.toHaveBeenCalled();
  });
});
