import { describe, expect, it, vi, beforeEach } from 'vitest';
import { financePolicy } from '../finance/domain.js';
import { readConfig } from '../../config.js';
import { workflowPolicies } from './registry.js';

const state = vi.hoisted(() => ({ session: null as null | { user: { id: string; role: string; banned: boolean } } }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: async () => state.session } } }));
vi.mock('./service.js', () => ({ listWorkflowRecords: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })), getWorkflowDetail: vi.fn(), listWorkflowSources: vi.fn(), writeWorkflow: vi.fn() }));
import { createWorkflowRoutes } from './routes.js';
import { getWorkflowDetail, listWorkflowRecords, writeWorkflow } from './service.js';

describe('workflow HTTP access boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); state.session = { user: { id: 'synthetic-admin', role: 'admin', banned: false } }; });
  it.each(['fulfillment', 'logistics', 'customs', 'archive'] as const)('closes every %s endpoint before payload parsing, services or queue access', async (kind) => {
    const boss = vi.fn(() => null), routes = createWorkflowRoutes(workflowPolicies[kind], boss);
    const id = '00000000-0000-4000-8000-000000000001';
    for (const [method, path] of [['GET', '/'], ['GET', `/${id}`], ['POST', '/'], ['PUT', `/${id}`], ['POST', `/${id}/actions`], ['POST', `/${id}/exports`]]) {
      const response = await routes.request(path!, { method, ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: '{malformed' } : {}) });
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: { code: 'FEATURE_UNDER_MAINTENANCE', message: '（待维护）' } });
    }
    expect(listWorkflowRecords).not.toHaveBeenCalled(); expect(getWorkflowDetail).not.toHaveBeenCalled(); expect(writeWorkflow).not.toHaveBeenCalled(); expect(boss).not.toHaveBeenCalled();
  });
  it('keeps authentication and origin checks ahead of maintenance responses', async () => {
    const routes = createWorkflowRoutes(workflowPolicies.fulfillment, () => null);
    state.session = null; expect((await routes.request('/')).status).toBe(401);
    state.session = { user: { id: 'synthetic-admin', role: 'admin', banned: true } }; expect((await routes.request('/')).status).toBe(403);
    state.session.user.banned = false;
    expect((await routes.request('/', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' } })).status).toBe(403);
  });
  it('keeps finance records available', async () => {
    const response = await createWorkflowRoutes(financePolicy, () => null).request('/');
    expect(response.status).toBe(200); expect(listWorkflowRecords).toHaveBeenCalledOnce();
  });
  it('does not expose business records without a session', async () => {
    state.session = null; const response = await createWorkflowRoutes(financePolicy, () => null).request('/'); expect(response.status).toBe(401);
  });
  it('rejects disabled and non-admin sessions', async () => {
    state.session!.user.banned = true; expect((await createWorkflowRoutes(financePolicy, () => null).request('/')).status).toBe(403);
    state.session!.user.banned = false; state.session!.user.role = 'viewer'; expect((await createWorkflowRoutes(financePolicy, () => null).request('/')).status).toBe(403);
  });
  it('rejects cross-origin mutations before handling payloads', async () => {
    const response = await createWorkflowRoutes(financePolicy, () => null).request('/', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: '{}' }); expect(response.status).toBe(403);
  });
  it('reports invalid operation envelopes without executing a mutation', async () => {
    const response = await createWorkflowRoutes(financePolicy, () => null).request('/', { method: 'POST', headers: { Origin: new URL(readConfig().WEB_ORIGIN).origin, 'Content-Type': 'application/json' }, body: '{}' }); expect(response.status).toBe(422);
  });
  it('requires a queue instead of claiming an export succeeded', async () => {
    const response = await createWorkflowRoutes(financePolicy, () => null).request('/00000000-0000-4000-8000-000000000001/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); expect(response.status).toBe(503);
  });
});
