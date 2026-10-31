import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentOperationInputSchema, documentSchema, withDocumentInvoiceDefaults } from '../../packages/contracts/dist/index.js';
import { closeGridDetails, closeGridMenu, grid, gridRowCount, selectGridRow } from '../shared/grid.mjs';
import { chooseOption } from '../shared/ui-controls.mjs';
import { assertBottomNavigation, openRowMenu, setColumnVisible, visibleColumnKeys } from './grid-helpers.mjs';

// Local, deterministic HTTP fixtures. No real service, account or database is used.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.DOCUMENT_GRID_EVIDENCE_DIR || resolve(root, '.local/m4/document-grid'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-30T03:00:00.000Z', week = '2026-10-26', uid = () => randomUUID();
const label = '单据记录', tableKey = 'document-records', userA = 'document-grid-account-a', userB = 'document-grid-account-b';
const checks = [], browserErrors = [], unexpectedRequests = [], externalRequests = [], listReads = [], writes = [], heldReleases = [], viewportEvents = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup', userId = userA, nextDelete = 'ready', holdDelete = false, releaseDelete;
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };

function makeRecord(index) {
  const demandId = uid(), groupId = uid(), shipmentId = uid(), boxId = uid(), id = uid();
  const fba = 'FBADOCGRID' + String(index).padStart(3, '0');
  const product = { msku: 'GRID-' + index, fnsku: 'GRID-FN-' + index, sku: 'GRID-SKU-' + index, name: '单据表格技术商品', quantity: '100', expiration: null, prepOwner: null, labelOwner: null };
  const demand = { id: demandId, version: 1, snapshot: { sid: 101, fba, shop: 'Grid Fixture Shop', country: '美国', channel: 'SEA', destinationFc: 'GRID1', destinationAddress: '1 Fixture Road', referenceQuantity: '100', notes: null, subBatchName: null }, businessDate: week, weekStartDate: week, weekEndDate: '2026-11-01', createdAt: now, updatedAt: now };
  const shipment = { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: 101, fba, items: [product], boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, weight: '10', weightUnit: 'KG', length: '30', width: '20', height: '10', dimensionUnit: 'CM', items: [product] }], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'technical fixture', createdBy: 'fixture', createdAt: now };
  const members = [{ source: { weekStartDate: week, groupId, groupVersion: 1, m2ConfirmationId: uid(), demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null }, demand, shipment, codes: [{ id: uid(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: now }], physical: null }];
  return documentSchema.parse({ id, purpose: 'invoice', status: 'draft', version: 1, createdBy: 'fixture', createdAt: now, updatedAt: now,
    currentRevision: { id: uid(), documentId: id, version: 1, reason: 'technical fixture', createdBy: 'fixture', createdAt: now,
      data: { purpose: 'invoice', weekStartDate: week, shippingRunMonth: '2026-10', shippingRunSequence: 1, title: 'GRID-DOC-' + String(index).padStart(3, '0'), members,
        fields: { ...withDocumentInvoiceDefaults({ service: 'TECH SERVICE' }, members), orderNumber: 'GRID-ORDER-' + index }, profileReferences: [], templateReference: null, generationRulesVersion: 'v2' } } });
}
const records = Array.from({ length: 125 }, (_, index) => makeRecord(index + 1));
const panel = () => page.locator('.document-list-panel');
const target = () => grid(panel(), label);
const preferenceKey = (account = userId, key = tableKey) => `scm-documents-grid:v1:${account}:${key}`;
const filterKey = (account = userId) => `scm-documents-filters:v1:${account}:${tableKey}`;
const stored = (key) => page.evaluate((name) => JSON.parse(localStorage.getItem(name) ?? 'null'), key);
async function loaded(count) { await expect.poll(() => gridRowCount(panel(), label)).toBe(count); await expect(target().getByRole('grid')).toHaveAttribute('aria-busy', 'false'); }
async function open() { await page.goto('/shipping?view=documents', { waitUntil: 'domcontentloaded', timeout: 60_000 }); await target().getByRole('grid').waitFor({ state: 'visible' }); }
async function screenshot(name) { await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' }); }

async function setupRoutes(context) {
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL) { externalRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user: { id: userId, name: 'Document grid fixture', email: 'grid@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/documents/automations' && method === 'GET') return json({ items: [] });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (['/api/v1/document-profiles', '/api/v1/document-templates'].includes(path)) return json({ items: [] });
    if (path === '/api/v1/documents' && method === 'GET') {
      const size = Number(url.searchParams.get('pageSize') || 20), pageNumber = Number(url.searchParams.get('page') || 1);
      const q = url.searchParams.get('q') || '', status = url.searchParams.get('status') || 'active', month = url.searchParams.get('month') || '';
      assert([20, 50, 100].includes(size)); assert(pageNumber >= 1);
      listReads.push({ page: pageNumber, pageSize: size, q, status, month });
      const items = records.filter((record) => (status === 'all' || (status === 'active' ? !['cancelled', 'superseded'].includes(record.status) : record.status === status))
        && (!month || record.currentRevision.data.shippingRunMonth === month)
        && (!q || [record.id, record.currentRevision.data.title, record.currentRevision.data.fields.orderNumber, ...record.currentRevision.data.members.flatMap((member) => [member.demand.snapshot.fba, member.demand.snapshot.shop])].some((value) => value?.includes(q))));
      return json({ items: items.slice((pageNumber - 1) * size, pageNumber * size), total: items.length, page: pageNumber, pageSize: size });
    }
    const match = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(cancel|history))?$/);
    if (match) {
      const record = records.find((item) => item.id === match[1]); assert(record, 'only fixture document IDs may be requested');
      if (method === 'GET' && !match[2]) return json({ document: record, validation: null, exports: [] });
      if (method === 'GET' && match[2] === 'history') return json({ revisions: [record.currentRevision], reviews: [], validations: [] });
      if (method === 'POST' && match[2] === 'cancel') {
        const input = documentOperationInputSchema.parse(request.postDataJSON()); writes.push({ id: record.id, input });
        if (holdDelete) await new Promise((release) => { releaseDelete = () => { holdDelete = false; release(); }; heldReleases.push(releaseDelete); });
        if (nextDelete === '409') { nextDelete = 'ready'; record.version++; return json({ error: { code: 'DOCUMENT_VERSION_CONFLICT', message: '技术夹具：版本已变化。' } }, 409); }
        assert.equal(input.expectedVersion, record.version); record.status = 'cancelled'; record.version++;
        return json({ document: documentSchema.parse(record), replayed: false });
      }
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: method + ' ' + path } }, 500);
  });
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await setupRoutes(context); page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message)); await open();

  step = 'document-list-starts-with-collapsed-filters-explicit-utility-columns-and-bottom-navigation';
  await loaded(20); await expect(panel().getByRole('button', { name: '展示过滤条件', exact: true })).toBeVisible();
  await expect(panel().getByRole('textbox', { name: '搜索单据', exact: true })).not.toBeVisible();
  const keys = await visibleColumnKeys(panel(), label); assert.equal(keys[0], 'rowNumber'); assert.equal(keys.at(-1), 'actions'); assert(keys.includes('orderNumber'));
  await assertBottomNavigation(panel(), label); await expect(target().getByRole('combobox', { name: '每页单据数', exact: true })).toHaveAttribute('data-value', '20');
  await expect(target().locator('canvas')).toHaveCount(1); note();

  step = 'filter-disclosure-preserves-drafts-applied-count-and-visible-dirty-explanation';
  const readsBeforeDraft = listReads.length;
  await panel().getByRole('button', { name: '展示过滤条件', exact: true }).click();
  await panel().getByRole('textbox', { name: '搜索单据', exact: true }).fill('GRID-DOC-125');
  await panel().getByRole('button', { name: '隐藏过滤条件', exact: true }).click();
  await expect(panel()).toContainText('有未应用修改'); await expect(panel()).toContainText('当前仍按已应用条件显示'); await loaded(20);
  assert.equal(listReads.length, readsBeforeDraft); assert.equal((await stored(filterKey())).expanded, false);
  await panel().getByRole('button', { name: '展开过滤条件继续修改', exact: true }).click();
  await expect(panel().getByRole('textbox', { name: '搜索单据', exact: true })).toHaveValue('GRID-DOC-125');
  await panel().getByRole('button', { name: '搜索', exact: true }).click(); await loaded(1);
  assert.equal(listReads.at(-1).q, 'GRID-DOC-125'); await expect(panel()).toContainText('已应用 1 项过滤条件'); await expect(panel()).not.toContainText('有未应用修改');
  await panel().getByRole('button', { name: '隐藏过滤条件', exact: true }).click(); await loaded(1);
  await panel().getByRole('button', { name: '展示过滤条件', exact: true }).click(); await panel().getByRole('button', { name: '重置', exact: true }).click(); await loaded(20);
  await expect(panel()).toContainText('已应用 0 项过滤条件'); await page.reload(); await loaded(20); await expect(panel().getByRole('button', { name: '隐藏过滤条件', exact: true })).toBeVisible(); note();

  step = 'document-page-capacities-request-full-pages-and-reset-to-first-page';
  await target().getByRole('button', { name: '下一页', exact: true }).click(); await loaded(20);
  await expect.poll(() => listReads.at(-1).page).toBe(2); await expect(await selectGridRow(panel(), label, 0)).toContainText('GRID-DOC-021'); await closeGridDetails(panel(), label);
  for (const capacity of [50, 100]) {
    await chooseOption(target().getByRole('combobox', { name: '每页单据数', exact: true }), String(capacity)); await loaded(capacity);
    assert.deepEqual({ page: listReads.at(-1).page, pageSize: listReads.at(-1).pageSize }, { page: 1, pageSize: capacity });
    await expect(await selectGridRow(panel(), label, capacity - 1)).toContainText('GRID-DOC-' + String(capacity).padStart(3, '0')); await closeGridDetails(panel(), label);
  }
  await expect(target().locator('canvas')).toHaveCount(1); assert.equal((await stored(preferenceKey())).pageSize, 100);
  await page.reload(); await loaded(100); assert.equal(listReads.at(-1).pageSize, 100); note();

  step = 'column-picker-search-width-and-visibility-persist-without-business-data';
  await target().getByRole('grid').scrollIntoViewIfNeeded();
  const canvas = target().getByRole('grid'), bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + 48 + 260 + 250, bounds.y + 18); await page.mouse.down(); await page.mouse.move(bounds.x + 48 + 260 + 320, bounds.y + 18, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await stored(preferenceKey()))?.columnWidths?.id ?? 0).toBeGreaterThan(290);
  const resized = (await stored(preferenceKey())).columnWidths.id;
  await setColumnVisible(panel(), label, '单据编号', 'id', false); await setColumnVisible(panel(), label, '订单号', 'orderNumber', false);
  await page.reload(); await loaded(100); const hidden = await visibleColumnKeys(panel(), label); assert(!hidden.includes('id')); assert(!hidden.includes('orderNumber'));
  const saved = await stored(preferenceKey()); assert.equal(saved.columnWidths.id, resized); assert.equal(saved.pageSize, 100);
  assert.deepEqual(Object.keys(saved).sort(), ['columnWidths', 'hiddenColumnKeys', 'pageSize', 'version']);
  assert(!JSON.stringify(saved).includes(records[0].id)); await setColumnVisible(panel(), label, '单据编号', 'id', true);
  assert.equal((await stored(preferenceKey())).columnWidths.id, resized);
  await target().getByRole('button', { name: '列展示设置', exact: true }).click(); const picker = page.locator('.scm-column-picker:visible');
  await picker.getByRole('textbox', { name: '查找列', exact: true }).fill('单据名称'); await expect(picker.getByRole('checkbox', { name: /^单据名称/ })).toBeDisabled();
  await picker.getByRole('button', { name: '恢复默认列', exact: true }).click(); await expect.poll(async () => (await stored(preferenceKey())).hiddenColumnKeys).toEqual([]);
  assert.deepEqual((await stored(preferenceKey())).columnWidths, {}); assert.equal((await stored(preferenceKey())).pageSize, 100); await picker.press('Escape'); note();

  step = 'row-menu-summary-full-details-and-direct-delete-use-the-current-stable-document-id';
  let menu = await openRowMenu(panel(), label, 2); await expect(menu).toContainText('GRID-DOC-003'); await expect(menu).toHaveAttribute('data-grid-menu-row-key', records[2].id);
  await menu.getByRole('menuitem', { name: '完整详情', exact: true }).click(); await expect(menu).not.toBeVisible();
  await expect(target().getByRole('dialog', { name: '单据 GRID-DOC-003', exact: true })).toBeVisible(); await expect(await selectGridRow(panel(), label, 2)).toContainText('GRID-ORDER-3'); await closeGridDetails(panel(), label);
  menu = await openRowMenu(panel(), label, 2); await menu.getByRole('menuitem', { name: '删除单据', exact: true }).click(); await expect(menu).not.toBeVisible();
  const remove = page.getByRole('dialog', { name: '删除单据', exact: true }); await expect(remove).toBeVisible(); await expect(remove).toContainText('GRID-DOC-003');
  await remove.getByRole('button', { name: '保留单据', exact: true }).click(); await expect(remove).not.toBeVisible(); assert.equal(writes.length, 0); note();

  step = 'row-menu-closure-keeps-delete-confirmation-conflict-recovery-and-pending-escape-protection';
  nextDelete = '409'; menu = await openRowMenu(panel(), label, 3); await menu.getByRole('menuitem', { name: '删除单据', exact: true }).click();
  await remove.getByRole('textbox', { name: '删除原因', exact: true }).fill('技术验证：稳定 ID 与版本校验'); await remove.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(remove.getByRole('alert')).toContainText('版本已变化'); assert.equal(writes.at(-1).id, records[3].id);
  await expect(remove.getByRole('textbox', { name: '删除原因', exact: true })).toHaveValue('技术验证：稳定 ID 与版本校验');
  await remove.getByRole('button', { name: '重新读取删除目标', exact: true }).click(); await expect(remove.getByRole('button', { name: '确认删除', exact: true })).toBeEnabled();
  holdDelete = true; await remove.getByRole('button', { name: '确认删除', exact: true }).click(); await expect.poll(() => typeof releaseDelete).toBe('function');
  await remove.press('Escape'); await expect(remove).toBeVisible(); await expect(remove.getByRole('textbox', { name: '删除原因', exact: true })).toBeDisabled();
  releaseDelete(); await expect(remove).not.toBeVisible(); await loaded(100); assert.equal(writes.at(-1).input.expectedVersion, 2); assert.equal(records[3].status, 'cancelled'); note();

  step = 'middle-button-pan-moves-only-horizontal-content-without-opening-a-business-action';
  await closeGridMenu(panel(), label); await closeGridDetails(panel(), label);
  await canvas.scrollIntoViewIfNeeded(); await canvas.focus(); for (let index = 0; index < 20; index++) await canvas.press('ArrowLeft');
  const beforeRect = await canvas.boundingBox(), beforeY = await page.evaluate(() => scrollY), writeCount = writes.length;
  const clip = { x: Math.round(beforeRect.x + beforeRect.width * .64), y: Math.round(beforeRect.y + 36 + 18), width: 130, height: 24 };
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
  const beforePixels = digest(await page.screenshot({ clip }));
  await page.mouse.move(beforeRect.x + beforeRect.width * .75, beforeRect.y + 36 + 28); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(beforeRect.x + beforeRect.width * .4, beforeRect.y + 36 + 28, { steps: 12 }); await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => digest(await page.screenshot({ clip }))).not.toBe(beforePixels);
  assert.equal(await page.evaluate(() => scrollY), beforeY); assert.equal(writes.length, writeCount); await expect(page.getByRole('menu', { name: label + ' 行操作', exact: true })).not.toBeVisible(); note();

  step = 'document-filter-and-grid-preferences-are-isolated-by-account-and-table';
  await setColumnVisible(panel(), label, '订单号', 'orderNumber', false); const accountAPreferences = await stored(preferenceKey(userA));
  const openDocument = await openRowMenu(panel(), label, 0); await openDocument.getByRole('menuitem', { name: '查看单据', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: '发票与单据向导', exact: true }); await expect(wizard).toBeVisible();
  await wizard.getByRole('navigation', { name: '单据制作步骤', exact: true }).getByRole('button', { name: '单票资料', exact: true }).click();
  await expect(grid(wizard, '逐箱制单资料').getByRole('grid')).toHaveAttribute('aria-busy', 'false');
  assert((await visibleColumnKeys(wizard, '逐箱制单资料')).includes('weight'));
  await setColumnVisible(wizard, '逐箱制单资料', '毛重（KG）', 'weight', false);
  assert((await stored(preferenceKey(userA, 'box-adjustments'))).hiddenColumnKeys.includes('weight'));
  assert.deepEqual(await stored(preferenceKey(userA)), accountAPreferences);
  await wizard.getByRole('button', { name: '暂时关闭', exact: true }).click(); await expect(wizard).not.toBeVisible();
  userId = userB; await page.reload(); await loaded(20); assert((await visibleColumnKeys(panel(), label)).includes('orderNumber'));
  assert.equal(await stored(preferenceKey(userB, 'box-adjustments')), null);
  await expect(panel().getByRole('button', { name: '展示过滤条件', exact: true })).toBeVisible();
  await chooseOption(target().getByRole('combobox', { name: '每页单据数', exact: true }), '50'); await loaded(50);
  await setColumnVisible(panel(), label, '更新时间', 'updatedAt', false);
  userId = userA; await page.reload(); await loaded(100); assert.deepEqual(await stored(preferenceKey(userA)), accountAPreferences);
  const accountAKeys = await visibleColumnKeys(panel(), label); assert(!accountAKeys.includes('orderNumber')); assert(accountAKeys.includes('updatedAt'));
  assert.equal((await stored(preferenceKey(userB))).pageSize, 50); note();

  step = 'column-picker-row-menu-and-bottom-controls-fit-all-six-supported-viewports';
  page.on('console', (message) => { if (message.text().startsWith('[document-grid-event] ')) viewportEvents.push(JSON.parse(message.text().slice('[document-grid-event] '.length))); });
  await page.evaluate(() => {
    const report = (type, target) => console.debug('[document-grid-event] ' + JSON.stringify({ type, time: performance.now(), width: innerWidth, y: scrollY, target: target instanceof Element ? target.className : 'document', menu: Boolean(document.querySelector('[role="menu"][aria-label="单据记录 行操作"]')), picker: Boolean(document.querySelector('.scm-column-picker')), focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.className }));
    document.addEventListener('scroll', (event) => report('scroll', event.target), true);
    document.addEventListener('focusin', (event) => report('focusin', event.target), true);
    window.addEventListener('resize', (event) => report('resize', event.target));
    new ResizeObserver((entries) => report('canvas-resize', entries[0].target)).observe(document.querySelector('[data-grid-label="单据记录"] [role="grid"]'));
  });
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    console.log('VIEWPORT ' + width);
    await page.setViewportSize({ width, height: 1000 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await assertBottomNavigation(panel(), label); menu = await openRowMenu(panel(), label, 1);
    const menuBounds = await menu.boundingBox(); assert(menuBounds && menuBounds.x >= -1 && menuBounds.x + menuBounds.width <= width + 1, 'menu fits viewport ' + width);
    await screenshot('document-row-menu-' + width + '.png'); await menu.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(target().getByRole('button', { name: label + ' 查看当前记录', exact: true })).toBeFocused();
    const columnTrigger = target().getByRole('button', { name: '列展示设置', exact: true });
    await columnTrigger.click();
    const popup = page.locator('.scm-column-picker'); await expect(popup).toBeVisible();
    const popupBounds = await popup.boundingBox();
    assert(popupBounds && popupBounds.x >= -1 && popupBounds.x + popupBounds.width <= width + 1 && popupBounds.y >= -1 && popupBounds.y + popupBounds.height <= 1001, 'column picker fits viewport ' + width);
    const search = popup.getByRole('textbox', { name: '查找列', exact: true });
    await search.fill('订单'); await expect(search).toBeFocused();
    await screenshot('document-column-picker-' + width + '.png');
    // A screenshot must not dismiss the picker or let a previous menu steal focus.
    await expect(popup).toBeVisible(); await expect(search).toBeFocused();
    await search.press('Escape'); await expect(popup).not.toBeVisible(); await expect(columnTrigger).toBeFocused();
  }
  note(); assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  heldReleases.forEach((release) => release()); await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-document-grid-browser', passed: !failed,
    checks, browserErrors, unexpectedRequests, externalRequests, listReads, writes, viewportEvents, realBusinessWrites: 0, externalServiceRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
