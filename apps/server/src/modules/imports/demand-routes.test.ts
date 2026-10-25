import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ session: vi.fn(), detail: vi.fn(), management: vi.fn(), revise: vi.fn(), cancel: vi.fn(), workspace: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('./confirmation.js', () => ({ getDemandDetail: state.detail }));
vi.mock('./demand-management.js', () => ({ getDemandManagement: state.management, reviseDemand: state.revise, cancelDemand: state.cancel }));
vi.mock('./workspace.js', () => ({ getDemandWorkspace: state.workspace }));
import { createDemandRoutes } from './routes.js';

const app = () => new Hono().route('/api/v1/demands', createDemandRoutes());
const headers = { 'Content-Type': 'application/json' };
beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset();
  state.session.mockResolvedValue({ user: { id: 'admin', role: 'admin', banned: false } });
  state.detail.mockResolvedValue({ demand: { id: 'retained' }, revisions: [], sources: [] });
  state.management.mockResolvedValue({ management: { lifecycle: 'active', canEdit: true, canDelete: true, reason: null, groupId: null, batchId: null }, operations: [] });
  state.workspace.mockResolvedValue({ rows: [], total: 0 }); state.revise.mockResolvedValue({ demand: { version: 2 }, replayed: false }); state.cancel.mockResolvedValue({ demand: { version: 3 }, replayed: false });
});
describe('demand management API', () => {
  it('returns original detail and source history together with current management permissions', async () => {
    const id = randomUUID(), response = await app().request(`/api/v1/demands/${id}`);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ demand: { id: 'retained' }, revisions: [], sources: [], management: { canEdit: true }, operations: [] });
    expect(state.detail).toHaveBeenCalledWith(id, 'admin'); expect(state.management).toHaveBeenCalledWith(id, 'admin');
  });
  it('passes lifecycle filters with safe active defaults and rejects invalid values', async () => {
    const server = app();
    expect((await server.request('/api/v1/demands')).status).toBe(200);
    expect(state.workspace).toHaveBeenCalledWith('admin', { lifecycle: 'active', page: 1, pageSize: 50 });
    expect((await server.request('/api/v1/demands?lifecycle=cancelled&q=%20FBA%20&page=2')).status).toBe(200);
    expect(state.workspace).toHaveBeenCalledWith('admin', { lifecycle: 'cancelled', q: 'FBA', page: 2, pageSize: 50 });
    expect((await server.request('/api/v1/demands?lifecycle=removed')).status).toBe(422); expect(state.workspace).toHaveBeenCalledTimes(2);
  });
  it('binds revisions and cancellation to current actor, version, operation and reason', async () => {
    const id = randomUUID(), input = { operationId: randomUUID(), expectedVersion: 1, reason: ' 核对后修订 ' }, server = app();
    expect((await server.request(`/api/v1/demands/${id}/revisions`, { method: 'POST', headers, body: JSON.stringify({ ...input, fields: { notes: ' 修改备注 ' } }) })).status).toBe(200);
    expect(state.revise).toHaveBeenCalledWith(id, 'admin', { ...input, reason: '核对后修订', fields: { notes: '修改备注' } });
    expect((await server.request(`/api/v1/demands/${id}/cancel`, { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(200);
    expect(state.cancel).toHaveBeenCalledWith(id, 'admin', { ...input, reason: '核对后修订' });
  });
  it('rejects identity edits, malformed JSON, missing version/reason and cross-site writes before mutation', async () => {
    const id = randomUUID(), input = { operationId: randomUUID(), expectedVersion: 1, reason: '修改' }, server = app();
    for (const body of [JSON.stringify({ ...input, fields: { sid: 2 } }), JSON.stringify({ ...input, fields: {} }), JSON.stringify({ operationId: input.operationId, fields: { notes: 'x' } }), '{bad']) {
      expect((await server.request(`/api/v1/demands/${id}/revisions`, { method: 'POST', headers, body })).status).toBe(422);
    }
    expect((await server.request(`/api/v1/demands/${id}/cancel`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' }, body: JSON.stringify(input) })).status).toBe(403);
    expect(state.revise).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled();
  });
  it('requires an authenticated active admin for detail and mutations', async () => {
    const id = randomUUID(), server = app(); state.session.mockResolvedValueOnce(null);
    expect((await server.request(`/api/v1/demands/${id}`)).status).toBe(401);
    state.session.mockResolvedValueOnce({ user: { id: 'user', role: 'user', banned: false } });
    expect((await server.request(`/api/v1/demands/${id}/cancel`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
    expect(state.detail).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled();
  });
});
