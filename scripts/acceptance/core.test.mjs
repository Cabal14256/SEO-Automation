import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { appModules, batchPackage, combinePages, compareDiff, compareRows, deriveDiff, json, putJson, recordSignoff, root, seal, verifyImportObservations, verifyPackage } from './core.mjs';
import { capture } from './cli.mjs';

const mapping = { sourceShop: '甲店', sid: 1, country: '美国', confirmedBy: '业务核对人', confirmedAt: '2026-10-17T00:00:00Z' };
const sourceRow = (fba, quantity, number, overrides = {}) => ({ sheetName: '需求导入', rowNumber: number, rawCells: [{ address: `E${number}` }], issues: [], normalized: { shop: '甲店', country: '美国', fba, referenceQuantity: quantity, channel: '空运', destinationFc: 'FC1', notes: null, subBatchName: null, ...overrides } });
async function temporary(fn) { const directory = await mkdtemp(join(tmpdir(), 'scm-acceptance-')); try { return await fn(directory); } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')); await rm(directory, { recursive: true, force: true }); } }

test('sid+FBA diff preserves duplicate evidence, content rules and full-snapshot missing hints', () => {
  const before = [sourceRow('FBA1', '1', 2), sourceRow('FBA2', '2', 3), sourceRow('FBA3', '3', 4)];
  const after = [sourceRow('FBA1', '1', 2, { sourceDate: 'changed-date', shop: ' 甲店 ' }), sourceRow('FBA2', '4', 3), sourceRow('FBA4', '0', 4), sourceRow('FBA4', '0', 5), sourceRow('FBA5', '1', 6), sourceRow('FBA5', '2', 7)];
  const result = deriveDiff(before, after, [mapping]);
  assert.deepEqual(result.counts, { new: 1, unchanged: 1, changed: 1, conflict: 1, error: 0, missing: 1 });
  assert.deepEqual(result.items.find((r) => r.fba === 'FBA2').changedFields, ['referenceQuantity']);
  assert.equal(result.items.find((r) => r.fba === 'FBA4').sources.length, 2);
  assert.equal(result.items.find((r) => r.kind === 'missing').action, '仅提示，不撤销需求');
  assert.equal(compareDiff(result.items, [...result.items].reverse()), true);
});

test('delta and unresolved identities cannot falsely infer deletion; country conflicts remain visible', () => {
  const before = [sourceRow('FBA1', '1', 2)], after = [sourceRow('FBA2', '1', 3, { country: '英国' })];
  const unresolved = deriveDiff(before, after, [mapping]); assert.equal(unresolved.missingDeferred, true); assert.equal(unresolved.counts.missing, 0); assert.equal(unresolved.counts.error, 1);
  const delta = deriveDiff(before, [], [mapping], 'delta'); assert.equal(delta.counts.missing, 0);
  assert.throws(() => deriveDiff(before, after, [mapping, mapping]), /重复店铺确认/);
});

test('pagination rejects missing/duplicate pages, changed box snapshots, totals and early endings', () => {
  const first = { page: 1, pageSize: 1, total: 2, rows: [{ id: 'a' }], boxes: [], confirmations: [], blocked: [] }, second = { ...first, page: 2, rows: [{ id: 'b' }] };
  assert.equal(combinePages([second, first]).rows.length, 2);
  for (const pages of [[first], [first, first], [first, { ...second, total: 3 }], [first, { ...second, boxes: [{ id: 1 }] }], [first, { ...second, rows: [] }]]) assert.throws(() => combinePages(pages));
});

test('full product identities prevent FNSKU collapse and zero remains distinct from missing', () => {
  const base = { sid: 1, fba: 'FBA1', msku: 'M', fnsku: 'F1', sku: 'S', quantity: 0 };
  assert.equal(compareRows([base, { ...base, fnsku: 'F2' }], [base, { ...base, fnsku: 'F2' }], ['quantity']).length, 0);
  assert.equal(compareRows([base], [{ ...base, quantity: null }], ['quantity']).length, 1);
  assert.equal(compareRows([base], [base, base], ['quantity']).some((d) => d.field === 'duplicate'), true);
});

test('operational observations detect replays that create different results and shifted first dates', () => {
  const demand = { id: 'stable', snapshot: { sid: 1, fba: 'FBA1' }, businessDate: '2026-10-17', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18' };
  const commit = { operationId: 'operation', items: [], replayed: false };
  const evidence = { initialCommit: commit, incrementCommit: commit, replayCommit: { ...commit, replayed: true }, beforeDemands: [demand], afterDemands: [demand], demandDetails: [], actualPreview: { items: [] } };
  assert.equal(verifyImportObservations(evidence, { items: [] }).failures.length, 0);
  const wrong = { ...evidence, replayCommit: { ...commit, replayed: true, operationId: 'other' }, afterDemands: [{ ...demand, businessDate: '2026-10-18' }] };
  const result = verifyImportObservations(wrong, { items: [] }); assert.equal(result.failures.length, 2);
  assert.ok(verifyImportObservations({}, { items: [] }).pending.length > 0);
});

test('sealed packages reject changed, additional and missing evidence; pending package cannot be accepted', async () => temporary(async (directory) => {
  await putJson(join(directory, 'reconciliation.json'), { result: 'pending' }); await seal(directory, { task: 'T22', result: 'pending' });
  const checked = await verifyPackage(directory); assert.equal(checked.manifest.result, 'pending');
  const evidence = join(directory, 'user.txt'); await writeFile(evidence, '业务负责人明确签收原文');
  await assert.rejects(() => verifyPackage(directory), /缺失、增加/); await rm(evidence);
  const file = join(directory, 'reconciliation.json'); const original = await readFile(file); await writeFile(file, 'changed'); await assert.rejects(() => verifyPackage(directory), /哈希不符/); await writeFile(file, original);
  const decision = join(directory, '..', `${randomUUID()}.json`);
  try { await putJson(decision, { decision: 'accepted', signer: '业务负责人', statement: '明确接受', decidedAt: new Date().toISOString(), packageSha256: checked.sha256, evidencePath: 'not-needed.txt' }); await assert.rejects(() => recordSignoff(directory, decision, join(directory, 'signoff')), /不能登记通过/); } finally { await rm(decision, { force: true }); }
}));

async function batchFixture(directory) {
  const { ExcelJS } = await appModules(); assert.ok(ExcelJS.Workbook);
  const { createReportWorkbook } = await import(pathToFileURL(resolve(root, 'apps/server/dist/modules/batches/workbook.js')));
  const id = randomUUID, groupId = id(), batchId = id(), demandId = id(), revisionId = id(), confirmationId = id(), boxId = id(), exportId = id(), now = new Date().toISOString();
  const demand = { id: demandId, snapshot: { sid: 1, fba: 'FBAREAL1', shop: '甲店', country: '美国', channel: '空运', destinationFc: 'FC1', referenceQuantity: '0', notes: null, subBatchName: null }, version: 1, businessDate: '2026-10-17', weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', createdAt: now, updatedAt: now };
  const product = { msku: 'M', fnsku: 'F', sku: 'S', quantity: '0', name: '真实参考仅用于技术夹具测试' };
  const revision = { id: revisionId, demandId, version: 1, demandVersion: 1, source: 'manual', reason: 'technical fixture', snapshotIds: [], createdBy: 'technical', createdAt: now, data: { sid: 1, fba: 'FBAREAL1', observedAt: now, issues: [], items: [product], boxes: [{ id: boxId, externalBoxId: 'external1', packageId: null, localBoxId: '1', name: 'box', order: 1, items: [{ ...product }] }] } };
  const group = { id: groupId, batchId, name: '甲组', version: 2, status: 'frozen', position: 0, demandIds: [demandId], prefix: 'A', confirmedVersion: 2, frozenAt: now, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now };
  const confirmation = { id: confirmationId, groupId, groupVersion: 2, snapshot: { members: [demand], shipments: [{ demandId, revision }], ruleVersion: 'technical-rule' }, createdBy: 'technical', createdAt: now };
  const row = { id: `${revisionId}:M:F:S`, groupId, groupName: '甲组', confirmationId, weekStartDate: demand.weekStartDate, weekEndDate: demand.weekEndDate, businessDate: demand.businessDate, sid: 1, shop: '甲店', country: '美国', channel: '空运', destinationFc: 'FC1', fba: 'FBAREAL1', msku: 'M', fnsku: 'F', sku: 'S', productName: product.name, quantity: 0, boxes: [{ boxId, boxOrder: 1, code: 'A1', quantity: 0 }], codes: ['A1'], groupQuantity: 0, monthQuantity: 0, status: '已冻结', actualShipDate: null, sourceObservedAt: now, dataRevisionId: revisionId };
  const box = { groupId, groupName: '甲组', confirmationId, demandId, fba: 'FBAREAL1', sid: 1, boxId, boxOrder: 1, code: 'A1', boxName: 'box', boxExternalId: 'external1', localBoxId: '1', weight: null, weightUnit: null, length: null, width: null, height: null, lengthUnit: null, items: [{ msku: 'M', fnsku: 'F', sku: 'S', quantity: 0 }] };
  const refs = [{ groupId, groupVersion: 2, confirmationId }], report = { rows: [row], boxes: [box], total: 1, page: 1, pageSize: 100, maxBoxes: 1, confirmations: refs, blocked: [], generatedAt: now };
  await putJson(join(directory, 'group.json'), { group, members: [demand], shipments: [{ demandId, revision }], issues: [], confirmation, codes: [{ id: id(), groupId, demandId, boxId, prefix: 'A', sequence: 1, code: 'A1', valid: true, createdAt: now }], history: [] }); await putJson(join(directory, 'report.json'), report);
  await putJson(join(directory, 'export.json'), { id: exportId, status: 'completed', groupIds: [groupId], references: refs, month: null, region: 'all', fileId: id(), error: null, createdAt: now, completedAt: now, rowCount: 1, boxCount: 1, valid: true, invalidReason: null });
  await writeFile(join(directory, 'report.xlsx'), await createReportWorkbook(report, { exportId }));
  await putJson(join(directory, 'batch.json'), { schemaVersion: 1, batchId, groupDetails: ['group.json'], reportPages: ['report.json'], demandDetails: [], exportRecord: 'export.json', workbook: 'report.xlsx' });
  return { report, row, box, group, demand, confirmation, revision };
}

test('real XLSX readback catches quantity/codes and pending materials never become signoff', async () => temporary(async (directory) => {
  const fixture = await batchFixture(directory);
  const result = await batchPackage(join(directory, 'batch.json'), join(directory, 'package'));
  assert.equal(result.result, 'pending'); assert.equal(result.differences, 0); assert.ok(result.pending >= 3);
  const { ExcelJS } = await appModules(), book = new ExcelJS.Workbook(); await book.xlsx.readFile(join(directory, 'report.xlsx'));
  const main = book.worksheets[0], headers = main.getRow(1).values; main.getCell(2, headers.indexOf('箱1')).value = 1; await book.xlsx.writeFile(join(directory, 'report.xlsx'));
  const changed = await batchPackage(join(directory, 'batch.json'), join(directory, 'changed-package')); assert.equal(changed.result, 'mismatch'); assert.ok(changed.differences > 0);
  const data = await json(join(directory, 'package', 'reconciliation.json')); assert.equal(data.productRows, 1); assert.equal(data.historicalShipments, 0); assert.equal(data.orderedGroups[0].confirmationId, fixture.confirmation.id);
}));

test('capture sends only application GETs, preserves cookie secrecy and rejects concurrent edits', async () => temporary(async (directory) => {
  const fixture = await batchFixture(directory), group = await json(join(directory, 'group.json')), exported = { export: await json(join(directory, 'export.json')) };
  const manifest = { schemaVersion: 1, baseUrl: 'http://127.0.0.1:3002', batchId: fixture.group.batchId, groupIds: [fixture.group.id], exportId: exported.export.id };
  const manifestPath = join(directory, 'capture.json'), cookiePath = join(directory, 'private-cookie.txt'); await putJson(manifestPath, manifest); await writeFile(cookiePath, 'test-session=private-fixture');
  let groupReads = 0, edited = false; const requests = [];
  const fetcher = async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Cookie, 'test-session=private-fixture'); requests.push(url.pathname);
    let data;
    if (url.pathname.includes('weekly-batches')) data = { batch: { id: fixture.group.batchId, weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', version: 1, sortMode: 'manual', nextPrefix: 1, createdAt: fixture.group.createdAt }, groups: [fixture.group], ungrouped: [] };
    else if (url.pathname.includes('sub-batches')) { groupReads++; data = edited && groupReads > 1 ? { ...group, group: { ...group.group, version: 3 } } : group; }
    else if (url.pathname.includes('demands')) data = { demand: fixture.demand, revisions: [], sources: [] };
    else if (url.pathname.includes('/exports/')) data = exported;
    else if (url.pathname.includes('/files/')) return { ok: true, arrayBuffer: async () => readFile(join(directory, 'report.xlsx')) };
    else if (url.pathname === '/api/v1/batch-reports') data = fixture.report;
    else throw new Error('Unexpected request');
    return { ok: true, json: async () => structuredClone(data) };
  };
  const output = join(directory, 'capture-output'); const result = await capture(manifestPath, cookiePath, output, fetcher);
  assert.equal(result.realBusinessRequests, 0); assert.equal(requests.length, 8); assert.ok(requests.every((p) => p.startsWith('/api/v1/')));
  assert.equal((await readFile(join(output, 'batch-manifest.json'), 'utf8')).includes('private-fixture'), false);
  edited = true; groupReads = 0; await assert.rejects(() => capture(manifestPath, cookiePath, join(directory, 'changed-capture'), fetcher), /采集期间业务组发生变化/);
}));

test('complete reconciliation permits a separately recorded explicit decision bound to immutable hashes', async () => temporary(async (directory) => {
  const fixture = await batchFixture(directory), now = new Date().toISOString(), source = { rowId: randomUUID(), parseRunId: randomUUID(), importId: randomUUID(), fileName: '技术测试原件.xlsx', sheetName: '需求导入', rowNumber: 2, addresses: ['E2'] };
  const detail = { demand: fixture.demand, revisions: [], sources: [{ source, acceptedVersion: 1, createdBy: 'technical', createdAt: now, mapping: { sourceShop: '甲店', sellerMappingId: randomUUID(), expectedVersion: 1, confirmed: true, sid: 1, name: '甲店', country: '美国', confirmedBy: 'technical', confirmedAt: now } }] };
  await putJson(join(directory, 'demand.json'), detail);
  await putJson(join(directory, 'reference.json'), { preparedBy: 'technical fixture only', preparedAt: now, source: 'test fixture, not real signoff', independentlyPrepared: true, products: [fixture.row], boxes: [{ ...fixture.box, ...fixture.box.items[0] }] });
  const input = await json(join(directory, 'batch.json')); input.demandDetails = ['demand.json']; input.humanReference = 'reference.json'; input.historicalEvidence = resolve(root, 'docs/acceptance/evidence/2026-10-17/t12-m2-e2e.json');
  await writeFile(join(directory, 'batch.json'), JSON.stringify(input));
  const packagePath = join(directory, 'package'), result = await batchPackage(join(directory, 'batch.json'), packagePath); assert.equal(result.result, 'ready_for_signoff'); assert.equal(result.differences, 0);
  await writeFile(join(directory, 'explicit.txt'), '这是自动化技术夹具用的明确结论原文，不是实际业务签收。');
  await putJson(join(directory, 'decision.json'), { decision: 'accepted', signer: 'technical fixture only', statement: '仅测试登记行为', decidedAt: now, packageSha256: result.sha256, evidencePath: 'explicit.txt' });
  const signed = await recordSignoff(packagePath, join(directory, 'decision.json'), join(directory, 'signoff')); assert.equal(signed.result, 'accepted'); assert.equal((await verifyPackage(packagePath)).sha256, result.sha256);
  const record = await json(join(directory, 'signoff', 'signoff.json')); assert.equal(record.packageSha256, result.sha256); assert.equal(record.signer, 'technical fixture only');
}));
