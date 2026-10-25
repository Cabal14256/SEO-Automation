import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { databaseSnapshot, hashFile, inventory, pgEnvironment, sha256, verifyIndexedFiles, verifyInventory } from '../trial/core.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), requireServer = createRequire(resolve(repo, 'apps/server/package.json'));
const { Client } = requireServer('pg');
const base = resolve(process.env.WORKFLOW_ACCEPTANCE_ROOT || resolve(repo, '.local/development/data/acceptance/workflow'), randomUUID());
const pgBin = process.env.WORKFLOW_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const postgres = resolve(base, 'postgres'), data = resolve(base, 'data');
await mkdir(data, { recursive: true });
const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise((done) => socket.close(done));
async function run(executable, args, env = process.env, capture = false) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: resolve(repo, 'apps/server'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; if (!capture) process.stdout.write(chunk); });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? done(output) : reject(new Error(`Workflow subprocess exited ${code}: ${output.slice(-6000)}`)));
  });
}
async function verifyRecovery(environment) {
  const sourceConfig = { releasePath: repo, dataDir: data }, restoredData = resolve(base, 'restored-data'), restoredConfig = { releasePath: repo, dataDir: restoredData };
  const restoredEnvironment = { ...environment, DATABASE_URL: `postgresql://scm_app@127.0.0.1:${port}/scm_workflow_restored`, DATA_DIR: restoredData }, dumpPath = resolve(base, 'database.dump');
  const snapshot = await databaseSnapshot(sourceConfig, environment), files = await inventory(data), verified = await verifyIndexedFiles(sourceConfig, snapshot);
  // The general backup inventory covers all application tables, including the
  // workflow record/revision/claim/attachment/export tables added by M5-M8.
  assert(snapshot.tables.some((table) => JSON.stringify(table).includes('workflow_record')), 'workflow tables must be in the backup inventory');
  await run(resolve(pgBin, 'pg_dump.exe'), ['-Fc', '--no-owner', '--no-privileges', '-f', dumpPath], pgEnvironment(environment), true);
  const admin = new Client({ host: '127.0.0.1', port, user: 'workflow_admin', database: 'postgres' }); await admin.connect();
  try { await admin.query('create database scm_workflow_restored owner scm_app'); } finally { await admin.end(); }
  await run(resolve(pgBin, 'pg_restore.exe'), ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '-d', 'scm_workflow_restored', dumpPath], pgEnvironment(restoredEnvironment), true);
  await cp(data, restoredData, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const restoredSnapshot = await databaseSnapshot(restoredConfig, restoredEnvironment), restoredVerified = await verifyIndexedFiles(restoredConfig, restoredSnapshot);
  assert.deepEqual(restoredSnapshot, snapshot); assert.deepEqual(restoredVerified, verified); await verifyInventory(restoredData, files);
  assert.deepEqual(await databaseSnapshot(sourceConfig, environment), snapshot); await verifyInventory(data, files);
  await writeFile(resolve(base, 'recovery.json'), JSON.stringify({ result: 'passed', technicalFixturesOnly: true, tables: snapshot.tables.length, copiedFiles: files.length, dump: { bytes: (await stat(dumpPath)).size, sha256: await hashFile(dumpPath) }, snapshotSha256: sha256(JSON.stringify(snapshot)), fileInventorySha256: sha256(JSON.stringify(files)), comparisons: { allDatabaseTables: true, indexedFileHashes: true, historicalFiles: true, fileInventory: true, sourceUnchanged: true } }, null, 2) + '\n');
}
let started = false;
try {
  await run(process.execPath, [resolve(repo, 'node_modules/typescript/bin/tsc'), '-p', resolve(repo, 'packages/contracts/tsconfig.json')]);
  await run(resolve(pgBin, 'initdb.exe'), ['-D', postgres, '-U', 'workflow_admin', '--encoding=UTF8', '--locale=C', '--auth=trust'], process.env, true);
  await run(resolve(pgBin, 'pg_ctl.exe'), ['start', '-D', postgres, '-l', resolve(base, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1`, '-w'], process.env, true); started = true;
  const admin = new Client({ host: '127.0.0.1', port, user: 'workflow_admin', database: 'postgres' }); await admin.connect();
  try { await admin.query('create role scm_app login'); await admin.query('create database scm_workflow_acceptance owner scm_app'); } finally { await admin.end(); }
  const environment = { ...process.env, DATABASE_URL: `postgresql://scm_app@127.0.0.1:${port}/scm_workflow_acceptance`, DATA_DIR: data,
    BETTER_AUTH_SECRET: randomUUID() + randomUUID(), BETTER_AUTH_URL: 'http://localhost:3198', WEB_ORIGIN: 'http://localhost:3198',
    LINGXING_REQUESTS_ENABLED: 'false', LINGXING_APP_ID: '', LINGXING_APP_SECRET: '', LINGXING_ACCESS_TOKEN: '', LINGXING_ENV_FILE: '', WORKFLOW_ACCEPTANCE_OUT: resolve(base, 'integration.json') };
  await run(process.execPath, ['--import', pathToFileURL(resolve(repo, 'scripts/m3/block-network.mjs')).href, resolve(repo, 'apps/server/node_modules/tsx/dist/cli.mjs'), 'src/workflow-acceptance.ts'], environment);
  assert.equal(JSON.parse(await readFile(resolve(base, 'integration.json'), 'utf8')).result, 'passed');
  await verifyRecovery(environment); console.log(`Workflow integration and recovery evidence: ${base}`);
} finally {
  if (started) await run(resolve(pgBin, 'pg_ctl.exe'), ['stop', '-D', postgres, '-m', 'fast', '-w'], process.env, true);
}
