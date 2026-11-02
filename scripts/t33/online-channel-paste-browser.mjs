import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { batchWorkspaceSchema, demandWorkspaceSchema, reportResponseSchema } from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';

// Isolated Vite UI and mocked application data. Real Ctrl+V exercises the browser
// clipboard and the rendered dropdown, including its portalled open menu.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.local/online-channel-paste');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-11-02T08:00:00.000Z';
const names = ['海运', '海派', '空派', '快递', '铁运', '卡航'];
const methods = [...names.map((name, index) => ({ id: String(index + 1), name, enabled: true, remark: '' })),
  { id: '7', name: '海卡', enabled: false, remark: '' }, { id: '8', name: '欧洲铁路专线', enabled: true, remark: '' }, { id: '9', name: '海配', enabled: false, remark: '' }];
const checks = [], errors = [], unexpected = [], external = [], writes = [], releases = [];
let browser, vite, page, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
const wizard = () => page.getByRole('dialog', { name: '导入向导', exact: true });
const cell = (row, column) => wizard().getByLabel(`第 ${row} 行${column}`, { exact: true });
const channel = (row) => cell(row, '业务渠道');
const screenshot = (name) => page.screenshot({ path: resolve(evidence, name), animations: 'disabled' });

async function setup(items = methods, state = {}) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL) { external.push(method + ' ' + url.href); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method !== 'GET') { writes.push(method + ' ' + path); return json({ error: { code: 'FIXTURE_UNEXPECTED_WRITE', message: 'This clipboard test must not submit business data.' } }, 500); }
    if (path === '/api/v1/session') return json({ user: { id: 'channel-paste-fixture', name: '渠道粘贴测试', email: 'fixture@example.invalid', role: 'admin' } });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: { mode: 'lingxing', version: 1, catalogVersion: 1, lastSyncedAt: now, lastError: null, configured: true, readOnly: true } });
    if (path === '/api/v1/imports/transport-methods') {
      if (state.holdMethods) await new Promise((done) => {
        state.releaseMethods = () => { state.holdMethods = false; done(); };
        releases.push(state.releaseMethods);
      });
      return json({ items, queriedAt: now });
    }
    if (path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
    if (path === '/api/v1/demands') return json(demandWorkspaceSchema.parse({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 20, maxBoxes: 10, filters: { weeks: [], batches: [], shops: [], countries: [], channels: [] }, generatedAt: now }));
    if (path === '/api/v1/batches/workspace') return json(batchWorkspaceSchema.parse({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } }));
    if (path === '/api/v1/shipping-runs') return json({ items: [] });
    if (path === '/api/v1/batch-reports') return json(reportResponseSchema.parse({ rows: [], boxes: [], confirmations: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, blocked: [], generatedAt: now }));
    unexpected.push(method + ' ' + path); return json({ error: { code: 'FIXTURE_UNHANDLED', message: 'Unexpected fixture request' } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/shipping', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '导入本次发货', exact: true }).click();
  await wizard().getByRole('button', { name: '显示补充资料', exact: true }).click();
  if (state.holdMethods) { await expect(channel(1)).toBeDisabled(); await expect.poll(() => typeof state.releaseMethods).toBe('function'); }
  else await expect(channel(1)).toBeEnabled();
  return context;
}

async function paste(control, value, { open = false } = {}) {
  await page.bringToFront();
  await page.evaluate((text) => navigator.clipboard.writeText(text), value);
  await control.scrollIntoViewIfNeeded();
  if (open) { await control.click(); await expect(page.getByRole('listbox')).toBeVisible(); }
  else { await control.focus(); await expect(page.getByRole('listbox')).toHaveCount(0); }
  await page.keyboard.press('Control+V');
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  vite = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  browser = await chromium.launch({ channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome', headless: true });
  let context = await setup();

  step = 'dropdown-selection-and-disabled-options-remain-available';
  await channel(1).click();
  await expect(page.getByRole('option', { name: '海卡（已停用）', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await chooseOption(channel(1), '海派'); await expect(channel(1)).toHaveAttribute('data-value', '海派');
  await chooseOption(channel(1), ''); await expect(channel(1)).toHaveAttribute('data-value', ''); note();

  step = 'single-code-real-clipboard-paste-on-closed-dropdown';
  await paste(channel(1), ' hP '); await expect(channel(1)).toHaveAttribute('data-value', '海派');
  await expect(channel(1)).toHaveAttribute('aria-invalid', 'false'); note();

  step = 'dynamic-pinyin-initials-match-new-directory-options-and-ignore-disabled-collisions';
  await paste(channel(9), ' ozTlzx '); await expect(channel(9)).toHaveAttribute('data-value', '欧洲铁路专线');
  await expect(channel(9)).toHaveAttribute('aria-invalid', 'false');
  await paste(channel(1), 'HP'); await expect(channel(1)).toHaveAttribute('data-value', '海派');
  await expect(channel(1)).toHaveAttribute('aria-invalid', 'false'); note();

  step = 'single-code-real-clipboard-paste-while-dropdown-is-open';
  await paste(channel(2), 'kD', { open: true }); await expect(channel(2)).toHaveAttribute('data-value', '快递');
  await expect(channel(2)).toBeFocused(); note();

  step = 'six-code-column-pastes-from-current-row-and-keeps-other-columns';
  await cell(3, 'FBA 货件号').fill('FBAPASTETHREE'); await cell(3, '店铺').fill('保留的店铺');
  await paste(channel(3), ' HY \r\nhp\r\nKP\r\nkd\r\nTy\r\nkh\r\n', { open: true });
  for (const [index, name] of names.entries()) { await expect(channel(index + 3)).toHaveAttribute('data-value', name); await expect(channel(index + 3)).toHaveAttribute('aria-invalid', 'false'); }
  await expect(channel(2)).toHaveAttribute('data-value', '快递'); await expect(channel(9)).toHaveAttribute('data-value', '欧洲铁路专线');
  await expect(cell(3, 'FBA 货件号')).toHaveValue('FBAPASTETHREE'); await expect(cell(3, '店铺')).toHaveValue('保留的店铺');
  await page.setViewportSize({ width: 1440, height: 1200 });
  await wizard().locator(':scope > .import-dialog-body').evaluate((node) => {
    const grid = node.querySelector('.online-grid-scroll'), row = grid.querySelector('tbody tr:nth-child(3)');
    node.scrollTop += grid.getBoundingClientRect().top - node.getBoundingClientRect().top - 80;
    grid.scrollTop += row.getBoundingClientRect().top - grid.getBoundingClientRect().top - grid.querySelector('thead').getBoundingClientRect().height;
  });
  await screenshot('six-channel-column-1440.png'); await page.setViewportSize({ width: 1440, height: 1000 }); note();

  step = 'rectangular-spreadsheet-paste-normalizes-channel-column-and-preserves-quoted-address';
  await paste(cell(10, 'FBA 货件号'), 'FBAPASTETEN\t店铺甲\t HY \t美国\tONT8\t"仓库\tA\n第二行"\r\nFBAPASTEELEVEN\t店铺乙\t kp \t德国\tDUS1\t仓库乙\r\n');
  await expect(channel(10)).toHaveAttribute('data-value', '海运'); await expect(channel(11)).toHaveAttribute('data-value', '空派');
  await expect(cell(10, 'FBA 货件号')).toHaveValue('FBAPASTETEN'); await expect(cell(10, '店铺')).toHaveValue('店铺甲');
  // A single-line HTML input removes the address newline, while the quoted tab
  // remains inside the address rather than becoming another grid column.
  await expect(cell(10, '仓库地址')).toHaveValue('仓库\tA第二行'); await expect(cell(10, '目的 FC')).toHaveValue('ONT8');
  await expect(cell(11, '国家')).toHaveValue('德国'); await expect(cell(11, '仓库地址')).toHaveValue('仓库乙'); note();

  step = 'rectangle-starting-at-channel-aligns-country-and-destination';
  await cell(15, 'FBA 货件号').fill('FBAPASTEFIFTEEN');
  await paste(channel(15), 'TY\t美国\tLAX9\t铁路仓库\r\nKH\t加拿大\tYYZ9\t卡航仓库', { open: true });
  await expect(channel(15)).toHaveAttribute('data-value', '铁运'); await expect(channel(16)).toHaveAttribute('data-value', '卡航');
  await expect(cell(15, 'FBA 货件号')).toHaveValue('FBAPASTEFIFTEEN'); await expect(cell(15, '国家')).toHaveValue('美国');
  await expect(cell(16, '目的 FC')).toHaveValue('YYZ9'); await expect(cell(16, '仓库地址')).toHaveValue('卡航仓库'); note();

  step = 'unknown-and-disabled-values-are-retained-marked-and-block-submission';
  await paste(channel(12), 'HYKD\r\n海卡');
  for (const [row, value] of [[12, 'HYKD'], [13, '海卡']]) {
    await expect(channel(row)).toHaveAttribute('data-value', value); await expect(channel(row)).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await channel(row).getAttribute('aria-describedby'); await expect(wizard().locator(`[id="${describedBy}"]`)).toContainText('当前值已保留');
  }
  await channel(12).click(); await expect(page.getByRole('option', { name: 'HYKD（原值，请重新选择）', exact: true })).toHaveAttribute('aria-disabled', 'true'); await page.keyboard.press('Escape');
  await wizard().getByRole('button', { name: '导入并整理本次发货', exact: true }).click();
  await expect(wizard().getByRole('alert')).toContainText('第 12 行业务渠道“HYKD”未启用或不在领星列表中'); assert.deepEqual(writes, []);
  await chooseOption(channel(12), '海派'); await chooseOption(channel(13), '');
  await expect(channel(12)).toHaveAttribute('aria-invalid', 'false'); await expect(channel(13)).toHaveAttribute('aria-invalid', 'false'); note();

  step = 'blank-pasted-channel-clears-one-row-and-adds-rows-at-grid-end';
  await chooseOption(channel(19), '快递');
  await paste(channel(18), 'HY\r\n \r\nHP\r\nKP\r\nKD');
  for (const [row, value] of [[18, '海运'], [19, ''], [20, '海派'], [21, '空派'], [22, '快递']]) await expect(channel(row)).toHaveAttribute('data-value', value);
  await expect(wizard().locator('.online-grid tbody tr')).toHaveCount(22); note();

  step = 'narrow-dropdown-paste-and-screenshot';
  await page.setViewportSize({ width: 390, height: 844 });
  await paste(channel(3), 'HY', { open: true }); await expect(channel(3)).toHaveAttribute('data-value', '海运');
  await channel(3).click(); const popup = page.getByRole('listbox'); await expect(popup).toBeVisible();
  const bounds = await popup.boundingBox(); assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= 391, 'Dropdown fits narrow viewport');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page fits narrow viewport');
  await screenshot('channel-dropdown-390.png'); await page.keyboard.press('Escape'); await context.close(); note();

  step = 'unmatched-codes-stay-original-when-directory-omits-or-disables-candidates';
  context = await setup(methods.filter((method) => method.name !== '海运').map((method) => ({ ...method, enabled: method.name === '卡航' ? false : method.enabled })));
  await paste(channel(1), 'HY\r\nKH', { open: true });
  await expect(channel(1)).toHaveAttribute('data-value', 'HY'); await expect(channel(2)).toHaveAttribute('data-value', 'KH');
  for (const row of [1, 2]) await expect(channel(row)).toHaveAttribute('aria-invalid', 'true');
  await channel(2).click(); await expect(page.getByRole('option', { name: '卡航（已停用）', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await screenshot('unavailable-channel-preserved-1440.png'); await page.keyboard.press('Escape'); await context.close(); note();

  step = 'ambiguous-pinyin-initials-retain-code-show-candidates-and-allow-manual-choice';
  const ambiguousMethods = methods.map((method) => ({ ...method, enabled: method.name === '海配' ? true : method.enabled }));
  context = await setup(ambiguousMethods);
  await paste(channel(1), 'HP', { open: true });
  await expect(channel(1)).toHaveAttribute('data-value', 'HP'); await expect(channel(1)).toHaveAttribute('aria-invalid', 'true');
  const ambiguousDescription = await channel(1).getAttribute('aria-describedby');
  await expect(wizard().locator(`[id="${ambiguousDescription}"]`)).toContainText('海派');
  await expect(wizard().locator(`[id="${ambiguousDescription}"]`)).toContainText('海配');
  await channel(1).scrollIntoViewIfNeeded(); await screenshot('ambiguous-pinyin-candidates-1440.png');
  await chooseOption(channel(1), '海配'); await expect(channel(1)).toHaveAttribute('data-value', '海配'); await expect(channel(1)).toHaveAttribute('aria-invalid', 'false');
  await paste(channel(2), ' 海派 '); await expect(channel(2)).toHaveAttribute('data-value', '海派'); await expect(channel(2)).toHaveAttribute('aria-invalid', 'false');
  await context.close(); note();

  step = 'literal-directory-value-takes-priority-over-pinyin-candidates';
  context = await setup([...ambiguousMethods, { id: '10', name: 'HP', enabled: true, remark: '' }]);
  await paste(channel(1), ' hp ', { open: true }); await expect(channel(1)).toHaveAttribute('data-value', 'HP'); await expect(channel(1)).toHaveAttribute('aria-invalid', 'false');
  await context.close(); note();

  step = 'pending-directory-rectangle-retains-codes-and-resolves-automatically-after-load';
  const pending = { holdMethods: true }; context = await setup(methods, pending);
  await paste(cell(1, 'FBA 货件号'), 'FBAPENDINGONE\t目录加载前店铺\tHY\t美国\tONT8\r\nFBAPENDINGTWO\t保留店铺\toztlzx\t德国\tDUS1\r\nFBAPENDINGTHREE\t第三店铺\tHP\t加拿大\tYYZ9');
  await expect(cell(1, 'FBA 货件号')).toHaveValue('FBAPENDINGONE'); await expect(cell(2, '目的 FC')).toHaveValue('DUS1');
  await expect(channel(1)).toHaveAttribute('data-value', 'HY'); await expect(channel(2)).toHaveAttribute('data-value', 'oztlzx'); await expect(channel(3)).toHaveAttribute('data-value', 'HP');
  await expect(channel(1)).toBeDisabled();
  pending.releaseMethods(); await expect(channel(1)).toBeEnabled();
  await expect(channel(1)).toHaveAttribute('data-value', '海运'); await expect(channel(2)).toHaveAttribute('data-value', '欧洲铁路专线'); await expect(channel(3)).toHaveAttribute('data-value', '海派');
  await expect(cell(1, '店铺')).toHaveValue('目录加载前店铺'); await expect(cell(2, 'FBA 货件号')).toHaveValue('FBAPENDINGTWO');
  await context.close(); note();

  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
} catch (error) {
  failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
} finally {
  releases.forEach((release) => release());
  await browser?.close(); vite?.kill(); if (vite && vite.exitCode === null) await Promise.race([new Promise((done) => vite.once('exit', done)), delay(5000)]);
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: !failed, checks, errors, unexpected, external, writes, realBusinessWrites: 0, realLingxingRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
