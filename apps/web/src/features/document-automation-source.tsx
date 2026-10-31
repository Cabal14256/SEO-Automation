import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Filter, X } from 'lucide-react';
import type { DocumentAutomationJob, DocumentCandidate } from '@scm/contracts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';
import { MultiSelect } from '../components/ui/multi-select';
import { filterMultiSelectOptions } from '../components/ui/multi-select-options';
import { Check, QueryError } from './batch-shared';
import type { GridColumn } from '../components/ui/scm-data-grid';
import { DocumentDataGrid } from './document-grid';
import { documentApi } from './document-api';
import { documentAutomationApi } from './document-automation-api';
import { useAutomationResume } from './document-automation';
import { DocumentField } from './document-fields';
import { shippingRunApi } from './shipping-run-api';
import { useDocumentAction } from './documents';

const commonFields = [['service', '渠道服务'], ['customsMode', '报关方式'], ['clearanceMode', '清关方式'], ['taxMode', '税务方式'], ['vat', 'VAT'], ['deliveryStation', '交货仓站'], ['battery', '含电池'], ['magnetic', '含磁性'], ['liquid', '含液体'], ['powder', '含粉末'], ['dangerous', '危险品']] as const;
export function NewDocument({ active, started, resume, onEditorState, actionsContainer, close, blocked }: {
  active: boolean; started: (job: DocumentAutomationJob) => void; resume: (job: DocumentAutomationJob) => void; onEditorState: (state: { dirty: boolean; busy: boolean }) => void;
  actionsContainer: HTMLDivElement | null; close: () => void; blocked: boolean;
}) {
  const id = useId();
  const [step, setStep] = useState<'sources' | 'details'>('sources');
  const heading = useRef<HTMLHeadingElement>(null);
  const [draftRunId, setDraftRunId] = useState('');
  const [runId, setRunId] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<Record<string, string | null>>({});
  const [prefillScopeChanged, setPrefillScopeChanged] = useState(false);
  const action = useDocumentAction();
  const resetAction = action.reset;
  useEffect(() => { resetAction(); }, [runId, selected, title, fields, resetAction]);
  const existing = useAutomationResume(action.error, resume, { preserveDraft: true, active });
  const locked = action.busy || existing.busy || blocked || !active;
  useEffect(() => { onEditorState({ dirty: selected.length > 0 || Boolean(title.trim()) || Object.values(fields).some(Boolean), busy: action.busy || existing.busy }); }, [selected.length, title, fields, action.busy, existing.busy, onEditorState]);
  const runs = useQuery({ queryKey: ['shipping-runs'], queryFn: shippingRunApi.list, enabled: active, retry: false });
  const candidates = useQuery({ queryKey: ['document-candidates', runId], queryFn: () => documentApi.candidates(runId), enabled: active && Boolean(runId), retry: false });
  const options = useQuery({ queryKey: ['document-field-options'], queryFn: documentApi.fieldOptions, enabled: active, retry: false });
  const shipmentOptions = (candidates.data?.items ?? []).map((item) => ({ value: item.demandId,
    label: `${item.demand.snapshot.fba} · ${item.demand.snapshot.shop} · ${item.demand.snapshot.destinationFc || '目的仓未填写'}`,
    keywords: [item.groupName, item.demand.snapshot.country, item.demand.snapshot.channel || '', String(item.demand.snapshot.sid)],
  }));
  const visibleIds = new Set(filterMultiSelectOptions(shipmentOptions, search).map((option) => option.value));
  const visible = (candidates.data?.items ?? []).filter((item) => visibleIds.has(item.demandId));
  const members = (candidates.data?.items ?? []).filter((item) => selected.includes(item.demandId));
  const canStart = !locked && Boolean(runId) && draftRunId === runId && !candidates.isPending && !candidates.isFetching && !candidates.isError && members.length > 0 && members.length === selected.length;
  const chooseStep = (next: 'sources' | 'details') => { if (!locked && (next === 'sources' || canStart)) setStep(next); };
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); heading.current?.closest('.import-dialog-body')?.scrollTo({ top: 0 }); });
    return () => cancelAnimationFrame(frame);
  }, [active, step]);
  const start = () => {
    if (step !== 'details' || !canStart) return;
    const input = { shippingRunId: runId, demandIds: members.map((item) => item.demandId), ...(title.trim() ? { title: title.trim() } : {}), fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value?.trim())) };
    action.run(`automation-start:${JSON.stringify(input)}`, (operationId) => documentAutomationApi.start({ operationId, ...input }), '自动出单任务已开始。', (value) => started((value as { job: DocumentAutomationJob }).job));
  };
  return <div className="document-new-wizard">
    <nav className="import-wizard-progress" aria-label="新建发票步骤"><ol>{([{ value: 'sources', label: '选择货件' }, { value: 'details', label: '出单资料' }] as const).map((item, index) => <li key={item.value} data-current={step === item.value}><button type="button" aria-current={step === item.value ? 'step' : undefined} disabled={locked || item.value === 'details' && !canStart} onClick={() => chooseStep(item.value)}><span className="wizard-step-number" aria-hidden="true">{index + 1}</span><span>{item.label}</span></button></li>)}</ol></nav>
    <section className="content-panel document-new-panel" aria-labelledby={`${id}-new-title`}>
    <div className="section-heading"><h3 ref={heading} tabIndex={-1} id={`${id}-new-title`}>{step === 'sources' ? '选择本次发货的货件' : '出单资料'}</h3><span>{step === 'sources' ? '支持多选，也可选择当前列表全部货件' : `已选 ${selected.length} 个货件 · 统一检查后生成发票 ZIP 压缩包`}</span></div>
    <div hidden={step !== 'sources'}>
    {runs.isError && <QueryError error={runs.error} retry={() => void runs.refetch()} />}
    <form className="document-candidate-filters" onSubmit={(event) => { event.preventDefault(); if (locked) return; if (runId && draftRunId !== runId) setPrefillScopeChanged(Boolean(title.trim()) || Object.values(fields).some(Boolean)); setRunId(draftRunId); setSelected([]); setSearch(''); }}>
      <div className="field"><label htmlFor={`${id}-run`}>发货次</label><SelectField id={`${id}-run`} value={draftRunId} disabled={locked || runs.isFetching} onValueChange={setDraftRunId} options={[{ value: '', label: '请选择发货次' }, ...(runs.data?.items ?? []).map((item) => ({ value: item.id, label: `${item.month} 第 ${item.sequence ?? '待分配'} 次 · ${item.numberingDate}` }))]} /></div>
      <div className="field"><label htmlFor={`${id}-search`}>查找货件</label><MultiSelect id={`${id}-search`} values={selected} onValuesChange={setSelected} search={search} onSearchChange={setSearch} disabled={locked || !runId || draftRunId !== runId || candidates.isPending || candidates.isFetching || candidates.isError} placeholder="搜索并选择货件，可多选" selectedSummary={`已选 ${selected.length} 个货件`} popupLabel="选择货件" searchPlaceholder="搜索 FBA、店铺、目的仓或制表组…" emptyMessage="没有匹配货件，请换个关键词。" options={shipmentOptions} /></div>
      <Button icon={Filter} type="submit" disabled={locked || runs.isFetching || !draftRunId} loading={candidates.isFetching}>读取货件</Button>
    </form>
    {search.trim() && <p className="mapping-help">当前搜索：{search} · 匹配 {visible.length} 个货件 <Button type="button" variant="text" disabled={locked} onClick={() => setSearch('')}>清除搜索</Button></p>}
    {!runId ? <p className="list-state">先选择发货次并读取货件。</p> : candidates.isPending ? <p className="list-state" role="status">正在读取本次发货的货件…</p> : candidates.isError ? <QueryError error={candidates.error} retry={() => void candidates.refetch()} /> : candidates.data.items.length === 0 ? <p className="list-state">本次暂无有效制表确认的货件。请先在发货批次中完成 M2 制表确认与编码。</p> : <>
      <div className="document-selection-bar"><Check checked={visible.length > 0 && visible.every((item) => selected.includes(item.demandId))} disabled={locked || draftRunId !== runId} onChange={(checked) => setSelected((current) => checked ? [...new Set([...current, ...visible.map((item) => item.demandId)])] : current.filter((item) => !visible.some((candidate) => candidate.demandId === item)))}>选择当前列表</Check><span>已选 {selected.length} 个 FBA</span></div>
      <CandidateGrid rows={visible} selected={selected} setSelected={setSelected} active={active && step === 'sources'} locked={locked || draftRunId !== runId} scopeKey={`${runId}:${search}`} />{visible.length === 0 && <p className="list-state">未找到匹配货件，请调整搜索词。</p>}
    </>}
    </div>
    <div hidden={step !== 'details'} aria-label="本次出单资料">
      {prefillScopeChanged && <p className="permission-note warning-note" role="status">已切换发货次，已填写的出单资料仍保留。请核对这些资料是否适用于本次货件，再开始生成。</p>}
      <p className="mapping-help">下方资料可选填写，用于补齐所选货件的空白字段，已有内容保留。未填写的资料由系统读取档案；仍有缺项时会统一提示。</p>
      <div className="field document-title-field"><label htmlFor={`${id}-title`}>任务名称（可选）</label><Input id={`${id}-title`} value={title} maxLength={200} disabled={locked} onChange={(event) => setTitle(event.target.value)} /></div>
      <div className="document-form-grid">{commonFields.map(([key, label]) => <div className="field" key={key}><label htmlFor={`${id}-${key}`}>{label}</label><DocumentField id={`${id}-${key}`} fieldKey={key} value={fields[key] || ''} disabled={locked} onValueChange={(value) => setFields((current) => ({ ...current, [key]: value }))} services={options.data?.services ?? []} servicesLoading={options.isFetching} servicesError={options.isError} retryServices={() => void options.refetch()} /></div>)}</div>
      <p className="mapping-help">系统先读取所选货件资料并整批检查；有缺项时统一填写，全部通过后，每张发票生成独立 Excel 文件并打包为 ZIP；混装提醒不阻止输出。</p>
    </div>
    {action.feedback}
    {existing.feedback}
    {actionsContainer && createPortal(<>{step === 'details' && <Button type="button" icon={ArrowLeft} disabled={locked} onClick={() => chooseStep('sources')}>上一步</Button>}<Button type="button" icon={X} disabled={locked} onClick={close}>暂时关闭</Button>{step === 'sources' ? <Button type="button" icon={ArrowRight} variant="primary" disabled={!canStart} onClick={() => chooseStep('details')}>下一步：出单资料</Button> : <Button type="button" icon={ArrowRight} variant="primary" disabled={!canStart} loading={action.busy} onClick={start}>自动生成发票</Button>}</>, actionsContainer)}
    </section>
  </div>;
}

function CandidateGrid({ rows, selected, setSelected, active, locked, scopeKey }: { rows: DocumentCandidate[]; selected: string[]; setSelected: (update: (current: string[]) => string[]) => void; active: boolean; locked: boolean; scopeKey: string }) {
  const choose = (row: DocumentCandidate, checked: boolean) => { if (!locked) setSelected((current) => checked ? [...new Set([...current, row.demandId])] : current.filter((id) => id !== row.demandId)); };
  const readiness = (row: DocumentCandidate) => row.blockers.length ? row.blockers.map((issue) => issue.message).join('；') : '来源已就绪';
  const columns: GridColumn<DocumentCandidate>[] = [
    { key: 'rowNumber', title: '#', width: 48, utility: 'number', align: 'center', getValue: () => '' },
    { key: 'selection', title: '选择', width: 48, getValue: () => '', getChecked: (row) => selected.includes(row.demandId), disabled: () => locked, onToggle: choose },
    { key: 'fba', title: 'FBA', width: 190, getValue: (row) => row.demand.snapshot.fba },
    { key: 'group', title: '批次', width: 200, getValue: (row) => row.groupName },
    { key: 'destinationFc', title: '目的仓', width: 110, getValue: (row) => row.demand.snapshot.destinationFc || '目的仓未填写' },
    { key: 'shop', title: '店铺', width: 160, getValue: (row) => row.demand.snapshot.shop },
    { key: 'country', title: '国家', width: 90, getValue: (row) => row.demand.snapshot.country },
    { key: 'channel', title: '渠道', width: 110, getValue: (row) => row.demand.snapshot.channel || '渠道未填写' },
    { key: 'address', title: '收件地址', width: 260, getValue: (row) => row.demand.snapshot.destinationAddress || '收件地址待补齐' },
    { key: 'source', title: '来源版本 / 箱数', width: 160, getValue: (row) => `v${row.groupVersion} · ${row.shipment.data.boxes.length} 箱` },
    { key: 'readiness', title: '生成准备情况', width: 300, getValue: readiness, getCellState: (row) => row.blockers.length ? 'error' : 'default' },
    { key: 'actions', title: '操作', width: 48, align: 'center', getValue: () => '', icon: () => 'more', openMenu: true },
  ];
  return <DocumentDataGrid tableKey="document-candidates" label="本次发货的可选货件" active={active} rows={rows} columns={columns} mandatoryColumnKeys={['fba']} getRowKey={(row) => row.demandId} frozenColCount={3} rowHeight={56} maxHeight={480} menuScopeKey={scopeKey} detailsMode="dialog" detailsTitle={(row) => row.demand.snapshot.fba}
    renderDetails={(row) => <><Check checked={selected.includes(row.demandId)} disabled={locked} onChange={(checked) => choose(row, checked)}>{row.demand.snapshot.fba}</Check><dl className="scm-grid-record-fields">{columns.filter((column) => !['rowNumber', 'selection', 'actions'].includes(column.key)).map((column) => <div className="scm-grid-record-field" key={column.key}><dt>{column.title}</dt><dd>{column.getValue(row) || '—'}</dd></div>)}</dl></>}
    renderRowMenu={(row, context) => <><div className="scm-record-menu-summary"><strong>{row.demand.snapshot.fba}</strong><p>{row.demand.snapshot.shop} · {row.demand.snapshot.destinationFc || '目的仓未填写'}</p><p className={row.blockers.length ? 'error-note' : undefined}>{readiness(row)}</p></div><div className="scm-record-menu-actions"><Button type="button" variant="text" role="menuitem" disabled={locked} onClick={() => { choose(row, !selected.includes(row.demandId)); context.close(); }}>{selected.includes(row.demandId) ? '取消选择货件' : '选择货件'}</Button><Button type="button" variant="text" role="menuitem" onClick={context.openDetails}>完整详情</Button></div></>} />;
}
