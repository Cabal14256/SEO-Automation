import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { emptyOnlineRow, hasOnlineContent, parsePastedCells } from '../../apps/web/src/features/online-import-grid.ts';
import { chooseOption } from '../shared/ui-controls.mjs';

// UI fixtures isolate these checks from business databases and external APIs.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.IMPORT_WORKSPACE_EVIDENCE_DIR || resolve(root, '.local/import-auto-upload/regression/workspace'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const uuid = () => randomUUID();
const now = new Date().toISOString();
const ids = { batch: uuid(), group: uuid(), demand: uuid(), import: uuid(), file: uuid(), run: uuid(), lookup: uuid() };
const checks = []; const browserErrors = []; const demandRequests = []; const lookupBodies = []; const onlineBodies = []; const uploadBodies = [];
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
const candidate = (sid, shop) => ({ sid, shop, country: '美国', channel: '空运', channelStatus: 'unique', channelOptions: [{ name: '空运', shipmentNumbers: [], channelIds: [], methodNames: ['空运'] }], destinationFc: 'ONT8', destinationAddress: 'DEMO WAREHOUSE ADDRESS, TEST CITY, US', shipmentCreatedAt: '2026-09-20T08:00:00Z', observedAt: now });
const run = { id: ids.run, importId: ids.import, status: 'queued', inputVersion: 1, mappingVersion: 'online-v1', sheetName: '在线表格', parserVersion: 'xlsx-preview-v1', processedRows: 0, counts: { totalRows: 0, validFbaRows: 0, errorRows: 0, warningRows: 0 }, issues: [], errorCode: null, errorMessage: null, createdAt: now, startedAt: null, completedAt: null };
const sourceImport = { id: ids.import, fileId: ids.file, sourceType: 'online', submissionStatus: 'partially_submitted', submittedSourceRows: 2, originalName: '在线需求-技术测试.xlsx', sha256: '0'.repeat(64), byteSize: 1024, createdBy: 'technical-ui', importedAt: now, businessDate: '2026-10-17', datePolicyVersion: 'import-date-shanghai-v1', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', status: 'queued', version: 1, sheets: [], latestRun: run };
const baseRow = {
  id: 'placeholder', demandId: ids.demand, rowKind: 'placeholder', demandVersion: 1, currentDemandVersion: 1,
  businessDate: '2026-10-17', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', sid: 1, shop: '示例店铺 A', country: '美国', channel: '空运', destinationFc: 'ONT8', destinationAddress: 'Address for UI test',
  fba: 'FBATECH1', msku: null, fnsku: null, sku: null, productName: null, quantity: null, referenceQuantity: '30', totalBoxes: null, boxes: [], codes: [], status: 'unsynced', groupId: null, groupName: null, groupVersion: null, batchId: ids.batch, confirmationId: null, dataRevisionId: null, dataVersion: null,
  actualShipDate: null, shipmentCreatedAt: '2026-09-20T08:00:00Z', sourceFilledAt: '2026-10-16', packingDays: null, metadataSource: 'online', metadataObservedAt: now, notes: null, issues: [], sources: [{ importId: ids.import, fileName: '在线需求-技术测试.xlsx', sheetName: '在线表格', rowNumber: 2 }],
};
const rows = [baseRow,
  { ...baseRow, id: 'candidate', demandId: uuid(), rowKind: 'product', fba: 'FBATECH2', productName: '候选商品', msku: 'MSKU-CANDIDATE', fnsku: 'FN-CANDIDATE', sku: 'SKU-CANDIDATE', quantity: 12, totalBoxes: 2, boxes: [{ boxId: uuid(), boxOrder: 1, quantity: 7, code: null }, { boxId: uuid(), boxOrder: 2, quantity: 5, code: null }], status: 'candidate', groupId: ids.group, groupName: '十月第一批', groupVersion: 1, dataRevisionId: uuid(), dataVersion: 1, shipmentCreatedAt: '2026-09-20 08:09:10' },
  { ...baseRow, id: 'frozen', demandId: uuid(), rowKind: 'product', fba: 'FBATECH3', productName: '已冻结商品', msku: 'MSKU-FROZEN', fnsku: 'FN-FROZEN', sku: 'SKU-FROZEN', quantity: 20, totalBoxes: 12, boxes: [{ boxId: uuid(), boxOrder: 12, quantity: 20, code: 'A12' }], codes: ['A12'], status: 'frozen', groupId: ids.group, groupName: '十月第一批', groupVersion: 2, confirmationId: uuid(), dataRevisionId: uuid(), dataVersion: 1, metadataSource: `lingxing:${uuid()}` },
];
const filters = { batches: [{ id: ids.batch, weekStartDate: '2026-10-12', weekEndDate: '2026-10-18' }], shops: [{ sid: 1, name: '示例店铺 A' }, { sid: 2, name: '示例店铺 B' }], countries: ['美国'], channels: ['空运'] };
let processHandle; let browser; let context; let lookupRecord; let lookupRelease; let holdLookup = false; let failed = false;
let holdDemands = false; let importReads = 0;
const demandReleases = [];
const lookupResult = (fba) => ({ fba, status: fba === 'FBAONLINE1' || fba === 'FBAOLD' ? 'unique' : fba === 'FBAONLINE2' ? 'ambiguous' : 'not_found', candidates: fba === 'FBAONLINE1' || fba === 'FBAOLD' ? [candidate(1, '示例店铺 A')] : fba === 'FBAONLINE2' ? [candidate(1, '示例店铺 A'), candidate(2, '示例店铺 B')] : [] });
async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(url)).ok) return; } catch { /* Starting */ } await delay(100); }
  throw new Error('Vite did not start');
}
async function paste(cell, text) {
  await cell.evaluate((node, value) => { const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value); node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })); }, text);
}
async function checkIconTargets(container) {
  const controls = container.locator('.icon-button:visible');
  assert(await controls.count() > 0, 'Expected visible icon controls');
  for (const control of await controls.all()) {
    const name = await control.getAttribute('aria-label');
    assert(name?.trim(), 'Icon controls must keep a nonempty accessible name');
    const box = await control.boundingBox();
    assert(box && box.width >= 44 && box.height >= 44, `${name}: icon target must be at least 44 x 44`);
    assert.equal(await control.locator('svg[aria-hidden="true"], [aria-hidden="true"] svg').count(), 1, `${name}: decorative icon must be hidden from assistive technology`);
  }
}
async function checkTooltipBounds(page) {
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  const viewport = page.viewportSize();
  assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'Tooltip must stay within the viewport');
}
try {
  await mkdir(evidence, { recursive: true });
  assert.deepEqual(parsePastedCells('FBA1\t"a\tb"\t"note\nline"\r\nFBA2\t"say ""yes"""\t\r\n'), [['FBA1', 'a\tb', 'note\nline'], ['FBA2', 'say "yes"', '']]);
  assert.equal(hasOnlineContent(emptyOnlineRow()), false); assert.equal(hasOnlineContent({ ...emptyOnlineRow(), notes: '备注' }), true);
  note('TSV preserves quoted tabs, multiline cells, literal quotes, and empty cells');
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  const baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  processHandle = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await waitForServer(baseURL);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }); });
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '技术界面检查', email: 'ui@acceptance.invalid', role: 'admin' } });
    if (path === '/api/v1/demands') {
      demandRequests.push(Object.fromEntries(url.searchParams));
      if (holdDemands) await new Promise((done) => { demandReleases.push(done); });
      const page = Number(url.searchParams.get('page') || 1); const q = url.searchParams.get('q');
      const resultRows = q ? rows.filter((row) => `${row.productName} ${row.fba}`.includes(q)) : page === 1 ? rows : [rows[2]];
      return json({ rows: resultRows, total: q ? resultRows.length : 53, demandTotal: q ? resultRows.length : 53, page, pageSize: 20, maxBoxes: 12, filters, generatedAt: now });
    }
    if (path === '/api/v1/batches/workspace') return json({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { ...filters, weeks: [] } });
    if (path === '/api/v1/batch-reports') return json({ rows: [], boxes: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, confirmations: [], blocked: [], generatedAt: now });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: { mode: 'manual', version: 1, catalogVersion: 2, lastSyncedAt: now, lastError: null, configured: true, readOnly: true } });
    if (path === '/api/v1/imports/fba-lookups' && request.method() === 'POST') {
      const body = request.postDataJSON(); lookupBodies.push(body);
      lookupRecord = { id: uuid(), status: 'queued', startDate: body.startDate, endDate: body.endDate, fbas: body.fbas, catalogMode: 'manual', catalogSettingsVersion: 1, catalogVersion: 2, createdAt: now, completedAt: null, errorCode: null, errorMessage: null, rows: [] };
      return json(lookupRecord, 202);
    }
    if (path.startsWith('/api/v1/imports/fba-lookups/')) {
      const record = { ...lookupRecord, status: 'completed', completedAt: now, rows: lookupRecord.fbas.map(lookupResult) };
      if (holdLookup) await new Promise((done) => { lookupRelease = done; });
      return json(record);
    }
    if (path === '/api/v1/imports/online') { onlineBodies.push(request.postDataJSON()); return json({ import: sourceImport, run, taskId: uuid(), taskUrl: `/api/v1/imports/${ids.import}`, replayed: false, deduplicated: false }, 202); }
    if (path === '/api/v1/imports' && request.method() === 'POST') { uploadBodies.push(request.postDataBuffer()); return json({ error: { code: 'INVALID_WORKBOOK', message: '技术夹具：工作簿内容无效，保留文件继续编辑。' } }, 422); }
    if (path === '/api/v1/imports') return json({ items: [sourceImport, { ...sourceImport, id: uuid(), sourceType: 'xlsx', originalName: '文件来源.xlsx', submissionStatus: 'submitted', submittedSourceRows: 8 }], total: 2, page: 1, pageSize: 10 });
    if (path === `/api/v1/imports/${ids.import}`) {
      importReads += 1;
      return json({ import: { ...sourceImport, status: 'parsing', latestRun: { ...run, status: 'running', processedRows: importReads } } });
    }
    if (path.endsWith('/runs')) return json({ items: [] });
    return json({ error: { code: 'NOT_FOUND', message: `Unhandled UI fixture: ${path}` } }, 404);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/shipping?view=demands');
  await expect(page.getByRole('heading', { name: '发货工作台', level: 1, exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const sidebar = page.locator('.sidebar');
  const shippingNavigation = sidebar.getByRole('navigation', { name: '发货管理子导航', exact: true });
  const shippingLabels = ['发货工作台', '实物箱确认', '发票与单据', '领星单据与分配', '物流与交接', '报关与 9810', '批次归档'];
  assert.deepEqual(await shippingNavigation.getByRole('link').allTextContents(), shippingLabels);
  await expect(shippingNavigation.getByRole('link', { name: '发货工作台', exact: true })).toHaveAttribute('aria-current', 'page');
  const businessNavigation = sidebar.getByRole('navigation', { name: '业务导航', exact: true });
  const shippingParent = businessNavigation.getByRole('button', { name: '发货管理', exact: true });
  await expect(businessNavigation.getByRole('link', { name: '工作台', exact: true })).toBeVisible();
  await expect(businessNavigation.getByRole('link', { name: '发货管理', exact: true })).toHaveCount(0);
  await expect(shippingParent).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('navigation', { name: '发货工作区', exact: true })).toHaveCount(0);
  note('Unified shipping shell exposes the workbench and fulfillment workspaces under one shipping sidebar parent');
  await shippingParent.click(); await expect(shippingParent).toHaveAttribute('aria-expanded', 'false');
  await expect(shippingNavigation).not.toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/shipping' && url.searchParams.get('view') === 'demands');
  await shippingParent.click(); await expect(shippingNavigation).toBeVisible();
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click(); await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await shippingParent.click(); await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  await expect(shippingParent).toHaveAttribute('aria-expanded', 'true'); await expect(shippingNavigation).toBeVisible();
  await page.screenshot({ path: resolve(evidence, 'shipping-sidebar-1440.png'), animations: 'disabled' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    const mobileNavigation = page.locator('#mobile-navigation');
    const mobileShipping = mobileNavigation.getByRole('navigation', { name: '发货管理子导航', exact: true });
    assert.deepEqual(await mobileShipping.getByRole('link').allTextContents(), shippingLabels);
    await expect(mobileNavigation.getByRole('button', { name: '发货管理', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: resolve(evidence, `shipping-mobile-navigation-${width}.png`), animations: 'disabled' });
    await mobileShipping.getByRole('link', { name: '发货工作台', exact: true }).click();
    await expect(mobileNavigation).not.toBeVisible();
    await expect(page.getByRole('button', { name: '打开导航', exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  note('Shipping parent toggles subitems, compact parent expands the sidebar, and mobile subitems navigate and close the menu');
  const table = page.getByRole('region', { name: '发货明细表，可横向滚动', exact: true });
  await chooseOption(page.getByLabel('展示方式', { exact: true }), 'products');
  await table.locator('.demand-product-name').filter({ hasText: '已冻结商品' }).waitFor();
  const headers = await table.locator('thead th').allTextContents();
  assert.deepEqual(headers.slice(0, 5), ['货件 / 批次 / 目的仓', '店铺 / 国家 / 渠道', 'MSKU / FNSKU', '品名 / SKU', '商品数量']);
  assert(headers.includes('箱 12')); assert.equal(await table.locator('tbody tr').count(), 3);
  assert.equal(await table.getByText('待同步商品 / 逐箱数据', { exact: true }).count(), 1);
  assert(!(await table.innerText()).includes('lingxing:'));
  for (const summary of await table.locator('.shipping-source-details > summary').all()) await summary.click();
  assert((await table.innerText()).includes('2026-09-20 08:09:10'));
  note('Workspace renders shipment placeholders, candidate products, frozen products, source labels, and all box columns');
  await checkIconTargets(page);
  const shipmentLink = table.getByRole('link', { name: '查看货件', exact: true }).first();
  assert((await shipmentLink.getAttribute('href')).includes(`/batches/${ids.batch}`));
  await page.keyboard.press('Tab'); await shipmentLink.focus(); await checkTooltipBounds(page);
  await expect(page.getByRole('tooltip')).toContainText('FBATECH2');
  await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0);
  const refresh = page.getByRole('button', { name: '刷新工作区', exact: true });
  await refresh.hover(); await checkTooltipBounds(page);
  await expect(page.getByRole('tooltip')).toContainText('刷新工作区');
  await page.mouse.move(0, 0); await page.getByLabel('搜索', { exact: true }).focus();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  note('Icon controls retain accessible names, 44px targets, object descriptions, real links, and hover/keyboard tooltips');
  const refreshElement = await refresh.elementHandle();
  const refreshBox = await refresh.boundingBox(); const requestsBeforeRefresh = demandRequests.length;
  holdDemands = true; await refresh.click();
  await expect.poll(() => demandReleases.length).toBe(1);
  assert.equal(await refreshElement.getAttribute('aria-busy'), 'true');
  assert.equal(await refreshElement.isDisabled(), true);
  assert.deepEqual(await refreshElement.boundingBox(), refreshBox, 'Loading must not change the icon button dimensions or location');
  await refreshElement.evaluate((node) => { node.click(); node.click(); });
  await delay(100); assert.equal(demandRequests.length, requestsBeforeRefresh + 1, 'A busy refresh must not start duplicate requests');
  const refreshSpinner = page.locator('.shipping-unified-toolbar .motion-spin');
  await expect(refreshSpinner).toHaveCount(1);
  assert.notEqual(await refreshSpinner.evaluate((node) => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await refreshSpinner.evaluate((node) => getComputedStyle(node).animationName), 'none');
  assert.equal(await refreshElement.getAttribute('aria-label'), '刷新工作区');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  holdDemands = false; demandReleases.splice(0).forEach((release) => release());
  await expect(refresh).toBeEnabled();
  note('Manual refresh keeps its size, disables duplicate requests, and stops continuous motion when reduced motion is requested');
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.getByText('第 2 页', { exact: false }).waitFor();
  await page.getByLabel('搜索', { exact: true }).fill('候选商品'); await page.getByRole('button', { name: '筛选', exact: true }).click();
  await table.locator('.demand-product-name').filter({ hasText: '候选商品' }).waitFor(); assert.equal(await table.locator('tbody tr').count(), 1); assert.equal(demandRequests.at(-1).page, '1'); assert.equal(demandRequests.at(-1).q, '候选商品');
  await page.getByRole('button', { name: '重置', exact: true }).click(); await table.locator('.demand-product-name').filter({ hasText: '已冻结商品' }).waitFor();
  note('Server filters and pagination reset to the first page');
  await page.getByRole('button', { name: '导入记录', exact: true }).click();
  const records = page.getByRole('dialog', { name: '导入记录', exact: true });
  await records.locator('tbody').getByText('在线填写', { exact: false }).waitFor(); await records.getByText('部分提交', { exact: false }).waitFor(); await records.getByText('有效项已提交', { exact: false }).waitFor();
  await page.keyboard.press('Tab'); await records.getByRole('button', { name: '关闭导入记录', exact: true }).focus();
  await checkTooltipBounds(page); await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  assert.equal(await records.evaluate((node) => node.open), true, 'Escape dismisses a focused tooltip before closing its dialog');
  await page.keyboard.press('Escape'); await records.waitFor({ state: 'hidden' }); assert.equal(await page.getByRole('button', { name: '导入记录', exact: true }).evaluate((node) => node === document.activeElement), true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: '导入记录', exact: true }).click();
    await records.getByRole('button', { name: '关闭导入记录', exact: true }).click();
    await page.getByRole('button', { name: '导入记录', exact: true }).click();
    assert.equal(await records.evaluate((node) => node.open), true);
    await records.getByRole('button', { name: '关闭导入记录', exact: true }).click();
    await records.waitFor({ state: 'hidden' });
  }
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
  note('Import history preserves Escape ordering, focus restoration, scroll unlock, and rapid repeated open/close');
  await page.getByRole('button', { name: '新增需求', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入向导', exact: true });
  const fileDialog = page.getByRole('dialog', { name: '表格导入', exact: true });
  await dialog.getByRole('button', { name: '表格导入', exact: true }).click();
  await expect(fileDialog.getByRole('button', { name: '上传并校验', exact: true })).toHaveCount(0); assert.equal(uploadBodies.length, 0);
  await fileDialog.getByLabel('需求文件', { exact: true }).evaluate((node) => node.dispatchEvent(new Event('cancel', { bubbles: true })));
  assert.equal(await dialog.evaluate((node) => node.open), true);
  await fileDialog.getByLabel('需求文件', { exact: true }).setInputFiles({ name: 'draft.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('UI file fixture; HTTP mocked') });
  await expect(fileDialog.getByRole('alert')).toContainText('工作簿内容无效'); assert.equal(uploadBodies.length, 1);
  await fileDialog.getByLabel('需求文件', { exact: true }).evaluate((node) => node.dispatchEvent(new Event('cancel', { bubbles: true }))); assert.equal(uploadBodies.length, 1);
  note('Selecting a file uploads automatically; cancel leaves the dialog and original upload unchanged');
  await fileDialog.getByRole('button', { name: '关闭表格导入', exact: true }).click();
  assert.equal(await dialog.locator('.online-grid tbody tr').count(), 20);
  const content = Array.from({ length: 21 }, (_, index) => [`FBAONLINE${index + 1}`, index === 0 ? '手填店铺' : '', '空运', '美国', '', '', '', '2026-10-16', '技术备注'].join('\t')).join('\r\n');
  await paste(dialog.getByLabel('第 1 行FBA 货件号', { exact: true }), content);
  await dialog.getByLabel('第 21 行FBA 货件号', { exact: true }).waitFor(); assert.equal(await dialog.getByLabel('第 1 行店铺', { exact: true }).inputValue(), '手填店铺');
  await dialog.getByRole('button', { name: '表格导入', exact: true }).click();
  assert.equal(await fileDialog.getByLabel('需求文件', { exact: true }).evaluate((node) => node.files[0]?.name), 'draft.xlsx');
  assert.equal(uploadBodies.length, 1, 'Returning to a failed file must not automatically upload it twice');
  await fileDialog.getByRole('button', { name: '关闭表格导入', exact: true }).click();
  assert.equal(await dialog.getByLabel('第 1 行店铺', { exact: true }).inputValue(), '手填店铺');
  assert.equal(await dialog.locator('.online-grid tbody tr').count(), 21);
  note('Closing and reopening the file subdialog retains both the failed file and the complete online draft');
  note('Online grid supports UUID fallback, starts with 20 rows, and expands on a 21-row TSV paste without shifting fields');
  await dialog.getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /按当前填写继续/ })).toBeVisible();
  assert.equal(await dialog.getByLabel('第 1 行店铺', { exact: true }).inputValue(), '手填店铺'); assert.equal(await dialog.getByLabel('第 1 行目的 FC', { exact: true }).inputValue(), 'ONT8');
  assert.equal(await dialog.getByLabel('第 1 行业务渠道', { exact: true }).inputValue(), '空运'); assert.equal(await dialog.getByLabel('第 1 行来源填写时间', { exact: true }).inputValue(), '2026-10-16');
  const first = dialog.locator('.online-grid tbody tr').nth(0); await first.getByRole('button', { name: '采用此结果并替换差异', exact: true }).click(); assert.equal(await dialog.getByLabel('第 1 行店铺', { exact: true }).inputValue(), '示例店铺 A');
  const second = dialog.locator('.online-grid tbody tr').nth(1); await second.locator('details').nth(1).getByRole('button', { name: '采用此查询结果', exact: true }).click(); assert.equal(await dialog.getByLabel('第 2 行店铺', { exact: true }).inputValue(), '示例店铺 B');
  assert.equal(lookupBodies[0].fbas.length, 21); assert.equal(lookupBodies[0].expectedCatalogVersion, 2);
  note('Manual-directory FBA lookup fills only blanks, preserves business fields, and requires a choice for conflicts or ambiguous shops');
  await dialog.getByLabel('第 1 行仓库地址', { exact: true }).fill('手工修正地址');
  await dialog.getByLabel('第 1 行FBA 货件号', { exact: true }).fill('FBAOLD');
  for (const label of ['店铺', '目的 FC', '货件创建时间']) assert.equal(await dialog.getByLabel(`第 1 行${label}`, { exact: true }).inputValue(), '');
  assert.equal(await dialog.getByLabel('第 1 行仓库地址', { exact: true }).inputValue(), '手工修正地址');
  assert.equal(await dialog.getByLabel('第 1 行国家', { exact: true }).inputValue(), '美国');
  await dialog.getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '补全并解析', exact: true })).toBeEnabled();
  assert.equal(await dialog.getByLabel('第 1 行目的 FC', { exact: true }).inputValue(), 'ONT8');
  await paste(dialog.getByLabel('第 1 行FBA 货件号', { exact: true }), 'FBAONLINE1\t粘贴手填店铺');
  for (const label of ['目的 FC', '货件创建时间']) assert.equal(await dialog.getByLabel(`第 1 行${label}`, { exact: true }).inputValue(), '');
  assert.equal(await dialog.getByLabel('第 1 行店铺', { exact: true }).inputValue(), '粘贴手填店铺');
  assert.equal(await dialog.getByLabel('第 1 行仓库地址', { exact: true }).inputValue(), '手工修正地址');
  assert.equal(await dialog.getByLabel('第 1 行业务渠道', { exact: true }).inputValue(), '');
  note('Changing an adopted FBA clears derived shipment fields and channel while preserving manual edits and pasted overrides');
  await dialog.getByLabel('第 1 行FBA 货件号', { exact: true }).fill('FBAHOLD');
  holdLookup = true;
  await dialog.getByRole('button', { name: '补全并解析', exact: true }).click();
  for (let attempt = 0; !lookupRelease && attempt < 100; attempt += 1) await delay(50);
  assert(lookupRelease, 'Lookup request was not held');
  await expect(dialog.getByLabel('第 1 行FBA 货件号', { exact: true })).toBeDisabled();
  holdLookup = false; lookupRelease(); lookupRelease = null;
  await expect(dialog.getByRole('button', { name: '补全并解析', exact: true })).toBeEnabled();
  await dialog.getByLabel('第 1 行FBA 货件号', { exact: true }).fill('FBANEW');
  assert.equal(await dialog.getByLabel('第 1 行店铺', { exact: true }).inputValue(), '粘贴手填店铺');
  note('The combined lookup pipeline locks edits while pending and preserves manual values after completion');
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter((node) => node.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(node).position === 'absolute').map((node) => ({ tag: node.tagName, className: node.className, text: node.textContent?.slice(0, 60), rect: node.getBoundingClientRect().toJSON() })) }));
    assert(overflow.scrollWidth <= width + 1, `Viewport overflow: ${JSON.stringify(overflow)}`);
    await checkIconTargets(dialog);
    await page.keyboard.press('Tab'); await dialog.getByRole('button', { name: '关闭导入向导', exact: true }).focus();
    await checkTooltipBounds(page);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate((node) => node.open), true);
    await page.screenshot({ path: resolve(evidence, `online-${width}.png`) });
    await dialog.getByLabel('第 1 行FBA 货件号', { exact: true }).focus();
  }
  note('Dialog and editable grid stay within the viewport at 1440/1024/768/390/320 pixels');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByLabel('第 20 行FBA 货件号', { exact: true }).fill('wrong'); await dialog.getByLabel('第 21 行FBA 货件号', { exact: true }).fill('');
  assert.equal(await dialog.getByLabel('第 20 行FBA 货件号', { exact: true }).getAttribute('aria-invalid'), 'true');
  await dialog.getByText('此行缺少 FBA。', { exact: true }).waitFor();
  await dialog.getByRole('checkbox', { name: /按当前填写继续/ }).check();
  await dialog.getByRole('button', { name: '补全并解析', exact: true }).click();
  await dialog.getByRole('button', { name: '查看导入详情', exact: true }).click();
  await page.getByRole('dialog', { name: '保存到草稿箱？', exact: true }).getByRole('button', { name: '不保存，退出', exact: true }).click();
  await page.getByRole('heading', { name: '文件解析详情', exact: true }).waitFor();
  assert.equal(onlineBodies.length, 1); assert.equal(onlineBodies[0].rows.length, 21); assert.equal(onlineBodies[0].rows[1].lookupSid, 2); assert.equal(onlineBodies[0].rows[0].lookupId, undefined);
  assert.equal(onlineBodies[0].rows[19].fba, 'WRONG'); assert.equal(onlineBodies[0].rows[20].fba, '');
  note('Online submission preserves candidate provenance and permits invalid rows to enter selective review');
  await page.setViewportSize({ width: 390, height: 700 });
  const downloadSource = page.getByRole('button', { name: '下载原文件', exact: true });
  await downloadSource.focus();
  await page.evaluate(() => {
    window.scrollTo(0, 180);
    window.__pollMotionEvents = [];
    document.querySelector('.import-detail').addEventListener('animationstart', (event) => {
      if (!event.target.closest('.motion-spin')) window.__pollMotionEvents.push(event.animationName);
    });
  });
  // Wait for initial entrance feedback to finish before observing automatic refreshes.
  await delay(300); await page.evaluate(() => { window.__pollMotionEvents = []; });
  const pollReadsBefore = importReads;
  const pollScrollBefore = await page.evaluate(() => scrollY);
  await expect.poll(() => importReads, { timeout: 10_000 }).toBeGreaterThanOrEqual(pollReadsBefore + 2);
  assert.equal(await downloadSource.evaluate((node) => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => scrollY), pollScrollBefore);
  assert.deepEqual(await page.evaluate(() => window.__pollMotionEvents), []);
  await page.locator('.import-detail').getByText('正在解析，已处理', { exact: false }).waitFor();
  note('Automatic progress polling updates real status without replaying entrance motion or moving focus/scroll');
  await page.goto('/shipping?view=demands'); await table.locator('.demand-product-name').filter({ hasText: '已冻结商品' }).waitFor();
  await chooseOption(page.getByLabel('展示方式', { exact: true }), 'products');
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await checkIconTargets(page);
    await table.focus(); await table.evaluate((node) => { node.scrollLeft = 0; }); await page.keyboard.press('ArrowRight'); await delay(150);
    assert.equal(await table.evaluate((node) => node.scrollLeft > 0), true);
    await table.evaluate((node) => { node.scrollLeft = 1100; });
    const pinned = await table.locator('tbody .shipping-row-identity').first().evaluate((node) => { const region = node.closest('[role="region"]').getBoundingClientRect(); const box = node.getBoundingClientRect(); return box.left >= region.left - 1 && box.right <= region.right + 1; });
    assert.equal(pinned, true, `FBA identity must remain visible at ${width}px`);
    assert.equal(await table.locator('tbody .shipping-row-identity').first().evaluate((node) => getComputedStyle(node).position), 'sticky');
    await page.screenshot({ path: resolve(evidence, `workspace-${width}.png`) });
  }
  note('Large table preserves FBA identity during horizontal scrolling and only pins FBA on narrow screens');
  assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; console.error(error.stack || error);
  if (context?.pages()[0]) await context.pages()[0].screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (lookupRelease) lookupRelease();
  demandReleases.splice(0).forEach((release) => release());
  await browser?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill(); await Promise.race([new Promise((done) => processHandle.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-demand-workspace-browser', passed: !failed, checks, browserErrors }, null, 2));
}
if (failed) process.exitCode = 1;
