import { sql, type SQL } from 'drizzle-orm';
import { BatchError, type BatchTx } from '../batches/service.js';

type EntityType = 'run' | 'group' | 'demand';
type Scope = { type: EntityType; id: string; exists: boolean; groupIds: string[]; batchIds: string[]; foreignGroups: boolean; identity?: { sid: number; fba: string } };
type Inspection = { canPurge: boolean; reasons: string[] };

async function rows<T extends Record<string, unknown>>(tx: BatchTx, statement: SQL): Promise<T[]> {
  const result = await tx.execute(statement);
  return (result as unknown as { rows: T[] }).rows;
}

/** Compare JSON scalar values, rather than substring-matching arbitrary business text. */
function references(value: SQL, ids: string[]): SQL {
  if (!ids.length) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM unnest(${sql.param(ids)}::text[]) AS needle(value)
    WHERE jsonb_path_exists(${value}, '$.** ? (@ == $needle)'::jsonpath, jsonb_build_object('needle', needle.value)))`;
}

async function scopeInTx(tx: BatchTx, type: EntityType, id: string): Promise<Scope> {
  const scope: Scope = { type, id, exists: false, groupIds: [], batchIds: [], foreignGroups: false };
  if (type === 'run') {
    scope.exists = (await rows(tx, sql`SELECT id FROM shipping_run WHERE id=${id}::uuid`)).length > 0;
    const groups = await rows<{ id: string; batch_id: string; shipping_run_id: string | null }>(tx, sql`
      SELECT g.id, g.batch_id, b.shipping_run_id FROM sub_batch g JOIN weekly_batch b ON b.id=g.batch_id
      WHERE b.shipping_run_id=${id}::uuid OR g.id IN (SELECT group_id FROM shipping_ticket_member WHERE run_id=${id}::uuid)`);
    scope.groupIds = groups.map((group) => group.id);
    scope.foreignGroups = groups.some((group) => group.shipping_run_id !== id);
    scope.batchIds = (await rows<{ id: string }>(tx, sql`SELECT id FROM weekly_batch WHERE shipping_run_id=${id}::uuid`)).map((batch) => batch.id);
  } else if (type === 'group') {
    const groups = await rows<{ id: string }>(tx, sql`SELECT id FROM sub_batch WHERE id=${id}::uuid`);
    scope.exists = groups.length > 0;
    scope.groupIds = groups.map((group) => group.id);
  } else {
    const [demand] = await rows<{ sid: number; fba: string }>(tx, sql`SELECT sid,fba FROM demand WHERE id=${id}::uuid`);
    scope.exists = Boolean(demand);
    if (demand) scope.identity = demand;
  }
  return scope;
}

async function inspectScopeInTx(tx: BatchTx, scope: Scope): Promise<Inspection> {
  const reasons: string[] = [];
  if (!scope.exists) return { canPurge: false, reasons: ['记录不存在或已永久删除。'] };
  const { type, id, groupIds, batchIds } = scope;
  const targetIds = [id, ...groupIds, ...batchIds];
  const checks = await rows<{ reason: string }>(tx, sql`
    SELECT '已有发布文件、打印或冻结历史，只能保留在回收站中追溯。' AS reason WHERE
      EXISTS (SELECT 1 FROM batch_print_record WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])) OR
      EXISTS (SELECT 1 FROM sub_batch WHERE id=ANY(${sql.param(groupIds)}::uuid[]) AND (frozen_at IS NOT NULL OR status='frozen')) OR
      EXISTS (SELECT 1 FROM shipping_run WHERE ${type === 'run'} AND id=${id}::uuid AND membership_frozen_at IS NOT NULL) OR
      EXISTS (SELECT 1 FROM batch_export e WHERE e.file_id IS NOT NULL AND (${references(sql`e.projection`, targetIds)} OR ${references(sql`e.group_ids`, groupIds)})) OR
      EXISTS (SELECT 1 FROM physical_export e WHERE e.file_id IS NOT NULL AND ${references(sql`e.references`, targetIds)}) OR
      EXISTS (SELECT 1 FROM document_export e WHERE e.file_id IS NOT NULL AND ${references(sql`e.reference`, targetIds)}) OR
      EXISTS (SELECT 1 FROM workflow_export e WHERE e.file_id IS NOT NULL AND ${references(sql`e.snapshot`, targetIds)}) OR
      EXISTS (SELECT 1 FROM document_invoice_bundle b WHERE ${references(sql`b.references`, targetIds)})
    UNION ALL SELECT '仍有关联单据或工作流记录，请保留其来源链路后再处理。' WHERE
      EXISTS (SELECT 1 FROM document_revision r WHERE ${references(sql`r.data`, targetIds)}) OR
      EXISTS (SELECT 1 FROM document_member_claim c WHERE ${type === 'demand'} AND c.demand_id=${id}::uuid) OR
      EXISTS (SELECT 1 FROM workflow_record r WHERE ${references(sql`r.source`, targetIds)} OR ${references(sql`r.data`, targetIds)}) OR
      EXISTS (SELECT 1 FROM workflow_revision r WHERE ${references(sql`r.record`, targetIds)})
    UNION ALL SELECT '关联同步或文件生成尚未停止，请等待安全停止完成。' WHERE
      EXISTS (SELECT 1 FROM batch_sync_run WHERE sub_batch_id=ANY(${sql.param(groupIds)}::uuid[]) AND status IN ('queued','running')) OR
      EXISTS (SELECT 1 FROM physical_sync_run WHERE group_id=ANY(${sql.param(groupIds)}::uuid[]) AND status IN ('queued','running')) OR
      EXISTS (SELECT 1 FROM batch_export e WHERE e.status IN ('queued','running') AND (${references(sql`e.projection`, targetIds)} OR ${references(sql`e.group_ids`, groupIds)})) OR
      EXISTS (SELECT 1 FROM physical_export e WHERE e.status IN ('queued','running') AND ${references(sql`e.references`, targetIds)})
    UNION ALL SELECT '关联导出同时包含其他批次，不能删除共享任务或其中的历史范围。' WHERE
      EXISTS (SELECT 1 FROM batch_export e WHERE ${references(sql`e.group_ids`, groupIds)}
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.group_ids) AS member(id) WHERE NOT member.id=ANY(${sql.param(groupIds)}::text[]))) OR
      EXISTS (SELECT 1 FROM physical_export e WHERE ${references(sql`e.references`, groupIds)}
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.references) AS member(value) WHERE NOT (member.value->>'groupId')=ANY(${sql.param(groupIds)}::text[])))
    UNION ALL SELECT '其他批次仍引用此更正关系，不能永久删除共享历史。' WHERE
      EXISTS (SELECT 1 FROM sub_batch g WHERE NOT g.id=ANY(${sql.param(groupIds)}::uuid[])
        AND (g.correction_of_id=ANY(${sql.param(groupIds)}::uuid[]) OR g.replaced_by_id=ANY(${sql.param(groupIds)}::uuid[])))
  `);
  reasons.push(...checks.map((check) => check.reason));
  if (scope.foreignGroups) reasons.push('本次发货引用历史批次，不能随容器永久删除非本次所有的内部组。');
  if (type === 'run' && groupIds.length) {
    if ((await rows(tx, sql`SELECT id FROM shipping_ticket_member WHERE group_id=ANY(${sql.param(groupIds)}::uuid[]) AND run_id<>${id}::uuid LIMIT 1`)).length) {
      reasons.push('内部组仍被其他发货次引用，不能永久删除共享批次。');
    }
  }
  if (type === 'run') {
    if ((await rows(tx, sql`SELECT j.id FROM document_automation_job j WHERE j.shipping_run_id=${id}::uuid
      AND (j.status IN ('queued','running') OR j.bundle->>'status'='completed'
        OR EXISTS (SELECT 1 FROM document_invoice_bundle b WHERE b.job_id=j.id)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(j.items) AS item(value) WHERE item.value->>'documentId' IS NOT NULL)) LIMIT 1`)).length) {
      reasons.push('自动出单任务仍在处理或已关联单据、整批文件，须保留发货次来源。');
    }
  }
  if (type === 'demand') {
    const demandChecks = await rows<{ reason: string }>(tx, sql`
      SELECT '货件仍有发货票或有效分组安排，请先取消安排并清理关联容器。' AS reason WHERE
        EXISTS (SELECT 1 FROM shipping_ticket_member WHERE demand_id=${id}::uuid) OR
        EXISTS (SELECT 1 FROM sub_batch_member WHERE demand_id=${id}::uuid AND active=true)
      UNION ALL SELECT '货件仍被批次确认、实物箱或发货历史使用，请先处理对应未发布批次；已发布历史不可清理。' WHERE
        EXISTS (SELECT 1 FROM group_confirmation c WHERE ${references(sql`c.snapshot`, [id])}) OR
        EXISTS (SELECT 1 FROM physical_source r WHERE ${references(sql`r.data`, [id])}) OR
        EXISTS (SELECT 1 FROM physical_revision r WHERE ${references(sql`r.data`, [id])}) OR
        EXISTS (SELECT 1 FROM physical_confirmation r WHERE ${references(sql`r.data`, [id])}) OR
        EXISTS (SELECT 1 FROM physical_template r WHERE ${references(sql`r.manifest`, [id])}) OR
        EXISTS (SELECT 1 FROM physical_intake_preview r WHERE ${references(sql`r.entries`, [id])}) OR
        EXISTS (SELECT 1 FROM batch_export e WHERE ${references(sql`e.projection`, [id])}) OR
        EXISTS (SELECT 1 FROM physical_export e WHERE ${references(sql`e.projection`, [id])})
      UNION ALL SELECT '货件仍被自动出单任务引用，请先处理该任务并保留其范围。' WHERE
        EXISTS (SELECT 1 FROM document_automation_job j WHERE ${references(sql`j.items`, [id])})
      UNION ALL SELECT '货件的同步尚未停止，请等待安全停止完成。' WHERE
        EXISTS (SELECT 1 FROM batch_sync_item i JOIN batch_sync_run r ON r.id=i.run_id
          WHERE i.demand_id=${id}::uuid AND (i.status IN ('queued','running') OR r.status IN ('queued','running'))) OR
        EXISTS (SELECT 1 FROM physical_sync_item i JOIN physical_sync_run r ON r.id=i.run_id
          WHERE i.demand_id=${id}::uuid AND (i.status IN ('queued','running') OR r.status IN ('queued','running')))
    `);
    reasons.push(...demandChecks.map((check) => check.reason));
  }
  return { canPurge: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Caller holds the same lifecycle/worker/identity locks used by cancellation. */
export async function inspectPurgeInTx(tx: BatchTx, type: EntityType, id: string): Promise<Inspection> {
  return inspectScopeInTx(tx, await scopeInTx(tx, type, id));
}

async function redactProcessHistoryInTx(tx: BatchTx, scope: Scope) {
  const ids = [scope.id, ...scope.groupIds, ...scope.batchIds];
  const tombstone = { purged: true, type: scope.type, id: scope.id };
  await tx.execute(sql`UPDATE batch_operation o SET result=${JSON.stringify(tombstone)}::jsonb WHERE ${references(sql`o.result`, ids)}`);
  await tx.execute(sql`UPDATE operation_audit a SET details=jsonb_build_object('purged','true','entityType',${scope.type}::text,
    'entityId',${scope.id}::text,'operationId',COALESCE(a.details->>'operationId',''))
    WHERE a.target_id=ANY(${sql.param(ids)}::uuid[]) OR ${references(sql`a.details`, ids)}`);
  // Corrections are historical working snapshots, not published documents. Keep the audit identity without business payload.
  await tx.execute(sql`UPDATE shipping_run_correction c SET snapshot=${JSON.stringify(tombstone)}::jsonb
    WHERE ${references(sql`c.snapshot`, ids)} AND (${scope.type !== 'run'} OR c.run_id<>${scope.id}::uuid)`);
  await tx.execute(sql`UPDATE shipping_run r SET checkpoint=jsonb_set(r.checkpoint,'{operations}',COALESCE(
    (SELECT jsonb_object_agg(operation.key,operation.value) FROM jsonb_each(r.checkpoint->'operations') AS operation(key,value)
      WHERE NOT ${references(sql`operation.value`, ids)}),'{}'::jsonb)),version=r.version+1,updated_at=now()
    WHERE ${references(sql`r.checkpoint`, ids)} AND (${scope.type !== 'run'} OR r.id<>${scope.id}::uuid)`);
}

async function purgeGroupsInTx(tx: BatchTx, groupIds: string[]) {
  if (!groupIds.length) return;
  // File indexes and immutable input/network archives are intentionally retained: their ownership may be shared.
  await tx.execute(sql`DELETE FROM batch_sync_snapshot WHERE run_id IN (SELECT id FROM batch_sync_run WHERE sub_batch_id=ANY(${sql.param(groupIds)}::uuid[]))`);
  await tx.execute(sql`DELETE FROM batch_sync_retry_operation WHERE run_id IN (SELECT id FROM batch_sync_run WHERE sub_batch_id=ANY(${sql.param(groupIds)}::uuid[]))`);
  await tx.execute(sql`DELETE FROM batch_sync_item WHERE run_id IN (SELECT id FROM batch_sync_run WHERE sub_batch_id=ANY(${sql.param(groupIds)}::uuid[]))`);
  await tx.execute(sql`DELETE FROM batch_sync_run WHERE sub_batch_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM physical_sync_snapshot WHERE run_id IN (SELECT id FROM physical_sync_run WHERE group_id=ANY(${sql.param(groupIds)}::uuid[]))`);
  await tx.execute(sql`DELETE FROM physical_sync_item WHERE run_id IN (SELECT id FROM physical_sync_run WHERE group_id=ANY(${sql.param(groupIds)}::uuid[]))`);
  await tx.execute(sql`DELETE FROM physical_sync_run WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM physical_intake_preview WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM physical_template WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM physical_review_state WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM physical_confirmation WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM physical_revision WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM physical_source WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM batch_export e WHERE ${references(sql`e.group_ids`, groupIds)}`);
  await tx.execute(sql`DELETE FROM physical_export e WHERE ${references(sql`e.references`, groupIds)}`);
  await tx.execute(sql`DELETE FROM batch_intake WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM batch_decision WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM allocation_code WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM shipping_ticket_member WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM sub_batch_member WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM sub_batch_revision WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM group_confirmation WHERE group_id=ANY(${sql.param(groupIds)}::uuid[])`);
  await tx.execute(sql`DELETE FROM sub_batch WHERE id=ANY(${sql.param(groupIds)}::uuid[])`);
}

/** Remove only the purged identity's cached preview/result entries, preserving mixed-import siblings and idempotency rows. */
async function redactDemandImportHistoryInTx(tx: BatchTx, scope: Scope) {
  const { id, identity } = scope;
  const previews = await rows<{ id: string; payload: Record<string, unknown> }>(tx, sql`SELECT id,payload FROM import_preview p
    WHERE ${references(sql`p.payload`, [id])} OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.payload->'items') AS item(value)
      WHERE item.value->>'sid'=${identity?.sid.toString() ?? ''} AND item.value->>'fba'=${identity?.fba ?? ''}) FOR UPDATE`);
  for (const record of previews) {
    const payload = record.payload;
    const items = (Array.isArray(payload.items) ? payload.items : []).filter((item: Record<string, unknown>) =>
      item.demandId !== id && !(identity && item.sid === identity.sid && item.fba === identity.fba));
    const preview = payload.preview as Record<string, unknown>;
    const counts: Record<string, number> = { new: 0, unchanged: 0, changed: 0, conflict: 0, error: 0, missing: 0 };
    for (const item of items) if (typeof item.kind === 'string' && counts[item.kind] !== undefined) counts[item.kind] = counts[item.kind]! + 1;
    const next = { ...payload, items, preview: { ...preview, counts, selectableItemIds: items.filter((item) => item.selectable).map((item) => item.id), changedItemIds: items.filter((item) => item.kind === 'changed').map((item) => item.id) } };
    await tx.execute(sql`UPDATE import_preview SET payload=${JSON.stringify(next)}::jsonb WHERE id=${record.id}::uuid`);
  }
  const commits = await rows<{ operation_id: string; result: Record<string, unknown> }>(tx, sql`SELECT operation_id,result FROM import_commit c WHERE ${references(sql`c.result`, [id])} FOR UPDATE`);
  for (const record of commits) {
    const items = (Array.isArray(record.result.items) ? record.result.items : []).filter((item: Record<string, unknown>) => item.demandId !== id);
    const counts: Record<string, number> = { created: 0, updated: 0, linked: 0, alreadyCommitted: 0 };
    for (const item of items) {
      const key = item.action === 'already_committed' ? 'alreadyCommitted' : item.action;
      if (typeof key === 'string' && counts[key] !== undefined) counts[key] = counts[key]! + 1;
    }
    const next = { ...record.result, items, counts, purged: true };
    await tx.execute(sql`UPDATE import_commit SET result=${JSON.stringify(next)}::jsonb WHERE operation_id=${record.operation_id}::uuid`);
  }
}

export async function purgeEntityInTx(tx: BatchTx, type: EntityType, id: string): Promise<void> {
  const scope = await scopeInTx(tx, type, id);
  const inspection = await inspectScopeInTx(tx, scope);
  if (!inspection.canPurge) throw new BatchError('SHIPPING_PURGE_PROTECTED', 409, inspection.reasons[0]!, { reasons: inspection.reasons });
  await redactProcessHistoryInTx(tx, scope);
  if (type === 'demand') {
    await redactDemandImportHistoryInTx(tx, scope);
    await tx.execute(sql`DELETE FROM batch_sync_snapshot WHERE item_id IN (SELECT id FROM batch_sync_item WHERE demand_id=${id}::uuid)`);
    await tx.execute(sql`DELETE FROM batch_sync_item WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM physical_sync_snapshot WHERE item_id IN (SELECT id FROM physical_sync_item WHERE demand_id=${id}::uuid)`);
    await tx.execute(sql`DELETE FROM physical_sync_item WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM batch_intake WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM batch_decision WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM allocation_code WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM sub_batch_member WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`UPDATE sub_batch_revision SET snapshot=jsonb_set(snapshot,'{demandIds}',COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(snapshot->'demandIds') member(value) WHERE value<>to_jsonb(${id}::text)),'[]'::jsonb)) WHERE ${references(sql`snapshot`, [id])}`);
    await tx.execute(sql`DELETE FROM shipment_revision WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM demand_source WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM demand_revision WHERE demand_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM demand WHERE id=${id}::uuid`);
    return;
  }
  await purgeGroupsInTx(tx, scope.groupIds);
  if (type === 'run') {
    await tx.execute(sql`DELETE FROM batch_export e WHERE e.projection->>'shippingRunId'=${id}`);
    await tx.execute(sql`DELETE FROM document_automation_job WHERE shipping_run_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM shipping_ticket_member WHERE run_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM shipping_ticket WHERE run_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM shipping_run_correction WHERE run_id=${id}::uuid`);
    await tx.execute(sql`DELETE FROM weekly_batch WHERE id=ANY(${sql.param(scope.batchIds)}::uuid[])`);
    // shipping_run_operation keeps its request hash and target UUID as a tombstone; it has no FK after the lifecycle migration.
    await tx.execute(sql`DELETE FROM shipping_run WHERE id=${id}::uuid`);
  }
}
