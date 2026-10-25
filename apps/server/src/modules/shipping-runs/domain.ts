import { createHash } from 'node:crypto';
import type { ShippingRunIssue } from '@scm/contracts';

const countries: Record<string, string> = {
  US: 'US', USA: 'US', 美国: 'US', UK: 'UK', GB: 'UK', GBR: 'UK', 英国: 'UK', DE: 'DE', 德国: 'DE', FR: 'FR', 法国: 'FR', ES: 'ES', 西班牙: 'ES', IT: 'IT', 意大利: 'IT',
  CA: 'CA', 加拿大: 'CA', AU: 'AU', 澳大利亚: 'AU', JP: 'JP', 日本: 'JP', MX: 'MX', 墨西哥: 'MX', AE: 'AE', 阿联酋: 'AE', SA: 'SA', 沙特阿拉伯: 'SA', 沙特: 'SA',
  NL: 'NL', 荷兰: 'NL', PL: 'PL', 波兰: 'PL', SE: 'SE', 瑞典: 'SE', BE: 'BE', 比利时: 'BE', IE: 'IE', 爱尔兰: 'IE', SG: 'SG', 新加坡: 'SG', IN: 'IN', 印度: 'IN',
  'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', 'UNITED KINGDOM': 'UK', 'GREAT BRITAIN': 'UK', GERMANY: 'DE', FRANCE: 'FR', SPAIN: 'ES', ITALY: 'IT',
  CANADA: 'CA', AUSTRALIA: 'AU', JAPAN: 'JP', MEXICO: 'MX', 'UNITED ARAB EMIRATES': 'AE', 'SAUDI ARABIA': 'SA', NETHERLANDS: 'NL', POLAND: 'PL', SWEDEN: 'SE', BELGIUM: 'BE', IRELAND: 'IE', SINGAPORE: 'SG', INDIA: 'IN',
};
export function shippingCountry(value: string | null | undefined): string | null {
  const clean = value?.trim().toUpperCase();
  return clean ? countries[clean] ?? (/^[A-Z]{2}$/.test(clean) ? clean : null) : null;
}
export function shippingOperationId(runId: string, step: string) {
  const hex = createHash('sha256').update(`${runId}:${step}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
export function shippingTicketNumber(date: string, sequence: number, country: string, ticketSequence: number) {
  return `${date.replaceAll('-', '')}-${sequence}-${country}-${ticketSequence}`;
}
export function lookupDateRange(date: string) {
  const start = new Date(`${date}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 89);
  const end = new Date(`${date}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
  return { startDate: start.toISOString().slice(0, 10), endDate: date, exclusiveEndDate: end.toISOString().slice(0, 10) };
}
export type ShippingSourceRow = { id: string; rowNumber: number; normalized: { fba: string | null; sourceTicketIndex?: number; sourceMemberIndex?: number }; issues: { code: string; message: string; severity: string }[] };
export function sourceTicketLayout(rows: readonly ShippingSourceRow[]) {
  const tickets = new Map<number, Array<{ sourceRowId: string; fba: string; inputOrder: number }>>();
  const issues: ShippingRunIssue[] = []; const seen = new Map<string, number>();
  for (const row of rows) {
    const ticketIndex = row.normalized.sourceTicketIndex ?? 1;
    const fba = row.normalized.fba?.trim().toUpperCase() ?? '';
    for (const issue of row.issues.filter((issue) => issue.severity === 'error' && !['SHOP_REQUIRED', 'COUNTRY_REQUIRED', 'SOURCE_MAPPING_REQUIRED', 'SELLER_ALIAS_CONFLICT', 'SELLER_COUNTRY_MISMATCH', 'COUNTRY_MISMATCH'].includes(issue.code))) issues.push({ code: issue.code, message: `第 ${row.rowNumber} 行：${issue.message}`, ticketIndex, ...(fba ? { fba } : {}) });
    if (!/^FBA[A-Z0-9]+$/.test(fba)) { issues.push({ code: 'INVALID_FBA', message: `第 ${row.rowNumber} 行的 FBA 无效。`, ticketIndex, ...(fba ? { fba } : {}) }); continue; }
    if (seen.has(fba)) { issues.push({ code: 'DUPLICATE_FBA', message: `FBA 在第 ${seen.get(fba)} 票与第 ${ticketIndex} 票的输入中重复，请保留一次。`, ticketIndex, fba }); continue; }
    seen.set(fba, ticketIndex);
    const members = tickets.get(ticketIndex) ?? [];
    members.push({ sourceRowId: row.id, fba, inputOrder: row.normalized.sourceMemberIndex ?? members.length + 1 }); tickets.set(ticketIndex, members);
  }
  if (!rows.length) issues.push({ code: 'EMPTY_SHIPMENT', message: '本次发货没有有效 FBA，请填写后重新解析。' });
  return { tickets: [...tickets].sort(([a], [b]) => a - b).map(([sourceTicketIndex, members]) => ({ sourceTicketIndex, members: members.sort((a, b) => a.inputOrder - b.inputOrder) })), issues };
}
export function numberTickets(tickets: Array<{ id: string; sourceTicketIndex: number; country: string }>, date: string, sequence: number) {
  const counts = new Map<string, number>();
  return [...tickets].sort((a, b) => a.sourceTicketIndex - b.sourceTicketIndex).map((ticket) => {
    const ticketSequence = (counts.get(ticket.country) ?? 0) + 1; counts.set(ticket.country, ticketSequence);
    return { ...ticket, ticketSequence, number: shippingTicketNumber(date, sequence, ticket.country, ticketSequence) };
  });
}
