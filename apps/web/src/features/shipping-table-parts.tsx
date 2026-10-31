import { formatReportCodeRanges, reportTicketKey, type ShipmentReport } from '@scm/contracts';

type ShippingShopCellProps = {
  shop: string;
  sid?: number;
  country: string;
  channel: string | null;
};

export function ShippingShopCell({ shop, sid, country, channel }: ShippingShopCellProps) {
  return <td>{shop || '—'}<small className="mapping-subtext">{sid !== undefined ? `sid ${sid} · ` : ''}{country || '—'} · {channel || '未填渠道'}</small></td>;
}

type ShippingProductCellsProps = {
  msku: string | null;
  fnsku: string | null;
  productName: string | null;
  sku: string | null;
  separate?: boolean;
  placeholder?: boolean;
};

export function ShippingProductCells({ msku, fnsku, productName, sku, separate = false, placeholder = false }: ShippingProductCellsProps) {
  if (separate) return <><td>{msku || '—'}</td><td>{fnsku || '—'}</td><td className="demand-product-name">{placeholder ? <span className="mapping-subtext">待同步商品 / 逐箱数据</span> : productName || '缺少品名'}</td><td>{sku || '—'}</td></>;
  return <><td>{msku || '—'}<small className="mapping-subtext">{fnsku || '—'}</small></td><td className="demand-product-name">{placeholder ? <span className="mapping-subtext">待同步商品 / 逐箱数据</span> : productName || '缺少品名'}<small className="mapping-subtext">{sku || '—'}</small></td></>;
}

type ShippingBoxQuantityCellsProps = {
  columns: number[];
  boxes: Array<{ boxOrder: number; displayBoxOrder?: number; quantity: number | null; orderConfirmed?: boolean; sourceLabel?: string | null }>;
};

export function ShippingBoxQuantityCells({ columns, boxes }: ShippingBoxQuantityCellsProps) {
  return <>{columns.map((order) => {
    const box = boxes.find((entry) => entry.boxOrder === order);
    return <td key={order} className="demand-number" title={box?.orderConfirmed === false ? '展示列序号，箱序待确认' : undefined}>{box ? box.quantity ?? '待核对' : '—'}{box?.orderConfirmed === false && <small className="mapping-subtext">{box.sourceLabel ? `${box.sourceLabel} · 箱序待确认` : '箱序待确认'}</small>}</td>;
  })}</>;
}

export function ShippingCodesCell({ codes, range }: { codes?: string[]; range?: string }) {
  return <td>{range !== undefined ? range : codes?.join('、') || '待编码'}</td>;
}

// These four helpers are pure table structure with no hooks. Scoped Canvas
// tables may explicitly expand their cells without invoking arbitrary components.
ShippingShopCell.gridCells = ShippingShopCell;
ShippingProductCells.gridCells = ShippingProductCells;
ShippingBoxQuantityCells.gridCells = ShippingBoxQuantityCells;
ShippingCodesCell.gridCells = ShippingCodesCell;

export function getShippingBoxColumns(maxBoxes: number | undefined, boxes?: ReadonlyArray<{ boxOrder: number }>) {
  const maximum = boxes === undefined ? maxBoxes ?? 0 : boxes.reduce((maximum, box) => Math.max(maximum, box.boxOrder), 0);
  return Array.from({ length: Math.max(5, maximum) }, (_, index) => index + 1);
}

export function getReportTicketCodeRanges(report: Pick<ShipmentReport, 'rows' | 'boxes'> | undefined): Map<string, string> {
  const codes = new Map<string, string[]>();
  for (const row of report?.rows ?? []) {
    const key = reportTicketKey(row);
    const ticketCodes = codes.get(key) ?? [];
    ticketCodes.push(...row.codes); codes.set(key, ticketCodes);
  }
  for (const box of report?.boxes ?? []) {
    const key = reportTicketKey(box);
    const ticketCodes = codes.get(key) ?? [];
    ticketCodes.push(box.code); codes.set(key, ticketCodes);
  }
  const ranges = new Map([...codes].map(([key, values]) => [key, formatReportCodeRanges(values)]));
  for (const row of report?.rows ?? []) if (row.ticketCodeRange !== undefined) ranges.set(reportTicketKey(row), row.ticketCodeRange);
  return ranges;
}
