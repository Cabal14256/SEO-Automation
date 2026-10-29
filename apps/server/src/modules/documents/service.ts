import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { applyDocumentAddress, documentBoxSources, documentCreateInputSchema, documentCorrectInputSchema, documentListQuerySchema, documentOperationInputSchema, documentProfileWriteSchema, documentRevisionInputSchema, documentReviewInputSchema, resolveDocumentLingxingAddress, withDocumentDefaults, withDocumentInvoiceDefaults,
  type Document, type DocumentCandidate, type DocumentCandidateList, type DocumentCandidateQuery, type DocumentListQuery, type DocumentMemberSnapshot, type DocumentProfile, type DocumentRevision, type DocumentRevisionData, type DocumentTemplate, type DocumentValidation } from '@scm/contracts';
import { db } from '../../db/client.js';
import { fileIndex, operationAudit } from '../../db/schema.js';
import { batchOperations, subBatches, weeklyBatches } from '../batches/schema.js';
import { BatchError, getConfirmedGroupInTx, requireBatchActor, type BatchTx } from '../batches/service.js';
import { checkedFileBytes } from '../imports/service.js';
import { documentAddressSourceKey, documentBoxFieldIssues, documentDependencyInvalidReason, documentDigest, documentM2SourceReference, documentUsesProfileReference, memberFromCandidate, reviseDocumentBoxFields, shipmentClaimKey, shouldResolveDocumentAddress, validateDocumentData } from './domain.js';
import { haveDocumentAddressSourcesChanged, reviseDocumentAddressFields } from './address.js';
import { checkedDocumentExportFile, documentExportFileSha256 } from './export-file.js';
import { documentExports, documentMemberClaims, documentProfiles, documentProfileVersions, documentRevisions, documentReviews, documents, documentTemplates, documentTemplateVersions, documentValidations } from './schema.js';
import { loadDocumentSourceCandidates } from './sources.js';
import { assertDocumentImageChanges, assertProductImageChange } from './image-fields.js';
import { documentListWhere, needsDocumentStatusFilter } from './query.js';
import { shippingRuns, shippingTicketMembers } from '../shipping-runs/schema.js';
import { applyDocumentManualSalesPricesInTx } from './manual-sales-price.js';
import { applyDocumentAddressCodeDefaults, hydrateDocumentAddressCodeSourcesInTx, validateDocumentAddressCode } from './address-code-service.js';
import { DocumentAddressCodeCatalogError, loadDocumentAddressCodeCatalog } from './address-code-catalog.js';

export { BatchError as DocumentError } from '../batches/service.js';
type CreateInput = z.infer<typeof documentCreateInputSchema>;
type RevisionInput = z.infer<typeof documentRevisionInputSchema>;
type OperationInput = z.infer<typeof documentOperationInputSchema>;
type ProfileInput = z.infer<typeof documentProfileWriteSchema>;
export const serializeDocumentRevision = (row: typeof documentRevisions.$inferSelect): DocumentRevision => ({ ...row, createdAt: row.createdAt.toISOString() });
export function serializeDocument(row: typeof documents.$inferSelect, revision: typeof documentRevisions.$inferSelect): Document {
  return { id: row.id, purpose: row.purpose as Document['purpose'], status: row.status as Document['status'], version: row.version, currentRevision: serializeDocumentRevision(revision), createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export function serializeProfile(row: typeof documentProfiles.$inferSelect): DocumentProfile { return { ...row, status: row.status as DocumentProfile['status'], createdAt: row.createdAt.toISOString() }; }
export async function documentOperation<T extends Record<string, unknown>>(actorId: string, operationId: string, action: string, input: unknown, execute: (tx: BatchTx) => Promise<T>): Promise<T & { replayed: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-operation:${operationId}`},0))`);
    await requireBatchActor(tx, actorId);
    const requestHash = documentDigest({ action, input });
    const [existing] = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, operationId));
    if (existing) { if (existing.actorId !== actorId || existing.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于不同请求。'); return { ...existing.result, replayed: true } as T & { replayed: boolean }; }
    const result = await execute(tx);
    await tx.insert(batchOperations).values({ operationId, actorId, action, requestHash, result });
    const details: { operationId: string; reason?: string } = { operationId };
    if (action === 'document.cancel') details.reason = z.object({ reason: documentOperationInputSchema.shape.reason }).parse(input).reason;
    await tx.insert(operationAudit).values({ id: randomUUID(), action, targetId: typeof result.documentId === 'string' ? result.documentId : operationId, actorUserId: actorId, requestHash, details });
    return { ...result, replayed: false };
  });
}
export async function lockedDocument(tx: BatchTx, id: string, actorId: string, expectedVersion?: number) {
  await requireBatchActor(tx, actorId);
  const [record] = await tx.select().from(documents).where(eq(documents.id, id)).for('update');
  if (!record) throw new BatchError('NOT_FOUND', 404, '单据不存在。');
  if (expectedVersion !== undefined && record.version !== expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '单据版本已变化，请保留输入并重新读取。');
  const [revision] = record.currentRevisionId ? await tx.select().from(documentRevisions).where(eq(documentRevisions.id, record.currentRevisionId)) : [];
  if (!revision) throw new BatchError('DOCUMENT_REVISION_UNAVAILABLE', 503, '单据修订缺失，请联系管理员。');
  return { record, revision };
}
const blocker = (code: string, message: string, groupId: string, demandId?: string): DocumentValidation['issues'][number] => ({ code, severity: 'error', message, groupId, ...(demandId ? { demandId } : {}) });
export async function documentCandidatesInTx(tx: BatchTx, actorId: string, input: DocumentCandidateQuery | string = {}): Promise<DocumentCandidateList> {
  await requireBatchActor(tx, actorId);
  const scope = typeof input === 'string' ? { weekStartDate: input } : input;
  const batches = await tx.select().from(weeklyBatches);
  if (!batches.length) return { items: [], total: 0, ...scope };
  const loadOccurrences = Boolean(scope.shippingRunId || scope.month || batches.some((batch) => batch.shippingRunId));
  const runs = loadOccurrences ? await tx.select().from(shippingRuns).where(and(eq(shippingRuns.lifecycle, 'active'), eq(shippingRuns.lifecyclePending, false), scope.shippingRunId ? eq(shippingRuns.id, scope.shippingRunId) : undefined, scope.month ? eq(shippingRuns.month, scope.month) : undefined)) : [];
  const links = loadOccurrences && runs.length ? await tx.select().from(shippingTicketMembers).where(and(inArray(shippingTicketMembers.runId, runs.map((run) => run.id)), isNull(shippingTicketMembers.releasedAt))) : [];
  const scoped = Boolean(scope.shippingRunId || scope.month);
  const selectedGroupIds = [...new Set(links.flatMap((link) => link.groupId ? [link.groupId] : []))];
  if (scoped && !selectedGroupIds.length) return { items: [], total: 0, ...scope };
  const groups = await tx.select().from(subBatches).where(and(eq(subBatches.lifecycle, 'active'), eq(subBatches.lifecyclePending, false), inArray(subBatches.status, ['confirmed', 'frozen']), scoped ? inArray(subBatches.id, selectedGroupIds) : undefined)).orderBy(asc(subBatches.id));
  const items: DocumentCandidate[] = [];
  for (const group of groups) {
    let bundle: Awaited<ReturnType<typeof getConfirmedGroupInTx>>;
    try { bundle = await getConfirmedGroupInTx(tx, group.id, actorId, false); }
    catch (error) { if (error instanceof BatchError && [409, 422].includes(error.status)) continue; throw error; }
    for (const entry of bundle.shipments) {
      const demand = bundle.members.find((member) => member.id === entry.demandId);
      if (!demand) continue;
      const link = links.find((member) => member.demandId === demand.id && member.groupId === group.id), run = runs.find((entry) => entry.id === link?.runId);
      if (scoped && !link) continue;
      const codes = bundle.codes.filter((code) => code.demandId === demand.id), blockers: DocumentValidation['issues'] = [];
      if (entry.revision.data.boxes.some((box) => !codes.some((code) => code.valid && code.boxId === box.id))) blockers.push(blocker('CODES_REQUIRED', '来源组尚未完成箱码。', group.id, demand.id));
      const sourceCandidates = await loadDocumentSourceCandidates(tx, { demand, shipment: entry.revision, physical: null });
      const boxSource = documentBoxSources({ demand, shipment: entry.revision, codes, physical: null }).map((box) => ({ ...box, po: sourceCandidates.po ?? null }));
      if (sourceCandidates.issues.some((issue) => issue.code === 'DOCUMENT_SOURCE_FILE_INVALID')) blockers.push(blocker('DOCUMENT_SOURCE_FILE_INVALID', '绑定的原始来源文件无法通过哈希或身份校验，请联系管理员处理后生成。', group.id, demand.id));
      items.push({ ...(run ? { shippingRunId: run.id, shippingRunMonth: run.month, shippingRunSequence: run.sequence } : {}), demandId: demand.id, demandVersion: demand.version, weekStartDate: demand.weekStartDate, weekEndDate: demand.weekEndDate, groupId: group.id, groupName: group.name, groupVersion: bundle.confirmation.groupVersion, groupStatus: group.status as DocumentCandidate['groupStatus'], m2ConfirmationId: bundle.confirmation.id,
        demand, shipment: entry.revision, codes, physicalConfirmationId: null, m3Version: null, sourceFingerprint: null, physical: null, boxSource, sourceCandidates, blockers });
    }
  }
  return { items, total: items.length, ...scope };
}
export async function listDocumentCandidates(actorId: string, scope: DocumentCandidateQuery | string = {}) { return db.transaction((tx) => documentCandidatesInTx(tx, actorId, scope)); }
async function selectMembers(tx: BatchTx, actorId: string, scope: DocumentCandidateQuery | string, demandIds: string[]): Promise<DocumentMemberSnapshot[]> {
  if (new Set(demandIds).size !== demandIds.length) throw new BatchError('DUPLICATE_DOCUMENT_MEMBER', 422, '货件范围不能重复。');
  const available = await documentCandidatesInTx(tx, actorId, scope), byId = new Map(available.items.map((candidate) => [candidate.demandId, candidate]));
  const selected = demandIds.map((id) => byId.get(id));
  if (selected.some((candidate) => !candidate)) throw new BatchError('DOCUMENT_MEMBER_UNAVAILABLE', 422, '所选货件不属于当前发货范围的有效完整制表确认，请刷新候选。');
  const members = selected.map((candidate) => memberFromCandidate(candidate!));
  if (new Set(members.map(shipmentClaimKey)).size !== members.length) throw new BatchError('DUPLICATE_DOCUMENT_MEMBER', 422, '同一店铺的完整 FBA 不能重复出单。');
  return members;
}
async function claimMembers(tx: BatchTx, documentId: string, revisionId: string, data: DocumentRevisionData) {
  for (const member of [...data.members].sort((left, right) => shipmentClaimKey(left).localeCompare(shipmentClaimKey(right)))) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-member:${data.purpose}:${shipmentClaimKey(member)}`},0))`);
    const [claim] = await tx.select().from(documentMemberClaims).where(and(eq(documentMemberClaims.purpose, data.purpose), eq(documentMemberClaims.sid, member.demand.snapshot.sid), eq(documentMemberClaims.fba, member.demand.snapshot.fba.trim().toUpperCase()), isNull(documentMemberClaims.releasedAt)));
    if (claim && claim.documentId !== documentId) throw new BatchError('DOCUMENT_MEMBER_CLAIMED', 409, '所选货件已被另一张未取消、未替代的发票占用。', { demandId: member.demand.id, documentId: claim.documentId });
  }
  await tx.update(documentMemberClaims).set({ releasedAt: new Date() }).where(and(eq(documentMemberClaims.documentId, documentId), isNull(documentMemberClaims.releasedAt)));
  for (const member of data.members) await tx.insert(documentMemberClaims).values({ id: randomUUID(), purpose: data.purpose, sid: member.demand.snapshot.sid, fba: member.demand.snapshot.fba.trim().toUpperCase(), demandId: member.demand.id, documentId, revisionId });
}
/** Defaults use archived Lingxing shipment evidence; local address profiles are historical only. */
export async function applyDocumentAutomaticDefaultsInTx(tx: BatchTx, data: DocumentRevisionData, previous?: DocumentRevisionData): Promise<DocumentRevisionData> {
  const finish = (value: DocumentRevisionData) => applyDocumentAddressCodeDefaults(value).catch(addressCodeCatalogFailure);
  data = await hydrateDocumentAddressCodeSourcesInTx(tx, data);
  const fields = withDocumentInvoiceDefaults(data.fields, data.members);
  let next = { ...data, fields };
  if (!shouldResolveDocumentAddress(next, previous)) return finish(next);
  const sourceChanged = Boolean(previous && (documentAddressSourceKey(previous.members) !== documentAddressSourceKey(next.members) || haveDocumentAddressSourcesChanged(previous.members, next.members)));
  if (sourceChanged) next = { ...next, profileReferences: next.profileReferences.filter((reference) => reference.category !== 'address'), fields: {
    ...next.fields, addressConfirmed: 'false', addressConfirmationReason: '', addressAdoptionVersion: 'explicit/v1', addressSelectionMode: 'manual', addressSourceLabel: '来源已变化，请人工核对本票地址',
  } };
  const address = resolveDocumentLingxingAddress(next.members);
  if (!address) return finish(next.fields.addressSelectionMode === 'profile' ? { ...next, fields: { ...next.fields, addressConfirmed: 'false', addressConfirmationReason: '', addressSelectionMode: 'manual', addressSourceLabel: '历史地址待核对，请维护领星货件地址或确认本票地址' } } : next);
  return finish({ ...next, fields: { ...applyDocumentAddress(next.fields, address), addressSelectionMode: 'lingxing', addressSourceLabel: '领星货件地址' },
    profileReferences: next.profileReferences.filter((reference) => reference.category !== 'address'),
  });
}
function addressCodeCatalogFailure(error: unknown): never {
  if (error instanceof DocumentAddressCodeCatalogError) throw new BatchError(error.code, 503, error.message);
  throw error;
}

async function appendRevision(tx: BatchTx, id: string, version: number, data: DocumentRevisionData, actorId: string, reason: string, previous?: DocumentRevisionData) {
  data = { ...data, fields: withDocumentDefaults(data.fields) };
  if (data.productSourceFacts) data.productSourceFacts = data.productSourceFacts.filter((fact) => data.members.some((member) => member.demand.snapshot.sid === fact.sid
    && member.shipment.data.items.some((item) => item.msku === fact.msku && item.fnsku === fact.fnsku && item.sku === fact.sku)));
  if (data.manualSalesPrices) data.manualSalesPrices = data.manualSalesPrices.filter((manual) => data.members.some((member) => member.demand.snapshot.sid === manual.sid
    && member.shipment.data.items.some((item) => item.msku === manual.msku && item.fnsku === manual.fnsku && item.sku === manual.sku)));
  const boxIssues = documentBoxFieldIssues(data);
  if (boxIssues.length) throw new BatchError(boxIssues[0]!.code, 422, boxIssues[0]!.message, boxIssues);
  data = await applyDocumentAutomaticDefaultsInTx(tx, data, previous);
  const [revision] = await tx.insert(documentRevisions).values({ id: randomUUID(), documentId: id, version, data, createdBy: actorId, reason }).returning();
  await claimMembers(tx, id, revision!.id, data);
  const [record] = await tx.update(documents).set({ version, currentRevisionId: revision!.id, status: 'draft', updatedAt: new Date() }).where(eq(documents.id, id)).returning();
  return serializeDocument(record!, revision!);
}
export { appendRevision as appendDocumentRevisionInTx };
export async function createDocument(actorId: string, input: CreateInput) {
  assertDocumentImageChanges({}, input.fields);
  return documentOperation(actorId, input.operationId, 'document.create', input, async (tx) => {
    const members = await selectMembers(tx, actorId, { shippingRunId: input.shippingRunId }, input.demandIds), id = randomUUID();
    const source = members[0]!.source;
    await tx.insert(documents).values({ id, purpose: input.purpose, createdBy: actorId });
    const document = await appendRevision(tx, id, 1, { purpose: input.purpose, weekStartDate: input.weekStartDate ?? members[0]!.demand.weekStartDate, ...(input.shippingRunId ? { shippingRunId: input.shippingRunId, shippingRunMonth: source.shippingRunMonth, shippingRunSequence: source.shippingRunSequence } : {}), title: input.title, fields: input.fields, members, profileReferences: [], templateReference: null, generationRulesVersion: 'v2', productSourceFacts: [] }, actorId, '建立发票草稿');
    return { documentId: id, document };
  });
}
async function authoritativeReferences(tx: BatchTx, input: Pick<RevisionInput, 'profileReferences' | 'templateReference'>, previous: DocumentRevisionData, scope: DocumentRevisionData = previous) {
  const profileReferences: DocumentRevisionData['profileReferences'] = [];
  for (const reference of input.profileReferences ?? previous.profileReferences) {
    const saved = previous.profileReferences.find((entry) => entry.category === reference.category && entry.profileId === reference.profileId && entry.version === reference.version);
    if (reference.category === 'address') {
      if (!saved) throw new BatchError('DOCUMENT_ADDRESS_SOURCE_ONLY', 422, '收件地址以领星货件资料为准，不再采用本地地址簿。');
      profileReferences.push(saved); continue;
    }
    if (saved && !documentUsesProfileReference(scope, saved)) { profileReferences.push(saved); continue; }
    const [profile] = await tx.select().from(documentProfiles).where(eq(documentProfiles.id, reference.profileId)).for('share');
    const [version] = await tx.select().from(documentProfileVersions).where(and(eq(documentProfileVersions.profileId, reference.profileId), eq(documentProfileVersions.version, reference.version)));
    if (!profile || profile.status !== 'active' || profile.category !== reference.category || !version) throw new BatchError('DOCUMENT_PROFILE_UNAVAILABLE', 422, '所选资料版本不存在或已停用。');
    profileReferences.push({ category: profile.category, profileId: profile.id, version: version.version, data: version.data });
  }
  const requested = input.templateReference === undefined ? previous.templateReference : input.templateReference;
  if (!requested) return { profileReferences, templateReference: null };
  const [template] = await tx.select().from(documentTemplates).where(eq(documentTemplates.id, requested.templateId)).for('share');
  const [version] = await tx.select().from(documentTemplateVersions).where(and(eq(documentTemplateVersions.templateId, requested.templateId), eq(documentTemplateVersions.version, requested.version)));
  if (!template || template.status !== 'active' || !version || version.sha256 !== requested.sha256 || version.fileId !== requested.fileId || template.purpose !== previous.purpose) throw new BatchError('DOCUMENT_TEMPLATE_UNAVAILABLE', 422, '所选模板版本不存在、内容不符或已停用。');
  return { profileReferences, templateReference: { templateId: template.id, version: version.version, sha256: version.sha256, fileId: version.fileId } };
}
export { authoritativeReferences as resolveDocumentReferencesInTx };
export async function reviseDocument(id: string, actorId: string, input: RevisionInput) {
  return documentOperation(actorId, input.operationId, 'document.revise', { id, ...input }, (tx) => reviseDocumentInTx(tx, id, actorId, input));
}
/** Reuse every revision gate when a larger audited operation already owns the transaction. */
export async function reviseDocumentInTx(tx: BatchTx, id: string, actorId: string, input: RevisionInput) {
    const { record, revision } = await lockedDocument(tx, id, actorId, input.expectedVersion);
    if (['cancelled', 'superseded'].includes(record.status)) throw new BatchError('DOCUMENT_READ_ONLY', 409, '已取消或被替代的单据只读。');
    const [file] = await tx.select({ id: documentExports.id }).from(documentExports).where(and(eq(documentExports.status, 'completed'), sql`${documentExports.reference}->>'documentId' = ${id}`)).limit(1);
    if (file) throw new BatchError('DOCUMENT_CORRECTION_REQUIRED', 409, '已有文件的发票请通过更正建立新单据并移交成员。');
    const members = input.demandIds ? await selectMembers(tx, actorId, { shippingRunId: revision.data.shippingRunId }, input.demandIds) : revision.data.members;
    const scope = { ...revision.data, members };
    let data = { ...revision.data, ...(input.title ? { title: input.title } : {}), ...(input.fields ? { fields: input.fields } : {}), ...await authoritativeReferences(tx, input, revision.data, scope), members };
    if (input.fields && Object.hasOwn(input.fields, 'addressCode') && !Object.hasOwn(input.fields, 'addressSelectionMode')
      && input.fields.addressCode?.trim() !== revision.data.fields.addressCode?.trim()) data.fields = { ...data.fields, addressSelectionMode: 'manual' };
    const addresses = (value: DocumentRevisionData) => value.profileReferences.filter((reference) => reference.category === 'address').map((reference) => [reference.profileId, reference.version]);
    const addressEvidenceChanged = documentDigest(addresses(data)) !== documentDigest(addresses(revision.data)) || haveDocumentAddressSourcesChanged(revision.data.members, data.members);
    data.fields = reviseDocumentAddressFields(revision.data.fields, data.fields, Boolean(input.confirmAddress && input.fields), addressEvidenceChanged);
    const { reviseDocumentProductFields } = await import('./workbook.js');
    data.fields = reviseDocumentProductFields(revision.data, data, input.fields);
    data.fields = reviseDocumentBoxFields(revision.data, data);
    data = await applyDocumentManualSalesPricesInTx(tx, data, actorId, input.manualSalesPrices);
    assertDocumentImageChanges(revision.data.fields, data.fields);
    return { documentId: id, document: await appendRevision(tx, id, record.version + 1, data, actorId, input.reason, revision.data) };
}
type DocumentListCandidate = Pick<typeof documents.$inferSelect, 'id' | 'status'> & { revisionId: string };
async function documentListStatuses(tx: BatchTx, actorId: string, candidates: DocumentListCandidate[]) {
  const statuses = new Map(candidates.map((record) => [record.id, record.status as Document['status']]));
  const active = candidates.filter((record) => !['cancelled', 'superseded', 'stale'].includes(record.status));
  const completed = new Set<string>();
  // Bound IN parameters for large, explicitly filtered history requests.
  for (let offset = 0; offset < active.length; offset += 500) {
    const ids = active.slice(offset, offset + 500).map((record) => record.id);
    const files = await tx.select({ documentId: sql<string>`${documentExports.reference}->>'documentId'` }).from(documentExports)
      .where(and(eq(documentExports.status, 'completed'), inArray(sql`${documentExports.reference}->>'documentId'`, ids)));
    for (const file of files) completed.add(file.documentId);
  }
  for (const record of active) {
    if (completed.has(record.id) && !(await documentDependencyValidityInTx(tx, record.id, record.revisionId, actorId)).valid) statuses.set(record.id, 'stale');
  }
  return statuses;
}
export async function listDocuments(actorId: string, input: DocumentListQuery) {
  const query = documentListQuerySchema.parse(input);
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const where = documentListWhere(query), offset = (query.page - 1) * query.pageSize;
    let total: number, statuses: Map<string, Document['status']>;
    let rows: { record: typeof documents.$inferSelect; revision: typeof documentRevisions.$inferSelect }[];
    if (needsDocumentStatusFilter(query.status)) {
      // Effective statuses can differ from stored statuses. Scan only metadata before
      // selecting a page, then hydrate its immutable revision snapshots below.
      const candidates = await tx.select({ id: documents.id, status: documents.status, revisionId: documentRevisions.id }).from(documents)
        .innerJoin(documentRevisions, eq(documents.currentRevisionId, documentRevisions.id)).where(where).orderBy(desc(documents.createdAt), desc(documents.id));
      statuses = await documentListStatuses(tx, actorId, candidates);
      const matching = candidates.filter((record) => statuses.get(record.id) === query.status);
      total = matching.length;
      const ids = matching.slice(offset, offset + query.pageSize).map((record) => record.id);
      rows = ids.length ? await tx.select({ record: documents, revision: documentRevisions }).from(documents)
        .innerJoin(documentRevisions, eq(documents.currentRevisionId, documentRevisions.id)).where(inArray(documents.id, ids)).orderBy(desc(documents.createdAt), desc(documents.id)) : [];
    } else {
      // active/all and terminal statuses have stable membership, so the normal
      // listing avoids checking dependencies or loading JSON outside this page.
      const [result] = await tx.select({ value: count() }).from(documents)
        .innerJoin(documentRevisions, eq(documents.currentRevisionId, documentRevisions.id)).where(where);
      total = result!.value;
      rows = await tx.select({ record: documents, revision: documentRevisions }).from(documents)
        .innerJoin(documentRevisions, eq(documents.currentRevisionId, documentRevisions.id)).where(where).orderBy(desc(documents.createdAt), desc(documents.id)).limit(query.pageSize).offset(offset);
      statuses = await documentListStatuses(tx, actorId, rows.map(({ record, revision }) => ({ id: record.id, status: record.status, revisionId: revision.id })));
    }
    const items = rows.map(({ record, revision }) => ({ ...serializeDocument(record, revision), status: statuses.get(record.id)! }));
    return { items, total, ...query };
  });
}
export async function getDocument(id: string, actorId: string) {
  return db.transaction(async (tx) => { const { record, revision } = await lockedDocument(tx, id, actorId); const validations = await tx.select().from(documentValidations).where(and(eq(documentValidations.documentId, id), eq(documentValidations.revisionId, revision.id))).orderBy(desc(documentValidations.checkedAt)).limit(1);
    const document = serializeDocument(record, revision); if (!['cancelled', 'superseded'].includes(record.status)) { const [file] = await tx.select({ id: documentExports.id }).from(documentExports).where(and(eq(documentExports.status, 'completed'), sql`${documentExports.reference}->>'documentId' = ${id}`)).limit(1); if (file && !(await documentDependencyValidityInTx(tx, id, revision.id, actorId)).valid) document.status = 'stale'; }
    return { document, validation: validations[0] ? { documentId: id, version: record.version, valid: validations[0].valid, issues: validations[0].issues, checkedAt: validations[0].checkedAt.toISOString() } : null }; });
}
export async function documentDependencyValidityInTx(tx: BatchTx, documentId: string, revisionId: string, actorId: string): Promise<{ valid: boolean; invalidReason: string | null }> {
  const { record } = await lockedDocument(tx, documentId, actorId);
  if (record.currentRevisionId !== revisionId || ['cancelled', 'superseded', 'stale'].includes(record.status)) return { valid: false, invalidReason: '单据已取消、来源作废、被替代或已有新修订，历史文件仅供追溯。' };
  const validation = await validateDocumentInTx(tx, documentId, actorId);
  const invalidReason = documentDependencyInvalidReason(validation.issues);
  if (invalidReason) return { valid: false, invalidReason };
  return { valid: true, invalidReason: null };
}
export async function validateDocumentInTx(tx: BatchTx, id: string, actorId: string, expectedVersion?: number): Promise<DocumentValidation> {
  const { record, revision } = await lockedDocument(tx, id, actorId, expectedVersion), issues = validateDocumentData(revision.data);
  if (revision.data.generationRulesVersion === 'v2' && revision.data.members.length) {
    const evidence = await hydrateDocumentAddressCodeSourcesInTx(tx, revision.data, true);
    issues.push(...validateDocumentAddressCode(evidence, await loadDocumentAddressCodeCatalog().catch(addressCodeCatalogFailure)));
    if (evidence.members.some((member) => member.sourceCandidates?.issues.some((issue) => issue.code === 'DOCUMENT_SOURCE_FILE_INVALID'))) issues.push({ code: 'DOCUMENT_SOURCE_FILE_INVALID', severity: 'error', message: 'B3 采用的领星货件原始文件缺失、身份无效或哈希不符，请重新核实来源。' });
  }
  if (['cancelled', 'superseded', 'stale'].includes(record.status)) issues.push({ code: 'DOCUMENT_READ_ONLY', severity: 'error', message: '单据已取消、来源作废或被替代，不能生成，请建立更正。' });
  const candidates = await documentCandidatesInTx(tx, actorId, { shippingRunId: revision.data.shippingRunId }), current = new Map(candidates.items.map((item) => [item.demandId, item]));
  for (const member of revision.data.members) {
    const candidate = current.get(member.demand.id);
    if (!candidate || documentDigest(documentM2SourceReference(memberFromCandidate(candidate).source)) !== documentDigest(documentM2SourceReference(member.source))) issues.push(blocker('DOCUMENT_SOURCE_STALE', '来源制表确认版本已变化，请显式采用当前来源或发起更正。', member.source.groupId, member.demand.id));
    else issues.push(...candidate.blockers);
    if (member.physical?.snapshot.source.snapshotIds.length) {
      const historical = await loadDocumentSourceCandidates(tx, member);
      if (historical.issues.some((issue) => issue.code === 'DOCUMENT_SOURCE_FILE_INVALID')) issues.push(blocker('DOCUMENT_SOURCE_FILE_INVALID', '本票历史来源文件无法通过哈希或身份校验，请联系管理员处理。', member.source.groupId, member.demand.id));
    }
  }
  for (const reference of revision.data.profileReferences) {
    if (!documentUsesProfileReference(revision.data, reference)) continue;
    const [profile] = await tx.select().from(documentProfiles).where(eq(documentProfiles.id, reference.profileId)).for('share');
    const [version] = await tx.select().from(documentProfileVersions).where(and(eq(documentProfileVersions.profileId, reference.profileId), eq(documentProfileVersions.version, reference.version)));
    if (!profile || profile.status !== 'active' || profile.category !== reference.category || !version || documentDigest(version.data) !== documentDigest(reference.data)) issues.push({ code: 'DOCUMENT_PROFILE_STALE', severity: 'error', message: '引用资料版本已停用或无法核验，请重新选择。', profileCategory: reference.category });
  }
  if (revision.data.generationRulesVersion === 'v2') {
    const sources = new Map((revision.data.productSourceFacts ?? []).map((fact) => [fact.sourceFileId, fact.sourceSha256]));
    for (const [sourceFileId, sourceSha256] of sources) {
      try {
        const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, sourceFileId));
        if (!file || file.sha256 !== sourceSha256) throw new Error('Source archive is missing or changed');
        await checkedFileBytes(file);
      } catch {
        issues.push({ code: 'DOCUMENT_SOURCE_FILE_INVALID', severity: 'error', message: '领星商品及箱规来源归档缺失或哈希不符，请重新查询并采用资料。' });
      }
    }
  }
  if (revision.data.templateReference) {
    const reference = revision.data.templateReference, [template] = await tx.select().from(documentTemplates).where(eq(documentTemplates.id, reference.templateId)).for('share');
    const [version] = await tx.select().from(documentTemplateVersions).where(and(eq(documentTemplateVersions.templateId, reference.templateId), eq(documentTemplateVersions.version, reference.version)));
    if (!template || template.status !== 'active' || template.purpose !== revision.data.purpose || version?.sha256 !== reference.sha256 || version?.fileId !== reference.fileId) issues.push({ code: 'DOCUMENT_TEMPLATE_STALE', severity: 'error', message: '引用模板版本已停用或无法核验。' });
  }
  const { validateWorkbookData } = await import('./workbook.js');
  issues.push(...validateWorkbookData(revision.data));
  return { documentId: id, version: record.version, valid: !issues.some((issue) => issue.severity === 'error'), issues, checkedAt: new Date().toISOString() };
}
export async function validateDocument(id: string, actorId: string, input: OperationInput) {
  return documentOperation(actorId, input.operationId, 'document.validate', { id, ...input }, async (tx) => { const validation = await validateDocumentInTx(tx, id, actorId, input.expectedVersion); const { revision } = await lockedDocument(tx, id, actorId);
    await tx.insert(documentValidations).values({ id: randomUUID(), documentId: id, revisionId: revision.id, valid: validation.valid, issues: validation.issues, checkedBy: actorId }); return { validation }; });
}
export async function cancelDocument(id: string, actorId: string, input: OperationInput) {
  return documentOperation(actorId, input.operationId, 'document.cancel', { id, ...input }, async (tx) => { const { record, revision } = await lockedDocument(tx, id, actorId, input.expectedVersion);
    if (['cancelled', 'superseded'].includes(record.status)) throw new BatchError('DOCUMENT_READ_ONLY', 409, '已取消或被替代的单据只读。');
    const [active] = await tx.select({ id: documentExports.id }).from(documentExports).where(and(inArray(documentExports.status, ['queued', 'running']), sql`${documentExports.reference}->>'documentId' = ${id}`)).limit(1);
    if (active) throw new BatchError('DOCUMENT_EXPORT_BUSY', 409, '当前发票仍在生成，请等待任务结束后删除单据。');
    await tx.update(documentMemberClaims).set({ releasedAt: new Date() }).where(and(eq(documentMemberClaims.documentId, id), isNull(documentMemberClaims.releasedAt)));
    const [updated] = await tx.update(documents).set({ status: 'cancelled', version: record.version + 1, updatedAt: new Date() }).where(eq(documents.id, id)).returning(); return { documentId: id, document: serializeDocument(updated!, revision) }; });
}
export async function correctDocument(id: string, actorId: string, input: z.infer<typeof documentCorrectInputSchema>) {
  return documentOperation(actorId, input.operationId, 'document.correct', { id, ...input }, async (tx) => { const { record, revision } = await lockedDocument(tx, id, actorId, input.expectedVersion);
    if (['cancelled', 'superseded'].includes(record.status)) throw new BatchError('DOCUMENT_READ_ONLY', 409, '该单据不能再次更正。');
    const members = await selectMembers(tx, actorId, { shippingRunId: revision.data.shippingRunId }, input.demandIds), successorId = randomUUID();
    const originalClaims = revision.data.members.map(shipmentClaimKey).sort(), nextClaims = members.map(shipmentClaimKey).sort();
    if (documentDigest(originalClaims) !== documentDigest(nextClaims)) throw new BatchError('DOCUMENT_CORRECTION_MEMBERS', 422, '更正须移交原票的完整货件范围；需要取消范围时请先取消原票。');
    await tx.update(documentMemberClaims).set({ releasedAt: new Date() }).where(and(eq(documentMemberClaims.documentId, id), isNull(documentMemberClaims.releasedAt)));
    await tx.insert(documents).values({ id: successorId, purpose: record.purpose, createdBy: actorId });
    const fields = reviseDocumentAddressFields(revision.data.fields, input.fields ?? revision.data.fields, Boolean(input.confirmAddress && input.fields), haveDocumentAddressSourcesChanged(revision.data.members, members));
    let data: DocumentRevisionData = { ...revision.data, generationRulesVersion: 'v2', title: input.title ?? revision.data.title, fields, members };
    const { reviseDocumentProductFields } = await import('./workbook.js');
    data.fields = reviseDocumentProductFields(revision.data, data, input.fields);
    data.fields = reviseDocumentBoxFields(revision.data, data);
    data = await applyDocumentManualSalesPricesInTx(tx, data, actorId, input.manualSalesPrices);
    assertDocumentImageChanges(revision.data.fields, data.fields);
    const document = await appendRevision(tx, successorId, 1, data, actorId, input.reason, revision.data);
    await tx.update(documents).set({ status: 'superseded', version: record.version + 1, updatedAt: new Date() }).where(eq(documents.id, id)); return { documentId: successorId, replacesDocumentId: id, document }; });
}
export async function reviewDocument(id: string, actorId: string, input: z.infer<typeof documentReviewInputSchema>) {
  return documentOperation(actorId, input.operationId, 'document.review', { id, ...input }, async (tx) => { const { record, revision } = await lockedDocument(tx, id, actorId, input.expectedVersion);
    if (record.status !== 'pending_review') throw new BatchError('DOCUMENT_REVIEW_STATE', 409, '只有待复核发票可以复核。');
    const [active] = await tx.select().from(documentExports).where(and(inArray(documentExports.status, ['queued', 'running']), sql`${documentExports.reference}->>'documentId' = ${id}`)).limit(1);
    if (active) throw new BatchError('DOCUMENT_EXPORT_BUSY', 409, '当前发票仍在生成，请等待任务结束后复核具体文件。');
    const [exported] = await tx.select().from(documentExports).where(and(eq(documentExports.id, input.exportId), eq(documentExports.status, 'completed'), sql`${documentExports.reference}->>'documentId' = ${id}`, sql`${documentExports.reference}->>'revisionId' = ${revision.id}`)).limit(1);
    if (!exported?.fileId) throw new BatchError('DOCUMENT_FILE_REQUIRED', 422, '待复核文件尚未成功发布。');
    const validation = await validateDocumentInTx(tx, id, actorId, input.expectedVersion); if (input.decision === 'approve' && !validation.valid) throw new BatchError('VALIDATION_BLOCKED', 422, '来源或资料已变化，不能通过复核。', validation.issues);
    const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, exported.fileId)); if (!file) throw new BatchError('FILE_UNAVAILABLE', 503, '复核文件索引缺失。');
    const fileSha256 = documentExportFileSha256(exported.reference, file.sha256)!;
    if (fileSha256 !== input.fileSha256) throw new BatchError('DOCUMENT_REVIEW_FILE_CONFLICT', 409, '复核的文件哈希与已发布文件不一致，请重新读取。'); await checkedDocumentExportFile(file, exported.reference);
    await tx.insert(documentReviews).values({ id: randomUUID(), documentId: id, revisionId: revision.id, exportId: exported.id, fileId: file.id, fileSha256, decision: input.decision, reason: input.reason, dependencies: exported.reference, reviewedBy: actorId });
    const [updated] = await tx.update(documents).set({ status: input.decision === 'approve' ? 'approved' : 'returned', version: record.version + 1, updatedAt: new Date() }).where(eq(documents.id, id)).returning();
    await tx.insert(operationAudit).values({ id: randomUUID(), action: 'document.review.file', targetId: id, actorUserId: actorId, requestHash: fileSha256, details: { revisionId: revision.id, fileId: file.id, fileSha256, decision: input.decision, reason: input.reason } });
    return { documentId: id, document: serializeDocument(updated!, revision) }; });
}
export async function listDocumentProfiles(actorId: string, category?: DocumentProfile['category']) { return db.transaction(async (tx) => { await requireBatchActor(tx, actorId); if (category === 'address') return { items: [] }; const rows = await tx.select().from(documentProfiles).where(and(ne(documentProfiles.category, 'address'), category ? eq(documentProfiles.category, category) : undefined)).orderBy(asc(documentProfiles.category), asc(documentProfiles.key)); return { items: rows.map(serializeProfile) }; }); }
export async function getDocumentProfile(id: string, actorId: string) { return db.transaction(async (tx) => {
  await requireBatchActor(tx, actorId);
  const [profile] = await tx.select().from(documentProfiles).where(eq(documentProfiles.id, id));
  if (!profile) throw new BatchError('NOT_FOUND', 404, '资料不存在。');
  return { profile: serializeProfile(profile) };
}); }
export async function writeDocumentProfile(actorId: string, input: ProfileInput) {
  return documentOperation(actorId, input.operationId, 'document.profile.write', input, async (tx) => ({ profile: await writeDocumentProfileInTx(tx, actorId, input) }));
}
export async function writeDocumentProfileInTx(tx: BatchTx, actorId: string, input: ProfileInput): Promise<DocumentProfile> {
    if (input.category === 'address' || input.profileId) throw new BatchError('DOCUMENT_ADDRESS_SOURCE_ONLY', 422, '收件地址以领星货件资料为准，不再维护本地地址簿。');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-profile:${input.category}:${input.key}`},0))`);
    const [previous] = await tx.select().from(documentProfiles).where(input.profileId ? eq(documentProfiles.id, input.profileId) : and(eq(documentProfiles.category, input.category), eq(documentProfiles.key, input.key))).for('update');
    if (previous && previous.version !== input.expectedVersion || !previous && input.expectedVersion !== undefined) throw new BatchError('VERSION_CONFLICT', 409, '资料版本已变化，请刷新后重新提交。');
    if (input.category === 'product') assertProductImageChange(previous?.data ?? {}, input.data);
    const data = input.data;
    const version = (previous?.version ?? 0) + 1, id = previous?.id ?? randomUUID();
    const [profile] = previous ? await tx.update(documentProfiles).set({ key: input.key, version, status: 'active', data, updatedAt: new Date() }).where(eq(documentProfiles.id, id)).returning() : await tx.insert(documentProfiles).values({ id, category: input.category, key: input.key, data, createdBy: actorId }).returning();
    await tx.insert(documentProfileVersions).values({ id: randomUUID(), profileId: id, version, data, reason: input.reason, createdBy: actorId }); return serializeProfile(profile!);
}
export async function changeDocumentProfileStatus(id: string, actorId: string, input: OperationInput, status: 'active' | 'retired') {
  return documentOperation(actorId, input.operationId, status === 'active' ? 'document.profile.restore' : 'document.profile.retire', { id, ...input }, async (tx) => {
    const [record] = await tx.select().from(documentProfiles).where(eq(documentProfiles.id, id)).for('update');
    if (!record) throw new BatchError('NOT_FOUND', 404, '资料不存在。');
    if (record.category === 'address') throw new BatchError('DOCUMENT_ADDRESS_SOURCE_ONLY', 422, '历史地址资料只供追溯，收件地址请在领星维护。');
    if (record.version !== input.expectedVersion) throw new BatchError('VERSION_CONFLICT', 409, '资料版本已变化，请重新读取后操作。');
    if (status === 'active') throw new BatchError('VALIDATION_ERROR', 422, '请建立新版本恢复资料。');
    await tx.update(documentProfiles).set({ status, updatedAt: new Date() }).where(eq(documentProfiles.id, id)); return { profileId: id };
  });
}
export async function listDocumentTemplates(actorId: string): Promise<{ items: DocumentTemplate[] }> { return db.transaction(async (tx) => {
  await requireBatchActor(tx, actorId); const rows = await tx.select().from(documentTemplates).orderBy(asc(documentTemplates.name)); const items: DocumentTemplate[] = [];
  for (const template of rows) { const [version] = await tx.select().from(documentTemplateVersions).where(and(eq(documentTemplateVersions.templateId, template.id), eq(documentTemplateVersions.version, template.version))); if (version) items.push({ id: template.id, purpose: template.purpose as DocumentTemplate['purpose'], name: template.name, version: template.version, status: template.status as DocumentTemplate['status'], fileId: version.fileId, sha256: version.sha256, mimeType: version.mimeType, createdBy: template.createdBy, createdAt: template.createdAt.toISOString() }); } return { items }; }); }

export async function getDocumentHistory(id: string, actorId: string) {
  return db.transaction(async (tx) => {
    await lockedDocument(tx, id, actorId);
    const revisions = await tx.select().from(documentRevisions).where(eq(documentRevisions.documentId, id)).orderBy(desc(documentRevisions.version));
    const reviews = await tx.select().from(documentReviews).where(eq(documentReviews.documentId, id)).orderBy(desc(documentReviews.reviewedAt));
    const validations = await tx.select().from(documentValidations).where(eq(documentValidations.documentId, id)).orderBy(desc(documentValidations.checkedAt));
    return { revisions: revisions.map(serializeDocumentRevision), reviews: reviews.map((review) => ({ ...review, reviewedAt: review.reviewedAt.toISOString() })), validations: validations.map((validation) => ({ ...validation, checkedAt: validation.checkedAt.toISOString() })) };
  });
}
