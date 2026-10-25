import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PHYSICAL_RULE_VERSION, type BatchIssue, type PhysicalAdopt, type PhysicalConfirmation, type PhysicalReview, type PhysicalRevision, type PhysicalSave, type PhysicalSource, type PhysicalWrite } from '@scm/contracts';
import { db } from '../../db/client.js';
import { operationAudit } from '../../db/schema.js';
import { batchOperations } from '../batches/schema.js';
import { BatchError, getConfirmedGroupInTx, getSubBatchDetail, requireBatchActor, type BatchTx } from '../batches/service.js';
import { pendingEntries, validatePhysicalEntries } from './domain.js';
import { loadHistoricalSource } from './sources.js';
import { physicalConfirmations, physicalRevisions, physicalReviewStates, physicalSources, physicalSyncRuns } from './schema.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const physicalDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export type PhysicalBundle = Awaited<ReturnType<typeof getConfirmedGroupInTx>>;
export type PhysicalContext = { bundle: PhysicalBundle; state: typeof physicalReviewStates.$inferSelect | undefined };
export async function lockPhysical(tx: BatchTx, groupId: string, actorId: string): Promise<PhysicalContext> {
  const bundle = await getConfirmedGroupInTx(tx, groupId, actorId);
  const [state] = await tx.select().from(physicalReviewStates).where(eq(physicalReviewStates.groupId, groupId)).for('update');
  return { bundle, state };
}
export async function currentPhysicalSource(tx: BatchTx, context: PhysicalContext) {
  if (!context.state?.sourceId || context.state.m2ConfirmationId !== context.bundle.confirmation.id) return null;
  const [row] = await tx.select().from(physicalSources).where(eq(physicalSources.id, context.state.sourceId));
  return row?.data ?? null;
}
export async function assertPhysicalWrite(context: PhysicalContext, input: PhysicalWrite, tx?: BatchTx) {
  if (context.bundle.confirmation.id !== input.m2ConfirmationId || (context.state?.version ?? 0) !== input.expectedVersion) {
    throw new BatchError('VERSION_CONFLICT', 409, 'M2确认或实物核对版本已变化，请保留输入并重新核对。');
  }
  const source = tx ? await currentPhysicalSource(tx, context) : context.state?.sourceId && context.state.m2ConfirmationId === input.m2ConfirmationId
    ? (await db.select().from(physicalSources).where(eq(physicalSources.id, context.state.sourceId)))[0]?.data ?? null : null;
  if ((source?.fingerprint ?? null) !== input.sourceFingerprint) throw new BatchError('SOURCE_CONFLICT', 409, '实物来源版本已经变化，请重新读取。');
}
export async function physicalOperation<T extends Record<string, unknown>>(actorId: string, operationId: string, action: string, input: unknown, execute: (tx: BatchTx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`batch-operation:${operationId}`},0))`);
    await requireBatchActor(tx, actorId);
    const requestHash = physicalDigest({ action, input });
    const [old] = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, operationId));
    if (old) {
      if (old.actorId !== actorId || old.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于不同请求，请勿覆盖原提交。');
      return { ...old.result, replayed: true } as T & { operationId: string; replayed: boolean };
    }
    const result = { ...await execute(tx), operationId, replayed: false };
    await tx.insert(batchOperations).values({ operationId, actorId, action, requestHash, result });
    await tx.insert(operationAudit).values({ id: randomUUID(), action, targetId: typeof result.groupId === 'string' ? result.groupId : operationId, actorUserId: actorId, requestHash, details: { operationId } });
    return result;
  });
}

/** Caller holds the week/group/M3 locks. Publishing evidence never adopts it. */
export async function publishPhysicalSource(tx: BatchTx, source: PhysicalSource) {
  const [old] = await tx.select().from(physicalSources).where(eq(physicalSources.id, source.id));
  if (old) {
    if (old.m2ConfirmationId !== source.m2ConfirmationId || old.fingerprint !== source.fingerprint) throw new BatchError('SOURCE_CONFLICT', 409, '同一来源编号不能替换内容。');
    return old.data;
  }
  await tx.insert(physicalSources).values({ id: source.id, groupId: source.groupId, m2ConfirmationId: source.m2ConfirmationId, fingerprint: source.fingerprint, data: source, createdAt: new Date(source.createdAt) });
  const [state] = await tx.select().from(physicalReviewStates).where(eq(physicalReviewStates.groupId, source.groupId)).for('update');
  if (state?.m2ConfirmationId === source.m2ConfirmationId && state.sourceId) {
    const [accepted] = await tx.select().from(physicalSources).where(eq(physicalSources.id, state.sourceId));
    if (!source.identityValid || accepted?.fingerprint !== source.fingerprint) {
      await tx.update(physicalReviewStates).set({ pendingChange: true, updatedAt: new Date() }).where(eq(physicalReviewStates.groupId, source.groupId));
    }
  }
  await tx.insert(operationAudit).values({ id: randomUUID(), action: 'physical.source.observe', targetId: source.groupId, actorUserId: source.createdBy,
    requestHash: source.fingerprint, details: { sourceId: source.id, origin: source.origin, identityValid: String(source.identityValid) } });
  return source;
}
async function nextRevision(tx: BatchTx, context: PhysicalContext, source: PhysicalSource, entries: PhysicalRevision['entries'], actorId: string, action: string) {
  const version = (context.state?.version ?? 0) + 1;
  const revision: PhysicalRevision = { id: randomUUID(), groupId: context.bundle.group.id, m2ConfirmationId: context.bundle.confirmation.id, version,
    sourceId: source.id, sourceFingerprint: source.fingerprint, entries, action, createdBy: actorId, createdAt: new Date().toISOString() };
  await tx.insert(physicalRevisions).values({ id: revision.id, groupId: revision.groupId, m2ConfirmationId: revision.m2ConfirmationId, version, data: revision });
  await tx.insert(physicalReviewStates).values({ groupId: revision.groupId, m2ConfirmationId: revision.m2ConfirmationId, version, sourceId: source.id, revisionId: revision.id, confirmationId: null, pendingChange: false })
    .onConflictDoUpdate({ target: physicalReviewStates.groupId, set: { m2ConfirmationId: revision.m2ConfirmationId, version, sourceId: source.id, revisionId: revision.id, confirmationId: null,
      pendingChange: action === 'adopt' ? false : context.state?.pendingChange ?? false, updatedAt: new Date() } });
  return revision;
}
export async function adoptPhysicalSource(groupId: string, input: PhysicalAdopt, actorId: string) {
  return physicalOperation(actorId, input.operationId, 'physical.source.adopt', { groupId, ...input }, async (tx) => {
    const context = await lockPhysical(tx, groupId, actorId); await assertPhysicalWrite(context, input, tx);
    const candidate = context.bundle.confirmation.id === input.sourceId ? await loadHistoricalSource(context.bundle, actorId) : null;
    if (candidate) await publishPhysicalSource(tx, candidate);
    const [row] = await tx.select().from(physicalSources).where(eq(physicalSources.id, input.sourceId));
    if (!row || row.groupId !== groupId || row.m2ConfirmationId !== input.m2ConfirmationId) throw new BatchError('SOURCE_UNAVAILABLE', 422, '来源不属于当前M2确认，请重新采集。');
    const [latest] = await tx.select().from(physicalSources).where(and(eq(physicalSources.groupId, groupId), eq(physicalSources.m2ConfirmationId, input.m2ConfirmationId))).orderBy(desc(physicalSources.createdAt), desc(physicalSources.id)).limit(1);
    if (latest?.id !== row.id) throw new BatchError('SOURCE_SUPERSEDED', 409, '已有更新的采集证据，请核对并采用最新来源。');
    if (!row.data.identityValid) throw new BatchError('IDENTITY_CONFLICT', 422, '箱身份、商品或数量不匹配，请返回M2映射或更正流程。', row.data.issues);
    const accepted = await currentPhysicalSource(tx, context);
    if (accepted?.fingerprint === row.fingerprint) {
      await tx.update(physicalReviewStates).set({ sourceId: row.id, pendingChange: false, updatedAt: new Date() }).where(eq(physicalReviewStates.groupId, groupId));
      return { groupId, version: context.state!.version };
    }
    const revision = await nextRevision(tx, context, row.data, pendingEntries(row.data), actorId, 'adopt');
    return { groupId, version: revision.version };
  });
}
export async function savePhysicalRevision(groupId: string, input: PhysicalSave, actorId: string) {
  return physicalOperation(actorId, input.operationId, 'physical.review.save', { groupId, ...input }, (tx) => savePhysicalRevisionInTx(tx, groupId, input, actorId));
}
export async function savePhysicalRevisionInTx(tx: BatchTx, groupId: string, input: PhysicalSave, actorId: string) {
    const context = await lockPhysical(tx, groupId, actorId); await assertPhysicalWrite(context, input, tx);
    const source = await currentPhysicalSource(tx, context);
    if (!source) throw new BatchError('SOURCE_REQUIRED', 422, '请先采用可信领星来源。');
    let entries = validatePhysicalEntries(source, input.entries, false);
    const [previous] = context.state?.revisionId ? await tx.select().from(physicalRevisions).where(eq(physicalRevisions.id, context.state.revisionId)) : [];
    if (previous && physicalDigest(previous.data.entries) === physicalDigest(entries)) return { groupId, version: context.state!.version };
    if (context.state?.confirmationId) entries = entries.map((entry) => ({ ...entry, status: 'pending' as const }));
    const revision = await nextRevision(tx, context, source, entries, actorId, context.state?.confirmationId ? 'reopen' : 'save');
    return { groupId, version: revision.version };
}
export async function confirmPhysicalReview(groupId: string, input: PhysicalWrite, actorId: string) {
  return physicalOperation(actorId, input.operationId, 'physical.review.confirm', { groupId, ...input }, async (tx) => {
    const context = await lockPhysical(tx, groupId, actorId); await assertPhysicalWrite(context, input, tx);
    const source = await currentPhysicalSource(tx, context);
    if (!source) throw new BatchError('SOURCE_REQUIRED', 422, '请先采用可信来源。');
    if (context.state?.pendingChange) throw new BatchError('SOURCE_CHANGE_PENDING', 409, '已发现来源变化，请先采用最新来源并整组重新核对。');
    if (!source.identityValid || source.issues.some((issue) => issue.severity === 'error')) throw new BatchError('VALIDATION_BLOCKED', 422, '来源仍有缺项或差异，不能确认。', source.issues);
    const [revision] = context.state?.revisionId ? await tx.select().from(physicalRevisions).where(eq(physicalRevisions.id, context.state.revisionId)) : [];
    if (!revision) throw new BatchError('REVIEW_REQUIRED', 422, '请完成逐箱核对并保存。');
    const entries = validatePhysicalEntries(source, revision.data.entries, true);
    const version = context.state!.version + 1;
    const confirmation: PhysicalConfirmation = { id: randomUUID(), groupId, m2ConfirmationId: input.m2ConfirmationId, m3Version: version,
      sourceFingerprint: source.fingerprint, snapshot: { source, entries, ruleVersion: PHYSICAL_RULE_VERSION }, createdBy: actorId, createdAt: new Date().toISOString() };
    await tx.insert(physicalConfirmations).values({ id: confirmation.id, groupId, m2ConfirmationId: input.m2ConfirmationId, m3Version: version, data: confirmation });
    await tx.update(physicalReviewStates).set({ version, confirmationId: confirmation.id, updatedAt: new Date() }).where(eq(physicalReviewStates.groupId, groupId));
    return { groupId, version };
  });
}
export async function getValidPhysicalConfirmationInTx(tx: BatchTx, groupId: string, actorId: string) {
  const context = await lockPhysical(tx, groupId, actorId);
  const state = context.state;
  if (!state?.confirmationId || state.m2ConfirmationId !== context.bundle.confirmation.id || state.pendingChange) throw new BatchError('PHYSICAL_CONFIRMATION_REQUIRED', 409, '需要当前有效的实物整组确认，且不能有待采用的来源变化。');
  const [row] = await tx.select().from(physicalConfirmations).where(eq(physicalConfirmations.id, state.confirmationId));
  const source = await currentPhysicalSource(tx, context);
  if (!row || row.m3Version !== state.version || row.data.sourceFingerprint !== source?.fingerprint) throw new BatchError('PHYSICAL_CONFIRMATION_STALE', 409, '实物确认已经过期。');
  return row.data;
}
const issue = (code: string, message: string): BatchIssue => ({ code, message, severity: 'error' });
export async function getPhysicalReview(groupId: string, actorId: string): Promise<PhysicalReview> {
  const detail = await getSubBatchDetail(groupId, actorId);
  let bundle: PhysicalBundle | null = null;
  const blocked: BatchIssue[] = [];
  try { bundle = await db.transaction((tx) => getConfirmedGroupInTx(tx, groupId, actorId)); }
  catch (error) { if (!(error instanceof BatchError)) throw error; blocked.push(issue(error.code, error.message)); }
  const [state] = await db.select().from(physicalReviewStates).where(eq(physicalReviewStates.groupId, groupId));
  const history = await getPhysicalHistory(groupId, actorId);
  const sameM2 = state?.m2ConfirmationId === (bundle?.confirmation.id ?? detail.confirmation?.id);
  const source = sameM2 ? history.sources.find((s) => s.id === state?.sourceId) ?? null : null;
  const revision = sameM2 ? history.revisions.find((r) => r.id === state?.revisionId) ?? null : null;
  const confirmation = history.confirmations.find((c) => c.id === state?.confirmationId) ?? null;
  const availableSources = history.sources.filter((s) => s.m2ConfirmationId === (bundle?.confirmation.id ?? detail.confirmation?.id));
  if (bundle && !availableSources.length) {
    try { const historical = await loadHistoricalSource(bundle, actorId); if (historical) availableSources.push(historical); }
    catch { blocked.push(issue('HISTORICAL_SOURCE_UNAVAILABLE', '绑定的原始快照缺失或校验失败，请联系管理员检查文件或显式重新同步。')); }
  }
  availableSources.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  if (!source) blocked.push(issue('SOURCE_REQUIRED', '请核对并采用领星来源；若无可信历史证据，请显式同步。'));
  if (source) blocked.push(...source.issues.filter((i) => i.severity === 'error'));
  const pendingChange = sameM2 && !!state?.pendingChange;
  if (pendingChange) blocked.push(issue('SOURCE_CHANGE_PENDING', '已发现新来源存在实质变化，请采用后整组重新核对。'));
  let complete = false;
  if (source && revision) {
    try { validatePhysicalEntries(source, revision.entries, true); complete = true; }
    catch (error) { blocked.push(issue('REVIEW_INCOMPLETE', error instanceof Error ? error.message : '逐箱核对尚未完成。')); }
  }
  const readOnly = detail.group.status === 'superseded';
  const valid = !!bundle && sameM2 && !readOnly && !pendingChange && !!confirmation && confirmation.m3Version === state?.version && confirmation.sourceFingerprint === source?.fingerprint;
  const rows = await db.select().from(physicalSyncRuns).where(eq(physicalSyncRuns.groupId, groupId)).orderBy(desc(physicalSyncRuns.createdAt)).limit(50);
  return { groupId, m2ConfirmationId: bundle?.confirmation.id ?? detail.confirmation?.id ?? null, version: state?.version ?? 0,
    source, availableSources, revision, confirmation, valid, canConfirm: !valid && !readOnly && complete && blocked.length === 0, canExport: valid && blocked.length === 0,
    readOnly, pendingChange, blocked, runs: rows.map((r) => ({ ...r, status: r.status as PhysicalReview['runs'][number]['status'], createdAt: r.createdAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null })) };
}
export async function getPhysicalHistory(groupId: string, actorId: string) {
  await db.transaction((tx) => requireBatchActor(tx, actorId));
  const [sources, revisions, confirmations] = await Promise.all([
    db.select().from(physicalSources).where(eq(physicalSources.groupId, groupId)).orderBy(desc(physicalSources.createdAt)),
    db.select().from(physicalRevisions).where(eq(physicalRevisions.groupId, groupId)).orderBy(desc(physicalRevisions.version)),
    db.select().from(physicalConfirmations).where(eq(physicalConfirmations.groupId, groupId)).orderBy(desc(physicalConfirmations.m3Version)),
  ]);
  return { sources: sources.map((r) => r.data), revisions: revisions.map((r) => r.data), confirmations: confirmations.map((r) => r.data) };
}
