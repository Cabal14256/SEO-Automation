import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentBoxFieldKey, documentRevisionInputSchema, documentSchema, withDocumentDefaults as documentFlagDefaults } from '../../packages/contracts/dist/index.js';

const withDocumentDefaults = (fields = {}) => documentFlagDefaults({ orderNumber: null, reference: null, tradeTerms: null, currency: 'USD', ...fields });

// All requests are handled by local fixtures. Revision responses update this
// process's memory only; no real account, database, parser, or service is used.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.DOCUMENT_DETAILS_EVIDENCE_DIR || resolve(root, '.local/m4/document-details'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-24T03:00:00.000Z', week = '2026-10-19', uid = () => randomUUID();
const checks = [], browserErrors = [], unexpectedRequests = [], externalRequests = [], heldReleases = [], revisionEvidence = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
const address = { recipientName: 'Technical Receiver', recipientCompany: 'Fixture Company', addressLine1: '1 Technical Road', addressLine2: '', addressLine3: '',
  city: 'Test City', state: 'CA', postalCode: '90001', countryCode: 'US', phone: '10000000000', email: '', addressCode: 'TEST1' };
function makeMember(index, count) {
  const demandId = uid(), groupId = uid(), shipmentId = uid(), m2 = uid();
  const fba = index === 1 ? 'FBADETAILSA' : 'FBADETAILSB', codePrefix = index === 1 ? 'A' : 'B';
  const product = { msku: index === 1 ? 'DETAIL-ALPHA' : 'DETAIL-BETA', fnsku: 'FNSKU-' + index, sku: 'SKU-' + index, name: '技术商品', quantity: '100', expiration: null, prepOwner: null, labelOwner: null };
  const boxes = Array.from({ length: count }, (_, number) => ({ id: uid(), externalBoxId: null, packageId: null, localBoxId: String(number + 1), name: null, order: number + 1,
    weight: String(10 + index + number), weightUnit: 'KG', length: String(30 + index + number), width: String(20 + index + number), height: String(15 + index + number), dimensionUnit: 'CM', items: [product] }));
  const demand = { id: demandId, snapshot: { sid: 101, fba, shop: 'Technical US Shop', country: '美国', channel: 'SEA', destinationFc: 'TEST1', destinationAddress: '1 Technical Road, Test City US', referenceQuantity: null, notes: null, subBatchName: null }, version: 1,
    businessDate: '2026-10-23', weekStartDate: week, weekEndDate: '2026-10-25', createdAt: now, updatedAt: now };
  const shipment = { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: 101, fba, items: [product], boxes, observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'Technical fixture', createdBy: 'fixture', createdAt: now };
  const codes = boxes.map((box, number) => ({ id: uid(), groupId, demandId, boxId: box.id, prefix: codePrefix, sequence: number + 1, code: codePrefix + (number + 1), valid: true, createdAt: now }));
  const boxSource = boxes.map((box, number) => ({ demandId, shipmentRevisionId: shipmentId, boxId: box.id, sid: 101, fba, code: codes[number].code, order: number + 1, po: 'SOURCE-PO-' + codes[number].code,
    range: fba + '000001-' + count, raw: { weight: box.weight, weightUnit: 'KG', length: box.length, width: box.width, height: box.height, dimensionUnit: 'CM' },
    values: { weight: Number(box.weight).toFixed(2), length: Number(box.length).toFixed(2), width: Number(box.width).toFixed(2), height: Number(box.height).toFixed(2) }, items: [product], sourceObservedAt: now }));
  return { source: { weekStartDate: week, groupId, groupVersion: 1, m2ConfirmationId: m2, demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null },
    demand, shipment, codes, physical: null, boxSource, sourceCandidates: { addresses: [{ source: 'listShipments', snapshotId: uid(), data: address }], products: [], issues: [] } };
}
function fixture() {
  const members = [makeMember(1, 2), makeMember(2, 1)];
  const references = members.map((member) => ({ category: 'product', profileId: uid(), version: 1, data: { sid: 101, ...member.shipment.data.items[0],
    englishName: 'Technical Product', chineseName: '技术商品', material: 'Glass', hsCode: '700719', use: 'Protect screen', brand: 'TECH', model: 'TEST', unit: 'piece', salesLink: 'https://example.invalid/product' } }));
  const profiles = references.map((reference, index) => ({ id: reference.profileId, category: 'product', key: 'DETAIL-PROFILE-' + index, version: 1, status: 'active', data: reference.data, createdBy: 'fixture', createdAt: now }));
  const template = { id: uid(), purpose: 'invoice', name: 'Technical Invoice Template', version: 1, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: 'a'.repeat(64), fileId: uid(), status: 'active', createdBy: 'fixture', createdAt: now };
  const productSourceFacts = members.map((member) => ({ sid: 101, ...Object.fromEntries(['msku', 'fnsku', 'sku'].map((key) => [key, member.shipment.data.items[0][key]])),
    salesPrice: '20.00', unitPrice: '4.00', currency: 'USD', cartonQuantity: '100', sourceFileId: uid(), sourceSha256: 'b'.repeat(64), fetchedAt: now }));
  const makeRecord = (title) => {
    const id = uid();
    return documentSchema.parse({ id, purpose: 'invoice', status: 'draft', version: 1, createdBy: 'fixture', createdAt: now, updatedAt: now,
      currentRevision: { id: uid(), documentId: id, version: 1, reason: 'Technical fixture', createdBy: 'fixture', createdAt: now,
        data: { purpose: 'invoice', weekStartDate: week, title, generationRulesVersion: 'v2', productSourceFacts: structuredClone(productSourceFacts), members: structuredClone(members), profileReferences: structuredClone(references),
          templateReference: { templateId: template.id, version: 1, sha256: template.sha256, fileId: template.fileId },
          fields: withDocumentDefaults({ service: 'TECH SERVICE', customsMode: '9810', clearanceMode: '一般贸易清关', taxMode: '包税', deliveryStation: '交货仓库', currency: 'USD',
            ...address, addressConfirmed: 'true', addressConfirmationReason: 'Fixture address explicitly checked', addressSelectionMode: 'manual', addressAdoptionVersion: 'explicit/v1', addressSourceLabel: 'Technical source' }) } } });
  };
  const complete = makeRecord('Complete details fixture'), incomplete = makeRecord('Missing details fixture'), unconfirmed = makeRecord('Unconfirmed address fixture'), conflicted = makeRecord('Conflicting address fixture');
  incomplete.currentRevision.data.fields.service = ''; incomplete.currentRevision.data.fields.city = ''; incomplete.currentRevision.data.fields.addressConfirmed = 'false';
  incomplete.currentRevision.data.profileReferences[0].data.material = '';
  incomplete.currentRevision.data.members[0].boxSource[1].values.weight = null; incomplete.currentRevision.data.members[0].boxSource[1].raw.weight = null;
  unconfirmed.currentRevision.data.fields.addressConfirmed = 'false'; unconfirmed.currentRevision.data.fields.addressConfirmationReason = '';
  conflicted.currentRevision.data.members[1].sourceCandidates.addresses[0].data = { ...address, addressLine1: 'Different Technical Address' };
  const records = [complete, incomplete, unconfirmed, conflicted]; records.forEach((record) => documentSchema.parse(record));
  return { complete, incomplete, unconfirmed, conflicted, records, profiles, template, attempts: [], accepted: [], modes: [], holdRevision: false, releaseRevision: null, detailFailures: 0,
    validateCalls: 0, exportCalls: 0, sourceSnapshot: JSON.stringify(complete.currentRevision.data.members), originalMembers: structuredClone(members) };
}
async function setup(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseURL) { externalRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/v1/session') return json({ user: { id: 'document-details-fixture', name: 'Details UI fixture', email: 'details@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/documents/automations' && method === 'GET') return json({ items: [] });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (path === '/api/v1/document-profiles') return json({ items: state.profiles });
    if (path === '/api/v1/document-templates') return json({ items: [state.template] });
    if (path === '/api/v1/documents' && method === 'GET') return json({ items: state.records, total: state.records.length, page: 1, pageSize: 20 });
    const match = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const record = state.records.find((item) => item.id === match[1]), action = match[2] || ''; assert(record, 'Unknown fixture document');
      if (method === 'GET' && !action) {
        if (state.detailFailures > 0) { state.detailFailures -= 1; return json({ error: { code: 'FIXTURE_DETAIL_READ', message: '技术夹具：读取单据失败。' } }, 503); }
        return json({ document: documentSchema.parse(record), validation: null, exports: [] });
      }
      if (method === 'GET' && action === 'history') return json({ revisions: [record.currentRevision], reviews: [], validations: [] });
      if (method === 'POST' && action === 'revisions') {
        const input = documentRevisionInputSchema.parse(request.postDataJSON()); state.attempts.push(input); revisionEvidence.push(input);
        if (state.holdRevision) await new Promise((release) => { state.releaseRevision = () => { state.holdRevision = false; release(); }; heldReleases.push(state.releaseRevision); });
        const mode = state.modes.shift() || 'ready';
        if (mode === '503') return json({ error: { code: 'FIXTURE_SAVE_FAILED', message: '技术夹具：保存失败，原填写已保留。' } }, 503);
        if (mode === '409') {
          record.version += 1; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, data: { ...record.currentRevision.data,
            title: 'OTHER-USER-TITLE', fields: { ...record.currentRevision.data.fields, [documentBoxFieldKey(record.currentRevision.data.members[0].boxSource[0].boxId, 'width')]: '29' } } };
          return json({ error: { code: 'DOCUMENT_VERSION_CONFLICT', message: '技术夹具：单据版本冲突。' } }, 409);
        }
        assert.equal(input.expectedVersion, record.version, 'Successful saves pin the current fixture version');
        state.accepted.push(input); record.version += 1;
        const previous = record.currentRevision.data;
        record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, reason: input.reason, data: { ...previous,
          title: input.title ?? previous.title, fields: input.fields ?? previous.fields,
          profileReferences: input.profileReferences?.map((reference) => ({ ...reference, data: previous.profileReferences.find((old) => old.profileId === reference.profileId)?.data || {} })) ?? previous.profileReferences,
          templateReference: input.templateReference === undefined ? previous.templateReference : input.templateReference } };
        return json({ document: documentSchema.parse(record), replayed: false });
      }
      if (method === 'POST' && action === 'validate') state.validateCalls += 1;
      if (method === 'POST' && action === 'exports') state.exportCalls += 1;
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: method + ' ' + path } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  return context;
}
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const footer = () => wizard().locator('.import-wizard-footer');
const nav = () => wizard().getByRole('navigation', { name: '单据制作步骤', exact: true });
const currentStage = (label) => expect(nav().locator('[aria-current="step"]')).toContainText(label);
const save = () => footer().getByRole('button', { name: '保存草稿', exact: true });
const next = () => footer().getByRole('button', { name: /^(保存并下一步|下一步)$/ });
const boxFields = () => wizard().locator('.document-box-adjustments');
const boxField = (code, label) => boxFields().getByRole('textbox', { name: code + ' ' + label, exact: true });
async function open(record) { await page.goto('/shipping?view=documents&documentId=' + record.id); await currentStage('单票资料'); await expect(wizard().getByLabel('草稿名称', { exact: true })).toHaveValue(record.currentRevision.data.title); }
async function screenshot(name) {
  await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))), new Promise((done) => setTimeout(done, 500))]));
  await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' });
}

const completion = () => wizard().getByRole('navigation', { name: '单票资料完成情况', exact: true });
const addressSection = () => wizard().locator('.document-address-section');
const addressEditor = () => addressSection().locator('details[data-section-editor="address"]');
const addressStatus = () => addressSection().getByRole('status', { name: '地址确认状态', exact: true });
const boxRow = (code) => boxFields().getByRole('rowgroup', { name: '箱 ' + code + ' 制单资料', exact: true });
const boxChoice = (code) => boxFields().getByRole('checkbox', { name: '选择箱 ' + code, exact: true });
const filterBoxes = (name) => boxFields().getByRole('group', { name: '箱资料筛选', exact: true }).getByRole('button', { name: new RegExp('^' + name) }).click();
const applyBatch = () => boxFields().getByRole('button', { name: /^应用到 \d+ 个选中箱$/ });
async function sectionFocus(section) { await expect.poll(() => section.evaluate((node) => node.contains(document.activeElement))).toBe(true); }
async function modalFrame() {
  const title = wizard().getByRole('heading', { name: '发票与单据向导', exact: true }); await expect(title).toBeVisible();
  const bounds = await title.boundingBox(), viewport = page.viewportSize(); assert(bounds && bounds.y >= -1 && bounds.y + bounds.height <= viewport.height + 1, 'Modal title remains inside the viewport after locating a section');
  await expect.poll(() => wizard().evaluate((node) => node.scrollTop)).toBe(0);
}
function noGeneration(state) { assert.equal(state.validateCalls, 0); assert.equal(state.exportCalls, 0); }

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });

  step = 'unchanged-next-enters-generation-without-saving-validating-or-exporting';
  const state = fixture(); let context = await setup(state); await open(state.complete);
  await expect(completion().getByRole('button')).toHaveCount(4); await expect(completion()).not.toContainText('正在读取商品');
  await wizard().locator(':scope > .import-dialog-body').evaluate((node) => { node.scrollTop = 0; }); await modalFrame(); await screenshot('document-details-overview-1440.png');
  await expect(save()).toBeDisabled(); await expect(next()).toHaveText('下一步'); await next().click(); await currentStage('校验与生成');
  assert.equal(state.attempts.length, 0); noGeneration(state); await footer().getByRole('button', { name: '上一步', exact: true }).click(); await currentStage('单票资料'); note();

  step = 'dirty-navigation-cannot-skip-save-and-source-navigation-preserves-input';
  await wizard().getByLabel('草稿名称', { exact: true }).fill('UNSAVED-NAV-GUARD');
  for (const label of ['校验与生成', '文件与复核']) await expect(nav().getByRole('button', { name: label, exact: true })).toBeDisabled();
  await nav().getByRole('button', { name: '货件与来源', exact: true }).click(); await currentStage('货件与来源'); assert.equal(state.attempts.length, 0);
  await nav().getByRole('button', { name: '单票资料', exact: true }).click(); await expect(wizard().getByLabel('草稿名称', { exact: true })).toHaveValue('UNSAVED-NAV-GUARD');
  await expect(next()).toHaveText('保存并下一步'); note();

  step = 'save-failure-stays-on-details-and-explicit-retry-keeps-the-original-operation';
  state.modes = ['503', 'ready']; state.holdRevision = true; await next().dblclick(); await expect.poll(() => state.attempts.length).toBe(1);
  await expect.poll(() => typeof state.releaseRevision).toBe('function'); await currentStage('单票资料');
  await expect(save()).toBeDisabled(); for (const button of await nav().getByRole('button').all()) await expect(button).toBeDisabled();
  state.releaseRevision(); await expect(wizard().getByRole('alert')).toContainText('保存失败'); await currentStage('单票资料');
  await expect(wizard().getByLabel('草稿名称', { exact: true })).toHaveValue('UNSAVED-NAV-GUARD'); await expect(next()).toBeEnabled();
  const firstAttempt = structuredClone(state.attempts[0]); await next().click(); await currentStage('校验与生成');
  assert.equal(state.attempts.length, 2); assert.deepEqual(state.attempts[1], firstAttempt); assert.equal(state.complete.version, 2);
  await expect(wizard().locator('.document-summary')).toContainText('v2'); noGeneration(state);
  await footer().getByRole('button', { name: '上一步', exact: true }).click(); await expect(wizard().getByLabel('草稿名称', { exact: true })).toHaveValue('UNSAVED-NAV-GUARD');
  await expect(save()).toBeDisabled(); await expect(next()).toHaveText('下一步'); note();

  step = 'save-draft-only-persists-the-revision-and-keeps-details-open';
  await wizard().getByLabel('草稿名称', { exact: true }).fill('SAVE-ONLY-ORDER'); await save().click(); await expect(save()).toBeDisabled(); await currentStage('单票资料');
  await expect(wizard().locator('.document-summary')).toContainText('v3'); assert.equal(state.complete.currentRevision.data.title, 'SAVE-ONLY-ORDER');
  assert.equal(JSON.stringify(state.complete.currentRevision.data.members), state.sourceSnapshot); noGeneration(state); await context.close(); note();

  step = 'version-conflict-retains-edits-and-recovery-keeps-unmodified-server-fields';
  const conflict = fixture(); conflict.modes = ['409', 'ready']; context = await setup(conflict); await open(conflict.complete);
  const box = conflict.complete.currentRevision.data.members[0].boxSource[0]; await boxField('A1', '长（CM）').fill('60.123'); await next().click();
  await expect(wizard().getByRole('alert')).toContainText('版本冲突'); await currentStage('单票资料'); await expect(boxField('A1', '长（CM）')).toHaveValue('60.123');
  await wizard().getByRole('button', { name: '重新读取最新版本', exact: true }).click(); await expect(wizard().getByRole('button', { name: '恢复未保存输入', exact: true })).toBeVisible();
  await expect(boxField('A1', '长（CM）')).toBeDisabled(); await wizard().getByRole('button', { name: '恢复未保存输入', exact: true }).click();
  await expect(boxField('A1', '长（CM）')).toHaveValue('60.123'); await expect(boxField('A1', '宽（CM）')).toHaveValue('29'); await expect(wizard().getByLabel('草稿名称', { exact: true })).toHaveValue('OTHER-USER-TITLE');
  await next().click(); await currentStage('校验与生成'); assert.equal(conflict.accepted[0].expectedVersion, 2);
  assert.equal(conflict.accepted[0].fields[documentBoxFieldKey(box.boxId, 'length')], '60.123'); assert.equal(conflict.accepted[0].fields[documentBoxFieldKey(box.boxId, 'width')], '29');
  noGeneration(conflict); await context.close(); note();

  step = 'failed-reread-and-same-version-retry-retain-recoverable-unsaved-input';
  const reread = fixture(); context = await setup(reread); await open(reread.complete);
  await boxField('A1', '长（CM）').fill('67.89'); await wizard().getByLabel('草稿名称', { exact: true }).fill('SAME-VERSION-UNSAVED');
  reread.detailFailures = 1; await wizard().getByRole('button', { name: '重新读取单据', exact: true }).click(); await expect(wizard().getByRole('alert')).toContainText('读取单据失败');
  await wizard().getByRole('button', { name: '重试', exact: true }).click(); await expect(wizard().getByRole('button', { name: '恢复未保存输入', exact: true })).toBeVisible();
  await expect(boxField('A1', '长（CM）')).toBeDisabled(); await wizard().getByRole('button', { name: '恢复未保存输入', exact: true }).click();
  await expect(boxField('A1', '长（CM）')).toHaveValue('67.89'); await expect(wizard().getByLabel('草稿名称', { exact: true })).toHaveValue('SAME-VERSION-UNSAVED');
  assert.equal(reread.complete.version, 1); assert.equal(reread.attempts.length, 0); await save().click(); await expect(save()).toBeDisabled();
  assert.equal(reread.accepted[0].expectedVersion, 1); noGeneration(reread); await context.close(); note();

  step = 'cross-version-address-recovery-keeps-values-and-invalidates-the-old-confirmation';
  const oldAddress = fixture(); oldAddress.modes = ['409']; context = await setup(oldAddress); await open(oldAddress.complete);
  await addressEditor().locator(':scope > summary').click(); await addressSection().getByLabel('城市', { exact: true }).fill('User City Before Conflict');
  await addressSection().getByLabel('地址核对 / 冲突处理原因', { exact: true }).fill('Old version address check'); await addressSection().getByLabel('已核对并确认本票采用的完整收件地址', { exact: true }).check();
  await next().click(); await expect(wizard().getByRole('alert')).toContainText('版本冲突'); await wizard().getByRole('button', { name: '重新读取最新版本', exact: true }).click();
  await wizard().getByRole('button', { name: '恢复未保存输入', exact: true }).click(); await expect(addressSection().getByLabel('城市', { exact: true })).toHaveValue('User City Before Conflict');
  await expect(addressSection().getByLabel('已核对并确认本票采用的完整收件地址', { exact: true })).not.toBeChecked(); await expect(addressStatus()).toHaveText('待核对确认');
  await expect(addressEditor()).toHaveAttribute('open', ''); assert.equal(oldAddress.accepted.length, 0); noGeneration(oldAddress); await context.close(); note();

  step = 'completion-navigation-expands-and-focuses-basic-address-product-and-box-sections';
  const missing = fixture(); context = await setup(missing); await open(missing.incomplete); await expect(completion().getByRole('button')).toHaveCount(4);
  for (const button of await completion().getByRole('button').all()) await expect(button).toHaveAttribute('data-incomplete', 'true');
  await completion().getByRole('button', { name: /^基础信息/ }).click(); await expect(wizard().getByLabel('草稿名称', { exact: true })).toBeVisible();
  await completion().getByRole('button', { name: /^收件地址/ }).click(); await expect(wizard().getByLabel('城市', { exact: true })).toBeVisible(); await sectionFocus(addressSection());
  await completion().getByRole('button', { name: /^商品申报/ }).click(); await expect(wizard().getByLabel('材质', { exact: true }).first()).toBeVisible(); await sectionFocus(wizard().locator('.document-product-adjustments'));
  await boxField('A1', '长（CM）').fill('41'); await filterBoxes('已修改'); await expect(boxRow('A2')).toHaveCount(0);
  await completion().getByRole('button', { name: /^箱规/ }).click(); await expect(boxField('A2', '毛重（KG）')).toHaveAttribute('aria-invalid', 'true'); await expect(boxField('A2', '毛重（KG）')).toBeFocused(); await sectionFocus(boxFields());
  await modalFrame(); assert.equal(missing.attempts.length, 0); await screenshot('document-details-missing-navigation-1440.png');
  await filterBoxes('待补齐'); await expect(boxRow('A2')).toBeVisible(); await boxField('A2', '毛重（KG）').pressSequentially('12.34'); await expect(boxField('A2', '毛重（KG）')).toHaveValue('12.34');
  await expect(boxRow('A2')).toBeVisible(); await completion().getByRole('button', { name: /^基础信息/ }).click(); await expect(boxRow('A2')).toHaveCount(0);
  await filterBoxes('全部'); await expect(boxField('A2', '毛重（KG）')).toHaveValue('12.34'); assert.equal(missing.attempts.length, 0); await context.close(); note();

  step = 'confirmed-address-collapses-and-editing-invalidates-confirmation-without-collapsing';
  const editingAddress = fixture(); context = await setup(editingAddress); await open(editingAddress.complete);
  await expect(addressStatus()).toHaveText('已确认'); await expect(addressEditor()).not.toHaveAttribute('open', ''); await expect(addressSection().getByLabel('城市', { exact: true })).not.toBeVisible();
  await expect(addressSection().getByLabel('本票最终地址', { exact: true })).toContainText('Technical Receiver');
  await addressEditor().locator(':scope > summary').click(); await addressSection().getByLabel('城市', { exact: true }).fill('Edited Technical City');
  await expect(addressEditor()).toHaveAttribute('open', ''); await expect(addressStatus()).toHaveText('待核对确认');
  await expect(addressSection().getByLabel('已核对并确认本票采用的完整收件地址', { exact: true })).not.toBeChecked(); await expect(addressSection().getByLabel('地址核对 / 冲突处理原因', { exact: true })).toHaveValue('');
  await addressSection().getByLabel('地址核对 / 冲突处理原因', { exact: true }).fill('Checked the edited technical address');
  await addressSection().getByLabel('已核对并确认本票采用的完整收件地址', { exact: true }).check(); await expect(addressEditor()).toHaveAttribute('open', '');
  await save().click(); await expect(save()).toBeDisabled(); await expect(addressStatus()).toHaveText('已确认'); await expect(addressEditor()).not.toHaveAttribute('open', '');
  await screenshot('document-details-address-summary-1440.png'); await context.close(); note();

  step = 'missing-unconfirmed-and-conflicting-addresses-stay-expanded-until-resolved';
  for (const kind of ['incomplete', 'unconfirmed', 'conflicted']) {
    const addressState = fixture(); context = await setup(addressState); await open(addressState[kind]); await expect(addressEditor()).toHaveAttribute('open', '');
    await expect(addressSection().getByLabel('城市', { exact: true })).toBeVisible(); await addressEditor().locator(':scope > summary').click(); await expect(addressEditor()).toHaveAttribute('open', '');
    await expect(addressStatus()).toHaveText(kind === 'incomplete' ? '待补全' : kind === 'unconfirmed' ? '待核对确认' : '需处理来源冲突');
    assert.equal(addressState.attempts.length, 0); await context.close();
  }
  note();

  step = 'box-batch-changes-only-selected-boxes-and-only-filled-fields';
  const batch = fixture(); context = await setup(batch); await open(batch.complete);
  const sources = batch.complete.currentRevision.data.members.flatMap((member) => member.boxSource), [a1, a2, b1] = sources;
  await boxChoice('A1').check(); await boxChoice('B1').check(); await boxFields().getByLabel('批量PO / Reference ID', { exact: true }).fill('BATCH-PO'); await boxFields().getByLabel('批量长（CM）', { exact: true }).fill('44.5');
  await expect(applyBatch()).toBeEnabled(); await applyBatch().click(); assert.equal(batch.attempts.length, 0);
  for (const code of ['A1', 'B1']) { await expect(boxField(code, 'PO / Reference ID')).toHaveValue('BATCH-PO'); await expect(boxField(code, '长（CM）')).toHaveValue('44.50'); }
  await expect(boxField('A2', 'PO / Reference ID')).toHaveValue(a2.po); await expect(boxField('A2', '长（CM）')).toHaveValue(a2.values.length);
  await expect(boxField('A1', '宽（CM）')).toHaveValue(a1.values.width); await expect(boxField('B1', '高（CM）')).toHaveValue(b1.values.height);
  await boxFields().getByLabel('批量毛重（KG）', { exact: true }).fill('-2'); await expect(applyBatch()).toBeDisabled(); await expect(boxFields().getByLabel('批量毛重（KG）', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await boxFields().getByLabel('批量毛重（KG）', { exact: true }).fill('13'); await applyBatch().click(); for (const code of ['A1', 'B1']) await expect(boxField(code, '毛重（KG）')).toHaveValue('13.00');
  await expect(boxField('A2', '毛重（KG）')).toHaveValue(a2.values.weight); await expect(boxField('A1', 'PO / Reference ID')).toHaveValue('BATCH-PO');
  assert.equal(JSON.stringify(batch.complete.currentRevision.data.members), batch.sourceSnapshot); note();

  step = 'box-filters-preserve-selection-and-overwrite-needs-explicit-confirmation';
  await filterBoxes('已修改'); await expect(boxFields().getByRole('checkbox', { name: /^选择箱 / })).toHaveCount(2); await expect(boxChoice('A1')).toBeChecked(); await expect(boxChoice('B1')).toBeChecked();
  await filterBoxes('待补齐'); await expect(boxFields().getByRole('checkbox', { name: /^选择箱 / })).toHaveCount(0); await expect(boxFields().getByRole('status').filter({ hasText: /已选 2 箱/ })).toContainText('2 箱不在当前筛选中');
  await filterBoxes('全部'); await boxFields().getByLabel('批量PO / Reference ID', { exact: true }).fill('SECOND-BATCH-PO'); await expect(applyBatch()).toBeDisabled();
  await boxFields().getByRole('checkbox', { name: /确认覆盖上述字段中的 2 处已有人工值/ }).check(); await applyBatch().click();
  await expect(boxField('A1', 'PO / Reference ID')).toHaveValue('SECOND-BATCH-PO'); await expect(boxField('B1', 'PO / Reference ID')).toHaveValue('SECOND-BATCH-PO'); await expect(boxField('A2', 'PO / Reference ID')).toHaveValue(a2.po);
  await boxFields().getByRole('button', { name: '清空箱选择', exact: true }).click(); await expect(boxFields().locator('.document-box-batch')).toHaveCount(0);
  await boxRow('A1').getByRole('button', { name: '恢复自动值', exact: true }).click(); await expect(boxField('A1', 'PO / Reference ID')).toHaveValue(a1.po); await expect(boxField('A1', '长（CM）')).toHaveValue(a1.values.length);
  await expect(boxField('B1', 'PO / Reference ID')).toHaveValue('SECOND-BATCH-PO'); await save().click(); await expect(save()).toBeDisabled();
  const savedFields = batch.accepted.at(-1).fields;
  for (const key of ['po', 'weight', 'length', 'width', 'height']) assert.equal(savedFields[documentBoxFieldKey(a1.boxId, key)], null);
  assert.equal(savedFields[documentBoxFieldKey(b1.boxId, 'po')], 'SECOND-BATCH-PO'); assert.equal(savedFields[documentBoxFieldKey(a2.boxId, 'po')], undefined);
  assert.equal(JSON.stringify(batch.complete.currentRevision.data.members), batch.sourceSnapshot); noGeneration(batch); note();

  step = 'details-navigation-address-summary-and-box-table-fit-wide-and-narrow-viewports';
  for (const width of [1920, 1440, 1024, 767, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await completion().getByRole('button', { name: /^箱规/ }).click(); await expect(boxField('A1', '长（CM）')).toBeVisible();
    await modalFrame();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    for (const label of ['PO / Reference ID', '毛重（KG）', '长（CM）', '宽（CM）', '高（CM）']) { const bounds = await boxField('A1', label).boundingBox(); assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'Box inputs fit width ' + width); }
    await screenshot('document-details-boxes-' + width + '.png'); await completion().getByRole('button', { name: /^收件地址/ }).click(); await modalFrame(); await screenshot('document-details-address-' + width + '.png');
  }
  await context.close(); note(); assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  heldReleases.forEach((release) => release()); await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-document-details-browser', passed: !failed,
    checks, browserErrors, unexpectedRequests, externalRequests, revisionEvidence, realBusinessWrites: 0, externalServiceRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
