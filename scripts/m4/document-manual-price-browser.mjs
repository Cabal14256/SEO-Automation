import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentSchema, documentRevisionInputSchema, documentManualSalesPriceInputSchema, documentManualSalesPriceSchema, documentAutomationJobSchema, documentAutomationSupplementInputSchema,
  calculateDocumentInvoiceUnitPrice, documentCanManuallySupplySalesPrice, documentEffectiveSalesPrice, documentManualSalesPriceSources, documentProductSourceFact, documentTicketCurrency, withDocumentInvoiceDefaults } from '../../packages/contracts/dist/index.js';
import { buildDocumentAutomationRequirements, planDocumentAutomationSupplement } from '../../apps/server/dist/modules/documents/automation-supplement.js';

// Local memory fixtures use the real pure descriptor/planning/decimal helpers.
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
function manualData(state, data, commands = []) {
  let stored = [...data.manualSalesPrices ?? []];
  for (const raw of commands) { const change = documentManualSalesPriceInputSchema.parse(raw), match = (entry) => entry.sid === change.sid && entry.msku === change.msku && entry.fnsku === change.fnsku && entry.sku === change.sku;
    const fact = documentProductSourceFact(data, change.sid, change), sources = documentManualSalesPriceSources(data, change.sid, change); assert(sources.length, 'Manual commands must match exact ticket identities'); stored = stored.filter((entry) => !match(entry));
    if (change.salesPrice === null) continue;
    if (!documentCanManuallySupplySalesPrice(data, change.sid, change) || calculateDocumentInvoiceUnitPrice(state.archivePrices.get(fact.sourceFileId))) throw Object.assign(new Error('领星已有有效售价，不能人工替代；请核对售价币种。'), { code: 'DOCUMENT_REMOTE_SALES_PRICE_AVAILABLE', status: 422 });
    stored.push(documentManualSalesPriceSchema.parse({ ...change, currency: documentTicketCurrency(data.members), recordedBy: actor, recordedAt: now, sourceFileId: fact.sourceFileId, sourceSha256: fact.sourceSha256, memberSources: structuredClone(sources) }));
  }
  return { ...data, manualSalesPrices: stored };
}
function revise(state, record, input) {
  assert.equal(input.expectedVersion, record.version); const data = manualData(state, { ...record.currentRevision.data, fields: input.fields ?? record.currentRevision.data.fields }, input.manualSalesPrices);
  record.version += 1; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, reason: input.reason || 'Technical selling price save', createdBy: actor, data: { ...data, title: input.title ?? data.title } }; documentSchema.parse(record);
}
function conflict(state, record, currency = false) {
  record.version += 1; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, data: { ...record.currentRevision.data, fields: { ...record.currentRevision.data.fields, remarks: 'OTHER-OPERATION-NOTE' } } };
  if (currency) { const data = record.currentRevision.data; data.members[0].demand.snapshot.country = '英国'; data.members[0].demand.version += 1; data.members[0].source.demandVersion += 1; data.members[0].shipment.demandVersion += 1; data.fields.currency = 'GBP'; data.fields.countryCode = 'GB'; data.productSourceFacts[0].currency = 'GBP'; }
  refresh(state);
}
function publish(state) {
  assert.equal(state.job.supplement.descriptors.length, 0); assert.equal(state.job.counts.ready, 4); state.bundleGenerations += 1;
  state.job.phase = 'completed'; state.job.status = 'completed'; state.job.bundle = { status: 'completed', fileId: uid(), fileName: 'technical-manual-prices.xlsx', sheetCount: 4, completedAt: now, error: null };
  for (const item of state.job.items) { item.status = 'completed'; item.stage = 'done'; state.records.find((record) => record.id === item.documentId).status = 'pending_review'; }
  state.job.counts.ready = 0; state.job.counts.completed = 4; state.job.completedAt = now; state.job.version += 1;
}
async function setup(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => { const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseURL) { externalRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); } if (!path.startsWith('/api/')) return route.continue();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) }); if (method !== 'GET') writes.push({ path, method, input: request.postDataJSON() });
    if (path === '/api/v1/session') return json({ user: { id: actor, name: 'Manual selling price fixture', email: 'price@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (path === '/api/v1/document-profiles') return json({ items: state.profiles }); if (path === '/api/v1/document-templates') return json({ items: [state.template] });
    if (path === '/api/v1/documents' && method === 'GET') return json({ items: state.records, total: 4, page: 1, pageSize: 20 });
    const base = '/api/v1/documents/automations';
    if (path === base && method === 'GET') return json({ items: [state.job] });
    if ([base + '/' + state.job.id, base + '/' + state.job.id + '/requirements'].includes(path) && method === 'GET') return json({ job: state.job });
    if (path === base + '/' + state.job.id + '/download' && method === 'GET') { assert.equal(state.job.phase, 'completed'); state.downloads += 1; return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'content-disposition': 'attachment; filename="technical-manual-prices.xlsx"' }, body: Buffer.from('Local manual price workbook fixture only') }); }
    const detail = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(.*))?$/), record = state.records.find((record) => record.id === detail?.[1]), action = detail?.[2] || '';
    if (record && method === 'GET' && !action) return json({ document: record, validation: null, exports: [] });
    if (record && method === 'GET' && action === 'history') return json({ revisions: [record.currentRevision], reviews: [], validations: [] });
    if (path === base + '/' + state.job.id + '/supplement' && method === 'POST' || record && action === 'revisions' && method === 'POST') {
      const batch = path.endsWith('/supplement'), raw = request.postDataJSON(); (batch ? state.supplementInputs : state.revisionInputs).push(raw);
      const mode = state.modes.shift(); if (mode === '409' || mode === 'currency409') conflict(state, batch ? state.records[0] : record, mode === 'currency409');
      if (['503', '409', 'currency409'].includes(mode)) return json({ error: { code: mode === '503' ? 'FIXTURE_PRICE_SAVE_FAILED' : 'DOCUMENT_VERSION_CONFLICT', message: mode === '503' ? '技术夹具：售价保存失败，填写已保留。' : '技术夹具：售价版本冲突，填写已保留。' } }, mode === '503' ? 503 : 409);
      try {
        const ledgerKey = raw.operationId; if (state.ledger.has(ledgerKey)) return json(state.ledger.get(ledgerKey));
        if (batch) {
          const input = documentAutomationSupplementInputSchema.parse(raw); assert.equal(input.expectedVersion, state.job.version); const plans = planDocumentAutomationSupplement(tickets(state), state.profiles, [state.template], input), staged = structuredClone(state.records);
          for (const plan of plans) revise(state, staged.find((record) => record.id === plan.documentId), plan); state.records = staged; state.plans.push(plans); state.acceptedSupplements.push(input); refresh(state);
          const result = { job: state.job, replayed: false }; state.ledger.set(ledgerKey, structuredClone(result)); return json(result);
        }
        const input = documentRevisionInputSchema.parse(raw); revise(state, record, input); state.acceptedRevisions.push(input); const result = { document: record, replayed: false }; state.ledger.set(ledgerKey, structuredClone(result)); return json(result);
      } catch (error) { return json({ error: { code: error.code || 'VALIDATION_ERROR', message: error.message } }, error.status || 422); }
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: method + ' ' + path } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message)); return context;
}
const jobDialog = () => page.getByRole('dialog', { name: '整批检查与合并出单', exact: true });
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const form = () => jobDialog().getByRole('region', { name: '统一补充资料', exact: true });
const group = (currency) => form().getByRole('group', { name: new RegExp(' · ' + currency + '$') });
const price = (currency) => group(currency).getByLabel('售价（' + currency + '）（待补）', { exact: true });
const reason = (currency) => group(currency).getByLabel('手工售价原因（待补）', { exact: true });
const save = () => jobDialog().getByRole('button', { name: '保存并统一检查', exact: true });
const legacySave = () => wizard().getByRole('button', { name: '保存草稿', exact: true });
const pricePanel = (identity = shared) => wizard().getByLabel(identity.msku + ' 自动申报单价', { exact: true });
const legacyPrice = (currency = 'USD') => pricePanel().getByLabel('人工补充售价（' + currency + '）', { exact: true });
const legacyReason = () => pricePanel().getByLabel('售价补充依据', { exact: true });
async function openJob() { await page.goto('/shipping?view=documents', { waitUntil: 'domcontentloaded', timeout: 30_000 }); await page.getByRole('region', { name: '最近自动出单任务', exact: true }).getByRole('button', { name: '查看进度', exact: true }).click(); await expect(form()).toBeVisible(); }
async function openLegacy(record, identity = shared) {
  await page.goto('/shipping?view=documents&documentId=' + record.id, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await wizard().getByRole('navigation', { name: '单据制作步骤', exact: true }).getByRole('button', { name: '单票资料', exact: true }).click();
  const section = wizard().locator('details[data-section-editor="products"]'); if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click();
  const product = section.locator('.document-product-adjustment').filter({ hasText: identity.msku }); await expect(product).toHaveCount(1); if (await product.getAttribute('open') === null) await product.locator(':scope > summary').click(); await expect(pricePanel(identity)).toBeVisible();
}
async function enter(currency, amount, explanation) { await price(currency).fill(amount); if (explanation !== undefined) await reason(currency).fill(explanation); }
async function noOutput(state) { assert.equal(state.bundleGenerations, 0); assert.equal(state.downloads, 0); await expect(jobDialog().getByRole('button', { name: '下载合并发票 XLSX', exact: true })).toHaveCount(0); }
async function shot(name) { await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' }); }
function commandsAreExact(commands) { for (const command of commands) assert.deepEqual(Object.keys(command).sort(), ['fnsku', 'msku', 'reason', 'salesPrice', 'sid', 'sku'].sort()); }

try {
  await mkdir(evidence, { recursive: true }); const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 30_000 }).toBe(200); browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });

  step = 'missing-and-invalid-remote-prices-share-exact-usd-targets-and-separate-gbp';
  const batch = fixture(); let context = await setup(batch); await openJob(); await expect(price('USD')).toHaveCount(1); await expect(price('GBP')).toHaveCount(1);
  const usd = batch.job.supplement.descriptors.find((descriptor) => descriptor.label === '售价（USD）'), gbp = batch.job.supplement.descriptors.find((descriptor) => descriptor.label === '售价（GBP）');
  assert.equal(usd.targets.length, 2); assert.equal(gbp.targets.length, 1); assert(usd.targets.every((target) => target.fieldKey.startsWith('@sellingPrice.USD.'))); assert(gbp.targets.every((target) => target.fieldKey.startsWith('@sellingPrice.GBP.')));
  assert(!batch.job.supplement.descriptors.some((descriptor) => descriptor.targets.some((target) => target.documentId === batch.records[3].id))); await expect(form()).toContainText('售价的 20%'); await noOutput(batch); note();

  step = 'selling-price-save-503-retains-both-typed-values-and-replays-the-same-operation';
  const factsBefore = JSON.stringify(batch.records.map((record) => record.currentRevision.data.productSourceFacts)); await enter('USD', '19.99', 'USD price checked against technical sales evidence'); await expect(group('USD').getByRole('status')).toContainText('4.00 USD'); batch.modes.push('503'); await save().click();
  await expect(jobDialog()).toContainText('售价保存失败'); await expect(price('USD')).toHaveValue('19.99'); await expect(reason('USD')).toHaveValue('USD price checked against technical sales evidence'); assert.equal(batch.acceptedSupplements.length, 0); assert(batch.records.every((record) => !record.currentRevision.data.manualSalesPrices));
  await save().click(); await expect.poll(() => batch.acceptedSupplements.length).toBe(1); assert.deepEqual(batch.supplementInputs[1], batch.supplementInputs[0]); note();

  step = 'partial-usd-fallback-writes-authenticated-provenance-only-to-the-two-matching-documents';
  await expect(price('USD')).toHaveCount(0); await expect(price('GBP')).toBeVisible(); assert.equal(batch.job.phase, 'needs_input');
  for (const [index, record] of batch.records.entries()) { const stored = record.currentRevision.data.manualSalesPrices; if (index > 1) { assert.equal(stored, undefined); continue; } assert.equal(stored.length, 1); assert.equal(stored[0].currency, 'USD'); assert.equal(stored[0].recordedBy, actor); assert.equal(stored[0].recordedAt, now); assert.deepEqual(stored[0].memberSources, record.currentRevision.data.members.map((member) => member.source)); assert.equal(documentEffectiveSalesPrice(record.currentRevision.data, shared.sid, shared).unitPrice, '4.00'); }
  for (const plan of batch.plans[0]) { commandsAreExact(plan.manualSalesPrices); assert(!Object.keys(plan.fields).some((key) => key.startsWith('@sellingPrice'))); }
  assert.equal(JSON.stringify(batch.records.map((record) => record.currentRevision.data.productSourceFacts)), factsBefore); await noOutput(batch); note();

  step = 'gbp-full-precision-fallback-derives-positive-half-up-unit-price-before-one-bundle';
  await enter('GBP', '0.025', 'GBP price checked independently without currency conversion'); await expect(group('GBP').getByRole('status')).toContainText('0.01 GBP'); await save().click(); await expect.poll(() => batch.acceptedSupplements.length).toBe(2);
  const effective = documentEffectiveSalesPrice(batch.records[2].currentRevision.data, shared.sid, shared); assert.equal(effective.salesPrice, '0.025'); assert.equal(effective.currency, 'GBP'); assert.equal(effective.unitPrice, '0.01'); assert.equal(batch.records[2].currentRevision.data.manualSalesPrices[0].currency, 'GBP');
  assert.equal(batch.job.supplement.descriptors.length, 0); publish(batch); await expect(jobDialog().getByRole('button', { name: '下载合并发票 XLSX', exact: true })).toHaveCount(1);
  const download = page.waitForEvent('download'); await jobDialog().getByRole('button', { name: '下载合并发票 XLSX', exact: true }).click(); await download; assert.equal(batch.downloads, 1); assert.equal(batch.bundleGenerations, 1); await context.close(); note();

  step = 'invalid-scientific-negative-and-round-zero-manual-prices-remain-blocking-and-retain-input';
  const invalid = fixture(); context = await setup(invalid); await openJob(); for (const amount of ['abc', '-1', '1e3', '0.01']) { await enter('USD', amount, 'Technical invalid input boundary'); await save().click(); await expect(jobDialog()).toContainText('20%'); await expect(price('USD')).toHaveValue(amount); assert.equal(invalid.acceptedSupplements.length, 0); }
  await noOutput(invalid); await context.close(); note();

  step = 'manual-price-and-real-reason-must-be-submitted-in-the-same-save';
  const noReason = fixture(); context = await setup(noReason); await openJob(); await enter('USD', '12.345'); await save().click(); await expect(jobDialog()).toContainText('同次填写'); await expect(price('USD')).toHaveValue('12.345'); assert.equal(noReason.acceptedSupplements.length, 0); await noOutput(noReason); await context.close(); note();

  step = '409-refetch-keeps-price-and-reason-after-descriptor-version-changes';
  const changed = fixture(); context = await setup(changed); await openJob(); await enter('USD', '17.55', 'Version conflict price evidence'); changed.modes.push('409'); await save().click(); await expect(jobDialog()).toContainText('售价版本冲突');
  await jobDialog().getByRole('button', { name: '刷新自动出单进度', exact: true }).click(); await expect(jobDialog().getByRole('button', { name: '已核对新版，保留填写继续', exact: true })).toBeVisible(); await expect(price('USD')).toHaveValue('17.55'); await expect(reason('USD')).toHaveValue('Version conflict price evidence'); await expect(save()).toBeDisabled();
  await jobDialog().getByRole('button', { name: '已核对新版，保留填写继续', exact: true }).click(); await save().click(); await expect.poll(() => changed.acceptedSupplements.length).toBe(1); assert.equal(changed.records[0].currentRevision.data.fields.remarks, 'OTHER-OPERATION-NOTE'); await noOutput(changed); await context.close(); note();

  step = 'known-valid-archived-remote-amount-cannot-be-hidden-behind-an-old-null-fact';
  const protectedPrice = fixture(); protectedPrice.archivePrices.set(protectedPrice.records[0].currentRevision.data.productSourceFacts[0].sourceFileId, '25.00'); context = await setup(protectedPrice); await openJob(); await enter('USD', '19.99', 'Cannot replace a known valid remote amount'); await save().click(); await expect(jobDialog()).toContainText('领星已有有效售价'); assert.equal(protectedPrice.acceptedSupplements.length, 0); assert(protectedPrice.records.every((record) => !record.currentRevision.data.manualSalesPrices)); await noOutput(protectedPrice); await context.close(); note();

  step = 'old-document-link-saves-explicit-manual-commands-without-price-fields-or-implicit-writes';
  const legacy = fixture(); context = await setup(legacy); const writesBefore = writes.length; await openLegacy(legacy.records[0]); assert.equal(writes.length, writesBefore); await legacyPrice().fill('12.345'); await legacyReason().fill('Legacy detail price evidence'); legacy.modes.push('503'); await legacySave().click(); await expect(wizard()).toContainText('售价保存失败'); await expect(legacyPrice()).toHaveValue('12.345'); await expect(legacyReason()).toHaveValue('Legacy detail price evidence');
  await legacySave().click(); await expect(legacySave()).toBeDisabled(); assert.deepEqual(legacy.revisionInputs[1], legacy.revisionInputs[0]); const command = legacy.acceptedRevisions[0]; commandsAreExact(command.manualSalesPrices); assert.equal(command.manualSalesPrices[0].salesPrice, '12.345'); assert(!Object.keys(command.fields).some((key) => /^product\..*\.(unitPrice|currency|salesPrice)$/.test(key))); assert.equal(command.manualSalesPrices[0].enteredCurrency, undefined); await expect(pricePanel()).toContainText('2.47 USD'); await expect(pricePanel()).toContainText('人工补充'); await context.close(); note();

  step = 'legacy-409-recovery-keeps-usd-input-and-requires-acknowledgement-before-using-gbp';
  const recovery = fixture(); context = await setup(recovery); await openLegacy(recovery.records[0]); await legacyPrice().fill('21.00'); await legacyReason().fill('Keep evidence while explicitly reviewing new GBP scope'); recovery.modes.push('currency409'); await legacySave().click(); await expect(wizard()).toContainText('售价版本冲突'); await wizard().getByRole('button', { name: '重新读取最新版本', exact: true }).click(); await wizard().getByRole('button', { name: '恢复未保存输入', exact: true }).click();
  await expect(legacyPrice('GBP')).toHaveValue('21.00'); await expect(legacyReason()).toHaveValue('Keep evidence while explicitly reviewing new GBP scope'); await expect(pricePanel()).toContainText('原填写币种为 USD'); await expect(legacySave()).toBeDisabled(); await pricePanel().getByRole('button', { name: '已核对，按 GBP 采用此售价', exact: true }).click(); await legacySave().click(); await expect(legacySave()).toBeDisabled(); assert.equal(recovery.acceptedRevisions[0].expectedVersion, 2); assert.equal(recovery.records[0].currentRevision.data.fields.remarks, 'OTHER-OPERATION-NOTE'); assert.equal(recovery.records[0].currentRevision.data.manualSalesPrices[0].currency, 'GBP'); commandsAreExact(recovery.acceptedRevisions[0].manualSalesPrices); await context.close(); note();

  step = 'valid-remote-price-always-wins-and-currency-conflicts-never-enable-fallback';
  const remote = fixture(); remote.records[0].currentRevision.data = manualData(remote, remote.records[0].currentRevision.data, [{ ...shared, salesPrice: '19.99', reason: 'Previous missing-price fallback' }]); const fact = remote.records[0].currentRevision.data.productSourceFacts[0]; fact.salesPrice = '30.00'; fact.unitPrice = '6.00'; fact.sourceFileId = uid(); refresh(remote);
  context = await setup(remote); await openLegacy(remote.records[0]); await expect(pricePanel()).toContainText('6.00 USD'); await expect(legacyPrice()).toHaveCount(0);
  remote.records[3].currentRevision.data.productSourceFacts[0].currency = 'EUR'; await openLegacy(remote.records[3], valid); await expect(pricePanel(valid)).toContainText('售价币种 EUR 与整票币种 USD 不一致'); await expect(pricePanel(valid).getByLabel('人工补充售价（USD）', { exact: true })).toHaveCount(0); await context.close(); note();

  step = 'manual-price-areas-fit-desktop-and-narrow-screens-with-fixed-modal-headings';
  const layout = fixture(); context = await setup(layout); await openLegacy(layout.records[0]); await legacyPrice().fill('19.99'); await legacyReason().fill('Visible technical selling-price evidence');
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); await pricePanel().evaluate((node) => { const body = node.closest('.import-dialog-body'); if (body) body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - (body.querySelector('.document-details-progress')?.getBoundingClientRect().height || 0) - 16; }); await expect(wizard().getByRole('heading', { name: '发票与单据向导', exact: true })).toBeInViewport(); assert.equal(await wizard().evaluate((node) => node.scrollTop), 0); for (const input of [legacyPrice(), legacyReason()]) { const bounds = await input.boundingBox(); assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1); } assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await shot('manual-selling-price-' + width + '.png'); }
  await context.close(); note(); assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []);
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-manual-selling-price-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests, writes, realBusinessWrites: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
