import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BatchIssue, PhysicalSource } from '@scm/contracts';
import { db } from '../../db/client.js';
import { fileIndex } from '../../db/schema.js';
import { getConfirmedGroup } from '../batches/service.js';
import { BatchSyncError, fetchCompleteShipmentList } from '../batches/sync.js';
import { checkedFileBytes } from '../imports/service.js';
import { batchSyncSnapshots } from '../lingxing/sync-schema.js';
import type { LingxingReadOperation, LingxingReadPayload } from '../lingxing/read-client.js';
import { buildPhysicalSource, physicalSourceFingerprint, type PhysicalEvidence } from './domain.js';

type Bundle = Awaited<ReturnType<typeof getConfirmedGroup>>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const normalizedFba = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : '';
export type PhysicalCheckpoint = { payload: LingxingReadPayload; observedAt: string; params: Record<string, unknown>; collectionId?: string };

/** Called only after checkedFileBytes has verified the immutable file's hash. */
export function decodePhysicalCheckpoint(bytes: Buffer, identity: { sid: number; fba: string; operation: LingxingReadOperation }): PhysicalCheckpoint {
  const decoded = object(JSON.parse(bytes.toString('utf8')));
  const request = object(decoded.request), params = object(request.params), metadata = object(decoded.metadata), payload = object(decoded.payload);
  const expectedFba = identity.operation === 'listShipments' ? params.shipment_id : params.shipmentConfirmationId;
  if (request.operation !== identity.operation || metadata.operation !== identity.operation || String(params.sid) !== String(identity.sid)
    || normalizedFba(expectedFba) !== normalizedFba(identity.fba) || metadata.readOnly !== true || String(metadata.businessCode) !== '0'
    || typeof metadata.httpStatus !== 'number' || metadata.httpStatus < 200 || metadata.httpStatus >= 300 || String(payload.code) !== '0'
    || typeof metadata.requestedAt !== 'string' || !Number.isFinite(Date.parse(metadata.requestedAt))) {
    throw new BatchSyncError('SNAPSHOT_IDENTITY_INVALID', '原始快照的请求身份、成功状态或采集时间无法验证。');
  }
  return { payload: payload as LingxingReadPayload, observedAt: new Date(metadata.requestedAt).toISOString(), params,
    ...(typeof decoded.collectionId === 'string' ? { collectionId: decoded.collectionId } : {}) };
}

export async function loadHistoricalSource(bundle: Bundle, actorId: string): Promise<PhysicalSource | null> {
  const evidence: PhysicalEvidence[] = [], issues: BatchIssue[] = [];
  for (const shipment of bundle.confirmation.snapshot.shipments) {
    const { sid, fba } = shipment.revision.data;
    const ids = shipment.revision.snapshotIds;
    if (!ids.length) continue;
    try {
      // The revision's immutable reference set is the entire search boundary.
      const records = await db.select({ snapshot: batchSyncSnapshots, file: fileIndex }).from(batchSyncSnapshots)
        .innerJoin(fileIndex, eq(fileIndex.id, batchSyncSnapshots.fileId))
        .where(and(inArray(batchSyncSnapshots.id, ids), eq(batchSyncSnapshots.successful, 1))).orderBy(desc(batchSyncSnapshots.createdAt));
      const checkpoints = new Map<string, PhysicalCheckpoint>(), selectedIds: string[] = [];
      for (const record of records) {
        const operation = record.snapshot.operation;
        if (!['listShipments', 'getShipmentDetails', 'getShipmentBoxes'].includes(operation)) continue;
        const key = `${operation}:${record.snapshot.page}`;
        if (checkpoints.has(key)) continue;
        const checkpoint = decodePhysicalCheckpoint(await checkedFileBytes(record.file), { sid, fba, operation: operation as LingxingReadOperation });
        checkpoints.set(key, checkpoint); selectedIds.push(record.snapshot.id);
      }
      const details = checkpoints.get('getShipmentDetails:0'), packing = checkpoints.get('getShipmentBoxes:0'), first = checkpoints.get('listShipments:0');
      if (!details || !packing || !first) throw new BatchSyncError('HISTORICAL_SOURCE_INCOMPLETE', '绑定修订未保留完整的成功列表、详情和装箱快照，请显式同步。');
      const listing = await fetchCompleteShipmentList(async (params, page) => {
        const checkpoint = checkpoints.get(`listShipments:${page}`);
        if (!checkpoint || Number(checkpoint.params.offset) !== params.offset || Number(checkpoint.params.length) !== params.length
          || checkpoint.params.start_date !== first.params.start_date || checkpoint.params.end_date !== first.params.end_date) {
          throw new BatchSyncError('HISTORICAL_SOURCE_INCOMPLETE', '绑定列表快照的分页或查询范围不完整，请显式同步。');
        }
        return checkpoint.payload;
      }, 100);
      const matched = listing.rows.filter((row) => String(row.sid) === String(sid) && normalizedFba(row.shipment_id) === normalizedFba(fba));
      if (matched.length !== 1) throw new BatchSyncError('SHIPMENT_NOT_UNIQUE_IN_RANGE', '历史快照不能按店铺和 FBA 唯一匹配目标货件。');
      evidence.push({ demandId: shipment.demandId, listing: matched[0]!, details: details.payload, packing: packing.payload,
        observedAt: [...checkpoints.values()].map((c) => c.observedAt).sort().at(-1)!, snapshotIds: selectedIds });
    } catch (error) {
      issues.push({ code: error instanceof BatchSyncError ? error.code : 'HISTORICAL_SOURCE_INVALID', severity: 'error', demandId: shipment.demandId,
        message: error instanceof BatchSyncError ? error.message : '绑定原始快照无法读取或哈希校验失败，请显式同步；不会改用全库最新数据。' });
    }
  }
  const source = buildPhysicalSource({ id: bundle.confirmation.id, groupId: bundle.group.id, m2ConfirmationId: bundle.confirmation.id, origin: 'history',
    createdBy: actorId, createdAt: bundle.confirmation.createdAt, shipments: bundle.confirmation.snapshot.shipments,
    members: bundle.confirmation.snapshot.members, codes: bundle.codes, evidence });
  const result = { ...source, issues: [...source.issues, ...issues], identityValid: source.identityValid && !issues.length };
  result.fingerprint = physicalSourceFingerprint(result);
  return result;
}
