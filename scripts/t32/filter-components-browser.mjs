import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import * as contracts from '../../packages/contracts/dist/index.js';

// All APIs are deterministic local fixtures. Unknown APIs and nonlocal requests
// are blocked, including writes: this script never contacts the live backend.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.FILTER_COMPONENTS_EVIDENCE_DIR || resolve(root, '.local/t32/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-19T03:00:00.000Z';
const checks = [], browserErrors = [], unexpectedRequests = [], measurements = [];
let browser, context, page, viteProcess, baseURL, step = 'setup', failed = false;
const id = () => randomUUID();
const note = () => { checks.push({ name: step, result: 'passed' }); console.log('PASS ' + step); };
const copy = (value) => structuredClone(value);
const catalog = { mode: 'manual', version: 1, catalogVersion: 1, lastSyncedAt: null, lastError: null, configured: true, readOnly: true };
const shops = [{ sid: 101, name: '技术美国店' }, { sid: 202, name: '技术英国店' }];
const batch = { id: id(), weekStartDate: '2026-09-07', weekEndDate: '2026-09-13', version: 1, sortMode: 'fba', nextPrefix: 0, createdAt: now };
const makeDemand = (sid) => ({ id: id(), snapshot: { sid, fba: 'FBAFILTER' + sid, shop: shops.find((shop) => shop.sid === sid).name, country: sid === 101 ? '美国' : '英国', channel: sid === 101 ? 'HY' : 'KP', destinationFc: 'TEST1', referenceQuantity: '10', notes: 'TECHNICAL HTTP FIXTURE', subBatchName: null }, version: 1, businessDate: batch.weekStartDate, weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, createdAt: now, updatedAt: now });
const member = makeDemand(101), ungrouped = shops.map((shop) => makeDemand(shop.sid));
const group = { id: id(), batchId: batch.id, name: '技术筛选验证批次', version: 1, status: 'draft', position: 0, demandIds: [member.id], prefix: null, confirmedVersion: null, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now };
const state = { demandQueries: [], batchQueries: [], reportQueries: [], lookupBodies: [], syncBodies: [], physicalBodies: [], lookups: new Map(), syncRuns: [], physicalRuns: [] };
const physicalConfirmationId = id();
const revision = contracts.shipmentRevisionSchema.parse({ id: id(), demandId: member.id, version: 1, demandVersion: 1,
  data: { sid: 101, fba: member.snapshot.fba, items: [], boxes: [], isSta: false, staPlanId: null, observedAt: now, issues: [] },
  source: 'manual', snapshotIds: [], reason: 'TECHNICAL HTTP FIXTURE', createdBy: 'filter-ui', createdAt: now });
const detail = () => contracts.subBatchDetailSchema.parse({ group, members: [member], shipments: [{ demandId: member.id, revision }],
  issues: [{ code: 'LIST_QUANTITY_MISMATCH', severity: 'warning', message: '技术夹具：列表数量需核对。', demandId: member.id }], confirmation: null, codes: [], history: [] });
const physical = () => contracts.physicalReviewSchema.parse({ groupId: group.id, m2ConfirmationId: physicalConfirmationId, version: 0, source: null, availableSources: [], revision: null, confirmation: null, valid: false, canConfirm: false, canExport: false, readOnly: false, pendingChange: false, blocked: [], runs: state.physicalRuns });

function demandWorkspace(raw) {
  const query = contracts.demandWorkspaceQuerySchema.parse(raw); state.demandQueries.push(copy(query));
  return contracts.demandWorkspaceSchema.parse({ rows: [], total: 0, demandTotal: 0, page: query.page, pageSize: query.pageSize, maxBoxes: 10,
    filters: { batches: [batch], shops, countries: ['美国', '英国'], channels: ['HY', 'KP'] }, generatedAt: now });
}
function batchWorkspace(raw) {
  const query = contracts.batchWorkspaceQuerySchema.parse(raw); state.batchQueries.push(copy(query));
  const row = { id: group.id, rowKind: 'group', batch, group, memberCount: 1, status: group.status,
    sids: [101], shops: ['技术美国店'], countries: ['美国'], channels: ['HY'], fbas: [member.snapshot.fba],
    sync: { syncedMemberCount: 0, staleMemberCount: 0, latestRun: null }, confirmation: null };
  return contracts.batchWorkspaceSchema.parse({ rows: [row], total: 1, page: query.page, pageSize: query.pageSize, availableWeeks: [],
    filters: { weeks: [batch], shops, countries: ['美国', '英国'], channels: ['HY', 'KP'] } });
}
async function setupContext() {
  context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(method + ' EXTERNAL ' + url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'filter-ui', name: '筛选组件技术验证', email: 'filter-ui@acceptance.invalid', role: 'admin' } });
    if (method === 'GET' && path === '/api/v1/demands') return json(demandWorkspace(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/demands/' + member.id) return json(contracts.demandDetailSchema.parse({ demand: member, sources: [], revisions: [] }));
    if (method === 'GET' && path === '/api/v1/batches/workspace') return json(batchWorkspace(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/weekly-batches') return json(contracts.weeklyBatchListSchema.parse({ items: [batch], availableWeeks: [] }));
    if (method === 'GET' && path === '/api/v1/weekly-batches/' + batch.id) return json(contracts.weeklyBatchDetailSchema.parse({ batch, groups: [group], ungrouped }));
    if (method === 'GET' && path === '/api/v1/sub-batches/' + group.id) return json(detail());
    if (method === 'GET' && path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: catalog });
    if (method === 'GET' && path === '/api/v1/batch-reports') {
      state.reportQueries.push(Object.fromEntries(url.searchParams));
      return json(contracts.reportResponseSchema.parse({ rows: [], boxes: [], total: 0, page: Number(url.searchParams.get('page') || 1), pageSize: 50, maxBoxes: 0, confirmations: [], blocked: [], generatedAt: now }));
    }
    if (method === 'POST' && path === '/api/v1/imports/fba-lookups') {
      const body = contracts.fbaLookupInputSchema.parse(request.postDataJSON()); state.lookupBodies.push(body);
      const record = contracts.fbaLookupRecordSchema.parse({ id: id(), status: 'completed', startDate: body.startDate, endDate: body.endDate, fbas: body.fbas,
        catalogMode: 'manual', catalogSettingsVersion: 1, catalogVersion: 1, createdAt: now, completedAt: now, errorCode: null, errorMessage: null,
        rows: body.fbas.map((fba) => ({ fba, status: 'not_found', candidates: [] })) });
      state.lookups.set(record.id, record); return json(record);
    }
    if (method === 'GET' && path.startsWith('/api/v1/imports/fba-lookups/')) return json(state.lookups.get(path.split('/').at(-1)));
    if (method === 'GET' && path === '/api/v1/batch-sync/' + group.id) return json({ runs: state.syncRuns });
    if (method === 'POST' && path === '/api/v1/batch-sync/' + group.id) {
      const body = request.postDataJSON(); state.syncBodies.push(body);
      const run = { id: id(), subBatchId: group.id, status: 'completed', startDate: body.startDate, endDate: body.endDate, requestBudget: body.requestBudget, requestsUsed: 0, maxPages: body.maxPages, errorCode: null, errorMessage: null, createdAt: now, startedAt: now, completedAt: now };
      state.syncRuns.unshift(run); return json({ run, items: [] });
    }
    if (method === 'GET' && path.startsWith('/api/v1/batch-sync/runs/')) return json({ run: state.syncRuns.find((run) => path.endsWith(run.id)), items: [] });
    if (method === 'GET' && path === `/api/v1/sub-batches/${group.id}/physical-review`) return json(physical());
    if (method === 'POST' && path === `/api/v1/sub-batches/${group.id}/physical-review/sync`) {
      const body = contracts.physicalSyncInputSchema.parse(request.postDataJSON()); state.physicalBodies.push(body);
      const run = contracts.physicalSyncRunSchema.parse({ id: id(), groupId: group.id, m2ConfirmationId: body.m2ConfirmationId, status: 'completed', startDate: body.startDate, endDate: body.endDate, requestBudget: body.requestBudget, requestsUsed: 0, authRequests: 0, cacheHits: 0, maxPages: body.maxPages, errorCode: null, errorMessage: null, createdAt: now, completedAt: now });
      state.physicalRuns.unshift(run); return json({ run, items: [] });
    }
    if (method === 'GET' && path.startsWith(`/api/v1/sub-batches/${group.id}/physical-review/sync/`)) return json({ run: state.physicalRuns.find((run) => path.endsWith(run.id)), items: [] });
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Blocked unknown fixture API' } }, 500);
  });
  page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.clock.setFixedTime(new Date(now));
}
const form = (name) => page.getByRole('form', { name, exact: true });
const field = (scope, name) => scope.getByLabel(name, { exact: true });
const monthField = (scope) => field(scope, '业务月份');
const monthTrigger = (scope) => scope.getByRole('button', { name: '打开月份选择', exact: true });
async function choose(scope, name, label, search) {
  await field(scope, name).click();
  if (search !== undefined) await page.locator('[cmdk-input]').fill(search);
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function measure(label, popup) {
  const data = await page.evaluate(() => ({ viewport: innerWidth, height: innerHeight, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert(data.document <= data.viewport + 1 && data.body <= data.viewport + 1, label + ': no horizontal viewport overflow');
  const bounds = popup ? await popup.boundingBox() : null;
  measurements.push({ label, ...data, popup: bounds });
  if (bounds) {
    assert(bounds.x >= -1 && bounds.x + bounds.width <= data.viewport + 1, label + ': popup stays horizontally in viewport');
    assert(bounds.y >= -1 && bounds.y + bounds.height <= data.height + 1, label + ': popup stays vertically in viewport');
  }
}
async function screenshot(name) { await page.screenshot({ path: resolve(evidence, name + '.png') }); }

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  baseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  await setupContext();

  step = 'month-picker-choose-current-clear-and-submit-semantics';
  await page.goto('/shipping?view=demands'); const demands = form('筛选发货工作台');
  await expect(field(demands, '店铺')).toBeEnabled(); await expect.poll(() => state.demandQueries.length).toBe(1);
  await monthTrigger(demands).click(); await page.getByRole('button', { name: '9月', exact: true }).click();
  await expect(monthField(demands)).toHaveValue('2026-09');
  await delay(180); assert.equal(state.demandQueries.length, 1, 'choosing a month only edits draft');
  await demands.getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.demandQueries.at(-1)?.month).toBe('2026-09');
  await monthTrigger(demands).click(); await page.getByRole('button', { name: '本月', exact: true }).click();
  await expect(monthField(demands)).toHaveValue('2026-10');
  await monthTrigger(demands).click(); await page.getByRole('button', { name: '清空', exact: true }).click();
  await expect(monthField(demands)).toHaveValue(''); assert.equal(state.demandQueries.at(-1).month, '2026-09'); note();

  step = 'search-shop-by-name-sid-empty-state-reset-and-keyboard';
  await field(demands, '店铺').click(); await page.locator('[cmdk-input]').fill('英国');
  await expect(page.getByRole('option', { name: '技术英国店 · 202', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '技术美国店 · 101', exact: true })).toHaveCount(0);
  await page.locator('[cmdk-input]').fill('101'); await page.getByRole('option', { name: '技术美国店 · 101', exact: true }).click();
  await expect(field(demands, '店铺')).toContainText('技术美国店');
  await field(demands, '店铺').click(); await page.locator('[cmdk-input]').fill('NO-MATCH-XYZ');
  await expect(page.locator('[cmdk-empty]')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(field(demands, '店铺')).toBeFocused();
  await field(demands, '店铺').press('Enter'); await page.locator('[cmdk-input]').fill('202');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(field(demands, '店铺')).toContainText('技术英国店');
  await choose(demands, '数据处理状态', '待核对');
  assert.equal(state.demandQueries.at(-1).sid, undefined, 'selection does not implicitly submit');
  await demands.getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.demandQueries.at(-1)?.sid).toBe(202);
  assert.equal(state.demandQueries.at(-1).status, 'needs_review');
  await demands.getByRole('button', { name: '重置', exact: true }).click();
  await expect(field(demands, '店铺')).toContainText('全部店铺'); await expect(field(demands, '数据处理状态')).toContainText('全部状态');
  await expect.poll(() => state.demandQueries.at(-1)?.sid).toBeUndefined(); note();

  step = 'combobox-outside-click-keeps-the-next-input-focused';
  await field(demands, '店铺').click(); await field(demands, '搜索').click({ position: { x: 12, y: 20 } });
  await expect(field(demands, '搜索')).toBeFocused(); await field(demands, '搜索').pressSequentially('FBAFILTER');
  await expect(field(demands, '搜索')).toHaveValue('FBAFILTER'); await expect(field(demands, '搜索')).toBeFocused();
  await expect(page.locator('[cmdk-input]')).toHaveCount(0);
  await demands.getByRole('button', { name: '重置', exact: true }).click(); note();

  step = 'batch-week-search-and-select-filter-drafts';
  await page.goto('/batches'); const batches = form('筛选发货批次');
  await choose(batches, '开始周', '2026-09-07 至 2026-09-13', '09-13');
  await choose(batches, '结束周', '2026-09-07 至 2026-09-13', '09-07');
  await choose(batches, '店铺', '技术美国店 · 101', '101'); await choose(batches, '处理状态', '待确认');
  const batchQueriesBeforeSubmit = state.batchQueries.length;
  await batches.getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.batchQueries.length).toBeGreaterThan(batchQueriesBeforeSubmit);
  await expect.poll(() => state.batchQueries.at(-1)?.status).toBe('draft');
  assert.equal(state.batchQueries.at(-1).weekFrom, '2026-09-07'); assert.equal(state.batchQueries.at(-1).weekTo, '2026-09-07'); note();

  step = 'native-dialog-searchable-week-and-shop-focus';
  await page.getByRole('button', { name: '新建批次', exact: true }).click();
  const create = page.getByRole('dialog', { name: '建立发货批次', exact: true }); await expect(create).toBeVisible();
  await choose(create, '需求周范围', '2026-09-07 至 2026-09-13 · 已有周批次', '09-07');
  await create.getByRole('button', { name: '下一步：选择需求', exact: true }).click();
  await choose(create, '店铺', '技术英国店 · 202', '202'); await expect(field(create, '店铺')).toContainText('英国');
  await field(create, '店铺').click(); await page.keyboard.press('Escape');
  await expect(create).toBeVisible(); await expect(field(create, '店铺')).toBeFocused();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await field(create, '店铺').click();
    await measure('dialog-combobox-' + width, page.getByRole('listbox')); await screenshot('dialog-combobox-' + width);
    await page.keyboard.press('Escape'); await expect(create).toBeVisible();
  }
  await create.getByRole('button', { name: '关闭建立发货批次', exact: true }).click(); note();

  step = 'workbench-month-region-submit-and-presentation-select';
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/shipping?view=reports'); const reports = form('筛选发货工作台');
  await monthField(reports).fill('2026-09'); await choose(reports, '国家 / 区域', '美国');
  const reportsBeforeSubmit = state.reportQueries.length;
  await reports.getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.reportQueries.length).toBeGreaterThan(reportsBeforeSubmit);
  await expect.poll(() => state.reportQueries.at(-1)?.month).toBe('2026-09'); assert.equal(state.reportQueries.at(-1).region, 'US');
  await choose(reports, '展示方式', '逐箱长表'); await expect(field(reports, '展示方式')).toContainText('逐箱长表'); note();

  step = 'responsive-month-and-select-panels-without-overflow';
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await monthTrigger(reports).click();
    await measure('month-' + width, page.locator('[data-radix-popper-content-wrapper]').last()); await screenshot('month-' + width); await page.keyboard.press('Escape');
    await field(reports, '国家 / 区域').click(); await measure('select-' + width, page.getByRole('listbox')); await screenshot('select-' + width); await page.keyboard.press('Escape');
  }
  for (const { width, height } of [{ width: 390, height: 700 }, { width: 320, height: 568 }]) {
    await page.setViewportSize({ width, height }); await monthTrigger(reports).click();
    await measure(`month-${width}x${height}`, page.locator('.picker-popover').last());
    await page.getByRole('button', { name: '清空', exact: true }).scrollIntoViewIfNeeded(); await screenshot(`month-${width}x${height}`); await page.keyboard.press('Escape');
  }
  note();

  step = 'inclusive-fba-date-range-and-popup-in-native-dialog';
  await page.goto('/imports/new'); const imports = page.getByRole('dialog', { name: '导入向导', exact: true });
  await expect(imports.getByRole('button', { name: '表格导入', exact: true })).toBeVisible();
  await field(imports, '第 1 行FBA 货件号').fill('FBAFILTER123');
  await field(imports, '货件创建日期从').fill('2026-09-07'); await field(imports, '至（包含当天）').fill('2026-09-07');
  await imports.getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect.poll(() => state.lookupBodies.length).toBe(1);
  await expect(imports.getByRole('checkbox', { name: /按当前填写继续/ })).toBeVisible();
  assert.equal(state.lookupBodies[0].startDate, '2026-09-07'); assert.equal(state.lookupBodies[0].endDate, '2026-09-07', 'same-day FBA lookup includes end day');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); const trigger = imports.getByRole('button', { name: '选择日期范围', exact: true }); await trigger.click();
    await measure('range-dialog-' + width, page.locator('[data-radix-popper-content-wrapper]').last()); await screenshot('range-dialog-' + width);
    await page.keyboard.press('Escape'); await expect(imports).toBeVisible(); await expect(trigger).toBeFocused();
  }
  for (const { width, height } of [{ width: 390, height: 700 }, { width: 320, height: 568 }]) {
    await page.setViewportSize({ width, height }); const trigger = imports.getByRole('button', { name: '选择日期范围', exact: true }); await trigger.click();
    const popup = page.locator('.picker-popover').last(); await measure(`range-dialog-${width}x${height}`, popup);
    await popup.evaluate((node) => { node.scrollTop = 0; }); await expect(page.getByRole('button', { name: '最近7天', exact: true })).toBeInViewport();
    await screenshot(`range-dialog-${width}x${height}-top`);
    await page.getByRole('button', { name: '清空日期', exact: true }).scrollIntoViewIfNeeded(); await expect(page.getByRole('button', { name: '清空日期', exact: true })).toBeInViewport(); await screenshot(`range-dialog-${width}x${height}-bottom`);
    await page.keyboard.press('Escape'); await expect(imports).toBeVisible(); await expect(trigger).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await imports.getByRole('button', { name: '选择日期范围', exact: true }).click(); await page.getByRole('button', { name: '最近7天', exact: true }).click();
  await expect(field(imports, '货件创建日期从')).toHaveValue('2026-10-13'); await expect(field(imports, '至（包含当天）')).toHaveValue('2026-10-19');
  await imports.getByRole('button', { name: '选择日期范围', exact: true }).click();
  await page.locator('[data-day="2026-10-15"] button').click(); await page.keyboard.press('Escape');
  await expect(field(imports, '货件创建日期从')).toHaveValue('2026-10-13'); await expect(field(imports, '至（包含当天）')).toHaveValue('2026-10-19');
  await imports.getByRole('button', { name: '选择日期范围', exact: true }).click();
  await page.locator('[data-day="2026-10-15"] button').click(); await page.locator('[data-day="2026-10-15"] button').click();
  await expect(field(imports, '货件创建日期从')).toHaveValue('2026-10-15'); await expect(field(imports, '至（包含当天）')).toHaveValue('2026-10-15');
  await imports.getByRole('button', { name: '选择日期范围', exact: true }).click();
  await page.locator('[data-day="2026-10-19"] button').click(); await page.locator('[data-day="2026-10-13"] button').click();
  await expect(field(imports, '货件创建日期从')).toHaveValue('2026-10-13'); await expect(field(imports, '至（包含当天）')).toHaveValue('2026-10-19');
  await imports.getByRole('button', { name: '选择日期范围', exact: true }).click(); await page.getByRole('button', { name: '本月', exact: true }).click();
  await expect(field(imports, '货件创建日期从')).toHaveValue('2026-10-01'); await expect(field(imports, '至（包含当天）')).toHaveValue('2026-10-31');
  await imports.getByRole('button', { name: '选择日期范围', exact: true }).click(); await page.getByRole('button', { name: '清空日期', exact: true }).click();
  await expect(field(imports, '货件创建日期从')).toHaveValue(''); await expect(field(imports, '至（包含当天）')).toHaveValue('');
  note();

  // A fresh context avoids the dirty import draft's intentional route guard.
  await context.close(); await setupContext();
  step = 'exclusive-sync-range-preserves-wire-format';
  await page.goto(`/batches/${batch.id}?groupId=${group.id}&wizard=process&stage=products`);
  const processDialog = page.getByRole('dialog', { name: '发货批次处理向导', exact: true }); await expect(processDialog).toBeVisible();
  const shipment = field(processDialog, '选择货件');
  await shipment.click(); await shipment.evaluate((node) => { node.closest('fieldset').disabled = true; });
  await expect(shipment).toBeDisabled(); await expect(page.locator('[cmdk-input]')).toHaveCount(0);
  await shipment.evaluate((node) => { node.closest('fieldset').disabled = false; }); await expect(shipment).toBeEnabled();
  await processDialog.getByRole('button', { name: '选择日期范围', exact: true }).click(); await page.getByRole('button', { name: '最近7天', exact: true }).click();
  await expect(field(processDialog, '货件创建日期起')).toHaveValue('2026-10-13'); await expect(field(processDialog, '货件创建日期止（不含）')).toHaveValue('2026-10-20');
  await processDialog.getByRole('button', { name: '同步全部成员', exact: true }).click(); await expect.poll(() => state.syncBodies.length).toBe(1);
  assert.equal(state.syncBodies[0].startDate, '2026-10-13'); assert.equal(state.syncBodies[0].endDate, '2026-10-20', 'exclusive range carries next midnight date');
  await field(processDialog, '同步历史').click(); await page.getByRole('option').click();
  await page.setViewportSize({ width: 390, height: 700 }); await field(processDialog, '同步历史').click();
  await measure('combobox-history-native-dialog-390x700', page.getByRole('listbox')); await screenshot('combobox-history-native-dialog-390x700');
  await page.keyboard.press('Escape'); await expect(field(processDialog, '同步历史')).toBeFocused(); await expect(processDialog).toBeVisible();
  await choose(processDialog, '需要记录决定的差异', '列表与详情冲突：保留详情主口径');
  await expect(field(processDialog, '需要记录决定的差异')).toContainText('列表与详情冲突：保留详情主口径');
  await field(processDialog, '需要记录决定的差异').click();
  await measure('select-native-dialog-390x700', page.getByRole('listbox')); await screenshot('select-native-dialog-390x700');
  await page.keyboard.press('Escape'); await expect(field(processDialog, '需要记录决定的差异')).toBeFocused(); await expect(processDialog).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 }); note();

  step = 'single-date-picker-today-clear-calendar-and-invalid-input';
  await processDialog.getByRole('button', { name: '来源与登记', exact: true }).click();
  const actualDate = field(processDialog, '实际发货日期（本地登记）');
  await processDialog.getByRole('button', { name: '打开日期选择', exact: true }).click(); await page.getByRole('button', { name: '今天', exact: true }).click();
  await expect(actualDate).toHaveValue('2026-10-19');
  await processDialog.getByRole('button', { name: '打开日期选择', exact: true }).click(); await page.locator('[data-day="2026-10-15"] button').click();
  await expect(actualDate).toHaveValue('2026-10-15');
  await processDialog.getByRole('button', { name: '打开日期选择', exact: true }).click(); await page.getByRole('button', { name: '清空', exact: true }).click();
  await expect(actualDate).toHaveValue('');
  await actualDate.fill('2026-02-30'); await actualDate.blur();
  await expect(actualDate).toHaveAttribute('aria-invalid', 'true'); await expect(processDialog.getByRole('button', { name: '保存日期', exact: true })).toBeDisabled();
  await actualDate.fill('2026-10-19'); await actualDate.blur(); await expect(actualDate).not.toHaveAttribute('aria-invalid', 'true'); note();

  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-filter-components-browser', passed: !failed, checks, measurements, browserErrors, unexpectedRequests, externalRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
