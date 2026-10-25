import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportAccepted, ImportCommitResult, ImportDraftContent } from '@scm/contracts';
import { ArrowLeft, ArrowRight, Check, FileSpreadsheet, History, ListChecks, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button } from '../components/ui/button';
import { ImportConfirmation, readConfirmationState } from './import-confirmation';
import { ErrorFeedback, ImportBadge, isBusy, IssueList, ParseControls, SourceRows, UploadPanel } from './import-source';
import { OnlineImport } from './online-import';
import { ImportDialog } from './import-dialog';
import { DatePicker } from '../components/ui/date-picker';
import { shanghaiToday, dateInputError } from '../components/ui/date-utils';
import { newOperation } from './batch-shared';
import { AutomaticShippingRun } from './shipping-runs';

export type ImportWizardStep = 1 | 2 | 3 | 4 | 5;
export type ImportWizardProgress = {
  importId: string | null; source: 'file' | 'online' | null; step?: ImportWizardStep;
  reviewedRunId?: string; reviewedVersion?: number;
  resultOperationId?: string;
};
// Keep legacy checkpoint values so saved drafts and /imports/new links remain readable.
type WizardStage = 2 | 4 | 5;
const steps: { value: WizardStage; label: string; description: string }[] = [
  { value: 2, label: '填写与解析', description: '在线填写或粘贴需求，一次完成 FBA 补全和解析。店铺自动识别，仅异常项需要处理。' },
  { value: 4, label: '核对与提交', description: '核对新增、相同与变化项，选择本次提交范围。' },
  { value: 5, label: '导入结果', description: '查看本次提交结果，继续处理剩余需求或返回列表。' },
];

export type ImportWizardDraftHandle = { content: () => Promise<ImportDraftContent>; hasContent: boolean; busy: boolean };
const encodeFile = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(new Error('无法读取草稿文件，请重新选择后保存。')); reader.readAsDataURL(file); });

export function ImportWizard({ initial, active, canManage, storageKey, checkpoint, finish, startNew, viewDetail, initialDraft, initialFile, draftHandle, onDraftState, onArrangeDemands }: {
  initial: ImportWizardProgress; active: boolean; canManage: boolean; storageKey: string;
  checkpoint: (progress: ImportWizardProgress) => void; finish: () => void; startNew: () => void; viewDetail: (id: string) => void;
  initialDraft?: ImportDraftContent; initialFile?: File; draftHandle?: MutableRefObject<ImportWizardDraftHandle | null>; onDraftState?: (hasContent: boolean, busy: boolean) => void;
  onArrangeDemands?: (demandIds: string[], mode: 'create' | 'append') => void;
}) {
  const client = useQueryClient();
  const [importId, setImportId] = useState(initial.importId);
  const [shipping, setShipping] = useState<NonNullable<ImportDraftContent['shipping']>>(() => initialDraft?.shipping ?? { enabled: !initial.importId, numberingDate: shanghaiToday(), operationId: newOperation() });
  const automatic = shipping.enabled;
  const [source, setSource] = useState(initial.source ?? 'online');
  const [step, setStep] = useState<WizardStage>(initial.step === 4 || initial.step === 5 ? initial.step : 2);
  const [fileOpen, setFileOpen] = useState(!initial.importId && initial.source === 'file');
  const [hydrated, setHydrated] = useState(!initial.importId);
  const [reviewed, setReviewed] = useState<{ runId: string; version: number } | null>(initial.reviewedRunId && initial.reviewedVersion ? { runId: initial.reviewedRunId, version: initial.reviewedVersion } : null);
  const [previewReady, setPreviewReady] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const reportOnlineBusy = useCallback((value: boolean) => { setOnlineBusy(value); if (value) setSource('online'); }, []);
  const working = busy || uploadBusy || onlineBusy;
  const [onlineDraft, setOnlineDraft] = useState(initialDraft?.online);
  const [restoredConfirmation] = useState(() => initialDraft?.confirmation ?? (initial.importId ? readConfirmationState(`${storageKey}:${initial.importId}`, initial.importId) : undefined));
  const [confirmationDraft, setConfirmationDraft] = useState(restoredConfirmation);
  const [fileDraft, setFileDraft] = useState<{ file: File | null; operation: string }>({ file: initialFile ?? null, operation: initialDraft?.file?.operationId ?? '' });
  const captureFile = useCallback((file: File | null, operation: string) => { setFileDraft({ file, operation }); if (file && fileOpen) setSource('file'); }, [fileOpen]);
  const hasDraftContent = Boolean(importId && step < 5 && !shipping.runId || !importId && (onlineDraft?.rows.length || fileDraft.file));
  const [loadedRunId, setLoadedRunId] = useState<string | null>(null);
  const sourceRowsReady = useCallback((id: string) => setLoadedRunId(id), []);
  const [notice, setNotice] = useState('');
  const [confirmationActions, setConfirmationActions] = useState<HTMLDivElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const progressNav = useRef<HTMLElement>(null);
  const detail = useQuery({ queryKey: ['import', importId], queryFn: () => api.sourceImport(importId!), enabled: Boolean(importId) && active, retry: false,
    refetchInterval: (query) => active && query.state.data && isBusy(query.state.data) ? 1500 : false });
  const record = detail.data;
  const run = record?.latestRun;
  const ready = record?.status === 'preview_ready' && run?.status === 'completed';
  const context = useQuery({ queryKey: ['import-confirmation', importId, record?.version], queryFn: () => api.importConfirmation(importId!), enabled: !automatic && Boolean(importId && record) && active, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const commits = useQuery({ queryKey: ['import-commits', importId], queryFn: () => api.importCommits(importId!), enabled: !automatic && Boolean(importId && record) && active, retry: false });
  const sourceReviewed = Boolean(ready && reviewed?.runId === run?.id && reviewed?.version === record?.version);
  const hasResult = Boolean(result || commits.data?.items.length);
  const savedResult = result ?? (initial.resultOperationId ? commits.data?.items.find((item) => item.operationId === initial.resultOperationId) : commits.data?.items[0]) ?? null;
  const hasPreview = previewReady;
  const staleReview = Boolean(reviewed && record && (reviewed.version !== record.version || reviewed.runId !== run?.id));
  const restoredPreviewId = restoredConfirmation?.pending?.previewId ?? restoredConfirmation?.previewId ?? context.data?.latestPreviewId;
  const restoredPreview = useQuery({ queryKey: ['import-preview-restore', importId, restoredPreviewId],
    queryFn: () => api.importPreview(importId!, restoredPreviewId!, { page: 1, pageSize: 20, kind: '' }),
    enabled: !hydrated && !restoredConfirmation?.pending && ready && Boolean(restoredPreviewId) && (initial.step === 4 || !initial.step), retry: false });
  useEffect(() => {
    onDraftState?.(hasDraftContent, working || fileOpen);
    if (!draftHandle) return;
    draftHandle.current = { hasContent: hasDraftContent, busy: working || fileOpen, content: async () => {
      const progress: ImportWizardProgress = { importId, source, step, ...(reviewed ? { reviewedRunId: reviewed.runId, reviewedVersion: reviewed.version } : {}), resultOperationId: result?.operationId ?? initial.resultOperationId };
      let confirmation: ImportDraftContent['confirmation'] = confirmationDraft;
      if (importId && !confirmation) { try { confirmation = JSON.parse(sessionStorage.getItem(`${storageKey}:${importId}`) ?? 'null') ?? undefined; } catch { /* Current confirmation is also held in memory. */ } }
      return { source, progress, shipping, ...(!importId && onlineDraft ? { online: onlineDraft } : {}), ...(!importId && fileDraft.file ? { file: { name: fileDraft.file.name, type: fileDraft.file.type, lastModified: fileDraft.file.lastModified, base64: await encodeFile(fileDraft.file), operationId: fileDraft.operation || undefined } } : {}), ...(confirmation ? { confirmation } : {}) };
    } };
  }, [draftHandle, onDraftState, hasDraftContent, working, fileOpen, importId, source, step, reviewed, result, initial.resultOperationId, onlineDraft, fileDraft, storageKey, confirmationDraft, shipping]);

  useEffect(() => {
    if ([detail.error, context.error, commits.error].some((error) => error instanceof ApiError && error.status === 401)) void client.invalidateQueries({ queryKey: ['session'] });
  }, [detail.error, context.error, commits.error, client]);
  // Infer a checkpoint only once. Polling/focus refresh must never move a person to another step.
  useEffect(() => {
    if (hydrated || !record) return;
    const receivedSource = record.sourceType === 'online' ? 'online' : 'file';
    if (automatic) { setSource(receivedSource); setStep(2); setHydrated(true); return; }
    // An uncertain commit must be replayable even when history or the current catalog is unavailable.
    if (restoredConfirmation?.pending) {
      setSource(receivedSource); setStep(4); setHydrated(true);
      checkpoint({ ...initial, source: receivedSource, step: 4 });
      return;
    }
    if (context.isPending || context.isError || commits.isPending || commits.isError) return;
    setSource(receivedSource);
    let restored: WizardStage = 2;
    if ((initial.step === 5 || !initial.step && context.data?.status === 'submitted') && savedResult) restored = 5;
    else if (ready && restoredPreviewId && (initial.step === 4 || !initial.step)) {
      if (restoredPreview.isPending) return;
      const preview = restoredPreview.data?.preview;
      const valid = preview && preview.importVersion === record.version && preview.parseRunId === run.id
        && preview.sellerCatalogMode === context.data.catalog.mode && preview.sellerCatalogSettingsVersion === context.data.catalog.version
        && preview.sellerCatalogVersion === context.data.catalog.catalogVersion
        && preview.mappings.every((mapping) => context.data.sellers.some((seller) => seller.id === mapping.sellerMappingId && seller.version === mapping.expectedVersion && seller.status !== 'disabled'));
      if (valid) { restored = 4; setPreviewReady(true); setReviewed({ runId: run.id, version: record.version }); }
      else setNotice('原差异预览已失效，请核对当前解析结果和店铺后重新生成。');
    }
    setStep(restored); setHydrated(true);
    checkpoint({ ...initial, source: receivedSource, step: restored,
      ...(ready && restored === 4
        ? { reviewedRunId: record.latestRun!.id, reviewedVersion: record.version } : {}),
    });
  }, [hydrated, record, run, context.isPending, context.isError, context.data, commits.isPending, commits.isError, initial, ready, restoredConfirmation, restoredPreviewId, restoredPreview.isPending, restoredPreview.data, checkpoint, savedResult, automatic]);
  useEffect(() => {
    if (!active || !hydrated) return;
    const frame = requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true });
      heading.current?.closest('.import-dialog-body')?.scrollTo({ top: 0 });
      const nav = progressNav.current;
      const currentStep = nav?.querySelector<HTMLElement>('[aria-current="step"]');
      if (nav && currentStep) {
        const bounds = nav.getBoundingClientRect(); const item = currentStep.getBoundingClientRect();
        if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
        else if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, hydrated, step]);

  const save = (next: WizardStage, values: Partial<ImportWizardProgress> = {}) => {
    const progress = { importId, source, step: next, resultOperationId: result?.operationId ?? initial.resultOperationId, ...(reviewed ? { reviewedRunId: reviewed.runId, reviewedVersion: reviewed.version } : {}), ...values };
    setStep(next); checkpoint(progress);
  };
  const accepted = (value: ImportAccepted) => {
    client.setQueryData(['import', value.import.id], value.import);
    void client.invalidateQueries({ queryKey: ['imports'] });
    setImportId(value.import.id); setReviewed(null); setPreviewReady(false); setResult(null); setHydrated(true); setFileOpen(false);
    const nextSource = value.import.sourceType === 'online' ? 'online' : 'file';
    setSource(nextSource);
    setNotice(value.deduplicated ? '已找到相同内容的导入记录，原业务日期保持不变。请核对已有解析结果。' : value.replayed ? '已恢复上次接收结果，请继续核对。' : value.import.status === 'awaiting_mapping' ? '工作簿已保存，请选择本次输入工作表后继续解析。' : '内容已保存，正在自动解析并识别店铺。完成后核对源行和识别结果。');
    save(2, { importId: value.import.id, source: nextSource, reviewedRunId: undefined, reviewedVersion: undefined });
    requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); heading.current?.closest('.import-dialog-body')?.scrollTo({ top: 0 }); });
  };
  const onPreviewReady = () => {
    if (!run || !record) return;
    setReviewed({ runId: run.id, version: record.version }); setPreviewReady(true);
    save(4, { reviewedRunId: run.id, reviewedVersion: record.version });
  };
  const onCommitted = (value: ImportCommitResult) => { setResult(value); save(5, { resultOperationId: value.operationId }); void client.invalidateQueries({ queryKey: ['demands'] }); void client.invalidateQueries({ queryKey: ['batches'] }); };
  const allowed = (target: WizardStage) => target === 2 || target === 4 && sourceReviewed && hasPreview || target === 5 && hasResult;
  const stage = automatic ? { label: '本次发货自动整理', description: '空行分票，自动补全、编号并整理商品和箱数据。只有异常项需要处理。' } : steps.find((item) => item.value === step)!;

  return <div className="import-wizard">
    {!importId && <div className="import-selection-actions"><Button type="button" aria-pressed={automatic} disabled={working} onClick={() => setShipping((value) => ({ ...value, enabled: true }))}>本次发货自动整理</Button><Button type="button" aria-pressed={!automatic} disabled={working} onClick={() => setShipping((value) => ({ ...value, enabled: false }))}>仅导入需求</Button></div>}
    <nav ref={progressNav} className="import-wizard-progress" aria-label="导入步骤" hidden={automatic}><ol>{steps.map(({ value: target, label }, index) => {
      return <li key={label} data-current={step === target} data-complete={target < step}><button type="button" aria-current={step === target ? 'step' : undefined} disabled={working || !hydrated || !allowed(target)} onClick={() => save(target)}><span className="wizard-step-number" aria-hidden="true">{target < step ? <Check size={15} /> : index + 1}</span><span>{label}</span></button></li>;
    })}</ol></nav>
    <div className="import-wizard-heading"><div><h3 ref={heading} tabIndex={-1}>{stage.label}</h3><p>{stage.description}</p></div>{importId && <Button variant="text" type="button" icon={History} onClick={() => viewDetail(importId)}>查看导入详情</Button>}</div>
    {automatic && <div className="shipping-numbering-controls"><div className="field"><label htmlFor="shipping-numbering-date">编号日期</label><DatePicker id="shipping-numbering-date" value={shipping.numberingDate} disabled={working || Boolean(shipping.runId || shipping.pending)} required onValueChange={(numberingDate) => setShipping((value) => ({ ...value, numberingDate }))} /></div><p className="mapping-help">格式：{shipping.numberingDate.replaceAll('-', '') || 'YYYYMMDD'}-本月第几次-国家-该国第几票。发货次数自动分配，英国使用 UK；编号日期独立于实际发货日期。</p></div>}
    {!hydrated ? <>
      {detail.isError ? <ErrorFeedback title="无法恢复导入" error={detail.error} retry={() => void detail.refetch()} />
        : context.isError ? <ErrorFeedback title="无法恢复店铺核对" error={context.error} retry={() => void context.refetch()} />
          : commits.isError ? <ErrorFeedback title="无法恢复提交记录" error={commits.error} retry={() => void commits.refetch()} />
            : <p className="list-state" role="status">正在恢复导入进度…</p>}
      <Button type="button" onClick={startNew}>新建导入</Button>
    </> : <>
      <div hidden={step !== 2} className="wizard-input-stage">
        {!importId && <div className="wizard-input-tools"><p className="mapping-help">直接填写在线表格，也可上传已有工作簿。</p><Button type="button" icon={FileSpreadsheet} disabled={working || Boolean(onlineDraft?.pendingSubmission) || !canManage} onClick={() => setFileOpen(true)}>表格导入</Button></div>}
        <div hidden={Boolean(importId)}><OnlineImport accepted={accepted} active={active && step === 2 && !importId && !fileOpen} initialDraft={initialDraft?.online} onDraftChange={setOnlineDraft} onBusyChange={reportOnlineBusy} deferLookup={automatic} /></div>
        {importId && (detail.isPending ? <p className="list-state" role="status">正在读取解析结果…</p> : detail.isError ? <ErrorFeedback title="无法读取导入" error={detail.error} retry={() => void detail.refetch()} /> : record && <>
          <div className="wizard-file-summary"><FileSpreadsheet size={22} aria-hidden="true" /><div><strong>{record.originalName}</strong><small>业务日期 {record.businessDate} · {record.sourceType === 'online' ? '在线填写快照' : '表格文件'}</small></div><ImportBadge record={record} /><Button type="button" variant="text" icon={RefreshCw} loading={detail.isFetching} onClick={() => void detail.refetch()}>刷新解析结果</Button></div>
          {notice && !automatic && <p className="permission-note success-note" role="status">{notice}</p>}
          {isBusy(record) && <p className="permission-note" role="status">{run?.sheetName && run.mappingVersion ? '文件结构与表头校验通过。' : ''}{record.status === 'queued' ? '正在等待自动解析，完成后可继续。' : `正在自动解析，已处理 ${run?.processedRows ?? 0} 行。`} 进度会自动更新。</p>}
          {record.status === 'failed' && <div className="inline-error" role="alert"><div><strong>本次解析失败</strong><p>{run?.errorMessage ?? '解析未完成，请核对工作表与字段映射后重试。'}</p></div></div>}
          {record.status === 'awaiting_mapping' && <p className="permission-note warning-note" role="status">需要人工选择本次输入工作表及字段映射，确认后继续解析。</p>}
          {run?.issues.length ? <IssueList issues={run.issues} /> : null}
          {(record.sheets.length > 0 || record.status === 'failed') && <details className="wizard-mapping-details" open={record.status === 'failed' || record.status === 'awaiting_mapping'}><summary>工作表与字段映射</summary><ParseControls key={`${record.id}:${record.version}`} record={record} canManage={canManage} scope="wizard" /></details>}
          {automatic && run?.status === 'completed' && (dateInputError(shipping.numberingDate, { required: true }) ? <p className="form-note error-note" role="alert">请填写有效的编号日期后继续自动整理。</p> : <AutomaticShippingRun key={`${record.id}:${shipping.operationId}:${shipping.numberingDate}`} record={record} active={active} initial={shipping} onChange={setShipping} />)}
          {!automatic && ready && run && <>
            <div className="import-counts" aria-label="本次解析统计"><div><span>保留源行</span><strong>{run.counts.totalRows}</strong></div><div><span>有效 FBA 行</span><strong>{run.counts.validFbaRows}</strong></div><div><span>需核对行</span><strong>{run.counts.warningRows}</strong></div><div><span>错误行</span><strong>{run.counts.errorRows}</strong></div></div>
            {run.counts.errorRows > 0 && <p className="mapping-help">错误行保留定位，不妨碍后续选择其他有效需求提交。</p>}
            <SourceRows key={run.id} record={record} runId={run.id} scope="wizard" onReady={sourceRowsReady} />
          </>}
        </>)}
      </div>
      {step >= 4 && staleReview && <div className="permission-note warning-note" role="status">解析版本已经更新。当前识别和差异需要重新核对。<Button type="button" icon={RefreshCw} onClick={() => { setPreviewReady(false); save(2); }}>核对最新解析版本</Button></div>}
      <div>
        {!automatic && record && run && (ready || step !== 2) ? <ImportConfirmation key={record.id} record={record} run={run} historical={false} canManage={canManage}
          wizard={{ step: step === 5 ? 'complete' : step === 4 ? 'review' : 'input', active, actionsContainer: confirmationActions, sourceReviewed: step === 2 ? Boolean(ready && loadedRunId === run.id) : sourceReviewed, onBusyChange: setBusy, onPreviewReady, onCommitted, onBackToSellers: () => { setPreviewReady(false); save(2); }, onInputChange: () => setPreviewReady(false), onContinueReview: () => sourceReviewed ? save(4) : save(2), storageKey: `${storageKey}:${record.id}`, initialConfirmation: restoredConfirmation, onStateChange: setConfirmationDraft }} />
          : step !== 2 && step !== 5 && <p className="list-state">解析尚未完成，请返回第一步核对。</p>}
      </div>
      {step === 5 && !run && savedResult && <p className="permission-note success-note">已恢复此前提交结果，新增 {savedResult.counts.created} 票，新版本 {savedResult.counts.updated} 票，补充来源 {savedResult.counts.linked} 票。</p>}
      {step === 5 && commits.isError && <ErrorFeedback title="无法读取提交结果" error={commits.error} retry={() => void commits.refetch()} />}
      {step === 5 && !savedResult && !commits.isPending && <p className="list-state">尚未提交需求，请返回核对后提交。</p>}
      <div className="import-wizard-footer" hidden={automatic || step === 2 && !importId}>
        <div>{step === 4 && <Button type="button" icon={ArrowLeft} disabled={working} onClick={() => save(2)}>上一步</Button>}</div>
        <div ref={setConfirmationActions}>
          {step === 2 && !ready && <Button type="button" variant="primary" icon={ArrowRight} disabled>下一步：核对与提交</Button>}
          {step === 5 && <><Button type="button" icon={FileSpreadsheet} onClick={startNew}>新建导入</Button><Button type="button" icon={ListChecks} onClick={finish}>稍后分组，返回需求列表</Button>{onArrangeDemands && savedResult && savedResult.items.length > 0 && <><Button type="button" disabled={working} onClick={() => onArrangeDemands([...new Set(savedResult.items.map((item) => item.demandId))], 'append')}>加入已有批次</Button><Button type="button" variant="primary" icon={ArrowRight} disabled={working} onClick={() => onArrangeDemands([...new Set(savedResult.items.map((item) => item.demandId))], 'create')}>新建发货批次</Button></>}</>}
        </div>
      </div>
    </>}
    <ImportDialog open={active && fileOpen && !importId} title="表格导入" close={() => { if (!uploadBusy) setFileOpen(false); }} closeDisabled={uploadBusy}>
      <UploadPanel canManage={canManage} active={active && fileOpen && !importId} accepted={accepted} onBusyChange={setUploadBusy} initialFile={initialFile} initialOperation={initialDraft?.file?.operationId} onDraftChange={captureFile} />
    </ImportDialog>
  </div>;
}
