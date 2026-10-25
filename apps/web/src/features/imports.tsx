import type { SourceImport } from '@scm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useBlocker, useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Download, Eye, FilePenLine, History, RefreshCw, Save, Upload } from 'lucide-react';
import { api, ApiError, type User } from '../api';
import { Button, IconButton, IconLink } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { AppShell, StatePage } from '../pages';
import { ImportConfirmation } from './import-confirmation';
import { ImportDialog } from './import-dialog';
import { ImportWorkspace } from './import-workspace';
import { ErrorFeedback, ImportBadge, isBusy, IssueList, messageOf, operationId, Pagination, ParseControls, RunHistoryItem, SourceRows, timestamp } from './import-source';
import { ImportWizard, type ImportWizardDraftHandle, type ImportWizardProgress, type ImportWizardStep } from './import-wizard';
import { ShippingLayout } from './shipping-layout';
import { ImportDrafts } from './import-drafts';
import { importDraftApi, type ImportDraft, type ImportDraftContent, type SaveImportDraftInput } from './import-draft-api';
import { DemandBatchAssignment, readDemandAssignment, type DemandAssignment } from './demand-batch-assignment';
import { ShippingRunsWorkspace } from './shipping-runs';

const blankProgress = (): ImportWizardProgress => ({ importId: null, source: 'online', step: 2 });
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function draftFile(value: ImportDraftContent['file']): File | undefined {
  if (!value) return undefined;
  const bytes = Uint8Array.from(atob(value.base64), (char) => char.charCodeAt(0));
  return new File([bytes], value.name, { type: value.type, lastModified: value.lastModified });
}

export function ImportsRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  const { importId } = useParams({ strict: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开需求导入" detail={messageOf(session.error)} action={<Button type="button" icon={RefreshCw} loading={session.isFetching} onClick={() => void session.refetch()}>重试</Button>} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  if (session.data.user.role !== 'admin') return <ShippingLayout user={session.data.user} view="demands"><section className="content-panel" aria-labelledby="import-forbidden-title"><div className="section-heading panel-heading"><div><h2 id="import-forbidden-title">当前账号没有需求导入权限</h2><p>请重新登录管理员账号。</p></div></div></section></ShippingLayout>;
  return <ShippingLayout user={session.data.user} view="demands"><ImportsPage user={session.data.user} importId={importId} embedded /></ShippingLayout>;
}

export type ImportsPageProps = {
  user: User; importId?: string; embedded?: boolean; active?: boolean; workspaceActive?: boolean;
  onArrangeDemands?: (demandIds: string[], mode: 'create' | 'append') => void;
  renderWorkspace?: (actions: { openRecords: () => void; openDrafts: () => void }) => ReactNode;
};
export function ImportsPage({ user, importId, embedded = false, active = true, workspaceActive = active, onArrangeDemands, renderWorkspace }: ImportsPageProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const search = useSearch({ strict: false });
  const storageKey = `scm-import-wizard:${user.id}`;
  const [boot] = useState(() => {
    const explicit = location.pathname === '/imports/new';
    const linked = explicit && 'importId' in search && uuid(search.importId);
    const progress: ImportWizardProgress = linked
      ? { importId: search.importId as string, source: null, step: 'step' in search ? search.step as ImportWizardStep : undefined }
      : blankProgress();
    return { token: operationId(), progress, open: explicit };
  });
  const [wizard, setWizard] = useState<{ token: string; initial: ImportWizardProgress; content?: ImportDraftContent; file?: File }>({ token: boot.token, initial: boot.progress });
  const [importOpen, setImportOpen] = useState(boot.open);
  const [assignment, setAssignment] = useState<DemandAssignment | null>(() => onArrangeDemands ? null : readDemandAssignment(user.id));
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftRecord, setDraftRecord] = useState<ImportDraft | null>(null);
  const [draftStatus, setDraftStatus] = useState({ hasContent: false, busy: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [saveAsNew, setSaveAsNew] = useState(false);
  const pendingSave = useRef<{ id: string; input: SaveImportDraftInput } | null>(null);
  const needsSaveReplay = useRef(false);
  const exitAfterSave = useRef<(() => void) | null>(null);
  const draftHandle = useRef<ImportWizardDraftHandle | null>(null);
  const onDraftState = useCallback((hasContent: boolean, busy: boolean) => setDraftStatus((old) => old.hasContent === hasContent && old.busy === busy ? old : { hasContent, busy }), []);
  const current = useRef({ token: boot.token, progress: boot.progress, open: boot.open });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canManage = user.role === 'admin';
  const clear = () => { current.current.open = false; setImportOpen(false); setSaveOpen(false); setDraftStatus({ hasContent: false, busy: false }); draftHandle.current = null; };
  const requestExit = (after: () => void) => {
    if (saving || draftHandle.current?.busy) return;
    if (needsSaveReplay.current && pendingSave.current) { exitAfterSave.current = after; setSaveOpen(true); return; }
    if (draftHandle.current?.hasContent) { exitAfterSave.current = after; setDraftTitle(draftRecord?.title ?? '未完成的需求导入'); setSaveError(''); setSaveAsNew(false); pendingSave.current = null; setSaveOpen(true); }
    else after();
  };
  const close = () => requestExit(clear);
  const start = (progress: ImportWizardProgress, draft?: ImportDraft) => {
    const token = operationId();
    current.current = { token, progress, open: true };
    if (draft?.content.confirmation && progress.importId) { try { sessionStorage.setItem(`${storageKey}:${progress.importId}`, JSON.stringify(draft.content.confirmation)); } catch { /* The saved confirmation is also passed directly to the wizard. */ } }
    setWizard({ token, initial: progress, content: draft?.content, file: draftFile(draft?.content.file) }); setImportOpen(true); setRecordsOpen(false); setDraftsOpen(false); setDraftRecord(draft ?? null); setDraftTitle(draft?.title ?? ''); setSaveError(''); setNotice(''); setSaveAsNew(false); pendingSave.current = null; draftHandle.current = null; setDraftStatus({ hasContent: false, busy: false });
  };
  const openNewDemand = () => requestExit(() => start(blankProgress()));
  const resume = (id: string) => {
    start({ importId: id, source: null });
  };
  const checkpoint = (progress: ImportWizardProgress) => {
    // Discard callbacks from an older wizard session after starting a new one.
    if (!mounted.current || current.current.token !== wizard.token) return;
    current.current.progress = progress;
  };
  const viewDetail = (id: string) => requestExit(() => { clear(); void navigate({ to: '/imports/$importId', params: { importId: id } }); });
  const finish = () => {
    clear();
    void queryClient.invalidateQueries({ queryKey: ['demands'] });
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    void queryClient.invalidateQueries({ queryKey: ['imports'] });
    void navigate({ to: '/shipping', search: { view: 'demands' } });
  };
  const arrange = (demandIds: string[], mode: 'create' | 'append') => {
    clear();
    void queryClient.invalidateQueries({ queryKey: ['demands'] });
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    if (onArrangeDemands) onArrangeDemands(demandIds, mode);
    else setAssignment({ demandIds, mode });
  };
  const blocker = useBlocker({ shouldBlockFn: () => current.current.open && (draftStatus.hasContent || draftStatus.busy || saving), enableBeforeUnload: importOpen && draftStatus.hasContent, withResolver: true });
  useEffect(() => {
    if (blocker.status !== 'blocked') return;
    exitAfterSave.current = () => { clear(); blocker.proceed(); };
    setDraftTitle(draftRecord?.title ?? '未完成的需求导入'); setSaveError(''); setSaveAsNew(false); setSaveOpen(true);
  }, [blocker.status, blocker.proceed, draftRecord?.title]);
  const cancelExit = () => { if (saving || needsSaveReplay.current) return; setSaveOpen(false); exitAfterSave.current = null; pendingSave.current = null; if (blocker.status === 'blocked') blocker.reset(); };
  const saveDraft = async () => {
    if (!draftHandle.current || draftHandle.current.busy || saving || !draftTitle.trim()) return;
    setSaving(true); setSaveError('');
    try {
      const pending = pendingSave.current ?? { id: !saveAsNew && draftRecord ? draftRecord.id : operationId(), input: { title: draftTitle.trim(), expectedVersion: !saveAsNew && draftRecord ? draftRecord.version : 0, content: await draftHandle.current.content() } };
      pendingSave.current = pending;
      const result = await importDraftApi.save(pending.id, pending.input);
      setDraftRecord(result.draft); pendingSave.current = null; needsSaveReplay.current = false; setSaveOpen(false); setNotice('已保存到草稿箱。再次导入将从空白开始。');
      void queryClient.invalidateQueries({ queryKey: ['import-drafts'] });
      const after = exitAfterSave.current; exitAfterSave.current = null; clear(); after?.();
    } catch (error) { setSaveError(messageOf(error)); needsSaveReplay.current = error instanceof ApiError && (error.status === 0 || error.status >= 500); if (!needsSaveReplay.current) pendingSave.current = null; if (error instanceof ApiError && (error.status === 409 || error.status === 404 && Boolean(draftRecord))) setSaveAsNew(true); }
    finally { setSaving(false); }
  };
  const Heading = embedded ? 'h2' : 'h1';
  const content = <div className="content-width import-workspace" hidden={!workspaceActive}>
      {(!renderWorkspace || importId) && <div className="import-page-heading"><div><Heading id="imports-title">{importId ? '导入核对' : '需求与批次'}</Heading><p className="mapping-help">{importId ? '查看来源、解析版本与提交记录，或打开向导继续核对。' : '导入并提交需求，选择货件安排批次，再继续同步、核对和导出。'}</p></div>
        {importId && <Link to="/shipping" search={{ view: 'demands' }} className="secondary-button"><ArrowLeft size={18} aria-hidden="true" />返回需求列表</Link>}
      </div>}
      {notice && <p className="permission-note success-note" role="status">{notice}</p>}
      {!importId && <ShippingRunsWorkspace active={active && workspaceActive} onCreate={openNewDemand} />}
      {!importId ? renderWorkspace ? renderWorkspace({ openRecords: () => setRecordsOpen(true), openDrafts: () => setDraftsOpen(true) }) : <ImportWorkspace active={active} openRecords={() => setRecordsOpen(true)} openDrafts={() => setDraftsOpen(true)} onArrangeDemands={arrange} /> : <div className="import-workspace-actions"><Button type="button" icon={ArrowRight} variant="primary" onClick={() => resume(importId)}>继续导入</Button><Button type="button" icon={Upload} onClick={openNewDemand}>导入本次发货</Button><Button type="button" icon={FilePenLine} onClick={() => setDraftsOpen(true)}>草稿箱</Button><Button type="button" icon={History} onClick={() => setRecordsOpen(true)}>导入记录</Button></div>}
      {importId && <ImportDetail key={importId} id={importId} canManage={canManage} active={active} />}
      <ImportDialog open={active && importOpen} title="导入向导" close={() => { if (active) close(); }} closeDisabled={draftStatus.busy || saving} wide>
        {importOpen && <><div className="import-draft-save-bar"><p className="mapping-help">{draftRecord ? `正在编辑草稿：${draftRecord.title}` : '新建导入从空白开始，未完成内容可保存到草稿箱。'}</p><Button type="button" icon={Save} disabled={!draftStatus.hasContent || draftStatus.busy || saving} onClick={() => requestExit(clear)}>保存到草稿箱</Button></div><ImportWizard key={wizard.token} initial={wizard.initial} initialDraft={wizard.content} initialFile={wizard.file} draftHandle={draftHandle} onDraftState={onDraftState} active={active && importOpen} canManage={canManage} storageKey={storageKey} checkpoint={checkpoint} finish={finish} startNew={() => requestExit(() => start(blankProgress()))} viewDetail={viewDetail} onArrangeDemands={arrange} /></>}
      </ImportDialog>
      {!onArrangeDemands && assignment && <DemandBatchAssignment open={active} userId={user.id} {...assignment} onClose={() => setAssignment(null)} onComplete={() => { void queryClient.invalidateQueries({ queryKey: ['demands'] }); void queryClient.invalidateQueries({ queryKey: ['batches'] }); }} onOpenGroup={(batchId, groupId) => { setAssignment(null); void navigate({ to: '/batches/$batchId', params: { batchId }, search: { groupId, wizard: 'process' } }); }} />}
      <ImportDialog open={active && recordsOpen} title="导入记录" close={() => { if (active) setRecordsOpen(false); }} wide><ImportRecords active={active && recordsOpen} importId={importId} openRecord={() => setRecordsOpen(false)} resume={resume} /></ImportDialog>
      <ImportDialog open={active && draftsOpen} title="草稿箱" close={() => setDraftsOpen(false)} wide><ImportDrafts active={active && draftsOpen} openDraft={(draft) => start(draft.content.progress, draft)} /></ImportDialog>
      <ImportDialog open={active && saveOpen} title="保存到草稿箱？" close={cancelExit}>
        <p className="mapping-help">保存后可从草稿箱继续编辑。选择不保存将放弃本次填写；已接收的导入记录仍会保留。</p>
        <div className="field"><label htmlFor="import-draft-title">草稿名称</label><Input id="import-draft-title" value={draftTitle} maxLength={120} disabled={saving || Boolean(pendingSave.current)} onChange={(event) => setDraftTitle(event.target.value)} /></div>
        {saveError && <p className="form-note error-note" role="alert">{saveError} {saveAsNew ? '原草稿已变化，可另存为新草稿以保留本次输入。' : '当前内容已保留，可重试保存或继续填写。'}</p>}
        {needsSaveReplay.current && <p className="mapping-help" role="status">保存结果尚未确认，请先重试原保存。系统会复用相同草稿编号和内容，避免重复保存。</p>}
        {draftStatus.busy && <p className="mapping-help" role="status">正在处理当前请求，完成后可保存或退出。</p>}
        <div className="import-selection-actions"><Button type="button" onClick={cancelExit} disabled={saving || needsSaveReplay.current}>继续填写</Button><Button type="button" disabled={saving || draftStatus.busy || needsSaveReplay.current} onClick={() => { const after = exitAfterSave.current; exitAfterSave.current = null; pendingSave.current = null; clear(); after?.(); }}>不保存，退出</Button><Button type="button" variant="primary" icon={Save} loading={saving} disabled={!draftTitle.trim() || draftStatus.busy} onClick={() => void saveDraft()}>{needsSaveReplay.current ? '重试原草稿保存' : saveAsNew ? '另存新草稿并退出' : '保存草稿并退出'}</Button></div>
      </ImportDialog>
    </div>;
  return embedded ? content : <AppShell user={user} title="需求导入">{content}</AppShell>;
}

function ImportRecords({ active, importId, openRecord, resume }: { active: boolean; importId?: string; openRecord: () => void; resume: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['imports', page], queryFn: () => api.imports(page, 10), retry: false, enabled: active,
    refetchInterval: (query) => active && query.state.data?.items.some(isBusy) ? 1_500 : false,
  });
  useEffect(() => {
    if (list.error instanceof ApiError && list.error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] });
  }, [list.error, queryClient]);
  return <section aria-labelledby="import-list-title">
        <div className="section-heading panel-heading"><div><h3 id="import-list-title">全部导入</h3><p>包括表格文件和在线填写记录，可返回详情继续核对。</p></div><IconButton type="button" icon={RefreshCw} label="刷新记录" loading={list.isFetching} onClick={() => void list.refetch()} /></div>
        {list.isPending ? <p className="list-state" role="status">正在读取导入记录…</p> : list.isError ? <ErrorFeedback title="导入记录暂时不可用" error={list.error} retry={() => void list.refetch()} /> : list.data.items.length === 0 ? <p className="list-state">尚无导入记录。上传 .xlsx 工作簿后可查看解析进度和源行。</p> : <>
          <div className="table-scroll" role="region" aria-label="导入记录表，可横向滚动" tabIndex={0}><div className="table-inner"><table className="task-table import-list-table"><thead><tr><th scope="col">原文件 / 在线表格</th><th scope="col">首次导入日期</th><th scope="col">解析 / 提交状态</th><th scope="col">接收时间（上海）</th><th scope="col">操作</th></tr></thead><tbody>{list.data.items.map((record) => <tr key={record.id} aria-current={record.id === importId ? 'true' : undefined}><td><strong>{record.originalName}</strong><small className="mapping-subtext">{record.sourceType === 'online' ? '在线填写' : '表格文件'} · {(record.byteSize / 1024).toFixed(1)} KB</small></td><td>{record.businessDate}</td><td><ImportBadge record={record} /><small className="mapping-subtext">版本 {record.version}{record.submissionStatus ? ` · ${({ not_submitted: '尚未提交', partially_submitted: '部分提交', submitted: '有效项已提交' } as const)[record.submissionStatus]}` : ''}</small>{record.submittedSourceRows !== undefined && <small className="mapping-subtext">已提交 {record.submittedSourceRows} 条源行</small>}</td><td className="time-cell">{timestamp(record.importedAt)}</td><td><div className="import-record-actions"><Button type="button" icon={ArrowRight} onClick={() => resume(record.id)}>继续导入</Button><IconLink className="import-detail-link" icon={Eye} label="查看源行" description={record.originalName} to="/imports/$importId" params={{ importId: record.id }} onClick={openRecord} /></div></td></tr>)}</tbody></table></div></div>
          <Pagination page={page} pageSize={10} total={list.data.total} pending={list.isFetching} change={setPage} />
        </>}
      </section>
}

function ImportDetail({ id, canManage, active }: { id: string; canManage: boolean; active: boolean }) {
  const queryClient = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const detail = useQuery({ queryKey: ['import', id], queryFn: () => api.sourceImport(id), enabled: active, retry: false, refetchInterval: (query) => active && query.state.data && isBusy(query.state.data) ? 1_500 : false });
  useEffect(() => { if (!active) return; const frame = window.requestAnimationFrame(() => heading.current?.focus()); return () => window.cancelAnimationFrame(frame); }, [active]);
  useEffect(() => { if (detail.error instanceof ApiError && detail.error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] }); }, [detail.error, queryClient]);
  return <section className="content-panel import-detail" aria-labelledby="import-detail-title">
    <div className="section-heading panel-heading"><div><h2 id="import-detail-title" ref={heading} tabIndex={-1}>文件解析详情</h2><p>预览仅供核对；店铺别名、数量含义及真实更正仍需业务确认。</p></div><IconButton type="button" icon={RefreshCw} label="刷新详情" loading={detail.isFetching} onClick={() => void detail.refetch()} /></div>
    {detail.isPending ? <p className="list-state" role="status">正在读取文件及解析结果…</p> : detail.isError ? <ErrorFeedback title="无法读取导入详情" error={detail.error} retry={() => void detail.refetch()} /> : <ImportContent record={detail.data} canManage={canManage} active={active} />}
  </section>;
}

function ImportContent({ record, canManage, active }: { record: SourceImport; canManage: boolean; active: boolean }) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ['import-runs', record.id, record.version], queryFn: () => api.importRuns(record.id), enabled: active, retry: false,
    refetchInterval: (query) => active && (isBusy(record) || query.state.data?.some((item) => item.status === 'queued' || item.status === 'running')) ? 1_500 : false,
  });
  const run = selectedRunId ? history.data?.find((item) => item.id === selectedRunId) ?? record.latestRun : record.latestRun;
  const isHistorical = run && run.id !== record.latestRun?.id;
  const download = useMutation({
    networkMode: 'always', mutationFn: () => api.downloadImportSource(record.fileId),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = record.originalName;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    onError: (error) => { if (error instanceof ApiError && error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] }); },
  });
  useEffect(() => { if (history.error instanceof ApiError && history.error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] }); }, [history.error, queryClient]);
  return <>
    <div className="import-file-heading"><strong>{record.originalName}</strong><ImportBadge record={record} /><Button type="button" variant="text" icon={Download} loading={download.isPending} loadingLabel="正在读取原文件…" onClick={() => download.mutate()}>下载原文件</Button></div>
    {download.isError && <p className="form-note error-note" role="alert">{messageOf(download.error)}</p>}
    <dl className="mapping-evidence import-evidence"><div><dt>固定业务日期（上海）</dt><dd>{record.businessDate}</dd></div><div><dt>文件接收时间</dt><dd>{timestamp(record.importedAt)}（上海时间）</dd></div><div><dt>源文件 SHA-256</dt><dd><code>{record.sha256}</code></dd></div><div><dt>解析版本</dt><dd>预览版本 {record.version}{run ? ` · ${run.parserVersion} · ${run.mappingVersion ?? '尚未选择映射'}` : ''}</dd></div></dl>
    {isBusy(record) && <p className="permission-note" role="status">{record.status === 'queued' ? '文件已保存，正在等待 Worker 解析。' : record.latestRun ? `正在解析，已处理 ${record.latestRun.processedRows} 行。` : '正在解析工作簿，等待进度更新。'} 进度会自动刷新。</p>}
    {record.latestRun?.status === 'failed' && <div className="inline-error" role="alert"><div><strong>本次解析失败</strong><p>{record.latestRun.errorMessage ?? '解析未完成，请刷新查看任务结果。'}{record.latestRun.errorCode ? `（${record.latestRun.errorCode}）` : ''}</p><p>原文件和业务日期已保留，可在修正映射后重新解析。</p></div></div>}
    {run && run.issues.length > 0 && <IssueList issues={run.issues} />}
    {(record.sheets.length > 0 || record.status === 'failed') && <ParseControls key={`${record.id}:${record.version}`} record={record} canManage={canManage} />}
    <div className="import-run-history"><div className="section-heading"><h3>解析版本记录</h3><IconButton type="button" icon={RefreshCw} label="刷新版本" loading={history.isFetching} onClick={() => void history.refetch()} /></div>{history.isPending ? <p className="list-state" role="status">正在读取解析版本…</p> : history.isError ? <ErrorFeedback title="解析版本暂时不可用" error={history.error} retry={() => void history.refetch()} /> : <ol>{history.data.map((item) => <RunHistoryItem key={item.id} run={item} current={item.id === record.latestRun?.id} selected={item.id === run?.id} choose={() => setSelectedRunId(item.id === record.latestRun?.id ? null : item.id)} />)}</ol>}</div>
    {isHistorical && <p className="permission-note" role="status">当前查看历史解析版本 {run.inputVersion}。原始源行按该版本保留；重新解析始终基于文件的最新版本。</p>}
    {run?.status === 'completed' && <>
      <div className="import-counts" aria-label="本次解析统计"><div><span>保留源行</span><strong>{run.counts.totalRows}</strong></div><div><span>有效 FBA 行</span><strong>{run.counts.validFbaRows}</strong></div><div><span>需核对行</span><strong>{run.counts.warningRows}</strong></div><div><span>错误行</span><strong>{run.counts.errorRows}</strong></div></div>
      <p className="mapping-help">已完成解析，请在下方核对并确认业务需求。源表中未出现的记录不会被自动撤销。</p>
      <SourceRows key={run.id} record={record} runId={run.id} />
      <ImportConfirmation key={`${record.id}:${run.id}`} record={record} run={run} historical={Boolean(isHistorical)} canManage={canManage} />
    </>}
  </>;
}
