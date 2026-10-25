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

// All business APIs use isolated, contract-checked HTTP fixtures. No database or
// Lingxing account is accessed; unexpected and nonlocal requests fail the run.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.AUTO_CONFIRM_EVIDENCE_DIR || resolve(root, '.local/t35/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-20T03:00:00.000Z', id = () => randomUUID(), copy = (value) => structuredClone(value);
const checks = [], browserErrors = [], unexpectedRequests = [];
let viteProcess, browser, page, baseURL, failed = false, step = 'setup';
const note = (name) => { checks.push({ name, result: 'passed' }); console.log('PASS ' + name); };

function fixture() {
  const batch = { id: id(), weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', version: 1, sortMode: 'fba', nextPrefix: 0, createdAt: now };
  const member = { id: id(), snapshot: { sid: 101, fba: 'FBAAUTOCONFIRM', shop: '技术美国店', country: '美国', channel: 'HY', destinationFc: 'ONT8', referenceQuantity: '10', notes: 'TECHNICAL HTTP FIXTURE', subBatchName: null }, version: 1, businessDate: batch.weekStartDate, weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, createdAt: now, updatedAt: now };
  const group = { id: id(), batchId: batch.id, name: '自动确认技术验证', version: 1, status: 'draft', position: 0, demandIds: [member.id], prefix: null, confirmedVersion: null, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now };
  const item = { msku: 'AUTO-MSKU', fnsku: 'AUTO-FNSKU', sku: 'AUTO-SKU', name: '技术验证商品', quantity: '10', listQuantity: '10', initialDeclaredQuantity: '10', localShippedQuantity: '0', receivedQuantity: '0', expiration: null, prepOwner: 'SELLER', labelOwner: 'SELLER' };
  const revision = { id: id(), demandId: member.id, version: 1, demandVersion: member.version, data: { sid: 101, fba: member.snapshot.fba, items: [item], boxes: [{ id: id(), externalBoxId: 'AUTO-BOX', packageId: null, localBoxId: '1', name: 'P1-B1', order: 1, items: [item] }], isSta: true, staPlanId: 'AUTO-PLAN', observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'TECHNICAL HTTP FIXTURE', createdBy: 'technical-ui', createdAt: now };
  const state = { batch, member, group, revision, issues: [], confirmation: null, codes: [], runs: [], bodies: [], operations: new Map(), groupReads: 0, syncReads: 0, syncFailures: 0, groupFailures: 0, conflictOnce: false, loseOnce: false, noRevision: false, holdSync: false, releaseSync: null };
  state.detail = () => contracts.subBatchDetailSchema.parse({ group, members: [member], shipments: [{ demandId: member.id, revision: state.noRevision ? null : revision }], issues: state.issues, confirmation: state.confirmation, codes: state.codes, history: [] });
  state.week = () => contracts.weeklyBatchDetailSchema.parse({ batch, groups: [group], ungrouped: [] });
  state.commit = (operationId) => {
    group.version++; group.status = 'confirmed'; group.confirmedVersion = group.version; group.prefix = 'A'; batch.version++; batch.nextPrefix = 1;
    state.confirmation = { id: id(), groupId: group.id, groupVersion: group.version, snapshot: { members: [copy(member)], shipments: [{ demandId: member.id, revision: copy(revision) }], ruleVersion: 'technical-fixture-v1' }, createdBy: 'technical-ui', createdAt: now };
    state.codes = revision.data.boxes.map((box, index) => ({ id: id(), groupId: group.id, demandId: member.id, boxId: box.id, prefix: 'A', sequence: index + 1, code: 'A' + (index + 1), valid: true, createdAt: now }));
    const result = contracts.batchMutationResultSchema.parse({ operationId, groupId: group.id, batchId: batch.id, replayed: false }); state.operations.set(operationId, result); return result;
  };
  state.workspace = () => contracts.batchWorkspaceSchema.parse({ rows: group.status === 'superseded' ? [] : [{ id: group.id, rowKind: 'group', batch, group, memberCount: 1, status: group.status, sids: [101], shops: [member.snapshot.shop], countries: ['美国'], channels: ['HY'], fbas: [member.snapshot.fba], sync: { syncedMemberCount: state.noRevision ? 0 : 1, staleMemberCount: 0, latestRun: null }, confirmation: state.confirmation ? { id: state.confirmation.id, groupVersion: state.confirmation.groupVersion, createdAt: now, current: true } : null }], total: group.status === 'superseded' ? 0 : 1, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [{ id: batch.id, weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate }], shops: [{ sid: 101, name: member.snapshot.shop }], countries: ['美国'], channels: ['HY'] } });
  return state;
}

async function contextFor(state, { forceConfirmation = true, width = 1440 } = {}) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width, height: 1000 } });
  if (forceConfirmation) await context.addInitScript((groupId) => {
    const key = 'scm-batch-process:technical-ui:' + groupId;
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ version: 2, stage: 'confirmation' }));
  }, state.group.id);
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    try {
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(method + ' EXTERNAL ' + url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '自动确认验证', email: 'automatic@acceptance.invalid', role: 'admin' } });
    if (method === 'GET' && path === '/api/v1/demands') return json({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 50, maxBoxes: 10, filters: { batches: [], shops: [], countries: [], channels: [] }, generatedAt: now });
    if (method === 'GET' && path === '/api/v1/batches/workspace') return json(state.workspace());
    if (method === 'GET' && path === '/api/v1/weekly-batches') return json(contracts.weeklyBatchListSchema.parse({ items: [state.batch], availableWeeks: [] }));
    if (method === 'GET' && path === '/api/v1/weekly-batches/' + state.batch.id) return json(state.week());
    if (method === 'GET' && path === '/api/v1/sub-batches/' + state.group.id) {
      state.groupReads++;
      if (state.groupFailures > 0) { state.groupFailures--; return json({ error: { code: 'DATABASE_UNAVAILABLE', message: '技术夹具：成员读取失败。' } }, 503); }
      return json(state.detail());
    }
    if (method === 'GET' && path === '/api/v1/batch-sync/' + state.group.id) {
      state.syncReads++;
      if (state.holdSync) await new Promise((done) => { state.releaseSync = () => { state.holdSync = false; done(); }; });
      if (state.syncFailures > 0) { state.syncFailures--; return json({ error: { code: 'DATABASE_UNAVAILABLE', message: '技术夹具：同步状态读取失败。' } }, 503); }
      return json({ runs: state.runs });
    }
    if (method === 'POST' && path === '/api/v1/sub-batches/' + state.group.id + '/confirm-and-allocate') {
      const body = request.postDataJSON(); state.bodies.push(copy(body));
      assert.deepEqual(Object.keys(body).sort(), ['operationId', 'expectedVersion', 'expectedBatchVersion', 'expectedDemandVersions', 'expectedShipmentVersions'].sort(), 'atomic payload needs no manual reason');
      if (contracts.confirmAndAllocateSubBatchInputSchema) contracts.confirmAndAllocateSubBatchInputSchema.parse(body);
      const replay = state.operations.get(body.operationId);
      if (replay) return json({ ...replay, replayed: true });
      assert.equal(body.expectedVersion, state.group.version); assert.equal(body.expectedBatchVersion, state.batch.version);
      assert.deepEqual(body.expectedDemandVersions, { [state.member.id]: state.member.version }); assert.deepEqual(body.expectedShipmentVersions, { [state.member.id]: state.revision.version });
      assert(!['frozen', 'superseded'].includes(state.group.status)); assert(!state.issues.some((issue) => issue.severity === 'error')); assert(!state.runs.some((run) => ['running', 'queued'].includes(run.status)));
      if (state.conflictOnce) { state.conflictOnce = false; state.group.version++; state.batch.version++; state.member.version++; state.revision.demandVersion = state.member.version; state.revision.version++; state.revision.id = id(); return json({ error: { code: 'VERSION_CONFLICT', message: '技术夹具：版本已变化，请刷新后重新校验。' } }, 409); }
      const result = state.commit(body.operationId);
      if (state.loseOnce) { state.loseOnce = false; return route.abort('connectionfailed'); }
      return json(result);
    }
    if (method === 'GET' && path === '/api/v1/batch-reports/exports') return json({ items: [] });
    if (method === 'GET' && path === '/api/v1/demands/' + state.member.id) return json(contracts.demandDetailSchema.parse({ demand: state.member, sources: [], revisions: [] }));
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unhandled isolated fixture API' } }, 500);
    } catch (error) {
      browserErrors.push('FIXTURE ' + method + ' ' + path + ': ' + error.message);
      return json({ error: { code: 'FIXTURE_ASSERTION_FAILED', message: error.message } }, 500);
    }
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => browserErrors.push(error.message)); return context;
}
const dialog = () => page.getByRole('dialog', { name: '发货批次处理向导', exact: true });
const nav = () => dialog().getByRole('navigation', { name: '批次处理步骤', exact: true });
const panel = () => page.locator('section').filter({ has: page.getByRole('heading', { name: '校验、确认与编码', exact: true }) });
const open = async (state) => { await page.goto('/batches/' + state.batch.id + '?groupId=' + state.group.id + '&wizard=process'); await expect(dialog()).toBeVisible(); };
async function absentManualControls() {
  await expect(page.getByLabel('确认说明', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /^已核对当前成员/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认当前数据版本', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认并分配编码', exact: true })).toHaveCount(0);
}
async function stableNoPost(state) { await delay(500); assert.equal(state.bodies.length, 0); }

async function automaticChecks() {
  step = 'valid-warning-only-data-auto-confirms-and-allocates-once-with-no-manual-controls';
  const state = fixture(); state.issues = [{ code: 'RECEIPT_DIFFERENCE', severity: 'warning', message: '亚马逊接收数量与申报量不同，未改变准备量。' }, { code: 'RECEIVED_DIFFERENCE', severity: 'warning', message: '接收量与申报量不同，接收差异不修改原装箱。' }];
  const context = await contextFor(state); await open(state); await absentManualControls();
  await expect.poll(() => state.bodies.length).toBe(1);
  await expect(panel().getByRole('region', { name: '箱编码预览，可横向滚动', exact: true })).toContainText('A1');
  await expect(panel()).toContainText('已保存'); await expect(nav().getByRole('button', { name: /成品与导出/ })).toBeEnabled();
  assert.equal(state.confirmation.snapshot.shipments[0].revision.data.boxes[0].items[0].quantity, '10');
  note(step);
  step = 'same-stage-refresh-poll-and-reload-do-not-create-duplicate-operations';
  await dialog().getByRole('button', { name: '刷新处理数据', exact: true }).click();
  await expect.poll(() => state.groupReads).toBeGreaterThanOrEqual(3); await delay(3400); assert.equal(state.bodies.length, 1);
  await page.reload(); await expect(panel()).toContainText('已保存'); await delay(500); assert.equal(state.bodies.length, 1); note(step);
  step = 'automatic-confirmation-responsive-desktop-and-mobile';
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })); assert(layout.document <= layout.viewport + 1);
    await page.screenshot({ path: resolve(evidence, 'automatic-confirmation-' + width + '.png'), fullPage: true });
  }
  note(step); await context.close();
}

async function readinessChecks() {
  const scenarios = [
    ['blocking-validation', (state) => { state.issues = [{ code: 'BOX_QUANTITY_MISMATCH', severity: 'error', message: '技术夹具：逐箱量与申报量不一致。' }]; }],
    ['active-sync', (state) => { state.runs = [{ id: id(), subBatchId: state.group.id, groupVersion: 1, status: 'running', startDate: '2026-10-01', endDate: '2026-10-21', requestBudget: 10, requestsUsed: 0, maxPages: 10, errorCode: null, errorMessage: null, createdAt: now, startedAt: now, completedAt: null }]; }],
    ['sync-status-read-failure', (state) => { state.syncFailures = 100; }],
    ['candidate-version-stale', (state) => { state.member.version++; }],
    ['candidate-missing', (state) => { state.noRevision = true; state.issues = [{ code: 'SHIPMENT_NOT_SYNCED', severity: 'error', message: '技术夹具：未同步。' }]; }],
    ['group-read-failure', (state) => { state.groupFailures = 100; }],
    ['frozen-group', (state) => { state.group.status = 'frozen'; state.group.frozenAt = now; }],
    ['superseded-group', (state) => { state.group.status = 'superseded'; }],
  ];
  for (const [name, prepare] of scenarios) {
    step = name + '-does-not-auto-confirm'; const state = fixture(); prepare(state);
    const context = await contextFor(state); await open(state); await absentManualControls(); await stableNoPost(state); note(step); await context.close();
  }
  step = 'sync-readiness-metadata-must-resolve-before-automatic-post';
  const held = fixture(); held.holdSync = true; const context = await contextFor(held); await open(held);
  await expect.poll(() => held.syncReads).toBeGreaterThan(0); await stableNoPost(held);
  held.releaseSync(); await expect.poll(() => held.bodies.length).toBe(1); note(step); await context.close();
  step = 'already-confirmed-and-coded-data-needs-no-new-post';
  const ready = fixture(); ready.commit(id()); const readyContext = await contextFor(ready); await open(ready); await expect(panel()).toContainText('已保存'); await stableNoPost(ready); note(step); await readyContext.close();
  step = 'hidden-confirmation-step-does-not-submit-in-background';
  const hidden = fixture(); hidden.issues = [{ code: 'TECH_BLOCKED', severity: 'error', message: '技术夹具：尚未就绪。' }]; const hiddenContext = await contextFor(hidden, { forceConfirmation: false });
  await hiddenContext.addInitScript((groupId) => sessionStorage.setItem('scm-batch-process:technical-ui:' + groupId, JSON.stringify({ version: 2, stage: 'products' })), hidden.group.id);
  await open(hidden); await nav().getByRole('button', { name: /制表确认与编码/ }).click(); await expect(panel()).toBeVisible(); await stableNoPost(hidden);
  await nav().getByRole('button', { name: /同步与商品/ }).click(); hidden.issues = [];
  await dialog().getByRole('button', { name: '刷新处理数据', exact: true }).click(); await stableNoPost(hidden); note(step); await hiddenContext.close();
}

async function recoveryChecks() {
  step = 'lost-committed-response-persists-original-request-across-reload';
  const state = fixture(); state.loseOnce = true; const context = await contextFor(state); await open(state);
  const retry = () => page.getByRole('button', { name: '重试自动确认与编码', exact: true });
  await expect(retry()).toBeEnabled(); assert.equal(state.bodies.length, 1); assert(state.confirmation); const first = copy(state.bodies[0]);
  const stored = await page.evaluate(() => Object.entries(sessionStorage).map(([key, value]) => ({ key, value })).filter((item) => item.value.includes('expectedShipmentVersions')));
  assert(stored.some((item) => item.value.includes(first.operationId)), 'exact unknown request survives reload in sessionStorage');
  await delay(3400); assert.equal(state.bodies.length, 1, 'polling must not retry unknown outcome');
  await page.reload(); await expect(retry()).toBeEnabled(); await delay(500); assert.equal(state.bodies.length, 1);
  await retry().click(); await expect(retry()).toHaveCount(0); await expect(panel()).toContainText('已保存');
  assert.equal(state.bodies.length, 2); assert.deepEqual(state.bodies[1], first); assert.equal(state.operations.size, 1); note(step); await context.close();
  step = '409-stops-automatic-retry-until-explicit-refresh-adopts-new-versions';
  const conflict = fixture(); conflict.conflictOnce = true; const conflictContext = await contextFor(conflict); await open(conflict);
  const refresh = page.getByRole('button', { name: '刷新后重新校验', exact: true }); await expect(refresh).toBeEnabled();
  assert.equal(conflict.bodies.length, 1); await delay(3400); assert.equal(conflict.bodies.length, 1, 'new polled facts must not bypass known conflict acknowledgement');
  await refresh.click(); await expect.poll(() => conflict.bodies.length).toBe(2); await expect(panel()).toContainText('已保存');
  assert.notEqual(conflict.bodies[1].operationId, conflict.bodies[0].operationId); assert.equal(conflict.bodies[1].expectedVersion, conflict.bodies[0].expectedVersion + 1); assert.equal(conflict.bodies[1].expectedBatchVersion, conflict.bodies[0].expectedBatchVersion + 1);
  assert.equal(conflict.bodies[1].expectedDemandVersions[conflict.member.id], 2); assert.equal(conflict.bodies[1].expectedShipmentVersions[conflict.member.id], 2); note(step); await conflictContext.close();
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'); viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  await automaticChecks(); await readinessChecks(); await recoveryChecks(); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-automatic-confirmation-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
