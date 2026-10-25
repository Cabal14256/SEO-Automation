import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import type { SellerMapping, SellerMappingRevisionInput } from '@scm/contracts';
import { auth } from './auth.js';
import { readConfig } from './config.js';
import { closeDatabase, db, pool } from './db/client.js';
import { operationAudit, sellerAliases, sellerMappingRevisions, sellerMappings, user } from './db/schema.js';
import { logError } from './errors.js';
import { MappingError, resolveApprovedSeller, reviseSellerMapping } from './modules/seller-mappings/service.js';

// Technical fixtures are isolated by UUID and removed after verification. Real
// seller candidates are never approved or changed by this acceptance command.
const config = readConfig();
assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_automation_dev', 'Use the dedicated development database');
const runId = randomUUID();
const root = fileURLToPath(new URL('../', import.meta.url));
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
const steps: Array<{ name: string; result: 'passed' | 'failed'; details?: Record<string, unknown> }> = [];
const fixtureIds: string[] = [randomUUID(), randomUUID(), randomUUID()];
const accountIds: string[] = [];
let api: ChildProcess | undefined;
let failed = false;
let currentStep = 'setup';
type Result<T> = { status: number; data: T; cookie: string };
type ErrorBody = { error: { code: string; traceId: string } };
type RevisionResult = { mapping: SellerMapping; replayed: boolean };
type List = { items: SellerMapping[]; total: number; page: number; pageSize: number };
const check = async (name: string, action: () => Promise<Record<string, unknown> | void>) => {
  currentStep = name;
  const details = await action();
  steps.push({ name, result: 'passed', ...(details ? { details } : {}) });
  console.log(`PASS ${name}`);
};

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

async function stopApi() {
  if (!api || api.exitCode !== null || api.signalCode !== null) return;
  const exited = new Promise<void>((done) => api!.once('exit', () => done()));
  api.kill('SIGTERM');
  await Promise.race([exited, delay(8_000)]);
  if (api.exitCode === null && api.signalCode === null) {
    api.kill('SIGKILL');
    await Promise.race([exited, delay(3_000)]);
  }
}

try {
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', BETTER_AUTH_URL: baseURL, WEB_ORIGIN: baseURL };
  async function request<T = ErrorBody>(path: string, cookie = '', method = 'GET', body?: unknown, origin = baseURL): Promise<Result<T>> {
    const response = await fetch(`${baseURL}/api/v1${path}`, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, data: await response.json() as T,
      cookie: response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') };
  }
  function startApi() {
    api = spawn(process.execPath, [resolve(root, 'dist/api.js')], { cwd: root, env, stdio: 'ignore', windowsHide: true });
    api.on('error', () => undefined);
  }
  async function waitForApi() {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await request('/health').then((value) => value.status === 200).catch(() => false)) return;
      await delay(200);
    }
    throw new Error('Acceptance API failed to start');
  }
  const protectedRows = await db.select().from(sellerMappings);
  const digestRows = (rows: typeof protectedRows) => createHash('sha256').update(JSON.stringify(rows.sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
  const protectedDigest = digestRows(protectedRows);
  await check('migration-and-isolated-fixtures', async () => {
    const result = await pool.query("select current_setting('timezone') as timezone, to_regclass('public.seller_mapping')::text as mapping_table");
    assert.equal(result.rows[0].timezone, 'Asia/Shanghai');
    assert.equal(result.rows[0].mapping_table, 'seller_mapping');
    for (let i = 0; i < fixtureIds.length; i++) {
      const [value] = await pool.query<{ sid: number }>('select (1900000000 + floor(random() * 200000000))::int as sid').then((value) => value.rows);
      await db.insert(sellerMappings).values({ id: fixtureIds[i]!, sid: value!.sid, name: `T05 技术验收 ${runId} ${i}`,
        country: 'TEST', status: 'candidate', sourceObservedAt: new Date(), sourceSha256: '0'.repeat(64) });
    }
    return { fixtureCount: fixtureIds.length, realCandidateRows: protectedRows.length };
  });
  startApi();
  await waitForApi();
  const accounts = new Map<string, { id: string; cookie: string }>();
  await check('real-authenticated-administrator', async () => {
    for (const role of ['admin'] as const) {
      const email = `t05-${runId}-${role}@acceptance.invalid`;
      const password = randomBytes(32).toString('base64url');
      const created = await auth.api.createUser({ body: { email, password, name: `T05 technical ${role}`, role } });
      accountIds.push(created.user.id);
      const login = await request('/auth/sign-in/email', '', 'POST', { email, password });
      assert.equal(login.status, 200);
      assert(login.cookie);
      accounts.set(role, { id: created.user.id, cookie: login.cookie });
    }
  });
  const admin = accounts.get('admin')!;
  const list = async (cookie = admin.cookie, suffix = '') => request<List>(`/seller-mappings${suffix}`, cookie);
  const revise = (id: string, body: SellerMappingRevisionInput, cookie = admin.cookie, origin = baseURL) =>
    request<RevisionResult & ErrorBody>(`/seller-mappings/${id}/revise`, cookie, 'POST', body, origin);
  const fixtureList = await list(admin.cookie, `?search=${encodeURIComponent(runId)}&pageSize=100`);
  assert.equal(fixtureList.status, 200);
  const first = fixtureList.data.items.find((row) => row.id === fixtureIds[0])!;
  const second = fixtureList.data.items.find((row) => row.id === fixtureIds[1])!;
  const alias = `T05-${runId}-alias`;
  const input = (row: SellerMapping, extra: Partial<SellerMappingRevisionInput> = {}): SellerMappingRevisionInput => ({
    operationId: randomUUID(), expectedVersion: row.version, name: row.name, country: row.country,
    marketplaceId: row.marketplaceId, wid: row.wid, aliases: row.aliases, status: row.status,
    reason: 'T05 技术验收，非真实业务批准', ...extra,
  });
  await check('authentication-permission-and-request-origin', async () => {
    assert.equal((await list('')).status, 401);
    assert.equal((await request(`/seller-mappings/${first.id}/history`)).status, 401);
    assert.equal((await revise(first.id, input(first), admin.cookie, 'https://untrusted.invalid')).status, 403);
  });
  await check('pagination-search-and-validation', async () => {
    const page1 = await list(admin.cookie, `?search=${runId}&page=1&pageSize=2`);
    const page2 = await list(admin.cookie, `?search=${runId}&page=2&pageSize=2`);
    assert.equal(page1.data.total, 3);
    assert.equal(page1.data.items.length, 2);
    assert.equal(page2.data.items.length, 1);
    assert(!page1.data.items.some((row) => row.id === page2.data.items[0]!.id));
    assert.equal((await list(admin.cookie, '?page=0')).status, 422);
    assert.equal((await revise(first.id, input(first, { status: 'approved', aliases: ['   '] }))).status, 422);
    assert.equal((await revise(first.id, input(first, { aliases: ['Alias', 'Ａｌｉａｓ'] }))).status, 422);
  });
  let approved: SellerMapping;
  await check('candidate-approval-and-normalized-exact-resolution', async () => {
    assert.equal(await resolveApprovedSeller(alias), null);
    const candidate = await revise(first.id, input(first, { aliases: [alias] }));
    assert.equal(candidate.status, 200);
    assert.equal(candidate.data.mapping.status, 'candidate');
    assert.equal(await resolveApprovedSeller(alias), null);
    const confirmed = await revise(first.id, input(candidate.data.mapping, { status: 'approved' }));
    assert.equal(confirmed.status, 200);
    approved = confirmed.data.mapping;
    assert.equal((await resolveApprovedSeller(`  ${alias.toUpperCase()}  `))?.id, first.id);
    assert.equal(await resolveApprovedSeller(`${alias}-other`), null);
    assert.equal(approved.version, first.version + 2);
  });
  await check('alias-conflict-rolls-back-version-history-and-audit', async () => {
    const before = await db.select().from(operationAudit).where(eq(operationAudit.targetId, second.id));
    const rejected = await revise(second.id, input(second, { aliases: [alias.toUpperCase()], status: 'approved' }));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.data.error.code, 'ALIAS_CONFLICT');
    const [row] = await db.select().from(sellerMappings).where(eq(sellerMappings.id, second.id));
    assert.equal(row!.version, second.version);
    assert.equal((await db.select().from(sellerMappingRevisions).where(eq(sellerMappingRevisions.sellerMappingId, second.id))).length, 0);
    assert.equal((await db.select().from(operationAudit).where(eq(operationAudit.targetId, second.id))).length, before.length);
    assert.equal((await db.select().from(sellerAliases).where(eq(sellerAliases.sellerMappingId, second.id))).length, 0);
  });
  await check('stale-version-and-operation-conflict', async () => {
    const stale = await revise(first.id, input(first));
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
    const body = input(approved!, { country: 'TECHNICAL' });
    const saved = await revise(first.id, body);
    assert.equal(saved.status, 200);
    const replay = await revise(first.id, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    assert.deepEqual(replay.data.mapping, saved.data.mapping);
    const conflict = await revise(first.id, { ...body, reason: 'changed payload' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error.code, 'OPERATION_CONFLICT');
    approved = saved.data.mapping;
  });
  await check('concurrent-replay-and-concurrent-version-control', async () => {
    const body = input(approved!, { country: 'CONCURRENT' });
    const replays = await Promise.all([revise(first.id, body), revise(first.id, body)]);
    assert(replays.every((result) => result.status === 200));
    assert.deepEqual(replays.map((result) => result.data.replayed).sort(), [false, true]);
    const current = replays[0]!.data.mapping;
    const concurrent = await Promise.all([revise(first.id, input(current, { country: 'A' })), revise(first.id, input(current, { country: 'B' }))]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
    approved = concurrent.find((result) => result.status === 200)!.data.mapping;
    return { sameOperationVersions: 1, competingVersionsCommitted: 1 };
  });
  await check('disable-mapping-history-audit-and-api-restart', async () => {
    const disabled = await revise(first.id, input(approved!, { status: 'disabled' }));
    assert.equal(disabled.status, 200);
    assert.equal(await resolveApprovedSeller(alias), null);
    const history = await request<{ items: Array<{ version: number; reason: string; before: SellerMapping; after: SellerMapping }> }>(`/seller-mappings/${first.id}/history`, admin.cookie);
    assert.equal(history.status, 200);
    assert.equal(history.data.items.length, disabled.data.mapping.version - 1);
    assert.equal(history.data.items[0]!.after.status, 'disabled');
    assert.equal(history.data.items.at(-1)!.before.version, 1);
    const auditRows = await db.select().from(operationAudit).where(eq(operationAudit.targetId, first.id));
    assert.equal(auditRows.length, history.data.items.length);
    assert(auditRows.every((row) => row.actorUserId === admin.id && row.requestHash));
    await stopApi();
    startApi();
    await waitForApi();
    const restarted = await list(admin.cookie, `?search=${runId}&status=disabled`);
    assert.equal(restarted.data.items[0]!.version, disabled.data.mapping.version);
    assert.equal(restarted.data.items[0]!.status, 'disabled');
    return { immutableRevisions: history.data.items.length, auditRows: auditRows.length };
  });
  await check('all-legacy-roles-are-rejected-at-http-and-transaction-boundaries', async () => {
    try {
      for (const role of ['operations', 'documentation', 'finance']) {
        await db.update(user).set({ role, banned: true }).where(eq(user.id, admin.id));
        assert.equal((await list()).status, 403);
        const forbidden = await revise(second.id, input(second));
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.data.error.code, 'FORBIDDEN');
        assert.match(forbidden.data.error.traceId, /^[a-f0-9-]{36}$/);
        await assert.rejects(reviseSellerMapping(second.id, input(second), admin.id),
          (error: unknown) => error instanceof MappingError && error.code === 'FORBIDDEN');
        assert.equal((await db.select().from(sellerMappings).where(eq(sellerMappings.id, second.id)))[0]!.version, second.version);
      }
    } finally { await db.update(user).set({ role: 'admin', banned: false }).where(eq(user.id, admin.id)); }
  });
  await check('real-seller-candidates-remain-unchanged', async () => {
    const current = (await db.select().from(sellerMappings)).filter((row) => !fixtureIds.includes(row.id));
    assert.equal(digestRows(current), protectedDigest);
    return { unchangedRealRows: current.length, realApprovalsByAcceptance: 0 };
  });
} catch (error) {
  failed = true;
  steps.push({ name: currentStep, result: 'failed', details: { code: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'CHECK_FAILED' } });
  logError('T05 seller mapping acceptance stopped', error);
} finally {
  await stopApi();
  try {
    await db.transaction(async (tx) => {
      await tx.delete(sellerAliases).where(inArray(sellerAliases.sellerMappingId, fixtureIds));
      await tx.delete(sellerMappingRevisions).where(inArray(sellerMappingRevisions.sellerMappingId, fixtureIds));
      await tx.delete(operationAudit).where(inArray(operationAudit.targetId, fixtureIds));
      await tx.delete(sellerMappings).where(inArray(sellerMappings.id, fixtureIds));
    });
    for (const id of accountIds) {
      await db.update(user).set({ banned: true, banReason: 'T05 technical acceptance completed' }).where(eq(user.id, id));
      await pool.query('delete from session where user_id = $1', [id]);
      await pool.query('delete from account where user_id = $1', [id]);
    }
  } catch (error) {
    failed = true;
    steps.push({ name: 'technical-fixture-cleanup', result: 'failed' });
    logError('T05 acceptance cleanup failed', error);
  }
  const report = { runId, createdAt: new Date().toISOString(), timezone: 'Asia/Shanghai', kind: 'real-postgresql-seller-mapping-integration',
    result: failed ? 'failed' : 'passed', steps, scope: 'Technical fixtures only; real seller candidates never approved or modified',
    technicalFixturesRemoved: !steps.some((step) => step.name === 'technical-fixture-cleanup'),
    notCovered: ['business approval of real sid/aliases/wid', 'real initial and incremental demand files', 'browser interactions'] };
  if (reportPath) {
    const target = resolve(reportPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  await closeDatabase();
  console.log(`T05 seller mapping integration ${failed ? 'FAILED' : 'PASSED'} (${steps.filter((step) => step.result === 'passed').length} checks)`);
  if (failed) process.exitCode = 1;
}
