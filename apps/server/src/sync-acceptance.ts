import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DemandSnapshot } from '@scm/contracts';
import { PgBoss } from 'pg-boss';
import { readConfig } from './config.js';
import { closeDatabase, pool } from './db/client.js';
import { LingxingReadClient, type LingxingReadDependencies } from './modules/lingxing/read-client.js';
import { createSubBatch, createWeeklyBatch, getSubBatchDetail } from './modules/batches/service.js';
import { BATCH_SYNC_QUEUE, executeBatchSync, getBatchSyncRun, reconcileBatchSyncRuns, requestBatchSync, retryBatchSync } from './modules/batches/sync-jobs.js';

async function run() {
  const config = readConfig(); assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_automation_dev');
  const id = randomUUID(); const actorId = `sync-test-${id}`; const demandId = randomUUID(); const sid = 1_880_000_000 + Math.floor(Math.random() * 1_000_000);
  const fba = `FBA${id.replaceAll('-', '').toUpperCase()}`; const runIds: string[] = []; let groupId = ''; let batchId = ''; let failed = false;
  const checks: string[] = []; const queue = { send: async () => randomUUID() } as unknown as PgBoss;
  const recoverySchema = `sync_recovery_${id.replaceAll('-', '')}`; let recoveryBoss: PgBoss | undefined;
  let requests = 0; let detailFailure = true;
  const product = { msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', productName: '离线同步技术商品' };
  const dependencies = { createClient: async (dependencies: LingxingReadDependencies) => new LingxingReadClient({ appId: '0123456789abcdef', accessToken: 'synthetic-sync-token' }, { ...dependencies, fetchImpl: async (url, options) => {
    requests++; const path = new URL(String(url)).pathname; const params = JSON.parse(String(options?.body));
    assert(!String(url).includes('real-credential'));
    if (path.endsWith('/shipmentList')) return Response.json({ code: 0, total: 1, data: { list: [{ sid, shipment_id: fba, sta_shipment_id: 'TECH-INTERNAL', is_sta: 1, item_list: [{ ...product, quantity_shipped: 5, init_quantity_shipped: 5, quantity_shipped_local: 0, quantity_received: 4 }] }] } });
    assert.equal(params.sid, sid); assert.equal(params.shipmentConfirmationId, fba);
    if (path.endsWith('/shipmentDetailList')) { if (detailFailure) { detailFailure = false; throw new Error('synthetic interrupted request'); } return Response.json({ code: 0, data: { shipmentList: [{ sid, shipmentConfirmationId: fba, shipmentId: 'TECH-INTERNAL', itemList: [{ ...product, quantity: 5 }] }] } }); }
    assert(path.endsWith('/listShipmentBoxes'));
    return Response.json({ code: 0, data: { shipmentList: [{ shipmentId: 'TECH-INTERNAL', shipmentPackingList: [{ boxId: 'TECH-BOX1', packageId: 'TECH-PACKAGE1', localBoxId: 1, boxName: 'P1 - B7', total: 5, weight: 3.5, weightUnit: 'LB', productList: [{ ...product, quantityInBox: 5 }] }] }] } });
  } }) };
  try {
    await pool.query('insert into "user"(id,name,email,role) values($1,$1,$2,\'admin\')', [actorId, `${actorId}@acceptance.invalid`]);
    const snapshot: DemandSnapshot = { sid, fba, shop: '离线同步技术店铺', country: '美国', channel: '技术渠道', destinationFc: 'TECH-FC', referenceQuantity: null, notes: 'TECHNICAL FIXTURE', subBatchName: null };
    await pool.query('insert into demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) values($1,$2,$3,$4,1,\'1998-01-05\',\'1998-01-05\',\'1998-01-11\')', [demandId, sid, fba, snapshot]);
    await pool.query('insert into demand_revision(id,demand_id,version,snapshot,created_by) values($1,$2,1,$3,$4)', [randomUUID(), demandId, snapshot, actorId]);
    batchId = (await createWeeklyBatch({ operationId: randomUUID(), weekStartDate: '1998-01-05' }, actorId)).batchId!;
    groupId = (await createSubBatch(batchId, { operationId: randomUUID(), expectedVersion: 1, name: '同步离线技术组', demandIds: [demandId], expectedDemandVersions: { [demandId]: 1 }, reason: 'TECHNICAL FIXTURE' }, actorId)).groupId!;
    const input = { operationId: randomUUID(), expectedVersion: 1, startDate: '1997-01-01', endDate: '1999-01-01', requestBudget: 10 };
    let first = await requestBatchSync(queue, groupId, input, actorId); runIds.push(first.run.id);
    assert.equal((await requestBatchSync(queue, groupId, input, actorId)).run.id, first.run.id); checks.push('sync-operation-is-idempotent');
    await executeBatchSync(first.run.id, dependencies); first = await getBatchSyncRun(first.run.id, actorId);
    assert.equal(first.run.status, 'failed'); assert.equal(first.run.requestsUsed, 2); assert.equal(first.items[0]!.snapshotIds.length, 2); checks.push('failed-ticket-preserves-success-and-error-snapshots');
    await retryBatchSync(queue, first.run.id, { operationId: randomUUID() }, actorId);
    await executeBatchSync(first.run.id, dependencies); first = await getBatchSyncRun(first.run.id, actorId);
    assert.equal(first.run.status, 'completed'); assert.equal(first.run.requestsUsed, 4); assert.equal(requests, 4); assert.equal(first.items[0]!.attempts, 2); checks.push('recovery-reuses-list-checkpoint-without-new-query');
    assert.equal(first.run.cacheHits, 1); assert.equal(first.run.authRequests, 0); checks.push('cache-hits-and-auth-attempts-are-separate-from-business-budget');
    const detail = await getSubBatchDetail(groupId, actorId); assert.equal(detail.shipments[0]!.revision!.data.boxes[0]!.weight, '3.5'); assert.equal(detail.shipments[0]!.revision!.data.items[0]!.localShippedQuantity, '0'); assert(!detail.issues.some((issue) => issue.severity === 'error')); checks.push('candidate-relations-units-and-zero-quantity-are-persisted');
    const second = await requestBatchSync(queue, groupId, { ...input, operationId: randomUUID(), requestBudget: 1 }, actorId); runIds.push(second.run.id);
    await executeBatchSync(second.run.id, dependencies);
    const limited = await getBatchSyncRun(second.run.id, actorId); assert.equal(limited.run.status, 'failed'); assert.equal(limited.run.requestsUsed, 1); assert.equal(limited.items[0]!.errorCode, 'REQUEST_BUDGET_EXHAUSTED'); checks.push('budget-is-enforced-before-next-external-attempt');
    await retryBatchSync(queue, second.run.id, { operationId: randomUUID(), additionalRequestBudget: 2 }, actorId); await executeBatchSync(second.run.id, dependencies);
    assert.equal((await getBatchSyncRun(second.run.id, actorId)).run.status, 'completed');
    const next = await getSubBatchDetail(groupId, actorId); assert.equal(next.shipments[0]!.revision!.data.boxes[0]!.id, detail.shipments[0]!.revision!.data.boxes[0]!.id); checks.push('explicit-budget-extension-and-strong-box-id-stability');
    const interrupted = await requestBatchSync(queue, groupId, { ...input, operationId: randomUUID(), requestBudget: 1 }, actorId); runIds.push(interrupted.run.id);
    await executeBatchSync(interrupted.run.id, dependencies);
    const interruptedBefore = await getBatchSyncRun(interrupted.run.id, actorId);
    assert.equal(interruptedBefore.run.requestsUsed, 1); assert.equal(interruptedBefore.items[0]!.snapshotIds.length, 1);
    // This isolated queue schema has no registered worker, so its real active
    // job cannot accidentally dispatch a company API request from another app.
    recoveryBoss = new PgBoss({ connectionString: config.DATABASE_URL, schema: recoverySchema });
    await recoveryBoss.start(); await recoveryBoss.createQueue(BATCH_SYNC_QUEUE, { retryLimit: 0, expireInSeconds: 7200 });
    const recoveryJobId = await recoveryBoss.send(BATCH_SYNC_QUEUE, { runId: interrupted.run.id }); assert(recoveryJobId);
    await recoveryBoss.fetch(BATCH_SYNC_QUEUE);
    assert.equal((await recoveryBoss.findJobs(BATCH_SYNC_QUEUE, { id: recoveryJobId }))[0]?.state, 'active');
    await pool.query('update batch_sync_run set status=\'running\',queue_job_id=$2,completed_at=null where id=$1', [interrupted.run.id, recoveryJobId]);
    await pool.query('update batch_sync_item set status=\'running\',completed_at=null,error_code=null,error_message=null where run_id=$1', [interrupted.run.id]);
    const owner = await pool.connect();
    try {
      await owner.query('select pg_advisory_lock(hashtextextended($1,0))', [`batch-sync-run:${interrupted.run.id}`]);
      await reconcileBatchSyncRuns(recoveryBoss); assert.equal((await getBatchSyncRun(interrupted.run.id, actorId)).run.status, 'running');
    } finally { await owner.query('select pg_advisory_unlock(hashtextextended($1,0))', [`batch-sync-run:${interrupted.run.id}`]); owner.release(); }
    checks.push('live-worker-session-lock-prevents-false-interruption-for-active-queue-job');
    await Promise.all([reconcileBatchSyncRuns(recoveryBoss), reconcileBatchSyncRuns(recoveryBoss)]);
    const recovered = await getBatchSyncRun(interrupted.run.id, actorId);
    assert.equal(recovered.run.status, 'failed'); assert.equal(recovered.items[0]!.errorCode, 'SYNC_INTERRUPTED'); assert.deepEqual(recovered.items[0]!.snapshotIds, interruptedBefore.items[0]!.snapshotIds);
    assert.equal((await recoveryBoss.findJobs(BATCH_SYNC_QUEUE, { id: recoveryJobId }))[0]?.state, 'active');
    checks.push('orphaned-active-job-recovers-immediately-without-two-hour-expiry-or-lost-checkpoints');
    await retryBatchSync(queue, interrupted.run.id, { operationId: randomUUID(), additionalRequestBudget: 2 }, actorId); await executeBatchSync(interrupted.run.id, dependencies);
    const resumed = await getBatchSyncRun(interrupted.run.id, actorId); assert.equal(resumed.run.status, 'completed'); assert.equal(resumed.run.requestsUsed, 3); assert.equal(resumed.run.cacheHits, 1);
    checks.push('immediate-user-retry-reuses-checkpoint-with-active-old-job-retained');
    const third = await requestBatchSync(queue, groupId, { ...input, operationId: randomUUID() }, actorId); runIds.push(third.run.id);
    await pool.query('update sub_batch set version=version+1 where id=$1', [groupId]); const before = requests;
    await assert.rejects(() => executeBatchSync(third.run.id, dependencies), (error: unknown) => (error as { code?: string }).code === 'VERSION_CONFLICT'); assert.equal(requests, before); checks.push('stale-group-rejected-before-network-and-publication');
  } catch (error) { failed = true; console.error(error instanceof Error ? error.message : 'SYNC_ACCEPTANCE_FAILED'); }
  finally {
    try {
      if (recoveryBoss) { await recoveryBoss.stop(); assert(/^sync_recovery_[a-f0-9]{32}$/.test(recoverySchema)); await pool.query(`drop schema "${recoverySchema}" cascade`); }
      const files = (await pool.query('select f.id,f.storage_key from file_index f where f.created_by=$1', [actorId])).rows as Array<{ id: string; storage_key: string }>;
      await pool.query('delete from batch_sync_snapshot where run_id=any($1::uuid[])', [runIds]); await pool.query('delete from batch_sync_retry_operation where run_id=any($1::uuid[])', [runIds]); await pool.query('delete from batch_sync_item where run_id=any($1::uuid[])', [runIds]); await pool.query('delete from batch_sync_run where id=any($1::uuid[])', [runIds]);
      await pool.query('delete from shipment_revision where created_by=$1', [actorId]); await pool.query('delete from sub_batch_revision where created_by=$1', [actorId]); await pool.query('delete from sub_batch_member where group_id=$1', [groupId || null]); await pool.query('delete from sub_batch where id=$1', [groupId || null]); await pool.query('delete from weekly_batch where id=$1', [batchId || null]); await pool.query('delete from batch_operation where actor_id=$1', [actorId]); await pool.query('delete from operation_audit where actor_user_id=$1', [actorId]); await pool.query('delete from demand_revision where demand_id=$1', [demandId]); await pool.query('delete from demand where id=$1', [demandId]); await pool.query('delete from file_index where created_by=$1', [actorId]); await pool.query('delete from "user" where id=$1', [actorId]);
      for (const file of files) { const path = resolve(config.dataDir, file.storage_key); assert(!relative(config.dataDir, path).startsWith('..')); await unlink(path); }
    } catch (error) { failed = true; console.error(`SYNC CLEANUP: ${error instanceof Error ? error.message : 'failed'}`); }
    const index = process.argv.indexOf('--report'); const report = resolve(index >= 0 ? process.argv[index + 1]! : '.local/m2-sync/sync-integration.json'); await mkdir(dirname(report), { recursive: true });
    await writeFile(report, `${JSON.stringify({ kind: 'real-postgresql-offline-sync-acceptance', createdAt: new Date().toISOString(), result: failed ? 'failed' : 'passed', checks, syntheticBusinessRequests: requests, externalBusinessRequests: 0, queueWasSimulated: true, isolatedRealQueueRecoveryTested: true, technicalFixturesRemoved: !failed }, null, 2)}\n`);
    await closeDatabase(); if (failed) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
