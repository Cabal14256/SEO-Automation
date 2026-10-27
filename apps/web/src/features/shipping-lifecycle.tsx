import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shippingLifecycleImpactSchema, shippingLifecycleInputSchema } from '@scm/contracts';
import { ArchiveRestore, Ban, RefreshCw, Search, Trash2 } from 'lucide-react';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { BatchPagination, BatchTable, messageOf, newOperation, QueryError, timestamp } from './batch-shared';
import { ImportDialog } from './import-dialog';
import { lifecycleApi, lifecycleOf, type LifecycleImpact, type LifecycleInput, type LifecycleResult, type LifecycleTarget, type ShippingLifecycleAction, type ShippingLifecycleType } from './shipping-lifecycle-api';
import './shipping-lifecycle.css';

const typeLabels = { run: '发货记录', group: '批次', demand: '需求' };
const verbs = { cancel: '取消', trash: '删除', restore: '恢复', purge: '彻底删除' };
export const lifecycleLabels: Record<string, string> = { active: '当前', cancelled: '已取消', trashed: '回收站', purged: '已彻底删除' };
const operationLabel = (target: LifecycleTarget, action: ShippingLifecycleAction) => `${verbs[action]}${action === 'cancel' && target.type === 'run' ? '本次发货' : typeLabels[target.type]}`;
const cacheKeys = ['shipping-runs', 'shipping-run', 'shipping-run-report', 'shipping-recycle-bin', 'shipping-lifecycle-impact', 'demand-assignment', 'demand-management', 'demands', 'batches', 'batch', 'sub-batch', 'batch-workspace', 'batch-sync', 'batch-reports', 'batch-exports', 'document-candidates', 'documents', 'document', 'document-exports', 'document-automations', 'workflow-sources', 'workflow-records', 'workflow', 'physical-review'];

export function ShippingLifecycleActions({ target, active = true, disabled = false, changed }: { target: LifecycleTarget; active?: boolean; disabled?: boolean; changed?: (result: LifecycleResult) => void }) {
  const [action, setAction] = useState<ShippingLifecycleAction | null>(null);
  const lifecycle = lifecycleOf(target);
  if (lifecycle === 'purged') return <span className="mapping-subtext">已彻底删除</span>;
  const actions: ShippingLifecycleAction[] = lifecycle === 'trashed' ? ['restore', 'purge'] : lifecycle === 'cancelled' ? ['restore', 'trash'] : ['cancel', 'trash'];
  return <div className="shipping-lifecycle-actions">{target.lifecyclePending && <span className="mapping-subtext" role="status">正在停止后台任务…</span>}{actions.map((item) => <Button type="button" key={item} variant="text" icon={item === 'restore' ? ArchiveRestore : item === 'cancel' ? Ban : Trash2} disabled={disabled || target.lifecyclePending} onClick={() => setAction(item)}>{operationLabel(target, item)}</Button>)}
    {action && <ShippingLifecycleDialog key={`${target.type}:${target.id}:${action}`} target={target} action={action} active={active} close={() => setAction(null)} completed={(result) => { setAction(null); changed?.(result); }} />}
  </div>;
}

type PendingLifecycle = { input: LifecycleInput; impact: LifecycleImpact; accepted?: boolean };
const parsePending = (value: string | null): PendingLifecycle | null => { try { const saved: unknown = JSON.parse(value ?? 'null'); if (!saved || typeof saved !== 'object' || !('input' in saved) || !('impact' in saved)) return null; const input = shippingLifecycleInputSchema.safeParse(saved.input), impact = shippingLifecycleImpactSchema.safeParse(saved.impact); return input.success && impact.success ? { input: input.data, impact: impact.data, accepted: 'accepted' in saved && saved.accepted === true } : null; } catch { return null; } };
export function ShippingLifecycleDialog({ target, action, active, close, completed }: { target: LifecycleTarget; action: ShippingLifecycleAction; active: boolean; close: () => void; completed: (result: LifecycleResult) => void }) {
  const client = useQueryClient();
  const reasonId = useId();
  const actor = client.getQueryData<{ user?: { id: string } }>(['session'])?.user?.id ?? 'current';
  const storageKey = `scm-shipping-lifecycle:${actor}:${target.type}:${target.id}:${action}`;
  const [pending, setPending] = useState<PendingLifecycle | null>(() => { try { const saved = parsePending(sessionStorage.getItem(storageKey)); return saved?.impact.id === target.id && saved.impact.action === action ? saved : null; } catch { return null; } });
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [reason, setReason] = useState(pending?.input.reason ?? '');
  const [confirmed, setConfirmed] = useState(Boolean(pending));
  const [reloaded, setReloaded] = useState(false);
  const query = useQuery({ queryKey: ['shipping-lifecycle-impact', target.type, target.id, action], queryFn: () => lifecycleApi.impact(target, action), enabled: active && !pending, retry: false, refetchOnWindowFocus: false, staleTime: 0 });
  const impact = pending?.impact ?? query.data;
  const savePending = (value: PendingLifecycle | null) => { pendingRef.current = value; setPending(value); try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* The mounted dialog still preserves the exact request. */ } window.dispatchEvent(new Event('scm-shipping-lifecycle-pending')); };
  const mutation = useMutation({ networkMode: 'always', mutationFn: (input: LifecycleInput) => lifecycleApi.mutate(target, action, input), onSuccess: async (result) => {
    savePending(result.pending && pendingRef.current ? { ...pendingRef.current, accepted: true } : null);
    await Promise.all(cacheKeys.map((key) => client.invalidateQueries({ queryKey: [key] })));
    completed(result);
  }, onError: (error) => {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) { savePending(null); setConfirmed(false); }
    if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] });
  } });
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  const reload = async () => { mutation.reset(); setConfirmed(false); setReloaded(false); const result = await query.refetch(); if (result.isSuccess) setReloaded(true); };
  const submit = () => {
    if (mutation.isPending) return;
    if (pendingRef.current) { mutation.mutate(pendingRef.current.input); return; }
    if (!impact || !impact.canExecute || !reason.trim() || !confirmed || query.isFetching || conflict) return;
    const next = { impact, input: { operationId: newOperation(), expectedVersion: impact.version, reason: reason.trim(), impactToken: impact.impactToken } };
    savePending(next); mutation.mutate(next.input);
  };
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (mutation.isPending) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [mutation.isPending]);
  const label = operationLabel(target, action);
  const busy = mutation.isPending;
  return <ImportDialog open={active} title={label} close={close} closeDisabled={busy}>
    <form className="shipping-lifecycle-dialog" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <p><strong>{impact?.name ?? target.name}</strong>{impact && <small className="mapping-subtext">当前 v{impact.version} · {lifecycleLabels[impact.lifecycle ?? 'active']}</small>}</p>
      {action === 'purge' ? <p className="form-note error-note">彻底删除后不能恢复。已发布文件、审计和已发生的外部业务事实仍保留用于追溯。</p> : action === 'restore' ? <p>恢复前重新检查原成员及当前占用；已失效的确认和文件需要重新核对、生成与复核。</p> : <p>{target.type === 'demand' ? '该需求将停止参与当前发货，并释放所属批次安排。' : '本次安排将作废，成员需求继续保留并回到待分组池，可重新安排。'}{action === 'trash' ? '记录移入回收站，可在回收站恢复。' : '取消后可在已取消记录中恢复。'}</p>}
      {action !== 'restore' && <p className="mapping-help">本操作只处理本系统记录；领星、物流商及申报平台的外部单据需另行处理。</p>}
      {!impact && (query.isError ? <QueryError error={query.error} retry={() => void query.refetch()} /> : <p role="status" className="list-state">正在核对影响范围与当前版本…</p>)}
      {impact && <>
        <dl className="shipping-lifecycle-counts"><div><dt>涉及 FBA</dt><dd>{impact.members.length}</dd></div><div><dt>关联批次</dt><dd>{impact.groups.length}</dd></div><div><dt>关联单据</dt><dd>{impact.documents.length}</dd></div><div><dt>后续业务记录</dt><dd>{impact.workflowCount}</dd></div></dl>
        {impact.members.length > 0 && <details open={impact.members.length <= 8}><summary>涉及的 FBA（{impact.members.length}）</summary><ul className="shipping-lifecycle-members">{impact.members.map((member) => <li key={member.id}>{member.fba}</li>)}</ul></details>}
        {impact.documents.length > 0 && <details><summary>受影响单据（{impact.documents.length}）</summary><ul>{impact.documents.map((document) => <li key={document.id}>{document.title}</li>)}</ul><p className="mapping-help">来源作废后整份关联文件失效，原文件与业务事实保留。</p></details>}
        {impact.groups.length > 0 && <details><summary>涉及的批次（{impact.groups.length}）</summary><ul>{impact.groups.map((group) => <li key={group.id}>{group.name}</li>)}</ul></details>}
        {impact.affectedRuns.length > 0 && <details><summary>受影响发货记录（{impact.affectedRuns.length}）</summary><ul>{impact.affectedRuns.map((run) => <li key={run.id}>{run.name}</li>)}</ul></details>}
        {impact.conflicts.length > 0 && <div className="form-note error-note" role="alert"><strong>当前存在冲突</strong><ul>{impact.conflicts.map((item, index) => <li key={`${item.code}:${index}`}>{item.fba ? `${item.fba}：` : ''}{item.message}</li>)}</ul></div>}
        {impact.blockingReasons.length > 0 && <div className="form-note error-note" role="alert"><ul>{impact.blockingReasons.map((item) => <li key={item}>{item}</li>)}</ul></div>}
        {impact.willRestoreTo && <p className="mapping-help">恢复后：{lifecycleLabels[impact.willRestoreTo] ?? impact.willRestoreTo}。</p>}
        <div className="field"><label htmlFor={reasonId}>{verbs[action]}原因</label><Input id={reasonId} required maxLength={2000} value={reason} disabled={busy || Boolean(pending)} onChange={(event) => setReason(event.target.value)} /></div>
        <label className="import-check"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(pending) || !impact.canExecute} onChange={(event) => setConfirmed(event.target.checked)} /><span>已核对以上范围和影响，确认{label}。</span></label>
      </>}
      {pending && !busy && <p className="form-note" role="status">原请求已保留。结果未确认前，请重试原请求；刷新或重新打开后仍沿用同一操作编号与内容。</p>}
      {mutation.isError && <div className="inline-error" role="alert"><p>{messageOf(mutation.error)} {pending ? '请重试原请求核对结果。' : '原因已保留，请重新核对影响范围。'}</p>{!pending && <Button type="button" icon={RefreshCw} onClick={() => void reload()}>重新核对影响范围</Button>}</div>}
      {reloaded && <p className="form-note" role="status">已读取最新影响范围，原因已保留，请重新勾选确认。</p>}
      <div className="shipping-lifecycle-footer"><Button type="button" disabled={busy} onClick={close}>返回</Button><Button type="submit" icon={action === 'restore' ? ArchiveRestore : action === 'cancel' ? Ban : Trash2} loading={busy} loadingLabel="正在提交并核对结果…" disabled={!pending && (!impact?.canExecute || !reason.trim() || !confirmed || query.isFetching || conflict)}>{pending ? '重试原请求' : `确认${label}`}</Button></div>
    </form>
  </ImportDialog>;
}

export function ShippingLifecyclePending({ active }: { active: boolean }) {
  const client = useQueryClient();
  const actor = client.getQueryData<{ user?: { id: string } }>(['session'])?.user?.id ?? 'current';
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<PendingLifecycle | null>(null);
  useEffect(() => { const changed = () => setRevision((value) => value + 1); window.addEventListener('scm-shipping-lifecycle-pending', changed); return () => window.removeEventListener('scm-shipping-lifecycle-pending', changed); }, []);
  const read = () => { void revision; const result: PendingLifecycle[] = []; try { for (let index = 0; index < sessionStorage.length; index++) { const key = sessionStorage.key(index); if (key?.startsWith(`scm-shipping-lifecycle:${actor}:`)) { const value = parsePending(sessionStorage.getItem(key)); if (value) result.push(value); } } } catch { /* Recovery remains available in an already open dialog. */ } return result; };
  const items = read();
  if (!items.length) return null;
  return <>{items.filter((item) => item.accepted).map((item) => <AcceptedLifecyclePoller key={item.input.operationId} item={item} actor={actor} active={active} />)}<Button type="button" icon={RefreshCw} onClick={() => setOpen(true)}>待核对操作（{items.length}）</Button><ImportDialog open={active && open} title="待核对发货操作" close={() => setOpen(false)} wide><p className="mapping-help">已受理的操作会自动刷新，后台任务安全结束后释放成员。结果未知的请求可原样重试核对。</p><BatchTable label="待核对发货操作" headers={['记录 / 操作', '原因', '核对']}>{items.map((item) => <tr key={item.input.operationId}><td>{item.impact.name}<small className="mapping-subtext">{operationLabel(item.impact, item.impact.action)} · {item.accepted ? '已受理，等待后台任务结束' : '结果待核对'}</small></td><td>{item.input.reason}</td><td><Button type="button" onClick={() => setSelected(item)}>核对原请求结果</Button></td></tr>)}</BatchTable>{selected && <ShippingLifecycleDialog key={selected.input.operationId} target={selected.impact} action={selected.impact.action} active={active && open} close={() => setSelected(null)} completed={() => { setSelected(null); setRevision((value) => value + 1); }} />}</ImportDialog></>;
}

function AcceptedLifecyclePoller({ item, actor, active }: { item: PendingLifecycle; actor: string; active: boolean }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['shipping-lifecycle-finalization', item.input.operationId], queryFn: () => lifecycleApi.mutate(item.impact, item.impact.action, item.input), enabled: active, retry: false, refetchInterval: (state) => !state.state.data || state.state.data.pending ? 1500 : false });
  useEffect(() => {
    if (!query.data || query.data.pending) return;
    try { sessionStorage.removeItem(`scm-shipping-lifecycle:${actor}:${item.impact.type}:${item.impact.id}:${item.impact.action}`); } catch { /* Query state still reflects completion for this mounted session. */ }
    window.dispatchEvent(new Event('scm-shipping-lifecycle-pending'));
    void Promise.all(cacheKeys.map((key) => client.invalidateQueries({ queryKey: [key] })));
  }, [query.data, actor, item.impact.type, item.impact.id, item.impact.action, client]);
  return null;
}

export function ShippingRecycleBin({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ShippingLifecycleType>('run');
  const [input, setInput] = useState('');
  const [q, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const searchId = useId();
  const list = useQuery({ queryKey: ['shipping-recycle-bin', type, q, page], queryFn: () => lifecycleApi.recycle(type, q, page), enabled: active && open, retry: false, refetchInterval: (query) => query.state.data?.items.some((item) => item.pending) ? 1500 : false });
  useEffect(() => { if (list.data && page > Math.max(1, Math.ceil(list.data.total / 20))) setPage(Math.max(1, Math.ceil(list.data.total / 20))); }, [list.data, page]);
  return <><Button type="button" icon={Trash2} onClick={() => setOpen(true)}>回收站</Button><ImportDialog open={active && open} title="发货回收站" close={() => setOpen(false)} wide>
    <div className="shipping-recycle-bin"><p className="mapping-help">删除的记录保留在此处。恢复前检查成员占用，彻底删除后不能恢复。</p>
      <div className="shipping-recycle-tabs" role="group" aria-label="回收站记录类型">{(['run', 'group', 'demand'] as const).map((value) => <Button type="button" key={value} aria-pressed={type === value} onClick={() => { setType(value); setPage(1); setNotice(''); }}>{typeLabels[value]}</Button>)}</div>
      <form className="shipping-recycle-search" onSubmit={(event) => { event.preventDefault(); setQuery(input.trim()); setPage(1); }}><div className="field"><label htmlFor={searchId}>搜索回收站</label><Input id={searchId} value={input} maxLength={200} placeholder="名称或 FBA" onChange={(event) => setInput(event.target.value)} /></div><Button type="submit" icon={Search}>搜索</Button><IconButton type="button" icon={RefreshCw} label="刷新回收站" loading={list.isFetching} onClick={() => void list.refetch()} /></form>
      {notice && <p className="form-note success-note" role="status">{notice}</p>}
      {list.isPending ? <p role="status" className="list-state">正在读取回收站…</p> : list.isError ? <QueryError error={list.error} retry={() => void list.refetch()} /> : !list.data.items.length ? <p className="list-state">{q ? '没有匹配的删除记录。' : `回收站暂无${typeLabels[type]}。`}</p> : <><BatchTable label="已删除发货记录" headers={['名称', '删除时间', '原因', '操作']}>{list.data.items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small className="mapping-subtext">{item.memberCount} 个 FBA{item.pending ? ' · 正在停止后台任务' : ''}</small></td><td>{timestamp(item.changedAt)}</td><td>{item.reason || '—'}</td><td><ShippingLifecycleActions target={{ ...item, type, lifecycle: 'trashed', lifecyclePending: item.pending }} active={active && open} changed={(result) => setNotice(result.purged ? '已彻底删除该记录。' : '恢复已提交，已按当前占用核对成员。')} /></td></tr>)}</BatchTable><BatchPagination page={page} pageSize={20} total={list.data.total} change={setPage} /></>}
    </div>
  </ImportDialog></>;
}
