import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ShippingLifecycleAction, ShippingLifecycleType } from '@scm/contracts';

const state = vi.hoisted(() => ({ schema: `shipping_lifecycle_test_${crypto.randomUUID().replaceAll('-', '')}`, pool: null as Pool | null }));
vi.mock('../../db/client.js', async () => {
  const { Pool } = await import('pg'), { drizzle } = await import('drizzle-orm/node-postgres'), { readConfig } = await import('../../config.js');
  state.pool = new Pool({ connectionString: readConfig().DATABASE_URL, options: `-c search_path=${state.schema} -c timezone=Asia/Shanghai`, max: 12 });
  return { pool: state.pool, db: drizzle({ client: state.pool }) };
});
import { changeShippingLifecycle, finalizePendingShippingLifecycles, getShippingLifecycleImpact, listShippingRecycleBin } from './service.js';
import { createManualShippingRun } from '../shipping-runs/manual.js';
import { getDemandManagement, reviseDemand } from '../imports/demand-management.js';
import { assertMutableBatchArrangementInTx } from '../batches/service.js';
import { db } from '../../db/client.js';
const actor = 'lifecycle-isolated-admin';
const legacyDemand = randomUUID();
let sequence = 0;
const query = async (statement: string, values: unknown[] = []) => (await state.pool!.query(statement, values)).rows;

describe.runIf(process.env.SHIPPING_LIFECYCLE_DB_TEST === '1')('shipping lifecycle with isolated PostgreSQL', () => {
  beforeAll(async () => {
    await state.pool!.query(`CREATE SCHEMA "${state.schema}"`);
    for (const filename of (await readdir('drizzle')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      if (filename.startsWith('0023_')) {
        await query('INSERT INTO "user"(id,name,email,role) VALUES($1,$1,$2,\'admin\')', [actor, `${actor}@acceptance.invalid`]);
        const snapshot = { sid: 1, fba: 'FBALEGACYCANCELLED', shop: '历史店', country: '美国', channel: null, destinationFc: null, referenceQuantity: null, notes: null, subBatchName: null };
        await query('INSERT INTO demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) VALUES($1,1,\'FBALEGACYCANCELLED\',$2,1,\'2026-10-27\',\'2026-10-26\',\'2026-11-01\')', [legacyDemand, snapshot]);
        await query('INSERT INTO demand_revision(id,demand_id,version,snapshot,created_by) VALUES($1,$2,1,$3,$4)', [randomUUID(), legacyDemand, snapshot, actor]);
        await query('INSERT INTO operation_audit(id,action,target_id,actor_user_id,request_hash,details) VALUES($1,\'demand.cancel\',$2,$3,\'legacy\',$4)', [randomUUID(), legacyDemand, actor, { reason: '旧版删除原因', operationId: randomUUID() }]);
      }
      const source = (await readFile(`drizzle/${filename}`, 'utf8')).replaceAll('"public".', `"${state.schema}".`);
      await state.pool!.query(source);
    }
    await query('INSERT INTO "user"(id,name,email,role) VALUES($1,$1,$2,\'admin\') ON CONFLICT DO NOTHING', [actor, `${actor}@acceptance.invalid`]);
  }, 60_000);
  afterAll(async () => { if (state.pool) { await state.pool.query(`DROP SCHEMA IF EXISTS "${state.schema}" CASCADE`); await state.pool.end(); } });

  async function fixture() {
    const run = randomUUID(), group = randomUUID(), batch = randomUUID(), demand = randomUUID(), ticket = randomUUID(), member = randomUUID(), code = randomUUID();
    const fba = `FBA${randomUUID().replaceAll('-', '').toUpperCase()}`; sequence++;
    const snapshot = { sid: 1, fba, shop: '测试店', country: '美国', channel: '海运', destinationFc: 'FC1', referenceQuantity: null, notes: null, subBatchName: null };
    await query('INSERT INTO demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) VALUES($1,1,$2,$3,1,\'2026-10-27\',\'2026-10-26\',\'2026-11-01\')', [demand, fba, snapshot]);
    await query('INSERT INTO demand_revision(id,demand_id,version,snapshot,created_by) VALUES($1,$2,1,$3,$4)', [randomUUID(), demand, snapshot, actor]);
    await query('INSERT INTO shipping_run(id,origin,status,stage,numbering_date,month,sequence,created_by) VALUES($1,\'manual\',\'draft\',\'sync\',\'2026-10-27\',\'2026-10\',$2,$3)', [run, sequence, actor]);
    await query('INSERT INTO weekly_batch(id,shipping_run_id,week_start_date,week_end_date,created_by) VALUES($1,$2,\'2026-10-26\',\'2026-11-01\',$3)', [batch, run, actor]);
    await query('INSERT INTO sub_batch(id,batch_id,name,created_by) VALUES($1,$2,\'测试批次\',$3)', [group, batch, actor]);
    await query('INSERT INTO sub_batch_member(id,batch_id,group_id,demand_id,demand_version) VALUES($1,$2,$3,$4,1)', [member, batch, group, demand]);
    await query('INSERT INTO shipping_ticket(id,run_id,source_ticket_index,country,ticket_sequence,number) VALUES($1,$2,1,\'US\',1,$3)', [ticket, run, `20261027-${sequence}-US-1`]);
    await query('INSERT INTO shipping_ticket_member(id,run_id,ticket_id,demand_id,fba,sid,input_order,group_id) VALUES($1,$2,$3,$4,$5,1,1,$6)', [randomUUID(), run, ticket, demand, fba, group]);
    await query('INSERT INTO allocation_code(id,batch_id,group_id,demand_id,box_id,prefix,sequence,code) VALUES($1,$2,$3,$4,$5,\'A\',1,\'A1\')', [code, batch, group, demand, randomUUID()]);
    return { run, group, batch, demand, ticket, member, fba, code };
  }
  async function action(type: ShippingLifecycleType, id: string, verb: ShippingLifecycleAction) {
    const impact = await getShippingLifecycleImpact(type, id, verb, actor);
    expect(impact.canExecute, JSON.stringify(impact)).toBe(true);
    const input = { operationId: randomUUID(), expectedVersion: impact.version, impactToken: impact.impactToken, reason: '隔离测试核对' };
    return { result: await changeShippingLifecycle(type, id, verb, input, actor), input };
  }

  it('migrates old demand.cancel deletion to the recycle bin with the original reason and actor', async () => {
    expect((await query('SELECT lifecycle,lifecycle_reason,lifecycle_changed_by FROM demand WHERE id=$1', [legacyDemand]))[0]).toMatchObject({ lifecycle: 'trashed', lifecycle_reason: '旧版删除原因', lifecycle_changed_by: actor });
    expect((await action('demand', legacyDemand, 'restore')).result.lifecycle).toBe('active');
    expect(await query('SELECT id FROM sub_batch_member WHERE demand_id=$1 AND active=true', [legacyDemand])).toEqual([]);
  });

  it.each(['run', 'group'] as const)('finds a recycled %s by its contained FBA', async (type) => {
    const f = await fixture(), id = type === 'run' ? f.run : f.group;
    await action(type, id, 'trash');
    const result = await listShippingRecycleBin(actor, { type, q: f.fba.toLowerCase(), page: 1, pageSize: 100 });
    expect(result.items.map((item) => item.id)).toContain(id);
  });

  it.each(['run', 'group', 'demand'] as const)('cancels and restores %s while preserving historical links and rejecting changed idempotency payloads', async (type) => {
    const f = await fixture(), id = type === 'run' ? f.run : type === 'group' ? f.group : f.demand;
    const cancelled = await action(type, id, 'cancel');
    expect(cancelled.result).toMatchObject({ lifecycle: 'cancelled', pending: false, purged: false });
    expect((await query('SELECT active FROM sub_batch_member WHERE id=$1', [f.member]))[0].active).toBe(false);
    expect((await query('SELECT released_at FROM shipping_ticket_member WHERE demand_id=$1', [f.demand]))[0].released_at).not.toBeNull();
    expect((await query('SELECT lifecycle FROM demand WHERE id=$1', [f.demand]))[0].lifecycle).toBe(type === 'demand' ? 'cancelled' : 'active');
    expect(await changeShippingLifecycle(type, id, 'cancel', cancelled.input, actor)).toMatchObject({ replayed: true });
    await expect(changeShippingLifecycle(type, id, 'cancel', { ...cancelled.input, reason: '不同请求' }, actor)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    const restored = await action(type, id, 'restore');
    expect(restored.result.lifecycle).toBe('active');
    expect((await query('SELECT active FROM sub_batch_member WHERE id=$1', [f.member]))[0].active).toBe(true);
    expect((await query('SELECT released_at FROM shipping_ticket_member WHERE demand_id=$1', [f.demand]))[0].released_at).toBeNull();
    expect((await query('SELECT valid FROM allocation_code WHERE id=$1', [f.code]))[0].valid).toBe(false);
  });

  it.each(['run', 'group', 'demand'] as const)('moves %s to the recycle bin and restores its previous cancelled state before explicit recovery', async (type) => {
    const f = await fixture(), id = type === 'run' ? f.run : type === 'group' ? f.group : f.demand;
    await action(type, id, 'cancel'); await action(type, id, 'trash');
    const recycle = await listShippingRecycleBin(actor, { type, q: '', page: 1, pageSize: 100 });
    expect(recycle.items).toContainEqual(expect.objectContaining({ id, lifecycle: 'trashed' }));
    expect((await action(type, id, 'restore')).result.lifecycle).toBe('cancelled');
    expect((await query('SELECT active FROM sub_batch_member WHERE id=$1', [f.member]))[0].active).toBe(false);
    expect((await action(type, id, 'restore')).result.lifecycle).toBe('active');
  });

  it('refuses to steal a reassigned FBA and rolls the entire restore back', async () => {
    const old = await fixture(); await action('run', old.run, 'cancel');
    const next = await fixture();
    await query('INSERT INTO sub_batch_member(id,batch_id,group_id,demand_id,demand_version) VALUES($1,$2,$3,$4,1)', [randomUUID(), next.batch, next.group, old.demand]);
    await query('INSERT INTO shipping_ticket_member(id,run_id,ticket_id,demand_id,fba,sid,input_order,group_id) VALUES($1,$2,$3,$4,$5,1,2,$6)', [randomUUID(), next.run, next.ticket, old.demand, old.fba, next.group]);
    const impact = await getShippingLifecycleImpact('run', old.run, 'restore', actor);
    expect(impact.canExecute).toBe(false); expect(impact.conflicts.some((item) => item.fba === old.fba)).toBe(true);
    await expect(changeShippingLifecycle('run', old.run, 'restore', { operationId: randomUUID(), expectedVersion: impact.version, impactToken: impact.impactToken, reason: '恢复冲突测试' }, actor)).rejects.toMatchObject({ code: 'SHIPPING_LIFECYCLE_BLOCKED' });
    expect((await query('SELECT lifecycle FROM shipping_run WHERE id=$1', [old.run]))[0].lifecycle).toBe('cancelled');
  });

  it('rejects a stale impact when a child changes even if the target version stays unchanged', async () => {
    const f = await fixture(), impact = await getShippingLifecycleImpact('run', f.run, 'cancel', actor);
    await query('UPDATE sub_batch SET version=version+1 WHERE id=$1', [f.group]);
    await expect(changeShippingLifecycle('run', f.run, 'cancel', { operationId: randomUUID(), expectedVersion: impact.version, impactToken: impact.impactToken, reason: '旧影响预览' }, actor)).rejects.toMatchObject({ code: 'SHIPPING_IMPACT_CHANGED' });
    expect((await query('SELECT lifecycle FROM shipping_run WHERE id=$1', [f.run]))[0].lifecycle).toBe('active');
  });

  it('requires explicit review when a released demand changes version before parent recovery', async () => {
    const f = await fixture(); await action('run', f.run, 'cancel');
    await reviseDemand(f.demand, actor, { operationId: randomUUID(), expectedVersion: 1, reason: '需求已重新核对', fields: { notes: '采用当前说明' } });
    const impact = await getShippingLifecycleImpact('run', f.run, 'restore', actor);
    expect(impact.canExecute).toBe(false);
    expect(impact.conflicts).toContainEqual(expect.objectContaining({ code: 'DEMAND_VERSION_CONFLICT', fba: f.fba }));
    expect((await query('SELECT active FROM sub_batch_member WHERE id=$1', [f.member]))[0].active).toBe(false);
  });

  it('preserves the original pre-numbering stage when an early organization is cancelled and restored', async () => {
    const f = await fixture(); await query('UPDATE shipping_run SET sequence=NULL,stage=\'lookup\',status=\'running\' WHERE id=$1', [f.run]);
    await action('run', f.run, 'cancel'); await action('run', f.run, 'restore');
    expect((await query('SELECT stage,sequence FROM shipping_run WHERE id=$1', [f.run]))[0]).toMatchObject({ stage: 'lookup', sequence: null });
  });

  it('persists pending cancellation while a worker owns the lock and finishes safely after release', async () => {
    const f = await fixture(), connection = await state.pool!.connect();
    try {
      await connection.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`shipping-run:${f.run}`]);
      expect((await action('run', f.run, 'cancel')).result.pending).toBe(true);
      expect((await query('SELECT lifecycle,lifecycle_pending FROM shipping_run WHERE id=$1', [f.run]))[0]).toMatchObject({ lifecycle: 'active', lifecycle_pending: true });
      await expect(reviseDemand(f.demand, actor, { operationId: randomUUID(), expectedVersion: 1, reason: '等待取消时修改', fields: { notes: '不能绕过待停止状态' } })).rejects.toMatchObject({ status: 409 });
      await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`shipping-run:${f.run}`]);
      await finalizePendingShippingLifecycles();
      expect((await query('SELECT lifecycle,lifecycle_pending FROM shipping_run WHERE id=$1', [f.run]))[0]).toMatchObject({ lifecycle: 'cancelled', lifecycle_pending: false });
    } finally { await connection.query('SELECT pg_advisory_unlock_all()'); connection.release(); }
  });

  it('preserves an independently deleted child when its parent is restored', async () => {
    const f = await fixture(); await action('run', f.run, 'cancel'); await action('group', f.group, 'trash');
    await action('run', f.run, 'restore');
    expect((await query('SELECT lifecycle FROM sub_batch WHERE id=$1', [f.group]))[0].lifecycle).toBe('trashed');
    expect((await query('SELECT active FROM sub_batch_member WHERE id=$1', [f.member]))[0].active).toBe(false);
  });

  it('releases only the target run members of a shared group and marks the other run for review', async () => {
    const first = await fixture(), second = await fixture();
    await query('UPDATE sub_batch_member SET batch_id=$1,group_id=$2 WHERE id=$3', [first.batch, first.group, second.member]);
    await query('UPDATE shipping_ticket_member SET group_id=$1 WHERE demand_id=$2', [first.group, second.demand]);
    const impact = await getShippingLifecycleImpact('run', first.run, 'cancel', actor);
    expect(impact.affectedRuns.map((run) => run.id)).toContain(second.run);
    await action('run', first.run, 'cancel');
    expect((await query('SELECT lifecycle,status FROM shipping_run WHERE id=$1', [second.run]))[0]).toMatchObject({ lifecycle: 'active', status: 'needs_review' });
    expect((await query('SELECT lifecycle FROM sub_batch WHERE id=$1', [first.group]))[0].lifecycle).toBe('active');
    expect((await query('SELECT active FROM sub_batch_member WHERE id=$1', [second.member]))[0].active).toBe(true);
    expect((await query('SELECT released_at FROM shipping_ticket_member WHERE demand_id=$1', [second.demand]))[0].released_at).toBeNull();
    await expect(db.transaction((tx) => assertMutableBatchArrangementInTx(tx, first.batch, first.group))).resolves.toBeUndefined();
    await action('run', first.run, 'restore');
    expect((await query('SELECT active FROM sub_batch_member WHERE id=$1', [first.member]))[0].active).toBe(true);
  });

  it('never reactivates a superseded historical group when cancelling and restoring the parent', async () => {
    const f = await fixture(), historical = randomUUID();
    await query('INSERT INTO sub_batch(id,batch_id,name,status,replaced_by_id,created_by) VALUES($1,$2,\'旧更正组\',\'superseded\',$3,$4)', [historical, f.batch, f.group, actor]);
    await query('INSERT INTO sub_batch_member(id,batch_id,group_id,demand_id,demand_version,active) VALUES($1,$2,$3,$4,1,false)', [randomUUID(), f.batch, historical, f.demand]);
    await action('run', f.run, 'cancel'); await action('run', f.run, 'restore');
    expect((await query('SELECT lifecycle,status FROM sub_batch WHERE id=$1', [historical]))[0]).toMatchObject({ lifecycle: 'active', status: 'superseded' });
  });

  it('directly voids published sources while preserving the immutable export and refusing permanent purge', async () => {
    const f = await fixture(), file = randomUUID(), exportId = randomUUID();
    await query('UPDATE sub_batch SET status=\'frozen\',frozen_at=now() WHERE id=$1', [f.group]);
    await query('UPDATE shipping_run SET membership_frozen_at=now() WHERE id=$1', [f.run]);
    await query('INSERT INTO file_index(id,storage_key,sha256,byte_size,original_name,mime_type,created_by) VALUES($1,$2,$3,4,\'已发布.xlsx\',\'application/octet-stream\',$4)', [file, `test/${file}`, 'a'.repeat(64), actor]);
    const projection = { shippingRunId: f.run, rows: [{ groupId: f.group, demandId: f.demand }], marker: 'immutable-original' };
    await query('INSERT INTO batch_export(id,operation_id,request_hash,created_by,queue_job_id,status,group_ids,"references",projection,file_id) VALUES($1,$2,\'test\',$3,\'offline\',\'completed\',$4,\'[]\',$5,$6)', [exportId, randomUUID(), actor, JSON.stringify([f.group]), projection, file]);
    await action('run', f.run, 'cancel'); await action('run', f.run, 'trash');
    const impact = await getShippingLifecycleImpact('run', f.run, 'purge', actor);
    expect(impact.canExecute).toBe(false); expect(impact.blockingReasons.join('')).toContain('发布');
    expect((await query('SELECT file_id,projection,status FROM batch_export WHERE id=$1', [exportId]))[0]).toMatchObject({ file_id: file, status: 'completed', projection });
  });

  it('invalidates the complete mixed invoice and workflow without rewriting external facts or revalidating on restore', async () => {
    const first = await fixture(), second = await fixture();
    const document = randomUUID(), revision = randomUUID(), workflow = randomUUID(), docExport = randomUUID(), workflowExport = randomUUID();
    const members = [{ demand: { id: first.demand }, source: { groupId: first.group } }, { demand: { id: second.demand }, source: { groupId: second.group } }];
    const source = { documentId: document, documentRevisionId: revision, members, externalMarker: 'external-source-preserved' };
    const facts = { handovers: [{ receipt: 'EXTERNAL-123', occurredAt: '2026-10-26' }], marker: 'never-rewrite-external-facts' };
    await query('INSERT INTO document(id,purpose,status,created_by) VALUES($1,\'invoice\',\'approved\',$2)', [document, actor]);
    await query('INSERT INTO document_revision(id,document_id,version,data,reason,created_by) VALUES($1,$2,1,$3,\'test\',$4)', [revision, document, { title: '混合发票', members }, actor]);
    await query('UPDATE document SET current_revision_id=$1 WHERE id=$2', [revision, document]);
    for (const f of [first, second]) await query('INSERT INTO document_member_claim(id,purpose,sid,fba,demand_id,document_id,revision_id) VALUES($1,\'invoice\',1,$2,$3,$4,$5)', [randomUUID(), f.fba, f.demand, document, revision]);
    await query('INSERT INTO document_export(id,operation_id,request_hash,reference,status,created_by) VALUES($1,$2,\'test\',$3,\'queued\',$4)', [docExport, randomUUID(), { documentId: document, revisionId: revision }, actor]);
    await query('INSERT INTO workflow_record(id,kind,title,status,source,box_ids,data,created_by) VALUES($1,\'logistics\',\'实际交接\',\'completed\',$2,\'[]\',$3,$4)', [workflow, source, facts, actor]);
    await query('INSERT INTO workflow_box_claim(id,purpose,box_id,record_id) VALUES($1,\'logistics\',$2,$3)', [randomUUID(), randomUUID(), workflow]);
    await query('INSERT INTO workflow_export(id,record_id,version,purpose,status,dependency_hash,snapshot,created_by) VALUES($1,$2,1,\'logistics\',\'queued\',\'test\',$3,$4)', [workflowExport, workflow, { source, data: facts }, actor]);
    const impact = await getShippingLifecycleImpact('demand', first.demand, 'cancel', actor);
    expect(impact.documents).toContainEqual({ id: document, title: '混合发票' }); expect(impact.workflowCount).toBe(1);
    await action('demand', first.demand, 'cancel');
    expect((await query('SELECT status FROM document WHERE id=$1', [document]))[0].status).toBe('stale');
    expect(await query('SELECT id FROM document_member_claim WHERE document_id=$1 AND released_at IS NULL', [document])).toEqual([]);
    expect((await query('SELECT status,source,data FROM workflow_record WHERE id=$1', [workflow]))[0]).toMatchObject({ status: 'stale', source, data: facts });
    expect(await query('SELECT id FROM workflow_box_claim WHERE record_id=$1 AND released_at IS NULL', [workflow])).toEqual([]);
    expect((await query('SELECT status FROM document_export WHERE id=$1', [docExport]))[0].status).toBe('stale');
    expect((await query('SELECT status FROM workflow_export WHERE id=$1', [workflowExport]))[0].status).toBe('stale');
    await action('demand', first.demand, 'restore');
    expect((await query('SELECT status FROM document WHERE id=$1', [document]))[0].status).toBe('stale');
    expect((await query('SELECT source,data FROM workflow_record WHERE id=$1', [workflow]))[0]).toEqual({ source, data: facts });
    expect((await getDemandManagement(first.demand, actor)).management.canEdit).toBe(true);
  });

  it('clears durable pending state and records the error when a delayed restore encounters a new claim', async () => {
    const f = await fixture(); await action('run', f.run, 'cancel');
    const connection = await state.pool!.connect();
    let operationId = '';
    try {
      await connection.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`shipping-run:${f.run}`]);
      const pending = await action('run', f.run, 'restore'); operationId = pending.input.operationId; expect(pending.result.pending).toBe(true);
      const next = await fixture();
      await query('INSERT INTO sub_batch_member(id,batch_id,group_id,demand_id,demand_version) VALUES($1,$2,$3,$4,1)', [randomUUID(), next.batch, next.group, f.demand]);
      await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`shipping-run:${f.run}`]);
      await finalizePendingShippingLifecycles();
      expect((await query('SELECT lifecycle,lifecycle_pending FROM shipping_run WHERE id=$1', [f.run]))[0]).toMatchObject({ lifecycle: 'cancelled', lifecycle_pending: false });
      const [operation] = await query('SELECT pending,error FROM shipping_lifecycle_operation WHERE operation_id=$1', [operationId]);
      expect(operation.pending).toBe(0); expect(operation.error).toContain('冲突');
      await expect(changeShippingLifecycle('run', f.run, 'restore', pending.input, actor)).rejects.toMatchObject({ code: 'SHIPPING_LIFECYCLE_FAILED' });
    } finally { await connection.query('SELECT pg_advisory_unlock_all()'); connection.release(); }
  });

  it('permanently purges an unpublished run, retains demands and tombstones earlier lifecycle requests', async () => {
    const f = await fixture(); const trashed = await action('run', f.run, 'trash'); await action('run', f.run, 'purge');
    expect(await query('SELECT id FROM shipping_run WHERE id=$1', [f.run])).toEqual([]);
    expect((await query('SELECT lifecycle FROM demand WHERE id=$1', [f.demand]))[0].lifecycle).toBe('active');
    expect(await changeShippingLifecycle('run', f.run, 'trash', trashed.input, actor)).toMatchObject({ purged: true, replayed: true });
    expect((await query('SELECT data FROM shipping_lifecycle_snapshot WHERE entity_id=$1', [f.run]))[0].data).toBeNull();
  });

  it('restores a legacy deleted demand without inventing its former arrangement', async () => {
    const f = await fixture();
    await query('UPDATE sub_batch_member SET active=false WHERE demand_id=$1', [f.demand]);
    await query('UPDATE shipping_ticket_member SET released_at=now() WHERE demand_id=$1', [f.demand]);
    await query('UPDATE demand SET lifecycle=\'trashed\',lifecycle_changed_at=now(),lifecycle_snapshot_id=NULL WHERE id=$1', [f.demand]);
    await action('demand', f.demand, 'restore');
    expect((await query('SELECT lifecycle FROM demand WHERE id=$1', [f.demand]))[0].lifecycle).toBe('active');
    expect((await query('SELECT active FROM sub_batch_member WHERE id=$1', [f.member]))[0].active).toBe(false);
  });

  it('purges an unpublished group and then its unassigned FBA without deleting the enclosing run', async () => {
    const f = await fixture(); await action('group', f.group, 'trash'); await action('group', f.group, 'purge');
    expect(await query('SELECT id FROM sub_batch WHERE id=$1', [f.group])).toEqual([]);
    expect(await query('SELECT id FROM shipping_run WHERE id=$1', [f.run])).toHaveLength(1);
    await action('demand', f.demand, 'trash'); await action('demand', f.demand, 'purge');
    expect(await query('SELECT id FROM demand WHERE id=$1', [f.demand])).toEqual([]);
    expect(await query('SELECT id FROM demand_revision WHERE demand_id=$1', [f.demand])).toEqual([]);
  });

  it('creates a new valid arrangement after demand recovery using a real demand revision for every lifecycle version', async () => {
    const f = await fixture(); await action('demand', f.demand, 'cancel'); await action('demand', f.demand, 'restore');
    const [current] = await query('SELECT version FROM demand WHERE id=$1', [f.demand]);
    expect(await query('SELECT version FROM demand_revision WHERE demand_id=$1 AND version=$2', [f.demand, current.version])).toHaveLength(1);
    await action('group', f.group, 'cancel');
    await query('INSERT INTO shipping_month_counter(month,last_sequence) VALUES(\'2026-10\',10000) ON CONFLICT(month) DO UPDATE SET last_sequence=GREATEST(shipping_month_counter.last_sequence,10000)');
    const created = await createManualShippingRun({ operationId: randomUUID(), numberingDate: '2026-10-27', name: '恢复后新安排', reason: '重新安排', demandIds: [f.demand], expectedDemandVersions: { [f.demand]: current.version } }, actor);
    expect(created.tickets[0]!.members[0]!.demandId).toBe(f.demand);
    expect((await query('SELECT demand_version FROM sub_batch_member WHERE demand_id=$1 AND active=true', [f.demand]))[0].demand_version).toBe(current.version);
  });
});
