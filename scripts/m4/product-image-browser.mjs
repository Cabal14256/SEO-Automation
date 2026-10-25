import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentRevisionInputSchema, documentSchema, documentExportSchema, documentValidationSchema, withDocumentDefaults as documentFlagDefaults, documentProductImagePreviewInputSchema } from '../../packages/contracts/dist/index.js';
import { validateDocumentData } from '../../apps/server/dist/modules/documents/domain.js';
import { documentProductOverrideKey, reviseDocumentProductFields, validateWorkbookData } from '../../apps/server/dist/modules/documents/workbook.js';
import { chooseOption } from '../shared/ui-controls.mjs';

const withDocumentDefaults = (fields = {}) => documentFlagDefaults({ orderNumber: null, reference: null, tradeTerms: null, currency: 'USD', ...fields });

// All requests use technical fixtures and the real pure validators. No database.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.local/m4/product-images');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-19T03:00:00.000Z', week = '2026-10-19', uid = () => randomUUID();
const item = { msku: 'MSKU-VALIDATION', fnsku: 'FNSKU-VALIDATION', sku: 'SKU-VALIDATION', name: '技术商品', quantity: '100', expiration: null, prepOwner: null, labelOwner: null };
const prefix = `product.${documentProductOverrideKey(101, item)}.`;
const template = { id: uid(), purpose: 'invoice', name: '技术模板', version: 1, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: 'a'.repeat(64), fileId: uid(), status: 'active', createdBy: 'fixture', createdAt: now };
const templateReference = { templateId: template.id, version: template.version, sha256: template.sha256, fileId: template.fileId };
function makeMember(index) {
  const demandId = uid(), groupId = uid(), revisionId = uid(), boxId = uid(), m2 = uid();
  const demand = { id: demandId, snapshot: { sid: 101, fba: 'FBATECHVALIDATION' + index, shop: '技术美国店', country: '美国', channel: 'HY', destinationFc: 'TEST1', destinationAddress: 'Technical Test Address', referenceQuantity: '100', notes: 'TECHNICAL FIXTURE', subBatchName: null }, version: 1, businessDate: week, weekStartDate: week, weekEndDate: '2026-10-25', createdAt: now, updatedAt: now };
  const shipment = { id: revisionId, demandId, version: 1, demandVersion: 1, data: { sid: 101, fba: demand.snapshot.fba, items: [item], boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, items: [item] }], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'technical', createdBy: 'fixture', createdAt: now };
  const codes = [{ id: uid(), groupId, demandId, boxId, prefix: 'A', sequence: index, code: 'A' + index, valid: true, createdAt: now }];
  const source = { id: uid(), groupId, m2ConfirmationId: m2, origin: 'history', fingerprint: 'technical-' + index, boxes: [{ demandId, shipmentRevisionId: revisionId, boxId, sid: 101, fba: demand.snapshot.fba, code: 'A' + index, order: 1, po: 'PO-TECH', range: demand.snapshot.fba + 'U000001', raw: { weight: '1', length: '10', width: '10', height: '10', weightUnit: 'KG', dimensionUnit: 'CM' }, values: { weight: '1.00', length: '10.00', width: '10.00', height: '10.00' }, items: [item], sourceObservedAt: now }], issues: [], identityValid: true, snapshotIds: [], createdBy: 'fixture', createdAt: now };
  const physical = { id: uid(), groupId, m2ConfirmationId: m2, m3Version: 1, sourceFingerprint: source.fingerprint, snapshot: { source, entries: [{ shipmentRevisionId: revisionId, boxId, status: 'consistent', measured: {}, reason: '' }], ruleVersion: 'physical-review/v1' }, createdBy: 'fixture', createdAt: now };
  return { source: { weekStartDate: week, groupId, groupVersion: 1, m2ConfirmationId: m2, demandId, demandVersion: 1, shipmentRevisionId: revisionId, physicalConfirmationId: physical.id, m3Version: 1, sourceFingerprint: source.fingerprint }, demand, shipment, codes, physical };
}
const members = [makeMember(1), makeMember(2)];
const declaration = { englishName: 'Screen Protector', chineseName: '屏幕保护膜', material: 'Tempered glass', hsCode: '7007198018', use: 'Screen protection', brand: 'TECH', model: 'TECH-1', unitPrice: '2.00', salesLink: 'https://fixture.invalid/product', imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYosAAAAASUVORK5CYII=', unitPriceConfirmed: 'true' };
const baseFields = { service: 'TECH SERVICE', currency: 'USD', recipientName: 'TEST1', addressLine1: '1 Technical Road', city: 'Technical City', state: 'IN', postalCode: '12345', countryCode: 'US', addressConfirmed: 'true', addressConfirmationReason: '已核对技术地址', customsMode: '普通报关', taxMode: '包税', ...Object.fromEntries(Object.entries(declaration).map(([key, value]) => [prefix + key, value])) };
const profiles = [], previewRequests = [];
let urlImage = '', failPreview = false;
const documents = [], exports = [], revisions = [], validations = new Map(), checks = [], browserErrors = [], unexpectedRequests = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
function createDocument(title, changes = {}) {
  const id = uid();
  const record = documentSchema.parse({ id, purpose: 'invoice', status: 'draft', version: 1, currentRevision: { id: uid(), documentId: id, version: 1, reason: 'technical create', data: { purpose: 'invoice', weekStartDate: week, title, fields: withDocumentDefaults({ ...baseFields, ...changes }), members: structuredClone(members), profileReferences: [], templateReference }, createdBy: 'fixture', createdAt: now }, createdBy: 'fixture', createdAt: now, updatedAt: now });
  documents.push(record); return record;
}
function validate(record) {
  const issues = [...validateDocumentData(record.currentRevision.data), ...validateWorkbookData(record.currentRevision.data)];
  const validation = documentValidationSchema.parse({ documentId: record.id, version: record.version, valid: !issues.some((issue) => issue.severity === 'error'), issues, checkedAt: now });
  validations.set(record.id, validation); return validation;
}
async function setupRoutes(context) {
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user: { id: 'fixture', name: 'M4 技术验证', email: 'm4@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/documents/automations' && method === 'GET') return json({ items: [] });
    if (path === '/api/v1/demands') return json({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 20, maxBoxes: 10, filters: { weeks: [], batches: [], shops: [], countries: [], channels: [] }, generatedAt: now });
    if (path === '/api/v1/batches/workspace') return json({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } });
    if (path === '/api/v1/batch-reports') return json({ rows: [], boxes: [], confirmations: [], blocked: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, generatedAt: now });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (path === '/api/v1/document-profiles') return json({ items: profiles });
    if (path === '/api/v1/document-templates') return json({ items: [template] });
    if (path === '/api/v1/documents' && method === 'GET') return json({ items: documents, total: documents.length, page: 1, pageSize: 20 });
    const match = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const record = documents.find((entry) => entry.id === match[1]), action = match[2] || ''; assert(record);
      if (method === 'GET' && !action) return json({ document: record, validation: validations.get(record.id) || null, exports: exports.filter((entry) => entry.reference.documentId === record.id) });
      if (method === 'GET' && action === 'history') return json({ revisions: [record.currentRevision], reviews: [], validations: [] });
      if (method === 'POST' && action === 'revisions') {
        const input = documentRevisionInputSchema.parse(request.postDataJSON()); assert.equal(input.expectedVersion, record.version); revisions.push(input);
        const previous = record.currentRevision.data;
        const next = { ...previous, title: input.title || previous.title, fields: withDocumentDefaults(input.fields || previous.fields), profileReferences: input.profileReferences?.map((reference) => { const authority = profiles.find((profile) => profile.id === reference.profileId && profile.version === reference.version); assert(authority); return { ...reference, data: structuredClone(authority.data) }; }) || previous.profileReferences, templateReference: input.templateReference === undefined ? previous.templateReference : input.templateReference };
        next.fields = reviseDocumentProductFields(previous, next, input.fields);
        record.version++; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, reason: input.reason, data: next };
        return json({ document: documentSchema.parse(record), replayed: false });
      }
      if (method === 'POST' && action === 'product-image-preview') { const input = documentProductImagePreviewInputSchema.parse(request.postDataJSON()); previewRequests.push(input); assert.equal(input.expectedVersion, record.version); assert.equal(input.sid, 101); await delay(150); return failPreview ? json({error:{code:'PRODUCT_IMAGE_FETCH_FAILED',message:'Image preview failed'}},422) : json({image:{imageBase64:urlImage,imageExtension:'png'}}); }
      if (method === 'POST' && action === 'validate') return json({ validation: validate(record), replayed: false });
      if (method === 'POST' && action === 'exports') {
        assert.equal(validate(record).valid, true, 'Export must satisfy actual validators');
        record.status = 'pending_review';
        const result = documentExportSchema.parse({ id: uid(), status: 'completed', reference: { documentId: record.id, revisionId: record.currentRevision.id, revisionVersion: record.version, templateId: template.id, templateVersion: template.version, templateSha256: template.sha256, sources: record.currentRevision.data.members.map((member) => member.source) }, fileId: uid(), fileSha256: 'b'.repeat(64), error: null, createdAt: now, completedAt: now, valid: true, invalidReason: null });
        exports.push(result); return json({ document: record, export: result });
      }
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: path } }, 500);
  });
}
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const stage = (label) => wizard().getByRole('navigation', { name: '单据制作步骤', exact: true }).getByRole('button', { name: label, exact: true }).click();
const product = () => wizard().locator('.document-product-adjustment');
const confirmPrice = () => product().getByRole('checkbox', { name: '已核对并确认本票该商品的申报单价与币种', exact: true });
const headerCurrency = () => wizard().locator('.document-edit-form').getByLabel('币种', { exact: true }).first();
async function open(id, label = '单票资料') { await page.goto('/shipping?view=documents&documentId=' + id); await stage(label); }
async function openProducts() { const section = wizard().locator('.document-product-adjustments'); if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click(); await expect(product()).toHaveCount(1); if (await product().getAttribute('open') === null) await product().locator(':scope > summary').click(); }
async function save() { await wizard().getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(wizard().getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled(); }
const imageArea = () => product().locator('.document-product-image');
const imageInput = () => imageArea().getByLabel('选择商品图片', { exact: true });
const imagePreview = () => imageArea().getByRole('img', { name: '商品申报图片预览', exact: true });
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } }); await setupRoutes(context); page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(error.message));

  step = 'missing-image-is-warning-and-generation-remains-enabled';
  const missing = createDocument('缺图待复核', { [prefix + 'imageBase64']: '' });
  const validation = validate(missing); assert.equal(validation.valid, true); assert.equal(validation.issues.length, 1); assert.equal(validation.issues[0].code, 'PRODUCT_IMAGE_MISSING'); assert.equal(validation.issues[0].severity, 'warning');
  await open(missing.id, '校验与生成'); await expect(wizard().locator('.document-issues > li')).toHaveCount(1); await expect(wizard().locator('.document-issues > li')).toHaveAttribute('data-severity', 'warning'); await expect(wizard().getByRole('button', { name: '生成待复核发票', exact: true })).toBeEnabled(); await wizard().getByRole('button', { name: '生成待复核发票', exact: true }).click(); await stage('文件与复核'); await expect(wizard().locator('.document-image-review')).toContainText('SKU-VALIDATION'); note();

  step = 'manual-file-over-4000-characters-persists-without-resetting-price';
  const uploaded = createDocument('手动补图', { [prefix + 'imageBase64']: '' }); await open(uploaded.id); await openProducts();
  const fileImage = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96; const ctx = canvas.getContext('2d'), data = ctx.createImageData(96, 96); let seed = 7; for (let index = 0; index < data.data.length; index += 4) { seed = (seed * 1664525 + 1013904223) >>> 0; data.data[index] = seed & 255; data.data[index + 1] = seed >>> 8 & 255; data.data[index + 2] = seed >>> 16 & 255; data.data[index + 3] = 255; } ctx.putImageData(data, 0, 0); return canvas.toDataURL('image/png').split(',')[1]; });
  assert(fileImage.length > 4000); await imageInput().setInputFiles({ name: 'technical.png', mimeType: 'image/png', buffer: Buffer.from(fileImage, 'base64') }); await expect(imagePreview()).toBeVisible(); await expect(confirmPrice()).toBeChecked(); await save(); assert.equal(uploaded.currentRevision.data.fields[prefix + 'imageBase64'], fileImage); assert.equal(uploaded.currentRevision.data.fields[prefix + 'unitPriceConfirmed'], 'true'); await open(uploaded.id); await openProducts(); await expect(imagePreview()).toHaveAttribute('src', 'data:image/png;base64,' + fileImage); note();

  step = 'url-fetch-is-explicit-and-snapshots-on-save';
  urlImage = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 3; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#497cb0'; ctx.fillRect(0, 0, 3, 3); return canvas.toDataURL('image/png').split(',')[1]; });
  await imageArea().getByLabel('图片直链 URL', { exact: true }).fill('https://cdn.fixture.invalid/product.png'); assert.equal(previewRequests.length, 0); await imageArea().getByRole('button', { name: '读取图片', exact: true }).click(); await expect(wizard().getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled(); await expect(imagePreview()).toHaveAttribute('src', 'data:image/png;base64,' + urlImage); assert.equal(previewRequests.length, 1); assert.equal(uploaded.currentRevision.data.fields[prefix + 'imageBase64'], fileImage); await expect(confirmPrice()).toBeChecked(); await save(); assert.equal(uploaded.currentRevision.data.fields[prefix + 'imageBase64'], urlImage); assert.equal(uploaded.currentRevision.data.fields[prefix + 'unitPriceConfirmed'], 'true'); note();

  step = 'failed-url-corrupt-decode-and-invalid-files-preserve-previous-image';
  await open(uploaded.id); await openProducts(); failPreview = true; await imageArea().getByLabel('图片直链 URL', { exact: true }).fill('https://cdn.fixture.invalid/fail.png'); await imageArea().getByRole('button', { name: '读取图片', exact: true }).click(); await expect(imageArea().getByRole('alert')).toContainText('原有图片未更改'); await expect(imagePreview()).toHaveAttribute('src', 'data:image/png;base64,' + urlImage); await expect(wizard().getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  failPreview = false; const goodUrlImage = urlImage; const corrupt = Buffer.from(urlImage, 'base64'); corrupt.writeUInt32BE(0x7fffffff, 16); for (let offset = 8; offset + 12 <= corrupt.length;) { const length = corrupt.readUInt32BE(offset); if (corrupt.toString('ascii', offset + 4, offset + 8) === 'IDAT') { corrupt.fill(0, offset + 8, offset + 8 + length); break; } offset += 12 + length; } urlImage = corrupt.toString('base64'); await imageArea().getByRole('button', { name: '读取图片', exact: true }).click(); await expect(imageArea().getByRole('alert')).toContainText('图片无法解码'); await expect(imagePreview()).toHaveAttribute('src', 'data:image/png;base64,' + goodUrlImage); urlImage = goodUrlImage;
  await imageInput().setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) }); await expect(imageArea().getByRole('alert')).toContainText('2 MiB'); await imageInput().setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not-an-image') }); await expect(imageArea().getByRole('alert')).toContainText('PNG 或 JPEG'); await expect(imagePreview()).toHaveAttribute('src', 'data:image/png;base64,' + goodUrlImage); note();

  step = 'remove-affects-ticket-only-and-restore-resolves-authoritative-profile';
  const profile = { id: uid(), category: 'product', key: 'technical-image', version: 1, status: 'active', data: { sid: 101, msku: item.msku, fnsku: item.fnsku, sku: item.sku, ...declaration, imageBase64: fileImage, imageExtension: 'png' }, createdBy: 'fixture', createdAt: now }; profiles.push(profile);
  const inherited = createDocument('恢复引用图', { [prefix + 'imageBase64']: null, [prefix + 'imageExtension']: null }); inherited.currentRevision.data.profileReferences = [{ category: 'product', profileId: profile.id, version: profile.version, data: structuredClone(profile.data) }]; await open(inherited.id); await openProducts(); await expect(imagePreview()).toHaveAttribute('src', 'data:image/png;base64,' + fileImage); await expect(imageArea().getByRole('button', { name: '恢复引用图片', exact: true })).toBeDisabled();
  await imageArea().getByRole('button', { name: '移除本票图片', exact: true }).click(); await expect(imagePreview()).toHaveCount(0); await save(); assert.equal(inherited.currentRevision.data.fields[prefix + 'imageBase64'], ''); assert.equal(profile.data.imageBase64, fileImage); assert.deepEqual(revisions.at(-1).profileReferences[0].data, {});
  await open(inherited.id); await openProducts(); await imageArea().getByRole('button', { name: '恢复引用图片', exact: true }).click(); await expect(imagePreview()).toHaveAttribute('src', 'data:image/png;base64,' + fileImage); await save(); assert.equal(inherited.currentRevision.data.fields[prefix + 'imageBase64'], null); assert.equal(inherited.currentRevision.data.profileReferences[0].data.imageBase64, fileImage); note();

  step = 'desktop-mobile-image-controls-and-mixed-products';
  await open(inherited.id); await openProducts();
  for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await imageArea().evaluate((element) => element.scrollIntoView({ block: 'start' })); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: resolve(evidence, `images-${width}.png`) }); }
  const mixed = createDocument('混排有图与缺图'); const otherItem = { ...item, msku: 'MSKU-OTHER', fnsku: 'FNSKU-OTHER', sku: 'SKU-OTHER' }, otherPrefix = `product.${documentProductOverrideKey(101, otherItem)}.`;
  for (const member of mixed.currentRevision.data.members) { member.shipment.data.items.push(structuredClone(otherItem)); member.shipment.data.boxes[0].items.push(structuredClone(otherItem)); member.physical.snapshot.source.boxes[0].items.push(structuredClone(otherItem)); }
  mixed.currentRevision.data.fields[prefix + 'imageBase64'] = fileImage; for (const [key, value] of Object.entries(declaration)) if (key !== 'imageBase64') mixed.currentRevision.data.fields[otherPrefix + key] = value;
  const mixedResult = validate(mixed); assert.equal(mixedResult.valid, true); assert.equal(mixedResult.issues.filter((issue) => issue.code === 'PRODUCT_IMAGE_MISSING').length, 1); assert(mixedResult.issues[0].message.includes('SKU-OTHER')); await open(mixed.id, '校验与生成'); await expect(wizard().locator('.document-issues')).toContainText('SKU-OTHER'); note();

  step = 'generated-file-locks-image-controls-and-legacy-image-blocker-refreshes';
  await page.setViewportSize({ width: 1440, height: 1000 }); await open(missing.id); await openProducts(); await expect(imageInput()).toBeDisabled(); await expect(imageArea().getByLabel('图片直链 URL', { exact: true })).toBeDisabled(); await expect(imageArea().getByRole('button', { name: '读取图片', exact: true })).toBeDisabled();
  const legacy = createDocument('旧缺图阻塞', { [prefix + 'imageBase64']: '' }); validations.set(legacy.id, documentValidationSchema.parse({ documentId: legacy.id, version: 1, valid: false, checkedAt: now, issues: [{ code: 'PRODUCT_IMAGE_REQUIRED', severity: 'error', message: '商品 SKU-VALIDATION 需要有效 PNG/JPEG 图片。' }] })); await open(legacy.id, '校验与生成'); await expect(wizard().getByText('出单校验规则已更新，请重新校验当前版本。下方诊断详情保留上次结果。', { exact: true })).toBeVisible(); await wizard().getByRole('button', { name: '校验当前版本', exact: true }).click(); await expect(wizard().getByRole('button', { name: '生成待复核发票', exact: true })).toBeEnabled(); note();

  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); await context.close();
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png') }).catch(() => {}); }
finally { await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-m4-product-image-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests: 0, databaseWrites: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
