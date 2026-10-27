import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { operationAudit } from '../../db/schema.js';
import type { BatchTx } from '../batches/service.js';
import { documentExports, documentMemberClaims, documentRevisions, documents } from '../documents/schema.js';
import { documentAutomationJobs } from '../documents/automation-schema.js';
import { workflowClaims, workflowExports, workflowRecords, workflowRevisions } from '../workflow/schema.js';
import { documentDigest } from '../documents/domain.js';

export type ShippingInvalidationScope = { runIds: string[]; groupIds: string[]; demandIds: string[]; operationId: string; reason: string; actorId: string };

/** Invalidate complete documents, including mixed invoices; never rewrite their published bytes or external facts. */
export async function invalidateShippingSourcesInTx(tx: BatchTx, scope: ShippingInvalidationScope): Promise<void> {
  if (!scope.runIds.length && !scope.groupIds.length && !scope.demandIds.length) return;
  const runs = new Set(scope.runIds), groups = new Set(scope.groupIds), demands = new Set(scope.demandIds);
  const revisions = await tx.select({ documentId: documentRevisions.documentId, data: documentRevisions.data }).from(documentRevisions).innerJoin(documents, eq(documents.currentRevisionId, documentRevisions.id));
  const ids = [...new Set(revisions.filter(({ data }) => runs.has(data.shippingRunId ?? '') || data.members.some((member) => groups.has(member.source.groupId) || demands.has(member.demand.id))).map((row) => row.documentId))].sort();
  const now = new Date();
  if (ids.length) {
    const records = await tx.select().from(documents).where(inArray(documents.id, ids)).orderBy(asc(documents.id)).for('update');
    for (const record of records) {
      if (['cancelled', 'superseded', 'stale'].includes(record.status)) continue;
      await tx.update(documents).set({ status: 'stale', version: record.version + 1, updatedAt: now }).where(eq(documents.id, record.id));
      await tx.insert(operationAudit).values({ id: randomUUID(), action: 'document.source_void', targetId: record.id, actorUserId: scope.actorId,
        requestHash: documentDigest({ operationId: scope.operationId, documentId: record.id }), details: { operationId: scope.operationId, reason: scope.reason } });
    }
    await tx.update(documentMemberClaims).set({ releasedAt: now }).where(and(inArray(documentMemberClaims.documentId, ids), isNull(documentMemberClaims.releasedAt)));
    await tx.update(documentExports).set({ status: 'stale', error: '上游发货安排已作废，未发布文件不能继续生成。', completedAt: now })
      .where(and(inArray(sql<string>`${documentExports.reference}->>'documentId'`, ids), inArray(documentExports.status, ['queued', 'running'])));
  }
  const workflows = await tx.select().from(workflowRecords).orderBy(asc(workflowRecords.id));
  const documentIds = new Set(ids);
  const affected = workflows.filter((record) => documentIds.has(record.source.documentId) || runs.has(record.source.shippingRunId ?? '') || record.source.members.some((member) => groups.has(member.source.groupId) || demands.has(member.demand.id)));
  for (const initial of affected) {
    const [record] = await tx.select().from(workflowRecords).where(eq(workflowRecords.id, initial.id)).for('update');
    if (!record || ['cancelled', 'stale'].includes(record.status)) continue;
    const version = record.version + 1;
    await tx.update(workflowRecords).set({ status: 'stale', version, updatedAt: now }).where(eq(workflowRecords.id, record.id));
    await tx.insert(workflowRevisions).values({ id: randomUUID(), recordId: record.id, version, action: 'source_void', reason: scope.reason,
      record: { ...record, kind: record.kind as 'fulfillment' | 'logistics' | 'customs' | 'finance' | 'archive', status: 'stale', version, createdAt: record.createdAt.toISOString(), updatedAt: now.toISOString() }, createdBy: scope.actorId });
  }
  if (affected.length) {
    const workflowIds = affected.map((record) => record.id);
    await tx.update(workflowClaims).set({ releasedAt: now }).where(and(inArray(workflowClaims.recordId, workflowIds), isNull(workflowClaims.releasedAt)));
    await tx.update(workflowExports).set({ status: 'stale', error: '上游发货安排已作废，历史业务事实保留。', completedAt: now }).where(and(inArray(workflowExports.recordId, workflowIds), inArray(workflowExports.status, ['queued', 'running'])));
  }
  const automations = await tx.select().from(documentAutomationJobs).where(isNull(documentAutomationJobs.deletedAt));
  for (const job of automations) {
    if (!runs.has(job.shippingRunId) && !job.items.some((item) => item.demandIds.some((id) => demands.has(id)) || documentIds.has(item.documentId ?? ''))) continue;
    await tx.update(documentAutomationJobs).set({ status: 'blocked', phase: 'failed', version: job.version + 1, queueJobId: null, leaseUntil: null, retryRequests: [],
      error: { code: 'SHIPPING_SOURCE_VOID', message: '发货来源已作废，请重新确认后建立新的出单任务；历史文件保留。' }, updatedAt: now }).where(eq(documentAutomationJobs.id, job.id));
  }
}
