import {
  batchScopeListSchema, batchScopeDetailSchema, subBatchDetailSchema, batchMutationResultSchema,
  reportResponseSchema, reportExportRecordSchema, shipmentRevisionSchema, type ShipmentReport, type ReportExportRecord,
  batchWorkspaceSchema, type BatchWorkspaceQuery, type ConfirmAndAllocateSubBatchInput,
} from '@scm/contracts';
import { ApiError, request } from '../api';

const base = '/api/v1';
const idPath = (id: string) => encodeURIComponent(id);
const post = (path: string, input: unknown) => request(`${base}${path}`, { method: 'POST', body: JSON.stringify(input) });
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOrNull = (value: unknown) => value === null || typeof value === 'string';

export interface SyncRun { id: string; subBatchId: string; status: 'queued' | 'running' | 'completed' | 'partial' | 'failed'; startDate: string; endDate: string; requestBudget: number; requestsUsed: number; authRequests?: number; cacheHits?: number; maxPages: number; errorCode: string | null; errorMessage: string | null; createdAt: string; startedAt: string | null; completedAt: string | null }
export interface SyncItem { id: string; demandId: string; sid: number; fba: string; status: 'queued' | 'running' | 'completed' | 'failed'; revisionId: string | null; errorCode: string | null; errorMessage: string | null; snapshotIds: string[]; requestCount: number; attempts: number }
function parseRun(value: unknown): SyncRun {
  if (!object(value) || !['id', 'subBatchId', 'startDate', 'endDate', 'createdAt'].every((key) => typeof value[key] === 'string') || !['requestBudget', 'requestsUsed', 'maxPages'].every((key) => typeof value[key] === 'number') || !['queued', 'running', 'completed', 'partial', 'failed'].includes(String(value.status)) || !['errorCode', 'errorMessage', 'startedAt', 'completedAt'].every((key) => textOrNull(value[key]))) throw new ApiError('无法识别同步任务。', 0);
  if (['authRequests', 'cacheHits'].some((key) => value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || (value[key] as number) < 0))) throw new ApiError('无法识别同步请求计数。', 0);
  return value as unknown as SyncRun;
}
function parseSync(value: unknown): { run: SyncRun; items: SyncItem[] } {
  if (!object(value) || !Array.isArray(value.items)) throw new ApiError('无法识别逐票同步结果。', 0);
  const items = value.items.map((item: unknown) => {
    if (!object(item) || !['id', 'demandId', 'fba'].every((key) => typeof item[key] === 'string') || !['sid', 'requestCount', 'attempts'].every((key) => typeof item[key] === 'number') || !['queued', 'running', 'completed', 'failed'].includes(String(item.status)) || !['revisionId', 'errorCode', 'errorMessage'].every((key) => textOrNull(item[key])) || !Array.isArray(item.snapshotIds) || !item.snapshotIds.every((id) => typeof id === 'string')) throw new ApiError('无法识别逐票同步结果。', 0);
    return item as unknown as SyncItem;
  });
  return { run: parseRun(value.run), items };
}

async function file(path: string) {
  let response: Response;
  try { response = await fetch(path, { credentials: 'same-origin' }); }
  catch { throw new ApiError('无法连接文件服务。', 0); }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const error = object(body) && object(body.error) ? body.error : body;
    throw new ApiError(object(error) && typeof error.message === 'string' ? error.message : `文件下载失败（${response.status}）`, response.status);
  }
  return response.blob();
}

export const batchApi = {
  workspace: async (input: BatchWorkspaceQuery) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value));
    return batchWorkspaceSchema.parse(await request(`${base}/batches/workspace?${params}`));
  },
  list: async () => batchScopeListSchema.parse(await request(`${base}/processing-batches`)),
  materialize: async (input: unknown) => batchMutationResultSchema.parse(await post('/weekly-batches', input)),
  detail: async (id: string) => batchScopeDetailSchema.parse(await request(`${base}/processing-batches/${idPath(id)}`)),
  group: async (id: string) => subBatchDetailSchema.parse(await request(`${base}/sub-batches/${idPath(id)}`)),
  confirmAndAllocate: async (id: string, input: ConfirmAndAllocateSubBatchInput) => batchMutationResultSchema.parse(await post(`/sub-batches/${idPath(id)}/confirm-and-allocate`, input)),
  // Only saved pre-migration requests use this endpoint; new work uses shipping-run APIs.
  createGroup: async (id: string, input: unknown) => batchMutationResultSchema.parse(await post(`/weekly-batches/${idPath(id)}/sub-batches`, input)),
  batchAction: async (id: string, action: 'reorder' | 'allocate-codes', input: unknown) => batchMutationResultSchema.parse(await post(`/processing-batches/${idPath(id)}/${action}`, input)),
  groupAction: async (id: string, action: 'members' | 'merge' | 'split' | 'move' | 'correction' | 'confirm' | 'decisions' | 'box-mapping' | 'actual-ship-date' | 'print', input: unknown) => batchMutationResultSchema.parse(await post(`/sub-batches/${idPath(id)}/${action}`, input)),
  manual: async (id: string, demandId: string, input: unknown) => batchMutationResultSchema.parse(await post(`/sub-batches/${idPath(id)}/shipments/${idPath(demandId)}/manual`, input)),
  syncRuns: async (id: string) => {
    const value = await request(`${base}/batch-sync/${idPath(id)}`);
    if (!object(value) || !Array.isArray(value.runs)) throw new ApiError('无法识别同步历史。', 0);
    return value.runs.map(parseRun);
  },
  sync: async (runId: string) => parseSync(await request(`${base}/batch-sync/runs/${idPath(runId)}`)),
  startSync: async (id: string, input: unknown) => parseSync(await post(`/batch-sync/${idPath(id)}`, input)),
  retrySync: async (runId: string, input: unknown) => parseSync(await post(`/batch-sync/runs/${idPath(runId)}/retry`, input)),
  reports: async (input: { month: string; shippingRunId?: string; weeklyBatchId?: string; subBatchId?: string; region: string; q?: string; page: number; sid?: number; country?: string; channel?: string }): Promise<ShipmentReport> => {
    const params = new URLSearchParams({ region: input.region, page: String(input.page), pageSize: '50' });
    if (input.month) params.set('month', input.month);
    if (input.weeklyBatchId) params.set('weeklyBatchId', input.weeklyBatchId);
    if (input.subBatchId) params.set('subBatchId', input.subBatchId);
    if (input.shippingRunId) params.set('shippingRunId', input.shippingRunId);
    if (input.q?.trim()) params.set('q', input.q.trim());
    for (const key of ['sid', 'country', 'channel'] as const) if (input[key] !== undefined) params.set(key, String(input[key]));
    return reportResponseSchema.parse(await request(`${base}/batch-reports?${params}`));
  },
  exports: async (input: { subBatchId?: string; month?: string; shippingRunId?: string }) => {
    const params = new URLSearchParams();
    if (input.subBatchId) params.set('subBatchId', input.subBatchId);
    if (input.month) params.set('month', input.month);
    if (input.shippingRunId) params.set('shippingRunId', input.shippingRunId);
    const value = await request(`${base}/batch-reports/exports?${params}`);
    if (!object(value) || !Array.isArray(value.items)) throw new ApiError('无法识别导出历史。', 0);
    return value.items.map((item): ReportExportRecord => reportExportRecordSchema.parse(item));
  },
  export: async (input: unknown) => {
    const value = await post('/batch-reports/exports', input);
    if (!object(value)) throw new ApiError('无法识别导出任务。', 0);
    return reportExportRecordSchema.parse(value.export);
  },
  download: (fileId: string) => file(`${base}/files/${idPath(fileId)}/download`),
  template: () => file(`${base}/batch-reports/intake-template.xlsx`),
  intake: async (file: File, input: { subBatchId: string; demandId: string; expectedVersion: number; reason: string; operationId: string }) => {
    const form = new FormData(); form.append('file', file);
    for (const [key, value] of Object.entries(input)) form.append(key, String(value));
    const result = await request(`${base}/batch-reports/intake`, { method: 'POST', body: form });
    if (!object(result) || typeof result.replayed !== 'boolean') throw new ApiError('无法识别补录结果，请保持当前文件及操作编号重试。', 0);
    return { revision: shipmentRevisionSchema.parse(result.revision), replayed: result.replayed };
  },
};
