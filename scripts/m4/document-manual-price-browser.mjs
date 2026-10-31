import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentSchema, documentRevisionInputSchema, documentAutomationJobSchema, documentManualSalesPriceSchema, documentManualSalesPriceSources, documentInvoicePrice, withDocumentInvoiceDefaults } from '../../packages/contracts/dist/index.js';
import { buildDocumentAutomationRequirements } from '../../apps/server/dist/modules/documents/automation-supplement.js';
import { selectGridRow } from '../shared/grid.mjs';

// Local memory fixtures use the real pure requirement and fixed-price helpers.
// Archive references below are technical fixtures; no database or real API is used.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.MANUAL_PRICE_EVIDENCE_DIR || resolve(root, '.local/m4/manual-selling-price'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-25T12:00:00.000Z', week = '2026-10-19', uid = () => randomUUID(), actor = 'technical-manual-price-admin';
const shared = { sid: 101, msku: 'SHARED-MSKU', fnsku: 'SHARED-FNSKU', sku: 'SHARED-SKU' };
const valid = { sid: 202, msku: 'VALID-MSKU', fnsku: 'VALID-FNSKU', sku: 'VALID-SKU' };
const checks = [], browserErrors = [], unexpectedRequests = [], externalRequests = [], writes = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
const documentProductOverrideKey = (sid, item) => createHash('sha256').update(JSON.stringify([sid, item.msku, item.fnsku, item.sku])).digest('hex');
function fixture() {
  const run = { id: uid(), version: 1, status: 'ready', stage: 'ready', numberingDate: '2026-10-25', month: '2026-10', sequence: 1, importId: null, parseRunId: null, origin: 'manual', membershipFrozenAt: now, error: null, createdAt: now, updatedAt: now };
  const template = { id: uid(), purpose: 'invoice', name: 'Technical manual price template', version: 1, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: 'a'.repeat(64), fileId: uid(), status: 'active', createdBy: actor, createdAt: now };
  const profiles = [shared, valid].map((identity, index) => ({ id: uid(), category: 'product', key: 'PRICE-PRODUCT-' + index, version: 1, status: 'active', createdBy: actor, createdAt: now,
    data: { ...identity, englishName: 'Technical Product', chineseName: '技术商品', material: 'Glass', hsCode: '700719', use: 'Protect screen', brand: 'TECH', model: 'PRICE', unit: 'piece', salesLink: 'https://fixture.invalid/product' } }));
  const records = Array.from({ length: 4 }, (_, index) => {
    const identity = index === 3 ? valid : shared, country = index === 2 ? '英国' : '美国', countryCode = index === 2 ? 'GB' : 'US';
    const id = uid(), demandId = uid(), groupId = uid(), shipmentId = uid(), boxId = uid(), fba = 'FBAMANUALPRICE' + (index + 1), profile = profiles[index === 3 ? 1 : 0];
    const item = { msku: identity.msku, fnsku: identity.fnsku, sku: identity.sku, name: '技术商品', quantity: '100', expiration: null, prepOwner: null, labelOwner: null };
    const address = { recipientName: 'Technical Receiver', addressLine1: (index + 1) + ' Manual Price Road', city: index === 2 ? 'London' : 'Technical City', state: '', postalCode: index === 2 ? 'SW1A1AA' : '90001', countryCode, addressCode: 'PRICE-' + index };
    const box = { id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, weight: '10', weightUnit: 'KG', length: '30', width: '20', height: '10', dimensionUnit: 'CM', items: [item] };
    const member = { source: { shippingRunId: run.id, weekStartDate: week, groupId, groupVersion: 1, m2ConfirmationId: uid(), demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null },
      demand: { id: demandId, snapshot: { sid: identity.sid, fba, shop: index === 3 ? 'Valid Remote Shop' : 'Shared Shop', country, channel: 'SEA', destinationFc: 'PRICE' + index, destinationAddress: address.addressLine1, referenceQuantity: null, notes: null, subBatchName: null }, version: 1, businessDate: '2026-10-25', weekStartDate: week, weekEndDate: '2026-10-25', createdAt: now, updatedAt: now },
      shipment: { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: identity.sid, fba, items: [item], boxes: [box], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'Technical fixture', createdBy: actor, createdAt: now },
      codes: [{ id: uid(), groupId, demandId, boxId, prefix: String.fromCharCode(65 + index), sequence: 1, code: String.fromCharCode(65 + index) + '1', valid: true, createdAt: now }], physical: null,
      boxSource: [{ demandId, shipmentRevisionId: shipmentId, boxId, sid: identity.sid, fba, code: String.fromCharCode(65 + index) + '1', order: 1, po: 'PRICE-PO-' + index, range: fba + 'U000001', raw: { weight: '10', weightUnit: 'KG', length: '30', width: '20', height: '10', dimensionUnit: 'CM' }, values: { weight: '10.00', length: '30.00', width: '20.00', height: '10.00' }, items: [item], sourceObservedAt: now }],
      sourceCandidates: { addresses: [{ source: 'getShipmentDetails', snapshotId: uid(), data: address }], products: [], issues: [] } };
    return documentSchema.parse({ id, purpose: 'invoice', status: 'draft', version: 1, createdBy: actor, createdAt: now, updatedAt: now,
      currentRevision: { id: uid(), documentId: id, version: 1, reason: 'Technical manual price fixture', createdBy: actor, createdAt: now, data: { purpose: 'invoice', shippingRunId: run.id, shippingRunMonth: run.month, shippingRunSequence: 1, weekStartDate: week, title: 'Manual Price Invoice ' + (index + 1), generationRulesVersion: 'v2', members: [member],
        fields: withDocumentInvoiceDefaults({ service: 'TECH SERVICE', customsMode: '普通报关', clearanceMode: '一般贸易清关', taxMode: '包税', ...address, addressSelectionMode: 'manual', addressConfirmed: 'true', addressConfirmationReason: 'Fixture address already explicitly checked' }, [member]),
        profileReferences: [{ category: 'product', profileId: profile.id, version: 1, data: structuredClone(profile.data) }], templateReference: { templateId: template.id, version: 1, sha256: template.sha256, fileId: template.fileId },
        productSourceFacts: [{ ...identity, salesPrice: index === 3 ? '19.99' : index === 2 ? 'invalid-remote-price' : null, currency: index === 2 ? 'GBP' : 'USD', unitPrice: index === 3 ? '4.00' : null, cartonQuantity: '100', sourceFileId: uid(), sourceSha256: 'b'.repeat(64), fetchedAt: now }] } } });
  });
  const state = { run, template, profiles, records, job: null, supplementInputs: [], acceptedSupplements: [], plans: [], revisionInputs: [], acceptedRevisions: [], modes: [], ledger: new Map(), downloads: 0, bundleGenerations: 0,
    archivePrices: new Map(records.map((record) => { const fact = record.currentRevision.data.productSourceFacts[0]; return [fact.sourceFileId, fact.salesPrice]; })) };
  state.job = documentAutomationJobSchema.parse({ id: uid(), mode: 'single_workbook', shippingRunId: run.id, version: 1, status: 'blocked', phase: 'needs_input', bundle: null, supplement: null,
    items: records.map((record) => ({ id: uid(), demandIds: record.currentRevision.data.members.map((member) => member.demand.id), fbas: record.currentRevision.data.members.map((member) => member.demand.snapshot.fba), documentId: record.id, documentVersion: 1, exportId: null, fileId: null, stage: 'validate', status: 'blocked', issues: [], error: null, attempt: 1 })), counts: { total: 4, queued: 0, running: 0, ready: 0, exporting: 0, completed: 0, blocked: 4 }, createdAt: now, updatedAt: now, completedAt: null, error: null });
  refresh(state); return state;
}
const tickets = (state) => state.job.items.map((item) => ({ item, document: state.records.find((record) => record.id === item.documentId) }));
function refresh(state) {
  // A worker recheck replaces its previous diagnostics before deriving readiness.
  for (const item of state.job.items) item.issues = [];
  state.job.supplement = buildDocumentAutomationRequirements(tickets(state), state.profiles, [state.template]);
  const counts = { total: state.job.items.length, queued: 0, running: 0, ready: 0, exporting: 0, completed: 0, blocked: 0 };
  for (const item of state.job.items) { const record = state.records.find((record) => record.id === item.documentId); item.documentVersion = record.version; item.issues = state.job.supplement.issues.filter((issue) => issue.documentId === record.id).map(({ itemId: _, documentId: __, ...issue }) => issue);
    item.status = item.issues.some((issue) => issue.severity === 'error') ? 'blocked' : 'ready'; item.stage = item.status === 'ready' ? 'ready' : 'validate'; counts[item.status] += 1; }
  state.job.counts = counts; state.job.phase = counts.blocked ? 'needs_input' : 'preparing'; state.job.status = counts.blocked ? 'blocked' : 'running'; state.job.version += 1; documentAutomationJobSchema.parse(state.job);
}

function revise(state, record, input) {
  assert.equal(input.expectedVersion, record.version);
  assert.equal(input.manualSalesPrices, undefined, 'Fixed-price edits never submit manual sales prices');
  record.version += 1; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, reason: input.reason, data: { ...record.currentRevision.data, fields: input.fields ?? record.currentRevision.data.fields, title: input.title ?? record.currentRevision.data.title } };
  documentSchema.parse(record);
}
function conflict(state, record) {
  record.version += 1; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, data: { ...record.currentRevision.data, fields: { ...record.currentRevision.data.fields, remarks: 'OTHER-OPERATION-NOTE', currency: 'GBP', countryCode: 'GB' } } };
  const data = record.currentRevision.data; data.members[0].demand.snapshot.country = '英国'; data.members[0].demand.version += 1; data.members[0].source.demandVersion += 1; data.members[0].shipment.demandVersion += 1;
  refresh(state);
}
function publish(state) {
  assert.equal(state.job.supplement.descriptors.length, 0); assert.equal(state.job.counts.ready, 4); state.bundleGenerations += 1;
  state.job.phase = 'completed'; state.job.status = 'completed'; state.job.bundle = { status: 'completed', fileId: uid(), fileName: 'technical-fixed-prices.zip', fileCount: 4, sheetCount: 4, completedAt: now, error: null };
  for (const item of state.job.items) { item.status = 'completed'; item.stage = 'done'; state.records.find((record) => record.id === item.documentId).status = 'pending_review'; }
  state.job.counts.ready = 0; state.job.counts.completed = 4; state.job.completedAt = now; state.job.version += 1;
}
async function setup(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseURL) { externalRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (method !== 'GET') writes.push({ path, method, input: request.postDataJSON() });
    if (path === '/api/v1/session') return json({ user: { id: actor, name: 'Fixed invoice price fixture', email: 'price@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (path === '/api/v1/document-profiles') return json({ items: state.profiles });
    if (path === '/api/v1/document-templates') return json({ items: [state.template] });
    if (path === '/api/v1/documents' && method === 'GET') return json({ items: state.records, total: 4, page: 1, pageSize: 20 });
    const base = '/api/v1/documents/automations';
    if (path === base && method === 'GET') return json({ items: [state.job] });
    if (path === base + '/' + state.job.id && method === 'GET' || path === base + '/' + state.job.id + '/requirements' && method === 'GET') return json({ job: state.job });
    if (path === base + '/' + state.job.id + '/download' && method === 'GET') { assert.equal(state.job.phase, 'completed'); state.downloads += 1; return route.fulfill({ status: 200, contentType: 'application/zip', headers: { 'content-disposition': 'attachment; filename="technical-fixed-prices.zip"' }, body: Buffer.from('Local fixed price ZIP fixture only') }); }
    const detail = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(.*))?$/), record = state.records.find((record) => record.id === detail?.[1]), action = detail?.[2] || '';
    if (record && method === 'GET' && !action) return json({ document: record, validation: null, exports: state.exports?.[record.id] ?? [] });
    if (record && method === 'GET' && action === 'history') return json({ revisions: [record.currentRevision], reviews: [], validations: [] });
    if (record && action === 'revisions' && method === 'POST') {
      const raw = request.postDataJSON(); state.revisionInputs.push(raw); const mode = state.modes.shift();
      if (mode === '409') conflict(state, record);
      if (mode === '503' || mode === '409') return json({ error: { code: mode === '503' ? 'FIXTURE_SAVE_FAILED' : 'DOCUMENT_VERSION_CONFLICT', message: mode === '503' ? '技术夹具：资料保存失败，填写已保留。' : '技术夹具：资料版本冲突，填写已保留。' } }, Number(mode));
      const input = documentRevisionInputSchema.parse(raw); revise(state, record, input); state.acceptedRevisions.push(input); return json({ document: record, replayed: false });
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: method + ' ' + path } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message)); return context;
}
const jobDialog = () => page.getByRole('dialog', { name: '整批检查与打包出单', exact: true });
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const save = () => wizard().getByRole('button', { name: '保存草稿', exact: true });
const pricePanel = (identity = shared) => wizard().getByLabel(identity.msku + ' 自动申报单价', { exact: true });
const material = () => wizard().getByLabel('材质', { exact: true });
async function openJob() {
  await page.goto('/shipping?view=documents', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: '自动出单任务', exact: true }).click();
  const row = await selectGridRow(page, '最近自动出单任务', 0);
  await row.getByRole('button', { name: '查看进度', exact: true }).click();
  await expect(jobDialog()).toBeVisible();
}
async function openDocument(record, identity = shared) {
  await page.goto('/shipping?view=documents&documentId=' + record.id, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await wizard().getByRole('navigation', { name: '单据制作步骤', exact: true }).getByRole('button', { name: '单票资料', exact: true }).click();
  const section = wizard().locator('details[data-section-editor="products"]'); if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click();
  const product = section.locator('.document-product-adjustment').filter({ hasText: identity.msku }); await expect(product).toHaveCount(1); if (await product.getAttribute('open') === null) await product.locator(':scope > summary').click(); await expect(pricePanel(identity)).toBeVisible();
}
async function shot(name) { await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' }); }
try {
  await mkdir(evidence, { recursive: true }); const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 30_000 }).toBe(200); browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });

  step = 'missing-invalid-and-valid-sales-prices-never-create-price-supplement-requirements';
  const batch = fixture(); batch.records[1].currentRevision.data.productSourceFacts = []; refresh(batch);
  assert.equal(batch.job.supplement.descriptors.length, 0); assert.equal(batch.job.counts.ready, 4); assert(!batch.job.supplement.issues.some((issue) => issue.severity === 'error'));
  let context = await setup(batch); const writesBefore = writes.length; await openJob(); await expect(jobDialog().getByLabel(/售价/)).toHaveCount(0); assert.equal(writes.length, writesBefore); await context.close(); note();

  step = 'fixed-price-keeps-each-invoice-currency-and-product-readiness-without-manual-input';
  context = await setup(batch);
  for (const [index, record] of batch.records.entries()) { const identity = index === 3 ? valid : shared; await openDocument(record, identity); const currency = index === 2 ? 'GBP' : 'USD'; await expect(pricePanel(identity)).toContainText('2.00 ' + currency); await expect(wizard().getByRole('button', { name: '商品申报 已填齐', exact: true })).toBeVisible(); await expect(pricePanel(identity).locator('input')).toHaveCount(0); assert.equal(documentInvoicePrice(record.currentRevision.data).currency, currency); }
  await context.close(); note();

  step = 'stale-saved-manual-prices-and-old-product-overrides-cannot-change-fixed-price';
  const stale = fixture(), data = stale.records[0].currentRevision.data, fact = data.productSourceFacts[0];
  const saved = documentManualSalesPriceSchema.parse({ ...shared, salesPrice: '17.55', currency: 'USD', reason: 'Historical manual sales price', recordedBy: actor, recordedAt: now, sourceFileId: fact.sourceFileId, sourceSha256: fact.sourceSha256, memberSources: documentManualSalesPriceSources(data, shared.sid, shared) });
  saved.memberSources[0].demandVersion += 100; data.manualSalesPrices = [saved]; const prefix = 'product.' + documentProductOverrideKey(shared.sid, shared) + '.'; data.fields[prefix + 'unitPrice'] = '89.00'; data.fields[prefix + 'currency'] = 'EUR';
  context = await setup(stale); await openDocument(stale.records[0]); await expect(pricePanel()).toContainText('2.00 USD'); await expect(pricePanel()).not.toContainText('17.55'); await expect(pricePanel()).not.toContainText('89.00'); await expect(pricePanel().locator('input')).toHaveCount(0); await expect(wizard().getByRole('button', { name: '商品申报 已填齐', exact: true })).toBeVisible(); await context.close(); note();

  step = 'ordinary-product-save-retains-input-and-idempotency-after-503-without-price-commands';
  const retry = fixture(); context = await setup(retry); await openDocument(retry.records[0]); await material().fill('Checked Glass'); retry.modes.push('503'); await save().click(); await expect(wizard()).toContainText('资料保存失败'); await expect(material()).toHaveValue('Checked Glass'); await save().click(); await expect.poll(() => retry.acceptedRevisions.length).toBe(1); assert.deepEqual(retry.revisionInputs[1], retry.revisionInputs[0]); assert.equal(retry.acceptedRevisions[0].manualSalesPrices, undefined); await expect(pricePanel()).toContainText('2.00 USD'); await context.close(); note();

  step = 'version-recovery-preserves-edits-and-adopts-new-ticket-currency-without-price-confirmation';
  const recovery = fixture(); context = await setup(recovery); await openDocument(recovery.records[0]); await material().fill('Retained Material'); recovery.modes.push('409'); await save().click(); await expect(wizard()).toContainText('资料版本冲突'); await wizard().getByRole('button', { name: '重新读取最新版本', exact: true }).click(); await wizard().getByRole('button', { name: '恢复未保存输入', exact: true }).click();
  const section = wizard().locator('details[data-section-editor="products"]'); if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click(); const product = section.locator('.document-product-adjustment'); if (await product.getAttribute('open') === null) await product.locator(':scope > summary').click();
  await expect(material()).toHaveValue('Retained Material'); await expect(pricePanel()).toContainText('2.00 GBP'); await expect(save()).toBeEnabled(); await save().click(); await expect.poll(() => recovery.acceptedRevisions.length).toBe(1); assert.equal(recovery.acceptedRevisions[0].expectedVersion, 2); assert.equal(recovery.records[0].currentRevision.data.fields.remarks, 'OTHER-OPERATION-NOTE'); assert.equal(recovery.acceptedRevisions[0].manualSalesPrices, undefined); await context.close(); note();

  step = 'batch-with-missing-sales-prices-downloads-one-zip-with-four-invoice-files';
  context = await setup(batch); publish(batch); await openJob(); await expect(jobDialog()).toContainText('4 个 Excel 文件'); const downloadEvent = page.waitForEvent('download'); await jobDialog().getByRole('button', { name: '下载发票压缩包 ZIP', exact: true }).click(); const download = await downloadEvent; assert(download.suggestedFilename().endsWith('.zip')); assert.equal(batch.downloads, 1); assert.equal(batch.bundleGenerations, 1); await context.close(); note();

  step = 'historical-files-explicitly-retain-their-original-declaration-price';
  const historical = fixture(), record = historical.records[0], reference = record.currentRevision.data.templateReference;
  record.status = 'pending_review'; historical.exports = { [record.id]: [{ id: uid(), status: 'completed', reference: { documentId: record.id, revisionId: record.currentRevision.id, revisionVersion: record.version, templateId: reference.templateId, templateVersion: reference.version, templateSha256: reference.sha256, sources: record.currentRevision.data.members.map((member) => member.source), generationRulesVersion: 'v2' }, fileId: uid(), fileSha256: 'c'.repeat(64), error: null, createdAt: now, completedAt: now, valid: true, invalidReason: null }] };
  context = await setup(historical); await openDocument(record); await expect(wizard()).toContainText('历史文件保留生成时的申报价格'); await expect(wizard()).toContainText('需建立更正单据后生成新文件'); await context.close(); note();

  step = 'fixed-price-display-fits-desktop-and-narrow-screens';
  const layout = fixture(); context = await setup(layout); await openDocument(layout.records[0]);
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); await pricePanel().evaluate((node) => { const body = node.closest('.import-dialog-body'); if (body) body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - (body.querySelector('.document-details-progress')?.getBoundingClientRect().height || 0) - 16; }); await expect(wizard().getByRole('heading', { name: '发票与单据向导', exact: true })).toBeInViewport(); await expect(pricePanel()).toBeInViewport(); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await shot('fixed-invoice-price-' + width + '.png'); }
  await context.close(); note(); assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []);
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-fixed-invoice-price-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests, writes, realBusinessWrites: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
