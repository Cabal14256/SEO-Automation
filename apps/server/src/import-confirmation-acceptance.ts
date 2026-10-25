import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import {
  demandDetailSchema, importAcceptedSchema, importCommitHistorySchema, importCommitResultSchema,
  importConfirmationContextSchema, importPreviewResponseSchema, importRowsResponseSchema, sellerCatalogSettingsSchema, sourceImportSchema,
  type ImportCommitInput, type ImportPreviewResponse, type ImportSellerSelection, type ImportSourceLocation, type SellerCatalogSettings, type SourceImport,
} from '@scm/contracts';
import { auth } from './auth.js';
import { readConfig } from './config.js';
import { closeDatabase, pool } from './db/client.js';
import { acceptanceSellerMatches, readAcceptanceFixture, type AcceptanceFixture } from './acceptance-fixture.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
type CommitError = { error: { details: { unknownItemIds?: string[]; missingChangedItemIds?: string[]; items?: Array<{ sources: ImportSourceLocation[] }>; sources?: ImportSourceLocation[]; currentDemandVersion?: number } } };
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function waitFor<T>(action: () => Promise<T | null>, message: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await action(); if (result !== null) return result; await delay(200); }
  throw new Error(message);
}
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
export type TechnicalRow = { shop: string; fba: string; quantity?: string; country?: string; channel?: string; fc?: string; date?: string; batch?: string; notes?: string };
// These workbooks are explicitly technical fixtures, never business increment evidence.
export function technicalWorkbook(rows: TechnicalRow[], sheetName = '需求导入 ') {
  const headers = ['店铺', '渠道', '国家', '目的FC', 'FBA货件号', '参考数量', '业务日期', '子批次名称', '备注'];
  const cells = (values: string[], number: number) => `<row r="${number}">${values.map((value, index) => `<c r="${String.fromCharCode(65 + index)}${number}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join('')}</row>`;
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells(headers, 1)}${rows.map((row, index) => cells([row.shop, row.channel ?? '技术渠道', row.country ?? '美国', row.fc ?? 'IND9', row.fba, row.quantity ?? '10', row.date ?? '2026-01-01', row.batch ?? '技术子批次', row.notes ?? 'TECHNICAL FIXTURE'], index + 2)).join('')}</sheetData></worksheet>`),
  }));
}

export async function createConfirmationHarness(options: { catalogMode?: SellerCatalogSettings['mode'] | null; fixture?: AcceptanceFixture } = {}) {
  const config = readConfig();
  assert.equal(new URL(config.DATABASE_URL).pathname, '/scm_automation_dev', 'Use the dedicated development database');
  const baseURL = process.env.IMPORT_BASE_URL || new URL(config.BETTER_AUTH_URL).origin;
  const runId = randomUUID();
  const fixture = options.fixture ?? await readAcceptanceFixture(false);
  const sourcePath = fixture?.sourceFile;
  const sourceBytes = sourcePath ? await readFile(sourcePath) : undefined;
  if (sourceBytes) assert.equal(digest(sourceBytes), fixture!.sourceSha256, 'The configured original must remain unchanged');
  function originalBytes() {
    assert(sourceBytes, 'Set IMPORT_ACCEPTANCE_CONFIG before uploading a business acceptance original');
    return sourceBytes;
  }
  const realSellerRows = (await pool.query('select * from seller_mapping order by id')).rows;
  if (fixture) assert.equal(realSellerRows.length, fixture.counts.sellerCandidates, 'The configured acceptance seller count must match');
  assert(realSellerRows.every((row) => row.status === 'candidate'), 'Real seller candidates must remain unapproved');
  const sellerDigest = digest(JSON.stringify(realSellerRows));
  const realAliases = (await pool.query('select * from seller_alias order by normalized_alias')).rows;
  assert.equal(realAliases.length, 0, 'Per-import confirmation must not require or introduce global aliases');
  const aliasDigest = digest(JSON.stringify(realAliases));
  const accountIds: string[] = [];
  const sellerIds: string[] = [];
  let originalCatalogMode: SellerCatalogSettings['mode'] | null = null;
  let originalCatalogSourceFileId: string | null = null;
  const users = new Map<string, { id: string; email: string; password: string; cookie: string }>();
  async function request(path: string, cookie = users.get('admin')?.cookie || '', method = 'GET', body?: unknown) {
    const form = body instanceof FormData;
    const response = await fetch(`${baseURL}/api/v1${path}`, { method,
      headers: { Origin: config.WEB_ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, data, cookie: response.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ') };
  }
  async function setup() {
    assert.equal((await request('/health', '')).status, 200, 'Start the coordinated API and Worker before acceptance');
    for (const name of ['admin', 'actor']) {
      const email = `t11-${runId}-${name}@acceptance.invalid`;
      const password = randomBytes(32).toString('base64url');
      const result = await auth.api.createUser({ body: { email, password, name: `T11 technical ${name}`, role: 'admin' } });
      accountIds.push(result.user.id);
      const login = await request('/auth/sign-in/email', '', 'POST', { email, password });
      assert.equal(login.status, 200); assert(login.cookie);
      users.set(name, { id: result.user.id, email, password, cookie: login.cookie });
    }
    const initial = await catalog(); originalCatalogMode = initial.mode;
    originalCatalogSourceFileId = (await pool.query<{ source_file_id: string | null }>('select source_file_id from seller_catalog_settings')).rows[0]!.source_file_id;
    if (options.catalogMode !== null && initial.mode !== (options.catalogMode ?? 'manual')) await switchCatalog(options.catalogMode ?? 'manual');
  }
  async function catalog() {
    const response = await request('/seller-mappings/catalog-settings'); assert.equal(response.status, 200);
    return sellerCatalogSettingsSchema.parse((response.data as { settings: unknown }).settings);
  }
  async function switchCatalog(mode: SellerCatalogSettings['mode']) {
    const current = await catalog();
    const response = await request('/seller-mappings/catalog-settings', undefined, 'POST', { operationId: randomUUID(), expectedVersion: current.version, mode });
    assert.equal(response.status, 200);
    return sellerCatalogSettingsSchema.parse((response.data as { settings: unknown }).settings);
  }
  function trackSeller(id: string) {
    if (!sellerIds.includes(id)) sellerIds.push(id);
  }
  async function seller() {
    const id = randomUUID();
    const sid = 1_000_000_000 + randomBytes(4).readUInt32BE() % 900_000_000;
    const name = `T11-${runId}-${sellerIds.length}`;
    await pool.query(`insert into seller_mapping (id,sid,name,country,status,version,source_observed_at,source_sha256) values ($1,$2,$3,'美国','candidate',1,now(),$4)`, [id, sid, name, digest(runId)]);
    trackSeller(id);
    return { id, sid, name, country: '美国', version: 1 };
  }
  function uploadBody(bytes = originalBytes(), name = fixture?.originalName ?? 'acceptance-source.xlsx', operationId = randomUUID()) {
    const body = new FormData(); body.set('operationId', operationId);
    body.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
    return body;
  }
  async function get(id: string) {
    const response = await request(`/imports/${id}`); assert.equal(response.status, 200);
    return sourceImportSchema.parse((response.data as { import: unknown }).import);
  }
  async function settle(id: string) {
    return waitFor(async () => { const item = await get(id); return item.latestRun && ['completed', 'failed'].includes(item.latestRun.status) ? item : null; }, 'The real Worker did not finish parsing');
  }
  async function upload(bytes = originalBytes(), name = fixture?.originalName ?? 'acceptance-source.xlsx', cookie?: string) {
    const response = await request('/imports', cookie, 'POST', uploadBody(bytes, name)); assert.equal(response.status, 202);
    const accepted = importAcceptedSchema.parse(response.data);
    const detail = await settle(accepted.import.id);
    assert.equal(detail.latestRun!.status, 'completed'); assert.equal(detail.status, 'preview_ready');
    return detail;
  }
  async function context(id: string) {
    const response = await request(`/imports/${id}/confirmation`); assert.equal(response.status, 200);
    return importConfirmationContextSchema.parse(response.data);
  }
  async function selections(id: string): Promise<ImportSellerSelection[]> {
    const current = await context(id);
    return current.shops.map((shop) => {
      // Source aliases are explicit private fixture choices and create no global alias.
      const observedOriginal = realSellerRows.filter((seller) => seller.manual_enabled && acceptanceSellerMatches(shop.sourceShop, seller, fixture?.sellerSelections ?? []));
      const observedIds = new Set(observedOriginal.map((seller) => seller.id));
      const matches = current.sellers.filter((seller) => seller.status !== 'disabled' && (current.catalog.mode === 'lingxing' && observedIds.size
        ? observedIds.has(seller.id)
        : acceptanceSellerMatches(shop.sourceShop, seller, fixture?.sellerSelections ?? [])));
      assert.equal(matches.length, 1, `Explicit fixture mapping requires one exact seller for ${shop.sourceShop}`);
      if (!shop.sourceShop.startsWith(`T11-${runId}-`)) assert(shop.countries.every((country) => country === matches[0]!.country), `The explicit fixture seller must match the source country for ${shop.sourceShop}`);
      return { sourceShop: shop.sourceShop, sellerMappingId: matches[0]!.id, expectedVersion: matches[0]!.version, confirmed: true as const };
    });
  }
  async function preview(item: SourceImport, sellerSelections?: ImportSellerSelection[], baselineImportId?: string, cookie?: string): Promise<ImportPreviewResponse> {
    const currentCatalog = (await context(item.id)).catalog;
    const response = await request(`/imports/${item.id}/preview`, cookie, 'POST', { expectedVersion: item.version, parseRunId: item.latestRun!.id,
      sellerSelections: sellerSelections ?? await selections(item.id), expectedCatalogSettingsVersion: currentCatalog.version, expectedCatalogVersion: currentCatalog.catalogVersion,
      ...(baselineImportId ? { baselineImportId } : {}) });
    assert.equal(response.status, 201);
    return importPreviewResponseSchema.parse(response.data);
  }
  async function allItems(item: SourceImport, value: ImportPreviewResponse) {
    const items = [];
    for (let page = 1; ; page++) {
      const response = await request(`/imports/${item.id}/previews/${value.preview.id}?page=${page}&pageSize=100`); assert.equal(response.status, 200);
      const data = importPreviewResponseSchema.parse(response.data); items.push(...data.items);
      if (items.length >= data.total) break;
    }
    return items;
  }
  async function commit(item: SourceImport, value: ImportPreviewResponse, ids = value.preview.selectableItemIds, options: Partial<ImportCommitInput> = {}, cookie?: string) {
    const input = { operationId: randomUUID(), previewId: value.preview.id, selectedItemIds: ids, confirmedChangedItemIds: [], ...options };
    const response = await request(`/imports/${item.id}/commit`, cookie, 'POST', input);
    return { ...response, input, result: response.status === 200 ? importCommitResultSchema.parse(response.data) : null };
  }
  async function unchangedOriginalAndMappings() {
    if (sourcePath) assert.equal(digest(await readFile(sourcePath)), fixture!.sourceSha256);
    assert.equal(digest(JSON.stringify((await pool.query('select * from seller_mapping where not (id = any($1::uuid[])) order by id', [sellerIds])).rows)), sellerDigest);
    assert.equal(digest(JSON.stringify((await pool.query('select * from seller_alias order by normalized_alias')).rows)), aliasDigest);
  }
  async function cleanup() {
    if (!accountIds.length) return;
    if (originalCatalogMode !== null && users.has('admin') && (await catalog()).mode !== originalCatalogMode) await switchCatalog(originalCatalogMode);
    if (originalCatalogMode !== null) assert.equal((await pool.query<{ source_file_id: string | null }>('select source_file_id from seller_catalog_settings')).rows[0]!.source_file_id, originalCatalogSourceFileId, 'Acceptance must preserve the catalog source file index');
    const files = (await pool.query<{ storage_key: string }>('select storage_key from file_index where created_by = any($1::text[])', [accountIds])).rows;
    const tx = await pool.connect();
    try {
      await tx.query('begin');
      // Never remove another actor's business records, including records linked concurrently.
      const ownedDemandIds = (await tx.query<{ demand_id: string }>(`select distinct demand_id from demand_revision where created_by = any($1::text[])`, [accountIds])).rows.map((row) => row.demand_id);
      const foreign = await tx.query(`select demand_id from demand_revision where demand_id = any($1::uuid[]) and not(created_by = any($2::text[])) union select demand_id from demand_source where demand_id = any($1::uuid[]) and not(created_by = any($2::text[]))`, [ownedDemandIds, accountIds]);
      assert.equal(foreign.rowCount, 0, 'Fixture demands received foreign records; preserve them and stop cleanup');
      await tx.query('delete from import_commit where actor_user_id = any($1::text[])', [accountIds]);
      await tx.query('delete from demand_source where created_by = any($1::text[])', [accountIds]);
      await tx.query('delete from demand_revision where demand_id = any($1::uuid[])', [ownedDemandIds]);
      await tx.query('delete from demand where id = any($1::uuid[])', [ownedDemandIds]);
      await tx.query('delete from import_preview where created_by = any($1::text[])', [accountIds]);
      await tx.query('delete from import_operation where actor_user_id = any($1::text[])', [accountIds]);
      await tx.query('delete from source_import_row where parse_run_id in (select id from import_parse_run where created_by = any($1::text[]))', [accountIds]);
      await tx.query('update source_import set latest_run_id = null where created_by = any($1::text[])', [accountIds]);
      await tx.query('delete from import_parse_run where created_by = any($1::text[])', [accountIds]);
      await tx.query('delete from seller_catalog_operation where actor_user_id = any($1::text[])', [accountIds]);
      await tx.query('delete from seller_mapping_revision where actor_user_id = any($1::text[])', [accountIds]);
      await tx.query('delete from seller_alias where seller_mapping_id = any($1::uuid[])', [sellerIds]);
      await tx.query('delete from operation_audit where actor_user_id = any($1::text[])', [accountIds]);
      await tx.query('delete from source_import where created_by = any($1::text[])', [accountIds]);
      await tx.query('delete from file_index where created_by = any($1::text[])', [accountIds]);
      await tx.query('delete from seller_mapping where id = any($1::uuid[])', [sellerIds]);
      await tx.query('update "user" set banned = true, ban_reason = $2 where id = any($1::text[])', [accountIds, 'T11 technical acceptance completed']);
      await tx.query('delete from session where user_id = any($1::text[])', [accountIds]);
      await tx.query('delete from account where user_id = any($1::text[])', [accountIds]);
      await tx.query('commit');
    } catch (error) { await tx.query('rollback'); throw error; } finally { tx.release(); }
    for (const file of files) { const target = resolve(config.dataDir, file.storage_key); assert(target.startsWith(resolve(config.dataDir) + sep)); await unlink(target); }
  }
  return { baseURL, runId, fixture, sourcePath, sourceBytes, users, request, setup, catalog, switchCatalog, trackSeller, seller, uploadBody, get, settle, upload, context, selections, preview, allItems, commit, unchangedOriginalAndMappings, cleanup };
}

async function run() {
  const checks: Array<{ name: string; result: string; details?: Record<string, unknown> }> = [];
  let currentStep = 'setup'; let failed = false; let cleaned = false;
  const fixture = await readAcceptanceFixture();
  const expected = fixture.counts;
  const h = await createConfirmationHarness({ fixture });
  const check = async (name: string, action: () => Promise<Record<string, unknown> | void>) => {
    currentStep = name; const details = await action(); checks.push({ name, result: 'passed', ...(details ? { details } : {}) }); console.log(`PASS ${name}`);
  };
  try {
    await h.setup();
    const admin = h.users.get('admin')!; const actor = h.users.get('actor')!;
    let original!: SourceImport; let originalPreview!: ImportPreviewResponse; let originalCommitInput!: ImportCommitInput;
    await check('configured-original-explicit-seller-confirmation-and-source-trace', async () => {
      original = await h.upload();
      assert.equal(original.latestRun!.counts.totalRows, expected.totalRows); assert.equal(original.latestRun!.counts.validFbaRows, expected.validFbaRows);
      const unconfirmed = await h.preview(original, []); assert.equal(unconfirmed.preview.selectableItemIds.length, 0);
      originalPreview = await h.preview(original);
      assert.equal(originalPreview.preview.counts.new, expected.validFbaRows, 'Use a clean acceptance database with no existing original demands');
      assert.equal(originalPreview.preview.counts.error, expected.errorRows);
      const items = await h.allItems(original, originalPreview);
      assert.equal(items.length, expected.totalRows);
      assert(items.every((item) => item.sources.every((source) => source.fileName === original.originalName && source.sheetName === original.latestRun!.sheetName && source.rowNumber > 1 && source.addresses.length > 0)));
      assert(items.filter((item) => item.kind === 'error').every((item) => !item.selectable && item.issues.length));
      assert(originalPreview.preview.mappings.every((mapping) => mapping.confirmedBy === admin.id && mapping.confirmedAt && mapping.confirmed));
      const rows = await h.request(`/imports/${original.id}/rows?pageSize=100`);
      assert(importRowsResponseSchema.parse(rows.data).items.every((row) => row.normalized.sid === null), 'Confirmation must not rewrite immutable parse rows');
      return { sourceSha256: fixture.sourceSha256, sourceRows: expected.totalRows, validFba: expected.validFbaRows, blockedIdentityRows: expected.errorRows, explicitMappings: originalPreview.preview.mappings.length };
    });
    await check('partial-original-commit-idempotency-history-and-demand-provenance', async () => {
      const selected = originalPreview.preview.selectableItemIds.slice(0, Math.min(17, expected.validFbaRows - 1));
      const submitted = await h.commit(original, originalPreview, selected); assert.equal(submitted.status, 200);
      assert.equal(submitted.result!.counts.created, selected.length);
      const repeated = await h.commit(original, originalPreview, selected, submitted.input); assert.equal(repeated.status, 200); assert.equal(repeated.result!.replayed, true);
      assert.deepEqual(repeated.result!.items, submitted.result!.items);
      const conflict = await h.commit(original, originalPreview, selected.slice(1), { operationId: submitted.input.operationId }); assert.equal(conflict.status, 409);
      assert.equal((await h.context(original.id)).status, 'partially_submitted');
      originalPreview = await h.preview(await h.get(original.id));
      const rest = await h.commit(original, originalPreview); assert.equal(rest.status, 200); assert.equal(rest.result!.counts.created, expected.validFbaRows - selected.length); originalCommitInput = rest.input;
      const context = await h.context(original.id); assert.equal(context.status, 'submitted'); assert.equal(context.submittedSourceRows, expected.validFbaRows);
      const history = await h.request(`/imports/${original.id}/commits`); assert.equal(importCommitHistorySchema.parse(history.data).items.length, 2);
      const demand = await h.request(`/demands/${submitted.result!.items[0]!.demandId}`); const detail = demandDetailSchema.parse(demand.data);
      assert.equal(detail.demand.businessDate, original.businessDate); assert.equal(detail.demand.weekStartDate, original.weekStartDate);
      assert.equal(detail.revisions.length, 1); assert.equal(detail.sources.length, 1); assert.equal(detail.sources[0]!.mapping.confirmedBy, admin.id);
      return { created: expected.validFbaRows, committedRows: context.submittedSourceRows, commitRecords: 2 };
    });
    await check('same-real-file-reupload-and-reparse-do-not-create-demands-or-sources', async () => {
      const repeated = await h.upload(); assert.equal(repeated.id, original.id);
      const current = await h.get(original.id);
      const parsed = await h.request(`/imports/${original.id}/parse`, undefined, 'POST', { operationId: randomUUID(), expectedVersion: current.version, sheetName: current.latestRun!.sheetName, mappingVersion: 'feishu-v1' }); assert.equal(parsed.status, 202);
      const rerun = await h.settle(original.id); const preview = await h.preview(rerun);
      assert.equal(preview.preview.counts.unchanged, expected.validFbaRows);
      assert((await h.allItems(rerun, preview)).filter((item) => item.kind === 'unchanged').every((item) => item.alreadyCommitted));
      assert.equal(preview.preview.selectableItemIds.length, 0);
      const replay = await h.commit(rerun, originalPreview, originalCommitInput.selectedItemIds, originalCommitInput); assert.equal(replay.status, 200); assert(replay.result!.replayed);
      const counts = await pool.query(`select (select count(*) from demand_source where import_id = $1)::int as sources, (select count(*) from demand_revision where created_by = $2)::int as revisions`, [original.id, admin.id]);
      assert.equal(counts.rows[0].sources, expected.validFbaRows); assert.equal(counts.rows[0].revisions, expected.validFbaRows);
      return { demandVersions: expected.validFbaRows, sources: expected.validFbaRows, newActions: 0 };
    });
    const seller = await h.seller();
    const fba = (suffix: string) => `FBAT11${h.runId.replaceAll('-', '').toUpperCase()}${suffix}`;
    const row = (suffix: string, quantity = '10'): TechnicalRow => ({ shop: seller.name, fba: fba(suffix), quantity });
    let initial!: SourceImport; let initialPreview!: ImportPreviewResponse; let firstDemandId = '';
    await check('technical-same-ticket-same-content-groups-all-source-rows', async () => {
      initial = await h.upload(technicalWorkbook([row('A'), row('B'), row('A')]), 'technical-base.xlsx'); initialPreview = await h.preview(initial);
      assert.equal(initialPreview.preview.counts.new, 2);
      const items = await h.allItems(initial, initialPreview); assert.equal(items.find((item) => item.fba === fba('A'))!.sources.length, 2);
      const result = await h.commit(initial, initialPreview); assert.equal(result.status, 200); assert.equal(result.result!.counts.created, 2);
      firstDemandId = result.result!.items.find((item) => item.sources.length === 2)!.demandId;
    });
    await check('technical-reordered-source-date-alias-and-cross-week-import-link-only', async () => {
      const later = await h.upload(technicalWorkbook([{ ...row('B'), date: '2027-01-15' }, { ...row('A'), shop: `${seller.name}-alias`, date: '2027-01-15' }]), 'technical-reordered.xlsx');
      await pool.query("update source_import set business_date='2027-01-15', week_start_date='2027-01-11', week_end_date='2027-01-17' where id=$1 and created_by=$2", [later.id, admin.id]);
      const selections: ImportSellerSelection[] = [seller.name, `${seller.name}-alias`].map((sourceShop) => ({ sourceShop, sellerMappingId: seller.id, expectedVersion: 1, confirmed: true }));
      const preview = await h.preview(await h.get(later.id), selections); assert.equal(preview.preview.counts.unchanged, 2);
      const result = await h.commit(later, preview); assert.equal(result.status, 200); assert.equal(result.result!.counts.linked, 2);
      const detail = demandDetailSchema.parse((await h.request(`/demands/${firstDemandId}`)).data);
      assert.equal(detail.demand.businessDate, initial.businessDate); assert.equal(detail.demand.weekStartDate, initial.weekStartDate); assert.equal(detail.revisions.length, 1); assert.equal(detail.sources.length, 3);
    });
    await check('technical-legacy-quantity-differences-only-link-sources-without-new-versions', async () => {
      const legacy = await h.upload(technicalWorkbook([row('A', ''), row('A', '0'), row('A', '4')]), 'technical-legacy-quantities.xlsx');
      const preview = await h.preview(legacy);
      assert.equal(preview.preview.counts.unchanged, 1); assert.equal(preview.preview.counts.conflict, 0);
      const result = await h.commit(legacy, preview); assert.equal(result.status, 200); assert.equal(result.result!.counts.linked, 1); assert.equal(result.result!.counts.updated, 0);
      const detail = demandDetailSchema.parse((await h.request(`/demands/${firstDemandId}`)).data);
      assert.equal(detail.demand.snapshot.referenceQuantity, '10'); assert.equal(detail.revisions.length, 1);
    });
    await check('technical-old-quantity-only-changed-preview-links-without-overwriting-history', async () => {
      const legacy = await h.upload(technicalWorkbook([row('A', '9')]), 'technical-old-quantity-preview.xlsx');
      const preview = await h.preview(legacy);
      assert.equal(preview.preview.counts.unchanged, 1);
      const previousPayload = {
        preview: { ...preview.preview, counts: { ...preview.preview.counts, unchanged: 0, changed: 1 }, changedItemIds: preview.preview.selectableItemIds },
        items: preview.items.map((item) => ({ ...item, kind: 'changed' as const })),
      };
      await pool.query('update import_preview set payload=$1::jsonb where id=$2 and created_by=$3', [JSON.stringify(previousPayload), preview.preview.id, admin.id]);
      const result = await h.commit(legacy, { ...preview, ...previousPayload }, preview.preview.selectableItemIds, { confirmedChangedItemIds: previousPayload.preview.changedItemIds });
      assert.equal(result.status, 200); assert.equal(result.result!.counts.linked, 1); assert.equal(result.result!.counts.updated, 0);
      const detail = demandDetailSchema.parse((await h.request(`/demands/${firstDemandId}`)).data);
      assert.equal(detail.demand.snapshot.referenceQuantity, '10'); assert.equal(detail.revisions.length, 1);
    });
    await check('technical-increment-visible-change-confirmation-and-missing-baseline', async () => {
      const changed = await h.upload(technicalWorkbook([{ ...row('A'), notes: 'TECHNICAL CHANGED NOTES' }, row('C')]), 'technical-increment.xlsx');
      const withoutBaseline = await h.preview(changed); assert.equal(withoutBaseline.preview.counts.missing, 0);
      const unconfirmedBaseline = await h.preview(changed, [], initial.id); assert.equal(unconfirmedBaseline.preview.counts.missing, 0); assert(unconfirmedBaseline.preview.counts.error > 0);
      const preview = await h.preview(changed, undefined, initial.id);
      assert.equal(preview.preview.counts.changed, 1); assert.equal(preview.preview.counts.new, 1); assert.equal(preview.preview.counts.missing, 1);
      const before = await pool.query('select count(*)::int as n from demand_revision where created_by=$1', [admin.id]);
      const rejected = await h.commit(changed, preview); assert.equal(rejected.status, 422);
      const details = (rejected.data as CommitError).error.details;
      assert.deepEqual(details.missingChangedItemIds, preview.preview.changedItemIds);
      assert(details.items?.every((item) => item.sources.every((source) => source.fileName === 'technical-increment.xlsx' && source.sheetName === '需求导入 ' && source.rowNumber === 2)));
      assert.equal((await pool.query('select count(*)::int as n from demand_revision where created_by=$1', [admin.id])).rows[0].n, before.rows[0].n);
      const submitted = await h.commit(changed, preview, preview.preview.selectableItemIds, { confirmedChangedItemIds: preview.preview.changedItemIds }); assert.equal(submitted.status, 200);
      assert.equal(submitted.result!.counts.updated, 1); assert.equal(submitted.result!.counts.created, 1);
      const detail = demandDetailSchema.parse((await h.request(`/demands/${firstDemandId}`)).data); assert.equal(detail.demand.snapshot.notes, 'TECHNICAL CHANGED NOTES'); assert.equal(detail.revisions.length, 2);
      return { technicalOnly: true, changedField: 'notes', changed: 1, added: 1, missingHint: 1 };
    });
    await check('technical-selection-rolls-back-earlier-new-demand-when-later-ticket-is-stale', async () => {
      const mixed = await h.upload(technicalWorkbook([row('J'), { ...row('A'), notes: 'TECHNICAL STALE NOTES' }]), 'technical-atomic-stale.xlsx');
      const mixedPreview = await h.preview(mixed);
      const concurrent = await h.upload(technicalWorkbook([{ ...row('A'), notes: 'TECHNICAL CONCURRENT NOTES' }]), 'technical-atomic-concurrent-change.xlsx');
      const concurrentPreview = await h.preview(concurrent);
      assert.equal((await h.commit(concurrent, concurrentPreview, concurrentPreview.preview.selectableItemIds, { confirmedChangedItemIds: concurrentPreview.preview.changedItemIds })).status, 200);
      const beforeAudit = Number((await pool.query('select count(*) from operation_audit where actor_user_id=$1', [admin.id])).rows[0].count);
      const rejected = await h.commit(mixed, mixedPreview, mixedPreview.preview.selectableItemIds, { confirmedChangedItemIds: mixedPreview.preview.changedItemIds }); assert.equal(rejected.status, 409);
      const details = (rejected.data as CommitError).error.details;
      assert.equal(details.currentDemandVersion, 3); assert.equal(details.sources?.length, 1);
      assert(details.sources?.every((source) => source.fileName === 'technical-atomic-stale.xlsx' && source.sheetName === '需求导入 ' && source.rowNumber === 3));
      assert.equal(Number((await pool.query('select count(*) from demand where sid=$1 and fba=$2', [seller.sid, fba('J')])).rows[0].count), 0);
      assert.equal(Number((await pool.query('select count(*) from demand_source where import_id=$1', [mixed.id])).rows[0].count), 0);
      assert.equal(Number((await pool.query('select count(*) from import_commit where import_id=$1', [mixed.id])).rows[0].count), 0);
      assert.equal(Number((await pool.query('select count(*) from operation_audit where actor_user_id=$1', [admin.id])).rows[0].count), beforeAudit);
    });
    await check('technical-already-submitted-source-cannot-rebind-to-another-seller', async () => {
      const alternate = await h.seller();
      const current = await h.get(initial.id);
      const reparsed = await h.request(`/imports/${initial.id}/parse`, undefined, 'POST', { operationId: randomUUID(), expectedVersion: current.version, sheetName: current.latestRun!.sheetName, mappingVersion: 'manual-v1' }); assert.equal(reparsed.status, 202);
      const rebound = await h.preview(await h.settle(initial.id), [{ sourceShop: seller.name, sellerMappingId: alternate.id, expectedVersion: 1, confirmed: true }]);
      assert.equal(rebound.preview.counts.conflict, 2); assert.equal(rebound.preview.selectableItemIds.length, 0);
      assert.equal(Number((await pool.query('select count(*) from demand where sid=$1', [alternate.sid])).rows[0].count), 0);
      const sources = await pool.query('select distinct mapping->>\'sid\' as sid from demand_source where import_id=$1', [initial.id]);
      assert.deepEqual(sources.rows, [{ sid: String(seller.sid) }]);
    });
    await check('technical-conflicting-ticket-invalid-country-and-disabled-seller-block-located-rows', async () => {
      const conflict = await h.upload(technicalWorkbook([row('D'), { ...row('D'), notes: 'TECHNICAL CONFLICTING NOTES' }, { ...row('E'), country: '德国' }]), 'technical-conflict.xlsx');
      const preview = await h.preview(conflict); assert.equal(preview.preview.counts.conflict, 1); assert.equal(preview.preview.counts.error, 1); assert.equal(preview.preview.selectableItemIds.length, 0);
      const items = await h.allItems(conflict, preview); assert.equal(items.find((item) => item.kind === 'conflict')!.sources.length, 2);
      assert(items.every((item) => item.sources.every((source) => source.fileName === 'technical-conflict.xlsx' && source.sheetName === '需求导入 ' && source.rowNumber >= 2)));
      const rejected = await h.commit(conflict, preview, [items[0]!.id]); assert.equal(rejected.status, 422);
      const details = (rejected.data as CommitError).error.details;
      assert(details.items); assert.equal(details.items.length, 1); assert.equal(details.items[0]!.sources.length, 2);
      assert(details.items[0]!.sources.every((source) => source.fileName === 'technical-conflict.xlsx' && source.sheetName === '需求导入 ' && source.rowNumber >= 2));
      await pool.query("update seller_mapping set status='disabled',version=version+1 where id=$1", [seller.id]);
      try {
        const currentCatalog = await h.catalog();
        const stale = await h.request(`/imports/${conflict.id}/preview`, undefined, 'POST', { expectedVersion: conflict.version, parseRunId: conflict.latestRun!.id, sellerSelections: [{ sourceShop: seller.name, sellerMappingId: seller.id, expectedVersion: 2, confirmed: true }], expectedCatalogSettingsVersion: currentCatalog.version, expectedCatalogVersion: currentCatalog.catalogVersion }); assert.equal(stale.status, 409);
      } finally { await pool.query("update seller_mapping set status='candidate',version=1 where id=$1", [seller.id]); }
    });
    await check('technical-stale-parse-and-seller-version-reject-without-partial-records', async () => {
      const item = await h.upload(technicalWorkbook([row('F')]), 'technical-stale.xlsx'); const preview = await h.preview(item);
      const parse = await h.request(`/imports/${item.id}/parse`, undefined, 'POST', { operationId: randomUUID(), expectedVersion: item.version, sheetName: item.latestRun!.sheetName, mappingVersion: 'manual-v1' }); assert.equal(parse.status, 202); await h.settle(item.id);
      assert.equal((await h.commit(item, preview)).status, 409);
      const fresh = await h.preview(await h.get(item.id));
      await pool.query('update seller_mapping set version=2 where id=$1', [seller.id]);
      try { assert.equal((await h.commit(item, fresh)).status, 409); } finally { await pool.query('update seller_mapping set version=1 where id=$1', [seller.id]); }
      assert.equal(Number((await pool.query('select count(*) from demand where sid=$1 and fba=$2', [seller.sid, fba('F')])).rows[0].count), 0);
      assert.equal(Number((await pool.query('select count(*) from import_commit where import_id=$1', [item.id])).rows[0].count), 0);
    });
    await check('technical-two-administrators-concurrent-commit-one-version-and-safe-operation-replay', async () => {
      const bytes = technicalWorkbook([row('G'), row('H')]);
      const item = await h.upload(bytes, 'technical-concurrent.xlsx');
      const other = await h.upload(bytes, 'technical-concurrent.xlsx', actor.cookie);
      const p1 = await h.preview(item);
      const otherActorContext = await h.request(`/imports/${item.id}/confirmation`, actor.cookie);
      assert.equal(importConfirmationContextSchema.parse(otherActorContext.data).latestPreviewId, null, 'An administrator must explicitly confirm a personal preview before committing');
      const p2 = await h.preview(other, undefined, undefined, actor.cookie);
      const results = await Promise.all([h.commit(item, p1), h.commit(other, p2, p2.preview.selectableItemIds, {}, actor.cookie)]);
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
      const counts = await pool.query('select count(*)::int as n,max(version)::int as max from demand where sid=$1 and fba=any($2::text[])', [seller.sid, [fba('G'), fba('H')]]); assert.deepEqual(counts.rows[0], { n: 2, max: 1 });
      const winner = results.find((result) => result.status === 200)!;
      const firstWon = winner.input.previewId === p1.preview.id;
      const replay = await h.commit(firstWon ? item : other, firstWon ? p1 : p2, winner.input.selectedItemIds, winner.input, firstWon ? admin.cookie : actor.cookie); assert.equal(replay.status, 200); assert(replay.result!.replayed);
    });
    await check('administrator-revocation-and-invalid-selection-do-not-write-commit-or-audit', async () => {
      const item = await h.upload(technicalWorkbook([row('I')]), 'technical-revocation.xlsx'); const preview = await h.preview(item);
      const invalidId = randomUUID(); const invalid = await h.commit(item, preview, [invalidId]); assert.equal(invalid.status, 422);
      assert.deepEqual((invalid.data as CommitError).error.details.unknownItemIds, [invalidId]);
      const audits = Number((await pool.query('select count(*) from operation_audit where actor_user_id=$1', [actor.id])).rows[0].count);
      await pool.query("update \"user\" set banned=true,role='operations' where id=$1", [actor.id]);
      try { assert.equal((await h.commit(item, preview, preview.preview.selectableItemIds, {}, actor.cookie)).status, 403); }
      finally { await pool.query("update \"user\" set banned=false,role='admin' where id=$1", [actor.id]); }
      assert.equal(Number((await pool.query('select count(*) from operation_audit where actor_user_id=$1', [actor.id])).rows[0].count), audits);
    });
    await check('real-original-candidates-and-global-aliases-unchanged', h.unchangedOriginalAndMappings);
  } catch (error) {
    failed = true; checks.push({ name: currentStep, result: 'failed', details: { message: error instanceof Error ? error.message : 'CHECK_FAILED' } });
    console.error(`T11 acceptance failed: ${currentStep}`, error instanceof Error ? error.message : 'CHECK_FAILED');
  } finally {
    try { await h.cleanup(); cleaned = true; } catch (error) { failed = true; checks.push({ name: 'technical-fixture-cleanup', result: 'failed', details: { message: error instanceof Error ? error.message : 'CLEANUP_FAILED' } }); }
    const reportIndex = process.argv.indexOf('--report');
    const reportPath = reportIndex >= 0 ? resolve(process.argv[reportIndex + 1]!) : resolve(projectRoot, '.local/t11/integration.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({ kind: 'real-postgresql-demand-confirmation', runId: h.runId, createdAt: new Date().toISOString(), timezone: 'Asia/Shanghai', result: failed ? 'failed' : 'passed', checks, technicalFixturesRemoved: cleaned,
      realEvidence: 'Designated unchanged original: initial explicit mapping, commit, repeat upload and reparse', technicalEvidence: 'Generated and labelled workbooks: increments, changes, missing, errors, stale snapshots and concurrency', notCovered: ['real daily increment/correction business acceptance', 'T12 weekly batch pages'] }, null, 2)}\n`);
    await closeDatabase(); console.log(`T11 integration ${failed ? 'FAILED' : 'PASSED'} (${checks.filter((check) => check.result === 'passed').length} checks)`); if (failed) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
