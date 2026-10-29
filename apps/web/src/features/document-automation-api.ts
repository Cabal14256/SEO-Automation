import { documentAutomationDeleteResponseSchema, documentAutomationListSchema, documentAutomationResponseSchema } from '@scm/contracts';
import { ApiError, request } from '../api';

const base = '/api/v1/documents/automations';
const post = (path: string, input: unknown) => request(path, { method: 'POST', body: JSON.stringify(input) });
export const documentAutomationApi = {
  list: async (shippingRunId?: string) => documentAutomationListSchema.parse(await request(`${base}${shippingRunId ? `?${new URLSearchParams({ shippingRunId })}` : ''}`)),
  get: async (id: string) => documentAutomationResponseSchema.parse(await request(`${base}/${encodeURIComponent(id)}`)),
  requirements: async (id: string) => documentAutomationResponseSchema.parse(await request(`${base}/${encodeURIComponent(id)}/requirements`)),
  start: async (input: unknown) => documentAutomationResponseSchema.parse(await post(base, input)),
  retry: async (id: string, input: unknown) => documentAutomationResponseSchema.parse(await post(`${base}/${encodeURIComponent(id)}/retry`, input)),
  remove: async (id: string, input: unknown) => {
    const result = documentAutomationDeleteResponseSchema.parse(await post(`${base}/${encodeURIComponent(id)}/delete`, input));
    if (result.automationId !== id) throw new ApiError('删除结果与所选任务不一致，请刷新列表核对。', 0);
    return result;
  },
  supplement: async (id: string, input: unknown) => documentAutomationResponseSchema.parse(await post(`${base}/${encodeURIComponent(id)}/supplement`, input)),
  download: async (id: string): Promise<Blob> => {
    const response = await fetch(`${base}/${encodeURIComponent(id)}/download`, { credentials: 'same-origin' });
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      throw new Error(typeof value?.error?.message === 'string' ? value.error.message : `发票文件下载失败（${response.status}）`);
    }
    return response.blob();
  },
};
