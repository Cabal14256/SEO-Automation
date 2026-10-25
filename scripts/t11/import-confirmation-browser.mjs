import { chooseOption } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// Run only after a coordinated build, migration and API/Worker start. This suite
// never starts or stops shared services; all writes belong to temporary actors.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(serverRoot, 'package.json'));
Object.assign(process.env, requireServer('dotenv').parse(await readFile(resolve(serverRoot, '.env'))));
const { createConfirmationHarness, technicalWorkbook, digest } = await import(pathToFileURL(resolve(serverRoot, 'dist/import-confirmation-acceptance.js')));
const { pool, closeDatabase } = await import(pathToFileURL(resolve(serverRoot, 'dist/db/client.js')));
const evidenceDir = resolve(process.env.IMPORT_CONFIRMATION_EVIDENCE_DIR || resolve(root, '.local/t11/browser'));
await mkdir(evidenceDir, { recursive: true });
const h = await createConfirmationHarness();
const fixture = h.fixture; assert(fixture, "Set IMPORT_ACCEPTANCE_CONFIG for original-workbook browser acceptance");
const expected = fixture.counts;
const checks = []; const errors = [];
let browser; let page; let context; let failed = false; let cleaned = false; let step = 'setup';
const record = (name, details = {}) => { checks.push({ name, result: 'passed', ...details }); console.log(`PASS ${name}`); };
const legacyDetail = () => page.locator('.import-detail');
async function openFileInput() {
  const dialog = page.getByRole('dialog', { name: '导入向导', exact: true });
  if (!await dialog.isVisible()) {
    const fresh = page.getByRole('button', { name: '新建导入', exact: true });
    if (await fresh.isVisible()) await fresh.click();
    else await page.getByRole('button', { name: '新增需求', exact: true }).click();
  }
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '表格导入', exact: true }).click();
  const fileDialog = page.getByRole('dialog', { name: '表格导入', exact: true });
  await fileDialog.getByLabel('需求文件', { exact: true }).waitFor({ state: 'visible' });
  return fileDialog;
}
async function openLegacyDetail(id) {
  await page.getByRole('dialog', { name: '导入向导', exact: true }).getByRole('button', { name: '查看导入详情', exact: true }).click();
  const discard = page.getByRole('dialog', { name: '保存到草稿箱？', exact: true }).getByRole('button', { name: '不保存，退出', exact: true });
  if (await discard.isVisible()) await discard.click();
  await page.waitForURL((url) => url.pathname === `/imports/${id}`);
  await legacyDetail().getByRole('heading', { name: '文件解析详情', exact: true }).waitFor();
}
async function generatePreview(id) {
  const selections = await h.selections(id);
  for (const selection of selections) {
    await chooseOption(legacyDetail().getByLabel(`“${selection.sourceShop}”对应店铺`, { exact: true }), selection.sellerMappingId);
    await legacyDetail().getByRole('checkbox', { name: `确认“${selection.sourceShop}”对应`, exact: false }).check();
  }
  const pending = page.waitForResponse((response) => response.url().endsWith(`/imports/${id}/preview`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '生成差异预览', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 201);
  const data = await response.json();
  await page.getByRole('region', { name: '需求增量差异表，可横向滚动', exact: true }).waitFor();
  return data;
}
async function selected(number) { await page.getByRole('status').filter({ hasText: new RegExp(`^已选 ${number} 票$`) }).waitFor(); }
const submitButton = () => page.getByRole('button', { name: '确认提交所选需求', exact: true });
try {
  await h.setup();
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  context = await browser.newContext({ baseURL: h.baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', (error) => errors.push(error.name));
  const admin = h.users.get('admin');
  step = 'administrator-ui-sign-in-and-real-workbook-upload';
  await page.goto('/login'); await page.getByLabel('邮箱', { exact: true }).fill(admin.email); await page.getByLabel('密码', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByRole('heading', { name: '发货任务工作台', exact: true }).waitFor();
  await page.goto('/imports'); const inputDialog = await openFileInput();
  const uploadPending = page.waitForResponse((response) => response.url().endsWith('/api/v1/imports') && response.request().method() === 'POST');
  await inputDialog.getByLabel('需求文件', { exact: true }).setInputFiles(h.sourcePath);
  const upload = await uploadPending; assert.equal(upload.status(), 202); const accepted = await upload.json(); await openLegacyDetail(accepted.import.id); const original = await h.settle(accepted.import.id);
  assert.equal(original.latestRun.counts.totalRows, expected.totalRows); assert.equal(original.latestRun.counts.validFbaRows, expected.validFbaRows);
  await page.getByRole('button', { name: '刷新详情', exact: true }).click(); await page.getByRole('heading', { name: '确认店铺与增量差异', exact: true }).waitFor();
  record('configured-original-ui-upload-with-expected-row-counts', { sourceSha256: digest(h.sourceBytes), sourceRows: expected.totalRows, validFba: expected.validFbaRows });
  step = 'explicit-seller-confirmations-and-default-no-selection';
  const originalPreview = await generatePreview(original.id); assert.equal(originalPreview.preview.counts.new, expected.validFbaRows); assert.equal(originalPreview.preview.counts.error, expected.errorRows);
  await selected(0); assert.equal(await submitButton().isDisabled(), true);
  record('candidate-shop-confirmations-required-and-preview-defaults-unselected', { mappings: originalPreview.preview.mappings.length, errors: expected.errorRows });
  step = 'cross-page-selection-and-select-all-are-distinct';
  const diff = page.locator('.import-diff-section');
  const region = page.getByRole('region', { name: '需求增量差异表，可横向滚动', exact: true });
  const firstPageSelectable = await region.locator('input[type="checkbox"]:enabled').count();
  await page.getByRole('button', { name: '选择本页可提交项', exact: true }).click();
  const firstSelected = firstPageSelectable; assert(firstSelected > 0);
  await selected(firstSelected);
  await diff.getByRole('button', { name: '下一页', exact: true }).click();
  await diff.getByText('第 2 页', { exact: false }).waitFor();
  const secondPageSelectable = await region.locator('input[type="checkbox"]:enabled').count();
  await page.getByRole('button', { name: '选择本页可提交项', exact: true }).click();
  await selected(firstSelected + secondPageSelectable);
  await diff.getByRole('button', { name: '上一页', exact: true }).click();
  await diff.getByText('第 1 页', { exact: false }).waitFor();
  assert.equal(await region.getByRole('checkbox', { checked: true }).count(), firstSelected);
  await page.getByRole('button', { name: '清空选择', exact: true }).click(); await selected(0);
  await page.getByRole('button', { name: '选择全部可提交项', exact: true }).click(); await selected(expected.validFbaRows);
  record('selection-persists-across-pages-and-all-valid-selection-covers-expected-items');
  step = 'error-filter-source-file-sheet-row-cell-and-csv';
  await chooseOption(legacyDetail().getByLabel('按差异分类筛选', { exact: true }), 'error');
  await region.getByText('缺少 FBA', { exact: true }).first().waitFor();
  assert.equal(await region.locator('tbody tr').count(), expected.errorRows);
  await region.getByText(original.originalName, { exact: true }).first().waitFor();
  assert((await region.innerText()).includes(original.latestRun.sheetName));
  assert.match(await region.innerText(), /第 \d+ 行/);
  const downloadPending = page.waitForEvent('download'); await page.getByRole('button', { name: '下载错误清单', exact: true }).click();
  const download = await downloadPending; const csv = await readFile(await download.path(), 'utf8'); assert(csv.includes(original.originalName)); assert(csv.includes(original.latestRun.sheetName)); assert(csv.includes('FBA_REQUIRED'));
  await page.screenshot({ path: resolve(evidenceDir, 'source-errors-1440.png') });
  await chooseOption(legacyDetail().getByLabel('按差异分类筛选', { exact: true }), ''); await selected(expected.validFbaRows);
  record('configured-errors-located-to-original-sheet-row-cell-and-exported');
  step = 'response-loss-keeps-selection-and-operation-id-for-idempotent-retry';
  const commitBodies = [];
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith(`/imports/${original.id}/commit`)) commitBodies.push(request.postDataJSON()); });
  let dropped = false;
  await page.route(`**/api/v1/imports/${original.id}/commit`, async (route) => {
    if (!dropped) { dropped = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('connectionfailed'); }
    else await route.continue();
  });
  await submitButton().click(); await page.getByRole('alert').filter({ hasText: '本次选择与操作编号已保留' }).waitFor(); await selected(expected.validFbaRows);
  const retryPending = page.waitForResponse((response) => response.url().endsWith(`/imports/${original.id}/commit`) && response.request().method() === 'POST');
  await submitButton().click(); const retried = await retryPending; assert.equal(retried.status(), 200); const retriedResult = await retried.json(); assert(retriedResult.replayed); assert.equal(retriedResult.counts.created, expected.validFbaRows);
  await page.getByRole('status').filter({ hasText: `已恢复原提交结果。新增 ${expected.validFbaRows} 票` }).waitFor(); await selected(0);
  assert.equal(commitBodies.length, 2); assert.deepEqual(commitBodies[0], commitBodies[1]);
  await page.unroute(`**/api/v1/imports/${original.id}/commit`);
  assert.equal((await h.context(original.id)).submittedSourceRows, expected.validFbaRows);
  record('configured-original-committed-once-after-lost-response-and-same-operation-retry', { commitRecords: 1, selectedItemsRetained: expected.validFbaRows });
  step = 'demand-version-history-and-original-provenance';
  await page.getByRole('button', { name: '查看需求版本与来源', exact: true }).first().click();
  await page.getByRole('heading', { name: '需求版本与来源', exact: true }).waitFor();
  const demand = page.locator('.import-demand-history'); assert((await demand.innerText()).includes(original.originalName)); assert((await demand.innerText()).includes('版本 1'));
  await page.getByRole('button', { name: '关闭需求详情', exact: true }).click();
  record('committed-demand-first-date-version-and-all-source-locations-visible');
  step = 'repeat-real-upload-does-not-add-demand-or-versions';
  const repeatDialog = await openFileInput();
  const repeatPending = page.waitForResponse((response) => response.url().endsWith('/api/v1/imports') && response.request().method() === 'POST');
  await repeatDialog.getByLabel('需求文件', { exact: true }).setInputFiles(h.sourcePath);
  assert.equal((await (await repeatPending).json()).import.id, original.id); await openLegacyDetail(original.id);
  const repeated = await generatePreview(original.id); assert.equal(repeated.preview.counts.unchanged, expected.validFbaRows); assert.equal(repeated.preview.selectableItemIds.length, 0);
  await page.getByRole('button', { name: '选择全部可提交项', exact: true }).click(); await selected(0); assert.equal(await submitButton().isDisabled(), true);
  record('repeat-original-file-ui-shows-unchanged-and-no-new-selectable-items');
  step = 'narrow-layout-and-keyboard-horizontal-table-scroll';
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await region.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await region.focus(); await page.keyboard.press('End');
    await page.screenshot({ path: resolve(evidenceDir, `confirmation-${width}.png`) });
    record(`confirmation-${width}px-layout-with-table-scroll`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  step = 'technical-changed-ticket-requires-individual-confirmation';
  const seller = await h.seller(); const prefix = `FBAT11${h.runId.replaceAll('-', '').toUpperCase()}`;
  const row = (suffix, quantity = '10') => ({ shop: seller.name, fba: `${prefix}${suffix}`, quantity });
  const technicalBase = await h.upload(technicalWorkbook([row('A')]), 'technical-browser-base.xlsx'); const basePreview = await h.preview(technicalBase);
  assert.equal((await h.commit(technicalBase, basePreview)).status, 200);
  const changed = await h.upload(technicalWorkbook([{ ...row('A'), notes: 'TECHNICAL BROWSER CHANGED NOTES' }, row('B')]), 'technical-browser-change.xlsx');
  await page.goto(`/imports/${changed.id}`); const changePreview = await generatePreview(changed.id); assert.equal(changePreview.preview.counts.changed, 1); assert.equal(changePreview.preview.counts.new, 1);
  await page.getByRole('button', { name: '选择全部可提交项', exact: true }).click(); await selected(1);
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await page.getByRole('checkbox', { name: `确认 ${prefix}A 的变化`, exact: true }).check();
  await page.getByRole('button', { name: '选择全部可提交项', exact: true }).click(); await selected(2);
  const changePending = page.waitForResponse((response) => response.url().endsWith(`/imports/${changed.id}/commit`) && response.request().method() === 'POST');
  await submitButton().click(); const changeResult = await (await changePending).json(); assert.equal(changeResult.counts.updated, 1); assert.equal(changeResult.counts.created, 1);
  await page.getByRole('status').filter({ hasText: '需求已提交。新增 1 票，新版本 1 票' }).waitFor();
  await page.screenshot({ path: resolve(evidenceDir, 'technical-changed-submit.png') });
  record('technical-visible-change-individual-confirmation', { technicalOnly: true, changedField: 'notes', newVersions: 1, created: 1 });
  step = 'stale-preview-conflict-feedback-preserves-selection';
  const stale = await h.upload(technicalWorkbook([row('C')]), 'technical-browser-stale.xlsx'); await page.goto(`/imports/${stale.id}`); await generatePreview(stale.id);
  await page.getByRole('button', { name: '选择全部可提交项', exact: true }).click(); await selected(1);
  await pool.query('update seller_mapping set version=2 where id=$1', [seller.id]);
  try {
    await submitButton().click(); await page.getByRole('alert').filter({ hasText: '请刷新详情并重新生成差异' }).waitFor(); await selected(1);
    assert.equal(Number((await pool.query('select count(*) from import_commit where import_id=$1', [stale.id])).rows[0].count), 0);
  } finally { await pool.query('update seller_mapping set version=1 where id=$1', [seller.id]); }
  record('stale-seller-snapshot-409-feedback-with-no-partial-commit', { technicalOnly: true });
  step = 'refreshed-stale-shop-excluded-with-other-valid-shop-partial-commit';
  const validSeller = await h.seller();
  const partial = await h.upload(technicalWorkbook([row('R'), { ...row('S'), shop: validSeller.name }]), 'technical-browser-partial-refresh.xlsx');
  await page.goto(`/imports/${partial.id}`);
  for (const candidate of [seller, validSeller]) {
    await chooseOption(legacyDetail().getByLabel(`“${candidate.name}”对应店铺`, { exact: true }), candidate.id);
    await legacyDetail().getByRole('checkbox', { name: `确认“${candidate.name}”对应`, exact: false }).check();
  }
  await pool.query("update seller_mapping set country='德国',version=2 where id=$1", [seller.id]);
  try {
    const refresh = page.waitForResponse((response) => response.url().endsWith(`/imports/${partial.id}/confirmation`));
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))); await refresh;
    await page.getByText(`“${seller.name}”的店铺资料已变化，或来源设置和目录版本已更新，请核对当前来源、名称和国家后重新勾选确认。`, { exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: `确认“${seller.name}”对应`, exact: false }).isChecked(), false);
    const refreshedPreview = page.waitForResponse((response) => response.url().endsWith(`/imports/${partial.id}/preview`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '生成差异预览', exact: true }).click();
    const response = await refreshedPreview; assert.equal(response.status(), 201); const result = await response.json();
    assert.equal(result.preview.counts.new, 1); assert.equal(result.preview.counts.error, 1);
    assert.deepEqual(result.preview.mappings.map((mapping) => mapping.sid), [validSeller.sid]);
    await page.getByRole('button', { name: '选择全部可提交项', exact: true }).click(); await selected(1);
    const submit = page.waitForResponse((response) => response.url().endsWith(`/imports/${partial.id}/commit`) && response.request().method() === 'POST');
    await submitButton().click(); const committed = await submit; assert.equal(committed.status(), 200); assert.equal((await committed.json()).counts.created, 1);
    assert.equal(Number((await pool.query('select count(*) from demand_source where import_id=$1', [partial.id])).rows[0].count), 1);
    await page.screenshot({ path: resolve(evidenceDir, 'final-partial-valid-source.png') });
  } finally { await pool.query("update seller_mapping set country='美国',version=1 where id=$1", [seller.id]); }
  record('refreshed-stale-shop-excluded-with-other-valid-shop-partial-commit', { technicalOnly: true });
  await h.unchangedOriginalAndMappings(); assert.equal(errors.length, 0); record('real-original-and-candidates-global-aliases-unchanged-with-no-page-errors');
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error instanceof Error ? error.message : 'CHECK_FAILED' });
  console.error(`T11 browser failed: ${step}`, error instanceof Error ? error.message : 'CHECK_FAILED');
  await page?.screenshot({ path: resolve(evidenceDir, 'failed.png') }).catch(() => undefined);
} finally {
  await browser?.close();
  try { await h.cleanup(); cleaned = true; } catch (error) { failed = true; checks.push({ name: 'technical-fixture-cleanup', result: 'failed', message: error instanceof Error ? error.message : 'CLEANUP_FAILED' }); }
  await writeFile(resolve(evidenceDir, 'browser.json'), `${JSON.stringify({ kind: 'real-postgresql-confirmation-browser', runId: h.runId, baseURL: h.baseURL, browserVersion: browser?.version(), timezone: 'Asia/Shanghai', completedAt: new Date().toISOString(), result: failed ? 'failed' : 'passed', checks, technicalFixturesRemoved: cleaned,
    realEvidence: 'Unchanged designated original uploaded, explicitly mapped, previewed, committed and repeated through browser', technicalEvidence: 'Labelled generated workbooks for visible demand changes and stale snapshots', notCovered: ['real daily increment/correction business acceptance', 'T12 weekly batch pages'] }, null, 2)}\n`);
  await closeDatabase(); console.log(`T11 browser ${failed ? 'FAILED' : 'PASSED'} (${checks.filter((check) => check.result === 'passed').length} checks)`); if (failed) process.exitCode = 1;
}
