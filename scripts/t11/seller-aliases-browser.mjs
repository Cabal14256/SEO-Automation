import { chooseOption, readOptions } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

// Frontend-only regression: every API response is an in-memory fixture. This
// script never reads credentials, starts the API, or connects to a database.
// Import matching, normalized name/alias collisions, and persistence are covered
// by backend tests; a successful mock response here only verifies the editor.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.SELLER_ALIASES_EVIDENCE_DIR || resolve(root, '.local/t30/seller-aliases'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-18T04:00:00.000Z';
const user = { id: 'fixture-admin', name: '隔离测试管理员', email: 'fixture@example.invalid', role: 'admin' };
let settings = { mode: 'lingxing', version: 5, catalogVersion: 9, lastSyncedAt: now, lastError: null, configured: false, readOnly: true };
let mapping = {
  id: randomUUID(), sid: 910001, name: 'DEMO-SELLER-DE', country: '德国', marketplaceId: 'A1PA6795UKMFR9', wid: null,
  aliases: [], status: 'approved', version: 3, updatedAt: now, sourceObservedAt: now, sourceSha256: 'a'.repeat(64),
  dataSource: 'lingxing', manualEnabled: false, lingxingName: 'DEMO-SELLER-DE', lingxingStatus: '1', identityLocked: false,
  hasApprovedBefore: true, autoApproved: true,
};
let manualMapping = {
  ...mapping, id: randomUUID(), sid: 910010, name: 'DEMO-MANUAL-STORE', country: '美国', marketplaceId: null,
  aliases: ['人工别名'], status: 'candidate', version: 1, dataSource: 'manual', manualEnabled: true,
  lingxingName: null, lingxingStatus: null, identityLocked: false, hasApprovedBefore: false, autoApproved: false,
};
const aliasKeys = ['operationId', 'expectedVersion', 'expectedCatalogSettingsVersion', 'expectedCatalogVersion', 'aliases', 'status', 'reason'].sort();
const identityKeys = ['sid', 'name', 'country', 'marketplaceId', 'wid', 'dataSource', 'manualEnabled', 'lingxingName', 'lingxingStatus', 'sourceObservedAt', 'sourceSha256'];
const initialIdentity = Object.fromEntries(identityKeys.map((key) => [key, mapping[key]]));
const histories = new Map([[mapping.id, []], [manualMapping.id, []]]);
const checks = []; const browserErrors = []; const unexpectedApi = []; const unexpectedNetwork = [];
const aliasWrites = []; const manualWrites = []; const modeWrites = [];
const releases = new Map();
let rejectNextAlias = false;
let browser; let context; let processHandle; let failed = false; let baseURL;
const note = (name) => { checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`); };
const hold = (name) => new Promise((done) => releases.set(name, done));
const release = (name) => { const done = releases.get(name); assert(done, `Missing held request: ${name}`); releases.delete(name); done(); };

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* Vite is starting. */ }
    await delay(100);
  }
  throw new Error('Vite did not start');
}

function recordRevision(before, after, input) {
  histories.get(after.id).unshift({ operationId: input.operationId, version: after.version, actorUserId: user.id, reason: input.reason, createdAt: now, before, after: structuredClone(after) });
}

async function assertIdentityLocked(page) {
  for (const [selector, value] of [
    ['#mapping-sid', '910001'], ['#mapping-name', 'DEMO-SELLER-DE'], ['#mapping-country', '德国'],
    ['#mapping-marketplace', 'A1PA6795UKMFR9'], ['#mapping-wid', ''],
  ]) {
    const field = page.locator(selector);
    await expect(field).toHaveValue(value);
    assert.equal(await field.evaluate((node) => node.disabled || node.readOnly), true, `${selector} must be read-only for a Lingxing seller`);
  }
  await expect(page.locator('#mapping-aliases')).toBeEditable();
  await expect(page.locator('#mapping-status')).toBeEnabled();
  await expect(page.locator('#mapping-reason')).toBeEditable();
}

async function captureLayout(page, name) {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const editor = page.locator('.mapping-editor');
    await editor.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Page overflow at ${width}px`);
    const editorBox = await editor.boundingBox();
    assert(editorBox && editorBox.x >= 0 && editorBox.x + editorBox.width <= width + 1, `Editor outside viewport at ${width}px`);
    for (const selector of ['#mapping-aliases', '#mapping-status', ...(await page.locator('#mapping-reason').count() ? ['#mapping-reason'] : ['#mapping-identity-confirmed'])]) {
      const box = await page.locator(selector).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 1, `${selector} outside viewport at ${width}px`);
    }
    await page.screenshot({ path: resolve(evidence, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  processHandle = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await waitForServer(baseURL);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== baseURL) {
      unexpectedNetwork.push(request.url());
      return route.abort('blockedbyclient');
    }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/v1/session') return json({ user });
    if (path === '/api/v1/seller-mappings/catalog-settings') {
      if (request.method() === 'GET') return json({ settings });
      const input = request.postDataJSON(); modeWrites.push(input);
      settings = { ...settings, mode: input.mode, version: settings.version + 1 };
      return json({ settings, replayed: false });
    }
    if (path === '/api/v1/seller-mappings' && request.method() === 'GET') {
      return json({ items: [settings.mode === 'lingxing' ? mapping : manualMapping], total: 1, settings });
    }
    for (const target of [mapping, manualMapping]) {
      if (path === `/api/v1/seller-mappings/${target.id}/history`) return json({ items: histories.get(target.id) });
    }
    if (path === `/api/v1/seller-mappings/${mapping.id}/aliases` && request.method() === 'POST') {
      const input = request.postDataJSON(); aliasWrites.push(input); await hold('aliases');
      const firstApproval = mapping.status === 'candidate' && !mapping.hasApprovedBefore && input.status === 'approved';
      assert.deepEqual(Object.keys(input).sort(), [...aliasKeys, ...(firstApproval ? ['identityConfirmed'] : [])].sort(), 'Alias endpoint must only receive local approval and optimistic concurrency fields');
      if (firstApproval) {
        assert.equal(input.identityConfirmed, true, 'First approval must explicitly confirm the seller identity');
        assert.equal(input.reason, '', 'First approval uses the server-generated audit reason');
      } else assert(input.reason.trim(), 'A later revision requires a written reason');
      if (rejectNextAlias) {
        rejectNextAlias = false;
        mapping = { ...mapping, version: mapping.version + 1 };
        settings = { ...settings, version: settings.version + 1, catalogVersion: settings.catalogVersion + 1 };
        return json({ error: { code: 'VERSION_CONFLICT' } }, 409);
      }
      const before = structuredClone(mapping);
      mapping = { ...mapping, aliases: input.aliases, status: input.status, version: mapping.version + 1, hasApprovedBefore: mapping.hasApprovedBefore || input.status === 'approved' };
      settings = { ...settings, catalogVersion: settings.catalogVersion + 1 };
      recordRevision(before, mapping, { ...input, reason: firstApproval ? `首次批准：已核对店铺身份（${mapping.name}，sid ${mapping.sid}，${mapping.country}）。` : input.reason });
      return json({ mapping, replayed: false });
    }
    if (path === `/api/v1/seller-mappings/${manualMapping.id}/revise` && request.method() === 'POST') {
      const input = request.postDataJSON(); manualWrites.push(input);
      const before = structuredClone(manualMapping);
      const firstApproval = manualMapping.status === 'candidate' && !manualMapping.hasApprovedBefore && input.status === 'approved';
      if (firstApproval) { assert.equal(input.identityConfirmed, true); assert.equal(input.reason, ''); }
      else assert(input.reason.trim());
      manualMapping = { ...manualMapping, sid: input.sid, name: input.name, country: input.country, marketplaceId: input.marketplaceId, wid: input.wid, aliases: input.aliases, status: input.status, version: manualMapping.version + 1, hasApprovedBefore: manualMapping.hasApprovedBefore || input.status === 'approved' };
      recordRevision(before, manualMapping, { ...input, reason: firstApproval ? `首次批准：已核对店铺身份（${manualMapping.name}，sid ${manualMapping.sid}，${manualMapping.country}）。` : input.reason });
      return json({ mapping: manualMapping });
    }
    unexpectedApi.push(`${request.method()} ${path}`);
    return json({ error: { code: 'NOT_FOUND', message: `Unhandled isolated fixture: ${path}` } }, 404);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/settings/seller-mappings');
  await page.getByRole('heading', { name: '店铺目录', exact: true }).waitFor();
  const lingxingRow = page.getByRole('row').filter({ hasText: 'DEMO-SELLER-DE' });
  await expect(lingxingRow.getByText('已批准', { exact: true })).toBeVisible();
  await expect(lingxingRow.getByText('使用店铺名称', { exact: true })).toBeVisible();
  await lingxingRow.getByRole('button', { name: '维护别名', exact: true }).click();
  await expect(page.locator('.mapping-editor')).toBeVisible();
  await assertIdentityLocked(page);
  await expect(page.getByLabel('需求别名（可选，每行一个）', { exact: true })).toBeEditable();
  await expect(page.locator('#mapping-aliases-help')).toHaveText('导入表与店铺名称一致时无需填写；名称不同时再补充，每行一个。');
  assert.equal(mapping.manualEnabled, false);
  assert.deepEqual(modeWrites, []);
  note('A pure Lingxing seller opens its local alias editor directly without enabling manual maintenance or switching catalog mode');

  await chooseOption(page.locator('#mapping-status'), 'approved');
  const save = page.getByRole('button', { name: '保存别名及状态', exact: true });
  const identityConfirmation = page.getByRole('checkbox', { name: '已核对店铺身份', exact: true });
  await expect(identityConfirmation).toHaveCount(0);
  await expect(page.locator('#mapping-reason')).toBeEditable();
  await expect(page.locator('#mapping-aliases')).toHaveValue('');
  assert.deepEqual(await readOptions(page.locator('#mapping-status')), ['approved', 'disabled']);
  await save.click();
  assert.deepEqual(aliasWrites, []);
  note('Automatically approved Lingxing identities offer only approved/disabled, no first-approval checkbox, and retain optional aliases plus required revision reasons');
  await captureLayout(page, 'lingxing-editor');
  note('Lingxing editor remains within the desktop and 390px/320px viewport bounds');
  await page.locator('#mapping-reason').fill('技术回归：核对自动批准目录，保留空别名');
  await save.click();
  await expect.poll(() => aliasWrites.length).toBe(1);
  await expect(page.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '维护店铺', exact: true })).not.toBeVisible();
  await expect(lingxingRow.getByRole('button', { name: '维护别名', exact: true })).toBeDisabled();
  assert.equal(aliasWrites[0].expectedVersion, 3);
  assert.equal(aliasWrites[0].expectedCatalogSettingsVersion, 5);
  assert.equal(aliasWrites[0].expectedCatalogVersion, 9);
  assert.deepEqual(aliasWrites[0].aliases, []);
  assert.equal(aliasWrites[0].status, 'approved');
  assert.equal(aliasWrites[0].reason, '技术回归：核对自动批准目录，保留空别名'); assert.equal(aliasWrites[0].identityConfirmed, undefined);
  assert.match(aliasWrites[0].operationId, /^[0-9a-f-]{36}$/);
  release('aliases');
  await expect(page.getByRole('status').filter({ hasText: '已保存为版本 4' })).toBeVisible();
  await expect(lingxingRow.getByText('已批准', { exact: true })).toBeVisible();
  await expect(lingxingRow.getByText('使用店铺名称', { exact: true })).toBeVisible();
  await expect(lingxingRow).toContainText('版本 4');
  await expect(page.getByRole('dialog', { name: '维护店铺', exact: true })).not.toBeVisible();
  await lingxingRow.getByRole('button', { name: '维护别名', exact: true }).click();
  const history = page.getByRole('dialog', { name: '维护店铺', exact: true }).locator('.mapping-history');
  if (await history.locator(':scope > summary').count()) await history.locator(':scope > summary').click();
  await expect(page.locator('.mapping-revisions')).toContainText('版本 4');
  await expect(page.locator('.mapping-revisions')).toContainText('技术回归：核对自动批准目录，保留空别名');
  await page.locator('.mapping-revisions summary').first().click();
  await expect(page.locator('.mapping-revisions')).toContainText('本次未改变映射字段');
  await expect(page.locator('#mapping-aliases')).toHaveValue('');
  assert.deepEqual(mapping.aliases, [], 'Approval must not invent or auto-fill an alias');
  assert.deepEqual(Object.fromEntries(identityKeys.map((key) => [key, mapping[key]])), initialIdentity);
  assert.deepEqual(modeWrites, []); assert.deepEqual(manualWrites, []);
  await assertIdentityLocked(page);
  await captureLayout(page, 'lingxing-approved');
  assert.equal(mapping.hasApprovedBefore, true);
  note('Remote maintenance with aliases [] binds all versions, retains identity and name matching, records the reason and history, and never invents an alias');

  await page.locator('#mapping-aliases').fill('DEMO-SELLER-DE\n后续重新核对的别名');
  await save.click();
  assert.equal(aliasWrites.length, 1);
  await expect(page.locator('#mapping-reason')).toHaveValue('');
  await expect(identityConfirmation).toHaveCount(0);
  await chooseOption(page.locator('#mapping-status'), 'disabled');
  await save.click();
  assert.equal(aliasWrites.length, 1);
  await expect(page.locator('#mapping-reason')).toHaveValue('');
  note('Later alias changes and disabling a mapping still require a written reason');

  await chooseOption(page.locator('#mapping-status'), 'disabled');
  await page.locator('#mapping-reason').fill('停用以重新核对已批准的映射');
  await save.click();
  await expect.poll(() => aliasWrites.length).toBe(2);
  assert.equal(aliasWrites[1].expectedVersion, 4);
  assert.equal(aliasWrites[1].status, 'disabled');
  assert.deepEqual(aliasWrites[1].aliases, ['DEMO-SELLER-DE', '后续重新核对的别名']);
  release('aliases');
  await expect(page.getByRole('dialog', { name: '维护店铺', exact: true }).getByRole('status').filter({ hasText: '已保存为版本 5' })).toBeVisible();
  await expect(lingxingRow).toContainText('后续重新核对的别名');
  await expect(page.locator('#mapping-aliases')).toHaveValue('DEMO-SELLER-DE\n后续重新核对的别名');
  note('Optional aliases can be added later and appear in the saved directory and editor');
  await chooseOption(page.locator('#mapping-status'), 'approved');
  await expect(identityConfirmation).toHaveCount(0);
  await expect(page.locator('#mapping-reason')).toBeEditable();
  await save.click();
  assert.equal(aliasWrites.length, 2);
  assert.equal(mapping.hasApprovedBefore, true);
  note('A previously approved remote mapping keeps its approval history while disabled and requires a reason to enable it again');

  rejectNextAlias = true;
  await page.locator('#mapping-aliases').fill('DEMO-SELLER-DE\n冲突时保留的别名');
  await page.locator('#mapping-reason').fill('冲突时保留的核对原因');
  await save.click();
  await expect.poll(() => aliasWrites.length).toBe(3);
  assert.equal(aliasWrites[2].expectedVersion, 5);
  release('aliases');
  await expect(page.getByRole('alert').filter({ hasText: '当前草稿仍保留在此表单中' })).toContainText('刷新目录');
  await expect(page.locator('#mapping-aliases')).toHaveValue('DEMO-SELLER-DE\n冲突时保留的别名');
  await expect(page.locator('#mapping-reason')).toHaveValue('冲突时保留的核对原因');
  await expect(save).toBeEnabled();
  await captureLayout(page, 'lingxing-conflict');
  note('A 409 preserves the alias and reason drafts and gives explicit close/refresh/reopen recovery guidance');

  await page.getByRole('button', { name: '关闭维护店铺', exact: true }).click();
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(lingxingRow).toContainText('版本 6');
  await lingxingRow.getByRole('button', { name: '维护别名', exact: true }).click();
  await page.locator('#mapping-aliases').fill('DEMO-SELLER-DE\n刷新后重新核对的别名');
  await chooseOption(page.locator('#mapping-status'), 'approved');
  await expect(identityConfirmation).toHaveCount(0);
  await page.locator('#mapping-reason').fill('已按最新目录版本重新核对');
  await save.click();
  await expect.poll(() => aliasWrites.length).toBe(4);
  assert.equal(aliasWrites[3].expectedVersion, 6);
  assert.equal(aliasWrites[3].expectedCatalogSettingsVersion, 6);
  assert.equal(aliasWrites[3].expectedCatalogVersion, 12);
  release('aliases');
  await expect(page.getByRole('dialog', { name: '维护店铺', exact: true }).getByRole('status').filter({ hasText: '已保存为版本 7' })).toBeVisible();
  assert.deepEqual(Object.fromEntries(identityKeys.map((key) => [key, mapping[key]])), initialIdentity);
  note('Reopening after a refresh binds a new save to the latest mapping, settings, and catalog versions');

  await page.getByRole('button', { name: '关闭维护店铺', exact: true }).click();
  await page.getByRole('button', { name: '来源设置', exact: true }).click();
  const sourceDialog = page.getByRole('dialog', { name: '店铺来源设置', exact: true });
  await sourceDialog.locator('input[type="radio"][value="manual"]').check();
  await sourceDialog.getByRole('button', { name: '保存店铺来源', exact: true }).click();
  await expect(sourceDialog.getByRole('status').filter({ hasText: '来源设置已保存' })).toBeVisible();
  await sourceDialog.getByRole('button', { name: '关闭店铺来源设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '新增人工店铺', exact: true })).toBeVisible();
  const manualRow = page.getByRole('row').filter({ hasText: 'DEMO-MANUAL-STORE' });
  await manualRow.getByRole('button', { name: '维护映射', exact: true }).click();
  await expect(page.locator('#mapping-name')).toBeEditable();
  await expect(page.locator('#mapping-country')).toBeEditable();
  await chooseOption(page.locator('#mapping-status'), 'approved');
  await expect(identityConfirmation).not.toBeChecked();
  await expect(page.locator('#mapping-reason')).toHaveCount(0);
  await page.getByRole('button', { name: '保存映射及版本', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '请先核对店铺身份' })).toBeVisible();
  assert.equal(manualWrites.length, 0);
  await identityConfirmation.check();
  await page.locator('#mapping-aliases').fill('人工可选别名');
  await expect(identityConfirmation).not.toBeChecked();
  await identityConfirmation.check();
  await chooseOption(page.locator('#mapping-status'), 'candidate');
  await expect(identityConfirmation).toHaveCount(0);
  await chooseOption(page.locator('#mapping-status'), 'approved');
  await expect(identityConfirmation).not.toBeChecked();
  note('Manual first approval still hides the reason, requires identity confirmation, and resets confirmation when aliases or status change');
  for (const [selector, value] of [
    ['#mapping-sid', '910011'], ['#mapping-name', 'DEMO-MANUAL-STORE-UPDATED'], ['#mapping-country', '加拿大'],
    ['#mapping-marketplace', 'fixture-marketplace'], ['#mapping-wid', '421'],
  ]) {
    await identityConfirmation.check();
    await page.locator(selector).fill(value);
    await expect(identityConfirmation).not.toBeChecked();
  }
  note('Changing any editable manual seller identity field resets a previously checked first-approval confirmation');
  await identityConfirmation.check();
  await page.getByRole('button', { name: '保存映射及版本', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '维护店铺', exact: true }).getByRole('status').filter({ hasText: 'DEMO-MANUAL-STORE-UPDATED已保存为版本 2' })).toBeVisible();
  assert.equal(manualWrites.length, 1); assert.equal(manualWrites[0].name, 'DEMO-MANUAL-STORE-UPDATED');
  assert.equal(manualWrites[0].identityConfirmed, true); assert.equal(manualWrites[0].reason, '');
  assert.equal(manualWrites[0].expectedVersion, 1); assert.equal(aliasWrites.length, 4);
  assert.equal(modeWrites.length, 1); assert.equal(modeWrites[0].mode, 'manual');
  const manualHistory = page.getByRole('dialog', { name: '维护店铺', exact: true }).locator('.mapping-history');
  if (await manualHistory.locator(':scope > summary').count()) await manualHistory.locator(':scope > summary').click();
  await expect(page.locator('.mapping-revisions')).toContainText('首次批准：已核对店铺身份');
  await expect(page.locator('.mapping-revisions')).toContainText('sid 910011');
  await expect(page.locator('.mapping-revisions')).toContainText('DEMO-MANUAL-STORE-UPDATED');
  note('The manual editor retains identity maintenance and reason-free first approval through /revise, with the generated identity audit in its history');
  await chooseOption(page.locator('#mapping-status'), 'candidate');
  await page.getByRole('button', { name: '保存映射及版本', exact: true }).click(); assert.equal(manualWrites.length, 1);
  await page.locator('#mapping-reason').fill('人工维护原有候选状态回归');
  await page.getByRole('button', { name: '保存映射及版本', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '维护店铺', exact: true }).getByRole('status').filter({ hasText: 'DEMO-MANUAL-STORE-UPDATED已保存为版本 3' })).toBeVisible();
  assert.equal(manualWrites[1].expectedVersion, 2); await chooseOption(page.locator('#mapping-status'), 'approved'); await expect(identityConfirmation).toHaveCount(0);
  await page.getByRole('button', { name: '保存映射及版本', exact: true }).click(); assert.equal(manualWrites.length, 2);
  note('Previously approved manual sellers retain candidate rollback and cannot regain the first-approval exemption after a later revision');

  assert.deepEqual(unexpectedApi, []); assert.deepEqual(unexpectedNetwork, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; console.error(error.stack || error);
  if (context?.pages()[0]) await context.pages()[0].screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  releases.forEach((done) => done()); releases.clear();
  await browser?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill(); await Promise.race([new Promise((done) => processHandle.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-seller-aliases-browser', passed: !failed, checks, browserErrors, unexpectedApi, unexpectedNetwork, aliasWrites, manualWrites, modeWrites }, null, 2));
}
if (failed) process.exitCode = 1;
