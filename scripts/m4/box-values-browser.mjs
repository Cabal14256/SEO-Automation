import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { grid, findGridRow } from '../shared/grid.mjs';
import { editGridCell, visibleColumnKeys } from './grid-helpers.mjs';
import { documentCreateInputSchema, documentRevisionInputSchema, documentSchema, documentExportSchema, documentBoxFieldKey, documentBoxValue, withDocumentDefaults as documentFlagDefaults } from '../../packages/contracts/dist/index.js';

const withDocumentDefaults = (fields = {}) => documentFlagDefaults({ orderNumber: null, reference: null, tradeTerms: null, currency: 'USD', ...fields });

// Technical fixtures only. Every API request is intercepted; no server/database/Lingxing access.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(root, '.local/m4/box-values');
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-23T03:00:00.000Z', week = '2026-10-19', uid = () => randomUUID();
const demandId = uid(), groupId = uid(), revisionId = uid(), boxId = uid(), m2 = uid();
const shippingRun = { id: uid(), version: 1, status: 'ready', stage: 'ready', numberingDate: '2026-10-23', month: '2026-10', sequence: 1, importId: null, parseRunId: null, origin: 'manual', membershipFrozenAt: now, error: null, createdAt: now, updatedAt: now };
const item = { msku: 'BOX-FIXTURE', fnsku: 'BOX-FNSKU', sku: 'BOX-SKU', name: '技术商品', quantity: '100', expiration: null, prepOwner: null, labelOwner: null };
const demand = { id: demandId, snapshot: { sid: 101, fba: 'FBABOXFIXTURE1', shop: '技术美国店', country: '美国', channel: 'HY', destinationFc: 'TEST1', destinationAddress: 'Technical Test Address', referenceQuantity: '100', notes: 'TECHNICAL FIXTURE', subBatchName: null }, version: 1, businessDate: week, weekStartDate: week, weekEndDate: '2026-10-25', createdAt: now, updatedAt: now };
const shipment = { id: revisionId, demandId, version: 1, demandVersion: 1, data: { sid: 101, fba: demand.snapshot.fba, items: [item], boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, weight: '22', weightUnit: 'LB', length: '20', width: '10', height: '8', dimensionUnit: 'IN', items: [item] }], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'technical', createdBy: 'fixture', createdAt: now };
const codes = [{ id: uid(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: now }];
const automaticBox = { demandId, shipmentRevisionId: revisionId, boxId, sid: 101, fba: demand.snapshot.fba, code: 'A1', order: 1, po: 'PO-LINGXING', range: demand.snapshot.fba + '000001-1', raw: { weight: '22', weightUnit: 'LB', length: '20', width: '10', height: '8', dimensionUnit: 'IN' }, values: { weight: documentBoxValue('22', 'LB', 'weight'), length: '50.80', width: '25.40', height: '20.32' }, items: [item], sourceObservedAt: now };
const member = { source: { weekStartDate: week, groupId, groupVersion: 1, m2ConfirmationId: m2, demandId, demandVersion: 1, shipmentRevisionId: revisionId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null }, demand, shipment, codes, physical: null, boxSource: [automaticBox] };
const candidate = { demandId, weekStartDate: week, weekEndDate: '2026-10-25', groupId, groupName: '技术制表组', groupVersion: 1, groupStatus: 'confirmed', m2ConfirmationId: m2, demandVersion: 1, demand, shipment, codes, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null, physical: null, boxSource: [automaticBox], blockers: [] };
const documents = [], exports = [], revisions = [], validations = new Map(), checks = [], browserErrors = [], unexpectedRequests = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup', conflictNextSave = false;
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
    if (path === '/api/v1/session') return json({ user: { id: 'fixture', name: '逐箱技术验证', email: 'box@fixture.invalid', role: 'admin' } });
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
      if (method === 'GET' && !action) return json({ document: record, validation: validations.get(record.id) ?? null, exports: exports.filter((entry) => entry.reference.documentId === record.id) });
      if (method === 'GET' && action === 'history') return json({ revisions: [record.currentRevision], reviews: [], validations: [] });
      if (method === 'POST' && action === 'validate') { const result = { documentId: record.id, version: record.version, valid: false, issues: [{ code: 'DOCUMENT_FIELD_REQUIRED', severity: 'error', message: '技术夹具缺少单票资料' }], checkedAt: now }; validations.set(record.id, result); return json({ validation: result }); }
      if (method === 'POST' && action === 'revisions') {
        if (conflictNextSave) { conflictNextSave = false; record.version++; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, data: { ...record.currentRevision.data, fields: { ...record.currentRevision.data.fields, remarks: 'OTHER-USER-NEW-REMARK', [documentBoxFieldKey(boxId, 'width')]: '29' } } }; return json({ error: { code: 'DOCUMENT_VERSION_CONFLICT', message: '技术版本冲突' } }, 409); }
        const input = documentRevisionInputSchema.parse(request.postDataJSON()); assert.equal(input.expectedVersion, record.version); revisions.push(input);
        record.version++; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, reason: input.reason, data: { ...record.currentRevision.data, title: input.title || record.currentRevision.data.title, fields: withDocumentDefaults(input.fields || record.currentRevision.data.fields), profileReferences: input.profileReferences || record.currentRevision.data.profileReferences, templateReference: input.templateReference === undefined ? record.currentRevision.data.templateReference : input.templateReference } };
        return json({ document: documentSchema.parse(record), replayed: false });
      }
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: path } }, 500);
  });
}
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const stage = (label) => wizard().getByRole('navigation', { name: '单据制作步骤', exact: true }).getByRole('button', { name: label, exact: true }).click();
const box = () => wizard().locator('.document-box-active[aria-label="A1 制单资料"]');
const selectBox = () => findGridRow(wizard(), '逐箱制单资料', 'A1');
const field = async (label) => { await selectBox(); return box().getByRole('textbox', { name: `A1 ${label}`, exact: true }); };
const saveButton = () => wizard().getByRole('button', { name: '保存草稿', exact: true });
async function save() { await saveButton().click(); await expect(saveButton()).toBeDisabled(); }
async function open(id) { await page.goto('/shipping?view=documents&documentId=' + id); await stage('单票资料'); await selectBox(); await expect(box()).toBeVisible(); }
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 390, height: 1000 } }); await setupRoutes(context); page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(error.message));

  step = 'legacy-physical-link-redirects-without-physical-navigation';
  await page.goto('/shipping?view=physical'); await expect(page).toHaveURL(/view=documents/); await expect(page.getByRole('link', { name: '实物箱确认', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '制作发票', exact: true })).toBeVisible(); note();
  step = 'no-m3-draft-uses-converted-lingxing-defaults';
  const initial = createDocument({ shippingRunId: shippingRun.id, title: 'Converted Lingxing box fixture' }); documents.push(initial); await open(initial.id); await expect(wizard()).not.toContainText('M3');
  await expect(await field('毛重（KG）')).toHaveValue('9.98'); await expect(await field('长（CM）')).toHaveValue('50.80'); await expect(await field('PO / Reference ID')).toHaveValue('PO-LINGXING'); await expect(box()).toContainText('毛重 22 LB'); assert.equal(documents[0].currentRevision.data.members[0].physical, null); note();
  step = 'manual-edit-survives-stages-close-and-save-conflict';
  await (await field('长（CM）')).fill('60.123'); await (await field('毛重（KG）')).fill('11.5'); await (await field('PO / Reference ID')).fill('MANUAL-PO'); await expect(box()).toContainText('本票人工采用：60.12');
  await stage('货件与来源'); await expect(wizard()).not.toContainText('M3'); await stage('单票资料'); await expect(await field('长（CM）')).toHaveValue('60.123'); await wizard().getByRole('button', { name: '暂时关闭', exact: true }).click(); await page.getByRole('button', { name: '继续本次制作', exact: true }).click(); await expect(await field('长（CM）')).toHaveValue('60.123');
  conflictNextSave = true; await saveButton().click(); await expect(wizard()).toContainText('技术版本冲突'); await expect(await field('长（CM）')).toHaveValue('60.123'); await wizard().getByRole('button', { name: '重新读取最新版本', exact: true }).click(); await expect(wizard().getByRole('button', { name: '恢复未保存输入', exact: true })).toBeVisible(); await expect(saveButton()).toBeDisabled(); await expect(wizard().locator('.document-box-adjustments input:enabled')).toHaveCount(0); for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await wizard().locator('.document-summary').evaluate((element) => element.scrollIntoView({ block: 'start' })); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: resolve(evidence, `box-conflict-recovery-${width}.png`) }); } await page.setViewportSize({ width: 390, height: 1000 }); await wizard().getByRole('button', { name: '恢复未保存输入', exact: true }).click(); await expect(await field('长（CM）')).toHaveValue('60.123'); await expect(await field('宽（CM）')).toHaveValue('29'); await expect(wizard().getByLabel('备注（可选）', { exact: true })).toHaveValue('OTHER-USER-NEW-REMARK'); await save(); assert.equal(revisions.at(-1).expectedVersion, 2); assert.equal(revisions.at(-1).fields.remarks, 'OTHER-USER-NEW-REMARK'); assert.equal(revisions.at(-1).fields[documentBoxFieldKey(boxId, 'width')], '29'); assert.equal(revisions.at(-1).fields[documentBoxFieldKey(boxId, 'length')], '60.123'); assert.equal(revisions.at(-1).fields[documentBoxFieldKey(boxId, 'po')], 'MANUAL-PO'); await open(documents[0].id); await expect(await field('长（CM）')).toHaveValue('60.123'); note();
  step = 'invalid-input-preserved-and-restore-automatic-values-saved';
  await (await field('宽（CM）')).fill('-3'); await expect(await field('宽（CM）')).toHaveValue('-3'); await expect(await field('宽（CM）')).toHaveAttribute('aria-invalid', 'true'); await box().getByRole('button', { name: '恢复自动值', exact: true }).click(); await expect(await field('宽（CM）')).toHaveValue('25.40'); await expect(await field('长（CM）')).toHaveValue('50.80'); await expect(await field('PO / Reference ID')).toHaveValue('PO-LINGXING'); await save(); for (const key of ['po', 'weight', 'length', 'width', 'height']) assert.equal(revisions.at(-1).fields[documentBoxFieldKey(boxId, key)], null); await open(documents[0].id); await expect(await field('长（CM）')).toHaveValue('50.80'); note();
  step = 'desktop-and-narrow-screen-box-editor-layout';
  await (await field('长（CM）')).fill('61');
  for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await selectBox(); await box().evaluate((element) => element.scrollIntoView({ block: 'start' })); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); if (width <= 768) for (const label of ['PO / Reference ID', '毛重（KG）', '长（CM）', '宽（CM）', '高（CM）']) { const bounds = await (await field(label)).boundingBox(); assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width); } await page.screenshot({ path: resolve(evidence, `box-editor-${width}.png`) }); } await save(); note();
  step = 'desktop-canvas-edit-saves-final-character-and-escape-cancels-buffer';
  await page.setViewportSize({ width: 1440, height: 1000 }); await open(documents[0].id);
  const viewport = grid(wizard(), '逐箱制单资料').getByRole('grid');
  await viewport.scrollIntoViewIfNeeded(); await expect(viewport).toHaveAttribute('aria-busy', 'false');
  assert.deepEqual((await visibleColumnKeys(wizard(), '逐箱制单资料')).slice(0, 3), ['expand', 'rowNumber', 'selection']);
  const cell = await editGridCell(wizard(), '逐箱制单资料', 1, 'po', 'A1 PO / Reference ID');
  await expect(cell).toBeFocused(); await cell.fill('DESKTOP-0001-末字'); await save();
  assert.equal(revisions.at(-1).fields[documentBoxFieldKey(boxId, 'po')], 'DESKTOP-0001-末字');
  await open(documents[0].id); await editGridCell(wizard(), '逐箱制单资料', 1, 'po', 'A1 PO / Reference ID');
  await expect(cell).toHaveValue('DESKTOP-0001-末字'); await cell.fill('CANCEL-BUFFER'); await cell.press('Escape');
  await expect(wizard().locator('.scm-grid-cell-editor')).toHaveCount(0); await expect(saveButton()).toBeDisabled();
  await editGridCell(wizard(), '逐箱制单资料', 1, 'po', 'A1 PO / Reference ID'); await expect(cell).toHaveValue('DESKTOP-0001-末字'); await cell.press('Escape');
  await page.screenshot({ path: resolve(evidence, 'box-desktop-canvas-editor.png') }); note();
  step = 'saved-m3-validation-requires-revalidation-and-stays-historical';
  const oldRecord = createDocument({ weekStartDate: week, title: '旧版校验技术夹具' }); documents.push(oldRecord); validations.set(oldRecord.id, { documentId: oldRecord.id, version: oldRecord.version, valid: false, issues: [{ code: 'PHYSICAL_CONFIRMATION_REQUIRED', severity: 'error', message: '旧流程等待 M3 整组确认' }, { code: 'M3_REQUIRED', severity: 'error', message: '旧流程要求实物确认' }], checkedAt: now });
  await page.setViewportSize({ width: 390, height: 1000 }); await open(oldRecord.id); await stage('校验与生成'); await expect(wizard()).toContainText('此结果来自旧版实物确认流程，请重新校验当前版本'); await expect(wizard().locator('.document-issues')).toHaveCount(0); await expect(wizard().getByRole('button', { name: '生成待复核发票', exact: true })).toBeDisabled(); await expect(wizard().getByText('查看上次校验详情', { exact: true })).toBeVisible(); await wizard().getByRole('button', { name: '校验当前版本', exact: true }).click(); await expect(wizard().locator('.document-issues')).toContainText('技术夹具缺少单票资料'); await expect(wizard()).not.toContainText('旧流程等待 M3'); await expect(wizard().getByRole('button', { name: '生成待复核发票', exact: true })).toBeDisabled(); note();
  step = 'generated-files-lock-box-values-and-offer-correction';
  const record = documents[0]; record.status = 'pending_review'; exports.push(documentExportSchema.parse({ id: uid(), status: 'completed', reference: { documentId: record.id, revisionId: record.currentRevision.id, revisionVersion: record.version, templateId: uid(), templateVersion: 1, templateSha256: 'a'.repeat(64), sources: [member.source] }, fileId: uid(), fileSha256: 'b'.repeat(64), error: null, createdAt: now, completedAt: now, valid: true, invalidReason: null }));
  await page.setViewportSize({ width: 390, height: 1000 }); await open(record.id); for (const label of ['PO / Reference ID', '毛重（KG）', '长（CM）', '宽（CM）', '高（CM）']) await expect(await field(label)).toBeDisabled(); await expect(box().getByRole('button', { name: '恢复自动值', exact: true })).toBeDisabled(); await expect(saveButton()).toHaveCount(0); await stage('货件与来源'); await expect(wizard().getByRole('button', { name: '建立更正单据', exact: true })).toBeVisible(); note();
  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); await context.close();
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-box-values-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests: 0, databaseWrites: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
