import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Download, History, RefreshCw, RotateCcw, Save, Upload } from 'lucide-react';
import { physicalEntrySchema, type PhysicalEntry, type PhysicalReview, type PhysicalWrite } from '@scm/contracts';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Combobox } from '../components/ui/combobox';
import { DateRangePicker } from '../components/ui/date-range-picker';
import { SelectField } from '../components/ui/select';
import { BatchPanel, BatchTable, downloadBlob, QueryError, timestamp } from './batch-shared';
import { physicalApi } from './physical-api';
import { usePhysicalAction, usePhysicalIdentity } from './physical-shared';
import { LingxingProgress } from './lingxing-progress';
import './batch-physical.css';

const fields = ['weight', 'length', 'width', 'height'] as const;
const fieldLabels = { weight: '毛重 KG', length: '长 CM', width: '宽 CM', height: '高 CM' };
const runLabels: Record<string, string> = { queued: '排队中', running: '采集中', completed: '已完成', partial: '部分失败', failed: '失败' };
type Draft = { version: 1; m2ConfirmationId: string | null; sourceFingerprint: string | null; baseVersion: number; entries: PhysicalEntry[] };
const entryKey = (entry: Pick<PhysicalEntry, 'shipmentRevisionId' | 'boxId'>) => `${entry.shipmentRevisionId}:${entry.boxId}`;
function measuredValue(value: string | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (!raw || raw.length > 100 || !/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.replace(/^\+/, '').split('.');
  const padded = fraction.padEnd(3, '0');
  const cents = BigInt(whole || '0') * 100n + BigInt(padded.slice(0, 2)) + (padded[2]! >= '5' ? 1n : 0n);
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) * 100n ? `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` : null;
}
function fromReview(review: PhysicalReview): Draft {
  const entries = review.source?.boxes.map((box) => review.revision?.entries.find((entry) => entryKey(entry) === entryKey(box)) ?? { shipmentRevisionId: box.shipmentRevisionId, boxId: box.boxId, status: 'pending' as const, measured: {}, reason: '' }) ?? [];
  return { version: 1, m2ConfirmationId: review.m2ConfirmationId, sourceFingerprint: review.source?.fingerprint ?? null, baseVersion: review.version, entries };
}
function readDraft(key: string, review: PhysicalReview): Draft {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 || !('entries' in value) || !Array.isArray(value.entries) || !('baseVersion' in value) || !Number.isInteger(value.baseVersion) || !('m2ConfirmationId' in value) || !('sourceFingerprint' in value)) return fromReview(review);
    const entries = physicalEntrySchema.array().safeParse(value.entries);
    if (!entries.success || !(value.m2ConfirmationId === null || typeof value.m2ConfirmationId === 'string') || !(value.sourceFingerprint === null || typeof value.sourceFingerprint === 'string')) return fromReview(review);
    return { version: 1, baseVersion: Number(value.baseVersion), m2ConfirmationId: value.m2ConfirmationId, sourceFingerprint: value.sourceFingerprint, entries: entries.data };
  } catch { return fromReview(review); }
}

export function BatchPhysical({ groupId, active = true }: { groupId: string; active?: boolean }) {
  const query = useQuery({ queryKey: ['physical-review', groupId], queryFn: () => physicalApi.current(groupId), retry: false, enabled: active,
    refetchInterval: active ? 3000 : false });
  return <div className="batch-physical">
    {query.isError && <QueryError error={query.error} retry={() => void query.refetch()} />}
    {query.isPending && <p className="list-state" role="status">正在读取实物箱核对记录…</p>}
    {query.data && <PhysicalEditor key={groupId} review={query.data} active={active} failed={query.isError} refreshing={query.isFetching} reload={async () => (await query.refetch()).data} />}
  </div>;
}

function PhysicalEditor({ review, active, failed, refreshing, reload }: { review: PhysicalReview; active: boolean; failed: boolean; refreshing: boolean; reload: () => Promise<PhysicalReview | undefined> }) {
  const client = useQueryClient();
  const userId = usePhysicalIdentity();
  const prefix = useId();
  const storageKey = `scm-physical-draft:${userId}:${review.groupId}`;
  const [draft, setDraft] = useState(() => readDraft(storageKey, review));
  const [selectedSource, setSelectedSource] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [budget, setBudget] = useState(100);
  const [retryBudget, setRetryBudget] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [preview, setPreview] = useState<{ previewId: string; sha256: string; boxCount: number; write: Omit<PhysicalWrite, 'operationId'> } | null>(null);
  const action = usePhysicalAction(review.groupId);
  const runId = review.runs.find((run) => run.status === 'queued' || run.status === 'running')?.id ?? (selectedRunId || review.runs[0]?.id);
  const sync = useQuery({ queryKey: ['physical-review', review.groupId, 'sync', runId], queryFn: () => physicalApi.sync(review.groupId, runId!), enabled: active && Boolean(runId), retry: false,
    refetchInterval: (query) => active && (query.state.data?.run.status === 'queued' || query.state.data?.run.status === 'running') ? 1500 : false });
  const history = useQuery({ queryKey: ['physical-history', review.groupId], queryFn: () => physicalApi.history(review.groupId), enabled: active && historyOpen, retry: false });
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* The current tab still keeps the draft in memory. */ } }, [draft, storageKey]);
  const currentDraft = fromReview(review);
  const stale = draft.baseVersion !== review.version || draft.m2ConfirmationId !== review.m2ConfirmationId || draft.sourceFingerprint !== (review.source?.fingerprint ?? null);
  const dirty = stale || JSON.stringify(draft.entries) !== JSON.stringify(currentDraft.entries);
  const running = review.runs.some((run) => run.status === 'queued' || run.status === 'running') || sync.data?.run.status === 'queued' || sync.data?.run.status === 'running';
  const submittingSync = action.pendingKey?.startsWith('["sync",') || action.pendingKey?.startsWith('["retry",');
  const progressRun = sync.data?.run ?? review.runs.find((run) => run.id === runId);
  const syncSuccessful = sync.data?.items.filter((item) => item.status === 'completed').length ?? 0;
  const syncFailed = sync.data?.items.filter((item) => item.status === 'failed').length ?? 0;
  const acceptSync = (value: Awaited<ReturnType<typeof physicalApi.sync>>) => {
    client.setQueryData(['physical-review', review.groupId, 'sync', value.run.id], value);
    client.setQueryData<PhysicalReview>(['physical-review', review.groupId], (previous) => previous ? { ...previous, runs: [value.run, ...previous.runs.filter((run) => run.id !== value.run.id)] } : previous);
    setSelectedRunId(value.run.id);
    return value;
  };
  const locked = review.readOnly || failed || !review.m2ConfirmationId;
  const write = { m2ConfirmationId: draft.m2ConfirmationId!, expectedVersion: draft.baseVersion, sourceFingerprint: draft.sourceFingerprint };
  const saveKey = JSON.stringify(['save', { ...write, entries: draft.entries }]);
  const recoveringSave = action.hasOperation(saveKey);
  const sourceWrite = { m2ConfirmationId: review.m2ConfirmationId!, expectedVersion: review.version, sourceFingerprint: review.source?.fingerprint ?? null };
  const checkedCount = draft.entries.filter((entry) => entry.status !== 'pending').length;
  const invalidMeasurement = draft.entries.some((entry) => fields.some((field) => Boolean(entry.measured[field]?.trim()) && measuredValue(entry.measured[field]) === null));
  const incompleteDifference = draft.entries.some((entry) => {
    if (entry.status !== 'different') return false;
    const box = review.source?.boxes.find((item) => entryKey(item) === entryKey(entry));
    return !entry.reason.trim() || !fields.some((field) => Boolean(entry.measured[field]?.trim()) && measuredValue(entry.measured[field]) !== null && measuredValue(entry.measured[field]) !== box?.values[field]);
  });
  const reset = (next = review) => { const saved = fromReview(next); setDraft(saved); setPreview(null); try { sessionStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* The mounted editor keeps the saved revision. */ } };
  const reloadSaved = async () => { const next = await reload(); if (next) reset(next); };
  const update = (key: string, change: Partial<PhysicalEntry>) => setDraft((previous) => ({ ...previous, entries: previous.entries.map((entry) => entryKey(entry) === key ? { ...entry, ...change } : entry) }));
  const save = async () => {
    const payload = { ...write, entries: draft.entries };
    await action.run(JSON.stringify(['save', payload]), async (operationId) => { const result = await physicalApi.save(review.groupId, { ...payload, operationId }); await reloadSaved(); return result; }, '逐箱核对草稿已保存。');
  };
  return <>
    <BatchPanel title="实物箱确认" help="逐箱核对领星登记毛重、箱规和 Reference ID。实测差异单独留痕，明细采用领星值。" action={<IconButton type="button" icon={RefreshCw} label="刷新实物核对" loading={refreshing} disabled={action.busy} onClick={() => void reload()} />}>
      <div className="physical-status" role="status"><strong>{review.valid ? '当前实物版本已确认' : review.confirmation ? '原实物确认已过期' : '尚未完成实物确认'}</strong><span>M3 v{review.version} · 已核对 {checkedCount} / {draft.entries.length} 箱</span></div>
      {submittingSync ? <LingxingProgress key={`submitting-${action.pendingKey}`} label="实物货件处理进度" status="queued" detail={action.pendingKey?.startsWith('["retry",') ? '正在提交实物采集重试，等待任务受理。' : '正在提交实物来源采集，等待任务受理。'} />
        : progressRun && <LingxingProgress label="实物货件处理进度" status={progressRun.status} processed={sync.data ? syncSuccessful + syncFailed : undefined} total={sync.data?.items.length} startedAt={progressRun.createdAt} detail={`${runLabels[progressRun.status]}${sync.data ? ` · 成功 ${syncSuccessful} 票 · 失败 ${syncFailed} 票` : ' · 正在读取逐票进度'}${sync.isError ? ' · 进度读取失败，显示最近状态' : ''}${progressRun.errorMessage ? ` · ${progressRun.errorMessage}` : ''}`} />}
      {sync.isError && <QueryError error={sync.error} retry={() => void sync.refetch()} />}
      {!review.m2ConfirmationId && <p className="permission-note warning-note">请先完成制表数据确认及箱编码，再进行实物核对。</p>}
      {review.readOnly && <p className="permission-note">此批次已被替代，实物记录仅供查看。请进入当前更正批次操作。</p>}
      {review.pendingChange && <p className="permission-note warning-note" role="alert">新来源存在实质变化。请核对来源并明确采用，之后整组重新核对；此前记录保留。</p>}
      {review.blocked.length > 0 && <ul className="import-issues">{review.blocked.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity === 'error' ? 'error-note' : 'warning-note'}><strong>{issue.code}</strong>：{issue.message}</li>)}</ul>}
      {stale && <p className="permission-note warning-note" role="alert">当前草稿基于 M3 v{draft.baseVersion}，后台版本或来源已变化。输入已保留，请核对后重新载入。<Button type="button" icon={RotateCcw} disabled={action.busy} onClick={() => reset()}>重新载入实物核对</Button></p>}
      <fieldset className="batch-process-fieldset" disabled={locked || action.busy}>
        <details className="batch-details physical-source" open={!review.source}>
          <summary>领星来源 · {review.source ? `${review.source.origin === 'history' ? '历史快照' : '显式采集'} · ${timestamp(review.source.createdAt)}` : '待采用'}</summary>
          <p className="mapping-help">打开页面只读取已有证据。仅点击下方同步按钮才请求领星；重量、尺寸和 Reference 缺失时请回领星补齐后同步。</p>
          <div className="batch-form"><div className="field physical-source-select"><label htmlFor={`${prefix}-source`}>可用来源</label><Combobox id={`${prefix}-source`} value={selectedSource} onValueChange={setSelectedSource} disabled={locked || action.busy} placeholder="选择并核对来源" searchPlaceholder="搜索来源时间或类型" options={[{ value: '', label: '选择并核对来源' }, ...review.availableSources.map((source) => ({ value: source.id, label: `${source.origin === 'history' ? '历史快照' : '显式采集'} · ${timestamp(source.createdAt)} · ${source.boxes.length} 箱${source.id === review.source?.id ? ' · 当前采用' : ''}${!source.identityValid ? ' · 身份不匹配' : ''}` }))]} /></div><Button type="button" disabled={!selectedSource || dirty || running || !review.availableSources.find((source) => source.id === selectedSource)?.identityValid} onClick={async () => { const payload = { ...sourceWrite, sourceId: selectedSource }; await action.run(JSON.stringify(['source', payload]), async (operationId) => { const result = await physicalApi.adopt(review.groupId, { ...payload, operationId }); await reloadSaved(); return result; }, '来源已采用，请完成整组核对。'); }}>采用指定来源</Button></div>
          {dirty && <p className="mapping-help">采用其他来源前，请先保存当前草稿或重新载入。</p>}
          {selectedSource && <ul className="import-issues">{review.availableSources.find((source) => source.id === selectedSource)?.issues.map((issue, index) => <li className="warning-note" key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>}
          <form className="physical-sync-form" onSubmit={(event) => { event.preventDefault(); const payload = { ...sourceWrite, startDate, endDate, requestBudget: budget, maxPages: 10 }; void action.run(JSON.stringify(['sync', payload]), async (operationId) => acceptSync(await physicalApi.startSync(review.groupId, { ...payload, operationId })), '实物来源采集已受理，完成后请核对并采用。'); }}>
            <DateRangePicker id={`${prefix}-dates`} startId={`${prefix}-start`} endId={`${prefix}-end`} startLabel="实物采集日期起" endLabel="实物采集日期止（不含）" required endExclusive startValue={startDate} endValue={endDate} disabled={locked || action.busy} onValueChange={({ start, end }) => { setStartDate(start); setEndDate(end); }} />
            <div className="field"><label htmlFor={`${prefix}-budget`}>实物采集请求上限</label><Input id={`${prefix}-budget`} type="number" min={1} max={1000} required value={budget} onChange={(event) => setBudget(Number(event.target.value))} /></div>
            <Button type="submit" icon={RefreshCw} loading={action.pendingKey?.startsWith('["sync",')} disabled={running || !startDate || !endDate || startDate >= endDate || !Number.isInteger(budget) || budget < 1 || budget > 1000}>同步实物来源</Button>
          </form>
          {review.runs.length > 0 && <BatchTable label="实物来源采集任务" headers={['创建时间', '状态 / 请求预算', '结果 / 重试']}>{review.runs.map((run) => <tr key={run.id}><td>{timestamp(run.createdAt)}</td><td>{runLabels[run.status]}<small className="mapping-subtext">{run.requestsUsed} / {run.requestBudget} 次 · 缓存 {run.cacheHits}</small></td><td>{run.errorMessage && <p className="error-note">{run.errorMessage}</p>}{(run.status === 'failed' || run.status === 'partial') && <Button type="button" icon={RotateCcw} loading={action.pendingKey?.startsWith('["retry",')} disabled={running || !Number.isInteger(retryBudget) || retryBudget < 0 || retryBudget > 1000} onClick={() => void action.run(JSON.stringify(['retry', run.id, retryBudget]), async (operationId) => acceptSync(await physicalApi.retrySync(review.groupId, run.id, { operationId, additionalRequestBudget: retryBudget })), '失败货件重试已受理，已有成功数据保留。')}>重试实物采集失败货件</Button>}</td></tr>)}</BatchTable>}
          {review.runs.some((run) => run.status === 'failed' || run.status === 'partial') && <div className="field physical-budget"><label htmlFor={`${prefix}-retry-budget`}>明确追加请求预算（0 不增加）</label><Input id={`${prefix}-retry-budget`} type="number" min={0} max={1000} value={retryBudget} onChange={(event) => setRetryBudget(Number(event.target.value))} /></div>}
        </details>
      </fieldset>
      {review.source && <>
        <p className="mapping-help">采用值统一为 KG / CM，保留两位小数。选择“一致”仅记录核对事实；有差异时只填写发生差异的实测项和原因。</p>
        <fieldset className="batch-process-fieldset" disabled={locked || stale && !recoveringSave || action.busy || running}>
          <BatchTable label="实物箱逐箱核对" headers={['FBA / 箱编码', '箱序 / PO / 范围箱号', '领星原始登记', '采用毛重 / 箱规', '来源 / 箱内商品', '核对结果 / 实测差异']}>{review.source.boxes.map((box) => {
            const key = entryKey(box); const entry = draft.entries.find((item) => entryKey(item) === key);
            if (!entry) return null;
            return <tr key={key}><td><strong>{box.fba}</strong><small className="mapping-subtext">{box.code || '缺少箱编码'}</small><small className="mapping-subtext">{box.boxId}</small></td><td>第 {box.order} 箱<small className="mapping-subtext">PO {box.po || '缺失'}</small><small className="mapping-subtext">{box.range}</small></td><td>{box.raw.weight ?? '缺失'} {box.raw.weightUnit || '单位缺失'}<small className="mapping-subtext">{box.raw.length ?? '缺失'} × {box.raw.width ?? '缺失'} × {box.raw.height ?? '缺失'} {box.raw.dimensionUnit || '单位缺失'}</small></td><td>{box.values.weight ?? '缺失'} KG<small className="mapping-subtext">{box.values.length ?? '缺失'} × {box.values.width ?? '缺失'} × {box.values.height ?? '缺失'} CM</small></td><td>{timestamp(box.sourceObservedAt)}<details><summary>箱内商品（{box.items.length} 项）</summary>{box.items.map((item, index) => <p className="mapping-subtext" key={index}>{item.msku || '无 MSKU'} / {item.fnsku || '无 FNSKU'} / {item.sku || '无 SKU'} · {item.quantity ?? '数量缺失'}</p>)}</details></td><td className="physical-result-cell"><label className="sr-only" htmlFor={`${prefix}-${box.boxId}-status`}>{box.code || box.fba} 核对结果</label><SelectField id={`${prefix}-${box.boxId}-status`} value={entry.status} disabled={locked || stale && !recoveringSave || action.busy || running} onValueChange={(value) => update(key, { status: value as PhysicalEntry['status'], measured: value === 'different' ? entry.measured : {}, reason: value === 'different' ? entry.reason : '' })} options={[{ value: 'pending', label: '待核对' }, { value: 'consistent', label: '一致' }, { value: 'different', label: '有差异' }]} />{entry.status === 'different' && <div className="physical-measured">{fields.map((field) => <div className="field" key={field}><label htmlFor={`${prefix}-${box.boxId}-${field}`}>实测{fieldLabels[field]}</label><Input id={`${prefix}-${box.boxId}-${field}`} inputMode="decimal" value={entry.measured[field] ?? ''} onChange={(event) => update(key, { measured: { ...entry.measured, [field]: event.target.value } })} /></div>)}<div className="field physical-reason"><label htmlFor={`${prefix}-${box.boxId}-reason`}>差异原因</label><Input id={`${prefix}-${box.boxId}-reason`} maxLength={1000} value={entry.reason} onChange={(event) => update(key, { reason: event.target.value })} /></div></div>}</td></tr>;
          })}</BatchTable>
          {invalidMeasurement && <p className="form-note error-note">已填写的实测项须为有效正数，四舍五入到两位小数后须大于零；未测量项请留空。</p>}
          {incompleteDifference && !invalidMeasurement && <p className="mapping-help">未完成的差异可先保存草稿。最终确认时，每个“有差异”的箱须有至少一项与采用值不同的两位小数实测值及原因。</p>}
          <div className="physical-actions"><Button type="button" icon={Save} variant="primary" loading={action.pendingKey?.startsWith('["save",')} disabled={!dirty || invalidMeasurement} onClick={() => void save()}>保存实物核对草稿</Button><Button type="button" icon={CheckCheck} disabled={dirty || !review.canConfirm || invalidMeasurement || review.pendingChange} onClick={async () => { await action.run(JSON.stringify(['confirm', write]), async (operationId) => { const result = await physicalApi.confirm(review.groupId, { ...write, operationId }); await reloadSaved(); return result; }, '整组实物箱已确认，可生成实物箱明细。'); }}>确认整组实物箱</Button><span className="mapping-help" role="status">{dirty ? '当前标签页有未保存输入' : '已保存内容可在其他电脑恢复'}</span></div>
        </fieldset>
        <details className="batch-details physical-intake"><summary>批量核对 · 模板与导入</summary><p className="mapping-help">模板只接收核对结果、实测值和原因。所有行预检通过后整批提交，不覆盖领星数据。</p>
          <fieldset className="batch-process-fieldset" disabled={locked || stale || action.busy || dirty || running}>
            <Button type="button" icon={Download} onClick={() => void action.run('template', () => downloadBlob(physicalApi.template(review.groupId), '实物箱核对模板.xlsx'), '模板下载已开始。')}>下载实物核对模板</Button>
            <div className="batch-form"><div className="field"><label htmlFor={`${prefix}-upload`}>实物核对 XLSX</label><Input id={`${prefix}-upload`} type="file" accept=".xlsx" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setUploadError(''); }} /></div><Button type="button" icon={Upload} disabled={!file} onClick={async () => { if (!file || !file.name.toLowerCase().endsWith('.xlsx') || file.size === 0 || file.size > 10 * 1024 * 1024) { setUploadError('请选择有内容且不超过 10MB 的 XLSX 文件。'); return; } setUploadError(''); const result = await action.run(JSON.stringify(['preview', write, file.name, file.size, file.lastModified]), (operationId) => physicalApi.preview(review.groupId, file, { ...write, operationId }), '批量核对预检通过，请核对后提交。'); if (result) setPreview({ ...result, write }); }}>预检实物核对文件</Button></div>
            {uploadError && <p className="form-note error-note" role="alert">{uploadError}</p>}
            {preview && <div className="physical-actions"><p className="mapping-help">预检通过：{preview.boxCount} 箱，提交时再次核验文件、箱身份与版本。</p><Button type="button" variant="primary" disabled={!file} onClick={async () => { if (!file) return; const payload = { ...preview.write, previewId: preview.previewId, sha256: preview.sha256 }; await action.run(JSON.stringify(['intake', payload]), async (operationId) => { const result = await physicalApi.intake(review.groupId, file, { ...preview.write, operationId }, preview); await reloadSaved(); return result; }, '批量核对草稿已保存，请确认整组实物箱。'); }}>提交整批实物核对</Button></div>}
          </fieldset>
        </details>
      </>}
      {action.feedback}
    </BatchPanel>
    <details className="batch-details physical-history" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}><summary><History size={16} aria-hidden="true" /> 实物来源、修订与确认历史</summary>
      {history.isPending && historyOpen && <p className="list-state">正在读取实物历史…</p>}{history.isError && <QueryError error={history.error} retry={() => void history.refetch()} />}
      {history.data && <><BatchTable label="实物来源历史" headers={['时间 / 来源', '箱数 / 来源指纹', '采集人']}>{history.data.sources.map((source) => <tr key={source.id}><td>{timestamp(source.createdAt)}<small className="mapping-subtext">{source.origin === 'history' ? '历史快照' : '显式采集'}</small></td><td>{source.boxes.length} 箱<small className="mapping-subtext">{source.fingerprint}</small></td><td>{source.createdBy}</td></tr>)}</BatchTable><BatchTable label="实物核对修订历史" headers={['版本 / 动作', '时间 / 操作人', '核对箱数']}>{history.data.revisions.map((revision) => <tr key={revision.id}><td>M3 v{revision.version} · {revision.action}</td><td>{timestamp(revision.createdAt)}<small className="mapping-subtext">{revision.createdBy}</small></td><td>{revision.entries.filter((entry) => entry.status !== 'pending').length} / {revision.entries.length}</td></tr>)}</BatchTable><BatchTable label="实物整组确认历史" headers={['确认 ID / 版本', '时间 / 确认人', '关联 M2 确认']}>{history.data.confirmations.map((confirmation) => <tr key={confirmation.id}><td>{confirmation.id}<small className="mapping-subtext">M3 v{confirmation.m3Version}{review.valid && review.confirmation?.id === confirmation.id ? ' · 当前有效' : ' · 历史记录'}</small></td><td>{timestamp(confirmation.createdAt)}<small className="mapping-subtext">{confirmation.createdBy}</small></td><td>{confirmation.m2ConfirmationId}</td></tr>)}</BatchTable></>}
    </details>
  </>;
}
