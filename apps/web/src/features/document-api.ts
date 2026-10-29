import {
  documentExportSchema,
  documentCandidateListSchema,
  documentProfileSchema,
  documentSchema,
  documentRevisionSchema,
  documentTemplateSchema,
  documentValidationSchema,
  documentLingxingPreviewSchema,
  documentLingxingPreviewInputSchema,
  documentLingxingApplyInputSchema,
  documentFieldOptionsSchema,
  documentProductImagePreviewInputSchema,
  documentProductImageSchema,
  documentListQuerySchema,
  type Document,
  type DocumentListQuery,
  type DocumentExport,
  type DocumentProfile,
  type DocumentTemplate,
  type DocumentValidation,
  type DocumentRevision,
} from '@scm/contracts';
import { ApiError, request } from '../api';
import type { ProfileImportPreview } from './document-profiles';

const base = '/api/v1';
const pathId = (id: string) => encodeURIComponent(id);
const post = (path: string, input: unknown) => request(`${base}${path}`, { method: 'POST', body: JSON.stringify(input) });
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface DocumentDetails {
  document: Document;
  validation: DocumentValidation | null;
  exports: DocumentExport[];
}

export interface DocumentAuditHistory {
  revisions: DocumentRevision[];
  reviews: Array<{ revisionId: string; exportId: string; fileSha256: string; decision: 'approve' | 'return'; reason: string; reviewedBy: string; reviewedAt: string }>;
  validations: unknown[];
}
export interface DocumentAssetVersion { id: string; version: number; reason: string; createdBy: string; createdAt: string; sha256?: string; data?: Record<string, unknown> }

function parseDocuments(value: unknown): { items: Document[]; total: number; page: number; pageSize: number } {
  if (!object(value) || !Array.isArray(value.items) || typeof value.total !== 'number') throw new ApiError('无法识别单据列表。', 0);
  return {
    items: value.items.map((item) => documentSchema.parse(item)),
    total: value.total,
    page: typeof value.page === 'number' ? value.page : 1,
    pageSize: typeof value.pageSize === 'number' ? value.pageSize : 20,
  };
}

async function file(path: string): Promise<Blob> {
  let response: Response;
  try { response = await fetch(`${base}${path}`, { credentials: 'same-origin' }); }
  catch { throw new ApiError('无法连接文件服务。', 0); }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const err = object(body) && object(body.error) ? body.error : body;
    throw new ApiError(object(err) && typeof err.message === 'string' ? err.message : `文件下载失败（${response.status}）`, response.status);
  }
  return response.blob();
}

export const documentApi = {
  fieldOptions: async () => documentFieldOptionsSchema.parse(await request(`${base}/documents/field-options`)),
  previewProductImage: async (id: string, input: { expectedVersion: number; sid: number; msku: string; fnsku: string; sku: string; url: string }) => {
    const value = await post(`/documents/${pathId(id)}/product-image-preview`, documentProductImagePreviewInputSchema.parse(input));
    return documentProductImageSchema.parse(object(value) ? value.image : undefined);
  },
  candidates: async (shippingRunId?: string) => documentCandidateListSchema.parse(await request(`${base}/documents/candidates?${new URLSearchParams(shippingRunId ? { shippingRunId } : {})}`)),
  list: async (page = 1, pageSize = 20, filters: Partial<Pick<DocumentListQuery, 'q' | 'status' | 'shippingRunId' | 'month'>> = {}) => {
    const query = documentListQuerySchema.parse({ ...filters, page, pageSize });
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize), status: query.status });
    if (query.q) params.set('q', query.q);
    if (query.shippingRunId) params.set('shippingRunId', query.shippingRunId);
    if (query.month) params.set('month', query.month);
    return parseDocuments(await request(`${base}/documents?${params}`));
  },
  get: async (id: string): Promise<DocumentDetails> => {
    const value = await request(`${base}/documents/${pathId(id)}`);
    if (!object(value)) throw new ApiError('无法识别单据详情。', 0);
    return {
      document: documentSchema.parse(value.document),
      validation: value.validation === null || value.validation === undefined ? null : documentValidationSchema.parse(value.validation),
      exports: Array.isArray(value.exports) ? value.exports.map((item) => documentExportSchema.parse(item)) : [],
    };
  },
  history: async (id: string): Promise<DocumentAuditHistory> => {
    const value = await request(`${base}/documents/${pathId(id)}/history`);
    if (!object(value) || !Array.isArray(value.revisions) || !Array.isArray(value.reviews) || !Array.isArray(value.validations)) throw new ApiError('无法识别单据版本与复核历史。', 0);
    return { revisions: value.revisions.map((revision) => documentRevisionSchema.parse(revision)), reviews: value.reviews as DocumentAuditHistory['reviews'], validations: value.validations };
  },
  create: async (input: unknown) => {
    const value = await post('/documents', input);
    if (!object(value)) throw new ApiError('无法识别草稿保存结果。', 0);
    return { document: documentSchema.parse(value.document), replayed: value.replayed === true };
  },
  revise: async (id: string, input: unknown) => {
    const value = await post(`/documents/${pathId(id)}/revisions`, input);
    if (!object(value)) throw new ApiError('无法识别单据修订结果。', 0);
    return { document: documentSchema.parse(value.document), replayed: value.replayed === true };
  },
  validate: async (id: string, input: unknown) => {
    const value = await post(`/documents/${pathId(id)}/validate`, input);
    return documentValidationSchema.parse(object(value) && 'validation' in value ? value.validation : value);
  },
  previewLingxing: async (id: string, input: { operationId: string; expectedVersion: number }) => {
    const value = await post(`/documents/${pathId(id)}/lingxing-preview`, documentLingxingPreviewInputSchema.parse(input));
    if (!object(value)) throw new ApiError('无法识别领星资料查询结果。', 0);
    return { preview: documentLingxingPreviewSchema.parse(value.preview), replayed: value.replayed === true };
  },
  applyLingxing: async (id: string, input: { operationId: string; expectedVersion: number; previewOperationId: string; reason: string; confirmPrices: boolean }) => {
    const value = await post(`/documents/${pathId(id)}/lingxing-apply`, documentLingxingApplyInputSchema.parse(input));
    if (!object(value)) throw new ApiError('无法识别领星资料采用结果。', 0);
    return { document: documentSchema.parse(value.document), replayed: value.replayed === true };
  },
  exportDocument: async (id: string, input: unknown) => {
    const value = await post(`/documents/${pathId(id)}/exports`, input);
    if (!object(value)) throw new ApiError('无法识别发票生成结果。', 0);
    return { document: documentSchema.parse(value.document), export: documentExportSchema.parse(value.export) };
  },
  review: async (id: string, input: unknown) => {
    const value = await post(`/documents/${pathId(id)}/review`, input);
    if (!object(value)) throw new ApiError('无法识别复核结果。', 0);
    return documentSchema.parse(value.document);
  },
  cancel: async (id: string, input: unknown) => {
    const value = await post(`/documents/${pathId(id)}/cancel`, input);
    if (!object(value)) throw new ApiError('无法识别取消结果。', 0);
    return documentSchema.parse(value.document);
  },
  correct: async (id: string, input: unknown) => {
    const value = await post(`/documents/${pathId(id)}/correct`, input);
    if (!object(value)) throw new ApiError('无法识别单据更正结果。', 0);
    return documentSchema.parse(value.document);
  },
  exports: async (id: string) => {
    const value = await request(`${base}/documents/${pathId(id)}/exports`);
    if (!object(value) || !Array.isArray(value.items)) throw new ApiError('无法识别发票生成记录。', 0);
    return value.items.map((item) => documentExportSchema.parse(item));
  },
  profiles: async (category?: string): Promise<DocumentProfile[]> => {
    const params = category ? `?${new URLSearchParams({ category })}` : '';
    const value = await request(`${base}/document-profiles${params}`);
    if (!object(value) || !Array.isArray(value.items)) throw new ApiError('无法识别单据资料列表。', 0);
    return value.items.map((item) => documentProfileSchema.parse(item));
  },
  writeProfile: async (input: unknown) => {
    const value = await post('/document-profiles', input);
    return documentProfileSchema.parse(object(value) && 'profile' in value ? value.profile : value);
  },
  previewProfiles: async (fileValue: File, input: { operationId: string }): Promise<ProfileImportPreview> => {
    const form = new FormData(); form.append('file', fileValue); form.append('phase', 'preview');
    for (const [key, value] of Object.entries(input)) form.append(key, value);
    const value = await request(`${base}/document-profiles/import`, { method: 'POST', body: form });
    if (!object(value) || typeof value.previewId !== 'string' || typeof value.sha256 !== 'string' || !Array.isArray(value.rows) || typeof value.valid !== 'boolean') throw new ApiError('无法识别资料导入预检。', 0);
    return value as unknown as ProfileImportPreview;
  },
  commitProfiles: async (input: { operationId: string; previewId: string; sha256: string }) => {
    const form = new FormData(); form.append('phase', 'commit'); form.append('reason', '人工核对并确认资料批量导入');
    for (const [key, value] of Object.entries(input)) form.append(key, value);
    return request(`${base}/document-profiles/import`, { method: 'POST', body: form });
  },
  profileTemplate: () => file('/document-profiles/import-template.xlsx'),
  assetHistory: async (kind: 'profiles' | 'templates', id: string): Promise<DocumentAssetVersion[]> => {
    const value = await request(`${base}/document-${kind}/${pathId(id)}/history`);
    if (!object(value) || !Array.isArray(value.items)) throw new ApiError('无法识别资料或模板版本历史。', 0);
    return value.items as DocumentAssetVersion[];
  },
  retireAsset: (kind: 'profiles' | 'templates', id: string, input: unknown) => post(`/document-${kind}/${pathId(id)}/retire`, input),
  downloadTemplate: (id: string, version: number) => file(`/document-templates/${pathId(id)}/download?${new URLSearchParams({ version: String(version) })}`),
  templates: async (): Promise<DocumentTemplate[]> => {
    const value = await request(`${base}/document-templates`);
    if (!object(value) || !Array.isArray(value.items)) throw new ApiError('无法识别单据模板列表。', 0);
    return value.items.map((item) => documentTemplateSchema.parse(item));
  },
  uploadTemplate: async (fileValue: File, input: { operationId: string; purpose: 'invoice'; name: string; reason: string; expectedVersion?: number }) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(input)) if (value !== undefined) form.append(key, String(value));
    form.append('file', fileValue);
    const value = await request(`${base}/document-templates`, { method: 'POST', body: form });
    return documentTemplateSchema.parse(object(value) && 'template' in value ? value.template : value);
  },
  export: async (id: string) => documentExportSchema.parse(await request(`${base}/document-exports/${pathId(id)}`)),
  download: (id: string) => file(`/document-exports/${pathId(id)}/download`),
};
