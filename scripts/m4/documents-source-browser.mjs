import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentCandidateListSchema, documentAutomationStartInputSchema, shippingRunListSchema } from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';

// Isolated UI fixtures only: no database, credentials, real candidate service,
// document creation, or external network requests are used by this suite.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.DOCUMENT_SOURCE_EVIDENCE_DIR || resolve(root, '.local/m4/source-selection'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-24T03:00:00.000Z';
const uid = () => randomUUID();
const checks = [], browserErrors = [], unexpectedRequests = [], externalRequests = [], heldReleases = [], fixtureWriteRequests = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup';
const note = (name) => { checks.push({ name, passed: true }); console.log('PASS ' + name); };

function makeRun(sequence) {
  return { id: uid(), version: 1, status: 'ready', stage: 'ready', numberingDate: '2026-10-23', month: '2026-10', sequence,
    importId: null, parseRunId: null, origin: 'manual', membershipFrozenAt: now, error: null, createdAt: now, updatedAt: now };
}
function makeCandidate(run, index, values = {}) {
  const demandId = uid(), groupId = uid(), boxId = uid(), shipmentId = uid();
  const snapshot = { sid: 101, fba: 'FBASOURCE00' + index, shop: 'North Shop', country: '美国', channel: 'SEA_A', destinationFc: 'LAX9',
    destinationAddress: '1 Technical Road, Test City, CA 90001 US', referenceQuantity: null, notes: null, subBatchName: null, ...values };
  const item = { msku: 'MSKU-' + index, fnsku: 'FNSKU-' + index, sku: 'SKU-' + index, name: 'Technical product', quantity: '10', expiration: null, prepOwner: null, labelOwner: null };
  return { shippingRunId: run.id, shippingRunMonth: run.month, shippingRunSequence: run.sequence,
    demandId, weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', groupId, groupName: index === 1 ? 'Pacific Batch' : index === 2 ? 'Harbor Batch' : 'Berlin Batch',
    groupVersion: 1, groupStatus: 'confirmed', m2ConfirmationId: uid(), demandVersion: 1,
    demand: { id: demandId, snapshot, version: 1, businessDate: '2026-10-23', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', createdAt: now, updatedAt: now },
    shipment: { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: snapshot.sid, fba: snapshot.fba, items: [item],
      boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, items: [item] }], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'Technical fixture', createdBy: 'fixture', createdAt: now },
    codes: [{ id: uid(), groupId, demandId, boxId, prefix: 'A', sequence: index, code: 'A' + index, valid: true, createdAt: now }],
    physicalConfirmationId: null, m3Version: null, sourceFingerprint: null, physical: null, blockers: [] };
}
function fixture() {
  const runs = [makeRun(1), makeRun(2)];
  const first = [makeCandidate(runs[0], 1), makeCandidate(runs[0], 2), makeCandidate(runs[0], 3, {
    sid: 202, shop: 'Berlin Shop', country: '德国', channel: 'AIR_DE', destinationFc: 'BER3', destinationAddress: '3 Technical Strasse, Berlin DE',
  })];
  const second = [makeCandidate(runs[1], 4, { shop: 'Second Run Shop', destinationFc: 'ONT8' })];
  const byRun = new Map([[runs[0].id, first], [runs[1].id, second]]);
  shippingRunListSchema.parse({ items: runs });
  for (const [shippingRunId, items] of byRun) documentCandidateListSchema.parse({ items, total: items.length, shippingRunId });
  return { runs, first, second, byRun, candidateMode: 'ready', holdRuns: false, releaseRuns: null, holdCandidates: false, releaseCandidates: null,
    allowStart: false, releaseStart: null, candidateCalls: [], startInputs: [], writes: [] };
}

async function setup(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseURL) { externalRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (method !== 'GET') {
      state.writes.push(method + ' ' + path);
      if (method === 'POST' && path === '/api/v1/documents/automations' && state.allowStart) {
        const input = documentAutomationStartInputSchema.parse(request.postDataJSON());
        state.startInputs.push(input); fixtureWriteRequests.push({ method, path, input });
        await new Promise((release) => { state.releaseStart = release; heldReleases.push(release); });
        return json({ error: { code: 'FIXTURE_STOP', message: '技术夹具已记录自动任务范围，未创建实际单据。' } }, 503);
      }
      unexpectedRequests.push(method + ' ' + path);
      return json({ error: { code: 'UNEXPECTED_WRITE', message: 'Selection and prefill must not start documents before the explicit action.' } }, 500);
    }
    if (path === '/api/v1/session') return json({ user: { id: 'document-source-fixture', name: 'Document source UI check', email: 'documents@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/documents/automations' && method === 'GET') return json({ items: [] });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (path === '/api/v1/documents') return json({ items: [], total: 0, page: 1, pageSize: 20 });
    if (path === '/api/v1/shipping-runs') {
      if (state.holdRuns) await new Promise((release) => { state.releaseRuns = () => { state.holdRuns = false; release(); }; heldReleases.push(state.releaseRuns); });
      return json(shippingRunListSchema.parse({ items: state.runs }));
    }
    if (path === '/api/v1/documents/candidates') {
      const runId = url.searchParams.get('shippingRunId');
      assert(state.byRun.has(runId), 'Candidates must be read by a known shippingRunId');
      assert.equal(url.searchParams.has('weekStartDate'), false, 'The new selector uses shipping runs, not the legacy week scope');
      state.candidateCalls.push(runId);
      if (state.holdCandidates) await new Promise((release) => { state.releaseCandidates = () => { state.holdCandidates = false; release(); }; heldReleases.push(state.releaseCandidates); });
      if (state.candidateMode === 'error') return json({ error: { code: 'FIXTURE_CANDIDATE_ERROR', message: '技术夹具：候选货件暂不可用。' } }, 503);
      const items = state.candidateMode === 'empty' ? [] : state.byRun.get(runId);
      return json(documentCandidateListSchema.parse({ items, total: items.length, shippingRunId: runId }));
    }
    unexpectedRequests.push(method + ' ' + path);
    return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unhandled fixture ' + method + ' ' + path } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  return context;
}
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const footer = () => wizard().locator('.import-wizard-footer');
const startAction = () => footer().getByRole('button', { name: '自动生成发票', exact: true });
const nextAction = () => footer().getByRole('button', { name: '下一步：出单资料', exact: true });
const previousAction = () => footer().getByRole('button', { name: '上一步', exact: true });
const steps = () => wizard().getByRole('navigation', { name: '新建发票步骤', exact: true });
const prefill = () => wizard().locator('[aria-label="本次出单资料"]');
const shipment = () => wizard().getByRole('combobox', { name: '查找货件', exact: true });
const table = () => wizard().getByRole('region', { name: '本次发货的可选货件，可横向滚动', exact: true });
const popup = () => wizard().getByRole('dialog', { name: '选择货件', exact: true });
const search = () => popup().getByPlaceholder('搜索 FBA、店铺、目的仓或制表组…', { exact: true });
const choice = (candidate) => popup().getByRole('checkbox', { name: new RegExp(candidate.demand.snapshot.fba) });
const bulk = () => popup().getByRole('button', { name: /^(全选|取消选择)搜索结果/ });
async function open() { await page.goto('/shipping?view=documents', { waitUntil: 'domcontentloaded', timeout: 30_000 }); await page.getByRole('button', { name: '制作发票', exact: true }).click(); await expect(wizard()).toBeVisible(); }
async function readRun(runId) { await chooseOption(wizard().getByLabel('发货次', { exact: true }), runId); await wizard().getByRole('button', { name: '读取货件', exact: true }).click(); }
async function openChoices() { if (await shipment().getAttribute('aria-expanded') !== 'true') await shipment().click(); await expect(popup()).toBeVisible(); }
async function finishChoices() { await popup().getByRole('button', { name: '完成选择', exact: true }).click(); await expect(popup()).not.toBeVisible(); }
async function selected(count) { await expect(wizard().locator('.document-selection-bar')).toContainText('已选 ' + count + ' 个 FBA'); }
async function screenshot(name) { await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' }); }

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });

  step = 'missing-run-and-pending-candidates-lock-search-and-the-only-next-action';
  const state = fixture(); state.holdRuns = true; let context = await setup(state); await open();
  await expect(nextAction()).toBeDisabled(); await expect(startAction()).toHaveCount(0); await expect(prefill()).not.toBeVisible(); await expect(steps().getByRole('button', { name: '出单资料', exact: true })).toBeDisabled();
  await expect(shipment()).toBeDisabled(); await expect.poll(() => typeof state.releaseRuns).toBe('function'); state.releaseRuns();
  await expect(wizard().getByLabel('发货次', { exact: true })).toBeEnabled();
  state.holdCandidates = true; await readRun(state.runs[0].id); await expect.poll(() => typeof state.releaseCandidates).toBe('function');
  await expect(wizard().getByRole('status').filter({ hasText: '正在读取本次发货的货件' })).toBeVisible(); await expect(nextAction()).toBeDisabled(); await expect(shipment()).toBeDisabled();
  state.releaseCandidates(); await expect(table().getByRole('checkbox')).toHaveCount(3); await expect(nextAction()).toBeDisabled();
  await expect(wizard().getByRole('button', { name: '预览出单范围', exact: true })).toHaveCount(0);
  await expect(wizard().getByRole('button', { name: '下一步', exact: true })).toHaveCount(0); assert.equal(state.writes.length, 0); note(step);

  step = 'search-multiselect-matches-all-keys-and-filters-the-table-without-selecting';
  await openChoices(); await expect(popup().getByRole('checkbox')).toHaveCount(3); await expect(bulk()).toHaveText('全选搜索结果（3）');
  const queries = [[state.first[0].demand.snapshot.fba, [state.first[0]]], ['Berlin Shop', [state.first[2]]], ['LAX9', state.first.slice(0, 2)],
    ['Harbor Batch', [state.first[1]]], ['德国', [state.first[2]]], ['SEA_A', state.first.slice(0, 2)], ['202', [state.first[2]]]];
  for (const [query, matches] of queries) {
    await search().fill(query); await expect(popup().getByRole('checkbox')).toHaveCount(matches.length); await expect(table().getByRole('checkbox')).toHaveCount(matches.length);
    for (const candidate of matches) { await expect(choice(candidate)).toBeVisible(); await expect(choice(candidate)).not.toBeChecked(); }
    await selected(0); await expect(nextAction()).toBeDisabled(); await expect(popup()).toBeVisible();
  }
  await search().fill(''); await expect(table().getByRole('checkbox')).toHaveCount(3); await finishChoices(); await selected(0); assert.equal(state.writes.length, 0); note(step);

  step = 'one-open-multiselect-allows-several-choices-without-closing-and-clears-them';
  await openChoices(); await choice(state.first[0]).check(); await expect(popup()).toBeVisible(); await choice(state.first[2]).check(); await expect(popup()).toBeVisible();
  await selected(2); await expect(shipment()).toContainText('已选 2 个货件'); await expect(nextAction()).toBeEnabled();
  for (const index of [0, 2]) await expect(table().getByRole('checkbox', { name: state.first[index].demand.snapshot.fba, exact: true })).toBeChecked();
  await screenshot('document-source-multiselect-1440.png');
  await popup().getByRole('button', { name: '清空全部已选', exact: true }).click(); await selected(0); await expect(popup()).toBeVisible(); await expect(nextAction()).toBeDisabled();
  for (const checkbox of await popup().getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
  await finishChoices(); assert.equal(state.writes.length, 0); note(step);

  step = 'search-bulk-selection-preserves-other-queries-and-shares-table-checkbox-state';
  await openChoices(); await search().fill('LAX9'); await expect(bulk()).toHaveText('全选搜索结果（2）'); await bulk().click(); await selected(2);
  await expect(bulk()).toHaveText('取消选择搜索结果（2）'); for (const index of [0, 1]) await expect(choice(state.first[index])).toBeChecked();
  await search().fill('Berlin'); await selected(2); await expect(choice(state.first[2])).not.toBeChecked(); await bulk().click(); await selected(3);
  await search().fill('Harbor Batch'); await expect(bulk()).toHaveText('取消选择搜索结果（1）'); await bulk().click(); await selected(2);
  await search().fill('NO_MATCH_TECHNICAL_KEYWORD'); await expect(popup().getByRole('checkbox')).toHaveCount(0); await expect(bulk()).toBeDisabled();
  await expect(table().getByRole('checkbox')).toHaveCount(0); await selected(2); await expect(nextAction()).toBeEnabled();
  await search().fill(''); for (const index of [0, 2]) await expect(choice(state.first[index])).toBeChecked(); await expect(choice(state.first[1])).not.toBeChecked();
  await finishChoices(); await table().getByRole('checkbox', { name: state.first[0].demand.snapshot.fba, exact: true }).uncheck(); await selected(1);
  await openChoices(); await expect(choice(state.first[0])).not.toBeChecked(); await expect(choice(state.first[2])).toBeChecked(); await choice(state.first[0]).check(); await selected(2);
  await search().fill('Harbor Batch'); await finishChoices(); await expect(table().getByRole('checkbox')).toHaveCount(1); await expect(nextAction()).toBeEnabled();
  assert.equal(state.candidateCalls.length, 1, 'Searching and selecting must remain local'); assert.equal(state.writes.length, 0); note(step);

  step = 'next-opens-the-dedicated-optional-details-step-without-starting-a-task';
  await expect(nextAction()).toHaveCount(1); await expect(nextAction()).toBeEnabled(); await expect(startAction()).toHaveCount(0);
  await expect(wizard().locator('.document-ticket-preview')).toHaveCount(0); await expect(wizard().getByRole('button', { name: '为此范围保存草稿', exact: true })).toHaveCount(0);
  await nextAction().click(); await expect(wizard().getByRole('heading', { name: '出单资料', exact: true })).toBeVisible(); await expect(prefill()).toBeVisible();
  await expect(steps().getByRole('button', { name: '出单资料', exact: true })).toHaveAttribute('aria-current', 'step'); await expect(table()).not.toBeVisible(); await expect(nextAction()).toHaveCount(0);
  await expect(wizard().getByLabel('任务名称（可选）', { exact: true })).toHaveValue(''); await expect(wizard().getByLabel('渠道服务', { exact: true })).toHaveAttribute('data-value', '');
  await expect(wizard().getByRole('status').filter({ hasText: '已切换发货次' })).toHaveCount(0); await expect(startAction()).toBeEnabled(); assert.equal(state.writes.length, 0); note(step);

  step = 'details-back-and-close-resume-preserve-prefill-fields-selection-and-search';
  await wizard().getByLabel('任务名称（可选）', { exact: true }).fill('Technical range selection'); await chooseOption(wizard().getByLabel('渠道服务', { exact: true }), 'TECH SERVICE');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await wizard().locator(':scope > .import-dialog-body').evaluate((node) => { node.scrollTop = 0; });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); assert(await steps().evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
    for (const control of await prefill().locator('input,button[role="combobox"]').all()) { const bounds = await control.boundingBox(); assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1); }
    await expect(wizard().getByRole('heading', { name: '发票与单据向导', exact: true })).toBeInViewport(); assert.equal(await wizard().evaluate((node) => node.scrollTop), 0); await screenshot('document-source-prefill-step2-' + width + '.png');
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await footer().getByRole('button', { name: '暂时关闭', exact: true }).click(); await expect(wizard()).not.toBeVisible();
  await page.getByRole('button', { name: '继续本次制作', exact: true }).click(); await expect(prefill()).toBeVisible(); await expect(steps().getByRole('button', { name: '出单资料', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(wizard().getByLabel('任务名称（可选）', { exact: true })).toHaveValue('Technical range selection'); await expect(wizard().getByLabel('渠道服务', { exact: true })).toHaveAttribute('data-value', 'TECH SERVICE');
  await previousAction().click(); await selected(2); await openChoices(); await expect(search()).toHaveValue('Harbor Batch'); await finishChoices();
  await nextAction().click(); await expect(wizard().getByLabel('任务名称（可选）', { exact: true })).toHaveValue('Technical range selection'); await expect(wizard().getByLabel('渠道服务', { exact: true })).toHaveAttribute('data-value', 'TECH SERVICE');
  await previousAction().click(); await openChoices(); await search().fill(''); for (const index of [0, 2]) await expect(choice(state.first[index])).toBeChecked(); await finishChoices(); assert.equal(state.writes.length, 0); note(step);

  step = 'changing-shipping-run-disables-old-scope-and-reading-clears-filter-and-checks';
  await openChoices(); await search().fill('Pacific Batch'); await finishChoices(); await chooseOption(wizard().getByLabel('发货次', { exact: true }), state.runs[1].id);
  await expect(nextAction()).toBeDisabled(); await expect(shipment()).toBeDisabled(); for (const checkbox of await table().getByRole('checkbox').all()) await expect(checkbox).toBeDisabled();
  await wizard().getByRole('button', { name: '读取货件', exact: true }).click(); await expect(table().getByRole('checkbox')).toHaveCount(1);
  await selected(0); await expect(nextAction()).toBeDisabled(); await openChoices(); await expect(search()).toHaveValue(''); await expect(popup().getByRole('checkbox')).toHaveCount(1); await finishChoices();
  await expect(table().getByRole('checkbox', { name: state.second[0].demand.snapshot.fba, exact: true })).not.toBeChecked();
  await readRun(state.runs[0].id); await expect(table().getByRole('checkbox')).toHaveCount(3); await selected(0); assert.equal(state.writes.length, 0); note(step);

  step = 'narrow-multiselect-supports-keyboard-checkboxes-and-escape-only-closes-the-popup';
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await shipment().focus(); await page.keyboard.press('Enter'); await expect(search()).toBeFocused(); await search().fill('');
    await expect(popup().getByRole('checkbox')).toHaveCount(3); await page.keyboard.press('ArrowDown'); await expect(choice(state.first[0])).toBeFocused();
    await page.keyboard.press('End'); await expect(choice(state.first[2])).toBeFocused(); await page.keyboard.press('Home'); await expect(choice(state.first[0])).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(choice(state.first[2])).toBeFocused(); await page.keyboard.press('ArrowDown'); await expect(choice(state.first[0])).toBeFocused();
    const fullRect = await popup().boundingBox(); assert(fullRect && fullRect.y >= -1 && fullRect.y + fullRect.height <= 901, 'Full multiselect must fit the narrow viewport height');
    await screenshot('document-source-multiselect-' + width + '.png');
    await search().fill('Pacific Batch'); await expect(popup().getByRole('checkbox')).toHaveCount(1); await search().press('ArrowDown');
    await page.keyboard.press('Space'); await expect(choice(state.first[0])).toBeChecked(); await selected(1); await expect(popup()).toBeVisible();
    assert(await popup().evaluate((node) => node.closest('dialog')?.querySelector('h2')?.textContent === '发票与单据向导'));
    const rect = await popup().boundingBox(); assert(rect && rect.x >= -1 && rect.x + rect.width <= width + 1, 'Popover must fit the narrow viewport');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await screenshot('document-source-search-' + width + '.png');
    await page.keyboard.press('Space'); await selected(0); await page.keyboard.press('Escape'); await expect(popup()).not.toBeVisible(); await expect(wizard()).toBeVisible(); await expect(shipment()).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await expect(wizard().getByText('当前搜索', { exact: false })).toBeVisible();
  await wizard().getByRole('button', { name: '清除搜索', exact: true }).click(); await expect(table().getByRole('checkbox')).toHaveCount(3); await selected(0); note(step);

  step = 'candidate-errors-and-empty-runs-keep-the-next-action-disabled-until-a-valid-selection';
  const errored = fixture(); errored.candidateMode = 'error'; const mainPage = page; const errorContext = await setup(errored); await open(); await readRun(errored.runs[0].id);
  await expect(wizard().getByRole('alert')).toContainText('候选货件暂不可用'); await expect(nextAction()).toBeDisabled(); await expect(shipment()).toBeDisabled();
  errored.candidateMode = 'ready'; await wizard().getByRole('button', { name: '重试', exact: true }).click(); await expect(table().getByRole('checkbox')).toHaveCount(3); await expect(nextAction()).toBeDisabled();
  errored.candidateMode = 'empty'; await readRun(errored.runs[1].id); await expect(wizard().getByText('本次暂无有效制表确认的货件。请先在发货批次中完成 M2 制表确认与编码。', { exact: true })).toBeVisible();
  await expect(nextAction()).toBeDisabled(); assert.equal(errored.writes.length, 0); await errorContext.close(); page = mainPage; note(step);

  step = 'only-explicit-automation-start-writes-the-whole-selected-scope-and-locks-repeat-actions';
  await openChoices(); for (const index of [0, 2]) await choice(state.first[index]).check(); await finishChoices(); assert.equal(state.writes.length, 0);
  await nextAction().click(); await expect(prefill()).toBeVisible();
  await expect(wizard().getByRole('status').filter({ hasText: '已切换发货次' })).toHaveText('已切换发货次，已填写的出单资料仍保留。请核对这些资料是否适用于本次货件，再开始生成。');
  assert.equal(state.writes.length, 0); state.allowStart = true; await startAction().dblclick();
  await expect.poll(() => state.startInputs.length).toBe(1); await expect.poll(() => typeof state.releaseStart).toBe('function');
  assert.deepEqual(state.startInputs[0].demandIds, [state.first[0].demandId, state.first[2].demandId]); assert.equal(state.startInputs[0].shippingRunId, state.runs[0].id);
  assert.equal(state.startInputs[0].title, 'Technical range selection'); assert.equal(state.startInputs[0].fields.service, 'TECH SERVICE');
  await expect(startAction()).toBeDisabled(); await expect(previousAction()).toBeDisabled(); await expect(wizard().getByLabel('任务名称（可选）', { exact: true })).toBeDisabled(); await expect(wizard().getByLabel('渠道服务', { exact: true })).toBeDisabled();
  await expect(wizard().getByRole('button', { name: '关闭发票与单据向导', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(wizard()).toBeVisible(); assert.deepEqual(state.writes, ['POST /api/v1/documents/automations']); await screenshot('document-source-explicit-start-pending.png');
  const firstStart = structuredClone(state.startInputs[0]); state.releaseStart(); await expect(wizard().getByRole('alert')).toContainText('技术夹具已记录自动任务范围');
  await expect(startAction()).toBeEnabled(); await expect(previousAction()).toBeEnabled(); state.releaseStart = null; await startAction().click();
  await expect.poll(() => state.startInputs.length).toBe(2); await expect.poll(() => typeof state.releaseStart).toBe('function');
  assert.deepEqual(state.startInputs[1], firstStart, 'Retry after a failed response reuses the operation and full selected scope');
  await expect(startAction()).toBeDisabled(); assert.deepEqual(state.writes, ['POST /api/v1/documents/automations', 'POST /api/v1/documents/automations']);
  state.releaseStart(); await expect(startAction()).toBeEnabled(); await context.close(); note(step);

  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  heldReleases.forEach((release) => release()); await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-document-source-browser', passed: !failed,
    checks, browserErrors, unexpectedRequests, externalRequests, fixtureWriteRequests, realBusinessWrites: 0, externalServiceRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
