import {
  physicalReviewSchema, physicalHistorySchema, physicalMutationSchema, physicalSyncResultSchema,
  physicalIntakePreviewSchema, physicalExportRecordSchema, physicalWorkspaceSchema, type PhysicalWorkspaceQuery, type PhysicalWrite,
  type PhysicalSave, type PhysicalAdopt, type PhysicalSyncInput, type PhysicalExportReference,
} from '@scm/contracts';
import { ApiError, request } from '../api';

const root = '/api/v1';
const groupPath = (id: string) => `${root}/sub-batches/${encodeURIComponent(id)}/physical-review`;
const post = (path: string, input: unknown) => request(path, { method: 'POST', body: JSON.stringify(input) });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function template(groupId: string) {
  let response: Response;
  try { response = await fetch(`${groupPath(groupId)}/template.xlsx`, { credentials: 'same-origin' }); }
  catch { throw new ApiError('无法连接文件服务。', 0); }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const error = record(body) && record(body.error) ? body.error : body;
    throw new ApiError(record(error) && typeof error.message === 'string' ? error.message : `模板下载失败（${response.status}）`, response.status);
  }
  return response.blob();
}

function intakeForm(file: File, write: PhysicalWrite, phase: 'preview' | 'commit', preview?: { previewId: string; sha256: string }) {
  const form = new FormData();
  form.append('file', file); form.append('phase', phase);
  for (const [key, value] of Object.entries(write)) form.append(key, value === null ? '' : String(value));
  if (preview) { form.append('previewId', preview.previewId); form.append('sha256', preview.sha256); }
  return form;
}

export const physicalApi = {
  workspace: async (query: PhysicalWorkspaceQuery) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return physicalWorkspaceSchema.parse(await request(`${root}/physical-reviews?${params}`));
  },
  current: async (groupId: string) => physicalReviewSchema.parse(await request(groupPath(groupId))),
  history: async (groupId: string) => physicalHistorySchema.parse(await request(`${groupPath(groupId)}/history`)),
  adopt: async (groupId: string, input: PhysicalAdopt) => physicalMutationSchema.parse(await post(`${groupPath(groupId)}/sources`, input)),
  save: async (groupId: string, input: PhysicalSave) => physicalMutationSchema.parse(await post(`${groupPath(groupId)}/revisions`, input)),
  confirm: async (groupId: string, input: PhysicalWrite) => physicalMutationSchema.parse(await post(`${groupPath(groupId)}/confirmations`, input)),
  startSync: async (groupId: string, input: PhysicalSyncInput) => physicalSyncResultSchema.parse(await post(`${groupPath(groupId)}/sync`, input)),
  sync: async (groupId: string, runId: string) => physicalSyncResultSchema.parse(await request(`${groupPath(groupId)}/sync/${encodeURIComponent(runId)}`)),
  retrySync: async (groupId: string, runId: string, input: { operationId: string; additionalRequestBudget: number }) => physicalSyncResultSchema.parse(await post(`${groupPath(groupId)}/sync/${encodeURIComponent(runId)}/retry`, input)),
  template,
  preview: async (groupId: string, file: File, write: PhysicalWrite) => physicalIntakePreviewSchema.parse(await request(`${groupPath(groupId)}/intake`, { method: 'POST', body: intakeForm(file, write, 'preview') })),
  intake: async (groupId: string, file: File, write: PhysicalWrite, preview: { previewId: string; sha256: string }) => physicalMutationSchema.parse(await request(`${groupPath(groupId)}/intake`, { method: 'POST', body: intakeForm(file, write, 'commit', preview) })),
  exports: async (subBatchId?: string) => {
    const value = await request(`${root}/physical-exports${subBatchId ? `?subBatchId=${encodeURIComponent(subBatchId)}` : ''}`);
    if (!record(value) || !Array.isArray(value.items)) throw new ApiError('无法识别实物明细导出历史。', 0);
    return value.items.map((item) => physicalExportRecordSchema.parse(item));
  },
  export: async (input: { operationId: string; references: PhysicalExportReference[] }) => {
    const value = await post(`${root}/physical-exports`, input);
    if (!record(value)) throw new ApiError('无法识别实物明细导出任务。', 0);
    return physicalExportRecordSchema.parse(value.export);
  },
  exportRecord: async (id: string) => {
    const value = await request(`${root}/physical-exports/${encodeURIComponent(id)}`);
    if (!record(value)) throw new ApiError('无法识别实物明细导出任务。', 0);
    return physicalExportRecordSchema.parse(value.export);
  },
};
