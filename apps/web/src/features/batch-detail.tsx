import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowRight, ArrowRightLeft, CalendarCheck, ClipboardCheck, Eye, FilePenLine, FileSpreadsheet, GitMerge, History, ListChecks, Package, Plus, Printer, RefreshCw, RotateCcw, Save, Scissors } from 'lucide-react';
import type { SubBatchDetail, BatchScopeDetail } from '@scm/contracts';
import { api } from '../api';
import { Button, IconButton, IconLink } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Combobox } from '../components/ui/combobox';
import { DatePicker } from '../components/ui/date-picker';
import { dateInputError } from '../components/ui/date-utils';
import { batchApi } from './batch-api';
import { BatchReports } from './batch-reports';
import { BatchShipments } from './batch-shipments';
import { BatchSync } from './batch-sync';
import { BatchPanel, BatchTable, Check, QueryError, timestamp, useBatchAction } from './batch-shared';
import { AutomaticConfirmation, hasCurrentGroupConfirmation } from './batch-auto-confirm';
import { BatchWizard } from './batch-wizard';

const statusLabels: Record<string, string> = { draft: '待确认', confirmed: '已确认', frozen: '已导出或打印 · 冻结', superseded: '已被更正版本替代' };
export function BatchGroupDetail({ id, week, selectGroup, initialDemandId, initialTab }: { id: string; week: BatchScopeDetail; selectGroup: (id: string) => void; initialDemandId?: string; initialTab?: string }) {
  const [tab, setTab] = useState(initialTab === 'physical' ? 'reports' : initialTab ?? 'shipments');
  const query = useQuery({ queryKey: ['sub-batch', id], queryFn: () => batchApi.group(id), retry: false, refetchInterval: 3000 });
  if (query.isPending) return <p className="list-state" role="status">正在读取子批次…</p>;
  if (query.isError) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  const detail = query.data;
  return <><BatchPanel title={detail.group.name} help={`${statusLabels[detail.group.status]} · v${detail.group.version} · ${detail.members.length} 票 · 前缀 ${detail.group.prefix || '未分配'}`} action={<IconButton icon={RefreshCw} label="刷新子批次" loading={query.isFetching} onClick={() => void query.refetch()} />}>
    {(detail.shippingRunIds ?? []).length === 0 && !detail.group.frozenAt && detail.group.status !== 'frozen' && detail.group.status !== 'superseded' && <LegacyGroupBinding detail={detail} />}
    {detail.group.correctionOfId && <p className="mapping-help">这是原子批次 {detail.group.correctionOfId} 的更正版本；原事实和导出保留。</p>}
    {detail.group.replacedById && <p className="permission-note">已被更正版本替代。<Button icon={ArrowRight} onClick={() => selectGroup(detail.group.replacedById!)}>进入更正版本</Button></p>}
    <div className="batch-tabs" role="tablist" aria-label="子批次工作区">{[{ value: 'shipments', label: '同步与商品 / 箱', icon: Package }, { value: 'members', label: '成员与分组调整', icon: ListChecks }, { value: 'confirmation', label: '校验、确认与编码', icon: ClipboardCheck }, { value: 'reports', label: '成品表与导出', icon: FileSpreadsheet }, { value: 'history', label: '来源、历史与登记', icon: History }].map(({ value, label, icon }) => <Button icon={icon} key={value} role="tab" aria-selected={tab === value} variant={tab === value ? 'primary' : 'secondary'} onClick={() => setTab(value)}>{label}</Button>)}</div>
  </BatchPanel>
    {tab === 'shipments' && <div className="motion-panel"><BatchSync detail={detail} /><BatchShipments detail={detail} initialDemandId={initialDemandId} /></div>}
    {tab === 'members' && <div className="motion-panel"><GroupMembers key={detail.group.id} detail={detail} week={week} /></div>}
    {tab === 'confirmation' && <div className="motion-panel"><GroupConfirmation detail={detail} week={week} ready={!query.isFetching} /></div>}
    {tab === 'reports' && <div className="motion-panel"><BatchReports subBatchId={id} /></div>}
    {tab === 'history' && <div className="motion-panel"><GroupHistory detail={detail} selectGroup={selectGroup} /></div>}
  </>;
}

function LegacyGroupBinding({ detail }: { detail: SubBatchDetail }) {
  const [open, setOpen] = useState(false);
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (!session.data?.user) return null;
  return <><p className="permission-note">历史批次／未关联发货次。选择发货次后重新核对确认及箱码。<Button type="button" icon={Plus} onClick={() => setOpen(true)}>关联发货次</Button></p><BatchWizard open={open} onClose={() => setOpen(false)} userId={session.data.user.id} initialDemandIds={detail.group.demandIds} existingGroupId={detail.group.id} expectedGroupVersion={detail.group.version} onCreated={() => setOpen(false)} /></>;
}

export function GroupMembers({ detail, week }: { detail: SubBatchDetail; week: BatchScopeDetail }) {
  const { group } = detail;
  const [baseVersion, setBaseVersion] = useState(group.version);
  const [selected, setSelected] = useState(group.demandIds);
  const [moving, setMoving] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [splitName, setSplitName] = useState(`${group.name}（拆分）`);
  const action = useBatchAction();
  const locked = Boolean(group.frozenAt) || group.status === 'frozen' || group.status === 'superseded';
  const stale = baseVersion !== group.version;
  const anchor = detail.members[0];
  const pool = [...detail.members, ...week.ungrouped.filter((item) => !detail.members.some((member) => member.id === item.id) && (!anchor || item.snapshot.sid === anchor.snapshot.sid && item.snapshot.country === anchor.snapshot.country && item.snapshot.channel === anchor.snapshot.channel))];
  const peers = week.groups.filter((peer) => peer.id !== group.id && peer.status !== 'superseded' && peer.status !== 'frozen');
  const versions = Object.fromEntries(pool.filter((demand) => selected.includes(demand.id)).map((demand) => [demand.id, demand.version]));
  const disabled = locked || action.busy || stale || !reason.trim();
  const request = (kind: 'members' | 'move' | 'merge' | 'split', extra: Record<string, unknown>, success: string) => action.run(JSON.stringify([kind, group.id, baseVersion, extra, reason]), (operationId) => batchApi.groupAction(group.id, kind, { operationId, expectedVersion: baseVersion, reason, ...extra }), success);
  return <BatchPanel title="成员与分组调整" help="成员同 sid、国家和渠道；跨计划合组或同计划拆组均须人工确认。合并、拆分、移动使受影响旧组全部旧码失效；移除仅作废被移除成员箱码；单纯追加保持原码。成员变化均需重新确认。">
    {locked && <p className="permission-note">此子批次已冻结或被替代，不能直接调整成员。请在历史与登记中创建独立更正版本。</p>}
    {stale && <p className="permission-note warning-note" role="status">草稿基于 v{baseVersion}，当前为 v{group.version}。原选择保留，请核对后重新载入。<Button icon={RotateCcw} onClick={() => { setBaseVersion(group.version); setSelected(group.demandIds); setMoving([]); setMergeIds([]); }}>按当前版本重置选择</Button></p>}
    <div className="field batch-reason"><label htmlFor="member-reason">本次调整原因（必填）</label><Input id="member-reason" value={reason} disabled={locked} maxLength={1000} onChange={(event) => setReason(event.target.value)} /></div>
    <BatchTable label="组成员及可追加需求" headers={['成员选择', 'FBA / 店铺', '国家 / 渠道 / FC', '业务日期 / 版本', '移出 / 拆分选择']}>{pool.map((demand) => <tr key={demand.id}><td><Check disabled={locked || stale} checked={selected.includes(demand.id)} onChange={(checked) => setSelected((current) => checked ? [...current, demand.id] : current.filter((id) => id !== demand.id))}>{group.demandIds.includes(demand.id) ? '现有成员' : '可追加'}</Check></td><td>{demand.snapshot.fba}<small className="mapping-subtext">{demand.snapshot.shop} · sid {demand.snapshot.sid}</small></td><td>{demand.snapshot.country} / {demand.snapshot.channel || '未填渠道'}<small className="mapping-subtext">{demand.snapshot.destinationFc || '未填 FC'}</small></td><td>{demand.businessDate} · v{demand.version}</td><td>{group.demandIds.includes(demand.id) && <Check disabled={locked || stale} checked={moving.includes(demand.id)} onChange={(checked) => setMoving((current) => checked ? [...current, demand.id] : current.filter((id) => id !== demand.id))}>选择 {demand.snapshot.fba}</Check>}</td></tr>)}</BatchTable>
    <Button icon={Save} loading={action.pendingKey?.startsWith('["members",')} disabled={disabled || selected.length === 0} onClick={() => request('members', { demandIds: selected, expectedDemandVersions: versions }, '成员修改已保存，请核对当前新版本。')}>保存成员选择 / 追加</Button>
    <div className="batch-subsection"><h3>移动已选成员</h3><div className="batch-form"><div className="field"><label htmlFor="move-target">目标子批次</label><Combobox id="move-target" value={target} onValueChange={setTarget} placeholder="选择目标" searchPlaceholder="搜索目标子批次" options={[{ value: '', label: '选择目标' }, ...peers.map((peer) => ({ value: peer.id, label: `${peer.name} · v${peer.version}` }))]} /></div><Button icon={ArrowRightLeft} loading={action.pendingKey?.startsWith('["move",')} disabled={disabled || !target || moving.length === 0} onClick={() => request('move', { targetGroupId: target, expectedTargetVersion: peers.find((peer) => peer.id === target)?.version, demandIds: moving }, '成员已移动，受影响组须重新确认与编码。')}>移动 {moving.length} 票</Button></div></div>
    <div className="batch-subsection"><h3>拆成两个子批次</h3><p className="mapping-help">右侧选中的成员进入新组，其余成员保留为另一组；拆分后两组都重新确认并取得新前缀。</p><div className="batch-form"><div className="field"><label htmlFor="split-name">选中成员的新组名称</label><Input id="split-name" value={splitName} onChange={(event) => setSplitName(event.target.value)} maxLength={120} /></div><Button icon={Scissors} loading={action.pendingKey?.startsWith('["split",')} disabled={disabled || moving.length === 0 || moving.length >= group.demandIds.length || !splitName.trim()} onClick={() => request('split', { groups: [{ name: splitName, demandIds: moving }, { name: `${group.name}（其余）`, demandIds: group.demandIds.filter((id) => !moving.includes(id)) }] }, '已拆分为新子批次，原组历史保留。')}>拆分所选成员</Button></div></div>
    <div className="batch-subsection"><h3>人工合并子批次</h3><div className="batch-check-list">{peers.map((peer) => <Check key={peer.id} disabled={locked || stale} checked={mergeIds.includes(peer.id)} onChange={(checked) => setMergeIds((current) => checked ? [...current, peer.id] : current.filter((id) => id !== peer.id))}>{peer.name} · {peer.demandIds.length} 票 · v{peer.version}</Check>)}</div><Button icon={GitMerge} loading={action.pendingKey?.startsWith('["merge",')} disabled={disabled || mergeIds.length === 0} onClick={() => request('merge', { sourceGroupIds: mergeIds, expectedGroupVersions: Object.fromEntries(peers.filter((peer) => mergeIds.includes(peer.id)).map((peer) => [peer.id, peer.version])) }, '子批次已合并，旧确认及编码已失效，请重新核对。')}>合并选中组到当前组</Button></div>
    {action.feedback}
  </BatchPanel>;
}

export function GroupConfirmation({ detail, week, active = true, ready = true, userId, onUnsettledChange }: {
  detail: SubBatchDetail; week: BatchScopeDetail; active?: boolean; ready?: boolean; userId?: string; onUnsettledChange?: (unsettled: boolean) => void;
}) {
  const { group } = detail;
  const errors = detail.issues.filter((issue) => issue.severity === 'error');
  const shipments = detail.shipments.filter((shipment) => shipment.revision !== null);
  const currentConfirmation = hasCurrentGroupConfirmation(detail);
  const boxCount = shipments.reduce((sum, shipment) => sum + (shipment.revision?.data.boxes.length ?? 0), 0);
  return <BatchPanel title="校验、确认与编码" help="同步完成且当前数据校验通过后，自动确认数据版本并分配箱码。数量、身份、箱映射或顺序异常会暂停处理。发票箱规在单票资料中填写。">
    <div className="import-counts"><div><span>成员货件</span><strong>{detail.members.length}</strong></div><div><span>已有商品 / 箱数据</span><strong>{shipments.length}</strong></div><div><span>实际箱数</span><strong>{boxCount}</strong></div><div><span>阻塞异常</span><strong>{errors.length}</strong></div></div>
    {detail.issues.length > 0 ? <ul className="import-issues">{detail.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity === 'error' ? 'error-note' : 'warning-note'}><strong>{issue.severity === 'error' ? '阻塞' : '提示'} · {issue.code}</strong>：{issue.message}</li>)}</ul> : <p className="form-note success-note">当前服务端校验没有异常。</p>}
    {detail.confirmation && !currentConfirmation && <p className="permission-note warning-note">{group.status === 'frozen' || group.status === 'superseded' ? '当前需求或候选与冻结确认不同。成品表和旧文件继续引用原确认；请发起独立更正版本处理新差异。' : '需求或候选数据与原确认版本不同。新操作须重新核对并确认；原确认及已生成文件保留。'}</p>}
    <AutomaticConfirmation detail={detail} week={week} active={active} ready={ready} userId={userId} onUnsettledChange={onUnsettledChange} />
    {detail.confirmation && <p className="mapping-help">确认 {detail.confirmation.id} · v{detail.confirmation.groupVersion} · {timestamp(detail.confirmation.createdAt)} · {detail.confirmation.createdBy}</p>}
    <div className="batch-subsection"><h3>箱编码</h3><p className="mapping-help">自动按当前分组顺序分配 A…Z、AA…；以服务端保存结果为准。追加沿用原前缀和原箱码，新箱接续编号。</p>
      <CodePreview detail={detail} nextPrefix={week.batch.nextPrefix} />
    </div>
  </BatchPanel>;
}

function CodePreview({ detail, nextPrefix }: { detail: SubBatchDetail; nextPrefix: number }) {
  const prefixOf = (index: number) => { let value = index + 1; let result = ''; while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; };
  const existing = detail.codes.filter((code) => code.valid);
  const prefix = detail.group.prefix || prefixOf(nextPrefix);
  let sequence = Math.max(0, ...detail.codes.filter((code) => code.prefix === prefix).map((code) => code.sequence));
  const shipments = (detail.group.status === 'frozen' || detail.group.status === 'superseded') && detail.confirmation ? detail.confirmation.snapshot.shipments : detail.shipments;
  const boxes = shipments.flatMap((shipment) => shipment.revision?.data.boxes.map((box) => ({ box, fba: shipment.revision!.data.fba })) ?? []).sort((a, b) => (a.fba < b.fba ? -1 : a.fba > b.fba ? 1 : 0) || (a.box.order ?? 0) - (b.box.order ?? 0));
  return <BatchTable label="箱编码预览" headers={['FBA', '确认箱序 / 平台箱名', '内部箱 ID', '编码 / 状态']}>{boxes.map(({ box, fba }) => { const code = existing.find((item) => item.boxId === box.id); const preview = code?.code ?? `${prefix}${++sequence}`; return <tr key={box.id}><td>{fba}</td><td>{box.order ?? '未确认'} · {box.name || '无箱名'}</td><td>{box.id}</td><td>{preview}<small className="mapping-subtext">{code ? '已保存' : '待事务分配'}</small></td></tr>; })}</BatchTable>;
}

export function GroupHistory({ detail, selectGroup }: { detail: SubBatchDetail; selectGroup: (id: string) => void }) {
  const group = detail.group;
  const [demandId, setDemandId] = useState(detail.members[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [actualDate, setActualDate] = useState(group.actualShipDate || '');
  const [actualDateVersion, setActualDateVersion] = useState(group.version);
  const dateStale = actualDateVersion !== group.version;
  const [printedConfirmation, setPrintedConfirmation] = useState('');
  const printed = printedConfirmation === detail.confirmation?.id;
  const action = useBatchAction();
  const source = useQuery({ queryKey: ['demand', demandId], queryFn: () => api.demand(demandId), enabled: Boolean(demandId), retry: false });
  return <>
    <BatchPanel title="来源追溯" help="需求保留每次导入源文件、工作表和物理行号，便于追溯原始记录。">
      <div className="field batch-select"><label htmlFor="source-demand">选择货件</label><Combobox id="source-demand" value={demandId} onValueChange={setDemandId} searchPlaceholder="搜索 FBA 或店铺" options={detail.members.map((member) => ({ value: member.id, label: `${member.snapshot.fba} · ${member.snapshot.shop}`, keywords: [String(member.snapshot.sid)] }))} /></div>
      {source.isError && <QueryError error={source.error} retry={() => void source.refetch()} />}
      {source.data && <><p className="mapping-help">首次业务日期 {source.data.demand.businessDate} · 需求 v{source.data.demand.version}</p><BatchTable label="需求来源" headers={['原文件 / 工作表', '物理行 / 单元格', '接受版本 / 时间', '查看原始导入']}>{source.data.sources.map((item) => <tr key={`${item.source.importId}-${item.source.rowId}`}><td>{item.source.fileName}<small className="mapping-subtext">{item.source.sheetName}</small></td><td>第 {item.source.rowNumber} 行 · {item.source.addresses.join('、')}</td><td>v{item.acceptedVersion}<small className="mapping-subtext">{timestamp(item.createdAt)}</small></td><td><IconLink icon={Eye} label="查看源行与原件" description={`${item.source.fileName} · 第 ${item.source.rowNumber} 行`} to="/imports/$importId" params={{ importId: item.source.importId }} /></td></tr>)}</BatchTable></>}
    </BatchPanel>
    <BatchPanel title="发货日期、打印与更正" help="以下只保存本地操作事实，不修改领星。打印登记表示人员已完成相应操作，登记后冻结该确认版本。">
      <div className="field batch-reason"><label htmlFor="history-reason">本次登记 / 更正说明（必填）</label><Input id="history-reason" value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} /></div>
      <div className="batch-form"><div className="field"><label htmlFor="actual-ship-date">实际发货日期（本地登记）</label><DatePicker id="actual-ship-date" value={actualDate} disabled={group.status === 'superseded'} onValueChange={setActualDate} /></div><Button icon={CalendarCheck} loading={action.pendingKey?.startsWith('["date",')} disabled={action.busy || dateStale || !reason.trim() || Boolean(dateInputError(actualDate, {})) || group.status === 'superseded'} onClick={() => action.run(JSON.stringify(['date', actualDateVersion, actualDate, reason]), (operationId) => batchApi.groupAction(group.id, 'actual-ship-date', { operationId, expectedVersion: actualDateVersion, reason, actualShipDate: actualDate || null }), '实际发货日期已本地登记。')}>保存日期</Button></div>
      {dateStale && <p className="permission-note warning-note" role="status">日期草稿基于 v{actualDateVersion}，当前为 v{group.version}；输入仍保留。请核对已登记日期 {group.actualShipDate || '未登记'} 后重新载入，避免覆盖他人的修改。<Button icon={RotateCcw} onClick={() => { setActualDate(group.actualShipDate || ''); setActualDateVersion(group.version); }}>重新载入当前日期</Button></p>}
      {group.status === 'frozen' && <p className="mapping-help">实际发货日期作为独立本地事实登记，保持现有确认和箱码。新日期须另生成导出版本后才反映到文件，旧XLSX保持原日期。</p>}
      <div className="batch-subsection"><Check checked={printed} onChange={(checked) => setPrintedConfirmation(checked ? detail.confirmation?.id ?? '' : '')} disabled={!detail.confirmation || group.status === 'superseded'}>我已在线下完成当前确认版本的打印操作。</Check><Button icon={Printer} loading={action.pendingKey?.startsWith('["print",')} disabled={action.busy || !detail.confirmation || !printed || !reason.trim() || group.status === 'superseded'} onClick={() => action.run(JSON.stringify(['print', group.version, detail.confirmation?.id, reason]), (operationId) => batchApi.groupAction(group.id, 'print', { operationId, expectedVersion: group.version, reason, confirmationId: detail.confirmation!.id, note: reason }), '打印事实已保存，当前组冻结。')}>登记打印事实</Button></div>
      {group.status === 'frozen' && <div className="batch-subsection"><h3>创建独立更正版本</h3><p className="mapping-help">保留旧组、旧码和旧文件，新版本重新核对、确认及编码；旧版不能直接修改。</p><Button icon={FilePenLine} loading={action.pendingKey?.startsWith('["correction",')} disabled={action.busy || !reason.trim()} onClick={() => action.run(JSON.stringify(['correction', group.id, group.version, reason]), async (operationId) => { const result = await batchApi.groupAction(group.id, 'correction', { operationId, expectedVersion: group.version, reason }); if (result.groupId) selectGroup(result.groupId); return result; }, '独立更正版本已建立。')}>创建更正版本</Button></div>}
      {action.feedback}
    </BatchPanel>
    <BatchPanel title="分组与编码历史" help="操作人、时间、原因及旧版本保留；作废编码不回收复用。">
      <BatchTable label="分组版本历史" headers={['版本 / 动作', '时间 / 操作人', '原因', '成员 / 编码']}>{detail.history.map((item, index) => <tr key={`${item.version}-${index}`}><td>v{item.version} · {item.action}</td><td>{timestamp(item.createdAt)}<small className="mapping-subtext">{item.createdBy}</small></td><td>{item.reason}</td><td>{item.snapshot.demandIds.length} 票 · {item.snapshot.prefix || '未分配'}</td></tr>)}</BatchTable>
      <BatchTable label="历史箱编码" headers={['编码', '箱 ID', '状态', '分配时间']}>{detail.codes.map((code) => <tr key={code.id}><td>{code.code}</td><td>{code.boxId}</td><td>{code.valid ? '有效' : '已作废'}</td><td>{timestamp(code.createdAt)}</td></tr>)}</BatchTable>
    </BatchPanel>
  </>;
}
