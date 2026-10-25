import {
  manualSellerCreateSchema, type SellerCatalogModeInput, type SellerCatalogSettings,
  type SellerCatalogSyncInput, type SellerMapping,
} from '@scm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Save } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { LingxingProgress } from './lingxing-progress';

export const catalogModeLabels = { lingxing: '领星实际店铺', manual: '人工维护' } as const;
export const catalogTimestamp = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value));
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
function operationId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function SellerSourceSetting({ settings, refreshing, refresh, changed, onBusyChange }: {
  settings: SellerCatalogSettings; refreshing: boolean; refresh: () => void;
  changed: (settings: SellerCatalogSettings) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draftMode, setDraftMode] = useState<SellerCatalogSettings['mode'] | null>(null);
  const [pendingMode, setPendingMode] = useState<SellerCatalogModeInput | null>(null);
  const [pendingSync, setPendingSync] = useState<SellerCatalogSyncInput | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mode = useMutation({ mutationKey: ['seller-catalog-update'], networkMode: 'always', mutationFn: api.setSellerCatalogMode, onSuccess: (result) => {
    changed(result.settings); setDraftMode(null); setPendingMode(null); setPendingSync(null); setNotice(`${result.replayed ? '已恢复原保存结果。' : '来源设置已保存。'}当前使用${catalogModeLabels[result.settings.mode]}。`);
  } });
  const sync = useMutation({ mutationKey: ['seller-catalog-update'], networkMode: 'always', mutationFn: api.syncSellerCatalog, onSuccess: (result) => {
    changed(result.settings); setPendingSync(null); setNotice(`${result.replayed ? '已恢复原同步结果。' : '领星实际店铺已同步。'}共 ${result.total} 家，新增 ${result.inserted} 家，更新 ${result.updated} 家。`);
  }, onError: () => { refresh(); } });
  const sessionExpired = [mode.error, sync.error].some((error) => error instanceof ApiError && error.status === 401);
  useEffect(() => { if (sessionExpired) void queryClient.invalidateQueries({ queryKey: ['session'] }); }, [sessionExpired, queryClient]);
  const busy = mode.isPending || sync.isPending;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const selectedMode = draftMode ?? settings.mode;
  const refreshSettings = () => { setDraftMode(null); setPendingMode(null); setPendingSync(null); mode.reset(); sync.reset(); setNotice(null); refresh(); };
  return <section className="content-panel seller-source-setting" aria-labelledby="seller-source-title">
      <div className="section-heading panel-heading"><div><h3 id="seller-source-title">选择店铺数据来源</h3><p>领星可用店铺目录自动批准，店铺身份由领星提供；也可切换为人工维护。切换后，导入页需要重新确认来源。</p></div><Button icon={RefreshCw} loading={refreshing} type="button" variant="text" disabled={busy || refreshing} onClick={refreshSettings}>刷新来源设置</Button></div>
      <fieldset className="seller-source-options" disabled={busy}><legend>选择店铺来源</legend>{(['lingxing', 'manual'] as const).map((value) => <label key={value} className={selectedMode === value ? 'seller-source-option selected' : 'seller-source-option'}><input type="radio" name="seller-catalog-mode" value={value} checked={selectedMode === value} onChange={() => { setDraftMode(value); setPendingMode(null); setNotice(null); mode.reset(); }} /><span><strong>{catalogModeLabels[value]}</strong><small>{value === 'lingxing' ? '同步领星可用店铺后自动批准，身份信息只读；本地别名和停用状态可维护。' : '人工维护 sid、显示名称和国家，核对身份并批准后用于需求导入。'}</small></span></label>)}</fieldset>
      <div className="seller-source-actions"><Button icon={Save} loading={mode.isPending} loadingLabel="正在保存来源…" type="button" variant="primary" disabled={busy || (selectedMode === settings.mode && !pendingMode)} onClick={() => {
        const input = pendingMode ?? { operationId: operationId(), expectedVersion: settings.version, mode: selectedMode };
        setPendingMode(input); mode.mutate(input);
      }}>保存店铺来源</Button><span>当前生效：{catalogModeLabels[settings.mode]} · 设置版本 {settings.version} · 目录版本 {settings.catalogVersion}</span></div>
      {notice && <p className="permission-note success-note" role="status">{notice}</p>}
      {mode.isError && <SourceFeedback error={mode.error} refresh={refreshSettings} />}
      {settings.mode === 'lingxing' && <div className="seller-source-sync"><div><h3>领星实际店铺目录</h3><p>可用店铺同步后自动批准，本地已停用的店铺保持停用。店铺编号、名称和国家等身份信息只读，仅查询领星店铺列表。</p><p>最近成功同步：{settings.lastSyncedAt ? `${catalogTimestamp(settings.lastSyncedAt)}（上海）` : '尚未同步'}</p>{!settings.configured && <p className="warning-note">服务端尚未配置领星连接，请配置后同步。</p>}{settings.lastError && <p className="error-note" role="alert">最近同步失败：{settings.lastError.message}。当前保留最近成功获取的店铺目录。</p>}</div><Button icon={RefreshCw} loading={sync.isPending} loadingLabel="正在同步实际店铺…" type="button" disabled={busy || !settings.configured} onClick={() => {
        const input = pendingSync ?? { operationId: operationId(), expectedVersion: settings.version };
        setPendingSync(input); setNotice(null); sync.mutate(input);
      }}>同步领星实际店铺</Button></div>}
      {settings.mode === 'lingxing' && !sync.isIdle && <LingxingProgress label="领星店铺目录同步" status={sync.isPending ? 'running' : sync.isError ? 'failed' : 'completed'} startedAt={sync.submittedAt} detail={sync.isPending ? '正在获取领星店铺目录并保存结果，请等待响应。' : sync.isSuccess ? `已读取 ${sync.data.total} 家店铺。` : '最近成功获取的目录仍保留，可核对后重试。'} />}
      {settings.mode === 'lingxing' && sync.isError && <SourceFeedback error={sync.error} refresh={refreshSettings} />}
    </section>;
}

export function ManualSellerCreate({ created, refresh, onBusyChange }: { created: (mapping: SellerMapping) => void; refresh: () => void; onBusyChange?: (busy: boolean) => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ sid: '', name: '', country: '' });
  const [currentOperation, setCurrentOperation] = useState(operationId);
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutation = useMutation({ networkMode: 'always', mutationFn: api.createManualSeller, onSuccess: (result) => { created(result.mapping); setDraft({ sid: '', name: '', country: '' }); setCurrentOperation(operationId()); }, onError: (error) => { if (error instanceof ApiError && error.status === 401) void queryClient.invalidateQueries({ queryKey: ['session'] }); } });
  useEffect(() => {
    onBusyChange?.(mutation.isPending);
    return () => onBusyChange?.(false);
  }, [mutation.isPending, onBusyChange]);
  const change = (field: keyof typeof draft, value: string) => { setDraft((current) => ({ ...current, [field]: value })); setCurrentOperation(operationId()); setValidationError(null); mutation.reset(); };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (mutation.isPending) return;
    const parsed = manualSellerCreateSchema.safeParse({ operationId: currentOperation, sid: /^\d+$/.test(draft.sid.trim()) ? Number(draft.sid) : NaN, name: draft.name, country: draft.country });
    if (!parsed.success) { setValidationError('请填写有效的正整数店铺编号、显示名称和国家。'); return; }
    setValidationError(null); mutation.mutate(parsed.data);
  };
  return <section className="content-panel" aria-labelledby="manual-seller-title"><div className="section-heading panel-heading"><div><h3 id="manual-seller-title">填写店铺身份</h3><p>填写实际店铺 sid。此编号与 FBA 共同识别需求；店铺被使用后编号将锁定。</p></div></div><form className="manual-seller-form" onSubmit={submit}><div className="field"><label htmlFor="manual-seller-sid">店铺编号（sid）</label><Input id="manual-seller-sid" inputMode="numeric" value={draft.sid} maxLength={10} required disabled={mutation.isPending} onChange={(event) => change('sid', event.target.value)} /></div><div className="field"><label htmlFor="manual-seller-name">显示名称</label><Input id="manual-seller-name" value={draft.name} maxLength={160} required disabled={mutation.isPending} onChange={(event) => change('name', event.target.value)} /></div><div className="field"><label htmlFor="manual-seller-country">国家</label><Input id="manual-seller-country" value={draft.country} maxLength={80} required disabled={mutation.isPending} onChange={(event) => change('country', event.target.value)} /></div><Button icon={Plus} loading={mutation.isPending} loadingLabel="正在新增店铺…" type="submit" variant="primary">新增人工店铺</Button>{validationError && <p className="form-note error-note" role="alert">{validationError}</p>}{mutation.isError && <SourceFeedback error={mutation.error} refresh={refresh} />}</form></section>;
}

function SourceFeedback({ error, refresh }: { error: unknown; refresh: () => void }) {
  return <div className="inline-error" role="alert"><div><p>{messageOf(error)}</p>{error instanceof ApiError && error.status === 0 && <p>当前输入与操作编号已保留，可再次点击相同操作重试。</p>}{error instanceof ApiError && error.status === 409 && <p>请刷新来源设置和目录，核对当前版本后重试。</p>}</div>{error instanceof ApiError && error.status === 409 && <Button icon={RefreshCw} type="button" onClick={refresh}>刷新来源设置</Button>}</div>;
}
