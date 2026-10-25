import { chooseOption } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { importAcceptedSchema } from '../../packages/contracts/dist/index.js';

// Fixture-only UI checks: no database, accounts file, real workbook parser, or
// external service is used. The real template workbook has separate server tests.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.IMPORT_AUTO_PARSE_EVIDENCE_DIR || resolve(root, '.local/import-auto-upload/auto-parse'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-18T03:00:00.000Z';
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const bytes = Buffer.from('PK\u0003\u0004TECHNICAL UI FIXTURE - HTTP mocked, not a real workbook');
const uuid = () => randomUUID();
const checks = []; const browserErrors = []; const unexpectedRequests = []; const externalRequests = []; const heldReleases = [];
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
const sheet = (name = '在线需求导入') => ({ name, state: 'visible', rowCount: 3, columnCount: 13, mergedRanges: [], hiddenColumns: [], headers: [{ column: 'A', value: '店铺' }, { column: 'E', value: 'FBA货件号' }] });
const catalog = { mode: 'manual', version: 1, catalogVersion: 2, lastSyncedAt: now, lastError: null, configured: true, readOnly: true };
const emptyWorkspace = { rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 50, maxBoxes: 10, filters: { batches: [], shops: [], countries: [], channels: [] }, generatedAt: now };
let processHandle; let browser; let page; let baseURL; let failed = false; let step = 'setup';

function fixture() {
  const id = uuid(); const sellerId = uuid();
  const run = { id: uuid(), importId: id, status: 'queued', inputVersion: 1, mappingVersion: 'online-v1', sheetName: '在线需求导入', parserVersion: 'xlsx-preview-v1', processedRows: 0, counts: { totalRows: 0, validFbaRows: 0, errorRows: 0, warningRows: 0 }, issues: [], errorCode: null, errorMessage: null, createdAt: now, startedAt: null, completedAt: null };
  const record = { id, fileId: uuid(), sourceType: 'xlsx', submissionStatus: 'not_submitted', submittedSourceRows: 0, originalName: 'technical-auto-parse.xlsx', sha256: '1'.repeat(64), byteSize: bytes.length, createdBy: 'technical-ui', importedAt: now, businessDate: '2026-10-18', datePolicyVersion: 'import-date-shanghai-v1', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', status: 'queued', version: 1, sheets: [sheet()], latestRun: run };
  const normalized = { shop: '自动解析技术店铺', channel: '技术渠道', country: '美国', destinationFc: 'ONT8', fba: 'FBAAUTOPARSE1', referenceQuantity: '10', sourceDate: null, sourceRecordId: null, notes: 'TECHNICAL UI FIXTURE', subBatchName: null, sellerMappingId: null, sid: null, sellerMappingVersion: null };
  const rows = [0, 1].map((index) => ({ id: uuid(), parseRunId: run.id, sheetName: run.sheetName, rowNumber: index + 2, hidden: false, status: 'needs_review', normalized: { ...normalized, fba: `FBAAUTOPARSE${index + 1}` }, rawCells: [{ address: `E${index + 2}`, column: 'E', type: 's', rawValue: `FBAAUTOPARSE${index + 1}`, value: `FBAAUTOPARSE${index + 1}`, numberFormat: '@', formula: null, formulaCache: 'not_formula', hidden: false }], issues: [] }));
  return { record, run, rows, sellerId, preview: null, previewBodies: [], drafts: new Map(), started: false, queueCount: 0, uploadBodies: [], parseBodies: [], detailReads: 0, templateReads: 0, templateMode: 'success', uploadError: null, dropUploadOnce: false, holdUpload: false, releaseUpload: null, seenOperations: new Set(), acceptedResponses: 0,
    accepted(extra = {}) { const value = { import: record, run, taskId: run.id, taskUrl: `/api/v1/imports/${id}/runs`, replayed: false, deduplicated: false, ...extra }; importAcceptedSchema.parse(value); return value; },
    multiple() { record.status = 'awaiting_mapping'; record.sheets = [sheet(), sheet('第二份需求')]; run.status = 'completed'; run.sheetName = null; run.mappingVersion = null; run.completedAt = now; },
    parsing() { record.status = 'parsing'; run.status = 'running'; run.startedAt = now; run.processedRows = 1; },
    complete(partial = false) { record.status = 'preview_ready'; run.status = 'completed'; run.startedAt = now; run.completedAt = now; run.processedRows = 2; run.counts = { totalRows: 2, validFbaRows: partial ? 1 : 2, errorRows: partial ? 1 : 0, warningRows: 0 }; if (partial) { rows[1].status = 'error'; rows[1].normalized.fba = 'WRONG'; rows[1].issues = [{ code: 'INVALID_FBA', severity: 'error', address: 'E3', message: '技术夹具：FBA 格式无效' }]; } },
    fail() { record.status = 'failed'; run.status = 'failed'; run.errorCode = 'TECHNICAL_PARSER_FAILURE'; run.errorMessage = '技术夹具：解析失败，请重试'; run.completedAt = now; },
  };
}

async function setupContext(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== baseURL) { externalRequests.push(request.url()); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/v1/')) return route.continue();
    const path = url.pathname; const method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '自动解析技术验证', email: 'auto-parse@acceptance.invalid', role: 'admin' } });
    if (path === '/api/v1/demands') return json(emptyWorkspace);
    if (path === '/api/v1/batches/workspace') return json({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } });
    if (path === '/api/v1/weekly-batches') return json({ items: [], availableWeeks: [] });
    if (path === '/api/v1/batch-reports') return json({ rows: [], boxes: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, confirmations: [], blocked: [], generatedAt: now });
    if (path === '/api/v1/batch-reports/exports') return json({ items: [] });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: catalog });
    if (path === '/api/v1/imports/drafts' && method === 'GET') return json({ items: [...state.drafts.values()], total: state.drafts.size });
    const draftId = path.match(/^\/api\/v1\/imports\/drafts\/([a-f\d-]+)$/i)?.[1];
    if (draftId && method === 'GET') return json({ draft: state.drafts.get(draftId) });
    if (draftId && method === 'PUT') {
      const input = request.postDataJSON(); const draft = { id: draftId, title: input.title, source: input.content.source, importId: input.content.progress.importId, rowCount: input.content.online?.rows.length ?? null, version: input.expectedVersion + 1, createdAt: now, updatedAt: now, content: input.content };
      state.drafts.set(draftId, draft); return json({ draft, replayed: false });
    }
    if (path === '/api/v1/imports/template') {
      state.templateReads += 1;
      if (state.templateMode === 'unavailable') return json({ error: { code: 'TEMPLATE_UNAVAILABLE', message: '技术夹具：模板暂不可用' } }, 503);
      return route.fulfill({ status: 200, contentType: state.templateMode === 'wrong_type' ? 'text/html' : mime, headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E9%9C%80%E6%B1%82%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx" }, body: state.templateMode === 'empty' ? Buffer.alloc(0) : bytes });
    }
    if (path === '/api/v1/imports' && method === 'GET') return json({ items: state.started ? [state.record] : [], total: Number(state.started), page: 1, pageSize: 10 });
    if (path === '/api/v1/imports' && method === 'POST') {
      const body = request.postDataBuffer().toString('utf8'); const operationId = body.match(/name="operationId"\r\n\r\n([^\r\n]+)/)?.[1];
      state.uploadBodies.push({ operationId, fileName: body.match(/filename="([^"]+)"/)?.[1] }); assert(operationId);
      if (state.holdUpload) await new Promise((done) => { state.releaseUpload = () => { state.holdUpload = false; done(); }; heldReleases.push(state.releaseUpload); });
      if (state.uploadError) return json({ error: state.uploadError }, 422);
      const replayed = state.seenOperations.has(operationId); const deduplicated = !replayed && state.started;
      state.seenOperations.add(operationId);
      if (!state.started) { state.started = true; if (state.record.status === 'queued') state.queueCount += 1; }
      if (state.dropUploadOnce) { state.dropUploadOnce = false; return route.abort('connectionfailed'); }
      state.acceptedResponses += 1; return json(state.accepted({ replayed, deduplicated }), 202);
    }
    if (path === `/api/v1/imports/${state.record.id}`) { state.detailReads += 1; return json({ import: state.record }); }
    if (path === `/api/v1/imports/${state.record.id}/runs`) return json({ items: [state.run] });
    if (path === `/api/v1/imports/${state.record.id}/rows`) return json({ items: state.rows, total: state.rows.length, page: 1, pageSize: 20, parseRunId: state.run.id, previewVersion: state.record.version });
    if (path === `/api/v1/imports/${state.record.id}/confirmation`) return json({ shops: [{ sourceShop: '自动解析技术店铺', countries: ['美国'], rowCount: 2,
      resolution: { status: 'unique', sellerMappingId: state.sellerId, expectedVersion: 1, reason: 'name_alias' } }],
      sellers: [{ id: state.sellerId, sid: 101, name: '自动解析技术店铺', country: '美国', status: 'approved', version: 1 }], latestPreviewId: state.preview?.preview.id ?? null, submittedSourceRows: 0, totalSourceRows: 2, status: 'not_submitted', baselines: [], catalog });
    if (path === `/api/v1/imports/${state.record.id}/preview`) {
      const body = request.postDataJSON(); state.previewBodies.push(body);
      const items = state.rows.map((row) => ({ id: uuid(), kind: row.status === 'error' ? 'error' : 'new', selectable: row.status !== 'error', sid: 101, fba: row.normalized.fba,
        demandId: null, expectedDemandVersion: 0, before: null, after: { ...row.normalized, sid: 101 }, alreadyCommitted: false, issues: row.issues,
        sources: [{ rowId: row.id, parseRunId: state.run.id, importId: state.record.id, fileName: state.record.originalName, sheetName: row.sheetName, rowNumber: row.rowNumber, addresses: [`E${row.rowNumber}`] }] }));
      state.preview = { preview: { id: uuid(), importId: state.record.id, parseRunId: state.run.id, importVersion: state.record.version,
        mappings: body.sellerSelections.map((selection) => ({ ...selection, sid: 101, name: '自动解析技术店铺', country: '美国', confirmedBy: 'technical-ui', confirmedAt: now })), baselineImportId: null, createdAt: now, createdBy: 'technical-ui',
        counts: { new: items.filter((item) => item.selectable).length, unchanged: 0, changed: 0, error: items.filter((item) => !item.selectable).length, conflict: 0, missing: 0 },
        selectableItemIds: items.filter((item) => item.selectable).map((item) => item.id), changedItemIds: [], sellerCatalogMode: catalog.mode, sellerCatalogSettingsVersion: catalog.version, sellerCatalogVersion: catalog.catalogVersion }, items, total: items.length, page: 1, pageSize: 20 };
      return json(state.preview, 201);
    }
    if (path.startsWith(`/api/v1/imports/${state.record.id}/previews/`)) return json(state.preview);
    if (path === `/api/v1/imports/${state.record.id}/commits`) return json({ items: [] });
    if (path === `/api/v1/imports/${state.record.id}/parse`) {
      const body = request.postDataJSON(); state.parseBodies.push(body); state.queueCount += 1; state.record.version += 1; state.run.id = uuid(); state.run.inputVersion = state.record.version; state.run.sheetName = body.sheetName; state.run.mappingVersion = body.mappingVersion; state.run.status = 'queued'; state.run.errorCode = null; state.run.errorMessage = null; state.run.completedAt = null; state.record.status = 'queued'; state.rows.forEach((row) => { row.parseRunId = state.run.id; row.sheetName = body.sheetName; });
      return json(state.accepted(), 202);
    }
    unexpectedRequests.push(`${method} ${path}`); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: `Unhandled fixture ${method} ${path}` } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  return context;
}
const dialog = () => page.getByRole('dialog', { name: '导入向导', exact: true });
const fileDialog = () => page.getByRole('dialog', { name: '表格导入', exact: true });
const nav = () => dialog().getByRole('navigation', { name: '导入步骤', exact: true });
const fileInput = () => fileDialog().getByLabel('需求文件', { exact: true });
const retryUpload = () => fileDialog().getByRole('button', { name: '重试上传', exact: true });
const nextButton = () => dialog().getByRole('button', { name: '下一步：核对与提交', exact: true });
const alert = (text) => dialog().getByRole('alert').filter({ hasText: text });
const currentStage = (name = '填写与解析') => expect(nav().locator('[aria-current="step"]')).toContainText(name);
async function openWizard() {
  await page.goto('/shipping?view=demands'); await page.getByRole('button', { name: '新增需求', exact: true }).click();
  await currentStage(); await dialog().getByRole('button', { name: '表格导入', exact: true }).click(); await expect(fileDialog()).toBeVisible();
}
async function nextUnavailable() { assert(!await nextButton().count() || !await nextButton().isEnabled(), 'preview navigation requires completed rows and a resolved shop'); }
async function chooseFile(name = 'technical-auto-parse.xlsx', buffer = bytes) { await fileInput().setInputFiles({ name, mimeType: mime, buffer }); }
async function refreshRecord() { await dialog().getByRole('button', { name: '刷新解析结果', exact: true }).click(); }
async function screenshot(name) { await dialog().evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {})))); await page.screenshot({ path: resolve(evidence, name) }); }

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  processHandle = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });

  step = 'authenticated-template-download-response-validation-and-retry';
  const template = fixture(); let context = await setupContext(template); await openWizard();
  template.templateMode = 'unavailable'; await dialog().getByRole('button', { name: '下载模板', exact: true }).click(); await expect(alert('模板暂不可用')).toBeVisible();
  template.templateMode = 'wrong_type'; await dialog().getByRole('button', { name: '下载模板', exact: true }).click(); await expect(alert('模板文件响应无效')).toBeVisible();
  template.templateMode = 'empty'; await dialog().getByRole('button', { name: '下载模板', exact: true }).click(); await expect(alert('模板文件为空')).toBeVisible();
  template.templateMode = 'success';
  const [download] = await Promise.all([page.waitForEvent('download'), dialog().getByRole('button', { name: '下载模板', exact: true }).click()]);
  assert.equal(download.suggestedFilename(), '需求导入模板.xlsx'); assert.deepEqual(await readFile(await download.path()), bytes);
  await expect(dialog().getByRole('status').filter({ hasText: '模板已下载' })).toBeVisible(); assert.equal(template.templateReads, 4); assert.equal(template.uploadBodies.length, 0);
  await screenshot('template-and-upload-1440.png'); note(step);

  step = 'client-file-type-empty-and-size-validation-never-posts';
  await expect(dialog().getByRole('button', { name: '上传并校验', exact: true })).toHaveCount(0); await expect(retryUpload()).toHaveCount(0);
  await fileInput().evaluate((node) => node.dispatchEvent(new Event('cancel', { bubbles: true }))); await expect(dialog()).toBeVisible();
  await chooseFile('technical.xls'); await expect(alert('目前支持 .xlsx')).toBeVisible();
  await chooseFile('empty.xlsx', Buffer.alloc(0)); await expect(alert('有内容且不超过 10 MB')).toBeVisible();
  await chooseFile('oversized.xlsx', Buffer.alloc(10 * 1024 * 1024 + 1)); await expect(alert('有内容且不超过 10 MB')).toBeVisible();
  assert.equal(template.uploadBodies.length, 0); assert.equal(template.queueCount, 0); note(step); await context.close();

  step = 'invalid-archive-headers-and-blank-sheet-return-422-without-record-or-queue';
  const invalid = fixture(); context = await setupContext(invalid); await openWizard();
  for (const [name, code, message] of [['invalid-format.xlsx', 'INVALID_WORKBOOK', '技术夹具：文件格式无效'], ['invalid-headers.xlsx', 'SOURCE_MAPPING_REQUIRED', '技术夹具：未找到合法表头'], ['blank.xlsx', 'EMPTY_WORKBOOK', '技术夹具：需求表为空']]) {
    invalid.uploadError = { code, message }; await chooseFile(name); await expect(alert(message)).toBeVisible();
    await expect(fileInput()).toBeVisible(); assert.equal(await fileInput().evaluate((node) => node.files.length), 1); await nextUnavailable();
    await currentStage(); assert.equal(invalid.started, false); assert.equal(invalid.queueCount, 0); assert.equal(invalid.parseBodies.length, 0);
  }
  assert.equal(invalid.uploadBodies.length, 3); assert.equal(new Set(invalid.uploadBodies.map((body) => body.operationId)).size, 3);
  await screenshot('invalid-upload-1440.png');
  invalid.uploadError = null; await chooseFile('corrected.xlsx');
  await expect(dialog().getByRole('status').filter({ hasText: '正在等待自动解析' })).toBeVisible(); assert.equal(invalid.started, true); assert.equal(invalid.queueCount, 1);
  note(step); await context.close();

  step = 'upload-validation-pending-locks-step-and-source-navigation';
  const automatic = fixture(); automatic.holdUpload = true; context = await setupContext(automatic); await openWizard(); await chooseFile();
  await expect.poll(() => Boolean(automatic.releaseUpload)).toBe(true);
  await expect(dialog().getByRole('status').filter({ hasText: '正在上传并校验文件结构' })).toBeVisible(); await expect(fileInput()).toBeDisabled();
  assert.equal(automatic.uploadBodies.length, 1, 'StrictMode must not send a second upload');
  await expect(fileDialog().getByRole('button', { name: '关闭表格导入', exact: true })).toBeDisabled();
  await nextUnavailable(); await screenshot('validation-pending-1440.png'); note(step);

  step = 'unique-candidate-auto-polls-queued-parsing-ready-without-second-parse-post';
  automatic.releaseUpload(); await expect(dialog().getByRole('status').filter({ hasText: '正在自动解析并识别店铺' })).toBeVisible();
  await expect(dialog().getByRole('status').filter({ hasText: '正在等待自动解析' })).toBeVisible(); await nextUnavailable();
  assert.equal(automatic.queueCount, 1); assert.equal(automatic.record.latestRun.sheetName, '在线需求导入'); assert.equal(automatic.record.latestRun.mappingVersion, 'online-v1');
  automatic.parsing(); await expect(dialog().getByRole('status').filter({ hasText: '正在自动解析，已处理 1 行' })).toBeVisible({ timeout: 10_000 });
  await nextUnavailable(); await screenshot('auto-parsing-1440.png');
  automatic.complete(true); await expect(nextButton()).toBeEnabled({ timeout: 10_000 }); await expect(dialog().getByRole('heading', { name: '源行预览', exact: true })).toBeVisible();
  await expect(dialog().getByText('错误行保留定位，不妨碍后续选择其他有效需求提交。', { exact: true })).toBeVisible(); assert.equal(automatic.parseBodies.length, 0); assert.equal(automatic.queueCount, 1);
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await screenshot(`auto-ready-${width}.png`); }
  await nextButton().click(); await currentStage('核对与提交'); note(step); await context.close();

  step = 'lost-upload-response-replays-the-same-file-and-operation-once';
  const lost = fixture(); lost.dropUploadOnce = true; context = await setupContext(lost); await openWizard(); await chooseFile(); await expect(alert('文件和操作号已保留')).toBeVisible();
  assert.equal(await fileInput().evaluate((node) => node.files.length), 1); await retryUpload().click();
  await expect(dialog().getByRole('status').filter({ hasText: '已恢复上次接收结果' })).toBeVisible(); assert.equal(lost.uploadBodies.length, 2); assert.equal(lost.uploadBodies[0].operationId, lost.uploadBodies[1].operationId); assert.equal(lost.queueCount, 1); assert.equal(lost.parseBodies.length, 0);
  const originalRun = lost.run.id; const originalBusinessDate = lost.record.businessDate; note(step); await context.close();

  step = 'repeated-upload-deduplicates-record-and-preserves-original-run-and-business-date';
  context = await setupContext(lost); await openWizard(); await chooseFile();
  await expect(dialog().getByRole('status').filter({ hasText: '已找到相同内容的导入记录' })).toBeVisible();
  assert.equal(lost.uploadBodies.length, 3); assert.notEqual(lost.uploadBodies[2].operationId, lost.uploadBodies[0].operationId); assert.equal(lost.queueCount, 1); assert.equal(lost.run.id, originalRun); assert.equal(lost.record.businessDate, originalBusinessDate); assert.equal(lost.parseBodies.length, 0); note(step); await context.close();

  step = 'legacy-choice-file-draft-opens-child-dialog-and-uploads-once';
  const staged = fixture(); const draftId = uuid(); const draftOperation = uuid();
  staged.drafts.set(draftId, { id: draftId, title: '选择方式阶段的文件草稿', source: 'file', importId: null, rowCount: null, version: 1, createdAt: now, updatedAt: now, content: { source: 'file', progress: { importId: null, source: 'file', step: 1 }, file: { name: 'staged-draft.xlsx', type: mime, lastModified: 1, base64: bytes.toString('base64'), operationId: draftOperation } } });
  context = await setupContext(staged); await page.goto('/shipping?view=demands'); await page.getByRole('button', { name: '草稿箱', exact: true }).click();
  await page.getByRole('dialog', { name: '草稿箱', exact: true }).getByRole('button', { name: '继续编辑', exact: true }).click(); await currentStage();
  await expect(dialog().getByRole('status').filter({ hasText: '正在等待自动解析' })).toBeVisible();
  assert.equal(staged.uploadBodies.length, 1); assert.equal(staged.uploadBodies[0].operationId, draftOperation); assert.equal(staged.queueCount, 1); note(step); await context.close();

  step = 'multiple-supported-sheets-wait-for-explicit-human-sheet-and-mapping';
  const multiple = fixture(); multiple.multiple(); context = await setupContext(multiple); await openWizard(); await chooseFile();
  await expect(dialog().getByRole('status').filter({ hasText: '需要人工选择本次输入工作表' })).toBeVisible(); await nextUnavailable();
  assert.equal(multiple.queueCount, 0); assert.equal(multiple.parseBodies.length, 0);
  await dialog().getByLabel('输入工作表', { exact: true }).click(); await page.getByRole('option', { name: /第二份需求/ }).click(); await chooseOption(dialog().getByLabel('字段映射', { exact: true }), 'online-v1');
  await screenshot('multiple-sheet-choice-1440.png'); await dialog().getByRole('button', { name: '按此映射重新解析', exact: true }).click();
  await expect(dialog().getByRole('status').filter({ hasText: '正在等待自动解析' })).toBeVisible();
  assert.equal(multiple.parseBodies.length, 1); assert.equal(multiple.parseBodies[0].sheetName, '第二份需求'); assert.equal(multiple.parseBodies[0].mappingVersion, 'online-v1'); assert.equal(multiple.queueCount, 1);
  multiple.complete(); await expect(nextButton()).toBeEnabled({ timeout: 10_000 }); note(step); await context.close();

  step = 'parsing-saved-draft-resumes-same-import-without-requeue';
  const recovery = fixture(); context = await setupContext(recovery); await openWizard(); await chooseFile();
  await expect(dialog().getByRole('status').filter({ hasText: '正在等待自动解析' })).toBeVisible(); recovery.parsing(); await refreshRecord();
  await dialog().getByRole('button', { name: '关闭导入向导', exact: true }).click();
  const save = page.getByRole('dialog', { name: '保存到草稿箱？', exact: true }); await save.getByLabel('草稿名称', { exact: true }).fill('自动解析草稿'); await save.getByRole('button', { name: '保存草稿并退出', exact: true }).click(); await expect(dialog()).not.toBeVisible();
  const readsWhileClosed = recovery.detailReads; await delay(1800); assert.equal(recovery.detailReads, readsWhileClosed, 'inactive wizard must stop polling');
  await page.getByRole('button', { name: '新增需求', exact: true }).click(); await currentStage(); await dialog().getByRole('button', { name: '关闭导入向导', exact: true }).click();
  await page.reload(); await expect(dialog()).not.toBeVisible();
  await page.getByRole('button', { name: '草稿箱', exact: true }).click(); await page.getByRole('dialog', { name: '草稿箱', exact: true }).getByRole('button', { name: '继续编辑', exact: true }).click(); await currentStage(); await nextUnavailable();
  assert.equal(recovery.uploadBodies.length, 1); assert.equal(recovery.parseBodies.length, 0); assert.equal(recovery.queueCount, 1);
  recovery.complete(); await expect(nextButton()).toBeEnabled({ timeout: 10_000 }); await nextButton().click(); await currentStage('核对与提交'); note(step); await context.close();

  step = 'upload-in-flight-keeps-wizard-open-until-validation-finishes';
  const closed = fixture(); closed.holdUpload = true; context = await setupContext(closed); await openWizard(); await chooseFile(); await expect.poll(() => Boolean(closed.releaseUpload)).toBe(true);
  await expect(fileDialog().getByRole('button', { name: '关闭表格导入', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(fileDialog()).toBeVisible(); closed.releaseUpload();
  await currentStage(); await expect(dialog().getByRole('status').filter({ hasText: '正在等待自动解析' })).toBeVisible();
  assert.equal(closed.uploadBodies.length, 1); assert.equal(closed.queueCount, 1); assert.equal(closed.parseBodies.length, 0); note(step); await context.close();

  step = 'failed-automatic-parse-keeps-explicit-mapping-retry';
  const failedParse = fixture(); context = await setupContext(failedParse); await openWizard(); await chooseFile();
  await expect(dialog().getByRole('status').filter({ hasText: '正在等待自动解析' })).toBeVisible(); failedParse.fail(); await expect(alert('本次解析失败')).toBeVisible({ timeout: 10_000 }); await nextUnavailable();
  await expect(dialog().getByLabel('字段映射', { exact: true })).toHaveAttribute('data-value', 'online-v1'); await dialog().getByRole('button', { name: '按此映射重新解析', exact: true }).click();
  await expect.poll(() => failedParse.parseBodies.length).toBe(1); failedParse.complete(); await refreshRecord(); await expect(nextButton()).toBeEnabled(); assert.equal(failedParse.queueCount, 2); note(step); await context.close();

  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  heldReleases.forEach((release) => release()); await browser?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill(); await Promise.race([new Promise((done) => processHandle.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), `${JSON.stringify({ kind: 'fixture-only-import-auto-parse-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests, externalLookupRequests: 0 }, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
