import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import * as contracts from '../../packages/contracts/dist/index.js';

const root = process.cwd(), evidence = resolve(root, '.local/t42/transport-methods');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-24T10:00:00.000Z';
const items = ['海派', '海卡', '空派', '快递', '铁运', '卡航', '传统联运'].map((name, index) => ({ id: String(index + 1), name, enabled: ![1, 6].includes(index), remark: '' }));
const unexpected = [], errors = [], checks = [];
let browser, vite, page, failed = false, dictionaryFailed = false, writes = 0;
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise((done) => socket.close(done));
  const baseURL = `http://127.0.0.1:${port}`;
  vite = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['data:', 'blob:'].includes(url.protocol)) { unexpected.push(`external:${url.origin}`); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes++; return json({ error: { code: 'UNEXPECTED_TEST_WRITE', message: 'No writes in this browser test' } }, 500); }
    if (path === '/api/v1/session') return json({ user: { id: 'test-admin', name: '测试管理员', email: 'transport@acceptance.invalid', role: 'admin' } });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: { mode: 'lingxing', version: 1, catalogVersion: 1, lastSyncedAt: now, lastError: null, configured: true, readOnly: true } });
    if (path === '/api/v1/imports/transport-methods') return dictionaryFailed ? json({ error: { code: 'LINGXING_NETWORK_ERROR', message: '运输方式查询连接失败' } }, 503) : json({ items, queriedAt: now });
    if (path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
    if (path === '/api/v1/demands') return json(contracts.demandWorkspaceSchema.parse({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 20, maxBoxes: 10, filters: { weeks: [], batches: [], shops: [], countries: [], channels: [] }, generatedAt: now }));
    if (path === '/api/v1/batches/workspace') return json(contracts.batchWorkspaceSchema.parse({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } }));
    if (path === '/api/v1/shipping-runs') return json({ items: [] });
    if (path === '/api/v1/batch-reports') return json(contracts.reportResponseSchema.parse({ rows: [], boxes: [], confirmations: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, blocked: [], generatedAt: now }));
    unexpected.push(path); return json({ error: { code: 'TEST_UNHANDLED', message: path } }, 500);
  });
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  const wizard = () => page.getByRole('dialog', { name: '导入向导', exact: true });
  const open = async () => { await page.goto('/shipping'); await page.getByRole('button', { name: '导入本次发货', exact: true }).click(); await wizard().getByRole('button', { name: '显示补充资料', exact: true }).click(); };
  const channel = () => wizard().getByRole('combobox', { name: '第 1 行业务渠道', exact: true });
  await open();
  await expect(channel()).toBeEnabled(); await channel().click();
  for (const method of items) {
    const option = page.getByRole('option', { name: method.enabled ? method.name : `${method.name}（已停用）`, exact: true });
    await expect(option).toBeVisible();
    if (!method.enabled) await expect(option).toHaveAttribute('aria-disabled', 'true');
  }
  await page.screenshot({ path: resolve(evidence, 'dropdown-1440.png') });
  await page.getByRole('option', { name: '海派', exact: true }).click();
  await expect(channel()).toHaveAttribute('data-value', '海派');
  await channel().focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: '空派', exact: true }).click();
  await expect(channel()).toHaveAttribute('data-value', '空派'); checks.push('actual options, disabled states, selection and keyboard opening');

  await wizard().getByLabel('第 1 行FBA 货件号', { exact: true }).evaluate((element) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'FBATESTCHANNEL\t测试店\t海运');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(channel()).toHaveAttribute('data-value', '海运'); await expect(channel()).toHaveAttribute('aria-invalid', 'true');
  await wizard().getByRole('button', { name: '导入并整理本次发货', exact: true }).click();
  await expect(wizard().getByText('第 1 行业务渠道“海运”未启用或不在领星列表中', { exact: false })).toBeVisible();
  assert.equal(writes, 0);
  await channel().click(); await page.getByRole('option', { name: '海派', exact: true }).click();
  await expect(channel()).toHaveAttribute('aria-invalid', 'false');
  await expect(wizard().getByLabel('第 1 行FBA 货件号', { exact: true })).toHaveValue('FBATESTCHANNEL');
  checks.push('pasted legacy value preserved, invalid submission blocked, correction preserves FBA');

  await page.setViewportSize({ width: 390, height: 844 });
  await channel().scrollIntoViewIfNeeded(); await channel().click();
  const popup = page.getByRole('listbox'); await expect(popup).toBeVisible();
  const box = await popup.boundingBox(); assert(box.x >= 0 && box.x + box.width <= 391);
  await page.screenshot({ path: resolve(evidence, 'dropdown-390.png') });
  await page.keyboard.press('Escape'); checks.push('mobile dropdown fits viewport');

  dictionaryFailed = true; await page.setViewportSize({ width: 1440, height: 1000 });
  await open();
  const retry = wizard().getByRole('button', { name: '重试读取运输方式', exact: true });
  await expect(retry).toBeVisible(); await expect(channel()).toBeDisabled();
  await wizard().getByLabel('第 1 行FBA 货件号', { exact: true }).fill('FBARETRY');
  dictionaryFailed = false; await retry.click();
  await expect(channel()).toBeEnabled();
  await expect(wizard().getByLabel('第 1 行FBA 货件号', { exact: true })).toHaveValue('FBARETRY');
  checks.push('dictionary failure and retry preserve input');
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []); assert.equal(writes, 0);
  console.log('PASS: '+checks.join('; '));
} catch (error) {
  failed = true; console.error(error.stack ?? error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) { vite.kill(); await Promise.race([new Promise((done) => vite.once('exit', done)), delay(5000)]); }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: !failed, checks, unexpected, errors, writes }, null, 2));
}
if (failed) process.exitCode = 1;
