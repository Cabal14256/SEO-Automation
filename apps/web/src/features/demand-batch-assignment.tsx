import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appendShippingTicketMembersInputSchema, type AppendShippingTicketMembersInput, type DemandRecord, type ShippingRunDetail, type SubBatchDetail } from '@scm/contracts';
import { ArrowRight, Plus } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button } from '../components/ui/button';
import { Combobox } from '../components/ui/combobox';
import { batchApi } from './batch-api';
import { shippingRunApi } from './shipping-run-api';
import { BatchWizard } from './batch-wizard';
import { ImportDialog } from './import-dialog';
import { messageOf, newOperation, QueryError } from './batch-shared';

export type DemandAssignment = { demandIds: string[]; mode: 'create' | 'append' };
type MonthlyAppend = { kind: 'monthly'; runId: string; ticketId: string; groupId: string; batchId: string; input: AppendShippingTicketMembersInput };
type LegacyAppend = { kind: 'legacy'; groupId: string; batchId: string; input: { operationId: string; expectedVersion: number; demandIds: string[]; expectedDemandVersions: Record<string, number>; reason: string } };
type AppendRequest = MonthlyAppend | LegacyAppend;
type Target = { detail: SubBatchDetail; run: ShippingRunDetail['run']; ticketId: string; ticketNumber: string | null };
const sameScope = (left: DemandRecord, right: DemandRecord) => left.snapshot.sid === right.snapshot.sid && left.snapshot.country === right.snapshot.country && left.snapshot.channel === right.snapshot.channel;
const currentKey = (userId: string) => `scm-demand-assignment:${userId}:current`;
export function readDemandAssignment(userId: string): DemandAssignment | null {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(currentKey(userId)) ?? 'null');
    if (!saved || typeof saved !== 'object' || !('demandIds' in saved) || !Array.isArray(saved.demandIds) || !saved.demandIds.length || saved.demandIds.length > 1000 || !saved.demandIds.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) return null;
    return { demandIds: saved.demandIds, mode: 'mode' in saved && saved.mode === 'append' ? 'append' : 'create' };
  } catch { return null; }
}
async function bounded<T, R>(items: T[], action: (item: T) => Promise<R>) {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += 8) result.push(...await Promise.all(items.slice(offset, offset + 8).map(action)));
  return result;
}
async function loadSelection(ids: string[]) {
  const records = await bounded(ids, api.demand);
  const demands = records.map((record) => record.demand).sort((a, b) => a.snapshot.sid - b.snapshot.sid || a.snapshot.country.localeCompare(b.snapshot.country) || (a.snapshot.channel ?? '').localeCompare(b.snapshot.channel ?? '') || a.snapshot.fba.localeCompare(b.snapshot.fba));
  const owners = new Map(records.flatMap((record) => record.management.groupId && record.management.batchId ? [[record.demand.id, { groupId: record.management.groupId, batchId: record.management.batchId }] as const] : []));
  const list = await shippingRunApi.list();
  const runs = await bounded(list.items.filter((run) => (run.lifecycle ?? 'active') === 'active' && !run.lifecyclePending && !run.membershipFrozenAt && !['queued', 'running'].includes(run.status)), (run) => shippingRunApi.detail(run.id));
  const refs = runs.flatMap((entry) => entry.tickets.flatMap((ticket) => [...new Set(ticket.members.flatMap((member) => member.groupId ? [member.groupId] : []))].map((groupId) => ({ run: entry.run, ticketId: ticket.id, ticketNumber: ticket.number, groupId }))));
  const groups = await bounded([...new Set(refs.map((entry) => entry.groupId))], batchApi.group);
  const targets: Target[] = refs.flatMap((ref) => { const detail = groups.find((group) => group.group.id === ref.groupId); return detail && (detail.group.lifecycle ?? 'active') === 'active' && !detail.group.lifecyclePending && !detail.group.frozenAt && !['frozen', 'superseded'].includes(detail.group.status) ? [{ detail, run: ref.run, ticketId: ref.ticketId, ticketNumber: ref.ticketNumber }] : []; });
  return { demands, owners, targets };
}
function readPending(key: string): AppendRequest | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!saved || typeof saved.groupId !== 'string' || typeof saved.batchId !== 'string' || !saved.input || typeof saved.input.operationId !== 'string') return null;
    if (saved.kind === 'monthly' && typeof saved.runId === 'string' && typeof saved.ticketId === 'string') { const input = appendShippingTicketMembersInputSchema.safeParse(saved.input); return input.success ? { ...saved, input: input.data } as MonthlyAppend : null; }
    if (Number.isInteger(saved.input.expectedVersion) && Array.isArray(saved.input.demandIds) && saved.input.expectedDemandVersions && typeof saved.input.reason === 'string') return { ...saved, kind: 'legacy' } as LegacyAppend;
    return null;
  } catch { return null; }
}
export function DemandBatchAssignment({ open, demandIds, mode = 'create', userId, onClose, onComplete, onOpenGroup }: {
  open: boolean; demandIds: string[]; mode?: 'create' | 'append'; userId: string;
  onClose: () => void; onComplete: () => void; onOpenGroup: (batchId: string, groupId: string) => void;
}) {
  const ids = [...new Set(demandIds)].sort();
  return <AssignmentSession key={ids.join(',')} open={open} demandIds={ids} mode={mode} userId={userId} onClose={onClose} onComplete={onComplete} onOpenGroup={onOpenGroup} />;
}
function AssignmentSession({ open, demandIds, mode, userId, onClose, onComplete, onOpenGroup }: Required<Parameters<typeof DemandBatchAssignment>[0]>) {
  const client = useQueryClient(); const prefix = useId();
  const pendingKey = `scm-demand-assignment:${userId}:${demandIds.join(',')}:pending`;
  const [pending, setPending] = useState<AppendRequest | null>(() => readPending(pendingKey)); const pendingRef = useRef(pending); pendingRef.current = pending;
  const [partitionKey, setPartitionKey] = useState(''); const [action, setAction] = useState(mode);
  const [targetId, setTargetId] = useState(pending?.groupId ?? ''); const [confirmed, setConfirmed] = useState(false);
  const [creation, setCreation] = useState<string[] | null>(null); const [result, setResult] = useState<{ groupId: string; batchId: string } | null>(null); const [notice, setNotice] = useState('');
  const query = useQuery({ queryKey: ['demand-assignment', demandIds], queryFn: () => loadSelection(demandIds), enabled: open && demandIds.length > 0, retry: false, refetchOnWindowFocus: false });
  const target = useQuery({ queryKey: ['sub-batch', targetId], queryFn: () => batchApi.group(targetId), enabled: open && Boolean(targetId) && !pending, retry: false, refetchOnWindowFocus: false });
  const partitions = new Map<string, DemandRecord[]>();
  const assigned = (query.data?.demands ?? []).filter((demand) => query.data?.owners.has(demand.id));
  for (const demand of query.data?.demands ?? []) if (!query.data!.owners.has(demand.id)) { const key = JSON.stringify([demand.snapshot.sid, demand.snapshot.country, demand.snapshot.channel]); partitions.set(key, [...partitions.get(key) ?? [], demand]); }
  const chosen = partitions.get(partitionKey) ?? (partitions.size === 1 ? [...partitions.values()][0] : undefined); const anchor = chosen?.[0];
  const eligible = query.data?.targets.filter((entry) => entry.detail.members.length > 0 && entry.detail.members.every((member) => anchor && sameScope(anchor, member))) ?? [];
  const selectedTarget = eligible.find((entry) => entry.detail.group.id === targetId);
  const targetValid = Boolean(selectedTarget && anchor && !query.isError && target.data && !target.isError && !target.isFetching && !target.data.group.frozenAt && !['frozen', 'superseded'].includes(target.data.group.status) && target.data.members.every((member) => sameScope(anchor, member)) && target.data.members.length + (chosen?.length ?? 0) <= 1000);
  const invalidate = () => Promise.all([['shipping-runs'], ['shipping-run'], ['demands'], ['batches'], ['batch'], ['sub-batch'], ['batch-workspace'], ['demand-assignment']].map((queryKey) => client.invalidateQueries({ queryKey })));
  const clearPending = () => { pendingRef.current = null; setPending(null); try { sessionStorage.removeItem(pendingKey); } catch { /* Mounted state remains usable. */ } };
  const mutation = useMutation({ networkMode: 'always', mutationFn: async (request: AppendRequest) => {
    if (request.kind === 'legacy') {
      const saved = await batchApi.groupAction(request.groupId, 'members', request.input);
      if (saved.groupId !== request.groupId || saved.batchId !== request.batchId) throw new ApiError('无法识别原加入请求的结果，请重试原请求。', 0);
    } else {
      const saved = await shippingRunApi.appendMembers(request.runId, request.ticketId, request.input);
      const ticket = saved.tickets.find((entry) => entry.id === request.ticketId);
      if (!ticket || !request.input.demandIds.every((id) => ticket.members.some((member) => member.demandId === id && member.groupId === request.groupId))) throw new ApiError('无法识别加入批次的结果，请重试原请求。', 0);
      client.setQueryData(['shipping-run', request.runId], saved);
    }
    return { groupId: request.groupId, batchId: request.batchId };
  }, onSuccess: async (saved) => { clearPending(); setResult(saved); await invalidate(); onComplete(); }, onError: (error) => {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) { clearPending(); setConfirmed(false); setNotice('批次或需求可能已变化，请刷新范围并重新核对。'); void query.refetch(); if (targetId) void target.refetch(); }
    if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] });
  } });
  const locked = mutation.isPending && !result || Boolean(pending);
  useEffect(() => { if (open) try { sessionStorage.setItem(currentKey(userId), JSON.stringify({ demandIds, mode: action })); } catch { /* Optional recovery. */ } }, [open, userId, demandIds, action]);
  useEffect(() => { if (!pending) return; const protect = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect); }, [pending]);
  const close = () => { if (creation) return; if (locked) { setNotice('加入结果尚未确认，请先重试原请求。'); return; } try { sessionStorage.removeItem(currentKey(userId)); } catch { /* Optional recovery. */ } onClose(); };
  const openGroup = (batchId: string, groupId: string) => { if (locked) return; try { sessionStorage.removeItem(currentKey(userId)); } catch { /* Optional recovery. */ } onClose(); onOpenGroup(batchId, groupId); };
  const append = () => {
    if (mutation.isPending) return;
    if (pendingRef.current) { mutation.mutate(pendingRef.current); return; }
    if (!confirmed || !chosen?.length || !targetValid || !target.data || !selectedTarget) return;
    const input = appendShippingTicketMembersInputSchema.parse({ operationId: newOperation(), expectedVersion: selectedTarget.run.version, groupId: targetId, expectedGroupVersion: target.data.group.version, demandIds: chosen.map((demand) => demand.id), expectedDemandVersions: Object.fromEntries(chosen.map((demand) => [demand.id, demand.version])), reason: '从需求工作区人工选择货件加入已有发货批次' });
    const request: MonthlyAppend = { kind: 'monthly', runId: selectedTarget.run.id, ticketId: selectedTarget.ticketId, groupId: targetId, batchId: target.data.group.batchId, input };
    try { sessionStorage.setItem(pendingKey, JSON.stringify(request)); } catch { /* Retain the exact request in memory too. */ }
    pendingRef.current = request; setPending(request); setNotice(''); mutation.mutate(request);
  };
  return <><ImportDialog open={open && !creation} title="安排发货批次" close={close} wide>
    {query.isPending && <p role="status">正在核对所选 {demandIds.length} 票需求及发货归属…</p>}{query.isError && <QueryError error={query.error} retry={() => void query.refetch()} />}{notice && <p className="permission-note" role="status">{notice}</p>}
    {result ? <div className="assignment-result"><h3>需求已加入发货批次</h3><p>原有成员和发货次数已保留，可继续同步与核对当前批次。</p><Button variant="primary" icon={ArrowRight} onClick={() => openGroup(result.batchId, result.groupId)}>继续同步与核对</Button><Button onClick={close}>完成，返回需求池</Button></div> : <>
      {assigned.length > 0 && <div className="assignment-existing"><h3>已有批次的需求 · {assigned.length} 票</h3><p className="mapping-help">保留原发货归属。可打开原批次继续处理或发起更正。</p><ul>{assigned.map((demand) => { const owner = query.data!.owners.get(demand.id)!; return <li key={demand.id}><span>{demand.snapshot.fba}</span><Button variant="text" disabled={locked} onClick={() => openGroup(owner.batchId, owner.groupId)}>打开原批次</Button></li>; })}</ul></div>}
      {partitions.size > 0 && <fieldset className="assignment-scope" disabled={locked || query.isFetching || query.isError}><legend>选择本次处理范围</legend><p className="mapping-help">同店铺、国家和渠道的需求可放入同一批次，允许选择不同日期导入的需求。</p>{[...partitions.entries()].map(([key, demands]) => { const first = demands[0]!; return <label key={key} className="assignment-scope-choice"><input type="radio" name={`${prefix}-scope`} value={key} checked={chosen === demands} onChange={() => { setPartitionKey(key); setTargetId(''); setConfirmed(false); mutation.reset(); }} /><span><strong>{first.snapshot.shop} · {first.snapshot.country} · {first.snapshot.channel || '未填渠道'}</strong><small>{demands.length} 票需求</small><small>{demands.map((demand) => demand.snapshot.fba).join('、')}</small></span></label>; })}</fieldset>}
      {anchor && <><div className="assignment-actions" role="group" aria-label="批次安排方式"><Button disabled={locked} variant={action === 'create' ? 'primary' : 'secondary'} onClick={() => { setAction('create'); setConfirmed(false); }}>新建发货批次</Button><Button disabled={locked} variant={action === 'append' ? 'primary' : 'secondary'} onClick={() => { setAction('append'); setConfirmed(false); }}>加入已有批次</Button></div>
        {action === 'create' ? <><p>带入 {chosen!.length} 票需求，继续选择月份与发货次并核对批次名称。</p><Button variant="primary" icon={Plus} disabled={query.isFetching || query.isError || locked} onClick={() => setCreation(chosen!.map((demand) => demand.id))}>继续建立批次</Button></> : <>
          <div className="field"><label htmlFor={`${prefix}-target`}>目标发货批次</label><Combobox id={`${prefix}-target`} value={targetId} disabled={locked || query.isFetching} onValueChange={(value) => { setTargetId(value); setConfirmed(false); mutation.reset(); }} searchPlaceholder="搜索月份、发货次数或批次…" options={[{ value: '', label: '请选择可追加的兼容批次' }, ...eligible.map((entry) => ({ value: entry.detail.group.id, label: `${entry.run.month} 第 ${entry.run.sequence} 次 · ${entry.detail.group.name} · 已有 ${entry.detail.members.length} 票`, keywords: [entry.ticketNumber ?? '', entry.run.numberingDate] }))]} /></div>
          {!eligible.length && <p className="mapping-help">暂无可追加的兼容批次。已发布的发货次请先建立更正版本，也可新建发货批次。</p>}{target.isError && <QueryError error={target.error} retry={() => void target.refetch()} />}{targetId && target.isFetching && <p role="status">正在读取目标批次完整成员…</p>}{target.data && <p className="mapping-help">保留原有 {target.data.members.length} 票，追加 {chosen!.length} 票。追加后重新核对确认，发货次数与票号沿用。</p>}{target.data && target.data.members.length + chosen!.length > 1000 && <p className="error-note">单个批次最多 1000 票，请减少选择或新建批次。</p>}
          <label className="import-check"><input type="checkbox" checked={confirmed} disabled={locked || !targetValid} onChange={(event) => setConfirmed(event.target.checked)} /><span>已核对发货次和完整成员，确认追加所选需求。</span></label><Button variant="primary" loading={mutation.isPending} disabled={!pending && (!confirmed || !targetValid || query.isFetching)} onClick={append}>{pending ? '重试原加入请求' : '确认加入批次'}</Button>
        </>}
      </>}
      {query.data && !partitions.size && !assigned.length && <p>所选需求已不在可处理范围，请返回需求池刷新。</p>}
    </>}
    {pending && !result && <p className="permission-note" role="status">加入结果未确认，原请求和成员版本已保留，请重试原请求。</p>}{pending && !result && (!anchor || action !== 'append') && <Button variant="primary" loading={mutation.isPending} onClick={append}>重试原加入请求</Button>}{mutation.isError && <p className="error-note" role="alert">{messageOf(mutation.error)}</p>}
  </ImportDialog>{creation && <BatchWizard open={open} userId={userId} initialDemandIds={creation} onClose={() => { setCreation(null); void query.refetch(); }} onCreated={() => { void invalidate(); onComplete(); }} onOpenCreated={(saved) => { if (saved.batchId && saved.groupId) { setCreation(null); openGroup(saved.batchId, saved.groupId); } }} />}</>;
}
