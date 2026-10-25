import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { importDraftSchema, saveImportDraftInputSchema } from '../../packages/contracts/dist/index.js';

// Fixture-only browser verification. All API traffic is intercepted; no real
// database, Lingxing service, import parser, or business data is read or changed.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.IMPORT_DRAFTS_EVIDENCE_DIR || resolve(root, '.local/import-auto-upload/regression/drafts'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-19T03:00:00.000Z';
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const bytes = Buffer.from('PK\u0003\u0004TECHNICAL DRAFT FIXTURE - not a real workbook');
const checks = []; const browserErrors = []; const unexpectedRequests = []; const externalRequests = [];
const writes = []; const deletedImports = []; const contexts = [];
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
const workspace = { rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 50, maxBoxes: 10, filters: { batches: [], shops: [], countries: [], channels: [] }, generatedAt: now };
const catalog = { mode: 'manual', version: 1, catalogVersion: 2, lastSyncedAt: now, lastError: null, configured: true, readOnly: true };
let child; let browser; let page; let baseURL; let failed = false; let step = 'setup';

function fixture() {
  return { drafts: new Map(), deleted: new Set(), puts: [], deletes: [], listQueries: [], uploadBodies: [], saveFailure: false, listFailure: false, conflictNext: false, dropSaveOnce: false,
    record(id, input, previous) {
      return importDraftSchema.parse({ id, title: input.title, source: input.content.source, importId: input.content.progress.importId,
        rowCount: input.content.online ? input.content.online.rows.length : null, version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? now, updatedAt: now, content: structuredClone(input.content) });
    },
  };
}

async function setup(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== baseURL) { externalRequests.push(request.url()); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/v1/')) return route.continue();
    const path = url.pathname; const method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/v1/session') return json({ user: { id: 'drafts-ui-fixture', name: '草稿箱技术验证', email: 'drafts@acceptance.invalid', role: 'admin' } });
    if (path === '/api/v1/demands') return json(workspace);
    if (path === '/api/v1/batches/workspace') return json({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [], filters: { weeks: [], shops: [], countries: [], channels: [] } });
    if (path === '/api/v1/weekly-batches') return json({ items: [], availableWeeks: [] });
    if (path === '/api/v1/batch-reports') return json({ rows: [], boxes: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, confirmations: [], blocked: [], generatedAt: now });
    if (path === '/api/v1/batch-reports/exports') return json({ items: [] });
    if (path === '/api/v1/physical-reviews') return json({ rows: [], total: 0, page: 1, pageSize: 20, filters: { weeks: [], shops: [], countries: [], channels: [] } });
    if (path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: catalog });
    if (path === '/api/v1/imports' && method === 'GET') return json({ items: [], total: 0, page: 1, pageSize: 10 });
    if (path === '/api/v1/imports' && method === 'POST') {
      state.uploadBodies.push(request.postDataBuffer());
      return json({ error: { code: 'INVALID_WORKBOOK', message: '技术夹具：已收到恢复文件，停止实际解析。' } }, 422);
    }
    if (path === '/api/v1/imports/drafts' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''; state.listQueries.push(q);
      if (state.listFailure) return json({ error: { code: 'INTERNAL_ERROR', message: '技术夹具：草稿列表读取失败。' } }, 503);
      const items = [...state.drafts.values()].filter((draft) => `${draft.title} ${JSON.stringify(draft.content.online?.rows ?? [])}`.toLowerCase().includes(q.toLowerCase()));
      const p = Number(url.searchParams.get('page') ?? 1); const size = Number(url.searchParams.get('pageSize') ?? 20);
      return json({ items: items.slice((p - 1) * size, p * size).map(({ content: _content, ...summary }) => summary), total: items.length });
    }
    const match = path.match(/^\/api\/v1\/imports\/drafts\/([a-f\d-]+)$/i);
    if (match) {
      const id = match[1]; const current = state.drafts.get(id);
      if (method === 'GET') return current ? json({ draft: current }) : json({ error: { code: 'NOT_FOUND' } }, 404);
      if (method === 'PUT') {
        const input = saveImportDraftInputSchema.parse(request.postDataJSON()); state.puts.push({ id, input }); writes.push({ method, path });
        if (state.saveFailure) return json({ error: { code: 'INTERNAL_ERROR' } }, 503);
        if (state.conflictNext && current) { state.conflictNext = false; state.drafts.set(id, { ...current, version: current.version + 1 }); return json({ error: { code: 'VERSION_CONFLICT' } }, 409); }
        if (current && JSON.stringify(current.content) === JSON.stringify(input.content) && current.title === input.title && input.expectedVersion === current.version - 1) return json({ draft: current, replayed: true });
        if (state.deleted.has(id) || input.expectedVersion !== (current?.version ?? 0)) return json({ error: { code: 'VERSION_CONFLICT' } }, 409);
        const draft = state.record(id, input, current); state.drafts.set(id, draft);
        if (state.dropSaveOnce) { state.dropSaveOnce = false; return route.abort('connectionfailed'); }
        return json({ draft, replayed: false });
      }
      if (method === 'DELETE') {
        state.deletes.push({ id, version: Number(url.searchParams.get('version')) }); writes.push({ method, path });
        if (!current) return json({ error: { code: 'NOT_FOUND' } }, 404);
        if (Number(url.searchParams.get('version')) !== current.version) return json({ error: { code: 'VERSION_CONFLICT' } }, 409);
        state.deleted.add(id); state.drafts.delete(id); return json({ deleted: true });
      }
    }
    if (method === 'DELETE' && path.startsWith('/api/v1/imports/')) deletedImports.push(path);
    unexpectedRequests.push(`${method} ${path}`); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: `Unhandled fixture ${method} ${path}` } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  return context;
}

const wizard = () => page.getByRole('dialog', { name: '导入向导', exact: true });
const fileBox = () => page.getByRole('dialog', { name: '表格导入', exact: true });
const fileIsOpen = () => page.locator('dialog[open]').evaluateAll((nodes) => nodes.some((node) => node.querySelector('h2')?.textContent === '表格导入'));
const box = () => page.getByRole('dialog', { name: '草稿箱', exact: true });
const saveDialog = () => page.getByRole('dialog', { name: '保存到草稿箱？', exact: true });
const fba = () => wizard().getByRole('textbox', { name: '第 1 行FBA 货件号', exact: true });
const button = (name, surface = wizard()) => surface.getByRole('button', { name, exact: true });
async function start(source = 'online') {
  await page.getByRole('button', { name: '新增需求', exact: true }).click();
  await expect(wizard().getByRole('navigation', { name: '导入步骤', exact: true }).locator('[aria-current="step"]')).toContainText('填写与解析');
  if (source === 'file') await switchSource('file');
}
async function switchSource(source) {
  if (source === 'file') { await button('表格导入').click(); await expect(fileBox()).toBeVisible(); }
  else if (await fileIsOpen()) { await button('关闭表格导入', fileBox()).click(); await expect(fileBox()).not.toBeVisible(); }
}
async function closeWizard() { if (await fileIsOpen()) await switchSource('online'); await button('关闭导入向导').click(); }
async function discard() { await button('不保存，退出', saveDialog()).click(); await expect(wizard()).not.toBeVisible(); }
async function save(name) {
  const input = saveDialog().getByLabel('草稿名称', { exact: true });
  if (await input.isEnabled()) await input.fill(name);
  await saveDialog().getByRole('button', { name: /^(保存草稿并退出|重试原草稿保存)$/ }).click();
  await expect(saveDialog()).not.toBeVisible(); await expect(wizard()).not.toBeVisible();
}
async function openBox() { await page.getByRole('button', { name: '草稿箱', exact: true }).click(); await expect(box()).toBeVisible(); }
const draftRow = (name) => box().getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
async function edit(name) { await draftRow(name).getByRole('button', { name: '继续编辑', exact: true }).click(); await expect(wizard()).toBeVisible(); }
async function screenshot(name) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: resolve(evidence, name) });
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const state = fixture(); const context = await setup(state); await page.goto('/shipping?view=demands', { timeout: 60_000 });

  step = 'blank-by-default-and-empty-draft-box';
  await openBox(); await expect(box().getByRole('heading', { name: '草稿箱为空', exact: true })).toBeVisible(); await button('关闭草稿箱', box()).click();
  await start(); await expect(fba()).toHaveValue(''); assert.equal(state.puts.length, 0); note(step);

  step = 'close-and-escape-prompt-can-continue-without-losing-input';
  await fba().fill('FBADRAFT001'); await wizard().getByRole('textbox', { name: '第 1 行业务渠道', exact: true }).fill('海运');
  await closeWizard(); await expect(saveDialog()).toBeVisible(); await button('继续填写', saveDialog()).click(); await expect(fba()).toHaveValue('FBADRAFT001');
  await page.keyboard.press('Escape'); await expect(saveDialog()).toBeVisible(); await button('继续填写', saveDialog()).click(); await expect(fba()).toHaveValue('FBADRAFT001');
  assert.equal(state.puts.length, 0); note(step);

  step = 'failed-save-keeps-title-and-online-input-for-retry';
  await button('保存到草稿箱').click(); await saveDialog().getByLabel('草稿名称', { exact: true }).fill('十月海运草稿');
  state.saveFailure = true; await button('保存草稿并退出', saveDialog()).click(); await expect(saveDialog().getByRole('alert')).toBeVisible();
  await expect(saveDialog().getByLabel('草稿名称', { exact: true })).toHaveValue('十月海运草稿'); assert.equal(state.drafts.size, 0);
  state.saveFailure = false; await save('十月海运草稿'); assert.equal(state.drafts.size, 1); assert.equal(state.puts[0].id, state.puts[1].id); assert.equal(state.puts[0].input.expectedVersion, 0);
  await start(); await expect(fba()).toHaveValue(''); await closeWizard(); await expect(saveDialog()).not.toBeVisible(); note(step);

  step = 'lost-save-response-retries-the-original-id-and-payload';
  await start(); await fba().fill('FBALOSTSAVE001'); await closeWizard(); await saveDialog().getByLabel('草稿名称', { exact: true }).fill('响应丢失草稿');
  state.dropSaveOnce = true; await button('保存草稿并退出', saveDialog()).click(); await expect(saveDialog().getByRole('alert')).toBeVisible();
  const lostId = state.puts.at(-1).id; const lostInput = state.puts.at(-1).input; const lostCount = state.drafts.size;
  await expect(button('继续填写', saveDialog())).toBeDisabled(); await expect(button('不保存，退出', saveDialog())).toBeDisabled();
  await save('响应丢失草稿'); assert.equal(state.puts.at(-1).id, lostId); assert.deepEqual(state.puts.at(-1).input, lostInput); assert.equal(state.drafts.size, lostCount); note(step);

  step = 'saved-online-draft-search-edit-and-versioned-update';
  await openBox(); await box().getByLabel('搜索草稿', { exact: true }).fill('FBADRAFT001'); await button('查询', box()).click(); await expect(draftRow('十月海运草稿')).toBeVisible();
  assert.equal(state.listQueries.at(-1), 'FBADRAFT001'); await edit('十月海运草稿'); await expect(fba()).toHaveValue('FBADRAFT001');
  await expect(wizard().getByRole('textbox', { name: '第 1 行业务渠道', exact: true })).toHaveValue('海运');
  await fba().fill('FBADRAFT002'); await closeWizard(); await save('十月海运草稿'); assert.equal([...state.drafts.values()].find((draft) => draft.title === '十月海运草稿').version, 2); assert.equal([...state.drafts.values()].find((draft) => draft.title === '十月海运草稿').content.online.rows[0].fba, 'FBADRAFT002'); note(step);

  step = 'draft-box-search-empty-reset-read-error-and-retry';
  await openBox(); await box().getByLabel('搜索草稿', { exact: true }).fill('不存在的草稿'); await button('查询', box()).click(); await expect(box().getByRole('heading', { name: '没有找到匹配草稿', exact: true })).toBeVisible();
  await button('清除搜索', box()).click(); await expect(draftRow('十月海运草稿')).toBeVisible(); state.listFailure = true; await button('刷新草稿箱', box()).click(); await expect(box().getByRole('alert')).toBeVisible();
  state.listFailure = false; await button('重试', box()).click(); await expect(draftRow('十月海运草稿')).toBeVisible(); note(step);

  step = 'rename-conflict-preserves-name-and-requires-reload';
  await draftRow('十月海运草稿').getByRole('button', { name: '重命名草稿', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名草稿', exact: true }); await rename.getByLabel('草稿名称', { exact: true }).fill('十月海运已核对'); state.conflictNext = true;
  await button('保存名称', rename).click(); await expect(rename.getByRole('alert')).toContainText('草稿已在其他窗口更新'); await expect(rename.getByLabel('草稿名称', { exact: true })).toHaveValue('十月海运已核对'); await expect(button('保存名称', rename)).toBeDisabled();
  await button('重新读取草稿', rename).click(); await expect(button('保存名称', rename)).toBeEnabled(); await button('保存名称', rename).click(); await expect(rename).not.toBeVisible(); await expect(draftRow('十月海运已核对')).toBeVisible(); note(step);

  step = 'responsive-draft-box-and-keyboard-management';
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await screenshot(`draft-box-${width}.png`); }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.keyboard.press('Escape'); await expect(box()).not.toBeVisible(); note(step);

  step = 'workbook-draft-restores-byte-content-and-operation-and-auto-uploads-on-active-file-step';
  await start('file'); await wizard().getByLabel('需求文件', { exact: true }).setInputFiles({ name: 'technical-draft.xlsx', mimeType: mime, buffer: bytes });
  await expect(wizard().getByRole('alert')).toContainText('已收到恢复文件'); assert.equal(state.uploadBodies.length, 1);
  await expect(button('上传并校验')).toHaveCount(0); await closeWizard(); await save('文件草稿');
  const fileDraft = [...state.drafts.values()].find((draft) => draft.title === '文件草稿'); assert.equal(fileDraft.content.file.base64, bytes.toString('base64')); assert(fileDraft.content.file.operationId);
  await openBox(); await edit('文件草稿'); await expect(wizard().getByRole('status').filter({ hasText: '已选择：technical-draft.xlsx' })).toBeVisible();
  await expect(wizard().getByRole('alert')).toContainText('已收到恢复文件'); assert.equal(state.uploadBodies.length, 2); assert(state.uploadBodies[1].includes(bytes)); assert(state.uploadBodies[1].includes(Buffer.from(fileDraft.content.file.operationId)));
  await button('重试上传').click(); await expect.poll(() => state.uploadBodies.length).toBe(3); await expect(wizard().getByRole('alert')).toContainText('已收到恢复文件'); assert(state.uploadBodies[2].includes(Buffer.from(fileDraft.content.file.operationId)));
  await closeWizard(); await discard(); note(step);

  step = 'restored-fba-edit-clears-autofilled-values-and-preserves-manual-edits';
  const seededId = randomUUID(); const seededRow = { fba: 'FBAAUTOFILLEDDRAFT1', shop: '自动补全店铺', channel: '海运', country: '美国', destinationFc: 'ONT8', destinationAddress: '自动补全地址', shipmentCreatedAt: '2026-10-01', sourceFilledAt: '', referenceQuantity: '', notes: '' };
  state.drafts.set(seededId, state.record(seededId, { title: '自动补全恢复草稿', content: { source: 'online', progress: { source: 'online', importId: null, step: 2 }, online: { rows: [seededRow], startDate: '2026-07-01', endDate: '2026-10-19', operationId: randomUUID(), autofilled: [{ shop: seededRow.shop, country: seededRow.country, destinationFc: seededRow.destinationFc, destinationAddress: seededRow.destinationAddress, shipmentCreatedAt: seededRow.shipmentCreatedAt }] } } }));
  await openBox(); await button('刷新草稿箱', box()).click(); await edit('自动补全恢复草稿');
  await wizard().getByRole('textbox', { name: '第 1 行仓库地址', exact: true }).fill('手动修正后地址'); await fba().fill('FBAAUTOFILLEDDRAFT2');
  for (const label of ['店铺', '国家', '目的 FC', '货件创建时间']) await expect(wizard().getByRole('textbox', { name: `第 1 行${label}`, exact: true })).toHaveValue('');
  await expect(wizard().getByRole('textbox', { name: '第 1 行仓库地址', exact: true })).toHaveValue('手动修正后地址'); await expect(wizard().getByRole('textbox', { name: '第 1 行业务渠道', exact: true })).toHaveValue('海运'); await closeWizard(); await discard(); note(step);

  step = 'nested-file-dialog-preserves-online-and-workbook-inputs-in-drafts';
  await start(); await fba().fill('FBAHIDDENONLINE001'); await switchSource('file'); await closeWizard(); await expect(saveDialog()).toBeVisible(); await save('隐藏在线内容');
  const hiddenOnline = [...state.drafts.values()].find((draft) => draft.title === '隐藏在线内容'); assert.equal(hiddenOnline.content.online.rows[0].fba, 'FBAHIDDENONLINE001');
  await start('file'); await wizard().getByLabel('需求文件', { exact: true }).setInputFiles({ name: 'hidden-file.xlsx', mimeType: mime, buffer: bytes }); await expect(wizard().getByRole('alert')).toContainText('已收到恢复文件'); await switchSource('online'); await expect(fba()).toHaveValue('');
  await closeWizard(); await expect(saveDialog()).toBeVisible(); await save('隐藏文件内容');
  const hiddenFile = [...state.drafts.values()].find((draft) => draft.title === '隐藏文件内容'); assert.equal(hiddenFile.content.file.base64, bytes.toString('base64'));
  await openBox(); await edit('隐藏在线内容'); await switchSource('online'); await expect(fba()).toHaveValue('FBAHIDDENONLINE001'); await closeWizard(); await discard();
  const uploadsBeforeHiddenRestore = state.uploadBodies.length;
  await openBox(); await edit('隐藏文件内容');
  if (!await fileBox().isVisible()) await switchSource('file');
  await expect(fileBox().getByRole('status').filter({ hasText: 'hidden-file.xlsx' })).toBeVisible(); await expect(fileBox().getByRole('alert')).toContainText('已收到恢复文件'); assert.equal(state.uploadBodies.length, uploadsBeforeHiddenRestore + 1);
  await switchSource('online'); await expect(fba()).toHaveValue(''); await closeWizard(); await discard(); note(step);

  step = 'editing-conflict-can-save-a-new-draft-without-overwriting-original';
  await openBox(); await edit('十月海运已核对'); await fba().fill('FBACONFLICTCOPY001'); await closeWizard(); state.conflictNext = true;
  await button('保存草稿并退出', saveDialog()).click(); await expect(saveDialog().getByRole('alert')).toContainText('原草稿已变化');
  const existing = [...state.drafts.values()].find((draft) => draft.title === '十月海运已核对'); const countBeforeCopy = state.drafts.size;
  await button('另存新草稿并退出', saveDialog()).click(); await expect(wizard()).not.toBeVisible(); assert.equal(state.drafts.size, countBeforeCopy + 1);
  assert.equal(state.drafts.get(existing.id).content.online.rows[0].fba, 'FBADRAFT002'); assert([...state.drafts.values()].some((draft) => draft.id !== existing.id && draft.content.online?.rows[0]?.fba === 'FBACONFLICTCOPY001')); note(step);

  step = 'reload-native-warning-can-cancel-and-retain-unsaved-online-input';
  await start(); await fba().fill('FBAREFRESH001'); await expect(button('保存到草稿箱')).toBeEnabled(); await fba().click(); await fba().press('End'); let nativeWarning = '';
  page.once('dialog', async (dialog) => { nativeWarning = dialog.type(); await dialog.dismiss(); });
  const reload = page.reload({ waitUntil: 'commit', timeout: 3000 }).catch((error) => { if (!/ERR_ABORTED|Navigation.*canceled|Timeout/i.test(error.message)) throw error; });
  await expect.poll(() => nativeWarning).toBe('beforeunload'); await reload;
  await expect(fba()).toHaveValue('FBAREFRESH001'); await closeWizard(); await discard(); note(step);

  step = 'route-back-navigation-prompts-before-discard';
  await start(); await fba().fill('FBAROUTE001'); await expect(button('保存到草稿箱')).toBeEnabled();
  await page.locator('.sidebar nav[aria-label="发货管理子导航"] a[href*="view=physical"]').evaluate((node) => node.click()); await expect(saveDialog()).toBeVisible();
  await button('继续填写', saveDialog()).click(); await expect(fba()).toHaveValue('FBAROUTE001'); await closeWizard(); await save('路由退出草稿'); note(step);

  step = 'delete-is-confirmed-and-only-removes-draft';
  await openBox(); const count = state.drafts.size;
  await draftRow('文件草稿').getByRole('button', { name: '删除草稿', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除草稿', exact: true }); await expect(confirmation).toContainText('已接收的导入记录和已提交需求会保留'); await button('取消', confirmation).click(); assert.equal(state.drafts.size, count);
  await draftRow('文件草稿').getByRole('button', { name: '删除草稿', exact: true }).click(); await button('确认删除草稿', confirmation).click(); await expect(draftRow('文件草稿')).not.toBeVisible(); assert.equal(state.drafts.size, count - 1); assert.equal(state.deletes.length, 1); assert.deepEqual(deletedImports, []); note(step);

  step = 'explicit-discard-keeps-next-import-blank';
  await button('关闭草稿箱', box()).click(); await start(); await fba().fill('FBADISCARD001'); await closeWizard(); const savedCount = state.drafts.size; await discard(); await start(); await expect(fba()).toHaveValue(''); assert.equal(state.drafts.size, savedCount); await closeWizard(); note(step);
  await context.close(); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => {}))); await browser?.close();
  if (child && child.exitCode === null) { child.kill(); await Promise.race([new Promise((done) => child.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), `${JSON.stringify({ kind: 'fixture-only-import-drafts-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests, writes, externalLookupRequests: 0, realBusinessWrites: 0 }, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
