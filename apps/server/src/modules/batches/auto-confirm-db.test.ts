import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { confirmAndAllocateSubBatchInputSchema, type DemandSnapshot, type ShipmentData } from '@scm/contracts';

const state = vi.hoisted(() => ({ schemaName: `batch_auto_test_${crypto.randomUUID().replaceAll('-', '')}`, pool: null as Pool | null }));
vi.mock('../../db/client.js', async () => {
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { readConfig } = await import('../../config.js');
  state.pool = new Pool({ connectionString: readConfig().DATABASE_URL, options: `-c search_path=${state.schemaName} -c timezone=Asia/Shanghai`, max: 8 });
  return { db: drizzle({ client: state.pool }) };
});
import { confirmAndAllocateGroup, confirmGroup, getSubBatchDetail, getWeeklyBatch, publishCandidate } from './service.js';

describe('automatic confirmation contract', () => {
  it('requires exact versions and refuses a manual explanation', () => {
    const input = { operationId: randomUUID(), expectedVersion: 1, expectedBatchVersion: 1, expectedDemandVersions: {}, expectedShipmentVersions: {} };
    expect(confirmAndAllocateSubBatchInputSchema.safeParse(input).success).toBe(true);
    expect(confirmAndAllocateSubBatchInputSchema.safeParse({ ...input, reason: 'manual' }).success).toBe(false);
    expect(confirmAndAllocateSubBatchInputSchema.safeParse({ ...input, expectedBatchVersion: undefined }).success).toBe(false);
  });
});

describe.runIf(process.env.BATCH_AUTO_CONFIRM_DB_TEST === '1')('automatic confirmation with isolated PostgreSQL schema', () => {
  const actor = 'automatic-confirm-admin', batchId = randomUUID();
  beforeAll(async () => {
    await state.pool!.query(`CREATE SCHEMA "${state.schemaName}"`);
    const template = process.env.SCM_TEST_TEMPLATE_SCHEMA ?? 'public';
    if (!/^[a-z_][a-z0-9_]*$/.test(template)) throw new Error('Invalid test template schema');
    for (const table of ['user', 'demand', 'demand_revision', 'weekly_batch', 'sub_batch', 'sub_batch_member', 'sub_batch_revision', 'shipment_revision', 'group_confirmation', 'allocation_code', 'batch_decision', 'batch_operation', 'operation_audit', 'batch_sync_run', 'batch_sync_item', 'shipping_run', 'shipping_ticket', 'shipping_ticket_member','batch_export']) {
      await state.pool!.query(`CREATE TABLE "${table}" (LIKE "${template}"."${table}" INCLUDING ALL)`);
    }
    await state.pool!.query('INSERT INTO "user"(id,name,email,role,banned) VALUES($1,$1,$1,\'admin\',false)', [actor]);
    await state.pool!.query('INSERT INTO weekly_batch(id,week_start_date,week_end_date,created_by) VALUES($1,\'2000-01-03\',\'2000-01-09\',$2)', [batchId, actor]);
  });
  afterAll(async () => {
    if (state.pool) {
      await state.pool.query(`DROP SCHEMA IF EXISTS "${state.schemaName}" CASCADE`);
      await state.pool.end();
    }
  });
  async function fixture() {
    const demandId = randomUUID(), groupId = randomUUID(), fba = `FBA${demandId.replaceAll('-', '').toUpperCase()}`;
    const snapshot: DemandSnapshot = { sid: 123, fba, shop: '技术测试店铺', country: '美国', channel: '技术测试', destinationFc: null, referenceQuantity: null, notes: null, subBatchName: null };
    await state.pool!.query('INSERT INTO demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) VALUES($1,123,$2,$3,1,\'2000-01-03\',\'2000-01-03\',\'2000-01-09\')', [demandId, fba, snapshot]);
    await state.pool!.query('INSERT INTO demand_revision(id,demand_id,version,snapshot,created_by) VALUES($1,$2,1,$3,$4)', [randomUUID(), demandId, snapshot, actor]);
    await state.pool!.query('INSERT INTO sub_batch(id,batch_id,name,created_by) VALUES($1,$2,\'技术自动确认\',$3)', [groupId, batchId, actor]);
    await state.pool!.query('INSERT INTO sub_batch_member(id,batch_id,group_id,demand_id,demand_version) VALUES($1,$2,$3,$4,1)', [randomUUID(), batchId, groupId, demandId]);
    const data: ShipmentData = { sid: 123, fba, shipmentStatus: 'CLOSED', items: [{ msku: 'M', fnsku: 'F', sku: 'S', name: '技术测试商品', quantity: '3', receivedQuantity: '0' }], boxes: [{ id: randomUUID(), externalBoxId: 'box-1', packageId: null, localBoxId: null, name: '箱1', order: 1, items: [{ msku: 'M', fnsku: 'F', sku: 'S', quantity: '3' }] }], observedAt: '2000-01-03T00:00:00Z', issues: [] };
    await publishCandidate({ demandId, subBatchId: groupId, expectedGroupVersion: 1, expectedDemandVersion: 1, actorId: actor, data, source: 'manual' });
    return { groupId, demandId, data };
  }
  async function input(groupId: string) {
    const detail = await getSubBatchDetail(groupId, actor), batch = await getWeeklyBatch(batchId, actor);
    return { operationId: randomUUID(), expectedVersion: detail.group.version, expectedBatchVersion: batch.batch.version, expectedDemandVersions: Object.fromEntries(detail.members.map((member) => [member.id, member.version])), expectedShipmentVersions: Object.fromEntries(detail.shipments.map((shipment) => [shipment.demandId, shipment.revision!.version])) };
  }
  const confirm = async (groupId: string) => confirmAndAllocateGroup(groupId, await input(groupId), actor);
  const counts = async (groupId: string) => (await state.pool!.query('SELECT (SELECT count(*)::int FROM group_confirmation WHERE group_id=$1) confirmations,(SELECT count(*)::int FROM allocation_code WHERE group_id=$1 AND valid) codes', [groupId])).rows[0];

  it('permits receipt warnings, confirms and allocates in one operation, and replays exactly', async () => {
    const { groupId } = await fixture(), request = await input(groupId);
    expect(await confirmAndAllocateGroup(groupId, request, actor)).toMatchObject({ groupId, batchId, replayed: false });
    const first = await getSubBatchDetail(groupId, actor);
    expect(first.group).toMatchObject({ status: 'confirmed', version: 2 });
    expect(first.issues.some((issue) => issue.code === 'RECEIVED_DIFFERENCE' && issue.severity === 'warning')).toBe(true);
    expect(await counts(groupId)).toEqual({ confirmations: 1, codes: 1 });
    expect(await confirmAndAllocateGroup(groupId, request, actor)).toMatchObject({ replayed: true });
    expect(await counts(groupId)).toEqual({ confirmations: 1, codes: 1 });
    expect(first.history[0]!.reason).toBe('系统自动确认当前有效数据版本并分配箱码');
    const audit = (await state.pool!.query('SELECT details FROM operation_audit WHERE action=\'sub_batch.confirm_and_allocate\' AND target_id=$1', [groupId])).rows[0];
    expect(audit.details.reason).toBe('系统自动确认当前有效数据版本并分配箱码');
    await expect(confirmAndAllocateGroup(groupId, { ...request, expectedBatchVersion: request.expectedBatchVersion + 1 }, actor)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });
  it('preserves the original confirmation, versions, prefix and code on a fresh equivalent request', async () => {
    const { groupId } = await fixture(); await confirm(groupId);
    const first = await getSubBatchDetail(groupId, actor), before = await getWeeklyBatch(batchId, actor);
    await confirm(groupId);
    const second = await getSubBatchDetail(groupId, actor), after = await getWeeklyBatch(batchId, actor);
    expect(second.confirmation!.id).toBe(first.confirmation!.id);
    expect(second.group.version).toBe(first.group.version); expect(second.codes).toEqual(first.codes);
    expect(after.batch).toEqual(before.batch); expect(await counts(groupId)).toEqual({ confirmations: 1, codes: 1 });
  });
  it('reuses a compatible confirmation made through the existing manual API', async () => {
    const { groupId } = await fixture(), request = await input(groupId);
    await confirmGroup(groupId, { ...request, reason: 'existing API' }, actor);
    const first = await getSubBatchDetail(groupId, actor);
    expect(first.codes).toHaveLength(0);
    await confirm(groupId); const second = await getSubBatchDetail(groupId, actor);
    expect(second.confirmation!.id).toBe(first.confirmation!.id); expect(second.group.version).toBe(first.group.version);
    expect(await counts(groupId)).toEqual({ confirmations: 1, codes: 1 });
  });
  it('serializes concurrent requests and does not create redundant versions', async () => {
    const { groupId } = await fixture(), request = await input(groupId);
    const outcomes = await Promise.allSettled([confirmAndAllocateGroup(groupId, request, actor), confirmAndAllocateGroup(groupId, { ...request, operationId: randomUUID() }, actor)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
    expect(await counts(groupId)).toEqual({ confirmations: 1, codes: 1 });
  });
  it('preserves existing codes and appends new boxes under the same prefix', async () => {
    const { groupId, demandId, data } = await fixture(); await confirm(groupId);
    const first = await getSubBatchDetail(groupId, actor), prefixBefore = (await getWeeklyBatch(batchId, actor)).batch.nextPrefix;
    const changed: ShipmentData = { ...data, items: [{ ...data.items[0]!, quantity: '6' }], boxes: [...data.boxes, { ...data.boxes[0]!, id: randomUUID(), externalBoxId: 'box-2', name: '箱2', order: 2 }] };
    await publishCandidate({ demandId, subBatchId: groupId, expectedGroupVersion: first.group.version, expectedDemandVersion: 1, actorId: actor, data: changed, source: 'manual' });
    await confirm(groupId); const second = await getSubBatchDetail(groupId, actor);
    expect(second.group.prefix).toBe(first.group.prefix); expect(second.codes[0]).toEqual(first.codes[0]);
    expect(second.codes[1]!.code).toBe(`${first.group.prefix}2`);
    expect((await getWeeklyBatch(batchId, actor)).batch.nextPrefix).toBe(prefixBefore);
  });
  it('rolls back confirmation and audit when allocation fails', async () => {
    const { groupId } = await fixture(), request = await input(groupId);
    await state.pool!.query('ALTER TABLE allocation_code ADD CONSTRAINT automatic_failure CHECK(group_id<>\'' + groupId + '\'::uuid)');
    try { await expect(confirmAndAllocateGroup(groupId, request, actor)).rejects.toMatchObject({ cause: { code: '23514' } }); }
    finally { await state.pool!.query('ALTER TABLE allocation_code DROP CONSTRAINT automatic_failure'); }
    expect(await counts(groupId)).toEqual({ confirmations: 0, codes: 0 });
    expect((await getSubBatchDetail(groupId, actor)).group).toMatchObject({ version: 1, status: 'draft', confirmedVersion: null, prefix: null });
    expect((await state.pool!.query('SELECT count(*)::int count FROM batch_operation WHERE operation_id=$1', [request.operationId])).rows[0].count).toBe(0);
    expect((await getWeeklyBatch(batchId, actor)).batch.version).toBe(request.expectedBatchVersion);
    await confirmAndAllocateGroup(groupId, request, actor);
    expect(await counts(groupId)).toEqual({ confirmations: 1, codes: 1 });
  });
  it('refuses blocking differences and any omitted or extra member versions', async () => {
    const { groupId, demandId, data } = await fixture(), request = await input(groupId);
    await expect(confirmAndAllocateGroup(groupId, { ...request, expectedDemandVersions: {} }, actor)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(confirmAndAllocateGroup(groupId, { ...request, expectedShipmentVersions: { ...request.expectedShipmentVersions, [randomUUID()]: 1 } }, actor)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await publishCandidate({ demandId, subBatchId: groupId, expectedGroupVersion: 1, expectedDemandVersion: 1, actorId: actor, data: { ...data, boxes: [] }, source: 'manual' });
    await expect(confirm(groupId)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' });
    expect(await counts(groupId)).toEqual({ confirmations: 0, codes: 0 });
  });
  it('blocks active sync and a failed reread of previously valid candidates, allowing an explicit repair', async () => {
    const { groupId, demandId, data } = await fixture(), runId = randomUUID();
    await state.pool!.query('INSERT INTO batch_sync_run(id,sub_batch_id,group_version,operation_id,request_hash,start_date,end_date,request_budget,created_by) VALUES($1,$2,1,$3,\'test\',\'2000-01-03\',\'2000-01-04\',10,$4)', [runId, groupId, randomUUID(), actor]);
    await state.pool!.query('INSERT INTO batch_sync_item(id,run_id,demand_id,demand_version,sid,fba) VALUES($1,$2,$3,1,123,$4)', [randomUUID(), runId, demandId, data.fba]);
    await expect(confirm(groupId)).rejects.toMatchObject({ code: 'SYNC_ACTIVE' });
    await state.pool!.query('UPDATE batch_sync_run SET status=\'failed\',completed_at=clock_timestamp() WHERE id=$1', [runId]);
    await state.pool!.query('UPDATE batch_sync_item SET status=\'failed\' WHERE run_id=$1', [runId]);
    await expect(confirm(groupId)).rejects.toMatchObject({ code: 'SYNC_FAILED' });
    await publishCandidate({ demandId, subBatchId: groupId, expectedGroupVersion: 1, expectedDemandVersion: 1, actorId: actor, data, source: 'manual' });
    await confirm(groupId); expect(await counts(groupId)).toEqual({ confirmations: 1, codes: 1 });
  });
  it('rejects frozen and superseded groups', async () => {
    const frozen = await fixture(); await confirm(frozen.groupId);
    await state.pool!.query('UPDATE sub_batch SET status=\'frozen\',frozen_at=clock_timestamp() WHERE id=$1', [frozen.groupId]);
    await expect(confirm(frozen.groupId)).rejects.toMatchObject({ code: 'GROUP_FROZEN' });
    const superseded = await fixture(); await state.pool!.query('UPDATE sub_batch SET status=\'superseded\' WHERE id=$1', [superseded.groupId]);
    await expect(confirm(superseded.groupId)).rejects.toMatchObject({ code: 'GROUP_SUPERSEDED' });
  });
});
