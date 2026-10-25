import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  DemandDetail, DemandRecord, DemandSnapshot, ImportCommitInput, ImportCommitResult, ImportConfirmationContext,
  ImportDiffItem, ImportIssue, ImportPreview, ImportPreviewInput, ImportPreviewPayload, ImportPreviewQuery,
  ImportPreviewResponse, ImportSellerConfirmation, ImportShopResolution, ImportSourceLocation,
} from '@scm/contracts';
import { db } from '../../db/client.js';
import {
  demands, demandRevisions, demandSources, importCommits, importPreviews, operationAudit,
  sourceImports, importParseRuns, sourceImportRows, sellerAliases, sellerMappings, user,
} from '../../db/schema.js';
import { normalizeAlias } from '../seller-mappings/service.js';
import { activeSeller, catalogSettingsView, getCatalogState } from '../seller-mappings/catalog.js';
import { findApprovedSellers } from '../seller-mappings/resolution.js';
import { canImport, ImportError } from './service.js';
import { loadDemandCancellationsInTx } from './demand-lifecycle.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SourceRecord = typeof sourceImports.$inferSelect;
type SourceRow = typeof sourceImportRows.$inferSelect;
type SourceIdentity = Pick<SourceRecord, 'id' | 'originalName'> & Partial<Pick<SourceRecord, 'sourceType'>>;
type DemandBaseline = Pick<typeof demands.$inferSelect, 'id' | 'snapshot' | 'version'>;
type CommittedOrigin = Pick<typeof demandSources.$inferSelect, 'sheetName' | 'rowNumber' | 'demandId' | 'acceptedVersion'>;

export function demandContentFingerprint(snapshot: DemandSnapshot) {
  // Legacy quantity, source aliases and reference dates remain evidence, not demand changes.
  return hashRequest({ channel: snapshot.channel, destinationFc: snapshot.destinationFc,
    notes: snapshot.notes, subBatchName: snapshot.subBatchName,
    destinationAddress: snapshot.destinationAddress ?? null, shipmentCreatedAt: snapshot.shipmentCreatedAt ?? null });
}

function sourceLocation(record: SourceIdentity, row: SourceRow): ImportSourceLocation {
  return { rowId: row.id, parseRunId: row.parseRunId, importId: record.id, fileName: record.originalName,
    sheetName: row.sheetName, rowNumber: row.rowNumber, addresses: row.rawCells.map((cell) => cell.address) };
}

function mappedRow(record: SourceIdentity, row: SourceRow, mapping: ImportSellerConfirmation | undefined, mappingVersion: string | null) {
  const source = sourceLocation(record, row);
  const manual = mappingVersion === 'manual-v1' || mappingVersion === 'online-v1';
  const shopColumn = manual ? 'A' : 'B';
  const fbaColumn = manual ? 'E' : 'F';
  const countryColumn = manual ? 'C' : 'D';
  const issues: ImportIssue[] = row.issues.filter((issue) => !['SOURCE_MAPPING_REQUIRED', 'SELLER_ALIAS_CONFLICT', 'SELLER_COUNTRY_MISMATCH', 'COUNTRY_MISMATCH', 'DUPLICATE_SHIPMENT'].includes(issue.code)).map((issue) => {
    if (issue.address) return issue;
    const column = issue.code === 'SHOP_REQUIRED' ? shopColumn : ['FBA_REQUIRED', 'MISSING_FBA', 'INVALID_FBA'].includes(issue.code) ? fbaColumn : issue.column;
    return column ? { ...issue, column, address: `${column}${row.rowNumber}` } : issue;
  });
  if (row.normalized.shop && !mapping) issues.push({ code: 'IMPORT_SELLER_CONFIRMATION_REQUIRED', severity: 'error', message: '请为本次导入明确确认来源名称对应的店铺和国家。', column: shopColumn, address: `${shopColumn}${row.rowNumber}` });
  if (mapping && row.normalized.country && normalizeAlias(row.normalized.country) !== normalizeAlias(mapping.country)) {
    issues.push({ code: 'COUNTRY_MISMATCH', severity: 'error', message: '来源国家与本次确认的店铺国家不一致。', column: countryColumn, address: `${countryColumn}${row.rowNumber}` });
  }
  let metadataSource = record.sourceType === 'online' ? row.normalized.metadataSource ?? 'online' : 'file';
  const lookupSid = /(?:^|:)sid=(\d+)$/.exec(metadataSource)?.[1];
  if (lookupSid && mapping && Number(lookupSid) !== mapping.sid) {
    issues.push({ code: 'LOOKUP_SHOP_REASSIGNED', severity: 'warning', message: '本次确认店铺与原 FBA 查询店铺不同，地址和创建时间按人工来源保留，请核对。' });
    metadataSource = 'online';
  }
  const after: DemandSnapshot | null = mapping && row.normalized.fba ? {
    sid: mapping.sid, fba: row.normalized.fba.trim().toUpperCase(), shop: row.normalized.shop!, country: mapping.country,
    channel: row.normalized.channel, destinationFc: row.normalized.destinationFc, referenceQuantity: row.normalized.referenceQuantity,
    notes: row.normalized.notes, subBatchName: row.normalized.subBatchName,
    destinationAddress: row.normalized.destinationAddress ?? null, shipmentCreatedAt: row.normalized.shipmentCreatedAt ?? null,
    sourceFilledAt: row.normalized.sourceFilledAt ?? row.normalized.sourceDate ?? null,
    metadataSource, metadataObservedAt: metadataSource.includes('lingxing:') ? row.normalized.metadataObservedAt ?? null : null,
  } : null;
  return { row, source, issues, after, mapping };
}

function previewCounts(items: ImportDiffItem[]): ImportPreview['counts'] {
  const counts: ImportPreview['counts'] = { new: 0, unchanged: 0, changed: 0, conflict: 0, error: 0, missing: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

export function deriveImportDiffItems(input: {
  source: SourceIdentity; rows: SourceRow[]; mappingVersion: string | null;
  mappings: ImportSellerConfirmation[]; demands: DemandBaseline[]; committedOrigins: CommittedOrigin[];
  cancelledDemandIds?: string[];
}): ImportDiffItem[] {
  const mappings = new Map(input.mappings.map((mapping) => [normalizeAlias(mapping.sourceShop), mapping]));
  const existing = new Map(input.demands.map((demand) => [shipmentKey(demand.snapshot.sid, demand.snapshot.fba), demand]));
  const origins = new Map(input.committedOrigins.map((origin) => [originKey(origin), origin]));
  const cancelled = new Set(input.cancelledDemandIds);
  const items: ImportDiffItem[] = [];
  const groups = new Map<string, ReturnType<typeof mappedRow>[]>();
  for (const row of input.rows) {
    const derived = mappedRow(input.source, row, row.normalized.shop ? mappings.get(normalizeAlias(row.normalized.shop)) : undefined, input.mappingVersion);
    const demand = derived.after ? existing.get(shipmentKey(derived.after.sid, derived.after.fba)) : undefined;
    if (!derived.after) {
      items.push({ id: randomUUID(), kind: 'error', selectable: false, sid: null,
        fba: row.normalized.fba, demandId: demand?.id ?? null, expectedDemandVersion: demand?.version ?? 0,
        before: demand?.snapshot ?? null, after: derived.after, sources: [derived.source], issues: derived.issues, alreadyCommitted: false });
      continue;
    }
    const key = shipmentKey(derived.after.sid, derived.after.fba);
    groups.set(key, [...groups.get(key) ?? [], derived]);
  }
  for (const [key, group] of groups) {
    const after = group[0]!.after!;
    const demand = existing.get(key);
    const linked = group.map((entry) => origins.get(originKey(entry.row))).filter((entry) => entry !== undefined);
    const issues = group.flatMap((entry) => entry.issues);
    const sources = group.map((entry) => entry.source);
    const base = { id: randomUUID(), sid: after.sid, fba: after.fba, demandId: demand?.id ?? null,
      expectedDemandVersion: demand?.version ?? 0, before: demand?.snapshot ?? null, after, sources, issues, alreadyCommitted: false };
    if (demand && cancelled.has(demand.id)) {
      items.push({ ...base, kind: 'error', selectable: false,
        issues: [...issues, { code: 'DEMAND_CANCELLED', severity: 'error', message: '需求已取消，不能通过重新导入恢复；请在需求列表查看取消记录。' }] });
    } else if (issues.some((issue) => issue.severity === 'error')) {
      items.push({ ...base, kind: 'error', selectable: false });
    } else if (new Set(group.map((entry) => demandContentFingerprint(entry.after!))).size > 1) {
      items.push({ ...base, kind: 'conflict', selectable: false, issues: [...issues, { code: 'CONFLICTING_SHIPMENT_ROWS', severity: 'error', message: '同一店铺及 FBA 的来源行内容不一致，全部保留；请核对源文件后重新导入。' }] });
    } else if (linked.some((origin) => origin.demandId !== demand?.id)) {
      items.push({ ...base, kind: 'conflict', selectable: false, issues: [...issues, { code: 'SOURCE_ALREADY_COMMITTED', severity: 'error', message: '来源行已经关联其他需求，重新解析不能更改其店铺或 FBA。' }] });
    } else if (linked.length === group.length) {
      const acceptedVersions = [...new Set(linked.map((origin) => origin.acceptedVersion))].sort((left, right) => left - right).join('、');
      items.push({ ...base, kind: 'unchanged', selectable: false, alreadyCommitted: true,
        issues: [...issues, { code: 'SOURCE_ALREADY_COMMITTED', severity: 'warning', message: `这些来源行已在需求第 ${acceptedVersions} 版接受，重复确认不会重新应用旧内容。` }] });
    } else {
      items.push({ ...base, kind: !demand ? 'new' : demandContentFingerprint(demand.snapshot) === demandContentFingerprint(after) ? 'unchanged' : 'changed', selectable: true });
    }
  }
  return items.sort((left, right) => left.sources[0]!.rowNumber - right.sources[0]!.rowNumber);
}

async function requireCurrentRun(tx: Tx, record: SourceRecord, parseRunId: string, expectedVersion: number) {
  if (record.version !== expectedVersion || record.latestRunId !== parseRunId) throw new ImportError('VERSION_CONFLICT', 409, '解析版本已经变化，请刷新后重新预览。');
  const [run] = await tx.select().from(importParseRuns).where(and(eq(importParseRuns.id, parseRunId), eq(importParseRuns.importId, record.id)));
  if (!run || run.status !== 'completed' || record.status !== 'preview_ready') throw new ImportError('IMPORT_NOT_READY', 409, '当前解析尚未生成可提交预览。');
  return run;
}

function paginatePreview(payload: ImportPreviewPayload, query: ImportPreviewQuery): ImportPreviewResponse {
  const items = query.kind ? payload.items.filter((item) => item.kind === query.kind) : payload.items;
  return { preview: payload.preview, items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
    total: items.length, page: query.page, pageSize: query.pageSize };
}

export async function createImportPreview(importId: string, input: ImportPreviewInput, actorId: string): Promise<ImportPreviewResponse> {
  return db.transaction(async (tx) => {
    const record = await getConfirmationImport(tx, importId, actorId, true);
    const run = await requireCurrentRun(tx, record, input.parseRunId, input.expectedVersion);
    const catalog = await getCatalogState(tx, true);
    if (catalog.version !== input.expectedCatalogSettingsVersion || catalog.catalogVersion !== input.expectedCatalogVersion) throw new ImportError('SELLER_CATALOG_CONFLICT', 409, '店铺数据源或目录已变化，请刷新并重新确认。');
    const rows = await tx.select().from(sourceImportRows).where(eq(sourceImportRows.parseRunId, run.id)).orderBy(asc(sourceImportRows.rowNumber));
    const shops = new Set(rows.flatMap((row) => row.normalized.shop ? [normalizeAlias(row.normalized.shop)] : []));
    const selectedShops = input.sellerSelections.map((selection) => normalizeAlias(selection.sourceShop));
    if (new Set(selectedShops).size !== selectedShops.length || selectedShops.some((shop) => !shops.has(shop))) throw new ImportError('VALIDATION_ERROR', 422, '本次店铺确认包含重复或不存在的来源名称。');
    const mappingIds = [...new Set(input.sellerSelections.map((selection) => selection.sellerMappingId))].sort();
    const candidates = mappingIds.length ? await tx.select().from(sellerMappings).where(inArray(sellerMappings.id, mappingIds)).orderBy(asc(sellerMappings.id)).for('share') : [];
    const createdAt = new Date();
    const mappings: ImportSellerConfirmation[] = input.sellerSelections.map((selection) => {
      const storedCandidate = candidates.find((mapping) => mapping.id === selection.sellerMappingId);
      const candidate = storedCandidate ? activeSeller(storedCandidate, catalog.mode) : null;
      if (!candidate || candidate.status === 'disabled' || candidate.version !== selection.expectedVersion) throw new ImportError('MAPPING_VERSION_CONFLICT', 409, '所选店铺已变更或停用，请刷新店铺和国家后重新确认。');
      return { ...selection, sid: candidate.sid, name: candidate.name, country: candidate.country, confirmedBy: actorId, confirmedAt: createdAt.toISOString() };
    });
    const sids = [...new Set(mappings.map((mapping) => mapping.sid))];
    const existing = sids.length ? await tx.select().from(demands).where(inArray(demands.sid, sids)) : [];
    const cancellations = await loadDemandCancellationsInTx(tx, existing.map((demand) => demand.id));
    const origins = await tx.select().from(demandSources).where(eq(demandSources.importId, importId));
    const items = deriveImportDiffItems({ source: record, rows, mappingVersion: run.mappingVersion, mappings, demands: existing,
      committedOrigins: origins, cancelledDemandIds: [...cancellations.keys()] });
    if (input.baselineImportId) {
      if (input.baselineImportId === importId) throw new ImportError('VALIDATION_ERROR', 422, '缺失比较必须选择其他历史导入。');
      await getConfirmationImport(tx, input.baselineImportId, actorId);
      const baseline = await tx.select({ source: demandSources, demand: demands }).from(demandSources).innerJoin(demands, eq(demandSources.demandId, demands.id)).where(eq(demandSources.importId, input.baselineImportId));
      const present = new Set(items.flatMap((item) => item.sid && item.fba ? [shipmentKey(item.sid, item.fba)] : []));
      // An unresolved current identity may be any baseline shipment. Wait for
      // explicit seller confirmation instead of reporting that shipment absent.
      const unresolvedIdentity = items.some((item) => item.fba && item.sid === null);
      const missing = new Map<string, typeof baseline>();
      for (const entry of baseline) {
        const key = shipmentKey(entry.demand.sid, entry.demand.fba);
        if (!unresolvedIdentity && !present.has(key)) missing.set(key, [...missing.get(key) ?? [], entry]);
      }
      for (const group of missing.values()) {
        const demand = group[0]!.demand;
        items.push({ id: randomUUID(), kind: 'missing', selectable: false, sid: demand.sid, fba: demand.fba, demandId: demand.id,
          expectedDemandVersion: demand.version, before: demand.snapshot, after: null, sources: group.map((entry) => entry.source.location),
          issues: [{ code: 'SOURCE_ROW_MISSING', severity: 'warning', message: '此需求未出现在本次已确认的输入范围中；只作提示，不撤销或移动既有需求。' }], alreadyCommitted: false });
      }
    }
    const preview: ImportPreview = { id: randomUUID(), importId, parseRunId: run.id, importVersion: record.version,
      sellerCatalogMode: catalog.mode as ImportPreview['sellerCatalogMode'], sellerCatalogSettingsVersion: catalog.version, sellerCatalogVersion: catalog.catalogVersion,
      mappings, baselineImportId: input.baselineImportId ?? null, createdAt: createdAt.toISOString(), createdBy: actorId, counts: previewCounts(items),
      selectableItemIds: items.filter((item) => item.selectable).map((item) => item.id), changedItemIds: items.filter((item) => item.kind === 'changed').map((item) => item.id) };
    const payload = { preview, items };
    await tx.insert(importPreviews).values({ id: preview.id, importId, parseRunId: run.id, importVersion: record.version, createdBy: actorId, payload, createdAt });
    return paginatePreview(payload, { page: 1, pageSize: 20 });
  });
}

async function loadPreview(tx: Tx, importId: string, previewId: string) {
  const [preview] = await tx.select().from(importPreviews).where(and(eq(importPreviews.id, previewId), eq(importPreviews.importId, importId)));
  if (!preview) throw new ImportError('NOT_FOUND', 404, '差异预览不存在。');
  return preview;
}

export async function getImportPreview(importId: string, previewId: string, actorId: string, query: ImportPreviewQuery): Promise<ImportPreviewResponse> {
  return db.transaction(async (tx) => {
    await getConfirmationImport(tx, importId, actorId);
    return paginatePreview((await loadPreview(tx, importId, previewId)).payload, query);
  }, { isolationLevel: 'repeatable read' });
}

export async function commitImport(importId: string, input: ImportCommitInput, actorId: string): Promise<ImportCommitResult> {
  if (new Set(input.selectedItemIds).size !== input.selectedItemIds.length || new Set(input.confirmedChangedItemIds).size !== input.confirmedChangedItemIds.length) throw new ImportError('VALIDATION_ERROR', 422, '提交范围不能包含重复项目。');
  const requestHash = hashRequest({ actorId, importId, previewId: input.previewId,
    selectedItemIds: [...input.selectedItemIds].sort(), confirmedChangedItemIds: [...input.confirmedChangedItemIds].sort() });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
    await requireConfirmationActor(tx, actorId);
    const [previous] = await tx.select().from(importCommits).where(eq(importCommits.operationId, input.operationId));
    if (previous) {
      if (previous.actorUserId !== actorId || previous.requestHash !== requestHash) throw new ImportError('OPERATION_CONFLICT', 409, '操作编号已经用于其他提交请求。');
      return { ...previous.result, replayed: true };
    }
    const record = await getConfirmationImport(tx, importId, actorId, true);
    const stored = await loadPreview(tx, importId, input.previewId);
    const { preview } = stored.payload;
    if (preview.createdBy !== actorId) throw new ImportError('FORBIDDEN', 403, '请使用当前账号重新确认店铺并生成预览。');
    await requireCurrentRun(tx, record, preview.parseRunId, preview.importVersion);
    const catalog = await getCatalogState(tx, true);
    if (preview.sellerCatalogMode !== catalog.mode || preview.sellerCatalogSettingsVersion !== catalog.version || preview.sellerCatalogVersion !== catalog.catalogVersion) throw new ImportError('SELLER_CATALOG_CONFLICT', 409, '店铺数据源或目录已变化，请刷新并重新确认。');
    const selectedSet = new Set(input.selectedItemIds);
    const selected = stored.payload.items.filter((item) => selectedSet.has(item.id));
    const knownItemIds = new Set(stored.payload.items.map((item) => item.id));
    const unknownItemIds = input.selectedItemIds.filter((id) => !knownItemIds.has(id));
    const invalidItems = selected.filter((item) => !item.selectable || !item.after || !['new', 'unchanged', 'changed'].includes(item.kind));
    if (unknownItemIds.length || invalidItems.length) throw new ImportError('VALIDATION_ERROR', 422, '提交范围包含不存在、错误或冲突项目。', {
      unknownItemIds, items: invalidItems.map((item) => ({ itemId: item.id, kind: item.kind, sources: item.sources, issues: item.issues })),
    });
    const changedSet = new Set(input.confirmedChangedItemIds);
    const changed = selected.filter((item) => item.kind === 'changed');
    const missingChanges = changed.filter((item) => !changedSet.has(item.id));
    const unexpectedChangedItemIds = [...changedSet].filter((id) => !changed.some((item) => item.id === id));
    if (missingChanges.length || unexpectedChangedItemIds.length) throw new ImportError('CHANGE_CONFIRMATION_REQUIRED', 422, '请逐项确认本次选中需求的变化。', {
      missingChangedItemIds: missingChanges.map((item) => item.id), unexpectedChangedItemIds,
      items: missingChanges.map((item) => ({ itemId: item.id, sources: item.sources })),
    });
    const sourceIds = selected.flatMap((item) => item.sources.map((source) => source.rowId));
    const rows = sourceIds.length ? await tx.select().from(sourceImportRows).where(and(eq(sourceImportRows.parseRunId, preview.parseRunId), inArray(sourceImportRows.id, sourceIds))) : [];
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    if (new Set(sourceIds).size !== sourceIds.length || rows.length !== sourceIds.length) throw new ImportError('VERSION_CONFLICT', 409, '所选来源行已经失效，请重新预览。');
    const sourceShops = new Set(rows.flatMap((row) => row.normalized.shop ? [normalizeAlias(row.normalized.shop)] : []));
    const mappings = preview.mappings.filter((mapping) => sourceShops.has(normalizeAlias(mapping.sourceShop)));
    const mappingMap = new Map(mappings.map((mapping) => [normalizeAlias(mapping.sourceShop), mapping]));
    const mappingIds = [...new Set(mappings.map((mapping) => mapping.sellerMappingId))].sort();
    const currentMappings = mappingIds.length ? await tx.select().from(sellerMappings).where(inArray(sellerMappings.id, mappingIds)).orderBy(asc(sellerMappings.id)).for('share') : [];
    for (const mapping of mappings) {
      const storedCurrent = currentMappings.find((candidate) => candidate.id === mapping.sellerMappingId);
      const current = storedCurrent ? activeSeller(storedCurrent, catalog.mode) : null;
      if (!current || current.status === 'disabled' || current.version !== mapping.expectedVersion || current.sid !== mapping.sid || current.country !== mapping.country) throw new ImportError('MAPPING_VERSION_CONFLICT', 409, '所选店铺和国家已经变化，请重新确认并预览。');
    }
    const keys = [...new Set(selected.map((item) => shipmentKey(item.after!.sid, item.after!.fba)))].sort();
    for (const key of keys) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`demand:${key}`}, 0))`);
    const sids = [...new Set(selected.map((item) => item.after!.sid))];
    const existingDemands = await tx.select().from(demands).where(inArray(demands.sid, sids));
    const demandMap = new Map(existingDemands.map((demand) => [shipmentKey(demand.sid, demand.fba), demand]));
    const cancellations = await loadDemandCancellationsInTx(tx, existingDemands.map((demand) => demand.id));
    const existingSources = await tx.select().from(demandSources).where(eq(demandSources.importId, importId));
    const origins = new Map(existingSources.map((source) => [originKey(source), source]));
    const createdAt = new Date();
    const results: ImportCommitResult['items'] = [];
    const counts: ImportCommitResult['counts'] = { created: 0, updated: 0, linked: 0, alreadyCommitted: 0 };
    for (const item of selected) {
      const after = item.after!;
      const current = demandMap.get(shipmentKey(after.sid, after.fba));
      if (current && cancellations.has(current.id)) throw new ImportError('DEMAND_CANCELLED', 409, '需求已取消，不能通过重新导入恢复；请重新预览并排除此需求。', {
        itemId: item.id, sources: item.sources, currentDemandId: current.id, currentDemandVersion: current.version,
      });
      const linkedSources = item.sources.map((source) => origins.get(originKey(source)));
      if (linkedSources.some((source) => source && source.demandId !== current?.id)) throw new ImportError('SOURCE_ALREADY_COMMITTED', 409, '来源行已经提交到其他需求，不能通过重新解析更改其关联。');
      if (linkedSources.every((source) => source !== undefined)) {
        results.push({ itemId: item.id, demandId: current!.id, version: current!.version, action: 'already_committed', sources: item.sources });
        counts.alreadyCommitted += 1;
        continue;
      }
      if ((current?.version ?? 0) !== item.expectedDemandVersion || (current?.id ?? null) !== item.demandId) throw new ImportError('DEMAND_VERSION_CONFLICT', 409, '所选需求已被其他提交更新，请重新预览差异。', {
        itemId: item.id, sources: item.sources, currentDemandId: current?.id ?? null, currentDemandVersion: current?.version ?? 0,
      });
      let demandId: string;
      let version: number;
      let action: ImportCommitResult['items'][number]['action'];
      if (!current) {
        demandId = randomUUID(); version = 1; action = 'created';
        await tx.insert(demands).values({ id: demandId, sid: after.sid, fba: after.fba, snapshot: after, version,
          businessDate: record.businessDate, weekStartDate: record.weekStartDate, weekEndDate: record.weekEndDate, createdAt, updatedAt: createdAt });
        await tx.insert(demandRevisions).values({ id: randomUUID(), demandId, version, snapshot: after, createdBy: actorId, createdAt });
        counts.created += 1;
      } else if (demandContentFingerprint(current.snapshot) !== demandContentFingerprint(after)) {
        if (item.kind !== 'changed' || !changedSet.has(item.id)) throw new ImportError('DEMAND_VERSION_CONFLICT', 409, '需求内容与预览不一致，请重新预览并确认。', {
          itemId: item.id, sources: item.sources, currentDemandId: current.id, currentDemandVersion: current.version,
        });
        demandId = current.id; version = current.version + 1; action = 'updated';
        const [updated] = await tx.update(demands).set({ snapshot: after, version, updatedAt: createdAt }).where(and(eq(demands.id, demandId), eq(demands.version, current.version))).returning({ id: demands.id });
        if (!updated) {
          const [latest] = await tx.select({ id: demands.id, version: demands.version }).from(demands).where(eq(demands.id, demandId));
          throw new ImportError('DEMAND_VERSION_CONFLICT', 409, '所选需求版本已经变化。', {
            itemId: item.id, sources: item.sources, currentDemandId: latest?.id ?? null, currentDemandVersion: latest?.version ?? 0,
          });
        }
        await tx.insert(demandRevisions).values({ id: randomUUID(), demandId, version, snapshot: after, createdBy: actorId, createdAt });
        counts.updated += 1;
      } else {
        demandId = current.id; version = current.version; action = 'linked'; counts.linked += 1;
      }
      const newSources = item.sources.filter((source) => !origins.has(originKey(source))).map((source) => {
        const row = rowMap.get(source.rowId)!;
        const mapping = row.normalized.shop ? mappingMap.get(normalizeAlias(row.normalized.shop)) : undefined;
        if (!mapping || mapping.sid !== after.sid || row.sheetName !== source.sheetName || row.rowNumber !== source.rowNumber) throw new ImportError('VERSION_CONFLICT', 409, '来源与店铺确认快照不一致，请重新预览。');
        return { id: randomUUID(), demandId, acceptedVersion: version, importId, parseRunId: preview.parseRunId,
          sourceRowId: source.rowId, sheetName: source.sheetName, rowNumber: source.rowNumber, location: source, mapping, createdBy: actorId, createdAt };
      });
      for (let start = 0; start < newSources.length; start += 100) await tx.insert(demandSources).values(newSources.slice(start, start + 100));
      results.push({ itemId: item.id, demandId, version, action, sources: item.sources });
    }
    const result: ImportCommitResult = { operationId: input.operationId, importId, previewId: preview.id,
      createdAt: createdAt.toISOString(), createdBy: actorId, items: results, counts, replayed: false };
    await tx.insert(importCommits).values({ operationId: input.operationId, importId, previewId: preview.id, actorUserId: actorId, requestHash, result, createdAt });
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'source_import.commit', targetId: importId, actorUserId: actorId, requestHash,
      details: { operationId: input.operationId, previewId: preview.id, created: String(counts.created), updated: String(counts.updated), linked: String(counts.linked), alreadyCommitted: String(counts.alreadyCommitted) } });
    return result;
  });
}

export async function listImportCommits(importId: string, actorId: string) {
  return db.transaction(async (tx) => {
    await getConfirmationImport(tx, importId, actorId);
    const commits = await tx.select().from(importCommits).where(eq(importCommits.importId, importId)).orderBy(desc(importCommits.createdAt), desc(importCommits.operationId)).limit(100);
    return { items: commits.map((commit) => commit.result) };
  });
}

type ResolutionSeller = { id: string; sid: number; name: string; country: string; status: string; version: number; aliases: string[] };
type ResolutionRow = Pick<SourceRow, 'normalized'>;

export function resolveImportShop(input: {
  sourceShop: string; sourceType?: string; rows: ResolutionRow[]; sellers: ResolutionSeller[];
}): ImportShopResolution {
  const unresolved = { sellerMappingId: null, expectedVersion: null };
  if (!normalizeAlias(input.sourceShop)) return { ...unresolved, status: 'unmatched', reason: 'not_found' };
  // Only online sources contain metadata generated after server-side lookup
  // validation. Uploaded workbook text must never become identity evidence.
  const lookupSids = new Set(input.sourceType === 'online' ? input.rows.flatMap((row) => {
    const match = /^(?:online\+)?lingxing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:sid=([1-9]\d*)$/i.exec(row.normalized.metadataSource ?? '');
    const sid = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(sid) ? [sid] : [];
  }) : []);
  if (lookupSids.size > 1) return { ...unresolved, status: 'ambiguous', reason: 'conflicting_lookup_sids' };
  const lookupSid = [...lookupSids][0];
  const matches = lookupSid !== undefined
    ? input.sellers.filter((seller) => seller.sid === lookupSid && seller.status !== 'disabled')
    : findApprovedSellers(input.sourceShop, input.sellers);
  if (!matches.length) return { ...unresolved, status: 'unmatched', reason: 'not_found' };
  if (matches.length !== 1) return { ...unresolved, status: 'ambiguous', reason: 'multiple_matches' };
  const seller = matches[0]!;
  if (input.rows.some((row) => row.normalized.country && normalizeAlias(row.normalized.country) !== normalizeAlias(seller.country))) {
    return { ...unresolved, status: 'ambiguous', reason: 'country_mismatch' };
  }
  return { status: 'unique', sellerMappingId: seller.id, expectedVersion: seller.version, reason: lookupSid !== undefined ? 'fba_lookup' : 'name_alias' };
}

export async function getConfirmationContext(importId: string, actorId: string): Promise<ImportConfirmationContext> {
  return db.transaction(async (tx) => {
    const record = await getConfirmationImport(tx, importId, actorId);
    const catalog = await getCatalogState(tx, true);
    const rows = record.latestRunId ? await tx.select().from(sourceImportRows).where(eq(sourceImportRows.parseRunId, record.latestRunId)).orderBy(asc(sourceImportRows.rowNumber)) : [];
    const origins = await tx.select().from(demandSources).where(eq(demandSources.importId, importId));
    const committed = new Set(origins.map(originKey));
    const shops = new Map<string, { sourceShop: string; countries: Set<string>; rowCount: number; rows: SourceRow[] }>();
    for (const row of rows) if (row.normalized.shop) {
      const key = normalizeAlias(row.normalized.shop);
      const shop = shops.get(key) ?? { sourceShop: row.normalized.shop, countries: new Set<string>(), rowCount: 0, rows: [] };
      shop.rowCount += 1;
      shop.rows.push(row);
      if (row.normalized.country) shop.countries.add(row.normalized.country);
      shops.set(key, shop);
    }
    const sellerRows = await tx.select().from(sellerMappings).orderBy(asc(sellerMappings.sid));
    const aliases = await tx.select().from(sellerAliases);
    const aliasesBySeller = new Map<string, string[]>();
    for (const alias of aliases) aliasesBySeller.set(alias.sellerMappingId, [...aliasesBySeller.get(alias.sellerMappingId) ?? [], alias.alias]);
    const sellers = sellerRows.flatMap((row) => { const current = activeSeller(row, catalog.mode); return current ? [{ id: current.id, sid: current.sid, name: current.name, country: current.country, status: current.status, version: current.version, aliases: aliasesBySeller.get(current.id) ?? [] }] : []; });
    const [latest] = record.latestRunId ? await tx.select({ id: importPreviews.id, payload: importPreviews.payload }).from(importPreviews).where(and(eq(importPreviews.importId, importId), eq(importPreviews.parseRunId, record.latestRunId), eq(importPreviews.importVersion, record.version), eq(importPreviews.createdBy, actorId), sql`${importPreviews.payload}->'preview'->>'sellerCatalogSettingsVersion' = ${String(catalog.version)}`, sql`${importPreviews.payload}->'preview'->>'sellerCatalogVersion' = ${String(catalog.catalogVersion)}`)).orderBy(desc(importPreviews.createdAt), desc(importPreviews.id)).limit(1) : [];
    const baselines = await tx.select({ id: sourceImports.id, originalName: sourceImports.originalName, businessDate: sourceImports.businessDate })
      .from(sourceImports).where(sql`${sourceImports.id} <> ${importId} AND EXISTS (SELECT 1 FROM demand_source ds WHERE ds.import_id = ${sourceImports.id})`).orderBy(desc(sourceImports.importedAt), desc(sourceImports.id)).limit(100);
    const submittedSourceRows = rows.filter((row) => committed.has(originKey(row))).length;
    const confirmableOrigins = latest ? latest.payload.items.filter((item) => ['new', 'unchanged', 'changed'].includes(item.kind)).flatMap((item) => item.sources.map(originKey))
      : rows.filter((row) => row.status !== 'error').map(originKey);
    return { shops: [...shops.values()].map(({ rows: shopRows, ...shop }) => ({ ...shop, countries: [...shop.countries].sort(),
      resolution: resolveImportShop({ sourceShop: shop.sourceShop, sourceType: record.sourceType, rows: shopRows, sellers }) })),
      sellers: sellers.map((seller) => ({ id: seller.id, sid: seller.sid, name: seller.name, country: seller.country, version: seller.version,
        status: seller.status as ImportConfirmationContext['sellers'][number]['status'] })),
      catalog: catalogSettingsView(catalog), latestPreviewId: latest?.id ?? null, submittedSourceRows, totalSourceRows: rows.length,
      status: !submittedSourceRows ? 'not_submitted' : confirmableOrigins.every((origin) => committed.has(origin)) ? 'submitted' : 'partially_submitted', baselines };
  }, { isolationLevel: 'repeatable read' });
}

function serializeDemand(demand: typeof demands.$inferSelect): DemandRecord {
  return { id: demand.id, snapshot: demand.snapshot, version: demand.version, businessDate: demand.businessDate,
    weekStartDate: demand.weekStartDate, weekEndDate: demand.weekEndDate, createdAt: demand.createdAt.toISOString(), updatedAt: demand.updatedAt.toISOString() };
}

export async function getDemandDetail(demandId: string, actorId: string): Promise<Omit<DemandDetail, 'management' | 'operations'>> {
  return db.transaction(async (tx) => {
    await requireConfirmationActor(tx, actorId);
    const [demand] = await tx.select().from(demands).where(eq(demands.id, demandId));
    if (!demand) throw new ImportError('NOT_FOUND', 404, '需求不存在。');
    const revisions = await tx.select().from(demandRevisions).where(eq(demandRevisions.demandId, demandId)).orderBy(desc(demandRevisions.version));
    const sources = await tx.select().from(demandSources).where(eq(demandSources.demandId, demandId)).orderBy(desc(demandSources.createdAt), desc(demandSources.id));
    return { demand: serializeDemand(demand), revisions: revisions.map((revision) => ({ version: revision.version, snapshot: revision.snapshot, createdBy: revision.createdBy, createdAt: revision.createdAt.toISOString() })),
      sources: sources.map((source) => ({ source: source.location, acceptedVersion: source.acceptedVersion, createdBy: source.createdBy, createdAt: source.createdAt.toISOString(), mapping: source.mapping })) };
  }, { isolationLevel: 'repeatable read' });
}

export async function getImportPreviewCsv(importId: string, previewId: string, actorId: string) {
  return db.transaction(async (tx) => {
    await getConfirmationImport(tx, importId, actorId);
    const { payload } = await loadPreview(tx, importId, previewId);
    const lines: unknown[][] = [['文件', '工作表', '行号', '单元格', '分类', '错误级别', '错误代码', '说明']];
    for (const item of payload.items) for (const source of item.sources) for (const issue of item.issues) {
      const addressRow = issue.address ? /\d+$/.exec(issue.address)?.[0] : undefined;
      if (addressRow && Number(addressRow) !== source.rowNumber) continue;
      lines.push([source.fileName, source.sheetName, source.rowNumber, issue.address ?? issue.column ?? '', item.kind, issue.severity, issue.code, issue.message]);
    }
    return `\uFEFF${lines.map((line) => line.map(confirmationCsvCell).join(',')).join('\r\n')}\r\n`;
  }, { isolationLevel: 'repeatable read' });
}

async function requireConfirmationActor(tx: Tx, actorId: string) {
  const [actor] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
  if (!actor || actor.banned || !canImport(actor.role)) throw new ImportError('FORBIDDEN', 403, '当前账号没有需求确认权限。');
}

async function getConfirmationImport(tx: Tx, importId: string, actorId: string, lock = false) {
  await requireConfirmationActor(tx, actorId);
  const query = tx.select().from(sourceImports).where(eq(sourceImports.id, importId));
  const [record] = await (lock ? query.for('update') : query);
  if (!record) throw new ImportError('NOT_FOUND', 404, '导入记录不存在。');
  return record;
}

function originKey(row: Pick<SourceRow, 'sheetName' | 'rowNumber'>) {
  return JSON.stringify([row.sheetName, row.rowNumber]);
}

function shipmentKey(sid: number, fba: string) {
  return JSON.stringify([sid, fba]);
}

function hashRequest(input: unknown) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function confirmationCsvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  const first = [...text].find((character) => character.charCodeAt(0) > 32 && character.trim() !== '');
  if ((first && '=+-@'.includes(first)) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
