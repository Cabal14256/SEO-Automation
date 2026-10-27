import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { reportTicketKey, type ReportReference } from '@scm/contracts';
import { Download, FileSpreadsheet, Filter, History, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { MonthPicker } from '../components/ui/month-picker';
import { SelectField } from '../components/ui/select';
import { batchApi } from './batch-api';
import { BatchPagination, BatchTable, downloadBlob, QueryError, TableSelectionCheckbox, timestamp, useBatchAction } from './batch-shared';
import { ImportDialog } from './import-dialog';
import { getReportTicketCodeRanges, getShippingBoxColumns, ShippingBoxQuantityCells, ShippingCodesCell, ShippingProductCells, ShippingShopCell } from './shipping-table-parts';
import './batch-reports.css';

const statusLabels: Record<string, string> = { draft: '待确认', confirmed: '已确认', frozen: '已冻结', superseded: '已替代', queued: '排队中', running: '生成中', completed: '已生成', failed: '失败', stale: '版本已过期' };
const sameReference = (left: ReportReference, right: ReportReference | undefined) => Boolean(right && left.groupVersion === right.groupVersion && left.confirmationId === right.confirmationId);
const maxSelectedGroups = 500;
type WorkspaceFilters = { month: string; region: string; q: string; shippingRunId?: string; sid?: number; country?: string; channel?: string };
export function BatchReports({ weeklyBatchId, subBatchId, active = true, workspaceFilters, workspaceFiltersPending = false }: { weeklyBatchId?: string; subBatchId?: string; active?: boolean; workspaceFilters?: WorkspaceFilters; workspaceFiltersPending?: boolean }) {
  const id = useId();
  const [draftQuery, setDraftQuery] = useState('');
  const [localQuery, setQuery] = useState('');
  const [draftMonth, setDraftMonth] = useState('');
  const [draftRegion, setDraftRegion] = useState('all');
  const [localMonth, setMonth] = useState('');
  const [localRegion, setRegion] = useState('all');
  const query = workspaceFilters?.q ?? localQuery;
  const month = workspaceFilters?.month ?? localMonth;
  const region = workspaceFilters?.region ?? localRegion;
  const [page, setPage] = useState(1);
  const [view, setView] = useState('products');
  const scope = JSON.stringify([weeklyBatchId, subBatchId, month, region, query, workspaceFilters?.shippingRunId, workspaceFilters?.sid, workspaceFilters?.country, workspaceFilters?.channel]);
  const [selection, setSelection] = useState(() => ({ scope, references: new Map<string, ReportReference>() }));
  const [selectionNotice, setSelectionNotice] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const action = useBatchAction();
  const report = useQuery({ queryKey: ['batch-reports', scope, page], queryFn: () => batchApi.reports({ ...workspaceFilters, month, region, q: query, weeklyBatchId, subBatchId, page }), retry: false, enabled: active });
  const exports = useQuery({ queryKey: ['batch-exports', subBatchId, month], queryFn: () => batchApi.exports({ subBatchId, month }), retry: false, enabled: active && historyOpen, refetchInterval: (query) => active && historyOpen && query.state.data?.some((record) => record.status === 'queued' || record.status === 'running') ? 1500 : false });
  const refs = selection.scope === scope ? [...selection.references.values()].sort((left, right) => left.groupId.localeCompare(right.groupId)) : [];
  const availableReferences = new Map(report.data?.confirmations.map((ref) => [ref.groupId, ref]));
  const visibleGroupIds = [...new Set(view === 'products' ? report.data?.rows.map((row) => row.groupId) : report.data?.boxes.filter((box) => box.items.length > 0).map((box) => box.groupId))];
  const visibleReferences = visibleGroupIds.flatMap((groupId) => { const ref = availableReferences.get(groupId); return ref ? [ref] : []; });
  const isSelected = (groupId: string) => selection.scope === scope && selection.references.has(groupId);
  const selectedVisibleCount = visibleReferences.filter((ref) => isSelected(ref.groupId)).length;
  const boxColumns = getShippingBoxColumns(report.data?.maxBoxes, report.data?.boxes);
  const ticketRanges = getReportTicketCodeRanges(report.data);
  const filtersChanged = workspaceFilters ? workspaceFiltersPending : draftMonth !== month || draftRegion !== region || draftQuery.trim() !== query;
  const selectionDisabled = action.busy || report.isFetching || report.isPending || report.isError || filtersChanged;
  const canExport = !selectionDisabled && refs.length > 0 && refs.every((ref) => sameReference(ref, availableReferences.get(ref.groupId)));
  useEffect(() => {
    setPage(1);
    setSelection((current) => current.scope === scope ? current : { scope, references: new Map() });
    setSelectionNotice('');
  }, [scope]);
  useEffect(() => {
    if (!report.data || report.isFetching || report.isError || selection.scope !== scope) return;
    const currentReferences = new Map(report.data.confirmations.map((ref) => [ref.groupId, ref]));
    const invalid = [...selection.references.values()].filter((ref) => !sameReference(ref, currentReferences.get(ref.groupId)));
    if (invalid.length === 0) return;
    setSelection((current) => {
      if (current.scope !== scope) return current;
      const references = new Map(current.references);
      for (const ref of invalid) references.delete(ref.groupId);
      return { scope, references };
    });
    setSelectionNotice(`${invalid.length} 个已选子批次的确认已失效或版本已变化，已取消选择，请核对后重新勾选。`);
  }, [report.data, report.isFetching, report.isError, selection, scope]);
  const clearSelection = () => { setSelection({ scope, references: new Map() }); setSelectionNotice(''); };
  const selectGroups = (references: ReportReference[], checked: boolean) => {
    if (selectionDisabled) return;
    const next = new Map(selection.scope === scope ? selection.references : []);
    for (const reference of references) {
      if (checked) next.set(reference.groupId, reference);
      else next.delete(reference.groupId);
    }
    if (next.size > maxSelectedGroups) { setSelectionNotice(`每次最多选择 ${maxSelectedGroups} 个子批次，请先取消部分选择；本次选择未生效。`); return; }
    setSelection({ scope, references: next });
    setSelectionNotice('');
  };
  const selectionHeader = (title: string) => <><TableSelectionCheckbox label="全选本页子批次" checked={visibleReferences.length > 0 && selectedVisibleCount === visibleReferences.length} indeterminate={selectedVisibleCount > 0 && selectedVisibleCount < visibleReferences.length} disabled={selectionDisabled || visibleReferences.length === 0} onChange={(checked) => selectGroups(visibleReferences, checked)} />{title}</>;
  const groupCell = (groupId: string, name: string, detail: string) => <div className="batch-report-group-cell"><TableSelectionCheckbox label={`选择子批次 ${name}`} checked={isSelected(groupId)} disabled={selectionDisabled || !availableReferences.has(groupId)} onChange={(checked) => { const reference = availableReferences.get(groupId); if (reference) selectGroups([reference], checked); }} /><div><strong>{name}</strong><small className="mapping-subtext">{detail}</small>{!availableReferences.has(groupId) && <small className="mapping-subtext error-note">确认已失效，请刷新后重新核对。</small>}</div></div>;
  const generateExport = () => {
    if (!canExport) return;
    action.run(JSON.stringify(['export', refs, month, region]), async (operationId) => {
      try { return await batchApi.export({ operationId, groupIds: refs.map((ref) => ref.groupId), expectedConfirmations: refs, ...(month ? { month } : {}), region }); }
      catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setSelection({ scope, references: new Map() });
          setSelectionNotice('确认版本已变化，已清空选择并刷新列表，请重新勾选子批次。');
          void report.refetch();
        }
        throw error;
      }
    }, '导出任务已受理。请在“导出记录”中查看进度并下载。');
  };
  return <div className="batch-reports">
    {!workspaceFilters && <div className="import-page-heading batch-report-heading"><div><h2>发货成品表</h2><p className="mapping-help">查看已确认商品与逐箱明细，按子批次选择范围并生成发货 XLSX。</p></div></div>}
    <section className={workspaceFilters ? 'batch-report-panel batch-report-panel-embedded' : 'content-panel batch-report-panel'} aria-labelledby={`${id}-list-title`}>
      {!workspaceFilters && <form className="batch-report-filters" aria-label="筛选成品表" onSubmit={(event) => { event.preventDefault(); setMonth(draftMonth); setRegion(draftRegion); setDraftQuery(draftQuery.trim()); setQuery(draftQuery.trim()); setPage(1); clearSelection(); }}>
        <div className="field batch-report-search"><label htmlFor={`${id}-report-search`}>搜索</label><Input id={`${id}-report-search`} type="search" value={draftQuery} maxLength={200} autoComplete="off" placeholder="子批次、FBA、店铺、品名、MSKU、FNSKU、SKU、内部编码" onChange={(event) => setDraftQuery(event.target.value)} /></div>
        <div className="field"><label htmlFor={`${id}-report-month`}>发货月份</label><MonthPicker id={`${id}-report-month`} value={draftMonth} onValueChange={setDraftMonth} /></div>
        <div className="field"><label htmlFor={`${id}-report-region`}>国家 / 区域</label><SelectField id={`${id}-report-region`} value={draftRegion} onValueChange={setDraftRegion} options={[{ value: 'all', label: '全部国家' }, { value: 'US', label: '美国' }, { value: 'EU', label: '欧洲' }]} /></div>
        <div className="field"><label htmlFor={`${id}-report-view`}>明细视图</label><SelectField id={`${id}-report-view`} value={view} onValueChange={setView} options={[{ value: 'products', label: '商品及逐箱数量' }, { value: 'boxes', label: '逐箱长表' }]} /></div>
        <div className="batch-report-filter-actions"><Button type="submit" icon={Filter} loading={report.isFetching}>筛选</Button><Button type="button" variant="text" icon={RotateCcw} onClick={() => { setDraftQuery(''); setQuery(''); setDraftMonth(''); setDraftRegion('all'); setMonth(''); setRegion('all'); setPage(1); clearSelection(); setView('products'); }}>重置</Button></div>
      </form>}
      {!workspaceFilters && filtersChanged && <p className="form-note" role="status">筛选条件已修改，请点击“筛选”更新列表和导出范围。</p>}
      {workspaceFilters && <div className="field shipping-report-view"><label htmlFor={`${id}-embedded-view`}>明细视图</label><SelectField id={`${id}-embedded-view`} value={view} onValueChange={setView} options={[{ value: 'products', label: '商品及逐箱数量' }, { value: 'boxes', label: '逐箱长表' }]} /></div>}
      <div className="batch-report-toolbar" aria-label="成品表操作">
        <Button type="button" icon={FileSpreadsheet} loading={action.pendingKey?.startsWith('["export",')} variant="primary" disabled={!canExport} onClick={generateExport}>生成发货表 XLSX</Button>
        <Button type="button" icon={History} onClick={() => setHistoryOpen(true)}>发货表导出记录</Button>
        <IconButton type="button" icon={RefreshCw} label="刷新成品表" loading={report.isFetching} onClick={() => void report.refetch()} />
        <Button type="button" variant="text" disabled={refs.length === 0 || action.busy} onClick={clearSelection}>清空选择</Button>
        <span className="batch-report-total" role="status">{report.data ? `${report.data.total} 条商品 · 已选 ${refs.length} 个子批次` : '正在读取成品表…'}</span>
      </div>
      <p className="mapping-help batch-report-export-help">勾选表格中的子批次，按完整子批次导出并冻结，每次最多 500 个。月份、区域筛选保留现有报表口径；表格与 XLSX 引用同一确认版本。</p>
      {selectionNotice && <p className="form-note error-note" role="alert">{selectionNotice}</p>}
      {!historyOpen && action.feedback}
      <div className="section-heading demand-list-heading"><h2 id={`${id}-list-title`}>{view === 'products' ? '商品与逐箱明细' : '逐箱明细'}</h2><span>月份按首次业务日期筛选 · 留空显示全部</span></div>
      {report.isPending ? <p className="list-state" role="status">正在读取确认数据…</p> : report.isError ? <QueryError error={report.error} retry={() => void report.refetch()} /> : <>
        {report.data.blocked.length > 0 && <details className="batch-details"><summary>另有 {report.data.blocked.length} 个子批次未满足成品表条件</summary><ul className="import-issues">{report.data.blocked.map((item) => <li key={item.groupId}><strong>{item.name}</strong>：{item.message}（{item.code}）</li>)}</ul></details>}
        {report.data.total === 0 ? <p className="list-state">{query ? '未找到匹配的子批次，请调整搜索词或筛选条件。' : '此范围还没有可展示的已确认商品数据。请先同步或补录、核对数量、确认箱序并分配编码。'}</p> : <>
          <p className="mapping-help">共 {report.data.total} 条商品 · 此筛选范围 {report.data.boxes.length} 箱 · 数据生成于 {timestamp(report.data.generatedAt)}</p>
          {view === 'products' ? <BatchTable label="商品及逐箱数量" headers={[selectionHeader('批次 / 发货次'), '店铺 / 国家 / 渠道', '目的 FC / FBA', 'MSKU / FNSKU', '品名 / SKU', '详情申报量', ...boxColumns.map((box) => `箱 ${box}`), '整票编码范围', '子批次商品总量', '本月商品量', '首次业务日期', '实际发货日期 / 状态', '数据来源 / 确认版本']}>
            {report.data.rows.map((row, index, rows) => <tr key={row.id} aria-selected={isSelected(row.groupId)}><td>{groupCell(row.groupId, row.groupName, row.ticketNumber || '历史批次／未关联发货次')}</td><ShippingShopCell {...row} /><td>{row.destinationFc || '—'}<small className="mapping-subtext">{row.fba}</small></td><ShippingProductCells {...row} /><td>{row.quantity}</td><ShippingBoxQuantityCells columns={boxColumns} boxes={row.boxes} /><ShippingCodesCell range={index === 0 || reportTicketKey(rows[index - 1]!) !== reportTicketKey(row) ? ticketRanges.get(reportTicketKey(row)) || '待编码' : ''} /><td>{row.groupQuantity}</td><td>{row.monthQuantity}</td><td>{row.businessDate}</td><td>{row.actualShipDate || '未登记'}<small className="mapping-subtext">{statusLabels[row.status] ?? row.status}</small></td><td>{timestamp(row.sourceObservedAt)}<small className="mapping-subtext">{row.dataRevisionId}</small><small className="mapping-subtext">{row.confirmationId}</small></td></tr>)}
          </BatchTable> : <BatchTable label="逐箱长表" headers={[selectionHeader('子批次 / FBA'), '箱序 / 内部编码', '平台箱标识', '商品身份', '箱内数量', '登记重量', '登记尺寸']}>
            {report.data.boxes.flatMap((box) => box.items.map((item, index) => <tr key={`${box.boxId}-${index}`} aria-selected={isSelected(box.groupId)}><td>{groupCell(box.groupId, box.groupName, `${box.fba} · sid ${box.sid}`)}</td><td>第 {box.boxOrder} 箱 · {box.code || '待编码'}</td><td>{box.boxName || '无箱名'}<small className="mapping-subtext">外部ID {box.boxExternalId || '—'} · localBoxId {box.localBoxId || '—'}</small></td><td>{item.msku}<small className="mapping-subtext">{item.fnsku} / {item.sku}</small></td><td>{item.quantity}</td><td>{box.weight === null ? '缺失' : `${box.weight} ${box.weightUnit || '单位缺失'}`}</td><td>{box.length === null || box.width === null || box.height === null ? '缺失' : `${box.length} × ${box.width} × ${box.height} ${box.lengthUnit || '单位缺失'}`}</td></tr>))}
          </BatchTable>}
          {view === 'products' && <BatchPagination page={page} pageSize={50} total={report.data.total} change={setPage} />}
        </>}
      </>}
    </section>
    {createPortal(<ImportDialog open={active && historyOpen} title="导出记录" close={() => setHistoryOpen(false)} wide>
      <div className="batch-report-history-heading"><p className="mapping-help">保存数据版本及文件；失败与过期结果单独显示，历史下载保留原内容。</p><IconButton type="button" icon={RefreshCw} label="刷新历史" loading={exports.isFetching} onClick={() => void exports.refetch()} /></div>
      {action.feedback}
      {exports.isPending ? <p className="list-state">正在读取导出历史…</p> : exports.isError ? <QueryError error={exports.error} retry={() => void exports.refetch()} /> : exports.data.length === 0 ? <p className="list-state">尚无导出记录。</p> : <BatchTable label="导出历史" headers={['时间 / 范围', '状态', '商品 / 箱', '确认版本', '下载 / 错误']}>{exports.data.map((record) => <tr key={record.id}><td>{timestamp(record.createdAt)}<small className="mapping-subtext">{record.month || '全部月份'} · {record.region === 'all' ? '全部国家' : record.region} · {record.groupIds.length} 组</small></td><td>{(record.status === 'queued' || record.status === 'running') && <LoaderCircle className="motion-spin" size={15} aria-hidden="true" />}{statusLabels[record.status]}{record.status === 'completed' && !record.valid && <small className="mapping-subtext error-note">{record.invalidReason || '历史版本已被替代'}</small>}</td><td>{record.rowCount} 条 / {record.boxCount} 箱</td><td>{record.references.map((ref) => <small className="mapping-subtext" key={ref.confirmationId}>{ref.confirmationId} · v{ref.groupVersion}</small>)}</td><td>{record.fileId && <IconButton icon={Download} label="下载 XLSX" description={`${timestamp(record.createdAt)} · ${record.month || '全部月份'}`} loading={action.pendingKey === `download-${record.id}`} disabled={action.busy} onClick={() => action.run(`download-${record.id}`, () => downloadBlob(batchApi.download(record.fileId!), `发货记录-${record.month || '批次'}-${record.id}.xlsx`), '下载已开始。')} />}{record.error && <p className="form-note error-note">{record.error}</p>}</td></tr>)}</BatchTable>}
    </ImportDialog>, document.body)}
  </div>;
}
