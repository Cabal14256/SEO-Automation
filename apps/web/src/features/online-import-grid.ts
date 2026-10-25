import type { FbaLookupCandidate, FbaLookupRecord, FbaLookupRow, OnlineImportRow, TransportMethod } from '@scm/contracts';

export const onlineColumns = [
  { key: 'fba', label: 'FBA 货件号', placeholder: 'FBA…' },
  { key: 'shop', label: '店铺', placeholder: '店铺名称' },
  { key: 'channel', label: '业务渠道', placeholder: '运输方式，优先通过 FBA 查询' },
  { key: 'country', label: '国家', placeholder: '国家' },
  { key: 'destinationFc', label: '目的 FC', placeholder: '如 ONT8' },
  { key: 'destinationAddress', label: '仓库地址', placeholder: '完整地址' },
  { key: 'shipmentCreatedAt', label: '货件创建时间', placeholder: 'YYYY-MM-DD 或日期时间' },
  { key: 'sourceFilledAt', label: '来源填写时间', placeholder: 'YYYY-MM-DD 或日期时间' },
  { key: 'notes', label: '备注', placeholder: '备注' },
] as const;
export type OnlineCellKey = typeof onlineColumns[number]['key'];
export const isOnlineChannelSelectable = (value: string, methods: TransportMethod[]) => !value.trim() || methods.some((method) => method.enabled && method.name === value);
export function onlineChannelOptions(methods: TransportMethod[], current: string) {
  const names = new Map<string, boolean>();
  for (const method of methods) names.set(method.name, Boolean(names.get(method.name)) || method.enabled);
  return [
    { value: '', label: '留空，按 FBA 自动补全', disabled: false },
    ...[...names].map(([value, enabled]) => ({ value, label: enabled ? value : `${value}（已停用）`, disabled: !enabled })),
    ...(current && !names.has(current) ? [{ value: current, label: `${current}（原值，请重新选择）`, disabled: true }] : []),
  ];
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
export const lookupFields = ['shop', 'country', 'destinationFc', 'destinationAddress', 'shipmentCreatedAt', 'channel'] as const;
export type AutofilledValues = Partial<Record<typeof lookupFields[number], string>>;
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
    const selectedChannel = adoptedSid === candidate.sid && candidate.channelOptions.some((option) => option.name === value.channel);
    if (!candidate.channel && !selectedChannel && autofilled.channel !== undefined && value.channel === autofilled.channel) { value.channel = ''; delete autofilled.channel; }
    for (const key of lookupFields) if ((key === 'channel' || !value[key].trim()) && candidateValue(candidate, key)) {
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
  return candidate.channelStatus !== 'unique' && !candidate.channelOptions.some((option) => option.name === row.value.channel);
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
