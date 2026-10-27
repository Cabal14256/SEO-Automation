import { formatReportCodeRanges, reportTicketKey, type ShipmentReportBox, type ShipmentReportRow } from '@scm/contracts';

const textOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function compareInternalCodes(left: string, right: string): number {
  const a = /^([A-Z]+)(\d+)$/.exec(left), b = /^([A-Z]+)(\d+)$/.exec(right);
  if (a && b) {
    // Match the allocation sequence A…Z, AA, AB… rather than placing AA before B.
    const prefix = a[1]!.length - b[1]!.length || textOrder.compare(a[1]!, b[1]!);
    if (prefix) return prefix;
    const first = BigInt(a[2]!), second = BigInt(b[2]!);
    return first < second ? -1 : first > second ? 1 : 0;
  }
  if (a || b) return a ? -1 : 1;
  return textOrder.compare(left, right);
}

/** Summaries use the complete ticket before pagination; actual per-product codes stay intact. */
export function summarizeReportTicketCodes(rows: ShipmentReportRow[], boxes: ShipmentReportBox[] = []): ShipmentReportRow[] {
  const codes = new Map<string, Set<string>>();
  const add = (key: string, values: string[]) => {
    const group = codes.get(key) ?? new Set<string>();
    for (const code of values) group.add(code);
    codes.set(key, group);
  };
  for (const row of rows) add(reportTicketKey(row), row.codes ?? []);
  for (const box of boxes) add(reportTicketKey(box), [box.code]);
  return rows.map((row) => ({ ...row, ticketCodeRange: boxes.length === 0 && row.ticketCodeRange ? row.ticketCodeRange
    : formatReportCodeRanges([...(codes.get(reportTicketKey(row)) ?? [])]) }));
}

export function sortReportRows(rows: ShipmentReportRow[]): ShipmentReportRow[] {
  type Block = { rows: ShipmentReportRow[]; boxes: Set<string>; code?: string };
  type Product = { row: ShipmentReportRow; total: bigint };
  type Ticket = { row: ShipmentReportRow; blocks: Map<string, Block>; products: Map<string, Product>; code?: string };
  const productKey = (row: ShipmentReportRow) => JSON.stringify([row.sid, row.msku, row.fnsku, row.sku]);
  const tickets = new Map<string, Ticket>();
  const minimum = (left: string | undefined, right: string | undefined) => right === undefined ? left
    : left === undefined || compareInternalCodes(right, left) < 0 ? right : left;
  for (const row of rows) {
    const ticketKey = reportTicketKey(row), ticket = tickets.get(ticketKey) ?? { row, blocks: new Map<string, Block>(), products: new Map<string, Product>() };
    const blockKey = JSON.stringify([row.groupId, row.demandId ?? [row.sid, row.fba]]);
    const block = ticket.blocks.get(blockKey) ?? { rows: [], boxes: new Set<string>() };
    const codes = [...(row.codes ?? [])].sort(compareInternalCodes);
    for (const code of codes) block.code = minimum(block.code, code);
    for (const box of row.boxes ?? []) block.boxes.add(box.boxId);
    block.rows.push({ ...row, codes });
    const identity = productKey(row), product = ticket.products.get(identity) ?? { row, total: 0n };
    product.total += BigInt(row.quantity);
    ticket.products.set(identity, product);
    ticket.code = minimum(ticket.code, block.code);
    ticket.blocks.set(blockKey, block); tickets.set(ticketKey, ticket);
  }
  const codeOrder = (left?: string, right?: string) => left === undefined ? (right === undefined ? 0 : 1)
    : right === undefined ? -1 : compareInternalCodes(left, right);
  const compareTickets = (left: Ticket, right: Ticket) => {
    const a = left.row, b = right.row;
    if (a.shippingRunId === b.shippingRunId && a.sourceTicketIndex !== undefined && b.sourceTicketIndex !== undefined)
      return a.sourceTicketIndex - b.sourceTicketIndex || codeOrder(left.code, right.code);
    if (a.ticketNumber && b.ticketNumber) return textOrder.compare(a.ticketNumber, b.ticketNumber) || codeOrder(left.code, right.code);
    return codeOrder(left.code, right.code);
  };
  return [...tickets.values()].sort(compareTickets).flatMap((ticket) => {
    // Build one product order from the complete business ticket, then reuse it
    // in every FBA even when their local quantity proportions differ.
    const products = [...ticket.products.entries()].sort(([leftKey, left], [rightKey, right]) =>
      (left.total > right.total ? -1 : left.total < right.total ? 1 : 0)
      || textOrder.compare(left.row.sku, right.row.sku) || textOrder.compare(left.row.fnsku, right.row.fnsku)
      || textOrder.compare(left.row.msku, right.row.msku) || left.row.sid - right.row.sid
      || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0));
    const rank = new Map(products.map(([key], index) => [key, index]));
    return [...ticket.blocks.values()]
      .sort((left, right) => left.boxes.size - right.boxes.size
        || (left.rows[0]!.inputOrder !== undefined && right.rows[0]!.inputOrder !== undefined ? left.rows[0]!.inputOrder! - right.rows[0]!.inputOrder! : 0)
        || codeOrder(left.code, right.code))
      .flatMap((block) => block.rows.sort((left, right) => rank.get(productKey(left))! - rank.get(productKey(right))!));
  });
}

export function sortReportBoxes(boxes: ShipmentReportBox[]): ShipmentReportBox[] {
  return [...boxes].sort((left, right) => compareInternalCodes(left.code, right.code));
}
