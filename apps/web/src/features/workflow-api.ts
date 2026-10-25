import { workflowDetailSchema, workflowExportSchema, workflowFileSchema, workflowListSchema, workflowRecordSchema, workflowSourceSchema, type WorkflowKind, type WorkflowWrite } from '@scm/contracts';
import { ApiError, request } from '../api';

const base = '/api/v1';
const path = (kind: WorkflowKind) => kind === 'archive' ? 'archives' : kind;
const id = encodeURIComponent;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const post = (url: string, body: unknown) => request(`${base}${url}`, { method: 'POST', body: JSON.stringify(body) });

export const workflowApi = {
  sources: async () => {
    const result = await request(`${base}/workflow-sources`);
    if (!object(result) || !Array.isArray(result.items)) throw new ApiError('无法读取可用单据。', 0);
    return result.items.map((item) => workflowSourceSchema.parse(item));
  },
  list: async (kind: WorkflowKind, query: { q?: string; status?: string; groupId?: string; page?: number }) => {
    const params = new URLSearchParams({ pageSize: '20' });
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, String(value));
    return workflowListSchema.parse(await request(`${base}/${path(kind)}?${params}`));
  },
  detail: async (kind: WorkflowKind, recordId: string) => workflowDetailSchema.parse(await request(`${base}/${path(kind)}/${id(recordId)}`)),
  write: async (kind: WorkflowKind, recordId: string | null, input: WorkflowWrite) => {
    const result = recordId
      ? await request(`${base}/${path(kind)}/${id(recordId)}${input.action === 'save' ? '' : '/actions'}`, { method: input.action === 'save' ? 'PUT' : 'POST', body: JSON.stringify(input) })
      : await post(`/${path(kind)}`, input);
    return workflowRecordSchema.parse(object(result) && 'record' in result ? result.record : result);
  },
  export: async (kind: WorkflowKind, recordId: string, operationId: string, expectedVersion: number, purpose: string) => {
    const result = await post(`/${path(kind)}/${id(recordId)}/exports`, { operationId, expectedVersion, purpose });
    return workflowExportSchema.parse(object(result) && 'export' in result ? result.export : result);
  },
  upload: async (recordId: string, purpose: string, operationId: string, file: File) => {
    const body = new FormData(); body.set('file', file); body.set('recordId', recordId); body.set('purpose', purpose); body.set('operationId', operationId);
    const result = await request(`${base}/workflow-files`, { method: 'POST', body });
    return workflowFileSchema.parse(object(result) && 'file' in result ? result.file : result);
  },
  fileUrl: (fileId: string) => `${base}/workflow-files/${id(fileId)}/download`,
  exportUrl: (exportId: string) => `${base}/workflow-exports/${id(exportId)}/download`,
};
