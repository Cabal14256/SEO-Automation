import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ session: vi.fn(), create: vi.fn(), get: vi.fn(), list: vi.fn(), retry: vi.fn(), manual: vi.fn(), addTicket: vi.fn(), append: vi.fn(), correction: vi.fn(), log: vi.fn() }));
vi.mock('../../auth.js', () => ({ auth: { api: { getSession: state.session } } }));
vi.mock('../../config.js', () => ({ readConfig: () => ({ BETTER_AUTH_URL: 'http://localhost:3001', WEB_ORIGIN: 'http://localhost:5173' }) }));
vi.mock('../../errors.js', () => ({ logError: state.log }));
vi.mock('./service.js', () => ({ createShippingRun: state.create, getShippingRun: state.get, listShippingRuns: state.list, retryShippingRun: state.retry }));
vi.mock('./manual.js', () => ({ createManualShippingRun: state.manual, addShippingTicket: state.addTicket, appendShippingTicketMembers: state.append, correctShippingRun: state.correction }));
vi.mock('../batches/service.js', () => ({ BatchError: class extends Error {
  constructor(public code: string, public status: number, message: string, public details?: unknown) { super(message); }
} }));
import { BatchError } from '../batches/service.js';
import { createShippingRunRoutes } from './routes.js';

const boss = { name: 'isolated-test-queue' } as unknown as PgBoss;
const app = (queueAvailable = true) => new Hono().route('/api/v1/shipping-runs', createShippingRunRoutes(() => queueAvailable ? boss : null));
const createInput = () => ({ operationId: randomUUID(), importId: randomUUID(), parseRunId: randomUUID() });
const post = (payload: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
beforeEach(() => {
  state.session.mockReset().mockResolvedValue({ user: { id: 'technical-admin', role: 'admin', banned: false } });
  state.create.mockReset().mockResolvedValue({ run: { id: 'created-run', status: 'queued' }, tickets: [], issues: [] });
  state.get.mockReset().mockResolvedValue({ run: { status: 'needs_review' }, tickets: [], issues: [] });
  state.list.mockReset().mockResolvedValue({ items: [] });
  state.retry.mockReset().mockResolvedValue({ run: { status: 'queued' }, tickets: [], issues: [] });
  for (const mock of [state.manual, state.addTicket, state.append, state.correction]) mock.mockReset().mockResolvedValue({ run: { status: 'draft' }, tickets: [], issues: [] });
  state.log.mockReset();
});

describe('shipping-run HTTP interfaces', () => {
  it('creates an explicitly selected manual occurrence without requiring a background queue', async () => {
    const id = randomUUID(), input = { operationId: randomUUID(), numberingDate: '2026-10-24', name: '人工发货', reason: '核对通过', demandIds: [id], expectedDemandVersions: { [id]: 2 } };
    const response = await app(false).request('/api/v1/shipping-runs/manual', post(input));
    expect(response.status).toBe(201); expect(state.manual).toHaveBeenCalledExactlyOnceWith(input, 'technical-admin');
  });
  it('routes additive ticket membership and explicit arrangement correction with their versions', async () => {
    const runId = randomUUID(), ticketId = randomUUID(), id = randomUUID();
    const common = { operationId: randomUUID(), expectedVersion: 3, reason: '核对通过', demandIds: [id], expectedDemandVersions: { [id]: 1 } };
    const ticket = { ...common, name: '第二票' };
    expect((await app().request(`/api/v1/shipping-runs/${runId}/tickets`, post(ticket))).status).toBe(201);
    expect(state.addTicket).toHaveBeenCalledExactlyOnceWith(runId, ticket, 'technical-admin');
    const members = { ...common, groupId: randomUUID(), expectedGroupVersion: 2 };
    expect((await app().request(`/api/v1/shipping-runs/${runId}/tickets/${ticketId}/members`, post(members))).status).toBe(200);
    expect(state.append).toHaveBeenCalledExactlyOnceWith(runId, ticketId, members, 'technical-admin');
    const correction = { operationId: randomUUID(), expectedVersion: 5, reason: '修正成员安排' };
    expect((await app().request(`/api/v1/shipping-runs/${runId}/correction`, post(correction))).status).toBe(200);
    expect(state.correction).toHaveBeenCalledExactlyOnceWith(runId, correction, 'technical-admin');
  });
  it('rejects duplicate manual members and a historical binding without its version', async () => {
    const id = randomUUID(), input = { operationId: randomUUID(), name: '人工发货', reason: '核对', demandIds: [id, id], expectedDemandVersions: { [id]: 1 } };
    expect((await app().request('/api/v1/shipping-runs/manual', post(input))).status).toBe(422);
    expect((await app().request('/api/v1/shipping-runs/manual', post({ ...input, demandIds: [id], existingGroupId: randomUUID() }))).status).toBe(422);
    expect(state.manual).not.toHaveBeenCalled();
  });
  it('reads the local list and one run with the authenticated actor and no-store responses', async () => {
    const runId = randomUUID(), api = app();
    const list = await api.request('/api/v1/shipping-runs');
    expect(list.status).toBe(200); expect(await list.json()).toEqual({ items: [] });
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    expect(state.list).toHaveBeenCalledExactlyOnceWith('technical-admin', 'active');
    const detail = await api.request(`/api/v1/shipping-runs/${runId}`);
    expect(detail.status).toBe(200); expect(detail.headers.get('Cache-Control')).toBe('no-store');
    expect(state.get).toHaveBeenCalledExactlyOnceWith(runId, 'technical-admin');
  });

  it('creates a run with the exact source, operation and optional numbering date', async () => {
    const input = { ...createInput(), numberingDate: '2026-10-23' };
    const response = await app().request('/api/v1/shipping-runs', post(input, { Origin: 'http://localhost:5173' }));
    expect(response.status).toBe(202);
    expect(state.create).toHaveBeenCalledExactlyOnceWith(boss, input, 'technical-admin');
    expect(await response.json()).toMatchObject({ run: { status: 'queued' } });
    const withoutDate = createInput();
    expect((await app().request('/api/v1/shipping-runs', post(withoutDate))).status).toBe(202);
    expect(state.create).toHaveBeenLastCalledWith(boss, withoutDate, 'technical-admin');
  });

  it('retries with the saved run version and permits a new source only together with its parse ID', async () => {
    const runId = randomUUID(), input = { operationId: randomUUID(), expectedVersion: 5, importId: randomUUID(), parseRunId: randomUUID() };
    const response = await app().request(`/api/v1/shipping-runs/${runId}/retry`, post(input));
    expect(response.status).toBe(202); expect(state.retry).toHaveBeenCalledExactlyOnceWith(boss, runId, input, 'technical-admin');
  });

  it.each([
    { numberingDate: '2026-02-30' }, { numberingDate: '2026-13-01' }, { numberingDate: '2026-1-01' },
    { operationId: 'bad' }, { importId: 'bad' }, { parseRunId: undefined }, { expectedVersion: 1 },
  ])('rejects invalid create data %o before invoking the service', async (change) => {
    const response = await app().request('/api/v1/shipping-runs', post({ ...createInput(), ...change }));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each([
    { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: '5' }, { operationId: 'bad' },
    { importId: '329243cc-f37c-45d9-ac72-69fd0f1df1fa' }, { parseRunId: 'bad' }, { numberingDate: '2026-10-23' },
  ])('rejects invalid retry data %o before invoking the service', async (change) => {
    const response = await app().request(`/api/v1/shipping-runs/${randomUUID()}/retry`, post({ operationId: randomUUID(), expectedVersion: 5, ...change }));
    expect(response.status).toBe(422); expect(state.retry).not.toHaveBeenCalled();
  });

  it('validates path IDs and malformed JSON without reaching business operations', async () => {
    const api = app();
    expect((await api.request('/api/v1/shipping-runs/not-a-uuid')).status).toBe(422);
    expect((await api.request('/api/v1/shipping-runs/not-a-uuid/retry', post({ operationId: randomUUID(), expectedVersion: 1 }))).status).toBe(422);
    expect((await api.request('/api/v1/shipping-runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status).toBe(422);
    expect(state.get).not.toHaveBeenCalled(); expect(state.retry).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
  });

  it.each([
    [null, 401], [{ user: { id: 'banned-admin', role: 'admin', banned: true } }, 403], [{ user: { id: 'viewer', role: 'viewer', banned: false } }, 403],
  ])('requires an unbanned administrator for reads and writes (%s)', async (session, status) => {
    state.session.mockResolvedValue(session);
    const api = app();
    expect((await api.request('/api/v1/shipping-runs')).status).toBe(status);
    expect((await api.request('/api/v1/shipping-runs', post(createInput()))).status).toBe(status);
    expect(state.list).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
  });

  it.each([{ Origin: 'https://external.invalid' }, { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'cross-site' }])('rejects untrusted write origins %o', async (headers) => {
    const response = await app().request('/api/v1/shipping-runs', post(createInput(), headers));
    expect(response.status).toBe(403); expect(state.create).not.toHaveBeenCalled();
  });

  it('reports an unavailable queue without pretending to create or retry a run', async () => {
    const api = app(false);
    const response = await api.request('/api/v1/shipping-runs', post(createInput()));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: 'QUEUE_UNAVAILABLE' } });
    expect((await api.request(`/api/v1/shipping-runs/${randomUUID()}/retry`, post({ operationId: randomUUID(), expectedVersion: 1 }))).status).toBe(503);
    expect(state.create).not.toHaveBeenCalled(); expect(state.retry).not.toHaveBeenCalled();
  });

  it('preserves a business conflict status and existing-run reference for recovery', async () => {
    const runId = randomUUID();
    state.create.mockRejectedValue(new BatchError('SHIPPING_IMPORT_ALREADY_USED', 409, '请打开原记录', { runId }));
    const response = await app().request('/api/v1/shipping-runs', post(createInput()));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'SHIPPING_IMPORT_ALREADY_USED', message: '请打开原记录', details: { runId } } });
    expect(state.log).not.toHaveBeenCalled();
  });

  it('logs unexpected failures while returning a generic retryable error to the client', async () => {
    const internal = new Error('FAKE_INTERNAL_DETAIL'); state.get.mockRejectedValue(internal);
    const response = await app().request(`/api/v1/shipping-runs/${randomUUID()}`), payload = await response.text();
    expect(response.status).toBe(500); expect(payload).toContain('INTERNAL_ERROR'); expect(payload).not.toContain('FAKE_INTERNAL_DETAIL');
    expect(state.log).toHaveBeenCalledExactlyOnceWith('Shipping run API failed', internal);
  });

  it('rejects oversized JSON without invoking a business operation', async () => {
    const response = await app().request('/api/v1/shipping-runs', post({ ...createInput(), padding: 'x'.repeat(65_536) }));
    expect(response.status).toBe(413); expect(state.create).not.toHaveBeenCalled();
  });
});
