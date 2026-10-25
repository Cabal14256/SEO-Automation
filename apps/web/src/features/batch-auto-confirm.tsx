import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirmAndAllocateSubBatchInputSchema, type ConfirmAndAllocateSubBatchInput, type SubBatchDetail, type WeeklyBatchDetail } from '@scm/contracts';
import { CircleCheck, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button } from '../components/ui/button';
import { batchApi } from './batch-api';
import { messageOf, newOperation } from './batch-shared';

type SavedConfirmation = {
  version: 1; batchId: string; groupId: string; input: ConfirmAndAllocateSubBatchInput;
  state: 'pending' | 'failed' | 'completed'; message?: string;
};
const storageKey = (userId: string, groupId: string) => `scm-auto-confirm:${userId}:${groupId}`;
function readSaved(userId: string, groupId: string): SavedConfirmation | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(userId, groupId)) ?? 'null') as SavedConfirmation | null;
    const input = confirmAndAllocateSubBatchInputSchema.safeParse(saved?.input);
    return saved?.version === 1 && saved.groupId === groupId && typeof saved.batchId === 'string' && ['pending', 'failed', 'completed'].includes(saved.state) && input.success ? { ...saved, input: input.data } : null;
  } catch { return null; }
}
export const hasUnsettledAutoConfirmation = (userId: string, groupId: string) => {
  const saved = readSaved(userId, groupId);
  return Boolean(saved && saved.state !== 'completed');
};
const fingerprint = (input: Omit<ConfirmAndAllocateSubBatchInput, 'operationId'>) => JSON.stringify([input.expectedVersion, input.expectedBatchVersion, Object.entries(input.expectedDemandVersions).sort(), Object.entries(input.expectedShipmentVersions).sort()]);
export function hasCurrentGroupConfirmation(detail: SubBatchDetail) {
  const saved = detail.confirmation;
  return Boolean(saved && ['confirmed', 'frozen'].includes(detail.group.status) && saved.groupVersion === detail.group.confirmedVersion && saved.snapshot.members.length === detail.members.length && saved.snapshot.shipments.length === detail.shipments.length
    && detail.members.every((member) => saved.snapshot.members.some((previous) => previous.id === member.id && previous.version === member.version))
    && detail.shipments.every((shipment) => shipment.revision && saved.snapshot.shipments.some((previous) => previous.demandId === shipment.demandId && previous.revision.id === shipment.revision!.id)));
}

export function AutomaticConfirmation({ detail, week, active = true, ready = true, userId, onUnsettledChange }: {
  detail: SubBatchDetail; week: WeeklyBatchDetail; active?: boolean; ready?: boolean; userId?: string;
  onUnsettledChange?: (unsettled: boolean) => void;
}) {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, enabled: active && !userId, retry: false });
  const actorId = userId ?? session.data?.user?.id;
  // Wait for the account identity before loading per-account recovery records.
  return actorId ? <AutomaticConfirmationSession key={`${actorId}:${detail.group.id}`} detail={detail} week={week} active={active} ready={ready} userId={actorId} onUnsettledChange={onUnsettledChange} /> : <p className="mapping-help" role="status">正在读取自动确认状态…</p>;
}

function AutomaticConfirmationSession({ detail, week, active, ready, userId, onUnsettledChange }: {
  detail: SubBatchDetail; week: WeeklyBatchDetail; active: boolean; ready: boolean; userId: string;
  onUnsettledChange?: (unsettled: boolean) => void;
}) {
  const client = useQueryClient();
  const { group } = detail;
  const key = storageKey(userId, group.id);
  const [saved, setSaved] = useState(() => readSaved(userId, group.id));
  const savedRef = useRef(saved); savedRef.current = saved;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const started = useRef(false);
  const callback = useRef(onUnsettledChange); callback.current = onUnsettledChange;
  const sync = useQuery({ queryKey: ['batch-sync', group.id], queryFn: () => batchApi.syncRuns(group.id), enabled: active, retry: false,
    refetchInterval: (query) => active && query.state.data?.some((run) => run.status === 'queued' || run.status === 'running') ? 1500 : false });
  const frozen = group.status === 'frozen' || group.status === 'superseded' || Boolean(group.frozenAt);
  const boxes = detail.shipments.flatMap((shipment) => shipment.revision?.data.boxes ?? []);
  const current = hasCurrentGroupConfirmation(detail);
  const coded = boxes.length > 0 && boxes.every((box) => detail.codes.some((code) => code.valid && code.boxId === box.id));
  const complete = current && coded;
  const candidates = detail.members.length > 0 && detail.members.length === detail.shipments.length && detail.shipments.every((shipment) => shipment.revision && detail.members.some((member) => member.id === shipment.demandId && member.version === shipment.revision!.demandVersion));
  const syncReady = sync.isSuccess && !sync.isFetching && !sync.data.some((run) => run.status === 'queued' || run.status === 'running');
  const expected = {
    expectedVersion: group.version, expectedBatchVersion: week.batch.version,
    expectedDemandVersions: Object.fromEntries(detail.members.map((member) => [member.id, member.version])),
    expectedShipmentVersions: Object.fromEntries(detail.shipments.flatMap((shipment) => shipment.revision ? [[shipment.demandId, shipment.revision.version]] : [])),
  };
  const identity = fingerprint(expected);
  const eligible = active && ready && syncReady && !frozen && candidates && boxes.length > 0 && !detail.issues.some((issue) => issue.severity === 'error') && group.batchId === week.batch.id;
  const write = (next: SavedConfirmation | null) => {
    savedRef.current = next; setSaved(next);
    try { if (next) sessionStorage.setItem(key, JSON.stringify(next)); else sessionStorage.removeItem(key); } catch { /* Retain the exact request in memory when storage is unavailable. */ }
  };
  const invalidate = () => Promise.all([['sub-batch', group.id], ['batch', group.batchId], ['demands'], ['batches'], ['batch-reports'], ['demand-assignment']].map((queryKey) => client.invalidateQueries({ queryKey })));
  const mutation = useMutation({
    mutationKey: ['auto-confirm', group.id], networkMode: 'always', retry: false,
    mutationFn: async (request: SavedConfirmation) => {
      const result = await batchApi.confirmAndAllocate(group.id, request.input);
      if (result.groupId !== group.id || result.batchId !== request.batchId || result.operationId !== request.input.operationId) throw new ApiError('自动确认结果无法识别，原请求已保留。', 0);
      return result;
    },
    onSuccess: async (_result, request) => {
      write({ ...request, state: 'completed' }); started.current = false; callback.current?.(false);
      await invalidate();
    },
    onError: (error, request) => {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
      write({ ...request, state: known ? 'failed' : 'pending', message: messageOf(error) });
      callback.current?.(true);
      if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] });
    },
  });
  const mutate = mutation.mutate;
  useEffect(() => {
    if (!eligible || complete || started.current || mutation.isPending || refreshing) return;
    const previous = savedRef.current;
    if (previous && (previous.state !== 'completed' || fingerprint(previous.input) === identity)) return;
    const request: SavedConfirmation = { version: 1, batchId: group.batchId, groupId: group.id, input: { operationId: newOperation(), ...expected }, state: 'pending' };
    started.current = true; savedRef.current = request; setSaved(request);
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { /* The in-memory request still prevents duplicate submission. */ }
    callback.current?.(true); mutate(request);
  }, [eligible, complete, identity, group.batchId, group.id, key, mutate, mutation.isPending, refreshing]); // expected is represented by its stable fingerprint.
  useEffect(() => {
    callback.current?.(Boolean(saved && saved.state !== 'completed'));
    if (saved?.state !== 'pending') return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [saved]);
  useEffect(() => { if (complete && saved?.state === 'completed') started.current = false; }, [complete, saved?.state]);
  const refresh = async () => {
    if (mutation.isPending || refreshing || savedRef.current?.state === 'pending') return;
    setRefreshing(true); setRefreshError('');
    try {
      await Promise.all([
        client.fetchQuery({ queryKey: ['sub-batch', group.id], queryFn: () => batchApi.group(group.id), staleTime: 0 }),
        client.fetchQuery({ queryKey: ['batch', group.batchId], queryFn: () => batchApi.detail(group.batchId), staleTime: 0 }),
        client.fetchQuery({ queryKey: ['batch-sync', group.id], queryFn: () => batchApi.syncRuns(group.id), staleTime: 0 }),
      ]);
      started.current = false; write(null); mutation.reset(); callback.current?.(false);
    } catch (error) { setRefreshError(messageOf(error)); }
    finally { setRefreshing(false); }
  };
  if (saved?.state === 'pending') return <div className="permission-note" role="status"><p>{mutation.isPending ? '正在自动确认当前数据版本并分配编码…' : '自动确认结果尚未确认，原请求和版本已保留。'}</p>{saved.message && <p className="error-note">{saved.message}</p>}{!mutation.isPending && <Button type="button" icon={RefreshCw} disabled={!active} onClick={() => mutate(saved)}>重试自动确认与编码</Button>}</div>;
  if (saved?.state === 'failed') return <div className="permission-note warning-note" role="alert"><p>自动确认与编码已暂停。{saved.message}</p><Button type="button" icon={RefreshCw} disabled={!active} loading={refreshing} onClick={() => void refresh()}>刷新后重新校验</Button>{refreshError && <p className="error-note">{refreshError}</p>}</div>;
  if (frozen) return <p className="mapping-help">当前批次已冻结或被替代，保留原确认和箱码；调整请发起更正。</p>;
  if (complete) return <p className="form-note success-note" role="status"><CircleCheck size={16} aria-hidden="true" /> 当前数据版本已确认，全部箱编码已分配。</p>;
  if (sync.isError) return <p className="permission-note warning-note" role="alert">同步状态读取失败，自动确认已暂停。<Button type="button" disabled={!active} icon={RefreshCw} onClick={() => void sync.refetch()}>重新读取同步状态</Button></p>;
  return <p className="mapping-help" role="status">{detail.issues.some((issue) => issue.severity === 'error') || !candidates ? '请先处理阻塞异常并补齐当前版本数据；校验通过后自动确认并分配编码。' : !syncReady ? '等待同步结束并核对当前状态后，自动确认并分配编码。' : '校验通过后自动确认当前版本并分配编码，无需填写说明。'}</p>;
}
