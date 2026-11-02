import type { ServiceMappingOptions } from '@scm/contracts';
import { sellerMappings } from '../../db/schema.js';
import { BatchError, type BatchTx } from '../batches/service.js';
import { getTransportMethods } from '../imports/transport-methods.js';
import { LingxingReadError } from '../lingxing/read-client.js';
import { normalizeServiceMappingCountry } from './normalization.js';

type CountryDirectory = ServiceMappingOptions['countries'];
type SellerCountry = { lingxingData: { country: string; present: boolean; status: string; observedAt: string } | null };
export function countryOptions(rows: SellerCountry[]): CountryDirectory {
  const countries = new Map<string, string>();
  const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
  for (const { lingxingData: data } of rows) {
    if (!data?.present || data.status !== '1' || !data.observedAt || typeof data.country !== 'string') continue;
    const code = normalizeServiceMappingCountry(data.country);
    if (code) countries.set(code, names.of(code) ?? code);
  }
  if (!countries.size) return { status: 'unavailable', items: [], message: '尚无可用的领星店铺国家，请先在店铺设置中同步领星店铺。' };
  return { status: 'available', items: [...countries].sort(([a], [b]) => a.localeCompare(b)).map(([code, name]) => ({ code, name })) };
}
export async function getCountryOptionsInTx(tx: BatchTx): Promise<CountryDirectory> {
  return countryOptions(await tx.select({ lingxingData: sellerMappings.lingxingData }).from(sellerMappings));
}
export async function getTransportMethodOptions(): Promise<ServiceMappingOptions['transportMethods']> {
  try {
    const { items } = await getTransportMethods();
    if (!items.length) return { status: 'unavailable', items: [], message: '领星尚未配置运输方式，请先在领星维护运输方式后重试。' };
    return { status: 'available', items };
  } catch (error) {
    let message = '领星运输方式目录暂时无法读取，请重试；已有映射仍可修改服务。';
    if (error instanceof LingxingReadError) {
      if (error.metadata?.httpStatus === 403 || error.metadata?.businessCode === '403') message = '领星运输方式查询未获授权，请开通“查询运输方式列表”接口权限后重试。';
      else if (error.code === 'LINGXING_REQUESTS_DISABLED') message = '当前环境已关闭领星查询；已有映射仍可修改服务。';
      else if (error.code === 'LINGXING_RATE_LIMITED') message = '领星运输方式查询达到限流，请稍后重试。';
    }
    return { status: 'unavailable', items: [], message };
  }
}
export async function requireEnabledTransportMethod(name: string, id?: string | null): Promise<string> {
  const directory = await getTransportMethodOptions();
  if (directory.status !== 'available') throw new BatchError('SERVICE_MAPPING_DIRECTORY_UNAVAILABLE', 503, directory.message ?? '运输方式目录暂不可用。');
  const match = directory.items.find((item) => item.enabled && item.name === name && (!id || item.id === id));
  if (!match) throw new BatchError('SERVICE_MAPPING_METHOD_INVALID', 422, '请选择当前领星目录中已启用的运输方式。');
  return match.id;
}
