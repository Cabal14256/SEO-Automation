import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { auth } from './auth.js';
import { readConfig } from './config.js';
import { closeDatabase, pool } from './db/client.js';
import { logError } from './errors.js';

// Uses the controlled existing administrator and one disposable technical
// administrator. Passwords, cookies and personal identifiers stay out of reports.
const config = readConfig();
assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_automation_dev');
const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
const steps: Array<{ name: string; result: 'passed' | 'failed'; details?: Record<string, unknown> }> = [];
const runId = randomUUID();
let api: ChildProcess | undefined;
let fixtureId: string | undefined;
let currentStep = 'setup';
let failed = false;
let fixtureRemoved = false;
type Body = { user?: { id: string; role: string } | null; items?: Array<{ id: string }>; total?: number };

async function check(name: string, action: () => Promise<Record<string, unknown> | void>) {
  currentStep = name;
  const details = await action();
  steps.push({ name, result: 'passed', ...(details ? { details } : {}) });
  console.log(`PASS ${name}`);
}

try {
  const credentials = JSON.parse(await readFile(process.env.M0_CREDENTIALS_FILE || fileURLToPath(new URL('../../../.local/development/accounts.json', import.meta.url)), 'utf8')) as Record<string, { email: string; password: string }>;
  const socket = createServer();
  await new Promise<void>((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done); });
  const address = socket.address();
  assert(address && typeof address === 'object');
  const baseURL = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()));
  async function request(path: string, cookie = '', method = 'GET', body?: unknown) {
    const response = await fetch(`${baseURL}/api/v1${path}`, {
      method, headers: { Origin: baseURL, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let data: Body = {};
    try { data = JSON.parse(bytes.toString()); } catch { /* Download remains bytes. */ }
    return { status: response.status, data, bytes, cookie: response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') };
  }
  await check('migration-disables-legacy-accounts-and-revokes-login-material', async () => {
    assert.deepEqual(Object.keys(credentials), ['admin']);
    assert(credentials.admin?.email && credentials.admin.password);
    const result = await pool.query(`select
      (select count(*)::int from "user" where role <> 'admin' and banned = false) as active_legacy,
      (select count(*)::int from session s join "user" u on u.id = s.user_id where u.role <> 'admin') as legacy_sessions,
      (select count(*)::int from account a join "user" u on u.id = a.user_id where u.role <> 'admin') as legacy_credentials,
      (select count(*)::int from "user" where role = 'admin' and banned = false) as active_admins,
      (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'user' and column_name = 'role') as role_default`);
    const state = result.rows[0];
    assert.equal(state.active_legacy, 0);
    assert.equal(state.legacy_sessions, 0);
    assert.equal(state.legacy_credentials, 0);
    assert(state.active_admins > 0);
    assert.match(state.role_default as string, /admin/);
    return { activeLegacyAccounts: 0, legacySessions: 0, legacyCredentials: 0, activeAdministrators: state.active_admins };
  });
  api = spawn(process.execPath, [resolve(serverRoot, 'dist/api.js')], {
    cwd: serverRoot, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(address.port), BETTER_AUTH_URL: baseURL, WEB_ORIGIN: baseURL },
  });
  api.on('error', () => undefined);
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    healthy = (await request('/health').catch(() => null))?.status === 200;
    if (healthy) break;
    await delay(250);
  }
  assert(healthy, 'Acceptance API did not start');
  let adminCookie = '';
  await check('existing-administrator-password-and-session-remain-valid', async () => {
    assert.equal((await request('/session')).data.user, null);
    assert.equal((await request('/auth/sign-in/email', '', 'POST', { email: credentials.admin!.email, password: randomBytes(32).toString('hex') })).status, 401);
    const login = await request('/auth/sign-in/email', '', 'POST', credentials.admin);
    assert.equal(login.status, 200);
    assert(login.cookie);
    adminCookie = login.cookie;
    const session = await request('/session', adminCookie);
    assert.equal(session.status, 200);
    assert.equal(session.data.user?.role, 'admin');
    for (const path of ['/dashboard', '/tasks', '/seller-mappings', '/imports']) assert.equal((await request(path, adminCookie)).status, 200);
  });
  await check('administrator-retains-access-to-historical-imports-and-originals', async () => {
    const count = Number((await pool.query('select count(*) from source_import')).rows[0].count);
    const list = await request('/imports?pageSize=100', adminCookie);
    assert.equal(list.status, 200);
    assert.equal(list.data.total, count);
    const historical = await pool.query<{ id: string; file_id: string; sha256: string }>(`select i.id, i.file_id, f.sha256 from source_import i join file_index f on f.id = i.file_id
      join "user" u on u.id = i.created_by where u.role <> 'admin' order by i.imported_at limit 1`);
    for (const row of historical.rows) {
      assert.equal((await request(`/imports/${row.id}`, adminCookie)).status, 200);
      assert.equal((await request(`/imports/${row.id}/rows?pageSize=1`, adminCookie)).status, 200);
      const file = await request(`/files/${row.file_id}/download`, adminCookie);
      assert.equal(file.status, 200);
      assert.equal(createHash('sha256').update(file.bytes).digest('hex'), row.sha256);
    }
    return { importCount: count, legacyOwnedOriginalsChecked: historical.rows.length };
  });
  const fixtureEmail = `admin-only-${runId}@acceptance.invalid`;
  const fixturePassword = randomBytes(32).toString('base64url');
  const fixture = await auth.api.createUser({ body: { email: fixtureEmail, password: fixturePassword, name: 'Admin-only technical verification', role: 'admin' } });
  fixtureId = fixture.user.id;
  const fixtureLogin = await request('/auth/sign-in/email', '', 'POST', { email: fixtureEmail, password: fixturePassword });
  assert.equal(fixtureLogin.status, 200);
  await check('legacy-correct-password-and-existing-session-cannot-access-any-surface', async () => {
    for (const role of ['operations', 'documentation', 'finance']) {
      await pool.query('update "user" set role = $2, banned = false where id = $1', [fixtureId, 'admin']);
      await assert.rejects(pool.query('update "user" set role = $2 where id = $1', [fixtureId, role]),
        (error: unknown) => (error as { code?: string }).code === '23514');
      await pool.query('update "user" set role = $2, banned = true where id = $1', [fixtureId, role]);
      const signIn = await request('/auth/sign-in/email', '', 'POST', { email: fixtureEmail, password: fixturePassword });
      assert.equal(signIn.status, 403, 'Legacy correct-password login must be rejected');
      assert(!signIn.cookie || signIn.cookie.split('; ').every((cookie) => cookie.endsWith('=')), 'Rejected login must not issue an authenticated cookie');
      for (const path of ['/session', '/auth/get-session', '/dashboard', '/tasks', '/seller-mappings', '/imports', `/files/${randomUUID()}/download`]) {
        assert.equal((await request(path, fixtureLogin.cookie)).status, 403, `${path} must reject the legacy session`);
      }
      assert.equal((await request('/tasks', fixtureLogin.cookie, 'POST', { label: 'Forbidden legacy task' })).status, 403);
      const unban = await request('/auth/admin/unban-user', adminCookie, 'POST', { userId: fixtureId });
      assert.equal(unban.status, 403);
      assert.equal((await pool.query('select banned from "user" where id = $1', [fixtureId])).rows[0].banned, true);
    }
    await pool.query('update "user" set role = $2, banned = false where id = $1', [fixtureId, 'admin']);
  });
  await check('non-administrator-creation-and-role-change-are-rejected', async () => {
    for (const role of ['operations', 'documentation', 'finance']) {
      const email = `forbidden-${runId}-${role}@acceptance.invalid`;
      const create = await request('/auth/admin/create-user', adminCookie, 'POST', { email, password: fixturePassword, name: 'Forbidden role', role });
      assert([400, 403].includes(create.status));
      assert.equal(Number((await pool.query('select count(*) from "user" where email = $1', [email])).rows[0].count), 0);
      const update = await request('/auth/admin/set-role', adminCookie, 'POST', { userId: fixtureId, role });
      assert([400, 403].includes(update.status));
      assert.equal((await pool.query('select role from "user" where id = $1', [fixtureId])).rows[0].role, 'admin');
    }
  });
  await check('sign-out-invalidates-the-preserved-administrator-session', async () => {
    assert.equal((await request('/auth/sign-out', adminCookie, 'POST', {})).status, 200);
    assert.equal((await request('/session', adminCookie)).data.user, null);
  });
} catch (error) {
  failed = true;
  steps.push({ name: currentStep, result: 'failed', details: { code: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'CHECK_FAILED', ...(error instanceof assert.AssertionError ? { assertion: error.message } : {}) } });
  logError('Admin-only acceptance stopped', error);
} finally {
  if (api && api.exitCode === null && api.signalCode === null) {
    const stopped = new Promise<void>((done) => api!.once('exit', () => done()));
    api.kill('SIGTERM');
    await Promise.race([stopped, delay(5_000)]);
    if (api.exitCode === null && api.signalCode === null) api.kill('SIGKILL');
  }
  try {
    if (fixtureId) {
      // No fixture business records are created, so cascade removes only its
      // authentication rows and leaves historical actors untouched.
      await pool.query('delete from "user" where id = $1', [fixtureId]);
      assert.equal(Number((await pool.query('select count(*) from "user" where id = $1', [fixtureId])).rows[0].count), 0);
    }
    fixtureRemoved = true;
  } catch { failed = true; steps.push({ name: 'technical-fixture-cleanup', result: 'failed' }); }
  await closeDatabase();
  const report = { runId, createdAt: new Date().toISOString(), timezone: 'Asia/Shanghai', kind: 'real-postgresql-admin-only-integration',
    result: failed ? 'failed' : 'passed', steps, technicalFixtureRemoved: fixtureRemoved,
    scope: 'Existing administrator login, migrated legacy accounts, historical read access and disposable role denial fixture; no business writes or external calls' };
  if (reportPath) { const target = resolve(reportPath); await mkdir(dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(`Admin-only integration ${failed ? 'FAILED' : 'PASSED'} (${steps.filter((step) => step.result === 'passed').length} checks)`);
  if (failed) process.exitCode = 1;
}
