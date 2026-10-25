import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ session: vi.fn(), workspace: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('./workspace.js', () => ({ getBatchWorkspace: state.workspace }));
vi.mock('./service.js', () => ({ BatchError: class extends Error {
  constructor(public code: string, public status: number, message: string, public details?: unknown) { super(message); }
} }));
import { createBatchWorkspaceRoutes } from './routes.js';

beforeEach(() => {
  state.session.mockReset().mockResolvedValue({ user: { id: 'technical-admin', role: 'admin', banned: false } });
  state.workspace.mockReset().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } });
});
const app = () => new Hono().route('/api/v1/batches', createBatchWorkspaceRoutes());
describe('GET /batches/workspace', () => {
  it('returns a no-store metadata list with parsed default paging', async () => {
    const response = await app().request('/api/v1/batches/workspace');
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ rows: [], page: 1, pageSize: 20, availableWeeks: [] });
    expect(state.workspace).toHaveBeenCalledExactlyOnceWith('technical-admin', { page: 1, pageSize: 20 });
  });
  it('passes every supported filter and accepts a cross-year inclusive range', async () => {
    const response = await app().request('/api/v1/batches/workspace?month=2026-12&weekFrom=2026-12-28&weekTo=2027-01-03&sid=11&country=US&channel=HY&status=draft&q=FBA111&page=2&pageSize=50');
    expect(response.status).toBe(200);
    expect(state.workspace).toHaveBeenCalledWith('technical-admin', { month: '2026-12', weekFrom: '2026-12-28', weekTo: '2027-01-03', sid: 11, country: 'US', channel: 'HY', status: 'draft', q: 'FBA111', page: 2, pageSize: 50 });
  });
  it.each(['weekFrom=2027-01-01&weekTo=2026-12-31', 'weekTo=2026-02-30', 'pageSize=100', 'sid=0', 'status=superseded', 'month=2026-13'])('rejects invalid query %s before querying data', async (query) => {
    const response = await app().request(`/api/v1/batches/workspace?${query}`);
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(state.workspace).not.toHaveBeenCalled();
  });
  it('requires a current unbanned administrator', async () => {
    state.session.mockResolvedValueOnce(null);
    expect((await app().request('/api/v1/batches/workspace')).status).toBe(401);
    state.session.mockResolvedValueOnce({ user: { id: 'technical-admin', role: 'admin', banned: true } });
    expect((await app().request('/api/v1/batches/workspace')).status).toBe(403);
    state.session.mockResolvedValueOnce({ user: { id: 'technical-viewer', role: 'viewer', banned: false } });
    expect((await app().request('/api/v1/batches/workspace')).status).toBe(403);
    expect(state.workspace).not.toHaveBeenCalled();
  });
});
