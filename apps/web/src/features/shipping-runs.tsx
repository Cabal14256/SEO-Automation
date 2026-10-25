import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, CircleAlert, Download, FileSpreadsheet, LoaderCircle, RefreshCw } from 'lucide-react';
import { correctShippingRunInputSchema, type CorrectShippingRunInput, type CreateShippingRunInput, type ImportAccepted, type ImportDraftContent, type OnlineImportRow, type ShippingRun, type SourceImport } from '@scm/contracts';
import { api, ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { BatchPagination, BatchTable, downloadBlob, newOperation, QueryError, timestamp, useBatchAction } from './batch-shared';
import { batchApi } from './batch-api';
import { ImportDialog } from './import-dialog';
import { shippingRunApi } from './shipping-run-api';
import { OnlineImport } from './online-import';
import { emptyOnlineRow } from './online-import-grid';
import { UploadPanel, ParseControls, isBusy } from './import-source';
import { shanghaiToday } from '../components/ui/date-utils';
import './shipping-runs.css';

type ShippingDraft = NonNullable<ImportDraftContent['shipping']>;
const labels: Record<ShippingRun['status'], string> = { draft: '待处理', queued: '排队中', running: '处理中', needs_review: '待处理', ready: '可导出', failed: '失败' };
const stages: Record<ShippingRun['stage'], string> = { lookup: '补全货件资料', commit: '提交需求', grouping: '建立分票关联', sync: '同步商品与箱数据', confirmation: '校验和分配箱码', ready: '发货表已就绪' };
const running = (run?: ShippingRun) => run && (run.status === 'queued' || run.status === 'running');
const steps = [
  { stage: 'lookup', label: '补全资料' }, { stage: 'commit', label: '保存需求' }, { stage: 'grouping', label: '建立分票' },
  { stage: 'sync', label: '同步商品与箱' }, { stage: 'confirmation', label: '校验与箱码' },
] as const;
const progressCopy: Record<ShippingRun['stage'], string> = {
  lookup: '正在查询店铺、国家、渠道和目的仓资料。', commit: '正在保存本次发货需求，完成后将自动建立分票关联。',
  grouping: '正在整理各票的 FBA 关联，完成后将自动同步商品与箱数据。',
  sync: '正在同步商品与箱数据，完成后将自动校验并分配箱码。',
  confirmation: '正在校验数量与箱序，并自动确认、分配箱码。', ready: '各票已完成整理，可预览并生成本次发货 XLSX。',
};

/** Creation uses a saved, exact request until the server acknowledges it. */
export function AutomaticShippingRun({ record, active, initial, onChange }: { record: SourceImport; active: boolean; initial: ShippingDraft; onChange: (value: ShippingDraft) => void }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const pending = useRef<CreateShippingRunInput | null>(initial.pending ?? null);
  const started = useRef(false);
  const create = useMutation({ networkMode: 'always', mutationFn: shippingRunApi.create,
    onSuccess: (value) => {
      client.setQueryData(['shipping-run', value.run.id], value);
      const next = { ...draft, runId: value.run.id, pending: undefined };
      pending.current = null; setDraft(next); onChange(next);
      void client.invalidateQueries({ queryKey: ['shipping-runs'] });
    },
  });
  const createRun = () => {
    if (started.current || draft.runId || create.isPending || !record.latestRun || record.latestRun.status !== 'completed') return;
    started.current = true;
    pending.current ??= { operationId: draft.operationId, importId: record.id, parseRunId: record.latestRun.id, numberingDate: draft.numberingDate };
    const next = { ...draft, pending: { ...pending.current, numberingDate: draft.numberingDate } };
    setDraft(next); onChange(next); create.mutate(pending.current);
  };
  useEffect(() => { if (active) createRun(); });
  if (draft.runId) return <ShippingRunPanel id={draft.runId} active={active} sourceRecord={record} />;
  return <section className="shipping-run-process" aria-label="自动整理本次发货">
    <h3>自动整理本次发货</h3>
    {create.isError ? <><QueryError error={create.error} retry={() => { started.current = false; createRun(); }} /><p className="mapping-help">原请求已保留，重试不会重复领取发货次数或票号。</p>{create.error instanceof ApiError && create.error.status === 409 && record.latestRun?.status === 'completed' && pending.current?.parseRunId !== record.latestRun.id && <Button type="button" onClick={() => { const next = { ...draft, operationId: newOperation(), pending: undefined }; pending.current = null; setDraft(next); onChange(next); }}>按最新解析版本重新整理</Button>}</>
      : <p className="form-note" role="status">正在保存本次发货任务，接收后将由后台继续整理。</p>}
  </section>;
}

export function ShippingRunsWorkspace({ active, onCreate }: { active: boolean; onCreate: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const runs = useQuery({ queryKey: ['shipping-runs'], queryFn: shippingRunApi.list, enabled: active, retry: false,
    refetchInterval: (query) => active && query.state.data?.items.some(running) ? 2000 : false });
  return <section className="shipping-run-history" aria-labelledby="shipping-runs-title">
    <div className="section-heading panel-heading"><div><h2 id="shipping-runs-title">本次发货与票号</h2><p>导入本次所需的 FBA，按空行分票，自动整理到可预览、可导出。</p></div><div className="import-selection-actions"><IconButton type="button" icon={RefreshCw} label="刷新发货记录" loading={runs.isFetching} onClick={() => void runs.refetch()} /><Button type="button" variant="primary" icon={FileSpreadsheet} onClick={onCreate}>导入本次发货</Button></div></div>
    {runs.isPending ? <p className="list-state" role="status">正在读取发货记录…</p> : runs.isError ? <QueryError error={runs.error} retry={() => void runs.refetch()} /> : !runs.data.items.length ? <p className="mapping-help">点击“导入本次发货”，只填 FBA 并以空行分票即可。</p> : <><BatchTable label="本次发货记录" headers={['编号日期 / 发货次数', '整理进度', '接收时间', '发货表']}>{runs.data.items.slice((page - 1) * 10, page * 10).map((run) => <tr key={run.id}>
      <td><strong>{run.numberingDate}</strong><small className="mapping-subtext">{run.sequence ? `${run.month} 第 ${run.sequence} 次发货` : '校验通过后分配次数'}</small></td>
      <td><span>{labels[run.status]}</span><small className="mapping-subtext">{run.origin === 'manual' && run.status === 'draft' ? '手工批次已保存，待同步核对' : stages[run.stage]}</small>{run.membershipFrozenAt && <small className="mapping-subtext">已发布，成员安排已冻结</small>}{run.error && <small className="mapping-subtext error-note">{run.error.message}</small>}</td><td>{timestamp(run.createdAt)}</td><td><Button type="button" icon={FileSpreadsheet} onClick={() => setSelected(run.id)}>{run.status === 'ready' ? '查看发货表' : '查看进度与处理'}</Button></td>
    </tr>)}</BatchTable>{runs.data.items.length > 10 && <BatchPagination page={page} pageSize={10} total={runs.data.items.length} change={setPage} />}</>}
    <ImportDialog open={active && Boolean(selected)} title="本次发货表" close={() => setSelected(null)} wide>{selected && <ShippingRunPanel key={selected} id={selected} active={active} />}</ImportDialog>
  </section>;
}

export function ShippingRunPanel({ id, active, sourceRecord }: { id: string; active: boolean; sourceRecord?: SourceImport }) {
  const client = useQueryClient();
  const action = useBatchAction();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'products' | 'boxes'>('products');
  const [correcting, setCorrecting] = useState(false);
  const detail = useQuery({ queryKey: ['shipping-run', id], queryFn: () => shippingRunApi.detail(id), enabled: active, retry: false,
    refetchInterval: (query) => active && running(query.state.data?.run) ? 1500 : false });
  const run = detail.data?.run;
  const report = useQuery({ queryKey: ['shipping-run-report', id, run?.version, run?.status, page], queryFn: () => batchApi.reports({ month: '', region: 'all', page, shippingRunId: id }), enabled: active && Boolean(run?.sequence), retry: false,
    refetchInterval: active && running(run) ? 2000 : false });
  const exports = useQuery({ queryKey: ['batch-exports', 'shipping-run', id], queryFn: () => batchApi.exports({ shippingRunId: id }), enabled: active, retry: false,
    refetchInterval: (query) => active && query.state.data?.some((item) => item.status === 'queued' || item.status === 'running') ? 1500 : false });
  const completedExports = exports.data?.filter((item) => item.status === 'completed').map((item) => item.id).join(',');
  useEffect(() => { if (completedExports) void client.invalidateQueries({ queryKey: ['shipping-run-report', id] }); }, [completedExports, client, id]);
  const ready = run?.status === 'ready' && Boolean(report.data?.confirmations.length) && !report.isFetching && !report.isError && !report.data?.blocked.length;
  const refresh = () => { void detail.refetch(); void report.refetch(); void exports.refetch(); };
  const retry = () => {
    if (!run) return;
    action.run(`shipping-retry-${id}-${run.version}`, async (operationId) => {
      const value = await shippingRunApi.retry(id, { operationId, expectedVersion: run.version,
        ...(sourceRecord?.id === run.importId && sourceRecord.latestRun?.status === 'completed' && sourceRecord.latestRun.id !== run.parseRunId && run.sequence === null ? { parseRunId: sourceRecord.latestRun.id } : {}) });
      client.setQueryData(['shipping-run', id], value); await client.invalidateQueries({ queryKey: ['shipping-runs'] });
    }, '已继续后台整理。');
  };
  const generate = () => {
    if (!run || !ready || !report.data) return;
    const references = report.data.confirmations;
    action.run(`shipping-export-${id}-${run.version}-${JSON.stringify(references)}`, async (operationId) => {
      await batchApi.export({ operationId, shippingRunId: id, expectedShippingRunVersion: run.version, groupIds: references.map((ref) => ref.groupId), expectedConfirmations: references, region: 'all' });
      await client.invalidateQueries({ queryKey: ['batch-exports', 'shipping-run', id] });
    }, '已开始生成本次发货 XLSX。');
  };
  if (detail.isPending) return <p className="list-state" role="status">正在读取本次发货…</p>;
  if (detail.isError) return <QueryError error={detail.error} retry={() => void detail.refetch()} />;
  if (!run || !detail.data) return null;
  const runDetail = detail.data;
  const boxes = Array.from({ length: Math.max(10, report.data?.maxBoxes ?? 0) }, (_, index) => index + 1);
  const inProgress = Boolean(running(run));
  const stopped = run.status === 'draft' || run.status === 'needs_review' || run.status === 'failed';
  // An unconfirmed source is expected while the automatic job is building or
  // processing it. Keep all other errors visible and retain the export gate.
  const reportProblems = (report.data?.blocked ?? []).filter((item) => !(inProgress
    && ['grouping', 'sync', 'confirmation'].includes(run.stage)
    && ['CONFIRMATION_REQUIRED', 'CODES_REQUIRED'].includes(item.code)
    && !runDetail.issues.some((issue) => issue.groupId === item.groupId)))
    .filter((item) => !runDetail.issues.some((issue) => issue.code === item.code && issue.groupId === item.groupId));
  const hasProblems = stopped || Boolean(run.error) || runDetail.issues.length > 0 || reportProblems.length > 0 || report.isError;
  const blockedGroups = new Set(report.data?.blocked.map((item) => item.groupId));
  const confirmedGroups = new Set(report.data?.confirmations.filter((ref) => !blockedGroups.has(ref.groupId)).map((ref) => ref.groupId));
  const projectedDemands = new Set(report.data?.boxes.map((box) => box.demandId));
  const members = runDetail.tickets.flatMap((ticket) => ticket.members);
  const readyMembers = members.filter((member) => member.groupId && member.demandId && confirmedGroups.has(member.groupId) && projectedDemands.has(member.demandId)).length;
  const currentStep = run.stage === 'ready' ? steps.length - (hasProblems ? 1 : 0) : steps.findIndex((step) => step.stage === run.stage);
  const tableReady = run.status === 'ready' && report.data && !report.isError && report.data.blocked.length === 0;
  const statusTitle = hasProblems ? stopped ? `${labels[run.status]} · ${stages[run.stage]}` : '发货表需要核对'
    : inProgress ? `${labels[run.status]} · ${stages[run.stage]}` : tableReady ? '发货表已就绪' : '正在读取发货表';
  const statusCopy = run.status === 'draft' ? '手工批次已保存。可打开相关批次同步核对，或点击“继续后台整理”。' : hasProblems ? stopped ? '已保留成功步骤，请处理具体问题后继续整理。' : '请核对下方提示；全部问题解决后才能生成整次发货表。'
    : run.status === 'queued' ? '任务已接收，后台将自动继续整理。'
      : inProgress ? progressCopy[run.stage] : tableReady ? progressCopy.ready : '正在核对发货表，读取完成后即可预览和生成 XLSX。';
  const StatusIcon = hasProblems ? CircleAlert : inProgress || !tableReady ? LoaderCircle : Check;
  return <section className="shipping-run-process" aria-label="本次发货整理结果">
    <div className="section-heading panel-heading"><div><h3>{run.month} · {run.sequence ? `第 ${run.sequence} 次发货` : '待分配发货次数'}</h3><p className="mapping-help">编号日期 {run.numberingDate}</p></div><Button type="button" icon={RefreshCw} disabled={detail.isFetching} onClick={refresh}>刷新</Button></div>
    <div className={`shipping-run-progress${hasProblems ? ' shipping-run-progress-attention' : ''}`}>
      <div role="status" aria-label="自动整理进度" className="shipping-run-progress-summary">
        <StatusIcon aria-hidden="true" size={20} className={!hasProblems && (inProgress || !tableReady) ? 'motion-spin' : undefined} />
        <div><strong>{statusTitle}</strong><p>{statusCopy}</p></div>
        {members.length > 0 && run.sequence && report.data && !report.isError && <span className="shipping-run-ready-count">{readyMembers} / {members.length} 个 FBA 已就绪</span>}
      </div>
      <ol className="shipping-run-steps" aria-label="整理步骤">{steps.map((step, index) => {
        const complete = index < currentStep, current = index === currentStep;
        return <li key={step.stage} data-state={complete ? 'complete' : current ? hasProblems ? 'attention' : 'current' : 'pending'} aria-current={current ? 'step' : undefined}>
          <span className="shipping-run-step-marker" aria-hidden="true">{complete ? <Check size={14} /> : index + 1}</span>
          <span>{step.label}<small>{complete ? '已完成' : current ? stopped ? '待处理' : run.status === 'queued' ? '排队中' : hasProblems && !inProgress ? '待核对' : '进行中' : '待开始'}</small></span>
        </li>;
      })}</ol>
      {inProgress && <p className="shipping-run-background-note">系统会自动刷新。关闭页面后仍会继续，可从发货记录返回。</p>}
    </div>
    {action.feedback}
    <ShippingRunArrangementCorrection run={run} active={active} completed={refresh} />
    {run.error && !runDetail.issues.some((issue) => issue.message === run.error?.message) && !reportProblems.some((issue) => issue.message === run.error?.message) && <p className="form-note error-note" role="alert">{run.error.message}</p>}
    {detail.data.issues.length > 0 && <ul className="shipping-run-issues">{detail.data.issues.map((issue, index) => <li key={index}><strong>{issue.ticketIndex ? `第 ${issue.ticketIndex} 段 · ` : ''}{issue.fba ? `${issue.fba}：` : ''}</strong>{issue.message}{issue.groupId && <> <Link to="/shipping" search={{ view: 'demands', groupId: issue.groupId }}>处理相关批次</Link></>}</li>)}</ul>}
    {reportProblems.length > 0 && <ul className="shipping-run-issues" aria-label="发货表待处理问题">{reportProblems.map((item) => {
      const affected = runDetail.tickets.flatMap((ticket) => {
        const matching = ticket.members.filter((member) => member.groupId === item.groupId);
        return matching.length ? [`${ticket.number || `第 ${ticket.sourceTicketIndex} 段`} · ${matching.map((member) => member.fba).join('、')}`] : [];
      });
      return <li key={item.groupId}><strong>{affected.join('；') || item.name}：</strong>{item.message} <Link to="/shipping" search={{ view: 'demands', groupId: item.groupId }}>处理相关批次</Link></li>;
    })}</ul>}
    {stopped && <div className="shipping-run-actions"><Button type="button" icon={RefreshCw} disabled={action.busy} onClick={retry}>{run.status === 'draft' ? '继续后台整理' : '处理后继续整理'}</Button>{run.origin === 'import' && run.sequence === null && <Button type="button" disabled={action.busy} onClick={() => setCorrecting(true)}>修正清单并继续</Button>}{run.importId && <Link to="/imports/$importId" params={{ importId: run.importId }} className="text-button">核对源行与导入资料</Link>}</div>}
    <BatchTable label="分票与 FBA 成员" headers={['完整票号', '来源分段 / 国家', '本票 FBA']}>
      {detail.data.tickets.map((ticket) => <tr key={ticket.id}><td><strong>{ticket.number || '校验通过后自动编号'}</strong></td><td>{run.origin === 'manual' ? '手工建立' : `第 ${ticket.sourceTicketIndex} 段`} · {ticket.country || '国家待补全'}<small className="mapping-subtext">{ticket.members.length} 个 FBA</small></td><td><div className="shipping-ticket-members">{ticket.members.map((member) => <span key={member.inputOrder}>{member.fba}{member.sid ? ` · sid ${member.sid}` : ''}{member.groupId && <> · <Link to="/shipping" search={{ view: 'batches', groupId: member.groupId }}>处理批次</Link></>}</span>)}</div></td></tr>)}
    </BatchTable>
    {!tableReady && !report.isError && Boolean(report.data?.rows.length) && <p className="mapping-help">当前可预览已就绪的 FBA；全部整理完成后才能生成整次 XLSX。</p>}
    <div className="shipping-run-actions"><div className="import-selection-actions"><Button type="button" aria-pressed={view === 'products'} onClick={() => setView('products')}>商品与箱数量</Button><Button type="button" aria-pressed={view === 'boxes'} onClick={() => setView('boxes')}>逐箱明细</Button></div><Button type="button" className="shipping-run-generate" variant="primary" icon={FileSpreadsheet} disabled={!ready || action.busy} onClick={generate}>生成本次发货 XLSX</Button></div>
    {!run.sequence ? <p className="mapping-help">完成货件资料和分票校验后，系统会自动分配票号并同步商品、箱数据。</p> : report.isPending ? <p className="list-state" role="status">正在读取本次发货表…</p> : report.isError ? <QueryError error={report.error} retry={() => void report.refetch()} /> : report.data && <>
      {report.data.rows.length === 0 ? <p className="mapping-help">商品与箱数据整理完成后会在这里显示。</p> : view === 'products' ? <>
        <BatchTable label="本次发货商品表" headers={['完整票号', '店铺 / 国家 / 渠道', 'FBA / 目的仓', 'MSKU / FNSKU', '品名 / SKU', '商品数量', ...boxes.map((order) => `箱 ${order}`), '内部箱码', '本票商品合计']}>
          {report.data.rows.map((row) => <tr key={row.id}><td><strong>{row.ticketNumber}</strong></td><td>{row.shop}<small className="mapping-subtext">{row.country} · {row.channel}</small></td><td>{row.fba}<small className="mapping-subtext">{row.destinationFc || '—'}</small></td><td>{row.msku}<small className="mapping-subtext">{row.fnsku}</small></td><td>{row.productName}<small className="mapping-subtext">{row.sku}</small></td><td className="demand-number">{row.quantity}</td>{boxes.map((order) => <td className="demand-number" key={order}>{row.boxes.find((box) => (box.displayBoxOrder ?? box.boxOrder) === order)?.quantity ?? '—'}</td>)}<td>{row.codes.join('、')}</td><td className="demand-number">{row.groupQuantity}</td></tr>)}
        </BatchTable><BatchPagination page={page} pageSize={50} total={report.data.total} change={setPage} />
      </> : <BatchTable label="本次发货逐箱表" headers={['完整票号 / FBA', '箱列 / 内部箱码', '商品', '箱内数量', '登记重量', '登记尺寸']}>
        {report.data.boxes.flatMap((box) => box.items.map((item, index) => <tr key={`${box.boxId}-${index}`}><td><strong>{box.ticketNumber}</strong><small className="mapping-subtext">{box.fba}</small></td><td>箱 {box.displayBoxOrder ?? box.boxOrder} · {box.code}{box.displayBoxOrder !== undefined && box.displayBoxOrder !== box.boxOrder && <small className="mapping-subtext">货件内箱 {box.boxOrder}</small>}</td><td>{item.msku}<small className="mapping-subtext">{item.fnsku} / {item.sku}</small></td><td>{item.quantity}</td><td>{box.weight === null ? '缺失' : `${box.weight} ${box.weightUnit || ''}`}</td><td>{box.length ?? '—'} × {box.width ?? '—'} × {box.height ?? '—'} {box.lengthUnit || ''}</td></tr>))}
      </BatchTable>}
    </>}
    <details className="shipping-run-export-history"><summary>本次发货导出记录</summary>
      {exports.isPending ? <p role="status">正在读取导出记录…</p> : exports.isError ? <QueryError error={exports.error} retry={() => void exports.refetch()} /> : !exports.data.length ? <p className="mapping-help">查看发货表后，点击“生成本次发货 XLSX”保存文件。</p> : <BatchTable label="本次发货导出记录" headers={['生成时间', '状态 / 数量', '文件']}>{exports.data.map((item) => <tr key={item.id}><td>{timestamp(item.createdAt)}</td><td>{({ queued: '排队中', running: '生成中', completed: '已生成', failed: '失败', stale: '已过期' } as const)[item.status]} · {item.rowCount} 条商品 / {item.boxCount} 箱{item.error && <small className="mapping-subtext error-note">{item.error}</small>}{!item.valid && item.invalidReason && <small className="mapping-subtext warning-note">{item.invalidReason}</small>}</td><td>{item.fileId && <Button type="button" icon={Download} disabled={action.busy} onClick={() => action.run(`shipping-download-${item.id}`, () => downloadBlob(batchApi.download(item.fileId!), `${run.numberingDate.replaceAll('-', '')}-${run.sequence}-发货表.xlsx`), '下载已开始。')}>下载 XLSX</Button>}</td></tr>)}</BatchTable>}
    </details>
    <ImportDialog open={active && correcting && run.origin === 'import'} title="修正本次发货清单" close={() => setCorrecting(false)} wide>{correcting && run.importId && run.parseRunId && <ShippingRunCorrection run={run as ShippingRun & { importId: string; parseRunId: string }} active={active} completed={() => { setCorrecting(false); refresh(); }} />}</ImportDialog>
  </section>;
}

function ShippingRunArrangementCorrection({ run, active, completed }: { run: ShippingRun; active: boolean; completed: () => void }) {
  const client = useQueryClient();
  const key = `scm-shipping-run-correction:${run.id}`;
  const [pending, setPending] = useState<CorrectShippingRunInput | null>(() => { try { const parsed = correctShippingRunInputSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null')); return parsed.success ? parsed.data : null; } catch { return null; } });
  const [reason, setReason] = useState(pending?.reason ?? '');
  const clear = () => { setPending(null); try { sessionStorage.removeItem(key); } catch { /* In-memory recovery remains available. */ } };
  const mutation = useMutation({ networkMode: 'always', mutationFn: (input: CorrectShippingRunInput) => shippingRunApi.correct(run.id, input), onSuccess: async (value) => { clear(); setReason(''); client.setQueryData(['shipping-run', run.id], value); await client.invalidateQueries({ queryKey: ['shipping-runs'] }); completed(); }, onError: (error) => { if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) clear(); } });
  if (!run.membershipFrozenAt && !pending) return null;
  const submit = () => {
    if (!active || mutation.isPending || !pending && !reason.trim()) return;
    const input = pending ?? { operationId: newOperation(), expectedVersion: run.version, reason: reason.trim() };
    setPending(input); try { sessionStorage.setItem(key, JSON.stringify(input)); } catch { /* Preserve the request in memory. */ }
    mutation.mutate(input);
  };
  return <section className="shipping-run-arrangement-correction" aria-label="发货次更正"><p className="mapping-help">本次发货已发布，成员安排已冻结。建立更正版本后可调整安排，旧文件和原确认保留；已冻结批次的成员变更仍需建立批次更正。</p><div className="field"><label htmlFor={`run-correction-${run.id}`}>更正说明</label><Input id={`run-correction-${run.id}`} maxLength={2000} value={reason} disabled={Boolean(pending) || mutation.isPending} onChange={(event) => setReason(event.target.value)} /></div><Button disabled={!active || !pending && !reason.trim()} loading={mutation.isPending} onClick={submit}>{pending ? '重试原更正请求' : '建立发货次更正版本'}</Button>{pending && <p className="mapping-help" role="status">原更正请求已保留，重试沿用相同操作编号。</p>}{mutation.isError && <QueryError error={mutation.error} retry={submit} />}</section>;
}

function ShippingRunCorrection({ run, active, completed }: { run: ShippingRun & { importId: string; parseRunId: string }; active: boolean; completed: () => void }) {
  const client = useQueryClient();
  const [mode, setMode] = useState<'online' | 'file'>('online');
  const [replacement, setReplacement] = useState<ImportAccepted | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ operationId: string; expectedVersion: number; importId: string; parseRunId: string } | null>(null);
  const attempted = useRef(false);
  const source = useQuery({ queryKey: ['shipping-run-source', run.id, run.parseRunId], enabled: active, retry: false, queryFn: async () => {
    const rows: OnlineImportRow[] = [];
    let previousTicket = 0;
    for (let page = 1; ; page += 1) {
      const result = await api.importRows(run.importId, { parseRunId: run.parseRunId, page, pageSize: 100, status: '' });
      for (const row of result.items) {
        const value = row.normalized;
        const ticket = value.sourceTicketIndex ?? 1;
        if (previousTicket && ticket !== previousTicket) rows.push(emptyOnlineRow());
        previousTicket = ticket;
        rows.push({ fba: value.fba ?? '', shop: value.shop ?? '', channel: value.channel ?? '', country: value.country ?? '', destinationFc: value.destinationFc ?? '', destinationAddress: value.destinationAddress ?? '', shipmentCreatedAt: value.shipmentCreatedAt ?? '', sourceFilledAt: value.sourceFilledAt ?? '', referenceQuantity: value.referenceQuantity ?? '', notes: value.notes ?? '' });
      }
      if (rows.length > 1000 || result.page * result.pageSize >= result.total) return rows;
    }
  } });
  const record = useQuery({ queryKey: ['import', replacement?.import.id], queryFn: () => api.sourceImport(replacement!.import.id), enabled: active && Boolean(replacement), retry: false,
    refetchInterval: (query) => active && query.state.data && isBusy(query.state.data) ? 1500 : false });
  const resume = useMutation({ networkMode: 'always', mutationFn: async () => shippingRunApi.retry(run.id, pending.current!), onSuccess: (value) => {
    client.setQueryData(['shipping-run', run.id], value); void client.invalidateQueries({ queryKey: ['shipping-runs'] }); completed();
  } });
  const continueRun = () => {
    if (attempted.current || !record.data?.latestRun || record.data.latestRun.status !== 'completed') return;
    attempted.current = true;
    pending.current ??= { operationId: newOperation(), expectedVersion: run.version, importId: record.data.id, parseRunId: record.data.latestRun.id };
    resume.mutate();
  };
  useEffect(() => { if (active) continueRun(); });
  if (replacement) return <>
    <p className="mapping-help">修正清单已保存，解析完成后自动继续原发货任务。</p>
    {record.isError ? <QueryError error={record.error} retry={() => void record.refetch()} /> : record.data && (record.data.status === 'awaiting_mapping' || record.data.status === 'failed') ? <ParseControls record={record.data} canManage /> : <p role="status">{resume.isError ? '恢复任务未确认成功。' : '正在解析并恢复整理…'}</p>}
    {resume.isError && <QueryError error={resume.error} retry={() => { attempted.current = false; continueRun(); }} />}
  </>;
  return <>
    <p className="mapping-help">调整空行分段、FBA 或店铺/渠道选择后提交。新的源记录会保留，当前发货任务继续使用原编号日期。</p>
    <div className="import-selection-actions"><Button type="button" aria-pressed={mode === 'online'} disabled={busy} onClick={() => setMode('online')}>在线修正</Button><Button type="button" aria-pressed={mode === 'file'} disabled={busy} onClick={() => setMode('file')}>上传修正清单</Button></div>
    {mode === 'file' ? <UploadPanel canManage active={active} accepted={setReplacement} onBusyChange={setBusy} /> : source.isPending ? <p role="status">正在读取原分票清单…</p> : source.isError ? <QueryError error={source.error} retry={() => void source.refetch()} /> : source.data.length > 1000 ? <p className="mapping-help">原清单超过在线编辑行数，请切换“上传修正清单”。</p> : <OnlineImport active={active} accepted={setReplacement} onBusyChange={setBusy} initialDraft={{ rows: source.data, startDate: shanghaiToday(-89), endDate: shanghaiToday() }} />}
  </>;
}
