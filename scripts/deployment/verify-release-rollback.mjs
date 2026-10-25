import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, run, sha256 } from '../trial/core.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const configPath = resolve(process.argv[2] ?? resolve(repo, '.local/trial/runtime.json'));
const config = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(config.services.api, 'SCM-Trial-API'); assert.equal(config.apiPort, 3002);
const target = join(config.trialRoot, 'releases', `technical-startup-failure-${Date.now()}`);
await mkdir(target);
for (const directory of ['apps/server/dist', 'apps/web/dist', 'runtime']) await mkdir(join(target, directory), { recursive: true });
await copyFile(join(config.releasePath, 'runtime/node.exe'), join(target, 'runtime/node.exe'));
await writeFile(join(target, 'apps/server/dist/api.js'), 'process.exit(23);\n');
await writeFile(join(target, 'apps/server/dist/worker.js'), 'setInterval(()=>{},1000);\n');
await writeFile(join(target, 'apps/web/dist/index.html'), '<div id="root">Technical startup-failure fixture</div>\n');
const files = await inventory(target);
await writeFile(join(target, 'release-manifest.json'), JSON.stringify({ format: 'scm-trial-release/v1', releaseId: 'technical-intentional-startup-failure', contentSha256: sha256(JSON.stringify(files)), inventory: files }));
let rejected = false;
let rollbackReported = false;
try {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/deployment/trial.ps1'), 'release', '-TrialRoot', config.trialRoot, '-ReleasePath', target]);
} catch (error) { rejected = true; rollbackReported = String(error.privateDetails ?? '').includes('the previous release and configuration were restored'); }
assert(rejected, 'Intentionally broken API must fail deployment');
assert(rollbackReported, 'The deployment must reach startup failure and report its automatic rollback');
const actual = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(actual.releasePath, config.releasePath, 'Previous release path must be restored');
const health = await fetch(`http://127.0.0.1:${config.apiPort}/api/v1/health`).then((response) => response.json());
assert.equal(health.database, 'ok'); assert.equal(health.worker, 'ok');
const report = { kind: 'technical-startup-failure-automatic-release-rollback', result: 'passed', checkedAt: new Date().toISOString(), rejectedBrokenRelease: true, automaticRollbackReported: true, originalReleaseRestored: true, health, externalBusinessRequests: 0, databaseMigrationRollbackTested: false };
await writeFile(join(config.trialRoot, 'evidence/release-rollback.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
