import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { batchWorkspaceSchema, demandWorkspaceSchema, reportResponseSchema } from '../../packages/contracts/dist/index.js';

// An isolated Vite UI and mocked APIs exercise real keyboard/clipboard input.
// Remote requests and business writes are intercepted before they can leave.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.local/online-channel-paste');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-11-03T08:00:00.000Z';
const names = ['海运', '海派', '空派', '快递', '铁运', '卡航'];
const checks = [], errors = [], unexpected = [], external = [], writes = [], directoryRequests = [], mockedLookups = [], mockedSubmissions = [];
let browser, vite, page, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
const wizard = () => page.getByRole('dialog', { name: '导入向导', exact: true });
const cell = (row, column) => wizard().getByLabel(`第 ${row} 行${column}`, { exact: true });
const channel = (row) => cell(row, '业务渠道');
const screenshot = (name) => page.screenshot({ path: resolve(evidence, name), animations: 'disabled' });

async function setup(state = {}) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL) { external.push(method + ' ' + url.href); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/imports/transport-methods') {
      directoryRequests.push(method + ' ' + path);
      return json({ error: { code: 'FIXTURE_FORBIDDEN_DIRECTORY', message: '运输方式目录不能用于导入。' } }, 503);
    }
    if (state.lookup && path === '/api/v1/imports/fba-lookups' && method === 'POST') {
      const input = request.postDataJSON(); mockedLookups.push(input);
      return json({ id: '019a3f6a-1111-4111-8111-111111111111', status: 'completed', startDate: input.startDate, endDate: input.endDate,
        fbas: input.fbas, catalogMode: 'lingxing', catalogSettingsVersion: 1, catalogVersion: 1, createdAt: now, completedAt: now, errorCode: null, errorMessage: null,
        rows: input.fbas.map((fba, index) => ({ fba, status: 'unique', candidates: [{ sid: 101, shop: '运输方式测试店', country: '美国',
          destinationFc: 'FC1', destinationAddress: '测试仓库地址', shipmentCreatedAt: '2026-11-01 12:00:00', observedAt: now,
          channel: '领星旧运输方式', channelStatus: index % 2 ? 'unavailable' : 'unique', channelSource: 'method_name',
          channelOptions: [{ name: '领星旧运输方式', shipmentNumbers: ['OLD-ORDER'], channelIds: [], methodNames: ['领星旧运输方式'] }],
          channelIssue: { code: 'LOOKUP_FAILED', message: '旧运输方式查询失败，不应再显示。' } }] })) });
    }
    if (state.submit && path === '/api/v1/imports/online' && method === 'POST') {
      mockedSubmissions.push(request.postDataJSON());
      // Keep the original payload reviewable without creating business data.
      return json({ error: { code: 'FIXTURE_UNCERTAIN_SAVE', message: '模拟接收结果尚未确认，请原样重试。' } }, 503);
    }
    if (method !== 'GET') { writes.push(method + ' ' + path); return json({ error: { code: 'FIXTURE_UNEXPECTED_WRITE', message: 'Unexpected business write.' } }, 500); }
    if (path === '/api/v1/session') return json({ user: { id: 'channel-paste-fixture', name: '渠道粘贴测试', email: 'fixture@example.invalid', role: 'admin' } });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: { mode: 'lingxing', version: 1, catalogVersion: 1, lastSyncedAt: now, lastError: null, configured: true, readOnly: true } });
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
  await expect(channel(1)).toBeEnabled();
  if (state.supplement) await wizard().getByRole('button', { name: '显示补充资料', exact: true }).click();
  return context;
}

async function paste(control, value) {
  await page.bringToFront(); await page.evaluate((text) => navigator.clipboard.writeText(text), value);
  await control.scrollIntoViewIfNeeded(); await control.focus(); await page.keyboard.press('Control+V');
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  vite = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  browser = await chromium.launch({ channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome', headless: true });
  let context = await setup();

  step = 'manual-transport-input-is-visible-next-to-fba-without-directory-or-supplements';
  await expect(cell(1, 'FBA 货件号')).toBeVisible(); await expect(channel(1)).toBeVisible();
  await expect(channel(1)).toHaveAttribute('placeholder', '运输方式全名或拼音缩写');
  assert.equal(await channel(1).evaluate((node) => node.tagName), 'INPUT');
  await expect(cell(1, '店铺')).toBeHidden(); await expect(page.getByRole('listbox')).toHaveCount(0);
  await screenshot('manual-transport-default-1440.png'); assert.deepEqual(directoryRequests, []); note();

  step = 'single-code-real-clipboard-paste-trims-and-normalizes-locally';
  await paste(channel(1), ' hP '); await expect(channel(1)).toHaveValue('海派');
  await expect(channel(1)).toHaveAttribute('aria-invalid', 'false'); note();

  step = 'default-two-column-paste-fills-visible-fba-and-transport-and-keeps-hidden-shop';
  await wizard().getByRole('button', { name: '显示补充资料', exact: true }).click();
  await cell(1, '店铺').fill('隐藏店铺保持');
  await wizard().getByRole('button', { name: '收起补充资料', exact: true }).click();
  await paste(cell(1, 'FBA 货件号'), 'FBAVISIBLEONE\tHY\r\nFBAVISIBLETWO\tkp');
  await expect(cell(1, 'FBA 货件号')).toHaveValue('FBAVISIBLEONE'); await expect(channel(1)).toHaveValue('海运');
  await expect(cell(2, 'FBA 货件号')).toHaveValue('FBAVISIBLETWO'); await expect(channel(2)).toHaveValue('空派');
  await expect(cell(1, '店铺')).toHaveValue('隐藏店铺保持'); await expect(cell(2, '店铺')).toHaveValue(''); note();

  step = 'typed-initials-normalize-on-blur-and-full-or-custom-names-remain-editable';
  await channel(2).fill(' kD '); await channel(2).press('Tab'); await expect(channel(2)).toHaveValue('快递');
  await channel(2).fill(' 海派 '); await channel(2).press('Tab'); await expect(channel(2)).toHaveValue('海派');
  await channel(2).fill('欧洲铁路专线'); await channel(2).press('Tab'); await expect(channel(2)).toHaveValue('欧洲铁路专线');
  await paste(channel(2), 'HYKD'); await expect(channel(2)).toHaveValue('HYKD'); await expect(channel(2)).toHaveAttribute('aria-invalid', 'false'); note();

  step = 'six-code-column-pastes-from-current-row-and-preserves-other-columns';
  await wizard().getByRole('button', { name: '显示补充资料', exact: true }).click();
  await cell(3, 'FBA 货件号').fill('FBAPASTETHREE'); await cell(3, '店铺').fill('保留的店铺');
  await paste(channel(3), ' HY \r\nhp\r\nKP\r\nkd\r\nTy\r\nkh\r\n');
  for (const [index, name] of names.entries()) await expect(channel(index + 3)).toHaveValue(name);
  await expect(channel(2)).toHaveValue('HYKD'); await expect(cell(3, 'FBA 货件号')).toHaveValue('FBAPASTETHREE'); await expect(cell(3, '店铺')).toHaveValue('保留的店铺');
  await screenshot('six-channel-column-1440.png'); note();

  step = 'rectangular-spreadsheet-paste-normalizes-original-channel-column-and-keeps-quoted-address';
  await paste(cell(10, 'FBA 货件号'), 'FBAPASTETEN\t店铺甲\t HY \t美国\tONT8\t"仓库\tA\n第二行"\r\nFBAPASTEELEVEN\t店铺乙\t kp \t德国\tDUS1\t仓库乙\r\n');
  await expect(channel(10)).toHaveValue('海运'); await expect(channel(11)).toHaveValue('空派');
  await expect(cell(10, 'FBA 货件号')).toHaveValue('FBAPASTETEN'); await expect(cell(10, '店铺')).toHaveValue('店铺甲');
  await expect(cell(10, '仓库地址')).toHaveValue('仓库\tA第二行'); await expect(cell(10, '目的 FC')).toHaveValue('ONT8');
  await expect(cell(11, '国家')).toHaveValue('德国'); await expect(cell(11, '仓库地址')).toHaveValue('仓库乙'); note();

  step = 'rectangle-starting-at-channel-aligns-country-and-destination';
  await cell(15, 'FBA 货件号').fill('FBAPASTEFIFTEEN');
  await paste(channel(15), 'TY\t美国\tLAX9\t铁路仓库\r\nKH\t加拿大\tYYZ9\t卡航仓库');
  await expect(channel(15)).toHaveValue('铁运'); await expect(channel(16)).toHaveValue('卡航');
  await expect(cell(15, 'FBA 货件号')).toHaveValue('FBAPASTEFIFTEEN'); await expect(cell(15, '国家')).toHaveValue('美国');
  await expect(cell(16, '目的 FC')).toHaveValue('YYZ9'); await expect(cell(16, '仓库地址')).toHaveValue('卡航仓库'); note();

  step = 'blank-pasted-channel-clears-one-row-and-adds-rows-at-grid-end';
  await channel(19).fill('快递'); await paste(channel(18), 'HY\r\n \r\nHP\r\nKP\r\nKD');
  for (const [row, value] of [[18, '海运'], [19, ''], [20, '海派'], [21, '空派'], [22, '快递']]) await expect(channel(row)).toHaveValue(value);
  await expect(wizard().locator('.online-grid tbody tr')).toHaveCount(22); note();

  step = 'oversized-paste-keeps-current-table-intact';
  await paste(channel(1), Array.from({ length: 1001 }, () => 'HP').join('\n'));
  await expect(wizard().getByRole('alert')).toContainText('粘贴范围超出表格');
  await expect(channel(1)).toHaveValue('海运'); await expect(wizard().locator('.online-grid tbody tr')).toHaveCount(22); note();

  step = 'narrow-manual-input-paste-and-default-columns-fit-page';
  await wizard().getByRole('button', { name: '收起补充资料', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 });
  await paste(channel(3), 'HY'); await expect(channel(3)).toHaveValue('海运'); await expect(channel(3)).toBeVisible();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page fits narrow viewport');
  await screenshot('manual-transport-390.png'); await context.close(); note();

  step = 'automatic-shipping-requires-manual-transport-before-any-submission';
  context = await setup(); await cell(1, 'FBA 货件号').fill('FBAREQUIRED');
  await wizard().getByRole('button', { name: '导入并整理本次发货', exact: true }).click();
  await expect(wizard().getByRole('alert')).toContainText('第 1 行'); await expect(channel(1)).toHaveAttribute('aria-invalid', 'true');
  assert.equal(mockedSubmissions.length, 0); assert.equal(mockedLookups.length, 0); await context.close(); note();

  step = 'custom-transport-submits-without-directory-and-uncertain-save-retries-identical-payload';
  context = await setup({ submit: true }); await cell(1, 'FBA 货件号').fill(' fbacustom '); await channel(1).fill('HYKD');
  await wizard().getByRole('button', { name: '导入并整理本次发货', exact: true }).click();
  await expect(wizard().getByRole('alert')).toContainText('模拟接收结果尚未确认');
  assert.equal(mockedSubmissions.length, 1); assert.equal(mockedSubmissions[0].rows[0].channel, 'HYKD'); assert.equal(mockedSubmissions[0].rows[0].fba, 'FBACUSTOM');
  await expect(channel(1)).toBeDisabled(); await expect(cell(1, 'FBA 货件号')).toBeDisabled();
  await wizard().getByRole('button', { name: '导入并整理本次发货', exact: true }).click();
  await expect.poll(() => mockedSubmissions.length).toBe(2); assert.deepEqual(mockedSubmissions[1], mockedSubmissions[0]);
  assert.equal(mockedLookups.length, 0); await context.close(); note();

  step = 'fba-metadata-lookup-keeps-manual-channel-and-ignores-legacy-results-or-issues';
  context = await setup({ lookup: true, submit: true }); await wizard().getByRole('button', { name: '仅导入需求', exact: true }).click();
  await cell(1, 'FBA 货件号').fill('FBAOLDCHANNEL1'); await paste(channel(1), 'HY');
  await cell(2, 'FBA 货件号').fill('FBAOLDCHANNEL2'); await channel(2).fill('自定义专线');
  await wizard().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(wizard().getByRole('alert')).toContainText('模拟接收结果尚未确认');
  await expect(channel(1)).toHaveValue('海运'); await expect(channel(2)).toHaveValue('自定义专线');
  await expect(cell(1, '店铺')).toHaveValue('运输方式测试店'); await expect(cell(2, '目的 FC')).toHaveValue('FC1');
  await expect(wizard().getByText('旧运输方式查询失败，不应再显示。', { exact: false })).toHaveCount(0);
  await expect(wizard().getByText('采用渠道：领星旧运输方式', { exact: true })).toHaveCount(0);
  assert.equal(mockedLookups.length, 1); assert.deepEqual(mockedLookups[0].fbas, ['FBAOLDCHANNEL1', 'FBAOLDCHANNEL2']);
  assert.deepEqual(mockedSubmissions.at(-1).rows.map((row) => row.channel), ['海运', '自定义专线']);
  await screenshot('metadata-keeps-manual-transport-1440.png'); await context.close(); note();

  step = 'demand-only-import-allows-blank-transport-and-submits-metadata';
  context = await setup({ lookup: true, submit: true }); await wizard().getByRole('button', { name: '仅导入需求', exact: true }).click();
  await cell(1, 'FBA 货件号').fill('FBAOPTIONALCHANNEL');
  await wizard().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(wizard().getByRole('alert')).toContainText('模拟接收结果尚未确认');
  await expect(channel(1)).toHaveValue(''); assert.equal(mockedSubmissions.at(-1).rows[0].channel, '');
  assert.equal(mockedSubmissions.at(-1).rows[0].lookupSid, 101); await context.close(); note();

  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(external, []); assert.deepEqual(writes, []); assert.deepEqual(directoryRequests, []);
} catch (error) {
  failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
} finally {
  await browser?.close(); vite?.kill(); if (vite && vite.exitCode === null) await Promise.race([new Promise((done) => vite.once('exit', done)), delay(5000)]);
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: !failed, checks, errors, unexpected, external, writes, directoryRequests,
    mockedLookupRequests: mockedLookups.length, mockedSubmissionRequests: mockedSubmissions.length, realBusinessWrites: 0, realLingxingRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
