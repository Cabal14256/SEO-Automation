import { createHash } from 'node:crypto';
import type { Document, DocumentAutomationCounts, DocumentAutomationJob, DocumentCandidate, DocumentExport, DocumentLingxingPreview, DocumentRevisionData, DocumentValidation } from '@scm/contracts';
import { DOCUMENT_ADDRESS_FIELDS, documentMemberAddressCode } from '@scm/contracts';
import { documentDigest, documentM2SourceReference, memberFromCandidate } from './domain.js';
import { BatchError } from '../batches/service.js';
import type { AutomationStage, StoredDocumentAutomationItem } from './automation-types.js';

export function automationOperationId(jobId: string, itemId: string, key: string): string {
  const hex = createHash('sha256').update(`document-automation:${jobId}:${itemId}:${key}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = '8';
  const value = hex.join(''); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export const automationSourceDigest = (members: DocumentRevisionData['members']) => documentDigest(members.map((member) => ({
  source: documentM2SourceReference(member.source), addressCode: documentMemberAddressCode(member) ?? null,
})).sort((left, right) => left.source.demandId.localeCompare(right.source.demandId)));

/** Stable splitting never combines different shops, destinations, countries, channels or source address evidence. */
export function groupAutomationCandidates(candidates: DocumentCandidate[]): DocumentCandidate[][] {
  const groups = new Map<string, DocumentCandidate[]>();
  for (const candidate of candidates) {
    const snapshot = candidate.demand.snapshot;
    const addresses = [...new Set((candidate.sourceCandidates?.addresses ?? []).map((address) => DOCUMENT_ADDRESS_FIELDS.map((key) => address.data[key]?.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase() ?? '').join('\u001f')))].sort();
    const key = documentDigest([snapshot.sid, snapshot.country.trim().toUpperCase(), snapshot.channel ?? '', snapshot.destinationFc?.trim().toUpperCase() ?? '', documentMemberAddressCode(candidate) ?? '', addresses]);
    const group = groups.get(key); if (group) group.push(candidate); else groups.set(key, [candidate]);
  }
  const bounded: DocumentCandidate[][] = [];
  for (const group of groups.values()) {
    let chunk: DocumentCandidate[] = [], identities = new Set<string>();
    const flush = () => { if (chunk.length) bounded.push(chunk); chunk = []; identities = new Set(); };
    for (const candidate of group.sort((a, b) => a.demandId.localeCompare(b.demandId))) {
      const next = candidateIdentities(candidate);
      if (next.size > 50) { flush(); bounded.push([candidate]); continue; }
      const merged = new Set([...identities, ...next]);
      if (chunk.length && (merged.size > 50 || chunk.length >= 500)) flush();
      chunk.push(candidate); for (const identity of next) identities.add(identity);
    }
    flush();
  }
  return bounded;
}
// This is the current Lingxing preview's actual complete-identity budget, including mixed-box identities.
const candidateIdentities = (candidate: DocumentCandidate) => new Set((candidate.shipment?.data?.items ?? []).map((item) => JSON.stringify([candidate.demand.snapshot.sid, item.msku, item.fnsku, item.sku])));
export function automationSummary(items: Pick<StoredDocumentAutomationItem, 'status'>[]): { counts: DocumentAutomationCounts; status: DocumentAutomationJob['status'] } {
  const counts: DocumentAutomationCounts = { total: items.length, queued: 0, running: 0, ready: 0, exporting: 0, completed: 0, blocked: 0 };
  for (const item of items) counts[item.status]++;
  const status = counts.running || counts.exporting ? 'running' : counts.queued ? 'queued' : counts.blocked ? counts.completed ? 'partial' : 'blocked' : counts.ready ? 'running' : 'completed';
  return { counts, status };
}
export function shouldReplayAutomationRequest(error: { code?: string; status?: number }, known: boolean): boolean {
  // A verified missing preview/source archive is rejected before a revision commits. A fresh preview can repair it.
  if (known && error.code === 'FILE_UNAVAILABLE') return false;
  return !known || (error.status ?? 0) >= 500 || error.status === 429;
}
export function resetAutomationRetry(item: StoredDocumentAutomationItem, exact: boolean) {
  if (['completed', 'exporting'].includes(item.status)) return;
  item.status = 'queued'; item.error = null; item.issues = item.issues.filter((issue) => issue.severity === 'warning');
  if (!exact) { item.attempt++; item.stage = item.documentId ? 'preview' : 'create'; item.documentVersion = null; item.exportId = null; item.fileId = null; }
  item.retryExact = false;
}
export function candidateItem(candidates: DocumentCandidate[], id: string): StoredDocumentAutomationItem {
  const issues = candidates.flatMap((candidate) => candidate.blockers);
  for (const candidate of candidates) if (candidateIdentities(candidate).size > 50) issues.push({ code: 'DOCUMENT_PRODUCT_LIMIT', severity: 'error', message: `${candidate.demand.snapshot.fba} 单个完整 FBA 超过 50 个不同商品查询身份，不能拆开 FBA；请先明确维护资料或调整查询策略。` });
  return { id, demandIds: candidates.map((candidate) => candidate.demandId), fbas: candidates.map((candidate) => candidate.demand.snapshot.fba),
    documentId: null, documentVersion: null, exportId: null, fileId: null, stage: 'create', status: issues.some((issue) => issue.severity === 'error') ? 'blocked' : 'queued',
    issues, error: issues.some((issue) => issue.severity === 'error') ? { code: issues.find((issue) => issue.severity === 'error')!.code, message: issues.find((issue) => issue.severity === 'error')!.message } : null, attempt: 1, sourceDigest: automationSourceDigest(candidates.map(memberFromCandidate)), operations: {} };
}

export type AutomationContext = { id: string; shippingRunId: string; createdBy: string; fields: Record<string, string | null>; title: string | null; mode?: 'legacy' | 'single_workbook' | string };
type DocumentResult = { document: Document; issues?: DocumentValidation['issues'] };
type OperationInput = { operationId: string; expectedVersion: number; reason: string };
export type AutomationServices = {
  current: (id: string) => Promise<{ document: Document; exports: DocumentExport[] }>;
  existing: (item: StoredDocumentAutomationItem) => Promise<{ document: Document; exports: DocumentExport[] } | null>;
  sourceDigest: (demandIds: string[]) => Promise<string>;
  create: (input: { operationId: string; shippingRunId: string; demandIds: string[]; purpose: 'invoice'; title: string; fields: Record<string, string | null> }) => Promise<DocumentResult>;
  preview: (id: string, input: Pick<OperationInput, 'operationId' | 'expectedVersion'>) => Promise<{ preview: DocumentLingxingPreview }>;
  apply: (id: string, input: OperationInput & { previewOperationId: string; confirmPrices: boolean }) => Promise<DocumentResult>;
  prepare: (id: string, input: OperationInput & { fields?: Record<string, string | null> }) => Promise<DocumentResult>;
  validate: (id: string, input: OperationInput) => Promise<{ validation: DocumentValidation }>;
  export: (id: string, input: OperationInput) => Promise<{ export: DocumentExport }>;
  exportStatus: (id: string) => Promise<{ status: string; fileId: string | null; error: string | null; valid?: boolean; invalidReason?: string | null }>;
};
const addIssues = (item: StoredDocumentAutomationItem, issues: DocumentValidation['issues']) => {
  const values = [...item.issues, ...issues]; item.issues = values.filter((issue, index) => values.findIndex((other) => documentDigest(other) === documentDigest(issue)) === index);
};
function blockIssues(item: StoredDocumentAutomationItem) {
  const issue = item.issues.find((entry) => entry.severity === 'error');
  if (!issue) return false;
  item.status = 'blocked'; item.error = { code: issue.code, message: issue.message }; return true;
}
async function currentDocument(item: StoredDocumentAutomationItem, services: AutomationServices, barrier = false) {
  const current = await services.current(item.documentId!);
  const file = current.exports.find((entry) => entry.fileId && entry.status === 'completed');
  if (file) {
    item.exportId = file.id; item.fileId = file.fileId;
    if (file.valid === false) { item.status = 'blocked'; item.error = { code: 'DOCUMENT_EXPORT_STALE', message: file.invalidReason || '已有文件的依赖已失效，请查看历史文件并建立更正单据。' }; }
    else { item.status = barrier ? 'ready' : 'completed'; item.stage = barrier ? 'ready' : 'done'; item.documentVersion = current.document.version; }
    return null;
  }
  if (current.exports.some((entry) => entry.status === 'queued' || entry.status === 'running')) {
    const pending = current.exports.find((entry) => entry.status === 'queued' || entry.status === 'running')!;
    item.exportId = pending.id; item.stage = 'export'; item.status = 'exporting'; return null;
  }
  if (['cancelled', 'superseded'].includes(current.document.status)) throw new BatchError('DOCUMENT_READ_ONLY', 409, '单据已取消或替代，请通过对应单据继续处理。');
  if (current.document.status === 'stale') throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '单据来源或依赖已变化，请先核对并明确采用当前版本后续跑。');
  if (item.documentVersion !== null && current.document.version !== item.documentVersion) throw new BatchError('VERSION_CONFLICT', 409, '单据已由其他操作修改，请核对保存内容后再续跑。');
  item.documentVersion = current.document.version; return current.document;
}

/** Each input is durably checkpointed before its side effect; recovery replays that exact request. */
export async function advanceAutomationItem(context: AutomationContext, item: StoredDocumentAutomationItem, services: AutomationServices, persist: () => Promise<void>): Promise<void> {
  if (context.mode === 'single_workbook' && item.stage === 'ready' && !['completed', 'blocked'].includes(item.status)) { item.status = 'ready'; await persist(); return; }
  if (item.status === 'completed' || item.status === 'blocked' || item.status === 'ready') return;
  if (item.status === 'exporting' && item.exportId) {
    const result = await services.exportStatus(item.exportId);
    if (result.status === 'completed' && result.fileId) {
      item.fileId = result.fileId;
      if (result.valid === false) { item.status = 'blocked'; item.error = { code: 'DOCUMENT_EXPORT_STALE', message: result.invalidReason || '已生成文件的依赖已失效，请建立更正单据。' }; }
      else { item.stage = context.mode === 'single_workbook' ? 'ready' : 'done'; item.status = context.mode === 'single_workbook' ? 'ready' : 'completed'; item.error = null; }
    }
    else if (['failed', 'stale', 'cancelled'].includes(result.status)) { item.status = 'blocked'; item.error = { code: 'DOCUMENT_EXPORT_FAILED', message: result.error || '文件生成未完成，请处理后续跑。' }; }
    await persist(); return;
  }
  // An upgraded legacy checkpoint must never replay an uncommitted per-ticket export before the batch barrier.
  if (context.mode === 'single_workbook' && item.stage === 'export') {
    const current = await currentDocument(item, services, true);
    if (!current) { await persist(); return; }
    item.attempt++; item.stage = 'validate'; item.exportId = null; item.fileId = null;
    await persist();
  }
  item.status = 'running'; item.error = null; await persist();
  for (let pass = 0; pass < 7; pass++) {
    const stage: AutomationStage = item.stage;
    if (stage === 'done') return;
    const key = stage === 'create' ? 'create' : `${item.attempt}:${stage}`;
    const operationId = automationOperationId(context.id, item.id, key);
    let operation = item.operations[key];
    if (!operation) {
      if (stage === 'create') {
        if (await services.sourceDigest(item.demandIds) !== item.sourceDigest) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, 'FBA 来源在任务开始后已变化，请核对当前来源后续跑。');
        const existing = await services.existing(item);
        if (existing) { item.documentId = existing.document.id; item.documentVersion = existing.document.version; item.stage = 'preview'; await persist(); continue; }
        operation = { input: { operationId, shippingRunId: context.shippingRunId, purpose: 'invoice', demandIds: item.demandIds, title: context.title || `自动发票 · ${item.fbas.join(' / ').slice(0, 160)}`, fields: context.fields } };
      } else {
        const current = await currentDocument(item, services, context.mode === 'single_workbook');
        if (!current) { await persist(); return; }
        const reason = '按用户启用的自动出单规则补齐并生成待复核发票';
        operation = { input: stage === 'preview' ? { operationId, expectedVersion: current.version }
          : stage === 'apply' ? { operationId, expectedVersion: current.version, reason, previewOperationId: automationOperationId(context.id, item.id, `${item.attempt}:preview`), confirmPrices: true }
            : stage === 'prepare' ? { operationId, expectedVersion: current.version, reason, fields: context.fields }
              : { operationId, expectedVersion: current.version, reason } };
      }
      item.operations[key] = operation; await persist();
    }
    if (stage === 'create') {
      const result = await services.create(operation.input as Parameters<AutomationServices['create']>[0]);
      item.documentId = result.document.id; item.documentVersion = result.document.version; item.stage = 'preview';
      if (automationSourceDigest(result.document.currentRevision.data.members) !== item.sourceDigest) throw new BatchError('DOCUMENT_SOURCE_STALE', 409, '建票期间来源版本发生变化，草稿已保留，请核对后续跑。');
    } else if (stage === 'preview') {
      await services.preview(item.documentId!, operation.input as Parameters<AutomationServices['preview']>[1]); item.stage = 'apply';
    } else if (stage === 'apply' || stage === 'prepare') {
      const result = stage === 'apply' ? await services.apply(item.documentId!, operation.input as Parameters<AutomationServices['apply']>[1]) : await services.prepare(item.documentId!, operation.input as Parameters<AutomationServices['prepare']>[1]);
      item.documentVersion = result.document.version; if (result.issues) addIssues(item, result.issues);
      item.stage = stage === 'apply' ? 'prepare' : 'validate';
      if (blockIssues(item)) { await persist(); return; }
    } else if (stage === 'validate') {
      const result = await services.validate(item.documentId!, operation.input as OperationInput); addIssues(item, result.validation.issues);
      if (!result.validation.valid || blockIssues(item)) { item.status = 'blocked'; item.error ??= { code: 'VALIDATION_BLOCKED', message: '发票仍有待补资料，请补齐后续跑。' }; await persist(); return; }
      item.stage = 'export';
      if (context.mode === 'single_workbook') { item.stage = 'ready'; item.status = 'ready'; await persist(); return; }
    } else if (stage === 'export') {
      const result = await services.export(item.documentId!, operation.input as OperationInput);
      item.exportId = result.export.id; item.fileId = result.export.fileId;
      if (item.fileId && result.export.valid === false) { item.status = 'blocked'; item.error = { code: 'DOCUMENT_EXPORT_STALE', message: result.export.invalidReason || '已有文件的依赖已失效，请查看文件并建立更正单据。' }; }
      else if (item.fileId && result.export.status === 'completed') { item.status = 'completed'; item.stage = 'done'; }
      else if (item.fileId || ['failed', 'stale', 'cancelled'].includes(result.export.status)) { item.status = 'blocked'; item.error = { code: 'DOCUMENT_EXPORT_FAILED', message: result.export.error || '文件任务状态无效，请核对文件记录后处理。' }; }
      else item.status = 'exporting';
      await persist(); return;
    }
    await persist();
  }
}
