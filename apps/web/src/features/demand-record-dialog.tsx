import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DemandDetail } from '@scm/contracts';
import { ArrowRight, Pencil, RefreshCw, Save } from 'lucide-react';
import { Link, useBlocker } from '@tanstack/react-router';
import { api, ApiError } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { BatchTable, messageOf, newOperation, QueryError, timestamp } from './batch-shared';
import { ImportDialog } from './import-dialog';
import { ShippingLifecycleActions, ShippingLifecycleDialog, lifecycleLabels } from './shipping-lifecycle';
import './demand-record-dialog.css';

export type DemandRecordMode = 'view' | 'edit' | 'delete';
const fields = [
  ['channel', '业务渠道'], ['destinationFc', '目的仓'], ['destinationAddress', '仓库地址'],
  ['referenceQuantity', '参考数量'], ['sourceFilledAt', '来源填写日期'], ['notes', '备注'],
] as const;
type Fields = Record<typeof fields[number][0], string>;
const fromDetail = (detail: DemandDetail): Fields => Object.fromEntries(fields.map(([key]) => [key, detail.demand.snapshot[key] ?? ''])) as Fields;
const fieldValue = (value: string | null | undefined) => value?.trim() || '未填写';

export function DemandRecordDialog({ id, initialMode, active, close, changed, openGroup }: {
  id: string; initialMode: DemandRecordMode; active: boolean; close: () => void; changed: (message: string) => void;
  openGroup?: (batchId: string, groupId: string) => void;
}) {
  const client = useQueryClient();
  const [session] = useState(newOperation);
  const query = useQuery({ queryKey: ['demand-management', id, session], queryFn: () => api.demand(id), enabled: active, retry: false, refetchOnWindowFocus: false });
  useEffect(() => { if (query.error instanceof ApiError && query.error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); }, [query.error, client]);
  const [baseline, setBaseline] = useState<DemandDetail | null>(null);
  const [values, setValues] = useState<Fields | null>(null);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState(initialMode);
  const [guard, setGuard] = useState<'close' | 'reload' | null>(null);
  const operations = useRef(new Map<string, string>());
  useEffect(() => { if (!baseline && query.data) { setBaseline(query.data); setValues(fromDetail(query.data)); } }, [baseline, query.data]);
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: async (input: { key: string; payload: Record<string, unknown> }) => {
      if (!operations.current.has(input.key)) operations.current.set(input.key, newOperation());
      const payload = { ...input.payload, operationId: operations.current.get(input.key)! };
      return api.reviseDemand(id, payload);
    },
    onSuccess: async (_value, input) => {
      operations.current.delete(input.key);
      await Promise.all(['demands', 'batches', 'batch', 'sub-batch', 'batch-reports', 'batch-exports', 'physical-review', 'document-candidates', 'documents', 'document', 'demand-management', 'demand-source'].map((key) => client.invalidateQueries({ queryKey: [key] })));
      changed('需求修改已保存为新版本；原商品候选及批次确认需重新核对。');
      if (blocker.status === 'blocked') blocker.proceed();
      close();
    },
    onError: (error) => { if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); },
  });
  const reload = useMutation({ networkMode: 'always', mutationFn: async () => {
    const result = await query.refetch(); if (result.error) throw result.error; if (!result.data) throw new Error('需求读取失败，请重试。'); return result.data;
  }, onSuccess: (detail) => { setBaseline(detail); setValues(fromDetail(detail)); setReason(''); setGuard(null); mutation.reset(); if (detail.management.lifecycle !== 'active') setMode('view'); } });
  const busy = mutation.isPending || reload.isPending;
  const dirty = Boolean(baseline && values && (mode === 'edit' && JSON.stringify(values) !== JSON.stringify(fromDetail(baseline)) || reason.trim()));
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  const blocker = useBlocker({ shouldBlockFn: () => active && (dirty || busy), enableBeforeUnload: active && (dirty || busy), withResolver: true });
  useEffect(() => { if (blocker.status === 'blocked') setGuard('close'); }, [blocker.status]);
  const requestClose = () => { if (busy) return; if (dirty) setGuard('close'); else close(); };
  const changeMode = (next: DemandRecordMode) => { if (busy || !baseline) return; setMode(next); setValues(fromDetail(baseline)); setReason(''); mutation.reset(); reload.reset(); };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!baseline || !values || busy || conflict || !reason.trim() || mode === 'view') return;
    if (mode !== 'edit' || !baseline.management.canEdit) return;
    const payload = { expectedVersion: baseline.demand.version, reason: reason.trim(), fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim() || null])) };
    mutation.mutate({ key: JSON.stringify([id, mode, payload]), payload });
  };
  const record = baseline?.demand, policy = baseline?.management;
  if (mode === 'delete') return <ShippingLifecycleDialog target={{ type: 'demand', id, name: record?.snapshot.fba ?? '货件需求', lifecycle: policy?.lifecycle }} action="trash" active={active} close={close} completed={() => { changed('需求已移入回收站，来源与历史保留。'); close(); }} />;
  return <ImportDialog open={active} title="货件需求" close={requestClose} closeDisabled={busy || Boolean(guard)} wide>
    <div className="demand-record-dialog">
      {!baseline ? query.isError ? <QueryError error={query.error} retry={() => void query.refetch()} /> : <p className="list-state" role="status">正在读取当前需求、来源和操作权限…</p> : <>
        <div className="demand-record-heading"><div><h3>{record!.snapshot.fba}</h3><p>{record!.snapshot.shop} · {record!.snapshot.country} · 需求 v{record!.version} · {lifecycleLabels[policy!.lifecycle]}</p></div>{mode === 'view' && <div className="demand-record-actions"><Button type="button" icon={Pencil} disabled={!policy!.canEdit || record!.lifecyclePending} onClick={() => changeMode('edit')}>编辑需求</Button><ShippingLifecycleActions target={{ type: 'demand', id, name: record!.snapshot.fba, lifecycle: policy!.lifecycle, lifecyclePending: record!.lifecyclePending }} active={active} changed={() => { changed('需求状态已更新，来源与历史保留。'); close(); }} /></div>}</div>
        <p className="mapping-help">首次业务日期 {record!.businessDate}。店铺、FBA 和首次导入日期保持，发货安排按所属发货次管理。</p>
        {policy!.reason && <p className="form-note" role="status">{policy!.reason}</p>}
        {guard && <div className="demand-record-guard" role="alert"><p>{guard === 'close' ? '当前输入尚未保存。可继续填写，或放弃本次修改后关闭。' : '重新读取会放弃当前输入，并载入最新版本、状态和操作权限。'}</p><div className="demand-record-actions"><Button type="button" disabled={busy} onClick={() => { if (blocker.status === 'blocked') blocker.reset(); setGuard(null); }}>继续填写</Button><Button type="button" disabled={busy} loading={reload.isPending} onClick={() => { if (guard === 'close') { if (blocker.status === 'blocked') blocker.proceed(); close(); } else reload.mutate(); }}>{guard === 'close' ? '放弃修改并关闭' : '放弃修改并重新读取'}</Button></div></div>}
        <fieldset className="demand-record-fieldset" disabled={busy || Boolean(guard)} inert={Boolean(guard)}>
          {mode === 'view' ? <>
            <dl className="demand-record-values">{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{fieldValue(record!.snapshot[key])}</dd></div>)}</dl>
            {policy!.groupId && policy!.batchId && openGroup && <Button type="button" icon={ArrowRight} onClick={() => { close(); openGroup(policy!.batchId!, policy!.groupId!); }}>处理所属批次</Button>}
            <details className="demand-record-history"><summary>修订与操作历史</summary><BatchTable label="需求修订历史" headers={['版本 / 时间', '内容', '操作人']}>{baseline.revisions.map((revision) => <tr key={revision.version}><td>v{revision.version}<small className="mapping-subtext">{timestamp(revision.createdAt)}</small></td><td>{fields.map(([key, label]) => <small className="mapping-subtext" key={key}>{label}：{fieldValue(revision.snapshot[key])}</small>)}</td><td>{revision.createdBy}</td></tr>)}</BatchTable>{baseline.operations.length > 0 && <BatchTable label="需求操作历史" headers={['操作 / 时间', '原因', '操作人']}>{baseline.operations.map((operation, index) => <tr key={`${operation.createdAt}-${index}`}><td>{({ 'demand.cancel': '取消需求', 'demand.trash': '删除需求', 'demand.restore': '恢复需求', 'demand.purge': '彻底删除需求', 'demand.revise': '修改需求' } as Record<string, string>)[operation.action] ?? operation.action}<small className="mapping-subtext">{timestamp(operation.createdAt)}</small></td><td>{operation.reason}</td><td>{operation.createdBy}</td></tr>)}</BatchTable>}</details>
            <details className="demand-record-history"><summary>原始来源 · {baseline.sources.length} 条</summary>{baseline.sources.length ? <BatchTable label="需求原始来源" headers={['文件 / 工作表', '源行 / 采用版本', '查看']}>{baseline.sources.map((item) => <tr key={item.source.rowId}><td>{item.source.fileName}<small className="mapping-subtext">{item.source.sheetName}</small></td><td>第 {item.source.rowNumber} 行 · v{item.acceptedVersion}</td><td><Link className="text-button" to="/imports/$importId" params={{ importId: item.source.importId }}>查看原始导入</Link></td></tr>)}</BatchTable> : <p className="mapping-help">暂无关联原始来源。</p>}</details>
          </> : <form onSubmit={submit}>
            <h4>编辑需求</h4><p className="mapping-help">参考数量保留来源口径；商品和逐箱数量在批次中维护。已分组需求的渠道需通过分组调整；修改后重新核对候选、确认和编码。</p><div className="demand-record-fields">{fields.map(([key, label]) => <div className={`field${key === 'destinationAddress' || key === 'notes' ? ' demand-record-wide' : ''}`} key={key}><label htmlFor={`${session}-${key}`}>{label}</label><Input id={`${session}-${key}`} maxLength={2000} value={values?.[key] ?? ''} disabled={!policy!.canEdit || key === 'channel' && Boolean(policy!.groupId)} onChange={(event) => setValues((current) => current ? { ...current, [key]: event.target.value } : current)} /></div>)}</div>
            <div className="field demand-record-reason"><label htmlFor={`${session}-reason`}>修改原因</label><Input id={`${session}-reason`} required maxLength={1000} value={reason} disabled={!policy!.canEdit} onChange={(event) => setReason(event.target.value)} /></div>
            {mutation.isError && <p className="form-note error-note" role="alert">{messageOf(mutation.error)} {conflict ? '输入已保留，请重新读取需求并核对最新版本后再操作。' : '内容和原操作编号已保留，可原样重试。'}</p>}
            <div className="demand-record-actions"><Button type="button" disabled={busy} onClick={() => changeMode('view')}>取消修改</Button>{conflict ? <Button type="button" icon={RefreshCw} onClick={() => setGuard('reload')}>重新读取需求</Button> : <Button type="submit" icon={Save} variant="primary" loading={mutation.isPending} loadingLabel="正在保存需求…" disabled={busy || !reason.trim() || !policy!.canEdit || JSON.stringify(values) === JSON.stringify(fromDetail(baseline))}>保存需求修改</Button>}</div>
          </form>}
        </fieldset>
        {reload.isError && <p className="form-note error-note" role="alert">{messageOf(reload.error)} 当前输入仍保留，可重试读取。</p>}
      </>}
    </div>
  </ImportDialog>;
}
