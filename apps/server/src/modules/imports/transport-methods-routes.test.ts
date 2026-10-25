import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ session: vi.fn(), methods: vi.fn(), boss: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('./transport-methods.js', () => ({ getTransportMethods: state.methods }));
import { createImportRoutes } from './routes.js';
import { LingxingReadError } from '../lingxing/read-client.js';
const app = () => new Hono().route('/api/v1/imports', createImportRoutes(state.boss));
const path = '/api/v1/imports/transport-methods';
beforeEach(() => {
  vi.resetAllMocks();
  state.session.mockResolvedValue({ user: { id: 'test-admin', role: 'admin', banned: false } });
  state.methods.mockResolvedValue({ items: [], queriedAt: '2026-10-24T10:00:00.000Z' });
});
describe('transport method read route', () => {
  it('requires an active administrator before querying Lingxing', async () => {
    for (const session of [null, { user: { id: 'test', role: 'viewer' } }, { user: { id: 'test', role: 'admin', banned: true } }]) {
      state.session.mockResolvedValueOnce(session);
      expect((await app().request(path)).status).toBe(session ? 403 : 401);
    }
    expect(state.methods).not.toHaveBeenCalled();
  });
  it('serves the dictionary without a task queue and exposes a recoverable Lingxing error', async () => {
    const result = await app().request(path);
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ items: [] });
    expect(state.boss).not.toHaveBeenCalled();
    state.methods.mockRejectedValueOnce(new LingxingReadError('LINGXING_NETWORK_ERROR', '领星连接未完成，请重试。'));
    const failure = await app().request(path);
    expect(failure.status).toBe(503); expect(await failure.json()).toMatchObject({ error: { code: 'LINGXING_NETWORK_ERROR' } });
  });
});
