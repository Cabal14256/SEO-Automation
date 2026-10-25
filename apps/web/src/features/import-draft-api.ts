import {
  importDraftListSchema, importDraftSchema, saveImportDraftInputSchema,
  type ImportDraft, type SaveImportDraftInput,
} from '@scm/contracts';
import { ApiError, request } from '../api';

export type { ImportDraft, ImportDraftContent, ImportDraftProgress, ImportDraftSummary, SaveImportDraftInput } from '@scm/contracts';

const base = '/api/v1/imports/drafts';
const draftPath = (id: string) => `${base}/${encodeURIComponent(id)}`;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function draftResponse(value: unknown): ImportDraft {
  if (!object(value)) throw new ApiError('无法识别草稿，请保持当前内容并重试。', 0);
  return importDraftSchema.parse(value.draft);
}

export const importDraftApi = {
  list: async (q = '', page = 1, pageSize = 20) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q.trim()) params.set('q', q.trim());
    return importDraftListSchema.parse(await request(`${base}?${params}`));
  },
  get: async (id: string) => draftResponse(await request(draftPath(id))),
  save: async (id: string, input: SaveImportDraftInput) => {
    const value = await request(draftPath(id), { method: 'PUT', body: JSON.stringify(saveImportDraftInputSchema.parse(input)) });
    if (!object(value) || typeof value.replayed !== 'boolean') throw new ApiError('无法识别保存结果。草稿内容已保留，请重试保存。', 0);
    return { draft: draftResponse(value), replayed: value.replayed };
  },
  remove: async (id: string, version: number) => {
    const value = await request(`${draftPath(id)}?version=${encodeURIComponent(version)}`, { method: 'DELETE' });
    if (!object(value) || value.deleted !== true) throw new ApiError('无法确认草稿是否已删除，请刷新草稿箱核对。', 0);
  },
};
