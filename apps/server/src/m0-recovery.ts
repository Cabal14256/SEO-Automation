import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { PgBoss, type SendOptions } from 'pg-boss';
import { auth } from './auth.js';
import { readConfig } from './config.js';
import { closeDatabase, db, pool } from './db/client.js';
import { demoTasks, fileIndex, user } from './db/schema.js';
import { errorCode, logError } from './errors.js';
import { storeImmutableFile, type NewFileIndex } from './file-store.js';
import { saveBusinessFile } from './files.js';
import { createDemoTask, DEMO_QUEUE, reconcileFailedJobs } from './tasks.js';

// Run with the normal development Worker stopped. This verifies the existing
// terminal-failure policy after a killed active handler, without changing retries.
const config = readConfig();
const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const runId = randomUUID();
const steps: Array<{ name: string; result: 'passed' | 'failed'; details?: Record<string, unknown> }> = [];
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
const boss = new PgBoss({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5_000,
  options: '-c timezone=Asia/Shanghai', supervise: false, monitorIntervalSeconds: 1 });
boss.on('error', (error) => logError('M0 recovery queue error', error));
let worker: ChildProcess | null = null;
let accountId: string | null = null;
let failed = false;

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('M0 recovery condition timed out');
}

async function stopWorker(): Promise<void> {
  const child = worker;
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([exited, delay(5_000)]);
  }
  worker = null;
}

async function check(name: string, action: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    steps.push({ name, result: 'passed', details: await action() });
    console.log(`PASS ${name}`);
  } catch (error) {
    steps.push({ name, result: 'failed', details: { code: errorCode(error) ?? 'CHECK_FAILED' } });
    throw error;
  }
}

try {
  let stored: NewFileIndex;
  await check('external-file-and-database-index-have-matching-sha256', async () => {
    const bytes = Buffer.from(`M0 acceptance file ${runId}\n`, 'utf8');
    stored = await saveBusinessFile({ bytes, originalName: `m0-${runId}.txt`, mimeType: 'text/plain', createdBy: null });
    const [row] = await db.select().from(fileIndex).where(eq(fileIndex.id, stored.id));
    assert(row);
    const saved = await readFile(join(config.dataDir, row.storageKey));
    assert.deepEqual(saved, bytes);
    assert.equal(createHash('sha256').update(saved).digest('hex'), row.sha256);
    assert.equal(saved.length, row.byteSize);
    return { fileId: row.id, storageKey: row.storageKey, sha256: row.sha256, byteSize: row.byteSize };
  });
  await check('real-index-constraint-failure-removes-published-file', async () => {
    let rejected: NewFileIndex | null = null;
    await assert.rejects(storeImmutableFile(config.dataDir, {
      bytes: Buffer.from(`M0 invalid index ${runId}`), originalName: 'm0-index-failure.txt',
      mimeType: 'text/plain', createdBy: `missing-m0-${runId}`,
    }, async (record) => {
      rejected = record;
      await db.insert(fileIndex).values(record);
    }));
    assert(rejected);
    const record = rejected as NewFileIndex;
    await assert.rejects(stat(join(config.dataDir, record.storageKey)), { code: 'ENOENT' });
    assert.equal((await db.select().from(fileIndex).where(eq(fileIndex.id, record.id))).length, 0);
    return { fileId: record.id, fileExists: false, indexRows: 0, injection: 'real foreign-key constraint failure' };
  });
  await check('real-filesystem-write-failure-does-not-create-index', async () => {
    let indexCalled = false;
    // An actual immutable file cannot also be a storage directory. This triggers
    // the operating system's filesystem failure without changing directory ACLs.
    const existingFile = join(config.dataDir, stored!.storageKey);
    await assert.rejects(storeImmutableFile(existingFile, {
      bytes: Buffer.from(`M0 filesystem failure ${runId}`), originalName: 'm0-write-failure.txt',
      mimeType: 'text/plain', createdBy: null,
    }, async (record) => {
      indexCalled = true;
      await db.insert(fileIndex).values(record);
    }));
    assert.equal(indexCalled, false);
    const original = await readFile(existingFile);
    assert.equal(createHash('sha256').update(original).digest('hex'), stored!.sha256);
    return { indexCalled, originalFileUnchanged: true, injection: 'real file used as directory; filesystem rejects write' };
  });
  await check('fresh-process-reopens-index-and-verifies-file-hash', async () => {
    const program = [
      `import assert from 'node:assert/strict';`,
      `import { readFile } from 'node:fs/promises';`,
      `import { createHash } from 'node:crypto';`,
      `import { join } from 'node:path';`,
      `import { eq } from 'drizzle-orm';`,
      `import { db, closeDatabase } from './dist/db/client.js';`,
      `import { fileIndex } from './dist/db/schema.js';`,
      `import { readConfig } from './dist/config.js';`,
      `try {`,
      `const [record] = await db.select().from(fileIndex).where(eq(fileIndex.id, ${JSON.stringify(stored!.id)}));`,
      `assert(record);`,
      `const bytes = await readFile(join(readConfig().dataDir, record.storageKey));`,
      `assert.equal(createHash('sha256').update(bytes).digest('hex'), ${JSON.stringify(stored!.sha256)});`,
      `assert.equal(bytes.length, record.byteSize);`,
      `} finally { await closeDatabase(); }`,
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      cwd: serverRoot, env: process.env, stdio: 'ignore', windowsHide: true,
    });
    const exitCode = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done); });
    assert.equal(exitCode, 0);
    return { fileId: stored!.id, sha256: stored!.sha256, freshProcess: true };
  });
  await check('killed-active-worker-rolls-back-and-preserves-terminal-failure', async () => {
    await boss.start();
    await boss.createQueue(DEMO_QUEUE, { retryLimit: 0, deleteAfterSeconds: 0 });
    const created = await auth.api.createUser({ body: { email: `m0-recovery-${runId}@acceptance.invalid`,
      name: 'M0 recovery acceptance', role: 'admin' } });
    accountId = created.user.id;
    const shortExpiryBoss = {
      send: (queue: string, data: { taskId: string }, options: SendOptions) => boss.send(queue, data,
        { ...options, expireInSeconds: 2, retryLimit: 0 }),
    } as unknown as PgBoss;
    const task = await createDemoTask(shortExpiryBoss, `M0 killed active worker ${runId}`, accountId);
    const lock = await pool.connect();
    try {
      await lock.query('begin');
      await lock.query('select id from demo_tasks where id = $1 for update', [task.id]);
      worker = spawn(process.execPath, [resolve(serverRoot, 'dist', 'worker.js')], {
        cwd: serverRoot, env: process.env, stdio: 'ignore', windowsHide: true,
      });
      worker.on('error', () => undefined);
      await waitFor(async () => (await boss.findJobs(DEMO_QUEUE, { id: task.queueJobId }))[0]?.state === 'active');
      await stopWorker();
      await lock.query('rollback');
    } finally {
      await lock.query('rollback').catch(() => undefined);
      lock.release();
    }
    // Supervisor time is real. The acceptance job alone has a two-second expiry;
    // regular demo jobs keep the existing queue's 900-second expiry.
    // This test's boss monitors at one second: pg-boss's default shared monitor
    // claim lasts 60 seconds, longer than this fixture's 15-second deadline.
    await waitFor(async () => {
      await boss.supervise(DEMO_QUEUE);
      return (await boss.findJobs(DEMO_QUEUE, { id: task.queueJobId }))[0]?.state === 'failed';
    });
    await reconcileFailedJobs(boss);
    const [failedTask] = await db.select().from(demoTasks).where(eq(demoTasks.id, task.id));
    const [failedJob] = await boss.findJobs(DEMO_QUEUE, { id: task.queueJobId });
    assert.equal(failedTask?.status, 'failed');
    assert.equal(failedTask?.result, null);
    assert.equal(failedTask?.completedAt, null);
    assert.equal(failedJob?.retryCount, 0);
    assert(failedTask.error);
    return { taskId: task.id, jobId: task.queueJobId, taskStatus: failedTask.status, jobState: failedJob.state,
      retryCount: failedJob.retryCount, completedAt: failedTask.completedAt, acceptanceExpirySeconds: 2,
      acceptanceMonitorIntervalSeconds: 1,
      normalQueueExpirySeconds: (await boss.getQueue(DEMO_QUEUE))?.expireInSeconds,
      policy: 'killed active job becomes a traceable failure after expiry; no automatic retry' };
  });
} catch (error) {
  failed = true;
  logError('M0 recovery acceptance stopped', error);
} finally {
  await stopWorker();
  if (accountId) await db.update(user).set({ banned: true, banReason: 'M0 recovery acceptance completed' })
    .where(eq(user.id, accountId)).catch(() => undefined);
  if (accountId) {
    await pool.query('delete from session where user_id = $1', [accountId]).catch(() => undefined);
    await pool.query('delete from account where user_id = $1', [accountId]).catch(() => undefined);
  }
  await boss.stop().catch(() => undefined);
  await closeDatabase();
  const report = { runId, createdAt: new Date().toISOString(), timezone: 'Asia/Shanghai',
    kind: 'real-postgresql-and-filesystem-recovery', result: failed ? 'failed' : 'passed', steps,
    notCovered: ['automatic continuation of killed active jobs', 'target-device backup restore'] };
  if (reportPath) {
    const target = resolve(reportPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(`M0 recovery ${failed ? 'FAILED' : 'PASSED'} (${steps.filter((step) => step.result === 'passed').length} checks)`);
  if (failed) process.exitCode = 1;
}
