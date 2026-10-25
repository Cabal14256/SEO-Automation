import {
  importCommitInputSchema, importDraftContentSchema, type ImportCommitInput, type ImportCommitResult, type ImportDiffItem, type ImportPreviewResponse, type ImportRun, type SourceImport, type ImportDraftContent,
} from '@scm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Download, Eye, ListChecks, RefreshCw, RotateCcw, ScanSearch, X } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Combobox } from '../components/ui/combobox';
import { SelectField } from '../components/ui/select';
import { catalogModeLabels, catalogTimestamp } from './seller-source-setting';

const labels: Record<ImportDiffItem['kind'], string> = {
  new: '新增', unchanged: '相同 · 补充来源', changed: '变化 · 待确认', conflict: '冲突', error: '错误', missing: '来源缺失',
};
const fieldLabels = { shop: '店铺名称', country: '国家', channel: '业务渠道', destinationFc: '目的 FC', destinationAddress: '仓库地址', shipmentCreatedAt: '货件创建时间', sourceFilledAt: '来源填写时间', subBatchName: '来源分组', notes: '备注' } as const;
const messageOf = (error: unknown) => error instanceof Error ? error.message : '读取失败，请稍后重试。';
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value));
const operationId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
type Selection = { sellerMappingId: string; confirmed: boolean; confirmedVersion?: number; catalogSettingsVersion?: number; catalogVersion?: number };
type StoredConfirmation = NonNullable<ImportDraftContent['confirmation']>;
const validUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function readConfirmationState(key: string | undefined, importId: string): StoredConfirmation {
  const empty: StoredConfirmation = { version: 1, importId, previewId: null, pending: null, lastOperationId: null };
  if (!key) return empty;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('importId' in value) || value.importId !== importId) return empty;
    const pending = 'pending' in value ? importCommitInputSchema.safeParse(value.pending) : null;
    const saved = importDraftContentSchema.shape.confirmation.unwrap().safeParse(value);
    return saved.success ? saved.data : { ...empty, previewId: 'previewId' in value && validUuid(value.previewId) ? value.previewId : null, pending: pending?.success ? pending.data : null, lastOperationId: 'lastOperationId' in value && validUuid(value.lastOperationId) ? value.lastOperationId : null };
  } catch { return empty; }
}
function saveConfirmationState(key: string | undefined, value: StoredConfirmation) {
  if (!key) return;
  try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage restrictions must not prevent the current session from importing. */ }
}

export type ImportConfirmationWizard = {
  step: 'input' | 'review' | 'complete';
  active?: boolean;
  actionsContainer?: HTMLDivElement | null;
  onPreviewReady: () => void;
  onCommitted: (result: ImportCommitResult) => void;
  onBackToSellers: () => void;
  onInputChange?: () => void;
  onContinueReview?: () => void;
  storageKey?: string;
  sourceReviewed?: boolean;
  onBusyChange?: (busy: boolean) => void;
  initialConfirmation?: ImportDraftContent['confirmation'];
  onStateChange?: (value: NonNullable<ImportDraftContent['confirmation']>) => void;
};

export function ImportConfirmation({ record, run, historical, canManage, wizard }: { record: SourceImport; run: ImportRun; historical: boolean; canManage: boolean; wizard?: ImportConfirmationWizard }) {
  const queryClient = useQueryClient();
  const instanceId = useId();
  const titleId = `import-confirmation-${instanceId}`;
  const baselineId = `import-baseline-${instanceId}`;
  const diffKindId = `import-diff-kind-${instanceId}`;
  const [restored] = useState(() => wizard?.initialConfirmation?.importId === record.id ? wizard.initialConfirmation : readConfirmationState(wizard?.storageKey, record.id));
  const [selections, setSelections] = useState<Record<string, Selection>>(restored.shopSelections ?? {});
  const [baselineImportId, setBaselineImportId] = useState(restored.baselineImportId ?? '');
  const [chosenPreviewId, setChosenPreviewId] = useState<string | null>(restored.pending?.previewId ?? restored.previewId);
  const [pendingSubmission, setPendingSubmission] = useState<ImportCommitInput | null>(restored.pending);
  const [lastOperationId, setLastOperationId] = useState<string | null>(restored.lastOperationId);
  const recoveredOperations = useRef(new Set<string>());
  const [draftChanged, setDraftChanged] = useState(false);
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<string[]>(restored.pending?.selectedItemIds ?? []);
  const [confirmedChanges, setConfirmedChanges] = useState<string[]>(restored.pending?.confirmedChangedItemIds ?? []);
  const [currentOperation, setCurrentOperation] = useState(() => restored.pending?.operationId ?? operationId());
  const [lastResult, setLastResult] = useState<ImportCommitResult | null>(null);
  const reportState = wizard?.onStateChange;
  useEffect(() => { reportState?.({ version: 1, importId: record.id, previewId: chosenPreviewId, pending: pendingSubmission, lastOperationId, shopSelections: selections, ...(baselineImportId ? { baselineImportId } : {}) }); }, [reportState, record.id, chosenPreviewId, pendingSubmission, lastOperationId, selections, baselineImportId]);
  const [openedDemandId, setOpenedDemandId] = useState<string | null>(null);
  const confirmation = useQuery({
    queryKey: ['import-confirmation', record.id, record.version], queryFn: () => api.importConfirmation(record.id), retry: false,
    enabled: wizard?.active !== false,
    refetchOnMount: wizard ? false : 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previousWizardStep = useRef(wizard?.step);
  const initializedSellerStep = useRef(false);
  useEffect(() => {
    const onSellerStep = wizard?.step === 'input';
    const enteredSellerStep = onSellerStep && (!initializedSellerStep.current || previousWizardStep.current !== 'input');
    previousWizardStep.current = wizard?.step;
    if (!onSellerStep || wizard?.active === false) return;
    initializedSellerStep.current = true;
    if (enteredSellerStep && confirmation.data && !confirmation.isFetching) void confirmation.refetch();
  }, [wizard?.step, wizard?.active, confirmation.data, confirmation.isFetching, confirmation.refetch]);
  const previewId = historical ? null : chosenPreviewId ?? (!wizard ? confirmation.data?.latestPreviewId ?? null : null);
  const preview = useQuery({
    queryKey: ['import-preview', record.id, previewId, page, kind],
    queryFn: () => api.importPreview(record.id, previewId!, { page, pageSize: 20, kind }), enabled: Boolean(previewId) && (!wizard || wizard.step !== 'input' || Boolean(pendingSubmission)), retry: false,
  });
  const commits = useQuery({ queryKey: ['import-commits', record.id], queryFn: () => api.importCommits(record.id), retry: false });
  const committedItemIds = new Set([
    ...(commits.data?.items.filter((result) => result.previewId === previewId).flatMap((result) => result.items.map((item) => item.itemId)) ?? []),
    ...(lastResult?.previewId === previewId ? lastResult.items.map((item) => item.itemId) : []),
  ]);
  const createPreview = useMutation({
    mutationFn: api.createImportPreview,
    onSuccess: (result: ImportPreviewResponse) => {
      setChosenPreviewId(result.preview.id); setPage(1); setKind(''); setSelected([]); setConfirmedChanges([]); setDraftChanged(false); setLastResult(null); setCurrentOperation(operationId());
      queryClient.setQueryData(['import-preview', record.id, result.preview.id, 1, ''], result);
      saveConfirmationState(wizard?.storageKey, { version: 1, importId: record.id, previewId: result.preview.id, pending: null, lastOperationId });
      void queryClient.invalidateQueries({ queryKey: ['import-confirmation', record.id] });
      wizard?.onPreviewReady();
    },
  });
  const commit = useMutation({
    networkMode: 'always',
    mutationFn: api.commitImport,
    onSuccess: (result) => {
      const alreadyRecovered = recoveredOperations.current.has(result.operationId);
      recoveredOperations.current.add(result.operationId);
      setPendingSubmission(null); setLastOperationId(result.operationId);
      saveConfirmationState(wizard?.storageKey, { version: 1, importId: record.id, previewId: chosenPreviewId, pending: null, lastOperationId: result.operationId });
      setLastResult(result); setSelected([]); setConfirmedChanges([]);
      void queryClient.invalidateQueries({ queryKey: ['import-preview', record.id] });
      void queryClient.invalidateQueries({ queryKey: ['import-commits', record.id] });
      void queryClient.invalidateQueries({ queryKey: ['import-confirmation', record.id] });
      void queryClient.invalidateQueries({ queryKey: ['demand'] });
      void queryClient.invalidateQueries({ queryKey: ['demands'] });
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
      if (!alreadyRecovered) wizard?.onCommitted(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403) {
        setPendingSubmission(null);
        saveConfirmationState(wizard?.storageKey, { version: 1, importId: record.id, previewId: chosenPreviewId, pending: null, lastOperationId });
      }
    },
  });
  const exportErrors = useMutation({ mutationFn: async () => {
    if (!previewId) return;
    const url = URL.createObjectURL(await api.downloadImportErrors(record.id, previewId));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `导入错误-${record.id}.csv`; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } });
  const errors = [confirmation.error, preview.error, commits.error, createPreview.error, commit.error, exportErrors.error];
  const sessionExpired = errors.some((error) => error instanceof ApiError && error.status === 401);
  useEffect(() => { if (sessionExpired) void queryClient.invalidateQueries({ queryKey: ['session'] }); }, [sessionExpired, queryClient]);
  useEffect(() => {
    if (wizard && !chosenPreviewId && confirmation.data?.latestPreviewId) setChosenPreviewId(confirmation.data.latestPreviewId);
  }, [wizard, chosenPreviewId, confirmation.data?.latestPreviewId]);
  useEffect(() => {
    saveConfirmationState(wizard?.storageKey, { version: 1, importId: record.id, previewId: chosenPreviewId, pending: pendingSubmission, lastOperationId, shopSelections: selections, ...(baselineImportId ? { baselineImportId } : {}) });
  }, [wizard?.storageKey, record.id, chosenPreviewId, pendingSubmission, lastOperationId, selections, baselineImportId]);
  useEffect(() => {
    if (!pendingSubmission) return;
    const saved = commits.data?.items.find((entry) => entry.operationId === pendingSubmission.operationId);
    if (!saved || recoveredOperations.current.has(saved.operationId)) return;
    recoveredOperations.current.add(saved.operationId);
    setLastResult(saved); setPendingSubmission(null); setLastOperationId(saved.operationId); setSelected([]); setConfirmedChanges([]);
    void queryClient.invalidateQueries({ queryKey: ['demands'] });
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    saveConfirmationState(wizard?.storageKey, { version: 1, importId: record.id, previewId: chosenPreviewId, pending: null, lastOperationId: saved.operationId });
    wizard?.onCommitted(saved);
  }, [pendingSubmission, commits.data, wizard, record.id, chosenPreviewId, queryClient]);
  const busy = createPreview.isPending || commit.isPending;
  const reportBusy = wizard?.onBusyChange;
  useEffect(() => {
    reportBusy?.(busy);
    return () => { reportBusy?.(false); };
  }, [busy, reportBusy]);
  const locked = busy || Boolean(pendingSubmission);
  const previewMatchesRun = preview.data?.preview.parseRunId === run.id && preview.data.preview.importVersion === record.version;
  const previewMatchesCatalog = Boolean(preview.data && confirmation.data && preview.data.preview.sellerCatalogMode === confirmation.data.catalog.mode && preview.data.preview.sellerCatalogSettingsVersion === confirmation.data.catalog.version && preview.data.preview.sellerCatalogVersion === confirmation.data.catalog.catalogVersion);
  const hasChangedConfirmation = preview.data?.preview.mappings.some((mapping) => !confirmation.data?.sellers.some((seller) => seller.id === mapping.sellerMappingId && seller.status !== 'disabled' && seller.version === mapping.expectedVersion && seller.sid === mapping.sid && seller.country === mapping.country)) ?? false;
  const sourceReviewed = wizard?.sourceReviewed !== false;
  const canSubmit = canManage && !historical && sourceReviewed && run.status === 'completed' && (!wizard || wizard.step === 'review') && !confirmation.isError && !draftChanged && !locked && previewMatchesRun && previewMatchesCatalog && !hasChangedConfirmation;
  const selectionFor = (shop: NonNullable<typeof confirmation.data>['shops'][number]): Selection => {
    if (shop.resolution?.reason === 'conflicting_lookup_sids') return { sellerMappingId: '', confirmed: false };
    const manual = Object.hasOwn(selections, shop.sourceShop) ? selections[shop.sourceShop] : undefined;
    if (manual) return manual;
    const resolution = shop.resolution;
    if (wizard && resolution?.status === 'unique' && resolution.sellerMappingId && resolution.expectedVersion) {
      return { sellerMappingId: resolution.sellerMappingId, confirmed: true, confirmedVersion: resolution.expectedVersion,
        catalogSettingsVersion: confirmation.data!.catalog.version, catalogVersion: confirmation.data!.catalog.catalogVersion };
    }
    return { sellerMappingId: '', confirmed: false };
  };
  const sellerSelections = confirmation.data?.shops.flatMap((shop) => {
    const selection = selectionFor(shop);
    const seller = selection?.confirmed && selection.catalogSettingsVersion === confirmation.data.catalog.version && selection.catalogVersion === confirmation.data.catalog.catalogVersion ? confirmation.data.sellers.find((value) => value.id === selection.sellerMappingId && value.status !== 'disabled' && value.version === selection.confirmedVersion) : undefined;
    return seller ? [{ sourceShop: shop.sourceShop, sellerMappingId: seller.id, expectedVersion: selection!.confirmedVersion!, confirmed: true as const }] : [];
  }) ?? [];
  const changeDraft = () => { if (pendingSubmission) return; setDraftChanged(true); setSelected([]); setConfirmedChanges([]); setLastResult(null); createPreview.reset(); commit.reset(); setCurrentOperation(operationId()); wizard?.onInputChange?.(); };
  const refreshConfirmation = () => { if (pendingSubmission) return; setSelections({}); changeDraft(); void confirmation.refetch(); if (wizard && wizard.step !== 'input') wizard.onBackToSellers(); };
  const changeSelected = (next: string[]) => { if (pendingSubmission) return; setSelected(next); setCurrentOperation(operationId()); commit.reset(); setLastResult(null); };
  const eligible = (item: ImportDiffItem) => item.selectable && !item.alreadyCommitted && !committedItemIds.has(item.id) && (item.kind !== 'changed' || confirmedChanges.includes(item.id));
  const toggleChanged = (id: string, checked: boolean) => {
    if (pendingSubmission) return;
    setConfirmedChanges((current) => checked ? [...current, id] : current.filter((value) => value !== id));
    if (!checked) setSelected((current) => current.filter((value) => value !== id));
    setCurrentOperation(operationId()); commit.reset(); setLastResult(null);
  };
  const refreshPreview = () => { if (pendingSubmission) return; setSelected([]); setConfirmedChanges([]); setCurrentOperation(operationId()); commit.reset(); void preview.refetch(); };
  const submitSelected = () => {
    if (!canManage || busy) return;
    if (pendingSubmission) { commit.mutate({ id: record.id, input: pendingSubmission }); return; }
    if (!canSubmit || !preview.data || !selected.length) return;
    const input = importCommitInputSchema.parse({ operationId: currentOperation, previewId: preview.data.preview.id, selectedItemIds: selected, confirmedChangedItemIds: confirmedChanges.filter((id) => selected.includes(id)) });
    setPendingSubmission(input);
    saveConfirmationState(wizard?.storageKey, { version: 1, importId: record.id, previewId: input.previewId, pending: input, lastOperationId });
    commit.mutate({ id: record.id, input });
  };
  const showSellers = !wizard || wizard.step === 'input';
  const showReview = !wizard || wizard.step === 'review';
  const previewAction = <Button type="button" variant={wizard ? 'primary' : 'secondary'} icon={ScanSearch} loading={createPreview.isPending} loadingLabel="正在生成差异…" disabled={locked || !canManage || !sourceReviewed || !confirmation.data || confirmation.isError || confirmation.isFetching || run.status !== 'completed' || Boolean(wizard && sellerSelections.length === 0)} onClick={() => {
    if (!sourceReviewed || !confirmation.data) return;
    createPreview.mutate({ id: record.id, input: { expectedVersion: record.version, parseRunId: run.id, sellerSelections, expectedCatalogSettingsVersion: confirmation.data.catalog.version, expectedCatalogVersion: confirmation.data.catalog.catalogVersion, ...(baselineImportId ? { baselineImportId } : {}) } });
  }}>{wizard ? '下一步：核对与提交' : '生成差异预览'}</Button>;
  const submitAction = <Button type="button" variant="primary" icon={Check} loading={commit.isPending} loadingLabel="正在提交需求…" disabled={pendingSubmission ? Boolean(wizard) || busy || !canManage : !canSubmit || selected.length === 0} onClick={submitSelected}>确认提交所选需求</Button>;
  const savedResult = lastOperationId ? commits.data?.items.find((entry) => entry.operationId === lastOperationId) ?? null : commits.data?.items[0] ?? null;
  const result = pendingSubmission ? null : lastResult ?? (wizard?.step === 'complete' ? savedResult : null);
  const completedItemIds = new Set([...committedItemIds, ...(lastResult?.previewId === previewId ? lastResult.items.map((item) => item.itemId) : [])]);
  const remainingCount = preview.data?.preview.selectableItemIds.filter((id) => !completedItemIds.has(id)).length ?? 0;
  const unresolvedCount = (preview.data?.preview.counts.error ?? 0) + (preview.data?.preview.counts.conflict ?? 0);
  const commitHistory = <div className="import-commit-history"><div className="section-heading"><h4>提交记录</h4><IconButton type="button" icon={RefreshCw} label="刷新提交记录" loading={commits.isFetching} onClick={() => void commits.refetch()} /></div>{commits.isPending ? <p className="list-state">正在读取提交记录…</p> : commits.isError ? <Feedback error={commits.error} retry={() => void commits.refetch()} /> : commits.data.items.length === 0 ? <p className="list-state">此文件尚无需求提交记录。</p> : <ol>{commits.data.items.map((entry) => <li key={entry.operationId}><details><summary>{formatTime(entry.createdAt)} · 新增 {entry.counts.created} · 新版本 {entry.counts.updated} · 补来源 {entry.counts.linked}</summary><CommitResult result={entry} openDemand={setOpenedDemandId} /></details></li>)}</ol>}</div>;
  return <div className="import-confirmation" aria-labelledby={titleId}>
    <div className="section-heading panel-heading"><div><h3 id={titleId}>{!wizard ? '确认店铺与增量差异' : ({ input: '店铺识别', review: '核对差异与提交', complete: '本次提交结果' } as const)[wizard.step]}</h3><p>{wizard?.step === 'complete' ? '已保存本次提交结果和需求来源，可继续处理尚未提交的有效需求。' : '每票需求以店铺 sid 与 FBA 识别。相同内容补充来源，变化经逐票确认后保存新版本。'}</p></div></div>
    {historical && <p className="permission-note" role="status">当前为历史解析版本。请返回最新版本确认店铺、生成差异并提交；历史提交记录仍可查看。</p>}
    {pendingSubmission && <div className="permission-note warning-note" role="status">
      <p>{commit.isPending ? '正在提交已选需求，请稍候。' : '上次提交结果尚未确认。请先重试原提交或核对提交记录，再调整店铺、差异与选择。'}</p>
      <p>原提交范围：{pendingSubmission.selectedItemIds.length} 票。即使目录或解析版本已更新，重试仍使用原来的提交内容与操作编号。</p>
      <div className="import-selection-actions"><Button type="button" variant="primary" icon={RefreshCw} loading={commit.isPending} loadingLabel="正在恢复提交…" disabled={busy || !canManage} onClick={submitSelected}>重试原提交</Button><Button type="button" icon={ScanSearch} loading={commits.isFetching} disabled={commit.isPending || commits.isFetching} onClick={() => void commits.refetch()}>核对提交记录</Button></div>
    </div>}
    {confirmation.isPending ? <p className="list-state" role="status">正在读取本次确认信息…</p> : confirmation.isError ? <Feedback error={confirmation.error} retry={() => void confirmation.refetch()} /> : <>
      {showSellers && <><p className="permission-note">本次店铺来源：{catalogModeLabels[confirmation.data.catalog.mode]} · 来源设置版本 {confirmation.data.catalog.version} · 目录版本 {confirmation.data.catalog.catalogVersion}{confirmation.data.catalog.mode === 'lingxing' && ` · 最近同步：${confirmation.data.catalog.lastSyncedAt ? `${catalogTimestamp(confirmation.data.catalog.lastSyncedAt)}（上海）` : '尚未同步'}`}</p>
      {confirmation.data.catalog.lastError && <p className="form-note warning-note">最近店铺同步失败：{confirmation.data.catalog.lastError.message}。当前保留最近成功同步的目录。</p>}</>}
      {(!wizard || showSellers) && <p className="permission-note">提交进度：{({ not_submitted: '尚未提交', partially_submitted: '部分提交', submitted: '有效项已提交' } as const)[confirmation.data.status]} · 已关联 {confirmation.data.submittedSourceRows} / {confirmation.data.totalSourceRows} 条源行</p>}
      {showSellers && !historical && <div className="import-confirmation-setup">
        <div className="section-heading panel-heading"><div><h4>{wizard ? '店铺识别结果' : '1. 确认本次店铺'}</h4><p className="mapping-help">{wizard ? '唯一匹配已自动采用。仅需处理未匹配或有歧义的店铺；未解决或国家不一致的源行保留为错误，有效需求可继续提交。' : '按来源名称逐项选择并确认店铺与国家。本次确认仅用于此导入；未确认或国家不一致的源行会列入错误。'}</p><p className="mapping-help" role="status">{confirmation.isFetching ? '正在自动更新店铺信息…' : '识别基于当前店铺目录，修改对应关系后需重新生成差异。'}</p></div><Button type="button" variant="text" icon={RefreshCw} disabled={locked || confirmation.isFetching} onClick={refreshConfirmation}>重新识别店铺</Button></div>
        <div className="import-shop-selections">{confirmation.data.shops.map((shop, index) => {
          const selection = selectionFor(shop);
          const seller = confirmation.data.sellers.find((value) => value.id === selection.sellerMappingId);
          const countryConflict = seller && shop.countries.some((country) => country.normalize('NFKC').trim().toLowerCase() !== seller.country.normalize('NFKC').trim().toLowerCase());
          const confirmationChanged = selection.confirmed && (!seller || seller.status === 'disabled' || selection.confirmedVersion !== seller.version || selection.catalogSettingsVersion !== confirmation.data.catalog.version || selection.catalogVersion !== confirmation.data.catalog.catalogVersion);
          const checked = selection.confirmed && !confirmationChanged;
          return <div className="import-shop-selection" key={shop.sourceShop}>
            <div><strong>{shop.sourceShop}</strong><small className="mapping-subtext">{shop.rowCount} 条源行 · 来源国家：{shop.countries.join('、') || '未提供'}</small>{wizard && <small className={`mapping-subtext ${checked ? 'success-note' : 'warning-note'}`}>{checked ? selections[shop.sourceShop] ? '已采用人工选择' : '已自动识别并采用' : shop.resolution?.reason === 'country_mismatch' ? '来源国家与店铺国家不一致，请核对' : shop.resolution?.reason === 'conflicting_lookup_sids' ? '同一来源名称对应多个店铺，请区分来源名称后重新导入' : shop.resolution?.status === 'ambiguous' ? '存在多个匹配，请选择对应店铺' : '未识别到唯一店铺，请选择'}</small>}</div>
            <div className="field"><label htmlFor={`confirm-shop-${instanceId}-${index}`}>“{shop.sourceShop}”对应店铺</label><Combobox id={`confirm-shop-${instanceId}-${index}`} disabled={locked || !canManage || shop.resolution?.reason === 'conflicting_lookup_sids'} value={selection.sellerMappingId} onValueChange={(value) => { const chosen = confirmation.data.sellers.find((item) => item.id === value); setSelections((current) => ({ ...current, [shop.sourceShop]: { sellerMappingId: value, confirmed: Boolean(wizard && chosen), confirmedVersion: wizard ? chosen?.version : undefined, catalogSettingsVersion: wizard ? confirmation.data.catalog.version : undefined, catalogVersion: wizard ? confirmation.data.catalog.catalogVersion : undefined } })); changeDraft(); }} searchPlaceholder="搜索店铺名称、sid 或国家…" options={[{ value: '', label: '请选择店铺' }, ...confirmation.data.sellers.filter((value) => value.status !== 'disabled').map((value) => ({ value: value.id, label: `${value.name} · sid ${value.sid} · ${value.country}`, keywords: [value.name, String(value.sid), value.country] }))]} /></div>
            {!wizard && <label className="import-check"><input type="checkbox" disabled={locked || !seller || seller.status === 'disabled' || !canManage} checked={checked} onChange={(event) => { setSelections((current) => ({ ...current, [shop.sourceShop]: { ...selection, confirmed: event.target.checked, confirmedVersion: event.target.checked ? seller?.version : undefined, catalogSettingsVersion: event.target.checked ? confirmation.data.catalog.version : undefined, catalogVersion: event.target.checked ? confirmation.data.catalog.catalogVersion : undefined } })); changeDraft(); }} /><span>确认“{shop.sourceShop}”对应 {seller ? `${seller.name}（${seller.country}）` : '所选店铺'}</span></label>}
            {countryConflict && <p className="form-note warning-note">来源国家与所选店铺国家不一致。不一致的行将保留为错误，请修正原始内容后重新导入；其余有效行可以继续。</p>}
            {confirmationChanged && <p className="form-note warning-note" role="status">“{shop.sourceShop}”的店铺资料或目录版本已变化，请重新识别或选择当前店铺。</p>}
          </div>;
        })}</div>
        <details className="import-sheet-details"><summary>高级选项</summary><div className="field"><label htmlFor={baselineId}>缺失行对照文件（可选）</label><Combobox id={baselineId} value={baselineImportId} disabled={locked || !canManage} onValueChange={(value) => { setBaselineImportId(value); changeDraft(); }} searchPlaceholder="搜索历史文件名称或日期…" options={[{ value: '', label: '不指定历史文件' }, ...confirmation.data.baselines.filter((item) => item.id !== record.id).map((item) => ({ value: item.id, label: `${item.originalName} · ${item.businessDate}`, keywords: [item.originalName, item.businessDate] }))]} /><p className="mapping-help">指定历史文件后提示本次未出现的需求；缺失记录保留原需求和归属。</p></div></details>
        {wizard && <p className="mapping-help" role="status">已采用 {sellerSelections.length} / {confirmation.data.shops.length} 个来源店铺。至少解决一个店铺后可继续，其余源行保留在差异中供核对。</p>}
        {!wizard && previewAction}
        {createPreview.isError && <Feedback error={createPreview.error} refreshConfirmation={refreshConfirmation} />}
      </div>}
    </>}
    {showReview && !previewId && !historical && <p className="permission-note" role="status">尚无可核对的差异预览，请返回{wizard ? '填写与解析' : '店铺确认区域'}生成差异。</p>}
    {showReview && previewId && <div className="import-diff-section">
      <div className="section-heading panel-heading"><div><h4>{wizard ? '选择本次提交范围' : '2. 选择提交范围'}</h4><p>每行一票需求，黄色单元格标明变化。变化项须逐票确认后选择；错误、冲突和缺失项不提交。</p></div><Button type="button" variant="text" icon={RefreshCw} loading={preview.isFetching} disabled={preview.isFetching || locked} onClick={refreshPreview}>刷新差异</Button></div>
      {draftChanged && <p className="permission-note warning-note" role="status">本次店铺或对照文件已修改。请重新生成差异预览后提交。</p>}
      {preview.data && !previewMatchesRun && <p className="permission-note warning-note" role="status">此差异预览属于旧解析版本，请返回填写与解析，重新核对并生成预览。</p>}
      {preview.data && confirmation.data && !previewMatchesCatalog && <p className="permission-note warning-note" role="status">店铺来源设置或目录版本已变化，请按当前来源重新识别店铺并生成差异预览。</p>}
      {wizard && hasChangedConfirmation && <p className="permission-note warning-note" role="status">已采用店铺的身份或版本发生变化，请返回填写与解析，核对后重新生成差异。</p>}
      {preview.isPending ? <p className="list-state" role="status">正在读取差异预览…</p> : preview.isError ? <Feedback error={preview.error} retry={refreshPreview} /> : preview.data && <>
        <details className="import-sheet-details"><summary>预览信息与已采用店铺</summary><p className="mapping-help">预览生成于 {formatTime(preview.data.preview.createdAt)}（上海） · 解析版本 {preview.data.preview.importVersion} · {catalogModeLabels[preview.data.preview.sellerCatalogMode]} · 来源设置版本 {preview.data.preview.sellerCatalogSettingsVersion} · 目录版本 {preview.data.preview.sellerCatalogVersion}</p><ul className="import-source-locations">{preview.data.preview.mappings.map((mapping) => <li key={mapping.sourceShop}><strong>{mapping.sourceShop} → {mapping.name}</strong><span>sid {mapping.sid} · {mapping.country} · 店铺版本 {mapping.expectedVersion}</span><small>采用账号 {mapping.confirmedBy} · {formatTime(mapping.confirmedAt)}</small></li>)}</ul>{preview.data.preview.baselineImportId && <p>已选择历史文件作缺失对照。</p>}</details>
        <div className="import-diff-counts" aria-label="差异分类统计">{Object.entries(preview.data.preview.counts).map(([key, count]) => <span key={key}>{labels[key as ImportDiffItem['kind']]} <strong>{count}</strong></span>)}</div>
        <div className="import-diff-toolbar"><div className="field"><label htmlFor={diffKindId}>按差异分类筛选</label><SelectField id={diffKindId} value={kind} disabled={locked} onValueChange={(value) => { setKind(value); setPage(1); }} options={[{ value: '', label: '全部差异' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} /></div><Button type="button" icon={Download} loading={exportErrors.isPending} loadingLabel="正在整理错误…" disabled={exportErrors.isPending || busy} onClick={() => exportErrors.mutate()}>下载错误清单</Button></div>
        {exportErrors.isError && <Feedback error={exportErrors.error} />}
        <div className="import-selection-actions"><strong role="status">已选 {selected.length} 票</strong><Button type="button" icon={ListChecks} disabled={!canSubmit} onClick={() => changeSelected([...new Set([...selected, ...preview.data.items.filter(eligible).map((item) => item.id)])])}>选择本页可提交项</Button><Button type="button" icon={ListChecks} disabled={!canSubmit} onClick={() => changeSelected(preview.data.preview.selectableItemIds.filter((id) => !committedItemIds.has(id) && (!preview.data.preview.changedItemIds.includes(id) || confirmedChanges.includes(id))))}>选择全部可提交项</Button><Button type="button" variant="text" icon={RotateCcw} disabled={!selected.length || locked} onClick={() => changeSelected([])}>清空选择</Button></div>
        <p className="mapping-help">选择跨页保留。“选择全部”包含已逐票确认的变化项。</p>
        {preview.data.items.length ? <div className="table-scroll import-diff-scroll" role="region" aria-label="需求增量差异表，可横向滚动" tabIndex={0}><table className="task-table import-diff-table"><thead><tr><th scope="col">选择</th><th scope="col">分类</th><th scope="col">FBA 货件号</th>{Object.entries(fieldLabels).map(([field, label]) => <th scope="col" key={field}>{label}</th>)}<th scope="col">变化确认</th><th scope="col">来源位置 / 校验</th></tr></thead><tbody>{preview.data.items.map((item) => <DiffRow key={item.id} item={item} disabled={!canSubmit} checked={selected.includes(item.id)} eligible={eligible(item)} confirmed={confirmedChanges.includes(item.id)} onSelect={(checked) => changeSelected(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} onConfirm={(checked) => toggleChanged(item.id, checked)} openDemand={setOpenedDemandId} />)}</tbody></table></div> : <p className="list-state">没有符合此分类的差异项。</p>}
        <Pager page={page} total={preview.data.total} pageSize={preview.data.pageSize} disabled={preview.isFetching || locked} change={setPage} />
        {wizard ? <p className="mapping-help" role="status">将提交选中的 {selected.length} 票。核对后点击下方“确认提交所选需求”。</p> : <div className="import-submit-panel"><div><h4>3. 确认提交</h4><p>将提交选中的 {selected.length} 票；新增保存首个版本，相同内容补充来源，已确认变化保存新版本。</p></div>{submitAction}</div>}
        {commit.isError && <Feedback error={commit.error} preserveOperation refreshConfirmation={refreshConfirmation} />}
        {!wizard && lastResult && <CommitResult result={lastResult} openDemand={setOpenedDemandId} />}
      </>}
    </div>}
    {wizard?.step === 'complete' && <div className="import-completion">
      {result ? <CommitResult result={result} openDemand={setOpenedDemandId} compact /> : pendingSubmission ? <p className="mapping-help">请先恢复上次提交结果。</p> : commits.isPending ? <p className="list-state" role="status">正在恢复最近的提交结果…</p> : !commits.isError && <p className="permission-note">此导入尚无成功提交结果，可返回填写与解析继续处理。</p>}
      {commits.isError && <Feedback error={commits.error} retry={() => void commits.refetch()} />}
      {wizard.onContinueReview && (remainingCount > 0 || unresolvedCount > 0 || confirmation.data?.status === 'partially_submitted') && <div className="import-selection-actions"><p className="mapping-help">{remainingCount > 0 ? `此预览还有 ${remainingCount} 票有效需求未提交。` : unresolvedCount > 0 ? `此预览仍有 ${unresolvedCount} 项错误或冲突需要核对。` : '此导入仍有尚未提交的需求。'}</p><Button type="button" icon={ListChecks} disabled={locked} onClick={wizard.onContinueReview}>继续处理剩余需求</Button></div>}
      <details className="import-sheet-details"><summary>查看提交记录</summary>{commitHistory}</details>
    </div>}
    {!wizard && commitHistory}
    {wizard?.active !== false && wizard?.actionsContainer && wizard.step !== 'complete' && createPortal(wizard.step === 'input' ? previewAction : submitAction, wizard.actionsContainer)}
    {openedDemandId && <DemandHistory id={openedDemandId} close={() => setOpenedDemandId(null)} />}
  </div>;
}

function DiffRow({ item, disabled, checked, eligible, confirmed, onSelect, onConfirm, openDemand }: { item: ImportDiffItem; disabled: boolean; checked: boolean; eligible: boolean; confirmed: boolean; onSelect: (checked: boolean) => void; onConfirm: (checked: boolean) => void; openDemand: (id: string) => void }) {
  return <tr>
    <td><label className="import-check"><input type="checkbox" aria-label={`选择 ${item.fba ?? '错误行'} ${item.id}`} disabled={disabled || !eligible} checked={checked} onChange={(event) => onSelect(event.target.checked)} /><span className="sr-only">选择需求</span></label>{item.alreadyCommitted && <small className="mapping-subtext">已提交</small>}</td>
    <td><span className={`import-diff-kind import-diff-kind-${item.kind}`}>{labels[item.kind]}</span></td>
    <th scope="row"><strong>{item.fba ?? '缺少 FBA'}</strong><small className="mapping-subtext">sid {item.sid ?? '待确认'}{item.expectedDemandVersion ? ` · 当前版本 ${item.expectedDemandVersion}` : ''}</small>{item.demandId && <IconButton type="button" icon={Eye} label="查看需求版本与来源" description={item.fba ?? `需求 ${item.demandId}`} onClick={() => openDemand(item.demandId!)} />}</th>
    {Object.entries(fieldLabels).map(([field]) => {
    const key = field as keyof typeof fieldLabels;
    const before = item.before?.[key] ?? null;
    const after = item.after?.[key] ?? null;
    const changed = Boolean(item.before && item.after && before !== after);
    return <td key={field} className={changed ? 'import-diff-cell-changed' : undefined}>{changed ? <div className="import-diff-cell-values"><span>当前：{before ?? '空'}</span><strong>拟采用：{after ?? '空'}</strong></div> : (item.after ? after : before) ?? '—'}</td>;
    })}
    <td>{item.kind === 'changed' ? <label className="import-check"><input type="checkbox" aria-label={`确认 ${item.fba} 的变化`} disabled={disabled || item.alreadyCommitted || !item.selectable} checked={confirmed} onChange={(event) => onConfirm(event.target.checked)} /><span>已核对变化，确认保存新版本</span></label> : '—'}</td>
    <td><SourceLocations sources={item.sources} />{item.kind === 'missing' && <p className="mapping-help">本次文件未出现；原需求保留。</p>}{item.issues.length > 0 && <ul className="import-issues">{item.issues.map((issue, index) => <li className={issue.severity === 'error' ? 'error-note' : 'warning-note'} key={`${issue.code}:${index}`}>{issue.address ? `${issue.address}：` : ''}{issue.message}</li>)}</ul>}</td>
  </tr>;
}

function SourceLocations({ sources }: { sources: ImportDiffItem['sources'] }) {
  return <ul className="import-source-locations">{sources.map((source) => <li key={`${source.importId}:${source.parseRunId}:${source.rowId}`}><strong>{source.fileName}</strong><span>{source.sheetName} · 第 {source.rowNumber} 行</span>{source.addresses.length > 0 && <small>{source.addresses.join('、')}</small>}</li>)}</ul>;
}

function CommitResult({ result, openDemand, compact = false }: { result: ImportCommitResult; openDemand: (id: string) => void; compact?: boolean }) {
  const actionLabels = { created: '已新增', updated: '已保存新版本', linked: '已补充来源', already_committed: '此前已提交' };
  const items = <ul>{result.items.map((item) => <li key={item.itemId}><span>{actionLabels[item.action]} · {item.action === 'already_committed' ? '提交时当前需求版本' : '需求版本'} {item.version}</span><IconButton type="button" icon={Eye} label="查看需求版本与来源" description={`需求 ${item.demandId} · 版本 ${item.version}`} onClick={() => openDemand(item.demandId)} /><SourceLocations sources={item.sources} /></li>)}</ul>;
  return <div className="import-commit-result"><p className="permission-note success-note" role="status">{result.replayed ? '已恢复原提交结果。' : '需求已提交。'}新增 {result.counts.created} 票，新版本 {result.counts.updated} 票，补来源 {result.counts.linked} 票，此前已提交 {result.counts.alreadyCommitted} 票。</p>{compact ? <details className="import-sheet-details"><summary>查看本次 {result.items.length} 票提交明细</summary>{items}</details> : items}</div>;
}

function DemandHistory({ id, close }: { id: string; close: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['demand', id], queryFn: () => api.demand(id), retry: false });
  const sessionExpired = detail.error instanceof ApiError && detail.error.status === 401;
  useEffect(() => { if (sessionExpired) void queryClient.invalidateQueries({ queryKey: ['session'] }); }, [sessionExpired, queryClient]);
  return <section className="import-demand-history" aria-labelledby="import-demand-history-title"><div className="section-heading"><h4 id="import-demand-history-title">需求版本与来源</h4><IconButton type="button" icon={X} label="关闭需求详情" onClick={close} /></div>{detail.isPending ? <p className="list-state">正在读取需求历史…</p> : detail.isError ? <Feedback error={detail.error} retry={() => void detail.refetch()} /> : <>
    <p><strong>{detail.data.demand.snapshot.fba}</strong> · {detail.data.demand.snapshot.shop} · sid {detail.data.demand.snapshot.sid} · 当前版本 {detail.data.demand.version}</p>
    <p className="mapping-help">首次业务日期：{detail.data.demand.businessDate}</p>
    <ol className="import-demand-revisions">{detail.data.revisions.map((revision) => <li key={revision.version}><strong>版本 {revision.version}</strong><small className="mapping-subtext">{formatTime(revision.createdAt)} · 操作人 {revision.createdBy}</small><dl className="import-value-diff">{Object.entries(fieldLabels).map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{revision.snapshot[field as keyof typeof fieldLabels] ?? '空'}</dd></div>)}</dl></li>)}</ol>
    <h5>全部来源</h5><ul className="import-demand-sources">{detail.data.sources.map((entry) => <li key={`${entry.source.rowId}:${entry.acceptedVersion}`}><p>接受版本 {entry.acceptedVersion} · {formatTime(entry.createdAt)} · 操作人 {entry.createdBy}</p><SourceLocations sources={[entry.source]} /><p className="mapping-help">本次确认：{entry.mapping.sourceShop} → {entry.mapping.name} · sid {entry.mapping.sid} · {entry.mapping.country} · 店铺版本 {entry.mapping.expectedVersion}</p></li>)}</ul>
  </>}</section>;
}

function Feedback({ error, retry, preserveOperation = false, refreshConfirmation }: { error: unknown; retry?: () => void; preserveOperation?: boolean; refreshConfirmation?: () => void }) {
  return <div className="inline-error" role="alert"><div><p>{messageOf(error)}</p>{error instanceof ApiError && error.status === 409 && <><p>请刷新详情并重新生成差异，核对最新版本后选择提交。</p>{refreshConfirmation && <p>店铺资料变化时，先刷新本次店铺并重新逐项确认。</p>}</>}{preserveOperation && error instanceof ApiError && error.status === 0 && <p>本次选择与操作编号已保留，可再次点击提交重试。</p>}</div>{refreshConfirmation && error instanceof ApiError && error.status === 409 ? <Button type="button" icon={RefreshCw} onClick={refreshConfirmation}>刷新店铺并重新确认</Button> : retry && <Button type="button" icon={RefreshCw} onClick={retry}>重试</Button>}</div>;
}

function Pager({ page, total, pageSize, disabled, change }: { page: number; total: number; pageSize: number; disabled: boolean; change: (page: number) => void }) {
  return <div className="mapping-pagination"><span>共 {total} 项 · 第 {page} 页</span><div><IconButton type="button" icon={ChevronLeft} label="上一页" disabled={page === 1 || disabled} onClick={() => change(page - 1)} /><IconButton type="button" icon={ChevronRight} label="下一页" disabled={page * pageSize >= total || disabled} onClick={() => change(page + 1)} /></div></div>;
}
