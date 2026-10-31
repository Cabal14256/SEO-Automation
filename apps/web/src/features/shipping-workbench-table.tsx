import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArchiveRestore, Ban, ChevronDown, ChevronsDown, ChevronsUp, Columns3, Eye, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { DemandWorkspaceRow } from '@scm/contracts';
import { Button, IconLink } from '../components/ui/button';
import { ScmDataGrid, type GridColumn } from '../components/ui/scm-data-grid';
import { Input } from '../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { ShippingLifecycleDialog, lifecycleLabels } from './shipping-lifecycle';
import { lifecycleOf, lifecyclePending, type LifecycleTarget, type ShippingLifecycleAction } from './shipping-lifecycle-api';
import type { ShippingGridPreferences } from './shipping-grid-preferences';
import './shipping-grid-controls.css';

export type ShippingPresentation = 'shipments' | 'products' | 'boxes';
export const shippingStatusLabels = { unsynced: '未同步', candidate: '候选', needs_review: '待核对', confirmed: '已确认', frozen: '已冻结' } as const;
const displayTime = (value: string | null) => {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(date);
};

export type ShippingGridSelection = { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void };
type GridRow = {
  key: string; kind: 'shipment' | 'product' | 'box' | 'placeholder'; source: DemandWorkspaceRow;
  box?: DemandWorkspaceRow['boxes'][number]; firstDemand: boolean; firstGroup: boolean; productCount: number; productIndex: number;
  boxesByOrder: ReadonlyMap<number, DemandWorkspaceRow['boxes'][number]>;
};
type Props = {
  rows: DemandWorkspaceRow[]; presentation: ShippingPresentation; boxColumns: number[];
  scopedGroup: boolean; expanded: string[]; toggleExpanded: (id: string) => void; setAllExpanded: (expanded: boolean) => void;
  renderSelection: (row: DemandWorkspaceRow, firstDemand: boolean, firstGroup: boolean) => ReactNode;
  selectionFor: (row: DemandWorkspaceRow, firstDemand: boolean, firstGroup: boolean) => ShippingGridSelection | null;
  openGroup?: (batchId: string, groupId: string) => void;
  arrange?: (ids: string[], mode: 'create' | 'append') => void; locked: boolean;
  manageDemand?: (id: string, mode: 'view' | 'edit' | 'delete') => void;
  lifecycleChanged?: () => void; active?: boolean; month: string;
  gridPreferences: ShippingGridPreferences; toolbarStart?: ReactNode; footerStart?: ReactNode; footerEnd?: ReactNode; menuScopeKey?: string;
};
const requiredColumnKeys = new Set(['expand', 'rowNumber', 'selection', 'fba', 'actions']);
const utilityColumnKeys = new Set(['expand', 'rowNumber', 'selection', 'actions']);

/** Display models own their keys; selection always resolves a stable business ID. */
function gridRowsFor(rows: DemandWorkspaceRow[], presentation: ShippingPresentation, expanded: string[]): GridRow[] {
  const shipments = new Map<string, DemandWorkspaceRow[]>(), firstGroups = new Map<string, string>();
  for (const row of rows) {
    const members = shipments.get(row.demandId);
    if (members) members.push(row); else shipments.set(row.demandId, [row]);
    if (row.groupId && !firstGroups.has(row.groupId)) firstGroups.set(row.groupId, row.id);
  }
  const counts = new Map([...shipments].map(([id, members]) => [id, members.filter((entry) => entry.rowKind === 'product').length]));
  const productIndices = new Map([...shipments.values()].flatMap((members) => members.filter((entry) => entry.rowKind === 'product').map((entry, index) => [entry.id, index + 1] as const)));
  const model = (source: DemandWorkspaceRow): GridRow => ({ key: `product:${source.id}`, kind: source.rowKind === 'placeholder' ? 'placeholder' : 'product', source,
    firstDemand: shipments.get(source.demandId)?.[0]?.id === source.id,
    firstGroup: Boolean(source.groupId && firstGroups.get(source.groupId) === source.id), productCount: counts.get(source.demandId)!, productIndex: productIndices.get(source.id) ?? 0,
    boxesByOrder: new Map(source.boxes.map((box) => [box.boxOrder, box])) });
  if (presentation === 'shipments') {
    const open = new Set(expanded);
    return [...shipments].flatMap(([id, members]) => [{ ...model(members[0]!), key: `shipment:${id}`, kind: 'shipment' as const },
      ...(open.has(id) ? members.map((source) => ({ ...model(source), firstDemand: false, firstGroup: false })) : [])]);
  }
  if (presentation === 'products') return rows.map(model);
  return rows.flatMap<GridRow>((source) => {
    const entry = model(source);
    return source.boxes.length ? source.boxes.map((box, index) => ({ ...entry, key: `box:${source.id}:${box.boxId}`, kind: 'box' as const, box,
      firstDemand: entry.firstDemand && index === 0, firstGroup: entry.firstGroup && index === 0 })) : [{ ...entry, key: `empty:${source.id}`, kind: 'placeholder' as const }];
  });
}

export function ShippingWorkbenchTable({ rows, presentation, boxColumns, expanded, toggleExpanded, setAllExpanded, renderSelection, selectionFor, openGroup, arrange, manageDemand, lifecycleChanged, active = true, locked, month, gridPreferences, toolbarStart, footerStart, footerEnd, menuScopeKey }: Props) {
  const [lifecycleCommand, setLifecycleCommand] = useState<{ target: LifecycleTarget; action: ShippingLifecycleAction } | null>(null);
  const expandedIds = expanded.join('|');
  const records = useMemo(() => gridRowsFor(rows, presentation, expandedIds.split('|')), [rows, presentation, expandedIds]);
  const shipmentIds = useMemo(() => [...new Set(rows.map((row) => row.demandId))], [rows]);
  const expandedSet = new Set(expanded);
  const hasExpanded = shipmentIds.some((id) => expandedSet.has(id));
  const hasCollapsed = shipmentIds.some((id) => !expandedSet.has(id));
  const status = (row: DemandWorkspaceRow) => lifecycleOf(row) !== 'active' ? lifecycleLabels[lifecycleOf(row)] : shippingStatusLabels[row.status];
  const selection = (entry: GridRow) => selectionFor(entry.source, entry.firstDemand, entry.firstGroup);
  const number = (value: number | null | undefined, fallback = '—') => value ?? fallback;
  const column = (key: string, title: string, width: number, getValue: GridColumn<GridRow>['getValue'], align?: 'left' | 'right' | 'center'): GridColumn<GridRow> => ({ key, title, width, getValue, align });
  const columns: GridColumn<GridRow>[] = [
    ...(presentation === 'shipments' ? [{ key: 'expand', title: '', width: 32, align: 'center' as const, getValue: () => '',
      icon: (entry: GridRow) => entry.kind === 'shipment' ? expanded.includes(entry.source.demandId) ? 'collapse' as const : 'expand' as const : null,
      editLabel: (entry: GridRow) => `${expanded.includes(entry.source.demandId) ? '收起' : '展开'}货件 ${entry.source.fba}`,
      buttonWhen: (entry: GridRow) => entry.kind === 'shipment', disabled: (entry: GridRow) => entry.kind !== 'shipment',
      onActivate: (entry: GridRow) => { if (entry.kind === 'shipment') toggleExpanded(entry.source.demandId); } }] : []),
    { key: 'rowNumber', title: '#', width: 48, align: 'center', utility: 'number', getValue: () => '' },
    { key: 'selection', title: '选择', width: 48, getValue: (entry) => selection(entry)?.label ?? '', getChecked: (entry) => selection(entry)?.checked ?? false,
      disabled: (entry) => selection(entry)?.disabled ?? true, onToggle: (entry, checked) => selection(entry)?.onChange(checked) },
    { ...column('fba', '货件', 200, ({ source, kind, productIndex, productCount }) => {
      if (kind === 'shipment') return `货件 · ${source.fba}`;
      if (presentation === 'shipments') return `${kind === 'placeholder' ? '待同步明细' : `商品 ${productIndex} / ${productCount}`}\n${source.fba}`;
      return source.fba;
    }), indent: ({ kind }) => presentation === 'shipments' && kind !== 'shipment' ? 14 : 0 },
    column('group', '批次', 200, ({ source }) => source.groupName || '待分组'),
    column('destinationFc', '目的仓', 112, ({ source }) => source.destinationFc || '未填写'),
    column('shop', '店铺', 160, ({ source }) => source.shop || '—'),
    column('country', '国家', 96, ({ source }) => source.country || '—'),
    column('channel', '渠道', 112, ({ source }) => source.channel || '未填渠道'),
  ];
  if (presentation === 'boxes') columns.push(column('boxIdentity', '箱序 / 内部编码', 175, ({ box }) => box ? `${box.orderConfirmed === false ? '箱序待确认' : `第 ${box.boxOrder} 箱`}\n${box.code || '待编码'}` : '装箱待同步'));
  columns.push(
    column('codes', 'MSKU / FNSKU', 195, ({ source, kind, productCount }) => kind === 'shipment' ? `${productCount} 条商品\n${source.totalBoxes === null ? '装箱待同步' : `${source.totalBoxes} 箱`}` : `${source.msku || '—'}\n${source.fnsku || '—'}`),
    column('product', '品名 / SKU', 250, ({ source, kind }) => kind === 'shipment' ? source.ticketNumber || (source.shippingMonth ? `${source.shippingMonth} 第 ${source.shippingSequence} 次` : '未关联发货次') : `${source.rowKind === 'placeholder' ? '待同步商品 / 逐箱数据' : source.productName || '缺少品名'}\n${source.sku || '—'}`),
    column('quantity', presentation === 'boxes' ? '箱内数量' : '商品数量', 95, ({ source, kind, box }) => kind === 'shipment' ? '—' : presentation === 'boxes' ? number(box?.quantity, '待核对') : number(source.quantity, '待同步'), 'right'),
  );
  if (presentation === 'boxes') columns.push(
    column('weight', '登记重量', 115, ({ box }) => box?.weight == null ? '缺失' : `${box.weight} ${box.weightUnit || '单位缺失'}`),
    column('dimensions', '登记尺寸', 190, ({ box }) => !box || box.length == null || box.width == null || box.height == null ? '缺失' : `${box.length} × ${box.width} × ${box.height} ${box.lengthUnit || '单位缺失'}`),
  );
  else columns.push(...boxColumns.map((order) => column(`box:${order}`, `箱 ${order}`, 84, ({ boxesByOrder, kind }) => {
    if (kind === 'shipment') return '—';
    const box = boxesByOrder.get(order);
    return box ? `${box.quantity ?? '待核对'}${box.orderConfirmed === false ? '\n箱序待确认' : ''}` : '—';
  }, 'right')),
  column('internalCodes', '内部编码', 170, ({ source, kind }) => kind === 'shipment' ? '—' : source.codes.join('、') || '待编码'),
  column('groupQuantity', '批次商品总量', 115, ({ source, kind }) => kind === 'shipment' ? '—' : number(source.groupQuantity), 'right'),
  column('monthQuantity', month ? '筛选月商品量' : '全期商品量', 115, ({ source, kind }) => kind === 'shipment' ? '—' : number(source.monthQuantity), 'right'));
  columns.push(column('status', '状态 / 来源版本', 165, ({ source }) => `${status(source)}\n需求 v${source.demandVersion} · 商品 ${source.dataVersion ? `v${source.dataVersion}` : '待同步'}`));
  if (presentation !== 'boxes') columns.push(column('dates', '业务日期 / 实际发货日期', 190, ({ source }) => `${source.businessDate}\n发货：${source.actualShipDate || '未登记'}`));
  columns.push({ key: 'actions', title: '操作', width: 48, align: 'center', getValue: () => '', icon: () => 'more', openMenu: true, editLabel: ({ source }) => `货件 ${source.fba} 操作` });
  const visibleColumns = columns.filter((field) => requiredColumnKeys.has(field.key) || !gridPreferences.hiddenColumnKeys.includes(field.key));
  const actions = (row: DemandWorkspaceRow, close?: () => void) => {
    const inMenu = Boolean(close), role = inMenu ? 'menuitem' as const : undefined;
    const run = (callback: () => void) => { close?.(); callback(); };
    const target: LifecycleTarget = { type: 'demand', id: row.demandId, name: row.fba, lifecycle: lifecycleOf(row), lifecyclePending: lifecyclePending(row) };
    const lifecycleActions: ShippingLifecycleAction[] = lifecycleOf(row) === 'trashed' ? ['restore', 'purge'] : lifecycleOf(row) === 'cancelled' ? ['restore', 'trash'] : lifecycleOf(row) === 'purged' ? [] : ['cancel', 'trash'];
    return <div className={inMenu ? 'shipping-grid-menu-actions' : 'shipping-shipment-actions'}>{lifecycleOf(row) === 'active' && !lifecyclePending(row) && (row.groupId && row.batchId && openGroup
      ? <Button type="button" role={role} variant="text" disabled={locked} onClick={() => run(() => openGroup(row.batchId!, row.groupId!))}>处理批次</Button>
      : !row.groupId && arrange ? <Button type="button" role={role} variant="text" disabled={locked} onClick={() => run(() => arrange([row.demandId], 'create'))}>安排批次</Button> : null)}
      {lifecycleOf(row) === 'active' && !lifecyclePending(row) && (row.batchId || !arrange) && <WorkspaceLink row={row} menu={inMenu} disabled={locked} close={close} />}
      {manageDemand && <div className={inMenu ? 'shipping-grid-menu-group' : 'shipping-demand-record-actions'}>
        <Button type="button" role={role} variant="text" icon={Eye} disabled={locked} onClick={() => run(() => manageDemand(row.demandId, 'view'))}>查看需求</Button>
        <Button type="button" role={role} variant="text" icon={Pencil} disabled={locked || row.status === 'frozen' || lifecycleOf(row) !== 'active'} title={lifecycleOf(row) !== 'active' ? '请先恢复需求，再核对编辑权限。' : row.status === 'frozen' ? '已冻结，请通过批次更正处理。' : undefined} onClick={() => run(() => manageDemand(row.demandId, 'edit'))}>编辑需求</Button>
        {lifecyclePending(row) && <span className="mapping-subtext" role="status">正在停止后台任务…</span>}
        {lifecycleActions.map((action) => <Button key={action} type="button" role={role} variant="text" icon={action === 'restore' ? ArchiveRestore : action === 'cancel' ? Ban : Trash2} disabled={locked || lifecyclePending(row)} onClick={() => run(() => setLifecycleCommand({ target, action }))}>{({ cancel: '取消需求', trash: '删除需求', restore: '恢复需求', purge: '彻底删除需求' } as const)[action]}</Button>)}
      </div>}
    </div>;
  };
  return <>
    {toolbarStart && <div className="shipping-grid-controls">{toolbarStart}</div>}
    <ScmDataGrid label="发货明细表" className="shipping-workbench-grid" rows={records} columns={visibleColumns} getRowKey={(row) => row.key} rowHeight={56} maxHeight={640} frozenColCount={presentation === 'shipments' ? 4 : 3}
    rowSeriesNumber={false} navigationPosition="bottom" footerStart={footerStart} footerEnd={footerEnd} middleMousePan
    headerEnd={<>
      {presentation === 'shipments' && <><Button type="button" icon={ChevronsUp} title="收起当前页全部货件的商品明细" disabled={!active || locked || !hasExpanded} onClick={() => setAllExpanded(false)}>全部收起</Button><Button type="button" icon={ChevronsDown} title="展开当前页全部货件的商品明细" disabled={!active || locked || !hasCollapsed} onClick={() => setAllExpanded(true)}>全部展开</Button></>}
      <ShippingColumnSettings columns={columns} preferences={gridPreferences} active={active} />
    </>}
    columnWidths={gridPreferences.columnWidths} onColumnWidthsChange={gridPreferences.setColumnWidths} menuScopeKey={menuScopeKey ?? presentation}
    active={active} isGroupRow={(entry) => entry.kind === 'shipment'} detailsMode="dialog" detailsTitle={(entry) => `货件 ${entry.source.fba}`}
    renderRowMenu={(entry, context) => <>
      <div className="shipping-grid-menu-summary"><strong>{entry.source.fba}</strong><span className={`demand-status demand-status-${entry.source.status}`}>{status(entry.source)}</span><p>{entry.source.groupName || '待分组'} · {entry.source.destinationFc || '目的仓未填写'}</p><p>{entry.source.shop} · {entry.source.country} · {entry.source.channel || '渠道未填'}</p>{entry.kind === 'product' && <p>{entry.source.productName || '品名未填写'} · {entry.source.sku || entry.source.msku || 'SKU 未填写'}</p>}{entry.kind === 'box' && <p>第 {entry.box?.boxOrder} 箱 · {entry.box?.code || '待编码'}</p>}</div>
      <Button type="button" role="menuitem" className="shipping-grid-full-details" variant="text" icon={Eye} onClick={context.openDetails}>完整详情</Button>
      {actions(entry.source, context.close)}
    </>}
    renderDetails={(entry) => <section className="shipping-grid-details" aria-label={`货件 ${entry.source.fba} 当前记录`} data-demand-id={entry.source.demandId} data-grid-row-kind={entry.kind}>
      <div className="shipping-grid-detail-heading"><div><h3>{entry.kind === 'shipment' ? '货件汇总' : entry.kind === 'box' ? '逐箱明细' : entry.kind === 'placeholder' ? '待同步明细' : `商品明细 ${entry.productIndex} / ${entry.productCount}`} · {entry.source.fba}</h3><p>{entry.source.shop} · {entry.source.country} · {entry.source.channel || '渠道未填'} · {entry.source.groupName || '待分组'}</p></div>{renderSelection(entry.source, true, Boolean(entry.source.groupId))}</div>
      {entry.kind === 'shipment' && <Button type="button" variant="text" icon={ChevronDown} aria-expanded={expanded.includes(entry.source.demandId)} onClick={() => toggleExpanded(entry.source.demandId)}>{expanded.includes(entry.source.demandId) ? '收起明细' : '商品与逐箱明细'}</Button>}
      <dl className="shipping-grid-values">{columns.filter((field) => !field.onToggle && !field.onActivate && !field.openDetails && !field.openMenu && !field.utility && (entry.kind !== 'shipment' || ['fba', 'group', 'destinationFc', 'shop', 'country', 'channel', 'codes', 'product', 'status', 'dates'].includes(field.key))).map((field) => <div key={field.key}><dt>{entry.kind === 'shipment' && field.key === 'codes' ? '商品 / 箱数' : entry.kind === 'shipment' && field.key === 'product' ? '发货票号' : field.title}</dt><dd>{field.getValue(entry) ?? '—'}</dd></div>)}</dl>
      {entry.source.destinationAddress && <details className="demand-address"><summary>仓库地址</summary><p>{entry.source.destinationAddress}</p></details>}
      {entry.box && <details><summary>箱标识</summary><p>外部 ID：{entry.box.externalBoxId || '—'}<br />本地 ID：{entry.box.localBoxId || '—'}<br />箱名 / 来源：{entry.box.boxName || entry.box.sourceLabel || '—'}</p></details>}
      {entry.kind === 'placeholder' && <p className="mapping-help">{lifecycleOf(entry.source) !== 'active' ? '需求已停止处理，来源和历史记录保留。' : '尚无装箱数据，请先同步或补录。'}</p>}
      <ShippingSource row={entry.source} />{actions(entry.source)}
    </section>} />
    {lifecycleCommand && <ShippingLifecycleDialog key={`${lifecycleCommand.target.id}:${lifecycleCommand.action}`} {...lifecycleCommand} active={active} close={() => setLifecycleCommand(null)} completed={() => { setLifecycleCommand(null); lifecycleChanged?.(); }} />}
  </>;
}

function ShippingColumnSettings({ columns, preferences, active }: { columns: GridColumn<GridRow>[]; preferences: ShippingGridPreferences; active: boolean }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const searchId = useId();
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const fields = columns.filter((field) => !utilityColumnKeys.has(field.key));
  const matches = fields.filter((field) => field.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const hidden = new Set(preferences.hiddenColumnKeys);
  const toggle = (key: string, checked: boolean) => preferences.setHiddenColumnKeys(checked ? preferences.hiddenColumnKeys.filter((value) => value !== key) : [...new Set([...preferences.hiddenColumnKeys, key])]);
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" icon={Columns3}>列展示设置</Button></PopoverTrigger><PopoverContent className="shipping-column-picker" align="end" aria-label="列展示设置" onOpenAutoFocus={(event) => { event.preventDefault(); searchInput.current?.focus({ preventScroll: true }); }}>
    <div className="shipping-column-search"><label htmlFor={searchId}>搜索列</label><Input ref={searchInput} id={searchId} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入列名" autoComplete="off" /></div>
    <p className="shipping-column-count">已显示 {fields.filter((field) => requiredColumnKeys.has(field.key) || !hidden.has(field.key)).length} / {fields.length} 个业务列</p>
    <div className="shipping-column-list">{matches.map((field) => <label key={field.key} data-column-key={field.key} className="shipping-column-option"><input type="checkbox" checked={requiredColumnKeys.has(field.key) || !hidden.has(field.key)} disabled={requiredColumnKeys.has(field.key)} onChange={(event) => toggle(field.key, event.target.checked)} /><span>{field.title}</span>{requiredColumnKeys.has(field.key) && <small>固定显示</small>}</label>)}{!matches.length && <p className="mapping-help">没有匹配的列。</p>}</div>
    <div className="shipping-column-actions"><Button type="button" variant="text" onClick={() => preferences.setHiddenColumnKeys([])}>全部显示</Button><Button type="button" variant="text" icon={RotateCcw} onClick={preferences.resetColumns}>恢复默认列</Button></div>
  </PopoverContent></Popover>;
}
function ShippingSource({ row }: { row: DemandWorkspaceRow }) {
  return <><span className={`demand-status demand-status-${row.status}`}>{lifecycleOf(row) !== 'active' ? lifecycleLabels[lifecycleOf(row)] : shippingStatusLabels[row.status]}</span>{row.issues.length > 0 && <details className="demand-issues"><summary>{row.issues.length} 项提示</summary><ul>{row.issues.map((issue, index) => <li key={index} className={issue.severity === 'error' ? 'error-note' : 'warning-note'}>{issue.message}</li>)}</ul></details>}<details className="shipping-source-details"><summary>{row.confirmationId ? '确认数据' : '候选 / 来源'} · 需求 v{row.demandVersion}</summary>
    <p>需求 v{row.demandVersion}{row.currentDemandVersion !== row.demandVersion ? ` / 当前 v${row.currentDemandVersion}` : ''} · 商品 {row.dataVersion ? `v${row.dataVersion}` : '待同步'}</p>
    {row.confirmationId && <p>确认版本：{row.confirmationId}</p>}{row.dataRevisionId && <p>数据修订：{row.dataRevisionId}</p>}
    <p>来源填写：{displayTime(row.sourceFilledAt)}<br />货件创建：{displayTime(row.shipmentCreatedAt)}<br />已装天数：{row.packingDays ?? '—'}<br />备注：{row.notes || '—'}</p>
    {row.sources.length > 0 && <ul className="demand-source-list">{row.sources.map((source, index) => <li key={index}><Link to="/imports/$importId" params={{ importId: source.importId }}>{source.fileName}</Link><small>{source.sheetName} · 第 {source.rowNumber} 行</small></li>)}</ul>}
  </details></>;
}

function WorkspaceLink({ row, menu = false, disabled = false, close }: { row: DemandWorkspaceRow; menu?: boolean; disabled?: boolean; close?: () => void }) {
  if (menu) return row.batchId ? <Link role="menuitem" className="text-button" aria-disabled={disabled || undefined} to="/batches/$batchId" params={{ batchId: row.batchId }} search={{ demandId: row.demandId, groupId: row.groupId ?? undefined, tab: 'shipments' }} onClick={(event) => { if (disabled) event.preventDefault(); else close?.(); }}><Eye size={18} aria-hidden="true" />{row.groupId ? '查看货件' : '进入批次分组'}</Link> : <Link role="menuitem" className="text-button" aria-disabled={disabled || undefined} to="/batches" search={{}} onClick={(event) => { if (disabled) event.preventDefault(); else close?.(); }}><Plus size={18} aria-hidden="true" />安排发货次</Link>;
  if (row.batchId) return <IconLink icon={Eye} label={row.groupId ? '查看货件' : '进入批次分组'} description={`${row.fba} · ${row.shop}`} to="/batches/$batchId" params={{ batchId: row.batchId }} search={{ demandId: row.demandId, groupId: row.groupId ?? undefined, tab: 'shipments' }} />;
  return <Link className="text-button" to="/batches" search={{}}><Plus size={18} aria-hidden="true" />安排发货次</Link>;
}
