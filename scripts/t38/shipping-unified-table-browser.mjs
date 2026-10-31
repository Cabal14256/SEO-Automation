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
import { chooseOption as chooseFieldOption } from '../shared/ui-controls.mjs';
import { closeGridDetails, closeGridMenu, selectGridRow, findGridRow, showShippingFilters } from '../shared/grid.mjs';

// Every API call is intercepted. This check never reads a database, account file,
// real shipment, or remote service, and refuses any request outside its Vite origin.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.SHIPPING_UNIFIED_EVIDENCE_DIR || resolve(root, '.local/t38/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-20T03:00:00.000Z';
const id = () => randomUUID();
const copy = (value) => structuredClone(value);
const checks = [], unexpectedRequests = [], browserErrors = [];
const entryOnly = process.env.SHIPPING_UNIFIED_ENTRY_ONLY === '1';
const interactionsOnly = process.env.SHIPPING_UNIFIED_INTERACTIONS_ONLY === '1';
let browser, viteProcess, page, baseURL, activeCrudState, step = 'setup', failed = false, currentRows = [];
const note = () => { checks.push({ name: step, result: 'passed' }); console.log('PASS ' + step); };

function fixture() {
  const batch = { id: id(), weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', version: 1, sortMode: 'fba', nextPrefix: 2, createdAt: now };
  const demand = (index) => ({ id: id(), snapshot: { sid: 101, fba: `FBA-SHARED-${index}`, shop: '技术美国店', country: '美国', channel: 'HY', destinationFc: 'ONT8', referenceQuantity: '10', notes: index === 0 ? 'ONLY-READY-NOTE' : 'ISOLATED WORKBENCH FIXTURE', subBatchName: null }, version: 1, businessDate: '2026-10-13', weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, createdAt: now, updatedAt: now });
  const demands = Array.from({ length: 5 }, (_, index) => demand(index));
  const group = (member, name, status) => ({ id: id(), batchId: batch.id, name, version: 1, status, position: 0, demandIds: [member.id], prefix: status === 'confirmed' ? 'AB' : null, confirmedVersion: status === 'confirmed' ? 1 : null, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now });
  const groups = [group(demands[0], '美国已确认批次', 'confirmed'), group(demands[1], '美国原确认冻结批次', 'frozen'), group(demands[3], '候选待核对批次', 'draft'), group(demands[4], '确认失效批次', 'confirmed')];
  groups[1].version = 2; groups[1].confirmedVersion = 1; groups[1].frozenAt = now;
  const references = groups.slice(0, 2).map((item) => ({ groupId: item.id, groupVersion: item.version, confirmationId: id() }));
  // Frozen export still guards the current group version, while retaining its
  // original confirmation identity and original confirmed product quantities.
  references[1].groupVersion = 2;
  const state = { batch, demands, groups, references, queries: [], batchQueries: [], reportQueries: [], exportBodies: [], mutations: [], exports: [], exportFailure: null, delayDemand: 0 };
  const choices = { weeks: [{ weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, demandCount: demands.length }], batches: [batch], shops: [{ sid: 101, name: '技术美国店' }, { sid: 202, name: '技术欧洲店' }], countries: ['美国', '德国'], channels: ['HY', 'OTHER'] };
  const matches = (row, raw, extendedSearch = false) => (!raw.month || row.businessDate.startsWith(raw.month)) && (!raw.weekStartDate || row.weekStartDate === raw.weekStartDate) && (!raw.sid || row.sid === Number(raw.sid)) && (!raw.country || row.country === raw.country) && (!raw.channel || row.channel === raw.channel) && (!raw.q || [row.fba, row.groupName, row.shop, row.productName, row.sku, ...(extendedSearch ? [row.notes, row.destinationAddress] : [])].some((value) => value?.toLowerCase().includes(raw.q.trim().toLowerCase())));
  state.demandRows = (raw) => {
    state.queries.push(copy(raw));
    let rows = demands.flatMap((member, index) => {
      const assigned = groups.find((item) => item.demandIds.includes(member.id));
      return Array.from({ length: index === 0 || index === 2 ? 2 : 1 }, (_, product) => ({
        id: `${member.id}:${product}`, demandId: member.id, rowKind: 'product', demandVersion: 1, currentDemandVersion: index === 1 ? 2 : 1, businessDate: member.businessDate, weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate,
        ...member.snapshot, destinationAddress: index === 0 ? 'ONLY-READY-ADDRESS' : 'TECHNICAL WAREHOUSE ADDRESS', msku: `MSKU-${index}-${product}`, fnsku: `FNSKU-${index}-${product}`, sku: `SKU-${index}-${product}`, productName: index === 1 ? '冻结原确认商品' : `完整商品 ${index}-${product}`, quantity: index === 1 ? 77 : 5,
        groupQuantity: index === 1 ? 77 : 10, monthQuantity: index === 1 ? 77 : 10,
        totalBoxes: 1, boxes: [{ boxId: state.boxes[index < 2 ? index : 0].boxId, boxOrder: 1, quantity: index === 1 ? 77 : 5, code: index < 2 ? `AB-${index + 1}` : null, orderConfirmed: index < 2, sourceLabel: index < 2 ? '原确认箱' : '待核对箱', boxName: '技术箱', externalBoxId: `EXT-${index}`, localBoxId: `LOCAL-${index}`, weight: 1.25, weightUnit: 'KG', length: 10, width: 20, height: 30, lengthUnit: 'CM' }], codes: index < 2 ? [`AB-${index + 1}`] : [], status: index === 1 ? 'frozen' : index === 0 ? 'confirmed' : index === 4 ? 'needs_review' : 'candidate',
        groupId: assigned?.id ?? null, groupName: assigned?.name ?? null, groupVersion: assigned?.version ?? null, batchId: batch.id, confirmationId: references.find((ref) => ref.groupId === assigned?.id)?.confirmationId ?? null,
        dataRevisionId: null, dataVersion: 1, actualShipDate: null, shipmentCreatedAt: null, sourceFilledAt: null, packingDays: null, metadataSource: 'xlsx', metadataObservedAt: null, issues: [], sources: [],
      }));
    }).filter((row) => matches(row, raw, true) && (!raw.region || raw.region === 'all' || raw.region === 'US') && (!raw.groupId || row.groupId === raw.groupId) && (raw.grouping !== 'ungrouped' || !row.groupId) && (!raw.status || row.status === raw.status));
    return contracts.demandWorkspaceSchema.parse({ rows, total: rows.length, demandTotal: new Set(rows.map((row) => row.demandId)).size, page: Number(raw.page || 1), pageSize: 20, maxBoxes: 10, filters: choices, generatedAt: now });
  };
  state.group = (groupId) => {
    const selected = groups.find((item) => item.id === groupId); assert(selected);
    const members = demands.filter((item) => selected.demandIds.includes(item.id));
    const reference = references.find((item) => item.groupId === groupId);
    const confirmation = reference ? { id: reference.confirmationId, groupId, groupVersion: selected.status === 'frozen' ? 1 : reference.groupVersion, snapshot: { members, shipments: [], ruleVersion: 'isolated-unified-fixture-v1' }, createdBy: 'technical-workbench', createdAt: now } : null;
    return contracts.subBatchDetailSchema.parse({ group: selected, members, shipments: members.map((member) => ({ demandId: member.id, revision: null })), issues: [], confirmation, codes: [], history: [] });
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
    ...demands[index].snapshot, msku: `MSKU-${index}-${product}`, fnsku: `FNSKU-${index}-${product}`, sku: `SKU-${index}-${product}`, productName: index === 1 ? '冻结原确认商品' : `完整商品 ${index}-${product}`, quantity: index === 1 ? 77 : 5,
    boxes: [], codes: [`AB-${index + 1}`], groupQuantity: index === 0 ? 10 : 77, monthQuantity: index === 0 ? 10 : 77, status: index === 1 ? 'frozen' : 'confirmed', actualShipDate: null, sourceObservedAt: now, dataRevisionId: id(),
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
  currentRows = [];
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(`${method} EXTERNAL ${url.origin}`); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) state.mutations.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: state.actor ?? 'technical-workbench', name: '发货工作台技术验证', email: 'workbench@acceptance.invalid', role: 'admin' } });
    if (method === 'GET' && path === '/api/v1/shipping-runs') return json({ items: [] });
    if (method === 'GET' && path === '/api/v1/demands') { if (state.delayDemand) await delay(state.delayDemand); const result = state.demandRows(Object.fromEntries(url.searchParams)); currentRows = result.rows; return json(result); }
    if (method === 'GET' && path === '/api/v1/batches/workspace') return json(state.workspace(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/batch-reports') return json(state.report(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/batch-reports/exports') return json({ items: state.exports });
    if (method === 'GET' && path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
    if (method === 'GET' && path === '/api/v1/imports/transport-methods') return json({ items: [], queriedAt: now });
    if (method === 'GET' && path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: { mode: 'manual', version: 1, catalogVersion: 1, lastSyncedAt: now, lastError: null, configured: true, readOnly: true } });
    const lifecycle = path.match(/^\/api\/v1\/demands\/([^/]+)\/(lifecycle-impact|lifecycle\/(cancel|trash|restore|purge))$/);
    if (lifecycle && state.lifecycleImpact) {
      if (method === 'GET') return json(state.lifecycleImpact(lifecycle[1], url.searchParams.get('action')));
      const result = await state.mutateLifecycle(lifecycle[1], lifecycle[3], request.postDataJSON()); return json(result.body, result.status);
    }
    if (method === 'GET' && path === '/api/v1/shipping-recycle-bin' && state.recycle) return json(state.recycle(Object.fromEntries(url.searchParams)));
    const demand = path.match(/^\/api\/v1\/demands\/([^/]+)(?:\/(revisions|cancel))?$/);
    if (demand && state.demandDetail) {
      if (method === 'GET' && !demand[2]) return json(state.demandDetail(demand[1]));
      if (method === 'POST' && demand[2]) { const result = await state.mutateDemand(demand[1], demand[2], request.postDataJSON()); return json(result.body, result.status); }
    }
    const group = path.match(/^\/api\/v1\/sub-batches\/([^/]+)$/);
    if (method === 'GET' && group) return json(state.group(group[1]));
    if (method === 'GET' && path.startsWith('/api/v1/files/')) return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'isolated-workbench-download-fixture' });
    if (method === 'POST' && path === '/api/v1/batch-reports/exports') {
      const body = contracts.reportExportInputSchema.parse(request.postDataJSON()); state.exportBodies.push(copy(body));
      if (state.exportFailure) { const error = state.exportFailure; state.exportFailure = null; if (error === 'UNKNOWN_RESULT') return route.abort('connectionfailed'); return json({ error: { code: error, message: '技术夹具导出失败' } }, error === 'QUEUE_UNAVAILABLE' ? 503 : 409); }
      const record = contracts.reportExportRecordSchema.parse({ id: id(), status: 'completed', groupIds: body.groupIds, references: body.expectedConfirmations, month: body.month || null, region: body.region, fileId: id(), error: null, createdAt: now, completedAt: now, rowCount: 2, boxCount: 1, valid: true, invalidReason: null });
      state.exports.push(record); return json({ export: record, replayed: false }, 202);
    }
    unexpectedRequests.push(`${method} ${path}`); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unhandled isolated fixture API' } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => browserErrors.push(error.message)); return context;
}

const closeRecord = async () => { await closeGridMenu(page, '发货明细表'); await closeGridDetails(page, '发货明细表'); };
const chooseOption = async (target, value) => { if (!await target.locator('xpath=ancestor::dialog[@open]').count()) { await closeRecord(); await showShippingFilters(page); } return chooseFieldOption(target, value); };
const openBatchPicker = async () => { await closeRecord(); const trigger = nav().getByRole('button', { name: '发货批次', exact: true }); if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click(); };
const form = () => page.getByRole('form', { name: '筛选发货工作台', exact: true });
const nav = () => page.getByRole('navigation', { name: '需求与批次导航', exact: true });
const scopes = () => page.getByRole('group', { name: '发货范围切换', exact: true });
const table = () => page.locator('[data-grid-label="发货明细表"]');
const presentation = () => page.getByLabel('展示方式', { exact: true });
const generate = () => page.getByRole('button', { name: '生成所选批次 XLSX', exact: true });
const newBatch = () => page.getByRole('button', { name: '新建发货批次', exact: true });
const demandCheck = async (fba) => { await locateShipment(fba); return table().getByRole('checkbox', { name: `选择货件 ${fba}`, exact: true }); };
const exportCheck = async (name) => {
  await expect.poll(() => currentRows.some((row) => row.groupName === name)).toBe(true);
  await locateShipment(currentRows.find((row) => row.groupName === name).fba);
  return table().getByRole('checkbox', { name: `选择导出批次 ${name}`, exact: true });
};
const allExports = () => page.getByRole('checkbox', { name: /(?:全选|选择本页).*导出/ }).first();
const reset = async () => { await closeRecord(); await showShippingFilters(page); await form().getByRole('button', { name: '重置', exact: true }).click(); };
const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'the viewport must fit the page; wide tables scroll internally');
const resetScroll = async () => { await closeRecord(); await table().getByLabel('发货明细表 定位行', { exact: true }).fill('1'); await expect(table().getByLabel('发货明细表 定位行', { exact: true })).toHaveValue('1'); await page.getByRole('heading', { level: 1, name: '发货工作台', exact: true }).click(); };

// A Canvas renders visible cells only. Exercise the public record navigation and
// the accessible current-record detail instead of expecting thousands of DOM rows.
async function gridRecords() {
  const view = await presentation().getAttribute('data-value');
  if (view === 'products') return currentRows.map((source) => ({ source }));
  if (view === 'boxes') return currentRows.flatMap((source) => source.boxes.length ? source.boxes.map((box) => ({ source, box })) : [{ source }]);
  const shipments = new Map();
  for (const source of currentRows) { const group = shipments.get(source.demandId); if (group) group.push(source); else shipments.set(source.demandId, [source]); }
  return [...shipments.values()].flatMap((members) => [{ source: members[0], summary: true }, ...members.map((source) => ({ source }))]);
}
async function locateRecord(predicate) {
  await expect(table()).toBeVisible();
  let models = [];
  await expect.poll(async () => { models = await gridRecords(); return models.findIndex(predicate); }).toBeGreaterThanOrEqual(0);
  const index = models.findIndex(predicate), model = models[index];
  await expect(table()).toHaveAttribute('data-row-count', String(models.length));
  await selectGridRow(page, '发货明细表', index);
  await expect(table().locator('.scm-grid-record')).toHaveAttribute('data-grid-row-index', String(index + 1));
  await expect(table().locator('.shipping-grid-details')).toHaveAttribute('data-demand-id', model.source.demandId);
  return model;
}
async function locateShipment(fba) { return locateRecord((entry) => entry.source.fba === fba); }
async function expectGridValue(value, keepOpen = false) {
  const text = String(value);
  await locateRecord((entry) => !entry.summary && JSON.stringify(entry).includes(text));
  await expect(table()).toContainText(text);
  if (!keepOpen) await closeRecord();
}
async function expectGridAbsent(value) {
  await expect.poll(() => JSON.stringify(currentRows).includes(String(value))).toBe(false);
  if (currentRows.length) await expect(table()).toHaveAttribute('data-row-count', String((await gridRecords()).length));
}

function interactionFixture() {
  const state = fixture(), original = state.demandRows({}), prototype = original.rows.find((row) => !row.groupId);
  state.queries.length = 0; state.maxBoxes = 10; state.newBoxId = id();
  state.uiDemandIds = Array.from({ length: 105 }, id);
  const rows = state.uiDemandIds.flatMap((demandId, index) => [0, 1].map((product) => ({ ...copy(prototype), id: `${demandId}:${product}`, demandId, fba: `FBA-UI-${String(index + 1).padStart(4, '0')}`, sku: `UI-SKU-${index + 1}-${product}`, msku: `UI-MSKU-${index + 1}-${product}`, fnsku: `UI-FNSKU-${index + 1}-${product}`, productName: `交互验收商品 ${index + 1}-${product}`, groupId: null, groupName: null, groupVersion: null, batchId: null })));
  state.demandRows = (raw) => {
    state.queries.push(copy(raw));
    const matched = new Set(rows.filter((row) => !raw.q || [row.fba, row.sku].some((value) => value.toLowerCase().includes(raw.q.trim().toLowerCase()))).map((row) => row.demandId));
    const pageNumber = Number(raw.page || 1), pageSize = Number(raw.pageSize || 20), pageIds = new Set([...matched].slice((pageNumber - 1) * pageSize, pageNumber * pageSize));
    const pageRows = rows.filter((row) => pageIds.has(row.demandId)).map((row, index) => state.maxBoxes > 10 && index === 0 ? { ...row, boxes: [...row.boxes, { ...row.boxes[0], boxId: state.newBoxId, boxOrder: 12, quantity: 3 }] } : row);
    return contracts.demandWorkspaceSchema.parse({ ...original, rows: pageRows, total: matched.size * 2, demandTotal: matched.size, page: pageNumber, pageSize, maxBoxes: state.maxBoxes, generatedAt: now });
  };
  return state;
}

async function interactionChecks(state) {
  const keys = async () => JSON.parse(await table().getAttribute('data-grid-column-keys'));
  const ready = async () => expect(table().getByRole('grid')).toHaveAttribute('aria-busy', 'false');
  const capacity = () => page.getByRole('combobox', { name: '每页票数', exact: true });
  const menu = () => page.getByRole('menu', { name: '发货明细表 行操作', exact: true });
  const picker = () => page.getByRole('dialog', { name: '列展示设置', exact: true });
  const openColumns = async () => { await closeRecord(); await page.getByRole('button', { name: '列展示设置', exact: true }).click(); await expect(picker()).toBeVisible(); };
  const closeColumns = async () => { await picker().press('Escape'); await expect(picker()).not.toBeVisible(); await ready(); };
  const preference = async (actor = 'technical-workbench', view = 'shipments') => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), `scm-shipping-grid:v1:${actor}:${view}`);
  step = 'filters-start-collapsed-retain-draft-and-never-apply-on-collapse';
  await page.goto('/shipping?view=demands'); await ready();
  await expect(page.getByRole('button', { name: '展示过滤条件', exact: true })).toBeVisible(); await expect(form()).not.toBeVisible(); await expect(presentation()).toBeVisible();
  const toggle = page.getByRole('button', { name: '展示过滤条件', exact: true });
  assert(await toggle.evaluate((element) => Boolean(element.closest('.shipping-workbench-actions'))), 'filter disclosure belongs to the main business-action row');
  assert(await scopes().evaluate((element) => Boolean(element.closest('.shipping-table-selection'))), 'scope switches belong to the selection bar');
  assert(await nav().evaluate((element) => Boolean(element.closest('.shipping-table-selection'))), 'batch picker belongs to the scope and selection bar');
  assert(await presentation().evaluate((element) => Boolean(element.closest('.shipping-table-selection'))), 'presentation belongs to the selection bar');
  assert(await page.getByRole('button', { name: '列展示设置', exact: true }).evaluate((element) => Boolean(element.closest('.scm-grid-navigation') && element.closest('.scm-grid-header-actions'))), 'column settings belong to the grid title row');
  const append = page.getByRole('button', { name: '加入已有批次', exact: true });
  assert(await append.evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector('[role="group"][aria-label="发货范围切换"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'scope switches follow append in reading order');
  assert(await scopes().evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector('nav[aria-label="需求与批次导航"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'batch picker follows scope switches in reading order');
  assert(await presentation().evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector('.shipping-export-page')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'presentation precedes the export checkbox');
  for (const width of [1920, 1440, 390, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 }); await noOverflow();
    const [actions, disclosure, selection, scope, appendButton, display, exportChoice, settings, batchPicker, gridHeader, gridTitle] = await Promise.all([
      page.locator('.shipping-workbench-actions').boundingBox(), page.locator('.shipping-filter-disclosure').boundingBox(),
      page.locator('.shipping-table-selection').boundingBox(), scopes().boundingBox(), append.boundingBox(), presentation().boundingBox(), page.locator('.shipping-export-page').boundingBox(), page.getByRole('button', { name: '列展示设置', exact: true }).boundingBox(),
      nav().getByRole('button', { name: '发货批次', exact: true }).boundingBox(), table().locator('.scm-grid-navigation').boundingBox(), table().locator('.scm-grid-navigation > span').first().boundingBox(),
    ]);
    assert(actions && disclosure && selection && scope && appendButton && display && exportChoice && settings && batchPicker && gridHeader && gridTitle);
    if (width >= 1440) assert(Math.abs(disclosure.x + disclosure.width - (actions.x + actions.width)) <= 2, `filter disclosure aligns to the far right at ${width}px`);
    if (width === 1920) {
      assert(scope.x >= appendButton.x + appendButton.width, 'scope switches follow append on the wide row');
      assert(Math.abs(scope.y + scope.height / 2 - (appendButton.y + appendButton.height / 2)) <= 8, 'scope and append share the wide row');
      assert(batchPicker.x >= scope.x + scope.width, 'batch picker follows scope switches on the wide row');
      assert(Math.abs(batchPicker.y + batchPicker.height / 2 - (scope.y + scope.height / 2)) <= 8, 'batch picker and scope switches share the wide row');
      assert(display.x + display.width <= exportChoice.x, 'presentation precedes export on the wide row');
      assert(Math.abs(display.y + display.height / 2 - (exportChoice.y + exportChoice.height / 2)) <= 8, 'presentation and export share the wide row');
    }
    assert(gridHeader.y >= selection.y + selection.height, 'grid title row follows the selection bar');
    assert(gridHeader.x + gridHeader.width - (settings.x + settings.width) <= 16, `column settings align right in the title row at ${width}px`);
    if (width >= 1440) { assert(gridTitle.x + gridTitle.width <= settings.x, 'title precedes column settings'); assert(Math.abs(gridTitle.y + gridTitle.height / 2 - (settings.y + settings.height / 2)) <= 8, 'title and column settings share the wide row'); }
    await page.screenshot({ path: resolve(evidence, `workbench-default-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 }); await openBatchPicker(); await page.waitForTimeout(150);
  const batchPanel = nav().locator('.shipping-batch-picker-options'), batchBounds = await batchPanel.boundingBox();
  assert(batchBounds && batchBounds.x >= 0 && batchBounds.y >= 0 && batchBounds.x + batchBounds.width <= 391 && batchBounds.y + batchBounds.height <= 845, `batch picker fits 390px: ${JSON.stringify(batchBounds)}`);
  await page.screenshot({ path: resolve(evidence, 'batch-picker-390.png'), animations: 'disabled' }); await nav().getByRole('button', { name: '发货批次', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const initialQueryCount = state.queries.length;
  await showShippingFilters(page); await form().getByLabel('搜索', { exact: true }).fill('UI-SKU-99-0');
  await page.getByRole('button', { name: '隐藏过滤条件', exact: true }).click(); await expect(form()).not.toBeVisible();
  await expect(page.getByText('有未应用修改', { exact: true })).toBeVisible(); await expect(newBatch()).toBeDisabled(); assert.equal(state.queries.length, initialQueryCount);
  await page.getByRole('button', { name: '展开过滤条件继续修改', exact: true }).click(); await expect(form().getByLabel('搜索', { exact: true })).toHaveValue('UI-SKU-99-0');
  await reset(); await page.getByRole('button', { name: '隐藏过滤条件', exact: true }).click(); await page.reload(); await ready(); await expect(form()).not.toBeVisible(); note();

  step = 'triangle-and-page-bulk-expansion-keep-selection-and-column-preferences';
  assert.deepEqual((await keys()).slice(0, 9), ['expand', 'rowNumber', 'selection', 'fba', 'group', 'destinationFc', 'shop', 'country', 'channel']);
  await expect(table()).toHaveAttribute('data-row-count', '60');
  await table().getByRole('grid').click({ position: { x: 16, y: 64 } }); await expect(table()).toHaveAttribute('data-row-count', '58');
  await table().getByRole('grid').click({ position: { x: 16, y: 64 } }); await expect(table()).toHaveAttribute('data-row-count', '60');
  const collapseAll = page.getByRole('button', { name: '全部收起', exact: true }), expandAll = page.getByRole('button', { name: '全部展开', exact: true });
  for (const control of [collapseAll, expandAll]) {
    assert(await control.evaluate((element) => Boolean(element.closest('.scm-grid-header-actions'))), 'bulk expansion belongs to the grid title controls');
    assert(await control.evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector('.scm-grid-header-actions button[aria-haspopup="dialog"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'bulk expansion precedes column settings');
  }
  await selectGridRow(page, '发货明细表', 0); await table().getByRole('checkbox', { name: '选择货件 FBA-UI-0001', exact: true }).check(); await closeRecord();
  const beforeBulkPreferences = await preference(), beforeBulkQueries = state.queries.length;
  await collapseAll.click(); await expect(table()).toHaveAttribute('data-row-count', '20');
  await expect(page.getByLabel('需求分组操作', { exact: true })).toContainText('已选 1 票');
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 }); await noOverflow(); await page.screenshot({ path: resolve(evidence, `bulk-collapsed-${width}.png`), fullPage: true, animations: 'disabled' }); }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await table().getByRole('grid').click({ position: { x: 16, y: 64 } }); await expect(table()).toHaveAttribute('data-row-count', '22');
  await expandAll.click(); await expect(table()).toHaveAttribute('data-row-count', '60');
  assert.equal(state.queries.length, beforeBulkQueries, 'expansion only changes the current page display'); assert.deepEqual(await preference(), beforeBulkPreferences, 'bulk expansion does not alter column preferences');
  await selectGridRow(page, '发货明细表', 0); await expect(table().getByRole('checkbox', { name: '选择货件 FBA-UI-0001', exact: true })).toBeChecked(); await closeRecord();
  await openColumns(); for (const label of ['货件', '批次', '目的仓', '店铺', '国家', '渠道']) await expect(picker().getByRole('checkbox', { name: label, exact: false }).first()).toBeChecked();
  await expect(picker().getByRole('checkbox', { name: /货件/ })).toBeDisabled();
  await closeColumns();
  for (const width of [1440, 390]) {
    const height = width < 768 ? 844 : 1000; await page.setViewportSize({ width, height }); await openColumns(); await page.waitForTimeout(150);
    const bounds = await picker().boundingBox(); assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, `column settings fit ${width}px: ${JSON.stringify(bounds)}`);
    await expect(picker().getByRole('button', { name: '恢复默认列', exact: true })).toBeInViewport();
    await page.screenshot({ path: resolve(evidence, `column-settings-${width}.png`), animations: 'disabled' }); await closeColumns();
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); note();
  if (process.env.SHIPPING_UNIFIED_COLUMN_VISUAL_ONLY === '1') return;

  step = 'page-capacity-uses-complete-demands-and-keeps-cross-page-selection';
  await selectGridRow(page, '发货明细表', 0); await table().getByRole('checkbox', { name: '选择货件 FBA-UI-0001', exact: true }).check(); await closeRecord();
  for (const size of [50, 100]) {
    await chooseFieldOption(capacity(), String(size)); await expect.poll(() => state.queries.at(-1)?.pageSize).toBe(String(size)); await expect.poll(() => new Set(currentRows.map((row) => row.demandId)).size).toBe(size);
    assert([...new Set(currentRows.map((row) => row.demandId))].every((key) => currentRows.filter((row) => row.demandId === key).length === 2));
    await expect(page.getByLabel('需求分组操作', { exact: true })).toContainText('已选 1 票');
  }
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect.poll(() => state.queries.at(-1)?.page).toBe('2'); await expect.poll(() => currentRows.length).toBe(10);
  await chooseFieldOption(capacity(), '20'); await expect.poll(() => state.queries.at(-1)?.page).toBe('1'); await expect.poll(() => currentRows.length).toBe(40); await expect(page.getByLabel('需求分组操作', { exact: true })).toContainText('已选 1 票');
  await selectGridRow(page, '发货明细表', 0); await expect(table().getByRole('checkbox', { name: '选择货件 FBA-UI-0001', exact: true })).toBeChecked(); await closeRecord();
  await chooseFieldOption(capacity(), '100'); await expect.poll(() => currentRows.length).toBe(200); note();

  step = 'columns-persist-per-view-and-new-box-columns-default-visible';
  await openColumns(); await picker().getByLabel('搜索列', { exact: true }).fill('国家'); await expect(picker().getByRole('checkbox')).toHaveCount(1); await picker().getByRole('checkbox', { name: '国家', exact: true }).uncheck(); await picker().getByLabel('搜索列', { exact: true }).fill(''); await picker().getByRole('checkbox', { name: '箱 1', exact: true }).uncheck(); await closeColumns();
  assert(!(await keys()).includes('country')); assert(!(await keys()).includes('box:1'));
  await chooseFieldOption(presentation(), 'products'); await ready(); await expect(capacity()).toHaveAttribute('data-value', '20'); assert((await keys()).includes('country')); assert(!(await keys()).includes('expand'));
  await expect(collapseAll).toHaveCount(0); await expect(expandAll).toHaveCount(0);
  await chooseFieldOption(presentation(), 'boxes'); await ready(); await expect(collapseAll).toHaveCount(0); await expect(expandAll).toHaveCount(0);
  await chooseFieldOption(presentation(), 'products'); await ready();
  await chooseFieldOption(capacity(), '50'); await expect.poll(() => currentRows.length).toBe(100);
  await chooseFieldOption(presentation(), 'shipments'); await ready(); await expect(capacity()).toHaveAttribute('data-value', '100'); assert(!(await keys()).includes('country'));
  state.maxBoxes = 12; await page.getByRole('button', { name: '刷新工作区', exact: true }).click(); await expect.poll(async () => (await keys()).includes('box:12')).toBe(true); assert(!(await keys()).includes('box:1'));
  await page.reload(); await ready(); await expect(capacity()).toHaveAttribute('data-value', '100'); assert(!(await keys()).includes('country')); note();

  step = 'column-widths-account-isolation-and-reset-preserve-capacity';
  await table().getByRole('grid').scrollIntoViewIfNeeded(); const bounds = await table().getByRole('grid').boundingBox();
  await page.mouse.move(bounds.x + 328, bounds.y + 18); await page.mouse.down(); await page.mouse.move(bounds.x + 368, bounds.y + 18, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await preference())?.columnWidths?.fba ?? 0).toBeGreaterThan(225);
  state.actor = 'technical-workbench-other'; await page.reload(); await ready(); await expect(capacity()).toHaveAttribute('data-value', '20'); assert((await keys()).includes('country')); assert.equal(await preference(state.actor), null);
  state.actor = 'technical-workbench'; await page.reload(); await ready(); await expect(capacity()).toHaveAttribute('data-value', '100'); assert(!(await keys()).includes('country')); assert((await preference()).columnWidths.fba > 225);
  await openColumns(); await picker().getByRole('button', { name: '恢复默认列', exact: true }).click(); await closeColumns(); assert((await keys()).includes('country')); assert((await keys()).includes('box:1')); assert.deepEqual((await preference()).columnWidths, {}); await expect(capacity()).toHaveAttribute('data-value', '100'); note();

  step = 'canvas-dots-menu-targets-stable-record-and-fits-responsive-viewports';
  for (const width of [1440, 1920, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 }); await noOverflow(); await table().getByRole('grid').scrollIntoViewIfNeeded();
    const bounds = await table().getByRole('grid').boundingBox(); await table().getByRole('grid').hover({ position: { x: bounds.width - 24, y: 100 } }); await page.mouse.wheel(10000, 0); await page.waitForTimeout(300);
    await table().getByRole('grid').click({ position: { x: bounds.width - 24, y: 64 } }); await expect(menu()).toContainText('FBA-UI-0001');
    await expect(menu().getByRole('menuitem', { name: '完整详情', exact: true })).toBeVisible(); await expect(menu().getByRole('menuitem', { name: '编辑需求', exact: true })).toBeEnabled();
    const menuBounds = await menu().boundingBox(); assert(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1);
    await page.screenshot({ path: resolve(evidence, `grid-interactions-menu-${width}.png`), animations: 'disabled' });
    await menu().getByRole('menuitem', { name: '完整详情', exact: true }).click(); await expect(table().locator('.shipping-grid-details')).toHaveAttribute('data-demand-id', state.uiDemandIds[0]); await closeRecord();
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); assert.deepEqual(state.mutations, []); note();
}

function scrollFixture() {
  const state = fixture(), demandRows = state.demandRows;
  state.demandRows = (raw) => {
    const result = demandRows(raw);
    // Every scope remains taller than the viewport, so an automatic scroll
    // reset cannot be confused with the browser clamping a shorter document.
    const rows = result.rows.flatMap((row) => Array.from({ length: 15 }, (_, index) => ({ ...row, id: `${row.id}:scroll-${index}`, sku: `${row.sku}-SCROLL-${index}` })));
    return contracts.demandWorkspaceSchema.parse({ ...result, rows, total: rows.length });
  };
  state.delayDemand = 150;
  return state;
}

async function scopeScrollChecks(state) {
  step = 'large-scope-navigation-keeps-one-bounded-canvas-and-current-record';
  await page.goto('/shipping?view=demands'); await expectGridValue('SKU-0-0-SCROLL-0');
  const choices = [
    { name: new RegExp(state.groups[0].name), groupId: state.groups[0].id, sku: 'SKU-0-0-SCROLL-0' },
    { name: new RegExp(state.groups[1].name), groupId: state.groups[1].id, sku: 'SKU-1-0-SCROLL-0' },
    { name: '全部发货', sku: 'SKU-2-0-SCROLL-0' },
    { name: '待分组需求', pool: 'ungrouped', sku: 'SKU-2-0-SCROLL-0' },
  ];
  for (const choice of choices) {
    if (typeof choice.name !== 'string') await openBatchPicker();
    const button = (typeof choice.name === 'string' ? scopes() : nav()).getByRole('button', { name: choice.name, exact: typeof choice.name === 'string' });
    const reads = state.queries.length; await button.click();
    await expect.poll(() => state.queries.length).toBeGreaterThan(reads);
    await expect.poll(() => state.queries.at(-1)?.groupId).toBe(choice.groupId);
    await expect.poll(() => state.queries.at(-1)?.grouping).toBe(choice.pool);
    if (typeof choice.name === 'string') await expect(button).toHaveAttribute('aria-current', 'page');
    else await expect(page.getByRole('heading', { name: choice.name })).toBeVisible();
    await expectGridValue(choice.sku);
    await expect(table().locator('canvas')).toHaveCount(1); await expect(table().locator('table')).toHaveCount(0);
    await expect(table().locator('.shipping-grid-details')).toHaveCount(0);
    const viewport = await table().getByRole('grid').boundingBox(); assert(viewport && viewport.height <= 641);
    await noOverflow();
  }
  await page.screenshot({ path: resolve(evidence, 'workbench-bounded-canvas-scopes.png') }); note();
}
async function unifiedNavigation(state) {
  step = 'one-workbench-table-with-three-presentations-and-unified-actions';
  await page.goto('/shipping?view=demands'); await expectGridValue('SKU-0-0');
  await showShippingFilters(page);
  await expect(page.getByRole('navigation', { name: '发货工作台视图', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '需求处理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发货成品', exact: true })).toHaveCount(0);
  await expect(table().locator('canvas')).toHaveCount(1); await expect(table().locator('table')).toHaveCount(0);
  const submenu = page.getByRole('navigation', { name: '发货管理子导航', exact: true });
  const shippingNavigation = [
    { label: '发货工作台', view: 'demands' },
    { label: '发票与单据', view: 'documents' },
  ];
  await expect(submenu.getByRole('link')).toHaveCount(shippingNavigation.length);
  await expect(submenu.getByRole('link')).toHaveText(shippingNavigation.map(({ label }) => label));
  for (const { label, view } of shippingNavigation) {
    const link = submenu.getByRole('link', { name: label, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/shipping?view=${view}`);
  }
  for (const label of ['领星单据与分配', '物流与交接', '报关与 9810', '批次归档']) await expect(submenu.getByRole('button', { name: label + '（待维护）', exact: true })).toBeDisabled();
  await expect(submenu.getByRole('link', { name: '发货工作台', exact: true })).toHaveAttribute('aria-current', 'page');
  for (const label of ['草稿箱', '导入记录', '生成所选批次 XLSX', '批次导出记录', '刷新工作区']) {
    const button = page.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible(); await expect(button).toHaveAttribute('type', 'button');
  }
  await expect(page.getByRole('button', { name: '导入需求', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新增需求', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导入本次发货', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '导入本次发货', exact: true })).toBeVisible();
  await openBatchPicker(); await expect(nav().getByRole('button', { name: '手动创建批次', exact: true })).toHaveCount(1);
  await expect(nav().getByRole('button', { name: '新建批次', exact: true })).toHaveCount(0);
  await nav().getByRole('button', { name: '发货批次', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: '发货工作台', exact: true }).click();
  await page.screenshot({ path: resolve(evidence, 'workbench-entry-actions-1440.png') });
  await expect(form().getByRole('button', { name: '筛选', exact: true })).toHaveAttribute('type', 'submit');
  await expect(form().getByLabel('数据处理状态', { exact: true })).toBeVisible(); await expect(form().getByLabel('国家 / 区域', { exact: true })).toBeVisible();
  const before = copy(state.mutations); await closeRecord(); await page.getByRole('button', { name: '导入记录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '导入记录', exact: true })).toContainText('尚无导入记录'); await page.keyboard.press('Escape');
  assert.deepEqual(state.mutations, before); note();
}

async function presentationsAndSelections(state) {
  step = 'grouped-products-and-box-rows-retain-identical-product-code-and-frozen-quantity';
  const before = copy(state.mutations), products = ['SKU-0-0', 'SKU-0-1', 'SKU-1-0', 'SKU-2-0', 'SKU-2-1', 'SKU-3-0', 'SKU-4-0'];
  for (const view of ['shipments', 'products', 'boxes']) {
    await chooseOption(presentation(), view); for (const sku of products) await expectGridValue(sku);
    await expectGridValue('SKU-1-0', true); const frozen = table().locator('.shipping-grid-details');
    await expect(frozen).toContainText('冻结原确认商品'); await expect(frozen).toContainText('77'); await expect(frozen).toContainText('AB-2'); await closeRecord();
    await expectGridValue('完整商品 0-1');
    if (view === 'boxes') { await expectGridValue('KG'); await expectGridValue('CM'); await expectGridValue('EXT-0'); }
  }
  assert.deepEqual(state.mutations, before); note();
  step = 'shipment-and-whole-export-group-selection-remain-independent-in-every-presentation';
  await chooseOption(presentation(), 'shipments');
  const shipment = (await demandCheck('FBA-SHARED-2')); await shipment.first().focus(); await page.keyboard.press('Space');
  await expect(shipment.first()).toBeChecked(); await expect(newBatch()).toBeEnabled(); await expect(generate()).toBeDisabled();
  await (await exportCheck(state.groups[0].name)).first().focus(); await page.keyboard.press('Space'); await expect(generate()).toBeEnabled(); await expect(newBatch()).toBeEnabled();
  await expect((await exportCheck(state.groups[2].name)).first()).toBeDisabled(); await expect((await exportCheck(state.groups[3].name)).first()).toBeDisabled();
  for (const view of ['products', 'boxes', 'shipments']) {
    await chooseOption(presentation(), view);
    for (const checkbox of await (await demandCheck('FBA-SHARED-2')).all()) await expect(checkbox).toBeChecked();
    for (const checkbox of await (await exportCheck(state.groups[0].name)).all()) await expect(checkbox).toBeChecked();
    await expect(generate()).toBeEnabled(); await expect(newBatch()).toBeEnabled();
  }
  await (await exportCheck(state.groups[0].name)).first().uncheck(); await expect(generate()).toBeDisabled(); await expect(newBatch()).toBeEnabled();
  await (await demandCheck('FBA-SHARED-2')).first().uncheck(); await expect(newBatch()).toBeDisabled();
  await (await exportCheck(state.groups[1].name)).first().check(); await expect(generate()).toBeEnabled();
  await closeRecord(); await generate().click(); await expect.poll(() => state.exports.length).toBe(1);
  assert.deepEqual(state.exportBodies.at(-1).expectedConfirmations, [state.references[1]], 'frozen export guards the current group version and keeps its original confirmation identity');
  assert.deepEqual(state.exportBodies.at(-1).groupIds, [state.groups[1].id]); await (await exportCheck(state.groups[1].name)).first().uncheck(); note();
}

async function searchEligibility(state) {
  step = 'notes-and-address-search-preserve-whole-shipment-and-valid-export-reference';
  for (const term of ['ONLY-READY-NOTE', 'ONLY-READY-ADDRESS']) {
    const previousReads = state.reportQueries.length;
    await closeRecord(); await form().getByLabel('搜索', { exact: true }).fill(term);
    await closeRecord(); await form().getByRole('button', { name: '筛选', exact: true }).click();
    await expect.poll(() => state.queries.at(-1)?.q).toBe(term);
    await expect.poll(() => state.reportQueries.length).toBeGreaterThan(previousReads);
    assert(!('q' in state.reportQueries.at(-1)), 'export eligibility must not narrow the broader workbench search');
    await expectGridValue('SKU-0-0'); await expectGridValue('SKU-0-1');
    await expectGridAbsent('SKU-1-0'); await expectGridAbsent('SKU-2-0');
    await (await exportCheck(state.groups[0].name)).first().check(); await expect(generate()).toBeEnabled();
    const before = state.exports.length; await closeRecord(); await generate().click(); await expect.poll(() => state.exports.length).toBe(before + 1);
    assert.deepEqual(state.exportBodies.at(-1).groupIds, [state.groups[0].id]);
    assert.deepEqual(state.exportBodies.at(-1).expectedConfirmations, [state.references[0]], 'a note/address search still exports the complete confirmed group');
    await reset(); await expectGridValue('SKU-2-1');
  }
  note();
}

async function filtersAndScope(state) {
  step = 'presentation-and-toolbar-actions-do-not-submit-pending-filters';
  await closeRecord(); await form().getByLabel('搜索', { exact: true }).fill('  FBA-SHARED  ');
  const previousQuery = copy(state.queries.at(-1));
  await chooseOption(presentation(), 'products'); await expectGridValue('SKU-0-0');
  await closeRecord(); await page.getByRole('button', { name: '导入记录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '导入记录', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  const queryCount = state.queries.length; await closeRecord(); await page.getByRole('button', { name: '刷新工作区', exact: true }).click();
  await expect.poll(() => state.queries.length).toBeGreaterThan(queryCount);
  assert.deepEqual(state.queries.at(-1), previousQuery, 'toolbar actions must keep the applied filter snapshot');
  await expect(page.getByText('筛选条件已修改，当前仍展示已应用范围。', { exact: false })).toBeVisible();
  await reset(); await expectGridValue('SKU-0-0'); note();
  step = 'draft-and-fetching-filters-block-grouping-and-export-before-applying';
  await (await demandCheck('FBA-SHARED-2')).first().check(); await (await exportCheck(state.groups[0].name)).first().check(); const before = copy(state.mutations);
  await closeRecord(); await form().getByLabel('搜索', { exact: true }).fill('  FBA-SHARED  ');
  await expect(newBatch()).toBeDisabled(); await expect(generate()).toBeDisabled(); await expect((await demandCheck('FBA-SHARED-2')).first()).toBeDisabled(); await expect((await exportCheck(state.groups[0].name)).first()).toBeDisabled();
  state.delayDemand = 600; await closeRecord(); await form().getByRole('button', { name: '筛选', exact: true }).click();
  await expect(newBatch()).toBeDisabled(); await expect(generate()).toBeDisabled(); await expect.poll(() => state.queries.at(-1)?.q).toBe('FBA-SHARED'); state.delayDemand = 0;
  await expect((await demandCheck('FBA-SHARED-2')).first()).not.toBeChecked(); await expect((await exportCheck(state.groups[0].name)).first()).not.toBeChecked(); assert.deepEqual(state.mutations, before); note();
  step = 'all-shared-filters-apply-to-the-one-table-with-status-and-region-together';
  await closeRecord(); await form().getByLabel('发货月份', { exact: true }).fill('2026-10');
  await expect(form().getByLabel('发货月份', { exact: true })).toHaveValue('2026-10');
  await expect(form().getByLabel('需求周范围', { exact: true })).toHaveCount(0);
  await chooseOption(form().getByLabel('店铺', { exact: true }), '101'); await chooseOption(form().getByLabel('国家', { exact: true }), '美国'); await chooseOption(form().getByLabel('业务渠道', { exact: true }), 'HY');
  await chooseOption(form().getByLabel('数据处理状态', { exact: true }), 'candidate'); await chooseOption(form().getByLabel('国家 / 区域', { exact: true }), 'US'); await closeRecord(); await form().getByRole('button', { name: '筛选', exact: true }).click();
  const expected = { month: '2026-10', sid: '101', country: '美国', channel: 'HY', q: 'FBA-SHARED', status: 'candidate', region: 'US' };
  await expect.poll(() => Object.fromEntries(Object.keys(expected).map((key) => [key, state.queries.at(-1)?.[key]]))).toEqual(expected);
  await expectGridValue('SKU-2-1'); await expectGridAbsent('SKU-0-0'); await expect(generate()).toBeDisabled();
  for (const view of ['products', 'boxes', 'shipments']) { await chooseOption(presentation(), view); await expectGridValue('SKU-2-1'); await expect(form().getByLabel('发货月份', { exact: true })).toHaveValue('2026-10'); }
  await reset(); await expectGridValue('SKU-0-0'); note();
  step = 'specific-batch-summary-frozen-snapshot-and-legacy-entry-links-use-the-same-table';
  await openBatchPicker(); await nav().getByRole('button', { name: new RegExp(state.groups[1].name) }).click(); await expect.poll(() => state.queries.at(-1)?.groupId).toBe(state.groups[1].id);
  await expect(page.getByRole('heading', { name: state.groups[1].name, exact: true })).toBeVisible(); await expectGridValue('冻结原确认商品'); await expectGridAbsent('SKU-0-0'); await expect(page.getByText(/已冻结，保留原确认数据/)).toBeVisible();
  for (const view of ['products', 'boxes']) { await chooseOption(presentation(), view); await expectGridValue('冻结原确认商品'); await expect(page.getByRole('heading', { name: state.groups[1].name, exact: true })).toBeVisible(); }
  await page.goto(`/shipping?view=reports&groupId=${state.groups[1].id}`); await expectGridValue('冻结原确认商品'); await expect(page.getByRole('navigation', { name: '发货工作台视图', exact: true })).toHaveCount(0);
  await page.goto('/batch-reports'); await expect(page).toHaveURL(/\/shipping\?/); await expectGridValue('SKU-2-1'); await page.goto('/shipping?view=demands'); await expectGridValue('SKU-2-1'); note();
}

async function exportChecks(state) {
  step = 'export-unknown-result-and-queue-retry-preserve-operation-and-confirmations';
  await (await exportCheck(state.groups[0].name)).first().check(); state.exportFailure = 'UNKNOWN_RESULT'; await closeRecord(); await generate().click();
  await expect(page.getByRole('alert')).toBeVisible(); await expect((await exportCheck(state.groups[0].name)).first()).toBeChecked();
  const snapshot = copy(state.exportBodies.at(-1)); state.exportFailure = 'QUEUE_UNAVAILABLE'; await closeRecord(); await generate().click(); await expect(page.getByRole('alert')).toContainText('任务队列暂不可用'); assert.deepEqual(state.exportBodies.at(-1), snapshot);
  const count = state.exports.length; await closeRecord(); await generate().click(); await expect.poll(() => state.exports.length).toBe(count + 1);
  assert.deepEqual(state.exportBodies.at(-1), snapshot); assert.deepEqual(snapshot.expectedConfirmations, [state.references[0]]); assert.deepEqual(snapshot.groupIds, [state.groups[0].id]);
  await closeRecord(); await page.getByRole('button', { name: '批次导出记录', exact: true }).click(); const history = page.getByRole('dialog', { name: '批次导出记录', exact: true }); await expect(await findGridRow(history, '导出历史', state.references[0].confirmationId)).toContainText(state.references[0].confirmationId);
  const download = page.waitForEvent('download'); await history.getByRole('button', { name: '下载 XLSX', exact: true }).last().click(); assert((await download).suggestedFilename().endsWith('.xlsx'));
  await page.keyboard.press('Escape'); state.exportFailure = 'VERSION_CONFLICT'; await closeRecord(); await generate().click(); await expect((await exportCheck(state.groups[0].name)).first()).not.toBeChecked(); await expect(generate()).toBeDisabled(); note();
  step = 'changed-confirmation-refresh-revokes-export-selection';
  await (await exportCheck(state.groups[0].name)).first().check(); state.references[0].confirmationId = id(); state.references[0].groupVersion += 1; state.groups[0].version += 1;
  state.reportRows.filter((row) => row.groupId === state.groups[0].id).forEach((row) => { row.confirmationId = state.references[0].confirmationId; }); state.boxes[0].confirmationId = state.references[0].confirmationId;
  await closeRecord(); await page.getByRole('button', { name: '刷新工作区', exact: true }).click(); await expect((await exportCheck(state.groups[0].name)).first()).not.toBeChecked(); await expect(generate()).toBeDisabled(); note();
}

async function entryChecks() {
  await page.goto('/shipping'); await expectGridValue('SKU-0-0');
  await expect(page.getByRole('button', { name: '新增需求', exact: true })).toHaveCount(0);
  const importer = page.getByRole('button', { name: '导入本次发货', exact: true });
  await expect(importer).toHaveCount(1);
  for (const width of [390, 320]) {
    step = `single-import-entry-label-fits-one-line-at-${width}px`;
    await page.setViewportSize({ width, height: 844 }); await page.evaluate(() => window.scrollTo(0, 0));
    await expect(importer).toBeVisible(); await noOverflow();
    const lineTops = await importer.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), tops = [];
      for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.textContent.trim()) {
        const range = document.createRange(); range.selectNodeContents(text);
        for (const rectangle of range.getClientRects()) tops.push(Math.round(rectangle.top));
      }
      return [...new Set(tops)];
    });
    assert.equal(lineTops.length, 1, `the import entry label must stay on one line at ${width}px`);
    await page.screenshot({ path: resolve(evidence, `workbench-entry-actions-${width}.png`) }); note();
  }
}

async function layoutChecks() {
  step = 'workbench-disclosure-and-bottom-controls-fit-all-breakpoints';
  await page.reload(); await expectGridValue('SKU-0-0');
  await showShippingFilters(page);
  for (const width of [1920, 1440, 1024, 767, 390, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    await noOverflow();
    const [search, display, apply, resetButton, toolbar, navigation, columnSettings, footer] = await Promise.all([
      form().getByLabel('搜索', { exact: true }).boundingBox(), presentation().boundingBox(),
      form().getByRole('button', { name: '筛选', exact: true }).boundingBox(),
      form().getByRole('button', { name: '重置', exact: true }).boundingBox(),
      page.locator('.shipping-unified-toolbar').boundingBox(), nav().boundingBox(),
      page.getByRole('button', { name: '列展示设置', exact: true }).boundingBox(), table().locator('.scm-grid-footer').boundingBox(),
    ]);
    assert(search && display && apply && resetButton && toolbar && navigation && columnSettings && footer);
    const filterBounds = await form().boundingBox(); assert(filterBounds);
    assert(toolbar.y + toolbar.height <= filterBounds.y + 1, `business toolbar precedes disclosed conditions at ${width}px`);
    assert(navigation.y >= toolbar.y + toolbar.height, `all actions appear above the demand and batch area at ${width}px`);
    assert(await nav().evaluate((element) => Boolean(element.closest('.shipping-table-selection'))), `batch navigation stays in the selection bar at ${width}px`);
    assert(footer.y > display.y, `row navigation and page capacity appear below the grid at ${width}px`);
    await page.getByRole('heading', { level: 1, name: '发货工作台', exact: true }).click();
    await page.screenshot({ path: resolve(evidence, `workbench-controls-${width}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '刷新工作区', exact: true }).focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: '隐藏过滤条件', exact: true })).toBeFocused();
  await closeRecord(); await form().getByLabel('搜索', { exact: true }).focus(); await page.keyboard.press('Tab'); await expect(form().getByRole('button', { name: '筛选', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(form().getByRole('button', { name: '重置', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('checkbox', { name: '选择本页未分组货件', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(scopes().getByRole('button', { name: '全部发货', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(scopes().getByRole('button', { name: '待分组需求', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(nav().getByRole('button', { name: '发货批次', exact: true })).toBeFocused(); note();
  step = 'single-table-keyboard-scroll-desktop-and-390px-without-page-overflow';
  await page.reload(); await expectGridValue('SKU-0-0');
  for (const view of ['shipments', 'products', 'boxes']) {
    await chooseOption(presentation(), view); await resetScroll(); const grid = table().getByRole('grid'); await grid.focus(); await expect(grid).toBeFocused(); await page.keyboard.press('ArrowDown'); await expect(table().getByLabel('发货明细表 定位行', { exact: true })).toHaveValue('2'); await page.keyboard.press('ArrowUp'); await expect(table().getByLabel('发货明细表 定位行', { exact: true })).toHaveValue('1');
    await resetScroll(); await noOverflow(); await page.screenshot({ path: resolve(evidence, `unified-${view}-1440.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await resetScroll(); await noOverflow(); await page.screenshot({ path: resolve(evidence, `unified-${view}-390.png`), fullPage: true }); await page.setViewportSize({ width: 1440, height: 1000 });
  }
  note();
}

function limitFixture() {
  const state = fixture(), original = state.demandRows({}).rows[0], rows = [], references = [];
  for (let index = 0; index < 501; index += 1) {
    const groupId = id(), confirmationId = id(); references.push({ groupId, groupVersion: 1, confirmationId });
    rows.push({ ...copy(original), id: `limit-${index}`, demandId: id(), fba: `FBA-LIMIT-${index}`, groupId, groupName: `上限验证批次 ${index + 1}`, groupVersion: 1, confirmationId, sku: `LIMIT-SKU-${index}`, msku: `LIMIT-MSKU-${index}`, fnsku: `LIMIT-FNSKU-${index}`, productName: `上限商品 ${index}`, codes: [`LIMIT-${index}`] });
  }
  state.demandRows = (raw) => { state.queries.push(copy(raw)); const page = Number(raw.page || 1); return contracts.demandWorkspaceSchema.parse({ rows: rows.slice((page - 1) * 20, page * 20), total: rows.length, demandTotal: rows.length, page, pageSize: 20, maxBoxes: 10, filters: { weeks: [], batches: [], shops: [], countries: [], channels: [] }, generatedAt: now }); };
  state.report = (raw) => { state.reportQueries.push(copy(raw)); return contracts.reportResponseSchema.parse({ rows: [], boxes: [], confirmations: references, total: 0, page: 1, pageSize: 50, maxBoxes: 0, blocked: [], generatedAt: now }); };
  return state;
}

async function limitChecks() {
  step = 'cross-page-export-selection-stops-at-500-without-silent-truncation';
  await page.goto('/shipping?view=demands'); await expectGridValue('LIMIT-SKU-0'); await chooseOption(presentation(), 'products');
  for (let pageNumber = 1; pageNumber <= 25; pageNumber += 1) {
    await closeRecord(); await allExports().check(); if (pageNumber < 25) { await closeRecord(); await page.getByRole('button', { name: '下一页', exact: true }).click(); await expectGridValue(`LIMIT-SKU-${pageNumber * 20}`); }
  }
  await expect(generate()).toBeEnabled(); await closeRecord(); await page.getByRole('button', { name: '下一页', exact: true }).click(); await expectGridValue('LIMIT-SKU-500');
  await (await exportCheck('上限验证批次 501')).first().click(); await expect(page.getByRole('alert')).toContainText('500'); await expect((await exportCheck('上限验证批次 501')).first()).not.toBeChecked(); await expect(generate()).toBeEnabled(); note();
}

function crudFixture() {
  const state = fixture(), original = state.demandRows({}), templates = new Map();
  for (const demand of state.demands) templates.set(demand.id, original.rows.filter((row) => row.demandId === demand.id).map(copy));
  state.queries.length = 0;
  state.lifecycles = new Map(state.demands.map((demand) => [demand.id, 'active']));
  state.revisionBodies = []; state.cancelBodies = []; state.detailReads = []; state.operationHistory = new Map();
  state.nextFailure = null; state.holdNextMutation = null; state.releaseMutation = null;
  state.pageDemands = Array.from({ length: 21 }, (_, index) => {
    const demand = copy(state.demands[2]); demand.id = id(); demand.snapshot.fba = `FBA-CRUD-PAGE-${String(index + 1).padStart(2, '0')}`; demand.snapshot.notes = `CRUD PAGE NOTE ${index + 1}`;
    templates.set(demand.id, Array.from({ length: index === 20 ? 2 : 1 }, (_, product) => ({ ...copy(original.rows.find((row) => row.demandId === state.demands[2].id)), id: `${demand.id}:${product}`, demandId: demand.id, msku: `CRUD-MSKU-${index + 1}-${product}`, fnsku: `CRUD-FNSKU-${index + 1}-${product}`, sku: `CRUD-SKU-${index + 1}-${product}`, productName: `CRUD 商品 ${index + 1}-${product}` })));
    state.lifecycles.set(demand.id, 'active'); return demand;
  });
  state.demands.push(...state.pageDemands);
  // The frozen projection remains its original snapshot. The detail endpoint
  // returns the current demand version, so the two must never be interchanged.
  state.demands[1].version = 2; state.demands[1].snapshot.notes = 'CURRENT SERVER NOTE FOR FROZEN SHIPMENT'; state.demands[1].snapshot.destinationFc = 'LATEST-FC';
  const history = new Map(state.demands.map((demand) => [demand.id, [{ version: demand.version, snapshot: copy(demand.snapshot), createdBy: 'technical-workbench', createdAt: now }]]));
  const replays = new Map();
  const owner = (demandId) => state.groups.find((group) => group.demandIds.includes(demandId));
  const management = (demand) => {
    const group = owner(demand.id), lifecycle = state.lifecycles.get(demand.id);
    const reason = lifecycle === 'cancelled' ? '需求已删除，历史版本只读。' : group?.frozenAt ? '批次已冻结，请发起更正后处理。' : demand.id === state.demands[4].id ? '已有下游单据或任务引用，请通过批次更正处理。' : null;
    return { lifecycle, canEdit: !reason, canDelete: !reason, reason, groupId: group?.id ?? null, batchId: group?.batchId ?? null };
  };
  state.demandDetail = (demandId) => {
    state.detailReads.push(demandId); const demand = state.demands.find((entry) => entry.id === demandId); assert(demand);
    return contracts.demandDetailSchema.parse({ demand, revisions: history.get(demandId), sources: [], management: management(demand), operations: state.operationHistory.get(demandId) ?? [] });
  };
  state.demandRows = (raw) => {
    state.queries.push(copy(raw)); const allRows = state.demands.flatMap((demand) => {
      const group = owner(demand.id), lifecycle = state.lifecycles.get(demand.id), source = templates.get(demand.id);
      if (lifecycle === 'trashed') return [];
      if (lifecycle === 'cancelled') return [{ ...copy(source[0]), ...copy(demand.snapshot), id: `${demand.id}:cancelled`, lifecycle, demandId: demand.id, demandVersion: demand.version, currentDemandVersion: demand.version, rowKind: 'placeholder', msku: null, fnsku: null, sku: null, productName: null, quantity: null, groupQuantity: null, monthQuantity: null, boxes: [], codes: [], totalBoxes: null, groupId: null, groupName: null, groupVersion: null, confirmationId: null, status: 'unsynced' }];
      return source.map((entry) => {
        const row = copy(entry), frozen = Boolean(group?.frozenAt);
        if (!frozen) Object.assign(row, copy(demand.snapshot), { demandVersion: demand.version, sourceFilledAt: demand.snapshot.sourceFilledAt ?? null });
        return { ...row, lifecycle, currentDemandVersion: demand.version, groupId: group?.id ?? null, groupName: group?.name ?? null, groupVersion: group?.version ?? null, status: !frozen && demand.version > entry.demandVersion ? 'needs_review' : row.status };
      });
    });
    const scoped = allRows.filter((row) => (!raw.lifecycle || raw.lifecycle === 'all' || row.lifecycle === raw.lifecycle) && (raw.lifecycle || row.lifecycle === 'active') && (!raw.month || row.businessDate.startsWith(raw.month)) && (!raw.weekStartDate || row.weekStartDate === raw.weekStartDate) && (!raw.sid || row.sid === Number(raw.sid)) && (!raw.country || row.country === raw.country) && (!raw.channel || row.channel === raw.channel) && (!raw.region || raw.region === 'all' || raw.region === 'US') && (!raw.groupId || row.groupId === raw.groupId) && (raw.grouping !== 'ungrouped' || !row.groupId) && (!raw.status || row.status === raw.status));
    const q = raw.q?.trim().toLowerCase(), found = q ? new Set(scoped.filter((row) => [row.fba, row.groupName, row.shop, row.productName, row.msku, row.fnsku, row.sku, row.notes, row.destinationAddress, ...row.codes].some((value) => value?.toLowerCase().includes(q))).map((row) => row.demandId)) : new Set(scoped.map((row) => row.demandId));
    const matching = scoped.filter((row) => found.has(row.demandId)), pageNumber = Number(raw.page || 1), pageSize = Number(raw.pageSize || 20), visibleIds = new Set([...found].slice((pageNumber - 1) * pageSize, pageNumber * pageSize));
    return contracts.demandWorkspaceSchema.parse({ rows: matching.filter((row) => visibleIds.has(row.demandId)), total: matching.length, demandTotal: found.size, page: pageNumber, pageSize, maxBoxes: 10, filters: { ...original.filters, channels: [...new Set(state.demands.map((entry) => entry.snapshot.channel).filter(Boolean))] }, generatedAt: now });
  };
  state.mutateDemand = async (demandId, action, raw) => {
    const input = action === 'revisions' ? contracts.demandRevisionInputSchema.parse(raw) : contracts.demandCancelInputSchema.parse(raw);
    (action === 'revisions' ? state.revisionBodies : state.cancelBodies).push({ demandId, input: copy(input) });
    const previous = replays.get(input.operationId);
    if (previous) { assert.deepEqual(input, previous.input); return { status: 200, body: { ...copy(previous.body), replayed: true } }; }
    const demand = state.demands.find((entry) => entry.id === demandId); assert(demand);
    if (state.holdNextMutation === action) { state.holdNextMutation = null; await new Promise((resolve) => { state.releaseMutation = resolve; }); state.releaseMutation = null; }
    if (state.nextFailure?.action === action) {
      const failure = state.nextFailure; state.nextFailure = null;
      if (failure.code === 'VERSION_CONFLICT') { demand.version++; demand.snapshot.notes = 'SERVER CONCURRENT NOTE'; history.get(demandId).push({ version: demand.version, snapshot: copy(demand.snapshot), createdBy: 'other-fixture-actor', createdAt: now }); }
      return { status: failure.code === 'QUEUE_UNAVAILABLE' ? 503 : 409, body: { error: { code: failure.code, message: failure.code === 'VERSION_CONFLICT' ? '需求版本已变化，请重新读取需求后核对。' : '技术夹具：请求暂未完成，请保持内容重试。' } } };
    }
    if (input.expectedVersion !== demand.version) return { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: '需求版本已变化。' } } };
    const permission = management(demand);
    if (action === 'revisions' ? !permission.canEdit : !permission.canDelete) return { status: 409, body: { error: { code: 'DEMAND_READ_ONLY', message: permission.reason } } };
    demand.version++; demand.updatedAt = now;
    if (action === 'revisions') { Object.assign(demand.snapshot, input.fields); history.get(demandId).push({ version: demand.version, snapshot: copy(demand.snapshot), createdBy: 'technical-workbench', createdAt: now }); }
    else state.lifecycles.set(demandId, 'cancelled');
    const group = owner(demandId);
    if (group) {
      group.version++; group.confirmedVersion = null; group.status = 'draft';
      if (action === 'cancel') group.demandIds = group.demandIds.filter((value) => value !== demandId);
      const refIndex = state.references.findIndex((reference) => reference.groupId === group.id); if (refIndex >= 0) state.references.splice(refIndex, 1);
      state.reportRows = state.reportRows.filter((row) => row.groupId !== group.id); state.boxes = state.boxes.filter((box) => box.groupId !== group.id);
    }
    const operations = state.operationHistory.get(demandId) ?? []; operations.push({ action: action === 'revisions' ? 'demand.revise' : 'demand.cancel', reason: input.reason, createdBy: 'technical-workbench', createdAt: now, version: demand.version }); state.operationHistory.set(demandId, operations);
    const body = { demand: contracts.demandRecordSchema.parse(demand), replayed: false }; replays.set(input.operationId, { input: copy(input), body: copy(body) });
    return { status: 200, body };
  };
  state.lifecycleImpact = (demandId, action) => {
    const demand = state.demands.find((entry) => entry.id === demandId), group = owner(demandId); assert(demand);
    return contracts.shippingLifecycleImpactSchema.parse({ type: 'demand', id: demandId, name: demand.snapshot.fba, version: demand.version, lifecycle: state.lifecycles.get(demandId), action, impactToken: 'a'.repeat(64), members: [{ id: demandId, fba: demand.snapshot.fba }], groups: group ? [{ id: group.id, name: group.name }] : [], affectedRuns: [], documents: [], workflowCount: 0, conflicts: [], canExecute: true, blockingReasons: [] });
  };
  const lifecycleReplays = new Map();
  state.mutateLifecycle = async (demandId, action, raw) => {
    const input = contracts.shippingLifecycleInputSchema.parse(raw); state.cancelBodies.push({ demandId, input: copy(input) });
    if (lifecycleReplays.has(input.operationId)) return { status: 200, body: { ...lifecycleReplays.get(input.operationId), replayed: true } };
    if (state.holdNextMutation === action) { state.holdNextMutation = null; await new Promise((resolve) => { state.releaseMutation = resolve; }); state.releaseMutation = null; }
    if (state.nextFailure?.action === action) { state.nextFailure = null; return { status: 503, body: { error: { code: 'QUEUE_UNAVAILABLE', message: '技术夹具：请求暂未完成，请保持内容重试。' } } }; }
    const demand = state.demands.find((entry) => entry.id === demandId); assert(demand); assert.equal(demand.version, input.expectedVersion);
    demand.version++; state.lifecycles.set(demandId, action === 'trash' ? 'trashed' : action === 'restore' ? 'active' : 'cancelled');
    const operations = state.operationHistory.get(demandId) ?? []; operations.push({ action: `demand.${action}`, reason: input.reason, createdBy: 'technical-workbench', createdAt: now, version: demand.version }); state.operationHistory.set(demandId, operations);
    const body = contracts.shippingLifecycleResultSchema.parse({ type: 'demand', id: demandId, version: demand.version, lifecycle: state.lifecycles.get(demandId), pending: false, purged: false, replayed: false }); lifecycleReplays.set(input.operationId, body); return { status: 200, body };
  };
  state.recycle = () => { const items = state.demands.filter((entry) => state.lifecycles.get(entry.id) === 'trashed').map((entry) => ({ type: 'demand', id: entry.id, name: entry.snapshot.fba, version: entry.version, lifecycle: 'trashed', changedAt: now, changedBy: 'technical-workbench', reason: state.operationHistory.get(entry.id)?.at(-1)?.reason ?? '', pending: false, memberCount: 1, canPurge: true, purgeBlockingReasons: [] })); return contracts.shippingRecycleListSchema.parse({ items, total: items.length, page: 1, pageSize: 20 }); };
  return state;
}

const demandDialog = () => page.getByRole('dialog', { name: '货件需求', exact: true });
const rowAction = async (fba, name) => {
  await locateShipment(fba); await closeRecord(); await table().getByRole('button', { name: '发货明细表 查看当前记录', exact: true }).click();
  const menu = page.getByRole('menu', { name: '发货明细表 行操作', exact: true });
  await expect(menu.locator('.shipping-grid-menu-summary')).toContainText(fba);
  return menu.getByRole('menuitem', { name, exact: true });
};
const submitDemand = () => demandDialog().locator('form button[type="submit"]');
const filterDemands = async (q) => {
  await showShippingFilters(page);
  await closeRecord(); await form().getByLabel('搜索', { exact: true }).fill(q);
  await closeRecord(); await form().getByRole('button', { name: '筛选', exact: true }).click();
};

async function crudChecks(state) {
  const target = state.pageDemands.at(-1), fba = target.snapshot.fba;
  step = 'single-import-entry-opens-automatic-and-legacy-modes-without-mutating-a-record';
  await page.goto('/shipping?view=demands'); await expectGridValue('SKU-0-0');
  await expect(page.getByRole('button', { name: '新增需求', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导入本次发货', exact: true })).toHaveCount(1);
  await closeRecord(); await page.getByRole('button', { name: '导入本次发货', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '导入向导', exact: true });
  await expect(importer).toBeVisible();
  await expect(importer.getByRole('button', { name: '本次发货自动整理', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await importer.getByRole('button', { name: '仅导入需求', exact: true }).click();
  await expect(importer.getByRole('navigation', { name: '导入步骤', exact: true }).getByRole('button', { name: /填写与解析/ })).toHaveAttribute('aria-current', 'step');
  await expect(importer.getByRole('region', { name: '在线需求编辑表，可横向滚动', exact: true })).toBeVisible();
  await importer.getByRole('button', { name: '关闭导入向导', exact: true }).click(); await expect(importer).not.toBeVisible();
  assert.deepEqual(state.mutations, []); note();

  step = 'one-shipment-crud-entry-in-all-three-presentations-and-responsive-layouts';
  for (const view of ['shipments', 'products', 'boxes']) {
    await chooseOption(presentation(), view);
    for (const name of ['查看需求', '编辑需求', '删除需求']) {
      await locateShipment('FBA-SHARED-0');
      await expect(table().getByRole('button', { name, exact: true })).toHaveCount(1);
      await expect((await rowAction('FBA-SHARED-0', name))).toHaveCount(1);
    }
    await expect((await rowAction('FBA-SHARED-1', '编辑需求'))).toBeDisabled();
    await expect((await rowAction('FBA-SHARED-1', '删除需求'))).toBeEnabled();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await resetScroll(); await noOverflow();
      await page.screenshot({ path: resolve(evidence, `workbench-crud-${view}-${width}.png`), fullPage: true });
      if (view === 'shipments' && width !== 320) await page.screenshot({ path: resolve(evidence, `workbench-crud-list-viewport-${width}.png`), fullPage: false });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  note();

  step = 'server-search-before-pagination-preserves-all-products-of-a-matched-shipment';
  await chooseOption(presentation(), 'products'); await filterDemands('FBA-CRUD-PAGE');
  await expect.poll(() => state.queries.at(-1)?.q).toBe('FBA-CRUD-PAGE');
  await expectGridAbsent(fba); await closeRecord(); await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expectGridValue('CRUD-SKU-21-0'); await expectGridValue('CRUD-SKU-21-1');
  await expect.poll(() => state.queries.at(-1)?.page).toBe('2');
  await filterDemands(`  ${fba.toLowerCase()}  `);
  await expect.poll(() => state.queries.at(-1)?.q).toBe(fba.toLowerCase()); await expect.poll(() => state.queries.at(-1)?.page).toBe('1');
  await expectGridValue('CRUD-SKU-21-0'); await expectGridValue('CRUD-SKU-21-1');
  await expectGridAbsent('CRUD-SKU-20-0');
  for (const view of ['shipments', 'boxes', 'products']) {
    await chooseOption(presentation(), view);
    for (const name of ['查看需求', '编辑需求', '删除需求']) await expect((await rowAction(fba, name))).toHaveCount(1);
    await expectGridValue('CRUD-SKU-21-0'); await expectGridValue('CRUD-SKU-21-1');
  }
  await filterDemands('no-matching-crud-demand'); await expect(page.getByText('此范围暂无发货明细，请调整筛选或导入并提交需求。', { exact: true })).toBeVisible(); await expect(table()).toHaveCount(0);
  await filterDemands(fba); await expect((await rowAction(fba, '编辑需求'))).toBeVisible(); note();

  step = 'edit-dirty-guard-cancel-and-503-retry-preserve-current-fields-and-operation';
  await (await rowAction(fba, '编辑需求')).click(); await expect(demandDialog().getByLabel('备注', { exact: true })).toHaveValue('CRUD PAGE NOTE 21');
  await demandDialog().getByLabel('备注', { exact: true }).fill('UNSAVED CRUD NOTE');
  await demandDialog().getByRole('button', { name: '关闭货件需求', exact: true }).click();
  await expect(demandDialog().getByRole('button', { name: '放弃修改并关闭', exact: true })).toBeVisible();
  await expect(demandDialog().getByLabel('备注', { exact: true })).toBeDisabled();
  await demandDialog().getByRole('button', { name: '继续填写', exact: true }).click();
  await expect(demandDialog().getByLabel('备注', { exact: true })).toHaveValue('UNSAVED CRUD NOTE');
  await demandDialog().getByRole('button', { name: '取消修改', exact: true }).click();
  await expect(demandDialog()).toContainText('CRUD PAGE NOTE 21'); assert.equal(state.revisionBodies.length, 0);
  await demandDialog().getByRole('button', { name: '编辑需求', exact: true }).click();
  const edited = { channel: 'CRUD-CHANNEL', destinationFc: 'CRUD-FC', destinationAddress: 'CRUD WAREHOUSE ADDRESS', referenceQuantity: '27', sourceFilledAt: '2026-10-12', notes: 'CRUD SAVED NOTE' };
  for (const [label, value] of [['业务渠道', edited.channel], ['目的仓', edited.destinationFc], ['仓库地址', edited.destinationAddress], ['参考数量', edited.referenceQuantity], ['来源填写日期', edited.sourceFilledAt], ['备注', edited.notes]]) await demandDialog().getByLabel(label, { exact: true }).fill(value);
  await demandDialog().getByLabel('修改原因', { exact: true }).fill('CRUD initial revision');
  state.holdNextMutation = 'revisions'; state.nextFailure = { action: 'revisions', code: 'QUEUE_UNAVAILABLE' };
  await submitDemand().click(); await expect.poll(() => Boolean(state.releaseMutation)).toBe(true);
  await expect(demandDialog().getByRole('button', { name: '关闭货件需求', exact: true })).toBeDisabled(); await expect(submitDemand()).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(demandDialog()).toBeVisible(); state.releaseMutation();
  await expect(demandDialog().getByRole('alert')).toContainText('原操作编号已保留');
  await expect(demandDialog().getByLabel('备注', { exact: true })).toHaveValue(edited.notes);
  await expect(demandDialog().getByLabel('修改原因', { exact: true })).toHaveValue('CRUD initial revision'); assert.equal(target.version, 1);
  const firstRevision = copy(state.revisionBodies.at(-1)); await submitDemand().click(); await expect(demandDialog()).not.toBeVisible();
  assert.deepEqual(state.revisionBodies.at(-1), firstRevision); assert.deepEqual(firstRevision.input.fields, edited); assert.equal(firstRevision.input.expectedVersion, 1); assert.equal(target.version, 2);
  await expectGridValue('CRUD SAVED NOTE');
  await (await rowAction(fba, '查看需求')).click(); await demandDialog().getByText('修订与操作历史', { exact: true }).click();
  await expect(await findGridRow(demandDialog(), '需求操作历史', 'CRUD initial revision')).toContainText('CRUD initial revision');
  await demandDialog().getByRole('button', { name: '关闭货件需求', exact: true }).click(); note();

  step = 'revision-conflict-requires-explicit-discard-and-new-current-version';
  await (await rowAction(fba, '编辑需求')).click(); await demandDialog().getByLabel('备注', { exact: true }).fill('CLIENT CONFLICT DRAFT'); await demandDialog().getByLabel('修改原因', { exact: true }).fill('stale client reason');
  state.nextFailure = { action: 'revisions', code: 'VERSION_CONFLICT' }; await submitDemand().click();
  await expect(demandDialog().getByRole('alert')).toContainText('输入已保留'); const staleInput = copy(state.revisionBodies.at(-1).input);
  await expect(demandDialog().getByLabel('备注', { exact: true })).toHaveValue('CLIENT CONFLICT DRAFT');
  await demandDialog().getByRole('button', { name: '重新读取需求', exact: true }).click(); await demandDialog().getByRole('button', { name: '继续填写', exact: true }).click();
  await expect(demandDialog().getByLabel('备注', { exact: true })).toHaveValue('CLIENT CONFLICT DRAFT');
  await demandDialog().getByRole('button', { name: '重新读取需求', exact: true }).click(); await demandDialog().getByRole('button', { name: '放弃修改并重新读取', exact: true }).click();
  await expect(demandDialog().getByLabel('备注', { exact: true })).toHaveValue('SERVER CONCURRENT NOTE'); await expect(demandDialog().getByLabel('修改原因', { exact: true })).toHaveValue(''); await expect(submitDemand()).toBeDisabled();
  await demandDialog().getByLabel('备注', { exact: true }).fill('CURRENT VERSION CRUD NOTE'); await demandDialog().getByLabel('修改原因', { exact: true }).fill('verified current version'); await submitDemand().click(); await expect(demandDialog()).not.toBeVisible();
  assert.equal(state.revisionBodies.at(-1).input.expectedVersion, 3); assert.notEqual(state.revisionBodies.at(-1).input.operationId, staleInput.operationId); assert.equal(target.version, 4); note();

  step = 'frozen-and-downstream-readonly-detail-use-latest-demand-not-frozen-row';
  await reset(); await expectGridValue('冻结原确认商品');
  await (await rowAction('FBA-SHARED-1', '查看需求')).click();
  await expect(demandDialog()).toContainText('CURRENT SERVER NOTE FOR FROZEN SHIPMENT'); await expect(demandDialog()).toContainText('LATEST-FC');
  await expect(demandDialog().getByRole('button', { name: '编辑需求', exact: true })).toBeDisabled(); await expect(demandDialog().getByRole('button', { name: '删除需求', exact: true })).toBeEnabled();
  await expect(demandDialog().getByRole('status')).toContainText('批次已冻结');
  await demandDialog().getByRole('button', { name: '关闭货件需求', exact: true }).click();
  await expectGridValue('SKU-1-0', true); await expect(table().locator('.shipping-grid-details')).toContainText('77');
  const writes = state.mutations.length; await (await rowAction('FBA-SHARED-4', '查看需求')).click();
  await expect(demandDialog().getByRole('status')).toContainText('已有下游单据或任务引用'); await expect(demandDialog().getByRole('button', { name: '编辑需求', exact: true })).toBeDisabled(); await expect(demandDialog().getByRole('button', { name: '删除需求', exact: true })).toBeEnabled();
  await demandDialog().getByRole('button', { name: '关闭货件需求', exact: true }).click(); assert.equal(state.mutations.length, writes); note();

  step = 'delete-confirmation-required-reason-and-retry-keep-payload-and-id';
  const deletion = () => page.getByRole('dialog', { name: '删除需求', exact: true });
  const deleteSubmit = () => deletion().getByRole('button', { name: '确认删除需求', exact: true });
  await filterDemands(fba); await (await rowAction(fba, '删除需求')).click(); await expect(deleteSubmit()).toBeDisabled();
  await expect(deletion().getByLabel('删除原因', { exact: true })).toHaveAttribute('maxlength', '2000');
  await deletion().getByLabel('删除原因', { exact: true }).fill('do not delete yet'); await deletion().getByRole('button', { name: '返回', exact: true }).click();
  assert.equal(state.cancelBodies.length, 0); await expect((await rowAction(fba, '编辑需求'))).toBeEnabled();
  await (await rowAction(fba, '删除需求')).click(); await deletion().getByLabel('删除原因', { exact: true }).fill('CRUD deletion requested'); await deletion().getByRole('checkbox').check();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await noOverflow();
    await page.screenshot({ path: resolve(evidence, `workbench-demand-delete-${width}.png`), fullPage: true });
    if (width !== 320) await page.screenshot({ path: resolve(evidence, `workbench-demand-delete-viewport-${width}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); state.holdNextMutation = 'trash'; state.nextFailure = { action: 'trash', code: 'QUEUE_UNAVAILABLE' };
  await deleteSubmit().click(); await expect.poll(() => Boolean(state.releaseMutation)).toBe(true); await expect(deletion().getByRole('button', { name: '关闭删除需求', exact: true })).toBeDisabled(); await expect(deletion().locator('button[type=submit]')).toBeDisabled(); state.releaseMutation();
  await expect(deletion().getByRole('alert')).toContainText('重试原请求'); await expect(deletion().getByLabel('删除原因', { exact: true })).toHaveValue('CRUD deletion requested');
  assert.equal(state.lifecycles.get(target.id), 'active'); const firstDelete = copy(state.cancelBodies.at(-1)); await deletion().getByRole('button', { name: '重试原请求', exact: true }).click(); await expect(deletion()).not.toBeVisible();
  assert.deepEqual(state.cancelBodies.at(-1), firstDelete); assert.equal(firstDelete.input.expectedVersion, 4); assert.equal(state.lifecycles.get(target.id), 'trashed');
  await expect(page.getByText('此范围暂无发货明细，请调整筛选或导入并提交需求。', { exact: true })).toBeVisible(); await expect(table()).toHaveCount(0); note();

  step = 'deleted-demand-is-in-recycle-bin-and-excluded-from-all-current-demand-filters';
  await page.getByRole('button', { name: '本次发货与票号', exact: true }).click();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  const recycle = page.getByRole('dialog', { name: '发货回收站', exact: true }); await recycle.getByRole('button', { name: '需求', exact: true }).click();
  await expect(recycle).toContainText(fba); await expect(recycle).toContainText('CRUD deletion requested'); await expect(recycle.getByRole('button', { name: '恢复需求', exact: true })).toBeVisible();
  await recycle.getByRole('button', { name: '关闭发货回收站', exact: true }).click();
  await page.getByRole('dialog', { name: '本次发货与票号', exact: true }).getByRole('button', { name: '关闭本次发货与票号', exact: true }).click();
  await chooseOption(form().getByLabel('需求记录状态', { exact: true }), 'all'); await closeRecord(); await form().getByRole('button', { name: '筛选', exact: true }).click(); await expect(table()).toHaveCount(0);
  await reset(); await expect.poll(() => state.queries.at(-1)?.lifecycle).toBe('active'); await expect.poll(() => state.queries.at(-1)?.page).toBe('1'); await expectGridAbsent(fba); note();
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'); viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200); browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  if (interactionsOnly) { const state = interactionFixture(), context = await contextFor(state); await interactionChecks(state); await context.close(); }
  if (entryOnly) { const context = await contextFor(fixture()); await entryChecks(); await context.close(); }
  if (!entryOnly && !interactionsOnly && process.env.SHIPPING_UNIFIED_CRUD_ONLY !== '1') {
    const scrollState = scrollFixture(), scrollContext = await contextFor(scrollState); await scopeScrollChecks(scrollState); await scrollContext.close();
    const state = fixture(), context = await contextFor(state); await unifiedNavigation(state); await presentationsAndSelections(state); await searchEligibility(state); await filtersAndScope(state); await exportChecks(state); await layoutChecks(); await context.close();
    const limits = await contextFor(limitFixture()); await limitChecks(); await limits.close();
    const interactionState = interactionFixture(), interactionContext = await contextFor(interactionState); await interactionChecks(interactionState); await interactionContext.close();
  }
  if (!entryOnly && !interactionsOnly) { activeCrudState = crudFixture(); const crudContext = await contextFor(activeCrudState); await crudChecks(activeCrudState); await crudContext.close(); }
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  activeCrudState?.releaseMutation?.();
  await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await writeFile(resolve(evidence, entryOnly ? 'entry-result.json' : 'result.json'), JSON.stringify({ kind: entryOnly ? 'fixture-only-shipping-entry-browser' : 'fixture-only-unified-shipping-table-browser', passed: !failed, checks, browserErrors, unexpectedRequests }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
