import { useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, RefreshCw, Trash2 } from 'lucide-react';
import type { DocumentAutomationDeleteResponse, DocumentAutomationJob } from '@scm/contracts';
import { ApiError } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { messageOf, newOperation, timestamp } from './batch-shared';
import { documentAutomationApi } from './document-automation-api';
import { ImportDialog } from './import-dialog';

type DeleteRequest = { operationId: string; expectedVersion: number; reason: string };

export function DocumentAutomationDeleteDialog({ active, job, close, deleted }: {
  active: boolean; job: DocumentAutomationJob; close: () => void; deleted: (result: DocumentAutomationDeleteResponse) => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const [target, setTarget] = useState(job);
  const [reason, setReason] = useState('');
  const requests = useRef(new Map<string, string>());
  const submitted = useRef<DeleteRequest | null>(null);
  const inFlight = useRef(false);
  const invalidateSession = (error: unknown) => { if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); };
  const removal = useMutation({
    networkMode: 'always',
    mutationFn: (input: DeleteRequest) => documentAutomationApi.remove(target.id, input),
    onSuccess: async (result) => {
      // Clear resumable editors before refreshing lists of released drafts.
      deleted(result);
      client.removeQueries({ queryKey: ['document-automation', result.automationId], exact: true });
      client.removeQueries({ queryKey: ['document-automation-requirements', result.automationId] });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['document-automations'] }),
        client.invalidateQueries({ queryKey: ['documents'] }),
        client.invalidateQueries({ queryKey: ['document'] }),
        client.invalidateQueries({ queryKey: ['document-history'] }),
        client.invalidateQueries({ queryKey: ['document-candidates'] }),
      ]);
    },
    onError: invalidateSession,
    onSettled: () => { inFlight.current = false; },
  });
  const refresh = useMutation({
    networkMode: 'always', mutationFn: () => documentAutomationApi.get(target.id),
    onSuccess: async ({ job: latest }) => {
      setTarget(latest); requests.current.clear(); submitted.current = null; removal.reset();
      client.setQueryData(['document-automation', latest.id], { job: latest });
      await client.invalidateQueries({ queryKey: ['document-automations'] });
    },
    onError: invalidateSession,
    onSettled: () => { inFlight.current = false; },
  });
  const locked = removal.isPending || refresh.isPending;
  const conflict = removal.error instanceof ApiError && removal.error.status === 409 && /VERSION_CONFLICT/.test(removal.error.code ?? '');
  const notFound = [removal.error, refresh.error].some((error) => error instanceof ApiError && error.status === 404);
  const uncertain = removal.isError && !(removal.error instanceof ApiError && removal.error.status >= 400 && removal.error.status < 500);
  const awaitingResult = uncertain && submitted.current !== null;
  const dismiss = () => {
    if (inFlight.current) return;
    if (removal.isError || notFound) {
      void client.invalidateQueries({ queryKey: ['document-automations'] });
      void client.invalidateQueries({ queryKey: ['documents'] });
      void client.invalidateQueries({ queryKey: ['document'] });
      void client.invalidateQueries({ queryKey: ['document-candidates'] });
    }
    close();
  };
  const remove = (event: FormEvent) => {
    event.preventDefault();
    if (!active || inFlight.current || conflict || notFound && !awaitingResult || !reason.trim()) return;
    const input = { expectedVersion: target.version, reason: reason.trim() }, key = JSON.stringify(input);
    if (!requests.current.has(key)) requests.current.set(key, newOperation());
    // Lock synchronously so repeated clicks share one idempotent request.
    inFlight.current = true;
    const request = awaitingResult ? submitted.current! : { ...input, operationId: requests.current.get(key)! };
    submitted.current = request;
    removal.mutate(request);
  };
  const reload = () => { if (inFlight.current) return; inFlight.current = true; refresh.mutate(); };
  const fbas = [...new Set(target.items.flatMap((item) => item.fbas))];
  return <ImportDialog open={active} title="删除自动出单任务" close={dismiss} closeDisabled={locked}><form className="document-delete-form" onSubmit={remove}>
    <h3>{fbas.length ? fbas.join('、') : '自动出单任务'}</h3>
    <p className="mapping-help">开始时间 {timestamp(target.createdAt)} · v{target.version}<br />任务编号 {target.id}</p>
    <p>删除后从任务列表移除，并停止后续处理。仅取消本任务创建且未被修改、导出或其他任务使用的草稿，释放其货件占用。</p>
    <p>已有单据和文件保留，可在“单据记录”中查看和下载；本任务的下载入口将关闭。后台正在处理或生成文件时，需等待本轮结束后再删除。</p>
    <div className="field"><label htmlFor={`${id}-reason`}>删除原因</label><Input id={`${id}-reason`} autoFocus required maxLength={1000} value={reason} disabled={locked || awaitingResult} onChange={(event) => setReason(event.target.value)} /></div>
    {removal.isError && <p className="form-note error-note" role="alert"><CircleAlert size={16} aria-hidden="true" />{messageOf(removal.error)} 删除原因已保留。</p>}
    {conflict && <p role="status">任务进度已变化，请重新读取并核对任务范围和版本后，再确认删除。</p>}
    {removal.isError && !notFound && <div className="document-delete-conflict"><Button type="button" icon={RefreshCw} disabled={locked} loading={refresh.isPending} onClick={reload}>重新读取删除目标</Button></div>}
    {refresh.isError && <p className="form-note error-note" role="alert">{messageOf(refresh.error)} 删除原因已保留，可重试读取。</p>}
    {awaitingResult && <p role="status">尚未确认删除结果。重试将使用原请求核对，不会重复删除。</p>}
    {notFound && !awaitingResult && <p role="status">任务不存在或已删除，请返回列表刷新核对。</p>}
    <div className="document-footer-actions"><Button type="button" disabled={locked} onClick={dismiss}>{notFound || awaitingResult ? '返回列表' : '保留任务'}</Button><Button type="submit" icon={Trash2} className="document-delete-submit" loading={removal.isPending} loadingLabel="正在删除…" disabled={locked || conflict || notFound && !awaitingResult || !reason.trim()}>{awaitingResult ? '重试确认删除结果' : '确认删除'}</Button></div>
  </form></ImportDialog>;
}
