import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type { ReportExportInput, ReportExportRecord, ReportReference, ShipmentReport, ShipmentReportBox, ShipmentReportRow } from '@scm/contracts';
import { db, pool } from '../../db/client.js';
import { fileIndex, operationAudit, user } from '../../db/schema.js';
import { readConfig } from '../../config.js';
import { storeImmutableFile, type NewFileIndex, type StoreFileInput } from '../../file-store.js';
import { checkedFileBytes } from '../imports/service.js';
import { batchExports } from './export-schema.js';
import { subBatches, weeklyBatches } from './schema.js';
import { BatchError, freezeGroupForExport, getConfirmedGroup, getConfirmedGroupInTx, lockBatchRunScopesInTx, type BatchTx } from './service.js';
import { createReportWorkbook, reportRegion } from './workbook.js';
import { productKey } from './validation.js';
import { sortReportBoxes, sortReportRows } from './report-order.js';
import { getReadyShippingRunInTx, getShippingRunReportScopeInTx } from '../shipping-runs/service.js';
import { shippingRuns, shippingTicketMembers, shippingTickets } from '../shipping-runs/schema.js';

export const EXPORT_QUEUE = 'shipment-export';
export type ReportFilter = { shippingRunId?: string; month?: string; weekStartDate?: string; weeklyBatchId?: string; subBatchId?: string; sid?: number; country?: string; channel?: string; region?: 'US' | 'EU' | 'all'; q?: string; page?: number; pageSize?: number };
export type ShippingReportScope = {
  shippingRunId: string; version: number; numberingDate: string; month: string; sequence: number | null;
  allowIncomplete?: boolean;
  members: Array<{ demandId: string; groupId: string; ticketId: string; ticketNumber: string; sourceTicketIndex: number; inputOrder: number }>;
};
type Confirmed = Awaited<ReturnType<typeof getConfirmedGroup>> & { shippingDetails?: Record<string,{runId:string;month:string;sequence:number|null;ticketNumber:string|null}> };
async function withShippingDetails(tx:BatchTx,groups:Confirmed[]):Promise<Confirmed[]> {
  if(!groups.length)return groups;
  const members=await tx.select({member:shippingTicketMembers,run:shippingRuns,ticket:shippingTickets}).from(shippingTicketMembers).innerJoin(shippingRuns,eq(shippingRuns.id,shippingTicketMembers.runId)).innerJoin(shippingTickets,eq(shippingTickets.id,shippingTicketMembers.ticketId)).where(inArray(shippingTicketMembers.groupId,groups.map((bundle)=>bundle.group.id)));
  return groups.map((bundle)=>({...bundle,shippingDetails:Object.fromEntries(members.filter(({member})=>member.groupId===bundle.group.id&&member.demandId).map(({member,run,ticket})=>[member.demandId!,{runId:run.id,month:run.month,sequence:run.sequence,ticketNumber:ticket.number}]))}));
}
const integer = (value: string | null | undefined) => { if (value === null || value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BatchError('INVALID_QUANTITY', 422, '数量无法安全写入 XLSX，请核对商品数据。'); return Number(value); };
const measure = (value: string | null | undefined) => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const safeSum = (left: number, right: number) => { const sum = left + right; if (!Number.isSafeInteger(sum)) throw new BatchError('INVALID_QUANTITY', 422, '商品汇总数量超过 XLSX 的安全整数范围，请分开导出。'); return sum; };
export function projectConfirmedGroups(groups: Confirmed[], filter: ReportFilter = {}, scope?: ShippingReportScope): ShipmentReport {
  if (scope) return projectShippingRunGroups(groups, filter, scope);
  const rows: ShipmentReportRow[] = []; const boxes: ShipmentReportBox[] = []; const confirmations: ReportReference[] = [];
  for (const bundle of groups) {
    const { group, confirmation, codes } = bundle;
    const members = confirmation.snapshot.members;
    // Production callers supply occurrence metadata, including an empty map for unassigned history.
    const monthOf=(member:typeof members[number])=>bundle.shippingDetails===undefined?member.businessDate.slice(0,7):bundle.shippingDetails[member.id]?.month;
    // Identity filters locate a complete confirmed group, within the existing
    // month/region projection. They must not trim its rows or export reference.
    const hasIdentityFilters = Boolean(filter.weekStartDate || filter.sid !== undefined || filter.country || filter.channel);
    if (hasIdentityFilters && !members.some((member) =>
      (!filter.month || monthOf(member)===filter.month) &&
      (!filter.region || filter.region === 'all' || reportRegion(member.snapshot.country) === filter.region) &&
      (!filter.weekStartDate || member.weekStartDate === filter.weekStartDate) &&
      (filter.sid === undefined || member.snapshot.sid === filter.sid) &&
      (!filter.country || member.snapshot.country === filter.country) &&
      (!filter.channel || member.snapshot.channel === filter.channel))) continue;
    const quantities = new Map<string, number>(); const monthQuantities = new Map<string, number>();
    for (const shipment of confirmation.snapshot.shipments) {
      const member = members.find((m) => m.id === shipment.demandId)!;
      if (!member) throw new BatchError('CONFIRMATION_INVALID', 409, '确认版本的货件关联缺失。');
      for (const item of shipment.revision.data.items) {
        const key = `${member.snapshot.sid}:${productKey(item)}`; const value = integer(item.quantity);
        quantities.set(key, safeSum(quantities.get(key) ?? 0, value));
        if (!filter.month || monthOf(member)===filter.month) monthQuantities.set(key, safeSum(monthQuantities.get(key) ?? 0, value));
      }
    }
    let included = false;
    for (const shipment of confirmation.snapshot.shipments) {
      const member = members.find((m) => m.id === shipment.demandId)!; const data = shipment.revision.data;
      if (filter.month && monthOf(member)!==filter.month) continue;
      if (filter.region && filter.region !== 'all' && reportRegion(member.snapshot.country) !== filter.region) continue;
      included = true;
      const sortedBoxes = [...data.boxes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (const [index, box] of sortedBoxes.entries()) {
        const code = codes.find((c) => c.valid && c.groupId === group.id && c.demandId === member.id && c.boxId === box.id);
        if (!code) throw new BatchError('CODES_REQUIRED', 409, '确认箱缺少有效编码，请先分配编码。');
        boxes.push({ groupId: group.id, groupName: group.name, confirmationId: confirmation.id, demandId: member.id, sid: member.snapshot.sid, fba: member.snapshot.fba, boxId: box.id,
          boxOrder: index + 1, displayBoxOrder: code.sequence, code: code.code, boxName: box.name, boxExternalId: box.externalBoxId, localBoxId: box.localBoxId,
          weight: measure(box.weight), weightUnit: box.weightUnit ?? null, length: measure(box.length), width: measure(box.width), height: measure(box.height), lengthUnit: box.dimensionUnit ?? null,
          items: box.items.map((item) => ({ msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: integer(item.quantity) })) });
      }
      const shipmentRows: ShipmentReportRow[] = [];
      for (const item of data.items) {
        const key = `${member.snapshot.sid}:${productKey(item)}`;
        const distribution = sortedBoxes.flatMap((box, index) => { const entry = box.items.find((p) => productKey(p) === productKey(item)); if (!entry) return []; const code = codes.find((c) => c.valid && c.groupId === group.id && c.boxId === box.id && c.demandId === member.id)!; return [{ boxId: box.id, boxOrder: index + 1, displayBoxOrder: code.sequence, code: code.code, quantity: integer(entry.quantity) }]; });
        shipmentRows.push({ id: `${shipment.revision.id}:${productKey(item)}`, demandId: member.id, groupId: group.id, groupName: group.name, confirmationId: confirmation.id,
          weekStartDate: member.weekStartDate, weekEndDate: member.weekEndDate, businessDate: member.businessDate, sid: member.snapshot.sid,
          ...(bundle.shippingDetails?.[member.id]?{shippingRunId:bundle.shippingDetails[member.id]!.runId,shippingMonth:bundle.shippingDetails[member.id]!.month,shippingRunSequence:bundle.shippingDetails[member.id]!.sequence??undefined,ticketNumber:bundle.shippingDetails[member.id]!.ticketNumber??undefined}:{}),
          shop: member.snapshot.shop, country: member.snapshot.country, channel: member.snapshot.channel ?? '', destinationFc: member.snapshot.destinationFc, fba: member.snapshot.fba,
          msku: item.msku, fnsku: item.fnsku, sku: item.sku, productName: item.name ?? '', quantity: integer(item.quantity), boxes: distribution, codes: distribution.map((b) => b.code),
          groupQuantity: quantities.get(key) ?? 0, monthQuantity: monthQuantities.get(key) ?? 0, status: group.frozenAt ? '已冻结' : '已确认', actualShipDate: group.actualShipDate,
          sourceObservedAt: data.observedAt, dataRevisionId: shipment.revision.id });
      }
      // Keep FBA blocks and accepted quantities intact; only order their product
      // rows by the first occupied box. Equal keys retain the source item order.
      rows.push(...shipmentRows.map((row, index) => ({ row, index,
        firstBox: row.boxes.reduce((first, box) => box.quantity > 0 ? Math.min(first, box.displayBoxOrder ?? box.boxOrder) : first, Infinity),
      })).sort((left, right) => left.firstBox - right.firstBox || left.index - right.index).map(({ row }) => row));
    }
    if (included) confirmations.push({ groupId: group.id, groupVersion: group.version, confirmationId: confirmation.id });
  }
  // Search locates complete sub-batches within the applied month/region. Keep
  // their full projection so both table views and group exports share a scope.
  const query = filter.q?.trim().toLowerCase();
  let matchingGroups: Set<string> | undefined;
  if (query) {
    const matches = (values: string[]) => values.some((value) => value.toLowerCase().includes(query));
    matchingGroups = new Set(rows.filter((row) => matches([row.groupName, row.fba, row.shop, row.productName, row.msku, row.fnsku, row.sku, ...row.codes])).map((row) => row.groupId));
    for (const box of boxes) if (matches([box.groupName, box.fba, box.code, ...box.items.flatMap((item) => [item.msku, item.fnsku, item.sku])])) matchingGroups.add(box.groupId);
  }
  const matchingRows = sortReportRows(matchingGroups ? rows.filter((row) => matchingGroups.has(row.groupId)) : rows);
  const matchingBoxes = sortReportBoxes(matchingGroups ? boxes.filter((box) => matchingGroups.has(box.groupId)) : boxes);
  const matchingConfirmations = matchingGroups ? confirmations.filter((ref) => matchingGroups.has(ref.groupId)) : confirmations;
  const maxBoxes = matchingBoxes.reduce((max, box) => Math.max(max, box.displayBoxOrder ?? box.boxOrder), 0); const page = filter.page ?? 1; const pageSize = filter.pageSize ?? 50;
  return { rows: matchingRows.slice((page - 1) * pageSize, page * pageSize), boxes: matchingBoxes, total: matchingRows.length, page, pageSize, maxBoxes, confirmations: matchingConfirmations, blocked: [], generatedAt: new Date().toISOString() };
}
function projectShippingRunGroups(groups: Confirmed[], filter: ReportFilter, scope: ShippingReportScope): ShipmentReport {
  const byDemand = new Map(scope.members.map((member) => [member.demandId, member]));
  if (byDemand.size !== scope.members.length) throw new BatchError('SHIPPING_RUN_MEMBERS_INVALID', 409, '本次发货包含重复货件，请重新核对票成员。');
  // A legacy source group may also contain FBA shipments outside this run.
  // Slice immutable accepted members before computing any quantities or box rows.
  const selectedGroups = groups.map((bundle) => ({ ...bundle, confirmation: { ...bundle.confirmation,
    snapshot: { ...bundle.confirmation.snapshot,
      members: bundle.confirmation.snapshot.members.filter((member) => byDemand.get(member.id)?.groupId === bundle.group.id),
      shipments: bundle.confirmation.snapshot.shipments.filter((shipment) => byDemand.get(shipment.demandId)?.groupId === bundle.group.id),
    } } })).filter((bundle) => bundle.confirmation.snapshot.members.length > 0);
  const accepted = new Set(selectedGroups.flatMap((bundle) => bundle.confirmation.snapshot.shipments.map((shipment) => shipment.demandId)));
  if (!scope.allowIncomplete && scope.members.some((member) => !accepted.has(member.demandId))) throw new BatchError('SHIPPING_RUN_SOURCE_STALE', 409, '本次发货的票成员已不属于原制表确认，请重新核对。');
  const complete = projectConfirmedGroups(selectedGroups, { pageSize: Number.MAX_SAFE_INTEGER });
  const ticketFields = (demandId: string) => {
    const member = byDemand.get(demandId)!;
    return { shippingRunId: scope.shippingRunId, shippingMonth:scope.month, shippingRunSequence:scope.sequence??undefined,ticketId: member.ticketId, ticketNumber: member.ticketNumber, sourceTicketIndex: member.sourceTicketIndex, inputOrder: member.inputOrder };
  };
  const rows = complete.rows.map((row) => ({ ...row, ...ticketFields(row.demandId!) }));
  const boxes = complete.boxes.map((box) => ({ ...box, ...ticketFields(box.demandId) }));
  const totals = new Map<string, number>();
  const quantityKey = (row: ShipmentReportRow) => JSON.stringify([row.ticketId, row.sid, productKey(row)]);
  for (const row of rows) totals.set(quantityKey(row), safeSum(totals.get(quantityKey(row)) ?? 0, row.quantity));
  for (const row of rows) { row.groupQuantity = totals.get(quantityKey(row))!; row.monthQuantity = row.groupQuantity; }
  const query = filter.q?.trim().toLowerCase();
  const byGroup = new Map(groups.map((bundle) => [bundle.group.id, bundle.group]));
  const matchingTickets = new Set(rows.filter((row) =>
    (!filter.month || scope.month === filter.month) &&
    (!filter.region || filter.region === 'all' || reportRegion(row.country) === filter.region) &&
    (!filter.weekStartDate || row.weekStartDate === filter.weekStartDate) &&
    (!filter.weeklyBatchId || byGroup.get(row.groupId)?.batchId === filter.weeklyBatchId) &&
    (!filter.subBatchId || row.groupId === filter.subBatchId) &&
    (filter.sid === undefined || row.sid === filter.sid) && (!filter.country || row.country === filter.country) &&
    (!filter.channel || row.channel === filter.channel) &&
    (!query || [row.ticketNumber!, row.groupName, row.fba, row.shop, row.productName, row.msku, row.fnsku, row.sku, ...row.codes].some((value) => value.toLowerCase().includes(query))))
    .map((row) => row.ticketId));
  const order = (left: { sourceTicketIndex?: number; inputOrder?: number }, right: { sourceTicketIndex?: number; inputOrder?: number }) =>
    left.sourceTicketIndex! - right.sourceTicketIndex! || left.inputOrder! - right.inputOrder!;
  const matchingRows = sortReportRows(rows.filter((row) => matchingTickets.has(row.ticketId)).sort(order));
  const matchingBoxes = sortReportBoxes(boxes.filter((box) => matchingTickets.has(box.ticketId)).sort((left, right) => order(left, right) || left.boxOrder - right.boxOrder));
  const matchingGroupIds = new Set(matchingRows.map((row) => row.groupId));
  const page = filter.page ?? 1, pageSize = filter.pageSize ?? 50;
  return { ...complete, shippingRunId: scope.shippingRunId, shippingRunVersion: scope.version, shippingRunDate: scope.numberingDate, ...(scope.sequence ? { shippingRunSequence: scope.sequence } : {}),
    rows: matchingRows.slice((page - 1) * pageSize, page * pageSize), boxes: matchingBoxes, total: matchingRows.length, page, pageSize,
    maxBoxes: matchingBoxes.reduce((maximum, box) => Math.max(maximum, box.displayBoxOrder ?? box.boxOrder), 0), confirmations: complete.confirmations.filter((ref) => matchingGroupIds.has(ref.groupId)) };
}
function reportScope(bundle: Awaited<ReturnType<typeof getReadyShippingRunInTx>>): ShippingReportScope {
  return { shippingRunId: bundle.run.id, version: bundle.run.version, numberingDate: bundle.run.numberingDate, month: bundle.run.month, sequence: bundle.run.sequence,
    members: bundle.tickets.flatMap((ticket) => ticket.number ? ticket.members.filter((member) => member.demandId && member.groupId).map((member) => ({ demandId: member.demandId!, groupId: member.groupId!, ticketId: ticket.id,
      ticketNumber: ticket.number!, sourceTicketIndex: ticket.sourceTicketIndex, inputOrder: member.inputOrder })) : []) };
}
export async function getShipmentReport(actorId: string, filter: ReportFilter = {}) {
  if (filter.shippingRunId) return db.transaction(async (tx) => {
    const run = await getShippingRunReportScopeInTx(tx, filter.shippingRunId!, actorId);
    const groups: Confirmed[] = [], blocked: ShipmentReport['blocked'] = [];
    for (const groupId of [...run.groupIds].sort()) {
      try { groups.push(await getConfirmedGroupInTx(tx, groupId, actorId)); }
      catch (error) { if (!(error instanceof BatchError)) throw error; blocked.push({ groupId, name: '本次发货来源组', code: error.code, message: error.message }); }
    }
    const scope = reportScope(run);
    scope.allowIncomplete = run.run.status !== 'ready';
    return { ...projectConfirmedGroups(groups, filter, scope), blocked };
  }, { isolationLevel: 'repeatable read' });
  const actor = await db.query.user.findFirst({ where: eq(user.id, actorId) });
  if (!actor || actor.banned || actor.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '需要有效管理员身份。');
  const conditions = [sql`${subBatches.status} <> 'superseded'`];
  if (filter.weeklyBatchId) conditions.push(eq(subBatches.batchId, filter.weeklyBatchId));
  if (filter.subBatchId) conditions.push(eq(subBatches.id, filter.subBatchId));
  const candidates = await db.select().from(subBatches).where(and(...conditions)).orderBy(subBatches.position, subBatches.createdAt);
  const bundles: Confirmed[] = []; const blocked: ShipmentReport['blocked'] = [];
  for (const group of candidates) {
    try { bundles.push(await getConfirmedGroup(group.id, actorId)); }
    catch (error) { if (!(error instanceof BatchError)) throw error; blocked.push({ groupId: group.id, name: group.name, code: error.code, message: error.message }); }
  }
  const enriched=await db.transaction((tx)=>withShippingDetails(tx,bundles));
  return { ...projectConfirmedGroups(enriched, filter), blocked };
}
const sameReferences = (a: ReportReference[], b: ReportReference[]) => JSON.stringify([...a].sort((x, y) => x.groupId.localeCompare(y.groupId))) === JSON.stringify([...b].sort((x, y) => x.groupId.localeCompare(y.groupId)));
const sameIds = (left: string[], right: string[]) => left.length === right.length && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
export function assertShippingRunProjection(scope: ShippingReportScope, projection: ShipmentReport) {
  const identity = (member: ShippingReportScope['members'][number]) => JSON.stringify([member.demandId, member.groupId, member.ticketId, member.ticketNumber, member.sourceTicketIndex, member.inputOrder]);
  const projected = new Set(projection.rows.map((row) => JSON.stringify([row.demandId, row.groupId, row.ticketId, row.ticketNumber, row.sourceTicketIndex, row.inputOrder])));
  if (scope.shippingRunId !== projection.shippingRunId || scope.version !== projection.shippingRunVersion || scope.numberingDate !== projection.shippingRunDate || scope.sequence !== projection.shippingRunSequence
    || projected.size !== scope.members.length || scope.members.some((member) => !projected.has(identity(member)))) {
    throw new BatchError('SHIPPING_RUN_VERSION_CONFLICT', 409, '导出期间发货次版本或票成员已变化，请重新预览。');
  }
}
async function lockReportGroups(tx: BatchTx, ids: string[]) {
  const groups = await tx.select({ id: subBatches.id, batchId: subBatches.batchId }).from(subBatches).where(inArray(subBatches.id, ids));
  if (groups.length !== ids.length) throw new BatchError('NOT_FOUND', 404, '部分导出子批次不存在。');
  for(const batchId of [...new Set(groups.map((group)=>group.batchId))].sort())await lockBatchRunScopesInTx(tx,batchId);
  // Occurrences precede processing containers and groups in every writer.
  await tx.select({ id: weeklyBatches.id }).from(weeklyBatches).where(inArray(weeklyBatches.id, [...new Set(groups.map((group) => group.batchId))])).orderBy(weeklyBatches.id).for('update');
  await tx.select({ id: subBatches.id }).from(subBatches).where(inArray(subBatches.id, ids)).orderBy(subBatches.id).for('update');
}
/** Stage bytes first; publish the index and business references in one short
 * transaction. On an ambiguous commit, preserve every indexed file. */
export async function publishReportFile(input: StoreFileInput, publish: (file: NewFileIndex) => Promise<void>) {
  const dataDir = readConfig().dataDir;
  const file = await storeImmutableFile(dataDir, input, async () => {});
  try { await publish(file); return file; }
  catch (error) {
    // A transport error during COMMIT does not prove rollback. Keep the bytes
    // even if another connection cannot yet observe the index. Our explicit
    // business errors originate before COMMIT and permit safe compensation.
    if (!(error instanceof BatchError)) throw error;
    try {
      const [indexed] = await db.select({ id: fileIndex.id }).from(fileIndex).where(eq(fileIndex.id, file.id));
      if (!indexed) {
        const path = resolve(dataDir, file.storageKey); const suffix = relative(dataDir, path);
        if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('INVALID_STAGED_FILE_PATH');
        await unlink(path).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== 'ENOENT') throw failure; });
      }
    } catch { /* Unknown database outcome: leave bytes available for reconciliation. */ }
    throw error;
  }
}
export async function requestReportExport(boss: PgBoss, input: ReportExportInput, actorId: string) {
  if (Boolean(input.shippingRunId) !== (input.expectedShippingRunVersion !== undefined) || (input.shippingRunId && (input.month || input.region !== 'all'))) throw new BatchError('VALIDATION_ERROR', 422, '整次发货导出须绑定发货次版本并包含全部票。');
  if (new Set(input.groupIds).size !== input.groupIds.length || new Set(input.expectedConfirmations.map((ref) => ref.groupId)).size !== input.expectedConfirmations.length || input.expectedConfirmations.length !== input.groupIds.length || input.expectedConfirmations.some((ref) => !input.groupIds.includes(ref.groupId))) throw new BatchError('VALIDATION_ERROR', 422, '导出范围和确认引用必须一一对应。');
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.operationId}, 0))`);
    const [actor] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
    if (!actor || actor.banned || actor.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '需要有效管理员身份。');
    const [previous] = await tx.select().from(batchExports).where(eq(batchExports.operationId, input.operationId));
    if (previous) { if (previous.createdBy !== actorId || previous.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '该操作编号已用于其他导出。'); return { export: await serializeExport(previous), replayed: true }; }
    const run = input.shippingRunId ? await getReadyShippingRunInTx(tx, input.shippingRunId, input.expectedShippingRunVersion, actorId) : undefined;
    if (run && !sameIds(input.groupIds, run.groupIds)) throw new BatchError('SHIPPING_RUN_SCOPE_MISMATCH', 409, '整次发货导出须包含本次全部来源组，请重新预览。');
    // Read immutable confirmations after locking every participating group.
    await lockReportGroups(tx, input.groupIds);
    const bundles: Confirmed[] = [];
    for (const id of [...input.groupIds].sort()) bundles.push(await getConfirmedGroupInTx(tx, id, actorId));
    const projection = projectConfirmedGroups(await withShippingDetails(tx,bundles), { month: input.month, region: input.region, pageSize: Number.MAX_SAFE_INTEGER }, run ? reportScope(run) : undefined);
    if (!sameReferences(projection.confirmations, input.expectedConfirmations)) throw new BatchError('VERSION_CONFLICT', 409, '报表依据的确认已变化或筛选范围不包含所选组，请重新预览。');
    if (!projection.rows.length) throw new BatchError('EMPTY_REPORT', 422, '当前筛选范围没有可导出的已确认商品。');
    const id = randomUUID();
    const jobId = await boss.send(EXPORT_QUEUE, { exportId: id }, { db: fromDrizzle(tx, sql), retryLimit: 2, retryDelay: 5, expireInSeconds: 180 });
    if (!jobId) throw new BatchError('QUEUE_UNAVAILABLE', 503, '导出任务入队失败。');
    const [record] = await tx.insert(batchExports).values({ id, operationId: input.operationId, requestHash, createdBy: actorId, queueJobId: jobId, groupIds: input.groupIds, references: projection.confirmations,
      month: input.month ?? null, region: input.region, projection, rowCount: projection.rows.length, boxCount: projection.boxes.length }).returning();
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'batch.export.request', targetId: id, actorUserId: actorId, requestHash, details: { groupCount: String(input.groupIds.length) } });
    return { export: await serializeExport(record!), replayed: false };
  });
}
type ExportRow = typeof batchExports.$inferSelect;
async function serializeExport(record: ExportRow): Promise<ReportExportRecord> {
  let invalidReason: string | null = null;
  if (record.status === 'completed') {
    const groups = await db.select().from(subBatches).where(inArray(subBatches.id, record.groupIds));
    if (groups.some((g) => g.replacedById)) invalidReason = '已有更正版本；历史文件保留，请核对替代记录。';
  }
  return { id: record.id, status: record.status as ReportExportRecord['status'], groupIds: record.groupIds, references: record.references,
    ...(record.projection.shippingRunId ? { shippingRunId: record.projection.shippingRunId, shippingRunVersion: record.projection.shippingRunVersion } : {}),
    month: record.month, region: record.region as ReportExportRecord['region'], fileId: record.fileId, error: record.error, createdAt: record.createdAt.toISOString(), completedAt: record.completedAt?.toISOString() ?? null,
    rowCount: record.rowCount, boxCount: record.boxCount, valid: record.status === 'completed' && !invalidReason, invalidReason };
}
export async function getExport(id: string) { const [record] = await db.select().from(batchExports).where(eq(batchExports.id, id)); if (!record) throw new BatchError('NOT_FOUND', 404, '导出记录不存在。'); return { export: await serializeExport(record) }; }
export async function listExports(filter: { subBatchId?: string; month?: string; shippingRunId?: string } = {}) {
  const records = await db.select().from(batchExports).where(and(filter.month ? eq(batchExports.month, filter.month) : undefined,
    filter.shippingRunId ? sql`${batchExports.projection}->>'shippingRunId' = ${filter.shippingRunId}` : undefined)).orderBy(desc(batchExports.createdAt)).limit(200);
  return { items: await Promise.all(records.filter((r) => !filter.subBatchId || r.groupIds.includes(filter.subBatchId)).map(serializeExport)) };
}
export async function executeReportExport(id: string, dependencies: { createWorkbook?: typeof createReportWorkbook } = {}) {
  const connection = await pool.connect(); let locked = false;
  try {
    const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`report-export:${id}`]);
    locked = result.rows[0]?.locked ?? false; if (!locked) return;
    await executeLockedReportExport(id, dependencies);
  } finally {
    let failedUnlock = false;
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`report-export:${id}`]); }
    catch { failedUnlock = true; }
    finally { connection.release(failedUnlock); }
  }
}
function reportWithBoxColumns(projection: ShipmentReport, groups: Confirmed[]): ShipmentReport {
  const allocations = new Map<string, Confirmed['codes']>();
  for (const bundle of groups) for (const code of bundle.codes ?? []) {
    if (!code.valid) continue;
    const key = JSON.stringify([bundle.group.id, code.boxId]);
    allocations.set(key, [...(allocations.get(key) ?? []), code]);
  }
  const column = <T extends { boxId: string; code: string; displayBoxOrder?: number }>(groupId: string, box: T, demandId?: string) => {
    const matches = allocations.get(JSON.stringify([groupId, box.boxId])) ?? [];
    const code = matches[0];
    if (matches.length !== 1 || !code || code.groupId !== groupId || code.code !== box.code || (demandId !== undefined && code.demandId !== demandId)
      || !Number.isSafeInteger(code.sequence) || code.sequence < 1 || (box.displayBoxOrder !== undefined && box.displayBoxOrder !== code.sequence)) {
      throw new BatchError('REPORT_BOX_COLUMNS_STALE', 409, '发货表箱列与当前有效箱码不一致，请重新预览并生成文件。');
    }
    return { ...box, displayBoxOrder: code.sequence };
  };
  // Older queued exports keep their accepted member and product snapshots.
  // Enrich display coordinates and apply the current output order only.
  const rows = projection.rows.map((row) => ({ ...row, boxes: (row.boxes ?? []).map((box) => column(row.groupId, box, row.demandId)) }));
  const boxes = projection.boxes.map((box) => ({ ...box, displayBoxOrder: column(box.groupId, box, box.demandId).displayBoxOrder }));
  const maxBoxes = rows.reduce((maximum, row) => row.boxes.reduce((max, box) => Math.max(max, box.displayBoxOrder), maximum),
    boxes.reduce((maximum, box) => Math.max(maximum, box.displayBoxOrder), projection.maxBoxes ?? 0));
  return { ...projection, rows: sortReportRows(rows), boxes: sortReportBoxes(boxes), maxBoxes };
}
async function executeLockedReportExport(id: string, dependencies: { createWorkbook?: typeof createReportWorkbook }) {
  const [record] = await db.select().from(batchExports).where(eq(batchExports.id, id));
  if (!record || record.status === 'completed' || record.status === 'stale') return;
  await db.update(batchExports).set({ status: 'running', error: null }).where(eq(batchExports.id, id));
  try {
    const renderProjection = await db.transaction(async (tx) => {
      if (record.projection.shippingRunId) {
        const run = await getReadyShippingRunInTx(tx, record.projection.shippingRunId, record.projection.shippingRunVersion, record.createdBy);
        if (!sameIds(run.groupIds, record.groupIds)) throw new BatchError('SHIPPING_RUN_SCOPE_MISMATCH', 409, '导出期间发货次来源范围已变化。');
        assertShippingRunProjection(reportScope(run), record.projection);
      }
      await lockReportGroups(tx, record.groupIds);
      const current: Confirmed[] = [];
      for (const groupId of [...record.groupIds].sort()) current.push(await getConfirmedGroupInTx(tx, groupId, record.createdBy));
      const references = current.map((b) => ({ groupId: b.group.id, groupVersion: b.group.version, confirmationId: b.confirmation.id }));
      if (!sameReferences(references, record.references)) throw new BatchError('VERSION_CONFLICT', 409, '导出期间确认版本已变化。');
      return reportWithBoxColumns(record.projection, current);
    });
    // Publication freezes these groups in the same transaction as the file
    // index. Render that resulting state without freezing before bytes exist.
    // Keep queued/failed projections and all historical completed files intact.
    const publishedProjection: ShipmentReport = { ...renderProjection,
      rows: renderProjection.rows.map((row) => ({ ...row, status: '已冻结' })) };
    const bytes = await (dependencies.createWorkbook ?? createReportWorkbook)(publishedProjection, { month: record.month, exportId: id });
    const fileLabel = record.projection.shippingRunDate ? `${record.projection.shippingRunDate.replaceAll('-', '')}-${record.projection.shippingRunSequence}-发货表` : `${record.month ?? '历史批次'}-发货记录`;
    await publishReportFile({ bytes, originalName: `${fileLabel}-${id.slice(0, 8)}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: record.createdBy }, async (file) => {
      await db.transaction(async (tx) => {
        const [actor] = await tx.select().from(user).where(eq(user.id, record.createdBy)).for('share');
        if (!actor || actor.banned || actor.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '导出提交人已失去管理员身份。');
        if (record.projection.shippingRunId) {
          const run = await getReadyShippingRunInTx(tx, record.projection.shippingRunId, record.projection.shippingRunVersion, record.createdBy);
          if (!sameIds(run.groupIds, record.groupIds)) throw new BatchError('SHIPPING_RUN_SCOPE_MISMATCH', 409, '生成文件期间发货次来源范围已变化，文件未发布。');
          assertShippingRunProjection(reportScope(run), record.projection);
        }
        await lockReportGroups(tx, record.groupIds);
        const [currentExport] = await tx.select().from(batchExports).where(eq(batchExports.id, id)).for('update');
        if (!currentExport || currentExport.status !== 'running' || currentExport.fileId) throw new BatchError('EXPORT_STATE_CONFLICT', 409, '导出任务状态已经变化，文件未重复发布。');
        const publicationGroups: Confirmed[] = [];
        for (const ref of [...record.references].sort((a, b) => a.groupId.localeCompare(b.groupId))) {
          const confirmed = await freezeGroupForExport(tx, ref.groupId, ref.confirmationId, record.createdBy);
          if (confirmed.group.version !== ref.groupVersion) throw new BatchError('VERSION_CONFLICT', 409, '生成文件期间子批次版本已变化，文件未发布。');
          publicationGroups.push(confirmed);
        }
        reportWithBoxColumns(publishedProjection, publicationGroups);
        if(record.projection.shippingRunId)await tx.update(shippingRuns).set({membershipFrozenAt:sql`COALESCE(${shippingRuns.membershipFrozenAt},now())`}).where(eq(shippingRuns.id,record.projection.shippingRunId));
        await tx.insert(fileIndex).values(file);
        await tx.update(batchExports).set({ status: 'completed', projection: publishedProjection, fileId: file.id, error: null, completedAt: new Date() }).where(eq(batchExports.id, id));
        await tx.insert(operationAudit).values({ id: randomUUID(), action: 'batch.export.publish', targetId: id, actorUserId: record.createdBy, requestHash: file.sha256, details: { fileId: file.id, rowCount: String(record.rowCount) } });
      });
    });
  } catch (error) {
    const [published] = await db.select().from(batchExports).where(eq(batchExports.id, id));
    if (published?.status === 'completed' && published.fileId) return;
    await db.update(batchExports).set({ status: error instanceof BatchError && error.status === 409 ? 'stale' : 'failed', error: error instanceof BatchError ? error.message : '导出文件生成或发布失败，请重试并检查文件存储。', completedAt: new Date() }).where(and(eq(batchExports.id, id), inArray(batchExports.status, ['queued', 'running', 'failed'])));
    throw error;
  }
}
export async function registerBatchExportWorker(boss: PgBoss) {
  await boss.createQueue(EXPORT_QUEUE, { retryLimit: 2, retryDelay: 5, expireInSeconds: 180, deleteAfterSeconds: 0 });
  await boss.work<{ exportId: string }>(EXPORT_QUEUE, { batchSize: 1 }, async (jobs) => { for (const job of jobs) await executeReportExport(job.data.exportId); });
  const interval = setInterval(() => void reconcileReportExports(boss).catch(() => undefined), 5_000); interval.unref();
  return () => clearInterval(interval);
}
export async function reconcileReportExports(boss: PgBoss) {
  const records = await db.select().from(batchExports).where(inArray(batchExports.status, ['queued', 'running'])).limit(100);
  for (const record of records) {
    const [job] = await boss.findJobs(EXPORT_QUEUE, { id: record.queueJobId });
    if (job && !['failed', 'cancelled'].includes(job.state)) continue;
    const connection = await pool.connect(); let locked = false;
    try {
      const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`report-export:${record.id}`]);
      locked = result.rows[0]?.locked ?? false; if (!locked) continue;
      await db.update(batchExports).set({ status: 'failed', error: '导出任务已中断或取消，未发布的文件不会覆盖历史文件，请重新发起导出。', completedAt: new Date() }).where(and(eq(batchExports.id, record.id), inArray(batchExports.status, ['queued', 'running'])));
    } finally { try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`report-export:${record.id}`]); } finally { connection.release(); } }
  }
}
export async function readExportFile(fileId: string) {
  const [record] = await db.select().from(batchExports).where(eq(batchExports.fileId, fileId));
  if (!record || record.status !== 'completed') throw new BatchError('NOT_FOUND', 404, '找不到已发布的发货表文件。');
  const [file] = await db.select().from(fileIndex).where(eq(fileIndex.id, fileId)); if (!file) throw new BatchError('FILE_NOT_FOUND', 404, '导出文件索引不存在。');
  return { file, bytes: await checkedFileBytes(file) };
}
