import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { serviceMappingCreateInputSchema, serviceMappingDeleteInputSchema, serviceMappingRevisionInputSchema,
  type ServiceMapping, type ServiceMappingCreateInput, type ServiceMappingDeleteInput, type ServiceMappingList, type ServiceMappingMutationResult,
  type ServiceMappingOptions, type ServiceMappingRevisionInput } from '@scm/contracts';
import { db } from '../../db/client.js';
import { operationAudit } from '../../db/schema.js';
import { batchOperations } from '../batches/schema.js';
import { BatchError, requireBatchActor, type BatchTx } from '../batches/service.js';
import { getCountryOptionsInTx, getTransportMethodOptions, requireEnabledTransportMethod } from './options.js';
import { serviceMappings } from './schema.js';

type MappingRow = typeof serviceMappings.$inferSelect;
const serialize = (row: MappingRow): ServiceMapping => ({ id: row.id, countryCode: row.countryCode, transportMethod: row.transportMethod,
  transportMethodId: row.transportMethodId, service: row.service, version: row.version,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), deletedAt: row.deletedAt?.toISOString() ?? null });
const digest = (action: string, input: unknown) => createHash('sha256').update(JSON.stringify({ action, input })).digest('hex');
async function replayInTx(tx: BatchTx, actorId: string, operationId: string, requestHash: string): Promise<ServiceMappingMutationResult | null> {
  // Share the existing batch/document operation namespace so an operation ID cannot change meaning.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-operation:${operationId}`},0))`);
  await requireBatchActor(tx, actorId);
  const [previous] = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, operationId));
  if (!previous) return null;
  if (previous.actorId !== actorId || previous.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于不同请求。');
  return { ...previous.result, replayed: true } as ServiceMappingMutationResult;
}
async function readReplay(actorId: string, operationId: string, requestHash: string) {
  return db.transaction((tx) => replayInTx(tx, actorId, operationId, requestHash));
}
async function mutation(actorId: string, operationId: string, action: string, input: unknown, reason: string | undefined,
  execute: (tx: BatchTx) => Promise<{ row: MappingRow; before?: MappingRow }>): Promise<ServiceMappingMutationResult> {
  try {
    return await db.transaction(async (tx) => {
      const requestHash = digest(action, input), replay = await replayInTx(tx, actorId, operationId, requestHash);
      if (replay) return replay;
      const { row, before } = await execute(tx), mapping = serialize(row), result = { mapping };
      await tx.insert(batchOperations).values({ operationId, actorId, action, requestHash, result });
      await tx.insert(operationAudit).values({ id: randomUUID(), action, targetId: row.id, actorUserId: actorId, requestHash,
        details: { operationId, reason: reason ?? '', version: String(row.version), before: before ? JSON.stringify(serialize(before)) : '', after: JSON.stringify(mapping) } });
      return { mapping, replayed: false };
    });
  } catch (error) {
    const wrapped = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    const postgres = wrapped?.cause?.code ? wrapped.cause : wrapped;
    if (postgres?.code === '23505' && postgres.constraint === 'service_mapping_active_combination_uq') throw new BatchError('SERVICE_MAPPING_DUPLICATE', 409, '该国家和运输方式已维护发票服务，请编辑已有映射。');
    if (postgres?.code === '23505' && postgres.constraint === 'batch_operation_pkey') throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他请求。');
    throw error;
  }
}
async function lockedMapping(tx: BatchTx, id: string, expectedVersion: number) {
  const [row] = await tx.select().from(serviceMappings).where(eq(serviceMappings.id, id)).for('update');
  if (!row || row.deletedAt) throw new BatchError('NOT_FOUND', 404, '服务映射不存在或已删除。');
  if (row.version !== expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '服务映射已变化，请保留输入并重新读取。');
  return row;
}
async function validateCombination(tx: BatchTx, countryCode: string, transportMethod: string, exceptId?: string) {
  const countries = await getCountryOptionsInTx(tx);
  if (!countries.items.some((country) => country.code === countryCode)) throw new BatchError('SERVICE_MAPPING_COUNTRY_INVALID', 422, '请选择已同步的领星店铺国家；目录为空时请先同步店铺。');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`service-mapping-combination:${countryCode}:${transportMethod}`},0))`);
  const [duplicate] = await tx.select({ id: serviceMappings.id }).from(serviceMappings).where(and(isNull(serviceMappings.deletedAt),
    eq(serviceMappings.countryCode, countryCode), eq(serviceMappings.transportMethod, transportMethod), exceptId ? ne(serviceMappings.id, exceptId) : undefined));
  if (duplicate) throw new BatchError('SERVICE_MAPPING_DUPLICATE', 409, '该国家和运输方式已维护发票服务，请编辑已有映射。');
}
export async function listServiceMappings(actorId: string): Promise<ServiceMappingList> {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const rows = await tx.select().from(serviceMappings).where(isNull(serviceMappings.deletedAt)).orderBy(asc(serviceMappings.countryCode), asc(serviceMappings.transportMethod));
    return { items: rows.map(serialize) };
  });
}
export async function getServiceMappingOptions(actorId: string): Promise<ServiceMappingOptions> {
  const countries = await db.transaction(async (tx) => { await requireBatchActor(tx, actorId); return getCountryOptionsInTx(tx); });
  return { countries, transportMethods: await getTransportMethodOptions() };
}
export async function createServiceMapping(actorId: string, raw: ServiceMappingCreateInput): Promise<ServiceMappingMutationResult> {
  const input = serviceMappingCreateInputSchema.parse(raw), action = 'service_mapping.create';
  const replay = await readReplay(actorId, input.operationId, digest(action, input));
  if (replay) return replay;
  const transportMethodId = await requireEnabledTransportMethod(input.transportMethod, input.transportMethodId);
  return mutation(actorId, input.operationId, action, input, input.reason, async (tx) => {
    await validateCombination(tx, input.countryCode, input.transportMethod);
    const [row] = await tx.insert(serviceMappings).values({ id: randomUUID(), countryCode: input.countryCode, transportMethod: input.transportMethod,
      transportMethodId, service: input.service, createdBy: actorId, updatedBy: actorId }).returning();
    return { row: row! };
  });
}
export async function reviseServiceMapping(id: string, actorId: string, raw: ServiceMappingRevisionInput): Promise<ServiceMappingMutationResult> {
  const input = serviceMappingRevisionInputSchema.parse(raw), action = 'service_mapping.revise', request = { id, ...input };
  const replay = await readReplay(actorId, input.operationId, digest(action, request));
  if (replay) return replay;
  const before = await db.transaction(async (tx) => { await requireBatchActor(tx, actorId); return lockedMapping(tx, id, input.expectedVersion); });
  const combinationChanged = before.countryCode !== input.countryCode || before.transportMethod !== input.transportMethod;
  const methodChanged = combinationChanged || input.transportMethodId !== undefined && input.transportMethodId !== before.transportMethodId;
  const transportMethodId = methodChanged ? await requireEnabledTransportMethod(input.transportMethod, input.transportMethodId) : before.transportMethodId;
  return mutation(actorId, input.operationId, action, request, input.reason, async (tx) => {
    const current = await lockedMapping(tx, id, input.expectedVersion);
    if (combinationChanged) await validateCombination(tx, input.countryCode, input.transportMethod, id);
    const [row] = await tx.update(serviceMappings).set({ countryCode: input.countryCode, transportMethod: input.transportMethod, transportMethodId,
      service: input.service, version: current.version + 1, updatedBy: actorId, updatedAt: new Date() }).where(eq(serviceMappings.id, id)).returning();
    return { row: row!, before: current };
  });
}
export async function deleteServiceMapping(id: string, actorId: string, raw: ServiceMappingDeleteInput): Promise<ServiceMappingMutationResult> {
  const input = serviceMappingDeleteInputSchema.parse(raw), action = 'service_mapping.delete';
  return mutation(actorId, input.operationId, action, { id, ...input }, input.reason, async (tx) => {
    const current = await lockedMapping(tx, id, input.expectedVersion), now = new Date();
    const [row] = await tx.update(serviceMappings).set({ deletedAt: now, updatedAt: now, updatedBy: actorId, version: current.version + 1 }).where(eq(serviceMappings.id, id)).returning();
    return { row: row!, before: current };
  });
}
