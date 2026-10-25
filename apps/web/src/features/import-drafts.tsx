import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FilePenLine, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { ImportDialog } from './import-dialog';
import { importDraftApi, type ImportDraft, type ImportDraftSummary } from './import-draft-api';
import { ErrorFeedback, messageOf, Pagination, timestamp } from './import-source';
import './import-drafts.css';

type DraftAction = { kind: 'rename' | 'delete'; draft: ImportDraftSummary };

export function ImportDrafts({ active, openDraft }: { active: boolean; openDraft: (draft: ImportDraft) => void }) {
  const client = useQueryClient();
  const searchId = useId();
  const titleId = useId();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<DraftAction | null>(null);
  const [title, setTitle] = useState('');
  const [notice, setNotice] = useState('');
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  const list = useQuery({
    queryKey: ['import-drafts', search, page], queryFn: () => importDraftApi.list(search, page, 20),
    enabled: active, retry: false, placeholderData: (previous) => previous,
  });
  const detail = useQuery({
    queryKey: ['import-draft', action?.draft.id], queryFn: () => importDraftApi.get(action!.draft.id),
    enabled: active && action !== null, retry: false,
  });
  const open = useMutation({
    networkMode: 'always', mutationFn: (id: string) => importDraftApi.get(id),
    onSuccess: (draft) => { if (activeRef.current) openDraft(draft); },
  });
  const rename = useMutation({
    networkMode: 'always',
    mutationFn: ({ draft, name }: { draft: ImportDraft; name: string }) => importDraftApi.save(draft.id, { expectedVersion: draft.version, title: name, content: draft.content }),
    onSuccess: () => { setAction(null); void client.invalidateQueries({ queryKey: ['import-drafts'] }); },
  });
  const remove = useMutation({
    networkMode: 'always', mutationFn: (draft: ImportDraft) => importDraftApi.remove(draft.id, draft.version),
    onSuccess: () => {
      setAction(null);
      if (list.data?.items.length === 1 && page > 1) setPage((current) => current - 1);
      void client.invalidateQueries({ queryKey: ['import-drafts'] });
    },
  });
  useEffect(() => {
    if ([list.error, detail.error, open.error, rename.error, remove.error].some((error) => error instanceof ApiError && error.status === 401)) void client.invalidateQueries({ queryKey: ['session'] });
  }, [list.error, detail.error, open.error, rename.error, remove.error, client]);
  const manage = (kind: DraftAction['kind'], draft: ImportDraftSummary) => {
    setTitle(draft.title); setNotice(''); rename.reset(); remove.reset(); setAction({ kind, draft });
    void client.invalidateQueries({ queryKey: ['import-draft', draft.id] });
  };
  const pending = rename.isPending || remove.isPending;
  const mutationError = action?.kind === 'rename' ? rename.error : remove.error;
  const conflict = mutationError instanceof ApiError && mutationError.code === 'VERSION_CONFLICT';
  const closeAction = () => { if (!pending) setAction(null); };
  const reloadDetail = async () => {
    setNotice('');
    const result = await detail.refetch();
    if (result.isSuccess) {
      rename.reset(); remove.reset();
      setNotice(action?.kind === 'rename' ? '已读取最新草稿，填写的名称已保留。请核对后保存。' : '已读取最新草稿。请核对后确认删除。');
    }
  };
  const find = (event: FormEvent) => { event.preventDefault(); setSearch(input.trim()); setPage(1); open.reset(); };
  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (detail.data && title.trim() && !pending && !conflict) rename.mutate({ draft: detail.data, name: title.trim() });
  };
  return <section className="import-drafts" aria-labelledby="import-drafts-title">
    <div className="section-heading panel-heading"><div><h3 id="import-drafts-title">已保存草稿</h3><p>查找未完成的导入，继续填写或核对。每次新建导入从空白开始。</p></div><IconButton type="button" icon={RefreshCw} label="刷新草稿箱" loading={list.isFetching} onClick={() => void list.refetch()} /></div>
    <form className="import-drafts-search" role="search" aria-label="查询导入草稿" onSubmit={find}>
      <div className="field"><label htmlFor={searchId}>搜索草稿</label><Input id={searchId} maxLength={200} placeholder="草稿名称或 FBA" value={input} onChange={(event) => setInput(event.target.value)} /></div>
      <Button type="submit" icon={Search} loading={list.isFetching}>查询</Button>
      {search && <Button type="button" variant="text" onClick={() => { setInput(''); setSearch(''); setPage(1); }}>清除搜索</Button>}
    </form>
    {open.isError && <p className="form-note error-note" role="alert">{messageOf(open.error)} 请刷新草稿箱后重新打开。</p>}
    {list.isPending ? <p className="list-state" role="status">正在读取草稿箱…</p> : list.isError ? <ErrorFeedback title="草稿箱暂时不可用" error={list.error} retry={() => void list.refetch()} /> : list.data.items.length === 0 ? <div className="import-drafts-empty"><FilePenLine size={24} aria-hidden="true" /><h4>{search ? '没有找到匹配草稿' : '草稿箱为空'}</h4><p>{search ? '换一个草稿名称或 FBA 搜索，也可清除搜索查看全部。' : '填写导入时，可点击“保存到草稿箱”；退出时也可以选择保存，之后在这里继续。'}</p></div> : <>
      <div className="table-scroll" role="region" aria-label="导入草稿表，可横向滚动" tabIndex={0} aria-busy={list.isFetching}>
        <table className="task-table import-drafts-table"><thead><tr><th scope="col">草稿名称</th><th scope="col">导入方式 / 进度</th><th scope="col">最后保存（上海）</th><th scope="col">操作</th></tr></thead><tbody>{list.data.items.map((draft) => <tr key={draft.id}>
          <td><strong>{draft.title}</strong><small className="mapping-subtext">{draft.rowCount === null ? '文件草稿' : `${draft.rowCount} 行填写内容`}</small></td>
          <td>{draft.source === 'online' ? '在线表格' : draft.source === 'file' ? '表格文件' : '待选择方式'}<small className="mapping-subtext">{draft.importId ? '已接收，可继续核对' : '待提交导入'}</small></td>
          <td className="time-cell">{timestamp(draft.updatedAt)}</td>
          <td><div className="import-draft-actions"><Button type="button" icon={ArrowRight} loading={open.isPending && open.variables === draft.id} disabled={open.isPending} onClick={() => { open.reset(); open.mutate(draft.id); }}>继续编辑</Button><IconButton type="button" icon={Pencil} label="重命名草稿" description={draft.title} disabled={open.isPending} onClick={() => manage('rename', draft)} /><IconButton type="button" icon={Trash2} label="删除草稿" description={draft.title} disabled={open.isPending} onClick={() => manage('delete', draft)} /></div></td>
        </tr>)}</tbody></table>
      </div>
      <Pagination page={page} pageSize={20} total={list.data.total} pending={list.isFetching} change={setPage} />
    </>}
    <ImportDialog open={active && action !== null} title={action?.kind === 'rename' ? '重命名草稿' : '删除草稿'} close={closeAction}>
      {action && <form className="import-draft-manage" onSubmit={action.kind === 'rename' ? submitRename : (event) => { event.preventDefault(); if (detail.data && !conflict && !pending) remove.mutate(detail.data); }}>
        {action.kind === 'rename' ? <div className="field"><label htmlFor={titleId}>草稿名称</label><Input id={titleId} value={title} maxLength={120} required disabled={pending} autoFocus onChange={(event) => { setTitle(event.target.value); if (rename.isError && !conflict) rename.reset(); }} /></div> : <><p>确认删除草稿“{action.draft.title}”？</p><p className="mapping-help">草稿中的未提交内容将被删除。已接收的导入记录和已提交需求会保留。</p></>}
        {detail.isPending && <p className="form-note" role="status">正在读取草稿内容…</p>}
        {detail.isError && <ErrorFeedback title="无法读取草稿" error={detail.error} retry={() => void detail.refetch()} />}
        {mutationError && <div className="inline-error" role="alert"><div><strong>{conflict ? '草稿已在其他窗口更新' : action.kind === 'rename' ? '名称保存失败' : '草稿删除失败'}</strong><p>{conflict ? '当前操作未覆盖最新草稿。请先重新读取，再核对并提交。填写的名称会保留。' : messageOf(mutationError)}</p></div>{conflict && <Button type="button" icon={RefreshCw} loading={detail.isFetching} onClick={() => void reloadDetail()}>重新读取草稿</Button>}</div>}
        {notice && <p className="form-note success-note" role="status">{notice}</p>}
        <div className="import-draft-dialog-actions"><Button type="button" disabled={pending} onClick={closeAction}>取消</Button><Button type="submit" variant="primary" icon={action.kind === 'rename' ? Pencil : Trash2} loading={pending} loadingLabel={action.kind === 'rename' ? '正在保存名称…' : '正在删除草稿…'} disabled={!detail.data || detail.isFetching || Boolean(detail.error) || conflict || action.kind === 'rename' && !title.trim()}>{action.kind === 'rename' ? '保存名称' : '确认删除草稿'}</Button></div>
      </form>}
    </ImportDialog>
  </section>;
}
