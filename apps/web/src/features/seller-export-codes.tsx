import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { RefreshCw, Save } from 'lucide-react';
import { invoiceFilenamePart, sellerExportCodeInputSchema, sellerExportCodeListSchema, sellerExportCodeResultSchema, type SellerExportCode } from '@scm/contracts';
import { api, request, type User } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { StatePage } from '../pages';
import { messageOf, newOperation, QueryError } from './batch-shared';
import { SettingsLayout } from './settings';
import './seller-export-codes.css';

const base = '/api/v1/seller-mappings/export-codes';
export function SellerExportCodesRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开店铺导出代号" detail={messageOf(session.error)} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <SellerExportCodes user={session.data.user} />;
}

function SellerExportCodes({ user }: { user: User }) {
  const list = useQuery({ queryKey: ['seller-export-codes'], queryFn: async () => sellerExportCodeListSchema.parse(await request(base)), retry: false, refetchOnWindowFocus: false });
  const [search, setSearch] = useState(''), [notice, setNotice] = useState('');
  const rows = (list.data?.items ?? []).filter((row) => [row.name, row.country, String(row.sid), row.code].some((value) => value.toLowerCase().includes(search.trim().toLowerCase())));
  return <SettingsLayout user={user}><section aria-labelledby="export-codes-title">
    <header className="settings-section-heading"><h2 id="export-codes-title">店铺导出代号</h2><p>代号最多 20 个字符，支持数字、字母、中文和符号，用于新生成的单票发票和整批压缩包文件名。留空使用店铺名，001 等前导零会保留；已归档文件保留原名称。Windows 文件名禁用字符会在文件名中替换为 _，保存的代号不变。</p></header>
    <div className="seller-directory-toolbar"><div className="field"><label htmlFor="export-code-search">搜索店铺、国家、SID 或代号</label><Input id="export-code-search" value={search} maxLength={160} onChange={(event) => setSearch(event.target.value)} /></div><Button icon={RefreshCw} loading={list.isFetching} onClick={() => void list.refetch()}>刷新列表</Button></div>
    {list.isPending ? <p role="status">正在读取店铺…</p> : list.isError ? <QueryError error={list.error} retry={() => void list.refetch()} /> : <>
      <p className="mapping-help">共 {rows.length} 家店铺 · 修改后请逐行保存</p>
      {notice && <p className="success-note" role="status">{notice}</p>}
      <div className="export-code-list">{rows.map((row) => <ExportCodeRow key={`${row.sid}:${row.version}`} row={row} saved={() => { setNotice(`${row.name} 的导出代号已保存。`); void list.refetch(); }} />)}</div>
      {!rows.length && <p role="status">{list.data.items.length ? '没有匹配的店铺，请调整搜索内容。' : '尚无店铺，请先在店铺映射中同步或添加店铺。'}</p>}
    </>}
  </section></SettingsLayout>;
}

function ExportCodeRow({ row, saved }: { row: SellerExportCode; saved: () => void }) {
  const [code, setCode] = useState(row.code), [version, setVersion] = useState(row.version), [stored, setStored] = useState(row.code);
  const [operationId, setOperationId] = useState(newOperation), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = sellerExportCodeInputSchema.safeParse({ operationId, expectedVersion: version, code });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '请填写最多 20 个字符的代号，或留空恢复店铺名。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = sellerExportCodeResultSchema.parse(await request(`${base}/${row.sid}`, { method: 'POST', body: JSON.stringify(parsed.data) }));
      setCode(result.code); setStored(result.code); setVersion(result.version); setOperationId(newOperation()); setNotice('已保存'); saved();
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); }
  };
  const id = `export-code-${row.sid}`;
  return <form className="export-code-row" aria-label={`${row.name} 导出代号`} onSubmit={(event) => void submit(event)}>
    <div className="export-code-identity"><strong>{row.name}</strong><small>{row.country} · SID {row.sid}</small></div>
    <div className="field"><label htmlFor={id}>导出代号</label><Input id={id} value={code} maxLength={20} disabled={busy} aria-describedby={`${id}-preview${error ? ` ${id}-error` : ''}`} aria-invalid={Boolean(error)} onChange={(event) => { setCode(event.target.value); setOperationId(newOperation()); setError(''); setNotice(''); }} /><small id={`${id}-preview`}>文件名店铺部分：{invoiceFilenamePart(code.trim() || row.name, '未填店铺')}</small></div>
    <Button icon={Save} type="submit" loading={busy} disabled={busy || code === stored}>保存</Button>
    {error && <p id={`${id}-error`} className="error-note export-code-feedback" role="alert">{error} 请保留内容重试；若版本冲突，请刷新列表后核对。</p>}{notice && <p className="success-note export-code-feedback" role="status">{notice}</p>}
  </form>;
}
