import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { api, type User } from '../api';
import { Button } from '../components/ui/button';
import { StatePage } from '../pages';
import { ImportsPage } from './imports';
import { ImportWorkspace } from './import-workspace';
import { BatchWizard } from './batch-wizard';
import { BatchProcessWizard, type ProcessStage } from './batch-process-wizard';
import { DemandBatchAssignment, readDemandAssignment, type DemandAssignment } from './demand-batch-assignment';
import { DocumentsWorkspace } from './documents';
import { ShippingLayout, type ShippingView } from './shipping-layout';
import { WorkflowWorkspace } from './workflow-workspace';

export function ShippingRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) return <StatePage title="无法打开发货管理" detail={session.error.message} action={<Button type="button" icon={RefreshCw} loading={session.isFetching} onClick={() => void session.refetch()}>重试</Button>} />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <ShippingWorkspace key={session.data.user.id} user={session.data.user} />;
}

function ShippingWorkspace({ user }: { user: User }) {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const client = useQueryClient();
  const view: ShippingView = search.view === 'physical' ? 'documents' : search.view === 'documents' || search.view === 'fulfillment' || search.view === 'logistics' || search.view === 'customs' || search.view === 'archives' ? search.view : 'demands';
  const workbenchActive = view === 'demands';
  const [assignment, setAssignment] = useState<DemandAssignment | null>(() => readDemandAssignment(user.id));
  const [creation, setCreation] = useState(false);
  const processKey = `scm-batch-process:${user.id}:current`;
  const [process, setProcess] = useState<{ batchId: string; groupId: string; open: boolean; initialStage?: ProcessStage } | null>(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(processKey) ?? 'null'); return saved && typeof saved.batchId === 'string' && typeof saved.groupId === 'string' ? { batchId: saved.batchId, groupId: saved.groupId, open: saved.open === true && search.view === 'batches' } : null; } catch { return null; }
  });
  const processRef = useRef(process); processRef.current = process;
  const [visited, setVisited] = useState<ShippingView[]>([view]);
  useEffect(() => { setVisited((previous) => previous.includes(view) ? previous : [...previous, view]); }, [view]);
  const refresh = () => { void client.invalidateQueries({ queryKey: ['demands'] }); void client.invalidateQueries({ queryKey: ['batches'] }); void client.invalidateQueries({ queryKey: ['batch'] }); void client.invalidateQueries({ queryKey: ['sub-batch'] }); void client.invalidateQueries({ queryKey: ['batch-reports'] }); };
  const saveProcess = (next: typeof process) => { processRef.current = next; setProcess(next); try { if (next) sessionStorage.setItem(processKey, JSON.stringify(next)); else sessionStorage.removeItem(processKey); } catch { /* Mounted state remains available. */ } };
  const openGroup = (batchId: string, groupId: string) => { setAssignment(null); saveProcess({ batchId, groupId, open: true }); void navigate({ to: '/shipping', search: { view: 'batches', groupId }, replace: true }); };
  const closeProcess = () => { if (processRef.current) saveProcess({ ...processRef.current, open: false }); refresh(); };
  useEffect(() => {
    if (!process?.open) return;
    try {
      const stage = JSON.parse(sessionStorage.getItem(`scm-batch-process:${user.id}:${process.groupId}`) ?? 'null');
      if (stage?.stage === 'physical') { setProcess((current) => current ? { ...current, open: false } : null); void navigate({ to: '/shipping', search: { view: 'documents' }, replace: true }); }
    } catch { /* Invalid saved stage is ignored by the process wizard. */ }
  }, [process?.open, process?.groupId, user.id, navigate]);
  useEffect(() => { if (search.view === 'physical') void navigate({ to: '/shipping', search: { view: 'documents' }, replace: true }); }, [search.view, navigate]);
  const mounted = (target: ShippingView) => target === view || visited.includes(target);
  return <ShippingLayout user={user} view={view} combined={workbenchActive}>
    <section className="shipping-view shipping-flow" aria-label="发货工作台" hidden={!workbenchActive}>{(workbenchActive || visited.includes('demands') || visited.includes('reports')) && <>
      <ImportsPage user={user} embedded active={workbenchActive} onArrangeDemands={(demandIds, mode) => setAssignment({ demandIds, mode })} renderWorkspace={(actions) => <ImportWorkspace {...actions} active={workbenchActive} initialPresentation={search.view === 'reports' ? 'products' : 'shipments'} initialGroupId={search.groupId} initialPool={search.pool} onScopeChange={(groupId, ungrouped) => { void navigate({ to: '/shipping', search: { view: 'demands', groupId, pool: ungrouped ? 'ungrouped' : undefined }, resetScroll: false }); }} onArrangeDemands={(demandIds, mode) => setAssignment({ demandIds, mode })} onOpenGroup={openGroup} onCreateBatch={() => setCreation(true)} />} />
      {assignment && <DemandBatchAssignment open={view === 'demands'} userId={user.id} {...assignment} onClose={() => setAssignment(null)} onComplete={refresh} onOpenGroup={openGroup} />}
      <BatchWizard open={view === 'demands' && creation} userId={user.id} onClose={() => setCreation(false)} onCreated={refresh} onOpenCreated={(result) => { if (result.batchId && result.groupId) { setCreation(false); openGroup(result.batchId, result.groupId); } }} />
      {process && <BatchProcessWizard key={process.groupId} {...process} open={view === 'demands' && process.open} userId={user.id} close={closeProcess} complete={closeProcess} selectGroup={(groupId, batchId) => openGroup(batchId ?? process.batchId, groupId)} viewDetail={() => { closeProcess(); void navigate({ to: '/batches/$batchId', params: { batchId: process.batchId }, search: { groupId: process.groupId } }); }} />}
    </>}</section>
    <section className="shipping-view" aria-label="发票与单据工作区" hidden={view !== 'documents'}>{mounted('documents') && <DocumentsWorkspace active={view === 'documents'} />}</section>
    {(['fulfillment', 'logistics', 'customs', 'archives'] as const).map((target) => <section key={target} className="shipping-view" aria-label={`${target === 'fulfillment' ? '领星单据与分配' : target === 'logistics' ? '物流与交接' : target === 'customs' ? '报关与 9810' : '批次归档'}工作区`} hidden={view !== target}>{mounted(target) && <WorkflowWorkspace kind={target === 'archives' ? 'archive' : target} active={view === target} />}</section>)}
  </ShippingLayout>;
}
