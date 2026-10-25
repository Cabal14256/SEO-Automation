import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(serverRoot, 'package.json'));
Object.assign(process.env, requireServer('dotenv').parse(await readFile(resolve(serverRoot, '.env'))));
const load = (path) => import(pathToFileURL(resolve(serverRoot, `dist/${path}.js`)).href);
const { readConfig } = await load('config');
assert.equal(new URL(readConfig().DATABASE_URL).pathname, '/scm_automation_dev', 'Use only the dedicated development database');
const { pool, closeDatabase } = await load('db/client');
const { BatchError, createSubBatch, createWeeklyBatch, getWeeklyBatch, listWeeklyBatches } = await load('modules/batches/service');
const { getBatchWorkspace } = await load('modules/batches/workspace');
const { batchWorkspaceQuerySchema, batchWorkspaceSchema } = await import(pathToFileURL(resolve(root, 'packages/contracts/dist/index.js')).href);
const reportArgument = process.argv.indexOf('--report');
const reportPath = resolve(root, reportArgument >= 0 ? process.argv[reportArgument + 1] : '.local/t26/batches-workspace-integration.json');
const runId = randomUUID();
const marker = `T26-${runId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
const actors = [`t26-${runId}-a`, `t26-${runId}-b`];
const sids = [1_800_000_000 + Math.floor(Math.random() * 90_000_000), 1_900_000_000 + Math.floor(Math.random() * 90_000_000)];
const demandIds = [];
const checks = [];
let stage = 'setup';
let failed = false;
let cleaned = false;
let baseline;

function record(name, details = {}) { checks.push({ name, result: 'passed', ...details }); console.log(`PASS ${name}`); }
async function expectError(code, work) {
  await assert.rejects(work, (error) => error instanceof BatchError && error.code === code, `Expected ${code}`);
}
async function workspace(input = {}) {
  return batchWorkspaceSchema.parse(await getBatchWorkspace(actors[0], batchWorkspaceQuerySchema.parse(input)));
}
const endOfWeek = (start) => {
  const date = new Date(`${start}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 6); return date.toISOString().slice(0, 10);
};
async function chooseWeeks() {
  // Reserve no business dates: use three consecutive, currently unused future technical weeks.
  const occupied = new Set((await pool.query('select week_start_date::text from demand union select week_start_date::text from weekly_batch')).rows.map((row) => row.week_start_date));
  const monday = new Date('2080-01-01T00:00:00Z');
  monday.setUTCDate(monday.getUTCDate() + (8 - monday.getUTCDay()) % 7);
  const offset = Number.parseInt(runId.slice(0, 4), 16) % 800;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const dates = [0, 1, 2].map((index) => {
      const date = new Date(monday); date.setUTCDate(date.getUTCDate() + (offset + attempt * 3 + index) * 7); return date.toISOString().slice(0, 10);
    });
    if (dates.every((date) => !occupied.has(date))) return dates;
  }
  throw new Error('Could not find isolated technical weeks');
}
async function addDemand(index, week, sid = sids[0], country = '美国', channel = 'T26-A') {
  const id = randomUUID(); demandIds.push(id);
  const fba = `FBA${runId.replaceAll('-', '').toUpperCase()}${String(index).padStart(3, '0')}`;
  const snapshot = { sid, fba, shop: `${marker}-${sid}`, country, channel, destinationFc: 'TECH-FC', referenceQuantity: null, notes: 'TECHNICAL FIXTURE', subBatchName: null };
  await pool.query('insert into demand(id,sid,fba,snapshot,version,business_date,week_start_date,week_end_date) values($1,$2,$3,$4,1,$5,$5,$6)', [id, sid, fba, snapshot, week, endOfWeek(week)]);
  await pool.query('insert into demand_revision(id,demand_id,version,snapshot,created_by) values($1,$2,1,$3,$4)', [randomUUID(), id, snapshot, actors[0]]);
  return { id, fba, snapshot };
}
async function operationCounts() {
  return (await pool.query('select (select count(*)::int from sub_batch where created_by=any($1::text[])) as groups, (select count(*)::int from sub_batch_member where demand_id=any($2::uuid[]) and active) as members, (select count(*)::int from batch_operation where actor_id=any($1::text[])) as operations', [actors, demandIds])).rows[0];
}
async function untouchedCatalog() {
  return createHash('sha256').update(JSON.stringify((await pool.query('select id,sid,status,version from seller_mapping order by id')).rows)).digest('hex');
}

try {
  baseline = await untouchedCatalog();
  for (const actor of actors) await pool.query('insert into "user"(id,name,email,role) values($1,$1,$2,\'admin\')', [actor, `${actor}@acceptance.invalid`]);
  const [weekA, weekB, weekC] = await chooseWeeks();
  const demands = [];
  for (let index = 0; index < 22; index++) demands.push(await addDemand(index, weekA));
  const incompatible = await addDemand(90, weekA, sids[1], '加拿大', 'T26-B');
  await addDemand(91, weekB, sids[1], '德国', 'T26-B');
  const availableDemand = await addDemand(92, weekC, sids[1], '日本', 'T26-C');

  stage = 'available-weeks-are-read-only-and-status-independent';
  const initial = await workspace({ sid: sids[0] });
  assert.equal(initial.total, 0);
  assert.equal(initial.availableWeeks.find((week) => week.weekStartDate === weekA)?.demandCount, 23);
  assert.equal((await pool.query('select count(*)::int as count from weekly_batch where week_start_date=any($1::date[])', [[weekA, weekB, weekC]])).rows[0].count, 0);
  const statusOnly = await workspace({ sid: sids[1], status: 'confirmed' });
  assert.equal(statusOnly.total, 0); assert(statusOnly.availableWeeks.some((week) => week.weekStartDate === weekC));
  record(stage, { technicalDemands: demandIds.length, writesFromList: 0 });

  stage = 'materialization-replays-and-emits-one-placeholder';
  const weekRequest = { operationId: randomUUID(), weekStartDate: weekA };
  const firstWeek = await createWeeklyBatch(weekRequest, actors[0]);
  const replayWeek = await createWeeklyBatch(weekRequest, actors[0]);
  assert.equal(firstWeek.batchId, replayWeek.batchId); assert.equal(replayWeek.replayed, true);
  const batchId = firstWeek.batchId; assert(batchId);
  const placeholder = await workspace({ sid: sids[0] });
  assert.equal(placeholder.total, 1); assert.equal(placeholder.rows[0].rowKind, 'week'); assert.equal(placeholder.rows[0].id, batchId);
  assert.equal(placeholder.rows[0].group, null); assert.equal(placeholder.rows[0].status, 'empty'); assert.equal(placeholder.rows[0].memberCount, 23);
  assert.equal(placeholder.rows[0].sync.syncedMemberCount, 0); assert.equal(placeholder.rows[0].confirmation, null);
  assert(!placeholder.availableWeeks.some((week) => week.weekStartDate === weekA));
  assert((await listWeeklyBatches(actors[0])).items.some((batch) => batch.id === batchId));
  record(stage, { placeholders: 1, replayed: true });

  stage = 'manual-scope-validation-has-no-partial-write';
  const beforeScope = await operationCounts();
  await expectError('GROUP_SCOPE_MISMATCH', () => createSubBatch(batchId, { operationId: randomUUID(), expectedVersion: 1, name: `${marker} invalid`, reason: 'TECHNICAL FIXTURE', demandIds: [demands[0].id, incompatible.id], expectedDemandVersions: { [demands[0].id]: 1, [incompatible.id]: 1 } }, actors[0]));
  assert.deepEqual(await operationCounts(), beforeScope);
  assert.equal((await getWeeklyBatch(batchId, actors[0])).ungrouped.length, 23);
  record(stage);

  stage = 'create-group-replaces-placeholder-without-duplicate-demands';
  const createInput = { operationId: randomUUID(), expectedVersion: 1, name: `${marker} first`, reason: 'TECHNICAL FIXTURE', demandIds: [demands[0].id, demands[1].id], expectedDemandVersions: { [demands[0].id]: 1, [demands[1].id]: 1 } };
  const created = await createSubBatch(batchId, createInput, actors[0]); assert(created.groupId);
  const grouped = await workspace({ sid: sids[0] });
  assert.equal(grouped.total, 1); assert.equal(grouped.rows[0].rowKind, 'group'); assert.equal(grouped.rows[0].id, created.groupId);
  assert.equal(grouped.rows[0].memberCount, 2); assert.deepEqual(new Set(grouped.rows[0].fbas), new Set(demands.slice(0, 2).map((row) => row.fba)));
  assert(!grouped.rows.some((row) => row.rowKind === 'week' && row.batch.id === batchId));
  assert.equal((await getWeeklyBatch(batchId, actors[0])).ungrouped.length, 21);
  assert.equal((await pool.query('select count(*)::int as count from demand where id=any($1::uuid[])', [demandIds])).rows[0].count, 25);
  record(stage, { groups: 1, members: 2, remainingUngrouped: 21 });

  stage = 'stale-submit-conflict-and-original-operation-replay';
  const beforeConflict = await operationCounts();
  const replay = await createSubBatch(batchId, createInput, actors[0]);
  assert.equal(replay.groupId, created.groupId); assert.equal(replay.replayed, true);
  await expectError('OPERATION_CONFLICT', () => createSubBatch(batchId, { ...createInput, name: `${marker} changed` }, actors[0]));
  await expectError('VERSION_CONFLICT', () => createSubBatch(batchId, { ...createInput, operationId: randomUUID(), demandIds: [demands[2].id], expectedDemandVersions: { [demands[2].id]: 1 } }, actors[1]));
  const current = await getWeeklyBatch(batchId, actors[0]);
  await expectError('DEMAND_VERSION_CONFLICT', () => createSubBatch(batchId, { ...createInput, operationId: randomUUID(), expectedVersion: current.batch.version, demandIds: [demands[2].id], expectedDemandVersions: { [demands[2].id]: 2 } }, actors[0]));
  assert.deepEqual(await operationCounts(), beforeConflict);
  record(stage, { sameOperationReplayed: true, rejected: ['OPERATION_CONFLICT', 'VERSION_CONFLICT', 'DEMAND_VERSION_CONFLICT'] });

  stage = 'workspace-filters-and-stable-real-pagination';
  for (let index = 2; index < demands.length; index++) {
    const current = await getWeeklyBatch(batchId, actors[0]);
    await createSubBatch(batchId, { operationId: randomUUID(), expectedVersion: current.batch.version, name: `${marker} group ${String(index).padStart(2, '0')}`, reason: 'TECHNICAL FIXTURE', demandIds: [demands[index].id], expectedDemandVersions: { [demands[index].id]: 1 } }, actors[0]);
  }
  await createWeeklyBatch({ operationId: randomUUID(), weekStartDate: weekB }, actors[0]);
  const common = { sid: sids[0], month: weekA.slice(0, 7), weekFrom: weekA, weekTo: weekA, country: '美国', channel: 'T26-A', status: 'draft', pageSize: 20 };
  const first = await workspace(common); const again = await workspace(common); const second = await workspace({ ...common, page: 2 });
  assert.equal(first.total, 21); assert.equal(first.rows.length, 20); assert.equal(second.rows.length, 1); assert.equal(second.total, 21);
  assert.deepEqual(first.rows.map((row) => row.id), again.rows.map((row) => row.id));
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 21);
  assert.equal((await workspace({ ...common, pageSize: 50 })).rows.length, 21);
  assert.equal((await workspace({ ...common, q: demands[0].fba.toLowerCase() })).total, 1);
  assert.equal((await workspace({ ...common, q: `${marker} first` })).total, 1);
  assert.equal((await workspace({ ...common, country: '德国' })).total, 0);
  assert.equal((await workspace({ ...common, channel: 'T26-B' })).total, 0);
  assert.equal((await workspace({ ...common, status: 'empty' })).total, 0);
  assert.equal((await workspace({ sid: sids[1], weekFrom: weekB, weekTo: weekB, country: '德国', status: 'empty' })).total, 1);
  const remaining = await workspace({ sid: sids[1], country: '日本', channel: 'T26-C', q: availableDemand.fba, status: 'confirmed' });
  assert.equal(remaining.total, 0); assert.deepEqual(remaining.availableWeeks, [{ weekStartDate: weekC, weekEndDate: endOfWeek(weekC), demandCount: 1 }]);
  assert(first.filters.weeks.some((week) => week.id === batchId)); assert(first.filters.shops.some((shop) => shop.sid === sids[0]));
  record(stage, { total: first.total, pageSizes: [20, 50], stableOrder: true, testedFilters: ['month', 'weekFrom', 'weekTo', 'sid', 'country', 'channel', 'status', 'q'] });

  stage = 'revoked-actor-is-denied';
  await pool.query('update "user" set banned=true where id=$1', [actors[1]]);
  await expectError('FORBIDDEN', () => getBatchWorkspace(actors[1], batchWorkspaceQuerySchema.parse({ sid: sids[0] })));
  record(stage);
} catch (error) {
  failed = true; checks.push({ name: stage, result: 'failed', message: error.message }); console.error(`FAIL ${stage}: ${error.stack ?? error}`);
} finally {
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    const groups = (await connection.query('select id from sub_batch where created_by=any($1::text[])', [actors])).rows.map((row) => row.id);
    await connection.query('delete from sub_batch_member where group_id=any($1::uuid[])', [groups]);
    await connection.query('delete from sub_batch_revision where created_by=any($1::text[])', [actors]);
    await connection.query('delete from sub_batch where id=any($1::uuid[])', [groups]);
    await connection.query('delete from weekly_batch where created_by=any($1::text[])', [actors]);
    await connection.query('delete from batch_operation where actor_id=any($1::text[])', [actors]);
    await connection.query('delete from operation_audit where actor_user_id=any($1::text[])', [actors]);
    await connection.query('delete from demand_revision where demand_id=any($1::uuid[])', [demandIds]);
    await connection.query('delete from demand where id=any($1::uuid[])', [demandIds]);
    await connection.query('delete from "user" where id=any($1::text[])', [actors]);
    await connection.query('commit');
    assert.equal((await pool.query('select count(*)::int as count from demand where id=any($1::uuid[])', [demandIds])).rows[0].count, 0);
    assert.equal((await pool.query('select count(*)::int as count from "user" where id=any($1::text[])', [actors])).rows[0].count, 0);
    if (baseline) assert.equal(await untouchedCatalog(), baseline, 'Seller mappings remain unchanged');
    cleaned = true;
  } catch (error) {
    await connection.query('rollback').catch(() => {});
    failed = true; checks.push({ name: 'cleanup', result: 'failed', message: error.message }); console.error(`Cleanup failed: ${error.stack ?? error}`);
  } finally { connection.release(); }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ kind: 'real-postgresql-batch-workspace-technical-acceptance', runId, createdAt: new Date().toISOString(), passed: !failed, technicalFixturesRemoved: cleaned, externalBusinessRequests: 0, checks }, null, 2)}\n`);
  await closeDatabase();
}
if (failed) process.exitCode = 1;
