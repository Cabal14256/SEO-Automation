import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import * as contracts from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';

// Isolated HTTP fixtures; no database, account files, or external services.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.local/t36/frontend');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-20T03:00:00.000Z';
const id = () => randomUUID();
const copy = (value) => structuredClone(value);
const checks = [], unexpectedRequests = [], browserErrors = [];
let browser, viteProcess, page, baseURL, step = 'setup', failed = false;
const note = () => { checks.push({ name: step, result: 'passed' }); console.log('PASS ' + step); };

function fixture(large = false) {
  const state = { reportQueries: [], reportBodies: [], reportExports: [], reportFailure: null };
  state.batch = { id: id(), weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', version: 1, sortMode: 'fba', nextPrefix: 0, createdAt: now };
  state.frameGroup = { id: id(), batchId: state.batch.id, name: '成品表技术验证', version: 1, status: 'confirmed', position: 0, demandIds: [], prefix: 'A', confirmedVersion: 1, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now };
  const groups = Array.from({ length: large ? 501 : 3 }, (_, index) => ({ id: id(), name: large ? `上限测试批次 ${index + 1}` : ['搜索命中完整组', '跨页第二组', '欧洲历史组'][index], confirmationId: id(), version: 1, boxId: id() }));
  state.groups = groups;
  state.rows = groups.flatMap((group, index) => Array.from({ length: !large && index === 0 ? 52 : 1 }, (_, product) => ({
    id: `${group.id}:${product}`, groupId: group.id, groupName: group.name, confirmationId: group.confirmationId, weekStartDate: '2026-10-12', weekEndDate: '2026-10-18',
    businessDate: !large && index === 2 ? '2026-09-15' : '2026-10-13', sid: 101, shop: '技术美国店', country: !large && index === 2 ? '德国' : '美国', channel: 'HY', destinationFc: 'ONT8', fba: `FBA-TABLE-${index}`,
    msku: `MSKU-${index}-${product}`, fnsku: `FNSKU-${index}-${product}`, sku: `SKU-${index}-${product}`, productName: index === 0 && product === 0 ? '定位商品' : `完整组商品 ${index}-${product}`,
    quantity: 10, boxes: [{ boxId: group.boxId, boxOrder: 1, code: `CODE-${index}`, quantity: 10 }], codes: [`CODE-${index}`], groupQuantity: 10, monthQuantity: 10, status: '已确认', actualShipDate: null, sourceObservedAt: now, dataRevisionId: id(),
  })));
  state.boxes = groups.map((group, index) => ({ groupId: group.id, groupName: group.name, confirmationId: group.confirmationId, demandId: id(), fba: `FBA-TABLE-${index}`, sid: 101, boxId: group.boxId, boxOrder: 1, code: `CODE-${index}`, boxName: `箱 ${index}`, boxExternalId: null, localBoxId: null, weight: 1, weightUnit: 'KG', length: 1, width: 2, height: 3, lengthUnit: 'CM', items: state.rows.filter((row) => row.groupId === group.id).map(({ msku, fnsku, sku, quantity }) => ({ msku, fnsku, sku, quantity })) }));
  state.report = (raw) => {
    state.reportQueries.push(copy(raw));
    let rows = state.rows.filter((row) => (!raw.month || row.businessDate.startsWith(raw.month)) && (!raw.region || raw.region === 'all' || (raw.region === 'US' ? row.country === '美国' : row.country === '德国')));
    const q = raw.q?.trim().toLowerCase();
    if (q) { const matched = new Set(rows.filter((row) => [row.groupName, row.fba, row.shop, row.productName, row.msku, row.fnsku, row.sku, ...row.codes].some((value) => value.toLowerCase().includes(q))).map((row) => row.groupId)); rows = rows.filter((row) => matched.has(row.groupId)); }
    const included = new Set(rows.map((row) => row.groupId)), pageNumber = Number(raw.page || 1), pageSize = 50;
    return contracts.reportResponseSchema.parse({ rows: rows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize), boxes: state.boxes.filter((box) => included.has(box.groupId)), confirmations: groups.filter((group) => included.has(group.id)).map((group) => ({ groupId: group.id, groupVersion: group.version, confirmationId: group.confirmationId })), total: rows.length, page: pageNumber, pageSize, maxBoxes: included.size ? 1 : 0, blocked: [], generatedAt: now });
  };
  return state;
}

async function contextFor(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(method + ' EXTERNAL ' + url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === `/api/v1/weekly-batches/${state.batch.id}`) return json(contracts.weeklyBatchDetailSchema.parse({ batch: state.batch, groups: [state.frameGroup], ungrouped: [] }));
    if (method === 'GET' && path === `/api/v1/sub-batches/${state.frameGroup.id}`) return json(contracts.subBatchDetailSchema.parse({ group: state.frameGroup, members: [], shipments: [], issues: [], confirmation: null, codes: [], history: [] }));
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '表格范围技术验证', email: 'table@acceptance.invalid', role: 'admin' } });
    // The merged workbench also loads its common filter metadata and batch rail.
    if (method === 'GET' && path === '/api/v1/demands') return json(contracts.demandWorkspaceSchema.parse({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 20, maxBoxes: 10, filters: { weeks: [], batches: [], shops: [{ sid: 101, name: '技术美国店' }], countries: ['美国', '德国'], channels: ['HY'] }, generatedAt: now }));
    if (method === 'GET' && path === '/api/v1/batches/workspace') return json(contracts.batchWorkspaceSchema.parse({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [{ sid: 101, name: '技术美国店' }], countries: ['美国', '德国'], channels: ['HY'] } }));
    if (method === 'GET' && path === '/api/v1/batch-reports') return json(state.report(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/batch-reports/exports') return json({ items: state.reportExports });
    if (method === 'GET' && path.startsWith('/api/v1/files/')) return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'isolated-ui-download-fixture' });
    if (method === 'POST' && path === '/api/v1/batch-reports/exports') {
      const body = contracts.reportExportInputSchema.parse(request.postDataJSON()); state.reportBodies.push(copy(body));
      if (state.reportFailure) { const failure = state.reportFailure; state.reportFailure = null; return json({ error: { code: failure, message: '技术夹具导出失败' } }, failure === 'QUEUE_UNAVAILABLE' ? 503 : 409); }
      const record = contracts.reportExportRecordSchema.parse({ id: id(), status: 'completed', groupIds: body.groupIds, references: body.expectedConfirmations, month: body.month || null, region: body.region, fileId: id(), error: null, createdAt: now, completedAt: now, rowCount: 1, boxCount: 1, valid: true, invalidReason: null });
      state.reportExports.push(record); return json({ export: record, replayed: false }, 202);
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unhandled isolated fixture API' } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => browserErrors.push(error.message)); return context;
}

const reportTable = () => page.getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true });
const generateReport = () => page.getByRole('button', { name: '生成发货表 XLSX', exact: true });
const nextPage = () => page.getByRole('button', { name: '下一页', exact: true });
const previousPage = () => page.getByRole('button', { name: '上一页', exact: true });
const reportForm = () => page.getByRole('form', { name: '筛选成品表', exact: true });
// The standalone report link now opens the unified workbench. Exercise the
// supported report component through the batch detail tab.
const openReport = (state) => page.goto(`/batches/${state.batch.id}?groupId=${state.frameGroup.id}&tab=reports`);

async function reportChecks(state) {
  step = 'report-empty-default-current-page-mixed-and-cross-page-selection';
  await openReport(state); await expect(reportTable()).toContainText('定位商品'); await expect(generateReport()).toBeDisabled();
  const first = reportTable().locator('tbody').getByRole('checkbox').first(), header = reportTable().locator('thead').getByRole('checkbox');
  await first.focus(); await page.keyboard.press('Space'); await expect(reportTable().locator('tbody input:checked')).toHaveCount(50); await expect(header).toBeChecked();
  await nextPage().click(); await expect(reportTable()).toContainText('跨页第二组');
  await expect(reportTable().locator('tbody input:checked')).toHaveCount(2); await expect(header).toHaveAttribute('aria-checked', 'mixed');
  await reportTable().locator('tbody tr').filter({ hasText: '跨页第二组' }).getByRole('checkbox').check();
  await previousPage().click(); await expect(first).toBeChecked(); await expect(page.getByRole('status').filter({ hasText: '已选 2 个子批次' })).toBeVisible();
  await chooseOption(page.getByLabel('明细视图', { exact: true }), 'boxes');
  const boxes = page.getByRole('region', { name: '逐箱长表，可横向滚动', exact: true });
  await expect(boxes.locator('tbody input:checked')).toHaveCount(53); await expect(boxes.locator('thead').getByRole('checkbox')).toHaveAttribute('aria-checked', 'mixed'); note();

  step = 'report-search-keeps-whole-group-and-clears-selection-on-apply';
  await chooseOption(page.getByLabel('明细视图', { exact: true }), 'products');
  const search = reportForm().getByLabel('搜索', { exact: true }); await search.fill('  定位商品  '); await expect(generateReport()).toBeDisabled();
  await reportForm().getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.reportQueries.at(-1)?.q).toBe('定位商品'); await expect(first).not.toBeChecked(); await expect(generateReport()).toBeDisabled();
  await nextPage().click(); await expect(reportTable()).toContainText('完整组商品 0-51'); await expect(reportTable()).not.toContainText('跨页第二组');
  await search.fill('not-found'); await search.press('Enter'); await expect(page.getByText('未找到匹配的子批次，请调整搜索词或筛选条件。', { exact: true })).toBeVisible();
  await search.fill('msku-0-0'); await search.press('Enter'); await expect(reportTable()).toContainText('定位商品'); await expect(first).not.toBeChecked();
  await page.screenshot({ path: resolve(evidence, 'reports-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: resolve(evidence, 'reports-390.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.setViewportSize({ width: 1440, height: 1000 }); note();

  step = 'report-queue-retry-preserves-reference-and-operation-conflict-clears';
  await first.check(); state.reportFailure = 'QUEUE_UNAVAILABLE'; await generateReport().click();
  await expect(page.getByRole('alert')).toContainText('任务队列暂不可用'); await expect(first).toBeChecked(); await expect(generateReport()).toBeEnabled();
  const snapshot = copy(state.reportBodies.at(-1)); await generateReport().click();
  await expect.poll(() => state.reportExports.length).toBe(1); assert.deepEqual(state.reportBodies.at(-1), snapshot);
  assert.deepEqual(snapshot.groupIds, [state.groups[0].id]); assert.equal(snapshot.expectedConfirmations[0].confirmationId, state.groups[0].confirmationId);
  await page.getByRole('button', { name: '发货表导出记录', exact: true }).click();
  const history = page.getByRole('dialog', { name: '导出记录', exact: true }); await expect(history).toContainText('已生成');
  const download = page.waitForEvent('download'); await history.getByRole('button', { name: '下载 XLSX', exact: true }).click(); assert((await download).suggestedFilename().endsWith('.xlsx'));
  await page.keyboard.press('Escape'); state.reportFailure = 'VERSION_CONFLICT'; await generateReport().click();
  await expect(first).not.toBeChecked(); await expect(generateReport()).toBeDisabled();
  await first.check(); state.groups[0].version += 1; state.groups[0].confirmationId = id();
  state.rows.filter((row) => row.groupId === state.groups[0].id).forEach((row) => { row.confirmationId = state.groups[0].confirmationId; });
  state.boxes[0].confirmationId = state.groups[0].confirmationId;
  await page.getByRole('button', { name: '刷新成品表', exact: true }).click(); await expect(first).not.toBeChecked(); await expect(generateReport()).toBeDisabled(); note();
}

async function limitChecks(state) {
  step = 'whole-group-selection-limit-refuses-overflow-without-silent-truncation';
  await openReport(state); await expect(reportTable()).toBeVisible(); await chooseOption(page.getByLabel('明细视图', { exact: true }), 'boxes');
  const table = page.getByRole('region', { name: '逐箱长表，可横向滚动', exact: true });
  await table.locator('thead').getByRole('checkbox').click(); await expect(page.getByRole('alert')).toContainText('500');
  await expect(table.locator('tbody input:checked')).toHaveCount(0); await expect(generateReport()).toBeDisabled();
  const lastGroup = state.groups.pop(), lastRow = state.rows.pop(), lastBox = state.boxes.pop();
  await page.getByRole('button', { name: '刷新成品表', exact: true }).click();
  await table.locator('thead').getByRole('checkbox').check(); await expect(table.locator('tbody input:checked')).toHaveCount(500); await expect(generateReport()).toBeEnabled();
  state.groups.push(lastGroup); state.rows.push(lastRow); state.boxes.push(lastBox);
  await page.getByRole('button', { name: '刷新成品表', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(501); await table.locator('tbody').getByRole('checkbox').last().click();
  await expect(page.getByRole('alert')).toContainText('500'); await expect(table.locator('tbody input:checked')).toHaveCount(500); note();
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const suites = [reportChecks, limitChecks];
  for (const check of suites) { const state = fixture(check === limitChecks); const context = await contextFor(state); await check(state); await context.close(); }
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-shipping-table-browser', passed: !failed, checks, browserErrors, unexpectedRequests }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
