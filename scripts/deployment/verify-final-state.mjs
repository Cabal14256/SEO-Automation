import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { run } from '../trial/core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(await readFile(process.argv[2] ?? resolve(root, '.local/trial/runtime.json'), 'utf8'));
const requireServer = createRequire(join(root, 'apps/server/package.json'));
const { Client } = requireServer('pg'); const { parse } = requireServer('dotenv');
const { readAcceptanceFixture } = await import(pathToFileURL(join(root, 'apps/server/dist/acceptance-fixture.js')));
const fixture = await readAcceptanceFixture();
assert(fixture.expectedRuntime, 'Configure expectedRuntime privately for final-state verification');
async function counts(envPath, expectedPort) {
  const env = parse(await readFile(envPath)); const url = new URL(env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(Number(url.port), expectedPort);
  const db = new Client({ connectionString: env.DATABASE_URL }); await db.connect();
  try {
    const result = await db.query(`select
      (select count(*)::int from "user" where role='admin' and not coalesce(banned,false)) as active_admins,
      (select count(*)::int from seller_mapping) as sellers,
      (select count(*)::int from seller_mapping where status='candidate') as candidates,
      (select count(*)::int from seller_alias) as aliases,
      (select count(*)::int from source_import) as imports,
      (select count(*)::int from source_import_row) as source_rows,
      (select count(*)::int from demand) as demands,
      (select count(*)::int from sub_batch) as groups,
      (select count(*)::int from group_confirmation) as confirmations,
      (select count(*)::int from batch_export) as exports`);
    return result.rows[0];
  } finally { await db.end(); }
}
const source = await counts(join(root, 'apps/server/.env'), 55432);
const trial = await counts(config.envPath, 55433);
for (const state of [source, trial]) {
  for (const [key, expected] of Object.entries(fixture.expectedRuntime)) assert.equal(state[key], expected, key);
}
const budget = JSON.parse(await readFile(join(root, '.local/t12-m2/e2e/live-budget.json'), 'utf8'));
assert.equal(budget.limit, 100); assert(Number.isSafeInteger(budget.used) && budget.used >= 0 && budget.used <= budget.limit); assert.equal(budget.reserved, 0);
const originalSha = createHash('sha256').update(await readFile(fixture.sourceFile)).digest('hex');
assert.equal(originalSha, fixture.sourceSha256);
const health = await fetch('http://127.0.0.1:3002/api/v1/health').then((response) => response.json());
assert.equal(health.database, 'ok'); assert.equal(health.worker, 'ok');
const system = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$services=Get-CimInstance Win32_Service|Where-Object{$_.Name -like 'SCM-Trial-*'}|Select-Object Name,State,StartMode,StartName; $ports=Get-NetTCPConnection -State Listen|Where-Object{$_.LocalPort -in @(3002,55433,443,3003,55434)}|Select-Object LocalAddress,LocalPort; $task=Get-ScheduledTaskInfo -TaskName 'SCM-Trial-DailyBackup'; [pscustomobject]@{services=@($services);listeners=@($ports);backupTask=@{lastResult=$task.LastTaskResult;lastRun=$task.LastRunTime.ToUniversalTime().ToString('o');nextRun=$task.NextRunTime.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Depth 6"]));
assert.equal(system.services.length, 4); assert(system.services.every((service) => service.State === 'Running' && service.StartMode === 'Auto'));
assert(system.listeners.filter((listener) => [3002, 55433].includes(listener.LocalPort)).every((listener) => listener.LocalAddress === '127.0.0.1'));
assert([3002, 55433, 443].every((port) => system.listeners.some((listener) => listener.LocalPort === port)));
assert(!system.listeners.some((listener) => [3003, 55434].includes(listener.LocalPort)));
assert.equal(system.backupTask.lastResult, 0);
assert(Date.parse(system.backupTask.lastRun) > Date.now() - 25 * 3600000, 'Backup task must actually have completed recently');
const manifest = JSON.parse(await readFile(join(config.releasePath, 'release-manifest.json'), 'utf8'));
assert(manifest.sourceExclusions.includes('**/*.local.json'));
assert(!manifest.inventory.some((file) => /(?:probe\.local\.json|(?:^|\/)\.env(?:\.|$)|(?:^|\/)private\/)/.test(file.path)));
const report = { kind: 't13-t23-final-controlled-runtime', result: 'passed', checkedAt: new Date().toISOString(), health, development: source, trial, originalUnchanged: true, requestBudget: { limit: budget.limit, used: budget.used, remaining: budget.limit - budget.used, newBusinessRequests: 0 }, release: { id: manifest.releaseId, files: manifest.inventory.length, productionPackages: manifest.productionPackages.length, privateSettingsExcluded: true }, ...system, restoreProcessesLeftRunning: false, pending: ['real-increment-and-expected-diff', 'actual-business-batch-and-user-signoff', 'operating-system-reboot', 'independent-lan-client', 'independent-backup-medium', 'signed-business-data-restore'] };
await writeFile(join(config.trialRoot, 'evidence/final-state.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
