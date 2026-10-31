/* global console, process, fetch, URL, structuredClone, sessionStorage */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import * as c from '../../packages/contracts/dist/index.js';
import { closeGridDetails, findGridRow } from '../shared/grid.mjs';

// Isolated UI verification. Every API is a fictitious fixture; no ERP or database access.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.local/t40/monthly-shipping');
const now = '2026-10-24T02:00:00.000Z', today = '2026-10-24';
const uid = () => randomUUID();
const errors = [], unexpected = [], checks = [];
let browser, vite, page, baseURL;
const state = { manualBodies: [], appendBodies: [], correctionBodies: [], legacyBodies: [], operations: new Map(), loseManual: true, loseCorrection: true, groups: new Map(), runs: [], demandOwners: new Map() };
const record = (index, businessDate, weekStartDate, weekEndDate) => c.demandRecordSchema.parse({ id: uid(), version: 1, businessDate, weekStartDate, weekEndDate, createdAt: now, updatedAt: now,
  snapshot: { sid: 101, fba: `FBAMONTH${index}`, shop: '技术验证美国店', country: '美国', channel: '海运', destinationFc: 'ONT8', referenceQuantity: null, notes: null, subBatchName: null, destinationAddress: '虚构地址' } });
const demands = [record(1, '2026-09-30', '2026-09-28', '2026-10-04'), record(2, '2026-10-20', '2026-10-19', '2026-10-25'), record(3, '2026-08-31', '2026-08-31', '2026-09-06'), record(4, '2026-10-01', '2026-09-28', '2026-10-04')];
function makeGroup(name, ids) {
  const group = c.subBatchRecordSchema.parse({ id: uid(), batchId: uid(), name, version: 1, status: 'draft', position: 0, demandIds: ids, prefix: null, confirmedVersion: null, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now });
  state.groups.set(group.id, group); for (const id of ids) state.demandOwners.set(id, group.id); return group;
}
function detailGroup(id) {
  const group = state.groups.get(id); assert(group, `fixture group ${id}`);
  return c.subBatchDetailSchema.parse({ group, members: demands.filter((d) => group.demandIds.includes(d.id)), shipments: group.demandIds.map((demandId) => ({ demandId, revision: null })), issues: [], confirmation: null, codes: [], history: [] });
}
function makeRun(sequence, group, numberingDate = today) {
  const run = c.shippingRunSchema.parse({ id: uid(), version: 1, status: 'draft', stage: 'sync', numberingDate, month: numberingDate.slice(0, 7), sequence, importId: null, parseRunId: null, origin: 'manual', membershipFrozenAt: null, error: null, createdAt: now, updatedAt: now });
  const ticket = { id: uid(), sourceTicketIndex: 1, country: 'US', ticketSequence: 1, number: `${numberingDate.replaceAll('-', '')}-${sequence}-US-1`, members: group.demandIds.map((id, index) => ({ demandId: id, fba: demands.find((d) => d.id === id).snapshot.fba, sid: 101, inputOrder: index + 1, groupId: group.id })) };
  const detail = c.shippingRunDetailSchema.parse({ run, tickets: [ticket], issues: [] }); state.runs.push(detail); return detail;
}
const existingGroup = makeGroup('十月已有手工批次', [demands[3].id]);
const existing = makeRun(2, existingGroup, '2026-10-10');
function workspace(url) {
  const grouping = url.searchParams.get('grouping'), groupId = url.searchParams.get('groupId');
  const rows = demands.filter((demand) => (!grouping || !state.demandOwners.has(demand.id)) && (!groupId || state.demandOwners.get(demand.id) === groupId)).map((demand) => {
    const group = state.groups.get(state.demandOwners.get(demand.id));
    const occurrence = state.runs.find((r) => r.tickets.some((t) => t.members.some((m) => m.demandId === demand.id)));
    return { id: demand.id, demandId: demand.id, lifecycle: 'active', rowKind: 'placeholder', demandVersion: 1, currentDemandVersion: 1, businessDate: demand.businessDate, weekStartDate: demand.weekStartDate, weekEndDate: demand.weekEndDate,
      sid: 101, shop: demand.snapshot.shop, country: demand.snapshot.country, channel: '海运', fba: demand.snapshot.fba, destinationFc: 'ONT8', destinationAddress: '虚构地址',
      msku: null, fnsku: null, sku: null, productName: null, quantity: null, referenceQuantity: null, totalBoxes: null, boxes: [], codes: [], status: 'unsynced', groupId: group?.id ?? null, groupName: group?.name ?? null, groupVersion: group?.version ?? null,
      batchId: group?.batchId ?? null, confirmationId: null, dataRevisionId: null, dataVersion: null, actualShipDate: null, shipmentCreatedAt: null, sourceFilledAt: null, packingDays: null, metadataSource: null, metadataObservedAt: null, notes: null, issues: [], sources: [],
      ...(occurrence ? { shippingRunId: occurrence.run.id, shippingMonth: occurrence.run.month, shippingSequence: occurrence.run.sequence, ticketNumber: occurrence.tickets[0].number } : {}) };
  });
  return c.demandWorkspaceSchema.parse({ rows, total: rows.length, demandTotal: rows.length, page: Number(url.searchParams.get('page') ?? 1), pageSize: Number(url.searchParams.get('pageSize') ?? 20), maxBoxes: 10, generatedAt: now,
    filters: { weeks: [], batches: [], shippingRuns: state.runs.map(({ run }) => run), shops: [{ sid: 101, name: '技术验证美国店' }], countries: ['美国'], channels: ['海运'] } });
}
function report(url) {
  const run = state.runs.find((entry) => entry.run.id === url.searchParams.get('shippingRunId'));
  return c.reportResponseSchema.parse({ rows: [], boxes: [], total: 0, page: 1, pageSize: 50, maxBoxes: 10, confirmations: [], blocked: run ? [...new Set(run.tickets.flatMap((t) => t.members.map((m) => m.groupId)))].map((groupId) => ({ groupId, name: state.groups.get(groupId).name, code: 'CONFIRMATION_REQUIRED', message: '请先确认批次。' })) : [], generatedAt: now });
}
const note = (name) => { checks.push(name); console.log(`PASS ${name}`); };
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = `http://127.0.0.1:${port}`;
  const req = createRequire(resolve(root, 'apps/web/package.json')); const viteBin = resolve(dirname(req.resolve('vite/package.json')), 'bin/vite.js');
  vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' }); const context = await browser.newContext({ viewport: { width: 1365, height: 950 } }); page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL && !['data:', 'blob:'].includes(url.protocol)) { unexpected.push(`EXTERNAL ${url.origin}`); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    try {
      if (path === '/api/v1/session') return json({ user: { id: 'monthly-ui-admin', name: '月内发货验证', email: 'monthly@acceptance.invalid', role: 'admin' } });
      if (method === 'GET' && path === '/api/v1/demands') return json(workspace(url));
      if (method === 'GET' && path.startsWith('/api/v1/demands/')) { const demand = demands.find((d) => d.id === path.split('/').at(-1)); assert(demand); const group = state.groups.get(state.demandOwners.get(demand.id)); return json(c.demandDetailSchema.parse({ demand, revisions: [], sources: [], operations: [], management: { lifecycle: 'active', canEdit: true, canDelete: true, reason: null, groupId: group?.id ?? null, batchId: group?.batchId ?? null } })); }
      if (method === 'GET' && path === '/api/v1/batches/workspace') return json(c.batchWorkspaceSchema.parse({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { shippingRuns: state.runs.map(({ run }) => run), weeks: [], shops: [], countries: [], channels: [] } }));
      if (method === 'GET' && path === '/api/v1/shipping-runs') return json({ items: state.runs.map(({ run }) => run) });
      if (method === 'GET' && /^\/api\/v1\/shipping-runs\/[^/]+$/.test(path)) { const detail = state.runs.find((entry) => entry.run.id === path.split('/').at(-1)); assert(detail); return json(detail); }
      if (method === 'GET' && path.startsWith('/api/v1/sub-batches/')) return json(detailGroup(path.split('/').at(-1)));
      if (method === 'GET' && path === '/api/v1/batch-reports') return json(report(url));
      if (method === 'GET' && path === '/api/v1/batch-reports/exports') return json({ items: [] });
      if (method === 'GET' && path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: { mode: 'manual', version: 1, catalogVersion: 1, lastSyncedAt: now, lastError: null, configured: true, readOnly: true } });
      if (method === 'GET' && path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
      if (method === 'POST' && path === '/api/v1/shipping-runs/manual') {
        const input = c.createManualShippingRunInputSchema.parse(request.postDataJSON()); state.manualBodies.push(input);
        let result = state.operations.get(input.operationId);
        if (!result) { const group = makeGroup(input.name, input.demandIds); result = makeRun(3, group, input.numberingDate); state.operations.set(input.operationId, result); }
        if (state.loseManual) { state.loseManual = false; return route.abort('failed'); }
        return json(result, 201);
      }
      if (method === 'POST' && /\/tickets\/[^/]+\/members$/.test(path)) {
        const input = c.appendShippingTicketMembersInputSchema.parse(request.postDataJSON()); state.appendBodies.push(input); assert.equal(input.groupId, existingGroup.id);
        const group = state.groups.get(input.groupId); group.demandIds.push(...input.demandIds); group.version++;
        for (const demandId of input.demandIds) { state.demandOwners.set(demandId, group.id); existing.tickets[0].members.push({ demandId, fba: demands.find((d) => d.id === demandId).snapshot.fba, sid: 101, inputOrder: existing.tickets[0].members.length + 1, groupId: group.id }); }
        existing.run.version++; return json(existing);
      }
      if (method === 'POST' && path.endsWith('/correction')) {
        const input = c.correctShippingRunInputSchema.parse(request.postDataJSON()); state.correctionBodies.push(input);
        if (!state.operations.has(input.operationId)) { existing.run.membershipFrozenAt = null; existing.run.version++; state.operations.set(input.operationId, existing); }
        if (state.loseCorrection) { state.loseCorrection = false; return route.abort('failed'); }
        return json(existing);
      }
      if (method === 'POST' && /^\/api\/v1\/weekly-batches\/[^/]+\/sub-batches$/.test(path)) {
        const input = request.postDataJSON(); state.legacyBodies.push(input);
        return json(c.batchMutationResultSchema.parse({ operationId: input.operationId, groupId: existingGroup.id, batchId: existingGroup.batchId, replayed: true }));
      }
      unexpected.push(`${method} ${path}`); return json({ error: { code: 'UNEXPECTED_FIXTURE', message: `Unexpected ${path}` } }, 500);
    } catch (error) { errors.push(error.stack); return json({ error: { code: 'FIXTURE_ERROR', message: error.message } }, 500); }
  });
  await page.goto(`${baseURL}/batches/new`);
  const wizard = page.getByRole('dialog', { name: '建立发货批次', exact: true }); await expect(wizard.getByRole('heading', { name: '选择发货次', exact: true })).toBeVisible();
  assert.equal(await page.getByText('需求周范围', { exact: true }).count(), 0);
  await wizard.getByRole('button', { name: '下一步：选择需求', exact: true }).click();
  await wizard.getByRole('checkbox', { name: '选择 FBAMONTH1', exact: true }).check(); await wizard.getByRole('checkbox', { name: '选择 FBAMONTH2', exact: true }).check();
  await expect(wizard.getByRole('row').filter({ hasText: '2026-09-30' })).toBeVisible(); await expect(wizard.getByRole('row').filter({ hasText: '2026-10-20' })).toBeVisible();
  await page.screenshot({ path: resolve(evidence, 'manual-cross-month-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: resolve(evidence, 'manual-cross-month-mobile.png'), fullPage: true }); await page.setViewportSize({ width: 1365, height: 950 });
  await wizard.getByRole('button', { name: '下一步：核对与建立', exact: true }).click(); await wizard.getByLabel('发货批次名称', { exact: true }).fill('跨月导入需求同次发货');
  await wizard.getByRole('checkbox', { name: '已核对发货次、店铺、国家和渠道，确认建立批次。', exact: true }).check(); await wizard.getByRole('button', { name: '确认建立发货批次', exact: true }).click();
  await expect(wizard.getByRole('button', { name: '重试原建立请求', exact: true })).toBeVisible();
  const original = structuredClone(state.manualBodies[0]); assert.equal(original.demandIds.length, 2); assert.deepEqual(new Set(original.demandIds), new Set([demands[0].id, demands[1].id])); assert.equal(state.runs.length, 2);
  await page.reload(); await page.getByRole('dialog', { name: '建立发货批次', exact: true }).getByRole('button', { name: '重试原建立请求', exact: true }).click();
  await expect(page.getByRole('heading', { name: '发货批次已建立', exact: true })).toBeVisible(); assert.deepEqual(state.manualBodies[1], original); assert.equal(state.runs.length, 2); note('cross-month manual creation and lost-response refresh replay preserve operation and occurrence');
  await page.goto(`${baseURL}/shipping`); await expect(page.getByRole('button', { name: '展示过滤条件', exact: true })).toBeVisible();
  const unassigned = await findGridRow(page, '发货明细表', 'FBAMONTH3'); await expect(unassigned.getByRole('checkbox', { name: '选择货件 FBAMONTH3', exact: true })).toBeVisible(); await unassigned.getByRole('checkbox', { name: '选择货件 FBAMONTH3', exact: true }).check(); await closeGridDetails(page, '发货明细表'); await page.getByRole('button', { name: '加入已有批次', exact: true }).click();
  const assignment = page.getByRole('dialog', { name: '安排发货批次', exact: true }); await assignment.getByRole('combobox', { name: '目标发货批次', exact: true }).click(); await page.getByRole('option', { name: /十月已有手工批次/ }).click();
  await assignment.getByRole('checkbox', { name: '已核对发货次和完整成员，确认追加所选需求。', exact: true }).check(); await assignment.getByRole('button', { name: '确认加入批次', exact: true }).click();
  await expect(assignment.getByRole('heading', { name: '需求已加入发货批次', exact: true })).toBeVisible(); assert.deepEqual(state.appendBodies[0].demandIds, [demands[2].id]); assert.equal(existing.run.sequence, 2); assert.equal(existing.tickets[0].members.length, 2); assert.equal(state.runs.length, 2); note('cross-month append keeps existing occurrence and ticket and sends new members only');
  await assignment.getByRole('button', { name: '完成，返回需求池', exact: true }).click();
  const openExistingRun = async () => { await page.getByRole('button', { name: '本次发货与票号', exact: true }).click(); const runs = page.getByRole('dialog', { name: '本次发货与票号', exact: true }); const existingRow = await findGridRow(runs, '本次发货记录', '2026-10 第 2 次发货'); await existingRow.getByRole('button', { name: '查看进度与处理', exact: true }).click(); };
  await openExistingRun();
  const panel = page.getByRole('dialog', { name: '本次发货表', exact: true }); await expect(panel.getByRole('button', { name: '继续后台整理', exact: true })).toBeVisible(); assert.equal(await panel.getByRole('button', { name: '修正清单并继续', exact: true }).count(), 0); assert.equal(await panel.getByRole('link', { name: '核对源行与导入资料', exact: true }).count(), 0); note('manual draft offers processing without import-source correction');
  await panel.getByRole('button', { name: '关闭本次发货表', exact: true }).click(); existing.run.membershipFrozenAt = now; existing.run.version++;
  await page.reload(); await openExistingRun();
  await panel.getByRole('textbox', { name: '更正说明', exact: true }).fill('更正本次成员安排'); await panel.getByRole('button', { name: '建立发货次更正版本', exact: true }).click(); await expect(panel.getByRole('button', { name: '重试原更正请求', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(evidence, 'frozen-correction-desktop.png'), fullPage: true });
  await page.reload(); await openExistingRun(); await panel.getByRole('button', { name: '重试原更正请求', exact: true }).click();
  await expect(panel.getByRole('button', { name: '重试原更正请求', exact: true })).toHaveCount(0); assert.deepEqual(state.correctionBodies[0], state.correctionBodies[1]); assert.equal(existing.run.sequence, 2); note('published occurrence correction survives refresh and replays original request');
  await panel.getByRole('button', { name: '关闭本次发货表', exact: true }).click();
  const legacyDemand = record(5, '2026-09-15', '2026-09-14', '2026-09-20'); demands.push(legacyDemand);
  const legacyInput = { operationId: uid(), expectedVersion: 3, name: '旧版结果待核对批次', reason: '原始待确认请求', demandIds: [legacyDemand.id], expectedDemandVersions: { [legacyDemand.id]: 1 } };
  let selectionHash = 2166136261; for (const character of legacyDemand.id) selectionHash = Math.imul(selectionHash ^ character.charCodeAt(0), 16777619);
  const oldKey = `scm-batch-wizard:monthly-ui-admin:2026-09-14:selection-${selectionHash >>> 0}`;
  await page.evaluate(({ oldKey, legacyDemand, legacyInput, batchId }) => {
    sessionStorage.setItem('scm-demand-assignment:monthly-ui-admin:current', JSON.stringify({ demandIds: [legacyDemand.id], mode: 'create' }));
    sessionStorage.setItem(oldKey, JSON.stringify({ version: 1, step: 3, weekStartDate: '2026-09-14', selected: [legacyDemand], name: legacyInput.name, pendingWeek: null, pendingGroup: { batchId, input: legacyInput } }));
  }, { oldKey, legacyDemand, legacyInput, batchId: existingGroup.batchId });
  await page.goto(`${baseURL}/shipping`); await page.getByRole('dialog', { name: '安排发货批次', exact: true }).getByRole('button', { name: '继续建立批次', exact: true }).click();
  const restored = page.getByRole('dialog', { name: '建立发货批次', exact: true }); await expect(restored.getByRole('button', { name: '核对原请求结果', exact: true })).toBeVisible();
  assert.deepEqual((await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), oldKey)).pendingGroup.input, legacyInput);
  await restored.getByRole('button', { name: '核对原请求结果', exact: true }).click(); await expect(restored.getByRole('heading', { name: '发货批次已建立', exact: true })).toBeVisible();
  assert.deepEqual(state.legacyBodies, [legacyInput]); assert.equal(state.manualBodies.length, 2); note('old selection-scoped v1 pending request is found and replayed unchanged before monthly creation');
  assert.equal(await page.getByText('需求周范围', { exact: true }).count(), 0); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []); note('no weekly controls, fixture violations or browser errors');
} catch (error) {
  errors.push(error.stack); console.error(error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
} finally {
  await browser?.close(); if (vite && vite.exitCode === null) vite.kill(); await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), `${JSON.stringify({ passed: process.exitCode !== 1, checks, errors, unexpected, manualBodies: state.manualBodies, appendBodies: state.appendBodies, correctionBodies: state.correctionBodies }, null, 2)}\n`);
}



