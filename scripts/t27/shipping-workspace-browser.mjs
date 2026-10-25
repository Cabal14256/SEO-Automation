import { chooseOption } from '../shared/ui-controls.mjs';
﻿import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import * as contracts from '../../packages/contracts/dist/index.js';
import { batchMutationResultSchema, batchWorkspaceQuerySchema, batchWorkspaceSchema, createSubBatchInputSchema, createWeeklyBatchInputSchema,
  demandDetailSchema, reportExportInputSchema, reportExportRecordSchema, reportResponseSchema, subBatchDetailSchema, weeklyBatchDetailSchema, weeklyBatchListSchema } from '../../packages/contracts/dist/index.js';

// Entirely in-memory HTTP fixtures. Unknown APIs and nonlocal requests are blocked;
// no database, account file, API server, shared worker or external service is used.
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.SHIPPING_WORKSPACE_EVIDENCE_DIR || resolve(root, '.local/t27/frontend'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const now = '2026-10-18T03:00:00.000Z';
const checks = [], browserErrors = [], unexpectedRequests = [], heldReleases = [], layoutMeasurements = [];
const shippingViews = ['demands', 'batches', 'reports', 'physical', 'documents'];
const shippingLabels = ['需求导入', '发货批次', '发货成品表', '实物箱确认', '发票与单据'];
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
    workspaceQueries: [], materializeBodies: [], createBodies: [], confirmBodies: [], codeBodies: [], syncBodies: [], exportBodies: [],
    createConflictOnce: false, materializeConflictOnce: false, loseCreateOnce: false, loseMaterializeOnce: false,
    holdCreate: false, releaseCreate: null, groupFailures: 0, syncFailures: 0, syncDelayOnce: 0,
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
    const ready = confirmation && confirmation.groupVersion === detail.group.version && codes.length > 0 && detail.shipments.every((shipment) => confirmation.snapshot.shipments.some((saved) => saved.demandId === shipment.demandId && saved.revision.id === shipment.revision?.id));
    const members = ready ? detail.members : [];
    return reportResponseSchema.parse({ rows: members.map((member) => {
      const revision = state.revisions.get(member.id), box = revision.data.boxes[0], code = codes.find((entry) => entry.boxId === box.id);
      return { id: member.id + '-0', groupId: detail.group.id, groupName: detail.group.name, confirmationId: confirmation.id, weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate,
        businessDate: member.businessDate, sid: member.snapshot.sid, shop: member.snapshot.shop, country: member.snapshot.country, channel: member.snapshot.channel, destinationFc: member.snapshot.destinationFc, fba: member.snapshot.fba,
        msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', productName: '技术验证商品', quantity: 10, boxes: [{ boxId: box.id, boxOrder: 1, code: code.code, quantity: 10 }], codes: [code.code], groupQuantity: 10, monthQuantity: 10, status: detail.group.status,
        actualShipDate: null, sourceObservedAt: now, dataRevisionId: revision.id };
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
    if (method === 'GET' && path.startsWith('/api/')) state.apiReads?.push(path);
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const conflict = () => json({ error: { code: 'VERSION_CONFLICT', message: '技术夹具：批次版本已变化，请重新核对。' } }, 409);
    if (url.origin !== baseURL && !['blob:', 'data:'].includes(url.protocol)) { unexpectedRequests.push(method + ' EXTERNAL ' + url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === '/api/v1/session') return json({ user: { id: 'technical-ui', name: '发货管理技术验证', email: 'shipping-ui@acceptance.invalid', role: 'admin' } });
    if (method === 'GET' && path === '/api/v1/demands') return json(demandWorkspace(state, Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/imports') return json(contracts.importListSchema.parse({ items: [state.source.record], total: 1, page: 1, pageSize: 10 }));
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.record.id) return json({ import: state.source.record });
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.record.id + '/runs') return json({ items: [state.source.run] });
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.record.id + '/rows') return json(state.source.rows);
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.record.id + '/confirmation') return json(state.source.context);
    if (method === 'GET' && path === '/api/v1/imports/' + state.source.record.id + '/commits') return json({ items: [] });
    if (method === 'GET' && path === '/api/v1/seller-mappings/catalog-settings') return json({ settings: state.source.catalog });
    if (method === 'GET' && path === '/api/v1/seller-mappings') return json({ items: [], total: 0, page: 1, pageSize: 20, settings: state.source.catalog });
    if (method === 'GET' && path === '/api/v1/batches/workspace') return json(state.workspace(Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/physical-reviews') return json(physicalWorkspace(state, Object.fromEntries(url.searchParams)));
    if (method === 'GET' && path === '/api/v1/documents') return json({ items: state.documents, total: state.documents.length, page: 1, pageSize: 20 });
    if (method === 'GET' && path === '/api/v1/documents/candidates') {
      const weekStartDate = url.searchParams.get('weekStartDate'); state.documentCandidateQueries.push(weekStartDate);
      return json(contracts.documentCandidateListSchema.parse({ items: state.documentCandidates, total: state.documentCandidates.length, weekStartDate }));
    }
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
    const physicalMatch = path.match(/^\/api\/v1\/sub-batches\/([^/]+)\/physical-review(\/history)?$/);
    if (method === 'GET' && physicalMatch) {
      if (physicalMatch[2]) return json(contracts.physicalHistorySchema.parse({ sources: [], revisions: [], confirmations: [] }));
      const detail = state.group(physicalMatch[1]);
      return json(contracts.physicalReviewSchema.parse({ groupId: detail.group.id, m2ConfirmationId: detail.confirmation?.id ?? null, version: 0,
        source: null, availableSources: [], revision: null, confirmation: null, valid: false, canConfirm: false, canExport: false,
        readOnly: detail.group.status === 'superseded', pendingChange: false, blocked: [{ code: 'SOURCE_REQUIRED', severity: 'error', message: '技术夹具：尚未完成实物确认。' }], runs: [] }));
    }
    if (method === 'GET' && path === '/api/v1/physical-exports') return json({ items: [] });
    const confirmMatch = path.match(/^\/api\/v1\/sub-batches\/([^/]+)\/confirm$/);
    if (method === 'POST' && confirmMatch) { const body = request.postDataJSON(); state.confirmBodies.push(copy(body)); return json(state.confirm(confirmMatch[1], body.operationId)); }
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
        const detail = state.group(syncMatch[1]);
        const value = { run: { id: id(), subBatchId: syncMatch[1], groupVersion: detail.group.version, status: 'completed', ...body, requestsUsed: 0, authRequests: 0, cacheHits: 0, errorCode: null, errorMessage: null, createdAt: now, startedAt: now, completedAt: now },
          items: detail.members.map((member) => ({ id: id(), demandId: member.id, sid: member.snapshot.sid, fba: member.snapshot.fba, status: 'completed', revisionId: state.revisions.get(member.id).id, errorCode: null, errorMessage: null, snapshotIds: [], requestCount: 0, attempts: 1 })) };
        state.syncRuns.set(syncMatch[1], [value]); return json(value, 202);
      }
    }
    const runMatch = path.match(/^\/api\/v1\/batch-sync\/runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) return json([...state.syncRuns.values()].flat().find((value) => value.run.id === runMatch[1]));
    if (method === 'GET' && path === '/api/v1/batch-reports') { state.reportQueries.push(Object.fromEntries(url.searchParams)); return json(state.report(url.searchParams.get('subBatchId'))); }
    if (method === 'GET' && path === '/api/v1/batch-reports/exports') { state.exportQueries.push(Object.fromEntries(url.searchParams)); return json({ items: state.exports }); }
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

function importFixture() {
  const importId = id(), runId = id(), sellerId = id();
  const catalog = contracts.sellerCatalogSettingsSchema.parse({ mode: 'manual', version: 1, catalogVersion: 2, lastSyncedAt: now, lastError: null, configured: true, readOnly: true });
  const run = contracts.importRunSchema.parse({ id: runId, importId, status: 'completed', inputVersion: 1, mappingVersion: 'manual-v1', sheetName: '技术需求', parserVersion: 'xlsx-preview-v1', processedRows: 1,
    counts: { totalRows: 1, validFbaRows: 1, errorRows: 0, warningRows: 0 }, issues: [], errorCode: null, errorMessage: null, createdAt: now, startedAt: now, completedAt: now });
  const record = contracts.sourceImportSchema.parse({ id: importId, fileId: id(), sourceType: 'xlsx', submissionStatus: 'not_submitted', submittedSourceRows: 0,
    originalName: 'technical-shipping-source.xlsx', sha256: '1'.repeat(64), byteSize: 100, createdBy: 'technical-ui', importedAt: now, businessDate: '2026-09-07', datePolicyVersion: 'import-date-shanghai-v1',
    weekStartDate: '2026-09-07', weekEndDate: '2026-09-13', status: 'preview_ready', version: 1,
    sheets: [{ name: '技术需求', state: 'visible', rowCount: 2, columnCount: 9, mergedRanges: [], hiddenColumns: [], headers: [{ column: 'E', value: 'FBA货件号' }] }], latestRun: run });
  const rows = contracts.importRowsResponseSchema.parse({ items: [{ id: id(), parseRunId: runId, sheetName: '技术需求', rowNumber: 2, hidden: false, status: 'valid',
    rawCells: [{ address: 'E2', column: 'E', type: 's', rawValue: 'FBATECH0001', value: 'FBATECH0001', numberFormat: '@', formula: null, formulaCache: 'not_formula', hidden: false }],
    normalized: { shop: '技术美国店', channel: 'HY', country: '美国', destinationFc: 'TEST1', fba: 'FBATECH0001', referenceQuantity: '10', sourceDate: null, sourceRecordId: null, notes: 'TECHNICAL HTTP FIXTURE', subBatchName: null, sellerMappingId: null, sid: null, sellerMappingVersion: null }, issues: [] }],
    total: 1, page: 1, pageSize: 20, parseRunId: runId, previewVersion: 1 });
  const context = contracts.importConfirmationContextSchema.parse({ shops: [{ sourceShop: '技术美国店', countries: ['美国'], rowCount: 1 }],
    sellers: [{ id: sellerId, sid: 101, name: '技术美国店', country: '美国', status: 'candidate', version: 1 }], latestPreviewId: null, submittedSourceRows: 0, totalSourceRows: 1, status: 'not_submitted', baselines: [], catalog });
  return { record, run, rows, context, catalog };
}
function demandWorkspace(state, raw) {
  const query = contracts.demandWorkspaceQuerySchema.parse(raw); state.demandQueries.push(copy(query));
  const member = state.demands[0];
  const row = { id: member.id + ':placeholder', demandId: member.id, rowKind: 'placeholder', demandVersion: member.version, currentDemandVersion: member.version,
    businessDate: member.businessDate, weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate,
    sid: member.snapshot.sid, shop: member.snapshot.shop, country: member.snapshot.country, channel: member.snapshot.channel, destinationFc: member.snapshot.destinationFc,
    destinationAddress: null, fba: member.snapshot.fba, msku: null, fnsku: null, sku: null, productName: null, quantity: null, referenceQuantity: '10', totalBoxes: null, boxes: [], codes: [], status: 'unsynced',
    groupId: state.primary.id, groupName: state.primary.name, groupVersion: state.primary.version, batchId: state.batch.id, confirmationId: null, dataRevisionId: null, dataVersion: null,
    actualShipDate: null, shipmentCreatedAt: null, sourceFilledAt: null, packingDays: null, metadataSource: 'xlsx', metadataObservedAt: null, notes: 'TECHNICAL HTTP FIXTURE', issues: [],
    sources: [{ importId: state.source.record.id, fileName: state.source.record.originalName, sheetName: '技术需求', rowNumber: 2 }] };
  const matches = (!query.month || member.businessDate.startsWith(query.month)) && (!query.q || (row.fba + ' ' + row.shop + ' ' + row.notes).toLowerCase().includes(query.q.toLowerCase()));
  return contracts.demandWorkspaceSchema.parse({ rows: matches ? [row] : [], total: Number(matches), demandTotal: Number(matches), page: query.page, pageSize: query.pageSize, maxBoxes: 10,
    filters: { batches: [{ id: state.batch.id, weekStartDate: state.batch.weekStartDate, weekEndDate: state.batch.weekEndDate }], shops: [{ sid: 101, name: '技术美国店' }], countries: ['美国'], channels: ['HY'] }, generatedAt: now });
}
function shippingFixture() {
  const state = fixture(); state.source = importFixture(); state.demandQueries = []; state.apiReads = []; state.reportQueries = []; state.exportQueries = [];
  state.physicalWorkspaceQueries = []; state.documentCandidateQueries = [];
  // Keep the primary group unsynced for dialog checks, and a different valid group
  // confirmed/coded so the reports view exercises real product and box columns.
  const reportGroupId = state.groups[1].id;
  state.seedCandidate(reportGroupId); state.confirm(reportGroupId, id()); state.allocate(reportGroupId, id());
  const originalReport = state.report; state.report = (groupId) => originalReport(groupId || reportGroupId);
  const detail = state.group(reportGroupId), member = detail.members[0], shipment = detail.shipments[0].revision;
  const source = { weekStartDate: member.weekStartDate, groupId: reportGroupId, groupVersion: detail.group.version, m2ConfirmationId: detail.confirmation.id,
    demandId: member.id, demandVersion: member.version, shipmentRevisionId: shipment.id, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null };
  state.documentCandidates = [contracts.documentCandidateSchema.parse({ ...source, weekEndDate: member.weekEndDate, groupName: detail.group.name, groupStatus: detail.group.status,
    demand: member, shipment, codes: detail.codes, physical: null, blockers: [{ code: 'M3_REQUIRED', severity: 'error', message: '等待实物箱整组确认。' }] })];
  const documentId = id();
  state.documents = [contracts.documentSchema.parse({ id: documentId, purpose: 'invoice', status: 'draft', version: 1,
    currentRevision: { id: id(), documentId, version: 1, reason: 'TECHNICAL HTTP FIXTURE', data: { purpose: 'invoice', weekStartDate: member.weekStartDate,
      title: '技术验证发票草稿', fields: {}, members: [{ source, demand: member, shipment, codes: detail.codes, physical: null }], profileReferences: [], templateReference: null }, createdBy: 'technical-ui', createdAt: now },
    createdBy: 'technical-ui', createdAt: now, updatedAt: now })];
  return state;
}

function physicalWorkspace(state, raw) {
  const query = contracts.physicalWorkspaceQuerySchema.parse(raw); state.physicalWorkspaceQueries.push(copy(query));
  const rows = state.groups.filter((group) => ['confirmed', 'frozen'].includes(group.status)).map((group) => {
    const detail = state.group(group.id), batch = state.batches.find((entry) => entry.id === group.batchId);
    return { id: group.id, batch: { id: batch.id, weekStartDate: batch.weekStartDate, weekEndDate: batch.weekEndDate }, group: { id: group.id, name: group.name, status: group.status },
      memberCount: detail.members.length, sids: [...new Set(detail.members.map((member) => member.snapshot.sid))], shops: [...new Set(detail.members.map((member) => member.snapshot.shop))],
      countries: [...new Set(detail.members.map((member) => member.snapshot.country))], channels: [...new Set(detail.members.map((member) => member.snapshot.channel).filter(Boolean))], fbas: detail.members.map((member) => member.snapshot.fba),
      physical: { status: 'blocked', version: 0, checkedCount: 0, boxCount: detail.codes.length, valid: false, pendingChange: false, blockedCount: 1, confirmationId: null, confirmedAt: null } };
  }).filter((row) => (!query.weekFrom || row.batch.weekEndDate >= query.weekFrom) && (!query.weekTo || row.batch.weekStartDate <= query.weekTo) &&
    (!query.sid || row.sids.includes(query.sid)) && (!query.country || row.countries.includes(query.country)) && (!query.channel || row.channels.includes(query.channel)) &&
    (!query.status || row.physical.status === query.status) && (!query.q || (row.group.name + ' ' + row.fbas.join(' ')).toLowerCase().includes(query.q.toLowerCase())));
  return contracts.physicalWorkspaceSchema.parse({ rows: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: rows.length, page: query.page, pageSize: query.pageSize,
    filters: { weeks: state.batches.map(({ weekStartDate, weekEndDate }) => ({ weekStartDate, weekEndDate })), shops: [{ sid: 101, name: '技术美国店' }], countries: ['美国'], channels: ['HY'] } });
}

const navigationHost = () => page.viewportSize().width < 768 ? page.locator('#mobile-navigation') : page.locator('aside.sidebar');
const shippingNav = () => navigationHost().getByRole('navigation', { name: '发货管理子导航', exact: true });
const shippingParent = () => navigationHost().getByRole('button', { name: '发货管理', exact: true });
const viewLink = (view) => shippingNav().locator('a[href*="view=' + view + '"]');
const demandForm = () => page.getByRole('form', { name: '筛选需求', exact: true });
const batchForm = () => page.getByRole('form', { name: '筛选发货批次', exact: true });
const reportForm = () => page.getByRole('form', { name: '筛选成品表', exact: true });
const physicalForm = () => page.getByRole('form', { name: '筛选实物箱确认任务', exact: true });
const exportDialog = () => page.getByRole('dialog', { name: '导出记录', exact: true });
const importDialog = () => page.getByRole('dialog', { name: '导入向导', exact: true });
const createDialog = () => page.getByRole('dialog', { name: '建立发货批次', exact: true });
const processDialog = () => page.getByRole('dialog', { name: '发货批次处理向导', exact: true });
const mainTable = () => page.getByRole('region', { name: '发货批次列表，可横向滚动', exact: true });
async function currentView(view) {
  await expect(page.getByRole('heading', { name: '发货管理', exact: true })).toHaveCount(1);
  assert.equal(await page.locator('.app-shell').count(), 1, 'one shared application shell');
  await expect(page.locator('main nav[aria-label="发货工作区"]')).toHaveCount(0);
  await expect(page.locator('main nav a[href*="view="]')).toHaveCount(0);
  // The desktop submenu also reflects the current view while a mobile drawer is
  // closed or a native modal prevents opening it. Inspect attributes, not hidden
  // application data, and use real menu interactions for every view change.
  const submenus = page.locator('nav[aria-label="发货管理子导航"]');
  assert(await submenus.count() > 0, 'shipping subnavigation exists');
  for (const submenu of await submenus.all()) {
    await expect(submenu.locator('a[aria-current="page"]')).toHaveCount(1);
    await expect(submenu.locator('a[href*="view=' + view + '"]')).toHaveAttribute('aria-current', 'page');
  }
}
async function openShippingNavigation() {
  if (page.viewportSize().width < 768 && !(await page.locator('#mobile-navigation').isVisible())) {
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
  }
  await expect(shippingParent()).toBeVisible();
  if (!(await shippingNav().isVisible())) await shippingParent().click();
  await expect(shippingNav()).toBeVisible();
}
async function switchView(view) { await openShippingNavigation(); await viewLink(view).click(); await currentView(view); }
async function noOpenModal() { await expect(page.locator('dialog[open]')).toHaveCount(0); }
async function assertTopDialogFocus(message) {
  const focus = await page.evaluate(() => ({ inside: [...document.querySelectorAll('dialog[open]')].at(-1)?.contains(document.activeElement), documentFocused: document.hasFocus() }));
  assert(focus.inside || !focus.documentFocused, message + ': focus may reach browser chrome but never background controls');
  if (!focus.documentFocused) {
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1)?.contains(document.activeElement))).toBe(true);
  }
}
async function capture(name) {
  const viewport = page.viewportSize(); assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= viewport.width + 1, name + ' page overflow');
  await page.screenshot({ path: resolve(evidence, name + '.png'), animations: 'disabled', timeout: 30000 });
}

async function shellAndDraftChecks(state) {
  step = 'one-shipping-sidebar-entry-default-view-and-current-navigation';
  await page.goto('/shipping'); await currentView('demands');
  const sidebar = page.locator('aside.sidebar');
  await expect(sidebar.getByRole('button', { name: '发货管理', exact: true })).toHaveCount(1);
  await expect(sidebar.getByRole('button', { name: '发货管理', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar.getByRole('link', { name: '发货管理', exact: true })).toHaveCount(0);
  for (const name of shippingLabels) await expect(shippingNav().getByRole('link', { name, exact: true })).toHaveCount(1);
  await expect(sidebar.locator('.sidebar-foot').getByRole('link', { name: '设置', exact: true })).toBeVisible(); note(step);

  step = 'content-has-no-horizontal-shipping-view-navigation';
  await expect(page.getByRole('navigation', { name: '发货工作区', exact: true })).toHaveCount(0);
  await expect(page.locator('main a[href*="/shipping"][href*="view="]')).toHaveCount(0); note(step);

  step = 'shipping-parent-toggle-preserves-current-view-and-subitem-hierarchy';
  const parentBounds = await shippingParent().boundingBox(), childBounds = await viewLink('demands').boundingBox();
  assert(parentBounds && childBounds && childBounds.x > parentBounds.x + 8, 'submenu is indented beneath shipping parent');
  await expect(shippingNav().getByRole('link')).toHaveCount(5);
  const originalURL = page.url(); await shippingParent().click();
  await expect(shippingParent()).toHaveAttribute('aria-expanded', 'false'); await expect(shippingNav()).not.toBeVisible();
  assert.equal(page.url(), originalURL, 'collapsing a group does not navigate');
  await shippingParent().click(); await expect(shippingParent()).toHaveAttribute('aria-expanded', 'true'); await currentView('demands'); note(step);

  step = 'compact-shipping-parent-expands-sidebar-and-opens-subitems';
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await expect(shippingParent()).toBeVisible(); await expect(shippingNav()).not.toBeVisible();
  await shippingParent().click();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  await expect(shippingParent()).toHaveAttribute('aria-expanded', 'true');
  await expect(shippingParent()).toBeFocused();
  await expect(shippingNav()).toBeVisible();
  await viewLink('batches').click(); await currentView('batches'); await switchView('demands'); note(step);

  step = 'five-visited-views-preserve-applied-filters-and-unsent-drafts';
  await demandForm().getByLabel('业务月份', { exact: true }).fill('2026-09');
  await demandForm().getByLabel('搜索', { exact: true }).fill('FBATECH');
  await demandForm().getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.demandQueries.at(-1)?.q).toBe('FBATECH');
  await demandForm().getByLabel('搜索', { exact: true }).fill('需求未提交筛选草稿');
  await switchView('batches');
  await batchForm().getByLabel('搜索', { exact: true }).fill('技术主批次');
  await batchForm().getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.workspaceQueries.at(-1)?.q).toBe('技术主批次');
  await batchForm().getByLabel('搜索', { exact: true }).fill('批次未提交筛选草稿');
  await switchView('reports');
  await reportForm().getByLabel('业务月份', { exact: true }).fill('2026-09');
  await chooseOption(reportForm().getByLabel('国家 / 区域', { exact: true }), 'US');
  await reportForm().getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.reportQueries.at(-1)?.month).toBe('2026-09');
  await reportForm().getByLabel('业务月份', { exact: true }).fill('2026-10');
  await chooseOption(page.getByLabel('明细视图', { exact: true }), 'boxes');
  await switchView('physical');
  await physicalForm().getByLabel('制表组名称 / FBA', { exact: true }).fill('FBATECH0002');
  await physicalForm().getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.physicalWorkspaceQueries.at(-1)?.q).toBe('FBATECH0002');
  await physicalForm().getByLabel('制表组名称 / FBA', { exact: true }).fill('实物未提交筛选草稿');
  await switchView('documents');
  await expect(page.getByRole('region', { name: '单据记录，可横向滚动', exact: true })).toContainText('技术验证发票草稿');
  await page.getByRole('button', { name: '制作发票', exact: true }).click();
  await expect.poll(() => state.documentCandidateQueries.length).toBeGreaterThan(0);
  await page.getByLabel('查找货件', { exact: true }).fill('单据未提交筛选草稿');
  await switchView('demands');
  await expect(demandForm().getByLabel('搜索', { exact: true })).toHaveValue('需求未提交筛选草稿');
  await expect(demandForm().getByLabel('业务月份', { exact: true })).toHaveValue('2026-09');
  assert.equal(state.demandQueries.at(-1).q, 'FBATECH');
  await switchView('batches');
  await expect(batchForm().getByLabel('搜索', { exact: true })).toHaveValue('批次未提交筛选草稿');
  assert.equal(state.workspaceQueries.at(-1).q, '技术主批次');
  await switchView('physical');
  await expect(physicalForm().getByLabel('制表组名称 / FBA', { exact: true })).toHaveValue('实物未提交筛选草稿');
  assert.equal(state.physicalWorkspaceQueries.at(-1).q, 'FBATECH0002');
  await physicalForm().getByRole('button', { name: '重置', exact: true }).click();
  await switchView('documents');
  await expect(page.getByLabel('查找货件', { exact: true })).toHaveValue('单据未提交筛选草稿');
  await page.getByRole('button', { name: '返回单据列表', exact: true }).click();
  await switchView('reports');
  await expect(reportForm().getByLabel('业务月份', { exact: true })).toHaveValue('2026-10');
  await expect(reportForm().getByLabel('国家 / 区域', { exact: true })).toHaveAttribute('data-value', 'US');
  assert.equal(state.reportQueries.at(-1).month, '2026-09');
  await expect(page.getByLabel('明细视图', { exact: true })).toHaveAttribute('data-value', 'boxes'); note(step);
}

async function modalIsolationChecks(state) {
  step = 'empty-import-dialog-closes-over-other-view-and-restores-original-step-on-forward';
  await switchView('demands');
  await page.getByRole('button', { name: '新增需求', exact: true }).click();
  await importDialog().getByRole('button', { name: '表格导入', exact: true }).click();
  const fileDialog = page.getByRole('dialog', { name: '表格导入', exact: true });
  // Dirty imports now use the explicit save/exit guard, covered by the draft
  // suite. Keep this scenario focused on an empty wizard's modal lifecycle.
  await expect(fileDialog.getByLabel('需求文件', { exact: true })).toBeVisible();
  await fileDialog.getByRole('button', { name: '关闭表格导入', exact: true }).click();
  await page.goBack(); await currentView('reports'); await noOpenModal();
  await page.goForward(); await currentView('demands'); await expect(importDialog()).toBeVisible();
  await expect(importDialog().getByRole('navigation', { name: '导入步骤', exact: true }).locator('[aria-current="step"]')).toContainText('填写与解析');
  await expect(importDialog().getByLabel('第 1 行FBA 货件号', { exact: true })).toHaveValue('');
  await importDialog().getByRole('button', { name: '关闭导入向导', exact: true }).click(); note(step);

  step = 'creation-dialog-does-not-overlay-demands-and-keeps-selected-members';
  await switchView('batches'); await batchForm().getByRole('button', { name: '重置', exact: true }).click();
  await mainTable().locator('tr').filter({ hasText: '待建立子批次' }).getByRole('button', { name: '新建分组', exact: true }).click();
  await createDialog().getByRole('button', { name: '下一步：选择需求', exact: true }).click();
  await createDialog().getByRole('checkbox', { name: '选择 ' + state.emptyMembers[0].snapshot.fba, exact: true }).check();
  await page.goBack(); await currentView('demands'); await noOpenModal();
  await page.goForward(); await currentView('batches'); await expect(createDialog()).toBeVisible();
  await expect(createDialog().getByRole('checkbox', { name: '选择 ' + state.emptyMembers[0].snapshot.fba, exact: true })).toBeChecked();
  await createDialog().getByRole('button', { name: '关闭建立发货批次', exact: true }).click(); note(step);

  step = 'processing-dialog-does-not-overlay-other-view-and-restores-step';
  await mainTable().locator('tr').filter({ hasText: '技术主批次' }).getByRole('button', { name: '处理向导', exact: true }).click();
  await expect(processDialog()).toBeVisible();
  await page.goBack(); await currentView('demands'); await noOpenModal();
  await page.goForward(); await currentView('batches'); await expect(processDialog()).toBeVisible();
  await expect(processDialog().getByRole('navigation', { name: '批次处理步骤', exact: true }).locator('[aria-current="step"]')).toContainText('同步与商品');
  await processDialog().getByRole('button', { name: '关闭发货批次处理向导', exact: true }).click(); note(step);
}

async function reportBehaviorChecks(state) {
  step = 'report-filters-apply-reset-and-export-use-committed-filter-scope';
  await switchView('reports');
  await reportForm().getByRole('button', { name: '重置', exact: true }).click();
  await expect(reportForm().getByLabel('业务月份', { exact: true })).toHaveValue('');
  await expect(reportForm().getByLabel('国家 / 区域', { exact: true })).toHaveAttribute('data-value', 'all');
  await expect(page.getByLabel('明细视图', { exact: true })).toHaveAttribute('data-value', 'products');
  await expect.poll(() => state.reportQueries.at(-1)?.region).toBe('all');
  await expect(page.getByRole('region', { name: '商品及逐箱数量，可横向滚动', exact: true })).toContainText('技术验证商品');
  const initialReads = state.reportQueries.length;
  await reportForm().getByLabel('业务月份', { exact: true }).fill('2026-09');
  await chooseOption(reportForm().getByLabel('国家 / 区域', { exact: true }), 'US');
  await delay(150); assert.equal(state.reportQueries.length, initialReads, 'typing draft filters does not query server');
  await reportForm().getByRole('button', { name: '筛选', exact: true }).click();
  await expect.poll(() => state.reportQueries.at(-1)?.month).toBe('2026-09');
  assert.equal(state.reportQueries.at(-1).region, 'US');
  await reportForm().getByLabel('业务月份', { exact: true }).fill('2026-10');
  await chooseOption(reportForm().getByLabel('国家 / 区域', { exact: true }), 'EU');
  const appliedReads = state.reportQueries.length;
  const generate = page.getByRole('button', { name: '生成发货表 XLSX', exact: true });
  await expect(generate).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: '筛选条件已修改' })).toBeVisible();
  assert.equal(state.exportBodies.length, 0, 'unapplied filters cannot create an export');
  await reportForm().getByLabel('业务月份', { exact: true }).fill('2026-09');
  await chooseOption(reportForm().getByLabel('国家 / 区域', { exact: true }), 'US');
  await expect(generate).toBeDisabled();
  const chosen = page.getByRole('region', { name: /^(商品及逐箱数量|逐箱长表)，可横向滚动$/ }).locator('tbody').getByRole('checkbox').first();
  await expect(chosen).not.toBeChecked();
  await chosen.check(); await expect(generate).toBeEnabled();
  await chosen.uncheck();
  await expect(generate).toBeDisabled();
  await chooseOption(page.getByLabel('明细视图', { exact: true }), 'boxes');
  await expect(page.getByRole('region', { name: '逐箱长表，可横向滚动', exact: true })).toContainText('TECH-MSKU');
  await expect(chosen).not.toBeChecked();
  await chooseOption(page.getByLabel('明细视图', { exact: true }), 'products');
  await expect(chosen).not.toBeChecked(); assert.equal(state.reportQueries.length, appliedReads, 'presentation view does not requery or reset selected export groups');
  await chosen.check(); await expect(generate).toBeEnabled();
  const reference = copy(state.report(null).confirmations[0]);
  await generate.click();
  await expect.poll(() => state.exportBodies.length).toBe(1);
  assert.deepEqual(state.exportBodies[0].expectedConfirmations, [reference]);
  assert.deepEqual(state.exportBodies[0].groupIds, [reference.groupId]);
  assert.equal(state.exportBodies[0].month, '2026-09'); assert.equal(state.exportBodies[0].region, 'US');
  await expect(page.getByRole('status').filter({ hasText: '导出任务已受理' })).toBeVisible();
  if (await exportDialog().isVisible()) await page.keyboard.press('Escape');
  await reportForm().getByRole('button', { name: '重置', exact: true }).click();
  await expect(reportForm().getByLabel('业务月份', { exact: true })).toHaveValue('');
  await expect(reportForm().getByLabel('国家 / 区域', { exact: true })).toHaveAttribute('data-value', 'all');
  await expect(page.getByLabel('明细视图', { exact: true })).toHaveAttribute('data-value', 'products');
  await expect(chosen).not.toBeChecked(); await expect(generate).toBeDisabled(); note(step);

  step = 'export-history-is-an-accessible-small-dialog-with-focus-restoration';
  const trigger = page.getByRole('button', { name: '发货表导出记录', exact: true });
  await expect(page.getByRole('region', { name: '导出历史，可横向滚动', exact: true })).not.toBeVisible();
  await trigger.click(); await expect(exportDialog()).toBeVisible();
  await expect(exportDialog().getByRole('region', { name: '导出历史，可横向滚动', exact: true })).toContainText('已生成');
  await exportDialog().getByRole('button', { name: '关闭导出记录', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await assertTopDialogFocus('Tab remains inside native history dialog');
  await exportDialog().getByRole('region', { name: '导出历史，可横向滚动', exact: true }).focus();
  await page.keyboard.press('Escape'); await expect(exportDialog()).not.toBeVisible(); await expect(trigger).toBeFocused();
  note(step);
}

async function fullWidthLayout(name) {
  const measured = await page.locator('.shipping-workspace').evaluate((workspace) => {
    const main = workspace.closest('main'), mainBounds = main.getBoundingClientRect(), bounds = workspace.getBoundingClientRect(), style = getComputedStyle(main);
    const active = workspace.querySelector('.shipping-view:not([hidden])');
    const panel = active?.querySelector('.content-panel'), heading = active?.querySelector('.import-page-heading, .batch-workspace-heading, .report-workspace-heading, .document-page-heading');
    const rect = (node) => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, width: r.width, right: r.right } : null; };
    return { main: rect(main), workspace: rect(workspace), panel: rect(panel), heading: rect(heading), leftPadding: parseFloat(style.paddingLeft), rightPadding: parseFloat(style.paddingRight), mainWidth: mainBounds.width, workspaceWidth: bounds.width };
  });
  const usable = measured.mainWidth - measured.leftPadding - measured.rightPadding;
  assert(Math.abs(measured.workspaceWidth - usable) <= 2, name + ': workspace fills all available main content width');
  assert(Math.abs(measured.workspace.x - measured.main.x - measured.leftPadding) <= 2, name + ': no extra left cap margin');
  assert(Math.abs(measured.main.right - measured.workspace.right - measured.rightPadding) <= 2, name + ': no extra right cap margin');
  assert(measured.panel && Math.abs(measured.panel.width - measured.workspace.width) <= 2, name + ': list panel fills the workspace');
  if (measured.heading) assert(Math.abs(measured.heading.x - measured.panel.x) <= 2, name + ': heading aligns with list panel');
  layoutMeasurements.push({ name, viewport: page.viewportSize(), sidebarCollapsed: await page.locator('aside.sidebar').getAttribute('data-collapsed'), ...measured });
}

async function nestedReportHistoryChecks(state) {
  step = 'batch-wizard-report-history-nested-dialog-keyboard-and-scroll-lock';
  await switchView('batches');
  await mainTable().locator('tr').filter({ hasText: state.groups[1].name }).getByRole('button', { name: '处理向导', exact: true }).click();
  await expect(processDialog()).toBeVisible();
  await expect(processDialog().getByRole('navigation', { name: '批次处理步骤', exact: true }).locator('[aria-current="step"]')).toContainText('成品与导出');
  const trigger = processDialog().getByRole('button', { name: '发货表导出记录', exact: true });
  await trigger.click(); await expect(exportDialog()).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(2);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await exportDialog().boundingBox();
    assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'nested history dialog fits viewport ' + width);
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'nested dialogs lock background scrolling');
    await exportDialog().getByRole('button', { name: '关闭导出记录', exact: true }).focus();
    await page.keyboard.press('Tab');
    await assertTopDialogFocus('keyboard remains in topmost nested dialog');
    await exportDialog().getByRole('region', { name: '导出历史，可横向滚动', exact: true }).focus();
    await capture('nested-export-history-' + width);
  }
  await exportDialog().getByRole('region', { name: '导出历史，可横向滚动', exact: true }).focus();
  await page.keyboard.press('Escape'); await expect(exportDialog()).not.toBeVisible(); await expect(processDialog()).toBeVisible();
  await expect(trigger).toBeFocused(); assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
  const embeddedStyle = await processDialog().locator('.batch-report-panel').evaluate((node) => ({ padding: getComputedStyle(node).padding, borderWidth: getComputedStyle(node).borderWidth }));
  assert.equal(embeddedStyle.padding, '0px'); assert.equal(embeddedStyle.borderWidth, '0px');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await capture('process-report-' + width);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  note(step);

  step = 'nested-report-history-remains-operable-when-processing-fieldset-is-disabled';
  await trigger.click(); await expect(exportDialog()).toBeVisible();
  const parentFieldset = processDialog().locator('fieldset.batch-process-fieldset').first();
  await parentFieldset.evaluate((node) => { node.disabled = true; });
  assert.equal(await exportDialog().evaluate((node) => node.closest('fieldset:disabled') === null), true, 'history modal escapes mutation-gating fieldsets');
  const closeHistory = exportDialog().getByRole('button', { name: '关闭导出记录', exact: true });
  const refreshHistory = exportDialog().getByRole('button', { name: '刷新历史', exact: true });
  await expect(closeHistory).toBeEnabled(); await expect(refreshHistory).toBeEnabled();
  const previousReads = state.exportQueries.length;
  await refreshHistory.click(); await expect.poll(() => state.exportQueries.length).toBeGreaterThan(previousReads);
  await closeHistory.click(); await expect(exportDialog()).not.toBeVisible(); await expect(processDialog()).toBeVisible();
  await parentFieldset.evaluate((node) => { node.disabled = false; });
  await processDialog().getByRole('button', { name: '关闭发货批次处理向导', exact: true }).click();
  await noOpenModal(); assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden', 'closing parent releases background scrolling');
  await page.setViewportSize({ width: 1440, height: 1000 }); note(step);
}

async function nestedNavigationChecks(state) {
  step = 'nested-dialog-navigation-and-spa-unmount-release-background-scroll';
  const outcomes = [];
  async function openReadyHistory() {
    if (!(await processDialog().isVisible())) await mainTable().locator('tr').filter({ hasText: state.groups[1].name }).getByRole('button', { name: '处理向导', exact: true }).click();
    await expect(processDialog()).toBeVisible();
    await processDialog().getByRole('button', { name: '发货表导出记录', exact: true }).click(); await expect(exportDialog()).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(2);
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
  }
  await page.goto('/shipping?view=demands'); await switchView('batches'); await openReadyHistory();
  await page.goBack(); await currentView('demands'); await noOpenModal();
  outcomes.push({ navigation: 'deactivate-shipping-view', overflow: await page.evaluate(() => document.body.style.overflow) });

  await page.goto('/settings'); await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  const settingsUrl = page.url();
  await switchView('batches'); await openReadyHistory();
  await page.goBack(); await expect(page).toHaveURL(settingsUrl); await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await noOpenModal();
  outcomes.push({ navigation: 'unmount-shipping-workspace', overflow: await page.evaluate(() => document.body.style.overflow) });
  assert(outcomes.every((outcome) => outcome.overflow !== 'hidden'), 'simultaneous nested dialog close releases scroll: ' + JSON.stringify(outcomes));
  note(step);
  await page.goto('/shipping?view=batches'); await expect(processDialog()).toBeVisible();
  await processDialog().getByRole('button', { name: '关闭发货批次处理向导', exact: true }).click(); await noOpenModal();
  await switchView('demands');
}

async function layoutChecks() {
  step = 'shipping-five-view-responsive-layout-1920-1440-1280-768-390-320';
  for (const width of [1920, 1440, 1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of shippingViews) {
      await switchView(view); await noOpenModal(); await fullWidthLayout(view + '-' + width);
      if (view === 'reports' && width < 768) {
        const formBounds = await reportForm().boundingBox(), viewBounds = await reportForm().getByLabel('明细视图', { exact: true }).boundingBox();
        assert(formBounds && viewBounds && Math.abs(formBounds.width - viewBounds.width) <= 2, 'mobile report view selector uses full filter width');
      }
      await capture(view + '-' + width);
    }
    if (width < 768) {
      await expect(page.locator('header.topbar').getByRole('link', { name: '设置', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '打开导航', exact: true })).toBeVisible();
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); note(step);
  step = 'all-five-shipping-views-expand-with-collapsed-sidebar-and-tables-own-horizontal-scroll';
  for (const width of [1920, 1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of shippingViews) {
      await switchView(view);
      await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
      await expect(page.locator('aside.sidebar')).toHaveAttribute('data-collapsed', 'true');
      await expect.poll(() => page.locator('aside.sidebar').evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(76);
      await fullWidthLayout(view + '-' + width + '-collapsed'); await capture(view + '-' + width + '-collapsed');
      const table = page.locator('.shipping-view:not([hidden]) .table-scroll').first();
      await expect(table).toBeVisible();
      const dimensions = await table.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowX: getComputedStyle(node).overflowX }));
      assert(['auto', 'scroll'].includes(dimensions.overflowX), 'wide tables contain their own horizontal scroll');
      if (dimensions.scrollWidth > dimensions.clientWidth + 1) {
        await table.focus(); await table.evaluate((node) => { node.scrollLeft = 0; }); await page.keyboard.press('ArrowRight');
        await expect.poll(() => table.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      }
      await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
      await expect(page.locator('aside.sidebar')).toHaveAttribute('data-collapsed', 'false');
      await expect.poll(() => page.locator('aside.sidebar').evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(208);
    }
  }
  note(step);
  step = 'mobile-menu-exposes-five-nested-shipping-views-and-closes-after-navigation';
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await openShippingNavigation();
    await expect(shippingParent()).toHaveAttribute('aria-expanded', 'true');
    await expect(shippingNav().getByRole('link')).toHaveCount(5);
    for (const name of shippingLabels) await expect(shippingNav().getByRole('link', { name, exact: true })).toBeVisible();
    await capture('mobile-subnavigation-' + width);
    await shippingParent().click(); await expect(shippingParent()).toHaveAttribute('aria-expanded', 'false'); await expect(shippingNav()).not.toBeVisible();
    await shippingParent().click();
    for (const view of shippingViews) {
      await switchView(view); await expect(page.locator('#mobile-navigation')).not.toBeVisible();
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); note(step);
  step = 'settings-lives-in-sidebar-bottom-and-retains-name-when-collapsed';
  const foot = page.locator('aside.sidebar .sidebar-foot');
  await expect(foot.getByRole('link', { name: '设置', exact: true })).toBeVisible();
  const settingsBounds = await foot.getByRole('link', { name: '设置', exact: true }).boundingBox();
  assert(settingsBounds && settingsBounds.y > page.viewportSize().height * 0.65, 'desktop settings appears near sidebar bottom');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.locator('aside.sidebar')).toHaveAttribute('data-collapsed', 'true');
  await expect(foot.getByRole('link', { name: '设置', exact: true })).toBeVisible();
  await capture('sidebar-collapsed-1440');
  await foot.getByRole('link', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.locator('aside.sidebar .sidebar-foot').getByRole('link', { name: '设置', exact: true })).toHaveAttribute('aria-current', 'page');
  note(step);
  step = 'mobile-header-settings-entry-opens-settings-without-expanding-navigation';
  await page.goto('/shipping?view=demands'); await page.setViewportSize({ width: 390, height: 1000 });
  await page.locator('header.topbar').getByRole('link', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.locator('#mobile-navigation')).not.toBeVisible(); await capture('settings-mobile-390'); note(step);
}

async function deepLinkChecks(state) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  step = 'new-demand-workspace-source-link-enters-legacy-detail-and-browser-back';
  await page.goto('/shipping?view=demands'); await currentView('demands');
  const source = page.getByRole('region', { name: '需求商品与逐箱明细表，可横向滚动', exact: true }).locator('details').filter({ has: page.locator('summary').filter({ hasText: '导入来源' }) });
  await source.locator('summary').click(); await source.getByRole('link', { name: state.source.record.originalName, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/imports/' + state.source.record.id); await currentView('demands');
  await page.goBack(); await expect(page).toHaveURL((url) => url.pathname === '/shipping' && url.searchParams.get('view') === 'demands'); await currentView('demands');
  await expect(demandForm()).toBeVisible(); note(step);
  step = 'legacy-main-links-share-shipping-header-and-active-local-view';
  for (const [path, view] of [['/imports', 'demands'], ['/batches', 'batches'], ['/batch-reports', 'reports']]) {
    await page.goto(path); await currentView(view);
    await expect(page.locator('aside.sidebar').getByRole('button', { name: '发货管理', exact: true })).toHaveAttribute('aria-expanded', 'true');
  }
  note(step);
  step = 'legacy-import-detail-and-new-import-deep-link-retain-shared-shell';
  await page.goto('/imports/' + state.source.record.id); await currentView('demands');
  await expect(page.getByText(state.source.record.originalName, { exact: true }).first()).toBeVisible();
  await page.goto('/imports/new?importId=' + state.source.record.id + '&step=2'); await currentView('demands');
  await expect(importDialog()).toBeVisible();
  await expect(importDialog().getByRole('navigation', { name: '导入步骤', exact: true }).locator('[aria-current="step"]')).toContainText('填写与解析');
  await page.keyboard.press('Escape'); note(step);
  step = 'legacy-batch-detail-query-retains-group-demand-tab-with-shared-shell';
  await page.goto('/batches/' + state.batch.id + '?groupId=' + state.primary.id + '&tab=confirmation&demandId=' + state.primary.demandIds[0]); await currentView('batches');
  await expect(page.getByRole('tab', { name: '校验、确认与编码', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: '校验、确认与编码', exact: true })).toBeVisible(); note(step);
  step = 'unknown-new-view-falls-back-to-demands';
  await page.goto('/shipping?view=unknown'); await currentView('demands'); note(step);
}

async function hiddenPollingChecks() {
  const state = shippingFixture();
  const run = { id: id(), subBatchId: state.primary.id, groupVersion: state.primary.version, status: 'running', startDate: '2026-09-01', endDate: '2026-10-01', requestBudget: 10, requestsUsed: 0,
    maxPages: 10, errorCode: null, errorMessage: null, createdAt: now, startedAt: now, completedAt: null };
  state.syncRuns.set(state.primary.id, [{ run, items: [] }]);
  const context = await contextFor(state);
  step = 'inactive-batch-view-stops-running-sync-child-polling-and-resumes-on-return';
  await page.goto('/shipping?view=demands'); await switchView('batches');
  await mainTable().locator('tr').filter({ hasText: '技术主批次' }).getByRole('button', { name: '处理向导', exact: true }).click();
  await expect(processDialog()).toBeVisible();
  await expect.poll(() => state.apiReads.filter((path) => path === '/api/v1/batch-sync/runs/' + run.id).length).toBeGreaterThan(0);
  await page.goBack(); await currentView('demands'); await noOpenModal(); await delay(100);
  const syncReads = () => state.apiReads.filter((path) => path.startsWith('/api/v1/batch-sync/')).length;
  const hiddenReads = syncReads(); await delay(1800); assert.equal(syncReads(), hiddenReads, 'hidden batch view must stop parent and child sync polling');
  await page.goForward(); await currentView('batches'); await expect(processDialog()).toBeVisible();
  await expect.poll(syncReads, { timeout: 4000 }).toBeGreaterThan(hiddenReads);
  await processDialog().getByRole('button', { name: '关闭发货批次处理向导', exact: true }).click(); note(step);

  step = 'inactive-physical-view-stops-review-polling-and-resumes-on-return';
  await switchView('physical');
  const physicalReads = () => state.apiReads.filter((path) => path === '/api/v1/physical-reviews' || /\/api\/v1\/sub-batches\/[^/]+\/physical-review$/.test(path)).length;
  await expect.poll(physicalReads).toBeGreaterThan(0);
  await page.goBack(); await currentView('batches'); await delay(100);
  const hiddenPhysicalReads = physicalReads(); await delay(3500);
  assert.equal(physicalReads(), hiddenPhysicalReads, 'hidden physical view must stop workspace and per-group review polling');
  await page.goForward(); await currentView('physical');
  await expect.poll(physicalReads, { timeout: 5000 }).toBeGreaterThan(hiddenPhysicalReads);
  await switchView('batches'); note(step);

  step = 'inactive-report-view-stops-queued-export-history-polling';
  const report = state.report(null), reference = report.confirmations[0];
  state.exports.push(contracts.reportExportRecordSchema.parse({ id: id(), status: 'queued', groupIds: [reference.groupId], references: [reference], month: null, region: 'all', fileId: null, error: null, createdAt: now, completedAt: null, rowCount: 0, boxCount: 0, valid: true, invalidReason: null }));
  await switchView('reports');
  await page.getByRole('button', { name: '发货表导出记录', exact: true }).click();
  await expect(exportDialog().getByRole('region', { name: '导出历史，可横向滚动', exact: true })).toContainText('排队中');
  await page.goBack(); await currentView('batches'); await noOpenModal(); await delay(100);
  const exportReads = () => state.apiReads.filter((path) => path === '/api/v1/batch-reports/exports').length;
  const count = exportReads(); await delay(1800); assert.equal(exportReads(), count, 'hidden report view must stop queued export polling');
  await page.goForward(); await currentView('reports');
  await page.getByRole('button', { name: '发货表导出记录', exact: true }).click(); await expect(exportDialog()).toBeVisible();
  await expect.poll(exportReads, { timeout: 4000 }).toBeGreaterThan(count);
  await page.keyboard.press('Escape'); await expect(exportDialog()).not.toBeVisible(); await delay(100);
  const closedCount = exportReads(); await delay(1800); assert.equal(exportReads(), closedCount, 'closed history dialog stops queued export polling');
  note(step); await context.close();
}

try {
  await mkdir(evidence, { recursive: true }); await rm(resolve(evidence, 'failure.png'), { force: true });
  const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  baseURL = 'http://127.0.0.1:' + port;
  const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
  viteProcess = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve(root, 'apps/web'), stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(baseURL)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  browser = await chromium.launch({ headless: true, channel: process.env.IMPORT_BROWSER_CHANNEL || 'chrome' });
  const state = shippingFixture(), context = await contextFor(state);
  if (process.env.SHIPPING_WORKSPACE_CHECK_SCOPE === 'nested') { await nestedNavigationChecks(state); await context.close(); }
  else {
    await shellAndDraftChecks(state); await modalIsolationChecks(state); await reportBehaviorChecks(state); await nestedReportHistoryChecks(state); await nestedNavigationChecks(state); await layoutChecks(); await context.close();
    const deepState = shippingFixture(), deepContext = await contextFor(deepState); await deepLinkChecks(deepState); await deepContext.close();
    await hiddenPollingChecks();
  }
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(browserErrors, []);
} catch (error) {
  failed = true; checks.push({ name: step, result: 'failed', message: error.message }); console.error(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  heldReleases.forEach((release) => release()); await browser?.close();
  if (viteProcess && viteProcess.exitCode === null) { viteProcess.kill(); await Promise.race([new Promise((done) => viteProcess.once('exit', done)), delay(5000)]); }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ kind: 'fixture-only-shipping-workspace-browser', passed: !failed, checks, layoutMeasurements, browserErrors, unexpectedRequests, externalRequests: 0 }, null, 2) + '\n');
}
if (failed) process.exitCode = 1;


