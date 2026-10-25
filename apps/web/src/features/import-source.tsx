import { IMPORT_MAX_BYTES, importParseInputSchema, type ImportAccepted, type ImportIssue, type ImportRow, type ImportRun, type SourceImport, type ImportParseInput } from '@scm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clock3, Download, Eye, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Combobox } from '../components/ui/combobox';
import { SelectField } from '../components/ui/select';
const importStatusLabels: Record<SourceImport['status'], string> = { queued: '等待解析', parsing: '解析中', awaiting_mapping: '待选择映射', preview_ready: '预览就绪', failed: '解析失败' };
const rowStatusLabels: Record<ImportRow['status'], string> = { valid: '格式有效', needs_review: '待核对', error: '有错误' };
export const messageOf = (error: unknown) => error instanceof Error ? error.message : '发生未知错误，请稍后重试。';
export const timestamp = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
export const isBusy = (record: SourceImport) => record.status === 'queued' || record.status === 'parsing';
export const operationId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export function UploadPanel({ canManage, active, accepted, onBusyChange, initialFile, initialOperation, onDraftChange }: { canManage: boolean; active: boolean; accepted: (result: ImportAccepted) => void; onBusyChange?: (busy: boolean) => void; initialFile?: File; initialOperation?: string; onDraftChange?: (file: File | null, operation: string) => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [currentOperation, setCurrentOperation] = useState(() => initialOperation ?? operationId());
  const attemptedOperation = useRef<string | null>(null);
  useEffect(() => { onDraftChange?.(file, currentOperation); }, [file, currentOperation, onDraftChange]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutation = useMutation({
    networkMode: 'always', mutationFn: ({ file, operation }: { file: File; operation: string }) => api.uploadImport(file, operation),
    onSuccess: accepted,
    onError: (error) => { if (error instanceof ApiError && error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] }); },
  });
  const template = useMutation({
    networkMode: 'always', mutationFn: api.downloadImportTemplate,
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = '需求导入模板.xlsx';
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onError: (error) => { if (error instanceof ApiError && error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] }); },
  });
  useEffect(() => {
    onBusyChange?.(mutation.isPending);
    return () => onBusyChange?.(false);
  }, [mutation.isPending, onBusyChange]);
  const upload = useCallback((selectedFile: File, operation: string) => {
    if (!canManage) return;
    if (!selectedFile.name.toLowerCase().endsWith('.xlsx')) { setValidationError('目前支持 .xlsx 工作簿，请另存为 .xlsx 后选择。'); return; }
    if (!selectedFile.size || selectedFile.size > IMPORT_MAX_BYTES) { setValidationError('请选择有内容且不超过 10 MB 的工作簿。'); return; }
    setValidationError(null);
    mutation.mutate({ file: selectedFile, operation });
  }, [canManage, mutation.mutate]);
  useEffect(() => {
    if (!active || !canManage || !file || attemptedOperation.current === currentOperation) return;
    attemptedOperation.current = currentOperation;
    upload(file, currentOperation);
  }, [active, canManage, file, currentOperation, upload]);
  return <section className="import-file-panel" aria-labelledby="upload-title">
    <div className="section-heading panel-heading import-upload-heading"><div><h2 id="upload-title">上传需求工作簿</h2><p>选择文件后自动上传并校验，通过后自动解析，再核对源行。</p></div>{canManage && <Button type="button" icon={Download} loading={template.isPending} loadingLabel="正在下载模板…" onClick={() => template.mutate()}>下载模板</Button>}</div>
    {template.isError && <p className="form-note error-note" role="alert">{messageOf(template.error)} 请重新点击“下载模板”重试。</p>}
    {template.isSuccess && <p className="form-note success-note" role="status">模板已下载。请按表内说明填写需求，保留表头后上传。</p>}
    {canManage ? <div className="import-upload-form" aria-busy={mutation.isPending}>
      <div className="field"><label htmlFor="import-file">需求文件</label><input id="import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={mutation.isPending} aria-describedby="import-file-help" onChange={(event) => { const selectedFile = event.target.files?.[0]; if (!selectedFile) return; setFile(selectedFile); setCurrentOperation(operationId()); setValidationError(null); mutation.reset(); }} /><p className="mapping-help" id="import-file-help">支持 .xlsx，最大 10 MB，选择后自动开始。有多个可用工作表时再选择本次输入表。原始单元格和公式缓存会保留。</p></div>
      {file && <p className="mapping-help" role="status">已选择：{file.name} · {(file.size / 1024).toFixed(1)} KB</p>}
      {mutation.isPending && <p className="form-note" role="status">正在上传并校验文件结构、表头和需求行。校验通过后将自动开始解析。</p>}
      {validationError && <p className="form-note error-note" role="alert">{validationError}</p>}
      {mutation.isError && <><p className="form-note error-note" role="alert">{messageOf(mutation.error)}{mutation.error instanceof ApiError && [413, 422].includes(mutation.error.status) ? ' 请修正后重新选择文件，也可下载模板填写。' : ' 文件和操作号已保留，可重试原上传；相同内容会复用原记录。'}</p><Button variant="primary" type="button" icon={RefreshCw} disabled={!file || mutation.isPending || !active} onClick={() => { if (file && active && !mutation.isPending) upload(file, currentOperation); }}>重试上传</Button></>}
    </div> : <p className="permission-note" role="status">请使用管理员账号上传和重新解析。</p>}
  </section>;
}

export function ParseControls({ record, canManage, scope = '' }: { record: SourceImport; canManage: boolean; scope?: string }) {
  const sheetId = `${scope ? `${scope}-` : ''}import-sheet`;
  const mappingId = `${scope ? `${scope}-` : ''}import-mapping`;
  const queryClient = useQueryClient();
  const [sheetName, setSheetName] = useState(record.latestRun?.sheetName ?? record.sheets.find((sheet) => sheet.name === '飞书表格')?.name ?? record.sheets.find((sheet) => sheet.state === 'visible')?.name ?? record.sheets[0]?.name ?? '飞书表格');
  const [mappingVersion, setMappingVersion] = useState<ImportParseInput['mappingVersion']>(record.latestRun?.mappingVersion ?? 'feishu-v1');
  const [currentOperation, setCurrentOperation] = useState(operationId);
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutation = useMutation({
    networkMode: 'always', mutationFn: (input: Parameters<typeof api.parseImport>[1]) => api.parseImport(record.id, input),
    onSuccess: (result) => { queryClient.setQueryData(['import', record.id], result.import); void queryClient.invalidateQueries({ queryKey: ['imports'] }); },
    onError: (error) => { if (error instanceof ApiError && error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] }); },
  });
  const selectedSheet = record.sheets.find((sheet) => sheet.name === sheetName);
  const busy = isBusy(record) || mutation.isPending;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || busy) return;
    const parsed = importParseInputSchema.safeParse({ operationId: currentOperation, expectedVersion: record.version, sheetName, mappingVersion });
    if (!parsed.success) { setValidationError('请选择有效的工作表和字段映射。'); return; }
    setValidationError(null);
    mutation.mutate(parsed.data);
  };
  return <div className="import-parse-panel">
    <h3>工作表与字段映射</h3>
    <form className="import-parse-form" onSubmit={submit}>
      <div className="field"><label htmlFor={sheetId}>输入工作表</label>{record.sheets.length > 0 ? <Combobox id={sheetId} value={sheetName} disabled={!canManage || busy} onValueChange={(value) => { setSheetName(value); setCurrentOperation(operationId()); mutation.reset(); }} searchPlaceholder="搜索工作表名称…" options={record.sheets.map((sheet) => ({ value: sheet.name, label: `${JSON.stringify(sheet.name)}${sheet.state !== 'visible' ? '（隐藏）' : ''} · ${sheet.rowCount} 行`, keywords: [sheet.name] }))} /> : <><Input id={sheetId} value={sheetName} maxLength={128} disabled={!canManage || busy} onChange={(event) => { setSheetName(event.target.value); setCurrentOperation(operationId()); mutation.reset(); }} /><p className="mapping-help">尚未成功读取工作表列表。可填写原表的精确名称后重试。</p></>}</div>
      <div className="field"><label htmlFor={mappingId}>字段映射</label><SelectField id={mappingId} value={mappingVersion} disabled={!canManage || busy} onValueChange={(value) => { setMappingVersion(value as ImportParseInput['mappingVersion']); setCurrentOperation(operationId()); mutation.reset(); }} options={[{ value: 'fba-list-v1', label: '单列 FBA 清单 · 空行分票' }, { value: 'feishu-v1', label: '飞书表格 · 货件级输入 v1' }, { value: 'manual-v1', label: '人工需求模板 v1' }, { value: 'online-v1', label: '在线表格 · 网页输入 v1' }]} /></div>
      {canManage && <Button type="submit" icon={RefreshCw} loading={mutation.isPending} loadingLabel="正在创建解析任务…" disabled={busy}>按此映射重新解析</Button>}
      {validationError && <p className="form-note error-note" role="alert">{validationError}</p>}
      {mutation.isError && <p className="form-note error-note" role="alert">{messageOf(mutation.error)}{mutation.error instanceof ApiError && mutation.error.status === 409 ? ' 请刷新详情后核对最新解析版本。' : ''}</p>}
    </form>
    {selectedSheet && <details className="import-sheet-details"><summary>查看工作表结构与表头</summary><p>精确表名：<code>{JSON.stringify(selectedSheet.name)}</code>（引号内保留首尾空格）</p><p>{selectedSheet.columnCount} 列 · 合并区域 {selectedSheet.mergedRanges.length} 处 · 隐藏列 {selectedSheet.hiddenColumns.length} 列</p><dl className="import-headers">{selectedSheet.headers.map((header) => <div key={header.column}><dt>{header.column}</dt><dd>{header.value ?? '空表头'}</dd></div>)}</dl>{selectedSheet.mergedRanges.length > 0 && <p>合并区域：{selectedSheet.mergedRanges.join('、')}</p>}</details>}
  </div>;
}

export function SourceRows({ record, runId, scope = '', onReady }: { record: SourceImport; runId: string; scope?: string; onReady?: (runId: string) => void }) {
  const statusId = `${scope ? `${scope}-` : ''}import-row-status`;
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const rows = useQuery({ queryKey: ['import-rows', record.id, runId, page, status], queryFn: () => api.importRows(record.id, { page, pageSize: 20, parseRunId: runId, status }), retry: false });
  useEffect(() => { if (rows.isSuccess) onReady?.(runId); }, [rows.isSuccess, runId, onReady]);
  useEffect(() => { if (rows.error instanceof ApiError && rows.error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] }); }, [rows.error, queryClient]);
  return <div className="import-source-rows">
    <div className="section-heading panel-heading"><div><h3>源行预览</h3><p>每行保留工作表及行号；展开原始单元格可查看公式、缓存、类型和数字格式。</p></div><IconButton type="button" icon={RefreshCw} label="刷新源行" loading={rows.isFetching} onClick={() => void rows.refetch()} /></div>
    <div className="field import-row-filter"><label htmlFor={statusId}>按校验状态筛选</label><SelectField id={statusId} value={status} onValueChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: '', label: '全部源行' }, { value: 'valid', label: '格式有效' }, { value: 'needs_review', label: '待核对' }, { value: 'error', label: '有错误' }]} /></div>
    {rows.isPending ? <p className="list-state" role="status">正在读取源行…</p> : rows.isError ? <ErrorFeedback title="源行预览暂时不可用" error={rows.error} retry={() => void rows.refetch()} /> : rows.data.items.length === 0 ? <p className="list-state">本次解析没有符合条件的源行。请检查工作表和字段映射。</p> : <>
      <div className="table-scroll" role="region" aria-label="需求源行预览表，可横向滚动" tabIndex={0}><div className="table-inner"><table className="task-table import-rows-table"><thead><tr><th scope="col">来源位置</th><th scope="col">店铺 / 身份</th><th scope="col">FBA</th><th scope="col">渠道 / 国家 / FC</th><th scope="col">来源时间</th><th scope="col">校验结果</th><th scope="col">原始数据</th></tr></thead><tbody>{rows.data.items.map((row) => <SourceRow key={row.id} row={row} originalName={record.originalName} />)}</tbody></table></div></div>
      <Pagination page={page} pageSize={20} total={rows.data.total} pending={rows.isFetching} change={setPage} />
    </>}
  </div>;
}

function SourceRow({ row, originalName }: { row: ImportRow; originalName: string }) {
  const value = row.normalized;
  return <tr>
    <td><strong>{row.sheetName} · 第 {row.rowNumber} 行</strong><small className="mapping-subtext">{originalName}</small>{row.hidden && <small className="mapping-subtext">原表隐藏行</small>}<small className="mapping-subtext">来源编号：{value.sourceRecordId ?? '未提供'}</small></td>
    <td>{value.shop ?? '未提供店铺'}<small className="mapping-subtext">{value.sid === null ? '店铺映射待确认' : `sid ${value.sid} · 映射版本 ${value.sellerMappingVersion}`}</small></td>
    <td><strong>{value.fba ?? '未提供 FBA'}</strong>{value.subBatchName && <small className="mapping-subtext">来源批次：{value.subBatchName}</small>}</td>
    <td>{value.channel ?? '未提供渠道'}<small className="mapping-subtext">{value.country ?? '未提供国家'} / {value.destinationFc ?? '未提供 FC'}</small>{value.destinationAddress && <small className="mapping-subtext">仓库地址：{value.destinationAddress}</small>}</td>
    <td><span>来源填写时间：{value.sourceFilledAt ?? value.sourceDate ?? '空'}</span><small className="mapping-subtext">货件创建时间：{value.shipmentCreatedAt ?? '空'}</small></td>
    <td><span className={`import-row-status import-row-status-${row.status}`}>{rowStatusLabels[row.status]}</span>{row.issues.length > 0 && <IssueList issues={row.issues} />}</td>
    <td><details className="import-cell-details"><summary>展开 {row.rawCells.length} 个单元格</summary><dl>{row.rawCells.map((cell) => <div key={cell.address}><dt>{cell.address}{cell.hidden ? '（隐藏列）' : ''}</dt><dd><strong>{cell.value === null ? '空值' : String(cell.value)}</strong><span>类型 {cell.type} · 格式 {cell.numberFormat || '常规'}</span><span>原始值：{cell.rawValue ?? '空'}</span>{cell.formula !== null && <><span>公式：{cell.formula}</span><span>公式缓存：{({ not_formula: '非公式', present: '有缓存', empty: '缓存为空', absent: '缺少缓存' } as const)[cell.formulaCache]}</span></>}</dd></div>)}</dl>{value.notes && <p>来源备注：{value.notes}</p>}</details></td>
  </tr>;
}

export function ImportBadge({ record }: { record: SourceImport }) {
  const Icon = record.status === 'parsing' ? LoaderCircle : record.status === 'preview_ready' ? CircleCheck : record.status === 'failed' || record.status === 'awaiting_mapping' ? CircleAlert : Clock3;
  return <span className={`status-badge ${record.status === 'failed' ? 'status-failed' : record.status === 'preview_ready' ? 'status-completed' : 'status-queued'}`}><Icon size={15} aria-hidden="true" className={record.status === 'parsing' ? 'motion-spin' : undefined} />{importStatusLabels[record.status]}</span>;
}

export function RunHistoryItem({ run, current, selected, choose }: { run: ImportRun; current: boolean; selected: boolean; choose: () => void }) {
  const labels: Record<ImportRun['status'], string> = { queued: '等待解析', running: '解析中', completed: '已解析', failed: '失败' };
  return <li aria-current={selected ? 'true' : undefined}><div><strong>版本 {run.inputVersion}{current ? ' · 当前' : ''}</strong><span className="mapping-subtext">{timestamp(run.createdAt)} · {labels[run.status]} · {run.sheetName ?? '待选择工作表'} · {run.mappingVersion ?? '待选择映射'}</span>{run.status === 'failed' && <p className="error-note">{run.errorMessage ?? '解析失败'}</p>}</div>{run.status === 'completed' && <IconButton type="button" icon={Eye} label={selected ? '正在查看' : '查看此版本源行'} description={`解析版本 ${run.inputVersion}`} disabled={selected} onClick={choose} />}</li>;
}

export function IssueList({ issues }: { issues: ImportIssue[] }) {
  return <ul className="import-issues">{issues.map((issue, index) => <li className={issue.severity === 'error' ? 'error-note' : 'warning-note'} key={`${issue.code}:${issue.address ?? ''}:${index}`}>{issue.address ? `${issue.address}：` : ''}{issue.message}</li>)}</ul>;
}

export function ErrorFeedback({ title, error, retry }: { title: string; error: unknown; retry: () => void }) {
  return <div className="inline-error" role="alert"><div><strong>{title}</strong><p>{messageOf(error)}</p></div><Button type="button" icon={RefreshCw} onClick={retry}>重试</Button></div>;
}

export function Pagination({ page, pageSize, total, pending, change }: { page: number; pageSize: number; total: number; pending: boolean; change: (page: number) => void }) {
  return <div className="mapping-pagination"><span>共 {total} 条 · 第 {page} 页</span><div><IconButton type="button" icon={ChevronLeft} label="上一页" disabled={page === 1 || pending} onClick={() => change(page - 1)} /><IconButton type="button" icon={ChevronRight} label="下一页" disabled={page * pageSize >= total || pending} onClick={() => change(page + 1)} /></div></div>;
}
