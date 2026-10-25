import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { databaseSnapshot, hashFile, inventory, pgEnvironment, sha256, verifyIndexedFiles, verifyInventory } from '../trial/core.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireServer = createRequire(resolve(repo, 'apps/server/package.json'));
const { Client } = requireServer('pg');
const base = resolve(process.env.M4_ACCEPTANCE_ROOT || resolve(repo, '.local/development/data/acceptance/m4'), randomUUID());
const pgBin = process.env.M4_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const postgres = resolve(base, 'postgres'), data = resolve(base, 'data'), before = resolve(base, 'migrations-before');
await mkdir(data, { recursive: true }); await mkdir(resolve(before, 'meta'), { recursive: true });
const journal = JSON.parse(await readFile(resolve(repo, 'apps/server/drizzle/meta/_journal.json'), 'utf8'));
const added = journal.entries.find((entry) => entry.tag.startsWith('0014_')); assert(added, 'M4 migration missing');
const oldEntries = journal.entries.filter((entry) => entry.idx < added.idx);
await writeFile(resolve(before, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: oldEntries }));
for (const entry of oldEntries) await copyFile(resolve(repo, `apps/server/drizzle/${entry.tag}.sql`), resolve(before, `${entry.tag}.sql`));
const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise((done) => socket.close(done));
async function run(executable, args, env = process.env, capture = false) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: resolve(repo, 'apps/server'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; if (!capture) process.stdout.write(chunk); });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? done(output) : reject(new Error(`M4 acceptance subprocess exited ${code}: ${output.slice(-4000)}`)));
  });
}
async function verifyRecovery(environment) {
  const recoveryPath = resolve(base, 'recovery.json'), dumpPath = resolve(base, 'database.dump'), restoredData = resolve(base, 'restored-data');
  const sourceConfig = { releasePath: repo, dataDir: data }, restoredConfig = { releasePath: repo, dataDir: restoredData };
  const restoredEnvironment = { ...environment, DATABASE_URL: `postgresql://scm_app@127.0.0.1:${port}/scm_m4_restored`, DATA_DIR: restoredData };
  const report = { kind: 'isolated-postgresql-M4-backup-recovery', result: 'running', technicalFixturesOnly: true, workerStarted: false, externalBusinessRequests: 0, startedAt: new Date().toISOString() };
  try {
    const snapshot = await databaseSnapshot(sourceConfig, environment), files = await inventory(data);
    const sourceVerified = await verifyIndexedFiles(sourceConfig, snapshot);
    assert(snapshot.documentRevisions?.length > 0, 'Recovery fixture has no preserved document revisions');
    assert(snapshot.documentTemplates?.length > 0, 'Recovery fixture has no preserved template versions');
    assert(snapshot.documentExports?.length > 0, 'Recovery fixture has no completed invoice files');
    const before = { snapshot, files, verified: sourceVerified };
    await writeFile(resolve(base, 'recovery-before.json'), JSON.stringify(before, null, 2) + '\n');
    await run(resolve(pgBin, 'pg_dump.exe'), ['-Fc', '--no-owner', '--no-privileges', '-f', dumpPath], pgEnvironment(environment), true);
    const admin = new Client({ host: '127.0.0.1', port, user: 'm4_admin', database: 'postgres' }); await admin.connect();
    try { await admin.query('create database scm_m4_restored owner scm_app'); } finally { await admin.end(); }
    await run(resolve(pgBin, 'pg_restore.exe'), ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '-d', 'scm_m4_restored', dumpPath], pgEnvironment(restoredEnvironment), true);
    await cp(data, restoredData, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    const restoredSnapshot = await databaseSnapshot(restoredConfig, restoredEnvironment), restoredVerified = await verifyIndexedFiles(restoredConfig, restoredSnapshot);
    assert.deepEqual(restoredSnapshot, snapshot, 'Restored database rows, sequences, source confirmations or M4 dependencies differ');
    assert.deepEqual(restoredVerified, sourceVerified, 'Restored historical XLSX and indexed-file checks differ');
    await verifyInventory(restoredData, files);
    // Read the source again after dumping/copying: acceptance has stopped its
    // queue, so these checks must remain stable without starting another worker.
    assert.deepEqual(await databaseSnapshot(sourceConfig, environment), snapshot, 'Source database changed during isolated recovery verification');
    await verifyInventory(data, files);
    await writeFile(resolve(base, 'recovery-restored.json'), JSON.stringify({ snapshot: restoredSnapshot, files: await inventory(restoredData), verified: restoredVerified }, null, 2) + '\n');
    Object.assign(report, { result: 'passed', completedAt: new Date().toISOString(), source: { database: 'scm_m4_acceptance', dataDirectory: data, ...sourceVerified }, restored: { database: 'scm_m4_restored', dataDirectory: restoredData, ...restoredVerified },
      dump: { path: dumpPath, bytes: (await stat(dumpPath)).size, sha256: await hashFile(dumpPath) }, databaseSnapshotSha256: sha256(JSON.stringify(snapshot)), fileInventorySha256: sha256(JSON.stringify(files)),
      tables: snapshot.tables.length, sequences: snapshot.sequences.length, copiedFiles: files.length, comparisons: { databaseSnapshot: true, indexedFileHashes: true, historicalXlsx: true, dataInventory: true, sourceUnchanged: true },
      evidence: { before: 'recovery-before.json', restored: 'recovery-restored.json' } });
  } catch (error) {
    Object.assign(report, { result: 'failed', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'Isolated recovery verification failed' });
    throw error;
  } finally { await writeFile(recoveryPath, JSON.stringify(report, null, 2) + '\n'); }
  console.log(`M4 isolated recovery evidence: ${recoveryPath}`);
}
let started = false;
try {
  await run(process.execPath, [resolve(repo, 'node_modules/typescript/bin/tsc'), '-p', resolve(repo, 'packages/contracts/tsconfig.json')]);
  await run(resolve(pgBin, 'initdb.exe'), ['-D', postgres, '-U', 'm4_admin', '--encoding=UTF8', '--locale=C', '--auth=trust'], process.env, true);
  await run(resolve(pgBin, 'pg_ctl.exe'), ['start', '-D', postgres, '-l', resolve(base, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1`, '-w'], process.env, true); started = true;
  const admin = new Client({ host: '127.0.0.1', port, user: 'm4_admin', database: 'postgres' }); await admin.connect();
  try { await admin.query('create role scm_app login'); await admin.query('create database scm_m4_acceptance owner scm_app'); } finally { await admin.end(); }
  const env = { ...process.env, DATABASE_URL: `postgresql://scm_app@127.0.0.1:${port}/scm_m4_acceptance`,
    BETTER_AUTH_SECRET: 'm4-isolated-technical-acceptance-secret-only-2026', BETTER_AUTH_URL: 'http://localhost:3197', WEB_ORIGIN: 'http://localhost:3197',
    DATA_DIR: data, LINGXING_REQUESTS_ENABLED: 'false', LINGXING_APP_ID: '', LINGXING_APP_SECRET: '', LINGXING_ACCESS_TOKEN: '', LINGXING_ENV_FILE: '',
    M4_OLD_MIGRATIONS: before, M4_ACCEPTANCE_OUT: resolve(base, 'integration.json') };
  await run(process.execPath, ['--import', pathToFileURL(resolve(repo, 'scripts/m3/block-network.mjs')).href, resolve(repo, 'apps/server/node_modules/tsx/dist/cli.mjs'), 'src/documents-acceptance.ts'], env);
  assert.equal(JSON.parse(await readFile(resolve(base, 'integration.json'), 'utf8')).result, 'passed', 'M4 integration must pass before recovery verification');
  await verifyRecovery(env);
  console.log(`M4 isolated acceptance evidence: ${resolve(base, 'integration.json')}`);
} finally {
  if (started) await run(resolve(pgBin, 'pg_ctl.exe'), ['stop', '-D', postgres, '-m', 'fast', '-w'], process.env, true);
}
