import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { PgBoss, type SendOptions } from 'pg-boss';
import { auth } from './auth.js';
import { readConfig } from './config.js';
import { closeDatabase, db, pool } from './db/client.js';
import { demoTasks, operationAudit, user } from './db/schema.js';
import { errorCode, logError } from './errors.js';
import { createDemoTask, DEMO_QUEUE } from './tasks.js';

// This command writes only M0 acceptance accounts and demo jobs to the configured
// development database. Passwords and cookies exist only in this process's memory.
const config = readConfig();
const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const reportArgument = process.argv.indexOf('--report');
const reportPath = reportArgument >= 0 ? process.argv[reportArgument + 1] : undefined;
const runId = randomUUID();
const steps: Array<{ name: string; result: 'passed' | 'failed'; details?: Record<string, unknown> }> = [];
const children = new Set<ChildProcess>();
const accountIds: string[] = [];
const boss = new PgBoss({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5_000,
  options: '-c timezone=Asia/Shanghai' });
boss.on('error', (error) => logError('M0 acceptance queue error', error));
let failed = false;

type Task = { id: string; label: string; status: string; result: string | null; error: string | null; completedAt: string | null };
type ApiResult<T> = { status: number; data: T; cookie: string };
type Account = { id: string; email: string; password: string; cookie: string };

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

async function waitFor(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await delay(250);
  }
  throw new Error(description);
}

function startProcess(entry: 'api' | 'worker', overrides: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [resolve(serverRoot, 'dist', `${entry}.js`)], {
    cwd: serverRoot,
    env: { ...process.env, ...overrides },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  child.on('error', () => undefined);
  children.add(child);
  return child;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(8_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(3_000)]);
    }
  }
  children.delete(child);
}

async function check(name: string, action: () => Promise<Record<string, unknown> | void>): Promise<void> {
  try {
    const details = await action();
    steps.push({ name, result: 'passed', ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    steps.push({ name, result: 'failed', details: { code: errorCode(error) ?? 'CHECK_FAILED' } });
    console.error(`FAIL ${name}`);
    failed = true;
    throw error;
  }
}

try {
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const apiEnvironment = { PORT: String(port), HOST: '127.0.0.1', BETTER_AUTH_URL: baseURL, WEB_ORIGIN: baseURL };
  async function request<T>(path: string, cookie = '', method = 'GET', body?: unknown): Promise<ApiResult<T>> {
    const response = await fetch(`${baseURL}/api/v1${path}`, {
      method,
      headers: { Origin: baseURL, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    return { status: response.status, data: await response.json() as T, cookie: cookies };
  }
  await check('database-and-migrations', async () => {
    const result = await pool.query<{ timezone: string; migrations: number }>(
      `select current_setting('timezone') as timezone, (select count(*)::int from drizzle.__drizzle_migrations) as migrations`,
    );
    assert.equal(result.rows[0]?.timezone, 'Asia/Shanghai');
    assert((result.rows[0]?.migrations ?? 0) > 0);
    await boss.start();
    await boss.createQueue(DEMO_QUEUE, { retryLimit: 0, deleteAfterSeconds: 0 });
    return { database: 'PostgreSQL', timezone: result.rows[0]?.timezone, migrationCount: result.rows[0]?.migrations };
  });

  let api = startProcess('api', apiEnvironment);
  await waitFor(async () => (await request('/health')).status === 200, 'API did not start');
  const accounts = new Map<string, Account>();
  await check('administrators-login-with-admin-only-session', async () => {
    for (const fixture of ['admin', 'actor']) {
      const email = `m0-${runId}-${fixture}@acceptance.invalid`;
      const password = randomBytes(32).toString('base64url');
      const created = await auth.api.createUser({ body: { email, password, name: `M0 acceptance ${fixture}`, role: 'admin' } });
      const id = created.user.id;
      accountIds.push(id);
      const signedIn = await request('/auth/sign-in/email', '', 'POST', { email, password });
      assert.equal(signedIn.status, 200);
      assert(signedIn.cookie);
      const current = await request<{ user: { id: string; role: string } }>('/session', signedIn.cookie);
      assert.equal(current.data.user.id, id);
      assert.equal(current.data.user.role, 'admin');
      accounts.set(fixture, { id, email, password, cookie: signedIn.cookie });
    }
    return { role: 'admin', technicalAccounts: accounts.size };
  });
  const admin = accounts.get('admin')!;
  const operator = accounts.get('actor')!;
  await check('wrong-password-and-unauthenticated', async () => {
    const wrong = await request('/auth/sign-in/email', '', 'POST', { email: operator.email, password: randomBytes(32).toString('hex') });
    assert.equal(wrong.status, 401);
    assert.equal((await request('/tasks', '', 'POST', { label: 'M0 unauthenticated' })).status, 401);
  });
  await check('legacy-roles-have-no-session-read-or-write-access', async () => {
    try {
      for (const role of ['operations', 'documentation', 'finance']) {
        await db.update(user).set({ role, banned: true }).where(eq(user.id, operator.id));
        assert.equal((await request('/session', operator.cookie)).status, 403);
        assert.equal((await request('/dashboard', operator.cookie)).status, 403);
        assert.equal((await request('/tasks', operator.cookie)).status, 403);
        assert.equal((await request('/tasks', operator.cookie, 'POST', { label: 'M0 forbidden' })).status, 403);
      }
    } finally { await db.update(user).set({ role: 'admin', banned: false }).where(eq(user.id, operator.id)); }
  });
  await check('public-account-creation-and-role-management-are-disabled', async () => {
    for (const role of ['operations', 'documentation', 'finance']) {
      const response = await request('/auth/admin/create-user', admin.cookie, 'POST', {
        email: `forbidden-${runId}-${role}@acceptance.invalid`, password: randomBytes(32).toString('hex'), name: 'M0 forbidden', role,
      });
      assert([400, 403].includes(response.status));
      assert.equal(Number((await pool.query('select count(*) from "user" where email = $1', [`forbidden-${runId}-${role}@acceptance.invalid`])).rows[0].count), 0);
    }
  });
  await check('business-audit-and-enqueue-rollback-together', async () => {
    let rolledBackId = '';
    const failingBoss = {
      send: async (queue: string, data: { taskId: string }, options: SendOptions) => {
        rolledBackId = data.taskId;
        await boss.send(queue, data, options);
        throw new Error('M0 controlled rollback after enqueue');
      },
    } as unknown as PgBoss;
    await assert.rejects(createDemoTask(failingBoss, `M0 rollback ${runId}`, operator.id), /M0 controlled rollback/);
    assert(rolledBackId);
    assert.equal((await db.select().from(demoTasks).where(eq(demoTasks.id, rolledBackId))).length, 0);
    assert.equal((await db.select().from(operationAudit).where(eq(operationAudit.targetId, rolledBackId))).length, 0);
    assert.equal((await boss.findJobs(DEMO_QUEUE, { data: { taskId: rolledBackId } })).length, 0);
    return { taskId: rolledBackId, taskRows: 0, auditRows: 0, queueRows: 0,
      faultInjection: 'throw after real queue insert, before transaction commit' };
  });
  let task: Task;
  await check('business-audit-and-enqueue-commit-together', async () => {
    const created = await request<{ task: Task }>('/tasks', operator.cookie, 'POST', { label: `M0 restart ${runId}` });
    assert.equal(created.status, 201);
    task = created.data.task;
    assert.equal(task.status, 'queued');
    const rows = await db.select().from(demoTasks).where(eq(demoTasks.id, task.id));
    assert.equal(rows.length, 1);
    assert.equal((await db.select().from(operationAudit).where(eq(operationAudit.targetId, task.id))).length, 1);
    const [job] = await boss.findJobs(DEMO_QUEUE, { id: rows[0]!.queueJobId });
    assert.equal(job?.state, 'created');
    return { taskId: task.id, jobId: job.id, taskRows: 1, auditRows: 1, queueRows: 1 };
  });
  await check('queued-task-survives-api-restart', async () => {
    await stopProcess(api);
    api = startProcess('api', apiEnvironment);
    await waitFor(async () => (await request('/health')).status === 200, 'Restarted API did not start');
    const listed = await request<{ items: Task[] }>('/tasks', operator.cookie);
    assert.equal(listed.data.items.find((item) => item.id === task.id)?.status, 'queued');
    return { taskId: task.id };
  });
  let worker = startProcess('worker');
  await check('worker-executes-and-api-queries-result', async () => {
    await waitFor(async () => {
      const listed = await request<{ items: Task[] }>('/tasks', operator.cookie);
      return listed.data.items.find((item) => item.id === task.id)?.status === 'completed';
    }, 'Worker did not complete the queued task');
    const listed = await request<{ items: Task[] }>('/tasks', operator.cookie);
    const completed = listed.data.items.find((item) => item.id === task.id)!;
    assert.equal(completed.result, '任务已完成');
    assert(completed.completedAt);
    task = completed;
    return { taskId: task.id, result: completed.result, completedAt: completed.completedAt };
  });
  let failedTaskId = '';
  await check('worker-permission-failure-is-persisted', async () => {
    await stopProcess(worker);
    const created = await request<{ task: Task }>('/tasks', operator.cookie, 'POST', { label: `M0 revoked permission ${runId}` });
    assert.equal(created.status, 201);
    failedTaskId = created.data.task.id;
    await db.update(user).set({ role: 'finance', banned: true }).where(eq(user.id, operator.id));
    worker = startProcess('worker');
    await waitFor(async () => {
      const listed = await request<{ items: Task[] }>('/tasks', admin.cookie);
      return listed.data.items.find((item) => item.id === failedTaskId)?.status === 'failed';
    }, 'Worker failure was not persisted');
    await db.update(user).set({ role: 'admin', banned: false }).where(eq(user.id, operator.id));
    const listed = await request<{ items: Task[] }>('/tasks', admin.cookie);
    assert.equal(listed.data.items.find((item) => item.id === failedTaskId)?.error, '提交人已失去任务执行权限');
    return { taskId: failedTaskId, failure: 'permission revoked after enqueue' };
  });
  await check('completed-and-failed-results-survive-api-worker-restart', async () => {
    await stopProcess(worker);
    await stopProcess(api);
    api = startProcess('api', apiEnvironment);
    worker = startProcess('worker');
    await waitFor(async () => (await request('/health')).status === 200, 'Restarted API did not start');
    const listed = await request<{ items: Task[] }>('/tasks', admin.cookie);
    const completed = listed.data.items.find((item) => item.id === task.id)!;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completedAt, task.completedAt);
    assert.equal(listed.data.items.find((item) => item.id === failedTaskId)?.status, 'failed');
    const row = (await db.select().from(demoTasks).where(eq(demoTasks.id, task.id)))[0]!;
    const [job] = await boss.findJobs(DEMO_QUEUE, { id: row.queueJobId });
    assert.equal(job?.state, 'completed');
    assert.equal(job?.retryCount, 0);
    return { taskId: task.id, failedTaskId, retryCount: job.retryCount, completedAt: completed.completedAt };
  });
  await check('sign-out-invalidates-session', async () => {
    for (const account of accounts.values()) {
      assert.equal((await request('/auth/sign-out', account.cookie, 'POST', {})).status, 200);
      const current = await request<{ user: unknown }>('/session', account.cookie);
      assert.equal(current.data.user, null);
    }
  });
  await check('unavailable-database-produces-real-health-failure', async () => {
    const deadPort = await availablePort();
    const failurePort = await availablePort();
    const unavailableDatabase = new URL(config.DATABASE_URL);
    unavailableDatabase.hostname = '127.0.0.1';
    unavailableDatabase.port = String(deadPort);
    const outageApi = startProcess('api', { ...apiEnvironment, PORT: String(failurePort), DATABASE_URL: unavailableDatabase.toString() });
    let response: Response | undefined;
    await waitFor(async () => {
      response = await fetch(`http://127.0.0.1:${failurePort}/api/v1/health`, { signal: AbortSignal.timeout(8_000) });
      return response.status === 503;
    }, 'Unavailable database did not return 503');
    assert.deepEqual(await response!.json(), { status: 'degraded', database: 'error', worker: 'unknown' });
    await stopProcess(outageApi);
    return { status: 503, database: 'error', injection: 'separate API pointed at unused local port' };
  });
} catch (error) {
  failed = true;
  logError('M0 acceptance stopped', error);
} finally {
  await Promise.all([...children].map(stopProcess));
  for (const id of accountIds) {
    await db.update(user).set({ banned: true, banReason: 'M0 acceptance completed' }).where(eq(user.id, id)).catch(() => undefined);
    await pool.query('delete from session where user_id = $1', [id]).catch(() => undefined);
    await pool.query('delete from account where user_id = $1', [id]).catch(() => undefined);
  }
  await boss.stop().catch(() => undefined);
  await closeDatabase();
  const report = { runId, createdAt: new Date().toISOString(), timezone: 'Asia/Shanghai',
    kind: 'real-postgresql-integration', result: failed ? 'failed' : 'passed',
    scope: 'M0 acceptance accounts and demo tasks; no business data or external API calls',
    steps, notCovered: ['browser viewport checks', 'business manual acceptance', 'target-device deployment and independent restore'] };
  if (reportPath) {
    const target = resolve(reportPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
  }
  console.log(`M0 integration ${failed ? 'FAILED' : 'PASSED'} (${steps.filter((step) => step.result === 'passed').length} checks)`);
  if (failed) process.exitCode = 1;
}
