import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import * as contracts from '../../packages/contracts/dist/index.js';
import { grid, gridRowCount, selectGridRow, findGridRow } from '../shared/grid.mjs';

// Offline UI acceptance: all API requests are fixtures, and traffic outside the
// isolated Vite origin is rejected. No database, credentials or ERP is accessed.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.SHIPPING_RUNS_EVIDENCE_DIR || resolve(root, '.local/t39/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-23T02:00:00.000Z';
const numberingDate = '2026-10-23';
const id = () => randomUUID();
const copy = (value) => structuredClone(value);
const checks = [], unexpectedRequests = [], browserErrors = [], fixtureErrors = [];
let browser, viteProcess, page, baseURL, step = 'setup', failed = false;
const note = () => { checks.push({ name: step, result: 'passed' }); console.log(`PASS ${step}`); };

function fixture(needsReview = false, correction = false) {
  const importId = id(), parseRunId = id(), runId = id();
  const fbas = ['FBAUS001', 'FBAUS002', 'FBAUK001'];
  const groupIds = fbas.map(id), demandIds = fbas.map(id), ticketIds = [id(), id()];
  const references = groupIds.map((groupId, index) => ({ groupId, groupVersion: index + 2, confirmationId: id() }));
  const state = { importId, parseRunId, runId, fbas, groupIds, references, created: needsReview, correction,
    replacementImportId: id(), replacementParseRunId: id(), replacementReads: 0, replacementUploads: 0, retryBodies: [],
    sourceReads: 0, runReads: 0, sourceBodies: [], createBodies: [], exportBodies: [], reportQueries: [], exportQueries: [], deliveredStatuses: [], exports: [], needsReview };
  const counts = { totalRows: 3, validFbaRows: 3, errorRows: 0, warningRows: 3 };
  const sheet = { name: '在线需求导入', state: 'visible', rowCount: 5, columnCount: 13, mergedRanges: [], hiddenColumns: [], headers: [] };
  state.source = (completed, replacement = false) => contracts.sourceImportSchema.parse({ id: replacement ? state.replacementImportId : importId, fileId: id(), sourceType: replacement ? 'xlsx' : 'online', submissionStatus: 'not_submitted', submittedSourceRows: 0,
    originalName: replacement ? 'corrected-fba.xlsx' : '在线填写快照.xlsx', sha256: '0'.repeat(64), byteSize: 4096, createdBy: 'technical-runs', importedAt: now, businessDate: numberingDate,
    datePolicyVersion: contracts.IMPORT_DATE_POLICY, weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', status: completed ? 'preview_ready' : 'queued', version: 2, sheets: [sheet],
    latestRun: { id: replacement ? state.replacementParseRunId : parseRunId, importId: replacement ? state.replacementImportId : importId, status: completed ? 'completed' : 'queued', inputVersion: 2, mappingVersion: replacement ? 'fba-list-v1' : 'online-v1', sheetName: sheet.name,
      parserVersion: contracts.IMPORT_PARSER_VERSION, processedRows: completed ? 3 : 0, counts: completed ? counts : { totalRows: 0, validFbaRows: 0, errorRows: 0, warningRows: 0 }, issues: [],
      errorCode: null, errorMessage: null, createdAt: now, startedAt: completed ? now : null, completedAt: completed ? now : null } });
  state.detail = (status) => {
    const numbered = state.numberedRunning || status === 'ready' || status === 'needs_review' && !state.correction;
    const run = { id: runId, version: state.controlledVersion ?? (numbered ? 3 : state.retried ? 2 : 1), status, stage: status === 'ready' ? 'ready' : state.controlledStage ?? (status === 'needs_review' && !state.correction ? 'confirmation' : 'lookup'),
      numberingDate, month: '2026-10', sequence: numbered ? 3 : null, importId: state.retried ? state.replacementImportId : importId, parseRunId: state.retried ? state.replacementParseRunId : parseRunId, error: null, createdAt: now, updatedAt: now };
    return contracts.shippingRunDetailSchema.parse({ run, tickets: (state.correction && !state.retried ? [0] : [0, 1]).map((index) => ({ id: ticketIds[index], sourceTicketIndex: index + 1,
      country: numbered ? index === 0 ? 'US' : 'UK' : null, ticketSequence: numbered ? 1 : null, number: numbered ? `20261023-3-${index === 0 ? 'US' : 'UK'}-1` : null,
      members: (state.correction && !state.retried ? [0, 1, 2] : index === 0 ? [0, 1] : [2]).map((member) => ({ demandId: numbered ? demandIds[member] : null, fba: fbas[member], sid: numbered ? member < 2 ? 101 : 202 : null, inputOrder: member + 1, groupId: numbered ? groupIds[member] : null })) })),
      issues: status === 'needs_review' ? [state.correction ? { code: 'MIXED_TICKET_COUNTRIES', message: '同一段包含不同国家，请修正空行分票后继续。', ticketIndex: 1 }
        : { code: 'BOX_ORDER_UNCONFIRMED', message: '箱序尚未确认，请处理后继续整理。', ticketIndex: 1, fba: fbas[0], groupId: groupIds[0] }] : [] });
  };
  state.currentStatus = needsReview ? 'needs_review' : 'queued';
  const rows = fbas.map((fba, index) => {
    const ticketIndex = index < 2 ? 0 : 1;
    const boxCount = index === 0 ? 12 : index === 1 ? 2 : 1;
    return { id: `product-${index}`, groupId: groupIds[index], groupName: `技术底层组 ${index + 1}`, confirmationId: references[index].confirmationId,
      shippingRunId: runId, ticketId: ticketIds[ticketIndex], ticketNumber: `20261023-3-${ticketIndex === 0 ? 'US' : 'UK'}-1`, sourceTicketIndex: ticketIndex + 1, inputOrder: index + 1, demandId: demandIds[index],
      weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', businessDate: numberingDate, sid: index < 2 ? 101 : 202,
      shop: index < 2 ? '技术美国店' : '技术英国店', country: index < 2 ? '美国' : '英国', channel: '海派', destinationFc: index < 2 ? 'ONT8' : 'BHX4', fba,
      msku: `MSKU-${index + 1}`, fnsku: `FNSKU-${index + 1}`, sku: `SKU-${index + 1}`, productName: `技术商品 ${index + 1}`, quantity: boxCount * 2,
      boxes: Array.from({ length: boxCount }, (_, box) => ({ boxId: id(), boxOrder: box + 1, displayBoxOrder: box + 1, code: `${String.fromCharCode(65 + index)}${box + 1}`, quantity: 2 })),
      codes: Array.from({ length: boxCount }, (_, box) => `${String.fromCharCode(65 + index)}${box + 1}`), groupQuantity: index < 2 ? 28 : 2,
      monthQuantity: 30, status: 'confirmed', actualShipDate: null, sourceObservedAt: now, dataRevisionId: id() };
  });
  const boxes = rows.flatMap((row) => row.boxes.map((box) => ({ ...row, ...box, boxName: '技术箱', boxExternalId: null, localBoxId: null,
    weight: 1, weightUnit: 'KG', length: 10, width: 20, height: 30, lengthUnit: 'CM', items: [{ msku: row.msku, fnsku: row.fnsku, sku: row.sku, quantity: box.quantity }] })));
  state.report = () => {
    const blocked = state.blocked ?? (state.needsReview ? [{ groupId: groupIds[0], name: '技术底层组 1', code: 'BOX_ORDER_UNCONFIRMED', message: '箱序尚未确认' }] : []);
    const omitted = new Set(state.partialPreview ? blocked.map((item) => item.groupId) : []);
    const visibleRows = rows.filter((row) => !omitted.has(row.groupId))
      .sort((left, right) => left.sourceTicketIndex - right.sourceTicketIndex || left.boxes.length - right.boxes.length || left.inputOrder - right.inputOrder);
    const visibleBoxes = boxes.filter((box) => !omitted.has(box.groupId));
    return contracts.reportResponseSchema.parse({ shippingRunId: runId, shippingRunVersion: state.controlledVersion ?? 3, shippingRunDate: numberingDate, shippingRunSequence: 3,
      rows: visibleRows, boxes: visibleBoxes, confirmations: references.filter((ref) => !omitted.has(ref.groupId)), total: visibleRows.length, page: 1, pageSize: 50,
      maxBoxes: visibleBoxes.reduce((maximum, box) => Math.max(maximum, box.boxOrder), 0), generatedAt: now, blocked });
  };
  return state;
}

function pendingBlockers(state) {
  return [
    { groupId: state.groupIds[1], name: '本次发货来源组', code: 'CONFIRMATION_REQUIRED', message: '请先确认子批次。' },
    { groupId: state.groupIds[2], name: '本次发货来源组', code: 'CODES_REQUIRED', message: '请先分配全部箱码。' },
  ];
}

function progressFixture(stage = 'sync', status = 'running') {
  const state = fixture(status === 'needs_review');
  Object.assign(state, { created: true, numberedRunning: true, controlledStatus: status, currentStatus: status, controlledStage: stage,
    controlledVersion: 3, partialPreview: status === 'running', blocked: pendingBlockers(state) });
  const report = state.report;
  state.report = () => {
    const value = report(), first = value.rows.find((row) => row.fba === state.fbas[0]);
    if (!first) return value;
    const second = { ...copy(first), id: `${first.id}:second-product`, msku: 'MSKU-1-SECOND', fnsku: 'FNSKU-1-SECOND', sku: 'SKU-1-SECOND', productName: '同一 FBA 第二个商品',
      quantity: first.boxes.length, boxes: first.boxes.map((box) => ({ ...box, quantity: 1 })), groupQuantity: first.boxes.length, monthQuantity: first.boxes.length };
    value.rows.splice(value.rows.indexOf(first) + 1, 0, second);
    for (const box of value.boxes.filter((box) => box.fba === first.fba)) box.items.push({ msku: second.msku, fnsku: second.fnsku, sku: second.sku, quantity: 1 });
    value.total = value.rows.length;
    return contracts.reportResponseSchema.parse(value);
  };
  return state;
}

function allocationColumnFixture() {
  const state = fixture();
  Object.assign(state, { created: true, controlledStatus: 'ready', currentStatus: 'ready' });
  const original = state.report();
  // Retain old global display metadata to exercise compatibility: the product
  // grid and its width must use local boxOrder even for G7 through G12.
  const quantities = [15, 11, 9], displayColumns = [[7, 8], [9, 10], [11, 12]];
  const rows = state.fbas.map((fba, index) => {
    const row = original.rows.find((row) => row.fba === fba);
    assert(row, 'every fixture FBA must retain its accepted product');
    const boxes = displayColumns[index].map((displayBoxOrder, localIndex) => ({
      boxId: row.boxes[localIndex]?.boxId ?? id(), boxOrder: localIndex + 1, displayBoxOrder, code: `G${displayBoxOrder}`, quantity: quantities[index],
    }));
    return { ...copy(row), quantity: quantities[index] * 2, groupQuantity: quantities[index] * 2, monthQuantity: quantities[index] * 2,
      boxes, codes: boxes.map((box) => box.code) };
  });
  const boxes = rows.flatMap((row) => {
    const source = original.boxes.find((box) => box.demandId === row.demandId);
    assert(source, 'every display-column fixture shipment must have its own source box metadata');
    return row.boxes.map((box) => ({ ...copy(source), ...box, demandId: row.demandId, fba: row.fba,
      items: [{ msku: row.msku, fnsku: row.fnsku, sku: row.sku, quantity: box.quantity }] }));
  });
  state.report = () => contracts.reportResponseSchema.parse({ ...copy(original), rows: copy(rows), boxes: copy(boxes), total: 3, maxBoxes: 12 });
  return state;
}

async function contextFor(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    try {
      if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(`${method} EXTERNAL ${url.origin}`); return route.abort('blockedbyclient'); }
      if (!path.startsWith('/api/')) return route.continue();
      if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'technical-runs', name: '发货次技术验证', email: 'runs@acceptance.invalid', role: 'admin' } });
      if (method === 'GET' && path === '/api/v1/demands') return json(contracts.demandWorkspaceSchema.parse({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 20, maxBoxes: 10,
        filters: { weeks: [], batches: [], shops: [], countries: [], channels: [] }, generatedAt: now }));
      if (method === 'GET' && path === '/api/v1/batches/workspace') return json(contracts.batchWorkspaceSchema.parse({ rows: [], total: 0, page: 1, pageSize: 20, availableWeeks: [],
        filters: { weeks: [], shops: [], countries: [], channels: [] } }));
      if (method === 'GET' && path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: { mode: 'manual', version: 1, catalogVersion: 1, lastSyncedAt: now, lastError: null, configured: true, readOnly: true } });
      if (method === 'GET' && path === '/api/v1/imports/transport-methods') return json({ items: [{ id: 'test-sea', name: '海派', enabled: true, remark: '' }], queriedAt: now });
      if (method === 'GET' && path === '/api/v1/imports') return json({ items: [], total: 0, page: 1, pageSize: 10 });
      if (method === 'POST' && path === '/api/v1/imports/online') {
        const body = contracts.onlineImportInputSchema.parse(request.postDataJSON()); state.sourceBodies.push(copy(body));
        assert.deepEqual(body.rows.map((row) => row.fba), [state.fbas[0], state.fbas[1], '', state.fbas[2]], 'online source must retain its internal blank row');
        assert(Object.values(body.rows[2]).every((value) => value === '' || value === undefined), 'the separator must remain empty in all business fields');
        assert(body.rows.every((row) => !row.shop), 'automatic input should require only FBA');
        const source = state.source(false);
        return json(contracts.importAcceptedSchema.parse({ import: source, run: source.latestRun, taskId: id(), taskUrl: `/api/v1/imports/${state.importId}/runs`, replayed: false, deduplicated: false }), 202);
      }
      if (method === 'GET' && path === `/api/v1/imports/${state.importId}`) return json({ import: state.source(++state.sourceReads > 1) });
      if (method === 'GET' && path === `/api/v1/imports/${state.importId}/rows`) {
        assert.equal(url.searchParams.get('parseRunId'), state.parseRunId);
        const items = state.fbas.map((fba, index) => ({ id: id(), parseRunId: state.parseRunId, sheetName: '在线需求导入', rowNumber: index + 2, hidden: false, status: 'needs_review', rawCells: [], issues: [],
          normalized: { shop: null, channel: null, country: index < 2 ? '美国' : '英国', destinationFc: null, fba, referenceQuantity: null, sourceDate: null, sourceRecordId: null,
            notes: null, subBatchName: null, sellerMappingId: null, sid: null, sellerMappingVersion: null, sourceTicketIndex: 1, sourceMemberIndex: index + 1 } }));
        return json(contracts.importRowsResponseSchema.parse({ items, total: items.length, page: 1, pageSize: 100, parseRunId: state.parseRunId, previewVersion: 2 }));
      }
      if (method === 'POST' && path === '/api/v1/imports') {
        assert(state.correction, 'file upload is reserved for the replacement-source scenario');
        assert(request.headers()['content-type'].startsWith('multipart/form-data'));
        assert(request.postDataBuffer().includes(Buffer.from('corrected-fba.xlsx')));
        state.replacementUploads += 1;
        const source = state.source(false, true);
        return json(contracts.importAcceptedSchema.parse({ import: source, run: source.latestRun, taskId: id(), taskUrl: `/api/v1/imports/${source.id}/runs`, replayed: false, deduplicated: false }), 202);
      }
      if (method === 'GET' && path === `/api/v1/imports/${state.replacementImportId}`) return json({ import: state.source(++state.replacementReads > 1, true) });
      if (method === 'GET' && path === '/api/v1/shipping-runs') return json(contracts.shippingRunListSchema.parse({ items: state.created ? [state.detail(state.currentStatus).run] : [] }));
      if (method === 'POST' && path === '/api/v1/shipping-runs') {
        const body = contracts.createShippingRunInputSchema.parse(request.postDataJSON()); state.createBodies.push(copy(body));
        assert.equal(body.importId, state.importId); assert.equal(body.parseRunId, state.parseRunId); assert.equal(body.numberingDate, numberingDate);
        assert(state.sourceReads > 1, 'creation must await the current completed parse');
        state.created = true; state.deliveredStatuses.push('queued'); return json(state.detail('queued'), 202);
      }
      if (method === 'GET' && path === `/api/v1/shipping-runs/${state.runId}`) {
        state.currentStatus = state.controlledStatus ?? (state.needsReview ? 'needs_review' : ++state.runReads > 1 ? 'ready' : 'queued');
        state.deliveredStatuses.push(state.currentStatus); return json(state.detail(state.currentStatus));
      }
      if (method === 'POST' && path === `/api/v1/shipping-runs/${state.runId}/retry`) {
        const body = contracts.retryShippingRunInputSchema.parse(request.postDataJSON()); state.retryBodies.push(copy(body));
        assert.equal(body.expectedVersion, 1); assert.equal(body.importId, state.replacementImportId); assert.equal(body.parseRunId, state.replacementParseRunId);
        assert(state.replacementReads > 1, 'retry must await the replacement completed parse');
        state.retried = true; state.needsReview = false; state.currentStatus = 'queued';
        return json(state.detail('queued'), 202);
      }
      if (method === 'GET' && path === '/api/v1/batch-reports') {
        const query = Object.fromEntries(url.searchParams); state.reportQueries.push(copy(query));
        if (query.shippingRunId) { assert.equal(query.shippingRunId, state.runId); assert.equal(query.region, 'all'); assert.equal(query.month, undefined); return json(state.report()); }
        return json(contracts.reportResponseSchema.parse({ rows: [], boxes: [], confirmations: [], total: 0, page: 1, pageSize: 50, maxBoxes: 0, blocked: [], generatedAt: now }));
      }
      if (method === 'GET' && path === '/api/v1/batch-reports/exports') { state.exportQueries.push(Object.fromEntries(url.searchParams)); return json({ items: url.searchParams.has('shippingRunId') ? state.exports : [] }); }
      if (method === 'POST' && path === '/api/v1/batch-reports/exports') {
        const body = contracts.reportExportInputSchema.parse(request.postDataJSON()); state.exportBodies.push(copy(body));
        assert.equal(body.shippingRunId, state.runId); assert.equal(body.expectedShippingRunVersion, 3); assert.equal(body.region, 'all'); assert.equal(body.month, undefined);
        assert.deepEqual(body.groupIds, state.groupIds); assert.deepEqual(body.expectedConfirmations, state.references, 'whole-run export must use every confirmation, including both members of the first ticket');
        const record = contracts.reportExportRecordSchema.parse({ id: id(), status: 'completed', shippingRunId: state.runId, shippingRunVersion: 3,
          groupIds: body.groupIds, references: body.expectedConfirmations, month: null, region: 'all', fileId: id(), error: null, createdAt: now, completedAt: now,
          rowCount: 3, boxCount: 15, valid: true, invalidReason: null });
        state.exports.push(record); return json({ export: record, replayed: false }, 202);
      }
      if (method === 'GET' && path.startsWith('/api/v1/files/')) return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'isolated-shipping-run-download-fixture' });
      unexpectedRequests.push(`${method} ${path}`); return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unhandled offline fixture API' } }, 500);
    } catch (error) {
      fixtureErrors.push({ request: `${method} ${path}`, message: error.message });
      return json({ error: { code: 'FIXTURE_ASSERTION_FAILED', message: error.message } }, 500);
    }
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.clock.setFixedTime(new Date(now));
  return context;
}

const wizard = () => page.getByRole('dialog', { name: '导入向导', exact: true });
const result = () => page.getByRole('region', { name: '本次发货整理结果', exact: true });
const productTable = () => grid(page, '本次发货商品表');
const generate = () => page.getByRole('button', { name: '生成本次发货 XLSX', exact: true });
const progress = () => result().getByRole('status', { name: '自动整理进度', exact: true });
const stepper = () => result().getByLabel('整理步骤', { exact: true });

async function automaticChecks(state) {
  step = 'new-import-defaults-to-automatic-and-previews-blank-line-ticket-boundaries';
  await page.goto('/shipping');
  await expect(page.getByRole('button', { name: '本次发货与票号', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '本次发货与票号', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '新增需求', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导入本次发货', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '导入本次发货', exact: true }).click();
  await expect(wizard().getByRole('button', { name: '本次发货自动整理', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await wizard().getByRole('button', { name: '仅导入需求', exact: true }).click();
  await expect(wizard().getByRole('button', { name: '仅导入需求', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(wizard().getByRole('button', { name: '补全并解析', exact: true })).toBeVisible();
  await wizard().getByRole('button', { name: '本次发货自动整理', exact: true }).click();
  await expect(wizard().getByRole('button', { name: '导入并整理本次发货', exact: true })).toBeVisible();
  await expect(wizard().getByLabel('编号日期', { exact: true })).toHaveValue(numberingDate);
  await expect(wizard().getByLabel('第 1 行店铺', { exact: true })).not.toBeVisible();
  await wizard().getByRole('button', { name: '显示补充资料', exact: true }).click();
  await expect(wizard().getByLabel('第 1 行店铺', { exact: true })).toBeVisible();
  await wizard().getByRole('button', { name: '收起补充资料', exact: true }).click();
  await expect(wizard().getByLabel('第 1 行店铺', { exact: true })).not.toBeVisible();
  await wizard().getByLabel('第 1 行FBA 货件号', { exact: true }).evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, `${state.fbas[0]}\n${state.fbas[1]}\n\n${state.fbas[2]}`);
  await expect(wizard()).toContainText('3 个 FBA · 2 票');
  await wizard().getByText('分票预览（按空行）', { exact: true }).click();
  await expect(wizard()).toContainText('第 1 段：2 个 FBA'); await expect(wizard()).toContainText('第 2 段：1 个 FBA');
  await expect(wizard().getByLabel('第 3 行FBA 货件号', { exact: true })).toHaveValue('');
  await wizard().getByText('分票预览（按空行）', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidence, 'ticket-preview-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'FBA-only entry must fit the mobile viewport');
  await wizard().getByText('分票预览（按空行）', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidence, 'ticket-preview-390.png') });
  await page.setViewportSize({ width: 1440, height: 1000 }); note();

  step = 'online-source-preserves-separator-and-automatic-run-awaits-current-parse';
  await wizard().getByRole('button', { name: '导入并整理本次发货', exact: true }).click();
  await expect.poll(() => state.sourceBodies.length).toBe(1);
  await expect.poll(() => state.createBodies.length, { timeout: 15000 }).toBe(1);
  await expect.poll(() => state.deliveredStatuses.includes('ready'), { timeout: 15000 }).toBe(true);
  assert(state.deliveredStatuses.includes('queued')); assert.equal(state.createBodies.length, 1); note();

  step = 'whole-run-product-table-keeps-tickets-contiguous-orders-by-box-count-and-retains-twelve-local-columns';
  await expect(await findGridRow(page, '本次发货商品表', '20261023-3-US-1')).toContainText('20261023-3-US-1'); await expect(await findGridRow(page, '本次发货商品表', '20261023-3-UK-1')).toContainText('20261023-3-UK-1');
  await expect((await selectGridRow(page, '本次发货商品表', 0)).locator('dt').filter({ hasText: /^箱 12$/ })).toHaveCount(1);
  await expect(productTable()).toHaveAttribute('data-row-count', '3');
  const textRows = []; for (let index = 0; index < await gridRowCount(page, '本次发货商品表'); index++) textRows.push(await (await selectGridRow(page, '本次发货商品表', index)).textContent());
  [state.fbas[1], state.fbas[0], state.fbas[2]].forEach((fba, index) => assert(textRows[index].includes(fba), 'FBA rows stay inside their ticket and sort by actual box count'));
  const ticketRangeColumn = (await (await selectGridRow(page, '本次发货商品表', 0)).locator('dt').allTextContents()).indexOf('整票编码范围');
  assert(ticketRangeColumn >= 0);
  await expect((await selectGridRow(page, '本次发货商品表', 0)).locator('dd').nth(ticketRangeColumn)).toHaveText('A1-A12、B1-B2');
  await expect((await selectGridRow(page, '本次发货商品表', 1)).locator('dd').nth(ticketRangeColumn)).toHaveText('');
  await expect((await selectGridRow(page, '本次发货商品表', 2)).locator('dd').nth(ticketRangeColumn)).toHaveText('C1');
  await expect(generate()).toBeEnabled();
  await productTable().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidence, 'ready-products-1440.png') });
  await productTable().locator('canvas').dispatchEvent('wheel', { deltaX: 10000, deltaY: 0 });
  await page.screenshot({ path: resolve(evidence, 'ready-products-box-12-1440.png') });
  await productTable().locator('canvas').dispatchEvent('wheel', { deltaX: -10000, deltaY: 0 });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'wide tables must scroll internally at mobile width');
  await productTable().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidence, 'ready-products-390.png') });
  await page.setViewportSize({ width: 1440, height: 1000 }); note();

  step = 'whole-run-export-uses-current-run-version-and-all-confirmations';
  await generate().click(); await expect.poll(() => state.exportBodies.length).toBe(1);
  await expect(wizard().locator('.shipping-run-export-history')).toHaveAttribute('open', '');
  await expect(wizard()).toContainText('已生成 · 3 条商品 / 15 箱');
  const download = page.waitForEvent('download'); await wizard().getByRole('button', { name: '下载 XLSX', exact: true }).click();
  assert.equal((await download).suggestedFilename(), '20261023-3-发货表.xlsx'); note();

  step = 'close-and-reopen-the-same-run-from-shipping-history';
  await wizard().getByRole('button', { name: '关闭导入向导', exact: true }).click(); await expect(wizard()).not.toBeVisible();
  await page.getByRole('button', { name: '本次发货与票号', exact: true }).click();
  await page.getByRole('dialog', { name: '本次发货与票号', exact: true }).getByRole('button', { name: '刷新发货记录', exact: true }).click();
  await expect(grid(page, '本次发货记录').getByRole('grid')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    await expect(page.getByRole('dialog', { name: '本次发货与票号', exact: true })).toBeVisible();
    assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= width + 1, 'the shipping run manager fits the viewport');
    await page.screenshot({ path: resolve(evidence, 'shipping-run-manager-' + width + '.png'), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '查看发货表', exact: true }).click();
  const recovered = page.getByRole('dialog', { name: '本次发货表', exact: true });
  await expect(recovered).toBeVisible(); await expect(await findGridRow(page, '本次发货商品表', '20261023-3-UK-1')).toContainText('20261023-3-UK-1');
  assert.equal(state.createBodies.length, 1, 'history recovery must not create another run');
  await recovered.getByRole('button', { name: '逐箱明细', exact: true }).click();
  const boxTable = grid(recovered, '本次发货逐箱表');
  await expect(boxTable).toHaveAttribute('data-row-count', '15'); await expect(await findGridRow(page, '本次发货逐箱表', '箱 12 · A12')).toContainText('箱 12 · A12');
  await boxTable.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidence, 'recovered-boxes-1440.png') }); note();
}

async function needsReviewChecks(state) {
  step = 'needs-review-retains-progress-and-disables-whole-run-export';
  state.blocked = pendingBlockers(state);
  await page.goto('/shipping'); await page.getByRole('button', { name: '本次发货与票号', exact: true }).click(); await page.getByRole('button', { name: '查看进度与处理', exact: true }).click();
  await expect(result()).toContainText('箱序尚未确认，请处理后继续整理。');
  await expect(result()).toContainText('请先确认子批次。'); await expect(result()).toContainText('请先分配全部箱码。');
  await expect(result().getByRole('link', { name: '处理相关批次', exact: true }).first()).toBeVisible();
  await expect(result().getByRole('button', { name: '处理后继续整理', exact: true })).toBeEnabled();
  await expect(await findGridRow(page, '本次发货商品表', state.fbas[0])).toContainText(state.fbas[0]); await expect(generate()).toBeDisabled();
  assert.equal(state.exportBodies.length, 0); assert.equal(state.createBodies.length, 0);
  await productTable().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidence, 'needs-review-1440.png') }); note();
}

async function normalProgressChecks(state) {
  const syncMessage = '正在同步商品与箱数据，完成后将自动校验并分配箱码。';
  const confirmationMessage = '正在校验数量与箱序，并自动确认、分配箱码。';
  step = 'numbered-sync-progress-shows-completed-preview-without-transient-error-messages';
  await page.goto('/shipping'); await page.getByRole('button', { name: '本次发货与票号', exact: true }).click(); await page.getByRole('button', { name: '查看进度与处理', exact: true }).click();
  await expect(progress()).toContainText(syncMessage); await expect(stepper()).toBeVisible();
  await expect(progress()).toContainText('1 / 3 个 FBA 已就绪');
  await expect(stepper().locator('[aria-current="step"]')).toContainText('同步商品与箱');
  await expect(result()).not.toContainText('请先确认子批次'); await expect(result()).not.toContainText('请先分配全部箱码');
  await expect(result().getByRole('alert')).toHaveCount(0);
  await expect(productTable()).toHaveAttribute('data-row-count', '2');
  await expect(await findGridRow(page, '本次发货商品表', state.fbas[0])).toContainText(state.fbas[0]); await expect(await findGridRow(page, '本次发货商品表', 'MSKU-1')).toContainText('MSKU-1');
  await expect(await findGridRow(page, '本次发货商品表', 'MSKU-1-SECOND')).toContainText('MSKU-1-SECOND');
  await expect(await findGridRow(page, '本次发货商品表', state.fbas[1])).toHaveCount(0); await expect(generate()).toBeDisabled();
  await progress().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, 'progress-sync-1440.png') });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'normal progress must fit the mobile viewport');
    await progress().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, `progress-sync-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); note();

  step = 'numbered-confirmation-progress-polls-without-asking-for-manual-confirmation';
  state.controlledStage = 'confirmation'; state.controlledVersion += 1;
  await expect(progress()).toContainText(confirmationMessage);
  await expect(stepper().locator('[aria-current="step"]')).toContainText('校验与箱码');
  await expect(result()).not.toContainText('请先确认子批次'); await expect(result()).not.toContainText('请先分配全部箱码');
  await expect(productTable()).toHaveAttribute('data-row-count', '2'); await expect(generate()).toBeDisabled();
  await progress().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, 'progress-confirmation-1440.png') }); note();

  step = 'ready-transition-automatically-clears-normal-progress-and-enables-complete-export';
  state.controlledStatus = 'ready'; state.controlledVersion += 1; state.blocked = []; state.partialPreview = false;
  await expect(productTable()).toHaveAttribute('data-row-count', '4');
  await expect(generate()).toBeEnabled();
  await expect(result()).not.toContainText(syncMessage); await expect(result()).not.toContainText(confirmationMessage);
  await expect(result()).not.toContainText('请先确认子批次'); await expect(result()).not.toContainText('请先分配全部箱码');
  assert.equal(state.exportBodies.length, 0);
  await result().getByRole('heading', { level: 3 }).first().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, 'progress-ready-1440.png') }); note();
}

async function runningIssueChecks(state) {
  step = 'running-preserves-real-confirmation-errors-and-links-to-the-related-group';
  const stale = { groupId: state.groupIds[1], name: '本次发货来源组', code: 'CONFIRMATION_STALE', message: '确认之后需求或候选数据发生变化，请重新确认。' };
  state.blocked = [stale, pendingBlockers(state)[1]];
  await page.goto('/shipping'); await page.getByRole('button', { name: '本次发货与票号', exact: true }).click(); await page.getByRole('button', { name: '查看进度与处理', exact: true }).click();
  await expect(progress()).toContainText('发货表需要核对');
  await expect(result()).toContainText(stale.message); await expect(result()).not.toContainText('请先分配全部箱码');
  const link = result().getByRole('link', { name: '处理相关批次', exact: true });
  await expect(link).toHaveCount(1); await expect(link).toHaveAttribute('href', new RegExp(`groupId=${stale.groupId}`));
  await expect(await findGridRow(page, '本次发货商品表', state.fbas[0])).toContainText(state.fbas[0]); await expect(generate()).toBeDisabled();
  await progress().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, 'running-real-issue-1440.png') }); note();
}

async function readyBlockedChecks(state) {
  step = 'ready-with-blocked-confirmations-keeps-errors-visible-and-export-disabled';
  await page.goto('/shipping'); await page.getByRole('button', { name: '本次发货与票号', exact: true }).click(); await page.getByRole('button', { name: '查看发货表', exact: true }).click();
  await expect(result()).toContainText('请先确认子批次。'); await expect(result()).toContainText('请先分配全部箱码。');
  await expect(progress()).toContainText('发货表需要核对');
  await expect(result().getByRole('link', { name: '处理相关批次', exact: true })).toHaveCount(2);
  await expect(generate()).toBeDisabled();
  await result().getByRole('button', { name: '刷新', exact: true }).click();
  await expect(result()).toContainText('请先确认子批次。'); await expect(generate()).toBeDisabled();
  assert.equal(state.exportBodies.length, 0);
  await result().getByRole('heading', { level: 3 }).first().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, 'ready-blocked-1440.png') }); note();
}

async function runningDetailIssueChecks(state) {
  step = 'running-keeps-unconfirmed-report-visible-when-the-same-group-has-a-real-detail-issue';
  const readDetail = state.detail;
  state.detail = (status) => {
    const value = readDetail(status);
    const members = value.tickets.flatMap((ticket) => ticket.members);
    // The missing FBA still points to a valid confirmed group. Its own accepted
    // shipment is absent, so group membership alone must not count it as ready.
    const missing = members.find((member) => member.fba === state.fbas[1]);
    missing.groupId = state.groupIds[0];
    members.find((member) => member.fba === state.fbas[2]).groupId = state.groupIds[1];
    value.issues = [
      { code: 'SHIPPING_MEMBER_REMOVED', message: '本票的 FBA 已从其内部处理组移除，请恢复正确归属后重试。', groupId: state.groupIds[0], demandId: missing.demandId, fba: missing.fba },
      { code: 'PACKED_QUANTITY_MISMATCH', message: '商品申报量与所有箱内数量合计不一致。', groupId: state.groupIds[1], fba: state.fbas[2] },
    ];
    return contracts.shippingRunDetailSchema.parse(value);
  };
  state.blocked = [pendingBlockers(state)[0]];
  const readReport = state.report;
  state.report = () => {
    const value = readReport(), rows = value.rows.filter((row) => row.fba === state.fbas[0]);
    return contracts.reportResponseSchema.parse({ ...value, rows, total: rows.length,
      boxes: value.boxes.filter((box) => box.fba === state.fbas[0]), confirmations: value.confirmations.filter((ref) => ref.groupId === state.groupIds[0]) });
  };
  const detail = state.detail('running'), missing = detail.tickets.flatMap((ticket) => ticket.members).find((member) => member.fba === state.fbas[1]);
  assert.equal(detail.tickets.flatMap((ticket) => ticket.members).filter((member) => member.groupId === state.groupIds[0]).length, 2);
  assert(state.report().confirmations.some((ref) => ref.groupId === missing.groupId));
  assert(!state.report().boxes.some((box) => box.demandId === missing.demandId));
  await page.goto('/shipping'); await page.getByRole('button', { name: '本次发货与票号', exact: true }).click(); await page.getByRole('button', { name: '查看进度与处理', exact: true }).click();
  await expect(progress()).toContainText('发货表需要核对');
  await expect(progress()).toContainText('1 / 3 个 FBA 已就绪'); await expect(progress()).not.toContainText('2 / 3 个 FBA 已就绪');
  await expect(result()).toContainText('本票的 FBA 已从其内部处理组移除，请恢复正确归属后重试。');
  await expect(result()).toContainText('商品申报量与所有箱内数量合计不一致。');
  const reportIssues = result().getByRole('list', { name: '发货表待处理问题', exact: true });
  await expect(reportIssues).toContainText('请先确认子批次。'); await expect(result()).not.toContainText('请先分配全部箱码');
  await expect(reportIssues.getByRole('link', { name: '处理相关批次', exact: true })).toHaveAttribute('href', new RegExp(`groupId=${state.groupIds[1]}`));
  await expect(generate()).toBeDisabled();
  await progress().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, 'running-detail-issue-1440.png') }); note();
}

async function correctionChecks(state) {
  step = 'replace-invalid-ticket-source-and-retry-the-original-unnumbered-run';
  await page.goto('/shipping'); await page.getByRole('button', { name: '本次发货与票号', exact: true }).click(); await page.getByRole('button', { name: '查看进度与处理', exact: true }).click();
  await expect(result()).toContainText('同一段包含不同国家'); await expect(generate()).toBeDisabled();
  await result().getByRole('button', { name: '修正清单并继续', exact: true }).click();
  const correction = page.getByRole('dialog', { name: '修正本次发货清单', exact: true });
  await expect(correction.getByLabel('第 3 行FBA 货件号', { exact: true })).toHaveValue(state.fbas[2]);
  await correction.getByRole('button', { name: '上传修正清单', exact: true }).click();
  // The API is intercepted, so these are literal upload bytes rather than a file
  // read from disk. Workbook parsing itself is covered by the real parser tests.
  await correction.getByLabel('需求文件', { exact: true }).setInputFiles({ name: 'corrected-fba.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('offline-corrected-workbook-fixture') });
  await expect.poll(() => state.retryBodies.length, { timeout: 15000 }).toBe(1);
  await expect(correction).not.toBeVisible();
  await expect.poll(() => state.currentStatus, { timeout: 15000 }).toBe('ready');
  await expect(await findGridRow(page, '本次发货商品表', '20261023-3-UK-1')).toContainText('20261023-3-UK-1'); await expect(generate()).toBeEnabled();
  assert.equal(state.replacementUploads, 1); assert.equal(state.createBodies.length, 0, 'a source correction must resume the original run rather than create another');
  assert.equal(state.detail('ready').run.id, state.runId); assert.equal(state.detail('ready').run.importId, state.replacementImportId);
  await productTable().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, 'corrected-original-run-1440.png') }); note();
}

async function allocationColumnChecks(state) {
  step = 'per-fba-box-columns-reset-to-one-with-five-columns-and-one-code-range-per-ticket';
  await page.goto('/shipping'); await page.getByRole('button', { name: '本次发货与票号', exact: true }).click(); await page.getByRole('button', { name: '查看发货表', exact: true }).click();
  await expect(productTable()).toHaveAttribute('data-row-count', '3');
  await expect(generate()).toBeEnabled();
  const headers = await (await selectGridRow(page, '本次发货商品表', 0)).locator('dt').allTextContents();
  const column = (name) => { const index = headers.indexOf(name); assert(index >= 0, `missing product column ${name}`); return index; };
  const expected = [
    ['15', '15', '—', '—', '—'],
    ['11', '11', '—', '—', '—'],
    ['9', '9', '—', '—', '—'],
  ];
  const expectedRanges = ['G7-G10', '', 'G11-G12'];
  const expectedQuantities = ['30', '22', '18'];
  assert.deepEqual(headers.filter((header) => /^箱 \d+$/.test(header)), ['箱 1', '箱 2', '箱 3', '箱 4', '箱 5']);
  for (let index = 0; index < 3; index++) {
    const row = await selectGridRow(page, '本次发货商品表', index), cells = row.locator('dd');
    await expect(cells.nth(column('FBA / 目的仓'))).toContainText(state.fbas[index]);
    await expect(cells.nth(column('商品数量'))).toHaveText(expectedQuantities[index]);
    await expect(cells.nth(column('整票编码范围'))).toHaveText(expectedRanges[index]);
    for (let order = 1; order <= 5; order++) await expect(cells.nth(column(`箱 ${order}`))).toHaveText(expected[index][order - 1]);
  }
  // Each FBA keeps separate local boxes 1/2 and all 70 accepted units, while
  // original G7-G12 codes remain independently visible in the box details.
  assert.equal(state.report().rows.reduce((total, row) => total + row.quantity, 0), 70);
  assert.equal(new Set(state.report().boxes.map((box) => box.demandId)).size, 3);
  await productTable().scrollIntoViewIfNeeded();
  await productTable().locator('canvas').dispatchEvent('wheel', { deltaX: 10000, deltaY: 0 });
  await page.screenshot({ path: resolve(evidence, 'per-fba-box-columns-1440.png') });
  await result().getByRole('button', { name: '逐箱明细', exact: true }).click();
  const boxTable = grid(result(), '本次发货逐箱表');
  await expect(boxTable).toHaveAttribute('data-row-count', '6');
  for (let index = 0; index < 3; index++) {
    for (let localOrder = 1; localOrder <= 2; localOrder++) {
      const displayOrder = 7 + index * 2 + localOrder - 1;
      const row = await selectGridRow(page, '本次发货逐箱表', index * 2 + localOrder - 1), cells = row.locator('dd');
      await expect(cells.nth(0)).toContainText(state.fbas[index]);
      await expect(cells.nth(1)).toHaveText(`箱 ${localOrder} · G${displayOrder}`);
      await expect(cells.nth(3)).toHaveText(String([15, 11, 9][index]));
    }
  }
  await boxTable.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidence, 'allocated-local-box-orders-1440.png') });
  assert.equal(state.createBodies.length, 0); assert.equal(state.exportBodies.length, 0); note();
}

try {
  await mkdir(evidence, { recursive: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = `http://127.0.0.1:${port}`;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  for (const [runChecks, needsReview, correction] of [[automaticChecks, false, false], [needsReviewChecks, true, false], [correctionChecks, true, true]]) {
    const state = fixture(needsReview, correction), context = await contextFor(state); await runChecks(state); await context.close();
  }
  for (const [runChecks, stage, status] of [[normalProgressChecks, 'sync', 'running'], [runningIssueChecks, 'confirmation', 'running'], [runningDetailIssueChecks, 'confirmation', 'running'], [readyBlockedChecks, 'ready', 'ready']]) {
    const state = progressFixture(stage, status), context = await contextFor(state); await runChecks(state); await context.close();
  }
  const displayState = allocationColumnFixture(), displayContext = await contextFor(displayState);
  await allocationColumnChecks(displayState); await displayContext.close();
  assert.deepEqual(fixtureErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-shipping-runs-browser', passed: !failed, checks, fixtureErrors, browserErrors, unexpectedRequests }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
