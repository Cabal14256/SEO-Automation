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
import { chooseOption, readOptions } from '../shared/ui-controls.mjs';

// Isolated HTTP fixtures: no business database, account file, or external API.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.SHIPPING_INTEGRATION_EVIDENCE_DIR || resolve(root, '.local/t34/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-19T03:00:00.000Z';
const id = () => randomUUID();
const copy = (value) => structuredClone(value);
const checks = [], browserErrors = [], unexpectedRequests = [];
let viteProcess, browser, page, baseURL, failed = false, step = 'setup';
const note = (name) => { checks.push({ name, result: 'passed' }); console.log('PASS ' + name); };

function fixture() {
  const batch = { id: id(), weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', version: 1, sortMode: 'fba', nextPrefix: 0, createdAt: now };
  const secondBatch = { ...batch, id: id(), weekStartDate: '2026-10-19', weekEndDate: '2026-10-25' };
  const demand = (fba, sid = 101, week = batch) => ({ id: id(), snapshot: { sid, fba, shop: sid === 101 ? '技术美国店' : '另一技术店', country: '美国', channel: 'HY', destinationFc: 'ONT8', referenceQuantity: '10', notes: 'TECHNICAL UI FIXTURE', subBatchName: null }, version: 1, businessDate: week.weekStartDate, weekStartDate: week.weekStartDate, weekEndDate: week.weekEndDate, createdAt: now, updatedAt: now });
  const demands = [demand('FBAFLOW001'), demand('FBAFLOW002'), demand('FBAOTHERSTORE', 202), demand('FBAOTHERWEEK', 101, secondBatch), demand('FBAFROZEN'), demand('FBADRAFT')];
  const group = (member, name, status = 'draft') => ({ id: id(), batchId: batch.id, name, version: 1, status, position: 0, demandIds: [member.id], prefix: null, confirmedVersion: null, frozenAt: status === 'frozen' ? now : null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now });
  const frozen = group(demands[4], '已冻结技术批次', 'frozen'), target = group(demands[5], '可追加技术批次');
  const state = { batch, batches: [secondBatch, batch], demands, groups: [frozen, target], frozen, target, queries: [], workspaceQueries: [], createBodies: [], memberBodies: [], operations: new Map(), revisions: new Map(), syncRuns: new Map(), loseAppendOnce: false };
  state.week = (batchId) => {
    const selectedBatch = state.batches.find((item) => item.id === batchId); assert(selectedBatch);
    const groups = state.groups.filter((item) => item.batchId === batchId), assigned = new Set(groups.filter((item) => item.status !== 'superseded').flatMap((item) => item.demandIds));
    return contracts.weeklyBatchDetailSchema.parse({ batch: selectedBatch, groups, ungrouped: demands.filter((item) => item.weekStartDate === selectedBatch.weekStartDate && !assigned.has(item.id)) });
  };
  state.group = (groupId) => {
    const selected = state.groups.find((item) => item.id === groupId); assert(selected);
    const members = demands.filter((item) => selected.demandIds.includes(item.id));
    return contracts.subBatchDetailSchema.parse({ group: selected, members, shipments: members.map((member) => ({ demandId: member.id, revision: null })), issues: [{ code: 'SHIPMENT_NOT_SYNCED', severity: 'error', message: '技术夹具：货件尚未同步。' }], confirmation: null, codes: [], history: [] });
  };
  state.workspace = (raw) => {
    const query = contracts.batchWorkspaceQuerySchema.parse(raw);
    state.workspaceQueries.push(copy(query));
    const rows = state.batches.flatMap((week) => {
      const groups = state.groups.filter((item) => item.batchId === week.id && item.status !== 'superseded');
      return (groups.length ? groups : [null]).map((group) => {
        const members = group ? state.group(group.id).members : state.week(week.id).ungrouped;
        return { id: group?.id ?? week.id, rowKind: group ? 'group' : 'week', batch: week, group, memberCount: members.length, status: group?.status ?? 'empty', sids: [...new Set(members.map((item) => item.snapshot.sid))], shops: [...new Set(members.map((item) => item.snapshot.shop))], countries: ['美国'], channels: ['HY'], fbas: members.map((item) => item.snapshot.fba), sync: { syncedMemberCount: 0, staleMemberCount: 0, latestRun: null }, confirmation: null };
      });
    }).filter((row) => (!query.month || row.batch.weekStartDate.startsWith(query.month)) && (!query.weekFrom || row.batch.weekEndDate >= query.weekFrom) && (!query.weekTo || row.batch.weekStartDate <= query.weekTo) && (!query.q || ((row.group?.name ?? '') + ' ' + row.fbas.join(' ')).toLowerCase().includes(query.q.toLowerCase())));
    return contracts.batchWorkspaceSchema.parse({ rows: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: rows.length, page: query.page, pageSize: query.pageSize, availableWeeks: [], filters: { weeks: state.batches.map(({ id, weekStartDate, weekEndDate }) => ({ id, weekStartDate, weekEndDate })), shops: [{ sid: 101, name: '技术美国店' }, { sid: 202, name: '另一技术店' }], countries: ['美国'], channels: ['HY'] } });
  };
  state.demandRows = (raw) => {
    state.queries.push(copy(raw));
    const rows = demands.flatMap((member, index) => {
      const assigned = state.groups.find((group) => group.status !== 'superseded' && group.demandIds.includes(member.id)), weekly = state.batches.find((week) => week.weekStartDate === member.weekStartDate);
      const base = { id: member.id + ':0', demandId: member.id, rowKind: 'placeholder', demandVersion: member.version, currentDemandVersion: member.version, businessDate: member.businessDate, weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate, ...member.snapshot, destinationAddress: null, msku: null, fnsku: null, sku: null, productName: null, quantity: null, totalBoxes: null, boxes: [], codes: [], status: assigned?.status === 'frozen' ? 'frozen' : 'unsynced', groupId: assigned?.id ?? null, groupName: assigned?.name ?? null, groupVersion: assigned?.version ?? null, batchId: weekly?.id ?? null, confirmationId: null, dataRevisionId: null, dataVersion: null, actualShipDate: null, shipmentCreatedAt: null, sourceFilledAt: null, packingDays: null, metadataSource: 'xlsx', metadataObservedAt: null, issues: [], sources: [] };
      // Two product rows must still count as one complete demand when selected.
      return index === 1 ? [0, 1].map((row) => ({ ...base, id: member.id + ':' + row, rowKind: 'product', sku: 'FLOW-SKU-' + row, msku: 'FLOW-MSKU-' + row, productName: '技术商品 ' + row, quantity: 5 })) : [base];
    }).filter((row) => (!raw.month || row.businessDate.startsWith(raw.month)) && (!raw.weekStartDate || row.weekStartDate === raw.weekStartDate) && (!raw.batchId || row.batchId === raw.batchId) && (!raw.groupId || row.groupId === raw.groupId) && (raw.grouping !== 'ungrouped' || !row.groupId) && (!raw.sid || row.sid === Number(raw.sid)) && (!raw.country || row.country === raw.country) && (!raw.channel || row.channel === raw.channel) && (!raw.q || (row.fba + ' ' + row.shop).includes(raw.q)));
    return contracts.demandWorkspaceSchema.parse({ rows, total: rows.length, demandTotal: new Set(rows.map((row) => row.demandId)).size, page: Number(raw.page || 1), pageSize: Number(raw.pageSize || 20), maxBoxes: 10, filters: { weeks: state.batches.map(({ weekStartDate, weekEndDate }) => ({ weekStartDate, weekEndDate, demandCount: state.demands.filter((member) => member.weekStartDate === weekStartDate).length })), batches: state.batches.map(({ id, weekStartDate, weekEndDate }) => ({ id, weekStartDate, weekEndDate })), shops: [{ sid: 101, name: '技术美国店' }, { sid: 202, name: '另一技术店' }], countries: ['美国'], channels: ['HY'] }, generatedAt: now });
  };
  const importId = id(), runId = id();
  state.catalog = { mode: 'manual', version: 1, catalogVersion: 1, lastSyncedAt: now, lastError: null, configured: true, readOnly: true };
  state.run = { id: runId, importId, status: 'completed', inputVersion: 1, mappingVersion: 'manual-v1', sheetName: '技术需求', parserVersion: 'xlsx-preview-v1', processedRows: 3, counts: { totalRows: 3, validFbaRows: 3, errorRows: 0, warningRows: 0 }, issues: [], errorCode: null, errorMessage: null, createdAt: now, startedAt: now, completedAt: now };
  state.source = contracts.sourceImportSchema.parse({ id: importId, fileId: id(), sourceType: 'xlsx', submissionStatus: 'submitted', submittedSourceRows: 3, originalName: 'technical-flow.xlsx', sha256: '1'.repeat(64), byteSize: 100, createdBy: 'technical-ui', importedAt: now, businessDate: batch.weekStartDate, datePolicyVersion: 'import-date-shanghai-v1', weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, status: 'preview_ready', version: 1, sheets: [], latestRun: state.run });
  state.commit = contracts.importCommitResultSchema.parse({ operationId: id(), importId, previewId: id(), createdAt: now, createdBy: 'technical-ui', items: [demands[0], demands[1], demands[4]].map((member) => ({ itemId: id(), demandId: member.id, version: member.version, action: 'linked', sources: [] })), counts: { created: 0, updated: 0, linked: 3, alreadyCommitted: 0 }, replayed: false });
  return state;
}

async function contextFor(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(method + ' EXTERNAL ' + url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '整合流程技术验证', email: 'flow@acceptance.invalid', role: 'admin' } });
    if (method === 'GET' && path === '/api/v1/demands') return json(state.demandRows(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/batches/workspace') return json(state.workspace(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/weekly-batches') return json(contracts.weeklyBatchListSchema.parse({ items: state.batches, availableWeeks: [] }));
    const weekly = path.match(/^\/api\/v1\/weekly-batches\/([^/]+)$/);
    if (method === 'GET' && weekly) return json(state.week(weekly[1]));
    const create = path.match(/^\/api\/v1\/weekly-batches\/([^/]+)\/sub-batches$/);
    if (method === 'POST' && create) {
      const body = contracts.createSubBatchInputSchema.parse(request.postDataJSON()); state.createBodies.push(copy(body));
      const week = state.batches.find((item) => item.id === create[1]), selected = state.demands.filter((item) => body.demandIds.includes(item.id));
      assert.equal(new Set(body.demandIds).size, body.demandIds.length, 'wire payload deduplicates product rows');
      assert.equal(body.expectedVersion, week.version); assert.equal(selected.length, body.demandIds.length);
      assert(selected.every((item) => item.weekStartDate === week.weekStartDate && item.snapshot.sid === selected[0].snapshot.sid && item.snapshot.country === selected[0].snapshot.country && item.snapshot.channel === selected[0].snapshot.channel));
      selected.forEach((item) => assert.equal(body.expectedDemandVersions[item.id], item.version));
      assert(selected.every((item) => !state.groups.some((group) => group.status !== 'superseded' && group.demandIds.includes(item.id))), 'grouped demands are never silently regrouped');
      let result = state.operations.get(body.operationId);
      if (!result) {
        const group = { id: id(), batchId: week.id, name: body.name, version: 1, status: 'draft', position: state.groups.length, demandIds: body.demandIds, prefix: null, confirmedVersion: null, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now };
        state.groups.push(group); week.version += 1; result = { operationId: body.operationId, groupId: group.id, batchId: week.id, replayed: false }; state.operations.set(body.operationId, result);
      }
      return json(contracts.batchMutationResultSchema.parse(result), 201);
    }
    const members = path.match(/^\/api\/v1\/sub-batches\/([^/]+)\/members$/);
    if (method === 'POST' && members) {
      const body = contracts.updateSubBatchMembersInputSchema.parse(request.postDataJSON()); state.memberBodies.push(copy(body));
      if (state.appendConflictOnce) {
        state.appendConflictOnce = false;
        state.groups.find((item) => item.id === members[1]).version += 1;
        return json({ error: { code: 'VERSION_CONFLICT', message: '技术夹具：批次版本已变化，请重新核对。' } }, 409);
      }
      let result = state.operations.get(body.operationId);
      if (!result) {
        const group = state.groups.find((item) => item.id === members[1]); assert(group && group.status !== 'frozen'); assert.equal(body.expectedVersion, group.version);
        assert(group.demandIds.every((demandId) => body.demandIds.includes(demandId)), 'adding preserves existing members');
        const selected = state.demands.filter((item) => body.demandIds.includes(item.id));
        assert.equal(new Set(body.demandIds).size, body.demandIds.length);
        assert(selected.every((item) => item.weekStartDate === selected[0].weekStartDate && item.snapshot.sid === selected[0].snapshot.sid && item.snapshot.country === selected[0].snapshot.country && item.snapshot.channel === selected[0].snapshot.channel));
        selected.forEach((item) => assert.equal(body.expectedDemandVersions[item.id], item.version));
        group.demandIds = body.demandIds; group.version += 1; state.batch.version += 1;
        result = { operationId: body.operationId, groupId: group.id, batchId: group.batchId, replayed: false }; state.operations.set(body.operationId, result);
      } else result = { ...result, replayed: true };
      if (state.loseAppendOnce) { state.loseAppendOnce = false; return route.abort('connectionfailed'); }
      return json(result);
    }
    const group = path.match(/^\/api\/v1\/sub-batches\/([^/]+)$/);
    if (method === 'GET' && group) return json(state.group(group[1]));
    if (method === 'GET' && /^\/api\/v1\/batch-sync\/[^/]+$/.test(path)) return json({ runs: [] });
    // The unified table reads export eligibility alongside all demand states.
    if (method === 'GET' && path === '/api/v1/batch-reports') return json(contracts.reportResponseSchema.parse({ rows: [], boxes: [], confirmations: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, blocked: [], generatedAt: now }));
    if (method === 'GET' && path === '/api/v1/batch-reports/exports') return json({ items: [] });
    if (method === 'GET' && path === '/api/v1/imports') return json({ items: [state.source], total: 1, page: 1, pageSize: 10 });
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.id) return json({ import: state.source });
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.id + '/runs') return json({ items: [state.run] });
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.id + '/rows') return json({ items: [], total: 0, page: 1, pageSize: 20, parseRunId: state.run.id, previewVersion: 1 });
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.id + '/confirmation') return json({ shops: [], sellers: [], latestPreviewId: null, submittedSourceRows: 3, totalSourceRows: 3, status: 'submitted', baselines: [], catalog: state.catalog });
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.id + '/commits') return json({ items: [state.commit] });
    if (method === 'GET' && path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: state.catalog });
    if (method === 'GET' && path === '/api/v1/seller-mappings') return json({ items: [], total: 0, page: 1, pageSize: 20, settings: state.catalog });
    const demand = path.match(/^\/api\/v1\/demands\/([^/]+)$/);
    if (method === 'GET' && demand) return json(contracts.demandDetailSchema.parse({ demand: state.demands.find((item) => item.id === demand[1]), sources: [], revisions: [] }));
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unhandled isolated fixture API' } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => browserErrors.push(error.message));
  return context;
}

async function integrationChecks(state) {
  step = 'one-shipment-row-expands-all-products-and-box-details';
  await page.goto('/shipping?view=demands');
  await expect(page.getByRole('form', { name: '筛选发货工作台', exact: true })).toBeVisible();
  const table = () => page.getByRole('region', { name: '发货明细表，可横向滚动', exact: true });
  const nav = () => page.getByRole('navigation', { name: '需求与批次导航', exact: true });
  await expect(table()).toBeVisible();
  await expect(table().locator('tr.shipping-shipment-heading')).toHaveCount(6);
  const products = table().locator('tr.shipping-shipment-heading').filter({ hasText: 'FBAFLOW002' });
  // The former nested-detail-region assertion is superseded by the same products
  // expanding directly in the single table; keep both collapse and expand checks.
  await expect(table()).toContainText('FLOW-SKU-0'); await expect(table()).toContainText('FLOW-SKU-1');
  await products.getByRole('button', { name: /收起明细/ }).click();
  await expect(table()).not.toContainText('FLOW-SKU-0'); await expect(table()).not.toContainText('FLOW-SKU-1');
  await products.getByRole('button', { name: /商品与逐箱明细/ }).click();
  await expect(table().locator('tr.demand-row').filter({ hasText: 'FLOW-SKU-' })).toHaveCount(2);
  await expect(table()).toContainText('FLOW-SKU-0'); await expect(table()).toContainText('FLOW-SKU-1');
  note(step);

  step = 'batch-navigation-filters-membership-and-preserves-frozen-state';
  await nav().getByRole('button', { name: /已冻结技术批次/ }).click();
  await expect(page.getByRole('heading', { name: state.frozen.name, exact: true })).toBeVisible();
  await expect(table().locator('tr.shipping-shipment-heading')).toHaveCount(1);
  await expect(table()).toContainText('FBAFROZEN');
  assert(state.queries.some((query) => query.groupId === state.frozen.id));
  await expect(page.getByText('已冻结，保留原确认数据；调整请发起更正。', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '选择货件 FBAFROZEN', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建发货批次', exact: true })).toHaveCount(0);
  note(step);

  step = 'ungrouped-scope-is-independent-of-data-processing-state';
  await nav().getByRole('button', { name: '待分组需求', exact: true }).click();
  await expect(page.getByRole('heading', { name: '待分组需求', exact: true })).toBeVisible();
  await expect(table().locator('tr.shipping-shipment-heading')).toHaveCount(4);
  await expect(table()).not.toContainText('FBAFROZEN'); await expect(table()).not.toContainText('FBADRAFT');
  assert(state.queries.some((query) => query.grouping === 'ungrouped'));
  note(step);

  step = 'common-week-and-shop-filters-apply-to-both-navigation-and-demand-pool';
  const form = page.getByRole('form', { name: '筛选发货工作台', exact: true });
  await chooseOption(form.getByLabel('需求周范围', { exact: true }), state.batches[0].weekStartDate);
  await chooseOption(form.getByLabel('店铺', { exact: true }), '101');
  await form.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(table().locator('tr.shipping-shipment-heading')).toHaveCount(1);
  await expect(table()).toContainText('FBAOTHERWEEK');
  assert.equal(state.queries.at(-1).weekStartDate, state.batches[0].weekStartDate);
  assert.equal(state.queries.at(-1).sid, '101');
  await expect.poll(() => state.workspaceQueries.at(-1).weekFrom).toBe(state.batches[0].weekStartDate);
  assert.equal(state.workspaceQueries.at(-1).sid, 101);
  await form.getByRole('button', { name: '重置', exact: true }).click();
  await expect(table().locator('tr.shipping-shipment-heading')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: '待分组需求', exact: true })).toBeVisible();
  note(step);

  step = 'integrated-workspace-responsive-layout';
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(nav()).toBeVisible(); await expect(table()).toBeVisible();
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert(layout.document <= layout.viewport + 1, 'wide detail tables must not overflow the page');
    await page.screenshot({ path: resolve(evidence, 'workspace-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); note(step);
}

async function batchSidebarSearchChecks(state) {
  step = 'batch-sidebar-search-is-independent-and-resets-pagination';
  for (let index = 1; index <= 19; index++) {
    const member = { ...copy(state.demands[5]), id: id(), snapshot: { ...copy(state.demands[5].snapshot), fba: index === 19 ? 'FBASIDEBARLAST' : 'FBASIDEBAR' + String(index).padStart(2, '0') } };
    const group = { ...copy(state.target), id: id(), position: state.groups.length, name: index === 19 ? '跨页可检索技术批次' : '分页技术批次 ' + String(index).padStart(2, '0'), demandIds: [member.id] };
    state.demands.push(member); state.groups.push(group);
  }
  await page.addInitScript(({ batchId, groupId }) => {
    sessionStorage.setItem('scm-batch-process:technical-ui:current', JSON.stringify({ batchId, groupId, open: false }));
  }, { batchId: state.batch.id, groupId: state.frozen.id });
  await page.goto('/shipping?view=demands');
  const nav = () => page.getByRole('navigation', { name: '需求与批次导航', exact: true });
  const items = () => nav().locator('.shipping-batch-item');
  const search = () => nav().getByRole('search', { name: '搜索发货批次', exact: true });
  const keyword = () => search().getByLabel('批次名称 / FBA', { exact: true });
  const demands = page.getByRole('form', { name: '筛选发货工作台', exact: true });
  const table = page.getByRole('region', { name: '发货明细表，可横向滚动', exact: true });
  await nav().getByRole('button', { name: /已冻结技术批次/ }).click();
  await expect(page.getByRole('heading', { name: state.frozen.name, exact: true })).toBeVisible();
  await demands.getByLabel('搜索', { exact: true }).fill('FBAFROZEN');
  await demands.getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.queries.at(-1)?.q).toBe('FBAFROZEN');
  await expect(table).toContainText('FBAFROZEN');
  await demands.getByLabel('搜索', { exact: true }).fill('需求搜索未提交草稿');
  const demandReads = state.queries.length;
  await expect(items()).toHaveCount(19);
  await nav().getByRole('button', { name: '下一页批次', exact: true }).click();
  await expect.poll(() => state.workspaceQueries.at(-1)?.page).toBe(2);
  await expect(items()).toHaveCount(2);
  await expect(items().last()).toContainText('跨页可检索技术批次');
  const sidebarReads = state.workspaceQueries.length;
  await keyword().fill('  跨页可检索技术批次  ');
  assert.equal(state.workspaceQueries.length, sidebarReads, 'sidebar draft does not issue an unapplied query');
  await keyword().press('Enter');
  await expect.poll(() => state.workspaceQueries.at(-1)?.q).toBe('跨页可检索技术批次');
  assert.equal(state.workspaceQueries.at(-1).page, 1, 'new sidebar search returns to page one');
  await expect(items()).toHaveCount(1); await expect(items().first()).toContainText('跨页可检索技术批次');
  await expect(nav().getByRole('button', { name: /已冻结技术批次/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: state.frozen.name, exact: true })).toBeVisible();
  await expect(demands.getByLabel('搜索', { exact: true })).toHaveValue('需求搜索未提交草稿');
  assert.equal(state.queries.length, demandReads, 'sidebar search and pagination never reread demand rows');
  assert.equal(state.queries.at(-1).groupId, state.frozen.id); assert.equal(state.queries.at(-1).q, 'FBAFROZEN');
  await expect(page.getByRole('button', { name: /继续上次/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续处理批次', exact: true })).toHaveCount(1);
  note(step);

  step = 'batch-sidebar-fba-search-case-insensitive-and-responsive';
  await keyword().fill('fbasidebarlast'); await keyword().press('Enter');
  await expect.poll(() => state.workspaceQueries.at(-1)?.q).toBe('fbasidebarlast');
  await expect(items()).toHaveCount(1); await expect(items().first()).toContainText('跨页可检索技术批次');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(search()).toBeVisible(); await expect(keyword()).toBeVisible();
    await expect(page.getByRole('heading', { name: state.frozen.name, exact: true })).toBeVisible();
    assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= width + 1, 'batch sidebar search fits the viewport');
    await page.screenshot({ path: resolve(evidence, 'batch-sidebar-search-' + width + '.png'), fullPage: true });
  }
  await search().getByRole('button', { name: '清空批次搜索', exact: true }).click();
  await expect(keyword()).toHaveValue('');
  await expect.poll(() => state.workspaceQueries.at(-1)?.q).toBeUndefined();
  assert.equal(state.workspaceQueries.at(-1).page, 1);
  await expect(items()).toHaveCount(19); await expect(nav().getByRole('button', { name: /已冻结技术批次/ })).toHaveAttribute('aria-current', 'page');
  await expect(nav().getByRole('button', { name: '上一页批次', exact: true })).toBeDisabled();
  await expect(nav().getByRole('button', { name: '下一页批次', exact: true })).toBeEnabled();
  await expect(demands.getByLabel('搜索', { exact: true })).toHaveValue('需求搜索未提交草稿');
  assert.equal(state.queries.length, demandReads, 'clearing only restores the sidebar list');
  assert.equal(state.queries.at(-1).groupId, state.frozen.id); assert.equal(state.queries.at(-1).q, 'FBAFROZEN');
  await page.setViewportSize({ width: 1440, height: 1000 }); note(step);
}

const assignment = () => page.getByRole('dialog', { name: '安排发货批次', exact: true });
const wizard = () => page.getByRole('dialog', { name: '建立发货批次', exact: true });
const processDialog = () => page.getByRole('dialog', { name: '发货批次处理向导', exact: true });
async function selectDemands(fbas) {
  await page.goto('/shipping?view=demands');
  for (const fba of fbas) await page.getByRole('checkbox', { name: '选择货件 ' + fba, exact: true }).check();
  await expect(page.getByLabel('需求分组操作', { exact: true })).toContainText('已选 ' + fbas.length + ' 票');
}

async function createChecks(state) {
  step = 'multi-product-demands-are-selected-once-and-carried-to-create-wizard';
  await selectDemands(['FBAFLOW001', 'FBAFLOW002']);
  await expect(page.getByRole('checkbox', { name: '选择货件 FBAFLOW002', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '新建发货批次', exact: true }).click();
  await expect(assignment()).toBeVisible();
  await expect(assignment()).toContainText('带入 2 票需求');
  await assignment().getByRole('button', { name: '继续建立批次', exact: true }).click();
  await expect(wizard()).toBeVisible();
  await wizard().getByRole('button', { name: '下一步：选择需求', exact: true }).click();
  await expect(wizard().getByRole('checkbox', { name: '选择 FBAFLOW001', exact: true })).toBeChecked();
  await expect(wizard().getByRole('checkbox', { name: '选择 FBAFLOW002', exact: true })).toBeChecked();
  await expect(wizard().getByRole('checkbox', { name: '选择 FBAOTHERSTORE', exact: true })).toBeDisabled();
  await expect(wizard()).toContainText('已选 2 票'); note(step);

  step = 'create-posts-exact-current-members-and-opens-processing';
  await wizard().getByRole('button', { name: '下一步：核对与建立', exact: true }).click();
  await wizard().getByLabel('发货批次名称', { exact: true }).fill('整合流程技术新批次');
  await wizard().getByRole('checkbox', { name: '已核对所选需求的店铺、国家和渠道，确认建立此发货批次。', exact: true }).check();
  await wizard().getByRole('button', { name: '确认建立发货批次', exact: true }).click();
  await expect(wizard()).toContainText('需求分组已建立');
  assert.equal(state.createBodies.length, 1); assert.deepEqual(new Set(state.createBodies[0].demandIds), new Set(state.demands.slice(0, 2).map((demand) => demand.id)));
  await wizard().getByRole('button', { name: '继续同步与核对', exact: true }).click();
  await expect(processDialog()).toBeVisible();
  await expect(processDialog().getByRole('heading', { name: '同步与商品', exact: true })).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('scm-demand-assignment:technical-ui:current')), null);
  await page.reload(); await expect(processDialog()).toBeVisible(); await expect(assignment()).not.toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1); note(step);
}

async function scopeChecks(state) {
  step = 'mixed-weeks-and-shops-require-an-explicit-compatible-partition';
  await selectDemands(['FBAFLOW001', 'FBAFLOW002', 'FBAOTHERSTORE', 'FBAOTHERWEEK']);
  await page.getByRole('button', { name: '新建发货批次', exact: true }).click();
  await expect(assignment().getByRole('radio')).toHaveCount(3);
  await expect(assignment().getByRole('button', { name: '继续建立批次', exact: true })).toHaveCount(0);
  await assignment().locator('label').filter({ hasText: 'FBAFLOW001、FBAFLOW002' }).getByRole('radio').check();
  await expect(assignment()).toContainText('带入 2 票需求');
  assert.equal(state.createBodies.length, 0); note(step);
}

async function appendChecks(state) {
  step = 'append-retains-current-members-excludes-frozen-groups-and-replays-lost-response';
  await selectDemands(['FBAFLOW001', 'FBAFLOW002']);
  await page.getByRole('button', { name: '加入已有批次', exact: true }).click();
  await expect(assignment()).toBeVisible();
  const target = assignment().getByLabel('目标发货批次', { exact: true });
  assert.deepEqual((await readOptions(target)).filter(Boolean), [state.target.id]);
  await chooseOption(target, state.target.id);
  const confirmation = assignment().getByRole('checkbox', { name: '已核对完整成员与批次范围，确认追加所选需求。', exact: true });
  await expect(confirmation).toBeEnabled(); await confirmation.check(); state.loseAppendOnce = true;
  await assignment().getByRole('button', { name: '确认加入批次', exact: true }).click();
  await expect(assignment().getByRole('button', { name: '重试原加入请求', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(assignment()).toBeVisible();
  await page.reload(); await expect(assignment()).toBeVisible();
  await assignment().getByRole('button', { name: '重试原加入请求', exact: true }).click();
  await expect(assignment().getByRole('heading', { name: '需求已加入发货批次', exact: true })).toBeVisible();
  assert.equal(state.memberBodies.length, 2); assert.deepEqual(state.memberBodies[0], state.memberBodies[1]);
  assert.deepEqual(new Set(state.target.demandIds), new Set([state.demands[0].id, state.demands[1].id, state.demands[5].id]));
  assert.equal(state.target.version, 2); await assignment().getByRole('button', { name: '继续同步与核对', exact: true }).click();
  await expect(processDialog()).toBeVisible(); await expect(page.locator('dialog[open]')).toHaveCount(1); note(step);
}

async function appendConflictChecks(state) {
  step = 'known-version-conflict-requires-human-review-with-a-new-operation';
  await selectDemands(['FBAFLOW001']);
  await page.getByRole('button', { name: '加入已有批次', exact: true }).click();
  await chooseOption(assignment().getByLabel('目标发货批次', { exact: true }), state.target.id);
  const confirmation = assignment().getByRole('checkbox', { name: '已核对完整成员与批次范围，确认追加所选需求。', exact: true });
  await confirmation.check(); state.appendConflictOnce = true;
  const submit = assignment().getByRole('button', { name: '确认加入批次', exact: true });
  await submit.click();
  await expect(assignment()).toContainText('批次或需求可能已变化，请刷新范围并重新核对。');
  await expect(confirmation).not.toBeChecked(); await expect(submit).toBeDisabled();
  assert.equal(state.target.demandIds.length, 1);
  await expect(confirmation).toBeEnabled(); await confirmation.check(); await submit.click();
  await expect(assignment().getByRole('heading', { name: '需求已加入发货批次', exact: true })).toBeVisible();
  assert.equal(state.memberBodies.length, 2);
  assert.notEqual(state.memberBodies[0].operationId, state.memberBodies[1].operationId);
  assert.equal(state.memberBodies[1].expectedVersion, state.memberBodies[0].expectedVersion + 1);
  note(step);
}

async function importHandoffChecks(state) {
  step = 'import-success-handoff-preserves-existing-membership-and-deduplicates-results';
  state.commit.items.push({ ...state.commit.items[0], itemId: id() });
  state.commit.counts.linked += 1;
  await page.goto('/imports/new?importId=' + state.source.id + '&step=5');
  const imported = page.getByRole('dialog', { name: '导入向导', exact: true });
  await expect(imported.getByRole('navigation', { name: '导入步骤', exact: true }).locator('[aria-current="step"]')).toContainText('导入结果');
  await imported.getByRole('button', { name: '新建发货批次', exact: true }).click();
  await expect(imported).not.toBeVisible(); await expect(assignment()).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(assignment()).toContainText('已有批次的需求 · 1 票');
  await expect(assignment()).toContainText('FBAFROZEN · 已冻结技术批次 · 已冻结');
  await expect(assignment()).toContainText('带入 2 票需求');
  await expect(assignment().getByRole('radio')).toHaveCount(1);
  assert.equal(state.createBodies.length, 0); assert.equal(state.memberBodies.length, 0); note(step);
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  baseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const selectedChecks = process.env.SHIPPING_INTEGRATION_CHECK_SCOPE === 'append' ? [appendChecks, appendConflictChecks] : process.env.SHIPPING_INTEGRATION_CHECK_SCOPE === 'import' ? [importHandoffChecks] : process.env.SHIPPING_INTEGRATION_CHECK_SCOPE === 'scope' ? [scopeChecks] : process.env.SHIPPING_INTEGRATION_CHECK_SCOPE === 'sidebar' ? [batchSidebarSearchChecks] : [integrationChecks, batchSidebarSearchChecks, createChecks, scopeChecks, appendChecks, appendConflictChecks, importHandoffChecks];
  for (const check of selectedChecks) {
    const state = fixture(), context = await contextFor(state); await check(state); await context.close();
  }
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-demand-batch-integration-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
