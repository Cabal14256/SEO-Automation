import { chooseOption } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The suite uses real UI, HTTP, database and Worker. Temporary technical accounts
// isolate uploads from business records and are disabled after the run.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(serverRoot, 'package.json'));
const { parse } = requireServer('dotenv');
Object.assign(process.env, parse(await readFile(resolve(serverRoot, '.env'))));
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/scm_automation_dev', 'Use the dedicated development database');
const { auth } = await import(pathToFileURL(resolve(serverRoot, 'dist/auth.js')));
const { pool, closeDatabase } = await import(pathToFileURL(resolve(serverRoot, 'dist/db/client.js')));
const { readAcceptanceFixture } = await import(pathToFileURL(resolve(serverRoot, 'dist/acceptance-fixture.js')));
const fixture = await readAcceptanceFixture();
const { chromium } = await import('@playwright/test');
const runId = randomUUID();
const sourcePath = fixture.sourceFile;
const evidenceDir = resolve(process.env.IMPORT_BROWSER_EVIDENCE_DIR || '.local/t09/browser');
const checks = [];
const errors = [];
const processes = [];
const accounts = {};
const accountIds = [];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let baseURL = process.env.IMPORT_BASE_URL || 'http://localhost:3001';
let browser;
let context;
let page;
let currentStep = 'setup';
let failed = false;
let cleanupSucceeded = false;
const report = { kind: 'real-postgresql-import-browser', runId, timezone: 'Asia/Shanghai', startedAt: new Date().toISOString(), checks };
await mkdir(evidenceDir, { recursive: true });
function record(name, details = {}) { checks.push({ name, result: 'passed', ...details }); console.log(`PASS ${name}`); }
async function waitUntil(action, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await delay(250); }
  throw new Error(message);
}
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(8_000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, delay(3_000)]); }
}
async function signIn(role) {
  currentStep = `${role} sign in`;
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(accounts[role].email);
  await page.getByLabel('密码', { exact: true }).fill(accounts[role].password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '发货任务工作台', exact: true }).waitFor();
  await page.goto('/imports');
  await page.locator('#imports-title').waitFor();
}
async function signOut() {
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录发货协同', exact: true }).waitFor();
}
const legacyDetail = () => page.locator('.import-detail');
async function openFileInput() {
  const dialog = page.getByRole('dialog', { name: '导入向导', exact: true });
  if (await dialog.isVisible() && !await dialog.getByRole('button', { name: '表格导入', exact: true }).isVisible()) {
    await dialog.getByRole('button', { name: '关闭导入向导', exact: true }).click();
    const discard = page.getByRole('dialog', { name: '保存到草稿箱？', exact: true }).getByRole('button', { name: '不保存，退出', exact: true });
    if (await discard.isVisible()) await discard.click();
  }
  if (!await dialog.isVisible()) {
    const fresh = page.getByRole('button', { name: '新建导入', exact: true });
    if (await fresh.isVisible()) await fresh.click();
    else await page.getByRole('button', { name: '新增需求', exact: true }).click();
  }
  await dialog.waitFor();
  const fileDialog = page.getByRole('dialog', { name: '表格导入', exact: true });
  if (!await fileDialog.isVisible()) await dialog.getByRole('button', { name: '表格导入', exact: true }).click();
  await fileDialog.getByLabel('需求文件', { exact: true }).waitFor({ state: 'visible' });
  return fileDialog;
}
async function openLegacyDetail(id) {
  await page.getByRole('dialog', { name: '导入向导', exact: true }).getByRole('button', { name: '查看导入详情', exact: true }).click();
  const discard = page.getByRole('dialog', { name: '保存到草稿箱？', exact: true }).getByRole('button', { name: '不保存，退出', exact: true });
  if (await discard.isVisible()) await discard.click();
  await page.waitForURL((url) => url.pathname === `/imports/${id}`);
  await legacyDetail().getByRole('heading', { name: '文件解析详情', exact: true }).waitFor();
}
async function upload(name = fixture.originalName, bytes) {
  const dialog = await openFileInput();
  const pending = page.waitForResponse((response) => response.url().endsWith('/api/v1/imports') && response.request().method() === 'POST');
  await dialog.getByLabel('需求文件', { exact: true }).setInputFiles(bytes ? { name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes } : sourcePath);
  report.lastUploadState = await page.evaluate(() => ({
    dialogOpen: document.querySelector('dialog[aria-labelledby]')?.open,
    selectedBytes: document.getElementById('import-file')?.files?.[0]?.size,
    buttonDisabled: [...document.querySelectorAll('button')].find((node) => node.textContent === '上传并校验')?.disabled,
    alerts: [...document.querySelectorAll('[role="alert"]')].filter((node) => node.checkVisibility()).map((node) => node.textContent),
  }));
  const response = await pending;
  assert.equal(response.status(), 202);
  await dialog.waitFor({ state: 'hidden' });
  return response.json();
}
async function settle(id) {
  return waitUntil(async () => {
    const response = await context.request.get(`/api/v1/imports/${id}`);
    assert.equal(response.status(), 200);
    const { import: result } = await response.json();
    return ['completed', 'failed'].includes(result.latestRun?.status) ? result : null;
  }, 'Real Worker did not finish within 60 seconds');
}

try {
  const sourceBytes = await readFile(sourcePath);
  const originalSha = sha256(sourceBytes);
  assert.equal(originalSha, fixture.sourceSha256);
  const mappingDigest = sha256(JSON.stringify((await pool.query('select * from seller_mapping order by id')).rows));
  const socket = createServer();
  await new Promise((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done); });
  const port = socket.address().port;
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  baseURL = `http://127.0.0.1:${port}`;
  report.baseURL = baseURL;
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), BETTER_AUTH_URL: baseURL, WEB_ORIGIN: baseURL, LINGXING_REQUESTS_ENABLED: 'false' };
  for (const script of ['api', 'worker']) {
    const child = spawn(process.execPath, [resolve(serverRoot, `dist/${script}.js`)], { cwd: serverRoot, env, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    processes.push(child);
  }
  await waitUntil(async () => {
    try { return (await fetch(`${baseURL}/api/v1/health`)).status === 200; } catch { return false; }
  }, 'Acceptance API did not start', 30_000);
  for (const role of ['admin']) {
    const email = `t09-ui-${runId}-${role}@acceptance.invalid`;
    const password = `T09-${randomUUID()}-${randomUUID()}`;
    const created = await auth.api.createUser({ body: { email, password, name: `T09 browser ${role}`, role } });
    accountIds.push(created.user.id);
    accounts[role] = { email, password, id: created.user.id };
  }
  browser = await chromium.launch({ headless: true, ...(process.env.IMPORT_BROWSER_CHANNEL ? { channel: process.env.IMPORT_BROWSER_CHANNEL } : {}) });
  report.browserVersion = browser.version();
  context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.name));
  await page.addInitScript(() => {
    window.__t09DialogEvents = [];
    for (const type of ['click', 'submit', 'close', 'cancel']) document.addEventListener(type, (event) => {
      const button = event.target.closest?.('button'); const dialog = event.target.closest?.('dialog');
      if (!dialog && !button?.textContent?.includes('导入')) return;
      const entry = { type, target: event.target.tagName, button: button?.textContent, dialogOpen: dialog?.open, x: event.clientX, y: event.clientY };
      window.__t09DialogEvents.push(entry);
      setTimeout(() => { entry.prevented = event.defaultPrevented; entry.openAfter = dialog?.open; }, 0);
    }, true);
  });
  page.setDefaultTimeout(15_000);
  await signIn('admin');
  record('管理员真实登录后进入需求导入');
  currentStep = 'client validation';
  const fileDialog = await openFileInput();
  assert.equal(await fileDialog.getByRole('button', { name: '上传并校验', exact: true }).count(), 0);
  await page.getByLabel('需求文件', { exact: true }).setInputFiles({ name: 'unsupported.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('invalid') });
  await page.getByRole('alert').filter({ hasText: '目前支持 .xlsx 工作簿' }).waitFor();
  record('页面默认等待文件选择且旧 XLS 格式显示校验反馈');
  currentStep = 'upload real designated workbook';
  const accepted = await upload();
  const importId = accepted.import.id;
  await openLegacyDetail(importId);
  let detail = await settle(importId);
  assert.notEqual(detail.status, 'failed');
  await page.getByRole('button', { name: '刷新详情', exact: true }).click();
  await legacyDetail().getByLabel('输入工作表', { exact: true }).waitFor();
  record('页面上传 → 原文件保存 → 异步解析与工作表发现', { importId, worksheetCount: detail.sheets.length });
  currentStep = 'explicit parse';
  const sheet = detail.sheets.find((value) => value.name.trim() === '飞书表格');
  assert(sheet);
  await chooseOption(legacyDetail().getByLabel('输入工作表', { exact: true }), sheet.name);
  await chooseOption(legacyDetail().getByLabel('字段映射', { exact: true }), 'feishu-v1');
  const [parsed] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/imports/${importId}/parse`) && response.request().method() === 'POST'),
    page.getByRole('button', { name: '按此映射重新解析', exact: true }).click(),
  ]);
  assert.equal(parsed.status(), 202);
  detail = await settle(importId);
  assert.equal(detail.latestRun.status, 'completed');
  await page.getByRole('button', { name: '刷新详情', exact: true }).click();
  await page.getByRole('heading', { name: '源行预览', exact: true }).waitFor();
  const sourceTable = legacyDetail().getByRole('region', { name: '需求源行预览表，可横向滚动', exact: true });
  await sourceTable.getByRole('row').nth(1).waitFor();
  assert.equal(detail.businessDate, accepted.import.businessDate);
  assert.equal(detail.importedAt, accepted.import.importedAt);
  assert.equal(detail.latestRun.counts.validFbaRows, fixture.counts.validFbaRows);
  await page.getByText('已完成解析，请在下方核对并确认业务需求。', { exact: false }).waitFor();
  record('选择飞书输入映射并预览 FBA，上海业务日期固定', { businessDate: detail.businessDate, validFbaRows: fixture.counts.validFbaRows });
  currentStep = 'source trace and filters';
  await sourceTable.locator('summary').first().click();
  await sourceTable.getByText('原始值：', { exact: false }).first().waitFor();
  await sourceTable.locator('summary').first().click();
  await legacyDetail().getByText('查看工作表结构与表头', { exact: true }).click();
  await chooseOption(legacyDetail().getByLabel('按校验状态筛选', { exact: true }), 'needs_review');
  await waitUntil(async () => {
    const response = await context.request.get(`/api/v1/imports/${importId}/rows?pageSize=1&status=needs_review`);
    return response.status() === 200 && (await response.json()).total > 0;
  }, 'Expected review rows not found');
  await legacyDetail().locator('.import-source-rows').getByRole('button', { name: '下一页', exact: true }).click();
  await legacyDetail().locator('.import-source-rows').getByText('第 2 页', { exact: false }).waitFor();
  await legacyDetail().locator('.import-source-rows').getByRole('button', { name: '上一页', exact: true }).click();
  record('源行位置、单元格详情、表头结构、筛选和分页');
  currentStep = 'original download and historical rows';
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载原文件', exact: true }).click(),
  ]);
  assert.equal(sha256(await readFile(await download.path())), originalSha);
  await page.locator('.import-run-history').getByRole('button', { name: '查看此版本源行', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: '当前查看历史解析版本' }).waitFor();
  await page.locator('.import-run-history li').first().getByRole('button', { name: '查看此版本源行', exact: true }).click();
  await waitUntil(async () => await page.getByRole('status').filter({ hasText: '当前查看历史解析版本' }).count() === 0, 'Historical view did not return to current');
  record('页面授权下载原文件哈希一致，历史解析源行可返回查看');
  currentStep = 'stale preview version feedback';
  const externalParse = await context.request.post(`/api/v1/imports/${importId}/parse`, { data: { operationId: randomUUID(), expectedVersion: detail.version, sheetName: sheet.name, mappingVersion: 'feishu-v1' } });
  assert.equal(externalParse.status(), 202);
  detail = await settle(importId);
  const [stale] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/imports/${importId}/parse`) && response.request().method() === 'POST'),
    page.getByRole('button', { name: '按此映射重新解析', exact: true }).click(),
  ]);
  assert.equal(stale.status(), 409);
  await legacyDetail().getByRole('alert').filter({ hasText: '请刷新详情后核对最新解析版本' }).waitFor();
  assert.equal(await legacyDetail().getByLabel('输入工作表', { exact: true }).getAttribute('data-value'), sheet.name);
  assert.equal(await legacyDetail().getByLabel('字段映射', { exact: true }).getAttribute('data-value'), 'feishu-v1');
  await page.getByRole('button', { name: '刷新详情', exact: true }).click();
  await page.getByRole('heading', { name: '源行预览', exact: true }).waitFor();
  record('过期预览版本返回 409 并保留选择，刷新后恢复');
  currentStep = 'repeated upload';
  await page.evaluate(() => { window.__t09DialogEvents = []; });
  const repeated = await upload();
  assert.equal(repeated.import.id, importId);
  assert(repeated.deduplicated || repeated.replayed);
  await page.getByRole('dialog', { name: '导入向导', exact: true }).getByRole('status').filter({ hasText: /已找到相同内容的导入记录|已恢复上次接收结果/ }).waitFor();
  await openLegacyDetail(importId);
  record('重复文件复用原导入并显示反馈，业务日期保持');
  for (const width of [320, 390, 1024]) {
    currentStep = `responsive ${width}px`;
    await page.setViewportSize({ width, height: 900 });
    await sourceTable.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${width}px whole-page overflow`);
    await sourceTable.focus();
    if (await sourceTable.evaluate((node) => node.scrollWidth > node.clientWidth)) {
      await page.keyboard.press('ArrowRight');
      await waitUntil(() => sourceTable.evaluate((node) => node.scrollLeft > 0), 'Keyboard horizontal scrolling failed', 3_000);
      await sourceTable.evaluate((node) => { node.scrollLeft = 0; });
    }
    if (width < 768) {
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await page.locator('#mobile-navigation').getByRole('link', { name: '需求导入', exact: true }).click();
      assert.equal(await page.locator('#mobile-navigation').count(), 0);
      await page.goto(`/imports/${importId}`);
      await sourceTable.waitFor();
    }
    await page.screenshot({ path: resolve(evidenceDir, `imports-${width}.png`), fullPage: true });
    record(`${width}px 导航、页面边界与源行表键盘横向滚动`);
  }
  await signOut();
  await signIn('admin');
  await page.goto(`/imports/${importId}`);
  await page.getByRole('heading', { name: '源行预览', exact: true }).waitFor();
  record('管理员重新登录后可读取原导入及源行');
  currentStep = 'invalid workbook feedback';
  const invalid = await upload(`t09-ui-invalid-${runId}.xlsx`, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]));
  const invalidResult = await settle(invalid.import.id);
  assert.equal(invalidResult.status, 'failed');
  await openLegacyDetail(invalid.import.id);
  await page.getByRole('button', { name: '刷新详情', exact: true }).click();
  await legacyDetail().getByRole('alert').filter({ hasText: '本次解析失败' }).waitFor();
  record('无效 XLSX 的持久失败与页面反馈');
  assert.equal(sha256(await readFile(sourcePath)), originalSha);
  assert.equal(sha256(JSON.stringify((await pool.query('select * from seller_mapping order by id')).rows)), mappingDigest);
  assert.equal(errors.length, 0);
  record('原附件及真实店铺候选不变，浏览器无未处理异常');
} catch (error) {
  failed = true;
  checks.push({ name: currentStep, result: 'failed', code: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'CHECK_FAILED' });
  const safeMessage = Object.values(accounts).reduce((message, account) => message.replaceAll(account.password, '[technical password]'), error.message);
  report.failure = { step: currentStep, error: error.name, message: safeMessage };
  if (page) report.dialogEvents = await page.evaluate(() => window.__t09DialogEvents ?? []).catch(() => []);
  console.error(`T09 browser check failed: ${currentStep}`, { error: error.name, message: safeMessage });
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failed.png'), fullPage: true }).catch(() => undefined);
} finally {
  await browser?.close();
  for (const child of processes.reverse()) await stopProcess(child);
  try {
    if (accountIds.length) {
      const files = await pool.query('select id, storage_key from file_index where created_by = any($1::text[])', [accountIds]);
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
        await tx.query('update "user" set banned = true, ban_reason = $2 where id = any($1::text[])', [accountIds, 'T09 browser acceptance completed']);
        await tx.query('delete from session where user_id = any($1::text[])', [accountIds]);
        await tx.query('delete from account where user_id = any($1::text[])', [accountIds]);
        await tx.query('commit');
      } catch (error) { await tx.query('rollback'); throw error; }
      finally { tx.release(); }
      for (const file of files.rows) { const target = resolve(process.env.DATA_DIR, file.storage_key); assert(target.startsWith(resolve(process.env.DATA_DIR) + sep)); await unlink(target); }
    }
    cleanupSucceeded = true;
  } catch { failed = true; checks.push({ name: 'technical fixture cleanup', result: 'failed' }); }
  report.result = failed ? 'failed' : 'passed';
  report.completedAt = new Date().toISOString();
  report.technicalFixturesRemoved = cleanupSucceeded;
  report.scope = 'Technical uploads only; no real seller approval, demand commit or Lingxing request';
  await writeFile(resolve(evidenceDir, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`);
  await closeDatabase();
  console.log(`T09 browser ${failed ? 'FAILED' : 'PASSED'} (${checks.filter((check) => check.result === 'passed').length} checks)`);
  if (failed) process.exitCode = 1;
}
