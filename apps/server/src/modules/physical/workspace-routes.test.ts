import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ session: vi.fn(), workspace: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('./workspace.js', () => ({ getPhysicalWorkspace: state.workspace }));
vi.mock('../batches/service.js', () => ({ BatchError: class extends Error { constructor(public code: string, public status: number, message: string) { super(message); } } }));
import { createPhysicalWorkspaceRoutes } from './workspace-routes.js';
const app = () => new Hono().route('/api/v1/physical-reviews', createPhysicalWorkspaceRoutes());
beforeEach(() => {
  state.session.mockReset().mockResolvedValue({ user: { id: 'admin', role: 'admin', banned: false } });
  state.workspace.mockReset().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 20, filters: { weeks: [], shops: [], countries: [], channels: [] } });
});
describe('GET /physical-reviews', () => {
  it('parses all list filters and responds without caching', async () => {
    const response = await app().request('/api/v1/physical-reviews?weekFrom=2026-10-19&weekTo=2026-10-25&sid=11&country=US&channel=SEA&status=stale&q=FBA&page=2&pageSize=50');
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(state.workspace).toHaveBeenCalledExactlyOnceWith('admin', { weekFrom: '2026-10-19', weekTo: '2026-10-25', sid: 11, country: 'US', channel: 'SEA', status: 'stale', q: 'FBA', page: 2, pageSize: 50 });
  });
  it('rejects invalid ranges without reading records', async () => {
    const response = await app().request('/api/v1/physical-reviews?weekFrom=2026-10-26&weekTo=2026-10-19');
    expect(response.status).toBe(422); expect(state.workspace).not.toHaveBeenCalled();
  });
  it('requires a current active administrator', async () => {
    state.session.mockResolvedValueOnce(null); expect((await app().request('/api/v1/physical-reviews')).status).toBe(401);
    state.session.mockResolvedValueOnce({ user: { id: 'admin', role: 'admin', banned: true } }); expect((await app().request('/api/v1/physical-reviews')).status).toBe(403);
    state.session.mockResolvedValueOnce({ user: { id: 'viewer', role: 'viewer', banned: false } }); expect((await app().request('/api/v1/physical-reviews')).status).toBe(403);
    expect(state.workspace).not.toHaveBeenCalled();
  });
});
