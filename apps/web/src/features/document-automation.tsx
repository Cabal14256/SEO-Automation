import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleCheck, Download, LoaderCircle, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { DocumentAutomationDeleteResponse, DocumentAutomationJob } from '@scm/contracts';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { BatchTable, downloadBlob, messageOf, newOperation, QueryError, timestamp } from './batch-shared';
import { documentApi } from './document-api';
import { documentAutomationApi } from './document-automation-api';
import { DocumentAutomationDeleteDialog } from './document-automation-delete';
import { scrollDocumentFieldIntoView } from './document-details-navigation';
import { ImportDialog } from './import-dialog';
import { DocumentAutomationSupplement, type AutomationFormState } from './document-automation-supplement';
import './document-automation.css';

export const automationRunning = (job: DocumentAutomationJob) => job.mode === 'single_workbook' ? ['preparing', 'ready', 'generating'].includes(job.phase) : ['queued', 'running'].includes(job.status);
const phaseLabels: Record<string, string> = { preparing: '正在统一检查', needs_input: '待统一补充资料', ready: '整批检查通过', generating: '正在生成发票压缩包', completed: '发票文件已生成', failed: '处理未完成' };
const statusLabels: Record<string, string> = { queued: '等待处理', running: '自动处理中', completed: '已生成', partial: '部分已生成', blocked: '待补充资料', failed: '处理失败', exporting: '正在生成文件' };
const stageLabels: Record<string, string> = { create: '建立单据', preview: '读取领星资料', apply: '采用领星资料', prepare: '补齐出单资料', validate: '校验出单内容', ready: '检查通过，等待整批生成', export: '生成发票', done: '文件已生成' };
const isLegacyWorkbook = (job: DocumentAutomationJob) => Boolean(job.bundle?.fileName?.toLowerCase().endsWith('.xlsx'));
const bundleSummary = (job: DocumentAutomationJob) => isLegacyWorkbook(job) ? `1 份 XLSX · ${job.bundle?.sheetCount ?? 0} 个工作表` : `1 份 ZIP · ${job.bundle?.fileCount ?? job.counts.completed} 个 Excel 文件`;

/** Open the conflicting task without creating or retrying any business operation. */
export function useAutomationResume(error: unknown, open: (job: DocumentAutomationJob) => void, { preserveDraft = false, active = true }: { preserveDraft?: boolean; active?: boolean } = {}) {
  const busyConflict = error instanceof ApiError && error.status === 409 && error.code === 'DOCUMENT_AUTOMATION_BUSY';
  const details = busyConflict ? error.details : null;
  const candidate = details && typeof details === 'object' && 'jobId' in details ? details.jobId : undefined;
  const jobId = typeof candidate === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
  const generation = useRef(0);
  const feedback = useRef<HTMLDivElement>(null);
  const currentJobId = useRef(jobId); currentJobId.current = active ? jobId : null;
  const mutation = useMutation({ networkMode: 'always', mutationFn: ({ id }: { id: string; generation: number }) => documentAutomationApi.get(id),
    onSuccess: ({ job }, input) => { if (currentJobId.current === input.id && generation.current === input.generation) open(job); } });
  const reset = mutation.reset;
  useEffect(() => {
    currentJobId.current = active ? jobId : null; reset();
    return () => { generation.current += 1; currentJobId.current = null; };
  }, [active, jobId, reset]);
  useEffect(() => {
    if (!active || !busyConflict) return;
    const frame = requestAnimationFrame(() => {
      const node = feedback.current;
      if (node) { node.focus({ preventScroll: true }); scrollDocumentFieldIntoView(node); }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, busyConflict, jobId]);
  return { busy: mutation.isPending, feedback: busyConflict && active && <div ref={feedback} role="group" aria-label="继续已有自动出单任务" tabIndex={-1} className="document-footer-actions">
    <p className="mapping-help">{jobId ? '已有任务可能只包含部分所选 FBA，请打开后核对任务范围。' : '请在“自动出单任务”列表中查看已有任务，当前填写已保留。'}{preserveDraft && jobId && '本次填写保留在“继续本次制作”中。'}</p>
    {jobId && <Button type="button" icon={ArrowRight} loading={mutation.isPending} onClick={() => mutation.mutate({ id: jobId, generation: generation.current })}>继续已有任务</Button>}
    {mutation.error && <p className="form-note error-note" role="alert">{messageOf(mutation.error)} 当前填写已保留，可重试读取已有任务。</p>}
  </div> };
}

/** Preserve the exact retry request when a response is lost. */
export function useAutomationRetry() {
  const requests = useRef(new Map<string, { operationId: string; expectedVersion: number; itemIds?: string[] }>());
  const inFlight = useRef<Promise<DocumentAutomationJob> | null>(null);
  const client = useQueryClient();
  const mutation = useMutation({ networkMode: 'always', mutationFn: async ({ jobId, itemIds, key }: { jobId: string; itemIds?: string[]; key: string }) => {
    let input = requests.current.get(key);
    if (!input) {
      const { job } = await documentAutomationApi.get(jobId);
      input = { operationId: newOperation(), expectedVersion: job.version, ...(itemIds ? { itemIds } : {}) }; requests.current.set(key, input);
    }
    try {
      const result = await documentAutomationApi.retry(jobId, input);
      requests.current.delete(key); return result.job;
    } catch (error) {
      // A rejected version was not accepted. The next explicit retry reads it again.
      if (error instanceof ApiError && error.status === 409 && /VERSION_CONFLICT/.test(error.code ?? '')) requests.current.delete(key);
      throw error;
    }
  }, onSuccess: async (job) => {
    client.setQueryData(['document-automation', job.id], { job });
    await Promise.all([client.invalidateQueries({ queryKey: ['document-automations'] }), client.invalidateQueries({ queryKey: ['documents'] })]);
  } });
  return { run: (jobId: string, itemIds: string[] | undefined, key: string) => {
    if (inFlight.current) return inFlight.current;
    const promise = mutation.mutateAsync({ jobId, itemIds, key }); inFlight.current = promise;
    void promise.then(() => { inFlight.current = null; }, () => { inFlight.current = null; }); return promise;
  }, busy: mutation.isPending, error: mutation.error, reset: mutation.reset };
}

export function DocumentAutomationRecent({ active, open, disabled, requestDelete, deleted }: {
  active: boolean; open: (id: string) => void; disabled: boolean; requestDelete: (next: () => void) => void;
  deleted: (result: DocumentAutomationDeleteResponse) => void;
}) {
  const [deleteTarget, setDeleteTarget] = useState<DocumentAutomationJob | null>(null);
  const [notice, setNotice] = useState('');
  const jobs = useQuery({ queryKey: ['document-automations'], queryFn: () => documentAutomationApi.list(), enabled: active, retry: false,
    refetchInterval: (query) => active && !deleteTarget && query.state.data?.items.some(automationRunning) ? 2000 : false });
  const removed = (result: DocumentAutomationDeleteResponse) => {
    deleted(result); setDeleteTarget(null);
    setNotice(`自动出单任务已删除。${result.cancelledDocumentIds.length ? `已取消 ${result.cancelledDocumentIds.length} 张草稿并释放货件占用。` : ''}${result.preservedDocumentIds.length ? `已保留 ${result.preservedDocumentIds.length} 张单据及已有文件，可在“单据记录”中查询。` : ''}`);
  };
  if (!active) return null;
  return <section className="document-automation-recent" aria-label="最近自动出单任务"><div className="section-heading"><div><h3>最近任务</h3><p className="mapping-help">关闭窗口后，任务仍在后台处理。</p></div><IconButton type="button" icon={RefreshCw} label="刷新自动出单任务" disabled={jobs.isFetching || disabled || Boolean(deleteTarget)} onClick={() => void jobs.refetch()} /></div>
    {notice && <p className="form-note success-note" role="status"><CircleCheck size={16} aria-hidden="true" />{notice}</p>}
    {jobs.isPending ? <p className="list-state" role="status">正在读取自动出单任务…</p> : jobs.isError ? <QueryError error={jobs.error} retry={() => void jobs.refetch()} /> : jobs.data.items.length > 0 ? <BatchTable label="最近自动出单任务" headers={['开始时间', '状态', '整批情况', '操作']}>{jobs.data.items.map((job) => <tr key={job.id}><td>{timestamp(job.createdAt)}</td><td>{job.mode === 'single_workbook' ? phaseLabels[job.phase] : statusLabels[job.status]}</td><td>{job.mode === 'single_workbook' ? job.bundle?.status === 'completed' ? bundleSummary(job) : `${job.counts.ready + job.counts.completed} / ${job.counts.total} 组检查通过` : `${job.counts.completed} / ${job.counts.total} 票已生成`}{job.counts.blocked > 0 && <small className="mapping-subtext">{job.counts.blocked} 组待处理</small>}</td><td><div className="document-record-actions"><Button type="button" icon={ArrowRight} disabled={disabled || Boolean(deleteTarget)} onClick={() => open(job.id)}>查看进度</Button><Button type="button" icon={Trash2} variant="text" disabled={disabled || Boolean(deleteTarget)} onClick={() => requestDelete(() => { setNotice(''); setDeleteTarget(job); })}>删除任务</Button></div></td></tr>)}</BatchTable> : <p className="mapping-help">暂无自动出单任务。</p>}
    {deleteTarget && <DocumentAutomationDeleteDialog key={deleteTarget.id} active={active} job={deleteTarget} close={() => setDeleteTarget(null)} deleted={removed} />}
  </section>;
}

function DocumentAutomationLegacyDialog({ active, jobId, close, edit, view }: { active: boolean; jobId: string; close: () => void; edit: (documentId: string, itemId: string) => void; view: (documentId: string) => void }) {
  const job = useQuery({ queryKey: ['document-automation', jobId], queryFn: () => documentAutomationApi.get(jobId), enabled: active && Boolean(jobId), retry: false,
    refetchInterval: (query) => active && query.state.data && automationRunning(query.state.data.job) ? 1500 : false });
  const retry = useAutomationRetry();
  const resetRetry = retry.reset;
  useEffect(() => { resetRetry(); }, [jobId, resetRetry]);
  const download = useMutation({ mutationFn: async ({ id, fba }: { id: string; fba: string }) => downloadBlob(documentApi.download(id), `发票-${fba}.xlsx`) });
  const data = job.data?.job;
  return <ImportDialog open={active} title="自动出单" close={close} closeDisabled={retry.busy} wide><section className="document-automation" aria-label="自动出单任务">
    <div className="section-heading"><div><h3>{data ? statusLabels[data.status] : '自动出单进度'}</h3><p className="mapping-help">系统自动分票、补齐资料并生成发票；混装票先输出，请下载后核对和修改 Excel。</p></div><IconButton type="button" icon={RefreshCw} label="刷新自动出单进度" disabled={job.isFetching || retry.busy} onClick={() => void job.refetch()} /></div>
    {job.isPending ? <p className="list-state" role="status">正在读取自动出单任务…</p> : job.isError ? <QueryError error={job.error} retry={() => void job.refetch()} /> : <>
      <div className="document-automation-progress" role="status" aria-live="polite"><p>已生成 {data!.counts.completed} / {data!.counts.total} 票 · 待补充 {data!.counts.blocked} 票 · 处理中 {data!.counts.queued + data!.counts.running + data!.counts.exporting} 票</p><progress value={data!.counts.completed + data!.counts.blocked} max={Math.max(1, data!.counts.total)} aria-label="已处理票数" /></div>
      {data!.error && <p className="form-note error-note" role="alert">{data!.error.message}</p>}
      <div className="document-automation-items">{data!.items.map((item, index) => <section className="document-automation-item" key={item.id} data-automation-item={item.id} aria-label={`第 ${index + 1} 票 ${item.fbas.join('、')}`}>
        <div className="document-automation-item-heading"><div><h4>第 {index + 1} 票 · {item.fbas.join('、')}</h4><p className="mapping-help">{stageLabels[item.stage]} · {statusLabels[item.status]}</p></div>{['queued', 'running', 'exporting'].includes(item.status) && <LoaderCircle size={18} className="motion-spin" aria-label="处理中" />}</div>
        {item.error && <p className="form-note error-note">{item.error.message}</p>}
        {item.issues.length > 0 && <ul className="document-automation-issues">{item.issues.map((issue, position) => <li key={`${issue.code}-${position}`} data-severity={issue.severity}>{issue.severity === 'warning' ? '提醒：' : ''}{issue.message}</li>)}</ul>}
        <div className="document-footer-actions">
          {item.status === 'blocked' && item.documentId && <Button type="button" icon={Pencil} disabled={retry.busy} onClick={() => edit(item.documentId!, item.id)}>补充资料</Button>}
          {item.status === 'blocked' && !automationRunning(data!) && <Button type="button" icon={RefreshCw} disabled={retry.busy} onClick={() => void retry.run(data!.id, [item.id], `${data!.id}:${item.id}:${item.attempt}`).catch(() => {})}>重试失败阶段</Button>}
          {item.status === 'completed' && item.fileId && item.exportId && <Button type="button" variant="primary" icon={Download} disabled={download.isPending} onClick={() => download.mutate({ id: item.exportId!, fba: item.fbas[0] || '自动出单' })}>下载发票 XLSX</Button>}
          {item.documentId && <Button type="button" variant="text" disabled={retry.busy} onClick={() => view(item.documentId!)}>查看单据与复核</Button>}
        </div>
      </section>)}</div>
    </>}
    {retry.error && <p className="form-note error-note" role="alert">{messageOf(retry.error)} 本次已生成的文件会保留，可刷新后重试。</p>}
    {download.error && <p className="form-note error-note" role="alert">{messageOf(download.error)}</p>}
    <footer className="import-wizard-footer"><p className="mapping-help">任务在后台继续；修改下载的 Excel 不会回写系统，文件仍需人工核对。</p><div><Button type="button" disabled={retry.busy} onClick={close}>返回工作台</Button>{data && data.counts.blocked > 0 && <Button type="button" icon={RefreshCw} variant="primary" loading={retry.busy} disabled={automationRunning(data)} onClick={() => void retry.run(data.id, undefined, `${data.id}:all:${data.version}`).catch(() => {})}>重试待补票</Button>}</div></footer>
  </section></ImportDialog>;
}

export function DocumentAutomationDialog({ active, jobId, close, edit, view, blocked, onFormState, registerDiscard }: {
  active: boolean; jobId: string; close: () => void; edit: (documentId: string, itemId: string) => void; view: (documentId: string) => void;
  blocked: boolean; onFormState: (state: AutomationFormState) => void; registerDiscard: (discard: () => void) => void;
}) {
  const [actionsContainer, setActionsContainer] = useState<HTMLDivElement | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const discardRef = useRef<() => void>(() => {});
  const stableDiscard = useCallback((discard: () => void) => { discardRef.current = discard; registerDiscard(discard); }, [registerDiscard]);
  const onStateRef = useRef(onFormState); onStateRef.current = onFormState;
  const stableFormState = useRef((state: AutomationFormState) => { setFormBusy(state.busy); setFormDirty(state.dirty); onStateRef.current(state); }).current;
  const job = useQuery({ queryKey: ['document-automation', jobId], queryFn: () => documentAutomationApi.get(jobId), enabled: active && Boolean(jobId), retry: false,
    refetchInterval: (query) => active && query.state.data && automationRunning(query.state.data.job) ? 1500 : false });
  const requirements = useQuery({ queryKey: ['document-automation-requirements', jobId, job.data?.job.version], queryFn: () => documentAutomationApi.requirements(jobId), enabled: active && job.data?.job.mode === 'single_workbook' && job.data.job.phase === 'needs_input', retry: false,
    placeholderData: (previous) => previous?.job.id === jobId ? previous : undefined });
  const lastRequirements = useRef<DocumentAutomationJob | null>(null);
  if (requirements.data?.job.id === jobId) lastRequirements.current = requirements.data.job;
  const checkedRequirements = lastRequirements.current?.id === jobId ? lastRequirements.current : undefined;
  const data = job.data?.job.phase === 'needs_input' && checkedRequirements ? checkedRequirements : job.data?.job;
  const formData = data?.phase === 'needs_input' ? data : formDirty ? checkedRequirements : undefined;
  const retry = useAutomationRetry();
  const resetRetry = retry.reset;
  useEffect(() => { resetRetry(); }, [jobId, resetRetry]);
  const download = useMutation({ mutationFn: async () => downloadBlob(documentAutomationApi.download(jobId), data?.bundle?.fileName || '发票压缩包.zip') });
  const refresh = () => { void job.refetch(); if (data?.phase === 'needs_input') void requirements.refetch(); };
  if (job.data?.job.mode === 'legacy') return <DocumentAutomationLegacyDialog active={active} jobId={jobId} close={close} edit={edit} view={view} />;
  const hasFields = Boolean(data?.supplement?.descriptors.length);
  const running = Boolean(data && (automationRunning(data) || ['queued', 'running'].includes(data.status) || data.bundle?.status === 'running'));
  const failed = Boolean(data && (data.phase === 'failed' || data.status === 'failed' || data.bundle?.status === 'failed'));
  const allReady = Boolean(data?.mode === 'single_workbook' && data.items.length > 0 && data.counts.total === data.items.length && data.counts.ready === data.items.length
    && data.items.every((item) => item.status === 'ready' && !item.error && !item.issues.some((issue) => issue.severity === 'error')));
  const canRetry = Boolean(data && !running && data.bundle?.status !== 'completed' && !data.bundle?.fileId && (data.counts.blocked > 0 || failed));
  const canGenerate = canRetry && allReady && failed;
  const retryDisabled = formBusy || formDirty || retry.busy || blocked || job.isFetching || job.isError;
  const retryCurrent = () => {
    if (!data || !active || !canRetry || retryDisabled) return;
    // The stable generation key keeps an uncertain response bound to its original request.
    // useAutomationRetry synchronously shares the in-flight promise between repeated clicks.
    void retry.run(data.id, undefined, canGenerate ? `bundle-generate:${data.id}` : `bundle-recheck:${data.id}:${data.version}`).catch(() => {});
  };
  return <ImportDialog open={active} title="整批检查与打包出单" close={close} closeDisabled={formBusy || retry.busy || blocked} wide><section className="document-automation" aria-label="自动出单任务">
    <div className="section-heading"><div><h3>{data ? phaseLabels[data.phase] : '正在读取任务'}</h3><p className="mapping-help">所有货件先统一检查，通过后每张发票生成独立 Excel 文件，统一打包为 ZIP 下载。</p></div><IconButton type="button" icon={RefreshCw} label="刷新自动出单进度" disabled={job.isFetching || requirements.isFetching || formBusy || retry.busy || blocked} onClick={refresh} /></div>
    {job.isError && data && <QueryError error={job.error} retry={refresh} />}
    {job.isPending && !data ? <p className="list-state" role="status">正在读取整批检查进度…</p> : job.isError && !data ? <QueryError error={job.error} retry={refresh} /> : data && <>
      <div className="document-automation-progress" role="status" aria-live="polite"><p>共 {data.items.reduce((count, item) => count + item.fbas.length, 0)} 个货件 · {data.counts.ready + data.counts.completed} / {data.counts.total} 组检查通过 · {data.counts.blocked} 组待处理</p><progress value={data.counts.ready + data.counts.completed + data.counts.blocked} max={Math.max(1, data.counts.total)} aria-label="整批检查进度" /></div>
      {data.error && <p className="form-note error-note" role="alert">{data.error.message}</p>}
      {data.phase === 'needs_input' && <div className="permission-note warning-note" role="status">发现待补充或待处理的项目，整批尚未生成文件。请在下方统一填写后重新检查。</div>}
      {formDirty && data.phase !== 'needs_input' && <div className="permission-note warning-note" role="alert"><p>任务已进入下一阶段，本次填写仍保留。请核对任务结果；生成后修改须通过更正处理。</p><Button type="button" disabled={formBusy} onClick={() => discardRef.current()}>放弃本次未保存填写</Button></div>}
      {data.phase === 'needs_input' && requirements.isError && <QueryError error={requirements.error} retry={() => void requirements.refetch()} />}
      {formData && (requirements.isPending && !checkedRequirements ? <p className="list-state" role="status">正在汇总全部缺项…</p> : hasFields || formDirty ? <DocumentAutomationSupplement key={formData.id} job={formData} blocked={blocked || retry.busy || requirements.isFetching || data.phase !== 'needs_input'} onState={stableFormState} registerDiscard={stableDiscard} actionsContainer={actionsContainer} /> : <p className="mapping-help">当前问题需要修正来源资料或档案。修正后点击“重新统一检查”；无需重新选择货件。</p>)}
      {data.bundle?.status === 'completed' && data.bundle.fileId && <div className="document-automation-bundle" aria-label="整批发票文件"><h4>{isLegacyWorkbook(data) ? '历史整批发票' : '发票压缩包'}</h4><p>{data.bundle.fileName || '发票压缩包.zip'} · {bundleSummary(data)}</p><Button type="button" icon={Download} variant="primary" loading={download.isPending} onClick={() => download.mutate()}>{isLegacyWorkbook(data) ? '下载历史发票 XLSX' : '下载发票压缩包 ZIP'}</Button><p className="mapping-help">混装票保留提醒，可下载后在 Excel 修改；修改不回写系统。</p></div>}
      <div className="document-automation-items">{data.items.map((item, index) => <section className="document-automation-item" key={item.id} data-automation-item={item.id} aria-label={`第 ${index + 1} 组 ${item.fbas.join('、')}`}><div className="document-automation-item-heading"><div><h4>第 {index + 1} 组 · {item.fbas.join('、')}</h4><p className="mapping-help">{stageLabels[item.stage]} · {item.status === 'ready' ? '已通过整批预检' : statusLabels[item.status]}</p></div>{['queued', 'running', 'exporting'].includes(item.status) && <LoaderCircle size={18} className="motion-spin" aria-label="处理中" />}</div>
        {item.error && <p className="form-note error-note">{item.error.message}</p>}{item.issues.length > 0 && <ul className="document-automation-issues">{item.issues.map((issue, position) => <li key={`${issue.code}-${position}`} data-severity={issue.severity}>{issue.severity === 'warning' ? '提醒：' : ''}{issue.message}</li>)}</ul>}
        {item.documentId && (item.status === 'completed' || item.fileId || /UPGRADE_REQUIRED|CORRECTION_REQUIRED|EXPORT_STALE/.test(item.error?.code ?? '')) && <Button type="button" variant="text" disabled={formBusy || blocked} onClick={() => view(item.documentId!)}>{item.status === 'completed' ? '查看单据与复核' : '查看单据与更正'}</Button>}
      </section>)}</div>
    </>}
    {retry.error && <p className="form-note error-note" role="alert">{messageOf(retry.error)} {canGenerate ? '已通过检查的资料会保留，可点击“生成发票文件”重试。' : '已保存的填写会保留，可刷新后重新检查。'}</p>}{download.error && <p className="form-note error-note" role="alert">{messageOf(download.error)}</p>}
    <footer className="import-wizard-footer"><p className="mapping-help">{canGenerate ? '所有货件已通过检查。点击“生成发票文件”继续当前任务，成功后下载包含独立 Excel 文件的 ZIP 压缩包。' : '整批没有错误后才生成文件，混装等提醒不阻止输出。关闭页面后后台继续。'}</p><div ref={setActionsContainer}><Button type="button" disabled={formBusy || retry.busy || blocked} onClick={close}>返回工作台</Button>{canRetry && <Button type="button" icon={canGenerate ? ArrowRight : RefreshCw} variant={canGenerate ? 'primary' : undefined} loading={retry.busy} disabled={retryDisabled} onClick={retryCurrent}>{canGenerate ? '生成发票文件' : '重新统一检查'}</Button>}</div></footer>
  </section></ImportDialog>;
}
