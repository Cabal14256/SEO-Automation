import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import type { SubBatchDetail } from '@scm/contracts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Combobox } from '../components/ui/combobox';
import { DateRangePicker } from '../components/ui/date-range-picker';
import { shanghaiToday } from '../components/ui/date-utils';
import { batchApi, type SyncRun } from './batch-api';
import { BatchPanel, BatchTable, QueryError, timestamp, useBatchAction } from './batch-shared';
import { LingxingProgress } from './lingxing-progress';

const states: Record<string, string> = { queued: '排队中', running: '同步中', completed: '完成', partial: '部分失败', failed: '失败' };
export function BatchSync({ detail, active = true }: { detail: SubBatchDetail; active?: boolean }) {
  const group = detail.group;
  const client = useQueryClient();
  const action = useBatchAction();
  const [startDate, setStartDate] = useState('2020-01-01');
  const [endDate, setEndDate] = useState(() => shanghaiToday(1));
  const [budget, setBudget] = useState(100);
  const [retryBudget, setRetryBudget] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState('');
  const runs = useQuery({ queryKey: ['batch-sync', group.id], queryFn: () => batchApi.syncRuns(group.id), enabled: active, retry: false, refetchInterval: (query) => active && query.state.data?.some((run) => run.status === 'queued' || run.status === 'running') ? 1500 : false });
  const runId = selectedRunId || runs.data?.[0]?.id;
  const result = useQuery({ queryKey: ['batch-sync', 'run', runId], queryFn: () => batchApi.sync(runId!), enabled: active && Boolean(runId), retry: false, refetchInterval: (query) => active && (query.state.data?.run.status === 'queued' || query.state.data?.run.status === 'running') ? 1500 : false });
  const running = runs.data?.some((run) => run.status === 'queued' || run.status === 'running') || result.data?.run.status === 'queued' || result.data?.run.status === 'running';
  const submitting = action.pendingKey?.startsWith('["sync",') || action.pendingKey?.startsWith('retry-');
  const successful = result.data?.items.filter((item) => item.status === 'completed').length ?? 0;
  const failed = result.data?.items.filter((item) => item.status === 'failed').length ?? 0;
  const acceptRun = (value: Awaited<ReturnType<typeof batchApi.sync>>) => {
    client.setQueryData(['batch-sync', 'run', value.run.id], value);
    client.setQueryData<SyncRun[]>(['batch-sync', group.id], (previous) => [value.run, ...(previous ?? []).filter((run) => run.id !== value.run.id)]);
    setSelectedRunId(value.run.id);
    return value;
  };
  return <BatchPanel title="领星只读同步" help="日期范围用于查找货件创建日期，不改变需求的业务日期。逐票保存原始快照；失败仅影响本子批次。">
    {submitting ? <LingxingProgress key={`submitting-${action.pendingKey}`} label="货件处理进度" status="queued" detail={action.pendingKey?.startsWith('retry-') ? '正在提交失败票重试，等待任务受理。' : '正在提交同步任务，等待任务受理。'} />
      : result.data ? <LingxingProgress label="货件处理进度" status={result.data.run.status} processed={successful + failed} total={result.data.items.length} startedAt={result.data.run.startedAt ?? result.data.run.createdAt} detail={`${states[result.data.run.status]} · 成功 ${successful} 票 · 失败 ${failed} 票${result.isError ? ' · 进度读取失败，显示最近状态' : ''}${result.data.run.errorMessage ? ` · ${result.data.run.errorMessage}` : ''}`} />
      : runId && <LingxingProgress label="货件处理进度" status={result.isError ? 'failed' : 'queued'} detail={result.isError ? '进度读取失败，请重试读取。' : '正在读取逐票同步进度。'} />}
    <form className="batch-form" onSubmit={(event) => {
      event.preventDefault();
      action.run(JSON.stringify(['sync', group.id, group.version, startDate, endDate, budget]), async (operationId) => {
        return acceptRun(await batchApi.startSync(group.id, { operationId, expectedVersion: group.version, startDate, endDate, requestBudget: budget, maxPages: 10 }));
      }, '同步任务已受理，逐票进度会自动更新。');
    }}>
      <DateRangePicker id="sync-dates" startId="sync-start" endId="sync-end" startLabel="货件创建日期起" endLabel="货件创建日期止（不含）" required endExclusive startValue={startDate} endValue={endDate} onValueChange={({ start, end }) => { setStartDate(start); setEndDate(end); }} />
      <div className="field"><label htmlFor="sync-budget">本次请求上限</label><Input id="sync-budget" type="number" min={1} max={1000} required value={budget} onChange={(event) => setBudget(Number(event.target.value))} /></div>
      <Button icon={RefreshCw} loading={action.pendingKey?.startsWith('["sync",')} variant="primary" type="submit" disabled={action.busy || running || group.status === 'superseded'}>同步全部成员</Button>
    </form>
    {action.feedback}
    {runs.isError && <QueryError error={runs.error} retry={() => void runs.refetch()} />}
    {runs.data && runs.data.length > 0 && <div className="field batch-select"><label htmlFor="sync-run">同步历史</label><Combobox id="sync-run" value={runId ?? ''} onValueChange={setSelectedRunId} searchPlaceholder="搜索同步时间或状态" options={runs.data.map((run) => ({ value: run.id, label: `${timestamp(run.createdAt)} · ${states[run.status]} · ${run.requestsUsed}/${run.requestBudget} 次请求` }))} /></div>}
    {result.isError && <QueryError error={result.error} retry={() => void result.refetch()} />}
    {result.data && <><p className="mapping-help" role="status">{states[result.data.run.status]} · 业务请求 {result.data.run.requestsUsed}/{result.data.run.requestBudget}{result.data.run.authRequests !== undefined && ` · 鉴权请求 ${result.data.run.authRequests}`}{result.data.run.cacheHits !== undefined && ` · 缓存复用 ${result.data.run.cacheHits}`} · 日期 {result.data.run.startDate} 至 {result.data.run.endDate}{result.data.run.errorMessage && ` · ${result.data.run.errorMessage}`}</p>
      <BatchTable label="逐票同步结果" headers={['FBA / 店铺', '状态', '请求 / 尝试', '原始快照 / 错误']}>{result.data.items.map((item) => <tr key={item.id}><td><strong>{item.fba}</strong><small className="mapping-subtext">sid {item.sid}</small></td><td>{states[item.status]}</td><td>{item.requestCount} / {item.attempts}</td><td>{item.errorMessage || `${item.snapshotIds.length} 份快照`}{item.errorCode && <small className="mapping-subtext">{item.errorCode}</small>}</td></tr>)}</BatchTable>
      {result.data.items.some((item) => item.status === 'failed') && <><div className="batch-form"><div className="field"><label htmlFor="sync-retry-budget">明确追加的请求预算（0 不增加）</label><Input id="sync-retry-budget" type="number" min={0} max={1000} value={retryBudget} onChange={(event) => setRetryBudget(Number(event.target.value))} /></div><Button icon={RotateCcw} loading={action.pendingKey?.startsWith('retry-')} disabled={action.busy || running || !Number.isInteger(retryBudget) || retryBudget < 0 || retryBudget > 1000} onClick={() => action.run(`retry-${runId}-${retryBudget}`, async (operationId) => acceptRun(await batchApi.retrySync(runId!, { operationId, additionalRequestBudget: retryBudget })), '失败票恢复任务已受理；已成功票保持。')}>仅重试失败票</Button></div><p className="mapping-help">已有请求仍计入该任务累计预算。预算耗尽时，只有明确追加后才继续请求。</p></>}
    </>}
    {!runId && !runs.isPending && <p className="list-state">尚未同步。请按实际货件创建日期选择覆盖范围。</p>}
  </BatchPanel>;
}
