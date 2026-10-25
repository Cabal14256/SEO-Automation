import { chooseOption } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

// This suite uses an isolated Vite and in-memory HTTP fixtures. It never opens a
// business database, reads accounts.json, or sends a request to Lingxing.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.IMPORT_WIZARD_EVIDENCE_DIR || resolve(root, '.local/import-refinements'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-18T03:00:00.000Z';
const checks = []; const browserErrors = []; const unexpectedRequests = []; const heldReleases = [];
let processHandle; let browser; let page; let failed = false; let step = 'setup';
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
const uuid = () => randomUUID();
const catalog = { mode: 'manual', version: 1, catalogVersion: 2, lastSyncedAt: now, lastError: null, configured: true, readOnly: true };
const sheet = { name: '技术需求', state: 'visible', rowCount: 3, columnCount: 9, mergedRanges: [], hiddenColumns: [], headers: [{ column: 'A', value: '店铺' }, { column: 'E', value: 'FBA货件号' }] };
const emptyWorkspace = { rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 50, maxBoxes: 10, filters: { batches: [], shops: [], countries: [], channels: [] }, generatedAt: now };

function fixture(sourceType = 'xlsx') {
  const id = uuid(); const runId = uuid(); const fileId = uuid(); const sellerId = uuid();
  const snapshot = { sid: 101, fba: 'FBAWIZARDNEW', shop: '向导技术店铺', country: '美国', channel: '技术渠道', destinationFc: 'ONT8', referenceQuantity: '10', destinationAddress: '123 TECHNICAL FIXTURE ROAD', shipmentCreatedAt: '2026-10-16', sourceFilledAt: '2026-10-17', notes: 'TECHNICAL UI FIXTURE', subBatchName: '技术来源分组' };
  const run = { id: runId, importId: id, status: 'queued', inputVersion: 1, mappingVersion: sourceType === 'online' ? 'online-v1' : 'manual-v1', sheetName: sheet.name, parserVersion: 'xlsx-preview-v1', processedRows: 0, counts: { totalRows: 2, validFbaRows: 2, errorRows: 0, warningRows: 2 }, issues: [], errorCode: null, errorMessage: null, createdAt: now, startedAt: null, completedAt: null };
  const record = { id, fileId, sourceType, submissionStatus: 'not_submitted', submittedSourceRows: 0, originalName: sourceType === 'online' ? '在线填写快照.xlsx' : 'technical-wizard.xlsx', sha256: '0'.repeat(64), byteSize: 1024, createdBy: 'technical-ui', importedAt: now, businessDate: '2026-10-18', datePolicyVersion: 'import-date-shanghai-v1', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', status: 'queued', version: 1, sheets: [sheet], latestRun: run };
  const mapping = { sourceShop: snapshot.shop, sellerMappingId: sellerId, expectedVersion: 1, confirmed: true, sid: snapshot.sid, name: snapshot.shop, country: snapshot.country, confirmedBy: 'technical-ui', confirmedAt: now };
  const source = (index) => ({ rowId: uuid(), parseRunId: runId, importId: id, fileName: record.originalName, sheetName: sheet.name, rowNumber: index + 2, addresses: [`E${index + 2}`] });
  const locations = [source(0), source(1)];
  const items = ['new', 'changed'].map((kind, index) => ({ id: uuid(), kind, selectable: true, sid: 101, fba: index ? 'FBAWIZARDCHANGED' : snapshot.fba, demandId: index ? uuid() : null, expectedDemandVersion: index ? 1 : 0,
    before: index ? { ...snapshot, fba: 'FBAWIZARDCHANGED', channel: '原技术渠道' } : null, after: { ...snapshot, fba: index ? 'FBAWIZARDCHANGED' : snapshot.fba }, sources: [locations[index]], issues: [], alreadyCommitted: false }));
  const rows = items.map((item, index) => ({ id: locations[index].rowId, parseRunId: runId, sheetName: sheet.name, rowNumber: index + 2, hidden: false, status: 'needs_review', rawCells: [{ address: `E${index + 2}`, column: 'E', type: 's', rawValue: item.fba, value: item.fba, numberFormat: '@', formula: null, formulaCache: 'not_formula', hidden: false }],
    normalized: { shop: snapshot.shop, channel: snapshot.channel, country: snapshot.country, destinationFc: snapshot.destinationFc, fba: item.fba, referenceQuantity: '10', sourceDate: null, sourceRecordId: null, notes: snapshot.notes, subBatchName: null, sellerMappingId: null, sid: null, sellerMappingVersion: null }, issues: [] }));
  const state = { record, run, rows, mapping, items, drafts: new Map(), lookups: new Map(), catalog: { ...catalog },
    resolution: { status: 'unique', sellerMappingId: sellerId, expectedVersion: 1, reason: 'name_alias' },
    started: false, preview: null, commits: [], uploadBodies: [], onlineBodies: [], previewBodies: [], commitBodies: [], parseBodies: [],
    dropUploadOnce: false, previewConflictOnce: false, commitConflictOnce: false, loseCommitOnce: false, commitHistoryUnavailable: false, parseConflictOnce: false, parseRecovery: false,
    detailFailures: 0, rowFailures: 0, holdPreview: false, releasePreview: null, confirmationCalls: 0, batchWorkspaceCalls: 0,
    complete() { record.status = 'preview_ready'; run.status = 'completed'; run.startedAt = now; run.completedAt = now; },
    fail() { record.status = 'failed'; run.status = 'failed'; run.errorCode = 'TECHNICAL_PARSE_FAILURE'; run.errorMessage = '技术夹具：解析失败，请修正映射后重试。'; },
    needsMapping() { record.status = 'awaiting_mapping'; run.status = 'completed'; run.sheetName = null; run.mappingVersion = null; },
  };
  state.accepted = () => ({ import: record, run, taskId: run.id, taskUrl: `/api/v1/imports/${id}/runs`, replayed: false, deduplicated: false });
  state.confirmation = () => ({ shops: [{ sourceShop: snapshot.shop, countries: ['美国'], rowCount: 2, resolution: state.resolution }], sellers: [{ id: sellerId, sid: 101, name: snapshot.shop, country: '美国', status: 'approved', version: 1 }], latestPreviewId: state.preview?.preview.id ?? null, submittedSourceRows: record.submittedSourceRows, totalSourceRows: 2, status: record.submissionStatus, baselines: [], catalog: state.catalog });
  state.newPreview = () => {
    state.preview = { preview: { id: uuid(), importId: id, parseRunId: run.id, importVersion: record.version, mappings: [mapping], baselineImportId: null, createdAt: now, createdBy: 'technical-ui', counts: { new: 1, unchanged: 0, changed: 1, conflict: 0, error: 0, missing: 0 }, selectableItemIds: items.map((item) => item.id), changedItemIds: [items[1].id], sellerCatalogMode: state.catalog.mode, sellerCatalogSettingsVersion: state.catalog.version, sellerCatalogVersion: state.catalog.catalogVersion }, items, total: items.length, page: 1, pageSize: 20 };
    return state.preview;
  };
  state.commit = (body) => {
    const existing = state.commits.find((commit) => commit.operationId === body.operationId);
    if (existing) { state.commitHistoryUnavailable = false; return { ...existing, replayed: true }; }
    const selected = items.filter((item) => body.selectedItemIds.includes(item.id));
    const result = { operationId: body.operationId, importId: id, previewId: state.preview.preview.id, createdAt: now, createdBy: 'technical-ui', items: selected.map((item) => ({ itemId: item.id, demandId: item.demandId ?? uuid(), version: item.kind === 'changed' ? 2 : 1, action: item.kind === 'changed' ? 'updated' : 'created', sources: item.sources })), counts: { created: selected.filter((item) => item.kind === 'new').length, updated: selected.filter((item) => item.kind === 'changed').length, linked: 0, alreadyCommitted: 0 }, replayed: false };
    state.commits.push(result); record.submittedSourceRows = selected.length; record.submissionStatus = selected.length === items.length ? 'submitted' : 'partially_submitted'; return result;
  };
  return state;
}

async function setupContext(state) {
  const context = await browser.newContext({ baseURL: globalThis.wizardBaseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const conflict = () => json({ error: { code: 'VERSION_CONFLICT', message: '技术夹具：版本已变化，请核对后重试。' } }, 409);
    if (path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '向导技术检查', email: 'wizard@acceptance.invalid', role: 'admin' } });
    if (path === '/api/v1/demands') return json(emptyWorkspace);
    if (path === '/api/v1/batches/workspace') { state.batchWorkspaceCalls += 1; return json({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } }); }
    if (path === '/api/v1/weekly-batches') return json({ items: [], availableWeeks: [] });
    if (path === '/api/v1/batch-reports') return json({ rows: [], boxes: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, confirmations: [], blocked: [], generatedAt: now });
    if (path === '/api/v1/batch-reports/exports') return json({ items: [] });
    if (path === '/api/v1/physical-reviews') return json({ rows: [], total: 0, page: 1, pageSize: 20, filters: { weeks: [], shops: [], countries: [], channels: [] } });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: state.catalog });
    if (path === '/api/v1/imports/fba-lookups' && method === 'POST') {
      const input = request.postDataJSON(); const id = uuid();
      const result = { id, status: 'completed', fbas: input.fbas, startDate: input.startDate, endDate: input.endDate,
        catalogMode: state.catalog.mode, catalogSettingsVersion: state.catalog.version, catalogVersion: state.catalog.catalogVersion,
        createdAt: now, completedAt: now, errorCode: null, errorMessage: null,
        rows: input.fbas.map((fba) => ({ fba, status: 'unique', candidates: [{ sid: state.mapping.sid, shop: state.mapping.sourceShop, country: state.mapping.country,
          destinationFc: 'ONT8', destinationAddress: '123 TECHNICAL FIXTURE ROAD', shipmentCreatedAt: '2026-10-16', channel: '手工保留渠道', channelSource: 'method_name', channelStatus: 'unique', channelOptions: [{ name: '手工保留渠道', shipmentNumbers: [], channelIds: [], methodNames: ['手工保留渠道'] }], observedAt: now }] })) };
      state.lookups.set(id, result); return json(result, 202);
    }
    const lookupId = path.match(/^\/api\/v1\/imports\/fba-lookups\/([a-f\d-]+)$/i)?.[1];
    if (lookupId) return json(state.lookups.get(lookupId));
    if (path === '/api/v1/imports/drafts' && method === 'GET') return json({ items: [...state.drafts.values()], total: state.drafts.size });
    const draftId = path.match(/^\/api\/v1\/imports\/drafts\/([a-f\d-]+)$/i)?.[1];
    if (draftId && method === 'GET') return json({ draft: state.drafts.get(draftId) });
    if (draftId && method === 'PUT') {
      const input = request.postDataJSON(); const draft = { id: draftId, title: input.title, source: input.content.source, importId: input.content.progress.importId, rowCount: input.content.online?.rows.length ?? null, version: input.expectedVersion + 1, createdAt: now, updatedAt: now, content: input.content };
      state.drafts.set(draftId, draft); return json({ draft, replayed: false });
    }
    if (path === '/api/v1/imports' && method === 'GET') return json({ items: state.started ? [state.record] : [], total: Number(state.started), page: 1, pageSize: 10 });
    if (path === '/api/v1/imports' && method === 'POST') {
      const body = request.postDataBuffer().toString('utf8');
      state.uploadBodies.push({ operationId: body.match(/name="operationId"\r\n\r\n([^\r\n]+)/)?.[1] }); state.started = true;
      if (state.dropUploadOnce) { state.dropUploadOnce = false; return route.abort('connectionfailed'); }
      return json(state.accepted(), 202);
    }
    if (path === '/api/v1/imports/online' && method === 'POST') { state.onlineBodies.push(request.postDataJSON()); state.started = true; return json(state.accepted(), 202); }
    if (path === `/api/v1/imports/${state.record.id}`) {
      if (state.detailFailures > 0) { state.detailFailures -= 1; return json({ error: { code: 'DATABASE_UNAVAILABLE', message: '技术夹具：读取导入失败，请重试。' } }, 503); }
      return json({ import: state.record });
    }
    if (path === `/api/v1/imports/${state.record.id}/runs`) return json({ items: [state.run] });
    if (path === `/api/v1/imports/${state.record.id}/rows`) {
      if (state.rowFailures > 0) { state.rowFailures -= 1; return json({ error: { code: 'DATABASE_UNAVAILABLE', message: '技术夹具：源行暂不可用，请重试。' } }, 503); }
      return json({ items: state.rows, total: state.rows.length, page: 1, pageSize: 20, parseRunId: state.run.id, previewVersion: state.record.version });
    }
    if (path === `/api/v1/imports/${state.record.id}/parse`) {
      const body = request.postDataJSON(); state.parseBodies.push(body);
      if (state.parseConflictOnce) { state.parseConflictOnce = false; return conflict(); }
      state.record.version += 1; state.run.inputVersion = state.record.version; state.run.sheetName = body.sheetName; state.run.mappingVersion = body.mappingVersion;
      state.run.errorCode = null; state.run.errorMessage = null; state.complete(); state.parseRecovery = true;
      return json(state.accepted(), 202);
    }
    if (path === `/api/v1/imports/${state.record.id}/confirmation`) { state.confirmationCalls += 1; return json(state.confirmation()); }
    if (path === `/api/v1/imports/${state.record.id}/preview`) {
      state.previewBodies.push(request.postDataJSON());
      if (state.previewConflictOnce) { state.previewConflictOnce = false; return conflict(); }
      if (state.holdPreview) await new Promise((done) => { state.releasePreview = () => { state.holdPreview = false; done(); }; heldReleases.push(state.releasePreview); });
      return json(state.newPreview(), 201);
    }
    if (path.startsWith(`/api/v1/imports/${state.record.id}/previews/`)) return json(state.preview);
    if (path === `/api/v1/imports/${state.record.id}/commits`) return state.commitHistoryUnavailable
      ? json({ error: { code: 'DATABASE_UNAVAILABLE', message: '技术夹具：暂时无法读取提交历史。' } }, 503) : json({ items: state.commits });
    if (path === `/api/v1/imports/${state.record.id}/commit`) {
      const body = request.postDataJSON(); state.commitBodies.push(body);
      if (state.commitConflictOnce) { state.commitConflictOnce = false; return conflict(); }
      const result = state.commit(body);
      if (state.loseCommitOnce) { state.loseCommitOnce = false; return route.abort('connectionfailed'); }
      return json(result);
    }
    unexpectedRequests.push(`${method} ${path}`);
    return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: `Unhandled fixture ${method} ${path}` } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  return context;
}
const dialog = () => page.getByRole('dialog', { name: '导入向导', exact: true });
const fileDialog = () => page.getByRole('dialog', { name: '表格导入', exact: true });
const nav = () => dialog().getByRole('navigation', { name: '导入步骤', exact: true });
const stageButton = (name) => nav().getByRole('button', { name: new RegExp(name) });
const sourceNext = () => dialog().getByRole('button', { name: '下一步：核对与提交', exact: true });
const submitButton = () => dialog().getByRole('button', { name: '确认提交所选需求', exact: true });
async function currentStage(name) { await expect(nav().locator('[aria-current="step"]')).toContainText(name); }
async function captureDialog(name, position = 'top') {
  await dialog().evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await dialog().locator('.import-dialog-body').first().evaluate((node, target) => { node.scrollTo({ top: target === 'top' ? 0 : node.scrollHeight, behavior: 'instant' }); }, position);
  await page.screenshot({ path: resolve(evidence, name) });
}
async function openWizard(method = 'online') {
  await page.goto('/shipping?view=demands'); await page.getByRole('button', { name: '新增需求', exact: true }).click();
  await expect(dialog()).toBeVisible(); await currentStage('填写与解析');
  if (method === 'file') { await dialog().getByRole('button', { name: '表格导入', exact: true }).click(); await expect(fileDialog()).toBeVisible(); }
}
async function upload() {
  await fileDialog().getByLabel('需求文件', { exact: true }).setInputFiles({ name: 'technical-wizard.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('TECHNICAL UI FIXTURE, HTTP mocked') });
}
async function confirmSeller(state) {
  await chooseOption(dialog().getByLabel(`“${state.mapping.sourceShop}”对应店铺`, { exact: true }), state.mapping.sellerMappingId);
  await expect(dialog().getByText('已采用人工选择', { exact: true })).toBeVisible();
}
async function saveDraftAndExit(title = '向导恢复草稿') {
  const save = page.getByRole('dialog', { name: '保存到草稿箱？', exact: true });
  if (!await save.isVisible()) await dialog().getByRole('button', { name: '保存到草稿箱', exact: true }).click();
  await save.getByLabel('草稿名称', { exact: true }).fill(title); await save.getByRole('button', { name: '保存草稿并退出', exact: true }).click(); await expect(dialog()).not.toBeVisible();
}
async function restoreDraft(title = '向导恢复草稿') {
  await page.getByRole('button', { name: '草稿箱', exact: true }).click();
  const drafts = page.getByRole('dialog', { name: '草稿箱', exact: true });
  await drafts.getByRole('row').filter({ hasText: title }).getByRole('button', { name: '继续编辑', exact: true }).click(); await expect(dialog()).toBeVisible();
}
async function reloadAndResumeRecord() {
  await page.reload(); await expect(dialog()).not.toBeVisible(); await page.getByRole('button', { name: '导入记录', exact: true }).click();
  await page.getByRole('dialog', { name: '导入记录', exact: true }).getByRole('button', { name: '继续导入', exact: true }).click();
}
async function checkFocusAndLayout(label) {
  const node = dialog();
  const rect = await node.boundingBox(); const viewport = page.viewportSize();
  assert(rect && rect.x >= -1 && rect.x + rect.width <= viewport.width + 1, `${label}: dialog width`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: whole-page overflow`);
  await node.getByRole('button', { name: '关闭导入向导', exact: true }).focus();
  for (let index = 0; index < 12; index += 1) { await page.keyboard.press('Tab'); assert(await node.evaluate((element) => element.contains(document.activeElement)), `${label}: focus escaped modal`); }
  await page.keyboard.press('Shift+Tab'); assert(await node.evaluate((element) => element.contains(document.activeElement)));
}
async function checkMergedWorkspace() {
  const shippingNav = page.locator('.sidebar').getByRole('navigation', { name: '发货管理子导航', exact: true });
  await expect(shippingNav.getByRole('link', { name: '发货工作台', exact: true })).toHaveCount(1);
  await expect(shippingNav.getByRole('link', { name: '需求导入', exact: true })).toHaveCount(0);
  await expect(shippingNav.getByRole('link', { name: '发货批次', exact: true })).toHaveCount(0);
  const workspace = page.getByRole('region', { name: '发货工作台', exact: true });
  await expect(page.getByRole('heading', { name: '发货工作台', exact: true })).toBeVisible();
  await expect(workspace.getByRole('button', { name: '新增需求', exact: true })).toHaveCount(1);
  await expect(workspace.getByRole('button', { name: '导入需求', exact: true })).toHaveCount(0);
}
async function checkFooterAction(action, label) {
  const footer = dialog().locator('.import-wizard-footer');
  const back = footer.getByRole('button', { name: '上一步', exact: true });
  await expect(action).toBeVisible();
  assert(await action.evaluate((node) => Boolean(node.closest('.import-wizard-footer'))), `${label}: primary action is in the wizard footer`);
  if (!await back.count()) return;
  await expect(back).toBeVisible();
  const [backBox, actionBox] = await Promise.all([back.boundingBox(), action.boundingBox()]);
  assert(backBox && actionBox && Math.abs(backBox.y + backBox.height / 2 - actionBox.y - actionBox.height / 2) <= 2, `${label}: back and primary action share a row`);
}
async function checkDiffTable() {
  const region = dialog().getByRole('region', { name: '需求增量差异表，可横向滚动', exact: true });
  await expect(region.getByRole('table')).toBeVisible();
  await expect(region.getByRole('columnheader')).toHaveText(['选择', '分类', 'FBA 货件号', '店铺名称', '国家', '业务渠道', '目的 FC', '仓库地址', '货件创建时间', '来源填写时间', '来源分组', '备注', '变化确认', '来源位置 / 校验']);
  await expect(region.getByRole('columnheader', { name: '参考数量', exact: true })).toHaveCount(0);
  await expect(region.getByRole('columnheader', { name: '当前值与拟采用值', exact: true })).toHaveCount(0);
  const changed = region.getByRole('row').filter({ hasText: 'FBAWIZARDCHANGED' });
  const cells = changed.locator('th, td');
  await expect(cells.nth(5)).toContainText('原技术渠道');
  await expect(cells.nth(5)).toContainText('技术渠道');
  await expect(cells.nth(7)).toContainText('123 TECHNICAL FIXTURE ROAD');
  await expect(cells.nth(8)).toContainText('2026-10-16');
  await expect(cells.nth(9)).toContainText('2026-10-17');
  await expect(cells.nth(10)).toContainText('技术来源分组');
}

async function nextUnavailable() { assert(!await sourceNext().count() || !await sourceNext().isEnabled(), 'navigation requires completed source rows and an adopted shop'); }
function seedDraft(state, title, legacyStep, confirmation) {
  const id = uuid();
  state.drafts.set(id, { id, title, source: 'file', importId: state.record.id, rowCount: null, version: 1, createdAt: now, updatedAt: now,
    content: { source: 'file', progress: { importId: state.record.id, source: 'file', step: legacyStep }, ...(confirmation ? { confirmation } : {}) } });
}
try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  globalThis.wizardBaseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  processHandle = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(globalThis.wizardBaseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });

  step = 'direct-online-three-stage-entry-and-nested-file-upload-retry';
  const file = fixture(); file.dropUploadOnce = true;
  let context = await setupContext(file); await openWizard(); await currentStage('填写与解析');
  await expect(nav().getByRole('button')).toHaveCount(3); await expect(nav().getByRole('button')).toHaveText(['1填写与解析', '2核对与提交', '3导入结果']);
  await expect(dialog().getByRole('radio')).toHaveCount(0); await expect(stageButton('核对与提交')).toBeDisabled(); await expect(stageButton('导入结果')).toBeDisabled();
  await captureDialog('wizard-online-primary-1440.png');
  await dialog().getByRole('button', { name: '表格导入', exact: true }).click(); await expect(fileDialog()).toBeVisible();
  await expect(fileDialog().getByRole('button', { name: '上传并校验', exact: true })).toHaveCount(0);
  await upload(); await expect(fileDialog().getByRole('alert')).toBeVisible();
  assert.equal(await fileDialog().getByLabel('需求文件', { exact: true }).evaluate((node) => node.files.length), 1);
  await fileDialog().getByRole('button', { name: '重试上传', exact: true }).click(); await expect.poll(() => file.uploadBodies.length).toBe(2);
  assert(file.uploadBodies[0].operationId); assert.equal(file.uploadBodies[0].operationId, file.uploadBodies[1].operationId);
  await expect(fileDialog()).not.toBeVisible(); await currentStage('填写与解析'); await nextUnavailable();
  file.complete(); await expect(sourceNext()).toBeEnabled({ timeout: 10_000 }); await expect(dialog().getByRole('heading', { name: '源行预览', exact: true })).toBeVisible();
  await expect(dialog().getByText('已自动识别并采用', { exact: true })).toBeVisible(); await expect(dialog().getByRole('checkbox', { name: /^确认“/ })).toHaveCount(0);
  await checkFooterAction(sourceNext(), 'source preview'); await captureDialog('wizard-shop-resolution-1440.png'); note(step);

  step = 'preview-conflict-stays-on-input-and-preserves-automatic-shop';
  file.previewConflictOnce = true; await sourceNext().click(); await expect(dialog().getByRole('alert')).toContainText('版本已变化'); await currentStage('填写与解析');
  await expect(dialog().getByLabel('“' + file.mapping.sourceShop + '”对应店铺', { exact: true })).toHaveAttribute('data-value', file.mapping.sellerMappingId);
  await sourceNext().click(); await currentStage('核对与提交');
  assert.deepEqual(file.previewBodies[1].sellerSelections, [{ sourceShop: file.mapping.sourceShop, sellerMappingId: file.mapping.sellerMappingId, expectedVersion: 1, confirmed: true }]);
  await checkDiffTable(); await checkFooterAction(submitButton(), 'review submit'); await captureDialog('wizard-review-1440.png'); await expect(submitButton()).toBeDisabled();
  await dialog().getByRole('button', { name: '选择全部可提交项', exact: true }).click(); await expect(dialog().getByRole('status').filter({ hasText: /^已选 1 票$/ })).toBeVisible();
  await dialog().getByRole('checkbox', { name: '确认 FBAWIZARDCHANGED 的变化', exact: true }).check(); await dialog().getByRole('button', { name: '选择全部可提交项', exact: true }).click();
  await expect(dialog().getByRole('status').filter({ hasText: /^已选 2 票$/ })).toBeVisible(); note(step);

  step = 'commit-conflict-and-lost-response-preserve-selection-and-operation';
  file.commitConflictOnce = true; await submitButton().click(); await expect(dialog().getByRole('alert')).toContainText('版本已变化');
  file.loseCommitOnce = true; file.commitHistoryUnavailable = true; await submitButton().click(); await expect(dialog().getByRole('alert')).toContainText('本次选择与操作编号已保留');
  file.catalog.version += 1; file.catalog.catalogVersion += 1;
  const confirmationCallsBeforeFocus = file.confirmationCalls;
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); }); assert.equal(file.confirmationCalls, confirmationCallsBeforeFocus);
  await saveDraftAndExit(); await page.reload(); await restoreDraft(); await currentStage('核对与提交');
  await expect(dialog().getByRole('status').filter({ hasText: /^已选 2 票$/ })).toBeVisible(); await expect(dialog().getByRole('button', { name: '选择全部可提交项', exact: true })).toBeDisabled();
  await dialog().getByRole('button', { name: '重试原提交', exact: true }).click(); await currentStage('导入结果');
  assert.equal(file.commitBodies.length, 3); assert.deepEqual(file.commitBodies[1], file.commitBodies[2]); assert.equal(file.commits.length, 1);
  await expect(dialog().getByRole('heading', { name: '本次提交结果', exact: true })).toBeVisible(); await expect(dialog().getByRole('status').filter({ hasText: '已恢复原提交结果' })).toBeVisible(); note(step);

  step = 'submitted-history-resumes-result-and-retains-legacy-detail';
  await page.keyboard.press('Escape'); await expect(dialog()).not.toBeVisible(); await reloadAndResumeRecord(); await currentStage('导入结果'); await page.goto('/imports/' + file.record.id);
  await expect(page.getByRole('heading', { name: '文件解析详情', exact: true })).toBeVisible(); await expect(page.getByRole('region', { name: '需求源行预览表，可横向滚动', exact: true })).toBeVisible(); note(step); await context.close();

  step = 'online-values-survive-file-dialog-and-route-draft-roundtrip';
  const online = fixture('online'); context = await setupContext(online); await openWizard(); await expect(dialog().getByRole('columnheader', { name: '参考数量', exact: true })).toHaveCount(0);
  await dialog().getByLabel('第 1 行FBA 货件号', { exact: true }).fill('FBAWIZARDNEW'); await dialog().getByLabel('第 1 行店铺', { exact: true }).fill(online.mapping.sourceShop);
  await dialog().getByLabel('第 1 行业务渠道', { exact: true }).fill('手工保留渠道'); await dialog().getByRole('button', { name: '表格导入', exact: true }).click(); await expect(fileDialog()).toBeVisible();
  await fileDialog().getByRole('button', { name: '关闭表格导入', exact: true }).click(); await expect(dialog().getByLabel('第 1 行FBA 货件号', { exact: true })).toHaveValue('FBAWIZARDNEW');
  await page.locator('.sidebar nav[aria-label="发货管理子导航"] a[href*="view=physical"]').evaluate((node) => node.click());
  await expect(page.getByRole('dialog', { name: '保存到草稿箱？', exact: true })).toBeVisible(); await saveDraftAndExit('侧栏导航草稿');
  await expect(page).toHaveURL((url) => url.pathname === '/shipping' && url.searchParams.get('view') === 'physical');
  await page.locator('.sidebar').getByRole('link', { name: '发货工作台', exact: true }).click(); await checkMergedWorkspace(); await restoreDraft('侧栏导航草稿'); await currentStage('填写与解析');
  await expect(dialog().getByLabel('第 1 行业务渠道', { exact: true })).toHaveValue('手工保留渠道'); await expect(page.locator('dialog[open]')).toHaveCount(1); note(step);

  step = 'combined-online-action-and-responsive-diff-keyboard-scroll';
  for (const width of [768, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await checkFocusAndLayout('online-' + width); await page.screenshot({ path: resolve(evidence, 'wizard-online-' + width + '.png') }); }
  await dialog().getByRole('button', { name: '补全并解析', exact: true }).click(); await expect.poll(() => online.onlineBodies.length).toBe(1);
  assert.equal(online.lookups.size, 1); assert.equal(online.onlineBodies[0].rows[0].channel, '手工保留渠道'); assert.equal(online.onlineBodies[0].rows[0].referenceQuantity, '');
  online.complete(); await expect(sourceNext()).toBeEnabled({ timeout: 10_000 }); await sourceNext().click(); await currentStage('核对与提交');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await checkFocusAndLayout('review-' + width);
    const region = dialog().getByRole('region', { name: '需求增量差异表，可横向滚动', exact: true });
    await region.focus(); await region.evaluate((node) => { node.scrollLeft = 0; }); await page.keyboard.press('ArrowRight'); await expect.poll(() => region.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await region.evaluate((node) => { node.scrollLeft = 0; }); await checkFooterAction(submitButton(), 'review-' + width); await captureDialog('wizard-review-' + width + '-top.png'); await captureDialog('wizard-review-' + width + '-bottom.png', 'bottom');
  }
  note(step); await context.close();

  step = 'ambiguous-and-legacy-fixtures-require-an-explicit-first-stage-choice';
  for (const resolution of [undefined, { status: 'ambiguous', sellerMappingId: null, expectedVersion: null, reason: 'multiple_matches' }]) {
    const manual = fixture(); manual.resolution = resolution; manual.started = true; manual.complete(); context = await setupContext(manual);
    await page.goto('/imports/new?importId=' + manual.record.id + '&step=3'); await currentStage('填写与解析'); await expect(sourceNext()).toBeDisabled();
    await confirmSeller(manual); await expect(sourceNext()).toBeEnabled(); await sourceNext().click(); await currentStage('核对与提交'); assert.equal(manual.previewBodies[0].sellerSelections[0].confirmed, true); await context.close();
  }
  note(step);

  step = 'reenter-input-refreshes-catalog-and-generates-a-current-preview';
  const automatic = fixture(); automatic.started = true; automatic.complete(); context = await setupContext(automatic);
  await page.goto('/imports/new?importId=' + automatic.record.id + '&step=2'); await expect(sourceNext()).toBeEnabled(); await sourceNext().click(); await currentStage('核对与提交');
  const calls = automatic.confirmationCalls; await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); }); assert.equal(automatic.confirmationCalls, calls);
  automatic.catalog.catalogVersion += 1; await dialog().getByRole('button', { name: '上一步', exact: true }).click(); await currentStage('填写与解析');
  await expect.poll(() => automatic.confirmationCalls).toBeGreaterThan(calls); await expect(sourceNext()).toBeEnabled(); await sourceNext().click(); await currentStage('核对与提交');
  assert.equal(automatic.previewBodies.at(-1).expectedCatalogVersion, automatic.catalog.catalogVersion); note(step); await context.close();

  step = 'legacy-draft-stages-1-and-3-restore-the-first-stage';
  for (const legacyStep of [1, 3]) {
    const legacy = fixture(); legacy.started = true; legacy.complete(); legacy.newPreview(); seedDraft(legacy, '旧阶段草稿' + legacyStep, legacyStep);
    context = await setupContext(legacy); await page.goto('/shipping?view=demands'); await restoreDraft('旧阶段草稿' + legacyStep); await currentStage('填写与解析');
    await expect(nav().getByRole('button')).toHaveCount(3); await expect(sourceNext()).toBeEnabled(); assert.equal(legacy.previewBodies.length, 0); await context.close();
  }
  note(step);

  step = 'invalid-step-4-draft-preview-returns-to-current-source-review';
  for (const invalidField of ['importVersion', 'sellerCatalogVersion']) {
    const invalid = fixture(); invalid.started = true; invalid.complete(); invalid.newPreview(); invalid.preview.preview[invalidField] += 1;
    seedDraft(invalid, '失效预览草稿', 4, { version: 1, importId: invalid.record.id, previewId: invalid.preview.preview.id, pending: null, lastOperationId: null });
    context = await setupContext(invalid); await page.goto('/shipping?view=demands'); await restoreDraft('失效预览草稿'); await currentStage('填写与解析');
    await expect(dialog().getByRole('status').filter({ hasText: '原差异预览已失效' })).toBeVisible(); await expect(stageButton('核对与提交')).toBeDisabled();
    await expect(sourceNext()).toBeEnabled(); await sourceNext().click(); await currentStage('核对与提交'); assert.equal(invalid.previewBodies.length, 1); await context.close();
  }
  note(step);

  step = 'failed-parser-mapping-retry-retains-version-guard';
  const recovery = fixture(); recovery.started = true; recovery.fail(); context = await setupContext(recovery);
  await page.goto('/imports/new?importId=' + recovery.record.id + '&step=5'); await currentStage('填写与解析'); await nextUnavailable(); await expect(dialog().getByRole('alert')).toContainText('解析失败');
  await dialog().getByLabel('输入工作表', { exact: true }).click(); await page.getByRole('option', { name: new RegExp(sheet.name) }).click(); await chooseOption(dialog().getByLabel('字段映射', { exact: true }), 'manual-v1');
  recovery.parseConflictOnce = true; await dialog().getByRole('button', { name: '按此映射重新解析', exact: true }).click(); await expect(dialog().getByRole('alert').filter({ hasText: '版本已变化' })).toBeVisible();
  await dialog().getByRole('button', { name: '按此映射重新解析', exact: true }).click(); await expect(sourceNext()).toBeEnabled(); assert.equal(recovery.parseBodies.length, 2); await sourceNext().click(); await currentStage('核对与提交'); note(step); await context.close();

  step = 'unmapped-parser-and-failed-source-read-cannot-skip-review';
  const unmapped = fixture(); unmapped.started = true; unmapped.needsMapping(); context = await setupContext(unmapped);
  await page.goto('/imports/new?importId=' + unmapped.record.id + '&step=4'); await currentStage('填写与解析'); await nextUnavailable();
  await chooseOption(dialog().getByLabel('字段映射', { exact: true }), 'manual-v1'); await dialog().getByRole('button', { name: '按此映射重新解析', exact: true }).click(); await expect(sourceNext()).toBeEnabled(); await context.close();
  const sourceFailure = fixture(); sourceFailure.started = true; sourceFailure.complete(); sourceFailure.rowFailures = 1;
  context = await setupContext(sourceFailure); await page.goto('/imports/new?importId=' + sourceFailure.record.id + '&step=2');
  await expect(dialog().getByRole('alert')).toContainText('源行预览暂时不可用'); await expect(sourceNext()).toBeDisabled(); await expect(stageButton('核对与提交')).toBeDisabled();
  await dialog().getByRole('button', { name: '重试', exact: true }).click(); await expect(sourceNext()).toBeEnabled(); note(step);

  step = 'preview-in-flight-locks-navigation-until-reviewable';
  sourceFailure.holdPreview = true; await sourceNext().click(); await expect.poll(() => Boolean(sourceFailure.releasePreview)).toBe(true);
  await expect(stageButton('填写与解析')).toBeDisabled(); await expect(stageButton('核对与提交')).toBeDisabled(); sourceFailure.releasePreview(); await currentStage('核对与提交'); note(step); await context.close();

  step = 'history-and-detail-retry-restore-valid-requested-progress';
  const restore = fixture(); restore.started = true; restore.complete(); restore.newPreview(); restore.detailFailures = 1;
  context = await setupContext(restore); await page.goto('/imports/new?importId=' + restore.record.id + '&step=4');
  await expect(dialog().getByRole('alert')).toContainText('无法恢复导入'); await dialog().getByRole('button', { name: '重试', exact: true }).click(); await currentStage('核对与提交'); await expect(submitButton()).toBeDisabled(); await context.close();
  const historical = fixture(); historical.started = true; historical.complete(); historical.newPreview(); historical.commit({ operationId: uuid(), selectedItemIds: historical.items.map((item) => item.id) });
  context = await setupContext(historical); await page.goto('/shipping?view=demands'); await page.getByRole('button', { name: '导入记录', exact: true }).click();
  await page.getByRole('dialog', { name: '导入记录', exact: true }).getByRole('button', { name: '继续导入', exact: true }).click(); await currentStage('导入结果'); note(step); await context.close();

  step = 'legacy-batches-link-resolves-to-the-single-workbench';
  context = await setupContext(fixture()); await page.goto('/shipping?view=batches'); await checkMergedWorkspace(); await page.setViewportSize({ width: 390, height: 900 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); note(step); await context.close();
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  heldReleases.forEach((release) => release()); await browser?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill(); await Promise.race([new Promise((done) => processHandle.once('exit', done)), delay(5_000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-import-wizard-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalLookupRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
