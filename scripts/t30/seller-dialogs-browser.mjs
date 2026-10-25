import { chooseOption, readOptions } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { sellerMappingSchema, sellerCatalogSettingsSchema } from '../../packages/contracts/dist/index.js';

// UI fixtures only: every API and non-local origin is intercepted. These tests
// never read credentials, access business databases, or synchronize real sellers.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.SELLER_DIALOGS_EVIDENCE_DIR || resolve(root, '.local/t30/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-18T09:00:00.000Z';
const user = { id: 'fixture-admin', name: '店铺弹窗技术验证', email: 'seller-dialogs@acceptance.invalid', role: 'admin' };
const checks = []; const browserErrors = []; const unexpectedApi = []; const externalRequests = []; const releases = [];
let browser; let processHandle; let baseURL; let page; let failed = false; let step = 'setup';
const uuid = () => randomUUID();
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
function mapping(overrides = {}) { return sellerMappingSchema.parse({ id: uuid(), sid: 910001, name: '技术领星店铺', country: '德国', marketplaceId: 'A1PA6795UKMFR9', wid: null, aliases: [], status: 'approved', version: 3, updatedAt: now, sourceObservedAt: now, sourceSha256: 'a'.repeat(64), dataSource: 'lingxing', manualEnabled: false, lingxingName: '技术领星店铺', lingxingStatus: '1', identityLocked: true, hasApprovedBefore: true, autoApproved: true, ...overrides }); }
function fixture(mode = 'lingxing') {
  const remote = mapping(); const disabled = mapping({ sid: 910002, name: '本地停用技术店铺', lingxingName: '本地停用技术店铺', status: 'disabled', aliases: ['保留本地别名'] });
  const manual = mapping({ sid: 4111, name: '人工候选技术店铺', country: '美国', marketplaceId: null, status: 'candidate', version: 1, dataSource: 'manual', manualEnabled: true, lingxingName: null, lingxingStatus: null, identityLocked: false, hasApprovedBefore: false, autoApproved: false });
  return { settings: sellerCatalogSettingsSchema.parse({ mode, version: 5, catalogVersion: 9, lastSyncedAt: now, lastError: null, configured: true, readOnly: true }), remote, disabled, manual, remoteItems: [remote, disabled], manualItems: [manual], histories: new Map([[remote.id, []], [disabled.id, []], [manual.id, []]]), historyReads: [], operations: new Map(), writes: { mode: [], sync: [], manual: [], aliases: [], revise: [] }, hold: null, release: null, dropOnce: null, conflictOnce: null,
    revise(target, input) { const before = structuredClone(target); Object.assign(target, Object.fromEntries(Object.entries(input).filter(([key]) => ['sid', 'name', 'country', 'marketplaceId', 'wid', 'aliases', 'status'].includes(key))), { version: target.version + 1, hasApprovedBefore: target.hasApprovedBefore || input.status === 'approved' }); this.settings.catalogVersion += 1; const revision = { operationId: input.operationId, version: target.version, actorUserId: user.id, reason: input.identityConfirmed ? `首次批准：已核对店铺身份（${target.name}，sid ${target.sid}，${target.country}）。` : input.reason, createdAt: now, before, after: structuredClone(target) }; this.histories.get(target.id).unshift(revision); return target; },
  };
}
async function setupContext(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL) { externalRequests.push(request.url()); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user });
    if (path === '/api/v1/seller-mappings/catalog-settings' && method === 'GET') return json({ settings: state.settings });
    if (path === '/api/v1/seller-mappings' && method === 'GET') { let items = state.settings.mode === 'lingxing' ? state.remoteItems : state.manualItems; const status = url.searchParams.get('status'); const search = url.searchParams.get('search'); if (status) items = items.filter((item) => item.status === status); if (search) items = items.filter((item) => `${item.name} ${item.aliases.join(' ')} ${item.sid}`.includes(search)); return json({ items, total: items.length, settings: state.settings }); }
    const target = [...state.remoteItems, ...state.manualItems].find((item) => path.startsWith(`/api/v1/seller-mappings/${item.id}/`));
    if (target && path.endsWith('/history')) { state.historyReads.push(target.id); return json({ items: state.histories.get(target.id) }); }
    const kind = path === '/api/v1/seller-mappings/catalog-settings' ? 'mode' : path === '/api/v1/seller-mappings/sync' ? 'sync' : path === '/api/v1/seller-mappings/manual' ? 'manual' : target && path.endsWith('/aliases') ? 'aliases' : target && path.endsWith('/revise') ? 'revise' : null;
    if (kind && method === 'POST') {
      const input = request.postDataJSON(); state.writes[kind].push(input); assert.match(input.operationId, /^[0-9a-f-]{36}$/i);
      if (state.hold === kind) await new Promise((done) => { state.release = () => { state.hold = null; done(); }; releases.push(state.release); });
      if (state.conflictOnce === kind) { state.conflictOnce = null; state.settings.version += 1; state.settings.catalogVersion += 1; return json({ error: { code: 'VERSION_CONFLICT' } }, 409); }
      let result = state.operations.get(input.operationId);
      if (result) result = { ...structuredClone(result), replayed: true };
      else {
        if (kind === 'mode') { assert.equal(input.expectedVersion, state.settings.version); state.settings.mode = input.mode; state.settings.version += 1; result = { settings: structuredClone(state.settings), replayed: false }; }
        if (kind === 'sync') { assert.equal(input.expectedVersion, state.settings.version); state.settings.catalogVersion += 1; state.settings.lastSyncedAt = now; result = { settings: structuredClone(state.settings), total: 2, inserted: 0, updated: 2, replayed: false }; }
        if (kind === 'manual') { assert.equal(state.settings.mode, 'manual'); const created = mapping({ sid: input.sid, name: input.name, country: input.country, marketplaceId: null, status: 'candidate', version: 1, dataSource: 'manual', manualEnabled: true, lingxingName: null, lingxingStatus: null, identityLocked: false, hasApprovedBefore: false, autoApproved: false }); state.manualItems.push(created); state.histories.set(created.id, []); state.settings.catalogVersion += 1; result = { mapping: structuredClone(created), replayed: false }; }
        if (kind === 'aliases' || kind === 'revise') { assert.equal(input.expectedVersion, target.version); if (kind === 'aliases') { assert.deepEqual(Object.keys(input).sort(), ['operationId', 'expectedVersion', 'expectedCatalogSettingsVersion', 'expectedCatalogVersion', 'aliases', 'status', 'reason'].sort()); assert.equal(input.expectedCatalogSettingsVersion, state.settings.version); assert.equal(input.expectedCatalogVersion, state.settings.catalogVersion); assert.notEqual(input.status, 'candidate'); assert(input.reason); } result = { mapping: structuredClone(state.revise(target, input)), replayed: false }; }
        state.operations.set(input.operationId, structuredClone(result));
      }
      if (state.dropOnce === kind) { state.dropOnce = null; return route.abort('connectionfailed'); }
      return json(result, kind === 'manual' ? 201 : 200);
    }
    unexpectedApi.push(`${method} ${path}`); return json({ error: { code: 'NOT_FOUND', message: `Unhandled isolated fixture ${path}` } }, 404);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/settings/seller-mappings'); await expect(page.getByRole('heading', { name: '店铺目录', exact: true })).toBeVisible();
  return context;
}
const sourceDialog = () => page.getByRole('dialog', { name: '店铺来源设置', exact: true });
const manualDialog = () => page.getByRole('dialog', { name: '新增人工店铺', exact: true });
const editorDialog = () => page.getByRole('dialog', { name: '维护店铺', exact: true });
const sourceButton = () => page.getByRole('button', { name: '来源设置', exact: true });
const row = (sid) => page.locator('.mapping-table tbody tr').filter({ hasText: `sid ${sid}` });
const remoteSave = () => editorDialog().getByRole('button', { name: '保存别名及状态', exact: true });
async function closeDialog(node, title) { await node.getByRole('button', { name: `关闭${title}`, exact: true }).click(); await expect(node).not.toBeVisible(); }
async function screenshot(name) { await page.screenshot({ path: resolve(evidence, name), fullPage: true }); }
async function checkLayout(node, name) {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const box = await node.boundingBox(); assert(box && box.x >= -1 && box.x + box.width <= width + 1, `Dialog width at ${width}px`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow at ${width}px`);
    await node.getByRole('button', { name: /^关闭/ }).first().focus();
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      const focus = await node.evaluate((element) => ({ contained: element.contains(document.activeElement), tag: document.activeElement?.tagName, focused: document.hasFocus() }));
      if (!focus.contained) {
        // Native modal dialogs allow the browser toolbar in the Tab cycle. This
        // is distinct from moving focus into the inert application background.
        assert.equal(focus.tag, 'BODY'); assert.equal(focus.focused, false);
        await page.keyboard.press('Tab'); assert(await node.evaluate((element) => element.contains(document.activeElement)), 'Tab returns from browser chrome to the modal');
      }
    }
    await screenshot(`${name}-${width}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = `http://127.0.0.1:${port}`;
  processHandle = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });

  step = 'directory-first-layout-and-separate-source-and-maintenance-dialogs';
  const remote = fixture(); let context = await setupContext(remote);
  await expect(page.locator('.seller-source-setting')).not.toBeVisible(); await expect(page.locator('.manual-seller-form')).not.toBeVisible();
  assert.deepEqual(await readOptions(page.locator('#seller-status')), ['', 'approved', 'disabled']);
  await expect(row(910001).getByText('已批准', { exact: true })).toBeVisible(); await expect(row(910001)).toContainText('领星状态 1'); await expect(row(910002).getByText('已停用', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增人工店铺', exact: true })).not.toBeVisible();
  await sourceButton().click(); await expect(sourceDialog()).toBeVisible(); await expect(sourceDialog()).toContainText('自动批准'); await expect(sourceDialog()).toContainText('只读'); await expect(sourceDialog().locator('.manual-seller-form')).toHaveCount(0);
  await checkLayout(sourceDialog(), 'source-dialog');
  if (await page.getByRole('tooltip').isVisible()) { await page.keyboard.press('Escape'); await expect(sourceDialog()).toBeVisible(); }
  await page.keyboard.press('Escape'); await expect(sourceDialog()).not.toBeVisible(); await expect(sourceButton()).toBeFocused();
  await screenshot('directory-1440.png'); note(step);

  step = 'remote-maintenance-is-identity-readonly-without-first-approval-or-candidate';
  await row(910001).getByRole('button', { name: '维护别名', exact: true }).click(); await expect(editorDialog()).toBeVisible();
  for (const selector of ['#mapping-sid', '#mapping-name', '#mapping-country', '#mapping-marketplace', '#mapping-wid']) assert(await editorDialog().locator(selector).evaluate((node) => node.readOnly || node.disabled));
  assert.deepEqual(await readOptions(editorDialog().locator('#mapping-status')), ['approved', 'disabled']);
  await expect(editorDialog().getByRole('checkbox', { name: '已核对店铺身份', exact: true })).toHaveCount(0); await expect(editorDialog().locator('#mapping-reason')).toBeEditable(); await expect(editorDialog().locator('#mapping-aliases')).toHaveValue('');
  assert.deepEqual(remote.historyReads, [], 'Version history remains collapsed and does not request data until expanded');
  await checkLayout(editorDialog(), 'remote-editor'); await editorDialog().locator('#mapping-aliases').fill('技术新别名'); await remoteSave().click(); assert.equal(remote.writes.aliases.length, 0); note(step);

  step = 'remote-alias-save-binds-versions-and-keeps-remote-identity';
  const originalIdentity = Object.fromEntries(['sid', 'name', 'country', 'marketplaceId', 'wid', 'lingxingName', 'lingxingStatus'].map((key) => [key, remote.remote[key]]));
  await editorDialog().locator('#mapping-reason').fill('技术验证：新增本地需求别名'); remote.hold = 'aliases'; await remoteSave().click(); await expect.poll(() => Boolean(remote.release)).toBe(true);
  await expect(editorDialog().getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(editorDialog()).not.toBeVisible(); await expect(row(910001).getByRole('button', { name: '维护别名', exact: true })).toBeDisabled(); remote.release();
  await expect(row(910001)).toContainText('技术新别名'); await expect(row(910001)).toContainText('版本 4'); await expect(editorDialog()).not.toBeVisible(); await row(910001).getByRole('button', { name: '维护别名', exact: true }).click(); assert.equal(remote.writes.aliases[0].expectedCatalogSettingsVersion, 5); assert.equal(remote.writes.aliases[0].expectedCatalogVersion, 9); assert.equal(remote.writes.aliases[0].expectedVersion, 3);
  assert.deepEqual(Object.fromEntries(Object.keys(originalIdentity).map((key) => [key, remote.remote[key]])), originalIdentity); await expect(editorDialog().locator('#mapping-aliases')).toHaveValue('技术新别名'); note(step);

  step = 'remote-history-and-explicit-reopen-use-the-current-catalog-identity';
  const history = editorDialog().locator('.mapping-history'); if (await history.locator(':scope > summary').count()) await history.locator(':scope > summary').click();
  await expect(editorDialog().locator('.mapping-revisions')).toContainText('技术验证：新增本地需求别名'); await editorDialog().locator('.mapping-revisions details summary').first().click(); await expect(editorDialog().locator('.mapping-diff')).toContainText('需求别名');
  assert.equal(remote.historyReads.length, 1);
  await screenshot('remote-history-1440.png');
  await editorDialog().locator('#mapping-aliases').fill('目录刷新前保留的旧草稿');
  const mappingVersion = remote.remote.version;
  remote.settings.catalogVersion += 1; remote.remote.lingxingName = '技术领星店铺更新名称';
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(row(910001)).toContainText('技术领星店铺更新名称');
  await expect(editorDialog().locator('#mapping-aliases')).toHaveValue('目录刷新前保留的旧草稿'); await expect(editorDialog().locator('#mapping-name')).toHaveValue('技术领星店铺'); await expect(remoteSave()).toBeDisabled();
  await expect(editorDialog().getByRole('alert').filter({ hasText: '店铺来源或目录版本已变化' })).toBeVisible();
  await closeDialog(editorDialog(), '维护店铺'); await row(910001).getByRole('button', { name: '维护别名', exact: true }).click();
  assert.equal(remote.remote.version, mappingVersion); await expect(editorDialog().locator('#mapping-name')).toHaveValue('技术领星店铺更新名称'); await expect(editorDialog().locator('#mapping-aliases')).toHaveValue('技术新别名');
  await closeDialog(editorDialog(), '维护店铺'); note(step);

  step = 'sync-unknown-response-keeps-the-original-payload-through-close-and-reopen';
  await sourceButton().click(); remote.dropOnce = 'sync'; remote.hold = 'sync'; remote.release = null; await sourceDialog().getByRole('button', { name: '同步领星实际店铺', exact: true }).click();
  await expect.poll(() => remote.hold === 'sync' && Boolean(remote.release)).toBe(true); await expect(sourceDialog().getByRole('button', { name: '正在同步实际店铺…', exact: true })).toBeDisabled(); await expect(sourceDialog().locator('input[value="manual"]')).toBeDisabled();
  const syncProgress = () => sourceDialog().getByRole('progressbar', { name: '领星店铺目录同步', exact: true });
  await expect(syncProgress()).toBeVisible();
  assert.equal(await syncProgress().getAttribute('aria-valuenow'), null, 'a pending single-request catalog fetch has no invented percentage');
  await screenshot('seller-sync-progress-pending.png');
  await closeDialog(sourceDialog(), '店铺来源设置'); await expect(sourceButton()).toBeDisabled(); remote.release(); await expect(sourceButton()).toBeEnabled(); await sourceButton().click();
  await expect(sourceDialog().getByRole('alert').filter({ hasText: '当前输入与操作编号已保留' })).toBeVisible();
  await expect(syncProgress()).toBeVisible();
  await expect(syncProgress().locator('..')).toHaveAttribute('data-status', 'failed');
  await expect(syncProgress()).toHaveAttribute('data-indeterminate', 'false');
  assert.equal(await syncProgress().getAttribute('aria-valuenow'), null, 'an unknown response does not claim a completed fetch');
  await closeDialog(sourceDialog(), '店铺来源设置'); await sourceButton().click(); await sourceDialog().getByRole('button', { name: '同步领星实际店铺', exact: true }).click();
  await expect(sourceDialog().getByRole('status').filter({ hasText: '已恢复原同步结果' })).toBeVisible(); await expect(syncProgress()).toHaveAttribute('aria-valuenow', '100'); await expect(syncProgress().locator('..')).toHaveAttribute('data-status', 'completed'); assert.deepEqual(remote.writes.sync[0], remote.writes.sync[1]); await expect(row(910002).getByText('已停用', { exact: true })).toBeVisible(); assert.deepEqual(remote.disabled.aliases, ['保留本地别名']); note(step);

  step = 'source-mode-unknown-response-replays-the-original-version-and-operation';
  await sourceDialog().locator('input[type="radio"][value="manual"]').check(); remote.dropOnce = 'mode'; await sourceDialog().getByRole('button', { name: '保存店铺来源', exact: true }).click();
  await expect(sourceDialog().getByRole('alert').filter({ hasText: '当前输入与操作编号已保留' })).toBeVisible(); await closeDialog(sourceDialog(), '店铺来源设置'); await sourceButton().click();
  await expect(sourceDialog().locator('input[type="radio"][value="manual"]')).toBeChecked(); await sourceDialog().getByRole('button', { name: '保存店铺来源', exact: true }).click();
  await expect(sourceDialog().getByRole('status').filter({ hasText: '已恢复原保存结果' })).toBeVisible(); assert.deepEqual(remote.writes.mode[0], remote.writes.mode[1]); await closeDialog(sourceDialog(), '店铺来源设置'); await expect(page.getByRole('button', { name: '新增人工店铺', exact: true })).toBeVisible(); note(step);
  assert.deepEqual(await readOptions(page.locator('#seller-status')), ['', 'candidate', 'approved', 'disabled']);

  step = 'manual-create-is-a-separate-dialog-and-preserves-draft-on-close';
  await page.getByRole('button', { name: '新增人工店铺', exact: true }).click(); await expect(manualDialog()).toBeVisible(); await expect(manualDialog().locator('.seller-source-setting')).toHaveCount(0);
  await manualDialog().getByLabel('店铺编号（sid）', { exact: true }).fill('0'); await manualDialog().getByLabel('显示名称', { exact: true }).fill('非法编号技术店铺'); await manualDialog().getByLabel('国家', { exact: true }).fill('美国'); await manualDialog().getByRole('button', { name: '新增人工店铺', exact: true }).click(); await expect(manualDialog().getByRole('alert').filter({ hasText: '有效的正整数店铺编号' })).toBeVisible(); assert.equal(remote.writes.manual.length, 0);
  await manualDialog().getByLabel('店铺编号（sid）', { exact: true }).fill('4200'); await manualDialog().getByLabel('显示名称', { exact: true }).fill('新建人工技术店铺'); await manualDialog().getByLabel('国家', { exact: true }).fill('加拿大');
  await checkLayout(manualDialog(), 'manual-create'); await closeDialog(manualDialog(), '新增人工店铺'); await page.getByRole('button', { name: '新增人工店铺', exact: true }).click(); await expect(manualDialog().getByLabel('显示名称', { exact: true })).toHaveValue('新建人工技术店铺'); note(step);

  step = 'manual-create-unknown-response-retries-identical-payload-without-duplicate';
  remote.dropOnce = 'manual'; await manualDialog().getByRole('button', { name: '新增人工店铺', exact: true }).click(); await expect(manualDialog().getByRole('alert').filter({ hasText: '当前输入与操作编号已保留' })).toBeVisible();
  await closeDialog(manualDialog(), '新增人工店铺'); await page.getByRole('button', { name: '新增人工店铺', exact: true }).click(); await manualDialog().getByRole('button', { name: '新增人工店铺', exact: true }).click(); await expect(row(4200)).toContainText('新建人工技术店铺');
  assert.deepEqual(remote.writes.manual[0], remote.writes.manual[1]); assert.equal(remote.manualItems.filter((item) => item.sid === 4200).length, 1); await expect(row(4200).getByText('待确认', { exact: true })).toBeVisible(); note(step);
  if (await manualDialog().isVisible()) await closeDialog(manualDialog(), '新增人工店铺');
  if (await editorDialog().isVisible()) await closeDialog(editorDialog(), '维护店铺');

  step = 'manual-first-approval-still-requires-explicit-identity-confirmation';
  await row(4111).getByRole('button', { name: '维护映射', exact: true }).click(); await expect(editorDialog().locator('#mapping-name')).toBeEditable(); assert.deepEqual(await readOptions(editorDialog().locator('#mapping-status')), ['candidate', 'approved', 'disabled']);
  await chooseOption(editorDialog().locator('#mapping-status'), 'approved'); const identity = editorDialog().getByRole('checkbox', { name: '已核对店铺身份', exact: true }); await expect(identity).not.toBeChecked(); await expect(editorDialog().locator('#mapping-reason')).toHaveCount(0);
  await editorDialog().getByRole('button', { name: '保存映射及版本', exact: true }).click(); await expect(editorDialog().getByRole('alert').filter({ hasText: '请先核对店铺身份' })).toBeVisible(); assert.equal(remote.writes.revise.length, 0);
  await identity.check(); await editorDialog().locator('#mapping-country').fill('英国'); await expect(identity).not.toBeChecked(); await identity.check(); await editorDialog().getByRole('button', { name: '保存映射及版本', exact: true }).click();
  await expect(row(4111).getByText('已批准', { exact: true })).toBeVisible(); assert.equal(remote.writes.revise[0].identityConfirmed, true); assert.equal(remote.writes.revise[0].reason, ''); await closeDialog(editorDialog(), '维护店铺'); note(step); await context.close();

  step = 'manual-create-can-finish-after-close-without-opening-a-late-editor';
  const background = fixture('manual'); background.hold = 'manual'; context = await setupContext(background);
  await page.getByRole('button', { name: '新增人工店铺', exact: true }).click();
  await manualDialog().getByLabel('店铺编号（sid）', { exact: true }).fill('4300'); await manualDialog().getByLabel('显示名称', { exact: true }).fill('后台新增技术店铺'); await manualDialog().getByLabel('国家', { exact: true }).fill('美国');
  await manualDialog().getByRole('button', { name: '新增人工店铺', exact: true }).click(); await expect.poll(() => Boolean(background.release)).toBe(true); await expect(manualDialog().getByRole('button', { name: '正在新增店铺…', exact: true })).toBeDisabled();
  await closeDialog(manualDialog(), '新增人工店铺'); await expect(sourceButton()).toBeDisabled(); await expect(page.getByRole('button', { name: '新增人工店铺', exact: true })).toBeDisabled();
  background.release(); await expect(row(4300)).toContainText('后台新增技术店铺'); await expect(editorDialog()).not.toBeVisible(); await expect(manualDialog()).not.toBeVisible(); await expect(sourceButton()).toBeEnabled(); assert.equal(background.writes.manual.length, 1); note(step); await context.close();

  step = 'source-mode-conflict-preserves-selection-and-explicit-refresh-rebinds-version';
  const conflict = fixture(); context = await setupContext(conflict); await sourceButton().click(); await sourceDialog().locator('input[type="radio"][value="manual"]').check(); conflict.conflictOnce = 'mode'; await sourceDialog().getByRole('button', { name: '保存店铺来源', exact: true }).click();
  await expect(sourceDialog().getByRole('alert').filter({ hasText: '请刷新来源设置和目录' })).toBeVisible(); await expect(sourceDialog().locator('input[type="radio"][value="manual"]')).toBeChecked();
  await sourceDialog().getByRole('alert').getByRole('button', { name: '刷新来源设置', exact: true }).click(); await expect(sourceDialog().locator('input[type="radio"][value="lingxing"]')).toBeChecked();
  await sourceDialog().locator('input[type="radio"][value="manual"]').check(); await sourceDialog().getByRole('button', { name: '保存店铺来源', exact: true }).click(); await expect(sourceDialog().getByRole('status').filter({ hasText: '来源设置已保存' })).toBeVisible(); assert.equal(conflict.writes.mode[1].expectedVersion, 6); assert.notEqual(conflict.writes.mode[0].operationId, conflict.writes.mode[1].operationId); note(step); await context.close();

  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedApi, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  releases.forEach((release) => release()); await browser?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill(); await Promise.race([new Promise((done) => processHandle.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), `${JSON.stringify({ kind: 'fixture-only-seller-dialogs-browser', passed: !failed, checks, browserErrors, unexpectedApi, externalRequests, externalLookupRequests: 0 }, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
