import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ session: vi.fn(), impact: vi.fn(), change: vi.fn(), recycle: vi.fn(), log: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('../../config.js', () => ({ readConfig: () => ({ BETTER_AUTH_URL: 'http://localhost:3001', WEB_ORIGIN: 'http://localhost:5173' }) }));
vi.mock('../../errors.js', () => ({ logError: state.log }));
vi.mock('./service.js', () => ({ getShippingLifecycleImpact: state.impact, changeShippingLifecycle: state.change, listShippingRecycleBin: state.recycle }));
vi.mock('../batches/service.js', () => ({ BatchError: class extends Error { constructor(public code: string, public status: number, message: string, public details?: unknown) { super(message); } } }));
import { BatchError } from '../batches/service.js';
import { createShippingLifecycleRoutes } from './routes.js';

const app = () => new Hono().route('/api/v1', createShippingLifecycleRoutes()).get('/api/v1/session', (c) => c.json({ user: null }));
const input = () => ({ operationId: randomUUID(), expectedVersion: 7, reason: '核对取消范围', impactToken: 'a'.repeat(64) });
const post = (value: unknown, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset();
  state.session.mockResolvedValue({ user: { id: 'admin', role: 'admin', banned: false } });
  state.impact.mockResolvedValue({ canExecute: true });
  state.change.mockResolvedValue({ pending: false });
  state.recycle.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
});

describe('shipping lifecycle HTTP boundaries', () => {
  it.each([['shipping-runs', 'run'], ['sub-batches', 'group'], ['demands', 'demand']])('routes %s previews and all four mutations with exact versioned payloads', async (resource, type) => {
    const api = app(), id = randomUUID();
    expect((await api.request(`/api/v1/${resource}/${id}/lifecycle-impact?action=cancel`)).status).toBe(200);
    expect(state.impact).toHaveBeenCalledWith(type, id, 'cancel', 'admin');
    for (const action of ['cancel', 'trash', 'restore', 'purge']) {
      const payload = input(), response = await api.request(`/api/v1/${resource}/${id}/lifecycle/${action}`, post(payload));
      expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(state.change).toHaveBeenLastCalledWith(type, id, action, payload, 'admin');
    }
  });
  it('returns 202 for a durably accepted stop without requiring queue access', async () => {
    state.change.mockResolvedValue({ pending: true });
    expect((await app().request(`/api/v1/shipping-runs/${randomUUID()}/lifecycle/cancel`, post(input()))).status).toBe(202);
  });
  it('does not apply lifecycle authentication to unrelated session routes', async () => {
    state.session.mockResolvedValue(null);
    expect(await (await app().request('/api/v1/session')).json()).toEqual({ user: null });
    expect(state.session).not.toHaveBeenCalled();
  });
  it.each([null, { user: { id: 'viewer', role: 'viewer' } }, { user: { id: 'blocked', role: 'admin', banned: true } }])('rejects unauthorized actors before reading business data', async (session) => {
    state.session.mockResolvedValue(session);
    const result = await app().request(`/api/v1/demands/${randomUUID()}/lifecycle-impact?action=trash`);
    expect(result.status).toBe(session ? 403 : 401); expect(state.impact).not.toHaveBeenCalled();
  });
  it.each([{ Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }])('rejects cross-site writes', async (headers) => {
    expect((await app().request(`/api/v1/demands/${randomUUID()}/lifecycle/trash`, post(input(), headers))).status).toBe(403);
    expect(state.change).not.toHaveBeenCalled();
  });
  it('validates identifiers, actions, versions, impact tokens, reasons and JSON bodies', async () => {
    const api = app(), id = randomUUID(), endpoint = `/api/v1/demands/${id}/lifecycle/trash`;
    for (const payload of [{ ...input(), expectedVersion: 0 }, { ...input(), reason: '' }, { ...input(), impactToken: '' }, { ...input(), extra: true }]) expect((await api.request(endpoint, post(payload))).status).toBe(422);
    expect((await api.request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(422);
    expect((await api.request(`/api/v1/demands/${id}/lifecycle/unknown`, post(input()))).status).toBe(422);
    expect((await api.request('/api/v1/demands/invalid/lifecycle-impact?action=cancel')).status).toBe(422);
    expect(state.change).not.toHaveBeenCalled();
  });
  it('validates and paginates the recycle bin', async () => {
    expect((await app().request('/api/v1/shipping-recycle-bin?type=group&q=FBA&page=2&pageSize=20')).status).toBe(200);
    expect(state.recycle).toHaveBeenCalledWith('admin', { type: 'group', q: 'FBA', page: 2, pageSize: 20 });
    expect((await app().request('/api/v1/shipping-recycle-bin?type=other')).status).toBe(422);
  });
  it('preserves conflict details and keeps unexpected failures private', async () => {
    state.change.mockRejectedValueOnce(new BatchError('SHIPPING_RESTORE_CONFLICT', 409, '存在占用冲突', { conflicts: [{ fba: 'FBA123' }] }));
    const endpoint = `/api/v1/demands/${randomUUID()}/lifecycle/restore`;
    expect(await (await app().request(endpoint, post(input()))).json()).toMatchObject({ error: { code: 'SHIPPING_RESTORE_CONFLICT', details: { conflicts: [{ fba: 'FBA123' }] } } });
    state.change.mockRejectedValueOnce(new Error('private database details'));
    const failure = await app().request(endpoint, post(input())); expect(failure.status).toBe(500); expect(await failure.text()).not.toContain('private database details');
  });
});
