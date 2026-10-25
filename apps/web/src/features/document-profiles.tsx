import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useSearch } from '@tanstack/react-router';
import { Download, FileSpreadsheet, Pencil, Plus, RefreshCw, Save, Upload, X } from 'lucide-react';
import type { DocumentProfile, DocumentProfileCategory } from '@scm/contracts';
import { api } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';
import { StatePage } from '../pages';
import { BatchTable, Check, downloadBlob, messageOf, QueryError, timestamp } from './batch-shared';
import { documentApi } from './document-api';
import { DocumentField } from './document-fields';
import { DocumentProductImage } from './document-product-image';
import { profileLabels, useDocumentAction } from './documents';
import { SettingsLayout } from './settings';
import './documents.css';

const profileFields: Record<DocumentProfileCategory, Array<{ key: string; label: string; type?: 'number' | 'url'; required?: boolean }>> = {
  product: [
    { key: 'sid', label: '店铺 SID', type: 'number', required: true }, { key: 'msku', label: 'MSKU', required: true }, { key: 'fnsku', label: 'FNSKU' }, { key: 'sku', label: 'SKU' },
    { key: 'englishName', label: '英文申报品名', required: true }, { key: 'chineseName', label: '中文申报品名', required: true }, { key: 'material', label: '材质', required: true }, { key: 'hsCode', label: 'HS 编码', required: true }, { key: 'use', label: '用途', required: true }, { key: 'brand', label: '品牌', required: true }, { key: 'model', label: '型号', required: true }, { key: 'unit', label: '申报单位（可选）' }, { key: 'unitPrice', label: '申报单价', type: 'number' }, { key: 'currency', label: '单价币种' }, { key: 'salesLink', label: '销售链接', type: 'url', required: true },
  ],
  party: [{ key: 'sid', label: '店铺 SID', type: 'number', required: true }, { key: 'companyName', label: '主体名称', required: true }, { key: 'englishName', label: '英文名称' }, { key: 'taxNumber', label: '税号' }, { key: 'address', label: '主体地址' }, { key: 'contact', label: '联系人' }, { key: 'phone', label: '联系电话' }, { key: 'email', label: '电子邮箱' }],
  address: [{ key: 'destinationFc', label: '目的仓代码', required: true }, { key: 'addressCode', label: '地址代码' }, { key: 'recipientName', label: '收件人', required: true }, { key: 'recipientCompany', label: '收件公司' }, { key: 'addressLine1', label: '地址第 1 行', required: true }, { key: 'addressLine2', label: '地址第 2 行' }, { key: 'addressLine3', label: '地址第 3 行' }, { key: 'city', label: '城市', required: true }, { key: 'state', label: '州 / 省' }, { key: 'postalCode', label: '邮编', required: true }, { key: 'countryCode', label: '国家代码', required: true }, { key: 'phone', label: '联系电话' }, { key: 'email', label: '电子邮箱' }],
  channel: [{ key: 'channel', label: '业务渠道', required: true }, { key: 'service', label: '渠道服务', required: true }, { key: 'currency', label: '币种', required: true }, { key: 'deliveryStation', label: '交货仓站' }, { key: 'customsMode', label: '报关方式' }, { key: 'clearanceMode', label: '清关方式' }, { key: 'tradeTerms', label: '贸易条款' }, { key: 'battery', label: '含电池' }, { key: 'magnetic', label: '含磁性' }, { key: 'liquid', label: '含液体' }, { key: 'powder', label: '含粉末' }, { key: 'dangerous', label: '危险品' }],
  tax: [{ key: 'sid', label: '店铺 SID', type: 'number' }, { key: 'countryCode', label: '目的国家', required: true }, { key: 'taxMode', label: '税务方式', required: true }, { key: 'vat', label: 'VAT' }, { key: 'currency', label: '币种', required: true }, { key: 'tradeTerms', label: '贸易条款' }],
};
const stringValue = (data: Record<string, unknown>, key: string) => data[key] === null || data[key] === undefined ? '' : String(data[key]);

export function DocumentProfilesRoute() {
  const search = useSearch({ strict: false });
  const documentId = typeof search.documentId === 'string' ? search.documentId : undefined;
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开单据资料" detail={messageOf(session.error)} action={<Button icon={RefreshCw} onClick={() => void session.refetch()}>重试</Button>} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <SettingsLayout user={session.data.user}>{documentId && <p className="mapping-help document-return-link"><Link to="/shipping" search={{ view: 'documents', documentId }}>返回当前发票草稿</Link> · 在草稿中重新采用资料版本并校验。</p>}<DocumentProfiles /></SettingsLayout>;
}

export function DocumentProfiles({ active = true }: { active?: boolean }) {
  const id = useId();
  const routeSearch = useSearch({ strict: false });
  const documentId = typeof routeSearch.documentId === 'string' ? routeSearch.documentId : undefined;
  const [category, setCategory] = useState<DocumentProfileCategory>('product');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<DocumentProfile | 'new' | null>(null);
  const profiles = useQuery({ queryKey: ['document-profiles'], queryFn: () => documentApi.profiles(), enabled: active, retry: false });
  const visible = (profiles.data ?? []).filter((profile) => profile.category === category && [profile.key, ...profileFields[category].map((field) => stringValue(profile.data, field.key))].join(' ').toLowerCase().includes(search.toLowerCase()));
  return <div className="document-profiles-workspace">
    <div className="document-page-heading"><div><h2>单据资料</h2><p className="mapping-help">维护商品申报、主体及渠道税务资料。收件地址在“收件地址”中统一管理。每次修改保留历史版本。</p></div>{!editing && category !== 'address' && <Button icon={Plus} variant="primary" onClick={() => setEditing('new')}>新增{profileLabels[category]}</Button>}</div>
    {editing ? <ProfileEditor key={editing === 'new' ? `new-${category}` : `${editing.id}-${editing.version}`} category={category} profile={editing === 'new' ? null : editing} close={() => setEditing(null)} /> : <section className="content-panel document-list-panel"><form className="document-settings-toolbar" onSubmit={(event) => event.preventDefault()}><div className="field"><label htmlFor={`${id}-category`}>资料分类</label><SelectField id={`${id}-category`} value={category} onValueChange={(value) => setCategory(value as DocumentProfileCategory)} options={Object.entries(profileLabels).map(([value, label]) => ({ value, label }))} /></div>{category !== 'address' && <><div className="field"><label htmlFor={`${id}-search`}>搜索资料</label><Input id={`${id}-search`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称、MSKU、SKU 或资料内容" /></div><IconButton icon={RefreshCw} label="刷新单据资料" loading={profiles.isFetching} onClick={() => void profiles.refetch()} /></>}</form>
      {category === 'address' ? <div className="document-empty"><h3>收件地址已统一管理</h3><p>在收件地址目录中搜索、查看、新增或编辑地址，也可删除及恢复地址，历史版本完整保留。</p><Link to="/settings/addresses" search={{ documentId }} className="primary-button">管理收件地址</Link></div> : profiles.isPending ? <p className="list-state" role="status">正在读取资料档案…</p> : profiles.isError ? <QueryError error={profiles.error} retry={() => void profiles.refetch()} /> : visible.length === 0 ? <p className="list-state">{search ? '没有找到匹配资料，请调整搜索词。' : `还没有${profileLabels[category]}资料。可新增资料，或从 XLSX 批量导入。`}</p> : <BatchTable label="单据资料" headers={['资料标识 / 版本', '关键字段', '状态 / 创建时间', '操作']}>{visible.map((profile) => <tr key={profile.id}><td><strong>{profile.key}</strong><small className="mapping-subtext">v{profile.version} · {profileLabels[profile.category]}</small></td><td>{profileFields[category].slice(0, 5).map((field) => <small className="mapping-subtext" key={field.key}>{field.label}：{stringValue(profile.data, field.key) || '—'}</small>)}</td><td>{profile.status === 'active' ? '使用中' : '已撤销'}<small className="mapping-subtext">{timestamp(profile.createdAt)}</small></td><td><Button icon={Pencil} onClick={() => setEditing(profile)}>建立新版本</Button><AssetManagement kind="profiles" id={profile.id} version={profile.version} status={profile.status} /></td></tr>)}</BatchTable>}
    </section>}
    {!editing && category !== 'address' && <ProfileImports category={category} />}
    {!editing && <DocumentTemplates active={active} />}
  </div>;
}

function ProfileEditor({ category, profile, close }: { category: DocumentProfileCategory; profile: DocumentProfile | null; close: () => void }) {
  const id = useId();
  const [key, setKey] = useState(profile?.key || '');
  const [data, setData] = useState<Record<string, unknown>>(profile?.data || {});
  const [reason, setReason] = useState(profile ? '更新单据资料' : '新增单据资料');
  const [imageBusy, setImageBusy] = useState(false);
  const action = useDocumentAction();
  const busy = action.busy || imageBusy;
  const fieldOptions = useQuery({ queryKey: ['document-field-options'], queryFn: documentApi.fieldOptions, enabled: category === 'channel', retry: false });
  const setValue = (name: string, value: string) => setData((current) => ({ ...current, [name]: name === 'sid' && value ? Number(value) : value, ...(name === 'unitPrice' || name === 'currency' ? { unitPriceConfirmed: 'false' } : {}) }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { ...(profile ? { expectedVersion: profile.version } : {}), category, key: key.trim(), data, reason: reason.trim() };
    action.run(`profile:${JSON.stringify(input)}`, (operationId) => documentApi.writeProfile({ operationId, ...input }), '资料版本已保存。', close);
  };
  return <form className="content-panel document-settings-form" onSubmit={submit}><div className="section-heading"><h3>{profile ? `建立${profileLabels[category]}新版本` : `新增${profileLabels[category]}`}</h3><Button type="button" icon={X} disabled={busy} onClick={close}>返回资料列表</Button></div><p className="mapping-help">标有 * 的内容用于保存当前资料。也可直接补齐本票出单字段，无需先建立公共资料；更改公共资料不会覆盖已保存的单据快照。</p><div className="field document-title-field"><label htmlFor={`${id}-key`}>资料标识 *</label><Input id={`${id}-key`} value={key} maxLength={200} required disabled={busy} onChange={(event) => setKey(event.target.value)} placeholder={category === 'product' ? '例如：店铺 SID / MSKU / FNSKU / SKU' : '为这组资料填写稳定且便于查找的名称'} /></div><div className="document-form-grid">{profileFields[category].map((field) => <div className="field" key={field.key}><label htmlFor={`${id}-${field.key}`}>{field.label}{field.required ? ' *' : ''}</label><DocumentField id={`${id}-${field.key}`} fieldKey={field.key} required={field.required} type={field.type || 'text'} min={field.type === 'number' ? field.key === 'sid' ? 1 : 0 : undefined} step={field.type === 'number' && field.key !== 'sid' ? 'any' : undefined} value={stringValue(data, field.key)} disabled={busy} onValueChange={(value) => setValue(field.key, value)} services={fieldOptions.data?.services} servicesLoading={fieldOptions.isFetching} servicesError={fieldOptions.isError} retryServices={() => void fieldOptions.refetch()} /></div>)}</div>
    {category === 'product' && <><DocumentProductImage imageBase64={stringValue(data, 'imageBase64')} disabled={busy} onBusyChange={setImageBusy} change={(image) => setData((current) => ({ ...current, imageBase64: image?.imageBase64 ?? '', imageExtension: image?.imageExtension ?? '' }))} /><div className="document-price-confirm"><Check checked={data.unitPriceConfirmed === true || data.unitPriceConfirmed === 'true'} disabled={busy} onChange={(checked) => setData((current) => ({ ...current, unitPriceConfirmed: checked ? 'true' : 'false' }))}>已核对并确认本资料中的申报单价与币种</Check><p className="mapping-help">此价格与确认仅供历史发票规则使用。新建和更正发票按领星 Listing 普通售价 × 20% 自动计算，不采用本资料的手填价格；标准箱规件数也通过领星查询采用。</p></div></>}
    <div className="field document-reason"><label htmlFor={`${id}-reason`}>修改原因 *</label><Input id={`${id}-reason`} value={reason} required maxLength={1000} disabled={busy} onChange={(event) => setReason(event.target.value)} /></div>{action.feedback}<div className="document-footer-actions"><Button type="submit" icon={Save} variant="primary" loading={action.busy} disabled={!key.trim() || !reason.trim() || busy || action.conflict}>保存资料版本</Button><Button type="button" disabled={busy} onClick={close}>返回列表</Button></div></form>;
}

function DocumentTemplates({ active }: { active: boolean }) {
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('丰信 B2B 单票模板');
  const [reason, setReason] = useState('新增受控模板');
  const [fileError, setFileError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [expectedVersion, setExpectedVersion] = useState<number | undefined>();
  const action = useDocumentAction();
  const templates = useQuery({ queryKey: ['document-templates'], queryFn: documentApi.templates, enabled: active, retry: false });
  return <section className="content-panel document-templates"><div className="section-heading"><div><h3>单据模板</h3><p>模板保存在受控文件目录，采用具体版本生成发票。</p></div><IconButton icon={RefreshCw} label="刷新单据模板" loading={templates.isFetching} onClick={() => void templates.refetch()} /></div>{templates.isPending ? <p className="list-state">正在读取单据模板…</p> : templates.isError ? <QueryError error={templates.error} retry={() => void templates.refetch()} /> : templates.data.length === 0 ? <p className="list-state">尚未上传受控 XLSX 模板。</p> : <BatchTable label="单据模板" headers={['模板名称 / 版本', '状态', '文件哈希', '上传时间', '管理']}>{templates.data.map((template) => <tr key={`${template.id}-${template.version}`}><td><strong>{template.name}</strong><small className="mapping-subtext">v{template.version}</small></td><td>{template.status === 'active' ? '使用中' : '已撤销'}</td><td className="document-hash">{template.sha256}</td><td>{timestamp(template.createdAt)}</td><td><AssetManagement kind="templates" id={template.id} version={template.version} status={template.status} beginVersion={() => { setName(template.name); setExpectedVersion(template.version); setReason('更新受控模板版本'); setUploadOpen(true); }} /></td></tr>)}</BatchTable>}<details className="document-field-group" open={uploadOpen} onToggle={(event) => setUploadOpen(event.currentTarget.open)}><summary>上传受控模板</summary><form onSubmit={(event) => { event.preventDefault(); if (file) action.run(`template:${file.name}:${file.size}:${name}:${reason}:${expectedVersion}`, (operationId) => documentApi.uploadTemplate(file, { operationId, purpose: 'invoice', name: name.trim(), reason: reason.trim(), ...(expectedVersion !== undefined ? { expectedVersion } : {}) }), '受控模板版本已保存。', () => { setFile(null); setExpectedVersion(undefined); }); }}><div className="document-form-grid"><div className="field"><label htmlFor={`${id}-name`}>模板名称</label><Input id={`${id}-name`} required maxLength={200} value={name} onChange={(event) => { setName(event.target.value); setExpectedVersion(undefined); }} disabled={action.busy} /></div><div className="field"><label htmlFor={`${id}-file`}>XLSX 模板</label><input id={`${id}-file`} type="file" accept=".xlsx" className="document-file-input" disabled={action.busy} onChange={(event) => { const next = event.target.files?.[0]; setFileError(next && !/\.xlsx$/i.test(next.name) ? '请选择 XLSX 模板文件。' : ''); setFile(next && /\.xlsx$/i.test(next.name) ? next : null); }} /></div><div className="field"><label htmlFor={`${id}-reason`}>上传原因</label><Input id={`${id}-reason`} required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={action.busy} /></div></div><p className="mapping-help">使用清理后的丰信主表模板。上传后由服务端清除旧订单、地址和商品内容；正式接收系统导入仍需单独验收。</p>{fileError && <p className="form-note error-note" role="alert">{fileError}</p>}{action.feedback}<div className="document-footer-actions"><Button icon={Upload} type="submit" variant="primary" loading={action.busy} disabled={!file || !name.trim() || !reason.trim() || action.busy}>上传模板版本</Button></div></form></details></section>;
}

function ProfileImports({ category }: { category: DocumentProfileCategory }) {
  return <section className="content-panel document-profile-imports"><div className="section-heading"><div><h3>批量导入{profileLabels[category]}</h3><p>使用 XLSX 预检资料，核对错误与变化后确认提交。</p></div><FileSpreadsheet size={20} aria-hidden="true" /></div><ProfileImportForm category={category} /></section>;
}

function ProfileImportForm({ category }: { category: DocumentProfileCategory }) {
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ProfileImportPreview | null>(null);
  const [fileError, setFileError] = useState('');
  const action = useDocumentAction();
  const columns = ['category', 'key', ...profileFields[category].map((field) => field.key), ...(category === 'product' ? ['unitPriceConfirmed', 'imageBase64', 'imageExtension'] : [])];
  const choose = (next: File | undefined) => { setPreview(null); if (next && !/\.xlsx$/i.test(next.name)) { setFile(null); setFileError('请选择 XLSX 文件。'); } else { setFile(next || null); setFileError(''); } };
  return <>
    <p className="mapping-help">下载模板填写；资料分类使用 product、party、address、channel 或 tax。同分类、同资料标识将建立新版本。</p>
    <details className="document-field-group"><summary>查看{profileLabels[category]}列名</summary><p className="mapping-help">{columns.join('、')}</p></details>
    <div className="document-settings-toolbar"><div className="field"><label htmlFor={`${id}-file`}>资料 XLSX</label><input id={`${id}-file`} type="file" accept=".xlsx" disabled={action.busy} className="document-file-input" onChange={(event) => choose(event.target.files?.[0])} /></div><Button icon={Download} disabled={action.busy} onClick={() => action.run('profile-import-template', () => downloadBlob(documentApi.profileTemplate(), '单据资料导入模板.xlsx'), '导入模板下载已开始。')}>下载导入模板</Button><Button icon={Upload} loading={action.pendingKey?.startsWith('profile-preview:')} disabled={!file || action.busy} onClick={() => { if (file) action.run(`profile-preview:${category}:${file.name}:${file.size}`, (operationId) => documentApi.previewProfiles(file, { operationId }), '预检已完成，请核对下方变化。', (value) => setPreview(value as ProfileImportPreview)); }}>预检导入</Button></div>
    {fileError && <p className="form-note error-note" role="alert">{fileError}</p>}{action.feedback}
    {preview && <div className="document-import-preview"><div className="section-heading"><h4>导入预检</h4><span>{preview.rows.length} 行 · {preview.rows.reduce((count, row) => count + row.errors.length, 0)} 个错误</span></div>
      <BatchTable label="资料导入变化" headers={['行号 / 资料标识', '变化与错误', '字段内容']}>{preview.rows.map((item, index) => <tr key={`${item.key}-${index}`}><td>第 {item.row} 行<small className="mapping-subtext">{profileLabels[item.category] || item.category} · {item.key}</small></td><td>{item.changes.map((change, changeIndex) => <small className="mapping-subtext" key={changeIndex}>{change}</small>)}{item.errors.map((error, errorIndex) => <small className="mapping-subtext error-note" key={errorIndex}>{error}</small>)}{item.changes.length === 0 && item.errors.length === 0 && '无变化'}</td><td>{Object.entries(item.data).filter(([key]) => key !== 'imageBase64').slice(0, 8).map(([key, value]) => <small className="mapping-subtext" key={key}>{profileFields[item.category]?.find((field) => field.key === key)?.label || key}：{String(value ?? '')}</small>)}</td></tr>)}</BatchTable>
      <div className="document-footer-actions"><Button icon={Save} variant="primary" disabled={action.busy || !preview.valid || !file || preview.rows.length === 0} loading={action.pendingKey?.startsWith('profile-commit:')} onClick={() => { if (file) action.run(`profile-commit:${preview.previewId}`, (operationId) => documentApi.commitProfiles({ operationId, previewId: preview.previewId, sha256: preview.sha256 }), '资料批量导入已完成。', () => setPreview(null)); }}>确认提交资料变化</Button></div>
    </div>}
  </>;
}

export interface ProfileImportPreview {
  previewId: string;
  sha256: string;
  rows: Array<{ row: number; category: DocumentProfileCategory; key: string; expectedVersion?: number; data: Record<string, unknown>; errors: string[]; changes: string[] }>;
  valid: boolean;
}

function AssetManagement({ kind, id: assetId, version, status, beginVersion }: { kind: 'profiles' | 'templates'; id: string; version: number; status: 'active' | 'retired'; beginVersion?: () => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [retireReason, setRetireReason] = useState('');
  const action = useDocumentAction();
  const history = useQuery({ queryKey: ['document-asset-history', kind, assetId, version], queryFn: () => documentApi.assetHistory(kind, assetId), enabled: open, retry: false });
  return <div className="document-asset-management">{beginVersion && <Button type="button" icon={Upload} onClick={beginVersion}>上传新版本</Button>}<details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>版本历史与撤销</summary>{open && <>{history.isPending ? <p className="mapping-help" role="status">正在读取版本历史…</p> : history.isError ? <QueryError error={history.error} retry={() => void history.refetch()} /> : <div className="document-asset-history">{history.data.map((entry) => <div key={entry.id}><strong>v{entry.version} · {timestamp(entry.createdAt)}</strong><small className="mapping-subtext">{entry.reason} · {entry.createdBy}</small>{kind === 'templates' && <Button type="button" icon={Download} disabled={action.busy} onClick={() => action.run(`template-download:${assetId}:${entry.version}`, () => downloadBlob(documentApi.downloadTemplate(assetId, entry.version), `单据模板-v${entry.version}.xlsx`), '模板版本下载已开始。')}>下载此版本</Button>}</div>)}</div>}{status === 'active' && <><div className="field document-reason"><label htmlFor={`${id}-retire`}>撤销原因</label><Input id={`${id}-retire`} maxLength={1000} value={retireReason} onChange={(event) => setRetireReason(event.target.value)} disabled={action.busy} /></div><p className="mapping-help">撤销后已有引用将失效，历史文件保留。请填写原因后明确提交。</p><Button type="button" icon={X} disabled={action.busy || !retireReason.trim()} onClick={() => action.run(`retire:${kind}:${assetId}:${version}:${retireReason}`, (operationId) => documentApi.retireAsset(kind, assetId, { operationId, expectedVersion: version, reason: retireReason.trim() }), '当前资料版本已撤销。')}>确认撤销{kind === 'profiles' ? '资料' : '模板'}</Button></>}{action.feedback}</>}</details></div>;
}
