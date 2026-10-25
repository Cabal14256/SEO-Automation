import { useEffect, useRef, useState } from 'react';
import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, History, ListChecks, RefreshCw } from 'lucide-react';
import type { SubBatchDetail } from '@scm/contracts';
import { ApiError } from '../api';
import { Button, IconButton } from '../components/ui/button';
import { Link } from '@tanstack/react-router';
import { ImportDialog } from './import-dialog';
import { batchApi } from './batch-api';
import { GroupConfirmation, GroupHistory, GroupMembers } from './batch-detail';
import { BatchReports } from './batch-reports';
import { BatchShipments } from './batch-shipments';
import { BatchSync } from './batch-sync';
import { batchScopeLabel, QueryError } from './batch-shared';
import { hasUnsettledAutoConfirmation } from './batch-auto-confirm';
import './batch-process-wizard.css';

const stages = ['members', 'products', 'confirmation', 'exports'] as const;
export type ProcessStage = typeof stages[number];
const labels: Record<ProcessStage, string> = { members: '分组与成员', products: '同步与商品', confirmation: '制表确认与编码', exports: '成品与导出' };
const readStage = (key: string): ProcessStage | null => {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof saved === 'number') return ({ 1: 'members', 2: 'products', 3: 'confirmation', 4: 'exports' } as Record<number, ProcessStage>)[saved] ?? null;
    if (typeof saved === 'object' && saved !== null && 'version' in saved && saved.version === 2 && 'stage' in saved) {
      if (saved.stage === 'physical') return 'exports';
      if (stages.includes(saved.stage as ProcessStage)) return saved.stage as ProcessStage;
    }
    return null;
  } catch { return null; }
};
function currentConfirmation(detail: SubBatchDetail) {
  const saved = detail.confirmation;
  return Boolean(saved && detail.group.status === 'confirmed' && saved.groupVersion === detail.group.confirmedVersion && saved.snapshot.members.length === detail.members.length
    && detail.members.every((member) => saved.snapshot.members.some((previous) => previous.id === member.id && previous.version === member.version))
    && detail.shipments.every((shipment) => saved.snapshot.shipments.some((previous) => previous.demandId === shipment.demandId && previous.revision.id === shipment.revision?.id)));
}

export function BatchProcessWizard({ open, userId, batchId, groupId, initialStage, initialDemandId, close, complete, selectGroup, viewDetail }: {
  open: boolean; userId: string; batchId: string; groupId: string; initialStage?: ProcessStage; initialDemandId?: string;
  close: () => void; complete: () => void; selectGroup: (id: string, batchId?: string) => void; viewDetail: () => void;
}) {
  const key = `scm-batch-process:${userId}:${groupId}`;
  const [autoUnsettled, setAutoUnsettled] = useState(() => hasUnsettledAutoConfirmation(userId, groupId));
  const [savedStep] = useState(() => hasUnsettledAutoConfirmation(userId, groupId) ? 'confirmation' : initialStage ?? readStage(key));
  const [step, setStep] = useState<ProcessStage>(savedStep ?? 'products');
  const [initialized, setInitialized] = useState(Boolean(savedStep));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVisited, setHistoryVisited] = useState(false);
  const [visited, setVisited] = useState<ProcessStage[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const nav = useRef<HTMLElement>(null);
  const client = useQueryClient();
  const busy = useIsMutating() > 0;
  const week = useQuery({ queryKey: ['batch', batchId], queryFn: () => batchApi.detail(batchId), retry: false, enabled: open });
  const query = useQuery({ queryKey: ['sub-batch', groupId], queryFn: () => batchApi.group(groupId), retry: false, enabled: open, refetchInterval: open ? 3000 : false });
  const syncRuns = useQuery({ queryKey: ['batch-sync', groupId], queryFn: () => batchApi.syncRuns(groupId), retry: false, enabled: open,
    refetchInterval: (state) => open && state.state.data?.some((run) => run.status === 'queued' || run.status === 'running') ? 1500 : false });
  const detail = query.data;
  const scopeMatches = detail?.group.batchId === batchId;
  const frozen = detail?.group.status === 'frozen';
  const syncUnsettled = syncRuns.isPending || syncRuns.isError || Boolean(syncRuns.data?.some((run) => run.status === 'queued' || run.status === 'running'));
  const confirmed = Boolean(detail && (frozen ? detail.confirmation : currentConfirmation(detail)));
  const boxes = (detail && (frozen ? detail.confirmation?.snapshot.shipments : detail.shipments)?.flatMap((shipment) => shipment.revision?.data.boxes ?? [])) ?? [];
  const coded = boxes.length > 0 && boxes.every((box) => detail?.codes.some((code) => code.boxId === box.id && code.valid));
  const exportReady = Boolean(scopeMatches && confirmed && coded && !autoUnsettled && detail?.group.status !== 'superseded' && (frozen || !syncUnsettled && !detail?.issues.some((issue) => issue.severity === 'error')));
  const candidates = Boolean(detail?.members.length && detail.shipments.length === detail.members.length && detail.shipments.every((shipment) => shipment.revision && detail.members.some((member) => member.id === shipment.demandId && member.version === shipment.revision?.demandVersion)));
  useEffect(() => {
    if (initialized || !detail || !frozen && syncRuns.isPending) return;
    setStep(exportReady ? 'exports' : candidates && !syncUnsettled ? 'confirmation' : 'products'); setInitialized(true);
  }, [initialized, detail, exportReady, candidates, frozen, syncRuns.isPending, syncUnsettled]);
  useEffect(() => {
    if (!initialized) return;
    try { sessionStorage.setItem(key, JSON.stringify({ version: 2, stage: step })); } catch { /* The open wizard still keeps its step. */ }
  }, [key, step, initialized]);
  useEffect(() => {
    if (!open || !initialized) return;
    setVisited((current) => current.includes(step) ? current : [...current, step]);
    const frame = requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true }); heading.current?.closest('.import-dialog-body')?.scrollTo({ top: 0 });
      const current = nav.current?.querySelector<HTMLElement>('[aria-current="step"]');
      if (nav.current && current) {
        const box = nav.current.getBoundingClientRect(); const item = current.getBoundingClientRect();
        if (item.right > box.right) nav.current.scrollLeft += item.right - box.right;
        else if (item.left < box.left) nav.current.scrollLeft -= box.left - item.left;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, initialized, step, historyOpen]);
  useEffect(() => {
    if ([query.error, week.error, syncRuns.error].some((error) => error instanceof ApiError && error.status === 401)) void client.invalidateQueries({ queryKey: ['session'] });
  }, [query.error, week.error, syncRuns.error, client]);
  const move = (next: ProcessStage) => { if (!busy) { setHistoryOpen(false); setStep(next); } };
  const allowed = (target: ProcessStage) => target === 'members' || target === 'products' || target === 'confirmation' && scopeMatches && (frozen || !syncUnsettled && (candidates || confirmed)) || target === 'exports' && exportReady;
  const completed: Record<ProcessStage, boolean> = { members: Boolean(detail?.members.length), products: candidates && !syncUnsettled || Boolean(frozen && detail?.confirmation), confirmation: confirmed && coded, exports: false };
  const index = stages.indexOf(step);
  return <ImportDialog open={open} title="发货批次处理向导" close={close} wide>
    <div className="batch-process-wizard">
      <nav ref={nav} className="import-wizard-progress" aria-label="批次处理步骤"><ol>{stages.map((target, stageIndex) => {
        return <li key={target} data-current={!historyOpen && step === target} data-complete={completed[target]}><button type="button" aria-current={!historyOpen && step === target ? 'step' : undefined} disabled={busy || !initialized || !allowed(target)} onClick={() => move(target)}><span className="wizard-step-number" aria-hidden="true">{completed[target] ? <Check size={15} /> : stageIndex + 1}</span>{labels[target]}</button></li>;
      })}</ol></nav>
      <div className="import-wizard-heading"><div><h3 ref={heading} tabIndex={-1}>{historyOpen ? '来源与登记' : labels[step]}</h3><p>{detail?.group.name ?? '正在读取批次'}{detail && ` · ${detail.members.length} 票`}{week.data && ` · ${batchScopeLabel(week.data.batch)}`}</p></div><div className="batch-process-header-actions"><Button type="button" variant="text" icon={History} disabled={busy} onClick={() => { setHistoryVisited(true); setHistoryOpen((value) => !value); }}>{historyOpen ? '返回处理步骤' : '来源与登记'}</Button><Button type="button" variant="text" disabled={busy} onClick={viewDetail}>查看批次详情</Button><IconButton type="button" icon={RefreshCw} label="刷新处理数据" disabled={busy} loading={query.isFetching || week.isFetching} onClick={() => { void query.refetch(); void week.refetch(); void syncRuns.refetch(); }} /></div></div>
      {query.isError && <QueryError error={query.error} retry={() => void query.refetch()} />}
      {week.isError && <QueryError error={week.error} retry={() => void week.refetch()} />}
      {!initialized && syncRuns.isPending && <p className="list-state" role="status">正在读取同步状态…</p>}
      {(!detail || !week.data) && (query.isPending || week.isPending) && <p className="list-state" role="status">正在读取批次及成员…</p>}
      {detail && week.data && <>
        {!scopeMatches && <p className="permission-note warning-note" role="alert">此子批次属于其他处理范围，当前操作已停用。<Button type="button" onClick={() => selectGroup(groupId, detail.group.batchId)}>打开所属批次</Button></p>}
        {detail.group.status === 'superseded' && <p className="permission-note warning-note">此批次已被更正版本替代，历史仍可查看。{detail.group.replacedById && <Button type="button" onClick={() => selectGroup(detail.group.replacedById!)}>进入更正批次</Button>}</p>}
        {!historyOpen && step === 'confirmation' && !candidates && !frozen && <p className="permission-note warning-note">成员或需求版本已变化，请返回同步步骤补齐当前版本数据。</p>}
        {!historyOpen && step === 'confirmation' && syncUnsettled && !frozen && <p className="permission-note warning-note">同步任务尚未完成或状态未读取成功。请等待或返回同步步骤核对后，再确认当前数据。</p>}
        {!historyOpen && step === 'exports' && !exportReady && <p className="permission-note warning-note">当前确认或箱编码尚未就绪。请返回核对，确认当前版本并分配箱编码后再生成成品。<Button type="button" onClick={() => move('confirmation')}>返回制表确认与编码</Button></p>}
        <fieldset className="batch-process-fieldset" disabled={query.isError || week.isError || !scopeMatches}>
        <div hidden={historyOpen || step !== 'members'}>{visited.includes('members') && <GroupMembers detail={detail} week={week.data} />}</div>
        <div hidden={historyOpen || step !== 'products'}>{visited.includes('products') && <><BatchSync detail={detail} active={open && !historyOpen && step === 'products'} /><BatchShipments detail={detail} initialDemandId={initialDemandId} /></>}</div>
        <div hidden={historyOpen || step !== 'confirmation'}>{visited.includes('confirmation') && <fieldset className="batch-process-fieldset"><GroupConfirmation detail={detail} week={week.data} userId={userId} active={open && !historyOpen && step === 'confirmation'} ready={!query.isError && !week.isError && !query.isFetching && !week.isFetching && scopeMatches && !syncUnsettled} onUnsettledChange={setAutoUnsettled} /></fieldset>}</div>
        <div hidden={historyOpen || step !== 'exports'}>{visited.includes('exports') && <fieldset className="batch-process-fieldset" disabled={!exportReady}><BatchReports subBatchId={groupId} active={open && !historyOpen && step === 'exports'} /></fieldset>}</div>
        <div hidden={!historyOpen}>{historyVisited && <GroupHistory detail={detail} selectGroup={selectGroup} />}</div>
        </fieldset>
        {!historyOpen && step === 'exports' && <p className="mapping-help">制表导出后可继续制作发票。<Link to="/shipping" search={{ view: 'documents' }} className="text-button" onClick={close}>进入发票与单据</Link></p>}
        <div className="import-wizard-footer"><div>{!historyOpen && index > 0 && <Button type="button" icon={ArrowLeft} disabled={busy} onClick={() => move(stages[index - 1]!)}>上一步</Button>}</div><div>{!historyOpen && step === 'confirmation' && <Button type="button" disabled={busy || !exportReady} onClick={() => move('exports')}>直接进入成品与导出</Button>}{!historyOpen && index < stages.length - 1 && <Button type="button" variant="primary" icon={ArrowRight} disabled={busy || !allowed(stages[index + 1]!)} onClick={() => move(stages[index + 1]!)}>下一步：{labels[stages[index + 1]!]}</Button>}<Button type="button" variant={step === 'exports' && !historyOpen ? 'primary' : 'secondary'} icon={ListChecks} disabled={busy} onClick={complete}>{step === 'exports' && !historyOpen ? '完成，返回批次列表' : '保存进度并返回列表'}</Button></div></div>
      </>}
    </div>
  </ImportDialog>;
}
