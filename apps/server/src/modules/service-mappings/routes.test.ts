import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), actor: vi.fn(), list: vi.fn(), options: vi.fn(), create: vi.fn(), revise: vi.fn(), remove: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock('../../config.js', () => ({ readConfig: () => ({ WEB_ORIGIN: 'http://localhost:5173', BETTER_AUTH_URL: 'http://localhost:3001' }) }));
vi.mock('../../db/client.js', () => ({ db: { transaction: async (action: (tx: unknown) => unknown) => action({}) } }));
vi.mock('../batches/service.js', () => ({ requireBatchActor: mocks.actor, BatchError: class extends Error { constructor(public code: string, public status: number, message: string, public details?: unknown) { super(message); } } }));
vi.mock('./service.js', () => ({ listServiceMappings: mocks.list, getServiceMappingOptions: mocks.options, createServiceMapping: mocks.create, reviseServiceMapping: mocks.revise, deleteServiceMapping: mocks.remove }));
import { createServiceMappingRoutes } from './routes.js';
import { BatchError } from '../batches/service.js';
const app = () => new Hono().route('/api/v1/service-mappings', createServiceMappingRoutes());
const write = (server: Hono, path: string, body: unknown, headers = {}) => server.request(`/api/v1/service-mappings${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.session.mockResolvedValue({ user: { id: 'admin', role: 'admin', banned: false } }); mocks.actor.mockResolvedValue({});
  mocks.list.mockResolvedValue({ items: [] }); mocks.options.mockResolvedValue({ countries: { status: 'unavailable', items: [] }, transportMethods: { status: 'unavailable', items: [] } });
  mocks.create.mockResolvedValue({ mapping: {}, replayed: false }); mocks.revise.mockResolvedValue({ mapping: {}, replayed: false }); mocks.remove.mockResolvedValue({ mapping: {}, replayed: false });
});
describe('service mapping authenticated HTTP API', () => {
  it('reads list and independent directory status using a validated active administrator', async () => {
    const server = app();
    expect((await server.request('/api/v1/service-mappings')).status).toBe(200);
    expect((await server.request('/api/v1/service-mappings/options')).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith('admin'); expect(mocks.options).toHaveBeenCalledWith('admin');
    expect(mocks.actor).toHaveBeenCalledTimes(2);
  });
  it('routes strict create, revision and soft delete bodies with operation and expected version', async () => {
    const server = app(), id = randomUUID(), input = { operationId: randomUUID(), countryCode: 'us', transportMethod: '自定义运输方式', service: '手写服务' };
    expect((await write(server, '', input)).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith('admin', { ...input, countryCode: 'US' });
    expect((await write(server, `/${id}/revisions`, { ...input, expectedVersion: 3 })).status).toBe(200);
    expect(mocks.revise).toHaveBeenCalledWith(id, 'admin', { ...input, countryCode: 'US', expectedVersion: 3 });
    const remove = { operationId: randomUUID(), expectedVersion: 4 };
    expect((await write(server, `/${id}/delete`, remove)).status).toBe(200); expect(mocks.remove).toHaveBeenCalledWith(id, 'admin', remove);
    expect((await write(server, `/${id}/delete`, { ...remove, expectedVersion: 0 })).status).toBe(422);
    expect((await write(server, '/bad-id/revisions', { ...input, expectedVersion: 1 })).status).toBe(422);
    expect((await write(server, '', { ...input, enabled: true })).status).toBe(422);
  });
  it('rejects missing, disabled and non-administrator sessions before reading or writing', async () => {
    const server = app();
    for (const [session, status] of [[null, 401], [{ user: { id: 'admin', role: 'admin', banned: true } }, 403], [{ user: { id: 'viewer', role: 'user' } }, 403]] as const) {
      mocks.session.mockResolvedValueOnce(session); expect((await server.request('/api/v1/service-mappings')).status).toBe(status);
    }
    mocks.actor.mockRejectedValueOnce(new BatchError('FORBIDDEN', 403, '管理员已停用'));
    expect((await server.request('/api/v1/service-mappings/options')).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.options).not.toHaveBeenCalled();
  });
  it('enforces same-origin and JSON writes, including Sec-Fetch-Site and request size', async () => {
    const server = app(), input = { operationId: randomUUID(), countryCode: 'US', transportMethod: '海运', service: '服务' };
    expect((await write(server, '', input, { Origin: 'https://untrusted.invalid' })).status).toBe(403);
    expect((await write(server, '', input, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await write(server, '', input, { 'Content-Type': 'text/plain' })).status).toBe(422);
    expect((await write(server, '', { ...input, service: 'x'.repeat(70_000) })).status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('preserves actionable duplicate and version conflicts with current protocol error codes', async () => {
    const server = app(), input = { operationId: randomUUID(), countryCode: 'US', transportMethod: '海运', service: '服务' };
    mocks.create.mockRejectedValueOnce(new BatchError('SERVICE_MAPPING_DUPLICATE', 409, '该组合已维护服务'));
    const duplicate = await write(server, '', input);
    expect(duplicate.status).toBe(409); expect(await duplicate.json()).toMatchObject({ error: { code: 'SERVICE_MAPPING_DUPLICATE' } });
    mocks.revise.mockRejectedValueOnce(new BatchError('VERSION_CONFLICT', 409, '请重新读取'));
    expect((await write(server, `/${randomUUID()}/revisions`, { ...input, expectedVersion: 1 })).status).toBe(409);
  });
});
