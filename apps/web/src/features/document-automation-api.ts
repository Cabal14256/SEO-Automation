import { documentAutomationListSchema, documentAutomationResponseSchema } from '@scm/contracts';
import { request } from '../api';

const base = '/api/v1/documents/automations';
const post = (path: string, input: unknown) => request(path, { method: 'POST', body: JSON.stringify(input) });
export const documentAutomationApi = {
  list: async (shippingRunId?: string) => documentAutomationListSchema.parse(await request(`${base}${shippingRunId ? `?${new URLSearchParams({ shippingRunId })}` : ''}`)),
  get: async (id: string) => documentAutomationResponseSchema.parse(await request(`${base}/${encodeURIComponent(id)}`)),
  requirements: async (id: string) => documentAutomationResponseSchema.parse(await request(`${base}/${encodeURIComponent(id)}/requirements`)),
  start: async (input: unknown) => documentAutomationResponseSchema.parse(await post(base, input)),
  retry: async (id: string, input: unknown) => documentAutomationResponseSchema.parse(await post(`${base}/${encodeURIComponent(id)}/retry`, input)),
  supplement: async (id: string, input: unknown) => documentAutomationResponseSchema.parse(await post(`${base}/${encodeURIComponent(id)}/supplement`, input)),
  download: async (id: string): Promise<Blob> => {
    const response = await fetch(`${base}/${encodeURIComponent(id)}/download`, { credentials: 'same-origin' });
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      throw new Error(typeof value?.error?.message === 'string' ? value.error.message : `合并文件下载失败（${response.status}）`);
    }
    return response.blob();
  },
};
