import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DemandSnapshot, ShipmentData } from '@scm/contracts';
import type { PgBoss } from 'pg-boss';
import ExcelJS from 'exceljs';
import { readConfig } from './config.js';
import { closeDatabase, pool } from './db/client.js';
import { allocateCodes, confirmGroup, createSubBatch, createWeeklyBatch, getSubBatchDetail, getWeeklyBatch, publishCandidate, setActualShipDate } from './modules/batches/service.js';
import { executeReportExport, getExport, getShipmentReport, publishReportFile, readExportFile, requestReportExport } from './modules/batches/report-service.js';
import { createReportWorkbook } from './modules/batches/workbook.js';
import { checkedFileBytes } from './modules/imports/service.js';

async function run() {
  const config = readConfig(); assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_automation_dev');
  const runId = randomUUID(); const actorId = `report-test-${runId}`; const sid = 1_870_000_000 + Math.floor(Math.random() * 1_000_000);
  const demandIds: string[] = []; const groupIds: string[] = []; const checks: string[] = [];
  let batchId = ''; let failed = false; let cleaned = false;
  const queue = { send: async () => randomUUID() } as unknown as PgBoss;
  const input = (expectedVersion: number) => ({ operationId: randomUUID(), expectedVersion, reason: 'TECHNICAL EXPORT FIXTURE' });
  async function request(groupId: string) {
    const detail = await getSubBatchDetail(groupId, actorId);
    return (await requestReportExport(queue, { operationId: randomUUID(), groupIds: [groupId], expectedConfirmations: [{ groupId, groupVersion: detail.group.version, confirmationId: detail.confirmation!.id }], region: 'all' }, actorId)).export.id;
  }
  async function fileCount() { return Number((await pool.query('select count(*) from file_index where created_by=$1', [actorId])).rows[0].count); }
  try {
    await pool.query('insert into "user"(id,name,email,role) values($1,$1,$2,\'admin\')', [actorId, `${actorId}@acceptance.invalid`]);
    let monday = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const date = new Date(Date.UTC(2000, 0, 3) - (1000 + Math.floor(Math.random() * 3000)) * 7 * 86_400_000); monday = date.toISOString().slice(0, 10);
      if (!(await pool.query('select id from weekly_batch where week_start_date=$1', [monday])).rowCount) break;
      monday = '';
    }
    assert(monday); const sunday = new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    for (let index = 0; index < 3; index++) {
      const id = randomUUID(); demandIds.push(id); const fba = `FBA${runId.replaceAll('-', '').toUpperCase()}${index}`;
      const snapshot: DemandSnapshot = { sid, fba, shop: '离线导出技术店铺', country: '美国', channel: '技术渠道', destinationFc: 'TECH-FC', referenceQuantity: null, notes: 'TECHNICAL FIXTURE', subBatchName: null };
      await pool.query('insert into demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) values($1,$2,$3,$4,1,$5,$5,$6)', [id, sid, fba, snapshot, monday, sunday]);
      await pool.query('insert into demand_revision(id,demand_id,version,snapshot,created_by) values($1,$2,1,$3,$4)', [randomUUID(), id, snapshot, actorId]);
      if (!batchId) batchId = (await createWeeklyBatch({ operationId: randomUUID(), weekStartDate: monday }, actorId)).batchId!;
      const batch = await getWeeklyBatch(batchId, actorId);
      const groupId = (await createSubBatch(batchId, { ...input(batch.batch.version), name: `导出技术组${index}`, demandIds: [id], expectedDemandVersions: { [id]: 1 } }, actorId)).groupId!; groupIds.push(groupId);
      const data: ShipmentData = { sid, fba, items: [{ msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', name: '离线导出商品', quantity: '5' }],
        boxes: [{ id: randomUUID(), externalBoxId: `TECH-BOX-${index}`, packageId: null, localBoxId: '1', name: '技术箱', order: 1, items: [{ msku: 'TECH-MSKU', fnsku: 'TECH-FNSKU', sku: 'TECH-SKU', quantity: '5' }] }], observedAt: new Date().toISOString(), issues: [] };
      await publishCandidate({ demandId: id, subBatchId: groupId, expectedGroupVersion: 1, expectedDemandVersion: 1, actorId, data, source: 'manual', reason: 'TECHNICAL FIXTURE' });
      const detail = await getSubBatchDetail(groupId, actorId);
      await confirmGroup(groupId, { ...input(detail.group.version), expectedDemandVersions: { [id]: 1 }, expectedShipmentVersions: { [id]: detail.shipments[0]!.revision!.version } }, actorId);
    }
    const batch = await getWeeklyBatch(batchId, actorId); const details = await Promise.all(groupIds.map((id) => getSubBatchDetail(id, actorId)));
    await allocateCodes(batchId, { ...input(batch.batch.version), groupIds, expectedGroupVersions: Object.fromEntries(details.map((detail) => [detail.group.id, detail.group.version])) }, actorId);

    const staleId = await request(groupIds[0]!);
    await assert.rejects(() => executeReportExport(staleId, { createWorkbook: async (projection, options) => {
      const detail = await getSubBatchDetail(groupIds[0]!, actorId); await setActualShipDate(groupIds[0]!, { ...input(detail.group.version), actualShipDate: monday }, actorId);
      return createReportWorkbook(projection, options);
    } }), (error: unknown) => (error as { code?: string }).code === 'VERSION_CONFLICT');
    assert.equal((await getExport(staleId)).export.status, 'stale'); assert.equal((await getExport(staleId)).export.fileId, null);
    assert.equal((await getSubBatchDetail(groupIds[0]!, actorId)).group.frozenAt, null); assert.equal(await fileCount(), 0);
    checks.push('mid-generation-group-version-change-rejects-publication-and-rolls-back-freeze-and-index');

    const concurrentId = await request(groupIds[1]!); let generated = 0;
    const beforeExport = await getShipmentReport(actorId, { subBatchId: groupIds[1]! });
    assert(beforeExport.rows.length > 0); assert(beforeExport.rows.every((row) => row.status === '已确认'));
    const pendingProjection = (await pool.query('select projection from batch_export where id=$1', [concurrentId])).rows[0].projection;
    await Promise.all([1, 2].map(() => executeReportExport(concurrentId, { createWorkbook: async (projection, options) => {
      generated++;
      assert.deepEqual(projection, { ...pendingProjection, rows: pendingProjection.rows.map((row: Record<string, unknown>) => ({ ...row, status: '已冻结' })) });
      assert.equal((await getSubBatchDetail(groupIds[1]!, actorId)).group.frozenAt, null);
      await new Promise((resolve) => setTimeout(resolve, 100)); return createReportWorkbook(projection, options);
    } })));
    const complete = (await getExport(concurrentId)).export; assert.equal(complete.status, 'completed'); assert(complete.fileId);
    assert.equal(generated, 1); assert.equal(await fileCount(), 1);
    assert.equal(Number((await pool.query('select count(*) from operation_audit where target_id=$1 and action=\'batch.export.publish\'', [concurrentId])).rows[0].count), 1);
    assert((await getSubBatchDetail(groupIds[1]!, actorId)).group.frozenAt); checks.push('concurrent-execution-publishes-exactly-one-file-and-one-audit');
    const afterExport = await getShipmentReport(actorId, { subBatchId: groupIds[1]! });
    const publishedProjection = (await pool.query('select projection from batch_export where id=$1', [concurrentId])).rows[0].projection;
    assert.deepEqual(afterExport.confirmations, beforeExport.confirmations);
    assert.deepEqual(afterExport.rows, beforeExport.rows.map((row) => ({ ...row, status: '已冻结' })));
    assert.deepEqual(publishedProjection.rows, afterExport.rows);
    const book = new ExcelJS.Workbook(); const exported = await readExportFile(complete.fileId);
    await book.xlsx.load(exported.bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheet = book.worksheets[0]!; const headers = sheet.getRow(1).values as string[];
    const statusColumn = headers.indexOf('流程状态'); assert(statusColumn > 0);
    assert.equal(sheet.rowCount, afterExport.rows.length + 1);
    for (const [index, row] of afterExport.rows.entries()) assert.equal(sheet.getCell(index + 2, statusColumn).value, row.status);
    checks.push('first-published-xlsx-status-matches-frozen-page-and-persisted-projection-without-early-freeze');

    const failureId = await request(groupIds[2]!); const blockedPath = resolve(tmpdir(), `scm-export-storage-failure-${runId}`); const oldDataDir = process.env.DATA_DIR;
    await writeFile(blockedPath, 'technical file deliberately blocks a directory', { flag: 'wx' });
    try {
      // This child process alone changes its own configuration. The API and
      // Worker processes continue using their original data directory.
      process.env.DATA_DIR = blockedPath;
      await assert.rejects(() => executeReportExport(failureId, { createWorkbook: async () => Buffer.from('synthetic prepared workbook bytes') }));
    } finally { if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir; await unlink(blockedPath); }
    const failure = (await getExport(failureId)).export; assert.equal(failure.status, 'failed'); assert.equal(failure.fileId, null); assert.equal(await fileCount(), 1);
    assert.equal((await getSubBatchDetail(groupIds[2]!, actorId)).group.frozenAt, null); checks.push('actual-storage-write-error-leaves-no-index-file-reference-or-false-success');
    const failedProjection = (await pool.query('select projection from batch_export where id=$1', [failureId])).rows[0].projection;
    assert(failedProjection.rows.every((row: { status: string }) => row.status === '已确认'));
    const committedBytes = Buffer.from('technical committed snapshot must survive a lost acknowledgement');
    await assert.rejects(() => publishReportFile({ bytes: committedBytes, originalName: 'technical-commit-acknowledgement.json', mimeType: 'application/json', createdBy: actorId }, async (file) => {
      await pool.query('insert into file_index(id,storage_key,sha256,byte_size,original_name,mime_type,created_by) values($1,$2,$3,$4,$5,$6,$7)', [file.id, file.storageKey, file.sha256, file.byteSize, file.originalName, file.mimeType, file.createdBy]);
      throw new Error('synthetic acknowledgement lost after committed index');
    }));
    const [committed] = (await pool.query('select storage_key as "storageKey",sha256,byte_size::int as "byteSize" from file_index where created_by=$1 and original_name=$2', [actorId, 'technical-commit-acknowledgement.json'])).rows;
    assert(committed); assert.deepEqual(await checkedFileBytes(committed as { storageKey: string; sha256: string; byteSize: number }), committedBytes);
    checks.push('committed-index-bytes-survive-unknown-commit-acknowledgement-failure');
  } catch (error) { failed = true; console.error(error instanceof Error ? error.message : 'REPORT_ACCEPTANCE_FAILED'); }
  finally {
    try {
      const files = (await pool.query('select id,storage_key from file_index where created_by=$1', [actorId])).rows as Array<{ id: string; storage_key: string }>;
      await pool.query('delete from batch_export where created_by=$1', [actorId]); await pool.query('delete from allocation_code where group_id=any($1::uuid[])', [groupIds]); await pool.query('delete from group_confirmation where created_by=$1', [actorId]); await pool.query('delete from shipment_revision where created_by=$1', [actorId]); await pool.query('delete from sub_batch_revision where created_by=$1', [actorId]); await pool.query('delete from sub_batch_member where group_id=any($1::uuid[])', [groupIds]); await pool.query('delete from sub_batch where created_by=$1', [actorId]); await pool.query('delete from weekly_batch where created_by=$1', [actorId]); await pool.query('delete from batch_operation where actor_id=$1', [actorId]); await pool.query('delete from operation_audit where actor_user_id=$1', [actorId]); await pool.query('delete from demand_revision where created_by=$1', [actorId]); await pool.query('delete from demand where id=any($1::uuid[])', [demandIds]); await pool.query('delete from file_index where created_by=$1', [actorId]); await pool.query('delete from "user" where id=$1', [actorId]);
      for (const file of files) { const path = resolve(config.dataDir, file.storage_key); const suffix = relative(config.dataDir, path); assert(suffix && !suffix.startsWith('..') && !isAbsolute(suffix)); await unlink(path); }
      cleaned = true;
    } catch (error) { failed = true; console.error(`REPORT CLEANUP: ${error instanceof Error ? error.message : 'failed'}`); }
    const index = process.argv.indexOf('--report'); const report = resolve(index >= 0 ? process.argv[index + 1]! : '.local/m2-report/report-integration.json'); await mkdir(dirname(report), { recursive: true });
    await writeFile(report, `${JSON.stringify({ kind: 'real-postgresql-export-concurrency-and-storage-acceptance', createdAt: new Date().toISOString(), result: failed ? 'failed' : 'passed', checks, externalBusinessRequests: 0, queueWasSimulated: true, technicalFixturesRemoved: cleaned }, null, 2)}\n`);
    await closeDatabase(); if (failed) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
