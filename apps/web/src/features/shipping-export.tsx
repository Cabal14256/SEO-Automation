import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DemandWorkspaceRow, ReportReference } from '@scm/contracts';
import { Download, FileSpreadsheet, History, LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { batchApi } from './batch-api';
import { BatchTable, downloadBlob, QueryError, timestamp, useBatchAction } from './batch-shared';
import { ImportDialog } from './import-dialog';
import './batch-reports.css';

const maxSelectedGroups = 500;
const statusLabels = { queued: '排队中', running: '生成中', completed: '已生成', failed: '失败', stale: '版本已过期' };
const sameReference = (left: ReportReference, right: ReportReference | undefined) => Boolean(right && left.groupId === right.groupId && left.groupVersion === right.groupVersion && left.confirmationId === right.confirmationId);
type VisibleExportRow = Pick<DemandWorkspaceRow, 'groupId' | 'groupVersion' | 'confirmationId' | 'status'>;
const matchesVisibleRows = (reference: ReportReference, rows: VisibleExportRow[] | undefined) => (rows ?? []).every((row) => row.groupId !== reference.groupId || (row.status === 'confirmed' || row.status === 'frozen') && row.groupVersion === reference.groupVersion && row.confirmationId === reference.confirmationId);

export type ShippingExportFilters = {
  month: string;
  region: string;
  q: string;
  shippingRunId?: string;
  sid?: number;
  country?: string;
  channel?: string;
};

type ShippingExportOptions = {
  active: boolean;
  scopeKey: string;
  filters: ShippingExportFilters;
  subBatchId?: string;
  pendingFilters: boolean;
  visibleRows?: VisibleExportRow[];
};

export function useShippingExport({ active, scopeKey, filters, subBatchId, pendingFilters, visibleRows }: ShippingExportOptions) {
  const { month, region, q, shippingRunId, sid, country, channel } = filters;
  const scope = JSON.stringify([scopeKey, subBatchId, month, region, q, shippingRunId, sid, country, channel]);
  const [selection, setSelection] = useState(() => ({ scope, references: new Map<string, ReportReference>() }));
  const [selectionNotice, setSelectionNotice] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const action = useBatchAction();
  const query = useQuery({
    queryKey: ['batch-reports', 'shipping-export', scope],
    // 资格按身份范围读取完整确认引用，搜索范围由父表可见行及版本匹配限定。
    // 主表支持备注、地址等搜索，不能沿用成品接口较窄的搜索口径。
    queryFn: () => batchApi.reports({ month, region, shippingRunId, sid, country, channel, subBatchId, page: 1 }),
    enabled: active,
    retry: false,
  });
  const exports = useQuery({
    queryKey: ['batch-exports', subBatchId, month],
    queryFn: () => batchApi.exports({ subBatchId, month }),
    enabled: active && historyOpen,
    retry: false,
    refetchInterval: (result) => active && historyOpen && result.state.data?.some((record) => record.status === 'queued' || record.status === 'running') ? 1500 : false,
  });
  const availableReferences = new Map(query.data?.confirmations.map((reference) => [reference.groupId, reference]));
  const selectedRefs = selection.scope === scope ? [...selection.references.values()].sort((left, right) => left.groupId.localeCompare(right.groupId)) : [];
  const disabled = !active || pendingFilters || query.isFetching || query.isPending || query.isError || action.busy;
  const canExport = !disabled && selectedRefs.length > 0 && selectedRefs.every((reference) => sameReference(reference, availableReferences.get(reference.groupId)) && matchesVisibleRows(reference, visibleRows));
  const isSelected = (groupId: string) => selection.scope === scope && selection.references.has(groupId);

  useEffect(() => {
    setSelection((current) => current.scope === scope ? current : { scope, references: new Map() });
    setSelectionNotice('');
  }, [scope]);
  useEffect(() => {
    if (selection.scope !== scope) return;
    const currentReferences = query.data && !query.isFetching && !query.isError ? new Map(query.data.confirmations.map((reference) => [reference.groupId, reference])) : null;
    const invalid = [...selection.references.values()].filter((reference) => !matchesVisibleRows(reference, visibleRows) || currentReferences !== null && !sameReference(reference, currentReferences.get(reference.groupId)));
    if (!invalid.length) return;
    setSelection((current) => {
      if (current.scope !== scope) return current;
      const references = new Map(current.references);
      for (const reference of invalid) references.delete(reference.groupId);
      return { scope, references };
    });
    setSelectionNotice(`${invalid.length} 个已选批次的确认已失效或版本已变化，已取消选择，请核对后重新勾选。`);
  }, [query.data, query.isFetching, query.isError, selection, scope, visibleRows]);

  const clearSelection = () => { setSelection({ scope, references: new Map() }); setSelectionNotice(''); };
  const selectReferences = (references: ReportReference[], checked: boolean) => {
    if (disabled) return;
    if (checked && references.some((reference) => !sameReference(reference, availableReferences.get(reference.groupId)) || !matchesVisibleRows(reference, visibleRows))) {
      setSelectionNotice('确认版本已变化，请刷新后重新核对并选择批次。');
      void query.refetch();
      return;
    }
    const next = new Map(selection.scope === scope ? selection.references : []);
    for (const reference of references) {
      if (checked) next.set(reference.groupId, reference);
      else next.delete(reference.groupId);
    }
    if (next.size > maxSelectedGroups) {
      setSelectionNotice(`每次最多选择 ${maxSelectedGroups} 个批次，请先取消部分选择；本次选择未生效。`);
      return;
    }
    setSelection({ scope, references: next });
    setSelectionNotice('');
  };
  const toggle = (reference: ReportReference, checked: boolean) => selectReferences([reference], checked);
  const generateExport = () => {
    if (!canExport) return;
    action.run(JSON.stringify(['export', selectedRefs, month, region]), async (operationId) => {
      try {
        return await batchApi.export({ operationId, groupIds: selectedRefs.map((reference) => reference.groupId), expectedConfirmations: selectedRefs, ...(month ? { month } : {}), region });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setSelection((current) => current.scope === scope ? { scope, references: new Map() } : current);
          setSelectionNotice('确认版本已变化，已清空选择并刷新列表，请重新勾选批次。');
          void query.refetch();
        }
        throw error;
      }
    }, '导出任务已受理。请在“批次导出记录”中查看进度并下载。');
  };
  const controls = <>
    <Button type="button" icon={FileSpreadsheet} loading={action.pendingKey?.startsWith('["export",')} variant="primary" disabled={!canExport} onClick={generateExport}>生成所选批次 XLSX</Button>
    <Button type="button" icon={History} disabled={!active} onClick={() => setHistoryOpen(true)}>批次导出记录</Button>
    <Button type="button" variant="text" disabled={!active || selectedRefs.length === 0 || action.busy} onClick={clearSelection}>清空已选批次</Button>
    <span className="batch-report-total" role="status">已选 {selectedRefs.length} 个导出批次</span>
  </>;
  const feedback = <>{selectionNotice && <p className="form-note error-note" role="alert">{selectionNotice}</p>}{!historyOpen && action.feedback}</>;
  const history = createPortal(<ImportDialog open={active && historyOpen} title="批次导出记录" close={() => setHistoryOpen(false)} wide>
    <div className="batch-report-history-heading"><p className="mapping-help">保存数据版本及文件；失败与过期结果单独显示，历史下载保留原内容。</p><IconButton type="button" icon={RefreshCw} label="刷新历史" loading={exports.isFetching} disabled={!active} onClick={() => void exports.refetch()} /></div>
    {action.feedback}
    {exports.isPending ? <p className="list-state" role="status">正在读取导出历史…</p> : exports.isError ? <QueryError error={exports.error} retry={() => void exports.refetch()} /> : exports.data.length === 0 ? <p className="list-state">尚无导出记录。</p> : <BatchTable label="导出历史" headers={['时间 / 范围', '状态', '商品 / 箱', '确认版本', '下载 / 错误']}>{exports.data.map((record) => <tr key={record.id}>
      <td>{timestamp(record.createdAt)}<small className="mapping-subtext">{record.month || '全部月份'} · {record.region === 'all' ? '全部国家' : record.region} · {record.groupIds.length} 组</small></td>
      <td>{(record.status === 'queued' || record.status === 'running') && <LoaderCircle className="motion-spin" size={15} aria-hidden="true" />}{statusLabels[record.status]}{record.status === 'completed' && !record.valid && <small className="mapping-subtext error-note">{record.invalidReason || '历史版本已被替代'}</small>}</td>
      <td>{record.rowCount} 条 / {record.boxCount} 箱</td>
      <td>{record.references.map((reference) => <small className="mapping-subtext" key={reference.confirmationId}>{reference.confirmationId} · v{reference.groupVersion}</small>)}</td>
      <td>{record.fileId && <IconButton type="button" icon={Download} label="下载 XLSX" description={`${timestamp(record.createdAt)} · ${record.month || '全部月份'}`} loading={action.pendingKey === `download-${record.id}`} disabled={!active || action.busy} onClick={() => { if (active && !action.busy) action.run(`download-${record.id}`, () => downloadBlob(batchApi.download(record.fileId!), `发货记录-${record.month || '批次'}-${record.id}.xlsx`), '下载已开始。'); }} />}{record.error && <p className="form-note error-note">{record.error}</p>}</td>
    </tr>)}</BatchTable>}
  </ImportDialog>, document.body);

  return { query, availableReferences, selectedRefs, isSelected, toggle, selectReferences, clearSelection, disabled, busy: action.busy, canExport, controls, history, feedback };
}
