import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, CircleAlert, CircleCheck, MapPin, Pencil, Plus, RefreshCw, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { documentAddressDataSchema, type DocumentProfile } from '@scm/contracts';
import { api, ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';
import { StatePage } from '../pages';
import { BatchPagination, BatchTable, messageOf, newOperation, QueryError, timestamp } from './batch-shared';
import { documentApi } from './document-api';
import { SettingsLayout } from './settings';
import './document-address-settings.css';

const addressFields = [
  { key: 'destinationFc', label: '目的仓代码', required: true, maxLength: 40 },
  { key: 'addressCode', label: '地址代码' },
  { key: 'countryCode', label: '国家代码', required: true, maxLength: 2 },
  { key: 'recipientName', label: '收件人', required: true },
  { key: 'recipientCompany', label: '收件公司' },
  { key: 'phone', label: '电话' },
  { key: 'addressLine1', label: '地址第 1 行', required: true },
  { key: 'addressLine2', label: '地址第 2 行' },
  { key: 'addressLine3', label: '地址第 3 行' },
  { key: 'city', label: '城市', required: true },
  { key: 'state', label: '州 / 省' },
  { key: 'postalCode', label: '邮编', required: true },
  { key: 'email', label: '邮箱' },
] as const;
type AddressDraft = { key?: string; data: Record<string, unknown>; reason?: string };
type EditorState = { profile: DocumentProfile | null; draft?: AddressDraft };
const text = (data: Record<string, unknown>, key: string) => typeof data[key] === 'string' || typeof data[key] === 'number' ? String(data[key]) : '';
const country = (profile: DocumentProfile) => text(profile.data, 'countryCode').trim().toUpperCase();
const pageSize = 20;
const draftStorageKey = (id: string) => `scm:address-draft:${id}`;

function readDraft(id: string): AddressDraft {
  const stored = sessionStorage.getItem(draftStorageKey(id));
  if (!stored) throw new Error('待保存地址已过期，请返回发票草稿重新发起，或点击“新增地址”。');
  const value: unknown = JSON.parse(stored);
  if (!value || typeof value !== 'object' || !('data' in value) || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new Error('无法读取待保存地址，请返回发票草稿重新发起。');
  const data: Record<string, string> = {};
  for (const field of addressFields) {
    const entry = (value.data as Record<string, unknown>)[field.key];
    if (typeof entry === 'string') data[field.key] = entry.slice(0, 4000);
  }
  return { data, key: 'key' in value && typeof value.key === 'string' ? value.key.slice(0, 200) : '', reason: 'reason' in value && typeof value.reason === 'string' ? value.reason.slice(0, 1000) : '从发票草稿新增收件地址' };
}

type AddressAction = { key: string; action: (operationId: string) => Promise<unknown>; success: string; done?: (result: unknown) => void };
function useAddressAction() {
  const client = useQueryClient();
  const operations = useRef(new Map<string, string>());
  const [notice, setNotice] = useState('');
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: (input: AddressAction) => {
      if (!operations.current.has(input.key)) operations.current.set(input.key, newOperation());
      return input.action(operations.current.get(input.key)!);
    },
    onSuccess: async (result, input) => {
      operations.current.delete(input.key);
      setNotice(input.success);
      input.done?.(result);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['document-addresses'] }),
        client.invalidateQueries({ queryKey: ['document-profiles'] }),
        client.invalidateQueries({ queryKey: ['document-asset-history'] }),
        client.invalidateQueries({ queryKey: ['document'] }),
      ]);
    },
    onError: (error) => { setNotice(''); if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); },
  });
  return {
    busy: mutation.isPending,
    run: (input: AddressAction) => { setNotice(''); mutation.mutate(input); },
    clear: () => { setNotice(''); mutation.reset(); },
    feedback: <>{mutation.isError && <p className="form-note error-note" role="alert"><CircleAlert size={16} aria-hidden="true" />{messageOf(mutation.error)}{mutation.error instanceof ApiError && mutation.error.status === 409 ? ' 请重新读取地址，核对最新版本后再保存。当前输入已保留。' : ' 当前输入已保留，可重试。'}</p>}{notice && <p className="form-note success-note" role="status"><CircleCheck size={16} aria-hidden="true" />{notice}</p>}</>,
  };
}

export function DocumentAddressesRoute() {
  const search = useSearch({ strict: false });
  const documentId = typeof search.documentId === 'string' ? search.documentId : undefined;
  const draftId = typeof search.draftId === 'string' ? search.draftId : undefined;
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开收件地址" detail={messageOf(session.error)} action={<Button icon={RefreshCw} onClick={() => void session.refetch()}>重试</Button>} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <SettingsLayout user={session.data.user}>{documentId && <p className="address-return-link mapping-help"><Link to="/shipping" search={{ view: 'documents', documentId }}>返回当前发票草稿</Link> · 保存后可在草稿中选择地址并重新核对。</p>}<AddressDirectory documentId={documentId} draftId={draftId} /></SettingsLayout>;
}

function AddressDirectory({ documentId, draftId }: { documentId?: string; draftId?: string }) {
  const id = useId();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [countryCode, setCountryCode] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draftError, setDraftError] = useState('');
  const handledDraft = useRef<string | null>(null);
  const action = useAddressAction();
  const addresses = useQuery({ queryKey: ['document-addresses'], queryFn: documentApi.addresses, retry: false });
  useEffect(() => {
    if (!draftId || handledDraft.current === draftId) return;
    handledDraft.current = draftId;
    try { setEditor({ profile: null, draft: readDraft(draftId) }); setSelectedId(null); setDraftError(''); }
    catch (error) { setDraftError(messageOf(error)); }
  }, [draftId]);
  const discardDraft = () => {
    if (draftId) {
      try { sessionStorage.removeItem(draftStorageKey(draftId)); } catch { /* The form remains usable when browser storage is unavailable. */ }
      void navigate({ to: '/settings/addresses', search: { documentId }, replace: true });
    }
  };
  const items = addresses.data ?? [];
  const countries = useMemo(() => [...new Set(items.map(country).filter(Boolean))].sort(), [items]);
  const visible = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((profile) => (status === 'all' || profile.status === status) && (!countryCode || country(profile) === countryCode) && terms.every((term) => [profile.key, ...addressFields.map((field) => text(profile.data, field.key))].join(' ').toLocaleLowerCase().includes(term)))
      .sort((left, right) => text(left.data, 'destinationFc').localeCompare(text(right.data, 'destinationFc'), 'zh-CN', { numeric: true }) || left.key.localeCompare(right.key, 'zh-CN'));
  }, [items, status, countryCode, search]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visible.length / pageSize)));
  const rows = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selected = selectedId ? items.find((profile) => profile.id === selectedId) : undefined;
  const open = (profile: DocumentProfile) => { action.clear(); setSelectedId(profile.id); setEditor(null); };
  const back = () => { setSelectedId(null); setEditor(null); action.clear(); };
  const startNew = () => { action.clear(); setDraftError(''); setSelectedId(null); setEditor({ profile: null }); };
  const save = (profile: DocumentProfile | null, input: { key: string; data: Record<string, unknown>; reason: string }) => {
    action.run({ key: `save:${profile?.id ?? 'new'}:${JSON.stringify(input)}`, action: (operationId) => profile
      ? documentApi.updateAddress(profile.id, { operationId, expectedVersion: profile.version, ...input })
      : documentApi.createAddress({ operationId, ...input }),
    success: profile ? '地址已更新，历史版本已保留。' : '地址已保存，可在发票草稿中选择。',
    done: (result) => { const saved = result as DocumentProfile; setEditor(null); setSelectedId(saved.id); discardDraft(); },
    });
  };
  const listHeading = <div className="address-page-heading"><div><h2>收件地址</h2><p className="mapping-help">统一维护收件地址与目的仓。修改保留历史版本，删除后可恢复。</p></div>{!editor && !selected && <Button type="button" icon={Plus} variant="primary" onClick={startNew}>新增地址</Button>}</div>;
  return <div className="address-workspace">{listHeading}
    {draftError && <p className="form-note error-note" role="alert">{draftError}</p>}
    {editor ? <AddressEditor key={editor.profile ? `${editor.profile.id}-${editor.profile.version}` : `new-${draftId ?? 'manual'}`} profile={editor.profile} draft={editor.draft} busy={action.busy} feedback={action.feedback} save={save} cancel={() => { setEditor(null); discardDraft(); action.clear(); }} />
      : selected ? <AddressDetails key={`${selected.id}-${selected.version}`} profile={selected} busy={action.busy} feedback={action.feedback} back={back} edit={() => { action.clear(); setEditor({ profile: selected }); }} changeStatus={(reason) => action.run({ key: `status:${selected.id}:${selected.version}:${reason}`, action: (operationId) => selected.status === 'active' ? documentApi.retireAddress(selected.id, { operationId, expectedVersion: selected.version, reason }) : documentApi.restoreAddress(selected.id, { operationId, expectedVersion: selected.version, reason }), success: selected.status === 'active' ? '地址已删除，可在“已删除”中恢复。历史版本已保留。' : '地址已恢复，可继续选择使用。' })} />
        : <section className="content-panel address-list-panel" aria-labelledby={`${id}-list-title`}>
          <div className="section-heading"><h3 id={`${id}-list-title`}>地址目录</h3><IconButton icon={RefreshCw} label="刷新收件地址" loading={addresses.isFetching} onClick={() => void addresses.refetch()} /></div>
          <form className="address-filters" onSubmit={(event) => event.preventDefault()}>
            <div className="field address-search"><label htmlFor={`${id}-search`}>搜索地址</label><Input id={`${id}-search`} type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="目的仓、地址标识、国家、联系人或地址" /></div>
            <div className="field"><label htmlFor={`${id}-status`}>地址状态</label><SelectField id={`${id}-status`} value={status} onValueChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: 'active', label: '有效地址' }, { value: 'retired', label: '已删除' }, { value: 'all', label: '全部状态' }]} /></div>
            <div className="field"><label htmlFor={`${id}-country`}>国家 / 地区</label><SelectField id={`${id}-country`} value={countryCode} onValueChange={(value) => { setCountryCode(value); setPage(1); }} options={[{ value: '', label: '全部国家 / 地区' }, ...countries.map((value) => ({ value, label: value }))]} /></div>
          </form>
          {addresses.isPending ? <div className="address-loading" role="status" aria-label="正在读取收件地址"><span /><span /><span /><p>正在读取收件地址…</p></div>
            : addresses.isError ? <QueryError error={addresses.error} retry={() => void addresses.refetch()} />
              : <><p className="address-result-count" role="status">共 {visible.length} 条{status === 'active' ? '有效地址' : status === 'retired' ? '已删除地址' : '地址'}{(search.trim() || countryCode) ? `，地址目录共 ${items.length} 条` : ''}</p>
                {rows.length ? <BatchTable label="收件地址" headers={['目的仓 / 地址标识', '收件地址', '国家 / 联系人', '状态 / 版本', '操作']}>{rows.map((profile) => <tr key={profile.id}><td><strong>{text(profile.data, 'destinationFc') || '目的仓未填写'}</strong><small className="mapping-subtext address-record-key">{profile.key}</small></td><td><span className="address-table-street">{[text(profile.data, 'addressLine1'), text(profile.data, 'addressLine2'), text(profile.data, 'addressLine3')].filter(Boolean).join('，')}</span><small className="mapping-subtext">{[text(profile.data, 'city'), text(profile.data, 'state'), text(profile.data, 'postalCode')].filter(Boolean).join(' · ')}</small></td><td>{country(profile) || '国家未填写'}<small className="mapping-subtext">{text(profile.data, 'recipientName') || '—'}{text(profile.data, 'recipientCompany') ? ` · ${text(profile.data, 'recipientCompany')}` : ''}</small></td><td><AddressStatus status={profile.status} /><small className="mapping-subtext">v{profile.version}</small></td><td><Button type="button" onClick={() => open(profile)}>查看详情</Button></td></tr>)}</BatchTable>
                  : <div className="address-empty"><MapPin size={26} aria-hidden="true" /><h3>{search.trim() || countryCode ? '没有匹配的地址' : status === 'retired' ? '还没有已删除地址' : '还没有有效地址'}</h3><p>{search.trim() || countryCode ? '尝试其他关键词或国家，也可清除筛选查看完整目录。' : status === 'retired' ? '删除的地址会保留在这里，可查看历史并恢复。' : '新增收件地址后，可在制作发票时按目的仓和国家选择。'}</p>{search.trim() || countryCode ? <Button onClick={() => { setSearch(''); setCountryCode(''); setPage(1); }}>清除筛选</Button> : status === 'active' && <Button icon={Plus} onClick={startNew}>新增地址</Button>}</div>}
                <BatchPagination page={currentPage} pageSize={pageSize} total={visible.length} change={setPage} />
              </>}
        </section>}
  </div>;
}

function AddressStatus({ status }: { status: DocumentProfile['status'] }) {
  return <span className={`address-status address-status-${status}`}>{status === 'active' ? '有效' : '已删除'}</span>;
}

function AddressValues({ data }: { data: Record<string, unknown> }) {
  return <dl className="address-values">{addressFields.map((field) => <div key={field.key} className={field.key.startsWith('addressLine') ? 'address-value-wide' : undefined}><dt>{field.label}</dt><dd>{text(data, field.key) || '—'}</dd></div>)}</dl>;
}

function AddressDetails({ profile, busy, feedback, back, edit, changeStatus }: { profile: DocumentProfile; busy: boolean; feedback: React.ReactNode; back: () => void; edit: () => void; changeStatus: (reason: string) => void }) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useQuery({ queryKey: ['document-asset-history', 'profiles', profile.id, profile.version], queryFn: () => documentApi.assetHistory('profiles', profile.id), enabled: historyOpen, retry: false });
  const source = profile.data.source && typeof profile.data.source === 'object' && !Array.isArray(profile.data.source) ? profile.data.source as Record<string, unknown> : null;
  return <section className="content-panel address-detail-panel" aria-labelledby={`${id}-title`}>
    <div className="section-heading address-detail-heading"><div><h3 id={`${id}-title`}>地址详情</h3><p className="address-detail-key">{profile.key}</p></div><Button type="button" icon={ArrowLeft} disabled={busy} onClick={back}>返回地址列表</Button></div>
    <div className="address-detail-meta"><AddressStatus status={profile.status} /><span>当前版本 v{profile.version}</span><span>创建于 {timestamp(profile.createdAt)}</span></div>
    <AddressValues data={profile.data} />
    {source && <details className="address-history"><summary>查看原始导入信息</summary><p className="mapping-help">以下信息保留导入时的记录，编辑地址不会改写原始记录。</p><dl className="address-values">{[{ key: 'addressLabel', label: '原地址简称' }, { key: 'telephone', label: '原联系电话' }, { key: 'mobile', label: '原联系手机' }, { key: 'countryOriginal', label: '原国家' }, { key: 'sheetName', label: '来源工作表' }].map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{text(source, field.key) || '—'}</dd></div>)}{Array.isArray(source.sourceRows) && <div><dt>来源行号</dt><dd>{source.sourceRows.join('、')}</dd></div>}</dl></details>}
    <details className="address-history" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}><summary>版本历史</summary>{historyOpen && (history.isPending ? <p className="mapping-help" role="status">正在读取地址版本…</p> : history.isError ? <QueryError error={history.error} retry={() => void history.refetch()} /> : <ol className="address-history-list">{history.data.map((entry) => <li key={entry.id}><div><strong>v{entry.version}</strong><span>{timestamp(entry.createdAt)}</span></div><p>{entry.reason}</p>{entry.data && <details><summary>查看 v{entry.version} 地址内容</summary><AddressValues data={entry.data} /></details>}</li>)}</ol>)}</details>
    {feedback}
    {!confirming ? <div className="address-actions">{profile.status === 'active' && <Button type="button" icon={Pencil} disabled={busy} onClick={edit}>编辑地址</Button>}<Button type="button" icon={profile.status === 'active' ? Trash2 : RotateCcw} disabled={busy} onClick={() => setConfirming(true)}>{profile.status === 'active' ? '删除地址' : '恢复地址'}</Button></div>
      : <form className="address-status-confirm" onSubmit={(event) => { event.preventDefault(); if (reason.trim()) changeStatus(reason.trim()); }}><h4>{profile.status === 'active' ? '删除此地址' : '恢复此地址'}</h4><p className="mapping-help">{profile.status === 'active' ? '删除后不再作为可选地址，历史版本和已生成文件保留。之后可在已删除地址中恢复。' : '恢复后重新进入有效地址目录，并保留删除前的完整版本历史。'}</p><div className="field"><label htmlFor={`${id}-reason`}>{profile.status === 'active' ? '删除原因' : '恢复原因'} *</label><Input id={`${id}-reason`} value={reason} maxLength={1000} required disabled={busy} autoFocus onChange={(event) => setReason(event.target.value)} /></div><div className="address-actions"><Button type="submit" icon={profile.status === 'active' ? Trash2 : RotateCcw} loading={busy} disabled={!reason.trim()}>{profile.status === 'active' ? '确认删除地址' : '确认恢复地址'}</Button><Button type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</Button></div></form>}
  </section>;
}

function AddressEditor({ profile, draft, busy, feedback, save, cancel }: { profile: DocumentProfile | null; draft?: AddressDraft; busy: boolean; feedback: React.ReactNode; save: (profile: DocumentProfile | null, input: { key: string; data: Record<string, unknown>; reason: string }) => void; cancel: () => void }) {
  const id = useId();
  const [key, setKey] = useState(profile?.key ?? draft?.key ?? '');
  const [data, setData] = useState<Record<string, unknown>>(() => ({ ...(profile?.data ?? draft?.data ?? {}) }));
  const [reason, setReason] = useState(draft?.reason ?? (profile ? '更新收件地址' : '新增收件地址'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discarding, setDiscarding] = useState(false);
  const initial = useRef(JSON.stringify({ key, data, reason }));
  const dirty = JSON.stringify({ key, data, reason }) !== initial.current;
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = Object.fromEntries(Object.entries(data).map(([field, value]) => [field, typeof value === 'string' ? value.trim() : value]));
    const parsed = documentAddressDataSchema.safeParse(normalized);
    if (!parsed.success) {
      const messages: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        messages[field] = field === 'countryCode' ? '请输入两位英文字母国家代码，例如 US。' : field === 'destinationFc' ? '目的仓代码最多 40 个字符，可用英文字母、数字、下划线、短横线或斜线。' : '请填写此字段，最多 4000 个字符。';
      }
      setErrors(messages);
      document.getElementById(`${id}-${Object.keys(messages)[0]}`)?.focus();
      return;
    }
    setErrors({});
    save(profile, { key: key.trim(), data: parsed.data, reason: reason.trim() });
  };
  return <form className="content-panel address-editor" onSubmit={submit} aria-labelledby={`${id}-title`}>
    <div className="section-heading"><div><h3 id={`${id}-title`}>{profile ? '编辑地址' : '新增地址'}</h3><p className="mapping-help">{draft ? '已带入发票中的地址。核对并保存后，返回草稿选择新地址。' : profile ? '修改保存为同一地址的新版本。标有 * 的字段为必填。' : '填写完整地址后，可在发票中按目的仓和国家选择。标有 * 的字段为必填。'}</p></div><Button type="button" icon={X} disabled={busy} onClick={() => dirty ? setDiscarding(true) : cancel()}>取消</Button></div>
    <div className="field address-key-field"><label htmlFor={`${id}-key`}>地址标识 *</label><Input id={`${id}-key`} value={key} maxLength={200} required autoFocus disabled={busy} onChange={(event) => setKey(event.target.value)} aria-describedby={`${id}-key-help`} /><p id={`${id}-key-help`} className="mapping-help">为地址填写便于查找的名称，例如“PBI3 美国仓”。编辑名称会保留同一条地址记录。</p></div>
    <div className="address-form-grid">{addressFields.map((field) => <div className={`field${field.key.startsWith('addressLine') ? ' address-form-wide' : ''}`} key={field.key}><label htmlFor={`${id}-${field.key}`}>{field.label}{'required' in field && field.required ? ' *' : ''}</label><Input id={`${id}-${field.key}`} value={text(data, field.key)} required={'required' in field && field.required} maxLength={'maxLength' in field ? field.maxLength : 4000} disabled={busy} aria-invalid={Boolean(errors[field.key]) || undefined} aria-describedby={errors[field.key] ? `${id}-${field.key}-error` : field.key === 'countryCode' ? `${id}-country-help` : undefined} onChange={(event) => { const value = event.target.value; setData((current) => ({ ...current, [field.key]: field.key === 'countryCode' || field.key === 'destinationFc' ? value.toUpperCase() : value })); setErrors((current) => ({ ...current, [field.key]: '' })); }} />{field.key === 'countryCode' && <p id={`${id}-country-help`} className="mapping-help">使用两位代码，例如 US、GB、DE。</p>}{errors[field.key] && <p id={`${id}-${field.key}-error`} className="mapping-help error-note">{errors[field.key]}</p>}</div>)}</div>
    <div className="field address-reason"><label htmlFor={`${id}-reason`}>修改原因 *</label><Input id={`${id}-reason`} value={reason} required maxLength={1000} disabled={busy} onChange={(event) => setReason(event.target.value)} /></div>
    {feedback}
    {discarding && <div className="address-discard-confirm" role="alert"><p>有未保存的地址修改，确定取消编辑？</p><div className="address-actions"><Button type="button" disabled={busy} onClick={cancel}>放弃修改</Button><Button type="button" disabled={busy} onClick={() => setDiscarding(false)}>继续编辑</Button></div></div>}
    <div className="address-actions"><Button type="submit" icon={Save} variant="primary" loading={busy} disabled={!key.trim() || !reason.trim()}>保存地址</Button><Button type="button" disabled={busy} onClick={() => dirty ? setDiscarding(true) : cancel()}>取消</Button></div>
  </form>;
}
