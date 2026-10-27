import type { ShipmentReportRow } from './reports.js';

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
