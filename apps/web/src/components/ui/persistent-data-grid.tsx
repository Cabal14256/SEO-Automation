import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Columns3 } from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { ScmDataGrid, type GridColumn, type ScmDataGridProps } from './scm-data-grid';
import './persistent-data-grid.css';

type Scope = { userId: string; namespace: string };
const PreferenceScope = createContext<Scope | null>(null);
export function PersistentGridScope({ userId, namespace, children }: Scope & { children: ReactNode }) {
  const value = useMemo(() => ({ userId, namespace }), [userId, namespace]);
  return <PreferenceScope value={value}>{children}</PreferenceScope>;
}
export const usePersistentGridScope = () => useContext(PreferenceScope);
export type GridPageSize = 20 | 50 | 100;
type StoredPreferences = { version: 1; hiddenColumnKeys: string[]; columnWidths: Record<string, number>; pageSize: GridPageSize };
export type PersistentGridPreferences = Omit<StoredPreferences, 'version'> & {
  setHiddenColumnKeys: (keys: string[]) => void;
  setColumnWidths: (widths: Record<string, number>) => void;
  setPageSize: (size: GridPageSize) => void;
  resetColumns: () => void;
};
const defaults = (): StoredPreferences => ({ version: 1, hiddenColumnKeys: [], columnWidths: {}, pageSize: 20 });
const validKey = (key: string) => key.length > 0 && key.length <= 160 && !['__proto__', 'prototype', 'constructor'].includes(key);
export function parseGridPreferences(raw: string | null): StoredPreferences {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<StoredPreferences> | null;
    if (!value || value.version !== 1 || !Array.isArray(value.hiddenColumnKeys) || !value.hiddenColumnKeys.every((key) => typeof key === 'string' && validKey(key))
      || !value.columnWidths || typeof value.columnWidths !== 'object' || Array.isArray(value.columnWidths)
      || !Object.entries(value.columnWidths).every(([key, width]) => validKey(key) && typeof width === 'number' && Number.isFinite(width) && width >= 16 && width <= 5000)
      || ![20, 50, 100].includes(value.pageSize!)) return defaults();
    return { version: 1, hiddenColumnKeys: [...new Set(value.hiddenColumnKeys)], columnWidths: { ...value.columnWidths }, pageSize: value.pageSize! };
  } catch { return defaults(); }
}
type Store = { value: StoredPreferences; listeners: Set<() => void> };
const stores = new Map<string, Store>();
function storeFor(key: string) {
  let store = stores.get(key);
  if (!store) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { /* Storage is optional. */ }
    store = { value: parseGridPreferences(raw), listeners: new Set() }; stores.set(key, store);
  }
  return store;
}
export function usePersistentGridPreferences(tableKey: string): PersistentGridPreferences {
  const scope = usePersistentGridScope();
  const key = `scm-${scope?.namespace ?? 'documents'}-grid:v1:${scope?.userId ?? 'anonymous'}:${tableKey}`;
  const store = useMemo(() => storeFor(key), [key]);
  const subscribe = useCallback((listener: () => void) => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; }, [store]);
  const snapshot = useCallback(() => store.value, [store]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const commit = useCallback((update: (previous: StoredPreferences) => StoredPreferences) => {
    store.value = update(store.value);
    try { localStorage.setItem(key, JSON.stringify(store.value)); } catch { /* Keep preferences usable in this session. */ }
    store.listeners.forEach((listener) => listener());
  }, [store, key]);
  return useMemo(() => ({ ...value,
    setHiddenColumnKeys: (keys: string[]) => commit((previous) => ({ ...previous, hiddenColumnKeys: [...new Set(keys.filter(validKey))] })),
    setColumnWidths: (widths: Record<string, number>) => commit((previous) => ({ ...previous, columnWidths: { ...previous.columnWidths, ...Object.fromEntries(Object.entries(widths).filter(([name, width]) => validKey(name) && Number.isFinite(width) && width >= 16 && width <= 5000)) } })),
    setPageSize: (size: GridPageSize) => { if ([20, 50, 100].includes(size)) commit((previous) => ({ ...previous, pageSize: size })); },
    resetColumns: () => commit((previous) => ({ ...previous, hiddenColumnKeys: [], columnWidths: {} })),
  }), [value, commit]);
}
export function usePersistentFiltersExpanded(tableKey: string) {
  const scope = usePersistentGridScope();
  const key = `scm-${scope?.namespace ?? 'documents'}-filters:v1:${scope?.userId ?? 'anonymous'}:${tableKey}`;
  const [values, setValues] = useState<Record<string, boolean>>({});
  const expanded = useMemo(() => {
    if (key in values) return values[key]!;
    try { const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return Boolean(saved && typeof saved === 'object' && 'version' in saved && saved.version === 1 && 'expanded' in saved && saved.expanded === true); } catch { return false; }
  }, [key, values]);
  const setExpanded = useCallback((next: boolean) => {
    setValues((previous) => ({ ...previous, [key]: next }));
    try { localStorage.setItem(key, JSON.stringify({ version: 1, expanded: next })); } catch { /* Disclosure remains usable without storage. */ }
  }, [key]);
  return [expanded, setExpanded] as const;
}

function ColumnSettings<Row>({ columns, required, preferences, beforeChange, disabled }: { columns: GridColumn<Row>[]; required: Set<string>; preferences: PersistentGridPreferences; beforeChange?: () => Promise<unknown>; disabled: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false), [search, setSearch] = useState(''), [pending, setPending] = useState(false);
  const latest = useRef({ preferences, disabled }); latest.current = { preferences, disabled };
  const mounted = useRef(true), working = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const change = async (action: (current: PersistentGridPreferences) => void) => {
    if (working.current || latest.current.disabled) return;
    working.current = true; setPending(true);
    try { await beforeChange?.(); if (mounted.current && !latest.current.disabled) action(latest.current.preferences); }
    finally { working.current = false; if (mounted.current) setPending(false); }
  };
  const selectable = columns.filter((column) => column.title && !column.utility && !['expand', 'selection', 'actions', 'rowNumber'].includes(column.key));
  const matches = selectable.filter((column) => column.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" icon={Columns3} disabled={disabled} aria-label="列展示设置">列展示设置</Button></PopoverTrigger>
    <PopoverContent className="scm-column-picker" align="end" onOpenAutoFocus={(event) => { event.preventDefault(); requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true })); }}>
      <label className="scm-column-search" htmlFor={id}>查找列<Input id={id} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入列名" /></label>
      <p className="scm-column-count">已显示 {selectable.filter((column) => required.has(column.key) || !preferences.hiddenColumnKeys.includes(column.key)).length} / {selectable.length} 列</p>
      <div className="scm-column-list">{matches.map((column) => <label className="scm-column-option" key={column.key}><input type="checkbox" checked={required.has(column.key) || !preferences.hiddenColumnKeys.includes(column.key)} disabled={disabled || pending || required.has(column.key)} onChange={(event) => { const checked = event.currentTarget.checked; void change((current) => current.setHiddenColumnKeys(checked ? current.hiddenColumnKeys.filter((key) => key !== column.key) : [...current.hiddenColumnKeys, column.key])); }} /><span>{column.title}</span>{required.has(column.key) && <small>固定保留</small>}</label>)}{!matches.length && <p className="mapping-help">没有匹配列。</p>}</div>
      <div className="scm-column-actions"><Button variant="text" type="button" disabled={disabled || pending} onClick={() => void change((current) => current.setHiddenColumnKeys([]))}>全部显示</Button><Button variant="text" type="button" disabled={disabled || pending} onClick={() => void change((current) => current.resetColumns())}>恢复默认列</Button></div>
    </PopoverContent></Popover>;
}

export type PersistentDataGridProps<Row> = ScmDataGridProps<Row> & { tableKey: string; mandatoryColumnKeys?: string[]; beforeColumnChange?: () => Promise<unknown>; preferences?: PersistentGridPreferences };
export function PersistentDataGrid<Row>({ tableKey, mandatoryColumnKeys = [], beforeColumnChange, preferences: external, ...props }: PersistentDataGridProps<Row>) {
  const stored = usePersistentGridPreferences(tableKey), preferences = external ?? stored;
  const required = new Set(['expand', 'rowNumber', 'selection', 'actions', ...mandatoryColumnKeys]);
  const columns = props.columns.filter((column) => required.has(column.key) || !preferences.hiddenColumnKeys.includes(column.key));
  return <ScmDataGrid {...props} columns={columns} columnWidths={preferences.columnWidths} onColumnWidthsChange={preferences.setColumnWidths} rowSeriesNumber={props.rowSeriesNumber ?? false} navigationPosition="bottom" middleMousePan
    headerEnd={<>{props.headerEnd}<ColumnSettings columns={props.columns} required={required} preferences={preferences} beforeChange={beforeColumnChange} disabled={props.active === false} /></>} />;
}
