import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import * as c from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';
import { closeGridDetails, closeGridMenu, selectGridRow, showShippingFilters } from '../shared/grid.mjs';

// All business requests are isolated fixtures. No database or external system is contacted.
const root = resolve(import.meta.dirname, '../..'), evidence = resolve(root, '.local/t41/shipping-lifecycle');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const at = '2026-10-27T02:00:00.000Z', uid = () => randomUUID();
const run = { id: uid(), version: 1, status: 'draft', stage: 'sync', numberingDate: '2026-10-27', month: '2026-10', sequence: 1, origin: 'manual', importId: null, parseRunId: null, membershipFrozenAt: at, error: null, createdAt: at, updatedAt: at, lifecycle: 'active' };
const batch = { id: uid(), shippingRunId: run.id, version: 1, sortMode: 'fba', nextPrefix: 1, createdAt: at, weekStartDate: '2026-10-26', weekEndDate: '2026-11-01' };
const demandId = uid();
const group = { id: uid(), batchId: batch.id, name: '生命周期测试批次', version: 1, status: 'frozen', position: 0, demandIds: [demandId], prefix: 'A', confirmedVersion: 1, frozenAt: at, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: at, updatedAt: at, lifecycle: 'active' };
const demand = { id: demandId + ':placeholder', demandId, rowKind: 'placeholder', demandVersion: 1, currentDemandVersion: 1, businessDate: '2026-10-26', weekStartDate: '2026-10-26', weekEndDate: '2026-11-01', shippingRunId: run.id, shippingMonth: run.month, shippingSequence: 1, ticketNumber: '20261027-1-US-1', sid: 101, shop: '虚构生命周期店', country: 'US', channel: 'HY', destinationFc: 'TEST1', destinationAddress: null, fba: 'FBA-LIFECYCLE', msku: null, fnsku: null, sku: null, productName: null, quantity: null, referenceQuantity: null, totalBoxes: null, boxes: [], codes: [], status: 'frozen', groupId: group.id, groupName: group.name, groupVersion: 1, batchId: batch.id, confirmationId: null, dataRevisionId: null, dataVersion: null, actualShipDate: null, shipmentCreatedAt: null, sourceFilledAt: null, packingDays: null, metadataSource: null, metadataObservedAt: null, notes: null, issues: [], sources: [], lifecycle: 'active' };
const occurrence = { id: run.id, month: run.month, sequence: 1, numberingDate: run.numberingDate };
const choices = { shippingRuns: [occurrence], weeks: [], batches: [], shops: [{ sid: 101, name: '虚构生命周期店' }], countries: ['US'], channels: ['HY'] };
const entities = { run, group, demand: { id: demandId, version: 1, lifecycle: 'active', name: demand.fba } };
const names = { run: '2026-10 第 1 次发货', group: group.name, demand: demand.fba };
const labels = { run: '发货记录', group: '批次', demand: '需求' };
const methods = { run: 'shipping-runs', group: 'sub-batches', demand: 'demands' };
const mutations = [], operations = new Map(), deleted = new Set(), previous = new Map(), checks = [], errors = [], unexpected = [];
let browser, vite, page, failure = false, loseResponse = false, rejectNext = false, restoreConflict = false, acceptPending = false, pendingEntry, holdLifecycle = false, releaseLifecycle;
const note = (name) => { checks.push(name); console.log('PASS ' + name); };
const visible = (entity, lifecycle = 'active') => !deleted.has(entity.id) && entity.lifecycle !== 'trashed' && (lifecycle === 'all' || entity.lifecycle === lifecycle);
const actionLabel = (type, action) => ({ cancel: type === 'run' ? '取消本次发货' : `取消${labels[type]}`, trash: `删除${labels[type]}`, restore: `恢复${labels[type]}`, purge: `彻底删除${labels[type]}` })[action];
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  const baseURL = 'http://127.0.0.1:' + port;
  vite = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpected.push('EXTERNAL ' + url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    try {
      if (path === '/api/v1/session') return json({ user: { id: 'lifecycle-browser', name: '生命周期验收', email: 'lifecycle@acceptance.invalid', role: 'admin' } });
      const lifecycleMatch = path.match(/^\/api\/v1\/(shipping-runs|sub-batches|demands)\/([^/]+)\/(lifecycle-impact|lifecycle\/(cancel|trash|restore|purge))$/);
      if (lifecycleMatch) {
        const type = Object.keys(methods).find((key) => methods[key] === lifecycleMatch[1]), entity = entities[type];
        assert.equal(entity.id, lifecycleMatch[2]);
        const action = method === 'GET' ? url.searchParams.get('action') : lifecycleMatch[4];
        if (method === 'GET') return json(c.shippingLifecycleImpactSchema.parse({ type, id: entity.id, name: names[type], version: entity.version, lifecycle: entity.lifecycle, action, impactToken: 'a'.repeat(64), members: [{ id: demandId, fba: demand.fba }], affectedRuns: [{ id: run.id, name: names.run }], groups: [{ id: group.id, name: group.name }], documents: [{ id: uid(), title: '原已发布测试发票' }], workflowCount: 2, conflicts: action === 'restore' && restoreConflict ? [{ code: 'MEMBER_OCCUPIED', message: '该 FBA 已安排到其他批次，请先处理占用。', fba: demand.fba }] : [], canExecute: !(action === 'restore' && restoreConflict), blockingReasons: [], ...(action === 'restore' ? { willRestoreTo: previous.get(entity.id) ?? 'active' } : {}) }));
        const input = c.shippingLifecycleInputSchema.parse(request.postDataJSON()); mutations.push({ type, action, input });
        if (holdLifecycle) { holdLifecycle = false; await new Promise((done) => { releaseLifecycle = done; }); }
        if (acceptPending && !operations.has(input.operationId)) { acceptPending = false; entity.lifecyclePending = true; pendingEntry = { type, input: structuredClone(input) }; const result = c.shippingLifecycleResultSchema.parse({ type, id: entity.id, version: entity.version, lifecycle: entity.lifecycle, pending: true, purged: false, replayed: false }); operations.set(input.operationId, result); return json(result, 202); }
        if (rejectNext) { rejectNext = false; entity.version++; return json({ error: { code: 'IMPACT_CHANGED', message: '影响范围已变化，请重新核对。' } }, 409); }
        let result = operations.get(input.operationId);
        if (!result) {
          assert.equal(input.expectedVersion, entity.version);
          previous.set(entity.id, action === 'trash' ? entity.lifecycle : previous.get(entity.id) ?? 'active');
          if (action === 'cancel') entity.lifecycle = 'cancelled';
          if (action === 'trash') entity.lifecycle = 'trashed';
          if (action === 'restore') entity.lifecycle = previous.get(entity.id) ?? 'active';
          if (action === 'purge') deleted.add(entity.id);
          entity.version++;
          result = c.shippingLifecycleResultSchema.parse({ type, id: entity.id, version: entity.version, lifecycle: entity.lifecycle, pending: false, purged: action === 'purge', replayed: false }); operations.set(input.operationId, result);
        } else result = { ...result, replayed: true };
        if (loseResponse) { loseResponse = false; return route.abort('failed'); }
        return json(result);
      }
      if (path === '/api/v1/shipping-runs') return json({ items: visible(run, url.searchParams.get('lifecycle') ?? 'active') ? [run] : [] });
      if (path === '/api/v1/shipping-recycle-bin') {
        const type = url.searchParams.get('type'), entity = entities[type];
        const items = entity.lifecycle === 'trashed' && !deleted.has(entity.id) && (!url.searchParams.get('q') || names[type].includes(url.searchParams.get('q'))) ? [{ type, id: entity.id, name: names[type], version: entity.version, lifecycle: 'trashed', changedAt: at, changedBy: 'lifecycle-browser', reason: '测试删除原因', pending: false, memberCount: 1, canPurge: true, purgeBlockingReasons: [] }] : [];
        return json(c.shippingRecycleListSchema.parse({ items, total: items.length, page: 1, pageSize: 20 }));
      }
      if (path === '/api/v1/demands') {
        const rows = visible(entities.demand, url.searchParams.get('lifecycle') ?? 'active') ? [{ ...demand, lifecycle: entities.demand.lifecycle, demandVersion: entities.demand.version, currentDemandVersion: entities.demand.version, ...(!visible(group) || !visible(run) || entities.demand.lifecycle !== 'active' ? { groupId: null, groupName: null, batchId: null, shippingRunId: null, shippingMonth: null, shippingSequence: null, ticketNumber: null, status: 'unsynced' } : {}) }] : [];
        return json(c.demandWorkspaceSchema.parse({ rows, total: rows.length, demandTotal: rows.length, page: 1, pageSize: 20, maxBoxes: 10, filters: choices, generatedAt: at }));
      }
      if (path === '/api/v1/batches/workspace') {
        const rows = visible(group, url.searchParams.get('lifecycle') ?? 'active') ? [{ id: group.id, rowKind: 'group', batch, group, shippingRuns: [occurrence], memberCount: 1, status: 'frozen', sids: [101], shops: ['虚构生命周期店'], countries: ['US'], channels: ['HY'], fbas: [demand.fba], sync: { syncedMemberCount: 0, staleMemberCount: 0, latestRun: null }, confirmation: null }] : [];
        return json(c.batchWorkspaceSchema.parse({ rows, total: rows.length, page: 1, pageSize: 20, availableWeeks: [], filters: choices }));
      }
      if (path === '/api/v1/batch-reports') return json(c.reportResponseSchema.parse({ rows: [], boxes: [], confirmations: [], total: 0, page: 1, pageSize: 50, maxBoxes: 10, blocked: [], generatedAt: at }));
      if (path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
      if (path === '/api/v1/processing-batches') return json({ items: [batch], availableWeeks: [] });
      if (path === '/api/v1/sub-batches/' + group.id) return json({ group, shippingRunIds: [run.id], members: [], shipments: [], issues: [], confirmation: null, codes: [], history: [] });
      unexpected.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE', message: 'Unexpected fixture API' } }, 500);
    } catch (error) { errors.push(error.stack); return json({ error: { code: 'FIXTURE_ERROR', message: error.message } }, 500); }
  });
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message)); page.setDefaultTimeout(12000);
  await page.goto('/shipping');
  await expect(page.locator('form[aria-label="筛选发货工作台"]')).toHaveAttribute('hidden', '');
  const runsWindow = () => page.getByRole('dialog', { name: '本次发货与票号', exact: true });
  const batchPicker = () => page.getByRole('button', { name: '发货批次', exact: true });
  const closeRuns = async () => { if (await runsWindow().isVisible()) { await runsWindow().getByRole('button', { name: '关闭本次发货与票号', exact: true }).click(); await expect(runsWindow()).not.toBeVisible(); } };
  const closeBatches = async () => { if (await batchPicker().getAttribute('aria-expanded') === 'true') await batchPicker().click(); };
  const prepare = async (type, details = true) => {
    await closeGridMenu(page, '发货明细表');
    if (type !== 'demand' || !details) await closeGridDetails(page, '发货明细表');
    if (type !== 'run') await closeRuns();
    if (type !== 'group') await closeBatches();
    if (type === 'run' && !await runsWindow().isVisible()) await page.getByRole('button', { name: '本次发货与票号', exact: true }).click();
    if (type === 'group' && await batchPicker().getAttribute('aria-expanded') !== 'true') await batchPicker().click();
    if (type === 'demand' && details) await selectGridRow(page, '发货明细表', 0);
  };
  const openRecycle = async () => { await prepare('run'); await runsWindow().getByRole('button', { name: '回收站', exact: true }).click(); return page.getByRole('dialog', { name: '发货回收站', exact: true }); };
  const assertReleasedDemand = async () => { await prepare('demand'); await expect(page.getByRole('button', { name: '安排批次', exact: true }).first()).toBeVisible(); };
  const dialog = (type, action) => page.getByRole('dialog', { name: actionLabel(type, action), exact: true });
  const demandMenu = () => page.getByRole('menu', { name: '发货明细表 行操作', exact: true });
  const launch = async (type, action) => {
    const recycle = page.getByRole('dialog', { name: '发货回收站', exact: true });
    if (!await recycle.isVisible() && type === 'demand') {
      await prepare(type, false);
      const table = page.locator('[data-grid-label="发货明细表"]');
      await expect(table.getByRole('grid')).toHaveAttribute('aria-busy', 'false');
      await table.getByRole('spinbutton', { name: '发货明细表 定位行', exact: true }).fill('1');
      await table.getByRole('button', { name: '发货明细表 查看当前记录', exact: true }).click();
      await expect(demandMenu()).toContainText(demand.fba);
      await demandMenu().getByRole('menuitem', { name: actionLabel(type, action), exact: true }).click();
      await expect(demandMenu()).not.toBeVisible();
    } else {
      if (!await recycle.isVisible()) await prepare(type);
      const source = await recycle.isVisible() ? recycle : type === 'run' ? runsWindow() : page;
      await source.getByRole('button', { name: actionLabel(type, action), exact: true }).first().click();
    }
    await expect(dialog(type, action).getByLabel(`${({ cancel: '取消', trash: '删除', restore: '恢复', purge: '彻底删除' })[action]}原因`, { exact: true })).toBeVisible();
    return dialog(type, action);
  };
  const confirm = async (type, action, scope = dialog(type, action)) => { await scope.getByRole('textbox').fill('生命周期操作验收原因'); await scope.getByRole('checkbox').check(); await scope.getByRole('button', { name: '确认' + actionLabel(type, action), exact: true }).click(); };
  const filter = async (type, value) => { await prepare(type, false); if (type === 'demand') await showShippingFilters(page); const label = { run: '发货记录状态', group: '批次记录状态', demand: '需求记录状态' }[type]; await chooseOption(page.getByLabel(label, { exact: true }), value); if (type === 'demand') await page.getByRole('form', { name: '筛选发货工作台', exact: true }).getByRole('button', { name: '筛选', exact: true }).click(); };

  for (const type of ['run', 'group', 'demand']) {
    let scope = await launch(type, 'cancel'); await expect(scope.getByRole('button', { name: '确认' + actionLabel(type, 'cancel'), exact: true })).toBeDisabled(); await expect(scope).toContainText('原已发布测试发票');
    await confirm(type, 'cancel'); await expect(scope).not.toBeVisible(); assert.equal(entities[type].lifecycle, 'cancelled');
    if (type !== 'demand') { assert.equal(entities.demand.lifecycle, 'active'); await assertReleasedDemand(); }
    await filter(type, 'cancelled'); scope = await launch(type, 'restore'); await confirm(type, 'restore'); await expect(scope).not.toBeVisible(); assert.equal(entities[type].lifecycle, 'active'); await filter(type, 'active');
    note(type + ': frozen cancellation and recoverable cancellation');

    scope = await launch(type, 'trash'); await confirm(type, 'trash'); await expect(scope).not.toBeVisible(); assert.equal(entities[type].lifecycle, 'trashed');
    const recycle = await openRecycle(); await recycle.getByRole('button', { name: labels[type], exact: true }).click(); await expect(recycle).toContainText(names[type]);
    if (type === 'demand') {
      restoreConflict = true; scope = await launch(type, 'restore'); await expect(scope.getByRole('alert')).toContainText('已安排到其他批次'); await expect(scope.getByRole('button', { name: '确认恢复需求', exact: true })).toBeDisabled(); await scope.getByRole('button', { name: '返回', exact: true }).click(); restoreConflict = false; note('restore conflict blocks execution');
    }
    scope = await launch(type, 'restore'); await confirm(type, 'restore'); await expect(scope).not.toBeVisible(); await recycle.getByRole('button', { name: '关闭发货回收站', exact: true }).click(); await expect(recycle).not.toBeVisible(); assert.equal(entities[type].lifecycle, 'active'); note(type + ': trash and recycle-bin restoration');
  }

  let scope = await launch('group', 'cancel'); holdLifecycle = true; await confirm('group', 'cancel');
  await expect(scope.getByRole('textbox')).toBeDisabled(); await expect.poll(() => typeof releaseLifecycle).toBe('function');
  const pendingGroupRequest = structuredClone(mutations.at(-1)); await page.keyboard.press('Escape');
  await expect(scope).toBeVisible(); await expect(batchPicker()).toHaveAttribute('aria-expanded', 'true'); await expect(scope.getByRole('textbox')).toBeDisabled();
  releaseLifecycle(); await expect(scope).not.toBeVisible(); assert.equal(entities.group.lifecycle, 'cancelled');
  assert.deepEqual(mutations.filter((entry) => entry.input.operationId === pendingGroupRequest.input.operationId), [pendingGroupRequest]);
  await filter('group', 'cancelled'); scope = await launch('group', 'restore'); await confirm('group', 'restore'); await expect(scope).not.toBeVisible(); await filter('group', 'active'); note('Escape cannot dismiss protected pending operation or its batch picker');

  scope = await launch('demand', 'cancel'); holdLifecycle = true; releaseLifecycle = undefined; await confirm('demand', 'cancel');
  await expect(scope.getByRole('textbox')).toBeDisabled(); await expect.poll(() => typeof releaseLifecycle).toBe('function');
  const pendingDemandRequest = structuredClone(mutations.at(-1)); await page.keyboard.press('Escape');
  await expect(scope).toBeVisible(); await expect(demandMenu()).not.toBeVisible(); await expect(scope.getByRole('textbox')).toBeDisabled();
  releaseLifecycle(); await expect(scope).not.toBeVisible(); assert.equal(entities.demand.lifecycle, 'cancelled');
  assert.deepEqual(mutations.filter((entry) => entry.input.operationId === pendingDemandRequest.input.operationId), [pendingDemandRequest]);
  await filter('demand', 'cancelled'); scope = await launch('demand', 'restore'); await confirm('demand', 'restore'); await expect(scope).not.toBeVisible(); await filter('demand', 'active');
  note('demand row-menu lifecycle dialog survives menu closure and pending Escape with original operation');

  scope = await launch('run', 'cancel'); acceptPending = true; await confirm('run', 'cancel'); await expect(scope).not.toBeVisible(); await expect(page.getByRole('button', { name: '取消本次发货', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: '待核对操作（1）', exact: true })).toBeVisible(); await page.reload(); await prepare('run'); await expect(page.getByRole('button', { name: '取消本次发货', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: '待核对操作（1）', exact: true })).toBeVisible();
  await closeRuns(); // Recovery polling continues while the task list is closed.
  run.lifecycle = 'cancelled'; run.lifecyclePending = false; run.version++; operations.set(pendingEntry.input.operationId, { ...operations.get(pendingEntry.input.operationId), lifecycle: 'cancelled', version: run.version, pending: false });
  await expect(page.getByRole('button', { name: '待核对操作（1）', exact: true })).toHaveCount(0, { timeout: 12000 }); await assertReleasedDemand(); for (const entry of mutations.filter((entry) => entry.input.operationId === pendingEntry.input.operationId)) assert.deepEqual(entry.input, pendingEntry.input); await filter('run', 'cancelled'); scope = await launch('run', 'restore'); await confirm('run', 'restore'); await expect(scope).not.toBeVisible(); await filter('run', 'active'); note('accepted pending operation polls across reload and refreshes released FBA automatically');

  scope = await launch('demand', 'cancel'); rejectNext = true; await confirm('demand', 'cancel'); await expect(scope.getByRole('alert')).toContainText('影响范围已变化'); await expect(scope.getByRole('textbox')).toHaveValue('生命周期操作验收原因'); await scope.getByRole('button', { name: '重新核对影响范围', exact: true }).click(); await expect(scope.getByRole('checkbox')).not.toBeChecked(); await scope.getByRole('button', { name: '返回', exact: true }).click(); note('known conflict preserves reason and requires renewed impact confirmation');
  scope = await launch('demand', 'cancel'); loseResponse = true; await confirm('demand', 'cancel'); await expect(scope.getByRole('button', { name: '重试原请求', exact: true })).toBeVisible(); const original = structuredClone(mutations.at(-1)); await page.reload();
  if (!await page.getByRole('button', { name: '待核对操作（1）', exact: true }).isVisible()) await prepare('run'); await page.getByRole('button', { name: '待核对操作（1）', exact: true }).click(); await page.getByRole('button', { name: '核对原请求结果', exact: true }).click(); await page.getByRole('dialog', { name: '取消需求', exact: true }).getByRole('button', { name: '重试原请求', exact: true }).click(); await expect(page.getByRole('dialog', { name: '取消需求', exact: true })).not.toBeVisible(); assert.deepEqual(mutations.at(-1), original); if (await page.getByRole('button', { name: '关闭待核对发货操作', exact: true }).count()) await page.getByRole('button', { name: '关闭待核对发货操作', exact: true }).click(); await filter('demand', 'cancelled'); scope = await launch('demand', 'restore'); await confirm('demand', 'restore'); await expect(scope).not.toBeVisible(); await filter('demand', 'active'); note('lost response survives page reload and replays exact original payload');

  scope = await launch('demand', 'trash');
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); await expect(scope).toHaveCSS('opacity', '1'); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: resolve(evidence, `impact-${width}.png`), fullPage: true }); }
  await confirm('demand', 'trash'); await expect(scope).not.toBeVisible(); const recycle = await openRecycle(); await recycle.getByRole('button', { name: '需求', exact: true }).click(); scope = await launch('demand', 'purge'); await expect(scope).toContainText('彻底删除后不能恢复'); await confirm('demand', 'purge'); await expect(scope).not.toBeVisible(); await expect(recycle).toContainText('回收站暂无需求'); assert(deleted.has(demandId)); note('permanent deletion confirmation and recycle-bin refresh');
  await recycle.getByRole('button', { name: '关闭发货回收站', exact: true }).click(); await expect(recycle).not.toBeVisible();
  for (const type of ['run', 'group']) { scope = await launch(type, 'trash'); await confirm(type, 'trash'); await expect(scope).not.toBeVisible(); await openRecycle(); await recycle.getByRole('button', { name: labels[type], exact: true }).click(); scope = await launch(type, 'purge'); await confirm(type, 'purge'); await expect(scope).not.toBeVisible(); await expect(recycle).toContainText(`回收站暂无${labels[type]}`); assert(deleted.has(entities[type].id)); await recycle.getByRole('button', { name: '关闭发货回收站', exact: true }).click(); await expect(recycle).not.toBeVisible(); note(type + ': permanent deletion'); }
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
} catch (error) { failure = true; errors.push(error.stack); console.error(error); await page?.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); if (vite && vite.exitCode === null) vite.kill(); await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ passed: !failure, checks, errors, unexpected, mutations }, null, 2) + '\n'); }
if (failure) process.exitCode = 1;
