import { useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { Pencil, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import type { ServiceMapping, ServiceMappingOptions } from '@scm/contracts';
import { api, ApiError, type User } from '../api';
import { Button } from '../components/ui/button';
import { Combobox } from '../components/ui/combobox';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { ScmDataGrid, type GridColumn } from '../components/ui/scm-data-grid';
import { StatePage } from '../pages';
import { messageOf, newOperation, QueryError, timestamp } from './batch-shared';
import { serviceMappingApi } from './service-mapping-api';
import { SettingsLayout } from './settings';
import './service-mappings.css';

type MappingOptions = ServiceMappingOptions;
const samePair = (left: Pick<ServiceMapping, 'countryCode' | 'transportMethod'>, right: Pick<ServiceMapping, 'countryCode' | 'transportMethod'>) => left.countryCode === right.countryCode && left.transportMethod.trim() === right.transportMethod.trim();
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409 && error.code !== 'SERVICE_MAPPING_DUPLICATE';

export function ServiceMappingsRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开发票服务映射" detail={messageOf(session.error)} action={<Button icon={RefreshCw} loading={session.isFetching} onClick={() => void session.refetch()}>重试</Button>} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <ServiceMappings user={session.data.user} />;
}

function ServiceMappings({ user }: { user: User }) {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['service-mappings'], queryFn: serviceMappingApi.list, retry: false });
  const options = useQuery({ queryKey: ['service-mapping-options'], queryFn: serviceMappingApi.options, retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 });
  const [searchDraft, setSearchDraft] = useState(''), [search, setSearch] = useState('');
  const [editor, setEditor] = useState<ServiceMapping | 'new' | null>(null), [deleting, setDeleting] = useState<ServiceMapping | null>(null);
  const [notice, setNotice] = useState('');
  const countryName = (code: string) => options.data?.countries.items.find((country) => country.code === code)?.name || code;
  const rows = (list.data?.items ?? []).filter((mapping) => !mapping.deletedAt && (!search || [mapping.countryCode, countryName(mapping.countryCode), mapping.transportMethod, mapping.service].some((text) => text.toLocaleLowerCase().includes(search.toLocaleLowerCase()))));
  const columns: GridColumn<ServiceMapping>[] = [
    { key: 'country', title: '国家', width: 150, getValue: (row) => `${countryName(row.countryCode)} · ${row.countryCode}`, onActivate: setEditor },
    { key: 'transportMethod', title: '运输方式', width: 180, getValue: (row) => row.transportMethod, onActivate: setEditor },
    { key: 'service', title: '发票服务名称', width: 340, getValue: (row) => row.service, onActivate: setEditor },
    { key: 'version', title: '版本', width: 75, getValue: (row) => row.version },
    { key: 'updatedAt', title: '更新时间', width: 165, getValue: (row) => timestamp(row.updatedAt) },
    { key: 'actions', title: '操作', width: 48, align: 'center', getValue: () => '', icon: () => 'more', openMenu: true },
  ];
  const saved = (mapping: ServiceMapping, deleted = false) => {
    setEditor(null); setDeleting(null); setNotice(deleted ? '已删除此服务映射。' : `${countryName(mapping.countryCode)} · ${mapping.transportMethod} 的服务映射已保存。`);
    void client.invalidateQueries({ queryKey: ['service-mappings'] });
    void client.invalidateQueries({ queryKey: ['document-field-options'] });
  };
  const refresh = async (id: string) => {
    const result = await list.refetch();
    if (result.error) throw result.error;
    const mapping = result.data?.items.find((item) => item.id === id && !item.deletedAt);
    if (!mapping) throw new Error('此映射已被删除。请关闭窗口并刷新列表。');
    return mapping;
  };
  return <SettingsLayout user={user}>
    <section aria-labelledby="service-mappings-title" className="service-mappings-list">
      <header className="settings-section-heading"><h2 id="service-mappings-title">发票服务映射</h2><p>为每个国家和运输方式填写一个发票服务名称，制作发票时按货件信息匹配。</p></header>
      <div className="service-mappings-toolbar">
        <form className="service-mappings-search" onSubmit={(event) => { event.preventDefault(); setSearch(searchDraft.trim()); }}>
          <div className="field"><label htmlFor="service-mapping-search">国家、运输方式或服务</label><Input id="service-mapping-search" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} maxLength={160} placeholder="输入搜索内容" /></div>
          <Button type="submit" icon={Search}>搜索</Button>
        </form>
        <div className="service-mappings-actions"><Button type="button" icon={Plus} variant="primary" onClick={() => { setNotice(''); setEditor('new'); }}>新增映射</Button><Button type="button" icon={RefreshCw} loading={list.isFetching} onClick={() => void list.refetch()}>刷新列表</Button></div>
      </div>
      {notice && <p className="permission-note success-note" role="status">{notice}</p>}
      {list.isPending ? <p className="list-state" role="status">正在读取发票服务映射…</p> : list.isError ? <QueryError error={list.error} retry={() => void list.refetch()} /> : rows.length === 0 ? <p className="list-state">{search ? '没有符合搜索条件的服务映射。请调整搜索内容。' : '还没有服务映射。点击“新增映射”，选择国家和运输方式并填写发票服务名称。'}</p> : <>
        <p className="service-mappings-summary">共 {rows.length} 条映射</p>
        <ScmDataGrid label="发票服务映射列表" rows={rows} columns={columns} getRowKey={(row) => row.id} frozenColCount={1} navigationPosition="bottom" rowSeriesNumber={false}
          renderRowMenu={(row, context) => <><div className="scm-record-menu-summary"><strong>{countryName(row.countryCode)} · {row.transportMethod}</strong><p>{row.service}</p><p>版本 {row.version}</p></div><div className="scm-record-menu-actions"><Button type="button" variant="text" role="menuitem" icon={Pencil} onClick={() => { context.close(); setNotice(''); setEditor(row); }}>编辑映射</Button><Button type="button" variant="text" role="menuitem" icon={Trash2} onClick={() => { context.close(); setNotice(''); setDeleting(row); }}>删除映射</Button></div></>} />
      </>}
    </section>
    {editor && <MappingEditor key={editor === 'new' ? 'new' : editor.id} mapping={editor === 'new' ? null : editor} mappings={list.data?.items ?? []} options={options.data} optionsError={options.error} optionsLoading={options.isFetching} retryOptions={() => void options.refetch()} close={() => setEditor(null)} saved={saved} refresh={refresh} />}
    {deleting && <MappingDelete key={deleting.id} mapping={deleting} countryName={countryName(deleting.countryCode)} close={() => setDeleting(null)} saved={(mapping) => saved(mapping, true)} refresh={refresh} />}
  </SettingsLayout>;
}

function MappingEditor({ mapping, mappings, options, optionsError, optionsLoading, retryOptions, close, saved, refresh }: {
  mapping: ServiceMapping | null; mappings: ServiceMapping[]; options: MappingOptions | undefined; optionsError: unknown; optionsLoading: boolean; retryOptions: () => void;
  close: () => void; saved: (mapping: ServiceMapping) => void; refresh: (id: string) => Promise<ServiceMapping>;
}) {
  const id = useId(), pending = useRef(false);
  const [baseline, setBaseline] = useState(mapping), [countryCode, setCountryCode] = useState(mapping?.countryCode ?? ''), [transportMethod, setTransportMethod] = useState(mapping?.transportMethod ?? ''), [service, setService] = useState(mapping?.service ?? '');
  const [operation, setOperation] = useState(newOperation), [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false), [error, setError] = useState<unknown>(null), [notice, setNotice] = useState('');
  const resetError = () => { setError(null); setNotice(''); setOperation(newOperation()); };
  const countries = options?.countries.items ?? [], methods = options?.transportMethods.items ?? [];
  const countryOptions = [{ value: '', label: '请选择国家' }, ...countries.map((country) => ({ value: country.code, label: `${country.name} · ${country.code}` })), ...countryCode && !countries.some((country) => country.code === countryCode) ? [{ value: countryCode, label: `${countryCode}（已保存）`, disabled: true }] : []];
  const methodOptions = [{ value: '', label: '请选择运输方式' }, ...methods.map((method) => ({ value: method.name, label: method.name + (method.enabled ? '' : '（已停用）'), disabled: !method.enabled })), ...transportMethod && !methods.some((method) => method.name === transportMethod) ? [{ value: transportMethod, label: `${transportMethod}（已保存）`, disabled: true }] : []];
  const countryUnchanged = Boolean(baseline && countryCode === baseline.countryCode), methodUnchanged = Boolean(baseline && transportMethod === baseline.transportMethod);
  const unavailable = Boolean(optionsError || options?.countries.status === 'unavailable' || options?.transportMethods.status === 'unavailable');
  const currentPair = Boolean(baseline && countryUnchanged && methodUnchanged);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || refreshing) return;
    if (!countryCode || !transportMethod.trim() || !service.trim()) { setError(new Error('请选择国家和运输方式，并填写发票服务名称。')); return; }
    if ((!countryUnchanged && (options?.countries.status !== 'available' || !countries.some((country) => country.code === countryCode))) || (!methodUnchanged && (options?.transportMethods.status !== 'available' || !methods.some((method) => method.name === transportMethod && method.enabled)))) { setError(new Error('请选择领星当前可用的国家和运输方式，或重试读取选项。')); return; }
    if (mappings.some((item) => !item.deletedAt && item.id !== baseline?.id && samePair(item, { countryCode, transportMethod }))) { setError(new Error('此国家和运输方式已有映射，请编辑已有映射。')); return; }
    pending.current = true; setBusy(true); setError(null);
    try {
      const input = { operationId: operation, countryCode, transportMethod: transportMethod.trim(), transportMethodId: methodUnchanged ? baseline?.transportMethodId ?? null : methods.find((method) => method.name === transportMethod)?.id ?? null, service: service.trim() };
      const result = baseline ? await serviceMappingApi.revise(baseline.id, { ...input, expectedVersion: baseline.version }) : await serviceMappingApi.create(input);
      saved(result.mapping);
    } catch (cause) { setError(cause); } finally { pending.current = false; setBusy(false); }
  };
  const reloadVersion = async () => {
    if (!baseline || refreshing || pending.current) return;
    setRefreshing(true);
    try { const current = await refresh(baseline.id); setBaseline(current); setOperation(newOperation()); setError(null); setNotice(`已读取服务器版本 ${current.version}，本次输入已保留。当前已保存的服务为“${current.service}”，请核对后再次保存。`); }
    catch (cause) { setError(cause); } finally { setRefreshing(false); }
  };
  return <Dialog open title={mapping ? '编辑发票服务映射' : '新增发票服务映射'} close={close} closeDisabled={busy || refreshing} className="service-mapping-dialog">
    <form className="service-mapping-form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy || refreshing}>
        <div className="service-mapping-pair">
          <div className="field"><label htmlFor={`${id}-country`}>国家</label><Combobox id={`${id}-country`} value={countryCode} onValueChange={(value) => { setCountryCode(value); resetError(); }} options={countryOptions} placeholder="请选择国家" searchPlaceholder="搜索国家…" emptyMessage="没有可用国家，请重试读取选项。" disabled={optionsLoading || options?.countries.status !== 'available'} required /></div>
          <div className="field"><label htmlFor={`${id}-method`}>运输方式</label><Combobox id={`${id}-method`} value={transportMethod} onValueChange={(value) => { setTransportMethod(value); resetError(); }} options={methodOptions} placeholder="请选择运输方式" searchPlaceholder="搜索运输方式…" emptyMessage="没有可用运输方式，请重试读取选项。" disabled={optionsLoading || options?.transportMethods.status !== 'available'} required /></div>
        </div>
        <div className="field"><label htmlFor={`${id}-service`}>发票服务名称</label><Input id={`${id}-service`} value={service} onChange={(event) => { setService(event.target.value); resetError(); }} maxLength={4000} required autoFocus /><p className="mapping-help">填写发票中需要显示的服务名称。</p></div>
      </fieldset>
      {optionsLoading ? <p className="mapping-help" role="status">正在读取领星国家和运输方式，已填写的内容会保留。</p> : unavailable ? <div className="service-mapping-conflict"><p className="form-note warning-note" role="status">{optionsError ? messageOf(optionsError) : [options?.countries.message, options?.transportMethods.message].filter(Boolean).join(' ') || '领星选项暂不可用。'}{baseline && ' 保持已保存的国家和运输方式时，仍可修改服务名称。'}</p><Button type="button" icon={RefreshCw} disabled={busy || refreshing} onClick={retryOptions}>重试领星选项</Button></div> : baseline && (!countries.some((country) => country.code === baseline.countryCode) || !methods.some((method) => method.name === baseline.transportMethod && method.enabled)) ? <p className="form-note warning-note" role="status">已保存的国家或运输方式当前不在领星可用目录中。可保持此组合修改服务名称，也可选择新的可用组合。</p> : null}
      {notice && <p className="form-note success-note" role="status">{notice}</p>}
      {error !== null && <div className="service-mapping-conflict"><p className="form-note error-note" role="alert">{messageOf(error)}</p>{isConflict(error) && baseline && <Button type="button" icon={RefreshCw} loading={refreshing} disabled={busy} onClick={() => void reloadVersion()}>读取最新版本并保留输入</Button>}</div>}
      <div className="service-mapping-form-footer"><Button type="button" disabled={busy || refreshing} onClick={close}>取消</Button><Button type="submit" variant="primary" icon={Save} loading={busy} loadingLabel="正在保存…" disabled={refreshing || !countryCode || !transportMethod || !service.trim() || (!currentPair && (optionsLoading || unavailable))}>保存映射</Button></div>
    </form>
  </Dialog>;
}

function MappingDelete({ mapping, countryName, close, saved, refresh }: { mapping: ServiceMapping; countryName: string; close: () => void; saved: (mapping: ServiceMapping) => void; refresh: (id: string) => Promise<ServiceMapping> }) {
  const pending = useRef(false);
  const [baseline, setBaseline] = useState(mapping), [operation, setOperation] = useState(newOperation), [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false), [error, setError] = useState<unknown>(null);
  const remove = async () => {
    if (pending.current || refreshing) return;
    pending.current = true; setBusy(true); setError(null);
    try { saved((await serviceMappingApi.delete(baseline.id, { operationId: operation, expectedVersion: baseline.version })).mapping); }
    catch (cause) { setError(cause); } finally { pending.current = false; setBusy(false); }
  };
  return <Dialog open title="删除发票服务映射" close={close} closeDisabled={busy || refreshing} className="service-mapping-dialog"><div className="service-mapping-form">
    <p className="service-mapping-delete-copy">删除后，新建发票将无法通过此组合自动匹配服务。已保存的发票保留原服务名称。</p>
    <div className="service-mapping-current"><p><strong>{countryName} · {baseline.transportMethod}</strong></p><p>{baseline.service}</p></div>
    {error !== null && <div className="service-mapping-conflict"><p className="form-note error-note" role="alert">{messageOf(error)}</p>{isConflict(error) && <Button type="button" icon={RefreshCw} loading={refreshing} disabled={busy} onClick={() => { setRefreshing(true); void refresh(baseline.id).then((current) => { setBaseline(current); setOperation(newOperation()); setError(null); }).catch(setError).finally(() => setRefreshing(false)); }}>读取最新版本后核对</Button>}</div>}
    <div className="service-mapping-form-footer"><Button type="button" disabled={busy || refreshing} onClick={close}>取消</Button><Button type="button" icon={Trash2} loading={busy} loadingLabel="正在删除…" disabled={refreshing} onClick={() => void remove()}>确认删除</Button></div>
  </div></Dialog>;
}
