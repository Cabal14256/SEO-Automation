import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, FilePenLine, FileSpreadsheet, Filter, History, ListFilter, Plus, RefreshCw, RotateCcw, Search, Upload, X } from 'lucide-react';
import { batchWorkspaceQuerySchema, demandWorkspaceQuerySchema, type DemandWorkspaceRow, type ReportReference } from '@scm/contracts';
import { api, ApiError, type SessionResponse } from '../api';
import { Button, IconButton, IconLink } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Combobox } from '../components/ui/combobox';
import { MonthPicker } from '../components/ui/month-picker';
import { SelectField } from '../components/ui/select';
import { GridTableScope } from '../components/ui/grid-table-scope';
import { batchApi } from './batch-api';
import { batchOccurrencesLabel, occurrenceLabel, QueryError, TableSelectionCheckbox } from './batch-shared';
import { getShippingBoxColumns } from './shipping-table-parts';
import { useShippingExport } from './shipping-export';
import { ShippingWorkbenchTable, shippingStatusLabels, type ShippingPresentation, type ShippingGridSelection } from './shipping-workbench-table';
import { DemandRecordDialog, type DemandRecordMode } from './demand-record-dialog';
import { ShippingLifecycleActions, ShippingLifecyclePending, lifecycleLabels } from './shipping-lifecycle';
import { lifecycleOf, lifecyclePending } from './shipping-lifecycle-api';
import { useShippingFiltersExpanded, useShippingGridPreferences, type ShippingPageSize } from './shipping-grid-preferences';
import './shipping-workspace.css';

const emptyFilters = { month: '', shippingRunId: '', sid: '', country: '', channel: '', status: '', q: '', region: 'all', lifecycle: 'active' };
type FilterDraft = typeof emptyFilters;
type WorkspaceProps = {
  openRecords: () => void; openDrafts: () => void; active?: boolean;
  openShippingRuns?: () => void; importShippingRun?: () => void;
  onArrangeDemands?: (demandIds: string[], mode: 'create' | 'append') => void;
  onOpenGroup?: (batchId: string, groupId: string) => void; onCreateBatch?: () => void;
  initialGroupId?: string; initialPool?: 'ungrouped'; onScopeChange?: (groupId?: string, ungrouped?: boolean) => void;
  initialPresentation?: ShippingPresentation;
};

export function ImportWorkspace({ openRecords, openDrafts, openShippingRuns, importShippingRun, active = true, onArrangeDemands, onOpenGroup, onCreateBatch, initialGroupId, initialPool, onScopeChange, initialPresentation = 'shipments' }: WorkspaceProps) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<FilterDraft>(emptyFilters);
  const [filters, setFilters] = useState<FilterDraft>(emptyFilters);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState(initialGroupId ?? initialPool ?? 'all');
  const [selected, setSelected] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<{ scope: string; ids: string[] }>({ scope: '', ids: [] });
  const [presentation, setPresentation] = useState<ShippingPresentation>(initialPresentation);
  const userId = client.getQueryData<SessionResponse>(['session'])?.user?.id ?? 'current';
  const gridPreferences = useShippingGridPreferences(userId, presentation);
  const pageSize = gridPreferences.pageSize;
  const [filtersExpanded, setFiltersExpanded] = useShippingFiltersExpanded(userId);
  const filtersId = useId();
  const [batchPage, setBatchPage] = useState(1);
  const [batchSearchDraft, setBatchSearchDraft] = useState('');
  const [batchSearch, setBatchSearch] = useState('');
  const [groupLifecycle, setGroupLifecycle] = useState('active');
  const [record, setRecord] = useState<{ id: string; mode: DemandRecordMode } | null>(null);
  const [recordNotice, setRecordNotice] = useState('');
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const [batchPickerPosition, setBatchPickerPosition] = useState<CSSProperties>({});
  const batchPicker = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = batchPicker.current;
    const trigger = node?.querySelector<HTMLButtonElement>('.shipping-batch-picker-trigger');
    const panel = node?.querySelector<HTMLElement>('.shipping-batch-picker-options');
    if (!batchPickerOpen || !trigger || !panel) return;
    let frame = 0;
    const position = () => {
      const parent = panel.offsetParent as HTMLElement | null;
      if (!parent) return;
      const bounds = trigger.getBoundingClientRect(), containing = parent.getBoundingClientRect();
      const origin = containing.top + parent.clientTop;
      const below = Math.max(0, innerHeight - bounds.bottom - 18), above = Math.max(0, bounds.top - 18);
      const desired = Math.min(640, innerHeight * .7, panel.scrollHeight + 2);
      const upward = below < desired && above > below;
      const next: CSSProperties = {
        top: upward ? 'auto' : bounds.bottom - origin + 6,
        bottom: upward ? origin + parent.clientHeight - bounds.top + 6 : 'auto',
        maxHeight: Math.min(640, innerHeight * .7, upward ? above : below),
      };
      setBatchPickerPosition((previous) => previous.top === next.top && previous.bottom === next.bottom && previous.maxHeight === next.maxHeight ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node && panel.contains(event.target))) schedule(); };
    position();
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    const list = panel.querySelector('.shipping-batch-list'); if (list) observer.observe(list);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', scroll, true);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); document.removeEventListener('scroll', scroll, true); };
  }, [batchPickerOpen]);
  useEffect(() => {
    if (!batchPickerOpen) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !batchPicker.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest('dialog, [data-slot="select-content"]'))) setBatchPickerOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [batchPickerOpen]);
  useEffect(() => { setScope(initialGroupId ?? initialPool ?? 'all'); setPage(1); setSelected([]); }, [initialGroupId, initialPool]);
  const groupId = scope !== 'all' && scope !== 'ungrouped' ? scope : undefined;
  const pendingFilters = Object.entries(draft).some(([key, value]) => (key === 'q' ? value.trim() : value) !== filters[key as keyof FilterDraft]);
  const appliedFilterCount = Object.entries(filters).filter(([key, value]) => value !== emptyFilters[key as keyof FilterDraft]).length;
  const query = demandWorkspaceQuerySchema.parse({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '')), groupId, grouping: scope === 'ungrouped' ? 'ungrouped' : undefined, pageBy: 'demand', page, pageSize });
  const list = useQuery({ queryKey: ['demands', query], queryFn: () => api.demands(query), enabled: active, retry: false, placeholderData: (previous) => previous, refetchInterval: (query) => query.state.data?.rows.some(lifecyclePending) ? 1500 : false });
  const batchQuery = batchWorkspaceQuerySchema.parse({ month: filters.month || undefined, shippingRunId: filters.shippingRunId || undefined, sid: filters.sid || undefined, country: filters.country || undefined, channel: filters.channel || undefined, lifecycle: groupLifecycle, q: batchSearch || undefined, page: batchPage, pageSize: 20 });
  const batches = useQuery({ queryKey: ['batches', 'workspace', batchQuery], queryFn: () => batchApi.workspace(batchQuery), enabled: active, retry: false, placeholderData: (previous) => previous, refetchInterval: (query) => query.state.data?.rows.some((row) => lifecyclePending(row.group ?? undefined)) ? 1500 : false });
  const group = useQuery({ queryKey: ['sub-batch', groupId], queryFn: () => batchApi.group(groupId!), enabled: active && Boolean(groupId), retry: false, refetchInterval: (query) => lifecyclePending(query.state.data?.group) ? 1500 : false });
  const exportAction = useShippingExport({ active, scopeKey: JSON.stringify([scope, filters.status, filters.lifecycle]), subBatchId: groupId,
    filters: { month: filters.month, shippingRunId: filters.shippingRunId || undefined, sid: filters.sid ? Number(filters.sid) : undefined, country: filters.country || undefined, channel: filters.channel || undefined, q: filters.q, region: filters.region },
    pendingFilters: pendingFilters || list.isFetching || list.isPlaceholderData || list.isError || Boolean(list.data?.rows.some(lifecyclePending)) || lifecyclePending(group.data?.group), visibleRows: list.data?.rows });
  const selectionLocked = !active || pendingFilters || list.isFetching || list.isPlaceholderData || list.isError || exportAction.busy || Boolean(list.data?.rows.some(lifecyclePending)) || lifecyclePending(group.data?.group);
  useEffect(() => { if (list.data && !list.isPlaceholderData && page > Math.max(1, Math.ceil(list.data.demandTotal / pageSize))) setPage(Math.max(1, Math.ceil(list.data.demandTotal / pageSize))); }, [list.data, list.isPlaceholderData, page, pageSize]);
  useEffect(() => { if (batches.data && !batches.isPlaceholderData && batchPage > Math.max(1, Math.ceil(batches.data.total / 20))) setBatchPage(Math.max(1, Math.ceil(batches.data.total / 20))); }, [batches.data, batches.isPlaceholderData, batchPage]);
  useEffect(() => {
    if (!list.data || list.isPlaceholderData) return;
    const assigned = new Set(list.data.rows.filter((row) => row.groupId).map((row) => row.demandId));
    if (assigned.size) setSelected((current) => current.filter((id) => !assigned.has(id)));
  }, [list.data, list.isPlaceholderData]);
  useEffect(() => { if ([list.error, batches.error, group.error, exportAction.query.error].some((error) => error instanceof ApiError && error.status === 401)) void client.invalidateQueries({ queryKey: ['session'] }); }, [list.error, batches.error, group.error, exportAction.query.error, client]);
  const change = (key: keyof FilterDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const search = (event: FormEvent) => { event.preventDefault(); setFilters({ ...draft, q: draft.q.trim() }); setPage(1); setBatchPage(1); setSelected([]); };
  const reset = () => { setDraft(emptyFilters); setFilters(emptyFilters); setPage(1); setBatchPage(1); setSelected([]); exportAction.clearSelection(); };
  const changePresentation = (next: ShippingPresentation) => { if (gridPreferences.pageSizeForView(next) !== pageSize) setPage(1); setPresentation(next); };
  const changePageSize = (next: ShippingPageSize) => { if (next === pageSize) return; setPage(1); gridPreferences.setPageSize(next); };
  const choices = list.data?.filters;
  const rows = list.data?.rows ?? [];
  const shipments = new Map<string, DemandWorkspaceRow[]>();
  for (const row of rows) shipments.set(row.demandId, [...shipments.get(row.demandId) ?? [], row]);
  const expansionScope = JSON.stringify([scope, filters, page, pageSize]);
  const expanded = [...shipments.keys()].filter((id) => collapsed.scope !== expansionScope || !collapsed.ids.includes(id));
  const toggleExpanded = (id: string) => setCollapsed((current) => {
    const ids = current.scope === expansionScope ? current.ids : [];
    return { scope: expansionScope, ids: ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id] };
  });
  const setAllExpanded = (expand: boolean) => setCollapsed({ scope: expansionScope, ids: expand ? [] : [...shipments.keys()] });
  const selectable = [...shipments.values()].filter(([row]) => !row!.groupId && lifecycleOf(row) === 'active' && !lifecyclePending(row)).map(([row]) => row!.demandId);
  const referenceFor = (row: DemandWorkspaceRow) => {
    const reference = row.groupId && lifecycleOf(row) === 'active' && !lifecyclePending(row) && !lifecyclePending(group.data?.group) && lifecycleOf(group.data?.group) === 'active' ? exportAction.availableReferences.get(row.groupId) : undefined;
    return reference && ['confirmed', 'frozen'].includes(row.status) && row.confirmationId === reference.confirmationId && row.groupVersion === reference.groupVersion ? reference : undefined;
  };
  const visibleReferences = [...new Map(rows.flatMap((row) => { const reference = referenceFor(row); return reference ? [[reference.groupId, reference] as const] : []; })).values()];
  const visibleSelected = visibleReferences.filter((reference) => exportAction.isSelected(reference.groupId)).length;
  const selectScope = (next: string, restorePickerFocus = false) => {
    setScope(next); setPage(1); setSelected([]); setBatchPickerOpen(false);
    onScopeChange?.(next === 'all' || next === 'ungrouped' ? undefined : next, next === 'ungrouped');
    if (restorePickerFocus) requestAnimationFrame(() => batchPicker.current?.querySelector<HTMLButtonElement>('.shipping-batch-picker-trigger')?.focus());
  };
  const toggle = (id: string, checked: boolean) => setSelected((current) => checked ? [...new Set([...current, id])].slice(0, 1000) : current.filter((value) => value !== id));
  const refresh = () => { void list.refetch(); void batches.refetch(); void exportAction.query.refetch(); if (groupId) void group.refetch(); };
  const title = groupId ? group.data?.group.name ?? '所选批次' : scope === 'ungrouped' ? '待分组需求' : '全部发货';
  const renderExportChoice = (name: string, id: string, reference?: ReportReference) => <label className="shipping-export-choice"><TableSelectionCheckbox label={`选择导出批次 ${name}`} checked={exportAction.isSelected(id)} disabled={!reference || selectionLocked || exportAction.disabled} onChange={(checked) => { if (reference) exportAction.toggle(reference, checked); }} /><span>{reference ? '导出此批次' : '待确认及编码'}</span></label>;
  const renderSelection = (row: DemandWorkspaceRow, firstDemand: boolean, firstGroup: boolean) => <>
    {onArrangeDemands && !row.groupId && lifecycleOf(row) === 'active' && firstDemand && <label className="shipping-demand-choice"><input type="checkbox" aria-label={`选择货件 ${row.fba}`} checked={selected.includes(row.demandId)} disabled={selectionLocked || !selected.includes(row.demandId) && selected.length >= 1000} onChange={(event) => toggle(row.demandId, event.target.checked)} /><span>安排货件</span></label>}
    {!groupId && row.groupId && firstGroup && renderExportChoice(row.groupName || row.groupId, row.groupId, referenceFor(row))}
  </>;
  const selectionFor = (row: DemandWorkspaceRow, firstDemand: boolean, firstGroup: boolean): ShippingGridSelection | null => {
    if (onArrangeDemands && !row.groupId && lifecycleOf(row) === 'active' && firstDemand) return {
      checked: selected.includes(row.demandId), disabled: selectionLocked || !selected.includes(row.demandId) && selected.length >= 1000,
      label: `选择货件 ${row.fba}`, onChange: (checked) => toggle(row.demandId, checked),
    };
    if (!groupId && row.groupId && firstGroup) {
      const reference = referenceFor(row);
      return { checked: exportAction.isSelected(row.groupId), disabled: !reference || selectionLocked || exportAction.disabled,
        label: `选择导出批次 ${row.groupName || row.groupId}`, onChange: (checked) => { if (reference) exportAction.toggle(reference, checked); } };
    }
    return null;
  };
  const groupMember = rows.find((row) => row.groupId === groupId) ?? group.data?.members[0]?.snapshot;
  const scopedReference = visibleReferences.find((reference) => reference.groupId === groupId);
  const presentationControl = <div className="field shipping-presentation-field"><label htmlFor="shipping-presentation">展示方式</label><SelectField id="shipping-presentation" value={presentation} onValueChange={(value) => changePresentation(value as ShippingPresentation)} options={[{ value: 'shipments', label: '货件分组' }, { value: 'products', label: '商品平铺' }, { value: 'boxes', label: '逐箱长表' }]} /></div>;
  const batchNavigation = <nav className="shipping-batch-nav shipping-inline-batch-nav" aria-label="需求与批次导航">
      <div className="shipping-batch-picker" ref={batchPicker} onKeyDown={(event) => { if (event.key === 'Escape' && batchPickerOpen && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest('dialog, [data-slot="select-content"]'))) { event.preventDefault(); setBatchPickerOpen(false); batchPicker.current?.querySelector<HTMLButtonElement>('.shipping-batch-picker-trigger')?.focus(); } }}><button type="button" className="shipping-batch-picker-trigger" aria-current={groupId ? 'page' : undefined} aria-expanded={batchPickerOpen} aria-controls="shipping-batch-picker-options" onClick={() => setBatchPickerOpen((value) => !value)}><ListFilter size={16} aria-hidden="true" />发货批次<ChevronDown size={15} aria-hidden="true" /></button>{batchPickerOpen && <div className="shipping-batch-picker-options" id="shipping-batch-picker-options" style={batchPickerPosition}><div className="shipping-batch-nav-heading"><h3>选择发货批次</h3>{onCreateBatch ? <IconButton type="button" icon={Plus} label="手动创建批次" onClick={onCreateBatch} /> : <IconLink icon={Plus} label="手动创建批次" to="/batches/new" />}</div>
      <div className="field"><label htmlFor="shipping-group-lifecycle">批次记录状态</label><SelectField id="shipping-group-lifecycle" value={groupLifecycle} onValueChange={(value) => { setGroupLifecycle(value); setBatchPage(1); }} options={[{ value: 'active', label: '当前批次' }, { value: 'cancelled', label: '已取消批次' }, { value: 'all', label: '全部未删除批次' }]} /></div>
      <form className="shipping-batch-search" role="search" aria-label="搜索发货批次" onSubmit={(event) => { event.preventDefault(); setBatchSearch(batchSearchDraft.trim()); setBatchPage(1); }}><label htmlFor="shipping-batch-query">批次名称 / FBA</label><div className="field"><Input id="shipping-batch-query" type="search" maxLength={200} value={batchSearchDraft} onChange={(event) => { const value = event.target.value; setBatchSearchDraft(value); if (!value) { setBatchSearch(''); setBatchPage(1); } }} placeholder="批次名称或 FBA" /><IconButton type="submit" icon={Search} label="搜索批次" loading={batches.isFetching} /></div>{(batchSearchDraft || batchSearch) && <Button type="button" variant="text" icon={X} onClick={() => { setBatchSearchDraft(''); setBatchSearch(''); setBatchPage(1); }}>清空批次搜索</Button>}</form>
      <div className="shipping-batch-list" aria-busy={batches.isFetching}>{batches.isPending ? <p role="status" className="mapping-help">正在读取批次…</p> : batches.isError ? <QueryError error={batches.error} retry={() => void batches.refetch()} /> : <>
        {batches.data.rows.filter((row) => row.group).map((row) => <div key={row.id}><button type="button" className="shipping-batch-item" aria-current={scope === row.group!.id ? 'page' : undefined} disabled={batches.isPlaceholderData} onClick={() => selectScope(row.group!.id, true)}><strong>{row.group!.name}</strong><span>{batchOccurrencesLabel(row.shippingRuns)} · {row.memberCount} 票</span><span>{row.shops.join('、')} · {row.channels.join('、') || '渠道未填'}</span><small>{lifecycleOf(row.group!) === 'active' ? ({ draft: '待确认', confirmed: '已确认', frozen: '已冻结', empty: '待分组' } as const)[row.status] : lifecycleLabels[lifecycleOf(row.group!)]} · {row.sync.syncedMemberCount}/{row.memberCount} 票已有数据</small></button><ShippingLifecycleActions target={{ type: 'group', id: row.group!.id, name: row.group!.name, lifecycle: lifecycleOf(row.group!), lifecyclePending: lifecyclePending(row.group!) }} active={active} disabled={batches.isFetching || batches.isPlaceholderData} changed={() => { selectScope('all'); setSelected([]); exportAction.clearSelection(); setRecordNotice('批次安排已更新，成员需求可在待分组池重新安排。'); }} /></div>)}
        {!batches.data.rows.some((row) => row.group) && <p className="mapping-help">{batchSearch ? '没有匹配的发货批次，请调整名称或 FBA 搜索。' : '此范围暂无发货批次。选择待分组需求建立批次。'}</p>}
        {batches.data.total > 20 && <div className="shipping-batch-pages"><IconButton icon={ChevronLeft} label="上一页批次" disabled={batchPage <= 1 || batches.isFetching} onClick={() => setBatchPage((value) => value - 1)} /><span>第 {batchPage} 页</span><IconButton icon={ChevronRight} label="下一页批次" disabled={batchPage * 20 >= batches.data.total || batches.isFetching} onClick={() => setBatchPage((value) => value + 1)} /></div>}
      </>}</div>
    </div>}</div><ShippingLifecyclePending active={active} /></nav>;
  const footerStart = <div className="shipping-page-summary"><span>共 {list.data?.demandTotal ?? 0} 票 · 第 {page} / {Math.max(1, Math.ceil((list.data?.demandTotal ?? 0) / pageSize))} 页</span><label htmlFor="shipping-page-size">每页票数</label><SelectField id="shipping-page-size" value={String(pageSize)} onValueChange={(value) => changePageSize(Number(value) as ShippingPageSize)} disabled={!active || list.isFetching || exportAction.busy} options={[20, 50, 100].map((size) => ({ value: String(size), label: `${size} 票` }))} /></div>;
  const footerEnd = <div className="shipping-page-buttons"><IconButton type="button" icon={ChevronLeft} label="上一页" disabled={!active || page === 1 || list.isFetching || exportAction.busy} onClick={() => setPage((current) => current - 1)} /><IconButton type="button" icon={ChevronRight} label="下一页" disabled={!active || page * pageSize >= (list.data?.demandTotal ?? 0) || list.isFetching || exportAction.busy} onClick={() => setPage((current) => current + 1)} /></div>;
  return <GridTableScope><section className="content-panel import-workspace-panel" aria-labelledby="demand-list-title">
    <div className="shipping-workbench-actions"><div className="shipping-unified-toolbar" aria-label="发货操作">{importShippingRun && <Button type="button" icon={Upload} onClick={importShippingRun}>导入本次发货</Button>}{openShippingRuns && <Button type="button" icon={FileSpreadsheet} onClick={openShippingRuns}>本次发货与票号</Button>}<Button type="button" icon={FilePenLine} onClick={openDrafts}>草稿箱</Button><Button type="button" icon={History} onClick={openRecords}>导入记录</Button>{exportAction.controls}<IconButton type="button" icon={RefreshCw} label="刷新工作区" loading={list.isFetching || batches.isFetching || exportAction.query.isFetching} onClick={refresh} /></div><div className="shipping-filter-disclosure"><Button type="button" icon={Filter} aria-expanded={filtersExpanded} aria-controls={filtersId} onClick={() => setFiltersExpanded(!filtersExpanded)}>{filtersExpanded ? '隐藏过滤条件' : '展示过滤条件'}</Button><span className="shipping-filter-count" role="status">已应用 {appliedFilterCount} 项过滤条件</span>{pendingFilters && <span className="shipping-filter-pending">有未应用修改</span>}</div></div>
    <form id={filtersId} hidden={!filtersExpanded} className="demand-filters shipping-workbench-filters" onSubmit={search} aria-label="筛选发货工作台">
      <div className="field"><label htmlFor="demand-month">发货月份</label><MonthPicker id="demand-month" value={draft.month} onValueChange={(value) => change('month', value)} /></div>
      <div className="field"><label htmlFor="demand-batch">发货次</label><Combobox id="demand-batch" value={draft.shippingRunId} onValueChange={(value) => change('shippingRunId', value)} searchPlaceholder="搜索月份或次数…" options={[{ value: '', label: '全部发货次' }, ...(choices?.shippingRuns.filter((run) => !draft.month || run.month === draft.month).map((run) => ({ value: run.id, label: occurrenceLabel(run) })) ?? [])]} /></div>
      <div className="field"><label htmlFor="demand-shop">店铺</label><Combobox id="demand-shop" value={draft.sid} onValueChange={(value) => change('sid', value)} searchPlaceholder="搜索店铺名称或 sid…" options={[{ value: '', label: '全部店铺' }, ...(choices?.shops.map((shop) => ({ value: String(shop.sid), label: `${shop.name} · ${shop.sid}` })) ?? [])]} /></div>
      <div className="field"><label htmlFor="demand-country">国家</label><Combobox id="demand-country" value={draft.country} onValueChange={(value) => change('country', value)} searchPlaceholder="搜索国家…" options={[{ value: '', label: '全部国家' }, ...(choices?.countries.map((country) => ({ value: country, label: country })) ?? [])]} /></div>
      <div className="field"><label htmlFor="demand-channel">业务渠道</label><Combobox id="demand-channel" value={draft.channel} onValueChange={(value) => change('channel', value)} searchPlaceholder="搜索业务渠道…" options={[{ value: '', label: '全部渠道' }, ...(choices?.channels.map((channel) => ({ value: channel, label: channel })) ?? [])]} /></div>
      <div className="field"><label htmlFor="demand-status">数据处理状态</label><SelectField id="demand-status" value={draft.status} onValueChange={(value) => change('status', value)} options={[{ value: '', label: '全部状态' }, ...Object.entries(shippingStatusLabels).map(([value, label]) => ({ value, label }))]} /></div>
      <div className="field"><label htmlFor="workbench-region">国家 / 区域</label><SelectField id="workbench-region" value={draft.region} onValueChange={(value) => change('region', value)} options={[{ value: 'all', label: '全部国家' }, { value: 'US', label: '美国' }, { value: 'EU', label: '欧洲' }]} /></div>
      <div className="field"><label htmlFor="demand-lifecycle">需求记录状态</label><SelectField id="demand-lifecycle" value={draft.lifecycle} onValueChange={(value) => change('lifecycle', value)} options={[{ value: 'active', label: '当前需求' }, { value: 'cancelled', label: '已取消需求' }, { value: 'all', label: '全部未删除需求' }]} /></div>
      <div className="field demand-search"><label htmlFor="demand-search">搜索</label><Input id="demand-search" maxLength={200} value={draft.q} onChange={(event) => change('q', event.target.value)} placeholder="批次、FBA、商品、SKU、内部编码或备注" /></div>
      <div className="demand-filter-buttons"><Button type="submit" icon={Filter} loading={list.isFetching}>筛选</Button><Button type="button" variant="text" icon={RotateCcw} onClick={reset}>重置</Button></div>
    </form>
    {pendingFilters && <p className="form-note shipping-filter-notice" role="status">筛选条件已修改，当前仍展示已应用范围。{filtersExpanded ? '请点击“筛选”更新。' : <button type="button" className="text-button" onClick={() => setFiltersExpanded(true)}>展开过滤条件继续修改</button>}</p>}
    <div className="shipping-demand-layout"><div className="shipping-demand-main">
      <div className="section-heading demand-list-heading"><div><h2 id="demand-list-title">{title}</h2><span role="status">{list.data ? `${list.data.demandTotal} 票需求 · ${list.data.total} 条商品 / 占位` : '正在读取发货明细…'}</span></div>{group.data && <div className="import-selection-actions"><ShippingLifecycleActions target={{ type: 'group', id: group.data.group.id, name: group.data.group.name, lifecycle: lifecycleOf(group.data.group), lifecyclePending: lifecyclePending(group.data.group) }} active={active} disabled={exportAction.busy} changed={() => { selectScope('all'); exportAction.clearSelection(); }} />{onOpenGroup && lifecycleOf(group.data.group) === 'active' && !lifecyclePending(group.data.group) && <Button type="button" icon={ArrowRight} disabled={exportAction.busy} onClick={() => onOpenGroup(group.data.group.batchId, group.data.group.id)}>继续处理批次</Button>}</div>}</div>
      {groupId && group.isError && <QueryError error={group.error} retry={() => void group.refetch()} />}
      {group.data && <div className="shipping-group-summary"><p>{groupMember && <>{groupMember.shop} · {groupMember.country} · {groupMember.channel || '渠道未填'} · </>}{group.data.members.length} 票 · {group.data.group.frozenAt ? '已冻结，保留原确认数据；调整请发起更正。' : '筛选仅改变显示范围，导出按完整批次处理。'}</p>{renderExportChoice(group.data.group.name, group.data.group.id, scopedReference)}</div>}
      {recordNotice && <p className="form-note success-note" role="status">{recordNotice}</p>}
      {exportAction.feedback}
      {exportAction.query.isError && <div className="inline-error" role="alert"><p>导出资格暂时不可用，发货明细仍可查看。</p><Button type="button" onClick={() => void exportAction.query.refetch()}>重试导出资格</Button></div>}
      <div className="shipping-table-selection">
      {onArrangeDemands && !groupId && <div className="shipping-selection-bar" aria-label="需求分组操作"><label className="import-check"><input type="checkbox" aria-label="选择本页未分组货件" checked={selectable.length > 0 && selectable.every((id) => selected.includes(id))} disabled={!selectable.length || selectionLocked} onChange={(event) => { const checked = event.target.checked; setSelected((current) => checked ? [...new Set([...current, ...selectable])].slice(0, 1000) : current.filter((id) => !selectable.includes(id))); }} /><span>选择本页未分组货件</span></label><strong role="status">已选 {selected.length} 票</strong><Button type="button" icon={Plus} disabled={!selected.length || selectionLocked} onClick={() => onArrangeDemands(selected, 'create')}>新建发货批次</Button><Button type="button" disabled={!selected.length || selectionLocked} onClick={() => onArrangeDemands(selected, 'append')}>加入已有批次</Button>{selected.length > 0 && <IconButton type="button" icon={X} label="清空需求选择" onClick={() => setSelected([])} />}</div>}
      <div className="shipping-selection-scopes" role="group" aria-label="发货范围切换"><button type="button" className="shipping-scope-button" aria-current={scope === 'all' ? 'page' : undefined} onClick={() => selectScope('all')}><ListFilter size={16} aria-hidden="true" />全部发货</button><button type="button" className="shipping-scope-button" aria-current={scope === 'ungrouped' ? 'page' : undefined} onClick={() => selectScope('ungrouped')}><Filter size={16} aria-hidden="true" />待分组需求</button></div>
      {batchNavigation}
      <div className="shipping-selection-display">{presentationControl}
      {!groupId && <label className="import-check shipping-export-page"><TableSelectionCheckbox label="选择本页可导出批次" checked={visibleReferences.length > 0 && visibleSelected === visibleReferences.length} indeterminate={visibleSelected > 0 && visibleSelected < visibleReferences.length} disabled={selectionLocked || exportAction.disabled || visibleReferences.length === 0} onChange={(checked) => exportAction.selectReferences(visibleReferences, checked)} /><span>选择本页可导出批次 · {visibleReferences.length} 个</span></label>}
      </div>
      </div>
      {list.isPending ? <p className="list-state" role="status">正在读取发货明细…</p> : list.isError ? <QueryError error={list.error} retry={() => void list.refetch()} /> : rows.length === 0 ? <p className="list-state">此范围暂无发货明细，请调整筛选或导入并提交需求。</p> : <>
        <ShippingWorkbenchTable month={filters.month} rows={rows} presentation={presentation} boxColumns={getShippingBoxColumns(list.data.maxBoxes, rows.flatMap((row) => row.boxes))} scopedGroup={Boolean(groupId)} expanded={expanded} toggleExpanded={toggleExpanded} setAllExpanded={setAllExpanded} renderSelection={renderSelection} selectionFor={selectionFor} openGroup={onOpenGroup} arrange={onArrangeDemands} manageDemand={(id, mode) => { setRecordNotice(''); setRecord({ id, mode }); }} lifecycleChanged={() => { setSelected([]); exportAction.clearSelection(); setRecordNotice('需求状态已更新，来源与历史已保留。'); }} active={active} locked={selectionLocked} gridPreferences={gridPreferences} footerStart={footerStart} footerEnd={footerEnd} menuScopeKey={JSON.stringify([scope, filters, page, pageSize, presentation])} />
      </>}
      {!list.isPending && !list.isError && !rows.length && <div className="shipping-empty-footer">{footerStart}{footerEnd}</div>}
      <details className="shipping-table-notes"><summary>筛选与导出说明</summary><p className="mapping-help">月份按发货编号日期筛选，待分组需求不受发货月份限制。确认及编码齐全后可导出；勾选批次按完整批次导出并在成功后冻结。</p><p className="mapping-help">候选数据用于核对；已确认和已冻结货件显示对应确认版本。筛选商品不会缩减导出的批次成员。</p></details>
    </div></div>{exportAction.history}
    {record && <DemandRecordDialog key={record.id} id={record.id} initialMode={record.mode} active={active} close={() => setRecord(null)} changed={(message) => { setRecordNotice(message); setSelected([]); exportAction.clearSelection(); }} openGroup={onOpenGroup} />}
  </section></GridTableScope>;
}
