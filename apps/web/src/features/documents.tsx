import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { scrollDocumentFieldIntoView } from './document-details-navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck, Download, FileCheck, FileSpreadsheet, History, LoaderCircle, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react';
import { DOCUMENT_ADDRESS_FIELDS, DOCUMENT_FIELD_OPTIONS, documentCurrencyForCountry, documentFieldsSchema, documentProductCurrency, documentTicketCurrency, hasDocumentAddressConflict, withDocumentDefaults, withDocumentInvoiceDefaults, type DocumentAutomationDeleteResponse, type DocumentAutomationJob, type Document as BusinessDocument, type DocumentExport, type DocumentListQuery, type DocumentRevisionData, type DocumentValidation } from '@scm/contracts';
import { ApiError, type SessionResponse } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { MonthPicker } from '../components/ui/month-picker';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';
import { BatchPagination, BatchTable, Check, downloadBlob, messageOf, newOperation, QueryError, timestamp } from './batch-shared';
import { documentApi, type DocumentDetails } from './document-api';
import { NewDocument } from './document-automation-source';
import { documentAutomationApi } from './document-automation-api';
import { DocumentAutomationDialog, DocumentAutomationRecent, useAutomationResume, useAutomationRetry } from './document-automation';
import type { AutomationFormState } from './document-automation-supplement';
import { documentDetailsReadiness, type DetailProgress } from './document-details-readiness';
import { DocumentField } from './document-fields';
import { DocumentAddressSection } from './document-address';
import { DocumentLingxing } from './document-lingxing';
import { DocumentProductImage } from './document-product-image';
import { DocumentSalesPrice, type ManualSalesPriceDrafts } from './document-sales-price';
import { DocumentBoxAdjustments } from './document-boxes';
import { invoiceBoxPreview, invoiceProductIdentity } from './document-invoice-preview';
import { ImportDialog } from './import-dialog';
import './documents.css';
import './document-wizard.css';

const documentLabels: Record<string, string> = { draft: '草稿', pending_review: '待复核', approved: '已通过', returned: '已退回', cancelled: '已取消', superseded: '已替代', stale: '已失效', queued: '排队中', running: '生成中', completed: '已生成', failed: '生成失败' };
const profileLabels: Record<string, string> = { product: '商品申报', party: '店铺主体', address: '收件地址', channel: '渠道服务', tax: '税务配置' };
const fieldGroups = [
  { title: '服务与币种', fields: [['service', '渠道服务'], ['currency', '币种'], ['deliveryStation', '交货仓站'], ['deliveryWindow', '送仓时间']] },
  { title: '收件地址', fields: [['addressCode', '地址代码'], ['recipientName', '收件人'], ['recipientCompany', '收件公司'], ['addressLine1', '地址第 1 行'], ['addressLine2', '地址第 2 行'], ['addressLine3', '地址第 3 行'], ['city', '城市'], ['state', '州 / 省'], ['postalCode', '邮编'], ['countryCode', '国家代码'], ['phone', '电话'], ['email', '邮箱']] },
  { title: '申报与税务', fields: [['customsMode', '报关方式'], ['clearanceMode', '清关方式'], ['taxMode', '税务方式'], ['vat', 'VAT'], ['battery', '含电池'], ['magnetic', '含磁性'], ['liquid', '含液体'], ['powder', '含粉末'], ['dangerous', '危险品'], ['remarks', '备注']] },
];
const friendlyFieldLabels: Record<string, string> = { ...Object.fromEntries(fieldGroups.flatMap((group) => group.fields)), englishName: '英文申报品名', chineseName: '中文申报品名', material: '材质', hsCode: 'HS 编码', use: '用途', brand: '品牌', model: '型号', unitPrice: '申报单价', salesLink: '销售链接', unit: '申报单位', imageBase64: '商品图片' };
const friendlyIssue = (message: string) => message.replace(/\b[A-Za-z][A-Za-z0-9]*\b/g, (word) => friendlyFieldLabels[word] || word);
const productFieldKeys = ['englishName', 'chineseName', 'material', 'hsCode', 'use', 'brand', 'model', 'unitPrice', 'salesLink', 'unit', 'currency'];
const optionalFields = new Set(['remarks', 'deliveryWindow', 'unit']);
const addressFieldKeys = new Set<string>(DOCUMENT_ADDRESS_FIELDS);
const sourceAddressConflictMessage = '来源中同一地址字段存在不同的非空值。请在“收件地址”中核对最终内容，记录采用依据并确认。';
const legacyPhysicalIssue = (code: string) => /^(?:M3_|PHYSICAL_CONFIRMATION_|DOCUMENT_PHYSICAL_)/.test(code);
const documentStages = [
  { value: 'sources', label: '货件与来源', description: '选择完整货件，核对来源版本与出单范围。' },
  { value: 'details', label: '单票资料', description: '补齐商品申报、收件地址、单票资料和模板，并保存修订。' },
  { value: 'generate', label: '校验与生成', description: '校验已保存版本，确认无阻塞后生成待复核发票。' },
  { value: 'review', label: '文件与复核', description: '下载具体文件，核对后记录复核结论，或查看历史。' },
] as const;
type DocumentStage = typeof documentStages[number]['value'];
type DocumentEditorState = { dirty: boolean; busy: boolean; detailsDirty?: boolean };
type DocumentEditorDraft = {
  documentId: string; baseVersion: number; fields: Record<string, string | null>;
  title?: string; templateId?: string; profileIds?: string[];
  addressReference?: DocumentRevisionData['profileReferences'][number] | null;
  addressReconfirmed: boolean; adoptCurrentProfileVersions: boolean; adoptCurrentTemplateVersion: boolean;
  reason: string; reviewReason: string; correctionIds?: string[];
  manualSalesPriceInputs?: ManualSalesPriceDrafts;
};
type DocumentEditorDraftRef = { current: DocumentEditorDraft | null };
const stageKey = (userId: string, documentId: string) => `scm-document-wizard:${userId}:${documentId}`;
function readDocumentStage(userId: string, documentId: string): DocumentStage | null {
  try { const saved: unknown = JSON.parse(sessionStorage.getItem(stageKey(userId, documentId)) ?? 'null'); return typeof saved === 'object' && saved !== null && 'stage' in saved && documentStages.some((item) => item.value === saved.stage) ? saved.stage as DocumentStage : null; } catch { return null; }
}
const inferDocumentStage = (record: BusinessDocument, exports: DocumentExport[]): DocumentStage => record.status === 'stale' ? 'sources' : exports.some((item) => item.status === 'queued' || item.status === 'running') ? 'generate' : ['pending_review', 'approved'].includes(record.status) && exports.some((item) => Boolean(item.fileId)) ? 'review' : 'details';
const documentEditingLocked = (record: BusinessDocument, exports: DocumentExport[]) => ['cancelled', 'superseded'].includes(record.status) || exports.some((item) => Boolean(item.fileId) || item.status === 'queued' || item.status === 'running');

const documentOccurrence = (data: Pick<DocumentRevisionData, 'shippingRunMonth' | 'shippingRunSequence'>) => data.shippingRunMonth ? `${data.shippingRunMonth} 第 ${data.shippingRunSequence ?? '待分配'} 次发货` : '未关联发货次';

function Status({ status }: { status: string }) {
  return <span className={`document-status document-status-${status}`}>{(status === 'running' || status === 'queued') && <LoaderCircle size={13} className="motion-spin" aria-hidden="true" />}{documentLabels[status] || status}</span>;
}

function useDocumentAction(conflictAction = '保存') {
  const client = useQueryClient();
  const operations = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const [notice, setNotice] = useState('');
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: async (input: { key: string; action: (operationId: string) => Promise<unknown>; success: string; done?: (value: unknown) => void }) => {
      if (!operations.current.has(input.key)) operations.current.set(input.key, newOperation());
      return input.action(operations.current.get(input.key)!);
    },
    onSuccess: async (result, input) => {
      operations.current.delete(input.key); setNotice(input.success); input.done?.(result);
      await Promise.all([client.invalidateQueries({ queryKey: ['documents'] }), client.invalidateQueries({ queryKey: ['document'] }), client.invalidateQueries({ queryKey: ['document-history'] }), client.invalidateQueries({ queryKey: ['document-candidates'] }), client.invalidateQueries({ queryKey: ['document-profiles'] }), client.invalidateQueries({ queryKey: ['document-templates'] })]);
    },
    onError: (error) => { setNotice(''); if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); },
    onSettled: () => { inFlight.current = false; },
  });
  const versionConflict = mutation.error instanceof ApiError && mutation.error.status === 409 && /VERSION_CONFLICT/.test(mutation.error.code ?? '');
  const resetMutation = mutation.reset;
  const reset = useCallback(() => { resetMutation(); setNotice(''); }, [resetMutation]);
  return {
    run: (key: string, action: (operationId: string) => Promise<unknown>, success: string, done?: (value: unknown) => void) => {
      // Lock immediately: two clicks can arrive before the pending state renders.
      if (inFlight.current) return;
      inFlight.current = true; setNotice(''); mutation.mutate({ key, action, success, done });
    },
    busy: mutation.isPending,
    pendingKey: mutation.isPending ? mutation.variables.key : undefined,
    error: mutation.error,
    conflict: versionConflict,
    reset,
    feedback: <>{mutation.isError && <p className="form-note error-note" role="alert"><CircleAlert size={16} aria-hidden="true" />{messageOf(mutation.error)}{versionConflict ? ` 请重新读取最新版本，核对后再次${conflictAction}。` : mutation.error instanceof ApiError && mutation.error.status === 409 ? '' : ' 内容已保留，可核对后重试。'}</p>}{notice && <p className="form-note success-note" role="status"><CircleCheck size={16} aria-hidden="true" />{notice}</p>}</>,
  };
}

export function DocumentsWorkspace({ active = true }: { active?: boolean }) {
  const client = useQueryClient();
  const search = useSearch({ strict: false });
  const initialDocumentId = typeof search.documentId === 'string' ? search.documentId : '';
  const userId = client.getQueryData<SessionResponse>(['session'])?.user?.id ?? 'anonymous';
  const [mode, setMode] = useState<'new' | 'detail' | null>(initialDocumentId ? 'detail' : null);
  const [documentId, setDocumentId] = useState(initialDocumentId);
  const [wizardOpen, setWizardOpen] = useState(Boolean(initialDocumentId));
  const [newSession, setNewSession] = useState(0);
  const [editorSession, setEditorSession] = useState(0);
  const [automaticJobId, setAutomaticJobId] = useState('');
  const [automaticOpen, setAutomaticOpen] = useState(false);
  const [automationFormState, setAutomationFormState] = useState<AutomationFormState>({ dirty: false, busy: false });
  const automationFormRef = useRef(automationFormState);
  const automationDiscard = useRef<() => void>(() => {});
  const onAutomationFormState = useCallback((next: AutomationFormState) => { automationFormRef.current = next; setAutomationFormState((previous) => previous.dirty === next.dirty && previous.busy === next.busy ? previous : next); }, []);
  const registerAutomationDiscard = useCallback((discard: () => void) => { automationDiscard.current = discard; }, []);
  const [automaticEdit, setAutomaticEdit] = useState<{ jobId: string; itemId: string; documentId: string } | null>(null);
  const automaticContinuation = useAutomationRetry();
  const automaticStart = useDocumentAction('自动出单');
  const [progress, setProgress] = useState<{ id: string; stage: DocumentStage } | null>(null);
  const [editorState, setEditorState] = useState<DocumentEditorState>({ dirty: false, busy: false });
  const editorDraft = useRef<DocumentEditorDraft | null>(null);
  const editorStateRef = useRef(editorState);
  const onEditorState = useCallback((next: DocumentEditorState) => { editorStateRef.current = next; setEditorState((old) => old.dirty === next.dirty && old.busy === next.busy && old.detailsDirty === next.detailsDirty ? old : next); }, []);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pendingSwitch = useRef<(() => void) | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const progressNav = useRef<HTMLElement>(null);
  const [newDocumentActions, setNewDocumentActions] = useState<HTMLDivElement | null>(null);
  const running = active && wizardOpen;
  const detail = useQuery({ queryKey: ['document', documentId], queryFn: () => documentApi.get(documentId), enabled: running && mode === 'detail' && Boolean(documentId), retry: false, refetchInterval: (query) => running && mode === 'detail' && query.state.data?.exports.some((item) => item.status === 'queued' || item.status === 'running') ? 1500 : false });
  const stage: DocumentStage = mode === 'new' ? 'sources' : progress?.id === documentId ? progress.stage : 'details';
  const stageIndex = documentStages.findIndex((item) => item.value === stage);
  const chooseStage = (next: DocumentStage, saved = false) => {
    if ((!saved && editorStateRef.current.busy) || mode !== 'detail') return;
    if (!saved && editorStateRef.current.detailsDirty && (next === 'generate' || next === 'review')) return;
    setProgress({ id: documentId, stage: next });
    try { sessionStorage.setItem(stageKey(userId, documentId), JSON.stringify({ stage: next })); } catch { /* The mounted wizard retains its stage. */ }
  };
  const switchTo = (next: () => void) => {
    if (editorStateRef.current.busy || automationFormRef.current.busy) return;
    if (editorStateRef.current.dirty || automationFormRef.current.dirty) { pendingSwitch.current = next; setConfirmDiscard(true); setWizardOpen(true); }
    else next();
  };
  const showAutomaticJob = (job: DocumentAutomationJob) => {
    automaticContinuation.reset();
    client.setQueryData(['document-automation', job.id], { job });
    void client.invalidateQueries({ queryKey: ['document-automations'] });
    onEditorState({ dirty: false, busy: false }); editorDraft.current = null;
    setMode(null); setDocumentId(''); setProgress(null); setWizardOpen(false);
    setAutomaticEdit(null); setAutomaticJobId(job.id); setAutomaticOpen(true);
  };
  const resumeAutomaticJob = (job: DocumentAutomationJob) => {
    automaticContinuation.reset(); automaticStart.reset();
    client.setQueryData(['document-automation', job.id], { job });
    void client.invalidateQueries({ queryKey: ['document-automations'] });
    setWizardOpen(false); setAutomaticEdit(null); setAutomaticJobId(job.id); setAutomaticOpen(true);
  };
  const automaticResume = useAutomationResume(automaticStart.error, resumeAutomaticJob, { active });
  const open = (id: string, preferredStage?: DocumentStage) => {
    if (mode === 'detail' && documentId === id) { setWizardOpen(true); return; }
    const next = () => { onEditorState({ dirty: false, busy: false }); setDocumentId(id); setMode('detail'); setWizardOpen(true); setProgress(preferredStage ? { id, stage: preferredStage } : null); if (preferredStage) { try { sessionStorage.setItem(stageKey(userId, id), JSON.stringify({ stage: preferredStage })); } catch { /* In-memory stage remains available. */ } } };
    if (preferredStage) next(); else switchTo(next);
  };
  const startNew = () => switchTo(() => { onEditorState({ dirty: false, busy: false }); setAutomaticEdit(null); setMode('new'); setDocumentId(''); setProgress(null); setNewSession((current) => current + 1); setWizardOpen(true); });
  const edit = (record: BusinessDocument) => {
    if (record.status === 'draft' && record.currentRevision.data.shippingRunId) {
      switchTo(() => {
        const input = { shippingRunId: record.currentRevision.data.shippingRunId, documentId: record.id, expectedVersion: record.version };
        automaticStart.run(`automatic-existing:${JSON.stringify(input)}`, (operationId) => documentAutomationApi.start({ operationId, ...input }), '自动出单任务已开始。', (value) => showAutomaticJob((value as { job: DocumentAutomationJob }).job));
      }); return;
    }
    const targetStage = record.status === 'draft' ? 'details' : 'sources';
    if (mode === 'detail' && documentId === record.id) { chooseStage(targetStage); setWizardOpen(true); }
    else switchTo(() => open(record.id, targetStage));
  };
  const deleted = (id: string) => {
    try { sessionStorage.removeItem(stageKey(userId, id)); } catch { /* The deleted record is no longer a resumable editor. */ }
    client.removeQueries({ queryKey: ['document', id], exact: true });
    if (mode !== 'detail' || documentId !== id) return;
    editorDraft.current = null;
    onEditorState({ dirty: false, busy: false }); setMode(null); setDocumentId(''); setProgress(null); setWizardOpen(false); setAutomaticEdit(null);
  };
  const automationDeleted = (result: DocumentAutomationDeleteResponse) => {
    result.cancelledDocumentIds.forEach(deleted);
    if (automaticJobId !== result.automationId && automaticEdit?.jobId !== result.automationId) return;
    automaticContinuation.reset(); setAutomaticJobId(''); setAutomaticOpen(false); setAutomaticEdit(null);
    onAutomationFormState({ dirty: false, busy: false });
  };
  const close = () => { if (active && wizardOpen && !editorStateRef.current.busy && !automaticContinuation.busy && !confirmDiscard) { setWizardOpen(false); if (automaticEdit) setAutomaticOpen(true); } };
  const editAutomaticItem = (id: string, itemId: string) => switchTo(() => {
    automaticContinuation.reset(); setAutomaticOpen(false); setAutomaticEdit({ jobId: automaticJobId, itemId, documentId: id });
    open(id, 'details'); setProgress({ id, stage: 'details' });
  });
  const viewAutomaticItem = (id: string) => switchTo(() => { setAutomaticOpen(false); setAutomaticEdit(null); open(id, 'review'); setProgress({ id, stage: 'review' }); });
  const continueAutomatic = (saved?: BusinessDocument) => {
    if (!automaticEdit || automaticContinuation.busy) return;
    const version = saved?.version ?? detail.data?.document.version;
    if (!version) return;
    void automaticContinuation.run(automaticEdit.jobId, [automaticEdit.itemId], `saved:${automaticEdit.documentId}:${version}`).then(showAutomaticJob).catch(() => {});
  };
  const blocker = useBlocker({ shouldBlockFn: ({ current, next }) => {
    const nextDocumentId = 'documentId' in next.search ? next.search.documentId : undefined;
    return (editorStateRef.current.dirty || editorStateRef.current.busy || automationFormRef.current.dirty || automationFormRef.current.busy) && (current.pathname !== next.pathname || typeof nextDocumentId === 'string' && nextDocumentId !== documentId);
  }, enableBeforeUnload: editorState.dirty || editorState.busy || automationFormState.dirty || automationFormState.busy, withResolver: true });
  useEffect(() => {
    if (blocker.status !== 'blocked') return;
    pendingSwitch.current = () => { setConfirmDiscard(false); blocker.proceed(); };
    setConfirmDiscard(true); setWizardOpen(true);
  }, [blocker.status, blocker.proceed]);
  useEffect(() => {
    if (!detail.data || mode !== 'detail' || progress?.id === documentId) return;
    const restored = readDocumentStage(userId, documentId) ?? inferDocumentStage(detail.data.document, detail.data.exports);
    setProgress({ id: documentId, stage: restored });
  }, [detail.data, documentId, mode, progress?.id, userId]);
  const linkedDocument = useRef(initialDocumentId);
  useEffect(() => {
    if (!active || !initialDocumentId || initialDocumentId === linkedDocument.current) return;
    linkedDocument.current = initialDocumentId;
    open(initialDocumentId);
  });
  useEffect(() => {
    if (!running) return;
    const frame = requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true }); heading.current?.closest('.import-dialog-body')?.scrollTo({ top: 0 });
      const nav = progressNav.current, current = nav?.querySelector<HTMLElement>('[aria-current="step"]');
      if (nav && current) { const bounds = nav.getBoundingClientRect(), item = current.getBoundingClientRect(); if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right; else if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left; }
    });
    return () => cancelAnimationFrame(frame);
  }, [running, stage, mode, documentId]);
  const discard = () => { if (editorStateRef.current.busy || automationFormRef.current.busy) return; automationDiscard.current(); editorDraft.current = null; const next = pendingSwitch.current; pendingSwitch.current = null; setConfirmDiscard(false); setEditorSession((current) => current + 1); onEditorState({ dirty: false, busy: false }); next?.(); };
  const continueEditing = () => { if (editorStateRef.current.busy || automationFormRef.current.busy) return; pendingSwitch.current = null; setConfirmDiscard(false); if (automationFormRef.current.dirty && !editorStateRef.current.dirty) { setWizardOpen(false); setAutomaticOpen(true); } if (blocker.status === 'blocked') blocker.reset(); };
  return <div className="documents-workspace">
    <header className="document-page-heading"><div><h2>发票与单据</h2><p className="mapping-help">多选货件统一检查、集中补齐后，每张发票生成独立 Excel 文件并打包为 ZIP；混装票下载后修改。</p></div><div className="document-footer-actions">{mode && <Button type="button" icon={ArrowRight} disabled={editorState.busy || automaticStart.busy || automaticResume.busy || automaticContinuation.busy} onClick={() => { setAutomaticOpen(false); setWizardOpen(true); }}>继续本次制作</Button>}<Button type="button" icon={Plus} variant="primary" disabled={editorState.busy || automaticStart.busy || automaticResume.busy || automaticContinuation.busy} onClick={startNew}>制作发票</Button></div></header>
    {automaticStart.feedback}
    {automaticResume.feedback}
    <DocumentAutomationRecent active={active && !wizardOpen && !automaticOpen} disabled={editorState.busy || automaticStart.busy || automaticResume.busy || automaticContinuation.busy} open={(id) => switchTo(() => { setAutomaticJobId(id); setAutomaticOpen(true); })} requestDelete={(next) => switchTo(() => { setWizardOpen(false); setAutomaticOpen(false); next(); })} deleted={automationDeleted} />
    <DocumentRecords active={active && !wizardOpen && !automaticOpen} busy={editorState.busy || automaticStart.busy || automaticResume.busy} startNew={startNew} open={open} edit={edit} deleted={deleted} requestDelete={(record, next) => { if (mode === 'detail' && documentId === record.id) switchTo(() => { setWizardOpen(false); next(); }); else next(); }} />
    {createPortal(<ImportDialog open={running || confirmDiscard} title="发票与单据向导" close={close} closeDisabled={editorState.busy || automaticContinuation.busy || confirmDiscard} wide><div className="document-wizard">
      {mode === 'detail' && !automaticEdit && <nav ref={progressNav} className="import-wizard-progress" aria-label="单据制作步骤"><ol>{documentStages.map((item, index) => <li key={item.value} data-current={stage === item.value}><button type="button" aria-current={stage === item.value ? 'step' : undefined} disabled={editorState.busy || confirmDiscard || mode === 'detail' && (!detail.data || Boolean(editorState.detailsDirty) && (item.value === 'generate' || item.value === 'review'))} onClick={() => chooseStage(item.value)}><span className="wizard-step-number" aria-hidden="true">{index + 1}</span><span>{item.label}</span></button></li>)}</ol></nav>}
      <div className="import-wizard-heading"><div><h3 ref={heading} tabIndex={-1}>{mode === 'new' ? '制作发票' : automaticEdit ? '补充出单资料' : documentStages[stageIndex]!.label}</h3><p>{mode === 'new' ? '选择货件，再填写本次出单资料；统一检查通过后生成独立 Excel 文件并打包为 ZIP。' : automaticEdit ? '补齐本票缺项后，保存并继续后台自动出单。' : documentStages[stageIndex]!.description}</p></div></div>
      {confirmDiscard && <div className="document-cancel-confirm" role="alert"><p>当前有未保存的填写。继续编辑可保留本次内容；放弃后切换只保留已保存的版本。</p><div className="document-footer-actions"><Button type="button" disabled={editorState.busy} onClick={continueEditing}>继续编辑当前单据</Button><Button type="button" disabled={editorState.busy} onClick={discard}>放弃未保存修改并继续</Button></div></div>}
      {automaticContinuation.error && <p className="form-note error-note" role="alert">{messageOf(automaticContinuation.error)} 已保存的资料会保留，可点击“继续自动出单”重试。</p>}
      <fieldset className="document-wizard-fieldset" disabled={confirmDiscard || automaticContinuation.busy} inert={confirmDiscard}>
        {mode === 'new' && <NewDocument key={newSession} active={running} started={showAutomaticJob} resume={resumeAutomaticJob} onEditorState={onEditorState} actionsContainer={newDocumentActions} close={close} blocked={confirmDiscard} />}
        {mode === 'detail' && (detail.isPending ? <p className="list-state" role="status">正在读取单据及版本…</p> : detail.isError ? <QueryError error={detail.error} retry={() => void detail.refetch()} /> : <DocumentEditor key={`${detail.data.document.id}-${detail.data.document.version}-${editorSession}-${documentEditingLocked(detail.data.document, detail.data.exports)}`} record={detail.data.document} draftRef={editorDraft} validation={detail.data.validation} exports={detail.data.exports} active={running} stage={stage} onEditorState={onEditorState} reload={() => void detail.refetch()} corrected={(id) => open(id, 'details')} actionsContainer={newDocumentActions} close={close} blocked={confirmDiscard || automaticContinuation.busy} automatic={automaticEdit?.documentId === documentId ? { continue: continueAutomatic, busy: automaticContinuation.busy } : undefined} advance={() => chooseStage('generate', true)} back={() => chooseStage('sources')} />)}
      </fieldset>
      <footer className="import-wizard-footer" data-stage={stage}><p className="mapping-help">{mode === 'new' ? '核对货件与出单资料后开始；任务开始后关闭页面也会继续处理。' : editorState.detailsDirty ? '有未保存的资料，请保存后继续；保存失败会保留本次填写。' : '关闭后可继续本次制作，已保存资料可进入下一步核对。'}</p><div ref={setNewDocumentActions}>{mode === 'detail' && stage !== 'details' && <><Button type="button" icon={ArrowLeft} disabled={stageIndex === 0 || editorState.busy || confirmDiscard} onClick={() => chooseStage(documentStages[stageIndex - 1]!.value)}>上一步</Button><Button type="button" icon={X} disabled={editorState.busy || confirmDiscard} onClick={close}>暂时关闭</Button><Button type="button" icon={ArrowRight} variant="primary" disabled={stageIndex === documentStages.length - 1 || editorState.busy || confirmDiscard || !detail.data || Boolean(editorState.detailsDirty) && stageIndex >= 1} onClick={() => chooseStage(documentStages[stageIndex + 1]!.value)}>下一步</Button></>}</div></footer>
    </div></ImportDialog>, document.body)}
    {createPortal(<DocumentAutomationDialog active={active && automaticOpen} jobId={automaticJobId} close={() => setAutomaticOpen(false)} edit={editAutomaticItem} view={viewAutomaticItem} blocked={confirmDiscard} onFormState={onAutomationFormState} registerDiscard={registerAutomationDiscard} />, document.body)}
  </div>;
}

type DocumentFilters = { q: string; status: DocumentListQuery['status']; month: string };
const emptyDocumentFilters: DocumentFilters = { q: '', status: 'active', month: '' };
function DocumentRecords({ active, busy, startNew, open, edit, requestDelete, deleted }: {
  active: boolean; busy: boolean; startNew: () => void; open: (id: string) => void; edit: (record: BusinessDocument) => void;
  requestDelete: (record: BusinessDocument, next: () => void) => void; deleted: (id: string) => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [draftFilters, setDraftFilters] = useState(emptyDocumentFilters);
  const [filters, setFilters] = useState(emptyDocumentFilters);
  const [deleteTarget, setDeleteTarget] = useState<BusinessDocument | null>(null);
  const [reason, setReason] = useState('');
  const action = useDocumentAction('删除');
  const refreshTarget = useMutation({ networkMode: 'always', mutationFn: documentApi.get, onSuccess: async (value) => { setDeleteTarget(value.document); action.reset(); await client.invalidateQueries({ queryKey: ['documents'] }); }, onError: (error) => { if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); } });
  const locked = busy || action.busy || refreshTarget.isPending;
  const list = useQuery({ queryKey: ['documents', filters, page], queryFn: () => documentApi.list(page, 20, { ...filters, month: filters.month || undefined }), enabled: active, retry: false });
  const hasFilter = Boolean(filters.q || filters.month || filters.status !== 'active');
  const filtersDirty = draftFilters.q.trim() !== filters.q || draftFilters.status !== filters.status || draftFilters.month !== filters.month;
  useEffect(() => { if (list.data && page > Math.max(1, Math.ceil(list.data.total / 20))) setPage(Math.max(1, Math.ceil(list.data.total / 20))); }, [list.data, page]);
  const reset = () => { setDraftFilters(emptyDocumentFilters); setFilters(emptyDocumentFilters); setPage(1); };
  const closeDelete = () => { if (locked) return; setDeleteTarget(null); setReason(''); refreshTarget.reset(); action.reset(); };
  const beginDelete = (record: BusinessDocument) => requestDelete(record, () => { action.reset(); refreshTarget.reset(); setReason(''); setDeleteTarget(record); });
  const remove = (event: FormEvent) => {
    event.preventDefault();
    if (!deleteTarget || locked || action.conflict || !reason.trim() || ['cancelled', 'superseded'].includes(deleteTarget.status)) return;
    const input = { expectedVersion: deleteTarget.version, reason: reason.trim() };
    action.run(`delete:${deleteTarget.id}:${JSON.stringify(input)}`, (operationId) => documentApi.cancel(deleteTarget.id, { operationId, ...input }), '单据已删除并标记为已取消，货件占用已释放。', () => {
      deleted(deleteTarget.id); setDeleteTarget(null); setReason('');
      if (list.data?.items.length === 1 && page > 1) setPage((current) => current - 1);
    });
  };
  return <section className="content-panel document-list-panel" aria-labelledby="document-list-title">
    <div className="section-heading"><h3 id="document-list-title">单据记录</h3><IconButton icon={RefreshCw} label="刷新单据列表" loading={list.isFetching} disabled={locked} onClick={() => void list.refetch()} /></div>
    <form className="document-record-filters" onSubmit={(event) => { event.preventDefault(); setFilters({ ...draftFilters, q: draftFilters.q.trim() }); setPage(1); }}>
      <div className="field"><label htmlFor={`${id}-search`}>搜索单据</label><Input id={`${id}-search`} maxLength={200} value={draftFilters.q} disabled={locked} onChange={(event) => setDraftFilters((current) => ({ ...current, q: event.target.value }))} placeholder="单据名称、编号、FBA、店铺或订单号" /></div>
      <div className="field"><label htmlFor={`${id}-status`}>单据状态</label><SelectField id={`${id}-status`} disabled={locked} value={draftFilters.status} onValueChange={(value) => setDraftFilters((current) => ({ ...current, status: value as DocumentFilters['status'] }))} options={[{ value: 'active', label: '当前单据' }, { value: 'all', label: '全部状态' }, ...['draft', 'pending_review', 'approved', 'returned', 'stale', 'cancelled', 'superseded'].map((value) => ({ value, label: documentLabels[value]! }))]} /></div>
      <div className="field"><label htmlFor={`${id}-month`}>来源月份</label><MonthPicker id={`${id}-month`} value={draftFilters.month} disabled={locked} onValueChange={(value) => setDraftFilters((current) => ({ ...current, month: value }))} /></div>
      <div className="document-record-filter-actions"><Button type="submit" icon={Search} loading={list.isFetching} disabled={locked}>搜索</Button><Button type="button" disabled={locked} onClick={reset}>重置</Button></div>
    </form>
    <p className="mapping-help" role="status">{filtersDirty ? '筛选条件已修改，请点击搜索更新列表。' : filters.status === 'active' ? '当前单据不含已取消或被替代的记录，可切换状态查询历史。' : '按已应用条件显示单据，打开单据可查看历史版本与文件。'}</p>
    {!deleteTarget && action.feedback}
    {list.isPending ? <p className="list-state" role="status">正在读取单据记录…</p> : list.isError ? <QueryError error={list.error} retry={() => void list.refetch()} /> : list.data.items.length === 0 ? <div className="document-empty"><FileSpreadsheet size={28} aria-hidden="true" /><h3>{hasFilter ? '没有匹配的单据' : '还没有当前单据'}</h3><p>{hasFilter ? '请调整单据关键词、状态或发货月份后重新搜索。' : '选择本次发货的完整 FBA 保存草稿，之后继续补齐资料和生成文件；历史记录可通过状态筛选查询。'}</p>{hasFilter ? <Button icon={RefreshCw} onClick={reset}>重置筛选</Button> : <Button icon={Plus} variant="primary" onClick={startNew}>制作第一张发票</Button>}</div> : <>
      <BatchTable label="单据记录" headers={['单据 / 发货次', '状态', '货件 / 店铺', '当前版本 / 更新时间', '操作']}>{list.data.items.map((record) => {
        const readOnly = ['cancelled', 'superseded'].includes(record.status);
        return <tr key={record.id}><td><strong>{record.currentRevision.data.title}</strong><small className="mapping-subtext">{documentOccurrence(record.currentRevision.data)}</small><small className="mapping-subtext document-record-id">编号 {record.id}</small>{record.currentRevision.data.fields.orderNumber && <small className="mapping-subtext">订单 {record.currentRevision.data.fields.orderNumber}</small>}</td><td><Status status={record.status} /></td><td>{record.currentRevision.data.members.length} 个 FBA · {new Set(record.currentRevision.data.members.map((member) => member.source.groupId)).size} 组<small className="mapping-subtext">{record.currentRevision.data.members.map((member) => member.demand.snapshot.fba).join('、')}</small><small className="mapping-subtext">{[...new Set(record.currentRevision.data.members.map((member) => member.demand.snapshot.shop))].join('、')}</small></td><td>v{record.version}<small className="mapping-subtext">{timestamp(record.updatedAt)}</small></td><td><div className="document-record-actions"><Button type="button" icon={ArrowRight} disabled={locked} onClick={() => open(record.id)}>查看单据</Button>{!readOnly && <Button type="button" icon={Pencil} variant="text" disabled={locked} onClick={() => edit(record)}>{record.status === 'draft' ? record.currentRevision.data.shippingRunId ? '自动生成发票' : '编辑单据' : '更正单据'}</Button>}<Button type="button" icon={Trash2} variant="text" disabled={locked || readOnly} onClick={() => beginDelete(record)}>删除单据</Button></div></td></tr>;
      })}</BatchTable><BatchPagination page={page} pageSize={20} total={list.data.total} change={setPage} />
    </>}
    {createPortal(<ImportDialog open={active && Boolean(deleteTarget)} title="删除单据" close={closeDelete} closeDisabled={locked}>{deleteTarget && <form className="document-delete-form" onSubmit={remove}>
      <h3>{deleteTarget.currentRevision.data.title}</h3><p className="mapping-help">编号 {deleteTarget.id} · v{deleteTarget.version} · {documentLabels[deleteTarget.status]}</p>
      <p>删除后标记为已取消，从当前单据中移出并释放货件占用。单据、修订和已生成文件仍保留，可按“已取消”查询；原制表组的冻结保持。</p>
      <div className="field"><label htmlFor={`${id}-delete-reason`}>删除原因</label><Input id={`${id}-delete-reason`} autoFocus required maxLength={1000} value={reason} disabled={locked} onChange={(event) => setReason(event.target.value)} /></div>
      {action.feedback}
      {action.conflict && <div className="document-delete-conflict"><p role="status">未确认删除成功。请重新读取并核对状态与版本，再决定是否删除。</p><Button type="button" icon={RefreshCw} loading={refreshTarget.isPending} onClick={() => refreshTarget.mutate(deleteTarget.id)}>重新读取删除目标</Button></div>}
      {refreshTarget.isError && <p className="form-note error-note" role="alert">{messageOf(refreshTarget.error)} 删除原因已保留，可重试读取。</p>}
      {['cancelled', 'superseded'].includes(deleteTarget.status) && <p className="mapping-help" role="status">该单据已结束，历史记录只读，无需再次删除。</p>}
      <div className="document-footer-actions"><Button type="button" disabled={locked} onClick={closeDelete}>保留单据</Button><Button type="submit" icon={Trash2} className="document-delete-submit" loading={action.busy} loadingLabel="正在删除…" disabled={locked || action.conflict || !reason.trim() || ['cancelled', 'superseded'].includes(deleteTarget.status)}>确认删除</Button></div>
    </form>}</ImportDialog>, document.body)}
  </section>;
}

function DocumentEditor({ record, draftRef, validation, exports, active, stage, onEditorState, reload, corrected, actionsContainer, close, blocked, advance, back, automatic }: { record: BusinessDocument; draftRef: DocumentEditorDraftRef; validation: DocumentValidation | null; exports: DocumentExport[]; active: boolean; stage: DocumentStage; onEditorState: (state: DocumentEditorState) => void; reload: () => void; corrected: (id: string) => void; actionsContainer: HTMLDivElement | null; close: () => void; blocked: boolean; advance: () => void; back: () => void; automatic?: { continue: (saved?: BusinessDocument) => void; busy: boolean } }) {
  const id = useId();
  const client = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const continueAfterSave = useRef(false);
  const editor = useRef<HTMLDivElement>(null);
  const [boxRevealRequest, setBoxRevealRequest] = useState<{ field: string; requestId: number }>();
  const data = record.currentRevision.data;
  const invoiceV2 = data.generationRulesVersion === 'v2';
  const preserveSavedFields = documentEditingLocked(record, exports);
  const normalizeFields = (value: Record<string, string | null>) => preserveSavedFields ? withDocumentDefaults(value) : withDocumentInvoiceDefaults(value, data.members);
  const automaticCurrency = preserveSavedFields ? undefined : documentTicketCurrency(data.members);
  const mixedCurrencies = !preserveSavedFields && new Set(data.members.map((member) => documentCurrencyForCountry(member.demand.snapshot.country)).filter(Boolean)).size > 1;
  const [recoverableDraft, setRecoverableDraft] = useState(() => draftRef.current?.documentId === record.id ? draftRef.current : null);
  const [title, setTitle] = useState(data.title);
  const [fields, setFields] = useState<Record<string, string | null>>(() => normalizeFields(data.fields));
  const [manualSalesPriceInputs, setManualSalesPriceInputs] = useState<ManualSalesPriceDrafts>({});
  const [templateId, setTemplateId] = useState(data.templateReference?.templateId || '');
  const [profileIds, setProfileIds] = useState(data.profileReferences.filter((item) => item.category !== 'address').map((item) => item.profileId));
  const [addressReference, setAddressReference] = useState<DocumentRevisionData['profileReferences'][number] | null>(data.profileReferences.find((item) => item.category === 'address') ?? null);
  const [addressReconfirmed, setAddressReconfirmed] = useState(false);
  const [adoptCurrentProfileVersions, setAdoptCurrentProfileVersions] = useState(false);
  const [adoptCurrentTemplateVersion, setAdoptCurrentTemplateVersion] = useState(false);
  const [reason, setReason] = useState('补齐发票资料');
  const [reviewReason, setReviewReason] = useState('');
  const [latestValidation, setLatestValidation] = useState<DocumentValidation | null>(validation);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showCorrection, setShowCorrection] = useState(false);
  const [correctionIds, setCorrectionIds] = useState(data.members.map((member) => member.source.demandId));
  const [profileNotice, setProfileNotice] = useState('');
  const [reviewExportId, setReviewExportId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lingxingBusy, setLingxingBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const { products, keyError, productsLoading } = useProductIdentities(data);
  useEffect(() => {
    if (invoiceV2 || preserveSavedFields || productsLoading || !automaticCurrency || documentProductCurrency('', data.fields.currency) === automaticCurrency) return;
    setFields((current) => {
      const next = { ...current };
      let changed = false;
      for (const product of products) {
        const profile = findProductProfile(data.profileReferences, product);
        const currency = current[product.prefix + 'currency'] ?? profileValue(profile, 'currency');
        const confirmed = current[product.prefix + 'unitPriceConfirmed'] ?? profileValue(profile, 'unitPriceConfirmed');
        if (!currency?.trim() && confirmed === 'true') { next[product.prefix + 'unitPriceConfirmed'] = 'false'; changed = true; }
      }
      return changed ? next : current;
    });
  }, [invoiceV2, preserveSavedFields, productsLoading, automaticCurrency, data, products]);
  const action = useDocumentAction();
  const busy = action.busy || lingxingBusy || imageBusy;
  const profiles = useQuery({ queryKey: ['document-profiles'], queryFn: () => documentApi.profiles(), enabled: active, retry: false });
  const templates = useQuery({ queryKey: ['document-templates'], queryFn: documentApi.templates, enabled: active, retry: false });
  const fieldOptions = useQuery({ queryKey: ['document-field-options'], queryFn: documentApi.fieldOptions, enabled: active, retry: false });
  const candidates = useQuery({ queryKey: ['document-candidates', data.shippingRunId], queryFn: () => documentApi.candidates(data.shippingRunId), enabled: active && showCorrection, retry: false });
  const history = useQuery({ queryKey: ['document-history', record.id, record.version], queryFn: () => documentApi.history(record.id), enabled: active && historyOpen, retry: false });
  const readOnly = ['cancelled', 'superseded'].includes(record.status);
  const actualDirty = Object.keys(manualSalesPriceInputs).length > 0 || title !== data.title || JSON.stringify(fields) !== JSON.stringify(withDocumentDefaults(data.fields)) || templateId !== (data.templateReference?.templateId || '') || JSON.stringify([...profileIds].sort()) !== JSON.stringify(data.profileReferences.filter((item) => item.category !== 'address').map((item) => item.profileId).sort()) || JSON.stringify(addressReference) !== JSON.stringify(data.profileReferences.find((item) => item.category === 'address') ?? null) || addressReconfirmed || adoptCurrentProfileVersions || adoptCurrentTemplateVersion;
  const dirty = actualDirty || Boolean(recoverableDraft);
  const currentValidation = latestValidation?.version === record.version ? latestValidation : null;
  const sourceAddresses = data.members.flatMap((member) => member.sourceCandidates?.addresses.map((candidate) => candidate.data) ?? []);
  const sourceAddressConflict = hasDocumentAddressConflict(sourceAddresses);
  const legacyPhysicalValidation = Boolean(currentValidation?.issues.some((issue) => legacyPhysicalIssue(issue.code)));
  const visibleValidationIssues = currentValidation?.issues.filter((issue) => {
    if (legacyPhysicalIssue(issue.code)) return false;
    if (issue.code !== 'DOCUMENT_ADDRESS_CONFLICT') return true;
    if (!issue.demandId) return sourceAddressConflict;
    const member = data.members.find((member) => member.source.demandId === issue.demandId);
    return !member || hasDocumentAddressConflict(member.sourceCandidates?.addresses.map((candidate) => candidate.data) ?? []);
  }) ?? [];
  const staleAddressValidation = Boolean(currentValidation && visibleValidationIssues.length !== currentValidation.issues.length);
  const staleFieldValidation = Boolean(currentValidation?.issues.some((issue) =>
    issue.code === 'DOCUMENT_PROFILE_REQUIRED' && ['product', 'party', 'channel', 'tax'].includes(issue.profileCategory || '')
    || issue.code === 'DOCUMENT_FIELD_REQUIRED' && /remarks|deliveryWindow|备注|送仓时间/.test(issue.message)
    || issue.code === 'DECLARATION_REQUIRED' && /缺少\s*(?:unit[。.]?$|申报单位)/.test(issue.message)
    || issue.code === 'PRODUCT_IMAGE_REQUIRED'));
  const staleValidation = legacyPhysicalValidation || staleAddressValidation || staleFieldValidation;
  const validationErrors = visibleValidationIssues.filter((issue) => issue.severity === 'error').length;
  const validationWarnings = visibleValidationIssues.length - validationErrors;
  const imageWarnings = currentValidation?.issues.filter((issue) => ['PRODUCT_IMAGE_MISSING', 'PRODUCT_IMAGE_INVALID'].includes(issue.code)) ?? [];
  const hasFile = exports.some((item) => Boolean(item.fileId));
  const generationRunning = exports.some((item) => item.status === 'queued' || item.status === 'running');
  const reviewableExports = exports.filter((item) => item.status === 'completed' && item.reference.revisionId === record.currentRevision.id && Boolean(item.fileSha256)).sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  const reviewTarget = reviewableExports.find((item) => item.id === reviewExportId) ?? reviewableExports[0];
  const fieldLabels: Record<string, string> = { ...Object.fromEntries(fieldGroups.flatMap((group) => group.fields)), destinationFc: '目的仓', fc: '目的仓' };
  const adoptProfiles = () => {
    setAdoptCurrentProfileVersions(true);
    const sourceValues = new Map<string, Set<string>>();
    for (const profile of profiles.data ?? []) {
      if (!profileIds.includes(profile.id) || profile.category === 'product' || profile.category === 'address') continue;
      for (const [key, value] of Object.entries(profile.data)) {
        if (!(key in fieldLabels) || addressFieldKeys.has(key) || value === null || value === undefined || value === '') continue;
        const values = sourceValues.get(key) ?? new Set<string>(); values.add(String(value)); sourceValues.set(key, values);
      }
    }
    const conflicts: string[] = [];
    const adopted: Record<string, string | null> = { ...fields };
    for (const [key, values] of sourceValues) {
      const value = [...values][0]!;
      if (values.size > 1 || adopted[key] && adopted[key] !== value) { conflicts.push(fieldLabels[key] || key); continue; }
      adopted[key] = value;
    }
    updateFields(adopted);
    setProfileNotice(conflicts.length ? `其余资料已填入；${conflicts.join('、')}存在不同值，请在对应字段中核对并明确填写。` : sourceValues.size ? '已将所选资料填入订单及税务字段，请核对并保存资料修订。' : '所选资料没有可填入的订单或税务字段。商品申报资料通过引用直接采用。');
  };
  const updateFields = (changes: Record<string, string | null>) => {
    setFields((current) => {
      const next = normalizeFields({ ...current, ...changes });
      if (!invoiceV2 && documentProductCurrency('', current.currency) !== documentProductCurrency('', next.currency)) {
        for (const product of products) {
          const profile = findProductProfile(effectiveProfiles, product);
          const currency = next[product.prefix + 'currency'] ?? profileValue(profile, 'currency');
          if (!currency?.trim()) next[product.prefix + 'unitPriceConfirmed'] = 'false';
        }
      }
      return next;
    });
  };
  const updateField = (key: string, value: string) => updateFields({ [key]: value });
  const effectiveProfiles = [...profileIds.flatMap((profileId) => {
    const previous = data.profileReferences.find((reference) => reference.profileId === profileId);
    const current = profiles.data?.find((profile) => profile.id === profileId);
    return previous && !adoptCurrentProfileVersions ? [previous] : current ? [{ category: current.category, profileId: current.id, version: current.version, data: current.data }] : previous ? [previous] : [];
  }), ...(addressReference ? [addressReference] : [])];
  const channelReferences = [
    ...effectiveProfiles.filter((profile) => profile.category === 'channel'),
    ...data.profileReferences.filter((profile) => profile.category === 'channel' && profileIds.includes(profile.profileId) && !effectiveProfiles.some((current) => current.profileId === profile.profileId)),
  ];
  const services = channelReferences.length ? [...new Set(channelReferences.flatMap((profile) => {
    const values = Array.isArray(profile.data.allowedServices) ? profile.data.allowedServices : [profile.data.service];
    return values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim());
  }))] : fieldOptions.data?.services ?? [];
  const operation = (operationId: string, text: string) => ({ operationId, expectedVersion: record.version, reason: text });
  const canSave = active && !busy && !blocked && !recoverableDraft && !readOnly && !hasFile && !generationRunning && Boolean(title.trim() && reason.trim()) && !profiles.isFetching && !templates.isFetching && !profiles.isError && !templates.isError;
  const saveForm = (next: boolean) => {
    if (busy || blocked || recoverableDraft || !active) return;
    if (!dirty) { if (next) { if (automatic) automatic.continue(record); else advance(); } return; }
    if (!canSave || !form.current?.reportValidity()) return;
    continueAfterSave.current = next; form.current.requestSubmit();
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = continueAfterSave.current; continueAfterSave.current = false;
    if (!canSave || !dirty) return;
    const template = templates.data?.find((item) => item.id === templateId);
    const input = { expectedVersion: record.version, reason: reason.trim(), title: title.trim(), fields, confirmAddress: addressReconfirmed, profileReferences: effectiveProfiles.map((reference) => ({ ...reference, data: {} })), templateReference: !adoptCurrentTemplateVersion && templateId === data.templateReference?.templateId ? data.templateReference : template ? { templateId: template.id, version: template.version, sha256: template.sha256, fileId: template.fileId } : null };
    action.run(`save:${record.id}:${JSON.stringify(input)}`, (operationId) => documentApi.revise(record.id, { operationId, ...input }), '单据修订已保存，生成前请重新校验。', (value) => {
      draftRef.current = null; setRecoverableDraft(null);
      const saved = (value as { document: BusinessDocument }).document;
      client.setQueryData<DocumentDetails>(['document', record.id], (previous) => previous ? { ...previous, document: saved, validation: null } : { document: saved, validation: null, exports });
      if (next) { if (automatic) automatic.continue(saved); else advance(); }
    });
  };
  const unsettled = actualDirty || Boolean(reviewReason.trim()) || reason !== '补齐发票资料' || JSON.stringify(correctionIds) !== JSON.stringify(data.members.map((member) => member.source.demandId));
  useEffect(() => {
    if (recoverableDraft) return;
    if (!unsettled) {
      if (draftRef.current?.documentId === record.id && draftRef.current.baseVersion === record.version) draftRef.current = null;
      return;
    }
    const baseFields = withDocumentDefaults(data.fields);
    const changedFields = Object.fromEntries([...new Set([...Object.keys(baseFields), ...Object.keys(fields)])].filter((key) => fields[key] !== baseFields[key]).map((key) => [key, fields[key] ?? null]));
    draftRef.current = {
      documentId: record.id, baseVersion: record.version, fields: changedFields,
      ...(title !== data.title ? { title } : {}),
      ...(templateId !== (data.templateReference?.templateId || '') ? { templateId } : {}),
      ...(JSON.stringify([...profileIds].sort()) !== JSON.stringify(data.profileReferences.filter((item) => item.category !== 'address').map((item) => item.profileId).sort()) ? { profileIds } : {}),
      ...(JSON.stringify(addressReference) !== JSON.stringify(data.profileReferences.find((item) => item.category === 'address') ?? null) ? { addressReference } : {}),
      addressReconfirmed, adoptCurrentProfileVersions, adoptCurrentTemplateVersion, reason, reviewReason,
      ...(Object.keys(manualSalesPriceInputs).length ? { manualSalesPriceInputs } : {}),
      ...(JSON.stringify(correctionIds) !== JSON.stringify(data.members.map((member) => member.source.demandId)) ? { correctionIds } : {}),
    };
  }, [unsettled, recoverableDraft, draftRef, record.id, record.version, data, fields, title, templateId, profileIds, addressReference, addressReconfirmed, adoptCurrentProfileVersions, adoptCurrentTemplateVersion, reason, reviewReason, correctionIds, manualSalesPriceInputs]);
  const recoverInputs = () => {
    if (!recoverableDraft) return;
    draftRef.current = null;
    const currentBoxIds = new Set(data.members.flatMap((member) => member.shipment.data.boxes.map((box) => box.id)));
    const applicableFields = Object.fromEntries(Object.entries(recoverableDraft.fields).filter(([key]) => !key.startsWith('box.') || currentBoxIds.has(key.split('.')[1] ?? '')));
    const addressChanged = recoverableDraft.addressReconfirmed || recoverableDraft.addressReference !== undefined || Object.keys(applicableFields).some((key) => addressFieldKeys.has(key) || key.startsWith('address'));
    const recheckAddress = recoverableDraft.baseVersion !== record.version && addressChanged;
    setFields((current) => normalizeFields({ ...current, ...applicableFields, ...(recheckAddress ? { addressConfirmed: 'false', addressConfirmationReason: '' } : {}) }));
    if (recoverableDraft.title !== undefined) setTitle(recoverableDraft.title);
    if (recoverableDraft.templateId !== undefined) setTemplateId(recoverableDraft.templateId);
    if (recoverableDraft.profileIds) setProfileIds(recoverableDraft.profileIds);
    if (recoverableDraft.addressReference !== undefined) setAddressReference(recoverableDraft.addressReference);
    setAddressReconfirmed(!recheckAddress && recoverableDraft.addressReconfirmed); setAdoptCurrentProfileVersions(recoverableDraft.adoptCurrentProfileVersions); setAdoptCurrentTemplateVersion(recoverableDraft.adoptCurrentTemplateVersion);
    setReason(recoverableDraft.reason); setReviewReason(recoverableDraft.reviewReason);
    if (recoverableDraft.manualSalesPriceInputs) setManualSalesPriceInputs(Object.fromEntries(Object.entries(recoverableDraft.manualSalesPriceInputs).filter(([, input]) => data.members.some((member) => member.demand.snapshot.sid === input.sid && member.shipment.data.items.some((item) => item.msku === input.msku && item.fnsku === input.fnsku && item.sku === input.sku)))));
    if (recoverableDraft.correctionIds) setCorrectionIds(recoverableDraft.correctionIds);
    setRecoverableDraft(null);
  };
  const removedBoxDraftFields = recoverableDraft ? Object.keys(recoverableDraft.fields).filter((key) => key.startsWith('box.') && !data.members.some((member) => member.shipment.data.boxes.some((box) => box.id === key.split('.')[1]))).length : 0;
  const removedManualPriceDrafts = Object.values(recoverableDraft?.manualSalesPriceInputs ?? {}).filter((input) => !data.members.some((member) => member.demand.snapshot.sid === input.sid && member.shipment.data.items.some((item) => item.msku === input.msku && item.fnsku === input.fnsku && item.sku === input.sku)));
  useEffect(() => { onEditorState({ dirty: unsettled || Boolean(recoverableDraft), busy, detailsDirty: dirty }); }, [unsettled, recoverableDraft, busy, dirty, onEditorState]);
  const readiness = documentDetailsReadiness({ data, fields, title, templateId, products, profiles: effectiveProfiles, productKeyError: keyError, productsLoading, manualSalesPriceInputs });
  const sectionId = (section: DetailProgress['section']) => `${id}-details-${section}`;
  const locate = (progress: DetailProgress) => {
    if (progress.section === 'boxes' && progress.issues[0]?.field.startsWith('box.')) {
      setBoxRevealRequest((previous) => ({ field: progress.issues[0]!.field, requestId: (previous?.requestId ?? 0) + 1 })); return;
    }
    const target = document.getElementById(sectionId(progress.section));
    if (!target) return;
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.querySelectorAll<HTMLDetailsElement>('details[data-section-editor]').forEach((details) => { details.open = true; });
    const issue = progress.issues[0];
    const field = issue && editor.current?.querySelector<HTMLElement>(`[data-document-field=${JSON.stringify(issue.field)}]`);
    const focusTarget = field ?? target;
    for (let ancestor: HTMLElement | null = focusTarget; ancestor; ancestor = ancestor.parentElement) if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    requestAnimationFrame(() => {
      const control = field?.matches('input:not(:disabled),button:not(:disabled),select:not(:disabled),textarea:not(:disabled)') ? field : field?.querySelector<HTMLElement>('input:not(:disabled),button:not(:disabled),select:not(:disabled),textarea:not(:disabled)');
      (control ?? (field?.hasAttribute('tabindex') ? field : target)).focus({ preventScroll: true }); scrollDocumentFieldIntoView(focusTarget);
    });
  };
  return <div ref={editor} className="document-editor">
    <section className="content-panel document-summary"><div><h3>{data.title}</h3><p>{documentOccurrence(data)} · v{record.version} · {data.members.length} 个 FBA</p></div><Status status={record.status} /><IconButton icon={RefreshCw} label="重新读取单据" disabled={busy} onClick={reload} /></section>
    {recoverableDraft && <div className="permission-note warning-note" role="alert"><p>已读取 v{record.version}，本次在 v{recoverableDraft.baseVersion} 中未保存的输入仍保留。可恢复本次修改，核对新版资料后再保存；未修改的字段继续采用新版。{removedBoxDraftFields > 0 && `其中 ${removedBoxDraftFields} 项已移除箱的修改不再应用。`}{removedManualPriceDrafts.length > 0 && `已移除商品的人工售价不再应用：${removedManualPriceDrafts.map((input) => `${input.sku || input.msku} ${input.salesPrice ?? '清除'} ${input.enteredCurrency}`).join('、')}。`}{(hasFile || record.status !== 'draft') && '当前单据已不可编辑，请通过更正单据处理。'}</p><div className="document-footer-actions"><Button type="button" disabled={busy || record.status !== 'draft' || hasFile || generationRunning} onClick={recoverInputs}>恢复未保存输入</Button><Button type="button" disabled={busy} onClick={() => { draftRef.current = null; setRecoverableDraft(null); }}>放弃未保存输入</Button></div></div>}
    {record.status === 'stale' && <p className="form-note error-note" role="alert">来源或依赖版本已变化。请核对来源，保存新修订并重新生成；已有文件保留原内容。</p>}
    {!invoiceV2 && !hasFile && <p className="form-note warning-note" role="status"><CircleAlert size={16} aria-hidden="true" />此草稿使用历史发票规则。请在“单票资料”中查询并采用领星资料，升级为每件固定单价 2.00、每箱一行及箱规默认申报数量后再生成。</p>}
    {hasFile && exports.some((item) => item.status === 'completed' && item.fileId && item.reference.pricingRule !== 'fixed-2') && <p className="form-note warning-note" role="status">历史文件保留生成时的申报价格；当前规则为每件固定 2.00，需建立更正单据后生成新文件。</p>}
    {action.feedback}{action.conflict && <Button icon={RefreshCw} onClick={reload}>重新读取最新版本</Button>}
    <div className="document-wizard-step" hidden={stage !== 'details'}>
    <nav className="document-details-progress" aria-label="单票资料完成情况">{readiness.map((item) => <button type="button" key={item.section} disabled={busy || blocked} data-incomplete={item.issues.length > 0} onClick={() => locate(item)}><strong>{item.label}</strong><span>{item.pending ? '正在读取商品…' : item.issues.length ? `待补 ${item.issues.length} 项` : '已填齐'}</span></button>)}</nav>
    <p className="mapping-help document-readiness-help">点击区块定位待补资料；本页提示随填写更新，出单前仍需校验保存版本。</p>
    {!automatic && <DocumentLingxing documentId={record.id} version={record.version} data={data} onBusyChange={setLingxingBusy} disabledReason={!active ? '切换回当前页面后可查询领星资料。' : readOnly ? '当前单据已结束，无法采用新资料。' : hasFile || generationRunning ? '该单据已进入文件生成流程；请建立更正单据后补齐资料。' : dirty ? '请先保存当前修改，再查询或采用领星资料。' : action.busy ? '请等待当前操作完成。' : ''} />}
    <form ref={form} className="content-panel document-edit-form" onSubmit={save}>
      <fieldset className="document-wizard-fieldset" disabled={Boolean(recoverableDraft)}>
      <div className="section-heading"><h3>单票资料</h3><span>{dirty ? '有未保存的修改' : '已保存当前版本'}</span></div><p className="mapping-help">订单编号、参考号和贸易条款无需填写，导出表格中保持空白。</p>
      <section id={sectionId('basic')} className="document-details-section" tabIndex={-1} aria-label="基础信息">
      {hasFile && <p className="form-note" role="status">该单据已生成文件。调整资料或来源时，请在下方“采用来源与更正”中建立更正单据。</p>}
      <p className="mapping-help"><Link to="/settings/document-profiles" search={{ documentId: record.id }}>维护单据资料与模板</Link> · 保存资料后可返回当前草稿并采用具体版本。</p>
      <div className="document-form-grid"><div className="field document-wide-field" data-document-field="title"><label htmlFor={`${id}-title`}>草稿名称</label><Input id={`${id}-title`} required maxLength={200} value={title} disabled={busy || readOnly || hasFile} onChange={(event) => setTitle(event.target.value)} /></div><div className="field" data-document-field="template"><label htmlFor={`${id}-template`}>单据模板</label><SelectField id={`${id}-template`} value={templateId} disabled={busy || readOnly || hasFile || templates.isFetching} onValueChange={(value) => { setTemplateId(value); setAdoptCurrentTemplateVersion(true); }} options={[{ value: '', label: '请选择受控模板' }, ...(templates.data ?? []).filter((item) => item.status === 'active' || item.id === templateId).map((item) => ({ value: item.id, label: `${item.name} · v${item.version}` }))]} /></div></div>
      {templates.isError && <QueryError error={templates.error} retry={() => void templates.refetch()} />}
      {data.templateReference && <p className="mapping-help">本票模板版本 v{data.templateReference.version}{!hasFile && templates.data?.some((template) => template.id === data.templateReference?.templateId && template.version !== data.templateReference.version) && <> · <Button type="button" variant="text" disabled={busy || readOnly} onClick={() => setAdoptCurrentTemplateVersion(true)}>采用模板当前版本</Button></>}</p>}
      <details className="document-profile-choices"><summary>引用单据资料（可选）· 已选 {profileIds.length} 项</summary><p className="mapping-help">可引用商品、主体、渠道及税务资料，也可直接补齐本票字段，无需先建立公共资料。收件地址在下方统一采用，公共资料更新后须显式采用新版。</p>{profiles.isPending ? <p role="status">正在读取单据资料…</p> : profiles.isError ? <QueryError error={profiles.error} retry={() => void profiles.refetch()} /> : <div className="document-profile-list">{profiles.data.filter((item) => item.category !== 'address' && (item.status === 'active' || profileIds.includes(item.id))).map((profile) => <Check key={profile.id} checked={profileIds.includes(profile.id)} disabled={busy || readOnly || hasFile} onChange={(checked) => setProfileIds((current) => checked ? [...current, profile.id] : current.filter((value) => value !== profile.id))}>{profileLabels[profile.category]} · {profile.key} · v{profile.version}</Check>)}</div>}</details>
      {!readOnly && !hasFile && <div className="document-footer-actions"><Button type="button" icon={ArrowRight} disabled={busy || profiles.isFetching || profiles.isError || profileIds.length === 0} onClick={adoptProfiles}>采用所选资料</Button><span className="mapping-help">商品资料随引用采用；其他资料先填入单票字段，遇到不同值时请人工处理。</span></div>}{profileNotice && <p className="form-note" role="status">{profileNotice}</p>}
      {fieldGroups.filter((group) => group.title !== '收件地址').map((group, index) => <details className="document-field-group" key={group.title} open={index === 0 || undefined}><summary>{group.title}</summary><div className="document-form-grid">{group.fields.map(([key, label]) => <div className="field" key={key} data-document-field={key}><label htmlFor={`${id}-${key}`}>{label}{optionalFields.has(key!) ? '（可选）' : ''}</label><>{key === 'currency' && (automaticCurrency || mixedCurrencies) ? <><Input id={`${id}-${key}`} value={automaticCurrency ? ({ USD: '美元（USD）', GBP: '英镑（GBP）', EUR: '欧元（EUR）' })[automaticCurrency] : '请按币种拆分出单'} readOnly aria-describedby={`${id}-currency-help`} /><p id={`${id}-currency-help`} className={`mapping-help${mixedCurrencies ? ' error-note' : ''}`}>{mixedCurrencies ? '本票 FBA 所属国家对应多个币种，请按币种拆分；系统不自动换汇。' : '根据 FBA 所属国家自动确定，无需填写。'}</p></> : <DocumentField id={`${id}-${key}`} fieldKey={key!} value={fields[key!] || ''} disabled={busy || readOnly || hasFile} onValueChange={(value) => updateField(key!, value)} services={services} servicesLoading={!channelReferences.length && fieldOptions.isFetching} servicesError={!channelReferences.length && fieldOptions.isError} retryServices={() => void fieldOptions.refetch()} serviceHelp={channelReferences.length ? '已引用渠道若维护服务范围，所填服务须在范围内。' : '按实际发运要求选择或填写服务，无需先建立渠道资料。'} />}</></div>)}</div></details>)}
      </section>
      <DocumentAddressSection sectionId={sectionId('address')} documentId={record.id} members={data.members} fields={fields} reference={addressReference} disabled={busy || blocked || Boolean(recoverableDraft) || readOnly || hasFile || generationRunning} conflict={sourceAddressConflict}
        adopt={(next, reference) => { setFields(next); setAddressReference(reference); setAddressReconfirmed(false); }}
        edit={(key, value) => { setFields((current) => ({ ...current, [key]: value, addressConfirmed: 'false', addressConfirmationReason: '', addressSelectionMode: 'manual', addressSourceLabel: '本票手工地址' })); setAddressReference(null); setAddressReconfirmed(false); }}
        confirm={(checked) => { updateField('addressConfirmed', checked ? 'true' : 'false'); setAddressReconfirmed(checked); }} reason={(value) => updateField('addressConfirmationReason', value)} />
      <section id={sectionId('products')} className="document-details-section" tabIndex={-1} aria-label="商品申报">
      {invoiceV2 && <InvoiceBoxQuantities data={data} fields={fields} />}
      <ProductAdjustments documentId={record.id} version={record.version} data={data} products={products} keyError={keyError} missingFields={readiness.find((item) => item.section === 'products')!.issues.map((issue) => issue.field)} profileReferences={effectiveProfiles} fields={fields} disabled={busy || readOnly || hasFile || generationRunning} updateFields={updateFields} onImageBusy={setImageBusy} manualSalesPriceInputs={manualSalesPriceInputs} changeManualSalesPrice={(prefix, input) => setManualSalesPriceInputs((current) => { const next = { ...current }; if (input) next[prefix] = input; else delete next[prefix]; return next; })} />
      </section>
      <DocumentBoxAdjustments sectionId={sectionId('boxes')} revealRequest={boxRevealRequest} members={data.members} fields={fields} disabled={busy || record.status !== 'draft' || hasFile || generationRunning} updateFields={updateFields} />
      {!readOnly && !hasFile && <><div className="field document-reason" data-document-field="reason"><label htmlFor={`${id}-reason`}>本次调整原因</label><Input id={`${id}-reason`} required maxLength={1000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></div><p className="mapping-help">单票调整只写入当前单据快照，请在底部保存草稿或保存后继续。</p></>}
      </fieldset>
    </form>
    {stage === 'details' && actionsContainer && createPortal(<>
      <Button type="button" icon={ArrowLeft} disabled={busy || blocked} onClick={automatic ? close : back}>{automatic ? '返回任务' : '上一步'}</Button>
      <Button type="button" icon={X} disabled={busy || blocked} onClick={close}>暂时关闭</Button>
      {!readOnly && !hasFile && <Button type="button" icon={Save} disabled={!dirty || !canSave} loading={action.pendingKey?.startsWith('save:')} onClick={() => saveForm(false)}>保存草稿</Button>}
      <Button type="button" icon={ArrowRight} variant="primary" disabled={busy || blocked || Boolean(recoverableDraft) || dirty && !canSave} loading={action.pendingKey?.startsWith('save:')} onClick={() => saveForm(true)}>{automatic ? dirty ? '保存并继续自动出单' : '继续自动出单' : dirty ? '保存并下一步' : '下一步'}</Button>
    </>, actionsContainer)}
    </div>
    <div className="document-wizard-step" hidden={stage !== 'sources'}>
    <section className="content-panel"><div className="section-heading"><h3>来源与完整货件</h3><span>原组、箱序和箱码保留</span></div><BatchTable label="单据来源" headers={['FBA / 店铺', '目的仓 / 地址', '来源组 / 确认', '箱 / 商品']}>{data.members.map((member) => <tr key={member.source.demandId}><td><strong>{member.demand.snapshot.fba}</strong><small className="mapping-subtext">{member.demand.snapshot.shop} · {member.demand.snapshot.country}</small></td><td>{member.demand.snapshot.destinationFc || '—'}<small className="mapping-subtext document-address">{member.demand.snapshot.destinationAddress || '待补齐'}</small></td><td>组 v{member.source.groupVersion}<small className="mapping-subtext">制表数据已确认 · 箱规可在单票资料中修改</small></td><td>{member.shipment.data.boxes.length} 箱 / {member.shipment.data.items.length} 个商品<small className="mapping-subtext">{member.codes.map((code) => code.code).join('、') || '箱码缺失'}</small></td></tr>)}</BatchTable></section>
    {!readOnly && <section className="content-panel document-source-actions"><div className="section-heading"><h3>采用来源与更正</h3></div><p className="mapping-help">未生成文件的草稿可显式采用当前制表与领星箱规来源，保留仍在本票中的人工箱规修改。已有文件时，通过更正建立后继单据并移交完整货件占用。</p><div className="document-footer-actions"><Button icon={RefreshCw} disabled={hasFile || dirty || busy} onClick={() => action.run(`adopt:${record.id}:${record.version}`, (operationId) => documentApi.revise(record.id, { ...operation(operationId, '显式采用当前制表与领星箱规来源'), demandIds: data.members.map((member) => member.source.demandId) }), '已采用当前来源，请核对资料并重新校验。')}>采用当前来源</Button><Button icon={Plus} disabled={dirty || busy} onClick={() => setShowCorrection((value) => !value)}>建立更正单据</Button></div>{showCorrection && <div className="document-correction-selection"><p className="mapping-help">选择本次发货的完整 FBA。当前单据的原货件已预选；更正将原子移交占用并保留旧单据和文件。</p>{candidates.isPending ? <p role="status">正在读取本次发货的候选范围…</p> : candidates.isError ? <QueryError error={candidates.error} retry={() => void candidates.refetch()} /> : <div className="document-profile-list">{candidates.data.items.map((item) => <Check key={item.demandId} checked={correctionIds.includes(item.demandId)} disabled={busy} onChange={(checked) => setCorrectionIds((current) => checked ? [...current, item.demandId] : current.filter((value) => value !== item.demandId))}>{item.demand.snapshot.fba} · {item.demand.snapshot.shop} · {item.groupName}</Check>)}</div>}<div className="field document-reason"><label htmlFor={`${id}-correction-reason`}>更正原因</label><Input id={`${id}-correction-reason`} maxLength={1000} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} disabled={busy} /></div><div className="document-footer-actions"><Button icon={Save} variant="primary" disabled={busy || !reviewReason.trim() || correctionIds.length === 0 || candidates.isFetching || candidates.isError} onClick={() => action.run(`correct:${record.id}:${record.version}:${JSON.stringify(correctionIds)}:${reviewReason}`, (operationId) => documentApi.correct(record.id, { ...operation(operationId, reviewReason.trim()), demandIds: correctionIds, title: `${data.title} 更正`, fields: data.fields }), '更正单据已建立，货件占用已移交。', (value) => corrected((value as BusinessDocument).id))}>保存更正并移交货件</Button></div></div>}</section>}
    </div>
    <div className="document-wizard-step" hidden={stage !== 'generate'}>
    <section className="content-panel document-validation-panel"><div className="section-heading"><h3>校验与生成</h3>{currentValidation && <span>校验于 {timestamp(currentValidation.checkedAt)}</span>}</div><p className="mapping-help">按最终出单内容核对地址、商品申报、货件与模板。文件发布成功后将冻结完整原制表组。</p>{dirty && <p className="form-note" role="status">请先保存资料修订，再执行校验或生成。</p>}{staleValidation && <p className="form-note" role="status">{legacyPhysicalValidation ? '此结果来自旧版实物确认流程，请重新校验当前版本。已保存资料和输入会保留。' : '出单校验规则已更新，请重新校验当前版本。下方诊断详情保留上次结果。'}</p>}{currentValidation ? !staleValidation && <>
      <p className={`form-note${validationErrors ? '' : ' success-note'}`} role="status">{validationErrors ? `还有 ${validationErrors} 项需补齐${validationWarnings ? `，${validationWarnings} 项提醒` : ''}。` : <><CircleCheck size={16} aria-hidden="true" />当前版本校验通过，可以生成待复核文件。{validationWarnings ? `另有 ${validationWarnings} 项提醒。` : ''}</>}</p>
      {visibleValidationIssues.length > 0 && <ul className="document-issues">{visibleValidationIssues.map((issue, index) => <li key={`${issue.code}-${index}`} data-severity={issue.severity}><CircleAlert size={16} aria-hidden="true" /><div><strong>{issue.severity === 'warning' ? '提醒：' : ''}{issue.code === 'DOCUMENT_ADDRESS_CONFLICT' ? sourceAddressConflictMessage : friendlyIssue(issue.message)}</strong>{issue.profileCategory && <small>{profileLabels[issue.profileCategory]}{fieldLabels[issue.profileKey || ''] ? ` · ${fieldLabels[issue.profileKey!]}` : ''}</small>}</div></li>)}</ul>}
    </> : <p className="mapping-help">尚未校验当前版本。</p>}
      {currentValidation && currentValidation.issues.length > 0 && <details className="document-validation-diagnostics"><summary>{staleValidation ? '查看上次校验详情' : '查看诊断详情'}</summary><ul>{currentValidation.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><code>{issue.code}</code> · {friendlyIssue(issue.message)}{issue.profileKey ? ` · ${issue.profileKey}` : ''}</li>)}</ul></details>}
      {!readOnly && <div className="document-footer-actions"><Button icon={FileCheck} disabled={dirty || busy} loading={action.pendingKey === `validate:${record.id}:${record.version}`} onClick={() => action.run(`validate:${record.id}:${record.version}`, (operationId) => documentApi.validate(record.id, operation(operationId, '人工校验单据')), '校验已完成。', (result) => setLatestValidation(result as DocumentValidation))}>校验当前版本</Button><Button icon={FileSpreadsheet} variant="primary" disabled={dirty || busy || staleValidation || !currentValidation?.valid} loading={action.pendingKey === `export:${record.id}:${record.version}`} onClick={() => action.run(`export:${record.id}:${record.version}`, (operationId) => documentApi.exportDocument(record.id, operation(operationId, '生成待复核发票')), '发票生成任务已受理，请在文件记录中查看进度。')}>生成待复核发票</Button></div>}
    </section>
    </div>
    <div className="document-wizard-step" hidden={stage !== 'review'}>
    {imageWarnings.length > 0 && <section className="content-panel document-image-review"><div className="section-heading"><h3>商品图片待核对</h3></div><p className="mapping-help">以下商品的图片列为空，请在下载文件后核对；需要补图时，建立更正单据后重新生成。</p><ul>{imageWarnings.map((issue, index) => <li key={`${issue.code}-${index}`}>{friendlyIssue(issue.message)}</li>)}</ul></section>}
    <DocumentFileHistory exports={exports} busy={busy} download={(item) => action.run(`download:${item.id}`, () => downloadBlob(documentApi.download(item.id), `发票-${data.title}-${item.id.slice(0, 8)}.xlsx`), '下载已开始。')} />
    <section className="content-panel"><details className="document-audit-history" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}><summary>单据修订与人工复核历史</summary>{historyOpen && (history.isPending ? <p className="list-state" role="status">正在读取单据历史…</p> : history.isError ? <QueryError error={history.error} retry={() => void history.refetch()} /> : <><BatchTable label="单据修订历史" headers={['版本 / 时间', '范围与资料', '修订原因 / 操作人']}>{history.data.revisions.map((revision) => <tr key={revision.id}><td>v{revision.version}<small className="mapping-subtext">{timestamp(revision.createdAt)}</small></td><td>{revision.data.title}<small className="mapping-subtext">{revision.data.members.length} 个 FBA · {revision.data.profileReferences.length} 项资料 · 模板 {revision.data.templateReference ? `v${revision.data.templateReference.version}` : '未选择'}</small></td><td>{revision.reason}<small className="mapping-subtext">{revision.createdBy}</small></td></tr>)}</BatchTable>{history.data.reviews.length > 0 ? <BatchTable label="人工复核历史" headers={['复核时间 / 结果', '文件哈希', '复核意见 / 操作人']}>{history.data.reviews.map((review, index) => <tr key={`${review.exportId}-${index}`}><td>{timestamp(review.reviewedAt)}<small className="mapping-subtext">{review.decision === 'approve' ? '通过' : '退回'}</small></td><td className="document-hash">{review.fileSha256}</td><td>{review.reason}<small className="mapping-subtext">{review.reviewedBy}</small></td></tr>)}</BatchTable> : <p className="mapping-help">尚无人工复核记录。</p>}</> )}</details></section>
    {!readOnly && <section className="content-panel document-review-target"><div className="section-heading"><h3>本次复核文件</h3></div><div className="field document-reason"><label htmlFor={`${id}-review-file`}>选择当前修订的已生成文件</label><SelectField id={`${id}-review-file`} value={reviewTarget?.id || ''} onValueChange={setReviewExportId} disabled={busy || generationRunning || reviewableExports.length === 0} options={reviewableExports.length ? reviewableExports.map((item) => ({ value: item.id, label: `${timestamp(item.createdAt)} · ${item.id.slice(0, 8)}${item.valid ? '' : ' · 已失效'}` })) : [{ value: '', label: '尚无当前修订的已生成文件' }]} /></div>{reviewTarget && <p className="mapping-help document-review-hash">文件 SHA256：{reviewTarget.fileSha256}</p>}{generationRunning && <p className="form-note" role="status">当前仍有生成任务，请等待任务结束后复核具体文件。</p>}</section>}
    {!readOnly && <section className="content-panel document-review-panel"><div className="section-heading"><h3>人工复核与单据处理</h3></div><p className="mapping-help">{invoiceV2 ? '下载后逐箱核对申报数量；混装请在 Excel 中手动修改。文件修改不会回写系统，系统复核记录对应原始生成文件。' : '下载并检查具体文件后再提交复核。文件在 Excel 中改动后，需回系统调整并重新生成。'}</p><div className="field"><label htmlFor={`${id}-review`}>复核意见 / 处理原因</label><Input id={`${id}-review`} value={reviewReason} maxLength={1000} onChange={(event) => setReviewReason(event.target.value)} placeholder="请记录已核对内容或退回原因" disabled={busy} /></div><div className="document-footer-actions"><Button icon={CircleCheck} variant="primary" disabled={dirty || busy || record.status !== 'pending_review' || !reviewTarget || !reviewTarget.valid || generationRunning || !reviewReason.trim()} onClick={() => action.run(`review:${record.id}:${record.version}:${reviewTarget?.id}:approve:${reviewReason}`, (operationId) => documentApi.review(record.id, { ...operation(operationId, reviewReason.trim()), decision: 'approve', exportId: reviewTarget?.id, fileSha256: reviewTarget?.fileSha256 }), '已记录复核通过。', () => setReviewReason(''))}>复核通过</Button><Button icon={ArrowLeft} disabled={dirty || busy || record.status !== 'pending_review' || !reviewTarget || generationRunning || !reviewReason.trim()} onClick={() => action.run(`review:${record.id}:${record.version}:${reviewTarget?.id}:return:${reviewReason}`, (operationId) => documentApi.review(record.id, { ...operation(operationId, reviewReason.trim()), decision: 'return', exportId: reviewTarget?.id, fileSha256: reviewTarget?.fileSha256 }), '已退回单据，请调整后重新生成。', () => setReviewReason(''))}>退回调整</Button><Button icon={X} variant="text" disabled={busy} onClick={() => setConfirmCancel((current) => !current)}>取消单据</Button></div>{confirmCancel && <div className="document-cancel-confirm"><p>取消将释放该单据的货件占用，已发生的原制表组冻结仍保留。请填写上方处理原因后确认。</p><Button icon={X} disabled={busy || !reviewReason.trim()} onClick={() => action.run(`cancel:${record.id}:${record.version}:${reviewReason}`, (operationId) => documentApi.cancel(record.id, operation(operationId, reviewReason.trim())), '单据已取消，货件占用已释放。', () => { setReviewReason(''); setConfirmCancel(false); })}>确认取消单据</Button></div>}</section>}
    </div>
  </div>;
}

function DocumentFileHistory({ exports, busy, download }: { exports: DocumentExport[]; busy: boolean; download: (item: DocumentExport) => void }) {
  return <section className="content-panel document-file-history"><div className="section-heading"><h3><History size={17} aria-hidden="true" />文件与生成记录</h3><span>历史文件保留原内容</span></div>{exports.length === 0 ? <p className="list-state">尚未生成文件。校验通过后可生成待复核发票。</p> : <BatchTable label="发票文件记录" headers={['生成时间 / 修订', '状态', '模板版本', '文件 / 错误']}>{exports.map((item) => <tr key={item.id}><td>{timestamp(item.createdAt)}<small className="mapping-subtext">单据修订 v{item.reference.revisionVersion}</small></td><td><Status status={item.status} />{!item.valid && <small className="mapping-subtext error-note">{item.invalidReason || '历史文件的依赖版本已失效'}</small>}</td><td>v{item.reference.templateVersion}<small className="mapping-subtext document-hash">SHA256 {item.reference.templateSha256}</small></td><td>{item.fileId && <Button icon={Download} disabled={busy} onClick={() => download(item)}>下载发票 XLSX</Button>}{item.error && <p className="form-note error-note">{item.error}</p>}</td></tr>)}</BatchTable>}</section>;
}

export { profileLabels, useDocumentAction };

type ProductIdentity = { sid: number; msku: string; fnsku: string; sku: string; fbas: string[]; prefix: string };
function useProductIdentities(data: DocumentRevisionData) {
  const [products, setProducts] = useState<ProductIdentity[]>([]);
  const [keyError, setKeyError] = useState('');
  const [productsLoading, setProductsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setProductsLoading(true);
    const { members } = data;
    const representativeIds = data.generationRulesVersion === 'v2' ? new Set(invoiceBoxPreview(data).flatMap(({ box, representative }) => representative ? [invoiceProductIdentity(box.sid, representative)] : [])) : null;
    const identities = new Map<string, Omit<ProductIdentity, 'prefix'>>();
    for (const member of members) for (const item of member.shipment.data.items) {
      if (representativeIds && !representativeIds.has(invoiceProductIdentity(member.demand.snapshot.sid, item))) continue;
      const identity = [member.demand.snapshot.sid, item.msku, item.fnsku, item.sku] as const;
      const key = JSON.stringify(identity), current = identities.get(key);
      identities.set(key, { sid: identity[0], msku: item.msku, fnsku: item.fnsku, sku: item.sku, fbas: [...new Set([...(current?.fbas ?? []), member.demand.snapshot.fba])] });
    }
    void Promise.all([...identities.entries()].map(async ([key, identity]) => {
      const hash = bytesToHex(sha256(new TextEncoder().encode(key)));
      return { ...identity, prefix: `product.${hash}.` };
    })).then((result) => { if (!cancelled) { setProducts(result); setKeyError(''); setProductsLoading(false); } }).catch(() => { if (!cancelled) { setKeyError('商品调整标识生成失败，请刷新页面后重试。'); setProductsLoading(false); } });
    return () => { cancelled = true; };
  }, [data]);
  return { products, keyError, productsLoading };
}

function findProductProfile(profiles: DocumentRevisionData['profileReferences'], product: ProductIdentity) {
  return profiles.find((reference) => reference.category === 'product' && Number(reference.data.sid) === product.sid && ['msku', 'fnsku', 'sku'].every((key) => String(reference.data[key] ?? '') === product[key as 'msku' | 'fnsku' | 'sku']));
}

function profileValue(profile: DocumentRevisionData['profileReferences'][number] | undefined, key: string) {
  return profile?.data[key] === null || profile?.data[key] === undefined ? '' : String(profile.data[key]);
}

function InvoiceBoxQuantities({ data, fields }: { data: DocumentRevisionData; fields: Record<string, string | null> }) {
  const id = useId();
  const rows = invoiceBoxPreview(data, fields);
  return <section className="document-field-group document-invoice-quantities" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><h3 id={`${id}-title`}>逐箱申报数量核对</h3><span>{rows.length} 箱 · 每个输出编号一行</span></div>
    <p className="mapping-help">同箱按 MSKU、FNSKU、SKU 排序选首个产品展示。默认申报数量取该产品的标准箱规件数；缺失或无效时采用全箱实际数量合计。混装请导出后在 Excel 手动修改，修改不会回写系统。</p>
    <BatchTable label="逐箱申报数量" headers={['货箱编号 / FBA', '代表产品', '全箱实际数量', '标准箱规件数', '默认申报数量 / 来源']}>{rows.map(({ box, representative, actualQuantity, cartonQuantity, declaredQuantity, mixed }) => <tr key={`${box.demandId}-${box.boxId}`}>
      <td data-label="货箱编号 / FBA"><strong>{box.code || `第 ${box.order} 箱`}</strong><small className="mapping-subtext">{box.fba}</small></td>
      <td data-label="代表产品">{representative?.msku || representative?.fnsku || representative?.sku || '缺少商品'}{representative && <small className="mapping-subtext">FNSKU {representative.fnsku || '—'} · SKU {representative.sku || '—'}</small>}</td>
      <td data-label="全箱实际数量">{actualQuantity ?? '无效，需核对来源'}</td>
      <td data-label="标准箱规件数">{cartonQuantity ?? '缺失或无效'}</td>
      <td data-label="默认申报数量"><strong>{declaredQuantity ?? '无法计算'}</strong><small className="mapping-subtext">{cartonQuantity !== null ? '来源：代表产品标准箱规' : '来源：全箱实际数量合计'}</small>{mixed && <small className="mapping-subtext document-waiting">混装：导出后手动核对并修改</small>}{cartonQuantity === null && <small className="mapping-subtext document-waiting">箱规不可用，已回退实际数量</small>}{cartonQuantity !== null && cartonQuantity !== actualQuantity && <small className="mapping-subtext document-waiting">箱规与实际数量不同，请核对</small>}</td>
    </tr>)}</BatchTable>
    <p className="mapping-help">J 列采用默认申报数量；F15“亚马逊上架总数量”仍为所有箱内商品的实际总量。相同箱范围的压缩方式保持不变。</p>
  </section>;
}

function ProductAdjustments({ documentId, version, data, products, keyError, profileReferences, fields, disabled, updateFields, onImageBusy, missingFields, manualSalesPriceInputs, changeManualSalesPrice }: { documentId: string; version: number; data: DocumentRevisionData; products: ProductIdentity[]; keyError: string; profileReferences: DocumentRevisionData['profileReferences']; fields: Record<string, string | null>; disabled: boolean; updateFields: (changes: Record<string, string | null>) => void; onImageBusy: (busy: boolean) => void; missingFields: string[]; manualSalesPriceInputs: ManualSalesPriceDrafts; changeManualSalesPrice: (prefix: string, input: ManualSalesPriceDrafts[string] | undefined) => void }) {
  const id = useId();
  const invoiceV2 = data.generationRulesVersion === 'v2';
  const [expanded, setExpanded] = useState(false);
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(() => new Set());
  const missingPrefixes = products.filter((product) => missingFields.some((field) => field.startsWith(product.prefix))).map((product) => product.prefix).join('\n');
  useEffect(() => {
    if (!missingPrefixes) return;
    setExpanded(true); setExpandedProducts((current) => new Set([...current, ...missingPrefixes.split('\n')]));
  }, [missingPrefixes]);
  return <details className="document-field-group document-product-adjustments" data-section-editor="products" open={expanded} onToggle={(event) => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}><summary>本票商品申报调整 · {products.length} 个{invoiceV2 ? '输出代表商品' : '完整商品身份'}</summary><p className="mapping-help">{invoiceV2 ? '仅需补齐输出代表商品的申报资料，箱内其他商品保留实际身份与数量。标准箱规采用领星快照；申报单价固定为每件 2.00，沿用本票币种，无需补充售价。' : '默认采用本票引用的商品资料。以下输入只修改当前单据快照，保存时沿用本次调整原因；需要更新公共资料时，请进入单据资料维护。'}</p>{keyError && <p className="form-note error-note" role="alert">{keyError}</p>}{products.map((product) => {
    const profile = findProductProfile(profileReferences, product);
    const value = (key: string) => fields[product.prefix + key] ?? profileValue(profile, key);
    const currency = documentProductCurrency(value('currency'), fields.currency);
    const validPrice = /^\d+(?:\.\d{1,2})?$/.test(value('unitPrice')) && Number.isFinite(Number(value('unitPrice'))) && Number(value('unitPrice')) > 0 && Number(value('unitPrice')) <= Number.MAX_SAFE_INTEGER;
    const canConfirm = validPrice && DOCUMENT_FIELD_OPTIONS.currency.includes(currency as typeof DOCUMENT_FIELD_OPTIONS.currency[number]) && currency === fields.currency;
    const adjusted = Boolean(manualSalesPriceInputs[product.prefix] || data.manualSalesPrices?.some((entry) => entry.sid === product.sid && entry.msku === product.msku && entry.fnsku === product.fnsku && entry.sku === product.sku)) || [...productFieldKeys, 'imageBase64', 'imageExtension'].some((key) => fields[product.prefix + key] !== undefined && fields[product.prefix + key] !== null);
    const imageOverride = fields[product.prefix + 'imageBase64'] !== undefined && fields[product.prefix + 'imageBase64'] !== null;
    return <details className="document-product-adjustment" key={product.prefix} open={expandedProducts.has(product.prefix)} onToggle={(event) => { if (event.target !== event.currentTarget) return; const open = event.currentTarget.open; setExpandedProducts((current) => { const next = new Set(current); if (open) next.add(product.prefix); else next.delete(product.prefix); return next; }); }}>
      <summary>{product.msku} / {product.fnsku || '无 FNSKU'} / {product.sku || '无 SKU'}{adjusted ? ' · 已设置本票调整' : ''}</summary>
      <p className="mapping-help">店铺 SID {product.sid} · {product.fbas.join('、')} · {profile ? `申报资料 v${profile.version}` : '直接填写本票申报资料即可，无需先建立公共资料'}</p>
      {invoiceV2 && <DocumentSalesPrice data={{ ...data, fields }} product={product} draft={manualSalesPriceInputs[product.prefix]} disabled={disabled} change={(input) => changeManualSalesPrice(product.prefix, input)} />}
      <div className="document-form-grid">{productFieldKeys.filter((key) => !invoiceV2 || !['unitPrice', 'currency'].includes(key)).map((key) => <div className="field" key={key} data-document-field={product.prefix + key}>
        <label htmlFor={`${id}-${product.prefix}-${key}`}>{friendlyFieldLabels[key] || key}{optionalFields.has(key) ? '（可选）' : ''}</label>
        <DocumentField id={`${id}-${product.prefix}-${key}`} fieldKey={key} value={key === 'currency' ? currency : value(key)} type={key === 'unitPrice' ? 'number' : key === 'salesLink' ? 'url' : 'text'} min={key === 'unitPrice' ? 0 : undefined} step={key === 'unitPrice' ? 'any' : undefined} disabled={disabled} onValueChange={(value) => updateFields({ [product.prefix + key]: value, ...(key === 'unitPrice' || key === 'currency' ? { [product.prefix + 'unitPriceConfirmed']: 'false' } : {}) })} />
        {key === 'currency' && !value('currency').trim() && <p className="mapping-help">{currency ? `采用整票币种 ${currency}；确认时保存为本票商品币种。` : '未单独指定时采用整票币种，请先选择整票或商品币种。'}</p>}
      </div>)}</div>
      {!invoiceV2 && <div className="document-price-confirm" data-document-field={product.prefix + 'unitPriceConfirmed'}><Check checked={value('unitPriceConfirmed') === 'true'} disabled={disabled || !canConfirm} onChange={(checked) => updateFields(checked ? { [product.prefix + 'unitPrice']: value('unitPrice'), [product.prefix + 'currency']: currency, [product.prefix + 'unitPriceConfirmed']: 'true' } : { [product.prefix + 'unitPriceConfirmed']: 'false' })}>已核对并确认本票该商品的申报单价与币种</Check>{!canConfirm && <p className="mapping-help">填好有效申报单价和币种后，再核对确认。</p>}</div>}
      <DocumentProductImage imageBase64={value('imageBase64')} ticket disabled={disabled} hasOverride={imageOverride} onBusyChange={onImageBusy}
        change={(image) => {
          const changes = { [product.prefix + 'imageBase64']: image?.imageBase64 ?? '', [product.prefix + 'imageExtension']: image?.imageExtension ?? '' };
          const parsed = documentFieldsSchema.safeParse({ ...fields, ...changes });
          if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || '图片超过本票保存容量，请压缩后重试。');
          updateFields(changes);
        }}
        restore={profile ? () => updateFields({ [product.prefix + 'imageBase64']: null, [product.prefix + 'imageExtension']: null }) : undefined}
        fetchFromUrl={(url) => documentApi.previewProductImage(documentId, { expectedVersion: version, sid: product.sid, msku: product.msku, fnsku: product.fnsku, sku: product.sku, url })} />
    </details>;
  })}</details>;
}
