import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_DRAFT_MAX_BODY_BYTES, IMPORT_DRAFT_MAX_FILE_BYTES } from '@scm/contracts';

const state = vi.hoisted(() => ({ session: vi.fn(), list: vi.fn(), get: vi.fn(), save: vi.fn(), remove: vi.fn(), boss: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('./drafts.js', () => ({ listImportDrafts: state.list, getImportDraft: state.get, saveImportDraft: state.save, deleteImportDraft: state.remove }));
import { createImportRoutes } from './routes.js';

const app = () => new Hono().route('/api/v1/imports', createImportRoutes(state.boss));
const url = (path = '') => `/api/v1/imports/drafts${path}`;
const input = () => ({ expectedVersion: 0, title: '未提交草稿', content: { source: 'online', progress: { source: 'online', importId: null }, online: { rows: [{ fba: '' }], startDate: '', endDate: '' } } });
beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset();
  state.session.mockResolvedValue({ user: { id: 'draft-owner', role: 'admin', banned: false } });
  state.boss.mockReturnValue(null);
  state.list.mockResolvedValue({ items: [], total: 0 }); state.get.mockResolvedValue({ id: 'draft-result' });
  state.save.mockImplementation(async (_id, value) => ({ draft: value, replayed: false })); state.remove.mockResolvedValue({ deleted: true });
});
describe('import draft routes', () => {
  it('requires an authenticated active administrator before accessing a draft service', async () => {
    state.session.mockResolvedValueOnce(null);
    expect((await app().request(url())).status).toBe(401);
    state.session.mockResolvedValueOnce({ user: { id: 'draft-owner', role: 'admin', banned: true } });
    expect((await app().request(url())).status).toBe(403);
    expect(state.list).not.toHaveBeenCalled();
  });
  it('matches list/detail/save/delete routes and never requires a queue', async () => {
    const id = randomUUID(), server = app();
    expect(await (await server.request(url('?q=FBA&page=2&pageSize=5'))).json()).toEqual({ items: [], total: 0 });
    expect(state.list).toHaveBeenCalledWith('draft-owner', { q: 'FBA', page: 2, pageSize: 5 });
    expect(await (await server.request(url(`/${id}`))).json()).toEqual({ draft: { id: 'draft-result' } });
    const response = await server.request(url(`/${id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input()) });
    expect(response.status).toBe(200); expect(state.save).toHaveBeenCalledWith(id, expect.objectContaining({ expectedVersion: 0 }), 'draft-owner');
    expect(await (await server.request(url(`/${id}?version=1`), { method: 'DELETE' })).json()).toEqual({ deleted: true });
    expect(state.remove).toHaveBeenCalledWith(id, 1, 'draft-owner'); expect(state.boss).not.toHaveBeenCalled();
  });
  it('rejects cross-site PUT and DELETE before saving or deleting data', async () => {
    const id = randomUUID(), server = app();
    for (const method of ['PUT', 'DELETE']) {
      const response = await server.request(url(`/${id}?version=1`), { method, headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' }, ...(method === 'PUT' ? { body: JSON.stringify(input()) } : {}) });
      expect(response.status).toBe(403);
    }
    expect(state.save).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
  });
  it('rejects invalid identifiers, missing deletion versions and malformed input', async () => {
    const server = app(), id = randomUUID();
    expect((await server.request(url('/not-a-uuid'))).status).toBe(422);
    expect((await server.request(url(`/${id}`), { method: 'DELETE' })).status).toBe(422);
    expect((await server.request(url(`/${id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input(), title: '' }) })).status).toBe(422);
    expect(state.save).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
  });
  it('allows a full ten MiB file encoded as Base64 and enforces the twenty MiB draft body limit', async () => {
    const id = randomUUID(), server = app();
    const fileContent = { source: 'file', progress: { source: 'file', importId: null }, file: { name: '十兆.xlsx', type: '', lastModified: 0, base64: Buffer.alloc(IMPORT_DRAFT_MAX_FILE_BYTES).toString('base64') } };
    const response = await server.request(url(`/${id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input(), content: fileContent }) });
    expect(response.status).toBe(200); expect(state.save).toHaveBeenCalledOnce();
    const oversized = await server.request(url(`/${id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(IMPORT_DRAFT_MAX_BODY_BYTES + 1) });
    expect(oversized.status).toBe(413); expect(state.save).toHaveBeenCalledOnce(); expect(state.boss).not.toHaveBeenCalled();
  });
});
