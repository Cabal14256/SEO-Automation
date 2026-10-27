import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { ConfirmAndAllocateSubBatchInput, FbaLookupCandidate, FbaLookupInput, ImportCommitInput, ImportNormalizedRow, ImportSellerSelection, ShippingRunIssue } from '@scm/contracts';
import { db, pool } from '../../db/client.js';
import { demands, importCommits, importParseRuns, importPreviews, operationAudit, sellerMappings, sourceImports, sourceImportRows } from '../../db/schema.js';
import { logError } from '../../errors.js';
import { BatchError, confirmAndAllocateGroup, createRunBatch, createSubBatch, getConfirmedGroup, getSubBatchDetail, getWeeklyBatch, requireBatchActor } from '../batches/service.js';
import { subBatches, subBatchMembers, weeklyBatches } from '../batches/schema.js';
import { getBatchSyncRun, requestBatchSync, retryBatchSync } from '../batches/sync-jobs.js';
import { commitImport, createImportPreview } from '../imports/confirmation.js';
import { getFbaLookup, requestFbaLookup } from '../imports/fba-lookup.js';
import { ImportError } from '../imports/service.js';
import { BatchSyncError } from '../batches/sync.js';
import { LingxingReadError } from '../lingxing/read-client.js';
import { batchSyncRuns } from '../lingxing/sync-schema.js';
import { activeSeller, CatalogError, getCatalogState } from '../seller-mappings/catalog.js';
import { lookupDateRange, numberTickets, shippingCountry, shippingOperationId, sourceTicketLayout } from './domain.js';
import { activeShippingRuns, enqueueShippingRunInTx, getShippingRunReportScopeInTx, reserveShippingSequenceInTx, shippingRunReadinessIssuesInTx, SHIPPING_RUN_QUEUE } from './service.js';
import { shippingRuns, shippingTicketMembers, shippingTickets } from './schema.js';
import { assertLifecycleActiveInTx } from '../shipping-lifecycle/guards.js';

type Run = typeof shippingRuns.$inferSelect;
type SourceRow = typeof sourceImportRows.$inferSelect;
type Stage = 'lookup' | 'commit' | 'grouping' | 'sync' | 'confirmation' | 'ready';
class ReviewRequired extends Error { constructor(public issues: ShippingRunIssue[]) { super(issues[0]?.message ?? '请处理本次发货的异常后重试。'); } }
function review(code: string, message: string, extra: Omit<ShippingRunIssue, 'code' | 'message'> = {}): never { throw new ReviewRequired([{ code, message, ...extra }]); }
async function transition(run: Run, stage: Stage, status = 'running') {
  const changed = await db.update(shippingRuns).set({ stage, status, version: sql`${shippingRuns.version}+1`, issues: [], error: null, updatedAt: new Date() }).where(and(eq(shippingRuns.id, run.id), eq(shippingRuns.lifecycle, 'active'), eq(shippingRuns.lifecyclePending, false))).returning({ id: shippingRuns.id });
  if (!changed.length) throw new BatchError('SHIPPING_LIFECYCLE_INACTIVE', 409, '记录正在取消或删除，已停止后台整理。');
  run.stage = stage; run.status = status;
}
async function saveCheckpoint(run: Run) { const changed = await db.update(shippingRuns).set({ checkpoint: run.checkpoint, updatedAt: new Date() }).where(and(eq(shippingRuns.id, run.id), eq(shippingRuns.lifecycle, 'active'), eq(shippingRuns.lifecyclePending, false))).returning({ id: shippingRuns.id }); if (!changed.length) throw new BatchError('SHIPPING_LIFECYCLE_INACTIVE', 409, '记录正在取消或删除，已停止保存后台检查点。'); }
async function checkpointInput<T>(run: Run, key: string, create: () => Promise<T> | T): Promise<T> {
  const old = run.checkpoint.operations[key]; if (old) return old.input as T;
  const input = await create(); run.checkpoint.operations[key] = { input }; await saveCheckpoint(run); return input;
}
async function saveResult(run: Run, key: string, resultId: string) { run.checkpoint.operations[key]!.resultId = resultId; await saveCheckpoint(run); }
async function source(run: Run) {
  if (!run.importId || !run.parseRunId) review('SOURCE_NOT_FOUND', '人工发货次不应读取导入来源。');
  const [record] = await db.select().from(sourceImports).where(eq(sourceImports.id, run.importId));
  const [parse] = await db.select().from(importParseRuns).where(and(eq(importParseRuns.id, run.parseRunId), eq(importParseRuns.importId, run.importId)));
  if (!record || !parse) review('SOURCE_NOT_FOUND', '发货来源或解析记录不存在，请重新选择来源。');
  if (record.latestRunId !== parse.id || record.version !== parse.inputVersion) review('SOURCE_VERSION_CHANGED', '导入已有更新的解析，请选择最新解析版本后重试。');
  if (parse.status === 'queued' || parse.status === 'running') return null;
  if (parse.status !== 'completed' || record.status !== 'preview_ready') review('SOURCE_PARSE_FAILED', parse.errorMessage ?? '来源解析尚未成功，请修正后重新解析。');
  const rows = await db.select().from(sourceImportRows).where(eq(sourceImportRows.parseRunId, run.parseRunId)).orderBy(asc(sourceImportRows.rowNumber));
  return { record, parse, rows };
}
async function ensureTickets(run: Run, rows: SourceRow[]) {
  const layout = sourceTicketLayout(rows);
  if (layout.issues.length) throw new ReviewRequired(layout.issues);
  await db.transaction(async (tx) => {
    await assertLifecycleActiveInTx(tx, 'run', run.id);
    const [exists] = await tx.select({ id: shippingTickets.id }).from(shippingTickets).where(eq(shippingTickets.runId, run.id)).limit(1); if (exists) return;
    for (const ticket of layout.tickets) {
      const id = randomUUID(); await tx.insert(shippingTickets).values({ id, runId: run.id, sourceTicketIndex: ticket.sourceTicketIndex });
      for (const member of ticket.members) await tx.insert(shippingTicketMembers).values({ id: randomUUID(), ticketId: id, runId: run.id, ...member });
    }
  });
}
async function lookupStage(boss: PgBoss, run: Run) {
  if (!run.importId || !run.parseRunId) review('SOURCE_NOT_FOUND', '本次发货缺少导入来源。');
  const importId = run.importId, parseRunId = run.parseRunId;
  const data = await source(run); if (!data) return false;
  await ensureTickets(run, data.rows);
  const { catalog, sellers } = await db.transaction(async (tx) => ({ catalog: await getCatalogState(tx), sellers: await tx.select().from(sellerMappings) }));
  const available = sellers.flatMap((row) => { const seller = activeSeller(row, catalog.mode); return seller && seller.status !== 'disabled' ? [seller] : []; });
  const explicitSeller = (row: SourceRow) => {
    const sid = row.normalized.sid ?? (data.record.sourceType === 'online' ? Number(/(?:^|:)sid=(\d+)$/.exec(row.normalized.metadataSource ?? '')?.[1]) || null : null);
    if (sid) return available.find((seller) => seller.sid === sid);
    const matches = available.filter((seller) => seller.id === row.normalized.sellerMappingId || seller.name.normalize('NFKC').trim().toLowerCase() === row.normalized.shop?.normalize('NFKC').trim().toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
  };
  const candidates = new Map<string, { lookupId: string; candidates: FbaLookupCandidate[] }>();
  const dates = lookupDateRange(run.numberingDate);
  // Reuse only verified online evidence from the current catalog and query
  // dates. File metadata text never grants a trusted lookup identity.
  if (data.record.sourceType === 'online') {
    for (const row of data.rows) {
      const lookupId = /(?:^|[+:])lingxing:([0-9a-f-]{36}):sid=\d+$/i.exec(row.normalized.metadataSource ?? '')?.[1];
      if (!lookupId) continue;
      const lookup = await getFbaLookup(lookupId, run.createdBy);
      if (lookup.status !== 'completed' || lookup.catalogMode !== catalog.mode || lookup.catalogSettingsVersion !== catalog.version || lookup.catalogVersion !== catalog.catalogVersion || lookup.startDate !== dates.startDate || lookup.endDate !== dates.endDate) continue;
      const item = lookup.rows.find((entry) => entry.fba === row.normalized.fba);
      if (item) candidates.set(item.fba, { lookupId, candidates: item.candidates });
    }
  }
  const fbas = [...new Set(data.rows.flatMap((row) => candidates.has(row.normalized.fba!) ? [] : [row.normalized.fba!]))];
  for (let start = 0; start < fbas.length; start += 100) {
    const key = `lookup:${start / 100}`; let operation = run.checkpoint.operations[key];
    if (operation?.resultId) {
      const previous = await getFbaLookup(operation.resultId, run.createdBy);
      if (previous.status === 'failed') { delete run.checkpoint.operations[key]; await saveCheckpoint(run); operation = undefined; }
    }
    const input = await checkpointInput<FbaLookupInput>(run, key, () => ({ operationId: shippingOperationId(run.id, `${key}:${run.checkpoint.lookupAttempt}`), fbas: fbas.slice(start, start + 100), startDate: lookupDateRange(run.numberingDate).startDate, endDate: run.numberingDate, expectedCatalogSettingsVersion: catalog.version, expectedCatalogVersion: catalog.catalogVersion }));
    const lookup = operation?.resultId ? await getFbaLookup(operation.resultId, run.createdBy) : await requestFbaLookup(boss, input, run.createdBy);
    if (!run.checkpoint.operations[key]!.resultId) await saveResult(run, key, lookup.id);
    if (lookup.status === 'failed') review(lookup.errorCode ?? 'FBA_LOOKUP_FAILED', lookup.errorMessage ?? 'FBA 信息补全失败，请稍后重试。');
    if (lookup.status !== 'completed') return false;
    for (const item of lookup.rows) candidates.set(item.fba, { lookupId: lookup.id, candidates: item.candidates });
  }
  const issues: ShippingRunIssue[] = []; const resolved: Array<{ row: SourceRow; normalized: ImportNormalizedRow }> = [];
  for (const row of data.rows) {
    let seller = explicitSeller(row); const match = candidates.get(row.normalized.fba!);
    const possible = seller ? match?.candidates.filter((candidate) => candidate.sid === seller!.sid) : match?.candidates;
    const candidate = possible?.length === 1 ? possible[0] : undefined;
    if (!seller && candidate) seller = available.find((entry) => entry.sid === candidate.sid);
    const extra = { ticketIndex: row.normalized.sourceTicketIndex ?? 1, fba: row.normalized.fba! };
    if (!candidate || !seller) { issues.push({ code: possible?.length ? 'FBA_SHOP_AMBIGUOUS' : 'FBA_NOT_FOUND', message: possible?.length ? 'FBA 对应多个店铺，请在来源中选择店铺候选后重新导入。' : '未找到所选店铺中的 FBA，请检查 FBA、店铺及货件创建日期。', ...extra }); continue; }
    if (row.normalized.country && shippingCountry(row.normalized.country) !== shippingCountry(seller.country)) { issues.push({ code: 'COUNTRY_MISMATCH', message: '来源国家与店铺国家不同，请修正来源。', ...extra }); continue; }
    if (!shippingCountry(seller.country)) { issues.push({ code: 'UNKNOWN_COUNTRY', message: `无法识别国家“${seller.country}”的简写，请维护店铺国家。`, ...extra }); continue; }
    if (candidate.channelStatus === 'ambiguous' && !(row.normalized.channel && candidate.channelOptions.some((option) => option.name === row.normalized.channel))) { issues.push({ code: 'CHANNEL_AMBIGUOUS', message: '该 FBA 对应多个运输方式，请在来源中明确选择。', ...extra }); continue; }
    if (candidate.channelStatus === 'unique' && row.normalized.channel && candidate.channel && row.normalized.channel !== candidate.channel) { issues.push({ code: 'CHANNEL_MISMATCH', message: '来源渠道与领星运输方式不同，请核对来源后重新导入。', ...extra }); continue; }
    if ((!candidate.channel || candidate.channelStatus === 'unavailable' || candidate.channelStatus === 'not_found') && !row.normalized.channel) { issues.push({ code: 'CHANNEL_REQUIRED', message: '领星未提供明确运输方式，请在来源中补充渠道后重试。', ...extra }); continue; }
    resolved.push({ row, normalized: { ...row.normalized, shop: row.normalized.shop || seller.name, country: seller.country, sid: seller.sid, sellerMappingId: seller.id, sellerMappingVersion: seller.version,
      channel: row.normalized.channel || candidate?.channel || null, destinationFc: row.normalized.destinationFc || candidate?.destinationFc || null,
      destinationAddress: row.normalized.destinationAddress || candidate?.destinationAddress || null, shipmentCreatedAt: row.normalized.shipmentCreatedAt || candidate?.shipmentCreatedAt || null,
      ...(candidate && match ? { metadataSource: `lingxing:${match.lookupId}:sid=${seller.sid}`, metadataObservedAt: candidate.observedAt } : {}) } });
  }
  const countryByTicket = new Map<number, Set<string>>();
  for (const entry of resolved) { const index = entry.normalized.sourceTicketIndex ?? 1; const set = countryByTicket.get(index) ?? new Set(); set.add(shippingCountry(entry.normalized.country)!); countryByTicket.set(index, set); }
  for (const [ticketIndex, countries] of countryByTicket) if (countries.size > 1) issues.push({ code: 'TICKET_COUNTRY_MISMATCH', message: '同一空行分段内出现多个国家，请按国家分开后重新导入。', ticketIndex });
  if (issues.length) throw new ReviewRequired(issues);
  await db.transaction(async (tx) => {
    // Serialize with preview/commit and parser publication. A normalization
    // change must invalidate pre-existing previews, never their source history.
    const [current] = await tx.select().from(sourceImports).where(eq(sourceImports.id, importId)).for('update');
    if (!current || current.latestRunId !== run.parseRunId || current.version !== data.record.version) review('SOURCE_VERSION_CHANGED', '补全期间来源版本已变化，请选择最新解析后重试。');
    const previousCommits = await tx.select({ id: importCommits.operationId }).from(importCommits).where(eq(importCommits.importId, importId)).limit(1);
    const modifiesRows = resolved.some((entry) => JSON.stringify(entry.row.normalized) !== JSON.stringify(entry.normalized));
    const fields = ['shop', 'country', 'sid', 'sellerMappingId', 'sellerMappingVersion', 'channel', 'destinationFc', 'destinationAddress', 'shipmentCreatedAt'] as const;
    const changesCommittedFields = resolved.some((entry) => fields.some((field) => (entry.row.normalized[field] ?? null) !== (entry.normalized[field] ?? null)));
    if (previousCommits.length && changesCommittedFields) review('SOURCE_ALREADY_COMMITTED', '该来源已提交过需求，不能改写历史补全依据；请复制清单为新的在线来源后重试。');
    const finalRows = resolved.map((entry) => ({ ...entry, filtered: entry.row.issues.filter((issue) => !['SHOP_REQUIRED', 'COUNTRY_REQUIRED', 'SOURCE_MAPPING_REQUIRED', 'SELLER_ALIAS_CONFLICT', 'SELLER_COUNTRY_MISMATCH', 'COUNTRY_MISMATCH'].includes(issue.code)) }));
    const countsAfter = { totalRows: finalRows.length, validFbaRows: finalRows.length, errorRows: finalRows.filter((entry) => entry.filtered.some((issue) => issue.severity === 'error')).length, warningRows: finalRows.filter((entry) => entry.filtered.some((issue) => issue.severity === 'warning')).length };
    for (const entry of finalRows) {
      // Raw cells and the original workbook remain immutable evidence. Only the
      // derived normalization is enriched, with the lookup observation attached.
      const filtered = entry.filtered;
      if (!previousCommits.length) await tx.update(sourceImportRows).set({ normalized: entry.normalized, issues: filtered, status: filtered.some((issue) => issue.severity === 'error') ? 'error' : filtered.length ? 'needs_review' : 'valid' }).where(eq(sourceImportRows.id, entry.row.id));
      await tx.update(shippingTicketMembers).set({ sid: entry.normalized.sid }).where(and(eq(shippingTicketMembers.runId, run.id), eq(shippingTicketMembers.sourceRowId, entry.row.id)));
    }
    for (const [sourceTicketIndex, countries] of countryByTicket) await tx.update(shippingTickets).set({ country: [...countries][0]! }).where(and(eq(shippingTickets.runId, run.id), eq(shippingTickets.sourceTicketIndex, sourceTicketIndex)));
    if (!previousCommits.length) {
      const changesDerivedData = modifiesRows || finalRows.some((entry) => JSON.stringify(entry.row.issues) !== JSON.stringify(entry.filtered));
      const version = current.version + (changesDerivedData ? 1 : 0);
      if (changesDerivedData) await tx.update(sourceImports).set({ version }).where(eq(sourceImports.id, importId));
      await tx.update(importParseRuns).set({ inputVersion: version, counts: countsAfter }).where(eq(importParseRuns.id, parseRunId));
    }
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'shipping_run.enrich', targetId: run.id, actorUserId: run.createdBy, requestHash: run.id, details: { rowCount: String(resolved.length), parseRunId,
      countsBefore: JSON.stringify(data.parse.counts), countsAfter: JSON.stringify(previousCommits.length ? data.parse.counts : countsAfter),
      normalizedRevisions: JSON.stringify(resolved.map((entry) => ({ sourceRowId: entry.row.id, before: entry.row.normalized, after: previousCommits.length ? entry.row.normalized : entry.normalized, issuesBefore: entry.row.issues, applied: !previousCommits.length }))) } });
  });
  await transition(run, 'commit'); return true;
}
async function commitStage(run: Run) {
  if (!run.importId || !run.parseRunId) review('SOURCE_NOT_FOUND', '本次发货缺少导入来源。');
  const stored = run.checkpoint.operations['commit-request'];
  if (stored) {
    const result = await commitImport(run.importId, stored.input as ImportCommitInput, run.createdBy);
    const already = (run.checkpoint.operations['commit-existing']?.input ?? []) as Array<{ demandId: string; sources: Array<{ rowId: string }> }>;
    await attachCommittedDemands(run, [...already, ...result.items]); await transition(run, 'grouping'); return true;
  }
  const data = await source(run); if (!data) return false;
  const catalog = await db.transaction((tx) => getCatalogState(tx));
  const shops = new Map<string, ImportSellerSelection>();
  for (const row of data.rows) {
    const normalized = row.normalized;
    if (!normalized.shop || !normalized.sellerMappingId || !normalized.sellerMappingVersion) review('SHOP_UNRESOLVED', '店铺尚未确定，请补全后重试。', { fba: normalized.fba ?? undefined });
    shops.set(normalized.shop.normalize('NFKC').trim().toLowerCase(), { sourceShop: normalized.shop, sellerMappingId: normalized.sellerMappingId, expectedVersion: normalized.sellerMappingVersion, confirmed: true });
  }
  let previewId = run.checkpoint.operations['commit-preview']?.resultId;
  if (!previewId) {
    const preview = await createImportPreview(run.importId, { expectedVersion: data.record.version, parseRunId: run.parseRunId, sellerSelections: [...shops.values()], expectedCatalogSettingsVersion: catalog.version, expectedCatalogVersion: catalog.catalogVersion }, run.createdBy);
    run.checkpoint.operations['commit-preview'] = { input: {}, resultId: preview.preview.id }; await saveCheckpoint(run); previewId = preview.preview.id;
  }
  const [preview] = await db.select().from(importPreviews).where(eq(importPreviews.id, previewId)); if (!preview) review('PREVIEW_MISSING', '需求预览已不可用，请重试。');
  const blocked = preview.payload.items.filter((item) => !item.selectable && !item.alreadyCommitted || item.kind === 'changed');
  if (blocked.length) throw new ReviewRequired(blocked.map((item) => ({ code: item.kind === 'changed' ? 'DEMAND_CHANGE_REVIEW_REQUIRED' : item.issues[0]?.code ?? 'DEMAND_CONFLICT', message: item.kind === 'changed' ? '已存在需求与本次来源不同，请在需求核对中明确确认变化后重试。' : item.issues[0]?.message ?? '需求存在冲突，请修正来源后重试。', ...(item.fba ? { fba: item.fba } : {}) })));
  const already = preview.payload.items.filter((item) => item.alreadyCommitted && item.demandId).map((item) => ({ demandId: item.demandId!, sources: item.sources }));
  run.checkpoint.operations['commit-existing'] = { input: already }; await saveCheckpoint(run);
  const selectedItemIds = preview.payload.items.filter((item) => item.selectable).map((item) => item.id);
  if (selectedItemIds.length) {
    const input = await checkpointInput<ImportCommitInput>(run, 'commit-request', () => ({ operationId: shippingOperationId(run.id, `commit:${previewId}`), previewId, selectedItemIds, confirmedChangedItemIds: [] }));
    const result = await commitImport(run.importId, input, run.createdBy); await attachCommittedDemands(run, [...already, ...result.items]);
  } else await attachCommittedDemands(run, already);
  await transition(run, 'grouping'); return true;
}
async function attachCommittedDemands(run: Run, items: Array<{ demandId: string; sources: Array<{ rowId: string }> }>) {
  await db.transaction(async (tx) => {
    for (const item of [...items].sort((a, b) => a.demandId.localeCompare(b.demandId))) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shipping-demand:${item.demandId}`},0))`);
      const [occupied] = await tx.select().from(shippingTicketMembers).where(and(eq(shippingTicketMembers.demandId, item.demandId), isNull(shippingTicketMembers.releasedAt)));
      if (occupied && occupied.runId !== run.id) {
        const [ticket] = await tx.select().from(shippingTickets).where(eq(shippingTickets.id, occupied.ticketId));
        const [previous] = await tx.select().from(shippingRuns).where(eq(shippingRuns.id, occupied.runId));
        review('MEMBER_ALREADY_SHIPPED', `FBA ${occupied.fba} 已属于${ticket?.number ? `票号 ${ticket.number}` : `${previous?.numberingDate ?? ''} 的发货整理记录`}，请打开原记录。`, { demandId: item.demandId, fba: occupied.fba });
      }
      for (const source of item.sources) await tx.update(shippingTicketMembers).set({ demandId: item.demandId }).where(and(eq(shippingTicketMembers.runId, run.id), eq(shippingTicketMembers.sourceRowId, source.rowId)));
    }
  });
}
async function reserveNumbers(run: Run) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(shippingRuns).where(eq(shippingRuns.id, run.id)).for('update'); if (!current) return;
    const sequence = await reserveShippingSequenceInTx(tx, current);
    const tickets = await tx.select().from(shippingTickets).where(eq(shippingTickets.runId, run.id));
    if (tickets.some((ticket) => !ticket.country)) review('COUNTRY_UNRESOLVED', '票的国家尚未确定，请补全来源。');
    for (const numbered of numberTickets(tickets.map((ticket) => ({ id: ticket.id, sourceTicketIndex: ticket.sourceTicketIndex, country: ticket.country! })), run.numberingDate, sequence)) await tx.update(shippingTickets).set({ ticketSequence: numbered.ticketSequence, number: numbered.number }).where(eq(shippingTickets.id, numbered.id));
    run.sequence = sequence;
  });
}
async function groupingStage(run: Run) {
  await reserveNumbers(run);
  const members = await db.select({ member: shippingTicketMembers, demand: demands }).from(shippingTicketMembers).innerJoin(demands, eq(demands.id, shippingTicketMembers.demandId)).where(and(eq(shippingTicketMembers.runId, run.id), isNull(shippingTicketMembers.releasedAt)));
  const all = await db.select().from(shippingTicketMembers).where(and(eq(shippingTicketMembers.runId, run.id), isNull(shippingTicketMembers.releasedAt)));
  if (members.length !== all.length || !members.length) review('DEMAND_NOT_COMMITTED', '部分 FBA 尚未提交为正式需求，请核对来源。');
  const groups = new Map<string, typeof members>();
  for (const entry of members) {
    const key = JSON.stringify([entry.member.ticketId, entry.demand.sid, entry.demand.snapshot.country, entry.demand.snapshot.channel]);
    groups.set(key, [...groups.get(key) ?? [], entry]);
  }
  for (const [key, entries] of groups) {
    if (entries.every(({ member }) => member.groupId)) continue;
    const step = `group:v2:${key}`;
    const existing = await db.select({ member: subBatchMembers, group: subBatches }).from(subBatchMembers).innerJoin(subBatches, eq(subBatches.id, subBatchMembers.groupId)).where(and(inArray(subBatchMembers.demandId, entries.map(({ demand }) => demand.id)), eq(subBatchMembers.active, true)));
    if (existing.some(({ group }) => group.status === 'superseded')) review('GROUP_SUPERSEDED', '原处理组已被更正，请核对其有效更正组。');
    for (const occupied of existing) await db.update(shippingTicketMembers).set({ groupId: occupied.group.id }).where(and(eq(shippingTicketMembers.runId, run.id), eq(shippingTicketMembers.demandId, occupied.member.demandId)));
    const ungrouped = entries.filter(({ demand }) => !existing.some(({ member }) => member.demandId === demand.id));
    if (!ungrouped.length) continue;
    const batchResult = await createRunBatch(run.id, run.createdBy);
    const batchId = batchResult.batchId!;
    let input = await checkpointInput<Parameters<typeof createSubBatch>[1]>(run, step, async () => {
      const [batch] = await db.select().from(weeklyBatches).where(eq(weeklyBatches.id, batchId));
      const [ticket] = await db.select().from(shippingTickets).where(eq(shippingTickets.id, entries[0]!.member.ticketId));
      return { operationId: shippingOperationId(run.id, step), expectedVersion: batch!.version, name: ticket!.number!, demandIds: ungrouped.map(({ demand }) => demand.id), expectedDemandVersions: Object.fromEntries(ungrouped.map(({ demand }) => [demand.id, demand.version])), reason: '本次发货按空行分票自动建立内部处理组' };
    });
    let result: Awaited<ReturnType<typeof createSubBatch>> | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { result = await createSubBatch(batchId, input, run.createdBy); break; }
      catch (error) {
        if (!(error instanceof BatchError) || error.code !== 'VERSION_CONFLICT' || attempt === 4) throw error;
        const [batch] = await db.select().from(weeklyBatches).where(eq(weeklyBatches.id, batchId));
        input = { ...input, expectedVersion: batch!.version, operationId: shippingOperationId(run.id, `${step}:batch-version:${batch!.version}`) };
        run.checkpoint.operations[step] = { input }; await saveCheckpoint(run);
      }
    }
    await saveResult(run, step, result!.groupId!);
    await db.update(shippingTicketMembers).set({ groupId: result!.groupId! }).where(inArray(shippingTicketMembers.id, ungrouped.map(({ member }) => member.id)));
  }
  await transition(run, 'sync'); return true;
}
async function runGroupIds(runId: string) { const members = await db.select().from(shippingTicketMembers).where(and(eq(shippingTicketMembers.runId, runId), isNull(shippingTicketMembers.releasedAt))); return [...new Set(members.flatMap((member) => member.groupId ? [member.groupId] : []))]; }
async function syncStage(boss: PgBoss, run: Run) {
  let waiting = false; const issues: ShippingRunIssue[] = [];
  const expected = await db.select().from(shippingTicketMembers).where(and(eq(shippingTicketMembers.runId, run.id), isNull(shippingTicketMembers.releasedAt)));
  const memberships = expected.length ? await db.select().from(subBatchMembers).where(and(inArray(subBatchMembers.demandId, expected.flatMap((member) => member.demandId ? [member.demandId] : [])), eq(subBatchMembers.active, true))) : [];
  for (const member of expected) if (!memberships.some((current) => current.groupId === member.groupId && current.demandId === member.demandId)) issues.push({ code: 'SHIPPING_MEMBER_REMOVED', message: '本票的 FBA 已从其内部处理组移除，请恢复正确归属后重试。', fba: member.fba, ...(member.demandId ? { demandId: member.demandId } : {}), ...(member.groupId ? { groupId: member.groupId } : {}) });
  if (issues.length) throw new ReviewRequired(issues);
  for (const groupId of await runGroupIds(run.id)) {
    const key = `sync:${groupId}`; let resultId = run.checkpoint.operations[key]?.resultId;
    const detail = await getSubBatchDetail(groupId, run.createdBy);
    const [active] = await db.select().from(batchSyncRuns).where(and(eq(batchSyncRuns.subBatchId, groupId), inArray(batchSyncRuns.status, ['queued', 'running']))).limit(1);
    if (active) { waiting = true; continue; }
    try { await getConfirmedGroup(groupId, run.createdBy); continue; } catch (error) { if (!(error instanceof BatchError)) throw error; }
    if (resultId) {
      const previous = await getBatchSyncRun(resultId, run.createdBy);
      if (previous.run.groupVersion !== detail.group.version) { delete run.checkpoint.operations[key]; await saveCheckpoint(run); resultId = undefined; }
    }
    if (!resultId) {
      const dates = lookupDateRange(run.numberingDate);
      const input = await checkpointInput<Parameters<typeof requestBatchSync>[2]>(run, key, () => ({ operationId: shippingOperationId(run.id, `${key}:${run.checkpoint.lookupAttempt}:${detail.group.version}`), expectedVersion: detail.group.version, startDate: dates.startDate, endDate: dates.exclusiveEndDate, requestBudget: Math.min(1000, Math.max(100, detail.members.length * 8)), maxPages: 20 }));
      const result = await requestBatchSync(boss, groupId, input, run.createdBy); await saveResult(run, key, result.run.id); resultId = result.run.id;
    }
    let result = await getBatchSyncRun(resultId, run.createdBy);
    if (['queued', 'running'].includes(result.run.status)) { waiting = true; continue; }
    if (['partial', 'failed'].includes(result.run.status)) {
      // A manual replacement after a failed sync can satisfy the existing
      // automatic-confirmation gate without repeating successful remote reads.
      const replacementsReady = detail.shipments.every((shipment) => shipment.revision && detail.members.some((member) => member.id === shipment.demandId && member.version === shipment.revision!.demandVersion)) && !detail.issues.some((issue) => issue.severity === 'error');
      const failed = result.items.filter((item) => item.status !== 'completed');
      const manuallyResolved = replacementsReady && failed.every((item) => { const revision = detail.shipments.find((shipment) => shipment.demandId === item.demandId)?.revision; return revision && result.run.completedAt && revision.createdAt > result.run.completedAt; });
      if (manuallyResolved) continue;
      const retryKey = `sync-retry:${groupId}:${run.checkpoint.lookupAttempt}`;
      if (run.checkpoint.lookupAttempt > 0 && !run.checkpoint.operations[retryKey]?.resultId) {
        const input = await checkpointInput<Parameters<typeof retryBatchSync>[2]>(run, retryKey, () => ({ operationId: shippingOperationId(run.id, retryKey), additionalRequestBudget: Math.min(1000 - result.run.requestBudget, Math.max(100, failed.length * 8)) }));
        result = await retryBatchSync(boss, resultId, input, run.createdBy); await saveResult(run, retryKey, result.run.id); waiting = true; continue;
      }
      for (const item of failed) issues.push({ code: item.errorCode ?? result.run.errorCode ?? 'SYNC_FAILED', message: item.errorMessage ?? result.run.errorMessage ?? '货件同步失败，请处理后重试。', groupId, demandId: item.demandId, fba: item.fba });
    }
  }
  if (issues.length) throw new ReviewRequired(issues);
  if (waiting) return false;
  await transition(run, 'confirmation'); return true;
}
async function confirmationStage(run: Run) {
  const issues: ShippingRunIssue[] = [];
  for (const groupId of await runGroupIds(run.id)) {
    try {
      const detail = await getSubBatchDetail(groupId, run.createdBy);
      try { await getConfirmedGroup(groupId, run.createdBy); continue; } catch (error) { if (!(error instanceof BatchError)) throw error; }
      const blocked = detail.issues.filter((issue) => issue.severity === 'error');
      if (blocked.length) { issues.push(...blocked.map((issue) => ({ code: issue.code, message: issue.message, groupId, ...(issue.demandId ? { demandId: issue.demandId } : {}) }))); continue; }
      const key = `confirm:${groupId}`;
      let input = await checkpointInput<ConfirmAndAllocateSubBatchInput>(run, key, async () => {
        const batch = await getWeeklyBatch(detail.group.batchId, run.createdBy);
        return { operationId: shippingOperationId(run.id, `${key}:${detail.group.version}:${batch.batch.version}`), expectedVersion: detail.group.version, expectedBatchVersion: batch.batch.version, expectedDemandVersions: Object.fromEntries(detail.members.map((member) => [member.id, member.version])), expectedShipmentVersions: Object.fromEntries(detail.shipments.flatMap((shipment) => shipment.revision ? [[shipment.demandId, shipment.revision.version]] : [])) };
      });
      for (let attempt = 0; attempt < 5; attempt++) {
        try { await confirmAndAllocateGroup(groupId, input, run.createdBy); break; }
        catch (error) {
          if (!(error instanceof BatchError) || error.code !== 'VERSION_CONFLICT' || attempt === 4) throw error;
          const current = await getSubBatchDetail(groupId, run.createdBy);
          if (current.group.version !== input.expectedVersion) throw error;
          const batch = await getWeeklyBatch(current.group.batchId, run.createdBy);
          input = { ...input, expectedBatchVersion: batch.batch.version, operationId: shippingOperationId(run.id, `${key}:${input.expectedVersion}:${batch.batch.version}`) };
          run.checkpoint.operations[key] = { input }; await saveCheckpoint(run);
        }
      }
    } catch (error) {
      if (error instanceof BatchError) issues.push({ code: error.code, message: error.message, groupId }); else throw error;
    }
  }
  if (issues.length) throw new ReviewRequired(issues);
  const readyIssues = await db.transaction(async (tx) => shippingRunReadinessIssuesInTx(tx, await getShippingRunReportScopeInTx(tx, run.id, run.createdBy)));
  if (readyIssues.length) throw new ReviewRequired(readyIssues);
  await transition(run, 'ready', 'ready'); return true;
}
export async function executeShippingRun(boss: PgBoss, runId: string) {
  const connection = await pool.connect(); let locked = false;
  try {
    const lock = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`shipping-run:${runId}`]); locked = lock.rows[0]?.locked ?? false; if (!locked) return;
    const [run] = await db.select().from(shippingRuns).where(eq(shippingRuns.id, runId)); if (!run || !['queued', 'running'].includes(run.status) || run.lifecycle !== 'active' || run.lifecyclePending) return;
    try {
      await db.transaction((tx) => requireBatchActor(tx, run.createdBy));
      await db.update(shippingRuns).set({ status: 'running', updatedAt: new Date() }).where(and(eq(shippingRuns.id, runId), eq(shippingRuns.lifecycle, 'active'), eq(shippingRuns.lifecyclePending, false)));
      for (let pass = 0; pass < 6; pass++) {
        await db.transaction((tx) => assertLifecycleActiveInTx(tx, 'run', runId));
        let advanced = false;
        if (run.stage === 'lookup') advanced = await lookupStage(boss, run);
        else if (run.stage === 'commit') advanced = await commitStage(run);
        else if (run.stage === 'grouping') advanced = await groupingStage(run);
        else if (run.stage === 'sync') advanced = await syncStage(boss, run);
        else if (run.stage === 'confirmation') advanced = await confirmationStage(run);
        if (!advanced || run.stage === 'ready') break;
      }
    } catch (error) {
      const known = error instanceof BatchError || error instanceof ImportError || error instanceof CatalogError || error instanceof BatchSyncError || error instanceof LingxingReadError;
      const issues = error instanceof ReviewRequired ? error.issues : [{ code: known ? error.code : 'SHIPPING_RUN_FAILED', message: known ? error.message : '发货整理暂未完成，已保存成功步骤，请重试。' }];
      await db.update(shippingRuns).set({ status: error instanceof ReviewRequired || known ? 'needs_review' : 'failed', issues, error: { code: issues[0]!.code, message: issues[0]!.message }, version: sql`${shippingRuns.version}+1`, updatedAt: new Date() }).where(and(eq(shippingRuns.id, runId), eq(shippingRuns.lifecycle, 'active'), eq(shippingRuns.lifecyclePending, false)));
      if (!known && !(error instanceof ReviewRequired)) logError('Shipping organization failed', error);
    }
  } finally { let failed = false; try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`shipping-run:${runId}`]); } catch { failed = true; } finally { connection.release(failed); } }
}
export async function reconcileShippingRuns(boss: PgBoss) {
  for (const record of await activeShippingRuns()) {
    const [job] = record.queueJobId ? await boss.findJobs(SHIPPING_RUN_QUEUE, { id: record.queueJobId }) : [];
    if (job && ['created', 'retry'].includes(job.state)) continue;
    const connection = await pool.connect(); let locked = false;
    try {
      const lock = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`shipping-run:${record.id}`]); locked = lock.rows[0]?.locked ?? false; if (!locked) continue;
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(shippingRuns).where(eq(shippingRuns.id, record.id)).for('update');
        if (!current || current.queueJobId !== record.queueJobId || !['queued', 'running'].includes(current.status) || current.lifecycle !== 'active' || current.lifecyclePending) return;
        await enqueueShippingRunInTx(tx, boss, current.id);
      });
    } finally { let failed = false; try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`shipping-run:${record.id}`]); } catch { failed = true; } finally { connection.release(failed); } }
  }
}
export async function registerShippingRunWorker(boss: PgBoss) {
  await boss.createQueue(SHIPPING_RUN_QUEUE, { retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 0 });
  await boss.work<{ runId: string }>(SHIPPING_RUN_QUEUE, { batchSize: 1 }, async (jobs) => { for (const job of jobs) await executeShippingRun(boss, job.data.runId); });
  const interval = setInterval(() => void reconcileShippingRuns(boss).catch((error) => logError('Shipping run reconciliation failed', error)), 5000); interval.unref();
  return () => clearInterval(interval);
}
