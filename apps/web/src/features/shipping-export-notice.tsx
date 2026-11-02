import type { ReportExportRecord } from '@scm/contracts';
import { useQuery } from '@tanstack/react-query';
import { batchApi } from './batch-api';
import { timestamp } from './batch-shared';

export function previousShippingExport(records: ReportExportRecord[] | undefined, groupIds: string[]) {
  const selected = new Set(groupIds);
  return records?.filter((record) => record.status === 'completed' && record.fileId && record.groupIds.some((id) => selected.has(id)))
    .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt))[0];
}

export function usePreviousShippingExport(groupIds: string[], active: boolean) {
  const ids = [...groupIds].sort();
  const history = useQuery({ queryKey: ['batch-exports', 'previous', ids], queryFn: async () => {
    const scopes = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, (index + 1) * 100));
    const records = await Promise.all(scopes.map((groupIds) => batchApi.exports({ groupIds })));
    return [...new Map(records.flat().map((record) => [record.id, record])).values()];
  },
    enabled: active && ids.length > 0, retry: false,
    refetchInterval: (query) => active && query.state.data?.some((record) => record.status === 'queued' || record.status === 'running') ? 1500 : false });
  return { history, previous: previousShippingExport(history.data, ids) };
}

export function ShippingExportNotice({ previous, frozen = false, historyUnavailable = false }: {
  previous?: ReportExportRecord; frozen?: boolean; historyUnavailable?: boolean;
}) {
  if (previous) return <p className="form-note warning-note" role="status">当前范围此前已生成过发货表，最近生成于 {timestamp(previous.completedAt ?? previous.createdAt)}。可以再次生成新文件，原文件保留。</p>;
  if (historyUnavailable) return <p className="mapping-help" role="status">暂时无法读取生成记录。仍可生成新文件，原文件保留；可在导出记录中刷新核对。</p>;
  if (frozen) return <p className="mapping-help" role="status">当前范围包含已冻结批次，可以沿用原确认数据生成发货表。每次生成新文件，原文件保留；修改成员或装箱数据仍需更正。</p>;
  return null;
}
