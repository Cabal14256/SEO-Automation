import { Fragment, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import type { DemandWorkspaceRow } from '@scm/contracts';
import { Button, IconLink } from '../components/ui/button';
import { ShippingBoxQuantityCells, ShippingCodesCell, ShippingProductCells, ShippingShopCell } from './shipping-table-parts';

export type ShippingPresentation = 'shipments' | 'products' | 'boxes';
export const shippingStatusLabels = { unsynced: '未同步', candidate: '候选', needs_review: '待核对', confirmed: '已确认', frozen: '已冻结' } as const;
const displayTime = (value: string | null) => {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(date);
};

type Props = {
  rows: DemandWorkspaceRow[]; presentation: ShippingPresentation; boxColumns: number[];
  scopedGroup: boolean; expanded: string[]; toggleExpanded: (id: string) => void;
  renderSelection: (row: DemandWorkspaceRow, firstDemand: boolean, firstGroup: boolean) => ReactNode;
  openGroup?: (batchId: string, groupId: string) => void;
  arrange?: (ids: string[], mode: 'create' | 'append') => void; locked: boolean;
  manageDemand?: (id: string, mode: 'view' | 'edit' | 'delete') => void;
  month: string;
};

export function ShippingWorkbenchTable({ rows, presentation, boxColumns, scopedGroup, expanded, toggleExpanded, renderSelection, openGroup, arrange, manageDemand, locked, month }: Props) {
  const shipments = new Map<string, DemandWorkspaceRow[]>();
  const firstGroup = new Map<string, string>();
  for (const row of rows) {
    shipments.set(row.demandId, [...shipments.get(row.demandId) ?? [], row]);
    if (row.groupId && !firstGroup.has(row.groupId)) firstGroup.set(row.groupId, row.id);
  }
  const firstDemand = (row: DemandWorkspaceRow) => shipments.get(row.demandId)?.[0]?.id === row.id;
  const isFirstGroup = (row: DemandWorkspaceRow) => Boolean(row.groupId && firstGroup.get(row.groupId) === row.id);
  const identityHeaders = scopedGroup ? ['货件 / 目的仓'] : ['货件 / 批次 / 目的仓', '店铺 / 国家 / 渠道'];
  const headers = presentation === 'boxes'
    ? [...identityHeaders, '箱序 / 内部编码', 'MSKU / FNSKU', '品名 / SKU', '箱内数量', '登记重量', '登记尺寸', '状态 / 来源版本', '操作']
    : [...identityHeaders, 'MSKU / FNSKU', '品名 / SKU', '商品数量', ...boxColumns.map((order) => `箱 ${order}`), '内部编码', '批次商品总量', month ? '筛选月商品量' : '全期商品量', '状态 / 来源版本', '业务日期 / 实际发货日期', '操作'];
  const actions = (row: DemandWorkspaceRow, withManagement = false) => <div className="shipping-shipment-actions">{row.lifecycle !== 'cancelled' && (row.groupId && row.batchId && openGroup
    ? <Button type="button" variant="text" disabled={locked} onClick={() => openGroup(row.batchId!, row.groupId!)}>处理批次</Button>
    : !row.groupId && arrange ? <Button type="button" variant="text" disabled={locked} onClick={() => arrange([row.demandId], 'create')}>安排批次</Button> : null)}{row.lifecycle !== 'cancelled' && (row.batchId || !arrange) && <WorkspaceLink row={row} />}{withManagement && manageDemand && <div className="shipping-demand-record-actions"><Button type="button" variant="text" icon={Eye} disabled={locked} onClick={() => manageDemand(row.demandId, 'view')}>查看需求</Button><Button type="button" variant="text" icon={Pencil} disabled={locked || row.status === 'frozen' || row.lifecycle === 'cancelled'} title={row.lifecycle === 'cancelled' ? '已删除需求的历史只读。' : row.status === 'frozen' ? '已冻结，请通过批次更正处理。' : undefined} onClick={() => manageDemand(row.demandId, 'edit')}>编辑需求</Button><Button type="button" variant="text" icon={Trash2} disabled={locked || row.status === 'frozen' || row.lifecycle === 'cancelled'} title={row.lifecycle === 'cancelled' ? '已删除需求的历史只读。' : row.status === 'frozen' ? '已冻结，请通过批次更正处理。' : undefined} onClick={() => manageDemand(row.demandId, 'delete')}>删除需求</Button></div>}</div>;
  const identity = (row: DemandWorkspaceRow, selection: ReactNode) => <><td className="shipping-row-identity">{selection}<strong>{row.fba}</strong>{!scopedGroup && <small className="mapping-subtext">{row.ticketNumber || (row.shippingMonth ? row.shippingMonth + ' 第 ' + row.shippingSequence + ' 次' : row.groupName ? '历史批次／未关联发货次' : '待安排')} · {row.groupName || '待分组'}</small>}<small className="mapping-subtext">{row.destinationFc || '目的仓未填写'}</small>{row.destinationAddress && <details className="demand-address"><summary>仓库地址</summary><p>{row.destinationAddress}</p></details>}</td>{!scopedGroup && <ShippingShopCell {...row} />}</>;
  const product = (row: DemandWorkspaceRow, selection: ReactNode) => <tr key={row.id} className={`demand-row demand-row-${row.status}`}>
    {identity(row, selection)}<ShippingProductCells {...row} placeholder={row.rowKind === 'placeholder'} />
    <td className="demand-number">{row.quantity ?? '待同步'}</td><ShippingBoxQuantityCells columns={boxColumns} boxes={row.boxes} /><ShippingCodesCell codes={row.codes} />
    <td className="demand-number">{row.groupQuantity ?? '—'}</td><td className="demand-number">{row.monthQuantity ?? '—'}</td>
    <td><ShippingSource row={row} /></td><td>{row.businessDate}<small className="mapping-subtext">发货：{row.actualShipDate || '未登记'}</small></td><td>{actions(row, presentation !== 'shipments' && firstDemand(row))}</td>
  </tr>;
  return <div className="table-scroll shipping-unified-scroll" role="region" aria-label="发货明细表，可横向滚动" tabIndex={0}>
    <table className="task-table shipping-unified-table"><thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead><tbody>
      {presentation === 'shipments' ? [...shipments].map(([id, members]) => {
        const row = members[0]!; const open = expanded.includes(id);
        return <Fragment key={id}><tr className="shipping-shipment-heading"><td colSpan={headers.length}><div className="shipping-shipment-summary">
          <div className="shipping-summary-identity">{renderSelection(row, true, isFirstGroup(row))}<button type="button" className="text-button shipping-expand" aria-expanded={open} aria-controls={`shipment-products-${id}`} onClick={() => toggleExpanded(id)}><ChevronDown size={16} aria-hidden="true" /><strong>{row.fba}</strong><span>{open ? '收起明细' : '商品与逐箱明细'}</span></button></div>
          <div className="shipping-summary-meta">{!scopedGroup && <span>{row.groupName || '待分组'} · {row.shop} · {row.country} · {row.channel || '渠道未填'}</span>}<span>目的仓 {row.destinationFc || '未填写'} · {members.filter((item) => item.rowKind === 'product').length} 条商品 · {row.totalBoxes === null ? '装箱待同步' : `${row.totalBoxes} 箱`}</span></div>
          <span className={`demand-status demand-status-${row.status}`}>{row.lifecycle === 'cancelled' ? '已删除' : shippingStatusLabels[row.status]}</span>{actions(row, true)}
        </div></td></tr><tr id={`shipment-products-${id}`} hidden={!open} className="shipping-detail-anchor"><td colSpan={headers.length}>货件 {row.fba} 商品明细</td></tr>{open && members.map((item) => product(item, null))}</Fragment>;
      }) : presentation === 'products' ? rows.map((row) => product(row, renderSelection(row, firstDemand(row), isFirstGroup(row)))) : rows.flatMap((row) => {
        if (!row.boxes.length) return [<tr key={row.id}>{identity(row, renderSelection(row, firstDemand(row), isFirstGroup(row)))}<td colSpan={6}>{row.lifecycle === 'cancelled' ? '已删除需求保留历史记录。' : '尚无装箱数据，请先同步或补录。'}</td><td><ShippingSource row={row} /></td><td>{actions(row, firstDemand(row))}</td></tr>];
        return row.boxes.map((box, index) => <tr key={`${row.id}:${box.boxId}`}>
          {identity(row, index === 0 ? renderSelection(row, firstDemand(row), isFirstGroup(row)) : null)}
          <td>{box.orderConfirmed === false ? '箱序待确认' : `第 ${box.boxOrder} 箱`}<small className="mapping-subtext">{box.code || '待编码'}</small>{(box.boxName || box.sourceLabel) && <small className="mapping-subtext">{box.boxName || box.sourceLabel}</small>}</td>
          <ShippingProductCells {...row} /><td className="demand-number">{box.quantity ?? '待核对'}</td>
          <td>{box.weight == null ? '缺失' : `${box.weight} ${box.weightUnit || '单位缺失'}`}</td><td>{box.length == null || box.width == null || box.height == null ? '缺失' : `${box.length} × ${box.width} × ${box.height} ${box.lengthUnit || '单位缺失'}`}</td>
          <td><ShippingSource row={row} /><details><summary>箱标识</summary><p>外部 ID：{box.externalBoxId || '—'}<br />本地 ID：{box.localBoxId || '—'}</p></details></td><td>{actions(row, firstDemand(row) && index === 0)}</td>
        </tr>);
      })}
    </tbody></table>
  </div>;
}

function ShippingSource({ row }: { row: DemandWorkspaceRow }) {
  return <><span className={`demand-status demand-status-${row.status}`}>{row.lifecycle === 'cancelled' ? '已删除' : shippingStatusLabels[row.status]}</span>{row.issues.length > 0 && <details className="demand-issues"><summary>{row.issues.length} 项提示</summary><ul>{row.issues.map((issue, index) => <li key={index} className={issue.severity === 'error' ? 'error-note' : 'warning-note'}>{issue.message}</li>)}</ul></details>}<details className="shipping-source-details"><summary>{row.confirmationId ? '确认数据' : '候选 / 来源'} · 需求 v{row.demandVersion}</summary>
    <p>需求 v{row.demandVersion}{row.currentDemandVersion !== row.demandVersion ? ` / 当前 v${row.currentDemandVersion}` : ''} · 商品 {row.dataVersion ? `v${row.dataVersion}` : '待同步'}</p>
    {row.confirmationId && <p>确认版本：{row.confirmationId}</p>}{row.dataRevisionId && <p>数据修订：{row.dataRevisionId}</p>}
    <p>来源填写：{displayTime(row.sourceFilledAt)}<br />货件创建：{displayTime(row.shipmentCreatedAt)}<br />已装天数：{row.packingDays ?? '—'}<br />备注：{row.notes || '—'}</p>
    {row.sources.length > 0 && <ul className="demand-source-list">{row.sources.map((source, index) => <li key={index}><Link to="/imports/$importId" params={{ importId: source.importId }}>{source.fileName}</Link><small>{source.sheetName} · 第 {source.rowNumber} 行</small></li>)}</ul>}
  </details></>;
}

function WorkspaceLink({ row }: { row: DemandWorkspaceRow }) {
  if (row.batchId) return <IconLink icon={Eye} label={row.groupId ? '查看货件' : '进入批次分组'} description={`${row.fba} · ${row.shop}`} to="/batches/$batchId" params={{ batchId: row.batchId }} search={{ demandId: row.demandId, groupId: row.groupId ?? undefined, tab: 'shipments' }} />;
  return <Link className="text-button" to="/batches" search={{}}><Plus size={18} aria-hidden="true" />安排发货次</Link>;
}
