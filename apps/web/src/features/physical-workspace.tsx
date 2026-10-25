import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, FileSpreadsheet, Filter, History, RefreshCw, RotateCcw } from 'lucide-react';
import { physicalWorkspaceQuerySchema, type PhysicalExportReference } from '@scm/contracts';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Combobox } from '../components/ui/combobox';
import { Input } from '../components/ui/input';
import { MonthPicker } from '../components/ui/month-picker';
import { SelectField } from '../components/ui/select';
import { batchApi } from './batch-api';
import { BatchPhysical } from './batch-physical';
import { batchOccurrencesLabel, occurrenceLabel, BatchPagination, BatchTable, QueryError, TableSelectionCheckbox, timestamp } from './batch-shared';
import { PhysicalExports, usePhysicalExports } from './physical-exports';
import { physicalApi } from './physical-api';
import { usePhysicalIdentity } from './physical-shared';
import './batch-workspace.css';
import './physical-workspace.css';

const initialFilters = { month: '', shippingRunId: '', sid: '', country: '', channel: '', status: '', q: '' };
type Filters = typeof initialFilters;
const statuses = { pending: '待核对', blocked: '有阻塞', confirmed: '已确认', stale: '需重新确认' } as const;
const sameReference = (left: PhysicalExportReference, right: PhysicalExportReference | null) => Boolean(right && left.groupId === right.groupId && left.m2ConfirmationId === right.m2ConfirmationId && left.physicalConfirmationId === right.physicalConfirmationId && left.m3Version === right.m3Version && left.sourceFingerprint === right.sourceFingerprint);

export function PhysicalWorkspace({ active = true }: { active?: boolean }) {
  const client = useQueryClient();
  const search = useSearch({ strict: false });
  const groupId = search.view === 'physical' ? search.groupId : undefined;
  const [draft, setDraft] = useState<Filters>(initialFilters);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [page, setPage] = useState(1);
  const [validation, setValidation] = useState('');
  const [selection, setSelection] = useState<Map<string, PhysicalExportReference>>(() => new Map());
  const [selectionNotice, setSelectionNotice] = useState('');
  const selectionContext = `${usePhysicalIdentity()}:${groupId ?? 'list'}`;
  const query = physicalWorkspaceQuerySchema.parse({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '')), page, pageSize: 20 });
  const list = useQuery({ queryKey: ['physical-workspace', query], queryFn: () => physicalApi.workspace(query), retry: false, enabled: active && !groupId,
    placeholderData: (previous) => previous });
  const selected = useQuery({ queryKey: ['sub-batch', groupId], queryFn: () => batchApi.group(groupId!), retry: false, enabled: active && Boolean(groupId) });
  const choices = list.data?.filters;
  useEffect(() => { if ([list.error, selected.error].some((error) => error instanceof ApiError && error.status === 401)) void client.invalidateQueries({ queryKey: ['session'] }); }, [list.error, selected.error, client]);
  useEffect(() => { setSelection(new Map()); setSelectionNotice(''); }, [selectionContext]);
  useEffect(() => {
    if (!list.data || list.isPlaceholderData || list.isFetching || list.isError || groupId) return;
    const invalid = list.data.rows.filter((row) => {
      const saved = selection.get(row.group.id);
      return saved && !sameReference(saved, row.physical.exportReference);
    });
    if (invalid.length === 0) return;
    setSelection((current) => {
      const next = new Map(current);
      for (const row of invalid) next.delete(row.group.id);
      return next;
    });
    setSelectionNotice(`${invalid.length} 个制表组的实物确认已变化，已取消勾选，请核对后重新选择。`);
  }, [list.data, list.isPlaceholderData, list.isFetching, list.isError, groupId, selection]);
  const references = [...selection.values()].sort((left, right) => left.groupId.localeCompare(right.groupId));
  const exports = usePhysicalExports({ references, active: active && !groupId, onConflict: async () => {
    setSelection(new Map()); setSelectionNotice('导出范围已失效，已清空选择。请核对刷新后的列表并重新勾选。');
    await list.refetch();
  } });
  const clearSelection = () => { setSelection(new Map()); setSelectionNotice(''); };
  const change = (key: keyof Filters, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const apply = (event: FormEvent) => {
    event.preventDefault(); const next = { ...draft, q: draft.q.trim() };
    if (!physicalWorkspaceQuerySchema.safeParse(Object.fromEntries(Object.entries(next).filter(([, value]) => value !== ''))).success) { setValidation('请核对发货月份、发货次和筛选条件。'); return; }
    setValidation(''); clearSelection(); setFilters(next); setPage(1);
  };
  const filtersChanged = JSON.stringify(draft) !== JSON.stringify(filters);
  const visibleSelectionChanged = (list.data?.rows ?? []).some((row) => {
    const reference = selection.get(row.group.id);
    return reference && !sameReference(reference, row.physical.exportReference);
  });
  const scopeReady = !filtersChanged && !list.isError && !list.isFetching && !list.isPlaceholderData && !visibleSelectionChanged;
  const selectionDisabled = !scopeReady || exports.busy;
  const eligibleRows = (list.data?.rows ?? []).filter((row) => row.physical.exportReference !== null);
  const selectedOnPage = eligibleRows.filter((row) => selection.has(row.group.id)).length;
  const selectedOutsidePage = selection.size - (list.data?.rows ?? []).filter((row) => selection.has(row.group.id)).length;
  const selectRows = (ids: string[], checked: boolean) => {
    const next = new Map(selection);
    for (const id of ids) {
      const reference = list.data?.rows.find((row) => row.group.id === id)?.physical.exportReference;
      if (checked && reference) next.set(id, reference);
      else next.delete(id);
    }
    if (next.size > 500) { setSelectionNotice('每次最多选择 500 个制表组，请减少选择后再操作。'); return; }
    setSelection(next); setSelectionNotice('');
  };
  return <div className="physical-workspace">
    <div className="batch-workspace-heading"><div><h2>实物箱确认</h2><p className="mapping-help">独立核对原制表组，逐箱保存、整组确认，再生成实物箱明细。发货表可先行导出。</p></div></div>
    <section className="content-panel batch-workspace-panel" aria-labelledby="physical-workspace-title" hidden={Boolean(groupId)}>
      <form className="batch-workspace-filters" aria-label="筛选实物箱确认任务" onSubmit={apply}>
        <div className="field"><label htmlFor="physical-month">发货月份</label><MonthPicker id="physical-month" value={draft.month} onValueChange={(value) => change('month', value)} /></div>
        <div className="field"><label htmlFor="physical-shipping-run">发货次</label><Combobox id="physical-shipping-run" value={draft.shippingRunId} onValueChange={(value) => change('shippingRunId', value)} options={[{ value: '', label: '全部发货次' }, ...(choices?.shippingRuns.filter((run) => !draft.month || run.month === draft.month).map((run) => ({ value: run.id, label: occurrenceLabel(run) })) ?? [])]} /></div>
        <div className="field"><label htmlFor="physical-shop">店铺</label><Combobox id="physical-shop" value={draft.sid} onValueChange={(value) => change('sid', value)} options={[{ value: '', label: '全部店铺' }, ...(choices?.shops.map((shop) => ({ value: String(shop.sid), label: shop.name })) ?? [])]} /></div>
        <div className="field"><label htmlFor="physical-country">国家</label><SelectField id="physical-country" value={draft.country} onValueChange={(value) => change('country', value)} options={[{ value: '', label: '全部国家' }, ...(choices?.countries.map((country) => ({ value: country, label: country })) ?? [])]} /></div>
        <div className="field"><label htmlFor="physical-channel">业务渠道</label><SelectField id="physical-channel" value={draft.channel} onValueChange={(value) => change('channel', value)} options={[{ value: '', label: '全部渠道' }, ...(choices?.channels.map((channel) => ({ value: channel, label: channel })) ?? [])]} /></div>
        <div className="field"><label htmlFor="physical-status">核对状态</label><SelectField id="physical-status" value={draft.status} onValueChange={(value) => change('status', value)} options={[{ value: '', label: '全部状态' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))]} /></div>
        <div className="field batch-workspace-search"><label htmlFor="physical-query">制表组名称 / FBA</label><Input id="physical-query" value={draft.q} onChange={(event) => change('q', event.target.value)} maxLength={200} /></div>
        <div className="batch-workspace-filter-actions"><Button type="submit" icon={Filter} loading={list.isFetching}>筛选</Button><Button type="button" variant="text" icon={RotateCcw} onClick={() => { setDraft(initialFilters); setFilters(initialFilters); setPage(1); setValidation(''); clearSelection(); }}>重置</Button></div>
      </form>
      {validation && <p className="error-note" role="alert">{validation}</p>}
      {filtersChanged && <p className="form-note" role="status">筛选条件已修改，请点击“筛选”更新列表。</p>}
      <div className="batch-workspace-toolbar physical-workspace-toolbar" role="toolbar" aria-label="实物箱明细操作">
        <h3 id="physical-workspace-title">原制表组</h3>
        <Button type="button" icon={FileSpreadsheet} disabled={!scopeReady || exports.busy || references.length === 0} onClick={() => void exports.generate()}>生成实物箱明细 XLSX</Button>
        <Button type="button" icon={History} onClick={exports.openHistory}>生成记录</Button>
        <IconButton type="button" icon={RefreshCw} label="刷新实物核对任务" loading={list.isFetching} disabled={exports.busy} onClick={() => void list.refetch()} />
        <span className="mapping-help" role="status">已选 {selection.size} 个制表组{selectedOutsidePage > 0 ? `（其中 ${selectedOutsidePage} 个在其他页）` : ''}</span>
        <Button type="button" variant="text" disabled={selection.size === 0 || exports.busy} onClick={clearSelection}>清空选择</Button>
        <span className="batch-workspace-total" role="status">{list.data ? `${list.data.total} 个制表组` : '正在读取任务…'}</span>
      </div>
      <p className="mapping-help">勾选整组生成实物箱明细，可跨页选择，最多 500 组。应用或重置筛选会清空选择。</p>
      {selectionNotice && <p className="form-note warning-note" role="status">{selectionNotice}</p>}
      {exports.feedback}{exports.historyDialog}
      {list.isError ? <QueryError error={list.error} retry={() => void list.refetch()} /> : list.isPending ? <p className="list-state" role="status">正在读取实物箱确认任务…</p> : list.data.rows.length === 0 ? <p className="list-state">此范围没有实物箱确认任务。可调整筛选，或先建立发货制表组。</p> : <>
        <div className="physical-task-table" aria-busy={list.isFetching}>
          <BatchTable label="实物箱确认任务" headers={[
            <><TableSelectionCheckbox label="选择当前页可导出的实物制表组" checked={eligibleRows.length > 0 && selectedOnPage === eligibleRows.length} indeterminate={selectedOnPage > 0 && selectedOnPage < eligibleRows.length} disabled={selectionDisabled || eligibleRows.length === 0} onChange={(checked) => selectRows(eligibleRows.map((row) => row.group.id), checked)} />制表组 / 发货次</>,
            '店铺 / 国家 / 渠道', 'FBA / 票数', '核对状态 / 进度', '确认版本 / 时间', '操作',
          ]}>{list.data.rows.map((row) => <tr key={row.id} aria-selected={selection.has(row.group.id)}>
            <td><div className="physical-workspace-group-cell"><TableSelectionCheckbox label={`选择实物制表组 ${row.group.name}`} checked={selection.has(row.group.id)} disabled={selectionDisabled || row.physical.exportReference === null} onChange={(checked) => selectRows([row.group.id], checked)} /><div><strong>{row.group.name}</strong><small className="mapping-subtext">{batchOccurrencesLabel(row.shippingRuns)}</small><small className="mapping-subtext">制表{row.group.status === 'draft' ? '待确认' : row.group.status === 'frozen' ? '已冻结' : '已确认'}</small></div></div></td>
            <td>{row.shops.join('、')}<small className="mapping-subtext">{row.countries.join('、')} / {row.channels.join('、') || '未填渠道'}</small></td>
            <td>{row.fbas.join('、')}<small className="mapping-subtext">{row.memberCount} 票</small></td>
            <td>{statuses[row.physical.status]}<small className="mapping-subtext">已核对 {row.physical.checkedCount} / {row.physical.boxCount} 箱{row.physical.blockedCount > 0 ? ` · ${row.physical.blockedCount} 项待处理` : ''}</small>{row.physical.exportReference === null && <small className="mapping-subtext">{row.physical.status === 'stale' ? '重新确认后可导出' : row.physical.status === 'blocked' || row.physical.blockedCount > 0 ? '处理阻塞并确认后可导出' : '完成整组确认后可导出'}</small>}</td>
            <td>M3 v{row.physical.version}<small className="mapping-subtext">{row.physical.confirmedAt ? timestamp(row.physical.confirmedAt) : '尚未整组确认'}</small></td>
            <td><Link className="secondary-button" to="/shipping" search={{ view: 'physical', groupId: row.group.id }}><ArrowRight size={16} aria-hidden="true" />进入核对</Link></td>
          </tr>)}</BatchTable>
        </div>
        <BatchPagination page={page} pageSize={20} total={list.data.total} change={setPage} />
      </>}
    </section>
    {groupId ? <>
      <div className="batch-workspace-heading"><h3>{selected.data?.group.name ?? '当前制表组'}</h3><Link className="secondary-button" to="/shipping" search={{ view: 'physical' }}><ArrowLeft size={16} aria-hidden="true" />返回核对列表</Link></div>
      {selected.isError && <QueryError error={selected.error} retry={() => void selected.refetch()} />}
      <BatchPhysical key={`review:${groupId}`} groupId={groupId} active={active} />
      <PhysicalExports key={`exports:${groupId}`} active={active} subBatchId={groupId} />
    </> : null}
  </div>;
}
