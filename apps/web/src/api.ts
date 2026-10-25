import {
  importAcceptedSchema, importListSchema, importRowsResponseSchema, importRunSchema, sourceImportSchema,
  sellerMappingSchema, type ImportAccepted, type ImportParseInput, type Role, type SellerMapping,
  type SellerMappingRevisionInput, type SellerAliasRevisionInput, type SourceImport, type TaskStatus,
  importConfirmationContextSchema, importPreviewResponseSchema, importCommitResultSchema, importCommitHistorySchema,
  demandDetailSchema, demandRecordSchema, demandRevisionInputSchema, demandCancelInputSchema, type ImportPreviewInput, type ImportCommitInput,
  sellerCatalogSettingsSchema, type SellerCatalogSettings, type SellerCatalogModeInput,
  type SellerCatalogSyncInput, type ManualSellerCreateInput,
  onlineImportInputSchema, fbaLookupInputSchema, fbaLookupRecordSchema, transportMethodsResponseSchema,
  type OnlineImportInput, type FbaLookupInput,
  demandWorkspaceSchema, type DemandWorkspaceQuery,
} from '@scm/contracts';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface SessionResponse {
  user: User | null;
}

export interface Task {
  id: string;
  label: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  result: string | null;
}

export interface DashboardResponse {
  tasks: Record<TaskStatus, number>;
  health: {
    database: 'ok';
    worker: 'ok' | 'stale' | 'unknown';
  };
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorMessages: Record<string, string> = {
  UNAUTHORIZED: '登录状态已失效，请重新登录。',
  FORBIDDEN: '当前账号没有此操作权限。',
  ROLE_NOT_ALLOWED: '系统仅允许管理员账号登录。',
  ACCOUNT_DISABLED: '账号已停用，请使用管理员账号登录。',
  DATABASE_UNAVAILABLE: '数据库连接失败，请检查数据库服务后重试。',
  QUEUE_UNAVAILABLE: '任务队列暂不可用，请检查 Worker 和数据库服务。',
  VALIDATION_ERROR: '提交内容未通过校验，请检查填写内容。',
  VERSION_CONFLICT: '当前数据版本已变化。请重新读取并核对后提交。',
  ALIAS_CONFLICT: '该别名已属于另一家店铺，请核对后修改。',
  SELLER_CATALOG_CONFLICT: '店铺来源或目录版本已变化，请刷新目录并核对后提交。',
  SELLER_UNAVAILABLE: '该店铺已不在当前目录中，请同步并核对店铺身份。',
  SELLER_NOT_AUTHORIZED: '该店铺当前未获领星授权，暂不能批准别名。请核对授权状态后同步目录。',
  OPERATION_CONFLICT: '此操作编号已用于其他修改，请核对当前版本后重新提交。',
  INTERNAL_ERROR: '服务处理失败，请稍后重试或联系管理员。',
  NOT_FOUND: '请求的记录或接口不存在，请刷新列表后重试。',
  INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确。',
  INVALID_CREDENTIALS: '邮箱或密码不正确。',
  FILE_TOO_LARGE: '文件超过 10 MB，请缩减工作簿后重新上传。',
  UNSUPPORTED_FILE_TYPE: '请选择 .xlsx 工作簿。',
  INVALID_WORKBOOK: '无法解析该工作簿，请检查文件是否完整或受密码保护。',
  IMPORT_BUSY: '该文件正在解析，请等待任务结束后重试。',
  IMPORT_NOT_FOUND: '找不到该导入记录，请返回列表重新选择。',
  FILE_NOT_FOUND: '原文件暂不可用，请联系管理员核对文件存储。',
  FILE_HASH_MISMATCH: '原文件校验失败，请联系管理员检查文件存储。',
  FILE_STORAGE_UNAVAILABLE: '文件存储暂不可用，请联系管理员检查存储目录。',
  PREVIEW_STALE: '预览所依据的数据已变化，请重新生成并核对差异。',
  PREVIEW_NOT_FOUND: '找不到该差异预览，请重新生成预览。',
  PREVIEW_NOT_READY: '当前解析尚未完成，请等待完成后生成预览。',
  DEMAND_VERSION_CONFLICT: '需求已被其他操作更新，请重新生成差异预览。',
};

function apiMessage(body: unknown, fallback: string): string {
  if (!isObject(body)) return fallback;
  if (isObject(body.error)) return apiMessage(body.error, fallback);
  const code = typeof body.code === 'string' ? body.code : body.error;
  if (typeof code === 'string' && ['INVALID_WORKBOOK', 'FILE_TOO_LARGE', 'UNSUPPORTED_FILE_TYPE'].includes(code) && typeof body.message === 'string' && body.message) return body.message;
  if (typeof code === 'string' && errorMessages[code]) return errorMessages[code];
  if (typeof body.message === 'string' && body.message) return body.message;
  if (typeof body.error === 'string' && body.error) return body.error;
  return fallback;
}

export async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('无法连接服务，请检查 API 是否已启动。', 0);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = isObject(body) && isObject(body.error) ? body.error : body;
    throw new ApiError(apiMessage(body, `请求失败（${response.status}）`), response.status, isObject(error) && typeof error.code === 'string' ? error.code : undefined, isObject(error) ? error.details : undefined);
  }
  return body;
}

function parseSession(value: unknown): SessionResponse {
  if (!isObject(value) || !('user' in value)) throw new ApiError('无法识别会话响应。', 0);
  if (value.user === null) return { user: null };
  if (!isObject(value.user)) throw new ApiError('无法识别会话响应。', 0);
  const user = value.user;
  if (
    typeof user.id !== 'string' ||
    typeof user.name !== 'string' ||
    typeof user.email !== 'string' ||
    user.role !== 'admin'
  ) throw new ApiError('无法识别会话响应。', 0);
  return { user: user as unknown as User };
}

function parseTask(value: unknown): Task {
  if (!isObject(value)) throw new ApiError('无法识别任务数据。', 0);
  const textOrNull = (v: unknown) => v === null || typeof v === 'string';
  if (
    typeof value.id !== 'string' ||
    typeof value.label !== 'string' ||
    !['queued', 'running', 'completed', 'failed'].includes(String(value.status)) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !textOrNull(value.completedAt) ||
    !textOrNull(value.error) ||
    !textOrNull(value.result)
  ) throw new ApiError('无法识别任务数据。', 0);
  return value as unknown as Task;
}

function parseDashboard(value: unknown): DashboardResponse {
  if (!isObject(value) || !isObject(value.tasks) || !isObject(value.health)) {
    throw new ApiError('无法识别工作台数据。', 0);
  }
  const counts = value.tasks;
  if (
    ['queued', 'running', 'completed', 'failed'].some(
      (key) => typeof counts[key] !== 'number' || !Number.isFinite(counts[key]) || (counts[key] as number) < 0,
    ) ||
    value.health.database !== 'ok' ||
    !['ok', 'stale', 'unknown'].includes(String(value.health.worker))
  ) throw new ApiError('无法识别工作台数据。', 0);
  return value as unknown as DashboardResponse;
}

export const api = {
  transportMethods: async () => {
    const parsed = transportMethodsResponseSchema.safeParse(await request('/api/v1/imports/transport-methods'));
    if (!parsed.success) throw new ApiError('无法识别领星运输方式列表，请重试读取。', 0);
    return parsed.data;
  },
  demands: async (input: DemandWorkspaceQuery) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') params.set(key, String(value));
    const parsed = demandWorkspaceSchema.safeParse(await request(`/api/v1/demands?${params}`));
    if (!parsed.success) throw new ApiError('无法识别需求商品列表，请刷新后重试。', 0);
    return parsed.data;
  },
  createOnlineImport: async (input: OnlineImportInput): Promise<ImportAccepted> => {
    const value = await request('/api/v1/imports/online', { method: 'POST', body: JSON.stringify(onlineImportInputSchema.parse(input)) });
    const parsed = importAcceptedSchema.safeParse(value);
    if (!parsed.success) throw new ApiError('无法识别在线导入结果。请先查看导入记录核对是否已接收。', 0);
    return parsed.data;
  },
  lookupFbas: async (input: FbaLookupInput) => {
    const value = await request('/api/v1/imports/fba-lookups', { method: 'POST', body: JSON.stringify(fbaLookupInputSchema.parse(input)) });
    const parsed = fbaLookupRecordSchema.safeParse(value);
    if (!parsed.success) throw new ApiError('无法识别货件查询任务。', 0);
    return parsed.data;
  },
  fbaLookup: async (id: string) => {
    const parsed = fbaLookupRecordSchema.safeParse(await request(`/api/v1/imports/fba-lookups/${encodeURIComponent(id)}`));
    if (!parsed.success) throw new ApiError('无法识别货件查询结果。', 0);
    return parsed.data;
  },
  imports: async (page: number, pageSize: number) => {
    const value = await request(`/api/v1/imports?${new URLSearchParams({ page: String(page), pageSize: String(pageSize) })}`);
    const parsed = importListSchema.safeParse(value);
    if (!parsed.success) throw new ApiError('无法识别导入列表。', 0);
    return parsed.data;
  },
  sourceImport: async (id: string): Promise<SourceImport> => {
    const value = await request(`/api/v1/imports/${encodeURIComponent(id)}`);
    const parsed = sourceImportSchema.safeParse(isObject(value) && 'import' in value ? value.import : value);
    if (!parsed.success) throw new ApiError('无法识别导入详情。', 0);
    return parsed.data;
  },
  uploadImport: async (file: File, operationId: string): Promise<ImportAccepted> => {
    const form = new FormData();
    form.append('operationId', operationId);
    form.append('file', file);
    const parsed = importAcceptedSchema.safeParse(await request('/api/v1/imports', { method: 'POST', body: form }));
    if (!parsed.success) throw new ApiError('无法识别上传结果。请刷新导入列表核对文件是否已接收。', 0);
    return parsed.data;
  },
  downloadImportTemplate: async (): Promise<Blob> => {
    let response: Response;
    try { response = await fetch('/api/v1/imports/template', { credentials: 'same-origin' }); }
    catch { throw new ApiError('无法连接服务，请检查 API 是否已启动。', 0); }
    if (!response.ok) throw new ApiError(apiMessage(await response.json().catch(() => null), `模板下载失败（${response.status}）`), response.status);
    if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) throw new ApiError('模板文件响应无效，请刷新后重新下载。', 0);
    const blob = await response.blob();
    if (!blob.size) throw new ApiError('模板文件为空，请稍后重新下载。', 0);
    return blob;
  },
  parseImport: async (id: string, input: ImportParseInput): Promise<ImportAccepted> => {
    const parsed = importAcceptedSchema.safeParse(await request(`/api/v1/imports/${encodeURIComponent(id)}/parse`, { method: 'POST', body: JSON.stringify(input) }));
    if (!parsed.success) throw new ApiError('无法识别解析任务结果。请刷新导入详情核对任务。', 0);
    return parsed.data;
  },
  importRows: async (id: string, input: { page: number; pageSize: number; parseRunId: string; status: string }) => {
    const params = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize), parseRunId: input.parseRunId });
    if (input.status) params.set('status', input.status);
    const parsed = importRowsResponseSchema.safeParse(await request(`/api/v1/imports/${encodeURIComponent(id)}/rows?${params}`));
    if (!parsed.success) throw new ApiError('无法识别源行预览。', 0);
    return parsed.data;
  },
  importRuns: async (id: string) => {
    const value = await request(`/api/v1/imports/${encodeURIComponent(id)}/runs`);
    if (!isObject(value) || !Array.isArray(value.items)) throw new ApiError('无法识别解析版本记录。', 0);
    return value.items.map((run) => {
      const parsed = importRunSchema.safeParse(run);
      if (!parsed.success) throw new ApiError('无法识别解析版本记录。', 0);
      return parsed.data;
    });
  },
  importConfirmation: async (id: string) => {
    const parsed = importConfirmationContextSchema.safeParse(await request(`/api/v1/imports/${encodeURIComponent(id)}/confirmation`));
    if (!parsed.success) throw new ApiError('无法识别本次店铺确认信息。', 0);
    return parsed.data;
  },
  createImportPreview: async ({ id, input }: { id: string; input: ImportPreviewInput }) => {
    const parsed = importPreviewResponseSchema.safeParse(await request(`/api/v1/imports/${encodeURIComponent(id)}/preview`, { method: 'POST', body: JSON.stringify(input) }));
    if (!parsed.success) throw new ApiError('无法识别差异预览，请刷新详情核对。', 0);
    return parsed.data;
  },
  importPreview: async (id: string, previewId: string, input: { page: number; pageSize: number; kind: string }) => {
    const params = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize) });
    if (input.kind) params.set('kind', input.kind);
    const parsed = importPreviewResponseSchema.safeParse(await request(`/api/v1/imports/${encodeURIComponent(id)}/previews/${encodeURIComponent(previewId)}?${params}`));
    if (!parsed.success) throw new ApiError('无法识别需求差异。', 0);
    return parsed.data;
  },
  downloadImportErrors: async (id: string, previewId: string): Promise<Blob> => {
    let response: Response;
    try { response = await fetch(`/api/v1/imports/${encodeURIComponent(id)}/previews/${encodeURIComponent(previewId)}/errors.csv`, { credentials: 'same-origin' }); }
    catch { throw new ApiError('无法连接服务，请检查 API 是否已启动。', 0); }
    if (!response.ok) throw new ApiError(apiMessage(await response.json().catch(() => null), `错误清单下载失败（${response.status}）`), response.status);
    return response.blob();
  },
  commitImport: async ({ id, input }: { id: string; input: ImportCommitInput }) => {
    const parsed = importCommitResultSchema.safeParse(await request(`/api/v1/imports/${encodeURIComponent(id)}/commit`, { method: 'POST', body: JSON.stringify(input) }));
    if (!parsed.success) throw new ApiError('无法识别提交结果。操作编号和选择已保留，可重试或刷新提交记录核对。', 0);
    return parsed.data;
  },
  importCommits: async (id: string) => {
    const parsed = importCommitHistorySchema.safeParse(await request(`/api/v1/imports/${encodeURIComponent(id)}/commits`));
    if (!parsed.success) throw new ApiError('无法识别提交记录。', 0);
    return parsed.data;
  },
  demand: async (id: string) => {
    const parsed = demandDetailSchema.safeParse(await request(`/api/v1/demands/${encodeURIComponent(id)}`));
    if (!parsed.success) throw new ApiError('无法识别需求版本与来源。', 0);
    return parsed.data;
  },
  reviseDemand: async (id: string, input: unknown) => {
    const value = await request(`/api/v1/demands/${encodeURIComponent(id)}/revisions`, { method: 'POST', body: JSON.stringify(demandRevisionInputSchema.parse(input)) });
    const parsed = demandRecordSchema.safeParse(isObject(value) ? value.demand : undefined);
    if (!parsed.success || !isObject(value) || typeof value.replayed !== 'boolean') throw new ApiError('无法确认需求保存结果，内容和操作编号已保留，请原样重试。', 0);
    return { demand: parsed.data, replayed: value.replayed };
  },
  cancelDemand: async (id: string, input: unknown) => {
    const value = await request(`/api/v1/demands/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify(demandCancelInputSchema.parse(input)) });
    const parsed = demandRecordSchema.safeParse(isObject(value) ? value.demand : undefined);
    if (!parsed.success || !isObject(value) || typeof value.replayed !== 'boolean') throw new ApiError('无法确认需求删除结果，内容和操作编号已保留，请原样重试。', 0);
    return { demand: parsed.data, replayed: value.replayed };
  },
  downloadImportSource: async (fileId: string): Promise<Blob> => {
    let response: Response;
    try { response = await fetch(`/api/v1/files/${encodeURIComponent(fileId)}/download`, { credentials: 'same-origin' }); }
    catch { throw new ApiError('无法连接服务，请检查 API 是否已启动。', 0); }
    if (!response.ok) throw new ApiError(apiMessage(await response.json().catch(() => null), `原文件下载失败（${response.status}）`), response.status);
    return response.blob();
  },
  sellerMappings: async (input: { page: number; pageSize: number; search: string; status: string }): Promise<SellerMappingList> => {
    const params = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize), search: input.search });
    if (input.status) params.set('status', input.status);
    const value = await request(`/api/v1/seller-mappings?${params.toString()}`);
    if (!isObject(value) || !Array.isArray(value.items) || typeof value.total !== 'number' || !Number.isInteger(value.total) || value.total < 0) {
      throw new ApiError('无法识别店铺映射列表。', 0);
    }
    const settings = sellerCatalogSettingsSchema.safeParse(value.settings);
    if (!settings.success) throw new ApiError('无法识别店铺来源设置，请刷新页面重试。', 0);
    return { items: value.items.map(parseSellerMapping), total: value.total, settings: settings.data };
  },
  sellerCatalogSettings: async () => {
    const value = await request('/api/v1/seller-mappings/catalog-settings');
    const parsed = sellerCatalogSettingsSchema.safeParse(isObject(value) ? value.settings : undefined);
    if (!parsed.success) throw new ApiError('无法识别店铺来源设置。', 0);
    return parsed.data;
  },
  setSellerCatalogMode: async (input: SellerCatalogModeInput) => {
    const value = await request('/api/v1/seller-mappings/catalog-settings', { method: 'POST', body: JSON.stringify(input) });
    const parsed = sellerCatalogSettingsSchema.safeParse(isObject(value) ? value.settings : undefined);
    if (!parsed.success || !isObject(value) || typeof value.replayed !== 'boolean') throw new ApiError('无法识别来源保存结果。操作编号已保留，可再次保存核对。', 0);
    return { settings: parsed.data, replayed: value.replayed };
  },
  syncSellerCatalog: async (input: SellerCatalogSyncInput) => {
    const value = await request('/api/v1/seller-mappings/sync', { method: 'POST', body: JSON.stringify(input) });
    const parsed = sellerCatalogSettingsSchema.safeParse(isObject(value) ? value.settings : undefined);
    if (!parsed.success || !isObject(value) || typeof value.replayed !== 'boolean' || !['inserted', 'updated', 'total'].every((key) => typeof value[key] === 'number' && Number.isInteger(value[key]) && (value[key] as number) >= 0)) throw new ApiError('无法识别同步结果。操作编号已保留，可再次同步核对。', 0);
    return { settings: parsed.data, inserted: value.inserted as number, updated: value.updated as number, total: value.total as number, replayed: value.replayed };
  },
  createManualSeller: async (input: ManualSellerCreateInput) => {
    const value = await request('/api/v1/seller-mappings/manual', { method: 'POST', body: JSON.stringify(input) });
    if (!isObject(value) || typeof value.replayed !== 'boolean') throw new ApiError('无法识别人工店铺保存结果，请刷新目录核对。', 0);
    return { mapping: parseSellerMapping(value.mapping), replayed: value.replayed };
  },
  reviseSellerMapping: async (id: string, input: SellerMappingRevisionInput): Promise<SellerMapping> => {
    const value = await request(`/api/v1/seller-mappings/${encodeURIComponent(id)}/revise`, { method: 'POST', body: JSON.stringify(input) });
    if (!isObject(value)) throw new ApiError('无法识别店铺映射保存结果。', 0);
    return parseSellerMapping(value.mapping);
  },
  reviseSellerAliases: async (id: string, input: SellerAliasRevisionInput) => {
    const value = await request(`/api/v1/seller-mappings/${encodeURIComponent(id)}/aliases`, { method: 'POST', body: JSON.stringify(input) });
    if (!isObject(value) || typeof value.replayed !== 'boolean') throw new ApiError('无法识别店铺别名保存结果。操作编号已保留，可再次保存核对。', 0);
    return { mapping: parseSellerMapping(value.mapping), replayed: value.replayed };
  },
  sellerMappingHistory: async (id: string): Promise<SellerMappingRevision[]> => {
    const value = await request(`/api/v1/seller-mappings/${encodeURIComponent(id)}/history`);
    if (!isObject(value) || !Array.isArray(value.items)) throw new ApiError('无法识别店铺映射版本记录。', 0);
    return value.items.map((item) => {
      if (!isObject(item) || typeof item.operationId !== 'string' || typeof item.version !== 'number' || !Number.isInteger(item.version) || typeof item.actorUserId !== 'string' || typeof item.reason !== 'string' || typeof item.createdAt !== 'string' || Number.isNaN(Date.parse(item.createdAt))) {
        throw new ApiError('无法识别店铺映射版本记录。', 0);
      }
      const before = item.before === null || isObject(item.before) && Object.keys(item.before).length === 0 ? null : parseSellerMapping(item.before);
      return { operationId: item.operationId, version: item.version, actorUserId: item.actorUserId, reason: item.reason, createdAt: item.createdAt, before, after: parseSellerMapping(item.after) };
    });
  },
  session: async (): Promise<SessionResponse> => parseSession(await request('/api/v1/session')),
  dashboard: async (): Promise<DashboardResponse> => parseDashboard(await request('/api/v1/dashboard')),
  tasks: async (): Promise<Task[]> => {
    const value = await request('/api/v1/tasks');
    if (!isObject(value) || !Array.isArray(value.items)) throw new ApiError('无法识别任务列表。', 0);
    return value.items.map(parseTask);
  },
  createTask: async (label: string): Promise<Task> => {
    const value = await request('/api/v1/tasks', { method: 'POST', body: JSON.stringify({ label }) });
    if (!isObject(value)) throw new ApiError('无法识别任务提交结果。', 0);
    return parseTask(value.task);
  },
  signIn: async (email: string, password: string): Promise<void> => {
    await request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },
  signOut: async (): Promise<void> => {
    await request('/api/v1/auth/sign-out', { method: 'POST', body: JSON.stringify({}) });
  },
};

export interface SellerMappingList { items: SellerMapping[]; total: number; settings: SellerCatalogSettings }
export interface SellerMappingRevision { operationId: string; version: number; actorUserId: string; reason: string; createdAt: string; before: SellerMapping | null; after: SellerMapping }

function parseSellerMapping(value: unknown): SellerMapping {
  const parsed = sellerMappingSchema.safeParse(value);
  if (!parsed.success) throw new ApiError('无法识别店铺映射数据。', 0);
  return parsed.data;
}
