import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentCreateInputSchema, documentRevisionInputSchema, documentSchema, documentExportSchema, withDocumentDefaults as documentFlagDefaults } from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';

const withDocumentDefaults = (fields = {}) => documentFlagDefaults({ orderNumber: null, reference: null, tradeTerms: null, currency: 'USD', ...fields });

const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.local/m4/order-number');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-19T03:00:00.000Z', week = '2026-10-19', uid = () => randomUUID();
const demandId = uid(), groupId = uid(), revisionId = uid(), boxId = uid(), m2 = uid();
const shippingRun = { id: uid(), version: 1, status: 'ready', stage: 'ready', numberingDate: '2026-10-23', month: '2026-10', sequence: 1, importId: null, parseRunId: null, origin: 'manual', membershipFrozenAt: now, error: null, createdAt: now, updatedAt: now };
const item = { msku: 'MSKU-1', fnsku: 'FNSKU-1', sku: 'SKU-1', name: '技术商品', quantity: '100', expiration: null, prepOwner: null, labelOwner: null };
const demand = { id: demandId, snapshot: { sid: 101, fba: 'FBATECHNUMBER1', shop: '技术美国店', country: '美国', channel: 'HY', destinationFc: 'TEST1', destinationAddress: 'Technical Test Address', referenceQuantity: '100', notes: 'TECHNICAL FIXTURE', subBatchName: null }, version: 1, businessDate: week, weekStartDate: week, weekEndDate: '2026-10-25', createdAt: now, updatedAt: now };
const shipment = { id: revisionId, demandId, version: 1, demandVersion: 1, data: { sid: 101, fba: demand.snapshot.fba, items: [item], boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, items: [item] }], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'technical', createdBy: 'fixture', createdAt: now };
const codes = [{ id: uid(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: now }];
const source = { id: uid(), groupId, m2ConfirmationId: m2, origin: 'history', fingerprint: 'technical-1', boxes: [{ demandId, shipmentRevisionId: revisionId, boxId, sid: 101, fba: demand.snapshot.fba, code: 'A1', order: 1, po: 'PO-TECH', range: demand.snapshot.fba + '000001-1', raw: { weight: '1', length: '10', width: '10', height: '10', weightUnit: 'KG', dimensionUnit: 'CM' }, values: { weight: '1.00', length: '10.00', width: '10.00', height: '10.00' }, items: [item], sourceObservedAt: now }], issues: [], identityValid: true, snapshotIds: [], createdBy: 'fixture', createdAt: now };
const physical = { id: uid(), groupId, m2ConfirmationId: m2, m3Version: 1, sourceFingerprint: source.fingerprint, snapshot: { source, entries: [{ shipmentRevisionId: revisionId, boxId, status: 'consistent', measured: {}, reason: '' }], ruleVersion: 'physical-review/v1' }, createdBy: 'fixture', createdAt: now };
const candidate = { demandId, weekStartDate: week, weekEndDate: '2026-10-25', groupId, groupName: '技术制表组', groupVersion: 1, groupStatus: 'confirmed', m2ConfirmationId: m2, demandVersion: 1, demand, shipment, codes, physicalConfirmationId: physical.id, m3Version: 1, sourceFingerprint: source.fingerprint, physical, blockers: [] };
const member = { source: { weekStartDate: week, groupId, groupVersion: 1, m2ConfirmationId: m2, demandId, demandVersion: 1, shipmentRevisionId: revisionId, physicalConfirmationId: physical.id, m3Version: 1, sourceFingerprint: source.fingerprint }, demand, shipment, codes, physical };
const documents = [], exports = [], revisions = [], checks = [], browserErrors = [], unexpectedRequests = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
function createDocument(input) {
  const id = uid();
  return documentSchema.parse({ id, purpose: 'invoice', status: 'draft', version: 1, currentRevision: { id: uid(), documentId: id, version: 1, reason: 'technical create', data: { purpose: 'invoice', weekStartDate: input.weekStartDate || week, ...(input.shippingRunId ? { shippingRunId: input.shippingRunId, shippingRunMonth: shippingRun.month, shippingRunSequence: 1 } : {}), title: input.title, fields: withDocumentDefaults(input.fields || {}), members: [structuredClone(member)], profileReferences: [], templateReference: null }, createdBy: 'fixture', createdAt: now }, createdBy: 'fixture', createdAt: now, updatedAt: now });
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
    if (path === '/api/v1/shipping-runs') return json({ items: [shippingRun] });
    if (path === '/api/v1/documents/candidates') return json({ items: [candidate], total: 1, weekStartDate: week });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (['/api/v1/document-profiles', '/api/v1/document-templates'].includes(path)) return json({ items: [] });
    if (path === '/api/v1/documents' && method === 'GET') return json({ items: documents, total: documents.length, page: 1, pageSize: 20 });
    if (path === '/api/v1/documents' && method === 'POST') { const input = documentCreateInputSchema.parse(request.postDataJSON()); const record = createDocument(input); documents.push(record); return json({ document: record, replayed: false }, 201); }
    const match = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const record = documents.find((entry) => entry.id === match[1]), action = match[2] || ''; assert(record);
      if (method === 'GET' && !action) return json({ document: record, validation: null, exports: exports.filter((entry) => entry.reference.documentId === record.id) });
      if (method === 'GET' && action === 'history') return json({ revisions: [record.currentRevision], reviews: [], validations: [] });
      if (method === 'POST' && action === 'revisions') {
        const input = documentRevisionInputSchema.parse(request.postDataJSON()); assert.equal(input.expectedVersion, record.version); revisions.push(input);
        record.version++; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, reason: input.reason, data: { ...record.currentRevision.data, title: input.title || record.currentRevision.data.title, fields: withDocumentDefaults(input.fields || record.currentRevision.data.fields), profileReferences: input.profileReferences || record.currentRevision.data.profileReferences, templateReference: input.templateReference === undefined ? record.currentRevision.data.templateReference : input.templateReference } };
        return json({ document: documentSchema.parse(record), replayed: false });
      }
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: path } }, 500);
  });
}
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
async function openEditor(id) { await page.goto('/shipping?view=documents&documentId=' + id); await wizard().getByRole('navigation', { name: '单据制作步骤', exact: true }).getByRole('button', { name: '单票资料', exact: true }).click(); await expect(wizard().locator('.document-edit-form')).toBeVisible(); }
async function openTax() { const summary = page.getByText('申报与税务', { exact: true }); if (!(await summary.locator('..').getAttribute('open'))) await summary.click(); }
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } }); await setupRoutes(context); page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(error.message));
  step = 'retired-header-fields-are-absent-and-dangerous-defaults-to-no';
  const initial = createDocument({ shippingRunId: shippingRun.id, title: 'Legacy document details compatibility fixture' }); documents.push(initial); await openEditor(initial.id);
  assert.equal(documents[0].currentRevision.data.fields.dangerous, '否');
  for (const label of ['订单编号', '参考号', '贸易条款']) await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('危险品', { exact: true })).toHaveAttribute('data-value', '否'); note();
  step = 'title-and-dangerous-save-while-retired-header-values-stay-blank';
  await page.getByLabel('草稿名称', { exact: true }).fill('MANUAL-TITLE-001'); await openTax(); await chooseOption(page.getByLabel('危险品', { exact: true }), '是'); await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  assert.equal(revisions.at(-1).title, 'MANUAL-TITLE-001'); for (const key of ['orderNumber', 'reference', 'tradeTerms']) assert.equal(revisions.at(-1).fields[key], null);
  assert.equal(revisions.at(-1).fields.dangerous, '是'); await page.getByRole('button', { name: '重新读取单据', exact: true }).click(); await expect(page.getByLabel('草稿名称', { exact: true })).toHaveValue('MANUAL-TITLE-001'); await expect(page.getByLabel('危险品', { exact: true })).toHaveAttribute('data-value', '是'); note();
  step = 'legacy-empty-default-and-explicit-yes-preserved';
  const legacy = createDocument({ weekStartDate: week, title: '旧草稿空危险品', fields: { orderNumber: 'EXISTING-MANUAL', reference: 'OLD-REFERENCE', tradeTerms: 'OLD-TERMS', dangerous: ' ' } }); legacy.currentRevision.data.fields.dangerous = ''; documents.push(legacy); await openEditor(legacy.id); await expect(page.getByLabel('危险品', { exact: true })).toHaveAttribute('data-value', '否');
  for (const label of ['订单编号', '参考号', '贸易条款']) await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  const reviewed = createDocument({ weekStartDate: week, title: '旧草稿已确认危险品', fields: { orderNumber: 'REVIEWED-MANUAL', dangerous: '是' } }); documents.push(reviewed); await openEditor(reviewed.id); await openTax(); await expect(page.getByLabel('危险品', { exact: true })).toHaveAttribute('data-value', '是'); note();
  step = 'desktop-and-mobile-controls-layout';
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const [label, name] of [['草稿名称', 'title'], ['危险品', 'dangerous']]) {
      await page.getByLabel(label, { exact: true }).evaluate((control) => control.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: resolve(evidence, `document-${name}-${width}.png`) });
    }
  } note();
  step = 'generated-file-locks-header-and-dangerous';
  reviewed.status = 'pending_review'; exports.push(documentExportSchema.parse({ id: uid(), status: 'completed', reference: { documentId: reviewed.id, revisionId: reviewed.currentRevision.id, revisionVersion: reviewed.version, templateId: uid(), templateVersion: 1, templateSha256: 'a'.repeat(64), sources: [member.source] }, fileId: uid(), fileSha256: 'b'.repeat(64), error: null, createdAt: now, completedAt: now, valid: true, invalidReason: null }));
  await page.setViewportSize({ width: 1440, height: 1000 }); await openEditor(reviewed.id); for (const label of ['订单编号', '参考号', '贸易条款']) await expect(page.getByLabel(label, { exact: true })).toHaveCount(0); await expect(page.getByLabel('草稿名称', { exact: true })).toBeDisabled(); await expect(page.getByLabel('危险品', { exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0); note();
  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); await context.close();
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-m4-number-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests: 0, databaseWrites: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
