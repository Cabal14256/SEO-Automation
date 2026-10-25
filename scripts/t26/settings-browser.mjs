import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
// Every API and external origin is intercepted. No credentials, database, or
// real seller synchronization is used by this settings regression.
const evidence = resolve(process.env.SETTINGS_EVIDENCE_DIR || resolve(root, '.local/t30/settings'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-18T04:00:00.000Z';
const user = { id: 'fixture-admin', name: '隔离界面检查', email: 'fixture@example.invalid', role: 'admin' };
const settings = { mode: 'manual', version: 1, catalogVersion: 1, lastSyncedAt: null, lastError: null, configured: false, readOnly: true };
let mapping = { id: '4813ddde-23b3-4624-9c19-7518745a08b2', sid: 42, name: '技术示例店铺', country: '美国', marketplaceId: null, wid: null, aliases: ['示例别名'], status: 'approved', version: 1, updatedAt: now, sourceObservedAt: now, sourceSha256: '0'.repeat(64), dataSource: 'manual', manualEnabled: true, lingxingName: null, lingxingStatus: null, identityLocked: true, hasApprovedBefore: true };
const checks = []; const errors = []; const unexpected = [];
const writes = []; const revisions = [];
let browser; let vite; let page; let failed = false;
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
async function checkShippingChildren(navigation, screenshot) {
  const parent = navigation.getByRole('button', { name: '发货管理', exact: true });
  if (await parent.getAttribute('aria-expanded') === 'true') await parent.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await parent.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  const children = navigation.getByRole('navigation', { name: '发货管理子导航', exact: true });
  await expect(children).toBeVisible();
  await expect(children.getByRole('link')).toHaveCount(3);
  for (const [label, view] of [['需求导入', 'demands'], ['发货批次', 'batches'], ['发货成品表', 'reports']]) {
    await expect(children.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', `/shipping?view=${view}`);
  }
  await expect(children.locator('a[aria-current="page"]')).toHaveCount(0);
  if (screenshot) await page.screenshot({ path: resolve(evidence, screenshot), fullPage: true });
  await parent.click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await expect(children).toBeHidden();
}
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const baseURL = `http://127.0.0.1:${port}`;
  vite = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(baseURL)).ok) { started = true; break; } } catch { /* Vite is starting. */ }
    await delay(100);
  }
  assert(started);
  browser = await chromium.launch({ channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL) { unexpected.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/v1/session') return json({ user });
    if (request.method() === 'GET' && url.pathname === '/api/v1/seller-mappings/catalog-settings') return json({ settings });
    if (request.method() === 'GET' && url.pathname === '/api/v1/seller-mappings') return json({ items: [mapping], total: 1, settings });
    if (request.method() === 'GET' && url.pathname === `/api/v1/seller-mappings/${mapping.id}/history`) return json({ items: revisions });
    if (request.method() === 'POST' && url.pathname === `/api/v1/seller-mappings/${mapping.id}/revise`) {
      const input = request.postDataJSON(); writes.push(input);
      assert.equal(input.expectedVersion, mapping.version);
      assert.equal(input.sid, 42, 'Used seller identity must remain locked');
      assert.match(input.operationId, /^[0-9a-f-]{36}$/i);
      const before = structuredClone(mapping);
      mapping = { ...mapping, name: input.name, country: input.country, marketplaceId: input.marketplaceId, wid: input.wid, aliases: input.aliases, status: input.status, version: mapping.version + 1 };
      revisions.unshift({ operationId: input.operationId, version: mapping.version, actorUserId: user.id, reason: input.reason, createdAt: now, before, after: structuredClone(mapping) });
      return json({ mapping });
    }
    unexpected.push(`${request.method()} ${url.pathname}`); return json({ error: { code: 'NOT_FOUND' } }, 404);
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/settings');
  await expect(page).toHaveURL(`${baseURL}/settings/seller-mappings`);
  await expect(page.getByRole('heading', { level: 1, name: '设置', exact: true })).toBeVisible();
  const businessNav = page.getByRole('navigation', { name: '业务导航', exact: true });
  await expect(businessNav.locator(':scope > a')).toHaveCount(1);
  await expect(businessNav.getByRole('link', { name: '工作台', exact: true })).toHaveAttribute('href', '/');
  await expect(businessNav.getByRole('button', { name: '发货管理', exact: true })).toHaveCount(1);
  await checkShippingChildren(businessNav, 'settings-shipping-navigation-1440.png');
  await expect(businessNav.getByRole('link', { name: '设置', exact: true })).toHaveCount(0);
  await expect(businessNav.getByRole('link', { name: '店铺映射', exact: true })).toHaveCount(0);
  const footerSettings = page.locator('.sidebar-foot').getByRole('navigation', { name: '全局设置', exact: true }).getByRole('link', { name: '设置', exact: true });
  await expect(footerSettings).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: '设置', exact: true })).toHaveCount(1);
  const settingsNav = page.getByRole('navigation', { name: '设置分类' });
  await expect(settingsNav.getByRole('link')).toHaveCount(1);
  await expect(settingsNav.getByRole('link', { name: '店铺映射', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: '店铺目录', exact: true })).toBeVisible();
  await expect(page.locator('.overview-banner')).toHaveCount(0);
  note('Settings entry preserves its URL, footer and child selection; the shipping parent toggles three inactive children outside the settings page');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const collapsedSettings = footerSettings;
  await expect(collapsedSettings).toHaveAttribute('href', '/settings');
  await expect(collapsedSettings).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Tab'); await collapsedSettings.focus();
  await expect(page.getByRole('tooltip').filter({ hasText: '设置' })).toBeVisible();
  await page.keyboard.press('Escape');
  await collapsedSettings.click();
  await expect(page).toHaveURL(`${baseURL}/settings/seller-mappings`);
  await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed', 'true');
  await page.screenshot({ path: resolve(evidence, 'settings-collapsed-1440.png'), fullPage: true });
  const compactShipping = businessNav.getByRole('button', { name: '发货管理', exact: true });
  await compactShipping.click();
  await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed', 'false');
  await expect(compactShipping).toHaveAttribute('aria-expanded', 'true');
  await expect(businessNav.getByRole('navigation', { name: '发货管理子导航', exact: true }).getByRole('link')).toHaveCount(3);
  await compactShipping.click();
  note('Collapsed settings keeps its label, tooltip, selected state and preference; the compact shipping parent expands both sidebar and group');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width < 768) {
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      const mobileBusiness = page.locator('#mobile-navigation').getByRole('navigation', { name: '业务导航', exact: true });
      await expect(mobileBusiness.locator(':scope > a')).toHaveCount(1);
      await checkShippingChildren(mobileBusiness, `settings-shipping-navigation-${width}.png`);
      await expect(page.locator('#mobile-navigation').getByRole('link', { name: '设置', exact: true })).toHaveCount(0);
      const mobileSettings = page.locator('.account-controls').getByRole('link', { name: '设置', exact: true });
      await expect(mobileSettings).toBeVisible();
      await expect(page.getByRole('link', { name: '设置', exact: true })).toHaveCount(1);
      await expect(mobileSettings).toHaveAttribute('aria-current', 'page');
      const bounds = await mobileSettings.boundingBox();
      assert(bounds && bounds.width >= 44 && bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Mobile settings target stays inside the header');
      await mobileSettings.click();
      await expect(page.locator('#mobile-navigation')).toHaveCount(0);
      await expect(page).toHaveURL(`${baseURL}/settings/seller-mappings`);
      await expect(settingsNav.getByRole('link', { name: '店铺映射', exact: true })).toBeVisible();
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow at ${width}`);
    await page.screenshot({ path: resolve(evidence, `settings-${width}.png`), fullPage: true });
  }
  note('Mobile header settings stays separate from the expandable shipping menu and closes it normally; desktop, 390px and 320px layouts fit');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/settings/seller-mappings');
  await page.getByRole('button', { name: '维护映射', exact: true }).click();
  await expect(page.locator('.mapping-editor')).toBeVisible();
  await expect(page.locator('#mapping-aliases')).toHaveValue('示例别名');
  await expect(page.locator('#mapping-sid')).toBeDisabled();
  await expect(page.locator('#mapping-reason')).toBeEditable();
  await page.locator('#mapping-aliases').fill('示例别名\n新增设置别名');
  await page.locator('#mapping-reason').fill('隔离测试：从设置维护别名');
  await page.getByRole('button', { name: '保存映射及版本', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '维护店铺', exact: true }).getByRole('status').filter({ hasText: '技术示例店铺已保存为版本 2' })).toBeVisible();
  const history = page.getByRole('dialog', { name: '维护店铺', exact: true }).locator('.mapping-history');
  if (await history.locator(':scope > summary').count()) await history.locator(':scope > summary').click();
  await expect(page.locator('.mapping-revisions')).toContainText('隔离测试：从设置维护别名');
  await expect(page.locator('.mapping-table')).toContainText('新增设置别名');
  assert.equal(writes.length, 1); assert.equal(writes[0].reason, '隔离测试：从设置维护别名');
  assert.deepEqual(writes[0].aliases, ['示例别名', '新增设置别名']);
  await page.getByRole('button', { name: '关闭维护店铺', exact: true }).click();
  await expect(page.locator('.mapping-editor')).not.toBeVisible();
  note('Preserved deep link maintains locked seller identity, edits aliases through the original versioned endpoint, updates history and closes normally');
  await page.keyboard.press('Tab');
  await settingsNav.getByRole('link').focus();
  assert(await settingsNav.getByRole('link').evaluate((node) => getComputedStyle(node).outlineStyle !== 'none'));
  note('Settings child navigation retains visible keyboard focus');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
} catch (error) {
  failed = true;
  errors.push(error instanceof Error ? error.stack : String(error));
  await page?.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
} finally {
  await browser?.close();
  vite?.kill();
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: !failed, checks, errors, unexpected }, null, 2));
  console.log(JSON.stringify({ passed: !failed, checks: checks.length, evidence }));
  if (failed) process.exitCode = 1;
}
