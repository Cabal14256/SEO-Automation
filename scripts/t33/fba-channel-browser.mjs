import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

// This suite serves isolated Vite UI and intercepts all application requests.
// It never reads credentials, opens a business database, or contacts Lingxing.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.FBA_CHANNEL_EVIDENCE_DIR || resolve(root, '.local/fba-channel'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-19T03:00:00.000Z';
const uuid = () => randomUUID();
const checks = []; const browserErrors = []; const unexpectedRequests = []; const externalRequests = [];
const lookupBodies = []; const onlineBodies = []; const savedDrafts = []; const uploadAttempts = [];
const drafts = new Map(); const lookups = new Map();
const catalog = { mode: 'manual', version: 1, catalogVersion: 2, lastSyncedAt: now, lastError: null, configured: true, readOnly: true };
const emptyWorkspace = { rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 50, maxBoxes: 10, filters: { batches: [], shops: [], countries: [], channels: [] }, generatedAt: now };
const option = (name, number) => ({ name, shipmentNumbers: [number], channelIds: [`id-${number}`], methodNames: [name] });
const apiChannel = '海派';
const firstOption = '空派'; const selectedOption = '海运整柜';
let lookupPhase = 'completed', holdNextLookup = false, releaseLookup;
let abortLookupPostAt = 0, abortNextLookupRead = false, abortNextOnline = false;
const lookupReads = [];
const candidate = (channelStatus = 'unique') => ({ sid: 101, shop: '领星渠道测试店铺', country: '美国', destinationFc: 'ONT8', destinationAddress: '123 TECHNICAL FIXTURE ROAD, US', shipmentCreatedAt: '2026-10-16T02:00:00.000Z', observedAt: now,
  channel: channelStatus === 'unique' ? apiChannel : null, channelStatus, channelSource: 'method_name',
  channelOptions: channelStatus === 'unique' ? [option(apiChannel, 'SHIP-UNIQUE')] : channelStatus === 'ambiguous' ? [option(firstOption, 'SHIP-FAST'), option(selectedOption, 'SHIP-REGULAR')] : [],
});
const lookupRow = (fba) => ({ fba, status: fba === 'FBACHANNELMISSING' ? 'not_found' : 'unique', candidates: fba === 'FBACHANNELMISSING' ? [] : [candidate(fba === 'FBACHANNELMULTI' ? 'ambiguous' : fba === 'FBACHANNELNONE' ? 'not_found' : fba === 'FBACHANNELUNAVAILABLE' ? 'unavailable' : 'unique')] });
const ids = { import: uuid(), file: uuid(), run: uuid() };
const run = { id: ids.run, importId: ids.import, status: 'failed', inputVersion: 1, mappingVersion: 'online-v1', sheetName: '在线表格', parserVersion: 'xlsx-preview-v1', processedRows: 6, counts: { totalRows: 6, validFbaRows: 6, errorRows: 0, warningRows: 0 }, issues: [], errorCode: 'TECHNICAL_FIXTURE', errorMessage: '技术测试已记录在线提交内容。', createdAt: now, startedAt: now, completedAt: now };
const sourceImport = { id: ids.import, fileId: ids.file, sourceType: 'online', submissionStatus: 'not_submitted', submittedSourceRows: 0, originalName: '业务渠道浏览器技术夹具.xlsx', sha256: '0'.repeat(64), byteSize: 1024, createdBy: 'technical-ui', importedAt: now, businessDate: '2026-10-19', datePolicyVersion: 'import-date-shanghai-v1', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', status: 'failed', version: 1, sheets: [], latestRun: run };
let processHandle; let browser; let context; let page; let failed = false; let step = 'setup';
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
const dialog = () => page.getByRole('dialog', { name: '导入向导', exact: true });
const cell = (row, column) => dialog().getByLabel(`第 ${row} 行${column}`, { exact: true });
const grid = () => dialog().getByRole('region', { name: '在线需求编辑表，可横向滚动', exact: true });
const gridRow = (number) => grid().locator('tbody tr').nth(number - 1);
async function fill(row, values) { for (const [column, value] of Object.entries(values)) await cell(row, column).fill(value); }
async function expandResult(row) { if (!await gridRow(row).locator('details').evaluate((node) => node.open)) await gridRow(row).locator('summary').click(); }
async function openWizard() {
  await page.goto('/shipping?view=demands');
  await page.getByRole('button', { name: '新增需求', exact: true }).click();
  await expect(dialog().getByRole('button', { name: '补全并解析', exact: true })).toBeEnabled();
}
async function capture(name, width, showChoices = false) {
  await page.setViewportSize({ width, height: 1000 });
  if (showChoices) {
    await gridRow(2).getByRole('button', { name: `采用渠道：${selectedOption}`, exact: true }).scrollIntoViewIfNeeded();
    await grid().evaluate((node) => {
      const summary = node.querySelector('tbody tr:nth-child(2) summary');
      const header = node.querySelector('thead');
      node.scrollTop += summary.getBoundingClientRect().top - node.getBoundingClientRect().top - header.getBoundingClientRect().height - 12;
    });
  }
  else {
    await grid().evaluate((node) => { node.scrollLeft = 0; });
    await dialog().locator(':scope > .import-dialog-body').evaluate((node) => { node.scrollTop = 0; });
  }
  await dialog().evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: the page has no horizontal overflow`);
  const bounds = await dialog().boundingBox();
  assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${name}: modal fits the viewport`);
  await page.screenshot({ path: resolve(evidence, `${name}.png`) });
}
async function saveAndRestoreDraft() {
  const title = `API 渠道补全恢复测试 ${savedDrafts.length + 1}`;
  await dialog().getByRole('button', { name: '保存到草稿箱', exact: true }).click();
  const save = page.getByRole('dialog', { name: '保存到草稿箱？', exact: true });
  await save.getByLabel('草稿名称', { exact: true }).fill(title);
  await save.getByRole('button', { name: '保存草稿并退出', exact: true }).click();
  await expect(dialog()).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '草稿箱', exact: true }).click();
  await page.getByRole('dialog', { name: '草稿箱', exact: true }).getByRole('row').filter({ hasText: title }).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(dialog()).toBeVisible();
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  const baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  processHandle = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method();
    if (url.origin !== baseURL) { externalRequests.push(request.url()); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/v1/')) return route.continue();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '业务渠道技术检查', email: 'fba-channel@acceptance.invalid', role: 'admin' } });
    if (path === '/api/v1/demands') return json(emptyWorkspace);
    if (path === '/api/v1/batches/workspace') return json({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } });
    if (path === '/api/v1/weekly-batches') return json({ items: [], availableWeeks: [] });
    if (path === '/api/v1/batch-reports') return json({ rows: [], boxes: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, confirmations: [], blocked: [], generatedAt: now });
    if (path === '/api/v1/batch-reports/exports') return json({ items: [] });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: catalog });
    if (path === '/api/v1/imports/drafts' && method === 'GET') return json({ items: [...drafts.values()], total: drafts.size });
    const draftId = path.match(/^\/api\/v1\/imports\/drafts\/([a-f\d-]+)$/i)?.[1];
    if (draftId && method === 'GET') return json({ draft: drafts.get(draftId) });
    if (draftId && method === 'PUT') {
      const input = request.postDataJSON(); savedDrafts.push(input);
      const draft = { id: draftId, title: input.title, source: input.content.source, importId: input.content.progress.importId, rowCount: input.content.online?.rows.length ?? null, version: input.expectedVersion + 1, createdAt: now, updatedAt: now, content: input.content };
      drafts.set(draftId, draft); return json({ draft, replayed: false });
    }
    if (path === '/api/v1/imports/fba-lookups' && method === 'POST') {
      const input = request.postDataJSON(); lookupBodies.push(input);
      const old = [...lookups.values()].find((record) => record.operationId === input.operationId);
      const record = old ?? { operationId: input.operationId, id: uuid(), status: 'queued', startDate: input.startDate, endDate: input.endDate, fbas: input.fbas, catalogMode: 'manual', catalogSettingsVersion: 1, catalogVersion: 2, createdAt: now, completedAt: null, errorCode: null, errorMessage: null, rows: [] };
      lookups.set(record.id, record);
      if (lookupBodies.length === abortLookupPostAt) return route.abort('failed');
      if (holdNextLookup) { holdNextLookup = false; await new Promise((release) => { releaseLookup = release; }); releaseLookup = undefined; }
      return json(record, 202);
    }
    const lookupId = path.match(/^\/api\/v1\/imports\/fba-lookups\/([a-f\d-]+)$/i)?.[1];
    if (lookupId) { if (abortNextLookupRead) { abortNextLookupRead = false; return route.abort('failed'); } const record = lookups.get(lookupId); lookupReads.push({ id: lookupId, status: lookupPhase }); return json({ ...record, status: lookupPhase, completedAt: ['completed', 'failed'].includes(lookupPhase) ? now : null, rows: lookupPhase === 'completed' ? record.fbas.map(lookupRow) : [], errorCode: lookupPhase === 'failed' ? 'LINGXING_TIMEOUT' : null, errorMessage: lookupPhase === 'failed' ? '技术夹具：领星补全超时，已填内容保留。' : null }); }
    if (path === '/api/v1/imports/online' && method === 'POST') { onlineBodies.push(request.postDataJSON()); if (abortNextOnline) { abortNextOnline = false; return route.abort('failed'); } return json({ import: sourceImport, run, taskId: ids.run, taskUrl: `/api/v1/imports/${ids.import}/runs`, replayed: false, deduplicated: false }, 202); }
    if (path === '/api/v1/imports' && method === 'POST') { uploadAttempts.push(request.postData()); return json({ error: { code: 'WORKBOOK_INVALID', message: '技术夹具：此工作簿未通过校验，在线填写内容已保留。' } }, 422); }
    if (path === '/api/v1/imports' && method === 'GET') return json({ items: onlineBodies.length ? [sourceImport] : [], total: Number(Boolean(onlineBodies.length)), page: 1, pageSize: 10 });
    if (path === `/api/v1/imports/${ids.import}`) return json({ import: sourceImport });
    if (path === `/api/v1/imports/${ids.import}/commits`) return json({ items: [] });
    if (path === `/api/v1/imports/${ids.import}/runs`) return json({ items: [run] });
    if (path === `/api/v1/imports/${ids.import}/confirmation`) return json({ shops: [], sellers: [], latestPreviewId: null, submittedSourceRows: 0, totalSourceRows: 6, status: 'not_submitted', baselines: [], catalog });
    unexpectedRequests.push(`${method} ${path}`); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: `Unhandled fixture ${method} ${path}` } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  await openWizard();

  step = 'unique-api-channel-overrides-abbreviation-and-preserves-other-manual-fields';
  await fill(1, { 'FBA 货件号': 'FBACHANNELUNIQUE', '店铺': '人工填写店铺', '业务渠道': 'HYKD', '国家': '加拿大', '目的 FC': 'YYZ9' });
  await fill(2, { 'FBA 货件号': 'FBACHANNELMULTI', '业务渠道': 'HYKD' });
  await fill(3, { 'FBA 货件号': 'FBACHANNELNONE', '业务渠道': '人工无渠道保留' });
  await fill(4, { 'FBA 货件号': 'FBACHANNELUNAVAILABLE', '业务渠道': '人工未完成保留' });
  await fill(5, { 'FBA 货件号': 'FBACHANNELMISSING', '店铺': '人工无货件店铺', '业务渠道': '人工无货件保留' });
  await fill(6, { 'FBA 货件号': 'FBACHANNELCLEAR' });
  holdNextLookup = true; lookupPhase = 'queued';
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  const lookupProgress = () => dialog().getByRole('progressbar', { name: '领星 FBA 信息补全', exact: true });
  await expect.poll(() => typeof releaseLookup).toBe('function');
  await expect(cell(1, '店铺')).toBeDisabled();
  await expect(dialog().getByRole('button', { name: '关闭导入向导', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog()).toBeVisible();
  await expect(lookupProgress()).toBeVisible();
  assert.equal(await lookupProgress().getAttribute('aria-valuenow'), null, 'request submission has no known completion denominator');
  releaseLookup();
  await expect.poll(() => lookupReads.at(-1)?.status).toBe('queued');
  await expect(lookupProgress().locator('..')).toHaveAttribute('data-status', 'queued');
  await expect(lookupProgress()).toHaveAttribute('data-indeterminate', 'true');
  assert.equal(await lookupProgress().getAttribute('aria-valuenow'), null);
  lookupPhase = 'running';
  await expect.poll(() => lookupReads.at(-1)?.status).toBe('running');
  await expect(lookupProgress().locator('..')).toHaveAttribute('data-status', 'running');
  await expect(lookupProgress()).toHaveAttribute('data-indeterminate', 'true');
  assert.equal(await lookupProgress().getAttribute('aria-valuenow'), null, 'request budgets must never be exposed as completion percentages');
  await capture('fba-lookup-progress-pending-1440', 1440); await capture('fba-lookup-progress-pending-390', 390);
  await page.setViewportSize({ width: 1440, height: 1000 });
  lookupPhase = 'completed';
  await expect(cell(1, '业务渠道')).toHaveValue(apiChannel);
  await expect(lookupProgress()).toHaveAttribute('aria-valuenow', '100');
  await expect(lookupProgress().locator('..')).toHaveAttribute('data-status', 'completed');
  await expect(cell(1, '店铺')).toHaveValue('人工填写店铺'); await expect(cell(1, '国家')).toHaveValue('加拿大'); await expect(cell(1, '目的 FC')).toHaveValue('YYZ9');
  await expect(cell(1, '仓库地址')).toHaveValue(candidate().destinationAddress);
  await expect(gridRow(1)).toContainText('原值已保留');
  assert.equal(lookupBodies.length, 1); assert.equal(lookupBodies[0].fbas.length, 6); note(step);

  step = 'missing-unavailable-and-unmatched-channel-results-keep-manual-value';
  await expect(cell(3, '业务渠道')).toHaveValue('人工无渠道保留'); await expect(cell(4, '业务渠道')).toHaveValue('人工未完成保留'); await expect(cell(5, '业务渠道')).toHaveValue('人工无货件保留');
  await expandResult(3); await expect(gridRow(3)).toContainText('未找到运输方式，保留手填内容');
  await expandResult(4); await expect(gridRow(4)).toContainText('运输方式查询未完成，保留手填内容');
  await expect(gridRow(5)).toContainText('此日期范围未找到，保留手填内容'); note(step);

  step = 'ambiguous-api-channels-require-explicit-channel-selection';
  await expect(cell(2, '业务渠道')).toHaveValue('HYKD');
  await expandResult(2);
  await expect(gridRow(2).locator('summary')).toContainText('货件信息已采用，渠道待确认');
  await expect(gridRow(2).getByRole('button', { name: `采用渠道：${firstOption}`, exact: true })).toBeVisible();
  await expect(gridRow(2).getByRole('button', { name: `采用渠道：${selectedOption}`, exact: true })).toBeVisible();
  await capture('fba-channel-1440', 1440); await capture('fba-channel-choices-1440', 1440, true);
  await capture('fba-channel-390', 390); await capture('fba-channel-choices-390', 390, true);
  await gridRow(2).getByRole('button', { name: `采用渠道：${selectedOption}`, exact: true }).click();
  await expect(cell(2, '业务渠道')).toHaveValue(selectedOption); note(step);

  step = 'review-pauses-submission-and-reuses-completed-lookup';
  assert.equal(onlineBodies.length, 0, 'review issues must pause automatic parsing');
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(dialog().getByRole('checkbox', { name: /^按当前填写继续/ })).toBeEnabled();
  assert.equal(lookupBodies.length, 1, 'review retries must not query completed FBAs again');
  assert.equal(onlineBodies.length, 0); note(step);
  step = 'draft-restores-channel-autofill-provenance-and-fba-change-clears-api-value';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await saveAndRestoreDraft();
  const saved = savedDrafts.at(-1).content.online;
  assert.equal(saved.autofilled[0].channel, apiChannel); assert.equal(saved.autofilled[1].channel, selectedOption); assert.equal(saved.autofilled[5].channel, apiChannel);
  assert.equal(saved.autofilled[2].channel, undefined); assert.equal(saved.autofilled[3].channel, undefined);
  await expect(cell(1, '业务渠道')).toHaveValue(apiChannel); await expect(cell(2, '业务渠道')).toHaveValue(selectedOption); await expect(cell(6, '业务渠道')).toHaveValue(apiChannel);
  await cell(6, 'FBA 货件号').fill('FBACHANNELNEW');
  await expect(cell(6, '业务渠道')).toHaveValue(''); await expect(cell(6, '店铺')).toHaveValue(''); await expect(cell(6, '仓库地址')).toHaveValue('');
  await cell(3, 'FBA 货件号').fill('FBACHANNELMANUAL'); await expect(cell(3, '业务渠道')).toHaveValue('人工无渠道保留'); note(step);

  step = 'online-submission-uses-selected-api-names-and-preserves-channel-fallbacks';
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(dialog().getByRole('checkbox', { name: /^按当前填写继续/ })).toBeVisible();
  await cell(6, 'FBA 货件号').fill('FBACHANNELUNLOOKED');
  await dialog().getByRole('checkbox', { name: /^按当前填写继续/ }).check();
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect.poll(() => onlineBodies.length).toBe(1);
  assert.deepEqual(onlineBodies[0].rows.map((row) => row.channel), [apiChannel, selectedOption, apiChannel, '人工未完成保留', '人工无货件保留', '']);
  assert.equal(onlineBodies[0].rows[0].shop, '人工填写店铺'); assert.equal(onlineBodies[0].rows[0].country, '加拿大'); assert.equal(onlineBodies[0].rows[0].destinationFc, 'YYZ9');
  assert.equal(onlineBodies[0].rows[5].fba, 'FBACHANNELUNLOOKED');
  await expect(dialog().getByRole('alert').filter({ hasText: '技术测试已记录在线提交内容' })).toBeVisible(); note(step);

  step = 'failed-file-child-dialog-preserves-online-input-before-pending-online-save';
  await openWizard();
  await fill(1, { '备注': '在线填写内容应保留' });
  await dialog().getByRole('button', { name: '表格导入', exact: true }).click();
  const fileDialog = page.getByRole('dialog', { name: '表格导入', exact: true });
  await fileDialog.getByLabel('需求文件', { exact: true }).setInputFiles({ name: 'rejected-technical-fixture.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('invalid-technical-workbook') });
  await expect(fileDialog.getByRole('alert')).toContainText('技术夹具：此工作簿未通过校验');
  assert.equal(uploadAttempts.length, 1);
  await fileDialog.getByRole('button', { name: '关闭表格导入', exact: true }).click();
  await expect(fileDialog).not.toBeVisible();
  await expect(cell(1, '备注')).toHaveValue('在线填写内容应保留'); note(step);

  step = 'over-100-fbas-run-sequentially-deduplicate-and-resume-unknown-batch-with-original-id';
  const beforeLookup = lookupBodies.length, beforeOnline = onlineBodies.length;
  const pastedFbas = [...Array.from({ length: 101 }, (_, index) => `FBABULK${String(index).padStart(3, '0')}`), ' fbabulk000 '];
  await cell(1, 'FBA 货件号').evaluate((node, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, pastedFbas.join('\n'));
  await expect(cell(102, 'FBA 货件号')).toHaveValue(' fbabulk000 ');
  abortLookupPostAt = beforeLookup + 2;
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(dialog().getByRole('checkbox', { name: /^按当前填写继续/ })).toBeEnabled();
  assert.equal(lookupBodies.length, beforeLookup + 2);
  assert.equal(lookupBodies[beforeLookup].fbas.length, 100); assert.equal(lookupBodies[beforeLookup + 1].fbas.length, 1);
  const firstTask = [...lookups.values()].find((record) => record.operationId === lookupBodies[beforeLookup].operationId);
  assert(lookupReads.some((read) => read.id === firstTask.id && read.status === 'completed'), 'the first batch completes before the second request');
  assert.equal(onlineBodies.length, beforeOnline, 'an unknown lookup response pauses automatic saving');
  const uncertainBatch = lookupBodies.at(-1);
  abortLookupPostAt = 0; abortNextLookupRead = true;
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(dialog().getByRole('alert').filter({ hasText: /网络|fetch|Failed|连接/i })).toBeVisible();
  assert.deepEqual(lookupBodies.at(-1), uncertainBatch, 'unknown POST response replays the same input and operation');
  const readsBeforeRetry = lookupBodies.length;
  abortNextOnline = true;
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect.poll(() => onlineBodies.length).toBe(beforeOnline + 1);
  await expect(cell(1, '店铺')).toBeDisabled();
  await expect(dialog().getByRole('button', { name: '表格导入', exact: true })).toBeDisabled();
  assert.equal(lookupBodies.length, readsBeforeRetry, 'a failed poll resumes the accepted task without a new POST');
  const original = onlineBodies.at(-1);
  assert.equal(original.rows.length, 102); assert(original.rows.every((row) => row.shop === candidate().shop && row.channel === apiChannel && row.lookupId));
  assert.equal(original.rows.at(-1).fba, 'FBABULK000');
  assert.equal(new Set(original.rows.map((row) => row.lookupId)).size, 2, 'each row keeps the credential of its own batch');
  note(step);

  step = 'uncertain-save-restores-from-draft-and-replays-original-snapshot-without-lookup';
  await saveAndRestoreDraft();
  const pendingContent = savedDrafts.at(-1).content;
  assert.equal(pendingContent.source, 'online'); assert.equal(pendingContent.progress.source, 'online');
  const pending = pendingContent.online;
  assert.deepEqual(pending.pendingSubmission, original);
  assert.deepEqual(pending.rows, original.rows);
  assert.equal(uploadAttempts.length, 1, 'restoring pending online input must not upload a previously rejected file');
  await expect(page.getByRole('dialog', { name: '表格导入', exact: true })).not.toBeVisible();
  await expect(dialog().getByRole('button', { name: '表格导入', exact: true })).toBeDisabled();
  await expect(cell(1, '店铺')).toBeDisabled();
  await saveAndRestoreDraft();
  const resavedContent = savedDrafts.at(-1).content;
  assert.equal(resavedContent.source, 'online'); assert.equal(resavedContent.progress.source, 'online');
  assert.deepEqual(resavedContent.online.pendingSubmission, original, 'a second save after hydration keeps the original online operation');
  assert.equal(uploadAttempts.length, 1, 'a hidden file panel must not upload or change the pending draft source on hydration');
  await expect(dialog().getByRole('button', { name: '表格导入', exact: true })).toBeDisabled();
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect.poll(() => onlineBodies.length).toBe(beforeOnline + 2);
  assert.deepEqual(onlineBodies.at(-1), original);
  assert.equal(lookupBodies.length, readsBeforeRetry);
  assert.equal(uploadAttempts.length, 1, 'online replay must remain online even when a rejected file is retained in the draft');
  await expect(dialog().getByRole('alert').filter({ hasText: '技术测试已记录在线提交内容' })).toBeVisible(); note(step);

  step = 'terminal-lookup-failure-keeps-values-and-retries-only-failed-stage';
  await openWizard(); lookupPhase = 'failed';
  await fill(1, { 'FBA 货件号': 'FBAFAILURE', '店铺': '人工填写店铺', '业务渠道': '人工渠道' });
  const failureOnlineCount = onlineBodies.length;
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(dialog().getByRole('alert').filter({ hasText: '技术夹具：领星补全超时' })).toBeVisible();
  const failedOperation = lookupBodies.at(-1).operationId;
  await expect(cell(1, '店铺')).toHaveValue('人工填写店铺');
  assert.equal(onlineBodies.length, failureOnlineCount);
  lookupPhase = 'completed';
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect(dialog().getByRole('checkbox', { name: /^按当前填写继续/ })).toBeEnabled();
  assert.notEqual(lookupBodies.at(-1).operationId, failedOperation, 'terminal failed tasks require a fresh task operation');
  await expect(cell(1, '店铺')).toHaveValue('人工填写店铺');
  await expect(cell(1, '业务渠道')).toHaveValue(apiChannel);
  assert.equal(onlineBodies.length, failureOnlineCount);
  await dialog().getByRole('checkbox', { name: /^按当前填写继续/ }).check();
  const failureLookupCount = lookupBodies.length;
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click();
  await expect.poll(() => onlineBodies.length).toBe(failureOnlineCount + 1);
  assert.equal(lookupBodies.length, failureLookupCount); note(step);
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  releaseLookup?.();
  await browser?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill(); await Promise.race([new Promise((done) => processHandle.once('exit', done)), delay(5_000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), `${JSON.stringify({ kind: 'fixture-only-fba-channel-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests, lookupRequests: lookupBodies.length, onlineRequests: onlineBodies.length, uploadRequests: uploadAttempts.length, externalLookupRequests: 0 }, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
