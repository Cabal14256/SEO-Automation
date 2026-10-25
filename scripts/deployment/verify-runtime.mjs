import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from '../trial/core.mjs';

const expect = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repository = fileURLToPath(new URL('../../', import.meta.url));

function optionsFrom(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    expect(['--config', '--recovery', '--accounts', '--report', '--skip-browser', '--enqueue-only', '--resume-task', '--expect-queued', '--help'].includes(key), 'Unknown verification option');
    if (['--skip-browser', '--enqueue-only', '--expect-queued', '--help'].includes(key)) options[key.slice(2)] = true;
    else { expect(args[index + 1] && !args[index + 1].startsWith('--'), 'Verification options require a value'); options[key.slice(2)] = args[++index]; }
  }
  expect(!(options.config && options.recovery), 'Choose --config or --recovery');
  expect(!options['enqueue-only'] || !options.recovery && !options['resume-task'], 'Choose HTTPS enqueue or recovery resume mode');
  expect(!options['resume-task'] || options.recovery && UUID.test(options['resume-task']), 'Recovery resume requires a task UUID and --recovery');
  expect(!options['expect-queued'] || options['resume-task'], 'Queued precheck requires --resume-task');
  return options;
}

// This verifier has no database connection and never submits imports, sync,
// confirmations, exports or business writes. Credentials remain in memory.
export async function verifyRuntime(options) {
  const startedAt = new Date().toISOString();
  const runId = randomUUID(); const checks = []; let browser;
  const configPath = resolve(options.recovery ?? options.config ?? resolve(repository, '.local/trial/runtime.json'));
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const recovery = Boolean(options.recovery);
  const enqueueOnly = Boolean(options['enqueue-only']); const resumeTaskId = options['resume-task'];
  const expectQueued = Boolean(options['expect-queued']); const queueMode = enqueueOnly || Boolean(resumeTaskId);
  const evidence = join(config.trialRoot, 'evidence'); await mkdir(evidence, { recursive: true });
  const defaultReport = enqueueOnly ? 'queue-pending-before-backup.json' : resumeTaskId ? expectQueued ? 'queue-pending-after-restore.json' : 'queue-resumed-after-restore.json' : recovery ? 'runtime-recovery.json' : 'runtime-https.json';
  const reportPath = resolve(options.report ?? join(evidence, defaultReport));
  const report = { kind: recovery ? 't23-recovery-http-runtime-verification' : 't23-target-https-runtime-verification',
    mode: enqueueOnly ? 'enqueue-before-backup' : resumeTaskId ? expectQueued ? 'restored-queue-precheck' : 'resume-existing-restored-task' : 'runtime-smoke',
    startedAt, result: 'failed', checks, externalBusinessRequests: 0, credentialsPrinted: false,
    scope: 'GET, administrator login and one explicitly technical demo task; no business acceptance',
    pending: recovery ? [] : ['operating-system-reboot', 'independent-lan-client', 'independent-backup-medium', 'signed-business-batch'] };
  let stage = 'configuration';
  try {
    const environment = parseEnv(await readFile(config.envPath, 'utf8'));
    expect(environment.LINGXING_REQUESTS_ENABLED === 'false', 'Runtime verification requires Lingxing outbound requests disabled');
    const origin = new URL(recovery ? `http://127.0.0.1:${config.apiPort ?? 3003}` : config.publicUrl).origin;
    const base = new URL(origin);
    expect(recovery ? base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) : base.protocol === 'https:', 'Unexpected runtime origin');
    expect(new URL(environment.BETTER_AUTH_URL).origin === origin && new URL(environment.WEB_ORIGIN).origin === origin, 'Runtime login and web origins must match the tested origin');
    const ca = recovery ? undefined : await readFile(join(config.caddyDataDir ?? join(config.trialRoot, 'caddy-data'), 'caddy/pki/authorities/local/root.crt'));
    const controlled = JSON.parse(await readFile(options.accounts ?? resolve(repository, '.local/development/accounts.json'), 'utf8'));
    const email = controlled.admin?.email; const password = controlled.admin?.password;
    expect(typeof email === 'string' && typeof password === 'string' && email && password, 'Controlled administrator account is unavailable');
    let cookie = ''; let requestCount = 0;
    const record = (name, details = {}) => checks.push({ name, result: 'passed', ...details });
    const request = async (path, { method = 'GET', body, authenticated = false } = {}) => {
      expect(path.startsWith('/') && !path.startsWith('//'), 'Only same-origin request paths are allowed');
      expect(method === 'GET' || method === 'POST' && ['/api/v1/auth/sign-in/email', '/api/v1/tasks'].includes(path), 'Verifier refuses this mutation');
      expect(!(resumeTaskId && method === 'POST' && path === '/api/v1/tasks'), 'Verifier refuses new tasks in recovery resume mode');
      const url = new URL(path, base); expect(url.origin === origin, 'Verifier refuses another origin');
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body)); requestCount++;
      return new Promise((done, reject) => {
        const transport = recovery ? http : https;
        const pending = transport.request(url, { method, ...(recovery ? {} : { ca, rejectUnauthorized: true }),
          headers: { Origin: origin, ...(authenticated ? { Cookie: cookie } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } }, (response) => {
          const tlsAuthorized = recovery ? null : response.socket.authorized === true;
          const tlsProtocol = recovery ? null : response.socket.getProtocol();
          const chunks = []; let size = 0;
          response.on('data', (chunk) => { size += chunk.length; if (size > 20 * 1024 * 1024) response.destroy(new Error('Response exceeded verification limit')); else chunks.push(chunk); });
          response.on('error', () => reject(new Error('Runtime response could not be read')));
          response.on('end', () => {
            const content = Buffer.concat(chunks); let data;
            if (String(response.headers['content-type']).includes('application/json')) { try { data = JSON.parse(content.toString('utf8')); } catch { reject(new Error('Runtime returned invalid JSON')); return; } }
            done({ status: response.statusCode, headers: response.headers, content, data, tlsAuthorized, tlsProtocol });
          });
        });
        pending.setTimeout(20_000, () => pending.destroy());
        pending.on('error', (error) => reject(new Error(`Runtime request failed (${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'TRANSPORT_ERROR'})`)));
        if (bytes) pending.write(bytes); pending.end();
      });
    };

    stage = 'health-and-certificate';
    const health = await request('/api/v1/health');
    expect(health.status === 200 && health.data?.database === 'ok', 'Database must be healthy');
    if (!enqueueOnly && !expectQueued) expect(health.data?.worker === 'ok', 'Database and Worker must both be healthy');
    if (!recovery) expect(health.tlsAuthorized, 'HTTPS certificate did not pass CA and hostname validation');
    record(recovery ? 'isolated-loopback-health' : 'internal-ca-and-hostname-validated-https', { database: 'ok', worker: health.data.worker, workerHealthRequired: !enqueueOnly && !expectQueued, tlsVerified: !recovery, tlsProtocol: health.tlsProtocol });

    stage = 'anonymous-protection';
    for (const path of ['/api/v1/dashboard', '/api/v1/imports', '/api/v1/weekly-batches', '/api/v1/batch-reports', '/api/v1/batch-reports/exports', '/api/v1/files/00000000-0000-4000-8000-000000000000/download']) {
      expect((await request(path)).status === 401, 'Anonymous access was not refused');
    }
    record('anonymous-business-and-download-routes-refused', { paths: 6 });

    stage = 'administrator-login';
    const login = await request('/api/v1/auth/sign-in/email', { method: 'POST', body: { email, password } });
    expect(login.status === 200, 'Controlled administrator login failed');
    const setCookies = login.headers['set-cookie'] ?? [];
    const sessionCookies = setCookies.filter((value) => /^[^=]*session_token=/.test(value));
    expect(sessionCookies.length > 0 && sessionCookies.every((value) => /;\s*HttpOnly(?:;|$)/i.test(value)), 'Session cookie must be HttpOnly');
    if (!recovery) expect(sessionCookies.every((value) => /;\s*Secure(?:;|$)/i.test(value)), 'HTTPS session cookie must be Secure');
    cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
    const session = await request('/api/v1/session', { authenticated: true });
    expect(session.status === 200 && session.data?.user?.role === 'admin', 'Administrator session is unavailable');
    record('administrator-session-cookie-protection', { role: 'admin', httpOnly: true, secure: !recovery, cookieValuesRecorded: false });

    const findTask = async (taskId) => {
      const listed = await request('/api/v1/tasks', { authenticated: true });
      expect(listed.status === 200, 'Technical task status is unavailable');
      const task = listed.data?.items?.find((item) => item.id === taskId);
      expect(task, 'Technical task was not found in this restored database');
      return task;
    };
    const awaitCompletion = async (taskId) => {
      const deadline = Date.now() + 45_000; let polls = 0;
      do {
        const task = await findTask(taskId); polls++;
        expect(task.status !== 'failed', 'Technical demo task failed');
        if (task.status === 'completed') return { polls, task };
        await sleep(500);
      } while (Date.now() < deadline);
      throw new Error('Technical demo task did not complete within 45 seconds');
    };
    if (queueMode) {
      stage = enqueueOnly ? 'enqueue-pending-backup-task' : 'resume-restored-backup-task';
      let taskId = resumeTaskId;
      if (enqueueOnly) {
        const submitted = await request('/api/v1/tasks', { method: 'POST', authenticated: true, body: { label: `T23 TECHNICAL PENDING BACKUP CHECK ${runId}` } });
        expect(submitted.status === 201 && UUID.test(submitted.data?.task?.id), 'Technical pending task was not submitted');
        taskId = submitted.data.task.id;
      }
      report.taskId = taskId;
      const initial = await findTask(taskId);
      expect(initial.label?.startsWith('T23 TECHNICAL PENDING BACKUP CHECK '), 'Technical restored task has an unexpected identity');
      report.taskCreatedAt = initial.createdAt; report.taskInitialStatus = initial.status;
      if (enqueueOnly || expectQueued) {
        expect(initial.status === 'queued', 'Technical backup task must remain queued while Worker is stopped');
        report.taskFinalStatus = 'queued';
        record(enqueueOnly ? 'technical-task-persisted-pending-before-backup' : 'same-technical-task-restored-pending-before-worker-start', { taskId, createdAt: initial.createdAt, status: 'queued', newTaskCreated: enqueueOnly, retainedForAudit: true });
      } else {
        const { polls, task } = await awaitCompletion(taskId);
        expect(task.createdAt === initial.createdAt, 'Technical restored task creation identity changed');
        report.taskFinalStatus = task.status;
        record('same-restored-technical-task-completed-without-resubmission', { taskId, createdAt: task.createdAt, completedAt: task.completedAt, polls, newTaskCreated: false, retainedForAudit: true });
      }
      report.requestCount = requestCount; report.result = 'passed';
      return { report, reportPath };
    }

    stage = 'business-read-and-download';
    for (const path of ['/api/v1/dashboard', '/api/v1/weekly-batches', '/api/v1/batch-reports']) expect((await request(path, { authenticated: true })).status === 200, 'Authorized business read failed');
    for (const path of ['/', '/imports', '/batches', '/batch-reports']) {
      const page = await request(path, { authenticated: true });
      expect(page.status === 200 && /text\/html/i.test(String(page.headers['content-type'])) && page.content.includes(Buffer.from('<div id="root">')), 'Built application page is unavailable');
    }
    record('built-pages-and-authorized-business-reads', { pages: 4, businessReads: 3 });
    const imports = await request('/api/v1/imports?page=1&pageSize=100', { authenticated: true });
    expect(imports.status === 200 && Array.isArray(imports.data?.items), 'Import history is unavailable');
    const original = imports.data.items.find((item) => UUID.test(item.fileId) && /^[0-9a-f]{64}$/i.test(item.sha256));
    expect(original, 'An existing indexed source file is required for download verification');
    const downloaded = await request(`/api/v1/files/${original.fileId}/download`, { authenticated: true });
    expect(downloaded.status === 200 && downloaded.content.length === original.byteSize && sha256(downloaded.content) === original.sha256, 'Authorized source download differs from its immutable index');
    expect((await request(`/api/v1/files/${original.fileId}/download`)).status === 401, 'Actual indexed file permits anonymous download');
    record('authorized-source-download-matches-index-and-denies-anonymous', { fileId: original.fileId, bytes: downloaded.content.length, sha256: original.sha256 });
    const exports = await request('/api/v1/batch-reports/exports', { authenticated: true });
    expect(exports.status === 200 && Array.isArray(exports.data?.items), 'Export history is unavailable');
    const published = exports.data.items.find((item) => item.status === 'completed' && UUID.test(item.fileId));
    if (published) {
      const file = await request(`/api/v1/files/${published.fileId}/download`, { authenticated: true });
      expect(file.status === 200 && file.content.subarray(0, 2).toString() === 'PK', 'Published XLSX download failed');
      record('authorized-historical-xlsx-download', { exportId: published.id, fileId: published.fileId, bytes: file.content.length, sha256: sha256(file.content) });
    } else checks.push({ name: 'authorized-historical-xlsx-download', result: 'pending', reason: 'No existing published XLSX; verifier does not create business exports' });
    const template = await request('/api/v1/batch-reports/intake-template.xlsx', { authenticated: true });
    expect(template.status === 200 && template.content.subarray(0, 2).toString() === 'PK', 'XLSX template download failed');
    record('authorized-xlsx-template-download', { bytes: template.content.length, sha256: sha256(template.content) });

    stage = 'technical-demo-task';
    const submitted = await request('/api/v1/tasks', { method: 'POST', authenticated: true, body: { label: `T23 TECHNICAL ${recovery ? 'RECOVERY' : 'RUNTIME'} CHECK ${runId}` } });
    expect(submitted.status === 201 && UUID.test(submitted.data?.task?.id), 'Technical demo task was not submitted');
    const taskId = submitted.data.task.id; const { polls } = await awaitCompletion(taskId);
    record('technical-demo-task-completed-through-persistent-worker', { taskId, polls, retainedForAudit: true });

    if (!recovery && !options['skip-browser']) {
      stage = 'real-chrome-browser';
      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch({ headless: true, channel: 'chrome' });
      const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage(); page.setDefaultTimeout(25_000); const pageErrors = []; const deniedRequests = [];
      await context.route('**/*', async (route) => {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin !== origin || request.method() !== 'GET' && !(request.method() === 'POST' && url.pathname === '/api/v1/auth/sign-in/email')) {
          deniedRequests.push({ method: request.method(), path: url.origin === origin ? url.pathname : '[external]' }); await route.abort(); return;
        }
        await route.continue();
      });
      page.on('pageerror', () => pageErrors.push('pageerror'));
      const first = await page.goto('/login');
      expect(first?.status() === 200 && new URL(page.url()).origin === origin, 'Chrome could not open trusted HTTPS application');
      const security = await first.securityDetails(); expect(security?.protocol, 'Chrome did not establish a verified TLS connection');
      await page.getByLabel('邮箱', { exact: true }).fill(email); await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('heading', { name: '发货任务工作台', exact: true }).waitFor();
      const browserSessionCookies = (await context.cookies()).filter((entry) => entry.name.endsWith('session_token'));
      expect(browserSessionCookies.length > 0 && browserSessionCookies.every((entry) => entry.secure && entry.httpOnly), 'Chrome session cookie protections differ');
      const screenshots = [];
      for (const [path, heading, label] of [['/batches', '周批次与人工分组', 'batches'], ['/batch-reports', '月汇总与批次成品表', 'reports']]) {
        await page.goto(path); await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        const file = `https-${label}-${runId}.png`; const mask = [page.getByText(email, { exact: true })];
        if (session.data.user.name) mask.push(page.getByText(session.data.user.name, { exact: true }));
        await page.screenshot({ path: join(evidence, file), fullPage: true, mask }); screenshots.push(file);
      }
      expect(pageErrors.length === 0 && deniedRequests.length === 0, 'Chrome observed a page error or unauthorized request');
      record('real-chrome-trusted-https-login-and-pages', { browser: 'chrome', ignoreHTTPSErrors: false, tlsProtocol: security.protocol, pageErrors: 0, unauthorizedRequests: 0, screenshots });
      await context.close();
    } else if (!recovery) checks.push({ name: 'real-chrome-trusted-https-login-and-pages', result: 'pending', reason: 'Explicitly skipped browser verification' });
    report.requestCount = requestCount; report.result = 'passed';
  } catch (error) {
    // Do not echo raw HTTP bodies, browser exceptions, cookies or account data.
    const safe = error instanceof Error && /^(?:Runtime |Only |Unexpected |Verifier |Unknown |Verification |Choose |Controlled |Database |HTTPS |Session |Administrator |Anonymous |Authorized |Built |Import |An existing |Actual |Export |Published |XLSX |Technical |Chrome )/.test(error.message) ? error.message : 'Verification failed; inspect controlled runtime logs';
    checks.push({ name: stage, result: 'failed', message: safe });
  } finally {
    if (browser) await browser.close().catch(() => undefined); report.completedAt = new Date().toISOString();
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return { report, reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = optionsFrom(process.argv.slice(2));
    if (options.help) console.log('verify-runtime.mjs --config <trial/runtime.json> [--enqueue-only] | --recovery <restored/runtime.json> [--resume-task <UUID> [--expect-queued]] [--accounts <controlled/accounts.json>] [--report <evidence.json>] [--skip-browser]');
    else {
      const { report, reportPath } = await verifyRuntime(options);
      console.log(JSON.stringify({ result: report.result, reportPath, ...(report.taskId ? { taskId: report.taskId, taskFinalStatus: report.taskFinalStatus } : {}), checks: report.checks.map(({ name, result }) => ({ name, result })), externalBusinessRequests: 0 }, null, 2));
      if (report.result !== 'passed') process.exitCode = 1;
    }
  } catch { console.error('Runtime verification could not initialize; check controlled configuration paths.'); process.exitCode = 1; }
}
