import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Eye, Plus, RefreshCw } from 'lucide-react';
import type { BatchMutationResult, DemandRecord, BatchScopeDetail } from '@scm/contracts';
import { api, type User } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { StatePage } from '../pages';
import { batchApi } from './batch-api';
import { BatchGroupDetail } from './batch-detail';
import { BatchReports } from './batch-reports';
import { batchScopeLabel, BatchPanel, BatchTable, Check, messageOf, newOperation, QueryError, useBatchAction } from './batch-shared';
import { BatchWorkspace } from './batch-workspace';
import { BatchWizard } from './batch-wizard';
import { BatchProcessWizard, type ProcessStage } from './batch-process-wizard';
import { ShippingLayout } from './shipping-layout';

export const groupStatus: Record<string, string> = { draft: '待确认', confirmed: '已确认', frozen: '已冻结', superseded: '已替代' };
const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
type ProcessTarget = { batchId: string; groupId: string; open: boolean; initialStage?: ProcessStage };
function readProcess(key: string): ProcessTarget | null {
  try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && isId(value.batchId) && isId(value.groupId) ? { batchId: value.batchId, groupId: value.groupId, open: value.open === true } : null; } catch { return null; }
}
function savedPhysicalStage(userId: string, groupId: string) {
  try { const saved: unknown = JSON.parse(sessionStorage.getItem(`scm-batch-process:${userId}:${groupId}`) ?? 'null'); return typeof saved === 'object' && saved !== null && 'version' in saved && saved.version === 2 && 'stage' in saved && saved.stage === 'physical'; } catch { return false; }
}

export function BatchesRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开发货批次" detail={messageOf(session.error)} action={<Button icon={RefreshCw} loading={session.isFetching} onClick={() => void session.refetch()}>重试</Button>} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <BatchesPage key={session.data.user.id} user={session.data.user} />;
}

export function BatchesPage({ user, embedded = false, active = true, restoreProcess = true }: { user: User; embedded?: boolean; active?: boolean; restoreProcess?: boolean }) {
  const { batchId } = useParams({ strict: false });
  const location = useLocation();
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const client = useQueryClient();
  const reports = location.pathname === '/batch-reports';
  const legacyPhysical = search.legacyPhysical || search.tab === 'physical';
  const processKey = `scm-batch-process:${user.id}:current`;
  const [creation, setCreation] = useState(() => ({ token: newOperation(), open: location.pathname === '/batches/new' || search.wizard === 'create', batchId: search.wizard === 'create' ? batchId : undefined, weekStartDate: search.weekStartDate, demandId: search.demandId }));
  const [process, setProcess] = useState<ProcessTarget | null>(() => {
    if (legacyPhysical) return null;
    if (search.wizard === 'process' && batchId && search.groupId) return { batchId, groupId: search.groupId, open: true };
    const previous = readProcess(processKey);
    return (embedded || location.pathname === '/batches') && search.wizard !== 'create' && previous ? { ...previous, open: previous.open && restoreProcess } : null;
  });
  const restorePhysical = Boolean(process?.open && savedPhysicalStage(user.id, process.groupId));
  const processRef = useRef(process);
  processRef.current = process;
  const persist = (target: ProcessTarget | null) => {
    try { if (target) sessionStorage.setItem(processKey, JSON.stringify(target)); else sessionStorage.removeItem(processKey); } catch { /* Keep the open page usable if storage is unavailable. */ }
  };
  const setTarget = (target: ProcessTarget | null) => { processRef.current = target; setProcess(target); persist(target); };
  const closeProcess = () => { const target = processRef.current; if (target) setTarget({ ...target, open: false }); };
  const openCreate = (selectedBatchId?: string, weekStartDate?: string, demandId?: string) => {
    closeProcess();
    const week = weekStartDate ?? search.weekStartDate;
    const targetDemand = demandId ?? search.demandId;
    setCreation((previous) => previous.batchId === selectedBatchId && previous.weekStartDate === week && previous.demandId === targetDemand
      ? { ...previous, open: true } : { token: newOperation(), open: true, batchId: selectedBatchId, weekStartDate: week, demandId: targetDemand });
  };
  const refresh = () => { void client.invalidateQueries({ queryKey: ['batches'] }); void client.invalidateQueries({ queryKey: ['batch'] }); void client.invalidateQueries({ queryKey: ['demands'] }); };
  const openProcess = (target: ProcessTarget) => {
    setTarget(target);
    if (!embedded && location.pathname !== '/batches') void navigate({ to: '/batches/$batchId', params: { batchId: target.batchId }, search: { groupId: target.groupId, wizard: 'process' } });
  };
  const openCreated = (result: BatchMutationResult) => {
    if (!result.batchId || !result.groupId) return;
    setCreation((previous) => ({ ...previous, open: false }));
    openProcess({ batchId: result.batchId, groupId: result.groupId, open: true, initialStage: 'products' }); refresh();
  };
  const inspect = () => { setTarget(null); };
  const viewDetail = () => {
    const target = processRef.current; if (!target) return;
    inspect(); void navigate({ to: '/batches/$batchId', params: { batchId: target.batchId }, search: { groupId: target.groupId } });
  };
  const finish = () => { closeProcess(); refresh(); void navigate({ to: '/shipping', search: { view: 'batches' } }); };
  useEffect(() => {
    if (active && legacyPhysical && search.groupId) {
      void navigate({ to: '/shipping', search: { view: 'documents' }, replace: true });
      return;
    }
    if (active && search.wizard === 'process' && batchId && search.groupId) {
      const target = { batchId, groupId: search.groupId, open: true };
      setProcess(target); processRef.current = target;
      try { sessionStorage.setItem(processKey, JSON.stringify(target)); } catch { /* Optional refresh recovery. */ }
    }
  }, [active, batchId, search.groupId, search.wizard, processKey, legacyPhysical, navigate]);
  useEffect(() => {
    if (!active || !process?.open || !restorePhysical) return;
    setProcess(null); processRef.current = null;
    try { sessionStorage.removeItem(processKey); } catch { /* The task link remains available. */ }
    void navigate({ to: '/shipping', search: { view: 'documents' }, replace: true });
  }, [active, process, processKey, restorePhysical, navigate]);
  const content = <div className="content-width batch-workspace" hidden={!active}>
    {!reports && <div className="batch-workspace-heading"><div><h2>{batchId && !process ? '发货批次详情' : '发货批次'}</h2><p className="mapping-help">从已提交需求人工分组，按向导完成同步、核对确认和成品导出。</p></div>{batchId && <Link to="/shipping" search={{ view: 'batches' }} className="secondary-button" onClick={inspect}><ArrowLeft size={18} aria-hidden="true" />返回批次列表</Link>}</div>}
    {reports ? <BatchReports active={active} /> : batchId && !process ? <WeeklyDetail key={batchId} id={batchId} initialGroupId={search.groupId} initialDemandId={search.demandId} initialTab={search.tab} create={() => openCreate(batchId, undefined, search.demandId)} process={(groupId) => openProcess({ batchId, groupId, open: true })} />
      : <BatchWorkspace active={active} create={openCreate} process={(row) => { if (row.group) openProcess({ batchId: row.batch.id, groupId: row.group.id, open: true }); }} inspect={inspect} canResume={Boolean(process)} resume={() => { if (process) openProcess({ ...process, open: true }); }} />}
    {!reports && <BatchWizard key={creation.token} open={active && creation.open} onClose={() => { if (active) setCreation((previous) => ({ ...previous, open: false })); }} userId={user.id} canManage={user.role === 'admin'} initialWeeklyBatchId={creation.batchId} initialWeekStartDate={creation.weekStartDate} initialDemandId={creation.demandId} onCreated={refresh} onOpenCreated={openCreated} />}
    {!reports && process && <BatchProcessWizard key={process.groupId} open={active && process.open} userId={user.id} batchId={process.batchId} groupId={process.groupId} initialStage={process.initialStage ?? search.stage} initialDemandId={search.demandId} close={() => { if (active && processRef.current?.groupId === process.groupId) closeProcess(); }} complete={finish} viewDetail={viewDetail} selectGroup={(groupId, targetBatchId) => openProcess({ ...process, batchId: targetBatchId ?? process.batchId, groupId, open: true, initialStage: undefined })} />}
  </div>;
  return embedded ? content : <ShippingLayout user={user} view={reports ? 'reports' : 'batches'}>{content}</ShippingLayout>;
}

function WeeklyDetail({ id, initialGroupId, initialDemandId, initialTab, create, process }: { id: string; initialGroupId?: string; initialDemandId?: string; initialTab?: string; create: () => void; process: (groupId: string) => void }) {
  const [groupId, setGroupId] = useState(initialGroupId ?? '');
  const query = useQuery({ queryKey: ['batch', id], queryFn: () => batchApi.detail(id), retry: false });
  if (query.isPending) return <p className="list-state" role="status">正在读取发货批次…</p>;
  if (query.isError) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  const detail = query.data;
  return <><BatchPanel title={batchScopeLabel(detail.batch)} help="按发货次管理处理组；成员由人工选择，可跨导入日期安排。" action={<IconButton icon={RefreshCw} label="刷新发货批次" loading={query.isFetching} onClick={() => void query.refetch()} />}>
    <div className="batch-workspace-toolbar"><Button type="button" variant="primary" icon={Plus} onClick={create}>新建分组</Button>{groupId && <><Button type="button" icon={ArrowRight} onClick={() => process(groupId)}>打开处理向导</Button><Link to="/shipping" search={{ view: 'archives', groupId }} className="secondary-button">完成检查与归档</Link><Link to="/finance" search={{ groupId }} className="secondary-button">费用对账</Link></>}<span className="batch-workspace-total">{detail.ungrouped.length} 票未分组需求</span></div>
    <GroupsList detail={detail} selected={groupId} select={setGroupId} />
  </BatchPanel>
  {groupId && <BatchGroupDetail key={groupId} id={groupId} week={detail} selectGroup={setGroupId} initialDemandId={initialDemandId} initialTab={initialTab} />}
  {!groupId && <p className="permission-note">选择已有子批次查看详情，或点击“新建分组”进入向导。</p>}</>;
}


function GroupsList({ detail, selected, select }: { detail: BatchScopeDetail; selected: string; select: (id: string) => void }) {
  const action = useBatchAction();
  const groups = detail.groups.filter((group) => group.status !== 'superseded');
  const [pendingMove, setPendingMove] = useState<{ id: string; step: number } | null>(null);
  const reorder = (index: number, step: number) => {
    setPendingMove({ id: groups[index]!.id, step });
    const ids = groups.map((group) => group.id); const current = ids[index]!; ids[index] = ids[index + step]!; ids[index + step] = current;
    action.run(JSON.stringify(['reorder', detail.batch.version, ids]), (operationId) => batchApi.batchAction(detail.batch.id, 'reorder', { operationId, expectedVersion: detail.batch.version, groupIds: ids, reason: '人工调整子批次顺序' }), '子批次顺序已保存，已分配的编码保持。');
  };
  return <>{detail.groups.length === 0 ? <p className="list-state">尚无子批次。在下方选择未分组需求创建。</p> : <BatchTable label="人工子批次" headers={['名称 / 状态', '成员 / 编码', '顺序', '操作']}>{detail.groups.map((group) => { const index = groups.findIndex((item) => item.id === group.id); return <tr key={group.id} aria-current={group.id === selected ? 'true' : undefined}><td><strong>{group.name}</strong><small className="mapping-subtext">{groupStatus[group.status]} · v{group.version}{group.correctionOfId ? ' · 更正版本' : ''}</small></td><td>{group.demandIds.length} 票 · {group.prefix || '未编码'}</td><td>{index >= 0 && <div className="batch-inline-actions"><IconButton icon={ArrowUp} label="上移" description={group.name} loading={action.busy && pendingMove?.id === group.id && pendingMove.step === -1} disabled={action.busy || index === 0} onClick={() => reorder(index, -1)} /><IconButton icon={ArrowDown} label="下移" description={group.name} loading={action.busy && pendingMove?.id === group.id && pendingMove.step === 1} disabled={action.busy || index === groups.length - 1} onClick={() => reorder(index, 1)} /></div>}</td><td><IconButton icon={Eye} label="查看并处理" description={group.name} aria-pressed={group.id === selected} onClick={() => select(group.id)} /></td></tr>; })}</BatchTable>}{action.feedback}</>;
}

export function DemandRow({ demand, checked, toggle, disabled = false }: { demand: DemandRecord; checked: boolean; toggle: (checked: boolean) => void; disabled?: boolean }) {
  return <tr><td><Check checked={checked} disabled={disabled} onChange={toggle}><span className="sr-only">选择 {demand.snapshot.fba}</span></Check></td><td><strong>{demand.snapshot.fba}</strong><small className="mapping-subtext">{demand.snapshot.shop} · sid {demand.snapshot.sid} · v{demand.version}</small></td><td>{demand.snapshot.country} / {demand.snapshot.channel || '未填渠道'}<small className="mapping-subtext">{demand.snapshot.destinationFc || '未填 FC'}</small></td><td>{demand.businessDate}<small className="mapping-subtext">{demand.snapshot.subBatchName || '无来源组标识'}</small></td></tr>;
}
