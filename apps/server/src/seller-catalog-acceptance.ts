import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importPreviewInputSchema, sellerMappingSchema, type SellerMapping, type SellerMappingRevisionInput } from '@scm/contracts';
import { closeDatabase, pool } from './db/client.js';
import { readConfig } from './config.js';
import { createConfirmationHarness, technicalWorkbook } from './import-confirmation-acceptance.js';
import { syncSellerCatalog } from './modules/seller-mappings/catalog.js';

type Harness = Awaited<ReturnType<typeof createConfirmationHarness>>;
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const technicalSid = () => 1_000_000_000 + randomBytes(4).readUInt32BE() % 900_000_000;
export function manualRevision(mapping: SellerMapping, patch: Partial<SellerMappingRevisionInput> = {}): SellerMappingRevisionInput {
  return { operationId: randomUUID(), expectedVersion: mapping.version, sid: mapping.sid, name: mapping.name, country: mapping.country,
    marketplaceId: mapping.marketplaceId, wid: mapping.wid, aliases: mapping.aliases, status: mapping.status,
    reason: 'TECHNICAL CATALOG ACCEPTANCE', ...patch };
}
export async function catalogList(h: Harness, search = '') {
  const response = await h.request(`/seller-mappings?page=1&pageSize=100&search=${encodeURIComponent(search)}`); assert.equal(response.status, 200);
  const result = response.data as { items: unknown[]; total: number };
  return { ...result, items: result.items.map((item) => sellerMappingSchema.parse(item)) };
}
export async function createTechnicalCatalogSeller(h: Harness, label = 'manual') {
  const input = { operationId: randomUUID(), sid: technicalSid(), name: `T11-${h.runId}-${label}`, country: '美国' };
  const response = await h.request('/seller-mappings/manual', undefined, 'POST', input); assert([200, 201].includes(response.status));
  const mapping = sellerMappingSchema.parse((response.data as { mapping: unknown }).mapping); h.trackSeller(mapping.id);
  return { mapping, input, response };
}

async function run() {
  const h = await createConfirmationHarness({ catalogMode: null });
  const checks: Array<{ name: string; result: string; details?: Record<string, unknown> }> = [];
  let step = 'setup'; let failed = false; let cleaned = false;
  const check = async (name: string, action: () => Promise<Record<string, unknown> | void>) => {
    step = name; const details = await action(); checks.push({ name, result: 'passed', ...(details ? { details } : {}) }); console.log(`PASS ${name}`);
  };
  try {
    await h.setup();
    await check('default-lingxing-catalog-and-root-coordinated-readonly-sync-evidence', async () => {
      const settings = await h.catalog(); assert.equal(settings.mode, 'lingxing'); assert.equal(settings.readOnly, true); assert.equal(settings.configured, true);
      assert(settings.lastSyncedAt, 'Root must coordinate one real read-only sync before this verification; this suite never calls the remote API');
      const raw = (await pool.query('select * from seller_mapping order by sid')).rows;
      assert(raw.every((row) => row.lingxing_data && typeof row.lingxing_data.name === 'string' && typeof row.lingxing_data.country === 'string'));
      const list = await catalogList(h); const active = raw.filter((row) => row.lingxing_data.present);
      assert.equal(list.total, active.length);
      for (const item of list.items) {
        const source = raw.find((row) => row.id === item.id)!.lingxing_data;
        assert.equal(item.dataSource, 'lingxing'); assert.equal(item.name, source.name); assert.equal(item.country, source.country); assert.equal(item.identityLocked, true);
      }
      const evidence = (await pool.query('select c.source_file_id,f.sha256 from seller_catalog_settings c join file_index f on f.id=c.source_file_id')).rows;
      assert.equal(evidence.length, 1); assert.match(evidence[0].sha256, /^[a-f0-9]{64}$/);
      const audit = (await pool.query("select details from operation_audit where action='seller_catalog.sync' and target_id=$1 order by created_at desc limit 1", [evidence[0].source_file_id])).rows;
      assert.equal(audit.length, 1); assert.equal(audit[0].details.readOnly, 'true');
      const original = await h.upload(); const preview = await h.preview(original);
      assert.equal(original.latestRun!.counts.totalRows, 200); assert.equal(preview.preview.counts.new, 189); assert.equal(preview.preview.counts.error, 11);
      assert.equal(preview.preview.sellerCatalogMode, 'lingxing'); assert.equal((await h.catalog()).mode, 'lingxing');
      return { effectiveSellers: list.total, configured: true, remoteReadOnly: true, realSyncPerformedBy: 'root-coordination', externalRequestsMadeByThisSuite: 0, realOriginalRows: 200, validDemands: 189, locatedErrors: 11, originalPreviewMode: 'lingxing' };
    });
    await check('concurrent-sync-late-failure-replays-success-without-overwriting-last-error', async () => {
      const admin = h.users.get('admin')!;
      const input = { operationId: randomUUID(), expectedVersion: (await h.catalog()).version };
      const before = (await pool.query('select source_file_id,last_synced_at,last_error,updated_by,updated_at from seller_catalog_settings where id=$1', ['global'])).rows[0]!;
      const originals = (await pool.query('select id,sid,lingxing_data,source_observed_at,source_sha256,source_file_id,version,updated_at from seller_mapping order by id')).rows;
      assert.equal(originals.length, 24);
      let releaseFailure!: () => void; let enteredFailure!: () => void;
      const failureGate = new Promise<void>((done) => { releaseFailure = done; });
      const failureEntered = new Promise<void>((done) => { enteredFailure = done; });
      const delayed = syncSellerCatalog(input, admin.id, { querySellers: async () => {
        enteredFailure(); await failureGate; throw new Error('TECHNICAL delayed query failure; no external request');
      } }).then((result) => ({ result }), (error: unknown) => ({ error }));
      let technicalFileIds: string[] = [];
      try {
        await failureEntered;
        const successful = await syncSellerCatalog(input, admin.id, { querySellers: async () => ({
          payload: { code: 0, data: originals.map((row) => ({ sid: row.sid, name: row.lingxing_data.name, country: row.lingxing_data.country,
            marketplace_id: row.lingxing_data.marketplaceId, status: row.lingxing_data.status })) },
          metadata: { operation: 'listSellers', method: 'GET', path: '/erp/sc/data/seller/lists', requestedAt: new Date().toISOString(), elapsedMs: 0,
            attempt: 1, httpStatus: 200, businessCode: '0', readOnly: true },
        }) });
        assert.equal(successful.replayed, false); assert.equal(successful.total, 24);
        const successState = (await pool.query('select source_file_id,last_synced_at,last_error from seller_catalog_settings where id=$1', ['global'])).rows[0]!;
        assert.notEqual(successState.source_file_id, before.source_file_id);
        releaseFailure();
        const late = await delayed;
        if ('error' in late) throw late.error;
        assert.equal(late.result.replayed, true);
        assert.deepEqual({ ...late.result, replayed: false }, successful);
        assert.deepEqual((await pool.query('select source_file_id,last_synced_at,last_error from seller_catalog_settings where id=$1', ['global'])).rows[0], successState);
        assert.equal(successState.last_error, null);
        assert.equal(Number((await pool.query('select count(*) from seller_catalog_operation where operation_id=$1', [input.operationId])).rows[0].count), 1);
        assert.equal(Number((await pool.query("select count(*) from operation_audit where action='seller_catalog.sync' and details->>'operationId'=$1", [input.operationId])).rows[0].count), 1);
      } finally {
        releaseFailure(); await delayed;
        const files = (await pool.query<{ id: string; storage_key: string }>(`select f.id,f.storage_key from file_index f join operation_audit a on a.target_id=f.id
          where a.actor_user_id=$1 and a.action='seller_catalog.sync' and a.details->>'operationId'=$2`, [admin.id, input.operationId])).rows;
        technicalFileIds = files.map((file) => file.id);
        const restoreDatabase = async () => {
          const tx = await pool.connect();
          try {
            await tx.query('begin');
            await tx.query(`update seller_catalog_settings set source_file_id=$1,last_synced_at=$2,last_error=$3,updated_by=$4,updated_at=$5 where id='global'`,
              [before.source_file_id, before.last_synced_at, before.last_error, before.updated_by, before.updated_at]);
            for (const row of originals) await tx.query('update seller_mapping set lingxing_data=$2,source_observed_at=$3,source_sha256=$4,source_file_id=$5,version=$6,updated_at=$7 where id=$1',
              [row.id, row.lingxing_data, row.source_observed_at, row.source_sha256, row.source_file_id, row.version, row.updated_at]);
            await tx.query('delete from seller_catalog_operation where operation_id=$1', [input.operationId]);
            await tx.query("delete from operation_audit where actor_user_id=$1 and action='seller_catalog.sync' and details->>'operationId'=$2", [admin.id, input.operationId]);
            await tx.query('delete from file_index where id=any($1::uuid[])', [technicalFileIds]);
            await tx.query('commit');
          } catch (error) { await tx.query('rollback'); throw error; } finally { tx.release(); }
        };
        await restoreDatabase();
        const dataDir = readConfig().dataDir;
        for (const file of files) {
          const target = resolve(dataDir, file.storage_key); assert(target.startsWith(resolve(dataDir) + sep));
          await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      assert.deepEqual((await pool.query('select source_file_id,last_synced_at,last_error,updated_by,updated_at from seller_catalog_settings where id=$1', ['global'])).rows[0], before);
      assert.deepEqual((await pool.query('select id,sid,lingxing_data,source_observed_at,source_sha256,source_file_id,version,updated_at from seller_mapping order by id')).rows, originals);
      assert.equal(Number((await pool.query('select count(*) from file_index where id=any($1::uuid[])', [technicalFileIds])).rows[0].count), 0);
      await h.unchangedOriginalAndMappings();
      return { concurrentAssertions: 9, restorationAssertions: 3, externalRequests: 0, successfulPublications: 1, lateFailureReplayed: true,
        originalSourceAndLastErrorRestored: true, originalSellerSnapshotsRestored: true, technicalArchivesRemoved: technicalFileIds.length };
    });
    await check('catalog-mode-operation-replay-and-stale-settings-version', async () => {
      const current = await h.catalog(); const input = { operationId: randomUUID(), expectedVersion: current.version, mode: 'manual' };
      const changed = await h.request('/seller-mappings/catalog-settings', undefined, 'POST', input); assert.equal(changed.status, 200);
      assert.equal((await h.catalog()).mode, 'manual');
      const replay = await h.request('/seller-mappings/catalog-settings', undefined, 'POST', input); assert.equal(replay.status, 200); assert.equal((replay.data as { replayed: boolean }).replayed, true);
      assert.equal((await h.request('/seller-mappings/catalog-settings', undefined, 'POST', { ...input, mode: 'lingxing' })).status, 409);
      assert.equal((await h.request('/seller-mappings/catalog-settings', undefined, 'POST', { ...input, operationId: randomUUID(), mode: 'lingxing' })).status, 409);
      await h.unchangedOriginalAndMappings();
    });
    let mapping!: SellerMapping;
    await check('manual-create-replay-conflicting-sid-and-unreferenced-sid-edit', async () => {
      const created = await createTechnicalCatalogSeller(h); mapping = created.mapping;
      assert.equal(mapping.dataSource, 'manual'); assert.equal(mapping.identityLocked, false); assert.equal(mapping.manualEnabled, true);
      const replay = await h.request('/seller-mappings/manual', undefined, 'POST', created.input); assert([200, 201].includes(replay.status));
      assert.equal((replay.data as { replayed: boolean }).replayed, true);
      assert.equal((await h.request('/seller-mappings/manual', undefined, 'POST', { ...created.input, operationId: randomUUID(), name: `${mapping.name}-duplicate` })).status, 409);
      assert.equal((await h.request('/seller-mappings/manual', undefined, 'POST', { ...created.input, operationId: randomUUID(), sid: 0 })).status, 422);
      const sid = technicalSid(); const revised = await h.request(`/seller-mappings/${mapping.id}/revise`, undefined, 'POST', manualRevision(mapping, { sid, name: `${mapping.name}-edited` })); assert.equal(revised.status, 200);
      mapping = sellerMappingSchema.parse((revised.data as { mapping: unknown }).mapping); assert.equal(mapping.sid, sid); assert.equal(mapping.version, 2);
      const list = await catalogList(h, String(sid)); assert(list.items.some((item) => item.id === mapping.id));
    });
    await check('mode-switch-keeps-manual-content-and-real-seller-both-source-snapshots', async () => {
      const before = (await pool.query('select * from seller_mapping where id=$1', [mapping.id])).rows[0];
      await h.switchCatalog('lingxing'); assert(!(await catalogList(h, mapping.name)).items.some((item) => item.id === mapping.id));
      await h.switchCatalog('manual'); const restored = (await catalogList(h, String(mapping.sid))).items.find((item) => item.id === mapping.id)!;
      assert.equal(restored.name, mapping.name); assert.equal(restored.country, mapping.country); assert.equal(restored.sid, mapping.sid);
      assert.deepEqual((await pool.query('select * from seller_mapping where id=$1', [mapping.id])).rows[0], before);
      await h.unchangedOriginalAndMappings();
    });
    let item!: Awaited<ReturnType<Harness['upload']>>;
    await check('preview-binds-catalog-settings-and-catalog-version', async () => {
      item = await h.upload(technicalWorkbook([{ shop: mapping.name, fba: `FBACATALOG${h.runId.replaceAll('-', '').toUpperCase()}`, country: '美国' }]), 'technical-catalog-version.xlsx');
      const context = await h.context(item.id); const input = importPreviewInputSchema.parse({ expectedVersion: item.version, parseRunId: item.latestRun!.id,
        sellerSelections: await h.selections(item.id), expectedCatalogSettingsVersion: context.catalog.version, expectedCatalogVersion: context.catalog.catalogVersion });
      const preview = await h.preview(item); assert.equal(preview.preview.sellerCatalogMode, 'manual'); assert.equal(preview.preview.sellerCatalogSettingsVersion, context.catalog.version); assert.equal(preview.preview.sellerCatalogVersion, context.catalog.catalogVersion);
      await h.switchCatalog('lingxing');
      assert.equal((await h.request(`/imports/${item.id}/preview`, undefined, 'POST', input)).status, 409);
      assert.equal((await h.commit(item, preview)).status, 409);
      await h.switchCatalog('manual');
      const current = await h.context(item.id); const catalogInput = { ...input, expectedCatalogSettingsVersion: current.catalog.version, expectedCatalogVersion: current.catalog.catalogVersion };
      const fresh = await h.preview(item); await createTechnicalCatalogSeller(h, 'directory-change');
      assert.equal((await h.request(`/imports/${item.id}/preview`, undefined, 'POST', catalogInput)).status, 409);
      assert.equal((await h.commit(item, fresh)).status, 409);
      assert.equal(Number((await pool.query('select count(*) from import_commit where import_id=$1', [item.id])).rows[0].count), 0);
    });
    await check('manual-sid-lock-after-demand-binding-and-remote-identity-lock', async () => {
      const preview = await h.preview(item); const result = await h.commit(item, preview); assert.equal(result.status, 200);
      const current = (await catalogList(h, String(mapping.sid))).items.find((seller) => seller.id === mapping.id)!; assert.equal(current.identityLocked, true);
      assert.equal((await h.request(`/seller-mappings/${mapping.id}/revise`, undefined, 'POST', manualRevision(current, { sid: technicalSid() }))).status, 409);
      const remote = (await createTechnicalCatalogSeller(h, 'remote-lock-fixture')).mapping;
      await pool.query('update seller_mapping set lingxing_data=$2 where id=$1', [remote.id, JSON.stringify({ name: `REMOTE-${h.runId}`, country: '美国', marketplaceId: null, status: '1', present: true, observedAt: new Date().toISOString() })]);
      assert.equal((await h.request(`/seller-mappings/${remote.id}/revise`, undefined, 'POST', manualRevision(remote, { sid: technicalSid() }))).status, 409);
      assert.equal((await pool.query('select sid from seller_mapping where id=$1', [remote.id])).rows[0].sid, remote.sid);
      const rawRemote = (await pool.query('select lingxing_data from seller_mapping where id=$1', [remote.id])).rows[0].lingxing_data;
      await h.switchCatalog('lingxing'); const effective = (await catalogList(h, `REMOTE-${h.runId}`)).items.find((seller) => seller.id === remote.id)!;
      assert.equal(effective.name, rawRemote.name); assert.equal(effective.country, rawRemote.country); assert.equal(effective.lingxingStatus, '1');
      await h.switchCatalog('manual'); assert.equal((await catalogList(h, remote.name)).items.find((seller) => seller.id === remote.id)!.name, remote.name);
    });
    await check('real-original-real-seller-snapshots-and-global-aliases-preserved', h.unchangedOriginalAndMappings);
  } catch (error) {
    failed = true; checks.push({ name: step, result: 'failed', details: { message: error instanceof Error ? error.message : 'CHECK_FAILED' } });
    console.error(`Seller catalog acceptance failed: ${step}`, error instanceof Error ? error.message : 'CHECK_FAILED');
  } finally {
    try { await h.cleanup(); cleaned = true; } catch (error) { failed = true; checks.push({ name: 'technical-fixture-cleanup-and-original-mode-restore', result: 'failed', details: { message: error instanceof Error ? error.message : 'CLEANUP_FAILED' } }); }
    const index = process.argv.indexOf('--report'); const target = index >= 0 ? resolve(process.argv[index + 1]!) : resolve(projectRoot, '.local/t11/seller-catalog-integration.json');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify({ kind: 'real-postgresql-seller-catalog', runId: h.runId, timezone: 'Asia/Shanghai', createdAt: new Date().toISOString(), result: failed ? 'failed' : 'passed', checks, technicalFixturesRemoved: cleaned,
      realEvidence: 'Read current effective catalog and previously root-coordinated real read-only synchronization evidence', technicalEvidence: 'Temporary manual sellers, identity locks, source switching and stale import snapshots', externalRequestsMadeByThisSuite: 0 }, null, 2)}\n`);
    await closeDatabase(); console.log(`Seller catalog integration ${failed ? 'FAILED' : 'PASSED'} (${checks.filter((entry) => entry.result === 'passed').length} checks)`); if (failed) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
