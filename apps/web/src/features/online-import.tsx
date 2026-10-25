import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import {
  fbaLookupInputSchema, onlineImportInputSchema, type FbaLookupCandidate,
  type FbaLookupInput, type FbaLookupRecord, type ImportAccepted, type OnlineImportInput, type ImportDraftContent, type TransportMethod,
} from '@scm/contracts';
import { api, ApiError } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';
import { DateRangePicker } from '../components/ui/date-range-picker';
import { shanghaiToday } from '../components/ui/date-utils';
import { newOperation } from './batch-shared';
import { LingxingProgress } from './lingxing-progress';
import {
  candidateValue, clearAutofilled, conflictsWith, currentLookupRecord, emptyOnlineRow, hasOnlineContent, lookupFields,
  mergeLookupRecord, needsLookupReview, normalFba, onlineColumns, parsePastedCells, refreshLookupEvidence, splitLookupFbas,
  trimOnlineRows, onlineTicketPreview, isOnlineChannelSelectable, onlineChannelOptions, type AutofilledValues, type OnlineCellKey, type OnlineDraftRow as DraftRow,
} from './online-import-grid';

const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const newRow = (): DraftRow => ({ id: newOperation(), value: emptyOnlineRow() });
const waitForLookup = () => new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
type LookupBatch = { input: FbaLookupInput; record?: FbaLookupRecord };
type OnlineDraft = NonNullable<ImportDraftContent['online']>;
export function OnlineImport({ accepted, active, initialDraft, onDraftChange, onBusyChange, deferLookup = false }: { accepted: (result: ImportAccepted) => void; active: boolean; initialDraft?: OnlineDraft; onDraftChange?: (value: OnlineDraft) => void; onBusyChange?: (busy: boolean) => void; deferLookup?: boolean }) {
  const client = useQueryClient();
  const [rows, setRows] = useState<DraftRow[]>(() => initialDraft?.rows.length ? initialDraft.rows.map((value, index) => ({ id: newOperation(), value, lookupId: value.lookupId, autofilled: initialDraft.autofilled?.[index] })) : Array.from({ length: 20 }, newRow));
  const [showSupplement, setShowSupplement] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [operation, setOperation] = useState(() => initialDraft?.operationId ?? newOperation());
  const [startDate, setStartDate] = useState(() => initialDraft?.startDate ?? shanghaiToday(-89));
  const [endDate, setEndDate] = useState(() => initialDraft?.endDate ?? shanghaiToday());
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'lookup' | 'submit'>('lookup');
  const [lookupRecord, setLookupRecord] = useState<FbaLookupRecord | null>(null);
  const [batchLabel, setBatchLabel] = useState('');
  const [lookupError, setLookupError] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(() => initialDraft?.pendingSubmission ? new Error('上次提交的接收结果尚未确认，请原样重试。') : null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [useCurrent, setUseCurrent] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);
  const batches = useRef<{ key: string; values: LookupBatch[] } | null>(null);
  const completed = useRef(new Map<string, FbaLookupRecord>());
  // A lost response may follow a successful save. Retry the original payload with the original id.
  const submittedPayload = useRef<OnlineImportInput | null>(initialDraft?.pendingSubmission ?? null);
  const settings = useQuery({ queryKey: ['seller-catalog-settings'], queryFn: api.sellerCatalogSettings, retry: false, enabled: active });
  const transportMethods = useQuery({ queryKey: ['lingxing-transport-methods'], queryFn: api.transportMethods, retry: false, staleTime: 5 * 60_000,
    enabled: active && (!deferLookup || showSupplement || rows.some((row) => Boolean(row.value.channel))) });
  const locked = busy || submittedPayload.current !== null;
  const canChangeRejectedSubmission = submitError instanceof ApiError && submitError.status >= 400 && submitError.status < 500 && submitError.status !== 408;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const included = trimOnlineRows(rows); onDraftChange?.({ rows: included.map((row) => row.value), autofilled: included.map((row) => row.autofilled ?? {}), startDate, endDate, operationId: operation, ...(submittedPayload.current ? { pendingSubmission: submittedPayload.current } : {}) }); }, [rows, startDate, endDate, operation, busy, stage, submitError, onDraftChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { if (settings.error instanceof ApiError && settings.error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); }, [settings.error, client]);
  const resetSubmission = () => { setOperation(newOperation()); setError(null); setSubmitError(null); setUseCurrent(false); };
  const edit = (id: string, key: OnlineCellKey, text: string) => {
    if (locked || running.current) return;
    resetSubmission();
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      const value = { ...row.value, [key]: text };
      if (key === 'fba' && normalFba(text) !== normalFba(row.value.fba)) {
        clearAutofilled(value, row.autofilled); delete value.lookupId; delete value.lookupSid;
        return { ...row, value, lookup: undefined, lookupId: undefined, autofilled: undefined };
      }
      const autofilled = { ...row.autofilled };
      if (lookupFields.some((field) => field === key)) { delete value.lookupId; delete value.lookupSid; delete autofilled[key as typeof lookupFields[number]]; }
      return refreshLookupEvidence({ ...row, value, autofilled });
    }));
  };
  const paste = (event: ClipboardEvent<HTMLElement>, rowIndex: number, columnIndex: number) => {
    if (locked || running.current) return;
    const text = event.clipboardData.getData('text/plain');
    if (!/[\t\r\n]/.test(text)) return;
    event.preventDefault();
    const pasted = parsePastedCells(text);
    if (pasted.length + rowIndex > 1000 || pasted.some((cells) => cells.length + columnIndex > onlineColumns.length || cells.some((cell) => cell.length > 2000))) {
      setError(`粘贴范围超出表格：最多 1000 行、${onlineColumns.length} 列，每个单元格最多 2000 字。请从对应列开始粘贴。`); return;
    }
    resetSubmission();
    setRows((current) => {
      const next: DraftRow[] = current.map((row) => ({ ...row, value: { ...row.value }, autofilled: { ...row.autofilled } }));
      while (next.length < rowIndex + pasted.length) next.push(newRow());
      pasted.forEach((cells, index) => {
        const row = next[rowIndex + index]!;
        if (columnIndex === 0 && normalFba(cells[0] ?? '') !== normalFba(row.value.fba)) {
          clearAutofilled(row.value, row.autofilled); delete row.value.lookupId; delete row.value.lookupSid;
          row.lookup = undefined; row.lookupId = undefined; row.autofilled = {};
        }
        cells.forEach((cell, column) => {
          const key = onlineColumns[columnIndex + column]!.key;
          row.value[key] = cell;
          if (lookupFields.some((field) => field === key)) { delete row.autofilled?.[key as typeof lookupFields[number]]; delete row.value.lookupId; delete row.value.lookupSid; }
        });
      });
      return next.map(refreshLookupEvidence);
    });
    setNotice(`已粘贴 ${pasted.length} 行。请核对列对应关系。`);
  };
  const applyCandidate = (id: string, candidate: FbaLookupCandidate, channel?: string) => {
    if (locked || running.current) return;
    resetSubmission();
    setRows((current) => current.map((row) => {
      if (row.id !== id || !row.lookupId || !row.lookup?.candidates.some((entry) => entry.sid === candidate.sid)) return row;
      const value = { ...row.value, lookupId: row.lookupId, lookupSid: candidate.sid };
      clearAutofilled(value, row.autofilled);
      const autofilled: AutofilledValues = {};
      for (const key of lookupFields) if (candidateValue(candidate, key)) {
        value[key] = candidateValue(candidate, key);
        if (row.value[key] !== value[key] || row.autofilled?.[key] !== undefined) autofilled[key] = value[key];
      }
      if (channel && candidate.channelOptions.some((option) => option.name === channel)) { value.channel = channel; autofilled.channel = channel; }
      return { ...row, value, autofilled };
    }));
  };
  const updateRows = (value: DraftRow[]) => { if (mounted.current) setRows(value); };
  const runPipeline = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); onBusyChange?.(true); setError(null); setSubmitError(null); setLookupError(false);
    let submitting = false;
    try {
      let payload = submittedPayload.current;
      if (!payload) {
        let current = rows;
        if (current.some((row) => Boolean(row.value.channel.trim()))) {
          if (!transportMethods.data) throw new Error('请先读取领星运输方式列表，再核对业务渠道；也可清空渠道，按 FBA 自动补全。');
          const invalidIndex = current.findIndex((row) => !isOnlineChannelSelectable(row.value.channel, transportMethods.data.items));
          if (invalidIndex >= 0) {
            if (deferLookup) setShowSupplement(true);
            throw new Error(`第 ${invalidIndex + 1} 行业务渠道“${current[invalidIndex]!.value.channel}”未启用或不在领星列表中，请重新选择，或留空自动补全。`);
          }
        }
        const input = onlineImportInputSchema.safeParse({ operationId: operation, rows: trimOnlineRows(current).map((row) => ({ ...row.value, fba: normalFba(row.value.fba) })) });
        if (!input.success) { setError(current.some((row) => hasOnlineContent(row.value)) ? '表格内容未通过校验，请检查单元格长度与行数。' : '请至少填写一行需求。'); return; }
        if (!useCurrent && !deferLookup) {
          setStage('lookup');
          if (!settings.data) throw new Error('请先读取店铺来源设置，再补全货件；也可选择按当前填写继续。');
          const scope = { ...settings.data, startDate, endDate };
          const validation = fbaLookupInputSchema.safeParse({ operationId: operation, fbas: ['FBA0'], startDate, endDate, expectedCatalogSettingsVersion: settings.data.version, expectedCatalogVersion: settings.data.catalogVersion });
          if (!validation.success) throw new Error(startDate > endDate ? '查询开始日期不能晚于结束日期，请调整货件创建日期范围。' : '请填写有效的查询开始和结束日期。');
          // Drafts retain verified row credentials. Restore their result before planning new batches.
          for (const id of new Set(current.flatMap((row) => row.value.lookupId && !completed.current.has(row.value.lookupId) ? [row.value.lookupId] : []))) {
            let restored: FbaLookupRecord;
            try { restored = await api.fbaLookup(id); }
            catch (failure) { if (failure instanceof ApiError && failure.status === 404) continue; throw failure; }
            if (!mounted.current) return;
            if (currentLookupRecord(restored, scope)) completed.current.set(restored.id, restored);
          }
          for (const [id, record] of completed.current) if (!currentLookupRecord(record, scope)) completed.current.delete(id);
          current = current.map((row) => {
            const id = row.lookupId ?? row.value.lookupId;
            if (!id || completed.current.has(id)) return row;
            const value = { ...row.value }; clearAutofilled(value, row.autofilled); delete value.lookupId; delete value.lookupSid;
            return { ...row, value, lookup: undefined, lookupId: undefined, autofilled: undefined };
          });
          for (const record of completed.current.values()) current = mergeLookupRecord(current, record);
          current = current.map(refreshLookupEvidence); updateRows(current);
          const known = new Set(current.filter((row) => row.lookup).map((row) => normalFba(row.value.fba)));
          const chunks = splitLookupFbas(current, known);
          // Keep the whole scope in the key: finishing one batch must not change a later batch's id.
          const key = JSON.stringify([splitLookupFbas(current), startDate, endDate, settings.data.version, settings.data.catalogVersion]);
          if (!batches.current || batches.current.key !== key) {
            const values = chunks.map((fbas) => ({ ...validation.data, operationId: newOperation(), fbas }));
            batches.current = { key, values: values.map((value) => ({ input: value })) };
          }
          const plan = batches.current.values;
          for (let index = 0; index < plan.length; index += 1) {
            const batch = plan[index]!;
            setBatchLabel(`第 ${index + 1} / ${plan.length} 批`);
            // Terminal failed tasks need a new operation. Unknown POST/read outcomes reuse the original id.
            if (batch.record?.status === 'failed') { batch.input = { ...batch.input, operationId: newOperation() }; batch.record = undefined; }
            if (!batch.record) { setLookupRecord(null); batch.record = await api.lookupFbas(batch.input); }
            if (!mounted.current) return;
            setLookupRecord(batch.record);
            while (batch.record.status === 'queued' || batch.record.status === 'running') {
              const record = await api.fbaLookup(batch.record.id);
              if (!mounted.current) return;
              batch.record = record; setLookupRecord(record);
              client.setQueryData(['fba-lookup', record.id], record);
              if (record.status === 'queued' || record.status === 'running') await waitForLookup();
              if (!mounted.current) return;
            }
            if (batch.record.status === 'failed') throw new Error(batch.record.errorMessage || 'FBA 查询失败，已填内容保留，请重试或按当前填写继续。');
            completed.current.set(batch.record.id, batch.record);
            current = mergeLookupRecord(current, batch.record).map(refreshLookupEvidence); updateRows(current);
          }
          if (current.some(needsLookupReview)) { setReviewRequired(true); setNotice('补全已完成。请处理未找到、多候选、渠道缺失或人工字段差异；也可确认按当前填写继续。'); return; }
        }
        if (useCurrent) current = current.map((row) => {
          if (!row.value.lookupId || row.lookup && completed.current.has(row.value.lookupId)) return row;
          const value = { ...row.value }; delete value.lookupId; delete value.lookupSid; return { ...row, value };
        });
        payload = onlineImportInputSchema.parse({ operationId: operation, rows: trimOnlineRows(current).map((row) => ({ ...row.value, fba: normalFba(row.value.fba) })) });
        updateRows(current.map((row) => ({ ...row, value: { ...row.value, fba: normalFba(row.value.fba) } })));
        submittedPayload.current = payload;
      }
      submitting = true; setStage('submit');
      const result = await api.createOnlineImport(payload);
      if (!mounted.current) return;
      submittedPayload.current = null; completed.current.clear(); batches.current = null;
      setRows(Array.from({ length: 20 }, newRow)); setOperation(newOperation()); setLookupRecord(null); setReviewRequired(false); setUseCurrent(false); setNotice('');
      accepted(result);
    } catch (failure) {
      if (!mounted.current) return;
      setError(messageOf(failure));
      if (submitting) setSubmitError(failure); else { setLookupError(true); setReviewRequired(true); }
      if (failure instanceof ApiError && failure.status === 401) void client.invalidateQueries({ queryKey: ['session'] });
    } finally { running.current = false; if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
  };
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void runPipeline(); };
  const changeDates = ({ start, end }: { start: string; end: string }) => {
    if (locked || running.current) return;
    resetSubmission(); setStartDate(start); setEndDate(end); batches.current = null; completed.current.clear(); setLookupRecord(null); setLookupError(false); setReviewRequired(false);
    setRows((current) => current.map((row) => { const value = { ...row.value }; delete value.lookupId; delete value.lookupSid; return { ...row, value, lookup: undefined, lookupId: undefined }; }));
  };
  return <form className="online-import" onSubmit={onSubmit}>
    <p className="mapping-help">粘贴本次发货的 FBA 清单，每票之间留一行空白。连续空行只分隔一次，首尾空行忽略。{deferLookup ? '只填 FBA 即可，提交后后台自动补全和整理。' : '补全后自动解析，再核对源行与差异。'}</p>
    {(!deferLookup || showSupplement) && <div className="mapping-help" aria-live="polite">
      {transportMethods.isPending ? '正在读取领星运输方式…' : transportMethods.isError ? <><span className="error-note">运输方式读取失败：{messageOf(transportMethods.error)}。已保留填写内容。</span> <Button type="button" variant="text" icon={RefreshCw} disabled={locked || transportMethods.isFetching} onClick={() => void transportMethods.refetch()}>重试读取运输方式</Button></> : <>
        业务渠道从领星运输方式中选择；停用项不可新选，留空可按 FBA 自动补全。{transportMethods.data?.items.every((method) => !method.enabled) && '领星当前没有已启用的运输方式。'}
      </>}
    </div>}
    <div className="online-lookup-panel" hidden={deferLookup}>
      <DateRangePicker id="fba-query-dates" startId="fba-query-start" endId="fba-query-end" startLabel="货件创建日期从" endLabel="至（包含当天）" startValue={startDate} endValue={endDate} disabled={locked} onValueChange={changeDates} />
      {(busy && stage === 'lookup' || lookupRecord || lookupError) && <LingxingProgress label="领星 FBA 信息补全" status={lookupError ? 'failed' : lookupRecord?.status ?? 'running'} startedAt={lookupRecord?.createdAt} detail={lookupError ? '查询未完成，已保留填写内容和已完成批次；可重试补全并解析，或按当前填写继续。' : `${batchLabel}${batchLabel ? ' · ' : ''}${lookupRecord?.status === 'completed' ? '查询已完成，请核对补全结果' : lookupRecord?.status === 'queued' ? '查询排队中' : '正在查询领星货件与渠道信息，请等待结果'}`} />}
      <p className="mapping-help">补全店铺、国家、目的 FC、仓库地址、货件创建时间和业务渠道，每批最多查询 100 个不同 FBA，自动依次处理。业务渠道采用领星发货单的唯一运输方式；其他字段只补空白。未找到、多候选或字段差异会暂停解析，保留手填内容供核对。来源填写时间选填，用于计算打包天数；业务日期由首次接收时间确定。</p>
      {settings.isPending && active && <p className="mapping-help" role="status">正在读取店铺来源…</p>}
      {settings.data?.mode === 'manual' && <p className="mapping-help">查询范围为当前人工目录中的可用店铺；也可按当前填写内容继续解析。</p>}
      {settings.isError && <div className="inline-error" role="alert"><p>{messageOf(settings.error)}</p><Button type="button" icon={RefreshCw} disabled={locked} loading={settings.isFetching} onClick={() => void settings.refetch()}>重试读取店铺来源</Button></div>}
    </div>
    <div className="online-grid-actions"><strong>{rows.filter((row) => hasOnlineContent(row.value)).length} 个 FBA · {onlineTicketPreview(rows).length} 票</strong>{deferLookup && <Button type="button" aria-pressed={showSupplement} disabled={locked} onClick={() => setShowSupplement((value) => !value)}>{showSupplement ? '收起补充资料' : '显示补充资料'}</Button>}<Button type="button" icon={Plus} disabled={locked || rows.length >= 1000} onClick={() => { resetSubmission(); setRows((current) => [...current, ...Array.from({ length: Math.min(20, 1000 - current.length) }, newRow)]); }}>增加 20 行</Button></div>
    {onlineTicketPreview(rows).length > 0 && <details className="shipping-ticket-preview"><summary>分票预览（按空行）</summary><ol>{onlineTicketPreview(rows).map((ticket) => <li key={ticket.index}>第 {ticket.index} 段：{ticket.count} 个 FBA，输入第 {ticket.firstRow}–{ticket.lastRow} 行</li>)}</ol></details>}
    <div className="table-scroll online-grid-scroll" role="region" aria-label="在线需求编辑表，可横向滚动" tabIndex={0}>
      <table className={`task-table online-grid${deferLookup && !showSupplement ? ' online-grid-fba-only' : ''}`}><thead><tr><th scope="col">行号</th>{onlineColumns.map((column) => <th scope="col" key={column.key} hidden={deferLookup && !showSupplement && column.key !== 'fba'}>{column.label}</th>)}<th scope="col">{deferLookup ? '补全 / 操作' : '查询核对 / 操作'}</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.id}>
          <th scope="row">{index + 1}</th>
          {onlineColumns.map((column, columnIndex) => <td key={column.key} hidden={deferLookup && !showSupplement && column.key !== 'fba'} onPaste={column.key === 'channel' ? (event) => paste(event, index, columnIndex) : undefined}>{column.key === 'channel' ? <OnlineChannelField rowId={row.id} rowIndex={index} value={row.value.channel} methods={transportMethods.data?.items} locked={locked} change={(value) => edit(row.id, 'channel', value)} /> : <Input aria-label={`第 ${index + 1} 行${column.label}`} value={row.value[column.key]} placeholder={column.placeholder} maxLength={2000} disabled={locked}
            aria-invalid={column.key === 'fba' && hasOnlineContent(row.value) && !/^FBA[A-Z0-9]+$/.test(normalFba(row.value.fba))}
            aria-describedby={column.key === 'fba' && hasOnlineContent(row.value) && !/^FBA[A-Z0-9]+$/.test(normalFba(row.value.fba)) ? `online-fba-error-${row.id}` : undefined}
            onChange={(event) => edit(row.id, column.key, event.target.value)} onPaste={(event) => paste(event, index, columnIndex)} />}{column.key === 'fba' && hasOnlineContent(row.value) && !/^FBA[A-Z0-9]+$/.test(normalFba(row.value.fba)) && <small id={`online-fba-error-${row.id}`} className="mapping-subtext error-note">{row.value.fba.trim() ? 'FBA 格式有误，请核对。' : '此行缺少 FBA。'}</small>}</td>)}
          <td>{deferLookup ? <span className="mapping-subtext">提交后自动补全</span> : <LookupReview row={row} apply={(candidate, channel) => applyCandidate(row.id, candidate, channel)} disabled={locked} />}<Button type="button" variant="text" icon={Trash2} disabled={locked} aria-label={`删除第 ${index + 1} 行`} onClick={() => { resetSubmission(); setRows((current) => current.length === 1 ? [newRow()] : current.filter((entry) => entry.id !== row.id)); }}>删除行</Button></td>
        </tr>)}</tbody>
      </table>
    </div>
    {notice && <p className="form-note success-note" role="status">{notice}</p>}
    {error && <p className="form-note error-note" role="alert">{error}</p>}
    {submitError !== null && <div className="form-note error-note"><p>已保留原表格内容与操作编号。再次点击“补全并解析”将直接重试原提交。</p>{canChangeRejectedSubmission ? <Button type="button" disabled={busy} onClick={() => {
      submittedPayload.current = null; resetSubmission(); completed.current.clear(); batches.current = null;
      setRows((current) => current.map((row) => { const value = { ...row.value }; delete value.lookupId; delete value.lookupSid; return { ...row, value, lookup: undefined, lookupId: undefined }; }));
      void settings.refetch();
    }}>修改填写内容</Button> : <p>接收结果尚未确认，重试成功前填写内容已锁定。</p>}</div>}
    {reviewRequired && <label className="import-check"><input type="checkbox" checked={useCurrent} disabled={locked} onChange={(event) => setUseCurrent(event.target.checked)} /><span>按当前填写继续<small className="mapping-subtext">保留未解决项供解析核对，有效需求仍可继续提交。</small></span></label>}
    <div className="online-submit"><p className="mapping-help">{deferLookup ? '接收后自动补全、分票编号并整理发货表；有异常时保留进度供处理。' : '补全完成后自动解析。核对源行后进入“核对与提交”。'}</p><Button variant="primary" type="submit" icon={Upload} loading={busy} loadingLabel={stage === 'lookup' && !deferLookup ? '正在补全 FBA 信息…' : '正在保存并自动解析…'} disabled={busy}>{deferLookup ? '导入并整理本次发货' : '补全并解析'}</Button></div>
  </form>;
}

function OnlineChannelField({ rowId, rowIndex, value, methods, locked, change }: { rowId: string; rowIndex: number; value: string; methods?: TransportMethod[]; locked: boolean; change: (value: string) => void }) {
  const invalid = Boolean(methods && !isOnlineChannelSelectable(value, methods));
  const errorId = `online-channel-error-${rowId}`;
  return <><SelectField id={`online-channel-${rowId}`} aria-label={`第 ${rowIndex + 1} 行业务渠道`} value={value}
    options={onlineChannelOptions(methods ?? [], value)} placeholder={methods ? '留空，按 FBA 自动补全' : '请先读取运输方式'}
    disabled={locked || !methods} onValueChange={change} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} />
    {invalid && <small id={errorId} className="mapping-subtext error-note">原值已保留，请选择已启用的运输方式，或留空自动补全。</small>}</>;
}

function LookupReview({ row, apply, disabled }: { row: DraftRow; apply: (candidate: FbaLookupCandidate, channel?: string) => void; disabled: boolean }) {
  if (!row.lookup) return <span className="mapping-subtext">可手工填写</span>;
  if (row.lookup.status === 'not_found') return <span className="mapping-subtext warning-note">此日期范围未找到，保留手填内容。</span>;
  return <div className="online-lookup-review"><strong>{row.lookup.status === 'ambiguous' ? '多个店铺匹配，请选择' : '已找到货件'}</strong>
    {row.lookup.candidates.map((candidate, index) => {
      const conflicts = conflictsWith(row.value, candidate);
      const adopted = row.value.lookupId === row.lookupId && row.value.lookupSid === candidate.sid && !conflicts.length;
      const channelSelected = candidate.channelStatus !== 'ambiguous' && candidate.channelStatus !== 'unavailable' || candidate.channelOptions?.some((option) => option.name === row.value.channel);
      return <details key={`${candidate.sid}-${index}`} open={conflicts.length > 0 || row.lookup?.status === 'ambiguous' || candidate.channelStatus === 'ambiguous'}><summary>{candidate.shop} · {candidate.country}{adopted ? channelSelected ? ' · 已采用' : ' · 货件信息已采用，渠道待确认' : ''}</summary>
        <p>sid {candidate.sid} · FC {candidate.destinationFc || '未返回'}</p><p>{candidate.destinationAddress || '未返回仓库地址'}</p><p>创建时间：{candidate.shipmentCreatedAt || '未返回'}</p>
        <p>业务渠道（运输方式）：{candidate.channel || (candidate.channelStatus === 'ambiguous' ? '多个运输方式，请选择或手工填写' : candidate.channelStatus === 'unavailable' ? '运输方式查询未完成，保留手填内容' : '未找到运输方式，保留手填内容')}</p>
        {candidate.channelOptions?.map((option) => <div key={option.name}><p>{option.name}{option.shipmentNumbers.length ? ` · 发货单 ${option.shipmentNumbers.join('、')}` : ''}</p>{candidate.channelStatus !== 'unique' && <Button type="button" icon={Check} disabled={disabled} onClick={() => apply(candidate, option.name)}>采用渠道：{option.name}</Button>}</div>)}
        {conflicts.length > 0 && <p className="warning-note">与已填{conflicts.map((key) => onlineColumns.find((column) => column.key === key)!.label).join('、')}不同，原值已保留。</p>}
        <Button type="button" icon={Check} disabled={disabled || adopted} onClick={() => apply(candidate)}>{adopted ? '已采用' : conflicts.length ? '采用此结果并替换差异' : '采用此查询结果'}</Button>
      </details>;
    })}
  </div>;
}
