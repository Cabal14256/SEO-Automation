import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Eye, Filter, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { batchWorkspaceQuerySchema, type BatchWorkspaceRow } from '@scm/contracts';
import { ApiError } from '../api';
import { Button, IconButton, IconLink } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Combobox } from '../components/ui/combobox';
import { MonthPicker } from '../components/ui/month-picker';
import { SelectField } from '../components/ui/select';
import { batchApi } from './batch-api';
import { batchOccurrencesLabel, occurrenceLabel, BatchTable, QueryError, timestamp } from './batch-shared';
import './batch-workspace.css';

const statuses = { empty: '尚未分组', draft: '待确认', confirmed: '已确认', frozen: '已冻结' } as const;
const initialFilters = { month: '', shippingRunId: '', sid: '', country: '', channel: '', status: '', q: '' };
type Filters = typeof initialFilters;

export function BatchWorkspace({ create, process, resume, inspect, canResume = false, active = true }: {
  create: (batchId?: string, weekStartDate?: string) => void; process: (row: BatchWorkspaceRow) => void; resume: () => void; inspect: () => void; canResume?: boolean; active?: boolean;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Filters>(initialFilters);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [page, setPage] = useState(1);
  const [validation, setValidation] = useState('');
  const query = batchWorkspaceQuerySchema.parse({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '')), page, pageSize: 20 });
  const list = useQuery({ queryKey: ['batches', 'workspace', query], queryFn: () => batchApi.workspace(query), retry: false, enabled: active, placeholderData: (previous) => previous,
    refetchInterval: (state) => active && state.state.data?.rows.some((row) => ['queued', 'running'].includes(row.sync.latestRun?.status ?? '')) ? 3000 : false });
  const choices = list.data?.filters;
  useEffect(() => { if (list.error instanceof ApiError && list.error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); }, [list.error, client]);
  const change = (key: keyof Filters, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next = { ...draft, q: draft.q.trim() };
    const checked = batchWorkspaceQuerySchema.safeParse(Object.fromEntries(Object.entries(next).filter(([, value]) => value !== '')));
    if (!checked.success) { setValidation('请检查发货月份、发货次和筛选条件。'); return; }
    setValidation(''); setFilters(next); setPage(1);
  };
  return <section className="content-panel batch-workspace-panel" aria-labelledby="batch-list-title">
    <form className="batch-workspace-filters" aria-label="筛选发货批次" onSubmit={apply}>
      <div className="field"><label htmlFor="batch-month">发货月份</label><MonthPicker id="batch-month" value={draft.month} onValueChange={(value) => change('month', value)} /></div>
      <div className="field"><label htmlFor="batch-shipping-run">发货次</label><Combobox id="batch-shipping-run" value={draft.shippingRunId} onValueChange={(value) => change('shippingRunId', value)} searchPlaceholder="搜索月份或次数…" options={[{ value: '', label: '全部发货次' }, ...(choices?.shippingRuns.filter((run) => !draft.month || run.month === draft.month).map((run) => ({ value: run.id, label: occurrenceLabel(run) })) ?? [])]} /></div>
      <div className="field"><label htmlFor="batch-shop">店铺</label><Combobox id="batch-shop" value={draft.sid} onValueChange={(value) => change('sid', value)} searchPlaceholder="搜索店铺名称或 sid…" options={[{ value: '', label: '全部店铺' }, ...(choices?.shops.map((shop) => ({ value: String(shop.sid), label: `${shop.name} · ${shop.sid}`, keywords: [shop.name, String(shop.sid)] })) ?? [])]} /></div>
      <div className="field"><label htmlFor="batch-country">国家</label><Combobox id="batch-country" value={draft.country} onValueChange={(value) => change('country', value)} searchPlaceholder="搜索国家…" options={[{ value: '', label: '全部国家' }, ...(choices?.countries.map((country) => ({ value: country, label: country })) ?? [])]} /></div>
      <div className="field"><label htmlFor="batch-channel">业务渠道</label><Combobox id="batch-channel" value={draft.channel} onValueChange={(value) => change('channel', value)} searchPlaceholder="搜索业务渠道…" options={[{ value: '', label: '全部渠道' }, ...(choices?.channels.map((channel) => ({ value: channel, label: channel })) ?? [])]} /></div>
      <div className="field"><label htmlFor="batch-state">处理状态</label><SelectField id="batch-state" value={draft.status} onValueChange={(value) => change('status', value)} options={[{ value: '', label: '全部状态' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))]} /></div>
      <div className="field batch-workspace-search"><label htmlFor="batch-search">搜索</label><Input id="batch-search" value={draft.q} maxLength={200} onChange={(event) => change('q', event.target.value)} placeholder="批次名称或 FBA" /></div>
      <div className="batch-workspace-filter-actions"><Button type="submit" icon={Filter} loading={list.isFetching}>筛选</Button><Button type="button" variant="text" icon={RotateCcw} onClick={() => { setDraft(initialFilters); setFilters(initialFilters); setPage(1); setValidation(''); }}>重置</Button></div>
    </form>
    {validation && <p className="form-note error-note" role="alert">{validation}</p>}
    <div className="batch-workspace-toolbar" aria-label="批次操作">
      <Button type="button" variant="primary" icon={Plus} onClick={() => create()}>新建批次</Button>
      {canResume && <Button type="button" icon={ArrowRight} onClick={resume}>继续上次处理</Button>}
      <IconButton type="button" icon={RefreshCw} label="刷新批次列表" loading={list.isFetching} onClick={() => void list.refetch()} />
      <span className="batch-workspace-total" role="status">{list.data ? `${list.data.total} 项批次` : '正在读取批次…'}</span>
    </div>
    <div className="section-heading demand-list-heading"><h2 id="batch-list-title">批次列表</h2><span>每页 20 项 · 按发货月份和次数管理</span></div>
    {list.isPending ? <p className="list-state" role="status">正在读取发货批次…</p> : list.isError ? <QueryError error={list.error} retry={() => void list.refetch()} /> : list.data.rows.length === 0 ? <div className="list-state"><p>此范围暂无批次。选择“新建批次”，选择发货次和已提交需求。</p>{list.data.availableWeeks.length === 0 && <Link to="/shipping" search={{ view: 'demands' }} className="text-button">前往需求导入</Link>}</div> : <div aria-busy={list.isFetching}>
      <BatchTable label="发货批次列表" headers={['批次名称', '发货次', '店铺', '国家 / 业务渠道', '货件', '同步进度', '处理状态', '更新时间', '操作']}>
        {list.data.rows.map((row) => <tr key={row.id}>
          <td><strong>{row.group?.name ?? '待建立子批次'}</strong><small className="mapping-subtext">{row.group ? `版本 ${row.group.version}${row.group.prefix ? ` · 前缀 ${row.group.prefix}` : ''}` : '发货次已建立，尚无处理组'}</small></td>
          <td>{batchOccurrencesLabel(row.shippingRuns)}</td>
          <td>{row.shops.join('、') || '—'}<small className="mapping-subtext">{row.sids.map((sid) => `sid ${sid}`).join(' / ')}</small></td>
          <td>{row.countries.join('、') || '—'}<small className="mapping-subtext">{row.channels.join('、') || '未填渠道'}</small></td>
          <td>{row.memberCount} 票</td>
          <td>{row.group ? `${row.sync.syncedMemberCount} / ${row.memberCount} 票已有数据` : '等待分组'}<small className="mapping-subtext">{row.sync.staleMemberCount > 0 ? `${row.sync.staleMemberCount} 票需重新同步` : row.sync.latestRun ? ({ queued: '等待同步', running: '正在同步', completed: '最近同步已完成', partial: '最近同步部分失败', failed: '最近同步失败' } as const)[row.sync.latestRun.status] : row.group ? '尚无同步任务' : ''}</small></td>
          <td><span className={`status-badge ${row.status === 'frozen' || row.status === 'confirmed' ? 'status-completed' : 'status-queued'}`}>{statuses[row.status]}</span>{row.confirmation && !row.confirmation.current && row.status !== 'frozen' && <small className="mapping-subtext warning-note">确认已过期</small>}</td>
          <td className="time-cell">{timestamp(row.group?.updatedAt ?? row.batch.createdAt)}</td>
          <td><div className="batch-workspace-row-actions">{row.group ? <Button type="button" icon={ArrowRight} onClick={() => process(row)}>处理向导</Button> : <Button type="button" icon={Plus} onClick={() => create(row.batch.id)}>新建分组</Button>}<IconLink icon={Eye} label="查看批次详情" onClick={inspect} description={row.group?.name ?? batchOccurrencesLabel(row.shippingRuns)} to="/batches/$batchId" params={{ batchId: row.batch.id }} search={row.group ? { groupId: row.group.id } : {}} /></div></td>
        </tr>)}
      </BatchTable>
      <div className="mapping-pagination"><span>共 {list.data.total} 项 · 第 {page} 页</span><div><Button type="button" disabled={list.isFetching || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button><Button type="button" disabled={list.isFetching || page * 20 >= list.data.total} onClick={() => setPage((value) => value + 1)}>下一页</Button></div></div>
    </div>}
  </section>;
}
