// Explicit technical records used only to prove restoration of M2 relationships.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const [action, configPath = resolve(repo, '.local/trial/runtime.json')] = process.argv.slice(2);
assert(['create', 'remove'].includes(action), 'Specify create or remove');
const config = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(config.database, 'scm_automation_trial');
const requireServer = createRequire(resolve(config.releasePath, 'apps/server/package.json'));
Object.assign(process.env, requireServer('dotenv').parse(await readFile(config.envPath)));
assert.equal(process.env.LINGXING_REQUESTS_ENABLED, 'false', 'This fixture requires outbound access to be disabled');
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/scm_automation_trial');
const load = (path) => import(pathToFileURL(resolve(config.releasePath, 'apps/server/dist', path)));
const { pool, closeDatabase } = await load('db/client.js');
const service = await load('modules/batches/service.js');
const reports = await load('modules/batches/report-service.js');
const recordPath = resolve(config.trialRoot, 'evidence/technical-restore-fixture.json');
const op = (expectedVersion) => ({ operationId: randomUUID(), expectedVersion, reason: 'T23 TECHNICAL RESTORE FIXTURE; NOT BUSINESS ACCEPTANCE' });
try {
  if (action === 'create') {
    const actor = `t23-restore-${randomUUID()}`;
    const id = randomUUID(); const sid = 1_890_000_001; const fba = `FBA${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const record = { kind: 'technical-only-restore-fixture', actor, demandId: id, externalBusinessRequests: 0, stage: 'starting' };
    await writeFile(recordPath, JSON.stringify(record, null, 2), { flag: 'wx' });
    await pool.query('insert into "user"(id,name,email,role) values($1,$2,$3,\'admin\')', [actor, 'T23技术恢复验证（非业务）', `${actor}@acceptance.invalid`]);
    const snapshot = { sid, fba, shop: 'T23技术恢复店铺', country: '美国', channel: 'TECHNICAL', destinationFc: 'TECH-FC', referenceQuantity: null, notes: 'TECHNICAL ONLY', subBatchName: null };
    await pool.query('insert into demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) values($1,$2,$3,$4,1,\'2001-01-01\',\'2001-01-01\',\'2001-01-07\')', [id, sid, fba, snapshot]);
    await pool.query('insert into demand_revision(id,demand_id,version,snapshot,created_by) values($1,$2,1,$3,$4)', [randomUUID(), id, snapshot, actor]);
    const week = await service.createWeeklyBatch({ operationId: randomUUID(), weekStartDate: '2001-01-01' }, actor);
    record.batchId = week.batchId;
    await writeFile(recordPath, JSON.stringify(record, null, 2));
    let batch = await service.getWeeklyBatch(week.batchId, actor);
    const made = await service.createSubBatch(week.batchId, { ...op(batch.batch.version), name: 'T23技术恢复组（非真实批次）', demandIds: [id], expectedDemandVersions: { [id]: 1 } }, actor);
    record.groupId = made.groupId;
    await writeFile(recordPath, JSON.stringify(record, null, 2));
    const a = { msku: '00001', fnsku: 'X001', sku: '001' }; const b = { msku: '00002', fnsku: 'X002', sku: '001' };
    const boxes = [
      { id: randomUUID(), externalBoxId: 'T23-BOX-1', packageId: null, localBoxId: '1', name: '技术混装箱', order: 1, items: [{ ...a, quantity: '3' }, { ...b, quantity: '4' }] },
      { id: randomUUID(), externalBoxId: 'T23-BOX-2', packageId: null, localBoxId: '2', name: '技术跨箱', order: 2, items: [{ ...a, quantity: '3' }] },
    ];
    await service.publishCandidate({ demandId: id, subBatchId: made.groupId, expectedGroupVersion: 1, expectedDemandVersion: 1, actorId: actor, data: { sid, fba, items: [{ ...a, name: '技术商品A', quantity: '6' }, { ...b, name: '技术商品B', quantity: '4' }], boxes, observedAt: new Date().toISOString(), issues: [] }, source: 'manual', reason: 'Technical backup/restore test only' });
    let detail = await service.getSubBatchDetail(made.groupId, actor);
    await service.confirmGroup(made.groupId, { ...op(detail.group.version), expectedDemandVersions: { [id]: 1 }, expectedShipmentVersions: { [id]: detail.shipments[0].revision.version } }, actor);
    detail = await service.getSubBatchDetail(made.groupId, actor); batch = await service.getWeeklyBatch(week.batchId, actor);
    await service.allocateCodes(week.batchId, { ...op(batch.batch.version), groupIds: [made.groupId], expectedGroupVersions: { [made.groupId]: detail.group.version } }, actor);
    detail = await service.getSubBatchDetail(made.groupId, actor);
    const queue = { send: async () => randomUUID() };
    const requested = await reports.requestReportExport(queue, { operationId: randomUUID(), groupIds: [made.groupId], expectedConfirmations: [{ groupId: made.groupId, groupVersion: detail.group.version, confirmationId: detail.confirmation.id }], region: 'all' }, actor);
    await reports.executeReportExport(requested.export.id);
    const exported = (await reports.getExport(requested.export.id)).export;
    assert.equal(exported.status, 'completed');
    await pool.query('update "user" set banned=true where id=$1', [actor]);
    await writeFile(recordPath, JSON.stringify({ ...record, stage: 'completed', exportId: exported.id, confirmationId: detail.confirmation.id, fileId: exported.fileId }, null, 2));
    console.log('Created explicit technical confirmation, mixed boxes, codes and immutable XLSX for restoration checks.');
  } else {
    const record = JSON.parse(await readFile(recordPath, 'utf8')); assert.equal(record.kind, 'technical-only-restore-fixture');
    assert(record.actor.startsWith('t23-restore-'));
    const files = (await pool.query('select id,storage_key from file_index where created_by=$1', [record.actor])).rows;
    const groups = (await pool.query('select id from sub_batch where created_by=$1', [record.actor])).rows.map((row) => row.id);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from batch_export where created_by=$1', [record.actor]);
      for (const table of ['batch_print_record', 'batch_decision', 'allocation_code', 'group_confirmation', 'sub_batch_revision', 'sub_batch_member']) await client.query(`delete from ${table} where group_id=any($1::uuid[])`, [groups]);
      await client.query('delete from sub_batch where created_by=$1', [record.actor]);
      await client.query('delete from weekly_batch where created_by=$1', [record.actor]);
      await client.query('delete from shipment_revision where created_by=$1', [record.actor]);
      await client.query('delete from batch_operation where actor_id=$1', [record.actor]);
      await client.query('delete from operation_audit where actor_user_id=$1', [record.actor]);
      await client.query('delete from demand_revision where created_by=$1', [record.actor]);
      await client.query('delete from demand where id=$1', [record.demandId]);
      await client.query('delete from file_index where created_by=$1', [record.actor]);
      await client.query('delete from "user" where id=$1', [record.actor]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    for (const file of files) {
      const path = resolve(config.dataDir, file.storage_key); const inside = relative(config.dataDir, path);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside)); await unlink(path);
    }
    await writeFile(recordPath + '.removed.json', JSON.stringify({ ...record, removedAt: new Date().toISOString() }, null, 2));
    await unlink(recordPath);
    console.log('Removed only the identified technical restore fixture from the trial environment.');
  }
} finally { await closeDatabase(); }
