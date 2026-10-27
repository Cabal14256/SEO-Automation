import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { Client } = require('pg');
const dotenv = require('dotenv');
const local = await readFile(join(root, 'apps/server/.env')).then((bytes) => dotenv.parse(bytes)).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return {};
});
const env = { ...local, ...process.env };
if (!env.DATABASE_URL) throw new Error('Set DATABASE_URL or configure apps/server/.env.');
const client = new Client({ connectionString: env.DATABASE_URL });
const template = `scm_monthly_validation_${randomUUID().replaceAll('-', '')}`;
const guard = `scm_monthly_guard_${randomUUID().replaceAll('-', '')}`;
const created = [];
let exitCode = 1;
await client.connect();
try {
  for (const schema of [template, guard]) {
    await client.query(`CREATE SCHEMA "${schema}"`);
    created.push(schema);
  }
  const migrationDirectory = join(root, 'apps/server/drizzle');
  const monthly = await readFile(join(migrationDirectory, '0019_magical_stardust.sql'), 'utf8');
  await client.query(`SET search_path TO "${guard}"`);
  await client.query('CREATE TABLE sub_batch_member(demand_id uuid, group_id uuid, active boolean)');
  const demandId = randomUUID();
  await client.query('INSERT INTO sub_batch_member VALUES($1,$2,true),($1,$3,true)', [demandId, randomUUID(), randomUUID()]);
  await client.query('BEGIN');
  let refused = false;
  try { await client.query(monthly.replaceAll('"public".', `"${guard}".`)); }
  catch (error) {
    refused = error.code === 'P0001' && error.detail?.includes(demandId);
    await client.query('ROLLBACK');
    if (!refused) throw error;
  }
  if (!refused) { await client.query('ROLLBACK'); throw new Error('Duplicate memberships did not block migration.'); }
  const check = await client.query('SELECT count(*)::int AS members, to_regclass($1) AS correction_table FROM sub_batch_member', [`${guard}.shipping_run_correction`]);
  if (check.rows[0].members !== 2 || check.rows[0].correction_table !== null) throw new Error('Conflict preflight changed existing state.');
  await client.query(`SET search_path TO "${template}"`);
  for (const name of (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
    const source = (await readFile(join(migrationDirectory, name), 'utf8')).replaceAll('"public".', `"${template}".`);
    await client.query('BEGIN');
    try { await client.query(source); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  const child = spawn('corepack pnpm --filter @scm/server exec vitest run --maxWorkers=2 src/modules/shipping-runs/jobs-db.test.ts src/modules/batches/auto-confirm-db.test.ts src/modules/shipping-lifecycle/service-db.test.ts', {
    cwd: root, shell: true, stdio: 'inherit', env: { ...env, SCM_TEST_TEMPLATE_SCHEMA: template, SHIPPING_RUN_DB_TEST: '1', BATCH_AUTO_CONFIRM_DB_TEST: '1', SHIPPING_LIFECYCLE_DB_TEST: '1' },
  });
  exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)); });
  const directory = join(root, '.local/t40/monthly-db');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: exitCode === 0, migrations: true, duplicateMembershipPreflight: true, businessSchemaChanged: false }, null, 2) + '\n');
} finally {
  // These exact identifiers are generated above, never read from external input.
  for (const schema of created.reverse()) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  await client.end();
}
process.exitCode = exitCode;
