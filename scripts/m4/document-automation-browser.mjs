import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { documentCandidateListSchema, documentSchema, documentBoxFieldKey, withDocumentInvoiceDefaults,
  documentAutomationJobSchema, documentAutomationStartInputSchema, documentAutomationRetryInputSchema, documentAutomationSupplementInputSchema } from '../../packages/contracts/dist/index.js';
import { documentProductOverrideKey } from '../../apps/server/dist/modules/documents/workbook.js';
import { chooseOption } from '../shared/ui-controls.mjs';

// A local in-memory automation service. Its worker state can advance while the
// page is closed. Browser requests never contact real services or create files.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.DOCUMENT_AUTOMATION_EVIDENCE_DIR || resolve(root, '.local/m4/document-batch-preflight'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-25T07:00:00.000Z', week = '2026-10-19', uid = () => randomUUID();
const checks = [], browserErrors = [], unexpectedRequests = [], externalRequests = [], releases = [], writes = [];
let browser, page, viteProcess, baseURL, failed = false, step = 'setup';
const note = () => { checks.push({ name: step, passed: true }); console.log('PASS ' + step); };
const address = { addressCode: 'AUTO-ADDRESS', recipientName: 'Technical Receiver', recipientCompany: 'Fixture Company', addressLine1: '1 Automation Road',
  addressLine2: '', addressLine3: '', city: 'Technical City', state: 'CA', postalCode: '90001', countryCode: 'US', phone: '10000000000', email: '' };
function makeCandidate(run, index) {
  const demandId = uid(), groupId = uid(), shipmentId = uid(), boxId = uid(), m2 = uid(), sid = 101 + index, fba = 'FBAAUTO00' + index;
  const product = { msku: 'AUTO-' + index, fnsku: 'FN-' + index, sku: 'SKU-' + index, name: 'Technical product', quantity: '100', expiration: null, prepOwner: null, labelOwner: null };
  const demand = { id: demandId, snapshot: { sid, fba, shop: 'Technical Shop ' + index, country: '美国', channel: 'SEA', destinationFc: 'AUTO' + index,
    destinationAddress: '1 Automation Road, Technical City US', referenceQuantity: null, notes: null, subBatchName: null }, version: 1,
    businessDate: '2026-10-25', weekStartDate: week, weekEndDate: '2026-10-25', createdAt: now, updatedAt: now };
  const box = { id: boxId, externalBoxId: null, packageId: null, localBoxId: '1', name: null, order: 1, weight: '10', weightUnit: 'KG', length: '30', width: '20', height: '10', dimensionUnit: 'CM', items: [product] };
  const shipment = { id: shipmentId, demandId, version: 1, demandVersion: 1, data: { sid, fba, items: [product], boxes: [box], observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'Technical fixture', createdBy: 'fixture', createdAt: now };
  const codes = [{ id: uid(), groupId, demandId, boxId, prefix: String.fromCharCode(64 + index), sequence: 1, code: String.fromCharCode(64 + index) + '1', valid: true, createdAt: now }];
  const boxSource = [{ demandId, shipmentRevisionId: shipmentId, boxId, sid, fba, code: codes[0].code, order: 1, po: 'AUTO-PO-' + index, range: fba + 'U000001',
    raw: { weight: '10', weightUnit: 'KG', length: '30', width: '20', height: '10', dimensionUnit: 'CM' }, values: { weight: '10.00', length: '30.00', width: '20.00', height: '10.00' }, items: [product], sourceObservedAt: now }];
  return { shippingRunId: run.id, shippingRunMonth: run.month, shippingRunSequence: run.sequence, demandId, weekStartDate: week, weekEndDate: '2026-10-25', groupId, groupName: 'Automation Group ' + index,
    groupVersion: 1, groupStatus: 'confirmed', m2ConfirmationId: m2, demandVersion: 1, demand, shipment, codes, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null, physical: null,
    boxSource, sourceCandidates: { addresses: [{ source: 'getShipmentDetails', snapshotId: uid(), data: address }], products: [], issues: [] }, blockers: [] };
}
function member(candidate) {
  return { source: { weekStartDate: week, groupId: candidate.groupId, groupVersion: 1, m2ConfirmationId: candidate.m2ConfirmationId, demandId: candidate.demandId, demandVersion: 1,
    shipmentRevisionId: candidate.shipment.id, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null }, demand: structuredClone(candidate.demand), shipment: structuredClone(candidate.shipment),
    codes: structuredClone(candidate.codes), physical: null, boxSource: structuredClone(candidate.boxSource), sourceCandidates: structuredClone(candidate.sourceCandidates) };
}
function fixture() {
  const run = { id: uid(), version: 1, status: 'ready', stage: 'ready', numberingDate: '2026-10-25', month: '2026-10', sequence: 1, importId: null, parseRunId: null, origin: 'manual', membershipFrozenAt: now, error: null, createdAt: now, updatedAt: now };
  const candidates = [makeCandidate(run, 1), makeCandidate(run, 2)]; documentCandidateListSchema.parse({ items: candidates, total: 2, shippingRunId: run.id });
  const template = { id: uid(), purpose: 'invoice', name: 'Technical Automation Template', version: 1, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: 'a'.repeat(64), fileId: uid(), status: 'active', createdBy: 'fixture', createdAt: now };
  const profiles = [], records = candidates.map((candidate, index) => {
    const id = uid(), members = [member(candidate)], product = candidate.shipment.data.items[0];
    const profile = { id: uid(), category: 'product', key: 'AUTO-PRODUCT-' + index, version: 1, status: 'active', data: { sid: candidate.demand.snapshot.sid, ...product,
      englishName: 'Technical Product', chineseName: '技术商品', material: 'Glass', hsCode: '700719', use: 'Protect screen', brand: 'TECH', model: 'AUTO', unit: 'piece', salesLink: 'https://fixture.invalid/product' }, createdBy: 'fixture', createdAt: now }; profiles.push(profile);
    return documentSchema.parse({ id, purpose: 'invoice', status: 'draft', version: 1, createdBy: 'fixture', createdAt: now, updatedAt: now,
      currentRevision: { id: uid(), documentId: id, version: 1, reason: 'Technical automatic draft', createdBy: 'fixture', createdAt: now, data: { purpose: 'invoice', weekStartDate: week,
        shippingRunId: run.id, shippingRunMonth: run.month, shippingRunSequence: run.sequence, title: 'Automatic Invoice ' + (index + 1), generationRulesVersion: 'v2', members,
        fields: withDocumentInvoiceDefaults({ service: 'TECH SERVICE', customsMode: '普通报关', clearanceMode: '一般贸易清关', taxMode: '包税', ...address,
          addressSelectionMode: 'manual', addressConfirmed: 'true', addressConfirmationReason: 'Fixture explicitly checked address', addressAdoptionVersion: 'explicit/v1' }, members),
        profileReferences: [{ category: 'product', profileId: profile.id, version: 1, data: profile.data }], templateReference: { templateId: template.id, version: 1, sha256: template.sha256, fileId: template.fileId },
        productSourceFacts: [{ sid: candidate.demand.snapshot.sid, msku: product.msku, fnsku: product.fnsku, sku: product.sku, salesPrice: '20.00', unitPrice: '4.00', currency: 'USD', cartonQuantity: '100', sourceFileId: uid(), sourceSha256: 'b'.repeat(64), fetchedAt: now }] } } });
  });
  records[1].currentRevision.data.fields.city = 'Second Address City';
  const first = records[0].currentRevision.data.members[0], extra = structuredClone(first.shipment.data.boxes[0]); extra.id = uid(); extra.localBoxId = '2'; extra.order = 2; extra.weight = '11';
  first.shipment.data.items = first.shipment.data.items.map((item) => ({ ...item, quantity: '200' })); first.shipment.data.boxes.push(extra);
  first.codes.push({ ...first.codes[0], id: uid(), boxId: extra.id, code: 'A2', sequence: 2 }); first.boxSource.push({ ...structuredClone(first.boxSource[0]), boxId: extra.id, code: 'A2', order: 2, raw: { ...first.boxSource[0].raw, weight: '11' }, values: { ...first.boxSource[0].values, weight: '11.00' } });
  candidates[0].shipment = structuredClone(first.shipment); candidates[0].codes = structuredClone(first.codes); candidates[0].boxSource = structuredClone(first.boxSource);
  documentCandidateListSchema.parse({ items: candidates, total: 2, shippingRunId: run.id }); records.forEach((record) => documentSchema.parse(record));
  return { run, candidates, template, profiles, records, job: null, startInputs: [], retryInputs: [], supplementInputs: [], acceptedSupplements: [], supplementLedger: new Map(), supplementModes: [], holdSupplement: false, releaseSupplement: null, bundleGenerations: 0, sourceSnapshot: JSON.stringify(records.map((record) => record.currentRevision.data.members)),
    starts: new Map(), retries: new Map(), retryModes: [], retryAccepted: 0, showExisting: false, startMode: 'ready', holdStart: false, releaseStart: null, holdRetry: false, releaseRetry: null, jobReadModes: [], jobReads: 0, listReads: 0, downloads: 0 };
}
function syncJob(state, phase) {
  const job = state.job, counts = { total: job.items.length, queued: 0, running: 0, ready: 0, exporting: 0, completed: 0, blocked: 0 };
  for (const item of job.items) counts[item.status] += 1;
  Object.assign(job, { counts, phase, status: phase === 'needs_input' ? 'blocked' : phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed' : 'running',
    completedAt: phase === 'completed' ? now : null, version: job.version + 1 }); documentAutomationJobSchema.parse(job); return job;
}
function createJob(state, input) {
  const existing = input.documentId ? state.records.find((record) => record.id === input.documentId) : undefined;
  if (existing) assert.equal(input.expectedVersion, existing.version);
  const ids = existing?.currentRevision.data.members.map((member) => member.demand.id) ?? input.demandIds;
  const selected = state.candidates.filter((candidate) => !ids || ids.includes(candidate.demandId));
  state.job = documentAutomationJobSchema.parse({ id: uid(), mode: 'single_workbook', shippingRunId: state.run.id, version: 1, status: 'queued', phase: 'preparing', bundle: null, supplement: { descriptors: [], issues: [] },
    items: selected.map((candidate) => ({ id: uid(), demandIds: [candidate.demandId], fbas: [candidate.demand.snapshot.fba], documentId: existing?.id ?? null, documentVersion: existing?.version ?? null,
      exportId: null, fileId: null, stage: existing ? 'preview' : 'create', status: 'queued', issues: [], error: null, attempt: 1 })),
    counts: { total: selected.length, queued: selected.length, running: 0, ready: 0, exporting: 0, completed: 0, blocked: 0 }, createdAt: now, updatedAt: now, completedAt: null, error: null }); return state.job;
}
function recordFor(state, item) { return state.records.find((record) => record.currentRevision.data.members.some((member) => item.demandIds.includes(member.demand.id))); }
function definitions(state, onlyAddress = false) {
  const targets = (indexes, fieldKey) => indexes.map((index) => ({ itemId: state.job.items[index].id, documentId: recordFor(state, state.job.items[index]).id,
    expectedVersion: recordFor(state, state.job.items[index]).version, fieldKey }));
  const text = (id, label, scope, scopeLabel, indexes, key) => {
    const references = targets(indexes, key); return { id: id + '-v' + references.map((target) => target.expectedVersion).join('-'), label, kind: 'text', value: null, required: true, scope, scopeLabel, targets: references };
  };
  const documentFields = [text('address-city', '城市', 'document', 'FBAAUTO002 收件地址', [1], 'city'),
    text('address-reason', '地址核对原因', 'document', 'FBAAUTO002 收件地址', [1], 'addressConfirmationReason'),
    { ...text('address-confirm', '已核对并确认完整地址', 'document', 'FBAAUTO002 收件地址', [1], 'addressConfirmed'), kind: 'checkbox', value: false }];
  if (onlyAddress) return documentFields;
  const products = state.records.map((record) => record.currentRevision.data.members[0]);
  const prefix = (index) => 'product.' + documentProductOverrideKey(products[index].demand.snapshot.sid, products[index].shipment.data.items[0]) + '.';
  return [{ ...text('common-service', '渠道服务', 'common', '整批共用资料', [0, 1], 'service'), kind: 'select', options: [{ value: 'TECH SERVICE', label: 'TECH SERVICE' }, { value: 'OTHER SERVICE', label: 'OTHER SERVICE' }] },
    { ...text('common-tax', '税务方式', 'common', '整批共用资料', [0, 1], 'taxMode'), kind: 'select', options: [{ value: '包税', label: '包税' }, { value: '不包税', label: '不包税' }] },
    text('material-one', '材质', 'product', '商品 AUTO-1 · Technical Shop 1', [0], prefix(0) + 'material'),
    text('material-two', '材质', 'product', '商品 AUTO-2 · Technical Shop 2', [1], prefix(1) + 'material'),
    { ...text('box-one', '毛重（KG）', 'box', 'FBAAUTO001 · 箱 A1', [0], documentBoxFieldKey(products[0].shipment.data.boxes[0].id, 'weight')), kind: 'number' },
    { ...text('box-two', '长（CM）', 'box', 'FBAAUTO002 · 箱 B1', [1], documentBoxFieldKey(products[1].shipment.data.boxes[0].id, 'length')), kind: 'number' }, ...documentFields];
}
function rebuildRequirements(state) {
  const all = definitions(state, state.onlyAddress), missing = all.filter((descriptor) => descriptor.targets.some((target) => {
    const fields = state.records.find((record) => record.id === target.documentId).currentRevision.data.fields, value = fields[target.fieldKey];
    return descriptor.kind === 'checkbox' ? value !== 'true' : state.prefilledReason && target.fieldKey === 'addressConfirmationReason' && fields.addressConfirmed !== 'true' || !value?.trim();
  }));
  for (const descriptor of missing) { const values = descriptor.targets.map((target) => state.records.find((record) => record.id === target.documentId).currentRevision.data.fields[target.fieldKey] ?? null); descriptor.value = descriptor.kind === 'checkbox' ? values[0] === 'true' : values.every((value) => value === values[0]) ? values[0] : null; }
  state.job.supplement = { descriptors: missing, issues: [] };
  for (const item of state.job.items) {
    const record = recordFor(state, item), fields = missing.filter((descriptor) => descriptor.targets.some((target) => target.itemId === item.id));
    Object.assign(item, { documentId: record.id, documentVersion: record.version, stage: fields.length ? 'validate' : 'ready', status: fields.length ? 'blocked' : 'ready', issues: [], error: null });
    if (fields.length) { const issue = { code: 'DOCUMENT_FIELD_REQUIRED', severity: 'error', message: '本范围还有 ' + fields.length + ' 项资料待补齐。', itemId: item.id, documentId: record.id }; state.job.supplement.issues.push(issue); item.issues.push({ code: issue.code, severity: issue.severity, message: issue.message }); }
  }
  return syncJob(state, missing.length ? 'needs_input' : 'preparing');
}
function prepareMissing(state, onlyAddress = false) {
  state.onlyAddress = onlyAddress;
  for (const descriptor of definitions(state, onlyAddress)) for (const target of descriptor.targets) state.records.find((record) => record.id === target.documentId).currentRevision.data.fields[target.fieldKey] = descriptor.kind === 'checkbox' ? 'false' : '';
  return rebuildRequirements(state);
}
function ready(state) {
  assert.equal(state.job.supplement.descriptors.length, 0); for (const item of state.job.items) Object.assign(item, { stage: 'ready', status: 'ready', issues: [] }); return syncJob(state, 'ready');
}
function beginBundle(state) {
  assert.equal(state.job.phase, 'ready'); assert.equal(state.job.counts.ready, state.job.counts.total); state.bundleGenerations += 1;
  state.job.bundle = { status: 'running', fileId: null, fileName: null, sheetCount: null, completedAt: null, error: null };
  for (const item of state.job.items) Object.assign(item, { stage: 'export', status: 'exporting' }); return syncJob(state, 'generating');
}
function finishBundle(state) {
  assert.equal(state.job.phase, 'generating'); state.job.bundle = { status: 'completed', fileId: uid(), fileName: '整批发票-' + state.job.id.slice(0, 8) + '.xlsx', sheetCount: 2, completedAt: now, error: null };
  for (const item of state.job.items) { Object.assign(item, { stage: 'done', status: 'completed', issues: [{ code: 'CARTON_MIXED_CONTENTS', severity: 'warning', message: '混装箱已按代表商品输出，请下载整份 Excel 后核对修改。' }] }); recordFor(state, item).status = 'pending_review'; }
  return syncJob(state, 'completed');
}
function markReadyFailure(state) {
  const error = { code: 'FIXTURE_BUNDLE_FAILED', message: '技术夹具：所有范围已就绪，上次合并文件失败。' };
  state.job.bundle = { status: 'failed', fileId: null, fileName: null, sheetCount: null, completedAt: null, error }; state.job.error = error; return syncJob(state, 'failed');
}
function readyFailedFixture(count = 5) {
  const state = fixture();
  for (let index = state.records.length; index < count; index += 1) {
    const extra = fixture(), record = extra.records[0], candidate = extra.candidates[0], fba = 'FBAREADYRETRY' + (index + 1), member = record.currentRevision.data.members[0];
    record.currentRevision.data.title = 'Existing ready invoice ' + (index + 1); record.currentRevision.data.shippingRunId = state.run.id;
    member.demand.snapshot.fba = fba; member.shipment.data.fba = fba; for (const box of member.boxSource) box.fba = fba;
    record.currentRevision.data.templateReference = { templateId: state.template.id, version: state.template.version, sha256: state.template.sha256, fileId: state.template.fileId };
    candidate.shippingRunId = state.run.id; candidate.demand.snapshot.fba = fba; candidate.shipment.data.fba = fba; for (const box of candidate.boxSource) box.fba = fba;
    state.records.push(record); state.candidates.push(candidate); state.profiles.push(extra.profiles[0]);
  }
  createJob(state, { shippingRunId: state.run.id, demandIds: count ? state.candidates.map((candidate) => candidate.demandId) : [] });
  for (const item of state.job.items) { const record = recordFor(state, item); item.documentId = record.id; item.documentVersion = record.version; }
  ready(state); markReadyFailure(state); state.readyRetry = true; state.sourceSnapshot = JSON.stringify(state.records.map((record) => record.currentRevision)); return state;
}
async function setup(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseURL) { externalRequests.push(method + ' ' + url.href); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (method !== 'GET') writes.push({ method, path, input: request.postDataJSON() });
    if (path === '/api/v1/session') return json({ user: { id: 'automation-browser', name: 'Batch workbook fixture', email: 'automation@fixture.invalid', role: 'admin' } });
    if (path === '/api/v1/shipping-runs') return json({ items: [state.run] });
    if (path === '/api/v1/documents/candidates') return json({ items: state.candidates, total: state.candidates.length, shippingRunId: state.run.id });
    if (path === '/api/v1/documents/field-options') return json({ services: ['TECH SERVICE'] });
    if (path === '/api/v1/document-profiles') return json({ items: state.profiles });
    if (path === '/api/v1/document-templates') return json({ items: [state.template] });
    if (path === '/api/v1/documents' && method === 'GET') return json({ items: state.job || state.showExisting ? state.records : [], total: state.job || state.showExisting ? state.records.length : 0, page: 1, pageSize: 20 });
    const base = '/api/v1/documents/automations';
    if (path === base && method === 'GET') { state.listReads += 1; return json({ items: state.job ? [state.job] : [] }); }
    if (path === base && method === 'POST') {
      const input = documentAutomationStartInputSchema.parse(request.postDataJSON()); state.startInputs.push(input); assert.equal(input.shippingRunId, state.run.id);
      let job = state.starts.get(input.operationId); const replayed = Boolean(job); if (!job) { job = createJob(state, input); state.starts.set(input.operationId, job); }
      if (state.holdStart) await new Promise((release) => { state.releaseStart = () => { state.holdStart = false; release(); }; releases.push(state.releaseStart); });
      if (state.startMode === 'drop-once') { state.startMode = 'ready'; return route.abort('failed'); }
      return json({ job, replayed }, 202);
    }
    if (state.job && (path === base + '/' + state.job.id || path === base + '/' + state.job.id + '/requirements') && method === 'GET') {
      state.jobReads += 1;
      if (path === base + '/' + state.job.id && state.jobReadModes.shift() === '503') return json({ error: { code: 'FIXTURE_JOB_READ_FAILED', message: '技术夹具：整批任务读取暂时失败。' } }, 503);
      return json({ job: documentAutomationJobSchema.parse(state.job) });
    }
    if (state.job && path === base + '/' + state.job.id + '/supplement' && method === 'POST') {
      const input = documentAutomationSupplementInputSchema.parse(request.postDataJSON()); state.supplementInputs.push(input);
      if (state.holdSupplement) await new Promise((release) => { state.releaseSupplement = () => { state.holdSupplement = false; release(); }; releases.push(state.releaseSupplement); });
      const replay = state.supplementLedger.get(input.operationId); if (replay) return json({ job: replay, replayed: true });
      const mode = state.supplementModes.shift();
      if (mode === '409') { const record = state.records[0]; record.version += 1; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version, data: { ...record.currentRevision.data, fields: { ...record.currentRevision.data.fields, remarks: 'OTHER-USER-SERVER-NOTE' } } }; rebuildRequirements(state); }
      if (mode === '503' || mode === '409') return json({ error: { code: mode === '409' ? 'DOCUMENT_AUTOMATION_VERSION_CONFLICT' : 'FIXTURE_SUPPLEMENT_FAILED', message: mode === '409' ? '技术夹具：批次版本冲突，本次填写已保留。' : '技术夹具：整批保存失败，本次填写已保留。' } }, Number(mode));
      assert.equal(input.expectedVersion, state.job.version); const changed = new Set(), staged = new Map(state.records.map((record) => [record.id, structuredClone(record)]));
      for (const entry of input.values.filter((entry) => entry.value === true)) {
        const confirmation = state.job.supplement.descriptors.find((descriptor) => descriptor.id === entry.id);
        for (const target of confirmation?.targets.filter((target) => target.fieldKey === 'addressConfirmed') ?? []) {
          const reason = input.values.find((candidate) => typeof candidate.value === 'string' && candidate.value.trim() && state.job.supplement.descriptors.find((descriptor) => descriptor.id === candidate.id)?.targets.some((reference) => reference.documentId === target.documentId && reference.fieldKey === 'addressConfirmationReason'));
          if (!reason) return json({ error: { code: 'DOCUMENT_ADDRESS_CONFIRMATION_REASON_REQUIRED', message: '确认地址时须在同一次提交中携带真实核对原因。' } }, 422);
        }
      }
      for (const entry of input.values) {
        const descriptor = state.job.supplement.descriptors.find((descriptor) => descriptor.id === entry.id); assert(descriptor, 'Only current missing-field descriptors may be submitted');
        for (const target of descriptor.targets) {
          const record = state.records.find((record) => record.id === target.documentId); assert.equal(input.documentVersions[record.id], record.version);
          const next = typeof entry.value === 'boolean' ? String(entry.value) : entry.value;
          if ((record.currentRevision.data.fields[target.fieldKey] ?? null) !== next) { staged.get(record.id).currentRevision.data.fields[target.fieldKey] = next; changed.add(record.id); }
        }
      }
      for (const id of changed) { const record = staged.get(id); record.version += 1; record.currentRevision = { ...record.currentRevision, id: uid(), version: record.version }; state.records[state.records.findIndex((old) => old.id === id)] = record; }
      state.acceptedSupplements.push(structuredClone(input)); rebuildRequirements(state); state.supplementLedger.set(input.operationId, structuredClone(state.job)); return json({ job: state.job, replayed: false });
    }
    if (state.job && path === base + '/' + state.job.id + '/retry' && method === 'POST') {
      const input = documentAutomationRetryInputSchema.parse(request.postDataJSON()); state.retryInputs.push(input);
      if (state.holdRetry) await new Promise((release) => { state.releaseRetry = () => { state.holdRetry = false; release(); }; releases.push(state.releaseRetry); });
      const replay = state.retries.get(input.operationId); if (replay) return json({ job: replay, replayed: true });
      assert.equal(input.expectedVersion, state.job.version); const mode = state.retryModes.shift();
      if (mode === '503') return json({ error: { code: 'FIXTURE_RETRY_FAILED', message: '技术夹具：生成请求响应暂时失败。' } }, 503);
      for (const item of state.job.items) { item.attempt += 1; item.status = state.readyRetry ? 'ready' : 'queued'; }
      state.retryAccepted += 1; state.job.bundle = null; state.job.error = null; syncJob(state, state.readyRetry ? 'ready' : 'preparing'); state.retries.set(input.operationId, structuredClone(state.job));
      // The command committed but its response was lost; a replay must precede the version guard.
      if (mode === '503-accepted') return json({ error: { code: 'FIXTURE_RETRY_FAILED', message: '技术夹具：生成请求响应暂时失败。' } }, 503);
      return json({ job: state.job, replayed: false }, 202);
    }
    if (state.job && path === base + '/' + state.job.id + '/download' && method === 'GET') {
      state.downloads += 1; assert.equal(state.job.phase, 'completed'); assert.equal(state.job.bundle.status, 'completed');
      return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'content-disposition': 'attachment; filename="technical-whole-batch.xlsx"' }, body: Buffer.from('Local bundle download fixture only') });
    }
    const detail = path.match(/^\/api\/v1\/documents\/([^/]+)$/), record = state.records.find((record) => record.id === detail?.[1]);
    if (record && method === 'GET') return json({ document: record, validation: null, exports: [] });
    unexpectedRequests.push(method + ' ' + path); return json({ error: { code: 'UNEXPECTED_FIXTURE_ROUTE', message: method + ' ' + path } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', (error) => browserErrors.push(error.message)); return context;
}
const wizard = () => page.getByRole('dialog', { name: '发票与单据向导', exact: true });
const jobDialog = () => page.getByRole('dialog', { name: '整批检查与合并出单', exact: true });
const dashboard = () => page.getByRole('region', { name: '自动出单任务', exact: true });
const recent = () => page.getByRole('region', { name: '最近自动出单任务', exact: true });
const startButton = () => wizard().getByRole('button', { name: '自动生成发票', exact: true });
const nextSourceButton = () => wizard().getByRole('button', { name: '下一步：出单资料', exact: true });
const requirementForm = () => dashboard().getByRole('region', { name: '统一补充资料', exact: true });
const field = (id) => requirementForm().locator('[data-automation-field^="' + id + '-v"]');
const saveButton = () => jobDialog().getByRole('button', { name: '保存并统一检查', exact: true });
const downloadButton = () => dashboard().getByRole('button', { name: /下载.*(整批|XLSX)/ });
const generateButton = () => jobDialog().getByRole('button', { name: '生成发票文件', exact: true });
async function openNew(state) {
  await page.goto('/shipping?view=documents', { waitUntil: 'domcontentloaded', timeout: 30_000 }); await page.getByRole('button', { name: '制作发票', exact: true }).click();
  await chooseOption(wizard().getByLabel('发货次', { exact: true }), state.run.id); await wizard().getByRole('button', { name: '读取货件', exact: true }).click();
}
async function toPrefill(state) {
  await nextSourceButton().click(); await expect(wizard().getByRole('heading', { name: '出单资料', exact: true })).toBeVisible();
  assert.equal(state.startInputs.length, 0, 'Advancing to optional details must not create an automation task'); await expect(startButton()).toBeEnabled();
}
async function start(state) { await openNew(state); await wizard().getByLabel('选择当前列表', { exact: true }).check(); await toPrefill(state); await startButton().click(); await expect(dashboard()).toBeVisible(); }
async function openJob() {
  await page.goto('/shipping?view=documents', { waitUntil: 'domcontentloaded', timeout: 30_000 }); await expect(recent()).toBeVisible();
  await recent().getByRole('button', { name: '查看进度', exact: true }).first().click(); await expect(dashboard()).toBeVisible();
}
async function openMissing() {
  const trigger = dashboard().getByRole('button', { name: /^(统一补充资料|集中补充资料|补充整批资料)$/ });
  await expect.poll(async () => await requirementForm().isVisible() || await trigger.count() > 0).toBe(true); if (await trigger.count()) await trigger.first().click();
  await expect(requirementForm()).toBeVisible(); await expect(wizard()).not.toBeVisible(); await expect(page.locator('dialog[open]')).toHaveCount(1);
}
async function set(id, value) {
  const wrapper = field(id); await expect(wrapper).toHaveCount(1);
  if (typeof value === 'boolean') await wrapper.getByRole('checkbox').setChecked(value);
  else if (await wrapper.getByRole('combobox').count()) await chooseOption(wrapper.getByRole('combobox'), value);
  else await wrapper.locator('input:not([type="checkbox"]),textarea').first().fill(value);
}
async function expectValue(id, value) {
  const wrapper = field(id); if (typeof value === 'boolean') return value ? expect(wrapper.getByRole('checkbox')).toBeChecked() : expect(wrapper.getByRole('checkbox')).not.toBeChecked();
  const select = wrapper.getByRole('combobox'); if (await select.count()) await expect(select).toHaveAttribute('data-value', value);
  else await expect(wrapper.locator('input:not([type="checkbox"]),textarea').first()).toHaveValue(value);
}
const values = { 'common-service': 'TECH SERVICE', 'common-tax': '包税', 'material-one': 'Glass A', 'material-two': 'Plastic B', 'box-one': '12.34', 'box-two': '65.43',
  'address-city': 'User supplied City', 'address-reason': 'Explicitly checked the complete batch address', 'address-confirm': true };
async function fillAll() { for (const [id, value] of Object.entries(values)) if (await field(id).count()) await set(id, value); }
function noIndividualPipeline() { assert(!writes.some((write) => /\/(lingxing-preview|lingxing-apply|validate|exports|review|revisions)$/.test(write.path))); }
async function noOutput(state, generations = 0) {
  assert.equal(state.bundleGenerations, generations); assert.equal(state.downloads, 0);
  for (const button of await downloadButton().all()) await expect(button).toBeDisabled(); noIndividualPipeline();
}
async function screenshot(name) { await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' }); }
function satisfyAll(state) {
  for (const descriptor of state.job.supplement.descriptors) {
    const id = descriptor.id.replace(/-v[0-9-]+$/, ''), value = values[id];
    for (const target of descriptor.targets) state.records.find((record) => record.id === target.documentId).currentRevision.data.fields[target.fieldKey] = typeof value === 'boolean' ? String(value) : value;
  }
  rebuildRequirements(state);
}

try {
  await mkdir(evidence, { recursive: true }); const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done)); baseURL = 'http://127.0.0.1:' + port;
  viteProcess = spawn(process.execPath, [resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 30_000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });

  step = 'one-start-covers-all-selected-shipments-and-synchronous-guard-blocks-double-clicks';
  const first = fixture(); first.holdStart = true; let context = await setup(first); await openNew(first); await expect(nextSourceButton()).toBeDisabled(); await expect(startButton()).toHaveCount(0);
  await wizard().getByLabel('选择当前列表', { exact: true }).check(); await toPrefill(first);
  await expect(wizard().getByLabel('任务名称（可选）', { exact: true })).toHaveValue(''); await expect(wizard().getByLabel('渠道服务', { exact: true })).toHaveAttribute('data-value', '');
  await startButton().evaluate((node) => { node.click(); node.click(); });
  await expect.poll(() => first.startInputs.length).toBe(1); await expect(startButton()).toBeDisabled(); assert.deepEqual(new Set(first.startInputs[0].demandIds), new Set(first.candidates.map((candidate) => candidate.demandId)));
  assert.equal(first.startInputs[0].title, undefined); assert.equal(first.startInputs[0].fields?.service, undefined, 'Empty optional details still allow an explicit final start');
  first.releaseStart(); await expect(dashboard()).toBeVisible(); assert.equal(first.job.mode, 'single_workbook'); await noOutput(first); note();

  step = 'one-ready-range-and-one-blocked-range-cannot-create-or-download-any-workbook';
  prepareMissing(first, true); await openMissing(); await expect(field('address-city')).toBeVisible(); assert.equal(first.job.counts.ready, 1); assert.equal(first.job.counts.blocked, 1);
  await expect(dashboard().getByRole('button', { name: '补充资料', exact: true })).toHaveCount(0); await expect(generateButton()).toHaveCount(0); await expect(jobDialog().getByRole('button', { name: '重新统一检查', exact: true })).toBeVisible(); await noOutput(first); await screenshot('document-preflight-barrier-1440.png'); note();

  step = 'closing-and-refreshing-finds-the-same-preflight-task-without-starting-it-again';
  await jobDialog().getByRole('button', { name: '关闭整批检查与合并出单', exact: true }).click(); await openJob(); await openMissing();
  await expect(field('address-city')).toBeVisible(); assert.equal(first.startInputs.length, 1); await noOutput(first); await context.close(); note();

  step = 'one-central-form-groups-common-product-box-and-address-fields-with-distinct-targets';
  const batch = fixture(); context = await setup(batch); await start(batch); prepareMissing(batch); await openMissing();
  await expect(field('common-service')).toHaveCount(1); await expect(field('common-tax')).toHaveCount(1);
  for (const id of ['material-one', 'material-two', 'box-one', 'box-two', 'address-city', 'address-reason', 'address-confirm']) await expect(field(id)).toHaveCount(1);
  await expect(requirementForm()).toContainText('商品 AUTO-1'); await expect(requirementForm()).toContainText('商品 AUTO-2'); await expect(requirementForm()).toContainText('箱 A1'); await expect(requirementForm()).toContainText('箱 B1'); await noOutput(batch); note();

  step = 'failed-atomic-save-retains-the-whole-form-and-retry-reuses-the-exact-operation';
  batch.supplementModes.push('503'); batch.holdSupplement = true; await set('common-service', values['common-service']);
  await saveButton().evaluate((node) => { node.click(); node.click(); }); await expect.poll(() => batch.supplementInputs.length).toBe(1); await expect(saveButton()).toBeDisabled();
  for (const record of batch.records) assert.equal(record.currentRevision.data.fields.service, ''); batch.releaseSupplement(); await expect(dashboard()).toContainText('整批保存失败'); await expectValue('common-service', values['common-service']);
  assert.equal(batch.acceptedSupplements.length, 0); await noOutput(batch); const original = structuredClone(batch.supplementInputs[0]); await saveButton().click();
  await expect.poll(() => batch.acceptedSupplements.length).toBe(1); assert.deepEqual(batch.supplementInputs[1], original); note();

  step = 'a-partial-save-applies-the-common-value-once-to-both-targets-and-stays-in-preflight';
  for (const record of batch.records) assert.equal(record.currentRevision.data.fields.service, 'TECH SERVICE'); assert.equal(batch.job.phase, 'needs_input');
  await expect(field('common-service')).toHaveCount(0); await expect(field('common-tax')).toBeVisible(); assert.equal(batch.job.counts.completed, 0); await noOutput(batch);
  await jobDialog().getByRole('button', { name: '关闭整批检查与合并出单', exact: true }).click(); await openJob(); await openMissing();
  await expect(field('common-service')).toHaveCount(0); for (const record of batch.records) assert.equal(record.currentRevision.data.fields.service, 'TECH SERVICE'); assert.equal(batch.startInputs.length, 1); note();

  step = 'all-targeted-product-box-and-address-values-save-without-changing-other-fields-or-sources';
  const descriptors = structuredClone(batch.job.supplement.descriptors); await fillAll(); await saveButton().click(); await expect.poll(() => batch.acceptedSupplements.length).toBe(2);
  for (const descriptor of descriptors) { const id = descriptor.id.replace(/-v[0-9-]+$/, ''); for (const target of descriptor.targets) assert.equal(batch.records.find((record) => record.id === target.documentId).currentRevision.data.fields[target.fieldKey], typeof values[id] === 'boolean' ? String(values[id]) : values[id]); }
  const untouchedBox = batch.records[0].currentRevision.data.members[0].shipment.data.boxes[1]; assert.equal(batch.records[0].currentRevision.data.fields[documentBoxFieldKey(untouchedBox.id, 'weight')], undefined);
  assert.equal(JSON.stringify(batch.records.map((record) => record.currentRevision.data.members)), batch.sourceSnapshot); assert.equal(batch.job.phase, 'preparing'); await noOutput(batch); note();

  step = 'all-ranges-must-pass-recheck-before-one-bundle-download-becomes-available';
  ready(batch); await jobDialog().getByRole('button', { name: '刷新自动出单进度', exact: true }).click(); await expect(dashboard().getByRole('heading', { name: '整批检查通过', exact: true })).toBeVisible(); await noOutput(batch);
  beginBundle(batch); await expect(dashboard().getByRole('heading', { name: '正在生成合并文件', exact: true })).toBeVisible(); await noOutput(batch, 1);
  finishBundle(batch); await expect(downloadButton()).toHaveCount(1); await expect(downloadButton()).toBeEnabled(); await jobDialog().locator(':scope > .import-dialog-body').evaluate((node) => { node.scrollTop = 0; }); await screenshot('document-bundle-completed-1440.png');
  const download = page.waitForEvent('download'); await downloadButton().click(); await download; assert.equal(batch.downloads, 1); assert.equal(batch.bundleGenerations, 1); assert.equal(batch.job.bundle.sheetCount, 2);
  assert(batch.records.every((record) => record.status === 'pending_review')); noIndividualPipeline(); await context.close(); note();

  step = 'version-conflict-keeps-every-entered-value-and-never-commits-or-generates';
  const conflict = fixture(); context = await setup(conflict); await start(conflict); prepareMissing(conflict); await openMissing(); await fillAll(); conflict.supplementModes.push('409');
  await saveButton().click(); await expect(dashboard()).toContainText('批次版本冲突'); for (const [id, value] of Object.entries(values)) await expectValue(id, value);
  assert.equal(conflict.acceptedSupplements.length, 0); await noOutput(conflict);
  await jobDialog().getByRole('button', { name: '刷新自动出单进度', exact: true }).click(); await expect(jobDialog().getByRole('button', { name: '已核对新版，保留填写继续', exact: true })).toBeVisible();
  for (const [id, value] of Object.entries(values)) await expectValue(id, value); await expect(saveButton()).toBeDisabled();
  await jobDialog().getByRole('button', { name: '已核对新版，保留填写继续', exact: true }).click(); await expect(saveButton()).toBeEnabled(); await saveButton().click();
  await expect.poll(() => conflict.acceptedSupplements.length).toBe(1); assert.equal(conflict.records[0].currentRevision.data.fields.remarks, 'OTHER-USER-SERVER-NOTE'); assert.equal(conflict.job.phase, 'preparing'); await noOutput(conflict); await context.close(); note();

  step = 'checking-address-confirmation-includes-the-visible-existing-reason-without-inventing-one';
  const confirmation = fixture(); context = await setup(confirmation); await start(confirmation); confirmation.onlyAddress = true; confirmation.prefilledReason = true;
  const originalReason = 'Existing explicitly supplied address check reason'; confirmation.records[1].currentRevision.data.fields.addressConfirmed = 'false'; confirmation.records[1].currentRevision.data.fields.addressConfirmationReason = originalReason;
  rebuildRequirements(confirmation); await openMissing(); await expectValue('address-reason', originalReason); await expectValue('address-confirm', false); await set('address-confirm', true); await saveButton().click();
  await expect.poll(() => confirmation.acceptedSupplements.length).toBe(1); const submitted = confirmation.acceptedSupplements[0].values;
  assert(submitted.some((entry) => entry.id.startsWith('address-reason-v') && entry.value === originalReason)); assert(submitted.some((entry) => entry.id.startsWith('address-confirm-v') && entry.value === true));
  assert.equal(confirmation.records[1].currentRevision.data.fields.addressConfirmationReason, originalReason); assert.equal(confirmation.records[1].currentRevision.data.fields.addressConfirmed, 'true'); await noOutput(confirmation); await context.close(); note();

  step = 'a-main-job-refresh-error-keeps-dirty-common-and-product-input-mounted-through-recovery';
  const refreshError = fixture(); context = await setup(refreshError); await start(refreshError); prepareMissing(refreshError); await openMissing();
  await set('common-service', 'OTHER SERVICE'); await set('material-one', 'UNSAVED EXACT MATERIAL'); refreshError.jobReadModes.push('503');
  await jobDialog().getByRole('button', { name: '刷新自动出单进度', exact: true }).click(); await expect(jobDialog()).toContainText('整批任务读取暂时失败');
  await expect(requirementForm()).toBeVisible(); await expectValue('common-service', 'OTHER SERVICE'); await expectValue('material-one', 'UNSAVED EXACT MATERIAL');
  await jobDialog().getByRole('button', { name: '重试', exact: true }).click(); await expect(jobDialog()).not.toContainText('整批任务读取暂时失败');
  await expectValue('common-service', 'OTHER SERVICE'); await expectValue('material-one', 'UNSAVED EXACT MATERIAL'); await expect(saveButton()).toBeEnabled();
  assert.equal(refreshError.acceptedSupplements.length, 0); await noOutput(refreshError); await context.close(); note();

  step = 'a-lost-start-response-retries-the-same-operation-and-recovers-one-task';
  const lost = fixture(); lost.startMode = 'drop-once'; context = await setup(lost); await openNew(lost); await wizard().getByLabel('选择当前列表', { exact: true }).check(); await toPrefill(lost); await startButton().click();
  await expect(startButton()).toBeEnabled(); await startButton().click(); await expect(dashboard()).toBeVisible(); assert.equal(lost.startInputs.length, 2); assert.equal(lost.starts.size, 1); assert.equal(lost.startInputs[0].operationId, lost.startInputs[1].operationId); await context.close(); note();

  step = 'a-closed-page-can-return-to-one-completed-bundle-without-restarting-the-job';
  const detached = fixture(); context = await setup(detached); await start(detached); prepareMissing(detached); await page.goto('about:blank'); satisfyAll(detached); ready(detached); beginBundle(detached); finishBundle(detached);
  await openJob(); await expect(downloadButton()).toHaveCount(1); assert.equal(detached.startInputs.length, 1); assert.equal(detached.retryInputs.length, 0); assert.equal(detached.bundleGenerations, 1); await context.close(); note();

  step = 'existing-draft-version-pinning-and-old-document-links-remain-compatible';
  const old = fixture(); old.showExisting = true; context = await setup(old); await page.goto('/shipping?view=documents&documentId=' + old.records[0].id, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(wizard().getByRole('navigation', { name: '单据制作步骤', exact: true })).toBeVisible(); assert.equal(old.startInputs.length, 0); await context.close();
  context = await setup(old); await page.goto('/shipping?view=documents', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.document-list-panel tbody tr').filter({ hasText: old.records[0].currentRevision.data.title }).getByRole('button', { name: '自动生成发票', exact: true }).click();
  await expect(dashboard()).toBeVisible(); assert.equal(old.startInputs[0].documentId, old.records[0].id); assert.equal(old.startInputs[0].expectedVersion, 1); assert.equal(old.startInputs[0].demandIds, undefined); await context.close(); note();

  step = 'five-ready-ranges-retry-generation-on-the-existing-job-with-one-operation-and-one-bundle';
  const generate = readyFailedFixture(); context = await setup(generate); const originalJob = generate.job.id, originalVersion = generate.job.version;
  await openJob(); await expect(dashboard()).toContainText('5 / 5 组检查通过'); await expect(generateButton()).toBeEnabled(); await expect(jobDialog().getByRole('button', { name: '重新统一检查', exact: true })).toHaveCount(0);
  for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await jobDialog().locator(':scope > .import-dialog-body').evaluate((node) => { node.scrollTop = 0; }); await expect(generateButton()).toBeInViewport(); await screenshot('document-ready-generation-' + width + '.png'); }
  await page.setViewportSize({ width: 1440, height: 1000 }); generate.retryModes.push('503-accepted'); generate.holdRetry = true;
  await generateButton().evaluate((node) => { node.click(); node.click(); }); await expect.poll(() => generate.retryInputs.length).toBe(1); await expect.poll(() => typeof generate.releaseRetry).toBe('function'); await expect(generateButton()).toBeDisabled();
  generate.releaseRetry(); await expect(jobDialog()).toContainText('生成请求响应暂时失败'); assert.equal(generate.retryAccepted, 1); assert.equal(generate.startInputs.length, 0);
  // The failed worker result gets a newer diagnostic version while the accepted request is unresolved in the UI.
  markReadyFailure(generate); await jobDialog().getByRole('button', { name: '刷新自动出单进度', exact: true }).click(); await expect(generateButton()).toBeEnabled();
  await generateButton().click(); await expect.poll(() => generate.retryInputs.length).toBe(2); assert.deepEqual(generate.retryInputs[1], generate.retryInputs[0]); assert.equal(generate.retryInputs[1].expectedVersion, originalVersion); assert.equal(generate.retryInputs[1].itemIds, undefined);
  await expect.poll(() => generate.retryAccepted).toBe(1); ready(generate); beginBundle(generate); finishBundle(generate); await expect(downloadButton()).toHaveCount(1); await expect(downloadButton()).toBeEnabled();
  const generatedDownload = page.waitForEvent('download'); await downloadButton().click(); await generatedDownload; assert.equal(generate.job.id, originalJob); assert.equal(generate.startInputs.length, 0); assert.equal(generate.records.length, 5); assert.equal(generate.acceptedSupplements.length, 0); assert.equal(generate.bundleGenerations, 1); assert.equal(generate.downloads, 1);
  assert.equal(JSON.stringify(generate.records.map((record) => record.currentRevision)), generate.sourceSnapshot); await context.close(); note();

  step = 'direct-generation-is-disabled-by-dirty-busy-or-read-error-and-hidden-for-running-or-zero-ready';
  const dirty = readyFailedFixture(); prepareMissing(dirty); context = await setup(dirty); await openJob(); await openMissing(); await set('common-service', 'TECH SERVICE'); satisfyAll(dirty); ready(dirty); markReadyFailure(dirty);
  await jobDialog().getByRole('button', { name: '刷新自动出单进度', exact: true }).click(); await expect(generateButton()).toBeDisabled(); await generateButton().evaluate((node) => node.click()); assert.equal(dirty.retryInputs.length, 0);
  await jobDialog().getByRole('button', { name: '放弃本次未保存填写', exact: true }).click(); await expect(generateButton()).toBeEnabled(); await context.close();
  const readError = readyFailedFixture(); context = await setup(readError); await openJob(); readError.jobReadModes.push('503'); await jobDialog().getByRole('button', { name: '刷新自动出单进度', exact: true }).click(); await expect(jobDialog()).toContainText('整批任务读取暂时失败'); await expect(generateButton()).toBeDisabled();
  await jobDialog().getByRole('button', { name: '重试', exact: true }).click(); await expect(generateButton()).toBeEnabled(); ready(readError); await jobDialog().getByRole('button', { name: '刷新自动出单进度', exact: true }).click(); await expect(dashboard().getByRole('heading', { name: '整批检查通过', exact: true })).toBeVisible(); await expect(generateButton()).toHaveCount(0); assert.equal(readError.retryInputs.length, 0); await context.close();
  const empty = readyFailedFixture(0); context = await setup(empty); await openJob(); await expect(generateButton()).toHaveCount(0); assert.equal(empty.retryInputs.length, 0); await context.close(); note();

  step = 'the-unified-missing-field-page-fits-wide-and-narrow-viewports';
  const layout = fixture(); context = await setup(layout); await start(layout); prepareMissing(layout); await openMissing();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await fillAll(); await requirementForm().evaluate((node) => { const body = node.closest('.import-dialog-body'); if (body) body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 16; });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await expect(jobDialog().getByRole('heading', { name: '整批检查与合并出单', exact: true })).toBeInViewport(); assert.equal(await jobDialog().evaluate((node) => node.scrollTop), 0);
    for (const control of await requirementForm().locator('input,button[role="combobox"]').all()) { const bounds = await control.boundingBox(); assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1); }
    await screenshot('document-preflight-' + width + '.png');
  }
  await context.close(); note(); noIndividualPipeline(); assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(externalRequests, []);
} catch (error) { failed = true; checks.push({ name: step, passed: false, message: error.message }); console.error(error.stack || error); if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { releases.forEach((release) => release()); await browser?.close(); if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); } await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-document-batch-preflight-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests, writes, realBusinessWrites: 0 }, null, 2) + '\n'); }
if (failed) process.exitCode = 1;
