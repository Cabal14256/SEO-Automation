import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { batchWorkspaceSchema, demandWorkspaceSchema, reportResponseSchema } from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';

// Isolated HTTP fixtures: no database, shared worker, or external API is used.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.MONTHLY_WORKSPACE_EVIDENCE_DIR || resolve(root, '.local/t40/monthly-workspace'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const at = '2026-10-24T02:00:00.000Z';
const id = () => randomUUID();
const occurrence = { id: id(), month: '2026-10', sequence: 3, numberingDate: '2026-10-24' };
const batch = { id: id(), shippingRunId: occurrence.id, ...occurrence, version: 1, sortMode: 'fba', nextPrefix: 0, createdAt: at, weekStartDate: '2026-10-19', weekEndDate: '2026-10-25' };
batch.id = id();
const group = { id: id(), batchId: batch.id, name: '十月第三次跨期需求', version: 1, status: 'draft', position: 0, demandIds: [], prefix: null, confirmedVersion: null, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: at, updatedAt: at };
const rows = ['2026-08-04', '2026-09-29', '2026-07-02'].map((businessDate, index) => {
  const assigned = index < 2;
  const demandId = id();
  if (assigned) group.demandIds.push(demandId);
  return { id: demandId + ':placeholder', demandId, rowKind: 'placeholder', demandVersion: 1, currentDemandVersion: 1, businessDate, weekStartDate: '2026-06-29', weekEndDate: '2026-07-05',
    shippingRunId: assigned ? occurrence.id : null, shippingMonth: assigned ? occurrence.month : null, shippingSequence: assigned ? 3 : null, ticketNumber: assigned ? '20261024-3-US-1' : null,
    sid: 101, shop: '虚构验收店', country: 'US', channel: 'HY', destinationFc: 'TEST1', destinationAddress: null, fba: 'FBAMONTH' + (index + 1),
    msku: null, fnsku: null, sku: null, productName: null, quantity: null, referenceQuantity: null, totalBoxes: null, boxes: [], codes: [], status: 'unsynced',
    groupId: assigned ? group.id : null, groupName: assigned ? group.name : null, groupVersion: assigned ? 1 : null, batchId: assigned ? batch.id : null, confirmationId: null, dataRevisionId: null, dataVersion: null,
    actualShipDate: null, shipmentCreatedAt: null, sourceFilledAt: null, packingDays: null, metadataSource: null, metadataObservedAt: null, notes: null, issues: [], sources: [] };
});
const choices = { shippingRuns: [occurrence], weeks: [], batches: [], shops: [{ sid: 101, name: '虚构验收店' }], countries: ['US'], channels: ['HY'] };
const workspaceRow = { id: group.id, rowKind: 'group', batch, group, shippingRuns: [occurrence], memberCount: 2, status: 'draft', sids: [101], shops: ['虚构验收店'], countries: ['US'], channels: ['HY'], fbas: rows.slice(0, 2).map((row) => row.fba), sync: { syncedMemberCount: 0, staleMemberCount: 0, latestRun: null }, confirmation: null };
const queries = [], batchQueries = [], errors = [], unexpected = [], checks = [];
let browser, viteProcess, page, failed = false;
const pass = (name) => { checks.push({ name, result: 'passed' }); console.log('PASS ' + name); };

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  const baseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpected.push('EXTERNAL ' + url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { unexpected.push(request.method() + ' ' + path); return json({ error: { message: 'Unexpected mutation' } }, 500); }
    if (path === '/api/v1/session') return json({ user: { id: 'technical-monthly', name: '月次验收', email: 'monthly@acceptance.invalid', role: 'admin' } });
    if (path === '/api/v1/shipping-runs') return json({ items: [] });
    if (path === '/api/v1/demands') {
      const query = Object.fromEntries(url.searchParams); queries.push(query);
      const visible = rows.filter((row) => (query.grouping === 'ungrouped' ? !row.groupId : (!query.month || row.shippingMonth === query.month) && (!query.shippingRunId || row.shippingRunId === query.shippingRunId)) && (!query.groupId || row.groupId === query.groupId));
      return json(demandWorkspaceSchema.parse({ rows: visible, total: visible.length, demandTotal: visible.length, page: 1, pageSize: 20, maxBoxes: 10, filters: choices, generatedAt: at }));
    }
    if (path === '/api/v1/batches/workspace') {
      const query = Object.fromEntries(url.searchParams); batchQueries.push(query);
      const visible = (!query.month || query.month === occurrence.month) && (!query.shippingRunId || query.shippingRunId === occurrence.id) ? [workspaceRow] : [];
      return json(batchWorkspaceSchema.parse({ rows: visible, total: visible.length, page: 1, pageSize: 20, availableWeeks: [], filters: choices }));
    }
    if (path === '/api/v1/batch-reports') return json(reportResponseSchema.parse({ rows: [], boxes: [], confirmations: [], total: 0, page: 1, pageSize: 50, maxBoxes: 10, blocked: [], generatedAt: at }));
    if (path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
    if (path === '/api/v1/processing-batches') return json({ items: [batch], availableWeeks: [] });
    if (path === '/api/v1/sub-batches/' + group.id) return json({ group, shippingRunIds: [occurrence.id], members: [], shipments: [], issues: [], confirmation: null, codes: [], history: [] });
    unexpected.push(request.method() + ' ' + path); return json({ error: { message: 'Unknown isolated fixture API' } }, 500);
  });
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); page.setDefaultTimeout(12000);
  await page.goto('/shipping?view=demands');
  const form = page.getByRole('form', { name: '筛选发货工作台', exact: true });
  const table = page.getByRole('region', { name: '发货明细表，可横向滚动', exact: true });
  const nav = page.getByRole('navigation', { name: '需求与批次导航', exact: true });
  await expect(form.getByLabel('发货月份', { exact: true })).toBeVisible(); await expect(form.getByLabel('发货次', { exact: true })).toBeVisible();
  await expect(table.locator('tr.shipping-shipment-heading')).toHaveCount(3);
  await expect(nav).toContainText('2026-10 第 3 次');
  await expect(page.getByText(/周范围|周批次|归属周|开始周|结束周/)).toHaveCount(0);
  pass('monthly-occurrence-labels-replace-week-controls');
  await chooseOption(form.getByLabel('发货次', { exact: true }), occurrence.id); await form.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(table.locator('tr.shipping-shipment-heading')).toHaveCount(2);
  await expect(table).toContainText('2026-08-04'); await expect(table).toContainText('2026-09-29');
  await expect.poll(() => queries.at(-1)?.shippingRunId).toBe(occurrence.id); await expect.poll(() => batchQueries.at(-1)?.shippingRunId).toBe(occurrence.id);
  assert(!queries.some((query) => query.weekStartDate)); assert(!batchQueries.some((query) => query.weekFrom || query.weekTo));
  pass('occurrence-filter-includes-cross-month-imports-without-week-parameters');
  await nav.getByRole('button', { name: '待分组需求', exact: true }).click();
  await expect(table.locator('tr.shipping-shipment-heading')).toHaveCount(1); await expect(table).toContainText('FBAMONTH3');
  pass('unarranged-pool-independent-of-selected-occurrence');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(form.getByLabel('发货次', { exact: true })).toBeVisible();
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })); assert(layout.document <= layout.viewport + 1);
    await page.screenshot({ path: resolve(evidence, 'workspace-' + width + '.png'), fullPage: true });
  }
  pass('desktop-and-mobile-no-page-overflow');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/batches');
  const batchForm = page.getByRole('form', { name: '筛选发货批次', exact: true });
  await expect(batchForm.getByLabel('发货次', { exact: true })).toBeVisible(); await expect(page.getByRole('table')).toContainText('2026-10 第 3 次');
  await expect(page.getByText(/周范围|周批次|归属周|开始周|结束周/)).toHaveCount(0);
  await page.screenshot({ path: resolve(evidence, 'batch-list.png'), fullPage: true }); pass('batch-list-shows-occurrence-instead-of-date-range');
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
} catch (error) {
  failed = true; checks.push({ name: 'browser', result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: !failed, checks, errors, unexpected, externalRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
