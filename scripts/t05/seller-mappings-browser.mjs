import { chooseOption } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// This suite uses the real running application and PostgreSQL. It creates only
// UUID-scoped technical mappings; business candidates are never approved.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(serverRoot, 'package.json'));
const { parse } = requireServer('dotenv');
Object.assign(process.env, parse(await readFile(resolve(serverRoot, '.env'))));
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/scm_automation_dev', 'Use the dedicated development database');
const { db, closeDatabase } = await import(pathToFileURL(resolve(serverRoot, 'dist/db/client.js')));
const { sellerMappings, sellerAliases, sellerMappingRevisions, operationAudit } = await import(pathToFileURL(resolve(serverRoot, 'dist/db/schema.js')));
const { inArray } = requireServer('drizzle-orm');
const { chromium } = await import('@playwright/test');
const credentialsFile = process.env.T05_CREDENTIALS_FILE || process.env.M0_CREDENTIALS_FILE;
assert(credentialsFile, 'Specify controlled local credentials via T05_CREDENTIALS_FILE');
const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
let baseURL = process.env.T05_BASE_URL || 'http://localhost:3001';
let acceptanceApi;
if (process.env.T05_START_API === '1') {
  const socket = createServer();
  await new Promise((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done); });
  const port = socket.address().port;
  await new Promise((done, reject) => socket.close((error) => error ? reject(error) : done()));
  baseURL = `http://127.0.0.1:${port}`;
  acceptanceApi = spawn(process.execPath, [resolve(serverRoot, 'dist/api.js')], {
    cwd: serverRoot, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), BETTER_AUTH_URL: baseURL, WEB_ORIGIN: baseURL },
  });
  acceptanceApi.on('error', () => undefined);
}
const evidenceDir = resolve(process.env.T05_BROWSER_EVIDENCE_DIR || '.local/t05/browser');
const runId = randomUUID();
const fixtureIds = [randomUUID(), randomUUID()];
const alias = `T05-${runId}-UI`;
const checks = [];
const errors = [];
const report = { kind: 'real-postgresql-seller-mapping-browser', runId, baseURL, timezone: 'Asia/Shanghai', startedAt: new Date().toISOString(), checks };
let currentStep = 'setup';
let browser;
let context;
let page;
let initialCatalogMode;
let catalogModeRestored = false;
await mkdir(evidenceDir, { recursive: true });
function record(name, details = {}) { checks.push({ name, result: 'passed', ...details }); console.log(`PASS ${name}`); }
async function signIn(role) {
  currentStep = `${role} login`;
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(credentials[role].email);
  await page.getByLabel('密码', { exact: true }).fill(credentials[role].password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '发货任务工作台', exact: true }).waitFor();
  await page.goto('/settings/seller-mappings');
  await page.getByRole('heading', { name: '店铺目录', exact: true }).waitFor();
}
async function signOut() {
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录发货协同', exact: true }).waitFor();
}
async function findFixtures() {
  await page.getByLabel('店铺名称、别名或 sid', { exact: true }).fill(runId);
  const loaded = page.waitForResponse((response) => response.url().includes('/api/v1/seller-mappings?') && response.status() === 200);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await loaded;
  await page.getByRole('row').filter({ hasText: `T05 UI ${runId} 0` }).waitFor();
}
async function openFirst() {
  await page.getByRole('row').filter({ hasText: `T05 UI ${runId} 0` }).getByRole('button', { name: '维护映射', exact: true }).click();
  await editor().getByRole('heading', { name: `维护：T05 UI ${runId} 0`, exact: true }).waitFor();
}
const editor = () => page.getByRole('dialog', { name: '维护店铺', exact: true });
async function closeEditor() { await editor().getByRole('button', { name: '关闭维护店铺', exact: true }).click(); await editor().waitFor({ state: 'hidden' }); }
async function openHistory() { await editor().locator('.mapping-history > summary').click(); await editor().locator('.mapping-history[open]').waitFor(); }
async function selectManualSource() {
  await page.getByRole('button', { name: '来源设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '店铺来源设置', exact: true });
  await dialog.getByRole('heading', { name: '选择店铺数据来源', exact: true }).waitFor();
  if (!await dialog.locator('input[type="radio"][value="manual"]').isChecked()) {
    await dialog.locator('input[type="radio"][value="manual"]').check();
    const pending = page.waitForResponse((response) => response.url().endsWith('/seller-mappings/catalog-settings') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '保存店铺来源', exact: true }).click();
    assert.equal((await pending).status(), 200);
    await dialog.getByText('当前生效：人工维护', { exact: false }).waitFor();
  }
  await dialog.getByRole('button', { name: '关闭店铺来源设置', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function restoreCatalogMode() {
  if (!initialCatalogMode || catalogModeRestored || !context) return;
  const currentResponse = await context.request.get('/api/v1/seller-mappings/catalog-settings');
  assert.equal(currentResponse.status(), 200);
  const { settings } = await currentResponse.json();
  if (settings.mode !== initialCatalogMode) {
    const restored = await context.request.post('/api/v1/seller-mappings/catalog-settings', { data: {
      operationId: randomUUID(), expectedVersion: settings.version, mode: initialCatalogMode,
    } });
    assert.equal(restored.status(), 200);
    assert.equal((await restored.json()).settings.mode, initialCatalogMode);
  }
  catalogModeRestored = true;
}
async function saveAndWait() {
  const response = page.waitForResponse((value) => value.url().endsWith(`/seller-mappings/${fixtureIds[0]}/revise`) && value.request().method() === 'POST');
  await editor().getByRole('button', { name: '保存映射及版本', exact: true }).click();
  return response;
}
try {
  if (acceptanceApi) {
    const deadline = Date.now() + 20_000;
    let healthy = false;
    while (Date.now() < deadline) {
      healthy = await fetch(`${baseURL}/api/v1/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.status === 200).catch(() => false);
      if (healthy) break;
      await delay(200);
    }
    assert(healthy, 'Isolated acceptance API did not start');
  }
  const existing = await db.select({ id: sellerMappings.id, status: sellerMappings.status, version: sellerMappings.version }).from(sellerMappings);
  report.realCandidatesBefore = existing.length;
  const sidBase = 1_800_000_000 + Math.floor(Math.random() * 50_000_000);
  for (let index = 0; index < fixtureIds.length; index++) {
    await db.insert(sellerMappings).values({ id: fixtureIds[index], sid: sidBase + index, name: `T05 UI ${runId} ${index}`,
      country: 'TEST', status: 'candidate', sourceObservedAt: new Date(), sourceSha256: '0'.repeat(64) });
  }
  await db.insert(sellerAliases).values({ sellerMappingId: fixtureIds[1], alias: `${alias}-taken`, normalizedAlias: `${alias}-taken`.toLowerCase() });
  browser = await chromium.launch({ headless: true, ...(process.env.T05_BROWSER_CHANNEL || process.env.M0_BROWSER_CHANNEL ? { channel: process.env.T05_BROWSER_CHANNEL || process.env.M0_BROWSER_CHANNEL } : {}) });
  report.browserVersion = browser.version();
  context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1024, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.name));
  currentStep = 'anonymous access';
  await page.goto('/settings/seller-mappings');
  await page.getByRole('heading', { name: '登录发货协同', exact: true }).waitFor();
  assert.equal((await context.request.get('/api/v1/seller-mappings')).status(), 401);
  record('匿名访问跳转登录且接口返回 401');
  assert.deepEqual(Object.keys(credentials), ['admin'], '本地凭据文件只应保留管理员');
  await signIn('admin');
  const initialSettings = await context.request.get('/api/v1/seller-mappings/catalog-settings');
  assert.equal(initialSettings.status(), 200);
  initialCatalogMode = (await initialSettings.json()).settings.mode;
  currentStep = 'pagination';
  const currentList = await context.request.get('/api/v1/seller-mappings?page=1&pageSize=20');
  assert.equal(currentList.status(), 200);
  const nextPage = page.getByRole('button', { name: '下一页', exact: true });
  if ((await currentList.json()).total > 20) {
    await nextPage.click();
    await page.getByText(/共 \d+ 家 · 第 2 页/).waitFor();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await page.getByText(/共 \d+ 家 · 第 1 页/).waitFor();
    record('真实目录分页前后切换');
  }
  await selectManualSource();
  await findFixtures();
  await openFirst();
  currentStep = 'approval validation';
  await chooseOption(page.getByLabel('映射状态', { exact: true }), 'approved');
  await page.getByLabel('需求别名（可选，每行一个）', { exact: true }).fill('Alias\nＡｌｉａｓ');
  await page.getByRole('checkbox', { name: '已核对店铺身份', exact: true }).check();
  await page.getByRole('button', { name: '保存映射及版本', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '别名规范化后不能重复' }).waitFor();
  record('可选别名规范化重复时显示真实校验反馈');
  currentStep = 'save technical approval';
  await page.getByLabel('需求别名（可选，每行一个）', { exact: true }).fill(alias);
  await page.getByRole('checkbox', { name: '已核对店铺身份', exact: true }).check();
  assert.equal((await saveAndWait()).status(), 200);
  await editor().getByRole('status').filter({ hasText: '已保存为版本 2' }).waitFor();
  await editor().getByText(/sid \d+ · 当前版本 2 · 最近更新/).waitFor();
  record('管理员批准技术映射并显示新版本和保存反馈');
  await openHistory();
  await editor().getByText(/首次批准：已核对店铺身份/).waitFor();
  await editor().getByText(/查看字段变化（\d+ 项）/).click();
  await editor().getByLabel('变更为', { exact: true }).first().waitFor();
  record('版本历史展示操作者、原因及前后字段变化');
  currentStep = 'alias conflict keeps draft';
  await page.getByLabel('需求别名（可选，每行一个）', { exact: true }).fill(`${alias}-taken`);
  await page.getByLabel('修改 / 批准原因', { exact: true }).fill('T05 UI duplicate alias technical check');
  assert.equal((await saveAndWait()).status(), 409);
  await page.getByRole('alert').filter({ hasText: '别名' }).waitFor();
  assert.equal(await page.getByLabel('需求别名（可选，每行一个）', { exact: true }).inputValue(), `${alias}-taken`);
  record('别名冲突返回 409 且表单保留草稿');
  currentStep = 'stale version keeps draft';
  await page.getByLabel('需求别名（可选，每行一个）', { exact: true }).fill(alias);
  const rows = await (await context.request.get(`/api/v1/seller-mappings?search=${runId}`)).json();
  const mapping = rows.items.find((item) => item.id === fixtureIds[0]);
  const concurrent = await context.request.post(`/api/v1/seller-mappings/${fixtureIds[0]}/revise`, { data: {
    operationId: randomUUID(), expectedVersion: mapping.version, name: mapping.name, country: 'CONCURRENT', marketplaceId: null,
    wid: null, aliases: mapping.aliases, status: mapping.status, reason: 'T05 UI concurrent technical change',
  } });
  assert.equal(concurrent.status(), 200);
  await page.getByLabel('国家', { exact: true }).fill('DRAFT');
  assert.equal((await saveAndWait()).status(), 409);
  await page.getByRole('alert').filter({ hasText: /当前数据版本已变化|已被更新|已被其他人修改/ }).waitFor();
  assert.equal(await page.getByLabel('国家', { exact: true }).inputValue(), 'DRAFT');
  record('其他会话先更新时阻止旧版本并保留草稿');
  currentStep = 'network interruption keeps draft';
  await context.setOffline(true);
  await page.getByRole('button', { name: '保存映射及版本', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /网络|连接|请求|fetch/i }).waitFor();
  assert.equal(await page.getByLabel('国家', { exact: true }).inputValue(), 'DRAFT');
  await context.setOffline(false);
  record('浏览器断网后保存失败，草稿保留');
  await closeEditor();
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await page.getByRole('row').filter({ hasText: `T05 UI ${runId} 0` }).getByText('版本 3', { exact: true }).waitFor();
  for (const width of [320, 390, 1024]) {
    currentStep = `responsive ${width}`;
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${width}px overall overflow`);
    const table = page.getByRole('region', { name: '店铺映射表，可横向滚动', exact: true });
    await table.focus();
    const scrollable = await table.evaluate((node) => node.scrollWidth > node.clientWidth);
    if (scrollable) {
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('[aria-label="店铺映射表，可横向滚动"]').scrollLeft > 0);
      await table.evaluate((node) => { node.scrollLeft = 0; });
    }
    await openFirst();
    await editor().getByLabel('店铺名称', { exact: true }).focus();
    assert.notEqual(await editor().getByLabel('店铺名称', { exact: true }).evaluate((node) => getComputedStyle(node).outlineStyle), 'none');
    await page.screenshot({ path: resolve(evidenceDir, `seller-mappings-${width}.png`), fullPage: true });
    record(`${width}px 搜索、表格键盘滚动、编辑表单与焦点`, { tableScrollable: scrollable });
    await closeEditor();
  }
  await restoreCatalogMode();
  await signOut();
  const after = (await db.select({ id: sellerMappings.id, status: sellerMappings.status, version: sellerMappings.version }).from(sellerMappings)).filter((row) => !fixtureIds.includes(row.id));
  assert.deepEqual(after.sort((a, b) => a.id.localeCompare(b.id)), existing.sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(errors, []);
  record('真实候选状态/版本保持不变，浏览器无未捕获错误');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.failure = { step: currentStep, error: error instanceof assert.AssertionError ? error.message : error?.name || 'Error' };
  console.error('FAIL T05 seller browser acceptance; inspect controlled local report.');
  process.exitCode = 1;
} finally {
  if (context) await context.setOffline(false).catch(() => undefined);
  try { await restoreCatalogMode(); } catch { report.result = 'failed'; process.exitCode = 1; }
  report.catalogModeRestored = catalogModeRestored;
  await browser?.close();
  if (acceptanceApi && acceptanceApi.exitCode === null && acceptanceApi.signalCode === null) {
    const exited = new Promise((done) => acceptanceApi.once('exit', done));
    acceptanceApi.kill('SIGTERM');
    await Promise.race([exited, delay(5_000)]);
    if (acceptanceApi.exitCode === null && acceptanceApi.signalCode === null) acceptanceApi.kill('SIGKILL');
  }
  try {
    await db.transaction(async (tx) => {
      await tx.delete(sellerAliases).where(inArray(sellerAliases.sellerMappingId, fixtureIds));
      await tx.delete(sellerMappingRevisions).where(inArray(sellerMappingRevisions.sellerMappingId, fixtureIds));
      await tx.delete(operationAudit).where(inArray(operationAudit.targetId, fixtureIds));
      await tx.delete(sellerMappings).where(inArray(sellerMappings.id, fixtureIds));
    });
    report.technicalFixturesRemoved = true;
  } catch {
    report.technicalFixturesRemoved = false;
    report.result = 'failed';
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  report.notCovered = ['real business approval of candidate aliases/sid/wid', 'real initial/incremental demand files', 'actual PostgreSQL service outage'];
  await writeFile(resolve(evidenceDir, 'seller-mappings-browser.json'), `${JSON.stringify(report, null, 2)}\n`);
  await closeDatabase();
}
