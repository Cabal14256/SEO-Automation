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
import { chooseOption } from '../shared/ui-controls.mjs';

// t38 supersedes the dual-view workbench. Preserve every historical assertion
// behind an explicit flag, while this familiar command verifies the current UI.
if (!process.argv.includes('--legacy-dual-view')) {
  console.log('INFO dual-view workbench superseded; running scripts/t38/shipping-unified-table-browser.mjs');
  await import('../t38/shipping-unified-table-browser.mjs');
} else {

// Every API call is intercepted. This check never reads a database, account file,
// real shipment, or remote service, and refuses any request outside its Vite origin.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.SHIPPING_WORKBENCH_EVIDENCE_DIR || resolve(root, '.local/t37/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-20T03:00:00.000Z';
const id = () => randomUUID();
const copy = (value) => structuredClone(value);
const checks = [], unexpectedRequests = [], browserErrors = [];
let browser, viteProcess, page, baseURL, step = 'setup', failed = false;
const note = () => { checks.push({ name: step, result: 'passed' }); console.log('PASS ' + step); };

function fixture() {
  const batch = { id: id(), weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', version: 1, sortMode: 'fba', nextPrefix: 2, createdAt: now };
  const demand = (index) => ({ id: id(), snapshot: { sid: 101, fba: `FBA-SHARED-${index}`, shop: '技术美国店', country: '美国', channel: 'HY', destinationFc: 'ONT8', referenceQuantity: '10', notes: 'ISOLATED WORKBENCH FIXTURE', subBatchName: null }, version: 1, businessDate: '2026-10-13', weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, createdAt: now, updatedAt: now });
  const demands = Array.from({ length: 4 }, (_, index) => demand(index));
  const group = (member, name, status) => ({ id: id(), batchId: batch.id, name, version: 1, status, position: 0, demandIds: [member.id], prefix: status === 'confirmed' ? 'AB' : null, confirmedVersion: status === 'confirmed' ? 1 : null, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now });
  const groups = [group(demands[0], '美国已确认批次', 'confirmed'), group(demands[1], '美国第二批次', 'confirmed'), group(demands[3], '候选待核对批次', 'draft')];
  const references = groups.slice(0, 2).map((item) => ({ groupId: item.id, groupVersion: item.version, confirmationId: id() }));
  const state = { batch, demands, groups, references, queries: [], batchQueries: [], reportQueries: [], exportBodies: [], mutations: [], exports: [], exportFailure: null };
  const choices = { weeks: [{ weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, demandCount: demands.length }], batches: [batch], shops: [{ sid: 101, name: '技术美国店' }, { sid: 202, name: '技术欧洲店' }], countries: ['美国', '德国'], channels: ['HY', 'OTHER'] };
  const matches = (row, raw) => (!raw.month || row.businessDate.startsWith(raw.month)) && (!raw.weekStartDate || row.weekStartDate === raw.weekStartDate) && (!raw.sid || row.sid === Number(raw.sid)) && (!raw.country || row.country === raw.country) && (!raw.channel || row.channel === raw.channel) && (!raw.q || [row.fba, row.groupName, row.shop, row.productName, row.sku].some((value) => value?.toLowerCase().includes(raw.q.trim().toLowerCase())));
  state.demandRows = (raw) => {
    state.queries.push(copy(raw));
    let rows = demands.flatMap((member, index) => {
      const assigned = groups.find((item) => item.demandIds.includes(member.id));
      return Array.from({ length: index === 0 || index === 2 ? 2 : 1 }, (_, product) => ({
        id: `${member.id}:${product}`, demandId: member.id, rowKind: 'product', demandVersion: 1, currentDemandVersion: 1, businessDate: member.businessDate, weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate,
        ...member.snapshot, destinationAddress: null, msku: `MSKU-${index}-${product}`, fnsku: `FNSKU-${index}-${product}`, sku: `SKU-${index}-${product}`, productName: `完整商品 ${index}-${product}`, quantity: 5,
        totalBoxes: index < 2 ? 1 : null, boxes: [], codes: index < 2 ? [`AB-${index + 1}`] : [], status: index < 2 ? 'confirmed' : 'candidate',
        groupId: assigned?.id ?? null, groupName: assigned?.name ?? null, groupVersion: assigned?.version ?? null, batchId: batch.id, confirmationId: references.find((ref) => ref.groupId === assigned?.id)?.confirmationId ?? null,
        dataRevisionId: null, dataVersion: 1, actualShipDate: null, shipmentCreatedAt: null, sourceFilledAt: null, packingDays: null, metadataSource: 'xlsx', metadataObservedAt: null, issues: [], sources: [],
      }));
    }).filter((row) => matches(row, raw) && (!raw.groupId || row.groupId === raw.groupId) && (raw.grouping !== 'ungrouped' || !row.groupId) && (!raw.status || row.status === raw.status));
    return contracts.demandWorkspaceSchema.parse({ rows, total: rows.length, demandTotal: new Set(rows.map((row) => row.demandId)).size, page: Number(raw.page || 1), pageSize: 20, maxBoxes: 10, filters: choices, generatedAt: now });
  };
  state.group = (groupId) => {
    const selected = groups.find((item) => item.id === groupId); assert(selected);
    const members = demands.filter((item) => selected.demandIds.includes(item.id));
    return contracts.subBatchDetailSchema.parse({ group: selected, members, shipments: members.map((member) => ({ demandId: member.id, revision: null })), issues: [], confirmation: null, codes: [], history: [] });
  };
  state.workspace = (raw) => {
    state.batchQueries.push(copy(raw));
    const rows = groups.filter((item) => !raw.q || (item.name + state.group(item.id).members.map((member) => member.snapshot.fba).join(' ')).includes(raw.q)).map((item) => ({
      id: item.id, rowKind: 'group', batch, group: item, memberCount: 1, status: item.status, sids: [101], shops: ['技术美国店'], countries: ['美国'], channels: ['HY'], fbas: state.group(item.id).members.map((member) => member.snapshot.fba),
      sync: { syncedMemberCount: 1, staleMemberCount: 0, latestRun: null }, confirmation: references.some((ref) => ref.groupId === item.id) ? { id: references.find((ref) => ref.groupId === item.id).confirmationId, groupVersion: 1, createdAt: now, current: true } : null,
    }));
    return contracts.batchWorkspaceSchema.parse({ rows, total: rows.length, page: 1, pageSize: 20, availableWeeks: [], filters: { ...choices, weeks: [batch] } });
  };
  state.reportRows = references.flatMap((ref, index) => Array.from({ length: index === 0 ? 2 : 1 }, (_, product) => ({
    id: `${ref.groupId}:${product}`, groupId: ref.groupId, groupName: groups[index].name, confirmationId: ref.confirmationId, weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, businessDate: demands[index].businessDate,
    ...demands[index].snapshot, msku: `MSKU-${index}-${product}`, fnsku: `FNSKU-${index}-${product}`, sku: `SKU-${index}-${product}`, productName: `完整商品 ${index}-${product}`, quantity: 5,
    boxes: [], codes: [`AB-${index + 1}`], groupQuantity: index === 0 ? 10 : 5, monthQuantity: index === 0 ? 10 : 5, status: 'confirmed', actualShipDate: null, sourceObservedAt: now, dataRevisionId: id(),
  })));
  state.boxes = references.map((ref, index) => ({
    groupId: ref.groupId, groupName: groups[index].name, confirmationId: ref.confirmationId, demandId: demands[index].id, fba: demands[index].snapshot.fba, sid: 101,
    boxId: id(), boxOrder: 1, code: `AB-${index + 1}`, boxName: '技术箱', boxExternalId: null, localBoxId: null, weight: 1, weightUnit: 'KG', length: 1, width: 2, height: 3, lengthUnit: 'CM',
    items: state.reportRows.filter((row) => row.groupId === ref.groupId).map(({ msku, fnsku, sku, quantity }) => ({ msku, fnsku, sku, quantity })),
  }));
  for (const row of state.reportRows) row.boxes = [{ boxId: state.boxes.find((box) => box.groupId === row.groupId).boxId, boxOrder: 1, code: row.codes[0], quantity: row.quantity }];
  state.report = (raw) => {
    state.reportQueries.push(copy(raw));
    let rows = state.reportRows.filter((row) => matches(row, raw) && (!raw.subBatchId || row.groupId === raw.subBatchId) && (!raw.weeklyBatchId || raw.weeklyBatchId === batch.id) && (!raw.region || raw.region === 'all' || raw.region === 'US'));
    // Search determines the matching groups, while every product of those groups remains visible.
    if (raw.q) { const included = new Set(rows.map((row) => row.groupId)); rows = state.reportRows.filter((row) => included.has(row.groupId)); }
    const included = new Set(rows.map((row) => row.groupId));
    return contracts.reportResponseSchema.parse({ rows, boxes: state.boxes.filter((box) => included.has(box.groupId)), confirmations: references.filter((ref) => included.has(ref.groupId)), total: rows.length, page: Number(raw.page || 1), pageSize: 50, maxBoxes: included.size ? 1 : 0,
      blocked: raw.subBatchId && raw.subBatchId !== groups[2].id ? [] : [{ groupId: groups[2].id, name: groups[2].name, code: 'NOT_CONFIRMED', message: '候选数据尚未取得有效确认和内部编码' }], generatedAt: now });
  };
  return state;
}

async function contextFor(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(`${method} EXTERNAL ${url.origin}`); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) state.mutations.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'technical-workbench', name: '发货工作台技术验证', email: 'workbench@acceptance.invalid', role: 'admin' } });
    if (method === 'GET' && path === '/api/v1/demands') return json(state.demandRows(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/batches/workspace') return json(state.workspace(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/batch-reports') return json(state.report(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/batch-reports/exports') return json({ items: state.exports });
    if (method === 'GET' && path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
    const group = path.match(/^\/api\/v1\/sub-batches\/([^/]+)$/);
    if (method === 'GET' && group) return json(state.group(group[1]));
    if (method === 'GET' && path.startsWith('/api/v1/files/')) return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'isolated-workbench-download-fixture' });
    if (method === 'POST' && path === '/api/v1/batch-reports/exports') {
      const body = contracts.reportExportInputSchema.parse(request.postDataJSON()); state.exportBodies.push(copy(body));
      if (state.exportFailure) { const error = state.exportFailure; state.exportFailure = null; return json({ error: { code: error, message: '技术夹具导出失败' } }, error === 'QUEUE_UNAVAILABLE' ? 503 : 409); }
      const record = contracts.reportExportRecordSchema.parse({ id: id(), status: 'completed', groupIds: body.groupIds, references: body.expectedConfirmations, month: body.month || null, region: body.region, fileId: id(), error: null, createdAt: now, completedAt: now, rowCount: 2, boxCount: 1, valid: true, invalidReason: null });
      state.exports.push(record); return json({ export: record, replayed: false }, 202);
    }
    unexpectedRequests.push(`${method} ${path}`); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unhandled isolated fixture API' } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => browserErrors.push(error.message)); return context;
}

const form = () => page.getByRole('form', { name: '筛选发货工作台', exact: true });
const nav = () => page.getByRole('navigation', { name: '需求与批次导航', exact: true });
const modes = () => page.getByRole('navigation', { name: '发货工作台视图', exact: true });
const demandTable = () => page.getByRole('region', { name: '需求商品与逐箱明细表，可横向滚动', exact: true });
const reportTable = () => page.getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true });
const generate = () => page.getByRole('button', { name: '生成发货表 XLSX', exact: true });
const switchMode = async (name) => { await modes().getByRole('button', { name, exact: true }).click(); await expect(modes().getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page'); };
const reset = async () => { await form().getByRole('button', { name: '重置', exact: true }).click(); };
const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page body must fit its viewport; wide tables scroll internally');

async function navigationAndSelection(state) {
  step = 'unified-sidebar-legacy-routes-and-keyboard-mode-navigation';
  await page.goto('/shipping?view=demands'); await expect(demandTable()).toContainText('FBA-SHARED-2');
  const submenu = page.getByRole('navigation', { name: '发货管理子导航', exact: true });
  await expect(submenu.getByRole('link')).toHaveCount(3);
  await expect(submenu.getByRole('link', { name: '发货工作台', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(submenu).not.toContainText('发货成品表');
  await modes().getByRole('button', { name: '需求处理', exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(modes().getByRole('button', { name: '发货成品', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(reportTable()).toContainText('完整商品 0-1'); await expect(submenu.getByRole('link', { name: '发货工作台', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goto('/batch-reports'); await expect(page).toHaveURL(/\/shipping\?view=reports/); await expect(reportTable()).toBeVisible();
  await page.goto('/shipping?view=reports'); await expect(reportTable()).toBeVisible(); note();

  step = 'demand-selection-counts-shipments-and-report-selection-counts-whole-groups';
  await switchMode('需求处理');
  const ungrouped = demandTable().getByRole('checkbox', { name: '选择货件 FBA-SHARED-2', exact: true });
  await ungrouped.focus(); await page.keyboard.press('Space'); await expect(ungrouped).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: /^已选 1 票$/ })).toBeVisible();
  await switchMode('发货成品'); await expect(generate()).toBeDisabled();
  const ready = reportTable().getByRole('checkbox', { name: `选择子批次 ${state.groups[0].name}`, exact: true });
  await ready.first().focus(); await page.keyboard.press('Space'); await expect(ready).toHaveCount(2);
  await expect(reportTable().locator('tbody input:checked')).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: '已选 1 个子批次' })).toBeVisible();
  await expect(reportTable()).not.toContainText('FBA-SHARED-3'); await expect(reportTable()).not.toContainText('FBA-SHARED-2');
  await expect(page.getByText('另有 1 个子批次未满足成品表条件', { exact: true })).toBeVisible();
  await switchMode('需求处理'); await expect(ungrouped).not.toBeChecked(); await expect(page.getByRole('status').filter({ hasText: /^已选 0 票$/ })).toBeVisible();
  await switchMode('发货成品'); await expect(reportTable().locator('tbody input:checked')).toHaveCount(2); note();

  step = 'batch-navigation-and-current-group-survive-view-switch';
  await nav().getByRole('button', { name: new RegExp(state.groups[0].name) }).click();
  await expect.poll(() => state.reportQueries.at(-1)?.subBatchId).toBe(state.groups[0].id);
  await expect(nav().getByRole('button', { name: new RegExp(state.groups[0].name) })).toHaveAttribute('aria-current', 'page');
  await switchMode('需求处理'); await expect.poll(() => state.queries.at(-1)?.groupId).toBe(state.groups[0].id);
  await expect(demandTable()).toContainText('FBA-SHARED-0'); await expect(demandTable()).not.toContainText('FBA-SHARED-1');
  await switchMode('发货成品'); await expect(reportTable()).toContainText('完整商品 0-1'); await expect(reportTable()).not.toContainText('FBA-SHARED-1');
  await expect(page).toHaveURL(new RegExp(`groupId=${state.groups[0].id}`));
  await nav().getByRole('button', { name: '全部批次', exact: true }).click(); note();
}

async function sharedFilters(state) {
  step = 'shared-month-week-shop-country-channel-search-and-mode-specific-filters';
  await switchMode('需求处理');
  await form().getByLabel('业务月份', { exact: true }).fill('2026-10');
  await chooseOption(form().getByLabel('需求周范围', { exact: true }), state.batch.weekStartDate);
  await chooseOption(form().getByLabel('店铺', { exact: true }), '101');
  await chooseOption(form().getByLabel('国家', { exact: true }), '美国');
  await chooseOption(form().getByLabel('业务渠道', { exact: true }), 'HY');
  await chooseOption(form().getByLabel('数据处理状态', { exact: true }), 'candidate');
  await form().getByLabel('搜索', { exact: true }).fill('  FBA-SHARED  '); await form().getByRole('button', { name: '筛选', exact: true }).click();
  const common = { month: '2026-10', weekStartDate: state.batch.weekStartDate, sid: '101', country: '美国', channel: 'HY', q: 'FBA-SHARED' };
  await expect.poll(() => state.queries.at(-1)?.status).toBe('candidate');
  for (const [key, value] of Object.entries(common)) assert.equal(state.queries.at(-1)[key], value);
  assert(!('region' in state.queries.at(-1)), 'demand API has no report region');
  assert.equal(state.batchQueries.at(-1).weekFrom, state.batch.weekStartDate); assert.equal(state.batchQueries.at(-1).sid, '101');
  await switchMode('发货成品'); await expect(reportTable()).toBeVisible();
  await expect(form().getByLabel('数据处理状态', { exact: true })).toHaveCount(0);
  await expect(form().getByLabel('业务月份', { exact: true })).toHaveValue(common.month);
  for (const [key, value] of Object.entries(common)) assert.equal(state.reportQueries.at(-1)[key], value);
  assert(!('status' in state.reportQueries.at(-1)), 'candidate status must never filter the confirmed report');
  await chooseOption(form().getByLabel('国家 / 区域', { exact: true }), 'US'); await form().getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.reportQueries.at(-1)?.region).toBe('US');
  await switchMode('需求处理'); await expect(form().getByLabel('国家 / 区域', { exact: true })).toHaveCount(0);
  await expect(form().getByLabel('数据处理状态', { exact: true })).toBeVisible();
  assert.equal(state.queries.at(-1).status, 'candidate');
  await expect(demandTable()).toContainText('FBA-SHARED-2'); await expect(demandTable()).not.toContainText('FBA-SHARED-0');
  await switchMode('发货成品'); await expect.poll(() => state.reportQueries.at(-1)?.region).toBe('US');
  await reset(); await expect(reportTable()).toContainText('完整商品 0-1'); note();
}

async function exportAndLayout(state) {
  step = 'report-export-binds-whole-group-confirmation-retry-and-historical-download';
  const first = reportTable().getByRole('checkbox', { name: `选择子批次 ${state.groups[0].name}`, exact: true }).first();
  await first.check(); state.exportFailure = 'QUEUE_UNAVAILABLE'; await generate().click();
  await expect(page.getByRole('alert')).toContainText('任务队列暂不可用'); await expect(first).toBeChecked();
  const snapshot = copy(state.exportBodies.at(-1)); await generate().click(); await expect.poll(() => state.exports.length).toBe(1);
  assert.deepEqual(state.exportBodies.at(-1), snapshot); assert.deepEqual(snapshot.groupIds, [state.groups[0].id]); assert.deepEqual(snapshot.expectedConfirmations, [state.references[0]]);
  await page.getByRole('button', { name: '发货表导出记录', exact: true }).click();
  const history = page.getByRole('dialog', { name: '导出记录', exact: true }); await expect(history).toContainText(state.references[0].confirmationId);
  const download = page.waitForEvent('download'); await history.getByRole('button', { name: '下载 XLSX', exact: true }).click(); assert((await download).suggestedFilename().endsWith('.xlsx'));
  await page.keyboard.press('Escape'); state.exportFailure = 'VERSION_CONFLICT'; await generate().click();
  await expect(first).not.toBeChecked(); await expect(generate()).toBeDisabled(); note();

  step = 'desktop-mobile-keyboard-scroll-and-no-page-overflow';
  // Capture the ordinary workbench, without the deliberately induced conflict feedback.
  await page.reload(); await expect(reportTable()).toContainText('完整商品 0-1');
  await reportTable().focus(); await expect(reportTable()).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect.poll(() => reportTable().evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await reportTable().evaluate((element) => { element.scrollLeft = 0; });
  await page.getByRole('heading', { name: '全部批次成品', exact: true }).click(); await noOverflow();
  await page.screenshot({ path: resolve(evidence, 'workbench-reports-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow();
  await page.screenshot({ path: resolve(evidence, 'workbench-reports-390.png'), fullPage: true });
  await switchMode('需求处理'); await expect(demandTable()).toBeVisible();
  await demandTable().getByRole('row').filter({ hasText: 'FBA-SHARED-2' }).getByRole('button', { name: '商品与逐箱明细', exact: true }).click();
  const detail = page.getByRole('region', { name: 'FBA-SHARED-2 商品与逐箱明细，可横向滚动', exact: true }); await expect(detail).toContainText('SKU-2-1');
  await demandTable().evaluate((element) => { element.scrollLeft = 0; });
  await detail.evaluate((element) => { element.scrollLeft = 0; });
  await page.getByRole('heading', { name: '全部需求', exact: true }).click();
  await noOverflow(); await page.screenshot({ path: resolve(evidence, 'workbench-demands-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await demandTable().evaluate((element) => { element.scrollLeft = 0; });
  await detail.evaluate((element) => { element.scrollLeft = 0; });
  await page.getByRole('heading', { name: '全部需求', exact: true }).click(); await noOverflow();
  await page.screenshot({ path: resolve(evidence, 'workbench-demands-1440.png'), fullPage: true }); note();
}

async function dialogHistory(state) {
  step = 'demand-dialog-hides-on-report-history-and-restores-on-demand-history';
  const before = copy(state.mutations);
  await expect(modes().getByRole('button', { name: '发货成品', exact: true })).toHaveAttribute('aria-current', 'page');
  await switchMode('需求处理');
  await page.getByRole('button', { name: '导入记录', exact: true }).click();
  const records = page.getByRole('dialog', { name: '导入记录', exact: true });
  await expect(records).toContainText('尚无导入记录。');
  await page.goBack(); await expect(modes().getByRole('button', { name: '发货成品', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(reportTable()).toBeVisible();
  await page.goForward(); await expect(records).toContainText('尚无导入记录。');
  await expect(modes().getByRole('button', { name: '需求处理', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape'); await expect(records).not.toBeVisible();
  await switchMode('发货成品'); assert.deepEqual(state.mutations, before, 'view/history changes must not write business data'); note();
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const state = fixture(), context = await contextFor(state);
  await navigationAndSelection(state); await sharedFilters(state); await dialogHistory(state); await exportAndLayout(state); await context.close();
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-shipping-workbench-browser', passed: !failed, checks, browserErrors, unexpectedRequests }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
}
