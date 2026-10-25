import { chooseOption } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { batchMutationResultSchema, batchWorkspaceQuerySchema, batchWorkspaceSchema, createSubBatchInputSchema, createWeeklyBatchInputSchema,
  demandDetailSchema, reportExportInputSchema, reportExportRecordSchema, reportResponseSchema, subBatchDetailSchema, weeklyBatchDetailSchema, weeklyBatchListSchema } from '../../packages/contracts/dist/index.js';

// Entirely in-memory HTTP fixtures. Unknown APIs and nonlocal requests are blocked;
// no database, account file, API server, shared worker or external service is used.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.BATCH_WORKSPACE_EVIDENCE_DIR || resolve(root, '.local/t26/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-18T03:00:00.000Z';
const checks = [], browserErrors = [], unexpectedRequests = [], heldReleases = [];
let viteProcess, browser, page, baseURL, failed = false, step = 'setup';
const note = (name) => { checks.push({ name, result: 'passed' }); console.log('PASS ' + name); };
const id = () => randomUUID();
const copy = (value) => structuredClone(value);
function makeDemand(index, start = '2026-09-07', end = '2026-09-13', sid = 101) {
  return { id: id(), snapshot: { sid, fba: 'FBATECH' + String(index).padStart(4, '0'), shop: sid === 101 ? '技术美国店' : '技术英国店', country: sid === 101 ? '美国' : '英国', channel: sid === 101 ? 'HY' : 'KP', destinationFc: 'TEST1', referenceQuantity: '10', notes: 'TECHNICAL HTTP FIXTURE', subBatchName: null },
    version: 1, businessDate: start, weekStartDate: start, weekEndDate: end, createdAt: now, updatedAt: now };
}
function makeBatch(start, end) { return { id: id(), weekStartDate: start, weekEndDate: end, version: 1, sortMode: 'fba', nextPrefix: 0, createdAt: now }; }
function makeGroup(batch, member, name, position = 0) {
  return { id: id(), batchId: batch.id, name, version: 1, status: 'draft', position, demandIds: [member.id], prefix: null, confirmedVersion: null, frozenAt: null, correctionOfId: null, replacedById: null, actualShipDate: null, createdAt: now, updatedAt: now };
}
function fixture() {
  const batch = makeBatch('2026-09-07', '2026-09-13'), emptyBatch = makeBatch('2026-09-14', '2026-09-20');
  const newWeek = { weekStartDate: '2026-10-12', weekEndDate: '2026-10-18', demandCount: 3 };
  const batches = [emptyBatch, batch], demands = [], groups = [];
  for (let index = 1; index <= 22; index++) {
    const member = makeDemand(index); demands.push(member); groups.push(makeGroup(batch, member, index === 1 ? '技术主批次' : '技术分页组' + String(index).padStart(2, '0'), index - 1));
  }
  const emptyMembers = [makeDemand(101, emptyBatch.weekStartDate, emptyBatch.weekEndDate), makeDemand(102, emptyBatch.weekStartDate, emptyBatch.weekEndDate), makeDemand(103, emptyBatch.weekStartDate, emptyBatch.weekEndDate, 202)];
  const newMembers = [makeDemand(201, newWeek.weekStartDate, newWeek.weekEndDate), makeDemand(202, newWeek.weekStartDate, newWeek.weekEndDate), makeDemand(203, newWeek.weekStartDate, newWeek.weekEndDate, 202)];
  demands.push(...emptyMembers, ...newMembers);
  const state = { batches, demands, groups, batch, emptyBatch, newWeek, emptyMembers, newMembers, primary: groups[0],
    revisions: new Map(), confirmations: new Map(), codes: new Map(), syncRuns: new Map(), exports: [], operations: new Map(),
    workspaceQueries: [], materializeBodies: [], createBodies: [], confirmBodies: [], codeBodies: [], automaticBodies: [], syncBodies: [], exportBodies: [],
    createConflictOnce: false, materializeConflictOnce: false, loseCreateOnce: false, loseMaterializeOnce: false,
    holdCreate: false, releaseCreate: null, groupFailures: 0, syncFailures: 0, syncDelayOnce: 0,
    holdSync: false, releaseSync: null, syncStartStatus: null, syncResultReads: 0, syncRetryBodies: [],
  };
  state.week = (batchId) => {
    const found = batches.find((entry) => entry.id === batchId); assert(found, 'known fixture week');
    const allGroups = groups.filter((group) => group.batchId === batchId);
    const assigned = new Set(allGroups.filter((group) => group.status !== 'superseded').flatMap((group) => group.demandIds));
    return weeklyBatchDetailSchema.parse({ batch: found, groups: allGroups, ungrouped: demands.filter((member) => member.weekStartDate === found.weekStartDate && !assigned.has(member.id)) });
  };
  state.group = (groupId) => {
    const group = groups.find((entry) => entry.id === groupId); assert(group, 'known fixture group');
    const members = group.demandIds.map((demandId) => demands.find((member) => member.id === demandId));
    const shipments = members.map((member) => ({ demandId: member.id, revision: state.revisions.get(member.id) ?? null }));
    const issues = shipments.flatMap((shipment) => shipment.revision ? [] : [{ code: 'SHIPMENT_NOT_SYNCED', severity: 'error', message: '技术夹具：货件尚未同步。', demandId: shipment.demandId }]);
    return subBatchDetailSchema.parse({ group, members, shipments, issues, confirmation: state.confirmations.get(groupId) ?? null, codes: state.codes.get(groupId) ?? [], history: [] });
  };
  state.workspace = (raw) => {
    const query = batchWorkspaceQuerySchema.parse(raw); state.workspaceQueries.push(copy(query));
    const rows = batches.flatMap((week) => {
      const active = groups.filter((group) => group.batchId === week.id && group.status !== 'superseded');
      return (active.length ? active : [null]).map((group) => {
        const members = group ? state.group(group.id).members : state.week(week.id).ungrouped;
        const confirmation = group ? state.confirmations.get(group.id) : null;
        const run = group ? state.syncRuns.get(group.id)?.[0]?.run : null;
        return { id: group?.id ?? week.id, rowKind: group ? 'group' : 'week', batch: week, group, memberCount: members.length, status: group?.status ?? 'empty',
          sids: [...new Set(members.map((member) => member.snapshot.sid))], shops: [...new Set(members.map((member) => member.snapshot.shop))], countries: [...new Set(members.map((member) => member.snapshot.country))], channels: [...new Set(members.map((member) => member.snapshot.channel).filter(Boolean))], fbas: members.map((member) => member.snapshot.fba),
          sync: { syncedMemberCount: members.filter((member) => state.revisions.has(member.id)).length, staleMemberCount: 0,
            latestRun: run ? { id: run.id, status: run.status, groupVersion: run.groupVersion, createdAt: run.createdAt, completedAt: run.completedAt } : null },
          confirmation: confirmation ? { id: confirmation.id, groupVersion: confirmation.groupVersion, createdAt: confirmation.createdAt, current: confirmation.groupVersion === group.version } : null,
        };
      });
    });
    const selected = rows.filter((row) => (!query.month || row.fbas.some((fba) => demands.find((member) => member.snapshot.fba === fba)?.businessDate.startsWith(query.month))) &&
      (!query.weekFrom || row.batch.weekEndDate >= query.weekFrom) && (!query.weekTo || row.batch.weekStartDate <= query.weekTo) &&
      (!query.sid || row.sids.includes(query.sid)) && (!query.country || row.countries.includes(query.country)) && (!query.channel || row.channels.includes(query.channel)) &&
      (!query.status || row.status === query.status) && (!query.q || (row.group?.name + ' ' + row.fbas.join(' ')).toLowerCase().includes(query.q.toLowerCase())));
    return batchWorkspaceSchema.parse({ rows: selected.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: selected.length, page: query.page, pageSize: query.pageSize,
      availableWeeks: batches.some((week) => week.weekStartDate === newWeek.weekStartDate) ? [] : [newWeek],
      filters: { weeks: batches.map(({ id, weekStartDate, weekEndDate }) => ({ id, weekStartDate, weekEndDate })), shops: [{ sid: 101, name: '技术美国店' }, { sid: 202, name: '技术英国店' }], countries: ['美国', '英国'], channels: ['HY', 'KP'] },
    });
  };
  state.seedCandidate = (groupId) => {
    for (const member of state.group(groupId).members) {
      const item = { msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', name: '技术验证商品', quantity: '10', listQuantity: '10', initialDeclaredQuantity: '10', localShippedQuantity: '0', receivedQuantity: '0', expiration: null, prepOwner: 'SELLER', labelOwner: 'SELLER' };
      state.revisions.set(member.id, { id: id(), demandId: member.id, version: 1, demandVersion: member.version, data: { sid: member.snapshot.sid, fba: member.snapshot.fba,
        items: [item], boxes: [{ id: id(), externalBoxId: 'TECH-BOX', packageId: null, localBoxId: '1', name: '技术箱1', order: 1, items: [item] }], isSta: true, staPlanId: 'TECH-PLAN', observedAt: now, issues: [] }, source: 'manual', snapshotIds: [], reason: 'TECHNICAL HTTP FIXTURE', createdBy: 'technical-ui', createdAt: now });
    }
  };
  state.confirm = (groupId, operationId) => {
    const group = groups.find((entry) => entry.id === groupId); group.version += 1; group.status = 'confirmed'; group.confirmedVersion = group.version;
    const detail = state.group(groupId); state.confirmations.set(groupId, { id: id(), groupId, groupVersion: group.version,
      snapshot: { members: copy(detail.members), shipments: copy(detail.shipments), ruleVersion: 'technical-fixture-v1' }, createdBy: 'technical-ui', createdAt: now });
    return batchMutationResultSchema.parse({ operationId, groupId, batchId: group.batchId, replayed: false });
  };
  state.allocate = (groupId, operationId) => {
    const detail = state.group(groupId); detail.group.prefix = 'A'; groups.find((group) => group.id === groupId).prefix = 'A';
    state.codes.set(groupId, detail.shipments.flatMap((shipment) => shipment.revision.data.boxes.map((box, index) => ({ id: id(), groupId, demandId: shipment.demandId, boxId: box.id, prefix: 'A', sequence: index + 1, code: 'A' + (index + 1), valid: true, createdAt: now }))));
    return batchMutationResultSchema.parse({ operationId, groupId, batchId: detail.group.batchId, replayed: false });
  };
  state.report = (groupId) => {
    const detail = groupId ? state.group(groupId) : state.group(state.primary.id);
    const confirmation = detail.confirmation, codes = detail.codes;
    const ready = confirmation && confirmation.groupVersion === detail.group.confirmedVersion && codes.length > 0 && detail.shipments.every((shipment) => confirmation.snapshot.shipments.some((saved) => saved.demandId === shipment.demandId && saved.revision.id === shipment.revision?.id));
    const members = ready ? detail.members : [];
    return reportResponseSchema.parse({ rows: members.map((member) => {
      const revision = state.revisions.get(member.id), box = revision.data.boxes[0], code = codes.find((entry) => entry.boxId === box.id);
      return { id: member.id + '-0', groupId: detail.group.id, groupName: detail.group.name, confirmationId: confirmation.id, weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate,
        businessDate: member.businessDate, sid: member.snapshot.sid, shop: member.snapshot.shop, country: member.snapshot.country, channel: member.snapshot.channel, destinationFc: member.snapshot.destinationFc, fba: member.snapshot.fba,
        msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', productName: '技术验证商品', quantity: 10, boxes: [{ boxId: box.id, boxOrder: 1, code: code.code, quantity: 10 }], codes: [code.code], groupQuantity: 10, monthQuantity: 10, status: detail.group.status,
        actualShipDate: detail.group.actualShipDate, sourceObservedAt: now, dataRevisionId: revision.id };
    }), boxes: members.map((member) => {
      const box = state.revisions.get(member.id).data.boxes[0], code = codes.find((entry) => entry.boxId === box.id);
      return { groupId: detail.group.id, groupName: detail.group.name, confirmationId: confirmation.id, demandId: member.id, fba: member.snapshot.fba, sid: member.snapshot.sid,
        boxId: box.id, boxOrder: 1, code: code.code, boxName: box.name, boxExternalId: box.externalBoxId, localBoxId: box.localBoxId,
        weight: null, weightUnit: null, length: null, width: null, height: null, lengthUnit: null, items: [{ msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', quantity: 10 }] };
    }), total: members.length, page: 1, pageSize: 50, maxBoxes: 1,
      confirmations: ready ? [{ groupId: detail.group.id, groupVersion: detail.group.version, confirmationId: confirmation.id }] : [],
      blocked: ready ? [] : [{ groupId: detail.group.id, name: detail.group.name, code: 'TECH_NOT_READY', message: '尚未确认并分配编码。' }], generatedAt: now });
  };
  state.workspace({}); state.week(batch.id); state.group(state.primary.id); state.report(state.primary.id);
  return state;
}

async function contextFor(state) {
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const conflict = () => json({ error: { code: 'VERSION_CONFLICT', message: '技术夹具：批次版本已变化，请重新核对。' } }, 409);
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(method + ' EXTERNAL ' + url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '批次向导验证', email: 'batch-ui@acceptance.invalid', role: 'admin' } });
    if (method === 'GET' && path === '/api/v1/demands') return json({ rows: [], total: 0, demandTotal: 0, page: 1, pageSize: 50, maxBoxes: 10, filters: { batches: [], shops: [], countries: [], channels: [] }, generatedAt: now });
    if (method === 'GET' && path === '/api/v1/batches/workspace') return json(state.workspace(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/weekly-batches') return json(weeklyBatchListSchema.parse({ items: state.batches, availableWeeks: state.batches.some((week) => week.weekStartDate === state.newWeek.weekStartDate) ? [] : [state.newWeek] }));
    if (method === 'POST' && path === '/api/v1/weekly-batches') {
      const body = createWeeklyBatchInputSchema.parse(request.postDataJSON()); state.materializeBodies.push(copy(body));
      if (state.materializeConflictOnce) { state.materializeConflictOnce = false; return conflict(); }
      let result = state.operations.get(body.operationId);
      if (!result) { const week = state.batches.find((entry) => entry.weekStartDate === body.weekStartDate) ?? makeBatch(body.weekStartDate, state.newWeek.weekEndDate); if (!state.batches.includes(week)) state.batches.unshift(week); result = { operationId: body.operationId, batchId: week.id, replayed: false }; state.operations.set(body.operationId, result); }
      else result = { ...result, replayed: true };
      if (state.loseMaterializeOnce) { state.loseMaterializeOnce = false; return route.abort('connectionfailed'); }
      return json(batchMutationResultSchema.parse(result), 201);
    }
    const weekMatch = path.match(/^\/api\/v1\/weekly-batches\/([^/]+)$/);
    if (method === 'GET' && weekMatch) return json(state.week(weekMatch[1]));
    const createMatch = path.match(/^\/api\/v1\/weekly-batches\/([^/]+)\/sub-batches$/);
    if (method === 'POST' && createMatch) {
      const body = createSubBatchInputSchema.parse(request.postDataJSON()); state.createBodies.push(copy(body));
      if (state.holdCreate) await new Promise((done) => { state.releaseCreate = () => { state.holdCreate = false; done(); }; heldReleases.push(state.releaseCreate); });
      if (state.createConflictOnce) { state.createConflictOnce = false; state.batches.find((week) => week.id === createMatch[1]).version += 1; return conflict(); }
      let result = state.operations.get(body.operationId);
      if (!result) {
        const week = state.batches.find((entry) => entry.id === createMatch[1]);
        const selected = body.demandIds.map((demandId) => state.demands.find((member) => member.id === demandId)); assert(selected.length && selected.every((member) => member.snapshot.sid === selected[0].snapshot.sid && member.snapshot.country === selected[0].snapshot.country && member.snapshot.channel === selected[0].snapshot.channel));
        assert.equal(body.expectedVersion, week.version); selected.forEach((member) => assert.equal(body.expectedDemandVersions[member.id], member.version));
        const group = makeGroup(week, selected[0], body.name, state.groups.length); group.demandIds = body.demandIds; state.groups.push(group); week.version += 1;
        result = { operationId: body.operationId, groupId: group.id, batchId: week.id, replayed: false }; state.operations.set(body.operationId, result);
      } else result = { ...result, replayed: true };
      if (state.loseCreateOnce) { state.loseCreateOnce = false; return route.abort('connectionfailed'); }
      return json(batchMutationResultSchema.parse(result), 201);
    }
    const groupMatch = path.match(/^\/api\/v1\/sub-batches\/([^/]+)$/);
    if (method === 'GET' && groupMatch) {
      if (state.groupFailures > 0) { state.groupFailures -= 1; return json({ error: { code: 'DATABASE_UNAVAILABLE', message: '技术夹具：成员暂不可用，请重试。' } }, 503); }
      return json(state.group(groupMatch[1]));
    }
    const confirmMatch = path.match(/^\/api\/v1\/sub-batches\/([^/]+)\/confirm$/);
    if (method === 'POST' && confirmMatch) { const body = request.postDataJSON(); state.confirmBodies.push(copy(body)); return json(state.confirm(confirmMatch[1], body.operationId)); }
    const automaticMatch = path.match(/^\/api\/v1\/sub-batches\/([^/]+)\/confirm-and-allocate$/);
    if (method === 'POST' && automaticMatch) {
      const body = request.postDataJSON(); state.automaticBodies.push(copy(body));
      assert.deepEqual(Object.keys(body).sort(), ['operationId', 'expectedVersion', 'expectedBatchVersion', 'expectedDemandVersions', 'expectedShipmentVersions'].sort());
      const detail = state.group(automaticMatch[1]);
      const previous = state.operations.get(body.operationId); if (previous) return json({ ...previous, replayed: true });
      assert.equal(body.expectedVersion, detail.group.version); assert.equal(body.expectedBatchVersion, state.batches.find((entry) => entry.id === detail.group.batchId).version);
      assert.deepEqual(body.expectedDemandVersions, Object.fromEntries(detail.members.map((member) => [member.id, member.version])));
      assert.deepEqual(body.expectedShipmentVersions, Object.fromEntries(detail.shipments.map((shipment) => [shipment.demandId, shipment.revision.version])));
      assert(!['frozen', 'superseded'].includes(detail.group.status)); assert(!detail.issues.some((issue) => issue.severity === 'error'));
      assert(!(state.syncRuns.get(detail.group.id) ?? []).some(({ run }) => ['running', 'queued'].includes(run.status)));
      state.confirm(detail.group.id, body.operationId); const result = state.allocate(detail.group.id, body.operationId); state.operations.set(body.operationId, result); return json(result);
    }
    const dateMatch = path.match(/^\/api\/v1\/sub-batches\/([^/]+)\/actual-ship-date$/);
    if (method === 'POST' && dateMatch) { const body = request.postDataJSON(), group = state.groups.find((entry) => entry.id === dateMatch[1]); assert.equal(body.expectedVersion, group.version); group.version++; group.actualShipDate = body.actualShipDate; return json({ operationId: body.operationId, groupId: group.id, batchId: group.batchId, replayed: false }); }
    const codesMatch = path.match(/^\/api\/v1\/weekly-batches\/([^/]+)\/allocate-codes$/);
    if (method === 'POST' && codesMatch) { const body = request.postDataJSON(); state.codeBodies.push(copy(body)); return json(state.allocate(body.groupIds[0], body.operationId)); }
    const syncMatch = path.match(/^\/api\/v1\/batch-sync\/([^/]+)$/);
    if (syncMatch) {
      if (method === 'GET') {
        if (state.syncDelayOnce) { const waiting = state.syncDelayOnce; state.syncDelayOnce = 0; await delay(waiting); }
        if (state.syncFailures > 0) { state.syncFailures -= 1; return json({ error: { code: 'DATABASE_UNAVAILABLE', message: '技术夹具：同步状态读取失败。' } }, 503); }
        return json({ runs: (state.syncRuns.get(syncMatch[1]) ?? []).map((value) => value.run) });
      }
      if (method === 'POST') {
        const body = request.postDataJSON(); state.syncBodies.push(copy(body)); state.seedCandidate(syncMatch[1]);
        if (state.holdSync) await new Promise((done) => { state.releaseSync = () => { state.holdSync = false; done(); }; heldReleases.push(state.releaseSync); });
        const detail = state.group(syncMatch[1]);
        const value = { run: { id: id(), subBatchId: syncMatch[1], groupVersion: detail.group.version, status: state.syncStartStatus ?? 'completed', ...body, requestsUsed: 0, authRequests: 0, cacheHits: 0, errorCode: null, errorMessage: null, createdAt: state.syncStartStatus ? new Date().toISOString() : now, startedAt: state.syncStartStatus ? new Date().toISOString() : now, completedAt: state.syncStartStatus ? null : now },
          items: detail.members.map((member) => ({ id: id(), demandId: member.id, sid: member.snapshot.sid, fba: member.snapshot.fba, status: state.syncStartStatus ? 'queued' : 'completed', revisionId: state.revisions.get(member.id).id, errorCode: null, errorMessage: null, snapshotIds: [], requestCount: 0, attempts: 1 })) };
        state.syncRuns.set(syncMatch[1], [value]); return json(value, 202);
      }
    }
    const runMatch = path.match(/^\/api\/v1\/batch-sync\/runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) { state.syncResultReads++; return json([...state.syncRuns.values()].flat().find((value) => value.run.id === runMatch[1])); }
    const retryMatch = path.match(/^\/api\/v1\/batch-sync\/runs\/([^/]+)\/retry$/);
    if (method === 'POST' && retryMatch) {
      state.syncRetryBodies.push(copy(request.postDataJSON()));
      if (state.holdSync) await new Promise((done) => { state.releaseSync = () => { state.holdSync = false; done(); }; heldReleases.push(state.releaseSync); });
      const result = [...state.syncRuns.values()].flat().find((value) => value.run.id === retryMatch[1]); assert(result);
      result.run.status = 'queued'; result.run.errorCode = null; result.run.errorMessage = null; result.run.completedAt = null;
      result.items.filter((item) => item.status !== 'completed').forEach((item) => { item.status = 'queued'; item.errorCode = null; item.errorMessage = null; });
      return json(result, 202);
    }
    if (method === 'GET' && path === '/api/v1/batch-reports') return json(state.report(url.searchParams.get('subBatchId')));
    if (method === 'GET' && path === '/api/v1/batch-reports/exports') return json({ items: state.exports });
    if (method === 'POST' && path === '/api/v1/batch-reports/exports') {
      const body = reportExportInputSchema.parse(request.postDataJSON()); state.exportBodies.push(copy(body));
      assert(body.groupIds.every((groupId) => state.report(groupId).confirmations.length === 1), 'fixture rejects premature export');
      const result = reportExportRecordSchema.parse({ id: id(), status: 'completed', groupIds: body.groupIds, references: body.expectedConfirmations, month: body.month ?? null, region: body.region, fileId: id(), error: null, createdAt: now, completedAt: now, rowCount: 1, boxCount: 1, valid: true, invalidReason: null });
      state.exports.push(result); return json({ export: result }, 202);
    }
    const sourceMatch = path.match(/^\/api\/v1\/demands\/([^/]+)$/);
    if (method === 'GET' && sourceMatch) return json(demandDetailSchema.parse({ demand: state.demands.find((member) => member.id === sourceMatch[1]), sources: [], revisions: [] }));
    unexpectedRequests.push(method + ' ' + path);
    return json({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unknown isolated fixture API' } }, 500);
  });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => browserErrors.push(error.message));
  return context;
}

const processDialog = () => page.getByRole('dialog', { name: '发货批次处理向导', exact: true });
const processNav = () => processDialog().getByRole('navigation', { name: '批次处理步骤', exact: true });
const processStage = (name) => processNav().getByRole('button', { name: new RegExp(name) });
async function currentProcess(name) { await expect(processNav().locator('[aria-current="step"]')).toContainText(name); }
const mainTable = () => page.getByRole('region', { name: '发货批次列表，可横向滚动', exact: true });
const primaryRow = () => mainTable().locator('tr').filter({ hasText: '技术主批次' });
const createDialog = () => page.getByRole('dialog', { name: '建立发货批次', exact: true });
const createNav = () => createDialog().getByRole('navigation', { name: '建立批次步骤', exact: true });
async function currentCreate(name) { await expect(createNav().locator('[aria-current="step"]')).toContainText(name); }
async function switchWorkspace(view) {
  await page.locator(`.sidebar nav[aria-label="发货管理子导航"] a[href*="view=${view}"]`).evaluate((node) => node.click());
  await expect(page).toHaveURL((url) => url.pathname === '/shipping' && url.searchParams.get('view') === view);
}
async function selectCompatible(members) {
  await expect(createDialog().getByRole('button', { name: '下一步：核对与建立', exact: true })).toBeDisabled();
  await createDialog().getByRole('checkbox', { name: '选择 ' + members[0].snapshot.fba, exact: true }).check();
  await expect(createDialog().getByRole('checkbox', { name: '选择 ' + members[2].snapshot.fba, exact: true })).toBeDisabled();
  await createDialog().getByLabel('搜索需求', { exact: true }).fill(members[1].snapshot.fba);
  await createDialog().getByRole('button', { name: '选择筛选中的兼容需求', exact: true }).click();
  await createDialog().getByLabel('搜索需求', { exact: true }).fill('');
  await expect(createDialog().getByRole('checkbox', { name: '选择 ' + members[0].snapshot.fba, exact: true })).toBeChecked();
  await expect(createDialog().getByRole('checkbox', { name: '选择 ' + members[1].snapshot.fba, exact: true })).toBeChecked();
  await chooseOption(createDialog().getByLabel('店铺', { exact: true }), '202');
  await expect(createDialog().getByRole('status').filter({ hasText: /^已选 2 票$/ })).toBeVisible();
  await chooseOption(createDialog().getByLabel('店铺', { exact: true }), '');
}
async function reviewCreation(name = '技术新建批次') {
  await createDialog().getByRole('button', { name: '下一步：核对与建立', exact: true }).click(); await currentCreate('核对与建立');
  await expect(createDialog().getByRole('button', { name: '确认建立发货批次', exact: true })).toBeDisabled();
  await createDialog().getByLabel('发货批次名称', { exact: true }).fill(name);
  await createDialog().getByLabel('建立说明', { exact: true }).fill('技术回归：人工选择兼容需求');
  await createDialog().getByRole('checkbox', { name: '已核对所选需求的店铺、国家和渠道，确认建立此发货批次。', exact: true }).check();
}
async function openExistingCreation(state, captureSteps = false) {
  await page.goto('/shipping?view=batches');
  await mainTable().locator('tr').filter({ hasText: '待建立子批次' }).getByRole('button', { name: '新建分组', exact: true }).click();
  await expect(createDialog()).toBeVisible(); await currentCreate('选择周范围');
  await expect(createDialog().getByLabel('需求周范围', { exact: true })).toHaveAttribute('data-value', state.emptyBatch.weekStartDate);
  if (captureSteps) await creationStageScreenshots('creation-step1');
  await createDialog().getByRole('button', { name: '下一步：选择需求', exact: true }).click(); await currentCreate('选择需求');
  assert.equal(state.materializeBodies.length, 0, 'existing week reused without POST');
}
async function layout(dialog, label) {
  const size = page.viewportSize();
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  if (documentWidth > size.width + 1) console.error('OVERFLOW', label, await page.locator('body *').evaluateAll((nodes) => nodes.map((node) => ({ tag: node.tagName, className: node.className, x: node.getBoundingClientRect().x, right: node.getBoundingClientRect().right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })).filter((node) => node.right > innerWidth + 1 && node.clientWidth < node.scrollWidth).slice(0, 30)));
  assert(documentWidth <= size.width + 1, label + ' document overflow');
  if (dialog) {
    const rect = await dialog.boundingBox(); assert(rect && rect.x >= -1 && rect.x + rect.width <= size.width + 1 && rect.y >= -1 && rect.y + rect.height <= size.height + 1, label + ' dialog bounds');
    await dialog.locator(':scope > .import-dialog-heading button').focus();
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      const focus = await dialog.evaluate((node) => ({ inside: node.contains(document.activeElement), documentFocused: document.hasFocus(), tag: document.activeElement?.tagName, text: document.activeElement?.getAttribute('aria-label') }));
      assert(focus.inside || !focus.documentFocused, label + ' focus moved to background: ' + JSON.stringify(focus));
    }
  }
}
async function capture(name, dialog) {
  if (dialog) {
    await dialog.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    await dialog.locator('nav [aria-current="step"]').focus();
  }
  await page.screenshot({ path: resolve(evidence, name), animations: 'disabled', timeout: 30000 });
}
async function creationStageScreenshots(prefix) {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await layout(createDialog(), prefix + '-' + width);
    await capture(prefix + '-' + width + '.png', createDialog());
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function listChecks(state) {
  step = 'workspace-server-pagination-filters-reset-and-placeholder';
  await page.goto('/shipping?view=batches'); await expect(page.getByRole('heading', { name: '批次列表', exact: true })).toBeVisible();
  await expect(mainTable().locator('tbody tr')).toHaveCount(20);
  await expect(mainTable().getByText('待建立子批次', { exact: true })).toBeVisible();
  await expect(primaryRow().getByRole('button', { name: '处理向导', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(() => state.workspaceQueries.at(-1)?.page).toBe(2);
  await expect(mainTable().locator('tbody tr')).toHaveCount(3);
  const form = page.getByRole('form', { name: '筛选发货批次', exact: true });
  await form.getByLabel('业务月份', { exact: true }).fill('2026-09');
  await chooseOption(form.getByLabel('开始周', { exact: true }), '2026-09-07');
  await chooseOption(form.getByLabel('结束周', { exact: true }), '2026-09-07');
  await chooseOption(form.getByLabel('店铺', { exact: true }), '101');
  await chooseOption(form.getByLabel('国家', { exact: true }), '美国');
  await chooseOption(form.getByLabel('业务渠道', { exact: true }), 'HY');
  await chooseOption(form.getByLabel('处理状态', { exact: true }), 'draft');
  await form.getByLabel('搜索', { exact: true }).fill('  技术主批次  ');
  const before = state.workspaceQueries.length; await delay(150); assert.equal(state.workspaceQueries.length, before, 'draft filter does not query before apply');
  await form.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(mainTable().locator('tbody tr')).toHaveCount(1);
  assert.deepEqual(state.workspaceQueries.at(-1), { month: '2026-09', weekFrom: '2026-09-07', weekTo: '2026-09-07', sid: 101, country: '美国', channel: 'HY', status: 'draft', q: '技术主批次', page: 1, pageSize: 20 });
  await form.getByLabel('店铺', { exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await switchWorkspace('demands'); await expect(mainTable()).not.toBeVisible();
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeVisible();
  await switchWorkspace('batches');
  await expect(mainTable().locator('tbody tr')).toHaveCount(1);
  await expect(form.getByLabel('搜索', { exact: true })).toHaveValue('  技术主批次  ');
  await expect(form.getByLabel('开始周', { exact: true })).toHaveAttribute('data-value', '2026-09-07');
  await expect(form.getByLabel('处理状态', { exact: true })).toHaveAttribute('data-value', 'draft');
  await form.getByRole('button', { name: '重置', exact: true }).click();
  await expect(mainTable().locator('tbody tr')).toHaveCount(20);
  assert.deepEqual(state.workspaceQueries.at(-1), { page: 1, pageSize: 20 });
  await chooseOption(form.getByLabel('开始周', { exact: true }), '2026-09-14');
  await chooseOption(form.getByLabel('结束周', { exact: true }), '2026-09-07');
  const invalidBefore = state.workspaceQueries.length; await form.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('结束周不能早于开始周'); assert.equal(state.workspaceQueries.length, invalidBefore);
  await form.getByRole('button', { name: '重置', exact: true }).click();
  note(step);
  step = 'workspace-responsive-1440-768-390-320';
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await layout(null, 'workspace-' + width); await capture('workspace-' + width + '.png');
    assert(await mainTable().evaluate((node) => node.scrollWidth >= node.clientWidth), 'table preserves own scrolling');
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); note(step);
}

async function processChecks(state) {
  step = 'process-unsynced-candidate-confirm-code-export-gates';
  await primaryRow().getByRole('button', { name: '处理向导', exact: true }).click();
  await expect(processDialog()).toBeVisible(); await currentProcess('同步与商品');
  await expect(processStage('制表确认与编码')).toBeDisabled(); await expect(processStage('成品与导出')).toBeDisabled();
  await processDialog().getByLabel('货件创建日期起', { exact: true }).fill('2026-09-01');
  await processDialog().getByLabel('货件创建日期止（不含）', { exact: true }).fill('2026-10-01');
  await processDialog().getByRole('button', { name: '同步全部成员', exact: true }).click();
  await expect(processDialog().getByRole('button', { name: '下一步：制表确认与编码', exact: true })).toBeEnabled();
  assert.equal(state.syncBodies.length, 1); assert.equal(state.automaticBodies.length, 0); assert.equal(state.confirmBodies.length, 0); assert.equal(state.codeBodies.length, 0); assert.equal(state.exportBodies.length, 0);
  await processDialog().getByRole('button', { name: '下一步：制表确认与编码', exact: true }).click(); await currentProcess('制表确认与编码');
  await expect(processDialog().getByLabel('确认说明', { exact: true })).toHaveCount(0);
  await expect(processDialog().getByRole('checkbox', { name: /^已核对当前成员/ })).toHaveCount(0);
  await expect.poll(() => state.automaticBodies.length).toBe(1); await expect(processStage('成品与导出')).toBeEnabled();
  await processDialog().getByRole('button', { name: '直接进入成品与导出', exact: true }).click(); await currentProcess('成品与导出');
  await processDialog().getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true }).locator('tbody').getByRole('checkbox').first().check();
  await expect(processDialog().getByRole('button', { name: '生成发货表 XLSX', exact: true })).toBeEnabled();
  await processDialog().getByRole('button', { name: '生成发货表 XLSX', exact: true }).click();
  await expect(processDialog().getByRole('status').filter({ hasText: '导出任务已受理' })).toBeVisible();
  assert.equal(state.automaticBodies.length, 1); assert.equal(state.confirmBodies.length, 0); assert.equal(state.codeBodies.length, 0); assert.equal(state.exportBodies.length, 1);
  assert.equal(state.exportBodies[0].expectedConfirmations[0].confirmationId, state.confirmations.get(state.primary.id).id);
  note(step);
  step = 'unified-views-hide-process-modal-and-preserve-current-stage';
  await switchWorkspace('demands');
  await expect(processDialog()).not.toBeVisible(); await expect(page.locator('dialog[open]')).toHaveCount(0);
  await switchWorkspace('reports');
  await expect(page.getByRole('heading', { name: '发货成品表', exact: true })).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await switchWorkspace('batches'); await expect(processDialog()).toBeVisible(); await currentProcess('成品与导出');
  await expect(page.locator('dialog[open]')).toHaveCount(1); note(step);
  step = 'process-escape-close-reopen-refresh-retains-stage';
  await page.keyboard.press('Escape'); await expect(processDialog()).not.toBeVisible();
  await page.getByRole('button', { name: '继续上次处理', exact: true }).click(); await currentProcess('成品与导出');
  await processDialog().getByRole('button', { name: '刷新处理数据', exact: true }).click(); await currentProcess('成品与导出');
  await page.reload(); await expect(processDialog()).toBeVisible(); await currentProcess('成品与导出'); note(step);
  step = 'process-responsive-1440-768-390-320';
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await layout(processDialog(), 'process-' + width); await capture('process-' + width + '.png', processDialog());
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await processDialog().getByRole('button', { name: '完成，返回批次列表', exact: true }).click(); await expect(processDialog()).not.toBeVisible(); note(step);
  step = 'legacy-deep-link-reopens-required-group-tab-and-demand';
  await page.goto('/batches/' + state.batch.id + '?groupId=' + state.primary.id + '&tab=confirmation&demandId=' + state.primary.demandIds[0]);
  await expect(page.getByRole('heading', { name: '校验、确认与编码', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '校验、确认与编码', exact: true })).toHaveAttribute('aria-selected', 'true'); note(step);
}

async function creationChecks() {
  let state = fixture(), context = await contextFor(state);
  step = 'creation-existing-week-compatible-members-review-escape-reopen';
  await openExistingCreation(state, true); await selectCompatible(state.emptyMembers); await creationStageScreenshots('creation-step2'); await reviewCreation();
  await switchWorkspace('demands');
  await expect(createDialog()).not.toBeVisible(); await expect(page.locator('dialog[open]')).toHaveCount(0);
  await switchWorkspace('batches'); await expect(createDialog()).toBeVisible(); await currentCreate('核对与建立');
  await expect(createDialog().getByLabel('发货批次名称', { exact: true })).toHaveValue('技术新建批次');
  await page.keyboard.press('Escape'); await expect(createDialog()).not.toBeVisible();
  await mainTable().locator('tr').filter({ hasText: '待建立子批次' }).getByRole('button', { name: '新建分组', exact: true }).click();
  await currentCreate('核对与建立'); await expect(createDialog().getByLabel('发货批次名称', { exact: true })).toHaveValue('技术新建批次');
  note(step);
  step = 'creation-responsive-1440-768-390-320';
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await layout(createDialog(), 'creation-' + width); await capture('creation-' + width + '.png', createDialog());
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); note(step);
  step = 'creation-confirmed-result-continues-processing-without-detail-detour';
  await createDialog().getByRole('button', { name: '确认建立发货批次', exact: true }).click(); await currentCreate('建立结果');
  await expect(createDialog().getByRole('heading', { name: '需求分组已建立', exact: true })).toBeVisible();
  assert.equal(state.createBodies.length, 1); assert.deepEqual(new Set(state.createBodies[0].demandIds), new Set(state.emptyMembers.slice(0, 2).map((member) => member.id)));
  await createDialog().getByRole('button', { name: '继续同步与核对', exact: true }).click();
  await expect(createDialog()).not.toBeVisible(); await currentProcess('同步与商品'); note(step); await context.close();

  state = fixture(); state.createConflictOnce = true; context = await contextFor(state);
  step = 'creation-409-retains-input-requires-current-week-and-demand-review';
  await openExistingCreation(state); await selectCompatible(state.emptyMembers); await reviewCreation('版本冲突保留名称');
  await createDialog().getByRole('button', { name: '确认建立发货批次', exact: true }).click();
  await expect(createDialog().getByRole('alert')).toContainText('版本已变化');
  await expect(createDialog().getByLabel('发货批次名称', { exact: true })).toHaveValue('版本冲突保留名称');
  await expect(createDialog().getByRole('button', { name: '确认建立发货批次', exact: true })).toBeDisabled();
  state.emptyMembers[0].version += 1;
  await createDialog().getByRole('button', { name: '返回选择并重新核对', exact: true }).click(); await currentCreate('选择需求');
  await expect(createDialog().getByRole('checkbox', { name: '选择 ' + state.emptyMembers[0].snapshot.fba, exact: true })).toBeChecked();
  await expect(createDialog().getByRole('button', { name: '下一步：核对与建立', exact: true })).toBeDisabled();
  await createDialog().getByRole('button', { name: '采用当前需求版本重新核对', exact: true }).click();
  await createDialog().getByRole('button', { name: '下一步：核对与建立', exact: true }).click(); await currentCreate('核对与建立');
  await expect(createDialog().getByLabel('发货批次名称', { exact: true })).toHaveValue('版本冲突保留名称');
  await expect(createDialog().getByRole('checkbox', { name: /^已核对所选需求/ })).not.toBeChecked();
  await createDialog().getByRole('checkbox', { name: /^已核对所选需求/ }).check();
  await createDialog().getByRole('button', { name: '确认建立发货批次', exact: true }).click(); await currentCreate('建立结果');
  assert.equal(state.createBodies.length, 2); assert.notEqual(state.createBodies[0].operationId, state.createBodies[1].operationId);
  assert.equal(state.createBodies[1].expectedVersion, state.createBodies[0].expectedVersion + 1);
  assert.equal(state.createBodies[1].expectedDemandVersions[state.emptyMembers[0].id], 2); note(step); await context.close();

  state = fixture(); state.loseMaterializeOnce = true; state.loseCreateOnce = true; context = await contextFor(state);
  step = 'creation-new-week-unknown-response-replays-original-week-operation';
  await page.goto('/batches/new'); await expect(createDialog()).toBeVisible(); await currentCreate('选择周范围');
  await chooseOption(createDialog().getByLabel('需求周范围', { exact: true }), state.newWeek.weekStartDate);
  await createDialog().getByRole('button', { name: '下一步：选择需求', exact: true }).click();
  await expect(createDialog().getByRole('alert')).toContainText('周范围建立结果尚未确认');
  await createDialog().getByRole('button', { name: '重试原周范围请求', exact: true }).click(); await currentCreate('选择需求');
  assert.equal(state.materializeBodies.length, 2); assert.deepEqual(state.materializeBodies[0], state.materializeBodies[1]);
  assert.equal(state.batches.filter((week) => week.weekStartDate === state.newWeek.weekStartDate).length, 1); note(step);
  step = 'creation-lost-success-response-locks-draft-refresh-replays-identical-operation';
  await selectCompatible(state.newMembers); await reviewCreation('丢失响应恢复批次');
  await createDialog().getByRole('button', { name: '确认建立发货批次', exact: true }).click();
  await expect(createDialog().getByRole('alert')).toContainText('建立结果尚未确认');
  await expect(createDialog().getByLabel('发货批次名称', { exact: true })).toBeDisabled();
  await expect(createNav().getByRole('button', { name: /选择需求/ })).toBeDisabled();
  await page.reload(); await expect(createDialog()).toBeVisible(); await currentCreate('核对与建立');
  await expect(createDialog().getByRole('button', { name: '重试原建立请求', exact: true })).toBeEnabled();
  await createDialog().getByRole('button', { name: '重试原建立请求', exact: true }).click(); await currentCreate('建立结果');
  await expect(createDialog().getByRole('heading', { name: '已恢复原分组结果', exact: true })).toBeVisible();
  assert.equal(state.createBodies.length, 2); assert.deepEqual(state.createBodies[0], state.createBodies[1]);
  assert.equal(state.groups.filter((group) => group.name === '丢失响应恢复批次').length, 1); note(step);
  step = 'creation-new-route-continues-process-and-refresh-keeps-created-group';
  await createDialog().getByRole('button', { name: '继续同步与核对', exact: true }).click(); await currentProcess('同步与商品');
  await expect(page).toHaveURL((url) => url.pathname !== '/batches/new' && url.searchParams.get('wizard') === 'process');
  const createdGroupId = new URL(page.url()).searchParams.get('groupId'); assert(createdGroupId);
  await page.reload(); await expect(processDialog()).toBeVisible(); await expect(createDialog()).not.toBeVisible(); await currentProcess('同步与商品');
  assert.equal(new URL(page.url()).searchParams.get('groupId'), createdGroupId); note(step); await context.close();
}

async function processFaultChecks() {
  const state = fixture(); state.seedCandidate(state.primary.id); state.confirm(state.primary.id, id()); state.allocate(state.primary.id, id());
  const context = await contextFor(state);
  step = 'process-stale-candidate-retains-progress-and-blocks-export';
  await page.goto('/batches/' + state.batch.id + '?groupId=' + state.primary.id + '&wizard=process');
  await expect(processDialog()).toBeVisible(); await currentProcess('成品与导出');
  await processDialog().getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true }).locator('tbody').getByRole('checkbox').first().check();
  await expect(processDialog().getByRole('button', { name: '生成发货表 XLSX', exact: true })).toBeEnabled();
  state.seedCandidate(state.primary.id);
  await processDialog().getByRole('button', { name: '刷新处理数据', exact: true }).click();
  await expect(processDialog().getByText(/当前确认或箱编码尚未就绪/)).toBeVisible(); await currentProcess('成品与导出');
  const exportButton = processDialog().getByRole('button', { name: '生成发货表 XLSX', exact: true });
  assert((await exportButton.count()) === 0 || !(await exportButton.isVisible()) || !(await exportButton.isEnabled()), 'stale confirmation must disable/remove cached export action');
  assert.equal(state.exportBodies.length, 0); note(step); await context.close();

  step = 'process-active-sync-and-sync-status-failure-block-confirmation-and-export';
  const active = fixture(); active.seedCandidate(active.primary.id); active.confirm(active.primary.id, id()); active.allocate(active.primary.id, id());
  const activeContext = await contextFor(active);
  await page.goto('/batches/' + active.batch.id + '?groupId=' + active.primary.id + '&wizard=process');
  await currentProcess('成品与导出');
  await processDialog().getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true }).locator('tbody').getByRole('checkbox').first().check();
  active.syncRuns.set(active.primary.id, [{ run: { id: id(), subBatchId: active.primary.id, groupVersion: active.primary.version, status: 'running', startDate: '2026-09-01', endDate: '2026-10-01', requestBudget: 10, requestsUsed: 0, maxPages: 10, errorCode: null, errorMessage: null, createdAt: now, startedAt: now, completedAt: null }, items: [] }]);
  await processDialog().getByRole('button', { name: '刷新处理数据', exact: true }).click();
  await expect(processDialog().getByRole('button', { name: '生成发货表 XLSX', exact: true })).toBeDisabled();
  await processDialog().getByRole('button', { name: '返回制表确认与编码', exact: true }).click(); await currentProcess('制表确认与编码');
  await expect(processDialog().getByRole('checkbox', { name: /^已核对当前成员/ })).toHaveCount(0);
  await expect(processDialog().getByRole('button', { name: '确认并分配编码', exact: true })).toHaveCount(0);
  assert.equal(active.automaticBodies.length, 0);
  active.syncRuns.set(active.primary.id, []); active.syncFailures = 1;
  await processDialog().getByRole('button', { name: '刷新处理数据', exact: true }).click();
  await expect(processDialog().getByText(/同步任务尚未完成或状态未读取成功/)).toBeVisible();
  await expect(processStage('成品与导出')).toBeDisabled();
  await expect(processDialog().getByRole('checkbox', { name: /^已核对当前成员/ })).toHaveCount(0);
  assert.equal(active.automaticBodies.length, 0);
  await processDialog().getByRole('button', { name: '刷新处理数据', exact: true }).click();
  await expect(processStage('成品与导出')).toBeEnabled();
  assert.equal(active.automaticBodies.length, 0); assert.equal(active.confirmBodies.length, 0); assert.equal(active.exportBodies.length, 0); note(step);

  step = 'process-history-draft-survives-switching-between-steps';
  await processDialog().getByRole('button', { name: '来源与登记', exact: true }).click();
  await processDialog().getByLabel('本次登记 / 更正说明（必填）', { exact: true }).fill('技术登记草稿：保留当前输入');
  await processDialog().getByRole('button', { name: '返回处理步骤', exact: true }).click(); await currentProcess('制表确认与编码');
  await processDialog().getByRole('button', { name: '来源与登记', exact: true }).click();
  await expect(processDialog().getByLabel('本次登记 / 更正说明（必填）', { exact: true })).toHaveValue('技术登记草稿：保留当前输入');
  note(step);
  step = 'process-cached-read-failure-preserves-and-locks-history-draft-until-retry';
  active.groupFailures = 1;
  await processDialog().getByRole('button', { name: '刷新处理数据', exact: true }).click();
  await expect(processDialog().getByRole('alert')).toContainText('暂时无法读取');
  await expect(processDialog().getByLabel('本次登记 / 更正说明（必填）', { exact: true })).toHaveValue('技术登记草稿：保留当前输入');
  await expect(processDialog().getByLabel('本次登记 / 更正说明（必填）', { exact: true })).toBeDisabled();
  await processDialog().getByRole('button', { name: '重试', exact: true }).click();
  await expect(processDialog().getByLabel('本次登记 / 更正说明（必填）', { exact: true })).toBeEnabled();
  await expect(processDialog().getByLabel('本次登记 / 更正说明（必填）', { exact: true })).toHaveValue('技术登记草稿：保留当前输入');
  note(step); await activeContext.close();

  step = 'process-first-read-error-can-retry-without-losing-target';
  const recover = fixture(); recover.groupFailures = 1; const recoverContext = await contextFor(recover);
  await page.goto('/batches/' + recover.batch.id + '?groupId=' + recover.primary.id + '&wizard=process');
  await expect(processDialog().getByRole('alert')).toContainText('暂时无法读取');
  await processDialog().getByRole('button', { name: '重试', exact: true }).click(); await currentProcess('同步与商品');
  await expect(processDialog().getByText('技术主批次', { exact: false }).first()).toBeVisible(); note(step); await recoverContext.close();

  step = 'process-ready-initial-stage-waits-for-delayed-sync-metadata';
  const ready = fixture(); ready.seedCandidate(ready.primary.id); ready.confirm(ready.primary.id, id()); ready.allocate(ready.primary.id, id()); ready.syncDelayOnce = 500;
  const readyContext = await contextFor(ready);
  await page.goto('/batches/' + ready.batch.id + '?groupId=' + ready.primary.id + '&wizard=process');
  await currentProcess('成品与导出'); note(step); await readyContext.close();

  step = 'explicit-new-route-does-not-reopen-a-previous-process-dialog';
  const explicit = fixture(), explicitContext = await contextFor(explicit);
  await explicitContext.addInitScript((target) => sessionStorage.setItem('scm-batch-process:technical-ui:current', JSON.stringify(target)), { batchId: explicit.batch.id, groupId: explicit.primary.id, open: true });
  await page.goto('/batches/new'); await expect(createDialog()).toBeVisible(); await expect(processDialog()).not.toBeVisible();
  await currentCreate('选择周范围'); note(step); await explicitContext.close();

  step = 'mismatched-week-deep-link-locks-actions-and-offers-correct-week';
  const mismatch = fixture(), mismatchContext = await contextFor(mismatch);
  await page.goto('/batches/' + mismatch.emptyBatch.id + '?groupId=' + mismatch.primary.id + '&wizard=process');
  await expect(processDialog()).toBeVisible(); await currentProcess('同步与商品');
  await expect(processDialog().getByRole('button', { name: '同步全部成员', exact: true })).toBeDisabled();
  await expect(processDialog().getByRole('button', { name: '打开所属周批次', exact: true })).toBeVisible();
  await expect(processStage('制表确认与编码')).toBeDisabled();
  await processDialog().getByRole('button', { name: '打开所属周批次', exact: true }).click();
  await expect(processDialog().getByRole('button', { name: '同步全部成员', exact: true })).toBeEnabled();
  await expect(processDialog().getByRole('alert')).not.toBeVisible();
  assert.equal(mismatch.syncBodies.length, 0); note(step); await mismatchContext.close();

  step = 'superseded-deep-link-switches-to-correction-and-refresh-keeps-new-target';
  const correction = fixture();
  const replacement = { ...copy(correction.primary), id: id(), name: '技术独立更正组', correctionOfId: correction.primary.id };
  correction.primary.status = 'superseded'; correction.primary.replacedById = replacement.id; correction.groups.push(replacement);
  const correctionContext = await contextFor(correction);
  await page.goto('/batches/' + correction.batch.id + '?groupId=' + correction.primary.id + '&wizard=process');
  await expect(processDialog().getByRole('button', { name: '进入更正批次', exact: true })).toBeVisible();
  await processDialog().getByRole('button', { name: '进入更正批次', exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('groupId') === replacement.id && url.searchParams.get('wizard') === 'process');
  await expect(processDialog().getByText('技术独立更正组', { exact: false }).first()).toBeVisible();
  await page.reload(); await expect(processDialog()).toBeVisible();
  await expect(processDialog().getByText('技术独立更正组', { exact: false }).first()).toBeVisible();
  assert.equal(new URL(page.url()).searchParams.get('groupId'), replacement.id); note(step); await correctionContext.close();
}

async function dateMetadataChecks() {
  const state = fixture(); state.seedCandidate(state.primary.id); state.confirm(state.primary.id, id()); state.allocate(state.primary.id, id());
  const context = await contextFor(state);
  step = 'm2-actual-date-version-change-retains-confirmation-and-direct-export';
  await page.goto('/batches/' + state.batch.id + '?groupId=' + state.primary.id + '&wizard=process');
  await currentProcess('成品与导出');
  const confirmationId = state.confirmations.get(state.primary.id).id, confirmedVersion = state.primary.confirmedVersion;
  await processDialog().getByRole('button', { name: '来源与登记', exact: true }).click();
  await processDialog().getByLabel('本次登记 / 更正说明（必填）', { exact: true }).fill('技术回归：只登记实际发货日期');
  await processDialog().getByLabel('实际发货日期（本地登记）', { exact: true }).fill('2026-10-19');
  await processDialog().getByRole('button', { name: '保存日期', exact: true }).click();
  await expect(processDialog().getByRole('status').filter({ hasText: '实际发货日期已本地登记' })).toBeVisible();
  assert.equal(state.confirmations.get(state.primary.id).id, confirmationId); assert.equal(state.primary.confirmedVersion, confirmedVersion); assert(state.primary.version > confirmedVersion);
  await processDialog().getByRole('button', { name: '返回处理步骤', exact: true }).click();
  await currentProcess('成品与导出');
  await processDialog().getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true }).locator('tbody').getByRole('checkbox').first().check();
  await expect(processDialog().getByRole('button', { name: '生成发货表 XLSX', exact: true })).toBeEnabled();
  await expect(processStage('实物箱确认')).toHaveCount(0);
  await page.reload(); await currentProcess('成品与导出');
  await processDialog().getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true }).locator('tbody').getByRole('checkbox').first().check();
  await expect(processDialog().getByRole('button', { name: '生成发货表 XLSX', exact: true })).toBeEnabled();
  note(step); await context.close();
}

async function lingxingProgressChecks() {
  const state = fixture(); state.primary.demandIds.push(state.demands[1].id);
  state.holdSync = true; state.syncStartStatus = 'queued';
  const context = await contextFor(state);
  step = 'm2-progress-pending-queued-known-percentage-partial-and-explicit-retry';
  await page.goto('/batches/' + state.batch.id + '?groupId=' + state.primary.id + '&wizard=process');
  await currentProcess('同步与商品');
  const bar = () => processDialog().getByRole('progressbar', { name: '货件处理进度', exact: true });
  await processDialog().getByRole('button', { name: '同步全部成员', exact: true }).click();
  await expect(bar()).toBeVisible(); await expect(bar()).not.toHaveAttribute('aria-valuenow');
  await expect.poll(() => Boolean(state.releaseSync)).toBe(true); state.releaseSync();
  await expect.poll(() => state.syncRuns.get(state.primary.id)?.length).toBe(1);
  await expect(bar()).toHaveAttribute('data-indeterminate', 'true');
  const result = state.syncRuns.get(state.primary.id)[0]; result.run.status = 'running'; result.items[0].status = 'completed'; result.items[1].status = 'running';
  await expect(bar()).toHaveAttribute('aria-valuenow', '50');
  await expect(bar()).toHaveAttribute('aria-valuetext', /已处理 1 \/ 2/);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await bar().evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await capture('m2-lingxing-progress-running-' + width + '.png');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'M2 progress preserves responsive layout');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  result.run.status = 'partial'; result.run.errorMessage = '技术夹具：第二票失败'; result.items[1].status = 'failed';
  await expect(bar()).toHaveAttribute('aria-valuenow', '100');
  await expect(bar()).toHaveAttribute('aria-valuetext', /部分.*失败 1 票/);
  state.holdSync = true; state.releaseSync = null;
  await processDialog().getByRole('button', { name: '仅重试失败票', exact: true }).click();
  await expect(bar()).not.toHaveAttribute('aria-valuenow');
  await expect.poll(() => Boolean(state.releaseSync)).toBe(true); state.releaseSync();
  await expect(bar()).toHaveAttribute('data-indeterminate', 'true');
  assert.equal(result.items[0].status, 'completed', 'retry preserves successful shipment'); assert.equal(state.syncRetryBodies[0].additionalRequestBudget, 0);
  result.run.status = 'running'; result.items[1].status = 'running'; await expect(bar()).toHaveAttribute('aria-valuenow', '50');
  await processStage('分组与成员').click(); await currentProcess('分组与成员'); await delay(250);
  const hiddenReads = state.syncResultReads; await delay(1800); assert.equal(state.syncResultReads, hiddenReads, 'hidden M2 step stops progress polling');
  await processStage('同步与商品').click(); await expect(bar()).toHaveAttribute('aria-valuenow', '50');
  await expect.poll(() => state.syncResultReads).toBeGreaterThan(hiddenReads);
  result.run.status = 'completed'; result.items[1].status = 'completed'; result.run.errorMessage = null;
  await expect(bar()).toHaveAttribute('aria-valuenow', '100'); await expect(bar()).toHaveAttribute('aria-valuetext', /成功 2 票.*失败 0 票/);
  note(step); await context.close();


}

try {
  await mkdir(evidence, { recursive: true });
  if (!failed) await rm(resolve(evidence, 'failure.png'), { force: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  baseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  // The unified demand/batch list and creation handoff are covered by T34.
  // Keep the former split-view checks available for archived builds.
  if (process.env.BATCH_WORKSPACE_CHECK_SCOPE === 'legacy') {
    const state = fixture(), context = await contextFor(state);
    await listChecks(state); await processChecks(state); await context.close(); await creationChecks();
  }
  if (process.env.BATCH_WORKSPACE_CHECK_SCOPE !== 'progress') { await processFaultChecks(); await dateMetadataChecks(); }
  await lingxingProgressChecks();
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  heldReleases.forEach((release) => release()); await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-batch-workspace-browser', passed: !failed, checks, browserErrors, unexpectedRequests, externalRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
