import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..'), evidence = resolve(root, '.local/settings/seller-export-codes');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise((done) => socket.close(done));
const baseURL = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
let browser;
const items = [{ sid: 101, name: 'JavoYion-US', country: '美国', code: '', version: 0 }, { sid: 102, name: 'MOMLOY-US', country: '美国', code: '002', version: 1 }];
const unexpected = [], errors = [], writes = []; let failWrite = false;
try {
  await mkdir(evidence, { recursive: true });
  for (let attempt = 0; attempt < 60; attempt++) { try { if ((await fetch(baseURL)).ok) break; } catch {} await delay(250); }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ baseURL, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL) { unexpected.push(req.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/v1/session') return json({ user: { id: 'fixture', name: '管理员', email: 'fixture@example.invalid', role: 'admin' } });
    if (url.pathname === '/api/v1/seller-mappings/export-codes') return json({ items });
    const match = url.pathname.match(/^\/api\/v1\/seller-mappings\/export-codes\/(\d+)$/);
    if (match && req.method() === 'POST') {
      const input = req.postDataJSON(); writes.push(input);
      if (failWrite) { failWrite = false; return json({ error: { code: 'UNAVAILABLE', message: '暂时无法保存' } }, 503); }
      const row = items.find((item) => item.sid === Number(match[1]));
      if (input.expectedVersion !== row.version) return json({ error: { code: 'VERSION_CONFLICT', message: '版本已变化' } }, 409);
      row.code = input.code; row.version++; return json({ code: row.code, version: row.version });
    }
    unexpected.push(req.method() + ' ' + url.pathname); return json({}, 500);
  });
  await page.goto('/settings/seller-export-codes');
  await expect(page.getByRole('heading', { name: '店铺导出代号', exact: true })).toBeVisible();
  const row = () => page.getByRole('form', { name: 'JavoYion-US 导出代号' });
  await row().getByLabel('数字代号').fill('001'); await row().getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'JavoYion-US 的导出代号已保存' })).toBeVisible();
  await page.reload(); await expect(row().getByLabel('数字代号')).toHaveValue('001');
  await row().getByLabel('数字代号').fill('abc'); await row().getByRole('button', { name: '保存', exact: true }).click();
  await expect(row().getByRole('alert')).toContainText('最多 20 位数字'); assert.equal(writes.length, 1);
  await row().getByLabel('数字代号').fill('003'); failWrite = true; await row().getByRole('button', { name: '保存', exact: true }).click();
  await expect(row().getByRole('alert')).toBeVisible(); await expect(row().getByLabel('数字代号')).toHaveValue('003');
  await row().getByRole('button', { name: '保存', exact: true }).click(); await expect(row().getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  assert.equal(writes[1].operationId, writes[2].operationId);
  await row().getByLabel('数字代号').fill(''); await row().getByRole('button', { name: '保存', exact: true }).click();
  await expect(row().getByText('文件名店铺部分：JavoYion-US')).toBeVisible();
  await page.getByLabel('搜索店铺、国家、SID 或代号').fill('002'); await expect(page.getByRole('form')).toHaveCount(1);
  await page.getByLabel('搜索店铺、国家、SID 或代号').fill('');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: resolve(evidence, `page-${width}.png`), fullPage: true });
  }
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: true, checks: ['save', 'reload', 'leading-zero', 'validation', 'failure-preserves-input', 'retry-operation-id', 'clear', 'search', 'desktop-mobile'], realBusinessWrites: 0 }, null, 2));
  console.log('PASS seller export codes browser checks');
} finally { await browser?.close(); vite.kill(); }
