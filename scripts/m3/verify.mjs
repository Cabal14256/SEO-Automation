import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireServer = createRequire(resolve(repo, 'apps/server/package.json'));
const { Client } = requireServer('pg');
const base = resolve(process.env.M3_ACCEPTANCE_ROOT || resolve(repo, '.local/development/data/acceptance/m3'), randomUUID());
const pgBin = process.env.M3_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const postgres = resolve(base, 'postgres'), data = resolve(base, 'data'), oldMigrations = resolve(base, 'migrations-before');
await mkdir(data, { recursive: true }); await mkdir(resolve(oldMigrations, 'meta'), { recursive: true });
const journal = JSON.parse(await readFile(resolve(repo, 'apps/server/drizzle/meta/_journal.json'), 'utf8'));
const added = journal.entries.find((entry) => entry.tag === '0012_romantic_lord_tyger'); assert(added, 'M3 migration missing');
const oldEntries = journal.entries.filter((entry) => entry.idx < added.idx);
await writeFile(resolve(oldMigrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: oldEntries }));
for (const entry of oldEntries) await copyFile(resolve(repo, `apps/server/drizzle/${entry.tag}.sql`), resolve(oldMigrations, `${entry.tag}.sql`));
const socket = createServer(); await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise((done) => socket.close(done));
async function run(executable, args, env = process.env, capture = false) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: resolve(repo, 'apps/server'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; if (!capture) process.stdout.write(chunk); });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? done(output) : reject(new Error(`Acceptance subprocess exited ${code}: ${output.slice(-3000)}`)));
  });
}
let started = false;
try {
  await run(resolve(pgBin, 'initdb.exe'), ['-D', postgres, '-U', 'm3_admin', '--encoding=UTF8', '--locale=C', '--auth=trust'], process.env, true);
  await run(resolve(pgBin, 'pg_ctl.exe'), ['start', '-D', postgres, '-l', resolve(base, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1`, '-w'], process.env, true); started = true;
  const admin = new Client({ host: '127.0.0.1', port, user: 'm3_admin', database: 'postgres' }); await admin.connect();
  try { await admin.query('create role scm_app login'); await admin.query('create database scm_m3_acceptance owner scm_app'); await admin.query('create database scm_automation_dev owner scm_app'); } finally { await admin.end(); }
  const env = { ...process.env, DATABASE_URL: `postgresql://scm_app@127.0.0.1:${port}/scm_m3_acceptance`,
    BETTER_AUTH_SECRET: 'm3-isolated-technical-acceptance-secret-only-2026', BETTER_AUTH_URL: 'http://localhost:3198', WEB_ORIGIN: 'http://localhost:3198',
    DATA_DIR: data, LINGXING_REQUESTS_ENABLED: 'false', LINGXING_APP_ID: '', LINGXING_APP_SECRET: '', LINGXING_ACCESS_TOKEN: '', LINGXING_ENV_FILE: '',
    M3_OLD_MIGRATIONS: oldMigrations, M3_ACCEPTANCE_OUT: resolve(base, 'integration.json') };
  await run(process.execPath, [resolve(repo, 'apps/server/node_modules/tsx/dist/cli.mjs'), 'src/physical-acceptance.ts'], env);
  const regressionEnv = { ...env, DATABASE_URL: `postgresql://scm_app@127.0.0.1:${port}/scm_automation_dev`, LINGXING_REQUESTS_ENABLED: 'true' };
  await run(process.execPath, [resolve(repo, 'apps/server/node_modules/tsx/dist/cli.mjs'), 'src/db/migrate.ts'], regressionEnv);
  for (const [entry, report] of [['batches-acceptance.ts', 'm2-batches.json'], ['sync-acceptance.ts', 'm2-sync.json'], ['report-acceptance.ts', 'm2-reports.json']]) {
    await run(process.execPath, ['--import', pathToFileURL(resolve(repo, 'scripts/m3/block-network.mjs')).href, resolve(repo, 'apps/server/node_modules/tsx/dist/cli.mjs'), `src/${entry}`, '--report', resolve(base, report)], regressionEnv);
  }
  console.log(`M3 isolated acceptance evidence: ${resolve(base, 'integration.json')}`);
} finally {
  if (started) await run(resolve(pgBin, 'pg_ctl.exe'), ['stop', '-D', postgres, '-m', 'fast', '-w'], process.env, true);
}
