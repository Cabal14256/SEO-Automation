import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PgBoss } from 'pg-boss';
import {
  IMPORT_MAX_BYTES, importAcceptedSchema, importListSchema, importRowsResponseSchema,
  sourceImportSchema, type ImportAccepted, type ImportParseInput, type SourceImport,
} from '@scm/contracts';
import { auth } from './auth.js';
import { readAcceptanceFixture } from './acceptance-fixture.js';
import { readConfig } from './config.js';
import { closeDatabase, pool } from './db/client.js';
import { logError } from './errors.js';
import { createSourceImport, IMPORT_QUEUE } from './modules/imports/service.js';

// This command exercises real HTTP, PostgreSQL, immutable files and the Worker.
// It uses temporary technical accounts and removes only their import fixtures.
const config = readConfig();
assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_automation_dev', 'Use the dedicated development database');
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await readAcceptanceFixture();
const sourcePath = fixture.sourceFile;
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
const runId = randomUUID();
const steps: Array<{ name: string; result: 'passed' | 'failed'; details?: Record<string, unknown> }> = [];
const accountIds: string[] = [];
const processes: ChildProcess[] = [];
const accounts = new Map<string, { id: string; cookie: string }>();
let currentStep = 'setup';
let failed = false;
let cleanupSucceeded = false;
type ErrorBody = { error: { code: string; traceId: string } };
type Result = { status: number; data: unknown; cookie: string; bytes: Buffer };
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const check = async (name: string, action: () => Promise<Record<string, unknown> | void>) => {
  currentStep = name;
  const details = await action();
  steps.push({ name, result: 'passed', ...(details ? { details } : {}) });
  console.log(`PASS ${name}`);
};
async function availablePort() {
  const socket = createServer();
  await new Promise<void>((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done); });
  const address = socket.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return address.port;
}
async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(8_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(3_000)]);
  }
}
async function waitUntil<T>(action: () => Promise<T | null>, message: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (value !== null) return value;
    await delay(250);
  }
  throw new Error(message);
}

try {
  const sourceBytes = await readFile(sourcePath);
  const originalSha = sha256(sourceBytes);
  assert.equal(originalSha, fixture.sourceSha256, 'The designated source must remain unchanged');
  const realMappings = await pool.query('select * from seller_mapping order by id');
  const mappingDigest = sha256(JSON.stringify(realMappings.rows));
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', BETTER_AUTH_URL: baseURL, WEB_ORIGIN: baseURL };
  const start = (script: string) => {
    const child = spawn(process.execPath, [resolve(root, `dist/${script}.js`)], { cwd: root, env, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    processes.push(child);
    return child;
  };
  async function request(path: string, cookie = '', method = 'GET', body?: unknown, origin = baseURL): Promise<Result> {
    const isForm = body instanceof FormData;
    const response = await fetch(`${baseURL}/api/v1${path}`, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25_000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let data: unknown = null;
    try { data = JSON.parse(bytes.toString()); } catch { /* Downloads remain bytes. */ }
    return { status: response.status, data, bytes, cookie: response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') };
  }
  function uploadInput(operationId: string, bytes = sourceBytes, name = fixture.originalName) {
    const body = new FormData();
    body.set('operationId', operationId);
    body.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
    return body;
  }
  let api = start('api');
  await waitUntil(async () => (await request('/health').catch(() => null))?.status === 200 ? true : null, 'Acceptance API failed to start', 30_000);
  await check('migration-real-database-and-administrator-sessions', async () => {
    const tables = await pool.query("select current_setting('timezone') as timezone, to_regclass('public.source_import')::text as import_table, to_regclass('public.source_import_row')::text as row_table");
    assert.equal(tables.rows[0].timezone, 'Asia/Shanghai');
    assert.equal(tables.rows[0].import_table, 'source_import');
    assert.equal(tables.rows[0].row_table, 'source_import_row');
    for (const fixture of ['admin', 'actor'] as const) {
      const email = `t09-${runId}-${fixture}@acceptance.invalid`;
      const password = randomBytes(32).toString('base64url');
      const created = await auth.api.createUser({ body: { email, password, name: `T09 technical ${fixture}`, role: 'admin' } });
      accountIds.push(created.user.id);
      const login = await request('/auth/sign-in/email', '', 'POST', { email, password });
      assert.equal(login.status, 200);
      assert(login.cookie);
      accounts.set(fixture, { id: created.user.id, cookie: login.cookie });
    }
    return { realSellerMappings: realMappings.rows.length };
  });
  const admin = accounts.get('admin')!;
  const actor = accounts.get('actor')!;
  await check('queue-failure-rolls-back-import-file-index-audit-and-file', async () => {
    const names = async () => (await readdir(resolve(config.dataDir, 'files'), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => resolve(entry.parentPath, entry.name)).sort();
    const before = await names();
    const realQueue = new PgBoss({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5_000, options: '-c timezone=Asia/Shanghai' });
    realQueue.on('error', () => undefined);
    await realQueue.start();
    let insertedJobId: string | null = null;
    try {
      await realQueue.createQueue(IMPORT_QUEUE, { retryLimit: 0, deleteAfterSeconds: 0 });
      const queue = new Proxy(realQueue, { get: (target, property, receiver) => property === 'send'
        ? async (...args: Parameters<PgBoss['send']>) => { insertedJobId = await target.send(...args); throw new Error('T09 injected failure after real queue insertion'); }
        : Reflect.get(target, property, receiver) });
      await assert.rejects(createSourceImport(queue, { bytes: sourceBytes, originalName: 'technical-queue-failure.xlsx', operationId: randomUUID(), actorUserId: admin.id }));
      assert(insertedJobId, 'The failure must occur after a real transactional pg-boss insert');
      assert.equal((await realQueue.findJobs(IMPORT_QUEUE, { id: insertedJobId })).length, 0);
    } finally { await realQueue.stop(); }
    assert.equal(Number((await pool.query('select count(*) from source_import where created_by = $1', [admin.id])).rows[0].count), 0);
    assert.equal(Number((await pool.query('select count(*) from file_index where created_by = $1', [admin.id])).rows[0].count), 0);
    assert.equal(Number((await pool.query('select count(*) from operation_audit where actor_user_id = $1', [admin.id])).rows[0].count), 0);
    assert.deepEqual(await names(), before);
    return { sourceRecords: 0, fileIndexes: 0, auditRows: 0, orphanFiles: 0, realQueueInsertRolledBack: true };
  });
  await check('filesystem-failure-leaves-no-business-record', async () => {
    const blocker = resolve(config.dataDir, `t09-blocker-${runId}`);
    await writeFile(blocker, 'T09 temporary filesystem blocker', { flag: 'wx' });
    const previousDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = blocker;
      const queue = { send: async () => { throw new Error('Queue must not be reached after filesystem failure'); } } as unknown as PgBoss;
      await assert.rejects(createSourceImport(queue, { bytes: sourceBytes, originalName: 'technical-fs-failure.xlsx', operationId: randomUUID(), actorUserId: admin.id }));
      assert.equal(Number((await pool.query('select count(*) from source_import where created_by = $1', [admin.id])).rows[0].count), 0);
      assert.equal(Number((await pool.query('select count(*) from file_index where created_by = $1', [admin.id])).rows[0].count), 0);
    } finally { process.env.DATA_DIR = previousDataDir; await unlink(blocker); }
  });
  const list = (cookie = admin.cookie, suffix = '') => request(`/imports${suffix}`, cookie);
  const get = async (id: string, cookie = admin.cookie) => {
    const result = await request(`/imports/${id}`, cookie);
    assert.equal(result.status, 200);
    return sourceImportSchema.parse((result.data as { import: unknown }).import);
  };
  const parse = (id: string, body: ImportParseInput, cookie = admin.cookie) => request(`/imports/${id}/parse`, cookie, 'POST', body);
  const settle = (id: string) => waitUntil(async () => {
    const current = await get(id);
    return current.latestRun && ['completed', 'failed'].includes(current.latestRun.status) ? current : null;
  }, 'Real Worker did not finish parsing within 60 seconds');
  await check('authentication-write-permissions-origin-and-upload-validation', async () => {
    assert.equal((await list('')).status, 401);
    try {
      for (const role of ['operations', 'documentation', 'finance']) {
        await pool.query('update "user" set role = $2, banned = true where id = $1', [actor.id, role]);
        assert.equal((await list(actor.cookie)).status, 403);
        const rejected = await request('/imports', actor.cookie, 'POST', uploadInput(randomUUID()));
        assert.equal(rejected.status, 403);
        assert.equal((rejected.data as ErrorBody).error.code, 'FORBIDDEN');
      }
    } finally { await pool.query('update "user" set role = $2, banned = false where id = $1', [actor.id, 'admin']); }
    assert.equal((await request('/imports', admin.cookie, 'POST', uploadInput(randomUUID()), 'https://untrusted.invalid')).status, 403);
    assert.equal((await request('/imports', admin.cookie, 'POST', uploadInput(randomUUID(), Buffer.alloc(0)))).status, 413);
    assert.equal((await request('/imports', admin.cookie, 'POST', uploadInput(randomUUID(), sourceBytes, 'source.xls'))).status, 415);
    assert.equal((await request('/imports', admin.cookie, 'POST', uploadInput(randomUUID(), Buffer.alloc(IMPORT_MAX_BYTES + 1)))).status, 413);
    assert.equal((await list(admin.cookie, '?page=0')).status, 422);
  });
  let first!: ImportAccepted;
  let firstPreview!: SourceImport;
  let worker!: ChildProcess;
  await check('upload-immutable-file-queue-and-shanghai-date', async () => {
    const operationId = randomUUID();
    const uploaded = await waitUntil(async () => {
      const result = await request('/imports', admin.cookie, 'POST', uploadInput(operationId));
      return result.status === 503 ? null : result;
    }, 'Persistent parse queue did not become ready', 30_000);
    assert.equal(uploaded.status, 202);
    first = importAcceptedSchema.parse(uploaded.data);
    assert.equal(first.replayed, false);
    assert.equal(first.import.sha256, originalSha);
    assert.equal(first.import.byteSize, sourceBytes.length);
    const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(first.import.importedAt));
    assert.equal(first.import.businessDate, businessDate);
    assert.equal(first.import.datePolicyVersion, 'import-date-shanghai-v1');
    const stored = await pool.query<{ storage_key: string; sha256: string }>('select storage_key, sha256 from file_index where id = $1', [first.import.fileId]);
    assert.equal(sha256(await readFile(resolve(config.dataDir, stored.rows[0]!.storage_key))), originalSha);
    assert.equal((await get(first.import.id)).latestRun!.status, 'queued');
    await stopProcess(api);
    api = start('api');
    await waitUntil(async () => (await request('/health').catch(() => null))?.status === 200 ? true : null, 'Restarted API failed to start', 30_000);
    assert.equal((await get(first.import.id)).latestRun!.id, first.run.id);
    assert.equal((await get(first.import.id)).latestRun!.status, 'queued');
    worker = start('worker');
    firstPreview = await settle(first.import.id);
    assert.notEqual(firstPreview.status, 'failed');
    assert(firstPreview.sheets.some((sheet) => sheet.name.trim() === '飞书表格'));
    const replay = await request('/imports', admin.cookie, 'POST', uploadInput(operationId));
    assert.equal(replay.status, 202);
    assert.equal(importAcceptedSchema.parse(replay.data).run.id, first.run.id);
    assert.equal(importAcceptedSchema.parse(replay.data).replayed, true);
    const conflict = await request('/imports', admin.cookie, 'POST', uploadInput(operationId, Buffer.concat([sourceBytes, Buffer.from([0])])));
    assert.equal(conflict.status, 409);
    assert.equal((conflict.data as ErrorBody).error.code, 'OPERATION_CONFLICT');
    return { byteSize: sourceBytes.length, sourceSha256: originalSha, businessDate, worksheetCount: firstPreview.sheets.length, queuedAcrossApiRestart: true };
  });
  await check('worker-rechecks-revoked-upload-permission-before-parsing', async () => {
    await stopProcess(worker);
    const uploaded = await request('/imports', actor.cookie, 'POST', uploadInput(randomUUID()));
    assert.equal(uploaded.status, 202);
    const fixture = importAcceptedSchema.parse(uploaded.data);
    await pool.query('update "user" set role = $2, banned = true where id = $1', [actor.id, 'operations']);
    try {
      worker = start('worker');
      const result = await settle(fixture.import.id);
      assert.equal(result.status, 'failed');
      assert.equal(result.latestRun!.errorCode, 'FORBIDDEN');
      assert.equal(Number((await pool.query('select count(*) from source_import_row where parse_run_id = $1', [fixture.run.id])).rows[0].count), 0);
    } finally { await pool.query('update "user" set role = $2, banned = false where id = $1', [actor.id, 'admin']); }
  });
  await check('same-owner-sha-deduplication-and-administrator-history-access', async () => {
    const duplicate = await request('/imports', admin.cookie, 'POST', uploadInput(randomUUID()));
    assert.equal(duplicate.status, 202);
    const deduplicated = importAcceptedSchema.parse(duplicate.data);
    assert.equal(deduplicated.import.id, first.import.id);
    assert.equal(deduplicated.deduplicated, true);
    assert.equal(deduplicated.import.importedAt, first.import.importedAt);
    const other = await request('/imports', actor.cookie, 'POST', uploadInput(randomUUID()));
    assert.equal(other.status, 202);
    const separate = importAcceptedSchema.parse(other.data);
    assert.notEqual(separate.import.id, first.import.id);
    const shared = await request(`/imports/${first.import.id}`, actor.cookie);
    assert.equal(shared.status, 200);
    const adminList = await list();
    const items = importListSchema.parse(adminList.data);
    assert(items.items.some((item) => item.id === first.import.id));
  });
  await check('worker-rechecks-administrator-permission-before-reparse', async () => {
    await stopProcess(worker);
    const ownerImports = importListSchema.parse((await list(actor.cookie)).data);
    const owned = ownerImports.items.find((item) => item.createdBy === actor.id)!;
    assert(owned);
    const ownerRecord = await get(owned.id, actor.cookie);
    const response = await parse(owned.id, { operationId: randomUUID(), expectedVersion: ownerRecord.version,
      sheetName: '飞书表格', mappingVersion: 'feishu-v1' });
    assert.equal(response.status, 202);
    const accepted = importAcceptedSchema.parse(response.data);
    await pool.query('update "user" set role = $2, banned = true where id = $1', [admin.id, 'operations']);
    try {
      worker = start('worker');
      const result = await waitUntil(async () => {
        const current = await get(owned.id, actor.cookie);
        return current.latestRun?.status === 'failed' ? current : null;
      }, 'Worker did not reject the revoked administrator');
      assert.equal(result.latestRun!.id, accepted.run.id);
      assert.equal(result.latestRun!.errorCode, 'FORBIDDEN');
      assert.equal(Number((await pool.query('select count(*) from source_import_row where parse_run_id = $1', [accepted.run.id])).rows[0].count), 0);
      assert.equal((await request(`/imports/${owned.id}`, admin.cookie)).status, 403);
      return { legacyRoleAccess: false, revokedActorSourceRowsPublished: 0 };
    } finally { await pool.query('update "user" set role = $2, banned = false where id = $1', [admin.id, 'admin']); }
  });
  let previewRunId!: string;
  await check('explicit-worksheet-mapping-preview-and-original-cell-trace', async () => {
    const sheet = firstPreview.sheets.find((value) => value.name.trim() === '飞书表格')!;
    const selected = await parse(first.import.id, { operationId: randomUUID(), expectedVersion: firstPreview.version, sheetName: sheet.name, mappingVersion: 'feishu-v1' });
    assert.equal(selected.status, 202);
    const accepted = importAcceptedSchema.parse(selected.data);
    firstPreview = await settle(first.import.id);
    assert.equal(firstPreview.latestRun!.status, 'completed');
    previewRunId = firstPreview.latestRun!.id;
    assert.equal(previewRunId, accepted.run.id);
    const rows = [];
    let total = 0;
    for (let page = 1; page <= 100; page++) {
      const response = await request(`/imports/${first.import.id}/rows?page=${page}&pageSize=100`, admin.cookie);
      assert.equal(response.status, 200);
      const data = importRowsResponseSchema.parse(response.data);
      assert.equal(data.parseRunId, previewRunId);
      total = data.total;
      rows.push(...data.items);
      if (rows.length >= total) break;
    }
    assert.equal(rows.length, total);
    assert.equal(new Set(rows.map((row) => row.id)).size, total);
    const fbaRows = rows.filter((row) => row.normalized.fba?.startsWith('FBA'));
    assert.equal(new Set(fbaRows.map((row) => row.normalized.fba)).size, fixture.counts.validFbaRows);
    assert(fbaRows.every((row) => row.normalized.sellerMappingId === null && row.status !== 'valid'));
    const original = fbaRows[0]!;
    assert(original.rawCells.some((cell) => cell.column === 'F' && cell.address === `F${original.rowNumber}`));
    assert(original.rawCells.some((cell) => cell.column === 'G'));
    assert(fbaRows.some((row) => row.issues.some((issue) => issue.code.includes('SELLER') || issue.code.includes('MAPPING'))));
    assert.equal(firstPreview.businessDate, first.import.businessDate);
    assert.equal(firstPreview.importedAt, first.import.importedAt);
    // T11 now exposes confirmation; malformed requests must be rejected without a write.
    assert.equal((await request(`/imports/${first.import.id}/commit`, admin.cookie, 'POST', {})).status, 422);
    return { sourceRows: total, distinctFba: fixture.counts.validFbaRows, realAliasApprovals: 0, businessDemandCommits: 0 };
  });
  await check('version-conflict-concurrent-replay-and-old-preview-retention', async () => {
    const sheet = firstPreview.latestRun!.sheetName!;
    const stale = await parse(first.import.id, { operationId: randomUUID(), expectedVersion: first.import.version, sheetName: sheet, mappingVersion: 'feishu-v1' });
    assert.equal(stale.status, 409);
    assert.equal((stale.data as ErrorBody).error.code, 'VERSION_CONFLICT');
    const body: ImportParseInput = { operationId: randomUUID(), expectedVersion: firstPreview.version, sheetName: sheet, mappingVersion: 'feishu-v1' };
    const repeated = await Promise.all([parse(first.import.id, body), parse(first.import.id, body)]);
    assert(repeated.every((result) => result.status === 202));
    assert.deepEqual(repeated.map((result) => importAcceptedSchema.parse(result.data).replayed).sort(), [false, true]);
    assert.equal(importAcceptedSchema.parse(repeated[0]!.data).run.id, importAcceptedSchema.parse(repeated[1]!.data).run.id);
    const conflict = await parse(first.import.id, { ...body, mappingVersion: 'manual-v1' });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.data as ErrorBody).error.code, 'OPERATION_CONFLICT');
    firstPreview = await settle(first.import.id);
    const oldRows = await request(`/imports/${first.import.id}/rows?parseRunId=${previewRunId}&pageSize=1`, admin.cookie);
    assert.equal(oldRows.status, 200);
    assert.equal(importRowsResponseSchema.parse(oldRows.data).parseRunId, previewRunId);
    assert.equal(firstPreview.businessDate, first.import.businessDate);
    assert.equal(firstPreview.importedAt, first.import.importedAt);
  });
  await check('authorized-original-download-integrity-failure-and-explicit-recovery', async () => {
    const path = `/files/${first.import.fileId}/download`;
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, actor.cookie)).status, 200);
    const downloaded = await request(path, admin.cookie);
    assert.equal(downloaded.status, 200);
    assert.equal(sha256(downloaded.bytes), originalSha);
    const stored = await pool.query<{ storage_key: string }>('select storage_key from file_index where id = $1', [first.import.fileId]);
    const storedPath = resolve(config.dataDir, stored.rows[0]!.storage_key);
    try {
      await writeFile(storedPath, Buffer.concat([sourceBytes, Buffer.from([0])]));
      const corrupted = await request(path, admin.cookie);
      assert.equal(corrupted.status, 503);
      assert.equal((corrupted.data as ErrorBody).error.code, 'FILE_INTEGRITY_ERROR');
      const accepted = await parse(first.import.id, { operationId: randomUUID(), expectedVersion: firstPreview.version,
        sheetName: firstPreview.latestRun!.sheetName!, mappingVersion: 'feishu-v1' });
      assert.equal(accepted.status, 202);
      firstPreview = await settle(first.import.id);
      assert.equal(firstPreview.status, 'failed');
      assert.equal(firstPreview.latestRun!.errorCode, 'FILE_INTEGRITY_ERROR');
    } finally { await writeFile(storedPath, sourceBytes); }
    const accepted = await parse(first.import.id, { operationId: randomUUID(), expectedVersion: firstPreview.version,
      sheetName: firstPreview.latestRun!.sheetName!, mappingVersion: 'feishu-v1' });
    assert.equal(accepted.status, 202);
    firstPreview = await settle(first.import.id);
    assert.equal(firstPreview.latestRun!.status, 'completed');
    assert.equal(firstPreview.businessDate, first.import.businessDate);
    assert.equal(firstPreview.importedAt, first.import.importedAt);
    const runId = firstPreview.latestRun!.id;
    await stopProcess(worker);
    await stopProcess(api);
    api = start('api');
    worker = start('worker');
    await waitUntil(async () => (await request('/health').catch(() => null))?.status === 200 ? true : null, 'Restarted API failed to start', 30_000);
    const restored = await get(first.import.id);
    assert.equal(restored.latestRun!.id, runId);
    assert.equal(restored.latestRun!.status, 'completed');
    return { originalDownloadedHash: originalSha, integrityFailure: 'FILE_INTEGRITY_ERROR', restoredAfterApiWorkerRestart: true };
  });
  await check('invalid-workbook-is-rejected-before-storage-and-queueing', async () => {
    const before = await pool.query('select id from source_import where created_by = $1', [admin.id]);
    const invalid = await request('/imports', admin.cookie, 'POST', uploadInput(randomUUID(), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), `t09-invalid-${runId}.xlsx`));
    assert.equal(invalid.status, 422);
    assert.equal((invalid.data as ErrorBody).error.code, 'INVALID_XLSX');
    assert.deepEqual((await pool.query('select id from source_import where created_by = $1', [admin.id])).rows, before.rows);
  });
  await check('permission-revocation-is-enforced-on-new-parse', async () => {
    await pool.query('update "user" set role = $2, banned = true where id = $1', [admin.id, 'finance']);
    try {
      const result = await parse(first.import.id, { operationId: randomUUID(), expectedVersion: firstPreview.version, sheetName: firstPreview.latestRun!.sheetName!, mappingVersion: 'feishu-v1' });
      assert.equal(result.status, 403);
      assert.equal((result.data as ErrorBody).error.code, 'FORBIDDEN');
      const download = await request(`/files/${first.import.fileId}/download`, admin.cookie);
      assert.equal(download.status, 403);
      assert.equal((download.data as ErrorBody).error.code, 'FORBIDDEN');
    } finally { await pool.query('update "user" set role = $2, banned = false where id = $1', [admin.id, 'admin']); }
  });
  await check('real-source-and-seller-candidates-remain-unchanged', async () => {
    assert.equal(sha256(await readFile(sourcePath)), originalSha);
    assert.equal(sha256(JSON.stringify((await pool.query('select * from seller_mapping order by id')).rows)), mappingDigest);
    return { unchangedOriginalSha256: originalSha, unchangedRealSellerMappings: realMappings.rows.length };
  });
} catch (error) {
  failed = true;
  steps.push({ name: currentStep, result: 'failed', details: { code: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'CHECK_FAILED' } });
  logError('T09 import acceptance stopped', error);
} finally {
  for (const child of processes.reverse()) await stopProcess(child);
  try {
    if (accountIds.length) {
      const files = await pool.query<{ storage_key: string; id: string }>('select id, storage_key from file_index where created_by = any($1::text[])', [accountIds]);
      const tx = await pool.connect();
      await tx.query('begin');
      try {
        await tx.query('delete from import_operation where actor_user_id = any($1::text[])', [accountIds]);
        await tx.query('delete from source_import_row where parse_run_id in (select id from import_parse_run where created_by = any($1::text[]))', [accountIds]);
        await tx.query('update source_import set latest_run_id = null where created_by = any($1::text[])', [accountIds]);
        await tx.query('delete from import_parse_run where created_by = any($1::text[])', [accountIds]);
        await tx.query('delete from operation_audit where actor_user_id = any($1::text[])', [accountIds]);
        await tx.query('delete from source_import where created_by = any($1::text[])', [accountIds]);
        await tx.query('delete from file_index where created_by = any($1::text[])', [accountIds]);
        await tx.query('update "user" set banned = true, ban_reason = $2 where id = any($1::text[])', [accountIds, 'T09 technical acceptance completed']);
        await tx.query('delete from session where user_id = any($1::text[])', [accountIds]);
        await tx.query('delete from account where user_id = any($1::text[])', [accountIds]);
        await tx.query('commit');
      } catch (error) { await tx.query('rollback'); await Promise.reject(error); }
      finally { tx.release(); }
      for (const file of files.rows) {
        const target = resolve(config.dataDir, file.storage_key);
        assert(target.startsWith(`${resolve(config.dataDir)}\\`) || target.startsWith(`${resolve(config.dataDir)}/`));
        await unlink(target);
      }
    }
    cleanupSucceeded = true;
  } catch (error) {
    failed = true;
    steps.push({ name: 'technical-fixture-cleanup', result: 'failed' });
    logError('T09 acceptance cleanup failed', error);
  }
  const report = { runId, createdAt: new Date().toISOString(), timezone: 'Asia/Shanghai', kind: 'real-postgresql-import-integration',
    result: failed ? 'failed' : 'passed', steps, technicalFixturesRemoved: cleanupSucceeded,
    scope: 'Real designated workbook parsed with temporary technical accounts; no real seller approval or demand commit',
    notCovered: ['business approval of real sid/aliases', 'real later additions/corrections', 'demand commit and weekly batches', 'browser interactions'] };
  if (reportPath) { const target = resolve(reportPath); await mkdir(dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(report, null, 2)}\n`); }
  await closeDatabase();
  console.log(`T09 import integration ${failed ? 'FAILED' : 'PASSED'} (${steps.filter((step) => step.result === 'passed').length} checks)`);
  if (failed) process.exitCode = 1;
}
