import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useBlocker, useSearch } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, Download, Eye, FileCheck, History, Plus, RefreshCw, Save, Search, Upload } from 'lucide-react';
import { archiveDataSchema, customsDataSchema, documentCountryCode, financeDataSchema, fulfillmentDataSchema, isWorkflowUnderMaintenance, logisticsDataSchema, workflowBoxes, workflowMaintenanceMessage, type ArchiveData, type CustomsData, type FinanceData, type FulfillmentData, type LogisticsData, type WorkflowContext, type WorkflowDetail, type WorkflowKind, type WorkflowRecord, type WorkflowSource, type WorkflowWrite } from '@scm/contracts';
import { api, ApiError } from '../api';
import { AppShell, StatePage } from '../pages';
import { Button, IconButton } from '../components/ui/button';
import { BatchPagination, BatchTable, messageOf, newOperation, QueryError, timestamp } from './batch-shared';
import { ImportDialog } from './import-dialog';
import { workflowApi } from './workflow-api';
import { BoxesSelection, ChoiceField, Section, TextField } from './workflow-fields';
import { FulfillmentForm, LogisticsForm } from './workflow-fulfillment';
import { CustomsForm } from './workflow-customs';
import { ArchiveForm, FinanceForm } from './workflow-finance';
import './workflow-workspace.css';

const labels: Record<WorkflowKind, { title: string; help: string; create: string }> = {
  fulfillment: { title: '领星单据与分配', help: '从已复核单据准备发货，在领星操作后逐项核对实际单据与库存分配。', create: '新建领星准备单' },
  logistics: { title: '物流与交接', help: '引用已复核的丰信文件，登记物流接单、箱唛、重量与实际交接。', create: '新建物流订单' },
  customs: { title: '报关与 9810', help: '按申报主体、国家及币种组织报关资料，分别追踪报关与 9810 结果。', create: '新建报关分组' },
  finance: { title: '费用对账', help: '登记原始账单，逐单分摊、核对人工回填结果，并完成结清。', create: '新建费用账单' },
  archive: { title: '批次归档', help: '检查全部有效成员的完成条件，生成归档文件并保留后续补账记录。', create: '新建批次归档' },
};
const statusLabels: Record<string, string> = { draft: '草稿', ready: '准备完成', pending: '待处理', completed: '已完成', complete: '已完成', partial_handover: '部分交接', confirmed: '已确认', cancelled: '已取消', submitted: '已提交', accepted: '已接收', rejected: '已拒绝', released: '已放行', partially_handed_over: '部分交接', handed_over: '已交接', pending_review: '待复核', reviewed: '复核通过', approved: '复核通过', returned: '已退回', settled: '已结清', reopened: '待重新处理', archived: '已归档', stale: '已失效', queued: '排队中', running: '生成中', failed: '失败' };
const actionLabels: Record<string, string> = { save: '保存草稿', confirm: '确认准备完成', record_result: '核对外部结果', cancel: '取消记录', submit: '登记丰信文件提交', record_receipt: '登记接单反馈', release: '检查并放行', handover: '登记实际交接', record_lingxing: '核对领星发货', preflight: '执行报关预检', review: '确认文件复核通过', return: '退回修订', 'record-customs': '登记报关结果', 'record-9810': '登记 9810 结果', complete: '检查并完成', settle: '检查并结清', check: '检查归档条件', archive: '确认归档条件', reopen: '重新打开待办' };
const actions: Record<WorkflowKind, string[]> = { fulfillment: ['confirm', 'record_result', 'cancel'], logistics: ['submit', 'record_receipt', 'release', 'handover', 'record_lingxing', 'cancel'], customs: ['preflight', 'review', 'return', 'record-customs', 'record-9810', 'complete', 'cancel'], finance: ['confirm', 'record_result', 'settle', 'cancel'], archive: ['check', 'archive', 'reopen'] };
const exportOptions: Partial<Record<WorkflowKind, Array<{ purpose: string; label: string }>>> = { fulfillment: [{ purpose: 'preparation', label: '生成单据准备清单' }, { purpose: 'reconciliation', label: '生成分配核对清单' }], customs: [{ purpose: 'customs-package', label: '生成七页报关资料' }, { purpose: 'filing9810-checklist', label: '生成 9810 填写核对清单' }], finance: [{ purpose: 'allocation-checklist', label: '生成拟回填清单' }], archive: [{ purpose: 'archive-package', label: '生成归档 ZIP' }] };
const emptyContext: WorkflowContext = { records: [], files: [], exports: [], sourceValid: true, sourceInvalidReason: null };
const stateLabel = (value: string) => statusLabels[value] ?? '待核对';
function Status({ status }: { status: string }) { return <span className={`workflow-status workflow-status-${status}`}>{stateLabel(status)}</span>; }
function apiFailureStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  // A request may have been created by an earlier hot-reloaded API module.
  // Use the public error shape as well as class identity to keep recovery usable.
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'ApiError' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}
const initialBoxIds = (kind: WorkflowKind, source: WorkflowSource) => { const boxes = workflowBoxes(source); return (kind === 'customs' ? boxes.filter((box) => box.country === boxes[0]?.country) : boxes).map((box) => box.id); };

function newData(kind: WorkflowKind, source: WorkflowSource, boxIds: string[]): Record<string, unknown> {
  const boxes = workflowBoxes(source).filter((box) => boxIds.includes(box.id));
  if (kind === 'fulfillment') return fulfillmentDataSchema.parse({ lines: boxes.flatMap((box) => box.items.map((item) => ({ boxId: box.id, msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: item.quantity ?? '0', components: [] }))) });
  if (kind === 'logistics') return logisticsDataSchema.parse({ boxes: boxes.map((box) => ({ boxId: box.id })) });
  if (kind === 'customs') return customsDataSchema.parse({ countryCodes: [...new Set(boxes.map((box) => documentCountryCode(box.country)).filter(Boolean))], currency: source.fields.currency ?? '', declarationMode: source.fields.customsMode || '9810', tradeTerms: source.fields.tradeTerms ?? '', lines: boxes.flatMap((box) => box.items.map((item) => ({ boxId: box.id, msku: item.msku, fnsku: item.fnsku, sku: item.sku, quantity: item.quantity ?? '', declaredQuantity: item.quantity ?? '', currency: source.fields.currency ?? '' }))), boxWeights: boxes.map((box) => ({ boxId: box.id })) });
  if (kind === 'finance') return financeDataSchema.parse({});
  return archiveDataSchema.parse({ groupId: boxes[0]?.groupId ?? source.members[0]!.source.groupId });
}

function useWorkflowAction() {
  const client = useQueryClient(), operations = useRef(new Map<string, string>());
  const [notice, setNotice] = useState('');
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: async (input: { key: string; execute: (operationId: string) => Promise<unknown>; done?: (value: unknown) => void; notice: string }) => {
      if (!operations.current.has(input.key)) operations.current.set(input.key, newOperation());
      return input.execute(operations.current.get(input.key)!);
    },
    onSuccess: async (result, input) => { operations.current.delete(input.key); setNotice(input.notice); input.done?.(result); await client.invalidateQueries({ queryKey: ['workflow'] }); },
    onError: (error) => { setNotice(''); if (apiFailureStatus(error) === 401) void client.invalidateQueries({ queryKey: ['session'] }); },
  });
  return { busy: mutation.isPending, conflict: apiFailureStatus(mutation.error) === 409, reset: () => { mutation.reset(); setNotice(''); }, run: (key: string, execute: (operationId: string) => Promise<unknown>, success: string, done?: (value: unknown) => void) => { setNotice(''); mutation.mutate({ key, execute, done, notice: success }); }, feedback: <>{mutation.isError && <p className="form-note error-note" role="alert"><CircleAlert size={16} aria-hidden="true" />{messageOf(mutation.error)}{apiFailureStatus(mutation.error) === 409 ? ' 请读取最新版本，核对后再提交。' : ' 填写内容已保留，可重试。'}</p>}{notice && <p className="form-note success-note" role="status"><CircleCheck size={16} aria-hidden="true" />{notice}</p>}</> };
}

export function FinanceRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开费用对账" detail={messageOf(session.error)} action={<Button type="button" onClick={() => void session.refetch()}>重试</Button>} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <AppShell user={session.data.user} title="费用对账"><div className="content-width workflow-page"><WorkflowWorkspace kind="finance" /></div></AppShell>;
}

export function WorkflowWorkspace({ kind, active = true }: { kind: WorkflowKind; active?: boolean }) {
  if (isWorkflowUnderMaintenance(kind)) return <section className="content-panel workflow-workspace" aria-label={`${labels[kind].title}${workflowMaintenanceMessage}`}>
    <div className="section-heading panel-heading"><h2>{labels[kind].title}{workflowMaintenanceMessage}</h2></div>
    <p className="workflow-boundary" role="status">该功能尚未完成，暂时关闭。</p>
    <Link className="secondary-button" to="/shipping" search={{ view: 'demands' }}>返回发货工作台</Link>
  </section>;
  return <ActiveWorkflowWorkspace kind={kind} active={active} />;
}

function ActiveWorkflowWorkspace({ kind, active }: { kind: WorkflowKind; active: boolean }) {
  const search = useSearch({ strict: false });
  const [query, setQuery] = useState(''), [status, setStatus] = useState(''), [filters, setFilters] = useState({ q: '', status: '', page: 1 });
  const [selected, setSelected] = useState<string | null>(typeof search.recordId === 'string' ? search.recordId : null), [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['workflow', kind, 'list', filters, search.groupId], queryFn: () => workflowApi.list(kind, { ...filters, groupId: search.groupId }), enabled: active });
  const sources = useQuery({ queryKey: ['workflow', 'sources'], queryFn: workflowApi.sources, enabled: active });
  const detail = useQuery({ queryKey: ['workflow', kind, selected], queryFn: () => workflowApi.detail(kind, selected!), enabled: active && Boolean(selected), retry: false, refetchInterval: (query) => query.state.data?.context.exports.some((item) => item.status === 'queued' || item.status === 'running') ? 1500 : false });
  const info = labels[kind];
  return <section className="content-panel workflow-workspace" aria-label={info.title}>
    <div className="section-heading panel-heading"><div><h2>{info.title}</h2><p>{info.help}</p></div><Button type="button" variant="primary" icon={Plus} onClick={() => setCreating(true)}>{info.create}</Button></div>
    {kind !== 'archive' && <p className="workflow-boundary">领星继续只读，外部创建、分配、发货和费用修改由人员操作后登记。</p>}
    <form className="workflow-filters" onSubmit={(event) => { event.preventDefault(); setFilters({ q: query, status, page: 1 }); }}><TextField label="搜索名称或关联单号" value={query} change={setQuery} /><ChoiceField label="处理状态" value={status} change={setStatus} options={[{ value: '', label: '全部状态' }, { value: 'draft', label: '草稿' }, { value: 'pending', label: '待处理' }, { value: 'complete', label: '已完成' }, { value: 'cancelled', label: '已取消' }, ...(kind === 'archive' ? [{ value: 'archived', label: '已归档' }, { value: 'reopened', label: '待重新处理' }] : [])]} /><div className="workflow-filter-actions"><Button type="submit" icon={Search}>搜索</Button><IconButton type="button" icon={RefreshCw} label="刷新工作区" loading={list.isFetching} onClick={() => { void list.refetch(); void sources.refetch(); }} /></div></form>
    {search.groupId && <p className="mapping-help">当前查看所选批次分组关联记录。<Link to="/shipping" search={{ view: kind === 'archive' ? 'archives' : kind === 'finance' ? 'demands' : kind }}>查看全部</Link></p>}
    {list.isPending && <p className="list-state" role="status">正在读取记录…</p>}{list.isError && <QueryError error={list.error} retry={() => void list.refetch()} />}
    {list.data && <>{list.data.items.length === 0 ? <div className="workflow-empty"><h3>还没有{info.title}记录</h3><p>选择一份已生成并复核的 来源单据，建立本阶段处理记录。</p><Button type="button" icon={Plus} onClick={() => setCreating(true)}>{info.create}</Button></div> : <BatchTable label={info.title} headers={['名称 / 来源', '范围', '状态', '最近更新', '操作']}>{list.data.items.map((record) => <tr key={record.id}><td><strong>{record.title}</strong><small className="mapping-subtext">{record.source.title} · v{record.source.documentVersion}</small></td><td>{record.boxIds.length} 箱<small className="mapping-subtext">{record.source.shippingRunMonth ? `${record.source.shippingRunMonth} 第 ${record.source.shippingRunSequence ?? '待分配'} 次发货` : '未关联发货次'}</small></td><td><Status status={record.status} /></td><td>{timestamp(record.updatedAt)}</td><td><Button type="button" icon={Eye} onClick={() => setSelected(record.id)}>查看并处理</Button></td></tr>)}</BatchTable>}<BatchPagination page={filters.page} pageSize={20} total={list.data.total} change={(page) => setFilters({ ...filters, page })} /></>}
    <ImportDialog open={active && creating} title={info.create} close={() => setCreating(false)} wide>{sources.isPending ? <p role="status">正在读取已复核单据…</p> : sources.isError ? <QueryError error={sources.error} retry={() => void sources.refetch()} /> : <WorkflowCreate kind={kind} sources={sources.data ?? []} preferredGroup={search.groupId} created={(id) => { setCreating(false); setSelected(id); }} />}</ImportDialog>
    {selected && <ImportDialog open={active && Boolean(selected)} title={`${info.title}处理向导`} close={() => { if (!detail.data) setSelected(null); else document.dispatchEvent(new CustomEvent(`workflow-close:${selected}`)); }} wide>{detail.isPending ? <p role="status">正在读取记录与核对条件…</p> : detail.isError ? <><QueryError error={detail.error} retry={() => void detail.refetch()} /><Button type="button" onClick={() => setSelected(null)}>关闭</Button></> : <WorkflowEditor key={selected} detail={detail.data} active={active} close={() => setSelected(null)} refresh={() => detail.refetch()} />}</ImportDialog>}
  </section>;
}

function WorkflowCreate({ kind, sources, preferredGroup, created }: { kind: WorkflowKind; sources: WorkflowSource[]; preferredGroup?: string; created: (id: string) => void }) {
  const candidates = preferredGroup ? sources.filter((source) => source.members.some((member) => member.source.groupId === preferredGroup)) : sources;
  const [sourceId, setSourceId] = useState(candidates[0]?.documentId ?? ''), [title, setTitle] = useState('');
  const source = candidates.find((item) => item.documentId === sourceId);
  const [boxIds, setBoxIds] = useState<string[]>(source ? initialBoxIds(kind, source) : []);
  const action = useWorkflowAction();
  if (!candidates.length) return <div className="workflow-empty"><h3>暂无可用的已复核单据</h3><p>请先在“发票与单据”完成生成和复核。来源发生变化的单据需重新处理。</p><Link to="/shipping" search={{ view: 'documents' }} className="secondary-button">前往发票与单据</Link></div>;
  const create = () => {
    if (!source) return;
    const data = newData(kind, source, boxIds);
    if (kind === 'archive' && preferredGroup) data.groupId = preferredGroup;
    const payload = { sourceDocumentId: source.documentId, title: title.trim(), boxIds, data, action: 'save', reason: '从已复核单据建立记录' };
    action.run(JSON.stringify(['create', kind, payload]), (operationId) => workflowApi.write(kind, null, { ...payload, operationId }), '草稿已建立。', (value) => created((value as WorkflowRecord).id));
  };
  return <><p className="mapping-help">选择来源与本次处理范围，保存后填写业务资料。各阶段可分别分组。</p><fieldset disabled={action.busy} className="workflow-fieldset"><div className="workflow-fields"><ChoiceField label="已复核来源单据" value={sourceId} change={(id) => { setSourceId(id); const next = candidates.find((item) => item.documentId === id); setBoxIds(next ? initialBoxIds(kind, next) : []); }} options={candidates.map((item) => ({ value: item.documentId, label: `${item.title} · v${item.documentVersion}` }))} /><TextField label="记录名称" value={title} change={setTitle} required /></div>{source && <Section title="处理箱范围" help={kind === 'customs' ? '已默认选择同一目的国家的箱；请再核对主体、申报方式和币种，需要跨国合并时填写依据。' : undefined}><BoxesSelection source={source} value={boxIds} change={setBoxIds} disabled={kind === 'archive'} /></Section>}</fieldset>{action.feedback}<div className="workflow-actions"><Button type="button" variant="primary" icon={Save} loading={action.busy} disabled={!title.trim() || boxIds.length === 0} onClick={create}>建立草稿并继续</Button></div></>;
}

type Stage = 'source' | 'details' | 'checks' | 'files';
function WorkflowEditor({ detail, active, close, refresh }: { detail: WorkflowDetail; active: boolean; close: () => void; refresh: () => Promise<unknown> }) {
  const [record, setRecord] = useState(detail.record), [data, setData] = useState(detail.record.data), [title, setTitle] = useState(detail.record.title), [stage, setStage] = useState<Stage>('details'), [reason, setReason] = useState(''), [confirmClose, setConfirmClose] = useState(false), [refreshing, setRefreshing] = useState(false), [reloadError, setReloadError] = useState('');
  const action = useWorkflowAction();
  const rawContext = detail.context ?? emptyContext;
  const context = { ...rawContext, files: rawContext.files.filter((file) => file.recordId === record.id), exports: rawContext.exports.filter((file) => file.recordId === record.id) };
  const boxes = workflowBoxes(record.source).filter((box) => record.boxIds.includes(box.id));
  const dirty = title !== record.title || JSON.stringify(data) !== JSON.stringify(record.data);
  const dirtyRef = useRef(dirty), busyRef = useRef(action.busy); dirtyRef.current = dirty; busyRef.current = action.busy;
  const disabled = record.status === 'cancelled';
  const blocker = useBlocker({ shouldBlockFn: () => dirtyRef.current || busyRef.current, enableBeforeUnload: dirty || action.busy, withResolver: true });
  useEffect(() => {
    const listener = () => { if (busyRef.current) return; if (dirtyRef.current) setConfirmClose(true); else close(); };
    document.addEventListener(`workflow-close:${record.id}`, listener);
    return () => document.removeEventListener(`workflow-close:${record.id}`, listener);
  }, [close, record.id]);
  const update = (next: Record<string, unknown>) => { setData(next); action.reset(); };
  const save = (name: string) => {
    let nextData = data;
    let preserveResults: Partial<CustomsData> = {};
    let preserveDraft: Record<string, unknown> = {};
    if (record.kind === 'logistics' && name !== 'handover') {
      nextData = { ...data, handovers: record.data.handovers };
      preserveDraft = { handovers: data.handovers };
    }
    if (record.kind === 'customs') {
      const saved = record.data as unknown as CustomsData, draft = data as unknown as CustomsData;
      nextData = { ...data, customsResult: name === 'record-customs' ? draft.customsResult : saved.customsResult, filing9810Result: name === 'record-9810' ? draft.filing9810Result : saved.filing9810Result };
      preserveResults = { ...(name !== 'record-customs' ? { customsResult: draft.customsResult } : {}), ...(name !== 'record-9810' ? { filing9810Result: draft.filing9810Result } : {}) };
    }
    if (record.kind === 'logistics' && name === 'submit') { nextData = { ...nextData, submission: (data as unknown as LogisticsData).submission ?? { exportId: record.source.exportId, fileSha256: record.source.fileSha256, submittedAt: new Date().toISOString() } }; setData({ ...data, submission: nextData.submission }); }
    if (record.kind === 'customs' && name === 'return') nextData = { ...nextData, review: null };
    if (record.kind === 'customs' && name === 'review') {
      const file = context.exports.filter((item) => item.recordId === record.id && item.purpose === 'customs-package' && item.status === 'completed' && item.valid !== false && item.fileSha256).sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))[0];
      if (!file) return;
      nextData = { ...nextData, review: { exportId: file.id, fileSha256: file.fileSha256, fingerprint: '' } };
    }
    const payload: Omit<WorkflowWrite, 'operationId'> = { expectedVersion: record.version, title, boxIds: record.boxIds, data: nextData, action: name, reason: reason.trim() || actionLabels[name] || '保存资料' };
    action.run(JSON.stringify([record.kind, record.id, payload]), (operationId) => workflowApi.write(record.kind, record.id, { ...payload, operationId }), name === 'save' ? '草稿已保存。未登记的外部结果请单独提交。' : '操作已登记，请查看当前状态和待办。', (value) => { const next = value as WorkflowRecord; setRecord(next); setData({ ...next.data, ...preserveResults, ...preserveDraft }); setTitle(next.title); });
  };
  const reload = async () => { setRefreshing(true); setReloadError(''); try { const latest = await workflowApi.detail(record.kind, record.id); setRecord(latest.record); action.reset(); await refresh(); } catch (error) { setReloadError(messageOf(error)); } finally { setRefreshing(false); } };
  const currentExports = context.exports.filter((item) => item.recordId === record.id);
  const hasReviewFile = currentExports.some((item) => item.purpose === 'customs-package' && item.status === 'completed' && item.fileSha256 && item.valid !== false);
  const groups = [...new Map(record.source.members.map((member) => [member.source.groupId, { value: member.source.groupId, label: `${member.demand.snapshot.subBatchName || member.demand.snapshot.fba} · ${member.demand.snapshot.country}` }])).values()];
  const form = (): ReactNode => {
    const shared = { boxes, context };
    if (record.kind === 'fulfillment') return <FulfillmentForm data={data as unknown as FulfillmentData} change={update} boxes={boxes} files={context.files} />;
    if (record.kind === 'logistics') return <LogisticsForm {...shared} data={data as unknown as LogisticsData} change={update} recordAction={save} />;
    if (record.kind === 'customs') return <CustomsForm {...shared} data={data as unknown as CustomsData} change={update} recordResult={save} />;
    if (record.kind === 'finance') return <FinanceForm {...shared} data={data as unknown as FinanceData} change={update} recordId={record.id} importedFile={() => void refresh()} />;
    return <ArchiveForm data={data as unknown as ArchiveData} change={update} context={context} groups={groups} />;
  };
  return <div className="workflow-editor">
    <div className="workflow-summary"><strong>{record.title}</strong><Status status={detail.record.version === record.version ? detail.record.status : record.status} /><span>{record.boxIds.length} 箱 · 已保存 v{record.version}{dirty ? ' · 有未保存修改' : ''}</span></div>
    {!context.sourceValid && <p className="form-note error-note" role="alert"><CircleAlert size={16} aria-hidden="true" />{context.sourceInvalidReason || '来源已变化，请核对当前资料。已发生的外部结果继续保留。'}</p>}
    <nav className="workflow-steps" aria-label="处理步骤">{([{ value: 'source', title: '来源与范围' }, { value: 'details', title: '业务资料' }, { value: 'checks', title: '检查与处理' }, { value: 'files', title: '附件与历史' }] as const).map((item) => <button type="button" key={item.value} aria-current={stage === item.value ? 'step' : undefined} onClick={() => setStage(item.value)}>{item.title}</button>)}</nav>
    <fieldset className="workflow-fieldset" disabled={action.busy || disabled}>
    {stage === 'source' && <><Section title="来源单据"><p>{record.source.title} · 复核版本 v{record.source.documentVersion}</p><p className="mapping-help">{record.source.shippingRunMonth ? `${record.source.shippingRunMonth} 第 ${record.source.shippingRunSequence ?? '待分配'} 次发货` : '未关联发货次'} · 来源更新后，已发生的业务事实保留并重新检查。</p><a className="secondary-button" href={`/api/v1/document-exports/${encodeURIComponent(record.source.exportId)}/download`} download><Download size={16} aria-hidden="true" />下载已复核丰信文件</a></Section><Section title="本次处理范围"><BoxesSelection source={record.source} value={record.boxIds} change={() => { /* Saved record membership is inspected here; new grouping uses a separate record. */ }} disabled /></Section></>}
    {stage === 'details' && <><TextField label="记录名称" value={title} change={setTitle} required />{form()}</>}
    {stage === 'checks' && <><Section title="当前待办与校验">{detail.issues.length === 0 ? <p className="form-note success-note"><CircleCheck size={16} aria-hidden="true" />当前没有发现阻塞项，提交动作时仍会重新检查。</p> : <ul className="workflow-issues">{detail.issues.map((issue, index) => <li key={index} data-severity={issue.severity}>{issue.message}</li>)}</ul>}</Section><Section title="处理记录" help="检查和结果登记均使用本次表单内容。退回、取消和重开待办时请说明原因。"><TextField label="本次处理说明" value={reason} change={setReason} /><div className="workflow-operation-list">{actions[record.kind].map((name) => <Button type="button" key={name} icon={name === 'review' ? FileCheck : undefined} disabled={action.busy || (name === 'cancel' || name === 'return' || name === 'reopen') && !reason.trim() || name === 'review' && (!hasReviewFile || dirty)} onClick={() => save(name)}>{record.kind === 'finance' && name === 'confirm' ? '确认费用分摊' : record.kind === 'finance' && name === 'record_result' ? '登记费用回填结果' : actionLabels[name]}</Button>)}</div>{record.kind === 'customs' && <p className="mapping-help">复核前请在下方生成并下载七页资料；修改资料后须保存、重新生成并复核。</p>}</Section>{exportOptions[record.kind] && <Section title="生成资料文件">{dirty && <p className="mapping-help">请先保存草稿，再生成本版本的资料文件。</p>}<div className="workflow-actions">{exportOptions[record.kind]!.map((item) => <Button type="button" key={item.purpose} icon={Download} disabled={dirty || action.busy} onClick={() => action.run(JSON.stringify(['export', record.id, record.version, item.purpose]), (operationId) => workflowApi.export(record.kind, record.id, operationId, record.version, item.purpose), '生成任务已提交，请在附件与历史中下载。')}>{item.label}</Button>)}</div></Section>}</>}
    </fieldset>
    {stage === 'files' && <WorkflowFiles record={record} context={context} history={detail.history} busy={action.busy} uploaded={() => void refresh()} />}
    {action.feedback}{reloadError && <p className="form-note error-note" role="alert">{reloadError} 填写内容已保留，可再次读取。</p>}{action.conflict && <Button type="button" icon={RefreshCw} loading={refreshing} onClick={() => void reload()}>读取最新版本并保留填写内容</Button>}
    <footer className="workflow-editor-footer"><Button type="button" variant="primary" icon={Save} loading={action.busy} loadingLabel="正在保存…" disabled={disabled || !dirty} onClick={() => save('save')}>保存草稿</Button><span className="mapping-help">{dirty ? '修改尚未保存' : '已保存的资料可继续处理'}</span>{stage !== 'checks' && <Button type="button" onClick={() => setStage('checks')}>查看检查与处理</Button>}</footer>
    <ImportDialog open={active && (confirmClose || blocker.status === 'blocked')} title="保留未保存修改" close={() => { setConfirmClose(false); if (blocker.status === 'blocked') blocker.reset(); }}><p>当前有未保存内容。可返回保存，或放弃本次修改后离开。</p><div className="workflow-actions"><Button type="button" variant="primary" onClick={() => { setConfirmClose(false); if (blocker.status === 'blocked') blocker.reset(); }}>返回继续编辑</Button><Button type="button" onClick={() => { setConfirmClose(false); if (blocker.status === 'blocked') blocker.proceed(); else close(); }}>放弃未保存修改</Button></div></ImportDialog>
  </div>;
}

function WorkflowFiles({ record, context, history, busy, uploaded }: { record: WorkflowRecord; context: WorkflowContext; history: WorkflowDetail['history']; busy: boolean; uploaded: () => void }) {
  const action = useWorkflowAction();
  const [purpose, setPurpose] = useState('evidence'), [file, setFile] = useState<File | null>(null);
  const files = context.files.filter((item) => item.recordId === record.id), exports = context.exports.filter((item) => item.recordId === record.id);
  return <><Section title="上传业务凭据" help="上传后返回业务资料，选择对应附件。原始文件及文件校验信息会留档。"><div className="workflow-fields"><ChoiceField label="附件用途" value={purpose} change={setPurpose} options={[{ value: 'evidence', label: '核对凭据' }, { value: 'label', label: '原始箱唛' }, { value: 'receipt', label: '接单回执' }, { value: 'handover', label: '交接凭据' }, { value: 'lingxing', label: '领星操作结果' }, { value: 'bill', label: '原始账单' }, { value: 'feedback', label: '报关 / 9810 反馈' }, { value: 'template', label: '七页报关模板 XLSX' }]} /><div className="field"><label htmlFor={`workflow-upload-${record.id}`}>业务附件</label><input id={`workflow-upload-${record.id}`} type="file" disabled={busy || action.busy || record.status === 'cancelled'} onChange={(event) => { setFile(event.target.files?.[0] ?? null); action.reset(); }} /></div></div><Button type="button" icon={Upload} loading={action.busy} disabled={!file || busy || record.status === 'cancelled'} onClick={() => { if (file) action.run(JSON.stringify(['upload', record.id, purpose, file.name, file.size, file.lastModified]), (operationId) => workflowApi.upload(record.id, purpose, operationId, file), '附件已上传，可回到业务资料选择。', () => { setFile(null); uploaded(); }); }}>上传附件</Button>{action.feedback}</Section>
  <Section title="已上传附件">{files.length === 0 ? <p className="mapping-help">尚未上传附件。</p> : <BatchTable label="业务附件" headers={['文件', '大小', '下载']}>{files.map((item) => <tr key={item.id}><td>{item.name}</td><td>{Math.ceil(item.byteSize / 1024)} KB</td><td><a href={workflowApi.fileUrl(item.id)} download className="secondary-button"><Download size={16} aria-hidden="true" />下载附件</a></td></tr>)}</BatchTable>}</Section>
  <Section title="生成文件">{exports.length === 0 ? <p className="mapping-help">尚无生成文件，请前往“检查与处理”生成。</p> : <BatchTable label="生成文件" headers={['文件 / 版本', '生成状态', '下载']}>{exports.map((item) => <tr key={item.id}><td>{item.name ?? '资料文件'}<small className="mapping-subtext">v{item.version} · {timestamp(item.createdAt)}</small></td><td><Status status={item.status === 'completed' && item.valid === false ? 'stale' : item.status} />{item.invalidReason && <p className="mapping-help">{item.invalidReason}</p>}{item.error && <p className="error-note">{item.error}</p>}</td><td>{item.status === 'completed' && item.fileId ? <a href={workflowApi.exportUrl(item.id)} download className="secondary-button"><Download size={16} aria-hidden="true" />下载文件</a> : '—'}</td></tr>)}</BatchTable>}</Section>
  <Section title="操作与结果历史" action={<History size={18} aria-hidden="true" />}><ol className="workflow-history">{history.map((entry) => <li key={entry.id}><div><strong>{actionLabels[entry.action] ?? '业务处理'}</strong><Status status={entry.record.status} /></div><p>{entry.reason}</p><small>{timestamp(entry.createdAt)} · v{entry.version} · {entry.createdBy}</small><details><summary>查看此版本结果</summary><HistoryFacts record={entry.record} /></details></li>)}</ol></Section></>;
}
function HistoryFacts({ record }: { record: WorkflowRecord }) {
  if (record.kind === 'fulfillment') { const value = record.data as unknown as FulfillmentData; return <ul>{value.externalOrders.map((order, i) => <li key={i}>{order.externalOrderNo} · {order.warehouseCode} · {({ allocated: '已分配', shortage: '缺货', unknown: '待核对', cancelled: '已取消' })[order.status]} · {order.lines.reduce((sum, line) => sum + Number(line.quantity), 0)} 件</li>)}</ul>; }
  if (record.kind === 'logistics') { const value = record.data as unknown as LogisticsData; return <p>物流单 {value.logisticsOrderNo || '未填'} · 跟踪号 {value.trackingNo || '未填'} · {value.handovers.length} 次交接 / {value.handovers.flatMap((item) => item.boxIds).length} 箱</p>; }
  if (record.kind === 'customs') { const value = record.data as unknown as CustomsData; return <p>报关：{value.customsResult.externalNumber || '未填外部编号'} · 9810：{value.filing9810Result.externalNumber || '未填外部编号'} · {value.entity} / {value.currency}</p>; }
  if (record.kind === 'finance') { const value = record.data as unknown as FinanceData; return <p>账单 {value.billNumber || '未填'} · {value.lines.length} 条费用 / {value.externalResults.length} 条回填结果</p>; }
  return <p>{(record.data as unknown as ArchiveData).note || '批次条件与归档记录已留存。'}</p>;
}
