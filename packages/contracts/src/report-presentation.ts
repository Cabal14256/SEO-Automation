import type { ShipmentReport, ShipmentReportBox, ShipmentReportRow } from './reports.js';

type TicketIdentity = Pick<ShipmentReportRow, 'shippingRunId' | 'ticketId' | 'ticketNumber' | 'groupId'>;

/** A business ticket can contain several internal processing groups. */
export function reportTicketKey(row: TicketIdentity): string {
  const ticket = row.ticketId ? ['ticket', row.ticketId]
    : row.ticketNumber ? ['number', row.ticketNumber] : ['group', row.groupId];
  return JSON.stringify([row.shippingRunId ?? null, ticket]);
}

const textOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const parseCode = (code: string) => {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(code);
  return match ? { prefix: match[1]!, sequence: BigInt(match[2]!) } : null;
};

/** Compress actual contiguous codes only; gaps and different prefixes remain separate. */
export function formatReportCodeRanges(codes: readonly string[]): string {
  const sorted = [...new Set(codes.filter((code) => code.length > 0))].sort((left, right) => {
    const a = parseCode(left), b = parseCode(right);
    if (!a || !b) return a ? -1 : b ? 1 : textOrder.compare(left, right);
    const prefix = a.prefix.length - b.prefix.length || textOrder.compare(a.prefix, b.prefix);
    return prefix || (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
  });
  const ranges: string[] = [];
  let first: string | undefined, last: string | undefined;
  const flush = () => { if (first !== undefined) ranges.push(first === last ? first : `${first}-${last}`); };
  for (const code of sorted) {
    const previous = last === undefined ? null : parseCode(last), next = parseCode(code);
    if (previous && next && previous.prefix === next.prefix && next.sequence === previous.sequence + 1n) last = code;
    else { flush(); first = code; last = code; }
  }
  flush();
  return ranges.join('、');
}

export type ReportTicketCodeDisplay = { range: string; uniform: boolean };

const isUnitedStates = (country: string) => ['美国', 'US', 'USA', 'UNITED STATES'].includes(country.trim().toUpperCase());

/** Compare actual carton contents across the complete ticket, including separate FBAs. */
function boxProductSignature(box: ShipmentReportBox): string {
  const quantities = new Map<string, bigint>();
  for (const item of box.items) {
    if (item.quantity <= 0) continue;
    const identity = JSON.stringify([box.sid, item.msku, item.fnsku, item.sku]);
    quantities.set(identity, (quantities.get(identity) ?? 0n) + BigInt(item.quantity));
  }
  return JSON.stringify([...quantities].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([identity, quantity]) => [identity, quantity.toString()]));
}

/** Box data is complete even when product rows are paginated. Missing data never implies equal packing. */
export function getReportTicketCodeDisplays(report: Pick<ShipmentReport, 'rows' | 'boxes'> | undefined): Map<string, ReportTicketCodeDisplay> {
  type Ticket = { codes: string[]; rows: ShipmentReportRow[]; boxes: ShipmentReportBox[] };
  const tickets = new Map<string, Ticket>();
  const ticket = (key: string) => {
    const value = tickets.get(key) ?? { codes: [], rows: [], boxes: [] };
    tickets.set(key, value);
    return value;
  };
  for (const row of report?.rows ?? []) {
    const value = ticket(reportTicketKey(row));
    value.codes.push(...row.codes); value.rows.push(row);
  }
  for (const box of report?.boxes ?? []) {
    const value = ticket(reportTicketKey(box));
    value.codes.push(box.code); value.boxes.push(box);
  }
  return new Map([...tickets].map(([key, value]) => {
    const signature = value.boxes[0] && boxProductSignature(value.boxes[0]);
    const uniform = value.rows.length > 0 && value.rows.every((row) => isUnitedStates(row.country))
      && signature !== undefined && signature !== '[]' && value.boxes.every((box) => boxProductSignature(box) === signature);
    return [key, { range: value.rows.find((row) => row.ticketCodeRange !== undefined)?.ticketCodeRange ?? formatReportCodeRanges(value.codes), uniform }];
  }));
}

/** Unequal packing lists only the positive carton allocations of this product row. */
export function getReportRowCodeLabel(row: Pick<ShipmentReportRow, 'boxes'>, display: ReportTicketCodeDisplay | undefined, firstRow: boolean): string {
  if (display?.uniform) return firstRow ? display.range : '';
  return [...new Set([...row.boxes].sort((left, right) => left.boxOrder - right.boxOrder)
    .filter((box) => box.quantity > 0 && box.code.length > 0).map((box) => box.code))].join('');
}
