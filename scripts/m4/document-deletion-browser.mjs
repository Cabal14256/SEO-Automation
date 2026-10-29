import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentAutomationJobSchema, documentOperationInputSchema, documentSchema, withDocumentInvoiceDefaults } from '../../packages/contracts/dist/index.js';

// Technical fixtures only: every API and external request is intercepted.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.DOCUMENT_DELETION_EVIDENCE_DIR || resolve(root, '.local/m4/document-deletion'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-29T03:00:00.000Z', uid = () => randomUUID();
const checks = [], browserErrors = [], unexpectedRequests = [], externalRequests = [], calls = [], accepted = new Map(), releases = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup', listReads = 0, detailReads = 0;
let deleteMode = 'success', holdDelete = false, releaseDelete, failRead = false;
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };

function makeJob(index, status = 'blocked', mode = 'single_workbook') {
  const completed = status === 'completed', running = status === 'running';
  return documentAutomationJobSchema.parse({
    id: uid(), shippingRunId: uid(), version: 2, status, mode,
    phase: completed ? 'completed' : running ? 'generating' : status === 'failed' ? 'failed' : 'needs_input',
    items: [{ id: uid(), demandIds: [uid()], fbas: ['FBADELETE00' + index], documentId: uid(), documentVersion: 1,
      exportId: completed ? uid() : null, fileId: completed ? uid() : null, stage: completed ? 'done' : running ? 'export' : 'validate',
      status: completed ? 'completed' : running ? 'exporting' : 'blocked', issues: [], error: null, attempt: 1 }],
    counts: { total: 1, queued: 0, running: 0, ready: 0, exporting: running ? 1 : 0, completed: completed ? 1 : 0, blocked: completed || running ? 0 : 1 },
    bundle: completed ? { status: 'completed', fileId: uid(), fileName: '技术合并发票.xlsx', sheetCount: 1, completedAt: now, error: null } : null,
    supplement: { descriptors: [], issues: [] }, createdAt: `2026-10-29T0${index}:00:00.000Z`, updatedAt: now,
    completedAt: completed ? now : null, error: null,
  });
}
const jobs = [makeJob(1, 'completed'), makeJob(2), makeJob(3, 'failed'), makeJob(4, 'running'), makeJob(5, 'blocked', 'legacy')];
const originalJobs = [...jobs];
const legacyJob = jobs.at(-1);
function makeLegacyDocument(job) {
  const item = job.items[0], demandId = item.demandIds[0], groupId = uid(), shipmentId = uid(), boxId = uid();
  const product = { msku: 'DELETE-LEGACY', fnsku: 'DELETE-FN', sku: 'DELETE-SKU', name: '删除交互技术商品', quantity: '10', expiration: null, prepOwner: null, labelOwner: null };
  const demand = { id: demandId, version: 1, snapshot: { sid: 101, fba: item.fbas[0], shop: '删除功能技术店铺', country: '美国', channel: 'TECH', destinationFc: 'TEST1', destinationAddress: '1 Technical Road', referenceQuantity: '10', notes: null, subBatchName: null }, businessDate: '2026-10-26', weekStartDate: '2026-10-26', weekEndDate: '2026-11-01', createdAt: now, updatedAt: now };
  const shipment = { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid: 101, fba: item.fbas[0], items: [product], boxes: [{ id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, weight: '1', weightUnit: 'KG', length: '10', width: '10', height: '10', dimensionUnit: 'CM', items: [product] }], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'technical fixture', createdBy: 'fixture', createdAt: now };
  const members = [{ source: { weekStartDate: '2026-10-26', groupId, groupVersion: 1, m2ConfirmationId: uid(), demandId, demandVersion: 1, shipmentRevisionId: shipmentId, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null }, demand, shipment, codes: [{ id: uid(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: now }], physical: null }];
  return documentSchema.parse({ id: item.documentId, purpose: 'invoice', status: 'draft', version: 1, createdBy: 'fixture', createdAt: now, updatedAt: now,
    currentRevision: { id: uid(), documentId: item.documentId, version: 1, reason: 'technical legacy fixture', createdBy: 'fixture', createdAt: now,
      data: { purpose: 'invoice', weekStartDate: '2026-10-26', shippingRunId: job.shippingRunId, shippingRunMonth: '2026-10', shippingRunSequence: 1, title: '删除任务未保存编辑技术夹具', members, fields: withDocumentInvoiceDefaults({ service: 'TECH SERVICE' }, members), profileReferences: [], templateReference: null, generationRulesVersion: 'v2' } } });
}
const legacyDocument = makeLegacyDocument(legacyJob);
const recent = () => page.getByRole('region', { name: '最近自动出单任务', exact: true });
const dialog = () => page.getByRole('dialog', { name: '删除自动出单任务', exact: true });
const row = (job) => recent().locator('tbody tr').nth(jobs.indexOf(job));
const confirm = () => dialog().getByRole('button', { name: '确认删除', exact: true });
const retryResult = () => dialog().getByRole('button', { name: '重试确认删除结果', exact: true });
const reason = () => dialog().getByLabel('删除原因', { exact: true });
const open = (job) => row(job).getByRole('button', { name: '删除任务', exact: true }).click();

async function setupRoutes(context) {
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { externalRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user: { id: 'deletion-fixture', name: '删除功能技术验证', email: 'deletion@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/demands') return json({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 20, maxBoxes: 10, filters: { weeks: [], batches: [], shops: [], countries: [], channels: [] }, generatedAt: now });
    if (path === '/api/v1/batches/workspace') return json({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } });
    if (path === '/api/v1/batch-reports') return json({ rows: [], boxes: [], confirmations: [], blocked: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, generatedAt: now });
    if (path === '/api/v1/shipping-runs') return json({ items: [] });
    if (path === '/api/v1/documents' && method === 'GET') {
      const items = legacyDocument.status === 'cancelled' ? [] : [legacyDocument];
      return json({ items, total: items.length, page: 1, pageSize: 20 });
    }
    if (path === '/api/v1/documents/' + legacyDocument.id && method === 'GET') return json({ document: legacyDocument, validation: null, exports: [] });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (['/api/v1/document-profiles', '/api/v1/document-templates'].includes(path)) return json({ items: [] });
    if (path === '/api/v1/documents/automations' && method === 'GET') { listReads++; return json({ items: jobs }); }
    const match = path.match(/^\/api\/v1\/documents\/automations\/([^/]+)(?:\/(delete))?$/);
    if (match) {
      const job = originalJobs.find((entry) => entry.id === match[1]);
      assert(job, 'only fixture jobs may be read or deleted');
      if (method === 'GET' && !match[2]) {
        detailReads++;
        if (failRead) { failRead = false; return json({ error: { code: 'FIXTURE_READ_FAILED', message: '技术夹具：删除目标读取失败。' } }, 503); }
        if (!jobs.includes(job)) return json({ error: { code: 'DOCUMENT_AUTOMATION_NOT_FOUND', message: '自动出单任务不存在。' } }, 404);
        return json({ job });
      }
      if (method === 'POST' && match[2] === 'delete') {
        const input = documentOperationInputSchema.parse(request.postDataJSON()); calls.push({ jobId: job.id, input });
        if (holdDelete) await new Promise((release) => { releaseDelete = () => { holdDelete = false; release(); }; releases.push(releaseDelete); });
        if (deleteMode === 'failure') { deleteMode = 'success'; return json({ error: { code: 'FIXTURE_DELETE_FAILED', message: '技术夹具：删除暂未完成，请重试。' } }, 503); }
        if (deleteMode === 'conflict') { deleteMode = 'success'; job.version++; return json({ error: { code: 'DOCUMENT_AUTOMATION_VERSION_CONFLICT', message: '技术夹具：任务版本已变化，请重新读取。' } }, 409); }
        if (deleteMode === 'busy' || deleteMode === 'export-busy') {
          const exporting = deleteMode === 'export-busy'; deleteMode = 'success';
          return json({ error: { code: exporting ? 'DOCUMENT_EXPORT_BUSY' : 'DOCUMENT_AUTOMATION_BUSY', message: exporting ? '技术夹具：发票仍在生成，完成后重试。' : '技术夹具：自动出单正在处理，请稍后重试。' } }, 409);
        }
        const prior = accepted.get(input.operationId);
        if (prior) { assert.equal(prior.jobId, job.id); assert.deepEqual(input, prior.input); return json({ ...prior.response, replayed: true }); }
        assert.equal(input.expectedVersion, job.version, 'deletion pins the reviewed version');
        assert(jobs.includes(job)); jobs.splice(jobs.indexOf(job), 1);
        if (job === legacyJob) { legacyDocument.status = 'cancelled'; legacyDocument.version++; }
        const response = { automationId: job.id, version: ++job.version, deleted: true, deletedAt: now, cancelledDocumentIds: job === legacyJob ? [legacyDocument.id] : [], preservedDocumentIds: job === legacyJob ? [] : [job.items[0].documentId], replayed: false };
        accepted.set(input.operationId, { jobId: job.id, input: structuredClone(input), response });
        if (deleteMode === 'lost-response') { deleteMode = 'success'; return route.abort('failed'); }
        return json(response);
      }
    }
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: path } }, 500);
  });
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await setupRoutes(context); page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/shipping?view=documents');

  step = 'task-deletion-is-discoverable-for-completed-blocked-failed-running-and-legacy-jobs';
  await expect(recent().locator('tbody tr')).toHaveCount(5);
  for (const job of jobs) await expect(row(job).getByRole('button', { name: '删除任务', exact: true })).toBeEnabled();
  note();

  step = 'task-deletion-requires-reason-and-cancel-does-not-write';
  await open(jobs[0]); await expect(dialog()).toBeVisible(); await expect(confirm()).toBeDisabled();
  await expect(reason()).toHaveAttribute('maxlength', '1000'); await reason().fill('   '); await expect(confirm()).toBeDisabled();
  await dialog().getByRole('button', { name: '保留任务', exact: true }).click(); await expect(dialog()).not.toBeVisible(); assert.equal(calls.length, 0);
  note();

  step = 'task-deletion-dialog-fits-desktop-and-small-phones';
  await open(jobs[0]); await reason().fill('技术验证：删除任务后保留已生成发票与操作记录');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const bounds = await dialog().boundingBox(); assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'confirmation dialog fits viewport');
    await expect(confirm()).toBeVisible(); await page.screenshot({ path: resolve(evidence, `task-deletion-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); note();

  step = 'pending-deletion-locks-form-dismissal-and-repeat-submission-then-failure-preserves-reason';
  const completed = jobs[0], firstCount = calls.length; holdDelete = true; deleteMode = 'failure';
  await confirm().click(); await expect.poll(() => calls.length).toBe(firstCount + 1);
  await expect(dialog().getByRole('button', { name: '正在删除…', exact: true })).toBeDisabled();
  await expect(dialog().getByRole('button', { name: '保留任务', exact: true })).toBeDisabled();
  await expect(dialog().getByRole('button', { name: '关闭删除自动出单任务', exact: true })).toBeDisabled();
  await expect(reason()).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog()).toBeVisible();
  await dialog().locator('form').evaluate((element) => { element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  assert.equal(calls.length, firstCount + 1); releaseDelete(); await expect(dialog().getByRole('alert')).toBeVisible();
  await expect(reason()).toHaveValue('技术验证：删除任务后保留已生成发票与操作记录');
  await expect(reason()).toBeDisabled(); await expect(retryResult()).toBeEnabled();
  const listBefore = listReads; await retryResult().click(); await expect(dialog()).not.toBeVisible();
  await expect.poll(() => listReads).toBeGreaterThan(listBefore); await expect(recent().locator('tbody tr')).toHaveCount(4);
  assert.deepEqual(calls[firstCount].input, calls[firstCount + 1].input); assert(!jobs.includes(completed)); note();

  step = 'version-conflict-requires-explicit-refresh-and-keeps-reason-on-refresh-failure';
  const conflicting = jobs[0], expectedVersion = conflicting.version, conflictCall = calls.length;
  await open(conflicting); await reason().fill('技术验证并发版本后重新确认'); deleteMode = 'conflict'; await confirm().click();
  await expect(dialog().getByRole('alert')).toBeVisible(); await expect(confirm()).toBeDisabled();
  await expect(reason()).toHaveValue('技术验证并发版本后重新确认'); failRead = true;
  await dialog().getByRole('button', { name: '重新读取删除目标', exact: true }).click();
  await expect(dialog()).toContainText('技术夹具：删除目标读取失败'); await expect(reason()).toHaveValue('技术验证并发版本后重新确认'); await expect(confirm()).toBeDisabled();
  const readsBefore = detailReads; await dialog().getByRole('button', { name: '重新读取删除目标', exact: true }).click();
  await expect.poll(() => detailReads).toBeGreaterThan(readsBefore); await expect(confirm()).toBeEnabled();
  assert.equal(calls.length, conflictCall + 1, 'reading the latest version never silently deletes');
  await confirm().click(); await expect(dialog()).not.toBeVisible(); await expect(recent().locator('tbody tr')).toHaveCount(3);
  assert.equal(calls[conflictCall].input.expectedVersion, expectedVersion); assert.equal(calls[conflictCall + 1].input.expectedVersion, expectedVersion + 1);
  assert.notEqual(calls[conflictCall].input.operationId, calls[conflictCall + 1].input.operationId); note();

  step = 'lost-success-response-and-refresh-404-still-replay-original-operation-and-refresh-list';
  const lostJob = jobs[0], lostCall = calls.length;
  await row(lostJob).getByRole('button', { name: '查看进度', exact: true }).click();
  const batchDialog = page.getByRole('dialog', { name: '整批检查与打包出单', exact: true });
  await expect(batchDialog).toBeVisible(); await batchDialog.getByRole('button', { name: '返回工作台', exact: true }).click();
  await open(lostJob); await reason().fill('技术验证响应丢失后的幂等重试'); deleteMode = 'lost-response';
  await confirm().click(); await expect(dialog().getByRole('alert')).toBeVisible(); await expect(reason()).toHaveValue('技术验证响应丢失后的幂等重试');
  await expect(reason()).toBeDisabled(); await dialog().getByRole('button', { name: '重新读取删除目标', exact: true }).click();
  await expect(dialog()).toContainText('自动出单任务不存在'); await expect(retryResult()).toBeEnabled();
  assert.equal(calls.length, lostCall + 1, 'a 404 refresh cannot create another deletion request');
  await retryResult().click(); await expect(dialog()).not.toBeVisible(); await expect(recent().locator('tbody tr')).toHaveCount(2);
  await expect(recent().getByRole('status')).toContainText('已保留 1 张单据及已有文件'); await expect(batchDialog).not.toBeVisible();
  assert.deepEqual(calls[lostCall].input, calls[lostCall + 1].input); assert(accepted.has(calls[lostCall].input.operationId)); note();

  step = 'worker-and-export-busy-errors-preserve-task-and-reason-until-retry';
  const runningJob = jobs[0]; await open(runningJob); await reason().fill('技术验证后台处理冲突后重试');
  for (const mode of ['busy', 'export-busy']) {
    deleteMode = mode; await confirm().click(); await expect(dialog().getByRole('alert')).toBeVisible();
    await expect(reason()).toHaveValue('技术验证后台处理冲突后重试'); assert(jobs.includes(runningJob)); await expect(confirm()).toBeEnabled();
  }
  await confirm().click(); await expect(dialog()).not.toBeVisible(); await expect(recent().locator('tbody tr')).toHaveCount(1); note();

  step = 'legacy-unsaved-editor-must-discard-before-deletion-without-reopening-closed-task';
  await row(legacyJob).getByRole('button', { name: '查看进度', exact: true }).click();
  const legacyDialog = page.getByRole('dialog', { name: '自动出单', exact: true }), wizard = page.getByRole('dialog', { name: '发票与单据向导', exact: true });
  await legacyDialog.getByRole('button', { name: '补充资料', exact: true }).click();
  await wizard.getByLabel('草稿名称', { exact: true }).fill('技术验证暂存的未保存编辑');
  await expect(wizard).toContainText('有未保存的修改'); await wizard.getByRole('button', { name: '暂时关闭', exact: true }).click();
  await legacyDialog.getByRole('button', { name: '返回工作台', exact: true }).click();
  await open(legacyJob); await expect(wizard).toContainText('当前有未保存的填写'); await expect(dialog()).not.toBeVisible();
  const writesBeforeDiscard = calls.length;
  await wizard.getByRole('button', { name: '放弃未保存修改并继续', exact: true }).click();
  await expect(dialog()).toBeVisible(); await expect(wizard).not.toBeVisible(); await expect(legacyDialog).not.toBeVisible();
  await expect(reason()).toBeEditable(); assert.equal(calls.length, writesBeforeDiscard, 'discarding changes opens review without deleting');
  await page.screenshot({ path: resolve(evidence, 'legacy-discard-delete-confirmation.png'), fullPage: true }); note();

  step = 'deleting-final-legacy-task-clears-cancelled-editor-and-shows-empty-state';
  await reason().fill('技术验证删除最后一个历史任务'); await confirm().click(); await expect(dialog()).not.toBeVisible();
  await expect(recent()).toContainText('暂无自动出单任务'); await expect(recent().getByRole('status')).toContainText('已取消 1 张草稿并释放货件占用'); await expect(recent().locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续本次制作', exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate((id) => sessionStorage.getItem(`scm-document-wizard:deletion-fixture:${id}`), legacyDocument.id), null);
  assert.equal(legacyDocument.currentRevision.data.title, '删除任务未保存编辑技术夹具', 'discard never persists unsaved content');
  assert.equal(jobs.length, 0); assert.equal(accepted.size, 5); note();
  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []); await context.close();
} catch (error) {
  failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  releases.forEach((release) => release()); await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-document-deletion-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests, deletionRequests: calls.length, acceptedDeletions: accepted.size, databaseWrites: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
