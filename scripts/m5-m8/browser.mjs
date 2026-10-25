import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID as uid } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { workflowSourceSchema, workflowRecordSchema, workflowWriteSchema, fulfillmentDataSchema, logisticsDataSchema, customsDataSchema, financeDataSchema, archiveDataSchema } from '../../packages/contracts/dist/index.js';
import { chooseOption } from '../shared/ui-controls.mjs';

const root = resolve(import.meta.dirname, '../..'), evidence = resolve(process.env.M5_M8_BROWSER_EVIDENCE_DIR || resolve(root, '.local/m5-m8/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-22T04:00:00.000Z', week = '2026-10-19', groupId = uid(), demandId = uid(), revisionId = uid(), boxId = uid();
const item = { msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', name: '????', quantity: '10', expiration: null, prepOwner: null, labelOwner: null };
const member = { source: { weekStartDate: week, groupId, groupVersion: 1, m2ConfirmationId: uid(), demandId, demandVersion: 1, shipmentRevisionId: revisionId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null }, demand: { id: demandId, snapshot: { sid: 101, fba: 'FBATECHM5M8', shop: '技术美国店', country: '美国', channel: 'HY', destinationFc: 'TEST1', destinationAddress: '1 Technical Road', referenceQuantity: '10', notes: '', subBatchName: '技术批次' }, version: 1, businessDate: week, weekStartDate: week, weekEndDate: '2026-10-25', createdAt: now, updatedAt: now }, shipment: { id: revisionId, demandId, version: 1, demandVersion: 1, data: { sid: 101, fba: 'FBATECHM5M8', items: [item], boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, items: [item] }], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'technical', createdBy: 'fixture', createdAt: now }, codes: [{ id: uid(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: now }], physical: null };
const source = workflowSourceSchema.parse({ documentId: uid(), documentRevisionId: uid(), documentVersion: 1, exportId: uid(), fileId: uid(), fileSha256: 'a'.repeat(64), title: '已复核技术来源单', weekStartDate: week, fields: { currency: 'USD', customsMode: '9810' }, members: [member] });
const records = [], files = [], exports = [], histories = new Map(), calls = [], errors = [], unexpectedRequests = [], checks = [];
const makeRecord = (kind, data) => workflowRecordSchema.parse({ id: uid(), kind, title: ({ fulfillment: '领星技术准备单', logistics: '物流技术订单', customs: '报关技术分组', finance: '技术费用账单', archive: '技术批次归档' })[kind], status: 'draft', version: 1, source, boxIds: [boxId], data, createdBy: 'fixture', createdAt: now, updatedAt: now });
const fData = fulfillmentDataSchema.parse({ warehouseCode: 'TECH-WH', logistics: '技术渠道', lines: [{ boxId, ...item, expiration: undefined, prepOwner: undefined, labelOwner: undefined, components: [] }].map(({ expiration, prepOwner, labelOwner, name, ...line }) => line), externalOrders: [{ externalOrderNo: 'TECH-ORDER-1', warehouseCode: 'TECH-WH', status: 'allocated', lines: [{ boxId, msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: '10', components: [] }] }] });
const fulfillment = makeRecord('fulfillment', fData); fulfillment.status = 'completed'; records.push(fulfillment);
records.push(makeRecord('logistics', logisticsDataSchema.parse({ fulfillmentIds: [fulfillment.id], boxes: [{ boxId }], lingxingResults: [{ boxId, status: 'unknown', externalOrderNo: 'TECH-ORDER-1' }] })));
records.push(makeRecord('customs', customsDataSchema.parse({ countryCodes: ['US'], declarationMode: '9810', currency: 'USD', lines: [{ boxId, msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: '10', declaredQuantity: '10' }], boxWeights: [{ boxId }] })));
records.push(makeRecord('finance', financeDataSchema.parse({ billNumber: 'TECH-BILL', provider: '技术物流' })));
records.push(makeRecord('archive', archiveDataSchema.parse({ groupId })));
for (const record of records) histories.set(record.id, [{ id: uid(), version: 1, action: 'save', reason: '技术初始草稿', record: structuredClone(record), createdBy: 'fixture', createdAt: now }]);
let browser, page, viteProcess, baseURL, failNextWrite = false, conflictNextWrite = false, step = 'setup', failed = false;
const note = (name) => { checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
const recordOf = (kind) => records.find((record) => record.kind === kind);
const dialog = () => page.getByRole('dialog').filter({ visible: true }).first();
const goStage = (name) => dialog().getByRole('button', { name, exact: true }).click();
async function screen(name) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true }); }
async function layout(name) {
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const overflow = await dialog().evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    assert.equal(overflow, false, `${name} dialog fits viewport at ${width}`);
    await screen(`${name}-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function openKind(kind) {
  await page.goto(`${baseURL}${kind === 'finance' ? '/finance' : `/shipping?view=${kind === 'archive' ? 'archives' : kind}`}`);
  await page.getByRole('button', { name: '查看并处理', exact: true }).first().click();
  await expect(dialog().getByLabel('记录名称', { exact: true })).toBeVisible();
}
async function routeAll(context) {
  await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(req.url()); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user: { id: 'fixture', name: 'M5–M8 技术验证', email: 'm5-m8@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/workflow-sources') return json({ items: [source] });
    if (path === '/api/v1/workflow-files' && method === 'POST') {
      const form = await new Request('http://fixture.invalid', { method: 'POST', headers: req.headers(), body: req.postDataBuffer() }).formData();
      const input = form.get('file'); const file = { id: uid(), recordId: String(form.get('recordId')), purpose: String(form.get('purpose')), name: input.name, mimeType: input.type, sha256: 'b'.repeat(64), byteSize: input.size };
      files.push(file); return json({ file });
    }
    if (/\/(workflow-files|workflow-exports|document-exports)\/[^/]+\/download$/.test(path)) return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from('fixture download') });
    if (path === '/api/v1/finance/import-template') return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('fixture template') });
    const match = path.match(/^\/api\/v1\/(fulfillment|logistics|customs|finance|archives)(?:\/([^/]+))?(?:\/(actions|exports|import-preview))?$/);
    if (match) {
      const kind = match[1] === 'archives' ? 'archive' : match[1], record = records.find((item) => item.id === match[2]);
      if (!match[2] && method === 'GET') { const q = (url.searchParams.get('q') || '').toLowerCase(), status = url.searchParams.get('status'); const items = records.filter((item) => item.kind === kind && (!q || item.title.toLowerCase().includes(q)) && (!status || item.status === status)); return json({ items, total: items.length, page: 1, pageSize: 20 }); }
      if (record && !match[3] && method === 'GET') return json({ record, context: { records, files, exports, sourceValid: true, sourceInvalidReason: null }, issues: record.kind === 'archive' ? [{ code: 'TECH_PENDING', severity: 'error', message: '技术夹具：尚有费用待结清' }] : [], history: histories.get(record.id) || [] });
      if (record && match[3] === 'exports') { const input = req.postDataJSON(); assert.equal(input.expectedVersion, record.version); const exp = { id: uid(), recordId: record.id, version: record.version, purpose: input.purpose, status: 'completed', fileId: uid(), fileSha256: 'c'.repeat(64), name: input.purpose === 'archive-package' ? '技术归档.zip' : '技术资料.xlsx', mimeType: 'application/octet-stream', error: null, dependencyHash: 'd'.repeat(64), valid: true, invalidReason: null, createdAt: now, completedAt: now }; exports.push(exp); return json({ export: exp }); }
      if (record && match[3] === 'import-preview') return json({ lines: [{ id: uid(), description: '技术合并运费', type: 'freight', nature: 'actual', amount: '12.50', currency: 'USD', boxIds: [boxId], allocations: [] }], issues: [], file: { id: uid() } });
      if (['POST', 'PUT'].includes(method)) {
        const input = workflowWriteSchema.parse(req.postDataJSON()); calls.push({ kind, id: record?.id, ...input });
        if (failNextWrite) { failNextWrite = false; return json({ error: { code: 'TECH_TRANSPORT', message: '技术夹具：连接暂时中断' } }, 503); }
        if (conflictNextWrite) { conflictNextWrite = false; record.version++; return json({ error: { code: 'VERSION_CONFLICT', message: '版本冲突' } }, 409); }
        if (!record) { const next = makeRecord(kind, input.data); next.title = input.title; next.boxIds = input.boxIds; records.push(next); histories.set(next.id, []); return json({ record: next }); }
        assert.equal(input.expectedVersion, record.version, 'write pins saved version'); record.title = input.title; record.data = input.data; record.boxIds = input.boxIds; record.version++;
        if (input.action !== 'save') record.status = input.action === 'cancel' ? 'cancelled' : input.action === 'check' ? 'pending' : 'completed';
        histories.get(record.id).push({ id: uid(), version: record.version, action: input.action, reason: input.reason, record: structuredClone(record), createdBy: 'fixture', createdAt: now }); return json({ record });
      }
    }
    unexpectedRequests.push(`${method} ${path}`); return json({ error: { code: 'UNEXPECTED', message: path } }, 500);
  });
}

try {
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'); viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(baseURL)).ok) break; } catch { /* Vite is starting. */ } await delay(250); }
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' }); await routeAll(context); page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  step = 'm5-strong-form-save-and-operation-retry'; await openKind('fulfillment'); await expect(dialog().getByLabel('出库仓代码')).toHaveValue('TECH-WH'); await dialog().getByLabel('出库仓代码').fill('TECH-WH-2'); failNextWrite = true; await dialog().getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(dialog().getByRole('alert')).toContainText('连接暂时中断'); const failedOperation = calls.at(-1).operationId; await dialog().getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('草稿已保存'); assert.equal(calls.at(-1).operationId, failedOperation); assert.equal(recordOf('fulfillment').data.warehouseCode, 'TECH-WH-2'); note(step);
  step = 'm5-version-conflict-preserves-input-and-refreshes-version'; await dialog().getByLabel('单据备注').fill('技术并发保留内容'); conflictNextWrite = true; await dialog().getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(dialog().getByRole('alert')).toContainText('版本'); const conflictOperation = calls.at(-1).operationId; await dialog().getByRole('button', { name: '读取最新版本并保留填写内容', exact: true }).click(); await expect(dialog().getByLabel('单据备注')).toHaveValue('技术并发保留内容'); await dialog().getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('草稿已保存'); assert.notEqual(calls.at(-1).operationId, conflictOperation); note(step);
  step = 'm5-attachments-history-download-and-responsive-layout'; await goStage('附件与历史'); await dialog().getByLabel('业务附件', { exact: true }).setInputFiles({ name: 'TECH-EVIDENCE.pdf', mimeType: 'application/pdf', buffer: Buffer.from('technical proof') }); await dialog().getByRole('button', { name: '上传附件', exact: true }).click(); await expect(dialog().getByText('TECH-EVIDENCE.pdf', { exact: true })).toBeVisible(); const download = page.waitForEvent('download'); await dialog().getByRole('link', { name: '下载附件', exact: true }).first().click(); await download; await expect(dialog().getByRole('heading', { name: '操作与结果历史' })).toBeVisible(); await layout('m5-files'); note(step); await goStage('业务资料'); await layout('m5-editor');
  step = 'unsaved-dialog-and-route-guard'; await dialog().getByLabel('单据备注').fill('技术未保存'); await dialog().getByRole('button', { name: '关闭领星单据与分配处理向导', exact: true }).click(); await expect(page.getByRole('dialog', { name: '保留未保存修改', exact: true })).toBeVisible(); await page.getByRole('button', { name: '返回继续编辑', exact: true }).click(); await expect(dialog().getByLabel('单据备注')).toHaveValue('技术未保存'); await dialog().getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('草稿已保存'); note(step);
  step = 'm6-order-weight-handover-shipping-forms'; await openKind('logistics'); await dialog().getByLabel('物流订单号').fill('TECH-LOG-1'); await dialog().getByLabel('物流毛重 kg').fill('12.3'); await dialog().getByLabel('计费重 kg').fill('13.0'); await dialog().getByRole('button', { name: '登记一批交接', exact: true }).click(); await dialog().getByLabel('接收人', { exact: true }).fill('技术收货人'); await dialog().getByLabel('异常交接原因').fill('技术异常交接'); await dialog().getByRole('button', { name: '提交本次实际交接', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('操作已登记'); assert.equal(recordOf('logistics').data.handovers.length, 1); assert.equal(recordOf('logistics').data.handovers[0].boxIds[0], boxId); await layout('m6-editor'); await goStage('检查与处理'); await expect(dialog().getByRole('button', { name: '检查并放行', exact: true })).toBeVisible(); await expect(dialog().getByRole('button', { name: '核对领星发货', exact: true })).toBeVisible(); note(step);
  step = 'm7-seven-sheet-checklist-and-independent-results'; await openKind('customs'); await dialog().getByLabel('申报主体', { exact: true }).fill('技术申报主体'); await dialog().getByLabel('净重 kg', { exact: true }).fill('10'); await chooseOption(dialog().getByLabel('报关状态', { exact: true }), 'saved'); await expect(dialog().getByLabel('9810状态', { exact: true })).toHaveAttribute('data-value', 'draft'); await dialog().getByRole('button', { name: '登记报关结果', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('操作已登记'); assert.equal(calls.at(-1).action, 'record-customs'); await layout('m7-editor'); const customsRecord = recordOf('customs'); exports.push({ id: uid(), recordId: customsRecord.id, version: customsRecord.version, purpose: 'customs-package', status: 'completed', fileId: uid(), fileSha256: 'f'.repeat(64), name: '技术历史失效资料.xlsx', mimeType: 'application/octet-stream', error: null, dependencyHash: 'e'.repeat(64), valid: false, invalidReason: '技术夹具：资料已变化，历史文件仅供追溯', createdAt: now, completedAt: now }); await dialog().getByRole('button', { name: '关闭报关与 9810处理向导', exact: true }).click(); await page.getByRole('button', { name: '查看并处理', exact: true }).first().click(); await goStage('检查与处理'); await expect(dialog().getByRole('button', { name: '确认文件复核通过', exact: true })).toBeDisabled(); await screen('m7-invalid-review-disabled'); note('m7-invalid-export-disables-review'); await dialog().getByRole('button', { name: '生成七页报关资料', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('生成任务已提交'); await dialog().getByRole('button', { name: '生成 9810 填写核对清单', exact: true }).click(); await expect.poll(() => exports.filter((item) => item.valid !== false).length).toBe(2); await expect(dialog().getByRole('button', { name: '确认文件复核通过', exact: true })).toBeEnabled(); await goStage('附件与历史'); await expect(dialog().getByRole('link', { name: '下载文件', exact: true })).toHaveCount(3); await expect(dialog().getByText('技术夹具：资料已变化，历史文件仅供追溯')).toBeVisible(); note(step);
  step = 'm8-manual-allocation-is-bound-to-external-order'; await openKind('finance'); await dialog().getByRole('button', { name: '增加费用', exact: true }).click(); await dialog().getByLabel('费用描述', { exact: true }).fill('技术合并运费'); await dialog().getByLabel('账单金额', { exact: true }).fill('12.50'); await dialog().getByLabel('币种', { exact: true }).fill('USD'); await dialog().getByRole('button', { name: '增加一单分摊', exact: true }).click(); await chooseOption(dialog().getByLabel('分摊外部单', { exact: true }), `${fulfillment.id}:TECH-ORDER-1`); await dialog().getByLabel('分摊金额', { exact: true }).fill('12.50'); await dialog().getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('草稿已保存'); assert.equal(recordOf('finance').data.lines[0].allocations[0].externalOrderNo, 'TECH-ORDER-1'); await layout('m8-finance'); note(step);
  step = 'm8-standard-xlsx-preview-is-explicit'; await dialog().locator('input[type="file"]').setInputFiles({ name: 'TECH-BILL.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('technical xlsx') }); await expect(dialog().getByRole('button', { name: '确认加入费用明细', exact: true })).toBeVisible(); assert.equal(recordOf('finance').data.lines.length, 1); await dialog().getByRole('button', { name: '确认加入费用明细', exact: true }).click(); await dialog().getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('草稿已保存'); assert.equal(recordOf('finance').data.lines.length, 2); note(step);
  step = 'archive-checks-show-blockers-and-package-download'; await openKind('archive'); await goStage('检查与处理'); await expect(dialog().getByText('技术夹具：尚有费用待结清')).toBeVisible(); await dialog().getByRole('button', { name: '检查归档条件', exact: true }).click(); await expect(dialog().getByRole('status')).toContainText('操作已登记'); await layout('m8-archive'); await goStage('附件与历史'); await expect(dialog().getByRole('heading', { name: '操作与结果历史' })).toBeVisible(); note(step);
  step = 'create-from-reviewed-source'; await dialog().getByRole('button', { name: '关闭批次归档处理向导', exact: true }).click(); await page.getByRole('button', { name: '新建批次归档', exact: true }).first().click(); await page.getByRole('dialog', { name: '新建批次归档', exact: true }).getByLabel('记录名称').fill('技术新归档'); await page.getByRole('button', { name: '建立草稿并继续', exact: true }).click(); await expect(dialog().getByLabel('记录名称')).toHaveValue('技术新归档'); assert.equal(calls.at(-1).sourceDocumentId, source.documentId); note(step);
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []); await context.close();
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await screen('failure').catch(() => {}); }
finally { await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-m5-m8-browser', passed: !failed, checks, browserErrors: errors, unexpectedRequests, externalRequests: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
