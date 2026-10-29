import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentSchema, documentRevisionInputSchema, documentExportSchema, withDocumentInvoiceDefaults } from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';

// Local browser fixtures only. HTTP writes below update this process's memory;
// all external requests are blocked and no real business service is contacted.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.DOCUMENT_DEFAULTS_EVIDENCE_DIR || resolve(root, '.local/m4/document-defaults'));
const screenshotsOnly = process.env.DOCUMENT_DEFAULTS_SCREENSHOTS_ONLY === '1';
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-25T03:00:00.000Z', uid = () => randomUUID();
const checks = [], browserErrors = [], unexpectedRequests = [], externalRequests = [], releases = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
const countryCode = { 美国: 'US', 英国: 'GB', 德国: 'DE', 法国: 'FR', 西班牙: 'ES', 意大利: 'IT', 加拿大: 'CA' };
const currencyLabel = { USD: '美元（USD）', GBP: '英镑（GBP）', EUR: '欧元（EUR）' };
const addressLabels = { addressCode: '地址代码', recipientName: '收件人', recipientCompany: '收件公司', addressLine1: '地址第 1 行', addressLine2: '地址第 2 行', addressLine3: '地址第 3 行', city: '城市', state: '州 / 省', postalCode: '邮编', countryCode: '国家代码', phone: '电话', email: '邮箱' };
const completeAddress = { addressCode: 'ADDR-ONLY', recipientName: 'Technical Receiver', recipientCompany: 'Technical Company', addressLine1: '1 Lingxing Source Road', addressLine2: '', addressLine3: '', city: 'Lingxing City', state: 'CA', postalCode: '90001', countryCode: 'US', phone: '10000000000', email: '' };
function member(country = '美国', addressCode = 'ADDR-ONLY', index = 1) {
  const demandId = uid(), groupId = uid(), shipmentId = uid(), boxId = uid();
  const item = { msku: 'DEFAULT-' + index, fnsku: 'FN-' + index, sku: 'SKU-' + index, name: '技术商品', quantity: '100', expiration: null, prepOwner: null, labelOwner: null };
  const fba = 'FBADEFAULTS' + index;
  return { source: { weekStartDate: '2026-10-19', groupId, groupVersion: 1, m2ConfirmationId: uid(), demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null },
    demand: { id: demandId, snapshot: { sid: 100 + index, fba, shop: 'Technical ' + country, country, channel: 'SEA', destinationFc: 'FC-LEGACY', destinationAddress: '', referenceQuantity: null, notes: null, subBatchName: null }, version: 1,
      businessDate: '2026-10-25', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', createdAt: now, updatedAt: now },
    shipment: { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: 100 + index, fba, items: [item], boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, weight: '10', weightUnit: 'KG', length: '30', width: '20', height: '10', dimensionUnit: 'CM', items: [item] }], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'Technical fixture', createdBy: 'fixture', createdAt: now },
    codes: [{ id: uid(), groupId, demandId, boxId, prefix: 'A', sequence: index, code: 'A' + index, valid: true, createdAt: now }], physical: null,
    sourceCandidates: { addresses: addressCode === undefined ? [] : [{ source: 'getShipmentDetails', snapshotId: uid(), data: { addressCode, countryCode: countryCode[country] || 'CA' } }], products: [], issues: [] } };
}
function record({ countries = ['美国'], rawCurrency, emptyAddress = false, code = 'ADDR-ONLY', retired = false } = {}) {
  const id = uid(), members = countries.map((country, index) => member(country, code, index + 1));
  const fields = withDocumentInvoiceDefaults({ service: 'TECH SERVICE', currency: rawCurrency || 'USD', customsMode: '普通报关', taxMode: '包税',
    ...(emptyAddress ? {} : { ...completeAddress, countryCode: countryCode[countries[0]] || 'CA', addressConfirmed: 'true', addressConfirmationReason: 'Previously checked address', addressSelectionMode: 'manual' }) }, members);
  if (rawCurrency !== undefined) fields.currency = rawCurrency;
  if (retired) Object.assign(fields, { orderNumber: 'OLD-ORDER', reference: 'OLD-REFERENCE', tradeTerms: 'OLD-TERMS' });
  return documentSchema.parse({ id, purpose: 'invoice', status: 'draft', version: 1, createdBy: 'fixture', createdAt: now, updatedAt: now,
    currentRevision: { id: uid(), documentId: id, version: 1, reason: 'Technical fixture', createdBy: 'fixture', createdAt: now,
      data: { purpose: 'invoice', weekStartDate: '2026-10-19', title: 'Invoice defaults technical fixture', fields, members, profileReferences: [], templateReference: null, generationRulesVersion: 'v2', productSourceFacts: [] } } });
}
function profile(data = {}, extra = {}) { return { id: uid(), category: 'address', key: 'TECH-ADDRESS-' + uid().slice(0, 6), version: 1, status: 'active', data: { destinationFc: 'FC-DIFFERENT', ...completeAddress, ...data }, createdBy: 'fixture', createdAt: now, ...extra }; }
function fixture(options) { return { document: record(options), exports: [], profiles: [], profileMode: 'ready', holdProfiles: false, releaseProfiles: null, profileReads: 0, revisions: [], validations: [], exportCalls: 0 }; }
function setLingxingAddress(state, data = completeAddress) {
  for (const member of state.document.currentRevision.data.members) member.sourceCandidates.addresses = [{ source: 'getShipmentDetails', snapshotId: uid(), data: { ...data } }];
}
async function setup(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseURL) { externalRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/v1/session') return json({ user: { id: 'document-defaults-fixture', name: 'Invoice defaults UI check', email: 'defaults@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/documents/automations' && method === 'GET') return json({ items: [] });
    if (path === '/api/v1/documents' && method === 'GET') return json({ items: [state.document], total: 1, page: 1, pageSize: 20 });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (path === '/api/v1/document-templates') return json({ items: [] });
    if (path === '/api/v1/document-profiles') {
      state.profileReads += 1;
      if (state.holdProfiles) await new Promise((done) => { state.releaseProfiles = () => { state.holdProfiles = false; done(); }; releases.push(state.releaseProfiles); });
      return state.profileMode === 'error' ? json({ error: { code: 'FIXTURE_PROFILES_FAILED', message: '技术夹具：单据资料读取失败。' } }, 503) : json({ items: state.profiles });
    }
    const base = '/api/v1/documents/' + state.document.id;
    if (path === base && method === 'GET') return json({ document: state.document, validation: null, exports: state.exports });
    if (path === base + '/revisions' && method === 'POST') {
      const input = documentRevisionInputSchema.parse(request.postDataJSON()); state.revisions.push(input);
      assert.equal(input.expectedVersion, state.document.version); state.document.version += 1;
      const previous = state.document.currentRevision.data;
      state.document.currentRevision = { ...state.document.currentRevision, id: uid(), version: state.document.version, reason: input.reason,
        data: { ...previous, title: input.title ?? previous.title, fields: input.fields ?? previous.fields,
          profileReferences: input.profileReferences?.map((reference) => ({ ...reference, data: state.profiles.find((item) => item.id === reference.profileId && item.version === reference.version)?.data || previous.profileReferences.find((item) => item.profileId === reference.profileId)?.data || {} })) ?? previous.profileReferences,
          templateReference: input.templateReference === undefined ? previous.templateReference : input.templateReference } };
      return json({ document: documentSchema.parse(state.document), replayed: false });
    }
    if (path === base + '/validate' && method === 'POST') {
      state.validations.push(request.postDataJSON());
      return json({ validation: { documentId: state.document.id, version: state.document.version, valid: false, checkedAt: now,
        issues: [{ code: 'DOCUMENT_TICKET_CURRENCY_CONFLICT', severity: 'error', message: '本票包含不同币种的国家，请按币种拆分出单。' }] }, replayed: false });
    }
    if (path === base + '/exports' && method === 'POST') state.exportCalls += 1;
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: method + ' ' + path } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message)); return context;
}
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const addressSection = () => wizard().locator('.document-address-section');
const addressField = (label) => addressSection().getByLabel(label, { exact: true });
const currency = () => wizard().locator('.document-edit-form').getByLabel('币种', { exact: true }).first();
const save = () => wizard().locator('.import-wizard-footer').getByRole('button', { name: '保存草稿', exact: true });
async function open(state) { await page.goto('/shipping?view=documents&documentId=' + state.document.id, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await expect(wizard()).toBeVisible(); await wizard().getByRole('navigation', { name: '单据制作步骤', exact: true }).getByRole('button', { name: '单票资料', exact: true }).click(); await expect(currency()).toBeVisible(); }
async function reload() { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }); }
async function screenshot(name) { await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' }); }
async function revealInBody(locator) {
  await locator.evaluate((node) => {
    const body = node.closest('.import-dialog-body'), target = node.closest('.field') || node;
    if (body) body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - (body.querySelector('.document-details-progress')?.getBoundingClientRect().height || 0) - 16;
  });
  await expect(wizard().getByRole('heading', { name: '发票与单据向导', exact: true })).toBeInViewport();
  assert.equal(await wizard().evaluate((node) => node.scrollTop), 0);
}

try {
  await mkdir(evidence, { recursive: true }); const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  let context;

  if (!screenshotsOnly) {
  step = 'retired-order-reference-and-trade-terms-are-hidden-and-saved-as-empty';
  const retired = fixture({ retired: true }); context = await setup(retired); await open(retired);
  for (const label of ['订单编号', '参考号', '贸易条款']) await expect(wizard().getByLabel(label, { exact: true })).toHaveCount(0);
  assert.equal(retired.revisions.length, 0); await expect(save()).toBeEnabled(); await save().click(); await expect(save()).toBeDisabled();
  for (const key of ['orderNumber', 'reference', 'tradeTerms']) assert.equal(retired.revisions[0].fields[key], null); await context.close(); note();

  step = 'supported-countries-refresh-old-currency-readonly-without-an-automatic-write';
  for (const [country, expected] of [['美国', 'USD'], ['英国', 'GBP'], ['德国', 'EUR'], ['法国', 'EUR'], ['西班牙', 'EUR'], ['意大利', 'EUR']]) {
    const oldCurrency = expected === 'USD' ? 'EUR' : 'USD', state = fixture({ countries: [country], rawCurrency: oldCurrency }); context = await setup(state); await open(state);
    await expect(currency()).toHaveJSProperty('readOnly', true); await expect(currency()).toHaveValue(currencyLabel[expected]); await expect(currency()).toHaveAttribute('aria-describedby', /.+/);
    assert.equal(state.document.currentRevision.data.fields.currency, oldCurrency); assert.equal(state.revisions.length, 0);
    await reload(); await expect(currency()).toHaveValue(currencyLabel[expected]); await save().click(); await expect(save()).toBeDisabled(); assert.equal(state.revisions[0].fields.currency, expected);
    await reload(); await expect(currency()).toHaveValue(currencyLabel[expected]); await expect(save()).toBeDisabled(); await context.close();
  }
  note();

  step = 'unknown-country-keeps-the-manual-currency-fallback';
  const unknown = fixture({ countries: ['加拿大'], rawCurrency: 'GBP' }); context = await setup(unknown); await open(unknown);
  await expect(currency()).toHaveAttribute('role', 'combobox'); await expect(currency()).toBeEnabled(); await expect(currency()).toHaveAttribute('data-value', 'GBP');
  await chooseOption(currency(), 'EUR'); await save().click(); await expect(save()).toBeDisabled(); assert.equal(unknown.revisions[0].fields.currency, 'EUR'); await context.close(); note();

  step = 'mixed-country-currencies-require-splitting-and-cannot-generate';
  const mixed = fixture({ countries: ['美国', '英国'] }); context = await setup(mixed); await open(mixed); await expect(currency()).toHaveValue('请按币种拆分出单');
  await wizard().locator('.import-wizard-footer').getByRole('button', { name: '下一步', exact: true }).click(); await wizard().getByRole('button', { name: '校验当前版本', exact: true }).click();
  await expect(wizard().locator('.document-issues')).toContainText('按币种拆分出单'); await expect(wizard().getByRole('button', { name: '生成待复核发票', exact: true })).toBeDisabled();
  assert.equal(mixed.revisions.length, 0); assert.equal(mixed.validations.length, 1); assert.equal(mixed.exportCalls, 0); await context.close(); note();

  step = 'lingxing-source-replaces-the-whole-address-without-using-a-local-profile';
  const unique = fixture({ emptyAddress: true }); setLingxingAddress(unique);
  unique.profiles = [profile({ city: 'Wrong Local Profile City' })];
  context = await setup(unique); await open(unique);
  await expect(addressSection().getByRole('button', { name: /管理地址簿|保存到地址簿|在地址簿补全/ })).toHaveCount(0);
  await expect(addressField('地址来源')).toContainText('领星');
  await addressSection().getByRole('button', { name: '采用地址', exact: true }).click();
  for (const [key, label] of Object.entries(addressLabels)) await expect(addressField(label)).toHaveValue(completeAddress[key] || '');
  await expect(addressField('已核对并确认本票采用的完整收件地址')).not.toBeChecked(); await expect(addressField('地址核对 / 冲突处理原因')).toHaveValue('');
  await expect(addressSection().getByRole('status', { name: '地址确认状态', exact: true })).toHaveText('待核对确认'); assert.equal(unique.revisions.length, 0);
  await addressField('地址核对 / 冲突处理原因').fill('Explicitly checked Lingxing source address'); await addressField('已核对并确认本票采用的完整收件地址').check(); await save().click(); await expect(save()).toBeDisabled();
  assert(!unique.revisions[0].profileReferences.some((reference) => reference.category === 'address')); assert.equal(unique.revisions[0].fields.addressSelectionMode, 'lingxing'); assert.equal(unique.revisions[0].confirmAddress, true); await context.close(); note();

  step = 'local-address-profiles-never-fill-an-empty-ticket-or-appear-as-a-source';
  for (const kind of ['unique', 'ambiguous', 'incomplete']) {
    const state = fixture({ emptyAddress: true }); state.document.currentRevision.data.members[0].sourceCandidates.addresses = [];
    state.profiles = kind === 'unique' ? [profile()] : kind === 'ambiguous' ? [profile(), profile({ city: 'Another Matching City' })] : [profile({ postalCode: '' })];
    context = await setup(state); await open(state); await expect.poll(() => state.profileReads).toBe(1); await expect(addressField('地址来源')).toBeEnabled();
    await expect(addressField('城市')).toHaveValue(''); await expect(addressField('收件人')).toHaveValue(''); await expect(addressSection()).toContainText('当前货件尚无领星地址');
    await addressField('地址来源').click(); await expect(page.getByRole('option')).toHaveCount(1); await page.keyboard.press('Escape');
    assert.equal(state.revisions.length, 0); await context.close();
  }
  note();

  step = 'unrelated-profile-request-failure-does-not-block-lingxing-address-adoption';
  const network = fixture({ emptyAddress: true }); setLingxingAddress(network); network.profileMode = 'error'; context = await setup(network); await open(network);
  await expect(addressField('地址来源')).toBeEnabled(); await expect(addressSection().getByRole('alert')).toHaveCount(0);
  await addressSection().getByRole('button', { name: '采用地址', exact: true }).click(); await expect(addressField('城市')).toHaveValue('Lingxing City');
  await expect(addressField('城市')).toBeEnabled(); assert.equal(network.revisions.length, 0); await context.close(); note();

  step = 'manual-input-and-confirmation-are-not-replaced-when-a-delayed-profile-request-finishes';
  const manual = fixture({ emptyAddress: true }); manual.profiles = [profile()]; manual.holdProfiles = true; context = await setup(manual); await open(manual); await expect.poll(() => typeof manual.releaseProfiles).toBe('function');
  for (const [label, value] of [['收件人', 'Manual Receiver'], ['地址第 1 行', 'Manual Technical Road'], ['城市', 'Manual City'], ['邮编', '90210'], ['国家代码', 'US']]) await addressField(label).fill(value);
  await addressField('地址核对 / 冲突处理原因').fill('Manually checked before directory response'); await addressField('已核对并确认本票采用的完整收件地址').check();
  manual.releaseProfiles(); await expect(addressField('地址来源')).toBeEnabled(); await expect(addressField('城市')).toHaveValue('Manual City'); await expect(addressField('收件人')).toHaveValue('Manual Receiver');
  await expect(addressField('已核对并确认本票采用的完整收件地址')).toBeChecked(); await expect(addressField('地址核对 / 冲突处理原因')).toHaveValue('Manually checked before directory response');
  assert.equal(manual.revisions.length, 0); await save().click(); await expect(save()).toBeDisabled(); assert(!manual.revisions[0].profileReferences.some((reference) => reference.category === 'address')); await context.close(); note();

  step = 'existing-manual-confirmed-and-historical-addresses-survive-profile-refresh';
  for (const kind of ['manual', 'unconfirmed-existing', 'confirmed', 'reference', 'empty-manual']) {
    const state = fixture(), current = profile({ city: 'Updated Directory City' }); state.profiles = [current]; state.document.currentRevision.data.fields.city = 'Saved Manual City';
    if (kind === 'manual') { state.document.currentRevision.data.fields.addressConfirmed = 'false'; state.document.currentRevision.data.fields.addressConfirmationReason = ''; }
    if (kind === 'unconfirmed-existing') { state.document.currentRevision.data.fields.addressSelectionMode = null; state.document.currentRevision.data.fields.addressConfirmed = 'false'; state.document.currentRevision.data.fields.addressConfirmationReason = ''; }
    if (kind === 'empty-manual') { for (const key of Object.keys(addressLabels)) state.document.currentRevision.data.fields[key] = null; state.document.currentRevision.data.fields.addressConfirmed = 'false'; state.document.currentRevision.data.fields.addressConfirmationReason = ''; }
    if (kind === 'reference') { state.document.currentRevision.data.fields.addressSelectionMode = 'profile'; state.profiles[0].version = 2; state.document.currentRevision.data.profileReferences = [{ category: 'address', profileId: current.id, version: 1, data: { ...current.data, city: 'Saved Manual City' } }]; }
    context = await setup(state); await open(state); if (await addressField('城市').isVisible() === false) await addressSection().getByLabel('修改地址 / 更换来源', { exact: true }).click();
    await expect(addressField('城市')).toHaveValue(kind === 'empty-manual' ? '' : 'Saved Manual City'); assert.equal(state.revisions.length, 0); await context.close();
  }
  note();

  step = 'generated-files-keep-their-saved-snapshot-and-do-not-reapply-address-or-currency-defaults';
  const frozen = fixture({ rawCurrency: 'GBP', emptyAddress: true, retired: true }); frozen.document.status = 'pending_review'; frozen.profiles = [profile()];
  frozen.exports = [documentExportSchema.parse({ id: uid(), status: 'completed', reference: { documentId: frozen.document.id, revisionId: frozen.document.currentRevision.id, revisionVersion: frozen.document.version, templateId: uid(), templateVersion: 1, templateSha256: 'a'.repeat(64), generationRulesVersion: 'v2', sources: frozen.document.currentRevision.data.members.map((member) => member.source) }, fileId: uid(), fileSha256: 'b'.repeat(64), error: null, createdAt: now, completedAt: now, valid: true, invalidReason: null })];
  context = await setup(frozen); await open(frozen); await expect(currency()).toHaveAttribute('data-value', 'GBP'); await expect(currency()).toHaveText('英镑（GBP）'); await expect(currency()).toBeDisabled();
  await expect(addressField('城市')).toHaveValue(''); await expect(addressField('城市')).toBeDisabled(); await expect(save()).toHaveCount(0);
  assert.equal(frozen.revisions.length, 0); await context.close(); note();
  }

  step = 'readonly-currency-and-automatic-address-fit-desktop-and-narrow-viewports';
  const narrow = fixture({ emptyAddress: true }); setLingxingAddress(narrow); context = await setup(narrow); await open(narrow);
  await addressSection().getByRole('button', { name: '采用地址', exact: true }).click(); await expect(addressField('城市')).toHaveValue('Lingxing City');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await wizard().locator(':scope > .import-dialog-body').evaluate((node) => { node.scrollTop = 0; });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); const bounds = await currency().boundingBox(); assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1);
    await expect(wizard().getByRole('heading', { name: '发票与单据向导', exact: true })).toBeVisible(); await screenshot('document-defaults-' + width + '.png');
    await revealInBody(currency()); await expect(currency()).toBeInViewport(); assert(await currency().evaluate((node) => { const bounds = node.getBoundingClientRect(), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); return hit === node || node.contains(hit); })); await screenshot('document-currency-' + width + '.png');
    await revealInBody(addressSection()); await expect(addressSection()).toBeInViewport(); await screenshot('document-address-' + width + '.png');
  }
  assert.equal(narrow.revisions.length, 0); await context.close(); note();
  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []);
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { releases.forEach((release) => release()); await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-document-defaults-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests, realBusinessWrites: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
