import {
  serviceMappingCreateInputSchema, serviceMappingDeleteInputSchema, serviceMappingListSchema,
  serviceMappingMutationResultSchema, serviceMappingOptionsSchema, serviceMappingRevisionInputSchema,
  type ServiceMappingCreateInput, type ServiceMappingDeleteInput, type ServiceMappingRevisionInput,
} from '@scm/contracts';
import { ApiError, request } from '../api';

const base = '/api/v1/service-mappings';
const result = (value: unknown) => {
  const parsed = serviceMappingMutationResultSchema.safeParse(value);
  if (!parsed.success) throw new ApiError('无法确认服务映射保存结果，输入与操作编号已保留，请原样重试。', 0);
  return parsed.data;
};

export const serviceMappingApi = {
  list: async () => serviceMappingListSchema.parse(await request(base)),
  options: async () => serviceMappingOptionsSchema.parse(await request(`${base}/options`)),
  create: async (input: ServiceMappingCreateInput) => result(await request(base, { method: 'POST', body: JSON.stringify(serviceMappingCreateInputSchema.parse(input)) })),
  revise: async (id: string, input: ServiceMappingRevisionInput) => result(await request(`${base}/${encodeURIComponent(id)}/revisions`, { method: 'POST', body: JSON.stringify(serviceMappingRevisionInputSchema.parse(input)) })),
  delete: async (id: string, input: ServiceMappingDeleteInput) => result(await request(`${base}/${encodeURIComponent(id)}/delete`, { method: 'POST', body: JSON.stringify(serviceMappingDeleteInputSchema.parse(input)) })),
};
