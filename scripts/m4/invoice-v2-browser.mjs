import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { closeGridDetails, grid, gridRowCount, findGridRow, activeGridRow } from '../shared/grid.mjs';
import { assertBottomNavigation, setColumnVisible } from './grid-helpers.mjs';
import { documentSchema, documentLingxingApplyInputSchema, documentLingxingPreviewSchema, withDocumentDefaults as documentFlagDefaults } from '../../packages/contracts/dist/index.js';

const withDocumentDefaults = (fields = {}) => documentFlagDefaults({ orderNumber: null, reference: null, tradeTerms: null, currency: 'USD', ...fields });

// Technical fixtures only. All API calls are intercepted; no live account or database access.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.M4_INVOICE_V2_EVIDENCE_DIR || resolve(root, '.local/m4/invoice-v2'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-24T03:00:00.000Z', week = '2026-10-19', uid = () => randomUUID();
const demandId = uid(), groupId = uid(), shipmentId = uid(), m2 = uid();
const product = (msku, quantity) => ({ msku, fnsku: `${msku}-FN`, sku: `${msku}-SKU`, name: '手机膜测试商品', quantity, expiration: null, prepOwner: null, labelOwner: null });
const first = product('A-FIRST', '100'), hidden = product('Z-HIDDEN', '200'), fallback = product('C-FALLBACK', '300');
const demand = { id: demandId, snapshot: { sid: 101, fba: 'FBAINVOICEV2', shop: '技术美国店', country: '美国', channel: 'HY', destinationFc: 'TEST1', destinationAddress: 'Technical Address', referenceQuantity: '600', notes: 'TECHNICAL FIXTURE', subBatchName: null }, version: 1, businessDate: week, weekStartDate: week, weekEndDate: '2026-10-25', createdAt: now, updatedAt: now };
const boxes = [[hidden, first], [fallback]].map((items, index) => ({ id: uid(), externalBoxId: null, packageId: null, localBoxId: String(index + 1), name: null, order: index + 1, weight: String(index + 1), weightUnit: 'KG', length: '10', width: '10', height: '10', dimensionUnit: 'CM', items }));
const shipment = { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: 101, fba: demand.snapshot.fba, items: [hidden, fallback, first], boxes, observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'technical', createdBy: 'fixture', createdAt: now };
const codes = boxes.map((box, index) => ({ id: uid(), groupId, demandId, boxId: box.id, prefix: 'A', sequence: index + 1, code: `A${index + 1}`, valid: true, createdAt: now }));
const member = { source: { weekStartDate: week, groupId, groupVersion: 1, m2ConfirmationId: m2, demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null }, demand, shipment, codes, physical: null };
const sourceFact = (item, price, unitPrice, cartonQuantity) => ({ sid: 101, msku: item.msku, fnsku: item.fnsku, sku: item.sku, salesPrice: price, currency: 'USD', unitPrice, cartonQuantity, sourceFileId: uid(), sourceSha256: 'a'.repeat(64), fetchedAt: now });
const facts = [sourceFact(first, '19.99', '4.00', '500'), sourceFact(fallback, '12.345', '2.47', null)];
const productData = { englishName: 'Screen protector', chineseName: '手机膜', material: 'Glass', hsCode: '700719', use: 'Protect phone screen', brand: 'TECH', model: 'TEST', unit: 'piece', salesLink: 'https://example.invalid/product' };
const profiles = [first, fallback].map((item) => ({ category: 'product', profileId: uid(), version: 1, data: { sid: 101, ...item, ...productData, unitPrice: '99.00', currency: 'EUR', unitPriceConfirmed: 'false' } }));
const prefix = 'product.' + createHash('sha256').update(JSON.stringify([101, first.msku, first.fnsku, first.sku])).digest('hex') + '.';
function record(title, version = 'v2') {
  const id = uid();
  return documentSchema.parse({ id, purpose: 'invoice', status: 'draft', version: 1, currentRevision: { id: uid(), documentId: id, version: 1, reason: 'technical fixture', data: { purpose: 'invoice', weekStartDate: week, title, fields: withDocumentDefaults({ currency: 'USD', [prefix + 'unitPrice']: '88', [prefix + 'currency']: 'GBP', [prefix + 'unitPriceConfirmed']: 'false' }), members: [structuredClone(member)], profileReferences: structuredClone(profiles), templateReference: null, ...(version === 'v2' ? { generationRulesVersion: 'v2', productSourceFacts: structuredClone(facts) } : {}) }, createdBy: 'fixture', createdAt: now }, createdBy: 'fixture', createdAt: now, updatedAt: now });
}
const main = record('新版发票技术夹具'), legacy = record('历史草稿技术夹具', 'v1'), documents = [main, legacy];
const calls = { preview: [], apply: [], revise: [], profiles: [] }, checks = [], browserErrors = [], unexpectedRequests = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup', permissionFailure = false;
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
async function setupRoutes(context) {
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user: { id: 'fixture', name: '发票规则技术验证', email: 'invoice@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/documents/automations' && method === 'GET') return json({ items: [] });
    if (path === '/api/v1/demands') return json({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 20, maxBoxes: 10, filters: { weeks: [], batches: [], shops: [], countries: [], channels: [] }, generatedAt: now });
    if (path === '/api/v1/batches/workspace') return json({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } });
    if (path === '/api/v1/batch-reports') return json({ rows: [], boxes: [], confirmations: [], blocked: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, generatedAt: now });
    if (path === '/api/v1/documents/field-options') return json({ services: [] });
    if (['/api/v1/document-profiles', '/api/v1/document-templates'].includes(path) && method === 'GET') return json({ items: [] });
    if (path === '/api/v1/document-profiles' && method === 'POST') { const input = request.postDataJSON(); calls.profiles.push(input); return json({ profile: { id: uid(), category: input.category, key: input.key, data: input.data, version: 1, status: 'active', createdBy: 'fixture', createdAt: now }, replayed: false }); }
    if (path === '/api/v1/documents' && method === 'GET') return json({ items: documents, total: documents.length, page: 1, pageSize: 20 });
    const match = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const current = documents.find((entry) => entry.id === match[1]), action = match[2] || ''; assert(current);
      if (method === 'GET' && !action) return json({ document: current, validation: null, exports: [] });
      if (method === 'GET' && action === 'history') return json({ revisions: [current.currentRevision], reviews: [], validations: [] });
      if (method === 'POST' && action === 'lingxing-preview') {
        const input = request.postDataJSON(); calls.preview.push(input);
        const preview = documentLingxingPreviewSchema.parse({ documentId: current.id, documentVersion: current.version, operationId: input.operationId, sourceFileId: uid(), products: [first, hidden, fallback].map((item) => {
          const fact = facts.find((entry) => entry.msku === item.msku);
          return { sid: 101, msku: item.msku, fnsku: item.fnsku, sku: item.sku, data: fact ? { ...productData, salesPrice: fact.salesPrice, unitPrice: fact.unitPrice, currency: fact.currency, cartonQuantity: fact.cartonQuantity, unitPriceSourceLabel: '领星售价 × 20%' } : {}, imageUrls: [], issues: fact ? [] : ['LISTING_PRICE_UNAVAILABLE'] };
        }), fields: {}, parties: [], issues: permissionFailure ? [{ code: 'LINGXING_PERMISSION_REQUIRED', message: 'Listing 售价查询未获授权，请开通权限后重试。', permission: 'Listing 查询' }] : [] });
        return json({ preview, replayed: false });
      }
      if (method === 'POST' && action === 'lingxing-apply') {
        const input = documentLingxingApplyInputSchema.parse(request.postDataJSON()); calls.apply.push(input); assert.equal(input.confirmPrices, false);
        current.version++; current.currentRevision = { ...current.currentRevision, id: uid(), version: current.version, data: { ...current.currentRevision.data, generationRulesVersion: 'v2', productSourceFacts: structuredClone(facts) } };
        return json({ document: current, replayed: false, appliedProducts: 2, issues: [] });
      }
      if (method === 'POST' && action === 'revisions') {
        const input = request.postDataJSON(); calls.revise.push(input); current.version++; current.currentRevision = { ...current.currentRevision, id: uid(), version: current.version, data: { ...current.currentRevision.data, fields: input.fields } };
        return json({ document: current, replayed: false });
      }
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: path } }, 500);
  });
}
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const stage = (label) => wizard().getByRole('navigation', { name: '单据制作步骤', exact: true }).getByRole('button', { name: label, exact: true }).click();
const quantities = () => grid(wizard(), '逐箱申报数量');
async function openAdjustment(msku) { await closeGridDetails(wizard(), '逐箱申报数量'); const section = wizard().locator('.document-product-adjustments'); if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click(); const item = section.locator('.document-product-adjustment').filter({ hasText: msku }); if (await item.getAttribute('open') === null) await item.locator(':scope > summary').click(); }
async function open(id) { await page.goto('/shipping?view=documents&documentId=' + id); await stage('单票资料'); }
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } }); await setupRoutes(context); page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(error.message));

  step = 'mixed-carton-one-representative-and-distinct-default-declaration-quantity';
  await open(main.id); await expect.poll(() => gridRowCount(wizard(), '逐箱申报数量')).toBe(2);
  await assertBottomNavigation(wizard(), '逐箱申报数量');
  await setColumnVisible(wizard(), '逐箱申报数量', '标准箱规件数', 'column:标准箱规件数', false);
  await setColumnVisible(wizard(), '逐箱申报数量', '标准箱规件数', 'column:标准箱规件数', true);
  const firstRow = await findGridRow(wizard(), '逐箱申报数量', 'A-FIRST');
  await expect(firstRow.locator('dd').nth(2)).toHaveText('300'); await expect(firstRow.locator('dd').nth(3)).toHaveText('500'); await expect(firstRow.locator('dd').nth(4)).toContainText('500');
  await expect(firstRow).toContainText('混装'); await expect(firstRow).toContainText('箱规与实际数量不同'); await expect(quantities()).not.toContainText('Z-HIDDEN'); note();

  step = 'missing-carton-quantity-falls-back-to-all-actual-items';
  const fallbackRow = await findGridRow(wizard(), '逐箱申报数量', 'C-FALLBACK');
  await expect(fallbackRow.locator('dd').nth(2)).toHaveText('300'); await expect(fallbackRow.locator('dd').nth(4)).toContainText('300'); await expect(fallbackRow).toContainText('来源：全箱实际数量合计'); await expect(fallbackRow).toContainText('已回退实际数量');
  await expect(wizard()).toContainText('F15“亚马逊上架总数量”仍为所有箱内商品的实际总量'); note();

  step = 'fixed-unit-price-is-readonly-and-legacy-overrides-are-ignored';
  const adjustments = wizard().locator('.document-product-adjustments'); await openAdjustment('A-FIRST');
  await expect(adjustments.locator('.document-product-adjustment')).toHaveCount(2);
  const editor = adjustments.locator('.document-product-adjustment').filter({ hasText: 'A-FIRST' });
  await expect(editor.getByLabel('A-FIRST 自动申报单价', { exact: true })).toContainText('2.00 USD');
  await expect(editor.getByLabel('申报单价', { exact: true })).toHaveCount(0); await expect(editor.getByLabel('币种', { exact: true })).toHaveCount(0); await expect(adjustments.getByRole('checkbox')).toHaveCount(0); await expect(editor).not.toContainText('88'); await expect(editor).not.toContainText('99.00');
  await expect(editor).toContainText('申报单价固定为每件 2.00'); await expect(editor).toContainText('无需补充商品售价'); note();

  step = 'fixed-unit-price-ignores-listing-currency-and-missing-sales-price';
  main.currentRevision.data.productSourceFacts[0].currency = 'EUR'; main.currentRevision.data.productSourceFacts[0].unitPrice = null;
  main.currentRevision.data.productSourceFacts[1].salesPrice = null; main.currentRevision.data.productSourceFacts[1].unitPrice = null;
  await open(main.id); await openAdjustment('A-FIRST');
  await expect(wizard().locator('.document-product-adjustment').filter({ hasText: 'A-FIRST' })).toContainText('2.00 USD');
  await expect(wizard().locator('.document-product-adjustment').filter({ hasText: 'A-FIRST' }).getByLabel('人工补充售价（USD）', { exact: true })).toHaveCount(0);
  await openAdjustment('C-FALLBACK');
  await expect(wizard().locator('.document-product-adjustment').filter({ hasText: 'C-FALLBACK' }).getByLabel('人工补充售价（USD）', { exact: true })).toHaveCount(0);
  await expect(wizard().locator('.document-product-adjustment').filter({ hasText: 'C-FALLBACK' })).toContainText('2.00 USD');
  main.currentRevision.data.productSourceFacts = structuredClone(facts); note();

  step = 'preview-has-fixed-price-and-permission-guidance-without-price-confirmation';
  await open(main.id); permissionFailure = true; const panel = wizard().locator('.document-lingxing');
  await panel.getByRole('button', { name: '查询领星资料', exact: true }).click(); await expect(panel).toContainText('Listing 售价查询未获授权'); await expect(panel).toContainText('需开通权限：Listing 查询');
  await expect(panel.getByRole('checkbox')).toHaveCount(0); await expect(panel).toContainText('固定申报单价 2.00 USD'); await expect(panel).not.toContainText('× 20%'); await expect(panel).toContainText('箱内其他商品 · 不输出申报资料');
  await panel.getByRole('button', { name: '采用领星资料补齐空项', exact: true }).click(); await expect.poll(() => calls.apply.length).toBe(1); assert.equal(calls.apply[0].confirmPrices, false); note();

  step = 'legacy-draft-can-query-and-upgrade-without-confirming-old-prices';
  await open(legacy.id); await expect(wizard()).toContainText('此草稿使用历史发票规则'); await wizard().locator('.document-lingxing').getByRole('button', { name: '查询领星资料', exact: true }).click();
  await wizard().locator('.document-lingxing').getByRole('button', { name: '采用领星资料补齐空项', exact: true }).click(); await expect(quantities()).toBeVisible(); await expect(wizard()).not.toContainText('此草稿使用历史发票规则'); note();

  step = 'wide-and-narrow-layout-invoice-quantity-and-product-preview';
  await open(main.id);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await wizard().locator('.document-invoice-quantities').evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await findGridRow(wizard(), '逐箱申报数量', 'A-FIRST');
    for (const cell of await activeGridRow(wizard(), '逐箱申报数量').locator('dd').all()) { const bounds = await cell.boundingBox(); assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'every declaration quantity and source fits the viewport'); }
    await page.screenshot({ path: resolve(evidence, `invoice-quantities-${width}.png`) });
    await openAdjustment('A-FIRST');
    await wizard().getByLabel('A-FIRST 自动申报单价', { exact: true }).evaluate((element) => { const body = element.closest('.import-dialog-body'); const navigation = body?.querySelector('.document-details-progress'); if (body) body.scrollTop += element.getBoundingClientRect().top - body.getBoundingClientRect().top - (navigation?.getBoundingClientRect().height ?? 0) - 32; }); await expect(wizard().getByLabel('A-FIRST 自动申报单价', { exact: true })).toBeInViewport(); await page.screenshot({ path: resolve(evidence, `invoice-price-${width}.png`) });
    await wizard().locator('.document-product-adjustment').filter({ hasText: 'A-FIRST' }).locator('summary').click();
    await wizard().locator('.document-product-adjustments > summary').click();
  }
  note();

  step = 'public-product-profile-saves-without-legacy-price-currency-or-confirmation';
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/settings/document-profiles'); await page.getByRole('button', { name: '新增商品申报', exact: true }).click();
  for (const [label, value] of Object.entries({ '资料标识 *': 'V2-ONLY-DECLARATION', '店铺 SID *': '101', 'MSKU *': 'V2-ONLY-DECLARATION', '英文申报品名 *': 'Screen protector', '中文申报品名 *': '手机膜', '材质 *': 'Glass', 'HS 编码 *': '700719', '用途 *': 'Protect phone screen', '品牌 *': 'TECH', '型号 *': 'TEST', '销售链接 *': 'https://example.invalid/product' })) await page.getByLabel(label, { exact: true }).fill(value);
  await expect(page.getByLabel('申报单价', { exact: true })).toHaveValue(''); assert.equal(await page.getByLabel('申报单价', { exact: true }).evaluate((element) => element.required), false);
  assert.notEqual(await page.getByLabel('单价币种', { exact: true }).getAttribute('aria-required'), 'true');
  await expect(page.getByLabel('已核对并确认本资料中的申报单价与币种', { exact: true })).not.toBeChecked();
  assert.equal(await page.locator('.document-settings-form').evaluate((element) => element.checkValidity()), true);
  await page.screenshot({ path: resolve(evidence, 'product-profile-without-legacy-price.png'), fullPage: true });
  await page.getByRole('button', { name: '保存资料版本', exact: true }).click(); await expect.poll(() => calls.profiles.length).toBe(1);
  assert.equal(calls.profiles[0].data.unitPrice, undefined); assert.equal(calls.profiles[0].data.currency, undefined); assert.equal(calls.profiles[0].data.unitPriceConfirmed, undefined);
  await expect(page.getByRole('button', { name: '新增商品申报', exact: true })).toBeVisible(); note();
  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); await context.close();
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-invoice-v2-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests: 0, databaseWrites: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
