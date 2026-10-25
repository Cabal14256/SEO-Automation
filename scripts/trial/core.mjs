import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { assertRuntimePath, assertSeparatePaths, containsPath, physicalPath } from '../shared/path-policy.mjs';

const MAGIC = Buffer.from('SCMBKP01');
const HEADER_LENGTH = 36;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function hashFile(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
export async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export function inside(root, path) {
  const part = relative(resolve(root), resolve(path));
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
export function assertNewTarget(path, forbidden = []) {
  const normalized = resolve(path);
  if (normalized === dirname(normalized) || forbidden.some((root) => normalized === resolve(root) || inside(root, normalized) || inside(normalized, root))) {
    throw new Error('Target must be a separate new directory');
  }
  return normalized;
}
export function safeRelative(path) {
  const normal = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normal || normal.startsWith('/') || normal.includes(':') || normal.split('/').includes('..') || normal.includes('\0') || normal.split('/').some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe archive path');
  return normal;
}
export async function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (bytes) => stdout.push(bytes));
    child.stderr.on('data', (bytes) => stderr.push(bytes));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) done(Buffer.concat(stdout).toString('utf8'));
      else { const error = new Error(`Command ${command.split(/[\\/]/).at(-1)} failed (${code})`); error.privateDetails = Buffer.concat(stderr).toString('utf8'); reject(error); }
    });
    if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  });
}
export async function secureDirectory(path) {
  if (process.platform !== 'win32') return;
  const sid = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'])).trim();
  if (!/^S-1-5-[\d-]+$/.test(sid)) throw new Error('Cannot determine current Windows identity');
  await run('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']);
}
export function parseEnv(contents) {
  const output = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    output[match[1]] = value;
  }
  return output;
}
export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  for (const name of ['trialRoot', 'releasePath', 'dataDir', 'envPath', 'postgresBin', 'postgresDataDir', 'runtimeDir', 'backupDir', 'keyPath']) {
    if (typeof config[name] !== 'string' || !isAbsolute(config[name])) throw new Error(`Missing absolute runtime setting: ${name}`);
  }
  if (!Number.isInteger(config.postgresPort) || config.postgresPort < 1024 || config.postgresPort > 65535) throw new Error('Invalid postgresPort');
  for (const name of ['api', 'worker']) if (!/^[A-Za-z0-9_.-]+$/.test(config.services?.[name] ?? '')) throw new Error(`Invalid service name: ${name}`);
  config.configDir ??= join(config.trialRoot, 'config');
  config.caddyDataDir ??= join(config.trialRoot, 'caddy-data');
  config.caddyConfigDir ??= join(config.trialRoot, 'caddy-config');
  config.configPath = resolve(path);
  const copiedRoots = [config.releasePath, config.dataDir, config.configDir, config.caddyDataDir, config.caddyConfigDir, config.toolsDir ?? join(config.trialRoot, 'tools'), config.servicesDir ?? join(config.trialRoot, 'services')];
  for (const root of [config.trialRoot, config.backupDir, ...copiedRoots]) {
    assertSeparatePaths(config.keyPath, [root], 'Backup key must stay outside every included backup directory');
  }
  assertSeparatePaths(config.backupDir, copiedRoots, 'Backup directory cannot overlap a copied data, release or configuration directory');
  const mutableRoots = [config.dataDir, config.configDir, config.postgresDataDir, config.runtimeDir, config.backupDir, config.caddyDataDir, config.caddyConfigDir];
  for (const path of mutableRoots) assertSeparatePaths(path, [config.releasePath], 'Mutable runtime directories cannot overlap the immutable release');
  for (const path of [config.envPath, config.configPath]) {
    if (containsPath(config.releasePath, path) || containsPath(physicalPath(config.releasePath), physicalPath(path))) throw new Error('Runtime configuration cannot be stored in the immutable release');
  }
  const environment = parseEnv(await readFile(config.envPath, 'utf8'));
  const database = new URL(environment.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.search || database.hash || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) || Number(database.port || 5432) !== config.postgresPort || decodeURIComponent(database.pathname.slice(1)) !== config.database || (config.appUser && decodeURIComponent(database.username) !== config.appUser)) throw new Error('Database connection must match the local trial configuration');
  if (typeof environment.DATA_DIR !== 'string' || resolve(environment.DATA_DIR) !== resolve(config.dataDir)) throw new Error('DATA_DIR must match the trial configuration');
  return { config, environment };
}
export async function inventory(root, skip = () => false) {
  const entriesToHash = [];
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const absolute = join(path, entry.name); const name = relative(root, absolute).replaceAll('\\', '/');
      if (skip(name, entry)) continue;
      if (entry.isSymbolicLink()) {
        const target = await realpath(absolute);
        if (!inside(root, target)) throw new Error(`External package link: ${name}`);
        entriesToHash.push({ path: name, link: relative(dirname(absolute), target).replaceAll('\\', '/') });
      } else if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) entriesToHash.push({ path: name, absolute });
      else throw new Error(`Unsupported filesystem entry: ${name}`);
    }
  }
  await visit(root);
  const files = [];
  for (let index = 0; index < entriesToHash.length; index += 16) {
    const results = await Promise.allSettled(entriesToHash.slice(index, index + 16).map(async (entry) => {
      if (entry.link) return entry;
      const details = await stat(entry.absolute);
      const digest = details.size <= 1024 * 1024 ? sha256(await readFile(entry.absolute)) : await hashFile(entry.absolute);
      return { path: entry.path, bytes: details.size, sha256: digest };
    }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    files.push(...results.map((result) => result.value));
  }
  return files;
}
export async function verifyInventory(root, records) {
  const actual = await inventory(root);
  const expected = [...records].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  actual.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('File inventory differs: missing, changed or unexpected files');
  return { files: records.filter((record) => record.sha256).length, links: records.filter((record) => record.link).length };
}
export async function verifyReleaseDirectory(root, expectedManifest) {
  const path = join(root, 'release-manifest.json'); const bytes = await readFile(path);
  if (expectedManifest && !bytes.equals(expectedManifest)) throw new Error('Release manifest changed while copying');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== 'scm-trial-release/v1' || !Array.isArray(manifest.inventory) || sha256(JSON.stringify(manifest.inventory)) !== manifest.contentSha256) throw new Error('Release content manifest is invalid');
  await verifyInventory(root, [...manifest.inventory, { path: 'release-manifest.json', bytes: bytes.length, sha256: sha256(bytes) }]);
  return manifest;
}
export async function encryptArchive(source, target, key) {
  if (key.length !== 32) throw new Error('Recovery key must contain exactly 32 bytes');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const header = Buffer.concat([MAGIC, iv, Buffer.alloc(16)]);
  const file = await open(target, 'wx', 0o600); await file.write(header); await file.close();
  try {
    await pipeline(createReadStream(source), cipher, createWriteStream(target, { flags: 'a' }));
    const result = await open(target, 'r+'); await result.write(cipher.getAuthTag(), 0, 16, 20); await result.sync(); await result.close();
  } catch (error) { await rm(target, { force: true }); throw error; }
}
export async function decryptArchive(source, target, key) {
  const file = await open(source, 'r'); const header = Buffer.alloc(HEADER_LENGTH);
  try { const result = await file.read(header, 0, HEADER_LENGTH, 0); if (result.bytesRead !== HEADER_LENGTH || !header.subarray(0, 8).equals(MAGIC)) throw new Error('Unknown backup format'); }
  finally { await file.close(); }
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8, 20)); decipher.setAuthTag(header.subarray(20));
  try { await pipeline(createReadStream(source, { start: HEADER_LENGTH }), decipher, createWriteStream(target, { flags: 'wx', mode: 0o600 })); }
  catch { await rm(target, { force: true }); throw new Error('Backup authentication failed: wrong key or damaged backup'); }
}
export async function readKey(path, create = false) {
  if (create && !await exists(path)) {
    if (dirname(path) === dirname(dirname(path))) throw new Error('Recovery key requires a dedicated directory');
    await mkdir(dirname(path), { recursive: true }); await secureDirectory(dirname(path)); await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const key = await readFile(path);
  if (key.length !== 32) throw new Error('Recovery key must contain exactly 32 bytes');
  return key;
}
export function pgEnvironment(environment) {
  const parsed = new URL(environment.DATABASE_URL);
  return { ...process.env, PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password), PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)), PGOPTIONS: '-c timezone=UTC', PGCONNECT_TIMEOUT: '10' };
}
export async function databaseSnapshot(config, environment) {
  const require = createRequire(join(config.releasePath, 'apps/server/package.json'));
  const { Client } = require('pg');
  const client = new Client({ connectionString: environment.DATABASE_URL, options: '-c timezone=UTC', connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const tables = (await client.query("select table_schema,table_name from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema') and table_schema not like 'pg_toast%' order by table_schema,table_name")).rows;
    const snapshot = [];
    for (const table of tables) {
      const ident = `"${table.table_schema.replaceAll('"', '""')}"."${table.table_name.replaceAll('"', '""')}"`;
      const records = (await client.query(`select row_to_json(t)::text as row from ${ident} t order by row_to_json(t)::text`)).rows;
      snapshot.push({ table: `${table.table_schema}.${table.table_name}`, rows: records.length, sha256: sha256(records.map((record) => record.row).join('\n')) });
    }
    const index = (await client.query('select id,storage_key,sha256,byte_size from file_index order by id')).rows;
    const sequenceNames = (await client.query("select sequence_schema,sequence_name from information_schema.sequences where sequence_schema not in ('pg_catalog','information_schema') order by sequence_schema,sequence_name")).rows;
    const sequences = [];
    for (const sequence of sequenceNames) {
      const ident = `"${sequence.sequence_schema.replaceAll('"', '""')}"."${sequence.sequence_name.replaceAll('"', '""')}"`;
      const value = (await client.query(`select last_value::text,is_called from ${ident}`)).rows[0];
      sequences.push({ sequence: `${sequence.sequence_schema}.${sequence.sequence_name}`, ...value });
    }
    const confirmations = (await client.query('select id from group_confirmation order by id')).rows.map((row) => row.id);
    const exports = (await client.query('select id,file_id,"references",status from batch_export where status=\'completed\' order by id')).rows;
    // Old releases do not contain M3 tables. Omit optional keys in that case so
    // their authenticated manifests still compare byte-for-byte after restore.
    const physical = await physicalDatabaseSnapshot(client);
    const document = await documentDatabaseSnapshot(client);
    await client.query('commit');
    return { tables: snapshot, sequences, index, confirmations, exports, ...physical, ...document };
  } catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
  finally { await client.end(); }
}
export async function physicalDatabaseSnapshot(client) {
  const available = (await client.query("select to_regclass('public.physical_confirmation')::text as confirmations,to_regclass('public.physical_export')::text as exports")).rows[0];
  const physical = {};
  if (available?.confirmations) physical.physicalConfirmations = (await client.query('select id from physical_confirmation order by id')).rows.map((row) => row.id);
  if (available?.exports) physical.physicalExports = (await client.query('select id,file_id,"references",status from physical_export where status=\'completed\' order by id')).rows;
  return physical;
}
export async function documentDatabaseSnapshot(client) {
  const available = (await client.query("select to_regclass('public.document_revision')::text as revisions,to_regclass('public.document_export')::text as exports,to_regclass('public.document_template_version')::text as templates")).rows[0];
  const document = {};
  if (available?.revisions) document.documentRevisions = (await client.query('select id from document_revision order by id')).rows.map((row) => row.id);
  if (available?.templates) document.documentTemplates = (await client.query('select template_id,version,file_id,sha256 from document_template_version order by template_id,version')).rows;
  if (available?.exports) document.documentExports = (await client.query("select id,file_id,reference,status from document_export where status='completed' order by id")).rows;
  return document;
}
function verifyDocumentWorkbook(workbook) {
  const sheet = workbook.worksheets[0];
  if (workbook.worksheets.length !== 1 || sheet?.getCell('A17').text.replace(/\s|\*/g, '') !== '货箱编号' || !sheet.getCell('Q17').text.includes('销售链接') || sheet.rowCount < 18) throw new Error('Historical invoice XLSX layout is invalid');
  if (!Number.isSafeInteger(sheet.getCell('B16').value) || sheet.getCell('B16').value < 1 || !Number.isSafeInteger(sheet.getCell('F15').value) || sheet.getCell('F15').value < 1) throw new Error('Historical invoice XLSX totals are invalid');
  for (let index = 18; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index);
    if (!/^.+\d{6}(?:-\d+)?$/.test(row.getCell(1).text) || !row.getCell(2).text || !row.getCell(17).text) throw new Error('Historical invoice XLSX row identity is invalid');
    for (const column of [3, 4, 5, 6, 9, 10]) if (typeof row.getCell(column).value !== 'number' || row.getCell(column).value <= 0 || !Number.isFinite(row.getCell(column).value) || column !== 10 && row.getCell(column).numFmt !== '0.00') throw new Error('Historical invoice XLSX numeric fields are invalid');
  }
  const imageRows = new Set();
  for (const image of sheet.getImages()) {
    const row = image.range.tl.nativeRow, column = image.range.tl.nativeCol;
    const media = workbook.getImage(Number(image.imageId));
    if (column !== 15 || row < 17 || row >= sheet.rowCount || imageRows.has(row) || !media?.buffer || !['png', 'jpeg', 'jpg'].includes(media.extension)) throw new Error('Historical invoice XLSX image mapping is invalid');
    imageRows.add(row);
  }
}
function verifyPhysicalWorkbook(workbook) {
  const expected = ['实物箱明细', '箱内商品', '版本与核对记录'];
  if (workbook.worksheets.length !== expected.length || !expected.every((name) => workbook.getWorksheet(name))) throw new Error('Historical physical XLSX has invalid required sheets');
  const sheet = workbook.getWorksheet('实物箱明细');
  if (sheet.rowCount < 2 || workbook.getWorksheet('箱内商品').rowCount < 2 || workbook.getWorksheet('版本与核对记录').rowCount < 2) throw new Error('Historical physical XLSX has no business rows');
  const headers = new Map(); sheet.getRow(1).eachCell((cell, column) => headers.set(cell.text, column));
  const required = ['采用毛重(KG)', '采用长(CM)', '采用宽(CM)', '采用高(CM)'];
  const optional = ['实测毛重(KG)', '实测长(CM)', '实测宽(CM)', '实测高(CM)', '毛重差(KG)', '长差(CM)', '宽差(CM)', '高差(CM)'];
  for (const name of [...required, ...optional]) if (!headers.has(name)) throw new Error('Historical physical XLSX has invalid measurement headers');
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    for (const name of [...required, ...optional]) {
      const cell = row.getCell(headers.get(name)), value = cell.value;
      if ((value === null || value === undefined) && optional.includes(name)) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || cell.numFmt !== '0.00' || (required.includes(name) && value <= 0)) throw new Error('Historical physical XLSX measurement must be numeric with 0.00 format');
    }
  });
}
export async function verifyIndexedFiles(config, snapshot) {
  for (const record of snapshot.index) {
    const key = safeRelative(record.storage_key); const path = resolve(config.dataDir, key);
    if (!inside(config.dataDir, path)) throw new Error('Indexed file path escapes data directory');
    const bytes = await readFile(path);
    if (String(bytes.length) !== String(record.byte_size) || sha256(bytes) !== record.sha256) throw new Error(`Indexed file verification failed: ${record.id}`);
  }
  // ExcelJS opens each historical completed XLSX. Its saved projection and rule
  // references are independently retained in the database snapshot digest.
  const require = createRequire(join(config.releasePath, 'apps/server/package.json'));
  const ExcelJS = require('exceljs');
  for (const exported of [...snapshot.exports, ...(snapshot.physicalExports ?? []), ...(snapshot.documentExports ?? [])]) {
    const file = snapshot.index.find((row) => row.id === exported.file_id);
    if (!file) throw new Error('Completed export has no indexed file');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(config.dataDir, file.storage_key));
    if (!workbook.worksheets.length) throw new Error('Historical XLSX has no sheets');
    if (snapshot.physicalExports?.includes(exported)) {
      for (const reference of exported.references ?? []) if (!snapshot.physicalConfirmations?.includes(reference.physicalConfirmationId)) throw new Error('Completed physical export has no preserved physical confirmation');
      verifyPhysicalWorkbook(workbook);
    }
    if (snapshot.documentExports?.includes(exported)) {
      const reference = exported.reference;
      if (!snapshot.documentRevisions?.includes(reference?.revisionId)) throw new Error('Completed invoice has no preserved document revision');
      const template = snapshot.documentTemplates?.find((item) => item.template_id === reference.templateId && item.version === reference.templateVersion);
      const indexedTemplate = template && snapshot.index.find((item) => item.id === template.file_id);
      if (!template || !indexedTemplate || template.sha256 !== reference.templateSha256 || template.sha256 !== indexedTemplate.sha256) throw new Error('Completed invoice has no preserved template version');
      for (const source of reference.sources ?? []) {
        if (!snapshot.confirmations.includes(source.m2ConfirmationId)
          || source.physicalConfirmationId !== null && !snapshot.physicalConfirmations?.includes(source.physicalConfirmationId)) throw new Error('Completed invoice has no preserved source confirmation');
      }
      verifyDocumentWorkbook(workbook);
    }
  }
  return { indexedFiles: snapshot.index.length, confirmations: snapshot.confirmations.length, historicalXlsx: snapshot.exports.length + (snapshot.physicalExports?.length ?? 0) + (snapshot.documentExports?.length ?? 0),
    ...(snapshot.physicalConfirmations ? { physicalConfirmations: snapshot.physicalConfirmations.length } : {}), ...(snapshot.physicalExports ? { physicalHistoricalXlsx: snapshot.physicalExports.length } : {}), ...(snapshot.documentExports ? { documentHistoricalXlsx: snapshot.documentExports.length } : {}) };
}
async function serviceStatus(name) {
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Service -Name '${name}' -ErrorAction Stop).Status.ToString()`])).trim();
}
async function controlService(name, action) {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s=Get-Service -Name '${name}' -ErrorAction Stop; ${action}-Service -InputObject $s -ErrorAction Stop; $s.WaitForStatus('${action === 'Stop' ? 'Stopped' : 'Running'}',[TimeSpan]::FromSeconds(60))`]);
}
export async function consistentCopy(config, environment, stage) {
  const running = [];
  for (const kind of ['https', 'api', 'worker']) {
    const name = config.services[kind];
    if (!name) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Invalid service name');
    if (await serviceStatus(name) === 'Running') running.push(name);
  }
  try {
    for (const service of running) await controlService(service, 'Stop');
    const boundaryAt = new Date().toISOString();
    const releaseManifest = await readFile(join(config.releasePath, 'release-manifest.json'));
    const snapshot = await databaseSnapshot(config, environment);
    await verifyIndexedFiles(config, snapshot);
    await run(join(config.postgresBin, 'pg_dump.exe'), ['-Fc', '--no-owner', '--no-privileges', '-f', join(stage, 'database.dump')], { env: pgEnvironment(environment) });
    await cp(config.dataDir, join(stage, 'data'), { recursive: true, dereference: false });
    await cp(config.releasePath, join(stage, 'release'), { recursive: true, dereference: false, verbatimSymlinks: false });
    const stagedConfig = { ...config, releasePath: join(stage, 'release'), dataDir: join(stage, 'data') };
    const stagedRelease = await verifyReleaseDirectory(stagedConfig.releasePath, releaseManifest);
    await verifyIndexedFiles(stagedConfig, snapshot);
    await cp(config.configDir, join(stage, 'config'), { recursive: true, dereference: false });
    if (await exists(config.caddyDataDir)) await cp(config.caddyDataDir, join(stage, 'caddy-data'), { recursive: true, dereference: false });
    for (const directory of ['tools', 'services', 'caddy-config']) {
      const source = directory === 'tools' ? config.toolsDir ?? join(config.trialRoot, directory) : directory === 'services' ? config.servicesDir ?? join(config.trialRoot, directory) : config.caddyConfigDir ?? join(config.trialRoot, directory);
      if (await exists(source)) await cp(source, join(stage, directory), { recursive: true, dereference: false });
    }
    await cp(config.configPath, join(stage, 'runtime.source.json'));
    const manifest = { format: 'scm-trial-backup/v1', boundaryAt, releaseId: stagedRelease.releaseId, snapshot, original: { trialRoot: config.trialRoot, postgresPort: config.postgresPort, database: config.database }, inventory: await inventory(stage) };
    await writeFile(join(stage, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return manifest;
  } finally {
    // Attempt every restart even if one restart fails; never mask data errors.
    const results = await Promise.allSettled([...running].reverse().map((service) => controlService(service, 'Start')));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map((result) => result.reason), 'Backup completed or failed; one or more original services could not restart');
  }
}
export async function backup(configPath) {
  const { config, environment } = await loadConfig(configPath);
  await mkdir(config.backupDir, { recursive: true });
  const key = await readKey(config.keyPath); // Keys are explicitly initialized, never silently replaced.
  const lockPath = join(config.backupDir, '.backup.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error) => { if (error.code === 'EEXIST') throw new Error('Another backup holds the backup lock; inspect it before retrying'); throw error; });
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const id = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
  const stage = join(config.backupDir, `.staging-${id}`); const archive = `${stage}.tar.gz`; const temporary = join(config.backupDir, `.${id}.tmp`); const target = join(config.backupDir, `${id}.scmbak`);
  try {
    await mkdir(stage);
    const manifest = await consistentCopy(config, environment, stage);
    await run('tar.exe', ['-czf', archive, '-C', stage, '.']);
    await encryptArchive(archive, temporary, key);
    // Authenticate the just-written encrypted archive before publishing it.
    const readback = `${archive}.readback`; await decryptArchive(temporary, readback, key);
    if (await hashFile(readback) !== await hashFile(archive)) throw new Error('Encrypted backup readback differs');
    await rename(temporary, target);
    const receipt = { format: 'scm-trial-backup-receipt/v1', backup: target.split(/[\\/]/).at(-1), boundaryAt: manifest.boundaryAt, completedAt: new Date().toISOString(), releaseId: manifest.releaseId, bytes: (await stat(target)).size, sha256: await hashFile(target), keyStoredSeparately: true, retentionDays: 30 };
    await writeFile(`${target}.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await pruneBackups(config.backupDir, 30);
    return receipt;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await Promise.allSettled([archive, `${archive}.readback`, temporary].map((path) => rm(path, { force: true })));
    await lock.close(); await rm(lockPath);
  }
}
export async function pruneBackups(directory, days, now = Date.now()) {
  const cutoff = now - days * 86400000;
  const entries = await readdir(directory);
  for (const name of entries.filter((name) => /^\d{4}-\d\d-\d\dT[\w-]+\.scmbak$/.test(name))) {
    const path = join(directory, name); const receipt = `${path}.json`;
    // Retain unreceipted/unknown artifacts for diagnosis; only prune completed
    // backups whose successful backup timestamp is older than the retention.
    if (!await exists(receipt)) continue;
    const data = JSON.parse(await readFile(receipt, 'utf8'));
    if (Date.parse(data.completedAt) < cutoff && data.backup === name) { await rm(path); await rm(receipt); }
  }
}
export async function extractAuthenticated(backupPath, target, key) {
  if (await exists(target)) throw new Error('Restore target already exists');
  const temporary = `${target}.${randomUUID()}.work`;
  await mkdir(temporary); await secureDirectory(temporary);
  const archive = join(temporary, 'authenticated.tar.gz');
  try {
    await decryptArchive(backupPath, archive, key);
    const paths = (await run('tar.exe', ['-tf', archive])).split(/\r?\n/).filter((path) => path && path !== './' && path !== '.');
    paths.forEach(safeRelative);
    // pnpm's internal package links are allowed only after the extracted
    // inventory proves that every link resolves within its restored tree.
    const verbose = (await run('tar.exe', ['-tvf', archive])).split(/\r?\n/);
    if (verbose.some((line) => /^[lh]/.test(line))) throw new Error('Restore archive contains links; package must be materialized before backup');
    await mkdir(target, { recursive: false }); await secureDirectory(target);
    await run('tar.exe', ['-xzf', archive, '-C', target, '--no-same-owner']);
    const manifest = JSON.parse(await readFile(join(target, 'backup-manifest.json'), 'utf8'));
    if (manifest.format !== 'scm-trial-backup/v1') throw new Error('Unknown backup manifest');
    await verifyInventory(target, [...manifest.inventory, { path: 'backup-manifest.json', bytes: (await stat(join(target, 'backup-manifest.json'))).size, sha256: sha256(await readFile(join(target, 'backup-manifest.json'))) }]);
    return manifest;
  } finally {
    if (!inside(dirname(target), temporary)) throw new Error('Unsafe temporary cleanup path');
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function restore({ configPath, backupPath, target, port, database }) {
  const started = Date.now(); const { config } = await loadConfig(configPath);
  target = assertRuntimePath(resolve(import.meta.dirname, '../..'), target, 'restore');
  const forbidden = [config.trialRoot, config.keyPath, config.releasePath, config.dataDir, config.configDir, config.postgresDataDir, config.caddyDataDir, config.caddyConfigDir, config.backupDir, config.runtimeDir];
  target = assertNewTarget(target, forbidden);
  assertSeparatePaths(target, forbidden, 'Restore target cannot overlap existing runtime or backup directories');
  target = physicalPath(target);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === config.postgresPort || port === 55432) throw new Error('Restore requires a different non-development database port');
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(database) || database === config.database || database === 'scm_automation_dev') throw new Error('Restore requires a new database name');
  const manifest = await extractAuthenticated(backupPath, target, await readKey(config.keyPath));
  if (port === manifest.original.postgresPort || database === manifest.original.database) throw new Error('Restore must differ from the backed-up database port and name');
  let databaseStarted = false;
  const pgData = join(target, 'postgres'); const pgRuntime = join(target, 'runtime');
  try {
    await mkdir(pgRuntime); const password = randomBytes(32).toString('base64url'); const appPassword = randomBytes(32).toString('base64url');
    const passwordFile = join(pgRuntime, 'init-password'); await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' });
    try { await run(join(config.postgresBin, 'initdb.exe'), ['-D', pgData, '-U', 'restore_admin', '--pwfile', passwordFile, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C']); }
    finally { await rm(passwordFile, { force: true }); }
    await writeFile(join(pgData, 'postgresql.auto.conf'), `listen_addresses = '127.0.0.1'\nport = ${port}\n`, { flag: 'a' });
    await run(join(config.postgresBin, 'pg_ctl.exe'), ['-D', pgData, '-l', join(pgRuntime, 'postgres.log'), '-w', 'start']); databaseStarted = true;
    const admin = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'restore_admin', PGPASSWORD: password, PGDATABASE: 'postgres' };
    await run(join(config.postgresBin, 'psql.exe'), ['-X', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { env: admin, input: `CREATE ROLE scm_app LOGIN PASSWORD '${appPassword}';\nCREATE DATABASE "${database}" OWNER scm_app;\n` });
    await run(join(config.postgresBin, 'pg_restore.exe'), ['--exit-on-error', '--no-owner', '--no-privileges', '--role=scm_app', '-d', database, join(target, 'database.dump')], { env: admin });
    const restored = { ...config, trialRoot: target, releasePath: join(target, 'release'), dataDir: join(target, 'data'), configDir: join(target, 'config'), caddyDataDir: join(target, 'caddy-data'), caddyConfigDir: join(target, 'caddy-config'), toolsDir: join(target, 'tools'), servicesDir: join(target, 'services'), envPath: join(target, 'config/app.env'), postgresDataDir: pgData, postgresPort: port, database, ownerUser: 'restore_admin', ownerPassword: password, appUser: 'scm_app', appPassword, runtimeDir: pgRuntime, backupDir: join(target, 'backups'), apiPort: 3003, restoreOnly: true, workerEnabled: false, services: { api: 'SCM-Restore-Disabled-API', worker: 'SCM-Restore-Disabled-Worker' } };
    delete restored.configPath;
    const original = parseEnv(await readFile(restored.envPath, 'utf8'));
    const environment = { ...original, DATABASE_URL: `postgres://scm_app:${appPassword}@127.0.0.1:${port}/${database}`, DATA_DIR: restored.dataDir.replaceAll('\\', '/'), WEB_DIST_DIR: join(restored.releasePath, 'apps/web/dist').replaceAll('\\', '/'), LINGXING_REQUESTS_ENABLED: 'false', LINGXING_ENV_FILE: '', LINGXING_APP_ID: '', LINGXING_APP_SECRET: '', LINGXING_ACCESS_TOKEN: '', HOST: '127.0.0.1', PORT: '3003', BETTER_AUTH_URL: 'http://127.0.0.1:3003', WEB_ORIGIN: 'http://127.0.0.1:3003' };
    await writeFile(restored.envPath, Object.entries(environment).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
    await writeFile(join(target, 'runtime.json'), JSON.stringify(restored, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(pgRuntime, 'recovery-admin.env'), `PGPASSWORD=${password}\n`, { mode: 0o600 });
    const actual = await databaseSnapshot(restored, environment);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.snapshot)) throw new Error('Restored database records, audit, confirmations or export versions differ');
    const verified = await verifyIndexedFiles(restored, actual);
    await run(join(config.postgresBin, 'pg_ctl.exe'), ['-D', pgData, '-m', 'fast', '-w', 'stop']); databaseStarted = false;
    const report = { format: 'scm-trial-restore-report/v1', result: 'passed', backupBoundaryAt: manifest.boundaryAt, verifiedAt: new Date().toISOString(), releaseId: manifest.releaseId, tables: actual.tables.length, ...verified, rpoSecondsAtRestoreStart: Math.max(0, Math.round((started - Date.parse(manifest.boundaryAt)) / 1000)), rtoSeconds: Math.round((Date.now() - started) / 1000), postgresPort: port, workerStarted: false, lingxingRequestsEnabled: false, databaseLeftRunning: false, pending: ['operator-start-and-queue-recovery-drill', 'signed-business-batch', 'independent-backup-medium'] };
    await writeFile(join(target, 'restore-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } finally {
    if (databaseStarted) await run(join(config.postgresBin, 'pg_ctl.exe'), ['-D', pgData, '-m', 'fast', '-w', 'stop']);
  }
}
export async function verify(configPath) {
  const { config, environment } = await loadConfig(configPath);
  const manifest = await verifyReleaseDirectory(config.releasePath);
  const snapshot = await databaseSnapshot(config, environment);
  return { result: 'passed', releaseId: manifest.releaseId, checkedAt: new Date().toISOString(), tables: snapshot.tables.length, ...await verifyIndexedFiles(config, snapshot), externalBusinessRequests: 0 };
}
