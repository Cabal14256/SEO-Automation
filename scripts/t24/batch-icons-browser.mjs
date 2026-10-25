import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

// Every API response and mutation is an in-memory fixture; no accounts, database,
// external service, or deployed application is read or changed by this script.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.BATCH_ICONS_EVIDENCE_DIR || resolve(root, '.local/t28/batch-icons'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const uuid = () => randomUUID();
const now = '2026-10-18T04:00:00.000Z';
const ids = { batch: uuid(), group: uuid(), peer: uuid(), demand: uuid(), peerDemand: uuid(), revision: uuid(), confirmation: uuid(), sourceImport: uuid(), export: uuid(), export2: uuid(), file: uuid(), file2: uuid() };
const checks = []; const browserErrors = []; const unexpectedRequests = []; const reportPages = [];
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
const batch = { id: ids.batch, weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', version: 1, sortMode: 'manual', nextPrefix: 2, createdAt: now };
const demand = { id: ids.demand, snapshot: { sid: 1, fba: 'FBATECHICONS', shop: '界面技术样本店铺', country: '美国', channel: '空运', destinationFc: 'ONT8', referenceQuantity: '12', notes: null, subBatchName: null }, version: 1, businessDate: '2026-10-17', weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, createdAt: now, updatedAt: now };
const group = { id: ids.group, batchId: ids.batch, name: '图标技术样本第一组', version: 1, status: 'confirmed', position: 0, demandIds: [ids.demand], prefix: 'A', confirmedVersion: 1, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now };
const peer = { ...group, id: ids.peer, name: '图标技术样本第二组', position: 1, demandIds: [ids.peerDemand], prefix: 'B' };
const product = { msku: 'MSKU-ICONS', fnsku: 'FNSKU-ICONS', sku: 'SKU-ICONS', name: '浏览器图标测试商品', quantity: '12' };
const boxes = Array.from({ length: 12 }, (_, index) => ({ id: uuid(), externalBoxId: `platform-box-${index + 1}`, packageId: `package-${index + 1}`, localBoxId: String(index + 1), name: `技术箱 ${index + 1}`, order: index + 1, items: [{ msku: product.msku, fnsku: product.fnsku, sku: product.sku, quantity: '1' }], weight: '1', weightUnit: 'KG', length: '10', width: '20', height: '30', dimensionUnit: 'CM' }));
const revision = { id: ids.revision, demandId: ids.demand, version: 1, demandVersion: 1, data: { sid: 1, fba: demand.snapshot.fba, items: [product], boxes, isSta: false, staPlanId: null, observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: '隔离浏览器技术样本', createdBy: 'fixture', createdAt: now };
const confirmation = { id: ids.confirmation, groupId: ids.group, groupVersion: 1, snapshot: { members: [demand], shipments: [{ demandId: ids.demand, revision }], ruleVersion: 'fixture-v1' }, createdBy: 'fixture', createdAt: now };
const detail = { group, members: [demand], shipments: [{ demandId: ids.demand, revision }], issues: [], confirmation, codes: boxes.map((box, index) => ({ id: uuid(), groupId: ids.group, demandId: ids.demand, boxId: box.id, prefix: 'A', sequence: index + 1, code: `A${index + 1}`, valid: true, createdAt: now })), history: [] };
const workspace = { rows: [{ id: group.id, rowKind: 'group', batch, group, memberCount: 1, sids: [demand.snapshot.sid], shops: [demand.snapshot.shop], countries: [demand.snapshot.country], channels: [demand.snapshot.channel], fbas: [demand.snapshot.fba], status: group.status,
  sync: { syncedMemberCount: 1, staleMemberCount: 0, latestRun: null }, confirmation: { id: confirmation.id, groupVersion: confirmation.groupVersion, createdAt: confirmation.createdAt, current: true } }],
  total: 1, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [{ id: batch.id, weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate }], shops: [{ sid: demand.snapshot.sid, name: demand.snapshot.shop }], countries: [demand.snapshot.country], channels: [demand.snapshot.channel] } };
const refs = [{ groupId: ids.group, groupVersion: 1, confirmationId: ids.confirmation }];
const reportRow = { id: 'fixture-product-1', groupId: ids.group, groupName: group.name, confirmationId: ids.confirmation, weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate, businessDate: demand.businessDate, sid: 1, shop: demand.snapshot.shop, country: '美国', channel: '空运', destinationFc: 'ONT8', fba: demand.snapshot.fba, msku: product.msku, fnsku: product.fnsku, sku: product.sku, productName: product.name, quantity: 12, boxes: boxes.map((box, index) => ({ boxId: box.id, boxOrder: index + 1, code: `A${index + 1}`, quantity: 1 })), codes: boxes.map((_, index) => `A${index + 1}`), groupQuantity: 12, monthQuantity: 12, status: 'confirmed', actualShipDate: null, sourceObservedAt: now, dataRevisionId: ids.revision };
const report = { rows: [reportRow], boxes: boxes.map((box, index) => ({ groupId: ids.group, groupName: group.name, confirmationId: ids.confirmation, demandId: ids.demand, fba: demand.snapshot.fba, sid: 1, boxId: box.id, boxOrder: index + 1, code: `A${index + 1}`, boxName: box.name, boxExternalId: box.externalBoxId, localBoxId: box.localBoxId, weight: 1, weightUnit: 'KG', length: 10, width: 20, height: 30, lengthUnit: 'CM', items: [{ msku: product.msku, fnsku: product.fnsku, sku: product.sku, quantity: 1 }] })), total: 51, page: 1, pageSize: 50, maxBoxes: 12, confirmations: refs, blocked: [], generatedAt: now };
const completedExport = { id: ids.export, status: 'completed', groupIds: [ids.group], references: refs, month: '2026-10', region: 'US', fileId: ids.file, error: null, createdAt: now, completedAt: now, rowCount: 1, boxCount: 12, valid: true, invalidReason: null };
const exportRecords = [completedExport, { ...completedExport, id: ids.export2, fileId: ids.file2, createdAt: '2026-10-17T04:00:00.000Z' }];
let processHandle; let browser; let context; let failed = false; let groupReads = 0;
let heldAction = null; let releaseAction = null; let heldDownload = false; let releaseDownload = null;

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(url)).ok) return; } catch { /* Starting Vite. */ } await delay(100); }
  throw new Error('Isolated Vite did not start');
}
async function checkIcons(container) {
  const controls = container.locator('.icon-button:visible');
  assert(await controls.count() > 0, 'Expected visible icon controls');
  for (const control of await controls.all()) {
    const label = await control.getAttribute('aria-label');
    assert(label?.trim(), 'Icon control must have an accessible name');
    const bounds = await control.boundingBox();
    assert(bounds && bounds.width >= 44 && bounds.height >= 44, `${label}: target is smaller than 44 pixels`);
    assert.equal(await control.locator('svg[aria-hidden="true"], [aria-hidden="true"] svg').count(), 1, `${label}: one decorative icon expected`);
  }
}
async function checkShippingNavigation(page, current = '发货工作台') {
  const mobile = page.viewportSize().width < 768;
  if (mobile) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  const navigation = page.locator(mobile ? '#mobile-navigation .navigation' : '.sidebar .navigation');
  await expect(navigation.locator(':scope > a')).toHaveCount(2);
  await expect(navigation.getByRole('link', { name: '工作台', exact: true })).toHaveAttribute('href', '/');
  const shipping = navigation.getByRole('button', { name: '发货管理', exact: true });
  if (await shipping.getAttribute('aria-expanded') === 'true') await shipping.click();
  await expect(shipping).toHaveAttribute('aria-expanded', 'false');
  await shipping.click();
  await expect(shipping).toHaveAttribute('aria-expanded', 'true');
  const children = navigation.getByRole('navigation', { name: '发货管理子导航', exact: true });
  const shippingNavigation = [['发货工作台', 'demands'], ['发票与单据', 'documents'], ['领星单据与分配', 'fulfillment'], ['物流与交接', 'logistics'], ['报关与 9810', 'customs'], ['批次归档', 'archives']];
  await expect(children.getByRole('link')).toHaveCount(shippingNavigation.length);
  for (const [label, view] of shippingNavigation) {
    const link = children.getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute('href', `/shipping?view=${view}`);
    if (label === current) await expect(link).toHaveAttribute('aria-current', 'page');
    else await expect(link).not.toHaveAttribute('aria-current', 'page');
  }
  await expect(children.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(navigation.locator('a[href="/settings"]')).toHaveCount(0);
  if (mobile) {
    await expect(page.locator('.account-controls').getByRole('link', { name: '设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭导航', exact: true }).click();
    await expect(page.locator('#mobile-navigation')).toHaveCount(0);
  } else await expect(page.locator('.sidebar-foot a[href="/settings"]')).toHaveAccessibleName('设置');
}
async function checkTooltip(page, trigger, { dialog = false } = {}) {
  await trigger.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await trigger.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  const label = await trigger.getAttribute('aria-label');
  await expect(tooltip).toContainText(label);
  const bounds = await tooltip.boundingBox(); const viewport = page.viewportSize();
  assert(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, 'Tooltip stays inside the viewport');
  assert.equal(await tooltip.evaluate((node) => node.matches(':popover-open')), true, 'Tooltip enters the browser top layer');
  assert.equal(await tooltip.evaluate((node) => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true, 'Tooltip is not occluded by a table or modal');
  if (dialog) assert.equal(await tooltip.evaluate((node) => Boolean(node.closest('dialog[open]'))), true, 'Modal tooltip is attached inside its dialog');
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
}

try {
  await mkdir(evidence, { recursive: true });
  const contracts = await import(pathToFileURL(resolve(root, 'packages/contracts/dist/index.js')).href);
  contracts.weeklyBatchListSchema.parse({ items: [batch], availableWeeks: [] });
  contracts.weeklyBatchDetailSchema.parse({ batch, groups: [group, peer], ungrouped: [] });
  contracts.subBatchDetailSchema.parse(detail);
  contracts.batchWorkspaceSchema.parse(workspace);
  contracts.reportResponseSchema.parse(report);
  exportRecords.forEach((record) => contracts.reportExportRecordSchema.parse(record));
  note('Isolated batch, shipment, report and export fixtures satisfy the shared contracts');
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  const baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  processHandle = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await waitForServer(baseURL);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.fixturePanelAnimations = 0;
    document.addEventListener('animationstart', (event) => { if (event.animationName === 'motion-fade' && event.target.classList.contains('motion-panel')) window.fixturePanelAnimations += 1; });
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(`${request.method()} EXTERNAL ${url.origin}`); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user: { id: 'fixture-admin', name: '图标浏览器技术验证', email: 'icons@acceptance.invalid', role: 'admin' } });
    if (path === '/api/v1/batches/workspace') return json(workspace);
    if (path === '/api/v1/weekly-batches') return json({ items: [batch], availableWeeks: [] });
    if (path === `/api/v1/weekly-batches/${ids.batch}`) return json({ batch, groups: [group, peer], ungrouped: [] });
    if (path === `/api/v1/sub-batches/${ids.group}`) { groupReads += 1; return json(detail); }
    if (path === `/api/v1/batch-sync/${ids.group}`) return json({ runs: [] });
    if (path === '/api/v1/batch-reports') { const page = Number(url.searchParams.get('page') || 1); reportPages.push(page); return json({ ...report, page, rows: [{ ...reportRow, id: `fixture-product-${page}`, productName: page === 1 ? product.name : '第二页技术样本商品' }] }); }
    if (path === '/api/v1/batch-reports/exports') {
      if (request.method() === 'GET') return json({ items: exportRecords });
      if (heldAction === 'export') await new Promise((done) => { releaseAction = done; });
      return json({ export: completedExport }, 202);
    }
    if ([`/api/v1/files/${ids.file}/download`, `/api/v1/files/${ids.file2}/download`].includes(path)) {
      if (heldDownload) await new Promise((done) => { releaseDownload = done; });
      return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('isolated download fixture') });
    }
    if ([`/api/v1/sub-batches/${ids.group}/actual-ship-date`, `/api/v1/sub-batches/${ids.group}/print`].includes(path)) {
      if (heldAction === 'date' || heldAction === 'print') await new Promise((done) => { releaseAction = done; });
      return json({ operationId: request.postDataJSON().operationId, groupId: ids.group, replayed: false });
    }
    if (path === `/api/v1/demands/${ids.demand}`) return json({ demand, revisions: [], sources: [] });
    if (path === '/api/v1/demands') return json({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 50, maxBoxes: 10, filters: { batches: [], shops: [], countries: [], channels: [] }, generatedAt: now });
    if (path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: { mode: 'manual', version: 1, catalogVersion: 1, lastSyncedAt: now, lastError: null, configured: true, readOnly: true } });
    unexpectedRequests.push(`${request.method()} ${path}`);
    return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: `Unexpected isolated fixture request: ${path}` } }, 404);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/batches');
  await checkShippingNavigation(page);
  const enter = page.getByRole('link', { name: '查看批次详情', exact: true });
  await expect(enter).toHaveAttribute('href', `/batches/${ids.batch}?groupId=${ids.group}`);
  await expect(enter).toHaveText('');
  await checkIcons(page);
  await enter.click();
  await checkShippingNavigation(page);
  const groupTable = page.getByRole('region', { name: '人工子批次，可横向滚动', exact: true });
  const firstRow = groupTable.getByRole('row').filter({ hasText: group.name });
  await expect(firstRow.getByRole('button', { name: '上移', exact: true })).toBeDisabled();
  await expect(firstRow.getByRole('button', { name: '下移', exact: true })).toBeEnabled();
  const view = firstRow.getByRole('button', { name: '查看并处理', exact: true });
  await checkTooltip(page, view);
  await view.click();
  await expect(view).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('heading', { name: '商品、逐箱数量与差异处理', exact: true }).waitFor();
  await checkIcons(page);
  note('Weekly links, sub-batch view and reorder icons retain accessible names, link destinations and selection states');

  await page.getByRole('tab', { name: '来源、历史与登记', exact: true }).click();
  const dateField = page.getByLabel('实际发货日期（本地登记）', { exact: true });
  await dateField.fill('2026-10-20');
  await dateField.evaluate((node) => { node.dataset.fixtureIdentity = 'preserved'; });
  await expect.poll(() => page.evaluate(() => window.fixturePanelAnimations)).toBeGreaterThan(0);
  const animationCount = await page.evaluate(() => window.fixturePanelAnimations);
  const readsBefore = groupReads;
  await expect.poll(() => groupReads, { timeout: 6000 }).toBeGreaterThan(readsBefore);
  await expect(dateField).toHaveValue('2026-10-20');
  await expect(dateField).toHaveAttribute('data-fixture-identity', 'preserved');
  assert.equal(await page.evaluate(() => window.fixturePanelAnimations), animationCount, 'Polling must not replay tab entry animation');
  const print = page.getByRole('button', { name: '登记打印事实', exact: true });
  await expect(print).toHaveText('登记打印事实');
  await page.getByLabel('本次登记 / 更正说明（必填）', { exact: true }).fill('隔离技术验证，无真实登记');
  await page.getByRole('checkbox', { name: '我已在线下完成当前确认版本的打印操作。', exact: true }).check();
  const saveDate = page.getByRole('button', { name: '保存日期', exact: true });
  heldAction = 'date'; await saveDate.click();
  await expect(saveDate).toHaveAttribute('aria-busy', 'true');
  await expect(print).toBeDisabled();
  assert.equal(await print.getAttribute('aria-busy'), null, 'A different action must not display the active spinner');
  await expect.poll(() => Boolean(releaseAction)).toBe(true);
  heldAction = null; releaseAction(); releaseAction = null;
  await expect(saveDate).not.toHaveAttribute('aria-busy', 'true');
  await expect(print).toBeEnabled();
  note('Tab entry animation is not replayed by polling, existing date input survives, and only the active registration button spins');

  await page.goto(`/batches/${ids.batch}?groupId=${ids.group}&tab=reports`);
  await checkShippingNavigation(page);
  const generate = page.getByRole('button', { name: '生成发货表 XLSX', exact: true, includeHidden: true });
  await expect(generate).toHaveText('生成发货表 XLSX');
  const reportTable = page.getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true });
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(reportTable).toContainText('第二页技术样本商品');
  assert(reportPages.includes(2));
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(reportTable).toContainText(product.name);
  await reportTable.locator('tbody').getByRole('checkbox').first().check();
  heldAction = 'export'; await generate.click();
  await expect(generate).toHaveAttribute('aria-busy', 'true');
  const historyButton = page.getByRole('button', { name: '发货表导出记录', exact: true });
  await historyButton.click();
  const historyDialog = page.getByRole('dialog', { name: '导出记录', exact: true });
  await expect(historyDialog).toBeVisible();
  const downloads = historyDialog.getByRole('button', { name: '下载 XLSX', exact: true });
  await expect(downloads).toHaveCount(2);
  await expect(downloads.first()).toHaveText('');
  for (const download of await downloads.all()) { await expect(download).toBeDisabled(); assert.equal(await download.getAttribute('aria-busy'), null); }
  await expect.poll(() => Boolean(releaseAction)).toBe(true);
  heldAction = null; releaseAction(); releaseAction = null;
  await expect(generate).not.toHaveAttribute('aria-busy', 'true');
  heldDownload = true; const downloading = page.waitForEvent('download'); await downloads.first().click();
  await expect(downloads.first()).toHaveAttribute('aria-busy', 'true');
  await expect(downloads.nth(1)).toBeDisabled();
  assert.equal(await downloads.nth(1).getAttribute('aria-busy'), null);
  await expect(generate).toBeDisabled(); assert.equal(await generate.getAttribute('aria-busy'), null);
  await expect.poll(() => Boolean(releaseDownload)).toBe(true);
  heldDownload = false; releaseDownload(); releaseDownload = null;
  assert((await downloading).suggestedFilename().endsWith('.xlsx'));
  await expect(downloads.first()).not.toHaveAttribute('aria-busy', 'true');
  await checkTooltip(page, downloads.first());
  await page.keyboard.press('Escape');
  await expect(historyDialog).not.toBeVisible();
  await expect(historyButton).toBeFocused();
  note('Report icon pagination and dialog downloads work; shared busy state spins only the selected action and Escape restores toolbar focus');

  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await checkIcons(page);
    await reportTable.scrollIntoViewIfNeeded(); await reportTable.focus();
    await reportTable.evaluate((node) => { node.scrollLeft = 0; });
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => reportTable.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await page.screenshot({ path: resolve(evidence, `report-${width}.png`) });
  }
  note('Reports fit 1440/1024/768/390/320-pixel viewports with 44-pixel icon targets and keyboard-scrollable wide tables');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/batches/${ids.batch}`);
  const narrowTable = page.getByRole('region', { name: '人工子批次，可横向滚动', exact: true });
  const narrowView = narrowTable.getByRole('button', { name: '查看并处理', exact: true }).first();
  await narrowView.click();
  const shipmentTable = page.getByRole('region', { name: '多口径商品数量，可横向滚动', exact: true });
  await expect(shipmentTable).toBeVisible();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await checkIcons(page);
    if (width <= 768) {
      await shipmentTable.scrollIntoViewIfNeeded(); await shipmentTable.focus();
      await shipmentTable.evaluate((node) => { node.scrollLeft = 0; }); await page.keyboard.press('ArrowRight');
      await expect.poll(() => shipmentTable.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    }
    await page.getByRole('tab', { name: '同步与商品 / 箱', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(evidence, `batch-${width}.png`) });
  }
  note('Weekly/sub-batch workspace fits all five viewports and shipment tables remain keyboard-scrollable on narrow screens');
  await page.setViewportSize({ width: 390, height: 900 });
  await checkTooltip(page, narrowView);
  await page.mouse.move(0, 0); await narrowView.hover(); await expect(page.getByRole('tooltip')).toBeVisible();
  await narrowTable.evaluate((node) => { node.scrollLeft = Math.max(0, node.scrollLeft - 30); });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  note('A row-action tooltip escapes the narrow scrolling table and dismisses when the table scrolls');

  await page.goto('/imports');
  await checkShippingNavigation(page);
  await page.getByRole('button', { name: '导入记录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入记录', exact: true });
  await expect(dialog).toBeVisible();
  await checkTooltip(page, dialog.getByRole('button', { name: '关闭导入记录', exact: true }), { dialog: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  note('Tooltip stays above the native dialog; first Escape dismisses the tooltip and the next closes the dialog');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/batches/${ids.batch}`);
  await page.getByRole('button', { name: '查看并处理', exact: true }).first().click();
  await expect(page.locator('.motion-panel')).toBeVisible();
  assert.equal(await page.locator('.motion-panel').evaluate((node) => getComputedStyle(node).animationName), 'none');
  note('Reduced-motion preference removes batch tab animation without hiding content');
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(unexpectedRequests, []);
} catch (error) {
  failed = true; console.error(error);
  if (context?.pages()[0]) await context.pages()[0].screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  releaseAction?.(); releaseDownload?.();
  await browser?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill(); await Promise.race([new Promise((done) => processHandle.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-batch-icons-browser', passed: !failed, checks, browserErrors, unexpectedRequests }, null, 2));
}
if (failed) process.exitCode = 1;
