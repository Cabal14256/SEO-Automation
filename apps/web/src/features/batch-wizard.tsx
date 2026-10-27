import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addShippingTicketInputSchema, batchMutationResultSchema, createManualShippingRunInputSchema, demandSnapshotSchema, demandWorkspaceQuerySchema, type AddShippingTicketInput, type BatchMutationResult, type CreateManualShippingRunInput, type DemandSnapshot } from '@scm/contracts';
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleCheck, RefreshCw, X } from 'lucide-react';
import { api, ApiError, request } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Combobox } from '../components/ui/combobox';
import { DatePicker } from '../components/ui/date-picker';
import { dateInputError, shanghaiToday } from '../components/ui/date-utils';
import { batchApi } from './batch-api';
import { shippingRunApi } from './shipping-run-api';
import { messageOf, newOperation } from './batch-shared';
import { ImportDialog } from './import-dialog';
import './batch-wizard.css';

export type BatchWizardProps = {
  open: boolean; onClose: () => void; userId: string; canManage?: boolean;
  initialWeeklyBatchId?: string; initialWeekStartDate?: string; initialShippingRunId?: string; initialDemandId?: string; initialDemandIds?: string[];
  existingGroupId?: string; expectedGroupVersion?: number;
  onCreated?: (result: BatchMutationResult) => void; onOpenCreated?: (result: BatchMutationResult) => void;
};
type Step = 1 | 2 | 3 | 4;
type Choice = { id: string; version: number; businessDate: string; snapshot: DemandSnapshot };
type Pending = { kind: 'new'; input: CreateManualShippingRunInput } | { kind: 'existing'; runId: string; input: AddShippingTicketInput };
type Legacy = { pendingWeek?: { operationId: string; weekStartDate: string } | null; pendingGroup?: { batchId: string; input: unknown } | null };
type Filters = { q: string; sid: string; country: string; channel: string };
type Draft = {
  version: 2; step: Step; mode: 'new' | 'existing'; runId: string; numberingDate: string; selected: Choice[];
  filters: Filters; name: string; reason: string; confirmed: boolean; reviewVersion: number | null;
  pending: Pending | null; result: BatchMutationResult | null; resultLabel: string; legacy: Legacy | null;
};
const stepLabels = ['选择发货次', '选择需求', '核对与建立', '建立结果'];
const descriptions = ['选择已有发货次，或按编号日期新建本月下一次发货。', '手动选择本次一起发货的需求。', '核对发货次、成员和批次名称。', '批次已保存，可继续同步商品并核对装箱。'];
const emptyFilters = (): Filters => ({ q: '', sid: '', country: '', channel: '' });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const sameScope = (left: Choice, right: Choice) => left.snapshot.sid === right.snapshot.sid && left.snapshot.country === right.snapshot.country && left.snapshot.channel === right.snapshot.channel;
const certainFailure = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
function freshDraft(props: BatchWizardProps): Draft {
  return { version: 2, step: 1, mode: props.initialShippingRunId ? 'existing' : 'new', runId: props.initialShippingRunId ?? '', numberingDate: shanghaiToday(), selected: [], filters: emptyFilters(), name: '', reason: '人工选择需求建立发货批次', confirmed: false, reviewVersion: null, pending: null, result: null, resultLabel: '', legacy: null };
}
function readDraft(key: string, props: BatchWizardProps): Draft {
  const fallback = freshDraft(props);
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!object(value)) return fallback;
    const selected = (Array.isArray(value.selected) && value.selected.length <= 1000 ? value.selected : []).flatMap((item): Choice[] => {
      if (!object(item) || !uuid(item.id) || !Number.isInteger(item.version) || Number(item.version) < 1 || typeof item.businessDate !== 'string') return [];
      const snapshot = demandSnapshotSchema.safeParse(item.snapshot);
      return snapshot.success ? [{ id: item.id, version: Number(item.version), businessDate: item.businessDate, snapshot: snapshot.data }] : [];
    });
    if (value.version === 1) return { ...fallback, selected, name: typeof value.name === 'string' ? value.name.slice(0, 120) : '', reason: typeof value.reason === 'string' ? value.reason.slice(0, 1000) : fallback.reason, legacy: value.pendingWeek || value.pendingGroup ? { pendingWeek: value.pendingWeek, pendingGroup: value.pendingGroup } as Legacy : null };
    if (value.version !== 2 || !Array.isArray(value.selected) || value.selected.length > 1000) return fallback;
    let pending: Pending | null = null;
    if (object(value.pending) && value.pending.kind === 'new') { const input = createManualShippingRunInputSchema.safeParse(value.pending.input); if (input.success) pending = { kind: 'new', input: input.data }; }
    if (object(value.pending) && value.pending.kind === 'existing' && uuid(value.pending.runId)) { const input = addShippingTicketInputSchema.safeParse(value.pending.input); if (input.success) pending = { kind: 'existing', runId: value.pending.runId, input: input.data }; }
    const parsed = batchMutationResultSchema.safeParse(value.result);
    const result = parsed.success && parsed.data.batchId && parsed.data.groupId ? parsed.data : null;
    return { ...fallback, step: result ? 4 : pending ? 3 : [1, 2, 3].includes(Number(value.step)) ? value.step as Step : 1,
      mode: value.mode === 'existing' ? 'existing' : 'new', runId: uuid(value.runId) ? value.runId : '', numberingDate: typeof value.numberingDate === 'string' ? value.numberingDate : fallback.numberingDate,
      name: typeof value.name === 'string' ? value.name.slice(0, 120) : '', reason: typeof value.reason === 'string' ? value.reason.slice(0, 1000) : fallback.reason,
      selected, reviewVersion: Number.isInteger(value.reviewVersion) ? Number(value.reviewVersion) : null, confirmed: false, pending, result,
      resultLabel: typeof value.resultLabel === 'string' ? value.resultLabel : '', legacy: object(value.legacy) ? value.legacy as Legacy : null };
  } catch { return fallback; }
}
async function availableDemands(): Promise<Choice[]> {
  const choices = new Map<string, Choice>();
  for (let page = 1; ; page++) {
    const result = await api.demands(demandWorkspaceQuerySchema.parse({ grouping: 'ungrouped', lifecycle: 'active', pageBy: 'demand', page, pageSize: 100 }));
    for (const row of result.rows) if (!row.groupId && row.lifecycle === 'active' && !row.lifecyclePending) choices.set(row.demandId, { id: row.demandId, version: row.currentDemandVersion, businessDate: row.businessDate, snapshot: { sid: row.sid, fba: row.fba, shop: row.shop, country: row.country, channel: row.channel, destinationFc: row.destinationFc, referenceQuantity: row.referenceQuantity, notes: row.notes, subBatchName: null, destinationAddress: row.destinationAddress } });
    if (page * result.pageSize >= result.demandTotal) return [...choices.values()];
  }
}
export function BatchWizard(props: BatchWizardProps) {
  const selection = [...new Set(props.initialDemandIds ?? [])].sort().join(',');
  let hash = 2166136261;
  for (let index = 0; index < selection.length; index++) hash = Math.imul(hash ^ selection.charCodeAt(index), 16777619);
  const suffix = selection ? `:selection-${hash >>> 0}` : '';
  const scope = `${props.userId}:${props.existingGroupId ? `legacy-${props.existingGroupId}` : props.initialShippingRunId ?? props.initialWeeklyBatchId ?? props.initialWeekStartDate ?? 'new'}${suffix}`;
  const [storageKey] = useState(() => {
    const fallback = `scm-batch-wizard:${scope}`;
    const oldScope = props.initialWeeklyBatchId ?? props.initialWeekStartDate;
    const explicit = oldScope ? `scm-batch-wizard:${props.userId}:${oldScope}${suffix}` : null;
    const matchesPending = (key: string, legacyOnly = false) => {
      try {
        const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (!object(value)) return false;
        if (!legacyOnly && value.version === 2 && value.pending) return true;
        if (value.version !== 1 || !value.pendingWeek && !value.pendingGroup) return false;
        const groupIds = object(value.pendingGroup) && object(value.pendingGroup.input) && Array.isArray(value.pendingGroup.input.demandIds) ? value.pendingGroup.input.demandIds : [];
        const selected = groupIds.length ? groupIds : Array.isArray(value.selected) ? value.selected.flatMap((entry) => object(entry) && typeof entry.id === 'string' ? [entry.id] : []) : [];
        return !selection || !selected.length || [...new Set(selected)].sort().join(',') === selection;
      } catch { return false; }
    };
    if (explicit && matchesPending(explicit)) return explicit;
    if (matchesPending(fallback)) return fallback;
    if (selection && !props.existingGroupId) {
      const prefix = `scm-batch-wizard:${props.userId}:`;
      try {
        for (let index = 0; index < sessionStorage.length; index++) {
          const key = sessionStorage.key(index);
          if (key?.startsWith(prefix) && key.endsWith(suffix) && matchesPending(key, true)) return key;
        }
      } catch { /* Storage restrictions do not change or clear any original request. */ }
    }
    return fallback;
  });
  return <BatchWizardSession key={storageKey} {...props} storageKey={storageKey} />;
}
function BatchWizardSession(props: BatchWizardProps & { storageKey: string }) {
  const { open, onClose, canManage = true, storageKey } = props;
  const client = useQueryClient(); const prefix = useId();
  const [draft, setDraft] = useState(() => readDraft(storageKey, props));
  const current = useRef(draft); const heading = useRef<HTMLHeadingElement>(null); const progress = useRef<HTMLElement>(null); const applied = useRef(false); const notified = useRef(new Set<string>());
  const [notice, setNotice] = useState('');
  const update = useCallback((change: Partial<Draft> | ((value: Draft) => Draft)) => {
    const next = typeof change === 'function' ? change(current.current) : { ...current.current, ...change };
    current.current = next; setDraft(next); try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Mounted state keeps exact requests too. */ }
  }, [storageKey]);
  const runs = useQuery({ queryKey: ['shipping-runs'], queryFn: shippingRunApi.list, enabled: open, retry: false });
  const initialScope = useQuery({ queryKey: ['batch', props.initialWeeklyBatchId], queryFn: () => batchApi.detail(props.initialWeeklyBatchId!), enabled: open && Boolean(props.initialWeeklyBatchId) && !props.initialShippingRunId && !draft.pending && !draft.legacy, retry: false });
  const run = useQuery({ queryKey: ['shipping-run', draft.runId], queryFn: () => shippingRunApi.detail(draft.runId), enabled: open && draft.mode === 'existing' && Boolean(draft.runId), retry: false });
  const pool = useQuery({ queryKey: ['demands', 'manual-available'], queryFn: availableDemands, enabled: open && draft.step !== 4 && !draft.legacy, retry: false });
  const legacyGroup = useQuery({ queryKey: ['sub-batch', props.existingGroupId], queryFn: () => batchApi.group(props.existingGroupId!), enabled: open && Boolean(props.existingGroupId) && !draft.result, retry: false });
  const invalidate = () => Promise.all([['shipping-runs'], ['shipping-run'], ['demands'], ['batches'], ['batch'], ['sub-batch'], ['batch-workspace']].map((queryKey) => client.invalidateQueries({ queryKey })));
  const create = useMutation({ networkMode: 'always', mutationFn: async (request: Pending) => {
    const detail = request.kind === 'new' ? await shippingRunApi.createManual(request.input) : await shippingRunApi.addTicket(request.runId, request.input);
    const ids = new Set(request.input.demandIds);
    const ticket = detail.tickets.find((entry) => entry.members.length === ids.size && entry.members.every((member) => member.demandId && ids.has(member.demandId)));
    const groupId = ticket?.members[0]?.groupId;
    if (!groupId) throw new ApiError('无法识别批次建立结果，原请求已保留，请重试。', 0);
    let group: Awaited<ReturnType<typeof batchApi.group>>;
    try { group = await batchApi.group(groupId); } catch { throw new ApiError('批次已接收，暂时无法读取建立结果。请重试原请求核对。', 0); }
    return { detail, result: { operationId: request.input.operationId, batchId: group.group.batchId, groupId, replayed: false } satisfies BatchMutationResult, label: `${detail.run.month} 第 ${detail.run.sequence} 次发货 · ${ticket?.number ?? ''}` };
  }, onSuccess: async ({ detail, result, label }) => {
    client.setQueryData(['shipping-run', detail.run.id], detail); update({ pending: null, result, resultLabel: label, step: 4, confirmed: false }); await invalidate();
  }, onError: (error) => { if (certainFailure(error)) { update({ pending: null, confirmed: false, reviewVersion: null }); setNotice('发货次或需求已变化，名称与选择已保留，请刷新并重新核对。'); void pool.refetch(); if (draft.mode === 'existing') void run.refetch(); } } });
  const recover = useMutation({ networkMode: 'always', mutationFn: async () => {
    const legacy = current.current.legacy;
    if (legacy?.pendingGroup) return batchMutationResultSchema.parse(await request(`/api/v1/weekly-batches/${encodeURIComponent(legacy.pendingGroup.batchId)}/sub-batches`, { method: 'POST', body: JSON.stringify(legacy.pendingGroup.input) }));
    if (legacy?.pendingWeek) return batchApi.materialize(legacy.pendingWeek);
    throw new Error('没有待核对的原请求。');
  }, onSuccess: async (result) => {
    if (result.groupId && result.batchId) update({ result, resultLabel: '已恢复历史批次', step: 4, legacy: null });
    else { update({ legacy: null, step: 1 }); setNotice('旧请求已核对，继续选择本次发货归属。'); }
    await invalidate();
  }, onError: (error) => { if (certainFailure(error)) { update({ legacy: null, step: 1 }); setNotice(`旧请求未执行：${messageOf(error)}。请按月份和发货次重新核对。`); } } });
  const locked = create.isPending || Boolean(draft.pending || draft.legacy);
  const edit = (change: Partial<Draft>) => { if (!locked) { create.reset(); update({ ...change, confirmed: false }); } };
  const existing = runs.data?.items.filter((item) => (item.lifecycle ?? 'active') === 'active' && !item.lifecyclePending && !item.membershipFrozenAt && !['queued', 'running'].includes(item.status)) ?? [];
  const runValid = draft.mode === 'new' ? !dateInputError(draft.numberingDate, { required: true }) : Boolean(run.data && !run.isError && !run.isFetching && (run.data.run.lifecycle ?? 'active') === 'active' && !run.data.run.lifecyclePending && !run.data.run.membershipFrozenAt && !['queued', 'running'].includes(run.data.run.status));
  const scopeLabel = draft.mode === 'new' ? `${draft.numberingDate.slice(0, 7)} 下一次发货` : run.data ? `${run.data.run.month} 第 ${run.data.run.sequence ?? '待分配'} 次发货` : '请选择发货次';
  const available = props.existingGroupId ? legacyGroup.data?.members ?? [] : pool.data ?? []; const byId = new Map(available.map((entry) => [entry.id, entry])); const anchor = draft.selected[0];
  const compatible = (entry: Choice) => !anchor || sameScope(anchor, entry);
  const visible = available.filter((entry) => (!draft.filters.q || `${entry.snapshot.fba} ${entry.snapshot.shop} ${entry.snapshot.destinationFc ?? ''}`.toLocaleLowerCase().includes(draft.filters.q.toLocaleLowerCase())) && (!draft.filters.sid || String(entry.snapshot.sid) === draft.filters.sid) && (!draft.filters.country || entry.snapshot.country === draft.filters.country) && (!draft.filters.channel || entry.snapshot.channel === draft.filters.channel));
  const selectedIds = new Set(draft.selected.map((entry) => entry.id));
  const stale = draft.selected.some((entry) => byId.get(entry.id)?.version !== entry.version || !sameScope(entry, byId.get(entry.id) ?? entry));
  const versionStale = draft.mode === 'existing' && draft.reviewVersion !== null && draft.reviewVersion !== run.data?.run.version;
  const legacyValid = !props.existingGroupId || Boolean(legacyGroup.data && !legacyGroup.isError && !legacyGroup.isFetching && !legacyGroup.data.group.frozenAt && !['frozen', 'superseded'].includes(legacyGroup.data.group.status) && draft.selected.length === legacyGroup.data.members.length && legacyGroup.data.members.every((member) => selectedIds.has(member.id)));
  const validSelection = Boolean(draft.selected.length && !pool.isFetching && !pool.isError && !stale && legacyValid && draft.selected.every((entry) => sameScope(anchor!, entry)));
  const toggle = (entry: Choice, checked: boolean) => edit({ selected: checked ? [...draft.selected, entry] : draft.selected.filter((item) => item.id !== entry.id), reviewVersion: null });
  useEffect(() => {
    const shippingRunId = initialScope.data?.batch.shippingRunId;
    if (shippingRunId && !current.current.runId && current.current.step === 1 && !current.current.pending && !current.current.legacy) update({ mode: 'existing', runId: shippingRunId, reviewVersion: null });
  }, [initialScope.data, update]);
  useEffect(() => {
    if (!pool.data || props.existingGroupId && !legacyGroup.data || applied.current || draft.legacy || draft.result || draft.pending) return;
    const ids = new Set(props.initialDemandIds ?? (props.initialDemandId ? [props.initialDemandId] : []));
    if (!ids.size) { applied.current = true; return; }
    applied.current = true;
    if (draft.selected.length) return;
    const selected = (props.existingGroupId ? legacyGroup.data!.members : pool.data).filter((entry) => ids.has(entry.id));
    if (selected.some((entry) => !sameScope(selected[0]!, entry))) { setNotice('所选需求包含不同店铺、国家或渠道，请分别建立批次。'); return; }
    update({ selected, ...(props.existingGroupId && legacyGroup.data ? { name: current.current.name || legacyGroup.data.group.name, reason: '将完整历史批次关联到本次发货' } : {}) }); setNotice(`已带入 ${selected.length} 票需求${selected.length < ids.size ? '，部分需求已安排或不再可用' : ''}。`);
  }, [pool.data, legacyGroup.data, props.existingGroupId, props.initialDemandId, props.initialDemandIds, draft.selected.length, draft.legacy, draft.result, draft.pending, update]);
  useEffect(() => {
    if (!draft.result || notified.current.has(draft.result.operationId)) return;
    notified.current.add(draft.result.operationId); props.onCreated?.(draft.result);
  }, [draft.result, props]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); heading.current?.closest('.import-dialog-body')?.scrollTo({ top: 0 }); progress.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    return () => cancelAnimationFrame(frame);
  }, [open, draft.step]);
  useEffect(() => {
    if (!draft.pending && !draft.legacy) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
  }, [draft.pending, draft.legacy]);
  const submit = () => {
    if (create.isPending || !canManage) return;
    if (draft.pending) { create.mutate(draft.pending); return; }
    if (!draft.confirmed || !runValid || !validSelection || versionStale || !draft.name.trim() || !draft.reason.trim()) return;
    const input = { operationId: newOperation(), name: draft.name.trim(), reason: draft.reason.trim(), demandIds: draft.selected.map((entry) => entry.id), expectedDemandVersions: Object.fromEntries(draft.selected.map((entry) => [entry.id, entry.version])), ...(props.existingGroupId && legacyGroup.data ? { existingGroupId: props.existingGroupId, expectedGroupVersion: legacyGroup.data.group.version } : {}) };
    const pending: Pending = draft.mode === 'new' ? { kind: 'new', input: createManualShippingRunInputSchema.parse({ ...input, numberingDate: draft.numberingDate }) } : { kind: 'existing', runId: draft.runId, input: addShippingTicketInputSchema.parse({ ...input, expectedVersion: run.data!.run.version }) };
    update({ pending }); create.mutate(pending);
  };
  const close = () => { if (locked) { setNotice('建立结果尚未确认，请先重试原请求核对。'); return; } onClose(); };
  const refreshSelection = async () => { const result = await pool.refetch(); if (props.existingGroupId) { const group = await legacyGroup.refetch(); if (group.data) update({ selected: group.data.members, reviewVersion: null, confirmed: false, step: 2 }); } else if (result.data) update({ selected: draft.selected.flatMap((entry) => result.data.find((item) => item.id === entry.id) ?? []), reviewVersion: null, confirmed: false, step: 2 }); if (draft.mode === 'existing') void run.refetch(); };
  return <ImportDialog open={open} title="建立发货批次" close={close} wide><div className="batch-wizard">
    <nav ref={progress} className="batch-wizard-progress" aria-label="建立批次步骤"><ol>{stepLabels.map((label, index) => { const target = index + 1 as Step; return <li key={label} data-current={draft.step === target} data-complete={draft.step > target}><button type="button" aria-current={draft.step === target ? 'step' : undefined} disabled={locked || Boolean(draft.result) || target === 4 || target === 2 && !runValid || target === 3 && (!validSelection || draft.reviewVersion === null)} onClick={() => edit({ step: target })}><span className="batch-wizard-number" aria-hidden="true">{draft.step > target ? <Check size={15} /> : target}</span><span>{label}</span></button></li>; })}</ol></nav>
    <div className="batch-wizard-heading"><h3 ref={heading} tabIndex={-1}>{stepLabels[draft.step - 1]}</h3><p>{descriptions[draft.step - 1]}</p></div>
    {notice && <p className="permission-note" role="status">{notice}</p>}
    {props.existingGroupId && <p className="permission-note">关联完整历史批次，保留原记录。冻结批次须先建立批次更正，成员范围在关联时保持完整。</p>}
    {legacyGroup.isError && <WizardError title="无法核对历史批次" error={legacyGroup.error} retry={() => void legacyGroup.refetch()} />}
    {!canManage && <p className="permission-note">请使用管理员账号建立发货批次。</p>}
    {draft.legacy ? <div className="batch-wizard-recovery" role="status"><p>检测到旧版尚未确认结果的请求，原内容已保留。请先核对原请求，再选择发货次。</p><Button icon={RefreshCw} loading={recover.isPending} onClick={() => recover.mutate()}>核对原请求结果</Button>{recover.isError && <WizardError title="原请求结果仍未确认" error={recover.error} />}</div> : <>
    {draft.step === 1 && <div className="batch-wizard-occurrence"><div className="assignment-actions" role="group" aria-label="发货次归属"><Button type="button" disabled={locked} variant={draft.mode === 'new' ? 'primary' : 'secondary'} onClick={() => edit({ mode: 'new', reviewVersion: null })}>新建本月下一次发货</Button><Button type="button" disabled={locked} variant={draft.mode === 'existing' ? 'primary' : 'secondary'} onClick={() => edit({ mode: 'existing', reviewVersion: null })}>选择已有发货次</Button></div>
      {draft.mode === 'new' ? <><div className="field"><label htmlFor={`${prefix}-date`}>编号日期</label><DatePicker id={`${prefix}-date`} value={draft.numberingDate} disabled={locked} required onValueChange={(numberingDate) => edit({ numberingDate })} /></div><p className="mapping-help">按编号日期所在月份领取下一次发货序号。确认建立后才分配次数和票号。</p></> : <><div className="field"><label htmlFor={`${prefix}-run`}>发货月份与次数</label><Combobox id={`${prefix}-run`} value={draft.runId} disabled={locked || runs.isFetching} searchPlaceholder="搜索月份或编号日期…" options={[{ value: '', label: '请选择可调整的发货次' }, ...existing.map((entry) => ({ value: entry.id, label: `${entry.month} 第 ${entry.sequence ?? '待分配'} 次 · ${entry.numberingDate}`, keywords: [entry.month, entry.numberingDate] }))]} onValueChange={(runId) => edit({ runId, reviewVersion: null })} /></div>{runs.isError && <WizardError title="无法读取发货次" error={runs.error} retry={() => void runs.refetch()} />}{run.isError && <WizardError title="无法读取发货次详情" error={run.error} retry={() => void run.refetch()} />}{!runs.isPending && !existing.length && <p className="mapping-help">暂无可调整的发货次。可新建本月下一次发货；已发布的发货次请先建立更正版本。</p>}</>}
    </div>}
    {(draft.step === 2 || draft.step === 3) && pool.isPending && <p className="list-state" role="status">正在读取未分组需求…</p>}
    {(draft.step === 2 || draft.step === 3) && pool.isError && <WizardError title="无法读取需求" error={pool.error} retry={() => void pool.refetch()} />}
    {draft.step === 2 && pool.data && <><div className="batch-wizard-scope"><strong>{scopeLabel}</strong><Button type="button" icon={RefreshCw} loading={pool.isFetching} disabled={locked} onClick={() => void pool.refetch()}>刷新需求</Button></div>
      <div className="batch-wizard-filters"><div className="field"><label htmlFor={`${prefix}-query`}>搜索需求</label><Input id={`${prefix}-query`} value={draft.filters.q} maxLength={200} disabled={locked} placeholder="FBA、店铺或目的仓" onChange={(event) => edit({ filters: { ...draft.filters, q: event.target.value } })} /></div>{(['sid', 'country', 'channel'] as const).map((field) => { const options = field === 'sid' ? [...new Map(available.map((entry) => [String(entry.snapshot.sid), entry.snapshot.shop])).entries()].map(([value, label]) => ({ value, label })) : [...new Set(available.map((entry) => entry.snapshot[field] ?? '').filter(Boolean))].map((value) => ({ value, label: value })); const label = { sid: '店铺', country: '国家', channel: '业务渠道' }[field]; return <div className="field" key={field}><label htmlFor={`${prefix}-${field}`}>{label}</label><Combobox id={`${prefix}-${field}`} value={draft.filters[field]} disabled={locked} options={[{ value: '', label: `全部${label}` }, ...options]} onValueChange={(value) => edit({ filters: { ...draft.filters, [field]: value } })} /></div>; })}</div>
      <div className="batch-wizard-selection-actions"><strong role="status">已选 {draft.selected.length} 票</strong><span>跨筛选保留</span><Button icon={CheckCheck} disabled={locked || Boolean(props.existingGroupId) || !visible.length || draft.selected.length >= 1000 || !anchor && visible.some((entry) => !sameScope(visible[0]!, entry))} onClick={() => edit({ selected: [...draft.selected, ...visible.filter((entry) => compatible(entry) && !selectedIds.has(entry.id))].slice(0, 1000), reviewVersion: null })}>选择筛选中的兼容需求</Button><Button variant="text" icon={X} disabled={locked || Boolean(props.existingGroupId) || !draft.selected.length} onClick={() => edit({ selected: [], reviewVersion: null })}>清空选择</Button></div>
      <p className="mapping-help">{anchor ? `当前选择：${anchor.snapshot.shop} · ${anchor.snapshot.country} · ${anchor.snapshot.channel || '未填渠道'}。` : '同一批次须为同店铺、国家和业务渠道。'}可选择不同日期导入的需求。</p>
      {stale && <p className="permission-note warning-note">部分需求已变化或已被安排。<Button icon={RefreshCw} disabled={locked} onClick={() => void refreshSelection()}>重新核对所选需求</Button></p>}
      {visible.length ? <div className="table-scroll batch-wizard-table" role="region" aria-label="待选择需求，可横向滚动" tabIndex={0}><table className="task-table"><thead><tr><th scope="col">选择</th><th scope="col">FBA / 店铺</th><th scope="col">国家 / 渠道</th><th scope="col">首次业务日期 / 目的仓</th></tr></thead><tbody>{visible.map((entry) => <tr key={entry.id}><td><label className="batch-wizard-row-select"><input type="checkbox" aria-label={`选择 ${entry.snapshot.fba}`} checked={selectedIds.has(entry.id)} disabled={locked || Boolean(props.existingGroupId) || !compatible(entry) || !selectedIds.has(entry.id) && draft.selected.length >= 1000} onChange={(event) => toggle(entry, event.target.checked)} /></label></td><td><strong>{entry.snapshot.fba}</strong><small>{entry.snapshot.shop} · sid {entry.snapshot.sid}</small></td><td>{entry.snapshot.country}<small>{entry.snapshot.channel || '未填渠道'}</small></td><td>{entry.businessDate}<small>{entry.snapshot.destinationFc || '未填目的仓'}</small></td></tr>)}</tbody></table></div> : <p className="list-state">{available.length ? '此筛选没有未分组需求，已选需求仍保留。' : '暂无未分组需求，请先导入并提交需求。'}</p>}
    </>}
    {draft.step === 3 && <><dl className="batch-wizard-review"><div><dt>发货归属</dt><dd>{scopeLabel}</dd></div><div><dt>成员范围</dt><dd>{anchor ? `${anchor.snapshot.shop} · ${anchor.snapshot.country} · ${anchor.snapshot.channel || '未填渠道'}` : '尚未选择'}</dd></div><div><dt>本次需求</dt><dd>{draft.selected.length} 票</dd></div></dl><div className="batch-wizard-review-fields"><div className="field"><label htmlFor={`${prefix}-name`}>发货批次名称</label><Input id={`${prefix}-name`} value={draft.name} required maxLength={120} disabled={locked} onChange={(event) => edit({ name: event.target.value })} /></div><div className="field"><label htmlFor={`${prefix}-reason`}>建立说明</label><textarea id={`${prefix}-reason`} value={draft.reason} rows={3} maxLength={1000} disabled={locked} onChange={(event) => edit({ reason: event.target.value })} /></div></div><details className="batch-wizard-selected"><summary>核对本次 {draft.selected.length} 票需求</summary><ul>{draft.selected.map((entry) => <li key={entry.id}><span>{entry.snapshot.fba}<small>{entry.businessDate} · 需求版本 {entry.version}</small></span></li>)}</ul></details>
      {(stale || versionStale || !runValid || draft.reviewVersion === null) && !draft.pending && <div className="permission-note warning-note">发货次或需求需要重新核对，名称与选择已保留。<Button icon={RefreshCw} onClick={() => void refreshSelection()}>返回选择并核对</Button></div>}
      <label className="import-check batch-wizard-confirm"><input type="checkbox" checked={draft.confirmed} disabled={locked || !runValid || !validSelection || versionStale || draft.reviewVersion === null} onChange={(event) => update({ confirmed: event.target.checked })} /><span>已核对发货次、店铺、国家和渠道，确认建立批次。</span></label>
      {create.isError && <WizardError title={draft.pending ? '建立结果尚未确认' : '批次尚未建立'} error={create.error} />}
      {draft.pending && <div className="batch-wizard-recovery" role="status"><p>原请求和所选需求已保留。重试将核对同一次操作。</p><Button variant="primary" icon={RefreshCw} loading={create.isPending} onClick={submit}>重试原建立请求</Button></div>}
    </>}
    {draft.step === 4 && draft.result && <div className="batch-wizard-result"><CircleCheck size={28} aria-hidden="true" /><div><h4>发货批次已建立</h4><p><strong>{draft.name}</strong> · {draft.selected.length} 票需求</p><p>{draft.resultLabel}</p><p className="mapping-help">继续同步商品与逐箱数据，再核对确认并导出。</p></div></div>}
    <div className="batch-wizard-footer"><div>{draft.step > 1 && draft.step < 4 && <Button icon={ArrowLeft} disabled={locked} onClick={() => edit({ step: draft.step - 1 as Step })}>上一步</Button>}</div><div>{draft.step === 1 && <Button variant="primary" icon={ArrowRight} disabled={locked || !canManage || !runValid} onClick={() => edit({ step: 2 })}>下一步：选择需求</Button>}{draft.step === 2 && <Button variant="primary" icon={ArrowRight} disabled={locked || !canManage || !runValid || !validSelection} onClick={() => edit({ step: 3, reviewVersion: draft.mode === 'new' ? 0 : run.data!.run.version })}>下一步：核对与建立</Button>}{draft.step === 3 && <Button variant="primary" icon={Check} loading={create.isPending} disabled={locked || !canManage || !draft.confirmed || !runValid || !validSelection || versionStale || !draft.name.trim() || !draft.reason.trim() || draft.reviewVersion === null} onClick={submit}>确认建立发货批次</Button>}{draft.step === 4 && <><Button onClick={() => { applied.current = true; update(freshDraft(props)); }}>新建另一批次</Button>{props.onOpenCreated ? <Button variant="primary" icon={ArrowRight} onClick={() => props.onOpenCreated?.(draft.result!)}>继续同步与核对</Button> : <Button variant="primary" onClick={close}>完成</Button>}</>}</div></div>
    </>}
  </div></ImportDialog>;
}
function WizardError({ title, error, retry }: { title: string; error: unknown; retry?: () => void }) {
  return <div className="inline-error" role="alert"><div><strong>{title}</strong><p>{error instanceof Error && error.name === 'ZodError' ? '服务返回的结果无法识别，请保留原请求并重试。' : messageOf(error)}</p></div>{retry && <Button icon={RefreshCw} onClick={retry}>重试</Button>}</div>;
}

