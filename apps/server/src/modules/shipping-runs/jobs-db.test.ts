import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { DemandSnapshot, FbaLookupInput, ShipmentData } from '@scm/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ schemaName: `shipping_run_test_${crypto.randomUUID().replaceAll('-', '')}`, pool: null as Pool | null, queuedLookup: false,
  failSync: false, crashSync: false, lookupCalls: 0, syncCalls: 0, countries: new Map<string, string>(), jobs: new Map<string, string>() }));
vi.mock('../../db/client.js', async () => {
  const { Pool } = await import('pg'); const { drizzle } = await import('drizzle-orm/node-postgres'); const { readConfig } = await import('../../config.js');
  state.pool = new Pool({ connectionString: readConfig().DATABASE_URL, options: `-c search_path=${state.schemaName} -c timezone=Asia/Shanghai`, max: 16 });
  return { db: drizzle({ client: state.pool }), pool: state.pool };
});
vi.mock('../imports/fba-lookup.js', async () => {
  const { db } = await import('../../db/client.js'); const { fbaLookupRuns } = await import('../imports/fba-lookup-schema.js'); const { eq } = await import('drizzle-orm');
  const candidates = (fbas: string[]) => fbas.map((fba) => { const country = state.countries.get(fba) ?? 'US'; return { fba, status: 'unique', candidates: [{ sid: country === 'UK' ? 202 : 101, shop: country === 'UK' ? '英国测试店' : '美国测试店', country: country === 'UK' ? '英国' : '美国',
    channel: '海运', channelStatus: 'unique', channelSource: 'method_name', channelOptions: [], destinationFc: 'FC1', destinationAddress: '测试仓库地址', shipmentCreatedAt: '2026-10-01 12:00:00', observedAt: '2026-10-23T00:00:00.000Z' }] }; });
  const read = async (id: string) => { const [row] = await db.select().from(fbaLookupRuns).where(eq(fbaLookupRuns.id, id)); return { ...row!, createdAt: row!.createdAt.toISOString(), completedAt: row!.completedAt?.toISOString() ?? null }; };
  return { getFbaLookup: read, requestFbaLookup: async (_boss: PgBoss, input: FbaLookupInput, actor: string) => {
    const [old] = await db.select().from(fbaLookupRuns).where(eq(fbaLookupRuns.operationId, input.operationId)); if (old) return read(old.id);
    state.lookupCalls++; const id = randomUUID();
    await db.insert(fbaLookupRuns).values({ id, operationId: input.operationId, requestHash: id, startDate: input.startDate, endDate: input.endDate, fbas: input.fbas, catalogMode: 'manual', catalogSettingsVersion: input.expectedCatalogSettingsVersion, catalogVersion: input.expectedCatalogVersion,
      sellerScope: [{ id: randomUUID(), sid: 101, name: '美国测试店', country: '美国', version: 1 }], createdBy: actor, status: state.queuedLookup ? 'queued' : 'completed', rows: state.queuedLookup ? [] : candidates(input.fbas), completedAt: state.queuedLookup ? null : new Date() });
    return read(id);
  }, completeTestLookups: async () => { const rows = await db.select().from(fbaLookupRuns); for (const row of rows) if (row.status === 'queued') await db.update(fbaLookupRuns).set({ status: 'completed', rows: candidates(row.fbas), completedAt: new Date() }).where(eq(fbaLookupRuns.id, row.id)); } };
});
vi.mock('../batches/sync-jobs.js', async () => {
  const { db } = await import('../../db/client.js'); const { demands } = await import('../../db/schema.js'); const { batchSyncRuns, batchSyncItems, batchSyncRetryOperations } = await import('../lingxing/sync-schema.js');
  const { subBatchMembers } = await import('../batches/schema.js'); const { publishCandidate } = await import('../batches/service.js'); const { and, eq } = await import('drizzle-orm');
  const read = async (id: string) => { const [run] = await db.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, id)); return { run: { ...run!, createdAt: run!.createdAt.toISOString(), completedAt: run!.completedAt?.toISOString() ?? null }, items: await db.select().from(batchSyncItems).where(eq(batchSyncItems.runId, id)) }; };
  const fill = async (id: string) => {
    const [run] = await db.select().from(batchSyncRuns).where(eq(batchSyncRuns.id, id)); const result = await read(id);
    for (const item of result.items) {
      if (item.status === 'completed') continue;
      if (state.failSync) { await db.update(batchSyncItems).set({ status: 'failed', errorCode: 'TEST_TRANSIENT', errorMessage: '技术测试：暂时不可用', completedAt: new Date() }).where(eq(batchSyncItems.id, item.id)); continue; }
      const data: ShipmentData = { sid: item.sid, fba: item.fba, items: [{ msku: 'M', fnsku: 'F', sku: 'S', name: '测试商品', quantity: '3' }], boxes: [{ id: randomUUID(), externalBoxId: 'B1', packageId: null, localBoxId: null, name: '箱1', order: 1, items: [{ msku: 'M', fnsku: 'F', sku: 'S', quantity: '3' }] }], observedAt: '2026-10-23T00:00:00Z', issues: [] };
      const revision = await publishCandidate({ demandId: item.demandId, subBatchId: run!.subBatchId, expectedGroupVersion: run!.groupVersion, expectedDemandVersion: item.demandVersion, data, source: 'manual', actorId: run!.createdBy });
      await db.update(batchSyncItems).set({ status: 'completed', revisionId: revision.id, errorCode: null, errorMessage: null, completedAt: new Date() }).where(eq(batchSyncItems.id, item.id));
    }
    await db.update(batchSyncRuns).set({ status: state.failSync ? 'failed' : 'completed', completedAt: new Date() }).where(eq(batchSyncRuns.id, id));
  };
  return { getBatchSyncRun: read, requestBatchSync: async (_boss: PgBoss, groupId: string, input: { operationId: string; expectedVersion: number; startDate: string; endDate: string; requestBudget: number; maxPages: number }, actor: string) => {
    const [old] = await db.select().from(batchSyncRuns).where(eq(batchSyncRuns.operationId, input.operationId)); if (old) return read(old.id);
    state.syncCalls++; const id = randomUUID();
    await db.insert(batchSyncRuns).values({ id, subBatchId: groupId, groupVersion: input.expectedVersion, operationId: input.operationId, requestHash: id, startDate: input.startDate, endDate: input.endDate, requestBudget: input.requestBudget, maxPages: input.maxPages, createdBy: actor });
    const members = await db.select({ demand: demands }).from(subBatchMembers).innerJoin(demands, eq(demands.id, subBatchMembers.demandId)).where(and(eq(subBatchMembers.groupId, groupId), eq(subBatchMembers.active, true)));
    for (const { demand } of members) await db.insert(batchSyncItems).values({ id: randomUUID(), runId: id, demandId: demand.id, demandVersion: demand.version, sid: demand.sid, fba: demand.fba });
    await fill(id);
    if (state.crashSync) { state.crashSync = false; throw new Error('TECHNICAL_SIMULATED_WORKER_INTERRUPTION_AFTER_SYNC_COMMIT'); }
    return read(id);
  }, retryBatchSync: async (_boss: PgBoss, id: string, input: { operationId: string }, actor: string) => {
    const [old] = await db.select().from(batchSyncRetryOperations).where(eq(batchSyncRetryOperations.operationId, input.operationId)); if (old) return read(id);
    await fill(id); await db.insert(batchSyncRetryOperations).values({ operationId: input.operationId, runId: id, actorId: actor, requestHash: id }); return read(id);
  } };
});

import { db } from '../../db/client.js';
import { demandRevisions, demands, fileIndex, importCommits, importParseRuns, operationAudit, sellerCatalogSettings, sellerMappings, sourceImports, sourceImportRows, user } from '../../db/schema.js';
import { shipmentRevisions, subBatchMembers, subBatches, weeklyBatches } from '../batches/schema.js';
import { correctGroup, createSubBatch, createWeeklyBatch, confirmAndAllocateGroup, getSubBatchDetail, getWeeklyBatch, mergeGroups, publishCandidate, reviseGroupAfterDemandMutationInTx, splitGroup } from '../batches/service.js';
import { getShipmentReport } from '../batches/report-service.js';
import { commitImport, createImportPreview } from '../imports/confirmation.js';
import { eq, sql } from 'drizzle-orm';
import { createShippingRun, getShippingRun, retryShippingRun } from './service.js';
import { addShippingTicket, appendShippingTicketMembers, correctShippingRun, createManualShippingRun } from './manual.js';
import { executeShippingRun, reconcileShippingRuns } from './jobs.js';
import { shippingMonthCounters, shippingRunCorrections, shippingRuns, shippingTicketMembers } from './schema.js';

const actor = 'shipping-isolated-admin';
const boss = { send: async () => { const id = randomUUID(); state.jobs.set(id, 'created'); return id; }, findJobs: async (_queue: string, input: { id: string }) => state.jobs.has(input.id) ? [{ id: input.id, state: state.jobs.get(input.id) }] : [] } as unknown as PgBoss;
describe.runIf(process.env.SHIPPING_RUN_DB_TEST === '1')('shipping pipeline with isolated PostgreSQL and offline external jobs', () => {
  beforeAll(async () => {
    await state.pool!.query(`CREATE SCHEMA "${state.schemaName}"`);
    const template = process.env.SCM_TEST_TEMPLATE_SCHEMA ?? 'public';
    if (!/^[a-z_][a-z0-9_]*$/.test(template)) throw new Error('Invalid SCM_TEST_TEMPLATE_SCHEMA');
    for (const table of ['user', 'file_index', 'source_import', 'import_parse_run', 'source_import_row', 'source_mapping_version', 'seller_mapping', 'seller_alias', 'seller_catalog_settings', 'operation_audit', 'demand', 'demand_revision', 'demand_source', 'import_preview', 'import_commit', 'weekly_batch', 'sub_batch', 'sub_batch_member', 'sub_batch_revision', 'shipment_revision', 'group_confirmation', 'allocation_code', 'batch_decision', 'batch_operation', 'batch_export', 'batch_sync_run', 'batch_sync_item', 'batch_sync_retry_operation', 'fba_lookup_run', 'shipping_run', 'shipping_ticket', 'shipping_ticket_member', 'shipping_month_counter', 'shipping_run_operation', 'shipping_run_correction']) await state.pool!.query(`CREATE TABLE "${table}" (LIKE "${template}"."${table}" INCLUDING ALL)`);
    await db.insert(user).values({ id: actor, name: actor, email: `${actor}@acceptance.invalid`, role: 'admin' });
    await db.insert(sellerCatalogSettings).values({ id: 'global', mode: 'manual' });
    for (const [sid, name, country] of [[101, '美国测试店', '美国'], [202, '英国测试店', '英国']] as const) await db.insert(sellerMappings).values({ id: randomUUID(), sid, name, country, status: 'approved', sourceObservedAt: new Date(), sourceSha256: '0'.repeat(64) });
  });
  afterAll(async () => { if (state.pool) { await state.pool.query(`DROP SCHEMA "${state.schemaName}" CASCADE`); await state.pool.end(); } });
  beforeEach(() => { state.queuedLookup = false; state.failSync = false; state.crashSync = false; state.lookupCalls = 0; state.syncCalls = 0; state.countries.clear(); });
  async function manualDemand(businessDate = '2026-09-01', weekStartDate = '2026-08-31', weekEndDate = '2026-09-06') {
    const id = randomUUID(), fba = `FBA${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const snapshot: DemandSnapshot = { sid: 101, fba, shop: '美国测试店', country: '美国', channel: '海运', destinationFc: 'FC1', referenceQuantity: null, notes: null, subBatchName: null };
    await db.insert(demands).values({ id, sid: 101, fba, snapshot, version: 1, businessDate, weekStartDate, weekEndDate });
    await db.insert(demandRevisions).values({ id: randomUUID(), demandId: id, version: 1, snapshot, createdBy: actor });
    return id;
  }
  it('creates manual occurrences atomically across import weeks/months and never syncs or renumbers a replay', async () => {
    const ids = [await manualDemand(), await manualDemand('2026-10-23', '2026-10-19', '2026-10-25')];
    const input = { operationId: randomUUID(), numberingDate: '2030-01-23', name: '跨周人工发货', reason: '人工核对', demandIds: ids, expectedDemandVersions: Object.fromEntries(ids.map((id) => [id, 1])) };
    const created = await createManualShippingRun(input, actor), replay = await createManualShippingRun(input, actor);
    expect(created.run).toMatchObject({ origin: 'manual', status: 'draft', sequence: 1, importId: null, parseRunId: null });
    expect(created.tickets).toHaveLength(1); expect(created.tickets[0]!.members.map((member) => member.demandId)).toEqual(ids);
    expect(new Set(created.tickets[0]!.members.map((member) => member.groupId)).size).toBe(1);
    expect(replay.run.id).toBe(created.run.id); expect(replay.tickets[0]!.number).toBe(created.tickets[0]!.number); expect(state.syncCalls).toBe(0);
    await expect(createManualShippingRun({ ...input, operationId: randomUUID(), numberingDate: '2030-02-01', demandIds: [randomUUID()] }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await db.select().from(shippingMonthCounters).where(eq(shippingMonthCounters.month, '2030-02'))).toEqual([]);
  });
  it('adds tickets and cross-week members with version checks, preserves numbering, and snapshots frozen arrangements', async () => {
    const first = await manualDemand(), extra = await manualDemand('2026-10-23', '2026-10-19', '2026-10-25'), second = await manualDemand();
    const run = await createManualShippingRun({ operationId: randomUUID(), numberingDate: '2030-03-23', name: '首票', reason: '核对', demandIds: [first], expectedDemandVersions: { [first]: 1 } }, actor);
    const ticket = run.tickets[0]!, groupId = ticket.members[0]!.groupId!;
    const appended = await appendShippingTicketMembers(run.run.id, ticket.id, { operationId: randomUUID(), expectedVersion: run.run.version, groupId, expectedGroupVersion: 1, reason: '追加', demandIds: [extra], expectedDemandVersions: { [extra]: 1 } }, actor);
    expect(appended.tickets[0]!.number).toBe(ticket.number); expect(appended.tickets[0]!.members.map((member) => member.inputOrder)).toEqual([1, 2]);
    await expect(addShippingTicket(run.run.id, { operationId: randomUUID(), expectedVersion: run.run.version, name: '旧版', reason: '核对', demandIds: [second], expectedDemandVersions: { [second]: 1 } }, actor)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const added = await addShippingTicket(run.run.id, { operationId: randomUUID(), expectedVersion: appended.run.version, name: '第二票', reason: '核对', demandIds: [second], expectedDemandVersions: { [second]: 1 } }, actor);
    expect(added.run.sequence).toBe(run.run.sequence); expect(added.tickets.map((entry) => entry.ticketSequence)).toEqual([1, 2]);
    await db.update(shippingRuns).set({ membershipFrozenAt: new Date() }).where(eq(shippingRuns.id, run.run.id));
    await expect(addShippingTicket(run.run.id, { operationId: randomUUID(), expectedVersion: added.run.version, name: '第三票', reason: '核对', demandIds: [randomUUID()], expectedDemandVersions: {} }, actor)).rejects.toMatchObject({ code: 'SHIPPING_MEMBERSHIP_FROZEN' });
    const corrected = await correctShippingRun(run.run.id, { operationId: randomUUID(), expectedVersion: added.run.version, reason: '更正安排' }, actor);
    expect(corrected.run.membershipFrozenAt).toBeNull(); expect(corrected.run.sequence).toBe(run.run.sequence); expect(corrected.tickets.map((entry) => entry.number)).toEqual(added.tickets.map((entry) => entry.number));
    expect(await db.select().from(shippingRunCorrections).where(eq(shippingRunCorrections.runId, run.run.id))).toHaveLength(1);
  });
  it('keeps ticket links after splitting cross-week members and rejects merging groups from different occurrences', async () => {
    const ids = [await manualDemand(), await manualDemand('2026-10-23', '2026-10-19', '2026-10-25')], outside = await manualDemand();
    const create = (demandIds: string[]) => createManualShippingRun({ operationId: randomUUID(), numberingDate: '2030-04-23', name: '范围核对', reason: '核对', demandIds, expectedDemandVersions: Object.fromEntries(demandIds.map((id) => [id, 1])) }, actor);
    const first = await create(ids), second = await create([outside]);
    const split = await splitGroup(first.tickets[0]!.members[0]!.groupId!, { operationId: randomUUID(), expectedVersion: 1, groups: ids.map((id, index) => ({ name: `拆分${index}`, demandIds: [id] })), reason: '拆分核对' }, actor);
    const current = await getShippingRun(first.run.id, actor);
    expect(current.tickets[0]!.number).toBe(first.tickets[0]!.number);
    expect(new Set(current.tickets[0]!.members.map((member) => member.groupId))).toEqual(new Set(split.groupIds));
    const otherGroup = second.tickets[0]!.members[0]!.groupId!;
    await expect(mergeGroups(split.groupIds![0]!, { operationId: randomUUID(), expectedVersion: 1, sourceGroupIds: [otherGroup], expectedGroupVersions: { [otherGroup]: 1 }, reason: '不可跨发货次' }, actor)).rejects.toMatchObject({ code: 'SHIPPING_RUN_SCOPE_MISMATCH' });
    expect((await getShippingRun(second.run.id, actor)).tickets[0]!.members[0]!.groupId).toBe(otherGroup);
  });
  it('serializes concurrent claims of one new demand across two occurrence groups', async () => {
    const initial = [await manualDemand(), await manualDemand()], shared = await manualDemand();
    const runs = await Promise.all(initial.map((id) => createManualShippingRun({ operationId: randomUUID(), numberingDate: '2030-05-23', name: '并发安排', reason: '核对', demandIds: [id], expectedDemandVersions: { [id]: 1 } }, actor)));
    const results = await Promise.allSettled(runs.map((run) => appendShippingTicketMembers(run.run.id, run.tickets[0]!.id, { operationId: randomUUID(), expectedVersion: run.run.version, groupId: run.tickets[0]!.members[0]!.groupId!, expectedGroupVersion: 1, reason: '并发追加', demandIds: [shared], expectedDemandVersions: { [shared]: 1 } }, actor)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => result.reason.code)).toEqual(['MEMBER_ALREADY_SHIPPED']);
    expect(await db.select().from(shippingTicketMembers).where(eq(shippingTicketMembers.demandId, shared))).toHaveLength(1);
    expect(await db.select().from(subBatchMembers).where(sql`${subBatchMembers.demandId}=${shared} AND ${subBatchMembers.active}=true`)).toHaveLength(1);
  });
  it('resumes a manual-origin failed sync using a fresh recovery attempt and the same numbers', async () => {
    const id = await manualDemand();
    const draft = await createManualShippingRun({ operationId: randomUUID(), numberingDate: '2030-06-23', name: '人工恢复', reason: '核对', demandIds: [id], expectedDemandVersions: { [id]: 1 } }, actor);
    state.failSync = true;
    await retryShippingRun(boss, draft.run.id, { operationId: randomUUID(), expectedVersion: draft.run.version }, actor);
    for (let pass = 0; pass < 3 && (await getShippingRun(draft.run.id, actor)).run.status !== 'needs_review'; pass++) await executeShippingRun(boss, draft.run.id);
    const failed = await getShippingRun(draft.run.id, actor); expect(failed.run.status).toBe('needs_review');
    state.failSync = false;
    await retryShippingRun(boss, draft.run.id, { operationId: randomUUID(), expectedVersion: failed.run.version }, actor);
    for (let pass = 0; pass < 3 && (await getShippingRun(draft.run.id, actor)).run.status !== 'ready'; pass++) await executeShippingRun(boss, draft.run.id);
    const ready = await getShippingRun(draft.run.id, actor);
    expect(ready.run.status).toBe('ready'); expect(ready.run.sequence).toBe(draft.run.sequence); expect(ready.tickets[0]!.number).toBe(draft.tickets[0]!.number);
    expect(state.lookupCalls).toBe(0);
  });
  it('releases a cancelled demand claim and atomically refuses to empty its final ticket', async () => {
    const ids = [await manualDemand(), await manualDemand()];
    const run = await createManualShippingRun({ operationId: randomUUID(), numberingDate: '2030-07-23', name: '成员取消', reason: '核对', demandIds: ids, expectedDemandVersions: Object.fromEntries(ids.map((id) => [id, 1])) }, actor);
    const groupId = run.tickets[0]!.members[0]!.groupId!;
    const cancel = (id: string) => db.transaction(async (tx) => {
      await tx.select().from(shippingRuns).where(eq(shippingRuns.id, run.run.id)).for('update');
      const [initial] = await tx.select().from(subBatches).where(eq(subBatches.id, groupId));
      await tx.select().from(weeklyBatches).where(eq(weeklyBatches.id, initial!.batchId)).for('update');
      const [group] = await tx.select().from(subBatches).where(eq(subBatches.id, groupId)).for('update');
      await reviseGroupAfterDemandMutationInTx(tx, group!, id, 1, actor, true, '取消核对');
    });
    await cancel(ids[0]!);
    const current = await getShippingRun(run.run.id, actor);
    expect(current.run.version).toBeGreaterThan(run.run.version); expect(current.tickets[0]!.members.map((member) => member.demandId)).toEqual([ids[1]]);
    expect(await db.select().from(shippingTicketMembers).where(eq(shippingTicketMembers.demandId, ids[0]!))).toHaveLength(0);
    await expect(cancel(ids[1]!)).rejects.toMatchObject({ code: 'EMPTY_TICKET' });
    expect((await getShippingRun(run.run.id, actor)).tickets[0]!.members.map((member) => member.demandId)).toEqual([ids[1]]);
    expect((await getSubBatchDetail(groupId, actor)).members.map((member) => member.id)).toEqual([ids[1]]);
  });
  async function fixture(tickets: Array<Array<{ fba?: string; country?: string }>> = [[{}]], month = '2026-10') {
    const fileId = randomUUID(), importId = randomUUID(), parseRunId = randomUUID();
    await db.insert(fileIndex).values({ id: fileId, storageKey: fileId, sha256: '0'.repeat(64), byteSize: 1, originalName: '技术测试清单.xlsx', mimeType: 'application/octet-stream', createdBy: actor });
    await db.insert(sourceImports).values({ id: importId, fileId, sha256: importId, originalName: '技术测试清单.xlsx', byteSize: 1, createdBy: actor, importedAt: new Date(), businessDate: '2026-10-23', datePolicyVersion: 'import-date-shanghai-v1', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25', status: 'preview_ready', latestRunId: parseRunId });
    await db.insert(importParseRuns).values({ id: parseRunId, importId, queueJobId: randomUUID(), createdBy: actor, status: 'completed', inputVersion: 1, mappingVersion: 'fba-list-v1', sheetName: '清单', parserVersion: 'xlsx-preview-v3' });
    let rowNumber = 1; const fbas: string[] = [];
    for (const [index, ticket] of tickets.entries()) {
      for (const [memberIndex, member] of ticket.entries()) {
        const fba = member.fba ?? `FBA${randomUUID().replaceAll('-', '').toUpperCase()}`; fbas.push(fba); state.countries.set(fba, member.country ?? 'US');
        await db.insert(sourceImportRows).values({ id: randomUUID(), parseRunId, sheetName: '清单', rowNumber: rowNumber++, status: 'needs_review', rawCells: [{ address: `A${rowNumber}`, column: 'A', type: 'string', rawValue: fba, value: fba, numberFormat: '@', formula: null, formulaCache: 'not_formula', hidden: false }], normalized: { shop: null, country: null, channel: null, destinationFc: null, fba, referenceQuantity: null, sourceDate: null, sourceRecordId: null, notes: null, subBatchName: null, sellerMappingId: null, sid: null, sellerMappingVersion: null, sourceTicketIndex: index + 1, sourceMemberIndex: memberIndex + 1 }, issues: [{ code: 'SHOP_REQUIRED', severity: 'warning', message: '等待补全' }] });
      }
      rowNumber++;
    }
    const input = { operationId: randomUUID(), importId, parseRunId, numberingDate: `${month}-23` };
    return { input, fbas };
  }
  it('automatically organizes blank-line tickets, numbers per country and replays the same import without a second sequence', async () => {
    const fixtureData = await fixture([[{}, {}], [{ country: 'UK' }], [{}]]);
    const accepted = await createShippingRun(boss, fixtureData.input, actor);
    await Promise.all([executeShippingRun(boss, accepted.run.id), executeShippingRun(boss, accepted.run.id)]);
    const result = await getShippingRun(accepted.run.id, actor);
    expect(result.run.status).toBe('ready'); expect(result.tickets.map((ticket) => ticket.number)).toEqual(['20261023-1-US-1', '20261023-1-UK-1', '20261023-1-US-2']);
    expect(result.tickets.flatMap((ticket) => ticket.members.map((member) => member.fba))).toEqual(fixtureData.fbas);
    const replay = await createShippingRun(boss, { ...fixtureData.input, operationId: randomUUID() }, actor); expect(replay.run.id).toBe(accepted.run.id);
    await executeShippingRun(boss, accepted.run.id); expect(state.lookupCalls).toBe(1); expect(state.syncCalls).toBe(3);
    const [audit] = await db.select().from(operationAudit).where(eq(operationAudit.action, 'shipping_run.enrich')).limit(1);
    expect(JSON.parse(audit!.details.normalizedRevisions!)[0].before.shop).toBeNull();
    const [parsed] = await db.select().from(importParseRuns).where(eq(importParseRuns.id, fixtureData.input.parseRunId)); expect(parsed!.counts).toEqual({ totalRows: 4, validFbaRows: 4, errorRows: 0, warningRows: 0 }); expect(parsed!.inputVersion).toBe(2);
  });
  it('continues after the browser job ends and reconciliation schedules the waiting persisted run', async () => {
    state.queuedLookup = true; const data = await fixture(); const accepted = await createShippingRun(boss, data.input, actor);
    await executeShippingRun(boss, accepted.run.id); expect((await getShippingRun(accepted.run.id, actor)).run.stage).toBe('lookup');
    const [record] = await db.select().from(shippingRuns).where(eq(shippingRuns.id, accepted.run.id)); state.jobs.set(record!.queueJobId!, 'completed');
    const { completeTestLookups } = await import('../imports/fba-lookup.js') as unknown as { completeTestLookups: () => Promise<void> }; await completeTestLookups();
    await reconcileShippingRuns(boss); const [rescheduled] = await db.select().from(shippingRuns).where(eq(shippingRuns.id, accepted.run.id)); expect(rescheduled!.queueJobId).not.toBe(record!.queueJobId);
    await executeShippingRun(boss, accepted.run.id); expect((await getShippingRun(accepted.run.id, actor)).run.status).toBe('ready'); expect(state.lookupCalls).toBe(1);
  });
  it('allocates different monthly sequences concurrently and starts the next month at one', async () => {
    const fixtures = await Promise.all([fixture(undefined, '2026-11'), fixture(undefined, '2026-11'), fixture(undefined, '2026-12')]);
    const accepted = await Promise.all(fixtures.map((data) => createShippingRun(boss, data.input, actor)));
    await Promise.all(accepted.map((data) => executeShippingRun(boss, data.run.id)));
    const results = await Promise.all(accepted.map((data) => getShippingRun(data.run.id, actor)));
    expect(results.map((data) => data.run.status)).toEqual(['ready', 'ready', 'ready']); expect(results.slice(0, 2).map((data) => data.run.sequence).sort()).toEqual([1, 2]); expect(results[2]!.run.sequence).toBe(1);
    const groups = await Promise.all(results.map((data) => getSubBatchDetail(data.tickets[0]!.members[0]!.groupId!, actor)));
    expect(groups.map((detail) => detail.group.prefix)).toEqual(['A', 'A', 'A']);
    expect(groups.map((detail) => detail.codes[0]!.code)).toEqual(['A1', 'A1', 'A1']);
  });
  it('blocks mixed-country and duplicate FBA input before numbering, and can replace the uncommitted source on the same run', async () => {
    const mixed = await fixture([[{}, { country: 'UK' }]]); const accepted = await createShippingRun(boss, mixed.input, actor); await executeShippingRun(boss, accepted.run.id);
    const blocked = await getShippingRun(accepted.run.id, actor); expect(blocked.run.sequence).toBeNull(); expect(blocked.issues[0]!.code).toBe('TICKET_COUNTRY_MISMATCH');
    const fixed = await fixture([[{}]]); await retryShippingRun(boss, accepted.run.id, { operationId: randomUUID(), expectedVersion: blocked.run.version, importId: fixed.input.importId, parseRunId: fixed.input.parseRunId }, actor); await executeShippingRun(boss, accepted.run.id);
    expect((await getShippingRun(accepted.run.id, actor)).run.status).toBe('ready');
    const fba = `FBA${randomUUID().replaceAll('-', '').toUpperCase()}`; const duplicate = await fixture([[{ fba }], [{ fba }]]); const second = await createShippingRun(boss, duplicate.input, actor); await executeShippingRun(boss, second.run.id);
    expect((await getShippingRun(second.run.id, actor)).issues[0]!.code).toBe('DUPLICATE_FBA');
  });
  it('recovers a sync committed before its checkpoint result was saved without producing duplicate candidate revisions', async () => {
    state.crashSync = true; const data = await fixture(); const accepted = await createShippingRun(boss, data.input, actor); await executeShippingRun(boss, accepted.run.id);
    const failed = await getShippingRun(accepted.run.id, actor); expect(failed.run.status).toBe('failed'); expect(failed.run.stage).toBe('sync');
    const before = await db.select({ count: sql<number>`count(*)::int` }).from(shipmentRevisions);
    await retryShippingRun(boss, accepted.run.id, { operationId: randomUUID(), expectedVersion: failed.run.version }, actor); await executeShippingRun(boss, accepted.run.id);
    const ready = await getShippingRun(accepted.run.id, actor); expect(ready.run.status).toBe('ready'); expect(ready.run.sequence).toBe(failed.run.sequence);
    const after = await db.select({ count: sql<number>`count(*)::int` }).from(shipmentRevisions); expect(after).toEqual(before);
  });
  it('retries failed sync items and retains the allocated shipment and ticket numbers', async () => {
    state.failSync = true; const data = await fixture(); const accepted = await createShippingRun(boss, data.input, actor); await executeShippingRun(boss, accepted.run.id);
    const blocked = await getShippingRun(accepted.run.id, actor); expect(blocked.run.status).toBe('needs_review'); const number = blocked.tickets[0]!.number;
    state.failSync = false; await retryShippingRun(boss, accepted.run.id, { operationId: randomUUID(), expectedVersion: blocked.run.version }, actor); await executeShippingRun(boss, accepted.run.id); await executeShippingRun(boss, accepted.run.id);
    const ready = await getShippingRun(accepted.run.id, actor); expect(ready.run.status).toBe('ready'); expect(ready.tickets[0]!.number).toBe(number);
  });
  it('prevents the same demand from being occupied by another shipping run', async () => {
    const first = await fixture(); const a = await createShippingRun(boss, first.input, actor); await executeShippingRun(boss, a.run.id);
    const second = await fixture([[{ fba: first.fbas[0]! }]]); const b = await createShippingRun(boss, second.input, actor); await executeShippingRun(boss, b.run.id);
    const result = await getShippingRun(b.run.id, actor); expect(result.issues[0]!.code).toBe('MEMBER_ALREADY_SHIPPED'); expect(result.issues[0]!.message).toContain((await getShippingRun(a.run.id, actor)).tickets[0]!.number);
  });
  it('recovers a committed import even after source reparse when member publication had failed', async () => {
    const data = await fixture(); const accepted = await createShippingRun(boss, data.input, actor);
    await state.pool!.query('ALTER TABLE shipping_ticket_member ADD CONSTRAINT technical_claim_failure CHECK(demand_id IS NULL) NOT VALID');
    try { await executeShippingRun(boss, accepted.run.id); } finally { await state.pool!.query('ALTER TABLE shipping_ticket_member DROP CONSTRAINT technical_claim_failure'); }
    const failed = await getShippingRun(accepted.run.id, actor); expect(failed.run.stage).toBe('commit'); expect(failed.run.status).toBe('failed');
    const commits = await db.select().from(importCommits).where(eq(importCommits.importId, data.input.importId)); expect(commits).toHaveLength(1);
    const replacementParseId = randomUUID(); await db.insert(importParseRuns).values({ id: replacementParseId, importId: data.input.importId, queueJobId: randomUUID(), createdBy: actor, status: 'completed', inputVersion: 3, parserVersion: 'xlsx-preview-v3' });
    await db.update(sourceImports).set({ latestRunId: replacementParseId, version: 3 }).where(eq(sourceImports.id, data.input.importId));
    await retryShippingRun(boss, accepted.run.id, { operationId: randomUUID(), expectedVersion: failed.run.version }, actor); await executeShippingRun(boss, accepted.run.id);
    expect((await getShippingRun(accepted.run.id, actor)).run.status).toBe('ready'); expect(await db.select().from(importCommits).where(eq(importCommits.importId, data.input.importId))).toHaveLength(1);
  });
  it('reuses a frozen legacy group but reports only the FBA explicitly included in this shipment', async () => {
    const included = `FBA${randomUUID().replaceAll('-', '').toUpperCase()}`, extra = `FBA${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const demandIds: string[] = [];
    for (const fba of [included, extra]) {
      const id = randomUUID(); demandIds.push(id);
      const snapshot: DemandSnapshot = { sid: 101, fba, shop: '美国测试店', country: '美国', channel: '海运', destinationFc: 'FC1', referenceQuantity: null, notes: null, subBatchName: null, destinationAddress: '测试仓库地址', shipmentCreatedAt: '2026-10-01 12:00:00' };
      await db.insert(demands).values({ id, sid: 101, fba, snapshot, version: 1, businessDate: '2026-10-23', weekStartDate: '2026-10-19', weekEndDate: '2026-10-25' });
      await db.insert(demandRevisions).values({ id: randomUUID(), demandId: id, version: 1, snapshot, createdBy: actor });
    }
    const batchId = (await createWeeklyBatch({ operationId: randomUUID(), weekStartDate: '2026-10-19' }, actor)).batchId!;
    const batch = await getWeeklyBatch(batchId, actor); const groupId = (await createSubBatch(batchId, { operationId: randomUUID(), expectedVersion: batch.batch.version, name: '原有冻结组', demandIds, expectedDemandVersions: Object.fromEntries(demandIds.map((id) => [id, 1])), reason: '技术测试' }, actor)).groupId!;
    for (const [index, fba] of [included, extra].entries()) {
      const data: ShipmentData = { sid: 101, fba, items: [{ msku: 'M', fnsku: 'F', sku: 'S', name: '原组商品', quantity: '3' }], boxes: [{ id: randomUUID(), externalBoxId: 'B', packageId: null, localBoxId: null, name: '箱', order: 1, items: [{ msku: 'M', fnsku: 'F', sku: 'S', quantity: '3' }] }], observedAt: '2026-10-23T00:00:00Z', issues: [] };
      await publishCandidate({ demandId: demandIds[index]!, subBatchId: groupId, expectedGroupVersion: 1, expectedDemandVersion: 1, data, source: 'manual', actorId: actor });
    }
    const detail = await getSubBatchDetail(groupId, actor), currentWeek = await getWeeklyBatch(batchId, actor);
    await confirmAndAllocateGroup(groupId, { operationId: randomUUID(), expectedVersion: detail.group.version, expectedBatchVersion: currentWeek.batch.version, expectedDemandVersions: Object.fromEntries(demandIds.map((id) => [id, 1])), expectedShipmentVersions: Object.fromEntries(demandIds.map((id) => [id, 1])) }, actor);
    await db.update(subBatches).set({ status: 'frozen', frozenAt: new Date() }).where(eq(subBatches.id, groupId));
    const source = await fixture([[{ fba: included }]]); const accepted = await createShippingRun(boss, source.input, actor); await executeShippingRun(boss, accepted.run.id);
    const ready = await getShippingRun(accepted.run.id, actor); expect(ready.run.status).toBe('ready'); expect(ready.tickets[0]!.members[0]!.groupId).toBe(groupId); expect(state.syncCalls).toBe(0);
    expect((await getSubBatchDetail(groupId, actor)).members).toHaveLength(2);
    const report = await getShipmentReport(actor, { shippingRunId: ready.run.id }); expect(report.rows.map((row) => row.fba)).toEqual([included]); expect(report.boxes.map((box) => box.fba)).toEqual([included]);
    const original = await getSubBatchDetail(groupId, actor);
    const replacement = await correctGroup(groupId, { operationId: randomUUID(), expectedVersion: original.group.version, reason: '历史组更正不能复用原发货次编码' }, actor);
    const corrected = await getSubBatchDetail(replacement.groupId!, actor), container = await getWeeklyBatch(corrected.group.batchId, actor);
    await confirmAndAllocateGroup(corrected.group.id, { operationId: randomUUID(), expectedVersion: corrected.group.version, expectedBatchVersion: container.batch.version, expectedDemandVersions: Object.fromEntries(corrected.members.map((member) => [member.id, member.version])), expectedShipmentVersions: Object.fromEntries(corrected.shipments.map((shipment) => [shipment.demandId, shipment.revision!.version])) }, actor);
    const allocated = await getSubBatchDetail(corrected.group.id, actor);
    expect(allocated.group.prefix).not.toBe(original.group.prefix);
    expect(allocated.codes.every((code) => !original.codes.some((previous) => previous.code === code.code))).toBe(true);
    expect((await getSubBatchDetail(groupId, actor)).codes).toEqual(original.codes);
    expect((await getShippingRun(ready.run.id, actor)).tickets[0]!.members[0]!.groupId).toBe(corrected.group.id);
    const secondSource = await fixture([[{ fba: extra }]]), secondRun = await createShippingRun(boss, secondSource.input, actor);
    await executeShippingRun(boss, secondRun.run.id);
    expect((await getShippingRun(secondRun.run.id, actor)).run.status).toBe('ready');
    const concurrent = await Promise.all([getShippingRun(ready.run.id, actor), getShippingRun(secondRun.run.id, actor), getShipmentReport(actor, { shippingRunId: ready.run.id }), getShipmentReport(actor, { shippingRunId: secondRun.run.id })]);
    expect(concurrent[0].tickets[0]!.members[0]!.demandId).toBe(demandIds[0]); expect(concurrent[1].tickets[0]!.members[0]!.demandId).toBe(demandIds[1]);
    expect(concurrent[2].rows.map((row) => row.fba)).toEqual([included]); expect(concurrent[3].rows.map((row) => row.fba)).toEqual([extra]);
  });
  it('links an already committed source without modifying its historical normalized rows', async () => {
    const source = await fixture(); const [row] = await db.select().from(sourceImportRows).where(eq(sourceImportRows.parseRunId, source.input.parseRunId)); const [mapping] = await db.select().from(sellerMappings).where(eq(sellerMappings.sid, 101));
    const normalized = { ...row!.normalized, shop: mapping!.name, country: mapping!.country, channel: '海运', destinationFc: 'FC1', destinationAddress: '测试仓库地址', shipmentCreatedAt: '2026-10-01 12:00:00', sellerMappingId: mapping!.id, sid: mapping!.sid, sellerMappingVersion: mapping!.version };
    await db.update(sourceImportRows).set({ normalized, status: 'valid', issues: [] }).where(eq(sourceImportRows.id, row!.id));
    const preview = await createImportPreview(source.input.importId, { expectedVersion: 1, parseRunId: source.input.parseRunId, sellerSelections: [{ sourceShop: mapping!.name, sellerMappingId: mapping!.id, expectedVersion: 1, confirmed: true }], expectedCatalogSettingsVersion: 1, expectedCatalogVersion: 0 }, actor);
    await commitImport(source.input.importId, { operationId: randomUUID(), previewId: preview.preview.id, selectedItemIds: preview.preview.selectableItemIds, confirmedChangedItemIds: [] }, actor);
    const accepted = await createShippingRun(boss, source.input, actor); await executeShippingRun(boss, accepted.run.id);
    expect((await getShippingRun(accepted.run.id, actor)).run.status).toBe('ready');
    const [after] = await db.select().from(sourceImportRows).where(eq(sourceImportRows.id, row!.id)); expect(after!.normalized).toEqual(normalized);
    const [record] = await db.select().from(sourceImports).where(eq(sourceImports.id, source.input.importId)); expect(record!.version).toBe(1);
  });
  it('invalidates ready state when candidate data changes, recovers with the same number and blocks removed members', async () => {
    const data = await fixture(); const accepted = await createShippingRun(boss, data.input, actor); await executeShippingRun(boss, accepted.run.id); const ready = await getShippingRun(accepted.run.id, actor);
    const member = ready.tickets[0]!.members[0]!, detail = await getSubBatchDetail(member.groupId!, actor); const revision = detail.shipments[0]!.revision!;
    await publishCandidate({ demandId: member.demandId!, subBatchId: member.groupId!, expectedGroupVersion: detail.group.version, expectedDemandVersion: 1, data: revision.data, source: 'manual', actorId: actor });
    const stale = await getShippingRun(ready.run.id, actor); expect(stale.run.status).toBe('needs_review'); expect(stale.run.version).toBeGreaterThan(ready.run.version); expect(stale.issues[0]!.code).toBe('CONFIRMATION_STALE');
    await retryShippingRun(boss, ready.run.id, { operationId: randomUUID(), expectedVersion: stale.run.version }, actor); await executeShippingRun(boss, ready.run.id);
    const restored = await getShippingRun(ready.run.id, actor); expect(restored.run.status).toBe('ready'); expect(restored.tickets[0]!.number).toBe(ready.tickets[0]!.number);
    await db.update(subBatchMembers).set({ active: false }).where(eq(subBatchMembers.demandId, member.demandId!));
    const removed = await getShippingRun(ready.run.id, actor); expect(removed.run.status).toBe('needs_review'); expect(removed.issues[0]!.code).toBe('SHIPPING_MEMBER_REMOVED');
    await retryShippingRun(boss, ready.run.id, { operationId: randomUUID(), expectedVersion: removed.run.version }, actor); await executeShippingRun(boss, ready.run.id); expect((await getShippingRun(ready.run.id, actor)).run.status).toBe('needs_review');
  });
});
