import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { assertNewTarget, decryptArchive, documentDatabaseSnapshot, encryptArchive, exists, extractAuthenticated, inside, inventory, loadConfig, parseEnv, physicalDatabaseSnapshot, pruneBackups, readKey, run, safeRelative, sha256, verifyIndexedFiles, verifyInventory, verifyReleaseDirectory } from './core.mjs';
import { includeSource, materializeProductionDependencies, packageRelease } from './package.mjs';

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'scm-trial-test-'));
  try { await action(root); }
  finally { assert(inside(tmpdir(), root)); await rm(root, { recursive: true, force: true }); }
}

test('AES-256-GCM encrypted backup authenticates content and rejects corruption, truncation and wrong keys', () => fixture(async (root) => {
  const source = join(root, 'source'); const encrypted = join(root, 'encrypted'); const restored = join(root, 'restored'); const key = randomBytes(32);
  const content = randomBytes(128000); await writeFile(source, content);
  await encryptArchive(source, encrypted, key); await decryptArchive(encrypted, restored, key);
  assert.deepEqual(await readFile(restored), content);
  const original = await readFile(encrypted); const corrupted = Buffer.from(original); corrupted[1000] ^= 1;
  await writeFile(join(root, 'corrupted'), corrupted);
  for (const [name, bytes] of [['truncated', original.subarray(0, original.length - 1)], ['empty', Buffer.alloc(3)]]) await writeFile(join(root, name), bytes);
  for (const name of ['corrupted', 'truncated', 'empty']) {
    const target = join(root, `bad-${name}`);
    await assert.rejects(decryptArchive(join(root, name), target, key)); assert.equal(await exists(target), false);
  }
  await assert.rejects(decryptArchive(encrypted, join(root, 'wrong-key'), randomBytes(32)));
  assert.equal(await exists(join(root, 'wrong-key')), false);
}));

test('recovery key is initialized once and never overwritten', () => fixture(async (root) => {
  const path = join(root, 'keys', 'recovery.key');
  const first = await readKey(path, true); const second = await readKey(path, true);
  assert.equal(first.length, 32); assert.deepEqual(first, second);
  await writeFile(join(root, 'bad.key'), 'not-32-bytes'); await assert.rejects(readKey(join(root, 'bad.key')));
}));

test('inventory detects changed, missing and unexpected files', () => fixture(async (root) => {
  await mkdir(join(root, 'nested')); await writeFile(join(root, 'nested', 'item'), 'immutable');
  const manifest = await inventory(root); await verifyInventory(root, manifest);
  await writeFile(join(root, 'nested', 'item'), 'changed'); await assert.rejects(verifyInventory(root, manifest));
  await rm(join(root, 'nested', 'item')); await assert.rejects(verifyInventory(root, manifest));
  await writeFile(join(root, 'nested', 'item'), 'immutable'); await writeFile(join(root, 'unexpected'), 'extra'); await assert.rejects(verifyInventory(root, manifest));
}));

test('restore targets and archive paths cannot overlap live data or escape extraction', () => {
  const live = resolve('live');
  for (const path of [live, join(live, 'data'), resolve('.')]) assert.throws(() => assertNewTarget(path, [live]));
  assert.equal(assertNewTarget(resolve('separate-restore'), [live]), resolve('separate-restore'));
  for (const path of ['/etc/passwd', '../../outside', 'a/../../b', 'C:/Windows', 'C:\\Windows', 'a\\..\\outside', 'nul\0bad']) assert.throws(() => safeRelative(path));
  assert.equal(safeRelative('./data/files/abc'), 'data/files/abc');
});

test('source package includes untracked implementation but excludes business files, credentials and local runtime', () => {
  for (const name of ['apps/server/src/new-untracked.ts', 'apps/web/dist/index.html', 'apps/server/drizzle/0009.sql', 'docs/business-rules.md']) assert.equal(includeSource(name), true);
  for (const name of ['docs/private/source.xlsx', 'apps/server/.env', '.local/runtime.json', 'scripts/lingxing/probe.local.json', 'node_modules/pkg/index.js', 'backup.dump', 'secrets/recovery.key']) assert.equal(includeSource(name), false);
  for (const name of ['apps/server/src/modules/seller-mappings/resolution.test.ts', 'apps/server/dist/import-confirmation-acceptance.js', 'apps/server/dist/import-confirmation-acceptance.js.map', 'apps/server/src/import-acceptance.ts', 'apps/server/src/__fixtures__/source.json', 'scripts/acceptance/core.mjs', 'scripts/t11/import-confirmation-browser.mjs', 'docs/research/raw.md', 'docs/acceptance/evidence/screenshot.png', 'docs/templates/import.xlsx', 'archive.zip', 'local.sqlite3']) assert.equal(includeSource(name), false, name);
});

test('release packaging rejects source destinations and preserves an existing private release', () => fixture(async (root) => {
  const repo = join(root, 'source'); await mkdir(repo);
  for (const target of [repo, join(repo, 'apps/release'), join(repo, '.local/archive/release'), join(repo, '.local/trial/releases')]) await assert.rejects(packageRelease({ repo, target }));
  const target = join(repo, '.local/trial/releases/existing'); await mkdir(target, { recursive: true });
  await writeFile(join(target, 'preserved'), 'immutable');
  await assert.rejects(packageRelease({ repo, target }), /already exists/);
  assert.equal(await readFile(join(target, 'preserved'), 'utf8'), 'immutable');
  for (const name of ['.local/archive/old-git/config', '.local/archive/public/.git/config', '.local/development/recovery/trial-backup.key', '.local/trial/releases/old/apps/server/dist/api.js']) assert.equal(includeSource(name), false);
}));

test('retention deletes only successfully receipted backups older than 30 days', () => fixture(async (root) => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const cases = [['2026-09-01T00-00-00-old.scmbak', 46], ['2026-09-20T00-00-00-recent.scmbak', 27], ['2026-08-01T00-00-00-unreceipted.scmbak', null]];
  for (const [name, age] of cases) {
    await writeFile(join(root, name), 'encrypted');
    if (age !== null) await writeFile(join(root, `${name}.json`), JSON.stringify({ backup: name, completedAt: new Date(now - age * 86400000).toISOString() }));
  }
  await pruneBackups(root, 30, now);
  assert.equal(await exists(join(root, cases[0][0])), false);
  for (const [name] of cases.slice(1)) assert.equal(await exists(join(root, name)), true);
}));

test('authenticated extraction rejects existing target and verifies missing archive members', () => fixture(async (root) => {
  const stage = join(root, 'stage'); const target = join(root, 'restore'); await mkdir(stage);
  await writeFile(join(stage, 'data'), 'expected');
  const files = await inventory(stage);
  const manifest = { format: 'scm-trial-backup/v1', inventory: [...files, { path: 'missing', bytes: 1, sha256: sha256('x') }] };
  await writeFile(join(stage, 'backup-manifest.json'), JSON.stringify(manifest));
  const archive = join(root, 'backup.tar.gz'); const backup = join(root, 'backup.scmbak'); const key = randomBytes(32);
  await run('tar.exe', ['-czf', archive, '-C', stage, '.']); await encryptArchive(archive, backup, key);
  await assert.rejects(extractAuthenticated(backup, stage, key), /already exists/);
  await assert.rejects(extractAuthenticated(backup, target, key), /inventory differs/);
}));

test('environment parser supports quoted values without printing or shell execution', () => {
  const environment = parseEnv('DATABASE_URL="postgres://user:secret@127.0.0.1:55433/db"\nDATA_DIR=D:/trial/data # comment\nIGNORED\nTOKEN=\'literal$()\'\n');
  assert.equal(environment.DATA_DIR, 'D:/trial/data'); assert.equal(environment.TOKEN, 'literal$()'); assert(environment.DATABASE_URL.includes('secret'));
});

async function mockPackage(path, name, version, dependencies, code, peers, peerMeta) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs', dependencies, peerDependencies: peers, peerDependenciesMeta: peerMeta }));
  await writeFile(join(path, 'index.cjs'), code);
}

test('materialized packages preserve conflicting dependency versions in actual fresh Node requires', () => fixture(async (root) => {
  const source = join(root, 'source'); const target = join(root, 'target');
  await mockPackage(source, 'fixture', '1.0.0', { parent_a: '1', parent_b: '1' }, '');
  for (const [name, version] of [['parent_a', '1.0.0'], ['parent_b', '2.0.0']]) {
    const parent = join(source, 'node_modules', name);
    await mockPackage(parent, name, '1.0.0', { shared: version }, "module.exports = require('shared');");
    await mockPackage(join(parent, 'node_modules/shared'), 'shared', version, {}, `module.exports = '${version}';`);
  }
  await mockPackage(target, 'fixture', '1.0.0', {}, ''); await materializeProductionDependencies(source, target);
  const output = await run(process.execPath, ['-e', "console.log(JSON.stringify([require('parent_a'), require('parent_b')]))"], { cwd: target, env: { ...process.env, NODE_PATH: '' } });
  assert.deepEqual(JSON.parse(output), ['1.0.0', '2.0.0']);
  assert.equal((await inventory(target)).some((record) => record.link), false);
}));

test('materialized packages retain same-version packages with different peer contexts', () => fixture(async (root) => {
  const source = join(root, 'source'); const target = join(root, 'target');
  await mockPackage(source, 'fixture', '1.0.0', { parent_a: '1', parent_b: '1' }, '');
  for (const [name, version] of [['parent_a', '1.0.0'], ['parent_b', '2.0.0']]) {
    const parent = join(source, 'node_modules', name);
    await mockPackage(parent, name, '1.0.0', { bridge: '1.0.0' }, "module.exports = require('bridge');");
    await mockPackage(join(parent, 'node_modules/bridge'), 'bridge', '1.0.0', {}, "module.exports = require('shared');", { shared: '*' });
    await mockPackage(join(parent, 'node_modules/shared'), 'shared', version, {}, `module.exports = '${version}';`);
  }
  await mockPackage(target, 'fixture', '1.0.0', {}, ''); await materializeProductionDependencies(source, target);
  const output = await run(process.execPath, ['-e', "console.log(JSON.stringify([require('parent_a'), require('parent_b')]))"], { cwd: target, env: { ...process.env, NODE_PATH: '' } });
  assert.deepEqual(JSON.parse(output), ['1.0.0', '2.0.0']);
}));

test('runtime config rejects remote hosts, URL host overrides, data mismatches and keys inside the backup tree without network', () => fixture(async (root) => {
  const trial = join(root, 'trial'); await mkdir(join(trial, 'config'), { recursive: true });
  const path = join(trial, 'runtime.json'); const envPath = join(trial, 'config/app.env'); const dataDir = join(trial, 'data');
  const config = { trialRoot: trial, releasePath: join(trial, 'release'), dataDir, envPath, postgresBin: join(root, 'pg/bin'), postgresDataDir: join(trial, 'postgres'), postgresPort: 55433, database: 'scm_trial', appUser: 'scm_app', runtimeDir: join(trial, 'runtime'), backupDir: join(trial, 'backups'), keyPath: join(root, 'keys/recovery.key'), services: { api: 'SCM-Test-API', worker: 'SCM-Test-Worker' } };
  const connection = 'postgresql://scm_app:secret@127.0.0.1:55433/scm_trial';
  const env = async (url, dir = dataDir) => writeFile(envPath, `DATABASE_URL=${url}\nDATA_DIR=${dir}\n`);
  await writeFile(path, JSON.stringify(config)); await env(connection); await loadConfig(path);
  for (const url of [connection.replace('127.0.0.1', 'example.com'), `${connection}?host=example.com`, `${connection}#override`, connection.replace('scm_app:', 'postgres:'), connection.replace('55433', '55432')]) { await env(url); await assert.rejects(loadConfig(path)); }
  await env(connection, join(root, 'different-data')); await assert.rejects(loadConfig(path));
  await env(connection); config.keyPath = join(dataDir, 'secret.key'); await writeFile(path, JSON.stringify(config)); await assert.rejects(loadConfig(path));
  config.backupDir = join(root, 'external-backup'); config.keyPath = join(config.backupDir, 'secret.key'); await writeFile(path, JSON.stringify(config)); await assert.rejects(loadConfig(path));
}));

test('runtime config rejects physical key inclusion, recursive backups and mutable release directories', () => fixture(async (root) => {
  const trial = join(root, 'trial'); const dataDir = join(trial, 'data');
  await mkdir(join(trial, 'config'), { recursive: true }); await mkdir(dataDir);
  const path = join(trial, 'runtime.json'); const envPath = join(trial, 'config/app.env');
  const config = { trialRoot: trial, releasePath: join(trial, 'release'), dataDir, envPath, postgresBin: join(root, 'pg/bin'), postgresDataDir: join(trial, 'postgres'), postgresPort: 55433, database: 'scm_trial', appUser: 'scm_app', runtimeDir: join(trial, 'runtime'), backupDir: join(trial, 'backups'), keyPath: join(root, 'keys/recovery.key'), services: { api: 'SCM-Test-API', worker: 'SCM-Test-Worker' } };
  await writeFile(envPath, `DATABASE_URL=postgresql://scm_app:secret@127.0.0.1:55433/scm_trial\nDATA_DIR=${dataDir}\n`);
  const alias = join(root, 'data-alias'); await symlink(dataDir, alias, 'junction');
  for (const change of [{ keyPath: join(alias, 'recovery.key') }, { backupDir: join(alias, 'backups') }, { releasePath: dataDir }, { runtimeDir: join(trial, 'release/runtime') }, { envPath: join(trial, 'release/app.env') }]) {
    await writeFile(path, JSON.stringify({ ...config, ...change })); await assert.rejects(loadConfig(path));
  }
  await writeFile(path, JSON.stringify(config)); await loadConfig(path);
}));

test('production packaging omits dev-only optional peers and keeps explicitly selected production peers', () => fixture(async (root) => {
  const source = join(root, 'source'); const target = join(root, 'target');
  await mockPackage(source, 'fixture', '1.0.0', { runtime_package: '1', selected_peer: '1' }, '');
  await mockPackage(join(source, 'node_modules/runtime_package'), 'runtime_package', '1.0.0', {}, "module.exports = require('selected_peer');", { dev_tool: '*', selected_peer: '*' }, { dev_tool: { optional: true }, selected_peer: { optional: true } });
  await mockPackage(join(source, 'node_modules/selected_peer'), 'selected_peer', '1.0.0', {}, "module.exports = 'production';");
  await mockPackage(join(source, 'node_modules/dev_tool'), 'dev_tool', '1.0.0', {}, "module.exports = 'development-only';");
  await mockPackage(target, 'fixture', '1.0.0', {}, ''); const packages = await materializeProductionDependencies(source, target);
  assert.equal(packages.some((item) => item.name === 'dev_tool'), false);
  const output = await run(process.execPath, ['-e', "console.log(JSON.stringify(require('runtime_package')))"], { cwd: target, env: { ...process.env, NODE_PATH: '' } });
  assert.equal(JSON.parse(output), 'production');
}));

test('staged release and indexed data reject copy-time mutations before backup publication', () => fixture(async (root) => {
  const release = join(root, 'release'); const data = join(root, 'data');
  await mkdir(release); await mkdir(join(data, 'files'), { recursive: true });
  await writeFile(join(release, 'app.js'), 'original implementation');
  const files = await inventory(release); const manifest = Buffer.from(JSON.stringify({ format: 'scm-trial-release/v1', releaseId: 'fixture', inventory: files, contentSha256: sha256(JSON.stringify(files)) }));
  await writeFile(join(release, 'release-manifest.json'), manifest); await verifyReleaseDirectory(release, manifest);
  await writeFile(join(release, 'app.js'), 'changed implementation'); await assert.rejects(verifyReleaseDirectory(release, manifest), /inventory differs/);
  await writeFile(join(release, 'release-manifest.json'), Buffer.from(manifest.toString().replace('fixture', 'changed'))); await assert.rejects(verifyReleaseDirectory(release, manifest), /manifest changed/);
  const content = Buffer.from('immutable indexed content'); const path = join(data, 'files', 'file-id');
  await writeFile(path, content);
  const config = { releasePath: resolve(import.meta.dirname, '../..'), dataDir: data };
  const snapshot = { index: [{ id: 'file-id', storage_key: 'files/file-id', sha256: sha256(content), byte_size: String(content.length) }], confirmations: [], exports: [] };
  await verifyIndexedFiles(config, snapshot);
  await writeFile(path, 'copy changed'); await assert.rejects(verifyIndexedFiles(config, snapshot), /Indexed file verification failed/);
}));

test('pre-M3 database snapshots retain their original shape and M3 snapshots explicitly preserve confirmations and completed exports', async () => {
  const calls = [];
  const absent = await physicalDatabaseSnapshot({ query: async (sql) => { calls.push(sql); return { rows: [{ confirmations: null, exports: null }] }; } });
  assert.deepEqual(absent, {}); assert.equal(calls.length, 1); assert.match(calls[0], /to_regclass/);
  const present = await physicalDatabaseSnapshot({ query: async (sql) => {
    if (sql.includes('to_regclass')) return { rows: [{ confirmations: 'physical_confirmation', exports: 'physical_export' }] };
    if (sql.includes('from physical_confirmation')) return { rows: [{ id: 'confirmation-1' }, { id: 'confirmation-2' }] };
    assert.match(sql, /physical_export where status='completed' order by id/);
    return { rows: [{ id: 'physical-export-1', file_id: 'file-1', references: [{ physicalConfirmationId: 'confirmation-1' }], status: 'completed' }] };
  } });
  assert.deepEqual(present.physicalConfirmations, ['confirmation-1', 'confirmation-2']); assert.equal(present.physicalExports[0].file_id, 'file-1');
});

async function physicalWorkbookFixture(root, change = () => {}) {
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('实物箱明细');
  sheet.addRow(['采用毛重(KG)', '采用长(CM)', '采用宽(CM)', '采用高(CM)', '实测毛重(KG)', '实测长(CM)', '实测宽(CM)', '实测高(CM)', '毛重差(KG)', '长差(CM)', '宽差(CM)', '高差(CM)']);
  for (let index = 0; index < 12; index++) { const row = sheet.addRow([1.01, 2.54, 7.62, 10.16, null, null, null, null, null, null, null, null]); row.eachCell((cell) => { cell.numFmt = '0.00'; }); }
  workbook.addWorksheet('箱内商品').addRows([['MSKU', '数量'], ['商品1', 2], ['商品2', 1]]);
  workbook.addWorksheet('版本与核对记录').addRows([['M3确认ID'], ['physical-confirmation']]);
  change(workbook);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const dataDir = join(root, 'data'); await mkdir(join(dataDir, 'files'), { recursive: true }); await writeFile(join(dataDir, 'files/physical.xlsx'), bytes);
  return { config: { releasePath: resolve(import.meta.dirname, '../..'), dataDir },
    snapshot: { index: [{ id: 'physical-file', storage_key: 'files/physical.xlsx', sha256: sha256(bytes), byte_size: String(bytes.length) }], confirmations: ['m2-confirmation'], exports: [],
      physicalConfirmations: ['physical-confirmation'], physicalExports: [{ id: 'physical-export', file_id: 'physical-file', references: [{ physicalConfirmationId: 'physical-confirmation' }], status: 'completed' }] } };
}

test('indexed verification opens historical M3 XLSX and keeps pre-M3 snapshot compatibility', () => fixture(async (root) => {
  const { config, snapshot } = await physicalWorkbookFixture(root);
  assert.deepEqual(await verifyIndexedFiles(config, snapshot), { indexedFiles: 1, confirmations: 1, historicalXlsx: 1, physicalConfirmations: 1, physicalHistoricalXlsx: 1 });
  const legacy = { index: snapshot.index, confirmations: ['m2-confirmation'], exports: [] };
  assert.deepEqual(await verifyIndexedFiles(config, legacy), { indexedFiles: 1, confirmations: 1, historicalXlsx: 0 });
}));

test('indexed verification rejects missing M3 file indexes, missing bytes and lost confirmation references', () => fixture(async (root) => {
  const { config, snapshot } = await physicalWorkbookFixture(root);
  await assert.rejects(verifyIndexedFiles(config, { ...snapshot, index: [] }), /no indexed file/);
  await assert.rejects(verifyIndexedFiles(config, { ...snapshot, physicalConfirmations: [] }), /no preserved physical confirmation/);
  await rm(join(config.dataDir, 'files/physical.xlsx'));
  await assert.rejects(verifyIndexedFiles(config, snapshot), { code: 'ENOENT' });
}));

test('indexed verification rejects M3 missing sheets, numeric text, missing values and wrong decimal formatting', () => fixture(async (root) => {
  const cases = [
    (book) => book.removeWorksheet('箱内商品'),
    (book) => { book.getWorksheet('实物箱明细').getCell('A2').value = '1.01'; },
    (book) => { book.getWorksheet('实物箱明细').getCell('A2').value = null; },
    (book) => { book.getWorksheet('实物箱明细').getCell('A2').numFmt = 'General'; },
  ];
  for (const [index, change] of cases.entries()) {
    const { config, snapshot } = await physicalWorkbookFixture(join(root, `case-${index}`), change);
    await assert.rejects(verifyIndexedFiles(config, snapshot), /Historical physical XLSX/);
  }
}));

test('pre-M4 snapshots omit document keys and M4 snapshots retain immutable revision/template/file references', async () => {
  assert.deepEqual(await documentDatabaseSnapshot({ query: async () => ({ rows: [{ revisions: null, exports: null, templates: null }] }) }), {});
  const actual = await documentDatabaseSnapshot({ query: async (sql) => {
    if (sql.includes('to_regclass')) return { rows: [{ revisions: 'document_revision', exports: 'document_export', templates: 'document_template_version' }] };
    if (sql.includes('from document_revision')) return { rows: [{ id: 'rev' }] };
    if (sql.includes('from document_template_version')) return { rows: [{ template_id: 'tpl', version: 1, file_id: 'file', sha256: 'hash' }] };
    return { rows: [{ id: 'export', file_id: 'result', reference: { revisionId: 'rev' } }] };
  } });
  assert.deepEqual(actual.documentRevisions, ['rev']); assert.equal(actual.documentTemplates[0].file_id, 'file'); assert.equal(actual.documentExports[0].reference.revisionId, 'rev');
});

async function invoiceWorkbookFixture(root, { rows = 1, imageRows = [18], carton = 'FBA000001-1', imageColumn = 'P' } = {}) {
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url)), ExcelJS = require('exceljs');
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('清关单');
  sheet.getCell('A17').value = '货箱编号*'; sheet.getCell('Q17').value = '产品销售链接'; sheet.getCell('B16').value = rows; sheet.getCell('F15').value = 3 * rows;
  for (let index = 18; index < 18 + rows; index++) {
    sheet.getRow(index).values = [carton, 'PO', 1.25, 2, 3, 4, 'Product', '商品', 1, 3, 'glass', '1234', 'test', 'brand', 'model', null, 'https://example.com'];
    for (const column of [3, 4, 5, 6, 9]) sheet.getRow(index).getCell(column).numFmt = '0.00';
  }
  for (const index of imageRows) {
    const imageId = book.addImage({ base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', extension: 'png' }); sheet.addImage(imageId, `${imageColumn}${index}:${imageColumn}${index}`);
  }
  const bytes = Buffer.from(await book.xlsx.writeBuffer()), dataDir = join(root, 'data'); await mkdir(join(dataDir, 'files'), { recursive: true });
  await writeFile(join(dataDir, 'files/invoice.xlsx'), bytes); await writeFile(join(dataDir, 'files/template.xlsx'), bytes);
  const template = { template_id: 'template', version: 1, file_id: 'template-file', sha256: sha256(bytes) };
  const exported = { id: 'export', file_id: 'invoice-file', reference: { revisionId: 'revision', templateId: 'template', templateVersion: 1, templateSha256: sha256(bytes), sources: [{ m2ConfirmationId: 'm2', physicalConfirmationId: 'm3' }] } };
  const snapshot = { index: ['invoice', 'template'].map((name) => ({ id: `${name}-file`, storage_key: `files/${name}.xlsx`, sha256: sha256(bytes), byte_size: bytes.length })), confirmations: ['m2'], exports: [], physicalConfirmations: ['m3'], documentRevisions: ['revision'], documentTemplates: [template], documentExports: [exported] };
  const config = { releasePath: resolve(import.meta.dirname, '../..'), dataDir };
  return { config, snapshot };
}

test('invoice recovery verifies source references, template hashes, numeric fields and images', () => fixture(async (root) => {
  const { config, snapshot } = await invoiceWorkbookFixture(root);
  assert.equal((await verifyIndexedFiles(config, snapshot)).documentHistoricalXlsx, 1);
  await assert.rejects(verifyIndexedFiles(config, { ...snapshot, documentRevisions: [] }), /no preserved document revision/);
  await assert.rejects(verifyIndexedFiles(config, { ...snapshot, documentTemplates: [] }), /no preserved template version/);
  await assert.rejects(verifyIndexedFiles(config, { ...snapshot, physicalConfirmations: [] }), /no preserved source confirmation/);
}));

test('invoice recovery accepts M2-only sources while preserving legacy M3 reference checks', () => fixture(async (root) => {
  const { config, snapshot } = await invoiceWorkbookFixture(root);
  snapshot.documentExports[0].reference.sources[0].physicalConfirmationId = null;
  snapshot.physicalConfirmations = [];
  assert.equal((await verifyIndexedFiles(config, snapshot)).documentHistoricalXlsx, 1);
  await assert.rejects(verifyIndexedFiles(config, { ...snapshot, confirmations: [] }), /no preserved source confirmation/);
  snapshot.documentExports[0].reference.sources.push({ m2ConfirmationId: 'm2', physicalConfirmationId: 'missing-legacy-confirmation' });
  await assert.rejects(verifyIndexedFiles(config, snapshot), /no preserved source confirmation/);
}));

test('invoice recovery accepts missing and mixed product images with current single-carton identifiers', () => fixture(async (root) => {
  for (const [index, imageRows] of [[], [19], [18, 19]].entries()) {
    const { config, snapshot } = await invoiceWorkbookFixture(join(root, String(index)), { rows: 2, imageRows, carton: 'FBATECHU000001' });
    assert.equal((await verifyIndexedFiles(config, snapshot)).documentHistoricalXlsx, 1);
  }
}));

test('invoice recovery rejects duplicate or misplaced product images', () => fixture(async (root) => {
  for (const [index, options] of [{ imageRows: [18, 18] }, { imageColumn: 'Q' }].entries()) {
    const { config, snapshot } = await invoiceWorkbookFixture(join(root, String(index)), options);
    await assert.rejects(verifyIndexedFiles(config, snapshot), /image mapping is invalid/);
  }
}));
