import { sellerAliasRevisionSchema, sellerMappingRevisionSchema, type SellerAliasRevisionInput, type SellerCatalogSettings, type SellerMapping, type SellerMappingRevisionInput } from '@scm/contracts';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Save, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type SellerMappingRevision, type User } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';
import { StatePage } from '../pages';
import { ManualSellerCreate, SellerSourceSetting, catalogModeLabels } from './seller-source-setting';
import { ImportDialog } from './import-dialog';
import { SettingsLayout } from './settings';

const labels: Record<SellerMapping['status'], string> = { candidate: '待确认', approved: '已批准', disabled: '已停用' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : '发生未知错误，请稍后重试。';
const timestamp = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));

export function SellerMappingsRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开店铺映射" detail={messageOf(session.error)} action={<Button icon={RefreshCw} loading={session.isFetching} type="button" onClick={() => void session.refetch()}>重试</Button>} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <SellerMappingsPage user={session.data.user} />;
}

function SellerMappingsPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ mapping: SellerMapping; settings: SellerCatalogSettings } | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'source' | 'manual' | 'edit' | null>(null);
  const [sourceVisited, setSourceVisited] = useState(false);
  const [manualVisited, setManualVisited] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const sourceSettings = useQuery({ queryKey: ['seller-catalog-settings'], queryFn: api.sellerCatalogSettings, retry: false });
  const list = useQuery({
    queryKey: ['seller-mappings', { page, search, status }],
    queryFn: () => api.sellerMappings({ page, pageSize: 20, search, status }),
    retry: false,
  });
  useEffect(() => {
    if ([list.error, sourceSettings.error].some((error) => error instanceof ApiError && error.status === 401)) void queryClient.invalidateQueries({ queryKey: ['session'] });
  }, [list.error, sourceSettings.error, queryClient]);
  const settings = sourceSettings.data ?? list.data?.settings;
  useEffect(() => {
    if (settings?.mode === 'lingxing' && status === 'candidate') { setStatus(''); setPage(1); }
  }, [settings?.mode, status]);
  const actionBusy = sourceBusy || manualBusy || editorBusy;
  const catalogBusy = useIsMutating({ mutationKey: ['seller-catalog-update'] }) > 0 || sourceSettings.isFetching || list.isFetching;
  const directoryCurrent = !!settings && !!list.data && settings.mode === list.data.settings.mode && settings.version === list.data.settings.version && settings.catalogVersion === list.data.settings.catalogVersion && !sourceSettings.isFetching && !list.isFetching;
  const selectionCurrent = !!selected && !!settings && selected.mapping.dataSource === settings.mode && selected.settings.mode === settings.mode && selected.settings.version === settings.version && (selected.mapping.dataSource === 'manual' || (selected.settings.catalogVersion === settings.catalogVersion && directoryCurrent));
  const refreshDirectory = () => { if (!actionBusy) setSelected(null); void list.refetch(); void sourceSettings.refetch(); };
  const openSource = () => { setSourceVisited(true); setDialog('source'); };
  const openMapping = (mapping: SellerMapping, context: SellerCatalogSettings) => {
    setConfirmation(null);
    setSelected((previous) => previous?.mapping.id === mapping.id && previous.mapping.version === mapping.version && previous.settings.mode === context.mode && previous.settings.version === context.version && previous.settings.catalogVersion === context.catalogVersion ? previous : { mapping, settings: context });
    setDialog('edit');
  };
  const catalogChanged = (value: NonNullable<typeof settings>) => {
    queryClient.setQueryData(['seller-catalog-settings'], value); setSelected(null); setPage(1);
    void queryClient.invalidateQueries({ queryKey: ['seller-mappings'] });
    void queryClient.invalidateQueries({ queryKey: ['import-confirmation'] });
  };
  const searchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(searchDraft.trim());
    setPage(1);
  };
  const mappingSaved = (mapping: SellerMapping) => {
    if (!selected) return;
    const nextSettings = selected.mapping.dataSource === 'lingxing'
      ? { ...selected.settings, catalogVersion: selected.settings.catalogVersion + 1 }
      : selected.settings;
    if (mapping.dataSource === 'lingxing') queryClient.setQueryData<SellerCatalogSettings>(['seller-catalog-settings'], (current) =>
      current?.mode === selected.settings.mode && current.version === selected.settings.version && current.catalogVersion === selected.settings.catalogVersion ? nextSettings : current);
    setSelected({ mapping, settings: nextSettings });
    setConfirmation(`${mapping.name}已保存为版本 ${mapping.version}，状态：${labels[mapping.status]}。`);
    void queryClient.invalidateQueries({ queryKey: ['seller-mappings'] });
    void queryClient.invalidateQueries({ queryKey: ['seller-mapping-history', mapping.id] });
    void queryClient.invalidateQueries({ queryKey: ['seller-catalog-settings'] });
    void queryClient.invalidateQueries({ queryKey: ['import-confirmation'] });
  };
  return (
    <SettingsLayout user={user}>
        <header className="settings-section-heading">
          <h2 id="seller-title">店铺目录</h2><p>领星可用店铺自动批准，可维护本地别名或停用；人工店铺保留人工审批。</p>
        </header>
        {sourceSettings.isError && <div className="inline-error" role="alert"><div><strong>店铺来源设置暂时不可用</strong><p>{messageOf(sourceSettings.error)}</p></div><Button icon={RefreshCw} loading={sourceSettings.isFetching} type="button" onClick={() => void sourceSettings.refetch()}>重试</Button></div>}
        <section className="content-panel" aria-labelledby="mapping-list-title">
          <h3 id="mapping-list-title" className="sr-only">店铺目录列表</h3>
          <form className="mapping-filters" onSubmit={searchSubmit}>
            <div className="field"><label htmlFor="seller-search">店铺名称、别名或 sid</label><Input id="seller-search" value={searchDraft} maxLength={160} onChange={(event) => setSearchDraft(event.target.value)} placeholder="输入搜索内容" /></div>
            <div className="field"><label htmlFor="seller-status">状态</label><SelectField id="seller-status" value={status} onValueChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: '', label: '全部状态' }, ...(settings?.mode !== 'lingxing' ? [{ value: 'candidate', label: '待确认' }] : []), { value: 'approved', label: '已批准' }, { value: 'disabled', label: '已停用' }]} /></div>
            <Button icon={Search} type="submit" disabled={list.isFetching}>搜索</Button>
          </form>
          <div className="seller-directory-toolbar"><Button type="button" icon={SlidersHorizontal} disabled={!settings || actionBusy} onClick={openSource}>来源设置</Button>{settings?.mode === 'manual' && <Button type="button" icon={Plus} variant="primary" disabled={actionBusy || catalogBusy} onClick={() => { setManualVisited(true); setDialog('manual'); }}>新增人工店铺</Button>}<Button icon={RefreshCw} loading={list.isFetching || sourceSettings.isFetching} disabled={actionBusy} type="button" variant="text" onClick={refreshDirectory}>刷新目录</Button><p>{settings ? `当前使用${catalogModeLabels[settings.mode]}` : '正在读取来源设置…'}{settings?.mode === 'lingxing' && ' · 可用目录自动批准'}</p></div>
          {list.isPending ? <p className="list-state" role="status">正在读取店铺目录…</p> : list.isError ? <div className="inline-error" role="alert"><div><strong>店铺目录暂时不可用</strong><p>{messageOf(list.error)}</p></div><Button icon={RefreshCw} loading={list.isFetching} type="button" onClick={() => void list.refetch()}>重试</Button></div> : list.data.items.length === 0 ? <p className="list-state">没有符合筛选条件的店铺。{settings?.mode === 'manual' ? '可点击“新增人工店铺”补充资料。' : '可在“来源设置”中同步领星实际店铺。'}</p> : <>
            <div className="table-scroll" role="region" aria-label="店铺映射表，可横向滚动" tabIndex={0}><div className="table-inner"><table className="task-table mapping-table"><thead><tr><th scope="col">店铺 / sid</th><th scope="col">国家 / 仓库</th><th scope="col">需求别名</th><th scope="col">状态 / 版本</th><th scope="col">操作</th></tr></thead><tbody>{list.data.items.map((mapping) => <tr key={mapping.id}><td><strong>{mapping.dataSource === 'lingxing' ? mapping.lingxingName ?? mapping.name : mapping.name}</strong><small className="mapping-subtext">sid {mapping.sid} · {catalogModeLabels[mapping.dataSource]}</small></td><td>{mapping.country}<small className="mapping-subtext">wid {mapping.wid ?? '未确认'}</small></td><td>{mapping.aliases.length ? mapping.aliases.join('、') : <span className="mapping-subtext">使用店铺名称</span>}</td><td><span className={`mapping-status mapping-status-${mapping.status}`}>{labels[mapping.status]}</span>{mapping.dataSource === 'lingxing' && mapping.autoApproved && <small className="mapping-subtext">领星自动批准</small>}<small className="mapping-subtext">版本 {mapping.version}{mapping.lingxingStatus ? ` · 领星状态 ${mapping.lingxingStatus}` : ''}</small></td><td>{settings?.mode === mapping.dataSource ? mapping.dataSource === 'lingxing' ? <Button type="button" icon={Pencil} variant="text" disabled={!directoryCurrent || catalogBusy || actionBusy} onClick={() => openMapping(mapping, list.data.settings)}>维护别名</Button> : <IconButton type="button" icon={Pencil} label="维护映射" description={`${mapping.name} · sid ${mapping.sid}`} disabled={!directoryCurrent || catalogBusy || actionBusy} onClick={() => openMapping(mapping, list.data.settings)} /> : <span className="mapping-subtext">请刷新目录</span>}</td></tr>)}</tbody></table></div></div>
            <div className="mapping-pagination"><span>共 {list.data.total} 家 · 第 {page} 页</span><div><IconButton type="button" icon={ChevronLeft} label="上一页" disabled={page === 1 || list.isFetching} onClick={() => setPage(page - 1)} /><IconButton type="button" icon={ChevronRight} label="下一页" disabled={page * 20 >= list.data.total || list.isFetching} onClick={() => setPage(page + 1)} /></div></div>
          </>}
        </section>
        {confirmation && <p className="permission-note success-note" role="status">{confirmation}</p>}
        {settings && <>
          <ImportDialog open={dialog === 'source'} title="店铺来源设置" close={() => setDialog((current) => current === 'source' ? null : current)}><div className="seller-dialog-content">{sourceVisited && <SellerSourceSetting settings={settings} refreshing={sourceSettings.isFetching} refresh={refreshDirectory} changed={catalogChanged} onBusyChange={setSourceBusy} />}</div></ImportDialog>
          <ImportDialog open={dialog === 'manual'} title="新增人工店铺" close={() => setDialog((current) => current === 'manual' ? null : current)}><div className="seller-dialog-content">{manualVisited && <>{settings.mode !== 'manual' && <p className="permission-note warning-note" role="alert">当前已切换到领星来源。请先在来源设置中切换回人工维护，再继续新增。</p>}<fieldset className="seller-dialog-fieldset" disabled={settings.mode !== 'manual'}><ManualSellerCreate onBusyChange={setManualBusy} refresh={refreshDirectory} created={(mapping) => {
            setSelected({ mapping, settings }); setConfirmation(`${mapping.name}（sid ${mapping.sid}）已保存，请继续核对人工审批。`); setDialog((current) => current === 'manual' ? 'edit' : current);
            void queryClient.invalidateQueries({ queryKey: ['seller-mappings'] }); void queryClient.invalidateQueries({ queryKey: ['seller-catalog-settings'] }); void queryClient.invalidateQueries({ queryKey: ['import-confirmation'] });
          }} /></fieldset></>}</div></ImportDialog>
        </>}
        <ImportDialog open={dialog === 'edit' && Boolean(selected)} title="维护店铺" close={() => setDialog((current) => current === 'edit' ? null : current)}><div className="seller-dialog-content">{selected && <MappingEditor key={`${selected.mapping.id}:${selected.mapping.version}:${selected.settings.mode}:${selected.settings.version}:${selected.settings.mode === 'lingxing' ? selected.settings.catalogVersion : 0}`} active={dialog === 'edit'} mapping={selected.mapping} catalogSettings={selected.settings} contextCurrent={selectionCurrent} catalogBusy={catalogBusy} notice={confirmation} onBusyChange={setEditorBusy} saved={mappingSaved} />}</div></ImportDialog>
    </SettingsLayout>
  );
}

interface Draft { sid: string; name: string; country: string; marketplaceId: string; wid: string; aliases: string; status: SellerMapping['status']; reason: string }

function operationId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function MappingEditor({ mapping, catalogSettings, contextCurrent, catalogBusy, active, notice, onBusyChange, saved }: {
  mapping: SellerMapping; catalogSettings: SellerCatalogSettings; contextCurrent: boolean; catalogBusy: boolean;
  active: boolean; notice: string | null; onBusyChange: (busy: boolean) => void; saved: (mapping: SellerMapping) => void;
}) {
  const queryClient = useQueryClient();
  const aliasesOnly = mapping.dataSource === 'lingxing';
  const [draft, setDraft] = useState<Draft>({ sid: String(mapping.sid), name: aliasesOnly ? mapping.lingxingName ?? mapping.name : mapping.name, country: mapping.country, marketplaceId: mapping.marketplaceId ?? '', wid: mapping.wid ?? '', aliases: mapping.aliases.join('\n'), status: aliasesOnly && mapping.status === 'candidate' ? 'disabled' : mapping.status, reason: '' });
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const firstApproval = !aliasesOnly && mapping.status === 'candidate' && !mapping.hasApprovedBefore && draft.status === 'approved';
  const remoteUnavailable = aliasesOnly && (mapping.lingxingStatus !== '1' || !mapping.autoApproved);
  const [error, setError] = useState<string | null>(null);
  const [pendingOperation, setPendingOperation] = useState<string>(operationId);
  const heading = useRef<HTMLHeadingElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const revisions = useQuery({ queryKey: ['seller-mapping-history', mapping.id, mapping.version], queryFn: () => api.sellerMappingHistory(mapping.id), retry: false, enabled: active && historyOpen });
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => heading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active]);
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value })); setError(null); setPendingOperation(operationId());
    if (key !== 'reason') setIdentityConfirmed(false);
  };
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: async (input: SellerMappingRevisionInput | SellerAliasRevisionInput) => 'expectedCatalogSettingsVersion' in input
      ? (await api.reviseSellerAliases(mapping.id, input)).mapping
      : api.reviseSellerMapping(mapping.id, input),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] });
    },
    onSuccess: saved,
  });
  useEffect(() => {
    onBusyChange(mutation.isPending);
    return () => onBusyChange(false);
  }, [mutation.isPending, onBusyChange]);
  const blocked = mutation.isPending || catalogBusy || !contextCurrent;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked) return;
    if (firstApproval && !identityConfirmed) {
      setError('请先核对店铺身份并勾选“已核对店铺身份”。');
      return;
    }
    const aliases = draft.aliases.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const approval = firstApproval ? { reason: '', identityConfirmed: true } : { reason: draft.reason };
    const parsed = aliasesOnly ? sellerAliasRevisionSchema.safeParse({
      operationId: pendingOperation, expectedVersion: mapping.version,
      expectedCatalogSettingsVersion: catalogSettings.version, expectedCatalogVersion: catalogSettings.catalogVersion,
      aliases, status: draft.status, ...approval,
    }) : sellerMappingRevisionSchema.safeParse({
      operationId: pendingOperation, expectedVersion: mapping.version,
      ...draft, ...approval, sid: /^\d+$/.test(draft.sid.trim()) ? Number(draft.sid) : NaN, aliases,
      wid: draft.wid.trim() || null, marketplaceId: draft.marketplaceId.trim() || null,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const fieldNames: Record<string, string> = { sid: '店铺编号', name: '店铺名称', country: '国家', marketplaceId: '站点 ID', wid: '仓库 wid', aliases: '需求别名', reason: '修改原因', identityConfirmed: '店铺身份核对' };
      setError(`${fieldNames[String(issue?.path[0])] ?? '输入内容'}：${issue?.message ?? '请检查填写内容'}`);
      return;
    }
    setError(null); mutation.mutate(parsed.data);
  };
  return <section className="content-panel mapping-editor motion-panel" aria-labelledby="mapping-editor-title">
    <div className="section-heading panel-heading"><div><h3 id="mapping-editor-title" ref={heading} tabIndex={-1}>{aliasesOnly ? '维护别名' : '维护'}：{draft.name}</h3><p>sid {mapping.sid} · 当前版本 {mapping.version} · 最近更新 {timestamp(mapping.updatedAt)}</p></div></div>
    {notice && <p className="permission-note success-note" role="status">{notice}</p>}
    <dl className="mapping-evidence"><div><dt>候选来源时间</dt><dd>{timestamp(mapping.sourceObservedAt)}（上海时间）</dd></div><div><dt>来源 SHA-256</dt><dd><code>{mapping.sourceSha256}</code></dd></div></dl>
    {aliasesOnly && <p className="mapping-help">领星可用店铺自动批准，身份信息由领星提供。可维护本地需求别名和使用状态；停用决定会保留。</p>}
    {remoteUnavailable && <p className="permission-note warning-note">当前领星身份不可用，请在来源设置中同步并核对目录后再启用。</p>}
    {catalogBusy ? <p className="permission-note" role="status">正在核对店铺来源和最新目录，请稍候。</p> : !contextCurrent && <p className="form-note error-note" role="alert">店铺来源或目录版本已变化，当前草稿保留在此表单中。请关闭详情、刷新目录后重新打开并核对。</p>}
    <form onSubmit={submit} className="mapping-edit-form">
      <div className="mapping-field-grid">
        <div className="field"><label htmlFor="mapping-sid">店铺编号（sid）</label><Input id="mapping-sid" inputMode="numeric" value={draft.sid} onChange={(event) => change('sid', event.target.value)} maxLength={10} required readOnly={aliasesOnly} disabled={blocked || (!aliasesOnly && mapping.identityLocked)} />{!aliasesOnly && mapping.identityLocked && <p className="mapping-help">该店铺身份已被使用，编号已锁定；历史需求关联保持原 sid。</p>}</div>
        <div className="field"><label htmlFor="mapping-name">店铺名称</label><Input id="mapping-name" value={draft.name} onChange={(event) => change('name', event.target.value)} maxLength={160} required readOnly={aliasesOnly} disabled={blocked} /></div>
        <div className="field"><label htmlFor="mapping-country">国家</label><Input id="mapping-country" value={draft.country} onChange={(event) => change('country', event.target.value)} maxLength={80} required readOnly={aliasesOnly} disabled={blocked} /></div>
        <div className="field"><label htmlFor="mapping-marketplace">站点 ID（可留空）</label><Input id="mapping-marketplace" value={draft.marketplaceId} onChange={(event) => change('marketplaceId', event.target.value)} maxLength={80} readOnly={aliasesOnly} disabled={blocked} /></div>
        <div className="field"><label htmlFor="mapping-wid">成品仓 wid（可留空）</label><Input id="mapping-wid" value={draft.wid} onChange={(event) => change('wid', event.target.value)} maxLength={80} readOnly={aliasesOnly} disabled={blocked} /></div>
      </div>
      <div className="field"><label htmlFor="mapping-aliases">需求别名（可选，每行一个）</label><textarea id="mapping-aliases" value={draft.aliases} onChange={(event) => change('aliases', event.target.value)} rows={4} maxLength={8050} disabled={blocked} aria-describedby="mapping-aliases-help" /><p className="mapping-help" id="mapping-aliases-help">导入表与店铺名称一致时无需填写；名称不同时再补充，每行一个。</p></div>
      <div className="field"><label htmlFor="mapping-status">{aliasesOnly ? '本地使用状态' : '映射状态'}</label><SelectField id="mapping-status" value={draft.status} onValueChange={(value) => change('status', value as SellerMapping['status'])} disabled={blocked} options={[...(!aliasesOnly ? [{ value: 'candidate', label: '待确认' }] : []), { value: 'approved', label: aliasesOnly ? '使用中（领星自动批准）' : '已批准', disabled: remoteUnavailable }, { value: 'disabled', label: '已停用' }]} /></div>
      {draft.status === 'approved' && <p className="permission-note" role="status">{draft.aliases.trim() ? '保存后，店铺名称和已填写别名均可匹配' : '保存后，导入表可使用店铺名称匹配'} sid {draft.sid}（{draft.country}）。{aliasesOnly ? '请核对本次别名与使用状态。' : `请核对店铺身份${draft.aliases.trim() ? '和全部别名' : ''}后提交。`}</p>}
      {firstApproval ? <div><label className="import-check"><input id="mapping-identity-confirmed" type="checkbox" checked={identityConfirmed} disabled={blocked} aria-required="true" aria-describedby="mapping-identity-help" onChange={(event) => { setIdentityConfirmed(event.target.checked); setError(null); setPendingOperation(operationId()); }} /><span>已核对店铺身份</span></label><p id="mapping-identity-help" className="mapping-help">首次批准无需填写原因；系统会记录本次核对确认、操作人和时间。</p></div> : <div className="field"><label htmlFor="mapping-reason">{aliasesOnly ? '修改原因' : '修改 / 批准原因'}</label><textarea id="mapping-reason" value={draft.reason} onChange={(event) => change('reason', event.target.value)} maxLength={500} rows={2} required disabled={blocked} /></div>}
      <p className="mapping-help">提交绑定当前版本；其他会话先修改时会提示冲突。{aliasesOnly ? '领星店铺身份只读，保存会记录本地别名和停用状态。' : '仓库未确认时继续保留空值。'}</p><div className="mapping-editor-actions"><Button icon={Save} loading={mutation.isPending} loadingLabel="正在保存…" disabled={blocked} type="submit" variant="primary">{aliasesOnly ? '保存别名及状态' : '保存映射及版本'}</Button></div>
      {error && <p className="form-note error-note" role="alert">{error}</p>}
      {mutation.isError && <p className="form-note error-note" role="alert">{messageOf(mutation.error)}{mutation.error instanceof ApiError && mutation.error.status === 409 ? ' 请关闭详情，刷新目录后重新打开并核对。当前草稿仍保留在此表单中。' : ''}</p>}
    </form>
    <details className="mapping-history" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}><summary>版本记录</summary>{historyOpen && <><p className="mapping-help">最近 100 次修改</p>{revisions.isPending ? <p className="list-state" role="status">正在读取版本记录…</p> : revisions.isError ? <div className="inline-error" role="alert"><div><strong>版本记录暂时不可用</strong><p>{messageOf(revisions.error)}</p></div><Button icon={RefreshCw} loading={revisions.isFetching} type="button" onClick={() => void revisions.refetch()}>重试</Button></div> : revisions.data && revisions.data.length === 0 ? <p className="list-state">尚无本地修改记录。</p> : <ol className="mapping-revisions">{revisions.data?.map((revision) => <RevisionItem key={revision.operationId} revision={revision} />)}</ol>}</>}</details>
  </section>;
}

function RevisionItem({ revision }: { revision: SellerMappingRevision }) {
  const fields: { key: 'sid' | 'name' | 'country' | 'marketplaceId' | 'wid' | 'aliases' | 'status'; label: string }[] = [
    { key: 'sid', label: '店铺编号 sid' }, { key: 'name', label: '店铺名称' }, { key: 'country', label: '国家' }, { key: 'marketplaceId', label: '站点 ID' }, { key: 'wid', label: '仓库 wid' }, { key: 'aliases', label: '需求别名' }, { key: 'status', label: '映射状态' },
  ];
  const display = (mapping: SellerMapping, key: typeof fields[number]['key']) => key === 'aliases' ? mapping.aliases.join('、') || '未填写' : key === 'status' ? labels[mapping.status] : mapping[key] || '未填写';
  const before = revision.before;
  const changed = before ? fields.filter(({ key }) => display(before, key) !== display(revision.after, key)) : fields;
  return <li><strong>版本 {revision.version}{before ? '' : ' · 新增资料'}</strong><span className="mapping-subtext">{timestamp(revision.createdAt)} · 操作人 ID：{revision.actorUserId}</span><p>{revision.reason}</p><details><summary>{before ? `查看字段变化（${changed.length} 项）` : '查看新增资料'}</summary>{changed.length ? <dl className="mapping-diff">{changed.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{before && <><span>{display(before, key)}</span><span aria-label="变更为">→</span></>}<strong>{display(revision.after, key)}</strong></dd></div>)}</dl> : <p>本次未改变映射字段。</p>}</details></li>;
}
