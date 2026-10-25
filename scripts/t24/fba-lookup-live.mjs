import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Explicit execution prevents accidentally starting live API work while preparing
// or syntax-checking this acceptance script. No existing account file is used.
if (!process.argv.includes('--run')) {
  console.log('Prepared. Run with --run only after coordinated API/Worker readiness.');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = resolve(root, 'apps/server');
const requireServer = createRequire(resolve(server, 'package.json'));
for (const [key, value] of Object.entries(requireServer('dotenv').parse(await readFile(resolve(server, '.env'))))) {
  if (process.env[key] === undefined) process.env[key] = value;
}
const { auth } = await import(pathToFileURL(resolve(server, 'dist/auth.js')));
const { readConfig } = await import(pathToFileURL(resolve(server, 'dist/config.js')));
const { pool, closeDatabase } = await import(pathToFileURL(resolve(server, 'dist/db/client.js')));
const config = readConfig();
const baseURL = new URL(process.env.FBA_LOOKUP_BASE_URL || 'http://localhost:3001').origin;
const outFlag = process.argv.indexOf('--out');
const out = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : resolve(root, '.local/t24/fba-lookup-live.json'));
const runId = randomUUID();
const digest = (value) => createHash('sha256').update(value).digest('hex');
class VerificationError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code) => { if (!condition) throw new VerificationError(code); };
let stage = 'preflight', actorId = null, cookie = '', lookupId = null, actorDisabled = false;
const report = { kind: 'real-multi-shop-multi-fba-metadata-lookup', runId, result: 'failed', checks: [], technicalActorDisabled: false,
  externalWrites: 0, productsOrBoxesRequested: false, businessSignoff: 'pending' };
const record = (name, details = {}) => report.checks.push({ name, result: 'passed', ...details });
async function request(path, method = 'GET', body) {
  const response = await fetch(`${baseURL}/api/v1${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Origin: config.WEB_ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json().catch(() => null),
    cookie: response.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ') };
}
async function catalogSnapshot() {
  const settings = (await pool.query('select * from seller_catalog_settings order by id')).rows;
  const sellers = (await pool.query('select * from seller_mapping order by id')).rows;
  const aliases = (await pool.query('select * from seller_alias order by normalized_alias')).rows;
  check(settings.length === 1, 'CATALOG_NOT_INITIALIZED');
  return { settings: settings[0], sellers, digest: digest(JSON.stringify({ settings, sellers, aliases })) };
}
async function chooseSamples(catalog) {
  const enabled = new Set(catalog.sellers.filter((seller) => seller.status !== 'disabled' && (catalog.settings.mode === 'manual' ? seller.manual_enabled
    : seller.lingxing_data?.present && seller.lingxing_data.status === '1')).map((seller) => seller.sid));
  const sources = JSON.parse(process.env.FBA_LOOKUP_SOURCE_DIRS || '[]');
  check(Array.isArray(sources) && sources.length > 0 && sources.every((directory) => typeof directory === 'string' && directory.trim()), 'SET_PRIVATE_FBA_LOOKUP_SOURCE_DIRS_JSON_ARRAY');
  const unique = new Map();
  for (const directory of sources) {
    const path = resolve(root, directory);
    for (const name of (await readdir(path)).filter((entry) => entry.endsWith('-list-p1.json')).sort()) {
      const evidence = JSON.parse(await readFile(resolve(path, name), 'utf8'));
      if (!evidence.ok || String(evidence.response?.code) !== '0') continue;
      for (const row of evidence.response.data?.list ?? []) {
        if (!enabled.has(Number(row.sid)) || !/^FBA[A-Z0-9]+$/.test(row.shipment_id) || !/^\d{4}-\d{2}-\d{2}/.test(row.gmt_create)) continue;
        unique.set(`${row.sid}:${row.shipment_id}`, { sid: Number(row.sid), fba: row.shipment_id, createdDate: row.gmt_create.slice(0, 10) });
      }
    }
  }
  const selected = [], selectedShops = new Set();
  for (const sample of unique.values()) if (!selectedShops.has(sample.sid) && selected.length < 3) { selected.push(sample); selectedShops.add(sample.sid); }
  for (const sample of unique.values()) if (selected.length < 3 && !selected.some((item) => item.fba === sample.fba)) selected.push(sample);
  check(selected.length >= 2 && selectedShops.size >= 2, 'INSUFFICIENT_VERIFIED_MULTI_SHOP_SAMPLES');
  return { selected, availableShops: enabled.size };
}

try {
  check(new URL(config.DATABASE_URL).pathname === '/scm_automation_dev', 'DEDICATED_DEVELOPMENT_DATABASE_REQUIRED');
  if (!config.LINGXING_REQUESTS_ENABLED) throw new VerificationError('LINGXING_REQUESTS_DISABLED');
  check((await request('/health')).status === 200, 'API_NOT_READY');
  const before = await catalogSnapshot();
  const { selected, availableShops } = await chooseSamples(before);
  const dates = selected.map((sample) => sample.createdDate).sort();
  report.sampleCount = selected.length;
  report.targetShopCount = new Set(selected.map((sample) => sample.sid)).size;
  report.currentSourceShopCount = availableShops;
  report.startDate = dates[0]; report.endDate = dates.at(-1);
  record('read-existing-verified-samples-without-changing-current-catalog');

  stage = 'technical-authentication';
  const email = `t24-fba-${runId}@acceptance.invalid`, password = randomBytes(32).toString('base64url');
  actorId = (await auth.api.createUser({ body: { email, password, name: 'T24 technical FBA lookup verification', role: 'admin' } })).user.id;
  const signedIn = await request('/auth/sign-in/email', 'POST', { email, password });
  check(signedIn.status === 200 && signedIn.cookie, 'TECHNICAL_SIGN_IN_FAILED'); cookie = signedIn.cookie;
  const settings = await request('/seller-mappings/catalog-settings');
  check(settings.status === 200, 'CATALOG_SETTINGS_NOT_READABLE');
  check(settings.data.settings.version === before.settings.version && settings.data.settings.catalogVersion === before.settings.catalog_version && settings.data.settings.mode === before.settings.mode,
    'CATALOG_CHANGED_BEFORE_QUERY');
  const lookupInput = { operationId: randomUUID(), fbas: selected.map((sample) => sample.fba), startDate: dates[0], endDate: dates.at(-1),
    expectedCatalogSettingsVersion: settings.data.settings.version, expectedCatalogVersion: settings.data.settings.catalogVersion };

  stage = 'live-metadata-query';
  const accepted = await request('/imports/fba-lookups', 'POST', lookupInput);
  if (accepted.status === 503 && accepted.data?.error?.code === 'LINGXING_REQUESTS_DISABLED') throw new VerificationError('LINGXING_REQUESTS_DISABLED');
  check(accepted.status === 202 && accepted.data?.id, 'LOOKUP_SUBMISSION_FAILED'); lookupId = accepted.data.id;
  const deadline = Date.now() + 180_000;
  let result = accepted.data;
  while (!['completed', 'failed'].includes(result.status) && Date.now() < deadline) {
    await delay(500);
    const polled = await request(`/imports/fba-lookups/${lookupId}`); check(polled.status === 200, 'LOOKUP_POLL_FAILED'); result = polled.data;
  }
  if (result.status === 'failed' && result.errorCode === 'LINGXING_REQUESTS_DISABLED') throw new VerificationError('LINGXING_REQUESTS_DISABLED');
  check(result.status === 'completed', 'LOOKUP_DID_NOT_COMPLETE');
  check(result.rows.length === selected.length, 'LOOKUP_RESULT_COUNT_MISMATCH');
  for (const expected of selected) {
    const row = result.rows.find((item) => item.fba === expected.fba);
    check(row?.status === 'unique' && row.candidates.length === 1 && row.candidates[0].sid === expected.sid, 'LOOKUP_SHOP_IDENTITY_MISMATCH');
  }
  report.uniqueResults = result.rows.filter((row) => row.status === 'unique').length;
  report.withDestinationAddress = result.rows.filter((row) => row.candidates[0]?.destinationAddress).length;
  report.withShipmentCreatedAt = result.rows.filter((row) => row.candidates[0]?.shipmentCreatedAt).length;
  record('real-multiple-fba-query-identifies-the-existing-verified-shops');

  stage = 'evidence-and-idempotency';
  const run = (await pool.query('select requests_used,status,request_budget,max_pages from fba_lookup_run where id=$1 and created_by=$2', [lookupId, actorId])).rows[0];
  check(run?.status === 'completed' && run.requests_used > 0, 'LOOKUP_LEDGER_MISSING');
  const replayed = await request('/imports/fba-lookups', 'POST', { ...lookupInput, fbas: [...lookupInput.fbas].reverse().map((fba) => ` ${fba.toLowerCase()} `) });
  check(replayed.status === 202 && replayed.data.id === lookupId && replayed.data.status === 'completed', 'LOOKUP_REPLAY_FAILED');
  const replayLedger = (await pool.query('select requests_used from fba_lookup_run where id=$1 and created_by=$2', [lookupId, actorId])).rows[0];
  check(replayLedger.requests_used === run.requests_used, 'LOOKUP_REPLAY_SENT_NEW_REQUEST');
  report.businessRequests = run.requests_used; report.applicationRequestBudget = run.request_budget;
  record('same-operation-replay-uses-no-additional-business-requests');

  const snapshots = (await pool.query('select f.storage_key,f.sha256 from fba_lookup_snapshot s join file_index f on f.id=s.file_id where s.run_id=$1 and f.created_by=$2 order by s.page,s.attempt', [lookupId, actorId])).rows;
  check(snapshots.length > 0, 'LOOKUP_METADATA_SNAPSHOT_MISSING');
  for (const snapshot of snapshots) {
    const path = resolve(config.dataDir, snapshot.storage_key), suffix = relative(config.dataDir, path);
    check(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'SNAPSHOT_PATH_INVALID');
    const bytes = await readFile(path); check(digest(bytes) === snapshot.sha256, 'SNAPSHOT_HASH_MISMATCH');
    const evidence = JSON.parse(bytes.toString('utf8'));
    check(evidence.schemaVersion === 'fba-lookup-metadata-v1' && evidence.metadata.operation === 'listShipments', 'SNAPSHOT_METADATA_FORMAT_INVALID');
    check(!/"(?:item_list|shipmentPackingList|productList|access_token|appSecret|sign)"\s*:/.test(bytes.toString('utf8')), 'UNNEEDED_PRODUCTS_OR_CREDENTIALS_ARCHIVED');
  }
  report.metadataSnapshotCount = snapshots.length; report.snapshotSha256 = snapshots.map((snapshot) => snapshot.sha256);
  report.lookupId = lookupId;
  record('immutable-metadata-snapshots-verified-without-products-boxes-or-credentials');
  const sideEffects = (await pool.query(`select
    (select count(*)::int from source_import where created_by=$1) as imports,
    (select count(*)::int from demand_revision where created_by=$1) as demands,
    (select count(*)::int from shipment_revision where created_by=$1) as shipments,
    (select count(*)::int from sub_batch where created_by=$1) as groups`, [actorId])).rows[0];
  check(Object.values(sideEffects).every((count) => count === 0), 'LOOKUP_CREATED_BUSINESS_RECORDS');
  check((await catalogSnapshot()).digest === before.digest, 'CATALOG_MUTATED_DURING_VERIFICATION');
  record('current-catalog-unchanged-and-no-imports-demands-groups-or-shipment-revisions-created');
  report.result = 'passed';
} catch (error) {
  report.result = error instanceof VerificationError && error.code === 'LINGXING_REQUESTS_DISABLED' ? 'blocked' : 'failed';
  report.failure = { stage, code: error instanceof VerificationError ? error.code : 'LIVE_VERIFICATION_FAILED' };
} finally {
  if (actorId) {
    try {
      // Retain the observed lookup and immutable snapshots as controlled evidence.
      // Only our temporary actor is disabled; remove its credentials and sessions.
      await pool.query('update "user" set banned=true,ban_reason=$2 where id=$1', [actorId, 'T24 technical FBA lookup verification completed']);
      await pool.query('delete from session where user_id=$1', [actorId]);
      await pool.query('delete from account where user_id=$1', [actorId]);
      actorDisabled = true;
    } catch { report.result = 'failed'; report.cleanupError = 'TECHNICAL_ACTOR_CLEANUP_FAILED'; }
  }
  report.technicalActorDisabled = actorDisabled;
  report.completedAt = new Date().toISOString();
  await mkdir(dirname(out), { recursive: true }); await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  await closeDatabase();
  console.log(JSON.stringify({ result: report.result, sampleCount: report.sampleCount ?? 0, targetShopCount: report.targetShopCount ?? 0,
    businessRequests: report.businessRequests ?? 0, technicalActorDisabled: actorDisabled, failure: report.failure ?? null }));
  if (report.result === 'failed') process.exitCode = 1;
}
