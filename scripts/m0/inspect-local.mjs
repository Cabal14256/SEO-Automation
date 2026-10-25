import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const serverRequire = createRequire(resolve(root, 'apps/server/package.json'));
const { parse } = serverRequire('dotenv');
const { Pool } = serverRequire('pg');
const config = parse(await readFile(resolve(root, 'apps/server/.env')));
const secrets = [];
for (const source of ['apps/server/.env', 'scripts/lingxing/.env']) {
  const values = parse(await readFile(resolve(root, source)));
  for (const [key, value] of Object.entries(values)) {
    if (/secret|password|app_key|app_id|database_url/i.test(key) && value.length >= 12) secrets.push(value);
  }
}
const localRuntime = JSON.parse((await readFile(resolve(root, '.local/development/runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
secrets.push(localRuntime.appPassword, localRuntime.ownerPassword);
try {
  const accounts = JSON.parse(await readFile(resolve(root, '.local/development/accounts.json'), 'utf8'));
  for (const account of Object.values(accounts)) if (account.password) secrets.push(account.password);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
assert.equal(listed.status, 0, 'Git tracked-file inspection failed');
const remotes = spawnSync('git', ['remote'], { cwd: root, encoding: 'utf8', windowsHide: true });
assert.equal(remotes.status, 0, 'Git remote inspection failed');
const tracked = listed.stdout.split('\0').filter(Boolean);
const leaks = [];
for (const file of tracked) {
  assert(!/^docs\/private\/(?!README\.md$)/.test(file), 'Private source is tracked');
  assert(!/^data\/|^\.local\/|(?:^|\/)\.env$|probe\.local\.json$/.test(file), 'Local data or credentials are tracked');
  const bytes = await readFile(resolve(root, file));
  if (secrets.some((secret) => bytes.includes(Buffer.from(secret)))) leaks.push(file);
}
assert.equal(leaks.length, 0, 'Tracked content contains a local secret; inspect privately');
const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5_000 });
let database;
try {
  const result = await pool.query(`select current_database() as database, current_user as role,
    current_setting('timezone') as timezone, current_setting('listen_addresses') as listen,
    current_setting('port')::int as port, version() as version,
    r.rolsuper as superuser, r.rolcreatedb as createdb, r.rolcreaterole as createrole,
    (select count(*)::int from drizzle.__drizzle_migrations) as migration_count
    from pg_roles r where r.rolname = current_user`);
  database = result.rows[0];
  assert.equal(database.database, 'scm_automation_dev');
  assert.equal(database.listen, '127.0.0.1');
  assert.equal(database.timezone, 'Asia/Shanghai');
  assert.equal(database.superuser, false);
  assert.equal(database.createdb, false);
  assert.equal(database.createrole, false);
} finally { await pool.end(); }
const lock = await readFile(resolve(root, 'pnpm-lock.yaml'));
const report = {
  checkedAt: new Date().toISOString(), timezone: 'Asia/Shanghai', result: 'passed',
  source: { trackedFiles: tracked.length, localSecretMatches: leaks.length, remoteConfigured: remotes.stdout.trim().length > 0 },
  node: process.version, packageManager: JSON.parse(await readFile(resolve(root, 'package.json'))).packageManager,
  lockSha256: createHash('sha256').update(lock).digest('hex'), database,
  dataDir: config.DATA_DIR, credentials: 'controlled local files only; values omitted',
};
await writeFile(resolve(root, 'docs/acceptance/evidence/2026-10-16/m0-environment.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`PASS local boundaries and tracked-secret inspection (${tracked.length} files)`);
