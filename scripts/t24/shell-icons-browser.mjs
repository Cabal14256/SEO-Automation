import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

// Run only the frontend. Every API request is fulfilled locally; no accounts,
// business databases, authentication service, or Lingxing connection is used.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.SHELL_ICONS_EVIDENCE_DIR || resolve(root, '.local/t28/shell-icons'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-18T04:00:00.000Z';
const user = { id: 'fixture-admin', name: '技术界面检查', email: 'fixture@example.invalid', role: 'admin' };
let settings = { mode: 'lingxing', version: 1, catalogVersion: 1, lastSyncedAt: null, lastError: null, configured: false, readOnly: true };
let mapping = {
  id: randomUUID(), sid: 42, name: '技术示例店铺', country: '美国', marketplaceId: null, wid: null,
  aliases: ['示例别名'], status: 'approved', version: 1, updatedAt: now, sourceObservedAt: now, sourceSha256: '0'.repeat(64),
  dataSource: 'manual', manualEnabled: true, lingxingName: null, lingxingStatus: null, identityLocked: true,
};
const task = { id: randomUUID(), label: '技术任务', status: 'running', createdAt: now, updatedAt: now, completedAt: null, error: null, result: null };
const checks = []; const browserErrors = []; const unexpectedApi = []; const revisions = []; const modeWrites = [];
const releases = new Map();
let signedIn = false; let loginWrites = 0; let taskReads = 0; let rejectRevision = true;
let browser; let context; let processHandle; let failed = false;
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
const hold = (name) => new Promise((done) => releases.set(name, done));
const release = (name) => { const done = releases.get(name); assert(done, `Missing held request: ${name}`); releases.delete(name); done(); };

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* Vite is starting. */ }
    await delay(100);
  }
  throw new Error('Vite did not start');
}

async function iconTargets(page) {
  const controls = page.locator('.icon-button:visible');
  assert(await controls.count() > 0);
  for (const control of await controls.all()) {
    const label = await control.getAttribute('aria-label');
    assert(label?.trim(), 'Icon controls need an accessible name');
    const box = await control.boundingBox();
    assert(box && box.width >= 44 && box.height >= 44, `${label}: expected a 44px target`);
    assert.equal(await control.locator('svg[aria-hidden="true"], [aria-hidden="true"] svg').count(), 1, `${label}: icon must be decorative`);
  }
}
async function checkShippingChildren(navigation) {
  const parent = navigation.getByRole('button', { name: '发货管理', exact: true });
  if (await parent.getAttribute('aria-expanded') !== 'true') await parent.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  const children = navigation.getByRole('navigation', { name: '发货管理子导航', exact: true });
  await expect(children).toBeVisible();
  const shippingNavigation = [['发货工作台', 'demands'], ['发票与单据', 'documents'], ['领星单据与分配', 'fulfillment'], ['物流与交接', 'logistics'], ['报关与 9810', 'customs'], ['批次归档', 'archives']];
  await expect(children.getByRole('link')).toHaveCount(shippingNavigation.length);
  await expect(children.getByRole('link')).toHaveText(shippingNavigation.map(([label]) => label));
  for (const [label, view] of shippingNavigation) {
    await expect(children.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', `/shipping?view=${view}`);
  }
  await expect(children.locator('a[aria-current="page"]')).toHaveCount(0);
  await parent.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await expect(children).toBeHidden();
}

async function tooltipAtKeyboardFocus(page, control, expectedText) {
  await page.mouse.move(0, 0);
  await control.scrollIntoViewIfNeeded();
  // Establish keyboard modality before focusing a specific fixture control.
  await page.keyboard.press('Tab');
  await control.focus();
  const tooltip = page.getByRole('tooltip').filter({ hasText: expectedText });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(expectedText);
  const box = await tooltip.boundingBox();
  const viewport = page.viewportSize();
  assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'Tooltip must remain in the viewport');
  assert.equal(await control.evaluate((node) => getComputedStyle(node).outlineStyle !== 'none'), true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(control).toBeFocused();
}

async function pendingDimensions(page, before, pending) {
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  // Let the brief press transform settle while the fixture keeps HTTP pending.
  await page.mouse.move(0, 0);
  await expect.poll(async () => {
    const after = await pending.boundingBox();
    return Boolean(after && Math.abs(after.width - before.width) < 0.5 && Math.abs(after.height - before.height) < 0.5);
  }, { timeout: 1500 }).toBe(true);
  assert.equal(await pending.locator('.motion-spin').count(), 1);
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  processHandle = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await waitForServer(baseURL);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const url = new URL(request.url());
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedApi.push(`${request.method()} EXTERNAL ${url.origin}`); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user: signedIn ? user : null });
    if (path === '/api/v1/auth/sign-in/email') { loginWrites += 1; await hold('login'); signedIn = true; return json({}); }
    if (path === '/api/v1/auth/sign-out') { signedIn = false; return json({}); }
    if (path === '/api/v1/dashboard') return json({ tasks: { queued: 0, running: 1, completed: 0, failed: 0 }, health: { database: 'ok', worker: 'ok' } });
    if (path === '/api/v1/tasks' && request.method() === 'GET') { taskReads += 1; return json({ items: [task] }); }
    if (path === '/api/v1/seller-mappings/catalog-settings') {
      if (request.method() === 'GET') return json({ settings });
      const input = request.postDataJSON(); modeWrites.push(input); await hold('mode');
      settings = { ...settings, mode: input.mode, version: settings.version + 1 };
      return json({ settings, replayed: false });
    }
    if (path === '/api/v1/seller-mappings' && request.method() === 'GET') return json({ items: [mapping], total: 1, settings });
    if (path === `/api/v1/seller-mappings/${mapping.id}/history`) return json({ items: [] });
    if (path === `/api/v1/seller-mappings/${mapping.id}/revise`) {
      const input = request.postDataJSON(); revisions.push(input); await hold('revision');
      if (rejectRevision) {
        rejectRevision = false; mapping = { ...mapping, version: mapping.version + 1 };
        return json({ error: { code: 'VERSION_CONFLICT' } }, 409);
      }
      mapping = { ...mapping, name: input.name, country: input.country, aliases: input.aliases, status: input.status, version: mapping.version + 1 };
      return json({ mapping });
    }
    unexpectedApi.push(`${request.method()} ${path}`);
    return json({ error: { code: 'NOT_FOUND', message: `Unhandled isolated fixture: ${path}` } }, 404);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(user.email);
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-password');
  const login = page.getByRole('button', { name: '登录', exact: true });
  const loginBox = await login.boundingBox(); assert(loginBox);
  await login.click();
  await pendingDimensions(page, loginBox, page.getByRole('button', { name: '正在登录…', exact: true }));
  assert.equal(loginWrites, 1);
  release('login');
  await page.getByRole('heading', { name: '发货任务工作台', exact: true }).waitFor();
  const businessNav = page.locator('.sidebar').getByRole('navigation', { name: '业务导航', exact: true });
  await expect(businessNav.locator(':scope > a')).toHaveCount(2);
  await expect(businessNav.getByRole('link', { name: '工作台', exact: true })).toHaveAttribute('href', '/');
  await expect(businessNav.getByRole('link', { name: '费用对账', exact: true })).toHaveAttribute('href', '/finance');
  await expect(businessNav.getByRole('button', { name: '发货管理', exact: true })).toHaveCount(1);
  await checkShippingChildren(businessNav);
  await expect(businessNav.getByRole('link', { name: '设置', exact: true })).toHaveCount(0);
  const footerSettings = page.locator('.sidebar-foot').getByRole('navigation', { name: '全局设置', exact: true }).getByRole('link', { name: '设置', exact: true });
  await expect(footerSettings).toHaveAttribute('href', '/settings');
  note('Login keeps its dimensions and accessible loading label while preventing duplicate submissions');

  const toggle = page.locator('.sidebar-foot button');
  await page.keyboard.press('Tab'); await toggle.focus();
  const toggleHandle = await toggle.elementHandle(); assert(toggleHandle);
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press('Enter');
    const collapsed = index % 2 === 0;
    await expect(toggle).toHaveAccessibleName(collapsed ? '展开侧栏' : '收起侧栏');
    await expect(toggle).toBeFocused();
    assert.equal(await toggleHandle.evaluate((node) => node.isConnected && document.activeElement === node), true, 'Toggling must retain the same focused button');
    await expect(footerSettings).toBeVisible();
    await expect(footerSettings).toHaveAccessibleName('设置');
  }
  assert.equal(await page.evaluate(() => localStorage.getItem('scm-sidebar-collapsed')), 'false');
  note('Repeated keyboard collapse and expand preserve the focused DOM button and stored preference');

  await page.getByLabel('任务名称', { exact: true }).fill('未提交的界面草稿');
  const taskInput = page.getByLabel('任务名称', { exact: true });
  await taskInput.focus();
  await page.evaluate(() => {
    window.__shellEntrances = [];
    document.addEventListener('animationstart', (event) => { if (!event.target.closest('.motion-spin')) window.__shellEntrances.push(event.animationName); });
  });
  const readsBefore = taskReads;
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await expect.poll(() => taskReads, { timeout: 7000 }).toBeGreaterThan(readsBefore);
  await expect(taskInput).toBeFocused();
  await expect(taskInput).toHaveValue('未提交的界面草稿');
  assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
  assert.deepEqual(await page.evaluate(() => window.__shellEntrances), []);
  note('Dashboard polling preserves focus, scroll, draft input, and settled entrance animations');

  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await iconTargets(page);
    const logout = page.getByRole('button', { name: '退出登录', exact: true });
    await tooltipAtKeyboardFocus(page, logout, '退出登录');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Dashboard overflow at ${width}px`);
    if (width < 768) {
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await expect(page.locator('#mobile-navigation')).toBeVisible();
      const mobileBusiness = page.locator('#mobile-navigation').getByRole('navigation', { name: '业务导航', exact: true });
      await expect(mobileBusiness.locator(':scope > a')).toHaveCount(2);
      await expect(mobileBusiness.getByRole('link', { name: '费用对账', exact: true })).toHaveAttribute('href', '/finance');
      await checkShippingChildren(mobileBusiness);
      await expect(page.locator('#mobile-navigation').getByRole('link', { name: '设置', exact: true })).toHaveCount(0);
      const mobileSettings = page.locator('.account-controls').getByRole('link', { name: '设置', exact: true });
      await expect(mobileSettings).toBeVisible();
      await expect(mobileSettings).toHaveAttribute('href', '/settings');
      await tooltipAtKeyboardFocus(page, mobileSettings, '设置');
      await page.locator('#mobile-navigation').getByRole('link', { name: '工作台', exact: true }).click();
      await expect(page.locator('#mobile-navigation')).toHaveCount(0);
    } else {
      await toggle.click();
      const home = page.locator('.sidebar').getByRole('link', { name: '工作台', exact: true });
      await tooltipAtKeyboardFocus(page, home, '工作台');
      await expect(home).toHaveAttribute('href', '/');
      await expect(home).toHaveAttribute('aria-current', 'page');
      await tooltipAtKeyboardFocus(page, footerSettings, '设置');
      const compactShipping = businessNav.getByRole('button', { name: '发货管理', exact: true });
      await tooltipAtKeyboardFocus(page, compactShipping, '发货管理');
      await compactShipping.click();
      await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed', 'false');
      await expect(compactShipping).toHaveAttribute('aria-expanded', 'true');
      await checkShippingChildren(businessNav);
    }
    await page.screenshot({ path: resolve(evidence, `dashboard-${width}.png`) });
  }
  note('Dashboard icons, real navigation links, keyboard tooltips, and mobile menu work at 320/390/1024/1440px');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.locator('.status-running .motion-spin').evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: '刷新', exact: true }).focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  assert.equal(await page.getByRole('tooltip').evaluate((node) => getComputedStyle(node).animationName), 'none');
  await page.keyboard.press('Escape');
  note('Reduced motion removes continuous status rotation and tooltip entrance motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await footerSettings.click();
  await expect(page).toHaveURL(`${baseURL}/settings/seller-mappings`);
  await expect(footerSettings).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '店铺映射', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('heading', { name: '店铺目录', exact: true }).waitFor();
  await page.getByRole('button', { name: '来源设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '店铺来源设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '同步领星实际店铺', exact: true })).toBeDisabled();
  await expect(page.getByText('服务端尚未配置领星连接，请配置后同步。', { exact: true })).toBeVisible();
  await page.locator('input[type="radio"][value="manual"]').check();
  const saveMode = page.getByRole('button', { name: '保存店铺来源', exact: true });
  const saveModeBox = await saveMode.boundingBox(); assert(saveModeBox);
  await saveMode.click();
  await pendingDimensions(page, saveModeBox, page.getByRole('button', { name: '正在保存来源…', exact: true }));
  assert.equal(modeWrites.length, 1); assert.equal(modeWrites[0].expectedVersion, 1); assert.equal(modeWrites[0].mode, 'manual');
  release('mode');
  await expect(page.getByRole('status').filter({ hasText: '来源设置已保存' })).toBeVisible();
  await page.getByRole('button', { name: '关闭店铺来源设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '店铺来源设置', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '新增人工店铺', exact: true })).toBeVisible();
  note('Unconfigured sync stays blocked and source selection saves with a stable loading button');

  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const edit = page.getByRole('button', { name: '维护映射', exact: true });
    await tooltipAtKeyboardFocus(page, edit, '技术示例店铺 · sid 42');
    await iconTargets(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Seller page overflow at ${width}px`);
    await page.screenshot({ path: resolve(evidence, `sellers-${width}.png`) });
  }
  note('Seller row actions retain object descriptions, accessible names, and bounded tooltips at four viewport widths');

  await page.getByRole('button', { name: '维护映射', exact: true }).click();
  await expect(page.getByRole('heading', { name: '维护：技术示例店铺', exact: true })).toBeFocused();
  await expect(page.locator('#mapping-sid')).toBeDisabled();
  await page.getByLabel('店铺名称', { exact: true }).fill('尚未保存的新名称');
  await page.getByLabel('修改 / 批准原因', { exact: true }).fill('技术版本冲突测试');
  const saveMapping = page.getByRole('button', { name: '保存映射及版本', exact: true });
  await saveMapping.scrollIntoViewIfNeeded();
  const saveMappingBox = await saveMapping.boundingBox(); assert(saveMappingBox);
  await saveMapping.click();
  await pendingDimensions(page, saveMappingBox, page.getByRole('button', { name: '正在保存…', exact: true }));
  await expect(page.getByRole('button', { name: '关闭维护店铺', exact: true })).toBeEnabled();
  assert.equal(revisions.length, 1); assert.equal(revisions[0].expectedVersion, 1);
  release('revision');
  await expect(page.getByRole('alert').filter({ hasText: '当前数据版本已变化' })).toContainText('当前草稿仍保留在此表单中');
  await expect(page.getByLabel('店铺名称', { exact: true })).toHaveValue('尚未保存的新名称');
  await expect(page.getByLabel('修改 / 批准原因', { exact: true })).toHaveValue('技术版本冲突测试');
  await expect(saveMapping).toBeEnabled();
  note('Mapping conflict preserves the draft, explicit recovery text, and version-bound request');

  await page.getByRole('button', { name: '关闭维护店铺', exact: true }).click();
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await page.getByRole('row').filter({ hasText: '技术示例店铺' }).getByText('版本 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: '维护映射', exact: true }).click();
  await page.getByLabel('店铺名称', { exact: true }).fill('已核对的新名称');
  await page.getByLabel('修改 / 批准原因', { exact: true }).fill('基于最新版本重新核对');
  await saveMapping.scrollIntoViewIfNeeded();
  const latestSaveBox = await saveMapping.boundingBox(); assert(latestSaveBox);
  await saveMapping.click();
  await pendingDimensions(page, latestSaveBox, page.getByRole('button', { name: '正在保存…', exact: true }));
  assert.equal(revisions.length, 2); assert.equal(revisions[1].expectedVersion, 2);
  release('revision');
  await expect(page.getByRole('dialog', { name: '维护店铺', exact: true }).getByRole('status').filter({ hasText: '已核对的新名称已保存为版本 3' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '维护：已核对的新名称', exact: true })).toBeFocused();
  const close = page.getByRole('button', { name: '关闭维护店铺', exact: true });
  await tooltipAtKeyboardFocus(page, close, '关闭维护店铺');
  await page.keyboard.press('Enter');
  await expect(page.locator('.mapping-editor')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '维护映射', exact: true })).toBeFocused();
  note('Refreshing the stale version permits a new save and leaves the editor keyboard operable');
  assert.deepEqual(unexpectedApi, []);
  assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; console.error(error.stack || error);
  if (context?.pages()[0]) await context.pages()[0].screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  releases.forEach((done) => done()); releases.clear();
  await browser?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill(); await Promise.race([new Promise((done) => processHandle.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-shell-icons-browser', passed: !failed, checks, browserErrors, unexpectedApi }, null, 2));
}
if (failed) process.exitCode = 1;
