import type { ShipmentReportBox, ShipmentReportRow } from '@scm/contracts';

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

export function sortReportRows(rows: ShipmentReportRow[]): ShipmentReportRow[] {
  const blocks = new Map<string, { code?: string; rows: ShipmentReportRow[] }>();
  for (const row of rows) {
    const key = JSON.stringify([row.shippingRunId, row.ticketId, row.groupId, row.demandId ?? [row.sid, row.fba]]);
    const block: { code?: string; rows: ShipmentReportRow[] } = blocks.get(key) ?? { rows: [] };
    const codes = [...(row.codes ?? [])].sort(compareInternalCodes);
    for (const code of codes) if (block.code === undefined || compareInternalCodes(code, block.code) < 0) block.code = code;
    block.rows.push({ ...row, codes });
    blocks.set(key, block);
  }
  // Move complete FBA blocks; retain their product stair-step order and stable ties.
  return [...blocks.values()].sort((left, right) => left.code === undefined ? (right.code === undefined ? 0 : 1)
    : right.code === undefined ? -1 : compareInternalCodes(left.code, right.code)).flatMap((block) => block.rows);
}

export function sortReportBoxes(boxes: ShipmentReportBox[]): ShipmentReportBox[] {
  return [...boxes].sort((left, right) => compareInternalCodes(left.code, right.code));
}
