import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { serviceMappingCreateInputSchema, serviceMappingDeleteInputSchema, serviceMappingListSchema, serviceMappingMutationResultSchema, serviceMappingOptionsSchema, serviceMappingRevisionInputSchema } from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';
import { gridRowCount } from '../shared/grid.mjs';
import { openRowMenu } from '../m4/grid-helpers.mjs';

// Isolated browser fixtures only. All API and external origins are intercepted;
// no production data, credentials, database, or real Lingxing request is used.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.local/settings/service-mappings');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-11-02T02:00:00.000Z';
const label = '发票服务映射列表';
const checks = [], errors = [], unexpected = [], external = [], writes = [], releases = [];
let browser, vite, page, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
const availableOptions = () => serviceMappingOptionsSchema.parse({ countries: { status: 'available', items: [{ code: 'US', name: '美国' }, { code: 'DE', name: '德国' }] }, transportMethods: { status: 'available', items: [{ id: 'tech-sea', name: 'SEA_TECH', enabled: true, remark: '' }, { id: 'tech-air', name: 'AIR_TECH', enabled: true, remark: '' }, { id: 'tech-disabled', name: 'DISABLED_TECH', enabled: false, remark: '' }] } });
const fixture = () => ({ mappings: [], options: availableOptions(), writeError: null, holdWrite: false, releaseWrite: null, holdOptions: false, releaseOptions: null });
const makeMapping = (values = {}) => ({ id: randomUUID(), countryCode: 'US', transportMethod: 'SEA_TECH', transportMethodId: 'tech-sea', service: '技术夹具服务', version: 1, createdAt: now, updatedAt: now, deletedAt: null, ...values });
const dialog = (kind = '新增') => page.getByRole('dialog', { name: `${kind}发票服务映射`, exact: true });
const save = (kind = '新增') => dialog(kind).getByRole('button', { name: '保存映射', exact: true });
const field = (name, kind = '新增') => dialog(kind).getByLabel(name, { exact: true });
const mappingMenu = () => openRowMenu(page.locator('.service-mappings-list'), label);

async function setup(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL) { external.push(method + ' ' + url.href); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'service-fixture', name: '隔离测试', email: 'fixture@example.invalid', role: 'admin' } });
    if (method === 'GET' && path === '/api/v1/service-mappings') return json(serviceMappingListSchema.parse({ items: state.mappings.filter((item) => !item.deletedAt) }));
    if (method === 'GET' && path === '/api/v1/service-mappings/options') {
      if (state.holdOptions) await new Promise((done) => { state.releaseOptions = () => { state.holdOptions = false; done(); }; releases.push(state.releaseOptions); });
      return json(serviceMappingOptionsSchema.parse(state.options));
    }
    const match = /^\/api\/v1\/service-mappings(?:\/([0-9a-f-]+)\/(revisions|delete))?$/.exec(path);
    if (method === 'POST' && match) {
      const kind = match[2] || 'create', schema = kind === 'delete' ? serviceMappingDeleteInputSchema : kind === 'revisions' ? serviceMappingRevisionInputSchema : serviceMappingCreateInputSchema;
      const input = schema.parse(request.postDataJSON()); writes.push({ path, input: structuredClone(input) });
      if (state.holdWrite) await new Promise((done) => { state.releaseWrite = () => { state.holdWrite = false; done(); }; releases.push(state.releaseWrite); });
      if (state.writeError) { const failure = state.writeError; state.writeError = null; return json({ error: failure }, failure.status || 503); }
      let mapping = match[1] ? state.mappings.find((item) => item.id === match[1]) : null;
      if (match[1] && (!mapping || mapping.version !== input.expectedVersion)) return json({ error: { code: 'SERVICE_MAPPING_VERSION_CONFLICT', message: '服务映射已被其他操作更新，请读取最新版本。' } }, 409);
      if (kind === 'delete') mapping = { ...mapping, deletedAt: now, version: mapping.version + 1 };
      else {
        if (state.mappings.some((item) => !item.deletedAt && item.id !== mapping?.id && item.countryCode === input.countryCode && item.transportMethod === input.transportMethod)) return json({ error: { code: 'SERVICE_MAPPING_DUPLICATE', message: '此国家和运输方式已有映射。' } }, 409);
        mapping = makeMapping({ ...mapping, countryCode: input.countryCode, transportMethod: input.transportMethod, transportMethodId: input.transportMethodId ?? null, service: input.service, version: mapping ? mapping.version + 1 : 1 });
      }
      const index = state.mappings.findIndex((item) => item.id === mapping.id); if (index === -1) state.mappings.push(mapping); else state.mappings[index] = mapping;
      return json(serviceMappingMutationResultSchema.parse({ mapping, replayed: false }));
    }
    unexpected.push(method + ' ' + path); return json({ error: { code: 'FIXTURE_UNHANDLED', message: 'Unexpected fixture request' } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/settings/service-mappings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '发票服务映射', exact: true })).toBeVisible();
  return context;
}
async function newMapping(country = 'US', method = 'SEA_TECH', service = '技术夹具服务') {
  await page.getByRole('button', { name: '新增映射', exact: true }).click();
  await chooseOption(field('国家'), country); await chooseOption(field('运输方式'), method); await field('发票服务名称').fill(service);
}
async function screenshot(name) { await page.screenshot({ path: resolve(evidence, name), fullPage: true, animations: 'disabled' }); }
async function fit(width, modal) {
  await page.setViewportSize({ width, height: 1000 });
  // Allow the shared grid's ResizeObserver and popover-anchor reset to settle.
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page fits ' + width);
  if (modal) for (const control of await modal.locator('input:not([aria-hidden="true"]),button[role="combobox"],button[data-slot="button"]').all()) {
    if (!await control.isVisible()) continue;
    const bounds = await control.boundingBox(); assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'Dialog control fits ' + width + ': ' + await control.evaluate((node) => node.outerHTML));
  }
}

try {
  await mkdir(evidence, { recursive: true }); const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  vite = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  browser = await chromium.launch({ channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome', headless: true });
  const state = fixture(); let context = await setup(state);

  step = 'empty-page-navigation-and-explicit-create';
  await expect(page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '发票服务映射', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('还没有服务映射。', { exact: false })).toBeVisible(); assert.equal(writes.length, 0);
  await newMapping(); await expect(field('国家')).toHaveAttribute('data-value', 'US');
  await field('运输方式').click(); await expect(page.locator('[role="option"][data-option-value="DISABLED_TECH"]')).toHaveAttribute('aria-disabled', 'true'); await page.keyboard.press('Escape');
  for (const width of [1440, 390, 320]) { await fit(width, dialog()); await screenshot(`service-mapping-create-${width}.png`); }
  state.holdWrite = true; await save().dblclick(); await expect.poll(() => writes.length).toBe(1); await expect.poll(() => typeof state.releaseWrite).toBe('function');
  await expect(field('发票服务名称')).toBeDisabled(); await expect(dialog().getByRole('button', { name: '关闭新增发票服务映射', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog()).toBeVisible();
  state.releaseWrite(); await expect(dialog()).toHaveCount(0); await expect.poll(() => gridRowCount(page, label)).toBe(1); note();

  step = 'searches-country-transport-method-and-service-without-writing';
  const beforeSearch = writes.length;
  for (const query of ['美国', 'US', 'SEA_TECH', '技术夹具服务']) { await page.getByLabel('国家、运输方式或服务', { exact: true }).fill(query); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect.poll(() => gridRowCount(page, label)).toBe(1); }
  await page.getByLabel('国家、运输方式或服务', { exact: true }).fill('NO_TECH_MATCH'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.getByText('没有符合搜索条件的服务映射。请调整搜索内容。', { exact: true })).toBeVisible();
  await page.getByLabel('国家、运输方式或服务', { exact: true }).fill(''); await page.getByRole('button', { name: '搜索', exact: true }).click(); assert.equal(writes.length, beforeSearch); note();

  step = 'duplicate-combinations-keep-input-and-do-not-write';
  await newMapping(); await save().click(); await expect(dialog().getByRole('alert')).toContainText('此国家和运输方式已有映射'); await expect(field('发票服务名称')).toHaveValue('技术夹具服务'); assert.equal(writes.length, beforeSearch);
  await dialog().getByRole('button', { name: '取消', exact: true }).click(); note();

  step = 'edit-failure-preserves-input-and-reuses-operation-on-retry';
  await page.setViewportSize({ width: 1440, height: 1000 }); let menu = await mappingMenu(); await menu.getByRole('menuitem', { name: '编辑映射', exact: true }).click();
  await field('发票服务名称', '编辑').fill('技术服务修订'); state.writeError = { code: 'FIXTURE_FAILURE', message: '技术夹具：保存暂不可用。', status: 503 }; await save('编辑').click();
  await expect(dialog('编辑').getByRole('alert')).toContainText('保存暂不可用'); await expect(field('发票服务名称', '编辑')).toHaveValue('技术服务修订'); const failureWrite = structuredClone(writes.at(-1));
  await save('编辑').click(); await expect(dialog('编辑')).toHaveCount(0); assert.deepEqual(writes.at(-1), failureWrite); assert.equal(state.mappings[0].service, '技术服务修订'); note();

  step = 'version-conflict-reloads-current-version-and-retains-local-input';
  menu = await mappingMenu(); await menu.getByRole('menuitem', { name: '编辑映射', exact: true }).click(); await field('发票服务名称', '编辑').fill('冲突后保留的技术服务');
  state.mappings[0] = { ...state.mappings[0], version: state.mappings[0].version + 1, service: '其他操作保存的技术服务' }; await save('编辑').click();
  await expect(dialog('编辑').getByRole('alert')).toContainText('已被其他操作更新'); await expect(field('发票服务名称', '编辑')).toHaveValue('冲突后保留的技术服务');
  await dialog('编辑').getByRole('button', { name: '读取最新版本并保留输入', exact: true }).click(); await expect(dialog('编辑').getByRole('status')).toContainText('其他操作保存的技术服务');
  await expect(field('发票服务名称', '编辑')).toHaveValue('冲突后保留的技术服务'); await save('编辑').click(); await expect(dialog('编辑')).toHaveCount(0); assert.equal(writes.at(-1).input.expectedVersion, 3); note();

  step = 'list-and-delete-confirmation-fit-desktop-and-narrow-viewports';
  for (const width of [1440, 390, 320]) { await fit(width); await screenshot(`service-mapping-list-${width}.png`); menu = await mappingMenu(); await menu.getByRole('menuitem', { name: '删除映射', exact: true }).click(); await fit(width, dialog('删除')); await screenshot(`service-mapping-delete-${width}.png`); await dialog('删除').getByRole('button', { name: '取消', exact: true }).click(); }
  assert.equal(state.mappings[0].deletedAt, null); menu = await mappingMenu(); await menu.getByRole('menuitem', { name: '删除映射', exact: true }).click();
  state.holdWrite = true; const beforeDelete = writes.length; await dialog('删除').getByRole('button', { name: '确认删除', exact: true }).dblclick(); await expect.poll(() => writes.length).toBe(beforeDelete + 1);
  await expect(dialog('删除').getByRole('button', { name: '取消', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog('删除')).toBeVisible(); state.releaseWrite(); await expect(dialog('删除')).toHaveCount(0); await expect(page.getByText('还没有服务映射。', { exact: false })).toBeVisible(); note();
  await context.close();

  step = 'unavailable-directories-allow-editing-an-unchanged-historical-pair-and-retry-retains-input';
  const historical = fixture(); historical.mappings = [makeMapping({ countryCode: 'FR', transportMethod: 'HISTORICAL_TECH', transportMethodId: 'old-tech' })];
  historical.options = { countries: { status: 'unavailable', items: [], message: '领星国家目录暂不可用。' }, transportMethods: { status: 'unavailable', items: [], message: '领星运输方式目录暂不可用。' } }; context = await setup(historical);
  menu = await mappingMenu(); await menu.getByRole('menuitem', { name: '编辑映射', exact: true }).click();
  await expect(field('国家', '编辑')).toBeDisabled(); await expect(field('运输方式', '编辑')).toBeDisabled(); await field('发票服务名称', '编辑').fill('历史组合服务修订'); await expect(save('编辑')).toBeEnabled();
  await expect(dialog('编辑').getByRole('status')).toContainText('仍可修改服务名称'); historical.holdOptions = true; await dialog('编辑').getByRole('button', { name: '重试领星选项', exact: true }).click();
  await expect.poll(() => typeof historical.releaseOptions).toBe('function'); await expect(field('发票服务名称', '编辑')).toHaveValue('历史组合服务修订'); historical.options = availableOptions(); historical.releaseOptions();
  await expect(dialog('编辑').getByRole('status')).toContainText('当前不在领星可用目录'); await expect(field('发票服务名称', '编辑')).toHaveValue('历史组合服务修订');
  await save('编辑').click(); await expect(dialog('编辑')).toHaveCount(0); assert.equal(historical.mappings[0].service, '历史组合服务修订'); assert.equal(writes.at(-1).input.transportMethodId, 'old-tech'); note();

  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(external, []);
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {}); }
finally {
  releases.forEach((release) => release()); await browser?.close(); vite?.kill(); if (vite && vite.exitCode === null) await Promise.race([new Promise((done) => vite.once('exit', done)), delay(5000)]);
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: !failed, checks, errors, unexpected, external, fixtureWrites: writes, realBusinessWrites: 0, realLingxingRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
