import { chooseOption, readOptions } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// The root agent coordinates the one real read-only external sync separately.
// This suite never clicks synchronization and blocks that browser endpoint.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(serverRoot, 'package.json'));
Object.assign(process.env, requireServer('dotenv').parse(await readFile(resolve(serverRoot, '.env'))));
const { createConfirmationHarness, technicalWorkbook } = await import(pathToFileURL(resolve(serverRoot, 'dist/import-confirmation-acceptance.js')));
const { catalogList, createTechnicalCatalogSeller, technicalSid } = await import(pathToFileURL(resolve(serverRoot, 'dist/seller-catalog-acceptance.js')));
const { pool, closeDatabase } = await import(pathToFileURL(resolve(serverRoot, 'dist/db/client.js')));
const historyOnly = process.argv.includes('--history-only');
const evidenceDir = resolve(process.env.SELLER_CATALOG_EVIDENCE_DIR || resolve(root, historyOnly ? '.local/t11/seller-catalog-history' : '.local/t11/seller-catalog-browser'));
await mkdir(evidenceDir, { recursive: true });
const h = await createConfirmationHarness({ catalogMode: null });
const checks = []; const errors = [];
let browser; let page; let failed = false; let cleaned = false; let step = 'setup'; let blockedSyncRequests = 0;
const record = (name, details = {}) => { checks.push({ name, result: 'passed', ...details }); console.log(`PASS ${name}`); };
const sourceDialog = () => page.getByRole('dialog', { name: '店铺来源设置', exact: true });
const editDialog = () => page.getByRole('dialog', { name: '维护店铺', exact: true });
async function openSource() {
  if (await editDialog().isVisible()) await editDialog().getByRole('button', { name: '关闭维护店铺', exact: true }).click();
  await page.getByRole('button', { name: '来源设置', exact: true }).click();
  await sourceDialog().getByRole('heading', { name: '选择店铺数据来源', exact: true }).waitFor();
}
async function closeSource() { await sourceDialog().getByRole('button', { name: '关闭店铺来源设置', exact: true }).click(); await sourceDialog().waitFor({ state: 'hidden' }); }
async function openHistory() {
  const history = editDialog().locator('.mapping-history');
  if (!await history.evaluate((node) => node.open)) await history.locator(':scope > summary').click();
  await editDialog().locator('.mapping-history[open]').waitFor();
}
async function switchMode(mode) {
  await openSource();
  await sourceDialog().locator(`input[type="radio"][value="${mode}"]`).check();
  const pending = page.waitForResponse((response) => response.url().endsWith('/seller-mappings/catalog-settings') && response.request().method() === 'POST');
  await sourceDialog().getByRole('button', { name: '保存店铺来源', exact: true }).click(); const response = await pending; assert.equal(response.status(), 200);
  assert.equal((await response.json()).settings.mode, mode);
  await sourceDialog().locator('.seller-source-actions').getByText(`当前生效：${mode === 'manual' ? '人工维护' : '领星实际店铺'}`, { exact: false }).waitFor();
  await closeSource();
}
async function preview(id, sourceShop, mapping) {
  const select = page.getByLabel(`“${sourceShop}”对应店铺`, { exact: true }); await chooseOption(select, mapping.id);
  const text = await select.innerText(); assert(text.includes(mapping.name)); assert(text.includes(String(mapping.sid))); assert(text.includes(mapping.country));
  await page.getByRole('checkbox', { name: `确认“${sourceShop}”对应`, exact: false }).check();
  const pending = page.waitForResponse((response) => response.url().endsWith(`/imports/${id}/preview`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '生成差异预览', exact: true }).click(); const response = await pending; assert.equal(response.status(), 201);
  const input = response.request().postDataJSON(); const current = await h.catalog();
  assert.equal(input.expectedCatalogSettingsVersion, current.version); assert.equal(input.expectedCatalogVersion, current.catalogVersion);
  const result = await response.json(); assert.equal(result.preview.counts.new, 1);
  await page.getByRole('region', { name: '需求增量差异表，可横向滚动', exact: true }).waitFor(); return result;
}
async function refreshImportContext() {
  const pending = page.waitForResponse((response) => response.url().endsWith('/confirmation'));
  await page.getByRole('button', { name: '刷新本次店铺', exact: true }).click(); await pending;
}
try {
  await h.setup(); assert.equal((await h.catalog()).mode, 'lingxing');
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL: h.baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', (error) => errors.push(error.name));
  await page.route('**/api/v1/seller-mappings/sync', async (route) => { blockedSyncRequests++; await route.abort('blockedbyclient'); });
  const admin = h.users.get('admin');
  step = 'default-lingxing-readonly-catalog-display';
  await page.goto('/login'); await page.getByLabel('邮箱', { exact: true }).fill(admin.email); await page.getByLabel('密码', { exact: true }).fill(admin.password); await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByRole('heading', { name: '发货任务工作台', exact: true }).waitFor();
  await page.goto('/settings/seller-mappings'); await page.getByRole('heading', { name: '店铺目录', exact: true }).waitFor();
  await openSource();
  assert.equal(await sourceDialog().locator('input[type="radio"][value="lingxing"]').isChecked(), true);
  await sourceDialog().getByRole('button', { name: '同步领星实际店铺', exact: true }).waitFor();
  await closeSource();
  const real = await catalogList(h); assert(real.items.length > 0);
  await page.getByRole('region', { name: '店铺映射表，可横向滚动', exact: true }).getByText(real.items[0].name, { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '维护映射', exact: true }).count(), 0);
  // Semantic update: authorized remote profiles are automatically approved;
  // maintaining local aliases no longer exposes a manual approval checkbox.
  const approved = real.items.filter((mapping) => mapping.status === 'approved');
  assert(approved.length > 0, 'The trusted cached directory must expose an approved authorized seller');
  for (const mapping of approved) { assert.equal(mapping.autoApproved, true); assert.equal(mapping.lingxingStatus, '1'); }
  const firstRemote = real.items[0];
  const remoteRow = page.locator('.mapping-table tbody tr').filter({ hasText: `sid ${firstRemote.sid} ·` });
  if (firstRemote.autoApproved) await remoteRow.getByText('领星自动批准', { exact: true }).waitFor();
  await remoteRow.getByRole('button', { name: '维护别名', exact: true }).click();
  await editDialog().getByRole('heading', { name: `维护别名：${firstRemote.name}`, exact: true }).waitFor();
  for (const label of ['店铺编号（sid）', '店铺名称', '国家']) assert.equal(await editDialog().getByLabel(label, { exact: true }).evaluate((node) => node.readOnly), true);
  assert.deepEqual(await readOptions(editDialog().getByLabel('本地使用状态', { exact: true })), ['approved', 'disabled']);
  assert.equal(await editDialog().getByRole('checkbox', { name: '已核对店铺身份', exact: true }).count(), 0);
  await editDialog().getByLabel('修改原因', { exact: true }).waitFor();
  await editDialog().getByRole('button', { name: '保存别名及状态', exact: true }).waitFor();
  await editDialog().getByRole('button', { name: '关闭维护店铺', exact: true }).click();
  record('default-lingxing-autoapproved-catalog-with-readonly-identity-and-local-alias-dialog', { effectiveSellers: real.total, autoApprovedSellers: approved.length, externalSyncRequests: 0 });
  step = 'manual-source-selection-and-create-seller';
  await switchMode('manual');
  await page.getByRole('button', { name: '新增人工店铺', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: '新增人工店铺', exact: true });
  await createDialog.getByRole('heading', { name: '填写店铺身份', exact: true }).waitFor();
  const form = createDialog.locator('.manual-seller-form'); await form.waitFor();
  const sid = technicalSid(); const name = `T11-${h.runId}-ui-display`;
  await form.getByLabel('店铺编号（sid）', { exact: true }).fill(String(sid)); await form.getByLabel('显示名称', { exact: true }).fill(name); await form.getByLabel('国家', { exact: true }).fill('美国');
  const createPending = page.waitForResponse((response) => response.url().endsWith('/seller-mappings/manual') && response.request().method() === 'POST');
  await form.getByRole('button', { name: '新增人工店铺', exact: true }).click(); const created = await createPending; assert([200, 201].includes(created.status()));
  let mapping = (await created.json()).mapping; h.trackSeller(mapping.id);
  const editor = editDialog().locator('.mapping-editor'); await editor.waitFor(); assert.equal(await editor.getByLabel('店铺编号（sid）', { exact: true }).isDisabled(), false);
  assert.deepEqual((await pool.query('select before from seller_mapping_revision where seller_mapping_id=$1 and version=1', [mapping.id])).rows[0].before, {}, 'A creation has no fabricated previous seller snapshot');
  await openHistory();
  await editor.locator('.mapping-revisions > li').filter({ hasText: '新增人工店铺' }).waitFor();
  assert.equal(await editor.locator('.mapping-history').getByRole('alert').count(), 0);
  const newSid = technicalSid(); const editedName = `${name}-edited`;
  await editor.getByLabel('店铺编号（sid）', { exact: true }).fill(String(newSid)); await editor.getByLabel('店铺名称', { exact: true }).fill(editedName); await editor.getByLabel('修改 / 批准原因', { exact: true }).fill('TECHNICAL BROWSER CATALOG ACCEPTANCE');
  const revisePending = page.waitForResponse((response) => response.url().endsWith(`/seller-mappings/${mapping.id}/revise`) && response.request().method() === 'POST');
  await editor.getByRole('button', { name: '保存映射及版本', exact: true }).click(); const revised = await revisePending; assert.equal(revised.status(), 200); mapping = (await revised.json()).mapping;
  assert.equal(mapping.sid, newSid); assert.equal(mapping.name, editedName);
  await editor.getByText(new RegExp(`当前版本 ${mapping.version} ·`)).waitFor();
  await openHistory();
  const updatedRevision = editor.locator('.mapping-revisions > li').filter({ hasText: 'TECHNICAL BROWSER CATALOG ACCEPTANCE' }); await updatedRevision.waitFor();
  await editor.locator('.mapping-revisions > li').filter({ hasText: '新增人工店铺' }).waitFor();
  assert.equal(await editor.locator('.mapping-revisions > li').count(), 2);
  await updatedRevision.locator('summary').click(); const changes = await updatedRevision.innerText(); assert(changes.includes(String(sid))); assert(changes.includes(String(newSid))); assert(changes.includes(editedName));
  assert.equal(await editor.locator('.mapping-history').getByRole('alert').count(), 0);
  record('manual-ui-source-create-display-name-and-unused-sid-edit');
  if (historyOnly) {
    await editor.locator('.mapping-history').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(evidenceDir, 'manual-create-revise-history.png') });
    record('manual-create-and-revise-history-readable-with-original-empty-before');
  } else {
  step = 'import-numeric-source-code-displays-selected-friendly-name-sid-and-country';
  const sourceShop = '162';
  const item = await h.upload(technicalWorkbook([{ shop: sourceShop, fba: `FBACATALOGUI${h.runId.replaceAll('-', '').toUpperCase()}`, country: '美国' }]), 'technical-catalog-browser.xlsx');
  await page.goto(`/imports/${item.id}`); await preview(item.id, sourceShop, mapping);
  await page.getByRole('button', { name: '选择全部可提交项', exact: true }).click(); await page.getByRole('status').filter({ hasText: /^已选 1 票$/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认提交所选需求', exact: true }).isDisabled(), false);
  record('numeric-source-code-explicitly-confirms-readable-name-sid-country-and-catalog-versions');
  step = 'source-mode-change-invalidates-existing-preview-and-checkboxes';
  await h.switchCatalog('lingxing'); await refreshImportContext();
  await page.getByRole('status').filter({ hasText: '店铺来源设置或目录版本已变化' }).waitFor();
  await page.getByRole('status').filter({ hasText: /^已选 0 票$/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认提交所选需求', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: `确认“${sourceShop}”对应`, exact: false }).isChecked(), false);
  await h.switchCatalog('manual'); await refreshImportContext();
  assert.equal(await page.getByRole('checkbox', { name: `确认“${sourceShop}”对应`, exact: false }).isChecked(), false);
  await preview(item.id, sourceShop, mapping);
  record('source-switch-clears-confirmation-and-prevents-submitting-old-preview');
  step = 'catalog-change-requires-explicit-reconfirmation';
  await createTechnicalCatalogSeller(h, 'browser-directory-change'); await refreshImportContext();
  assert.equal(await page.getByRole('checkbox', { name: `确认“${sourceShop}”对应`, exact: false }).isChecked(), false);
  assert.equal(await page.getByRole('button', { name: '确认提交所选需求', exact: true }).isDisabled(), true);
  const noConfirmPending = page.waitForResponse((response) => response.url().endsWith(`/imports/${item.id}/preview`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '生成差异预览', exact: true }).click(); const noConfirmResponse = await noConfirmPending; assert.equal(noConfirmResponse.status(), 201);
  assert.deepEqual(noConfirmResponse.request().postDataJSON().sellerSelections, []); assert.equal((await noConfirmResponse.json()).preview.counts.error, 1);
  await preview(item.id, sourceShop, mapping); await page.getByRole('button', { name: '选择全部可提交项', exact: true }).click();
  const commitPending = page.waitForResponse((response) => response.url().endsWith(`/imports/${item.id}/commit`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认提交所选需求', exact: true }).click(); const committed = await commitPending; assert.equal(committed.status(), 200); assert.equal((await committed.json()).counts.created, 1);
  await page.getByRole('status').filter({ hasText: '需求已提交。新增 1 票' }).waitFor();
  record('directory-refresh-clears-checkbox-unconfirmed-preview-blocks-until-new-confirmation');
  step = 'used-sid-is-locked-and-manual-content-survives-ui-mode-roundtrip';
  await page.goto('/settings/seller-mappings');
  await page.getByLabel('店铺名称、别名或 sid', { exact: true }).fill(String(newSid)); await page.getByRole('button', { name: '搜索', exact: true }).click();
  const ownRow = page.locator('.mapping-table tbody tr').filter({ hasText: editedName }); await ownRow.getByRole('button', { name: '维护映射', exact: true }).click();
  assert.equal(await editDialog().getByLabel('店铺编号（sid）', { exact: true }).isDisabled(), true);
  assert.equal(await editDialog().getByLabel('店铺名称', { exact: true }).inputValue(), editedName);
  await switchMode('lingxing'); assert.equal(await page.getByRole('dialog', { name: '新增人工店铺', exact: true }).isVisible(), false); assert.equal(await editDialog().isVisible(), false);
  await switchMode('manual'); await ownRow.getByRole('button', { name: '维护映射', exact: true }).click();
  assert.equal(await editDialog().getByLabel('店铺名称', { exact: true }).inputValue(), editedName);
  assert.equal((await pool.query('select sid,name,country from seller_mapping where id=$1', [mapping.id])).rows[0].sid, newSid);
  record('used-manual-sid-ui-lock-and-source-roundtrip-preserves-manual-display-name');
  step = 'catalog-source-ui-responsive-layout';
  await openSource();
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await sourceDialog().getByRole('heading', { name: '选择店铺数据来源', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: resolve(evidenceDir, `seller-source-${width}.png`) });
    record(`seller-source-${width}px-without-document-overflow`);
  }
  await closeSource();
  }
  await h.unchangedOriginalAndMappings(); assert.equal(errors.length, 0); assert.equal(blockedSyncRequests, 0);
  record('real-candidate-both-source-snapshots-preserved-no-page-errors-no-external-sync');
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error instanceof Error ? error.message : 'CHECK_FAILED' });
  console.error(`Seller catalog browser failed: ${step}`, error instanceof Error ? error.message : 'CHECK_FAILED');
  await page?.screenshot({ path: resolve(evidenceDir, 'failed.png') }).catch(() => undefined);
} finally {
  await browser?.close();
  try { await h.cleanup(); cleaned = true; } catch (error) { failed = true; checks.push({ name: 'fixture-cleanup-and-original-source-restore', result: 'failed', message: error instanceof Error ? error.message : 'CLEANUP_FAILED' }); }
  await writeFile(resolve(evidenceDir, 'browser.json'), `${JSON.stringify({ kind: historyOnly ? 'real-postgresql-seller-catalog-history-browser' : 'real-postgresql-seller-catalog-browser', runId: h.runId, baseURL: h.baseURL, browserVersion: browser?.version(), timezone: 'Asia/Shanghai', completedAt: new Date().toISOString(), result: failed ? 'failed' : 'passed', checks, technicalFixturesRemoved: cleaned,
    externalSyncRequestsMadeByThisSuite: 0, blockedSyncRequests, realEvidence: 'Display of root-coordinated previously synchronized real catalog', technicalEvidence: 'Temporary manual sellers, readable display for numeric source code, source switching and catalog confirmation invalidation' }, null, 2)}\n`);
  await closeDatabase(); console.log(`Seller catalog browser ${failed ? 'FAILED' : 'PASSED'} (${checks.filter((entry) => entry.result === 'passed').length} checks)`); if (failed) process.exitCode = 1;
}
