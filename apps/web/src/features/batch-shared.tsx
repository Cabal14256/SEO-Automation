import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, RefreshCw } from 'lucide-react';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import type { BatchScope, ShippingOccurrence } from '@scm/contracts';
import './batch-table-selection.css';
import { useGridTableScope } from '../components/ui/grid-table-scope';
import { ReactGridTable } from '../components/ui/react-grid-table';

export const occurrenceLabel = (run: Pick<ShippingOccurrence, 'month' | 'sequence'>) => run.sequence === null ? run.month + ' · 待编号' : run.month + ' 第 ' + run.sequence + ' 次';
export const batchScopeLabel = (batch: BatchScope) => batch.shippingRunId && batch.month ? occurrenceLabel({ month: batch.month, sequence: batch.sequence ?? null }) : '历史批次／未关联发货次';
export const batchOccurrencesLabel = (runs: ShippingOccurrence[]) => runs.length ? runs.map(occurrenceLabel).join('、') : '历史批次／未关联发货次';

export const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
export const timestamp = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '—';
export const newOperation = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function useBatchAction() {
  const client = useQueryClient();
  const [notice, setNotice] = useState('');
  const operations = useRef(new Map<string, string>());
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: async ({ key, action }: { key: string; action: (operationId: string) => Promise<unknown>; success: string }) => {
      if (!operations.current.has(key)) operations.current.set(key, newOperation());
      return action(operations.current.get(key)!);
    },
    onSuccess: async (_result, input) => {
      operations.current.delete(input.key);
      setNotice(input.success);
      await Promise.all([client.invalidateQueries({ queryKey: ['shipping-runs'] }), client.invalidateQueries({ queryKey: ['demand-assignment'] }), client.invalidateQueries({ queryKey: ['demands'] }), client.invalidateQueries({ queryKey: ['batches'] }), client.invalidateQueries({ queryKey: ['batch'] }), client.invalidateQueries({ queryKey: ['sub-batch'] }), client.invalidateQueries({ queryKey: ['batch-sync'] }), client.invalidateQueries({ queryKey: ['batch-reports'] }), client.invalidateQueries({ queryKey: ['batch-exports'] })]);
    },
    onError: (error) => { setNotice(''); if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); },
  });
  const run = (key: string, action: (operationId: string) => Promise<unknown>, success = '已保存。') => { setNotice(''); mutation.mutate({ key, action, success }); };
  const pendingKey = mutation.isPending ? mutation.variables.key : undefined;
  return { run, busy: mutation.isPending, pendingKey, feedback: <>{mutation.isError && <p className="form-note error-note" role="alert"><CircleAlert size={16} aria-hidden="true" /> {messageOf(mutation.error)} 请求未确认成功时，保持内容再次提交可使用同一操作编号重试。</p>}{notice && <p className="form-note success-note" role="status"><CircleCheck size={16} aria-hidden="true" /> {notice}</p>}</> };
}

export function BatchPanel({ title, help, children, action }: { title: string; help?: string; children: ReactNode; action?: ReactNode }) {
  return <section className="content-panel batch-panel"><div className="section-heading panel-heading"><div><h2>{title}</h2>{help && <p>{help}</p>}</div>{action}</div>{children}</section>;
}

export function BatchTable({ label, headers, children }: { label: string; headers: ReactNode[]; children: ReactNode }) {
  const grid = useGridTableScope();
  if (grid) return <ReactGridTable label={label} headers={headers}>{children}</ReactGridTable>;
  return <div className="table-scroll" role="region" aria-label={`${label}，可横向滚动`} tabIndex={0}><div className="table-inner"><table className="task-table batch-table"><thead><tr>{headers.map((header, index) => <th key={index} scope="col">{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div></div>;
}

export function TableSelectionCheckbox({ checked, indeterminate = false, disabled = false, label, onChange }: {
  checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void;
}) {
  return <input type="checkbox" className="table-selection-checkbox" aria-label={label} aria-checked={indeterminate ? 'mixed' : checked} checked={checked} disabled={disabled}
    ref={(element) => { if (element) element.indeterminate = indeterminate; }} onChange={(event) => onChange(event.target.checked)} />;
}

export function QueryError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="inline-error" role="alert"><CircleAlert size={19} aria-hidden="true" /><div><strong>暂时无法读取</strong><p>{messageOf(error)}</p></div><Button type="button" icon={RefreshCw} onClick={retry}>重试</Button></div>;
}

export async function downloadBlob(action: Promise<Blob>, filename: string) {
  const url = URL.createObjectURL(await action);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function Check({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return <label className="import-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{children}</label>;
}

export function BatchPagination({ page, pageSize, total, change }: { page: number; pageSize: number; total: number; change: (page: number) => void }) {
  return <div className="mapping-pagination"><span>共 {total} 项 · 第 {page} 页</span><div><IconButton icon={ChevronLeft} label="上一页" disabled={page <= 1} onClick={() => change(page - 1)} /><IconButton icon={ChevronRight} label="下一页" disabled={page * pageSize >= total} onClick={() => change(page + 1)} /></div></div>;
}
