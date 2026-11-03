import { manualTransportMethods, type FbaLookupCandidate, type FbaLookupRecord, type FbaLookupRow, type OnlineImportRow } from '@scm/contracts';
import { pinyin } from 'pinyin-pro';

export const onlineColumns = [
  { key: 'fba', label: 'FBA 货件号', placeholder: 'FBA…' },
  { key: 'shop', label: '店铺', placeholder: '店铺名称' },
  { key: 'channel', label: '业务渠道', placeholder: '运输方式全名或拼音缩写' },
  { key: 'country', label: '国家', placeholder: '国家' },
  { key: 'destinationFc', label: '目的 FC', placeholder: '如 ONT8' },
  { key: 'destinationAddress', label: '仓库地址', placeholder: '完整地址' },
  { key: 'shipmentCreatedAt', label: '货件创建时间', placeholder: 'YYYY-MM-DD 或日期时间' },
  { key: 'sourceFilledAt', label: '来源填写时间', placeholder: 'YYYY-MM-DD 或日期时间' },
  { key: 'notes', label: '备注', placeholder: '备注' },
] as const;
export type OnlineCellKey = typeof onlineColumns[number]['key'];
export type OnlineChannelMatch = { value: string; candidates: string[] };
/** Resolve complete initials against local names, without requesting a remote directory. */
export function createOnlineChannelMatcher(names: readonly string[] = manualTransportMethods.map((method) => method.name)) {
  const actualNames = new Set(names.map((name) => name.trim()).filter(Boolean));
  const literals = new Map<string, string[]>(), initials = new Map<string, string[]>();
  for (const name of actualNames) {
    const abbreviation = pinyin(name, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' })
      .join('').replace(/[^a-z0-9]/gi, '').toUpperCase();
    for (const [index, key] of [[literals, name.toUpperCase()], [initials, abbreviation]] as const) {
      index.set(key, [...(index.get(key) ?? []), name]);
    }
  }
  return (value: string): OnlineChannelMatch => {
    const trimmed = value.trim();
    if (!trimmed || actualNames.has(trimmed) || !/^[a-z0-9]+$/i.test(trimmed)) return { value: trimmed, candidates: [] };
    const key = trimmed.toUpperCase();
    const candidates = literals.get(key) ?? initials.get(key) ?? [];
    return { value: candidates.length === 1 ? candidates[0]! : trimmed, candidates };
  };
}
export const emptyOnlineRow = (): OnlineImportRow => ({ fba: '', shop: '', channel: '', country: '', destinationFc: '', destinationAddress: '', shipmentCreatedAt: '', sourceFilledAt: '', referenceQuantity: '', notes: '' });
export const hasOnlineContent = (row: OnlineImportRow) => onlineColumns.some(({ key }) => row[key].trim() !== '');

/** Empty rows between members carry ticket boundaries, including in saved drafts. */
export function trimOnlineRows<T extends { value: OnlineImportRow }>(rows: T[]): T[] {
  const first = rows.findIndex((row) => hasOnlineContent(row.value));
  if (first < 0) return [];
  let end = rows.length;
  while (end > first && !hasOnlineContent(rows[end - 1]!.value)) end -= 1;
  return rows.slice(first, end);
}

export function onlineTicketPreview(rows: { value: OnlineImportRow }[]) {
  const tickets: { index: number; count: number; firstRow: number; lastRow: number }[] = [];
  let separated = true;
  rows.forEach((row, position) => {
    if (!hasOnlineContent(row.value)) { separated = true; return; }
    if (separated) tickets.push({ index: tickets.length + 1, count: 0, firstRow: position + 1, lastRow: position + 1 });
    const ticket = tickets[tickets.length - 1]!;
    ticket.count += 1; ticket.lastRow = position + 1; separated = false;
  });
  return tickets;
}

export const normalFba = (value: string) => value.trim().toUpperCase();
export const lookupFields = ['shop', 'country', 'destinationFc', 'destinationAddress', 'shipmentCreatedAt'] as const;
// Legacy drafts may still contain channel provenance; it must never clear manual input.
export type AutofilledValues = Partial<Record<typeof lookupFields[number] | 'channel', string>>;
export type OnlineDraftRow = { id: string; value: OnlineImportRow; lookup?: FbaLookupRow; lookupId?: string; autofilled?: AutofilledValues };
export const candidateValue = (candidate: FbaLookupCandidate, key: typeof lookupFields[number]) => candidate[key] ?? '';
export const conflictsWith = (row: OnlineImportRow, candidate: FbaLookupCandidate) => lookupFields.filter((key) => row[key].trim() && candidateValue(candidate, key).trim() && row[key].trim() !== candidateValue(candidate, key).trim());
export function clearAutofilled(value: OnlineImportRow, autofilled: AutofilledValues = {}) {
  for (const key of lookupFields) if (autofilled[key] !== undefined && value[key] === autofilled[key]) value[key] = '';
}

/** Keep one lookup credential per row even when duplicate FBAs share a batch. */
export function mergeLookupRecord(rows: OnlineDraftRow[], record: FbaLookupRecord): OnlineDraftRow[] {
  if (record.status !== 'completed') return rows;
  const results = new Map(record.rows.map((row) => [normalFba(row.fba), row]));
  return rows.map((row) => {
    const lookup = results.get(normalFba(row.value.fba));
    if (!lookup || row.lookupId === record.id && row.lookup) return row;
    const value = { ...row.value };
    const adoptedSid = value.lookupId === record.id ? value.lookupSid : undefined;
    delete value.lookupId; delete value.lookupSid;
    if (lookup.status === 'ambiguous' && lookup.candidates.some((candidate) => candidate.sid === adoptedSid && !conflictsWith(row.value, candidate).length)) {
      return { ...row, lookup, lookupId: record.id };
    }
    if (lookup.status !== 'unique' || !lookup.candidates[0]) return { ...row, value, lookup, lookupId: record.id };
    const candidate = lookup.candidates[0], autofilled = { ...row.autofilled };
    delete autofilled.channel;
    for (const key of lookupFields) if (!value[key].trim() && candidateValue(candidate, key)) {
      value[key] = candidateValue(candidate, key); autofilled[key] = value[key];
    }
    if (!conflictsWith(value, candidate).length) { value.lookupId = record.id; value.lookupSid = candidate.sid; }
    return { ...row, value, lookup, lookupId: record.id, autofilled };
  });
}

/** Manual corrections matching the unique result may adopt its evidence without another request. */
export function refreshLookupEvidence(row: OnlineDraftRow): OnlineDraftRow {
  const candidate = row.lookup?.candidates.find((entry) => entry.sid === row.value.lookupSid)
    ?? (row.lookup?.status === 'unique' ? row.lookup.candidates[0] : undefined);
  if (!candidate || !row.lookupId || conflictsWith(row.value, candidate).length) return row;
  return { ...row, value: { ...row.value, lookupId: row.lookupId, lookupSid: candidate.sid } };
}

export function needsLookupReview(row: OnlineDraftRow): boolean {
  if (!hasOnlineContent(row.value)) return false;
  if (!/^FBA[A-Z0-9]+$/.test(normalFba(row.value.fba)) || !row.lookup || row.lookup.status === 'not_found') return true;
  const candidate = row.lookup.candidates.find((entry) => entry.sid === row.value.lookupSid);
  if (!candidate || row.value.lookupId !== row.lookupId || conflictsWith(row.value, candidate).length) return true;
  return false;
}

export function splitLookupFbas(rows: OnlineDraftRow[], alreadyLookedUp: ReadonlySet<string> = new Set()): string[][] {
  const fbas = [...new Set(rows.filter((row) => hasOnlineContent(row.value)).map((row) => normalFba(row.value.fba)))]
    .filter((fba) => /^FBA[A-Z0-9]+$/.test(fba) && fba.length <= 100 && !alreadyLookedUp.has(fba));
  return Array.from({ length: Math.ceil(fbas.length / 100) }, (_, index) => fbas.slice(index * 100, (index + 1) * 100));
}

export function currentLookupRecord(record: FbaLookupRecord, scope: { mode: string; version: number; catalogVersion: number; startDate: string; endDate: string }): boolean {
  return record.status === 'completed' && record.catalogMode === scope.mode && record.catalogSettingsVersion === scope.version
    && record.catalogVersion === scope.catalogVersion && record.startDate === scope.startDate && record.endDate === scope.endDate;
}

/** Excel quotes cells containing tabs, newlines, and literal quotes. */
export function parsePastedCells(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let value = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (quoted || value === '') quoted = !quoted;
      else value += char;
    } else if (!quoted && char === '\t') { row.push(value); value = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (value !== '' || row.length > 0 || rows.length === 0) { row.push(value); rows.push(row); }
  return rows;
}
