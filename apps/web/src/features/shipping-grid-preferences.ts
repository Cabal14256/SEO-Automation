import { useCallback, useMemo, useRef, useState } from 'react';
import type { ShippingPresentation } from './shipping-workbench-table';

export type ShippingPageSize = 20 | 50 | 100;
type StoredGridPreferences = {
  version: 1;
  hiddenColumnKeys: string[];
  columnWidths: Record<string, number>;
  pageSize: ShippingPageSize;
};
export type ShippingGridPreferences = Omit<StoredGridPreferences, 'version'> & {
  setHiddenColumnKeys: (keys: string[]) => void;
  setColumnWidths: (widths: Record<string, number>) => void;
  setPageSize: (size: ShippingPageSize) => void;
  pageSizeForView: (presentation: ShippingPresentation) => ShippingPageSize;
  resetColumns: () => void;
};
const defaults = (): StoredGridPreferences => ({ version: 1, hiddenColumnKeys: [], columnWidths: {}, pageSize: 20 });
const validKey = (key: string) => key.length > 0 && key.length <= 120 && !['__proto__', 'prototype', 'constructor'].includes(key);
export const shippingGridPreferenceKey = (userId: string, presentation: ShippingPresentation) => `scm-shipping-grid:v1:${userId}:${presentation}`;

export function parseShippingGridPreferences(raw: string | null): StoredGridPreferences {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1
      || !('hiddenColumnKeys' in parsed) || !Array.isArray(parsed.hiddenColumnKeys)
      || !parsed.hiddenColumnKeys.every((key) => typeof key === 'string' && validKey(key))
      || !('columnWidths' in parsed) || !parsed.columnWidths || typeof parsed.columnWidths !== 'object' || Array.isArray(parsed.columnWidths)
      || !Object.entries(parsed.columnWidths).every(([key, width]) => validKey(key) && typeof width === 'number' && Number.isFinite(width) && width >= 16 && width <= 5000)
      || !('pageSize' in parsed) || typeof parsed.pageSize !== 'number' || ![20, 50, 100].includes(parsed.pageSize)) return defaults();
    return { version: 1, hiddenColumnKeys: [...new Set(parsed.hiddenColumnKeys as string[])], columnWidths: { ...parsed.columnWidths as Record<string, number> }, pageSize: parsed.pageSize as ShippingPageSize };
  } catch { return defaults(); }
}
function load(key: string) {
  try { return parseShippingGridPreferences(localStorage.getItem(key)); } catch { return defaults(); }
}

/** One owner per workspace; only view preferences are stored, never business records. */
export function useShippingGridPreferences(userId: string, presentation: ShippingPresentation): ShippingGridPreferences {
  const key = shippingGridPreferenceKey(userId, presentation);
  const [cache, setCache] = useState(() => new Map([[key, load(key)]]));
  const cacheRef = useRef(cache);
  const value = useMemo(() => cache.get(key) ?? load(key), [cache, key]);
  const commit = useCallback((update: (previous: StoredGridPreferences) => StoredGridPreferences) => {
    const next = update(cacheRef.current.get(key) ?? value);
    const nextCache = new Map(cacheRef.current); nextCache.set(key, next);
    cacheRef.current = nextCache; setCache(nextCache);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Mounted state remains usable when storage is unavailable. */ }
  }, [key, value]);
  const setHiddenColumnKeys = useCallback((keys: string[]) => commit((previous) => ({ ...previous, hiddenColumnKeys: [...new Set(keys.filter(validKey))] })), [commit]);
  const setColumnWidths = useCallback((widths: Record<string, number>) => commit((previous) => ({ ...previous, columnWidths: { ...previous.columnWidths, ...Object.fromEntries(Object.entries(widths).filter(([name, width]) => validKey(name) && Number.isFinite(width) && width >= 16 && width <= 5000)) } })), [commit]);
  const setPageSize = useCallback((size: ShippingPageSize) => { if ([20, 50, 100].includes(size)) commit((previous) => ({ ...previous, pageSize: size })); }, [commit]);
  const resetColumns = useCallback(() => commit((previous) => ({ ...previous, hiddenColumnKeys: [], columnWidths: {} })), [commit]);
  const pageSizeForView = useCallback((view: ShippingPresentation) => {
    const viewKey = shippingGridPreferenceKey(userId, view);
    return viewKey === key ? value.pageSize : (cacheRef.current.get(viewKey) ?? load(viewKey)).pageSize;
  }, [userId, key, value.pageSize]);
  return { hiddenColumnKeys: value.hiddenColumnKeys, columnWidths: value.columnWidths, pageSize: value.pageSize, setHiddenColumnKeys, setColumnWidths, setPageSize, pageSizeForView, resetColumns };
}

export function useShippingFiltersExpanded(userId: string) {
  const key = `scm-shipping-filters:v1:${userId}`;
  const [values, setValues] = useState<Record<string, boolean>>({});
  const expanded = useMemo(() => {
    if (key in values) return values[key]!;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      return Boolean(saved && typeof saved === 'object' && 'version' in saved && saved.version === 1 && 'expanded' in saved && saved.expanded === true);
    } catch { return false; }
  }, [key, values]);
  const setExpanded = useCallback((next: boolean) => {
    setValues((previous) => ({ ...previous, [key]: next }));
    try { localStorage.setItem(key, JSON.stringify({ version: 1, expanded: next })); } catch { /* Keep the current disclosure usable without storage. */ }
  }, [key]);
  return [expanded, setExpanded] as const;
}
