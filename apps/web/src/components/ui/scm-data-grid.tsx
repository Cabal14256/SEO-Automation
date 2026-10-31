import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import type { ListTable, TYPES } from '@visactor/vtable';
import { Dialog } from './dialog';
import { Popover, PopoverAnchor, PopoverContent } from './popover';
import { useGridMiddlePan } from './use-grid-middle-pan';
import './scm-data-grid.css';

export type GridEdit = { rowKey: string; columnKey: string; value: string };
export type GridRowMenuContext = { close: () => void; openDetails: () => void };
export type GridHandle = {
  revealCell: (rowKey: string, columnKey?: string, options?: { edit?: boolean; requestId?: number; signal?: AbortSignal }) => Promise<void>;
  finishEdit: () => Promise<GridEdit | null>;
  cancelEdit: () => void;
};
export type GridColumn<Row> = {
  key: string; title: string; width?: number; align?: 'left' | 'center' | 'right';
  getValue: (row: Row) => string | number | null | undefined;
  getChecked?: (row: Row) => boolean;
  onToggle?: (row: Row, checked: boolean) => void;
  disabled?: (row: Row) => boolean;
  onActivate?: (row: Row) => void;
  buttonWhen?: (row: Row) => boolean;
  openDetails?: boolean;
  openMenu?: boolean;
  utility?: 'number';
  icon?: (row: Row) => 'expand' | 'collapse' | 'more' | null;
  indent?: (row: Row) => number;
  editable?: (row: Row) => boolean;
  editLabel?: (row: Row) => string;
  inputMode?: 'text' | 'decimal'; maxLength?: number;
  getCellState?: (row: Row) => 'error' | 'modified' | 'default';
};
type Props<Row> = {
  label: string; rows: Row[]; columns: GridColumn<Row>[]; getRowKey: (row: Row) => string;
  active?: boolean;
  height?: number; maxHeight?: number; rowHeight?: number; frozenColCount?: number; className?: string;
  selectedRowKey?: string; onActiveRowChange?: (row: Row) => void;
  renderDetails?: (row: Row, context: { close: () => void }) => ReactNode; gridRef?: Ref<GridHandle>;
  detailsMode?: 'inline' | 'dialog'; detailsTitle?: (row: Row) => string;
  onEdit?: (edit: GridEdit, row: Row) => void; onPendingEditChange?: (pending: boolean) => void;
  onEditingRowChange?: (row: Row | null) => void;
  isGroupRow?: (row: Row) => boolean;
  rowSeriesNumber?: boolean;
  navigationPosition?: 'top' | 'bottom'; footerStart?: ReactNode; footerEnd?: ReactNode;
  headerEnd?: ReactNode;
  columnWidths?: Record<string, number>; onColumnWidthsChange?: (widths: Record<string, number>) => void;
  middleMousePan?: boolean; menuScopeKey?: string;
  renderRowMenu?: (row: Row, context: GridRowMenuContext) => ReactNode;
};
export type ScmDataGridProps<Row> = Props<Row>;
type RecordValue = { __key: string; [field: string]: string | number | boolean | null };
type EditorContext = { container: HTMLElement; referencePosition: { rect: { left: number; top: number; width: number; height: number } }; value: unknown; col: number; row: number; endEdit: () => void };

/** One native input per table. VTable owns its position; React owns committed drafts. */
class NativeCellEditor {
  input?: HTMLInputElement;
  private initial = '';
  private composing = false;
  private end?: () => void;
  private compositionWaiters = new Set<() => void>();
  isComposing = () => this.composing;
  waitForComposition = () => {
    if (!this.composing) return Promise.resolve();
    const waiting = new Promise<void>((resolve) => this.compositionWaiters.add(resolve));
    this.input?.blur();
    return waiting;
  };
  validateValue = () => !this.composing;
  constructor(private start: (col: number, row: number, input: HTMLInputElement) => void, private pending: (pending: boolean) => void, private stop: () => void, private cancel: () => void, private advance: (key: string, col: number, direction: number) => void) {}
  onStart = (context: EditorContext) => {
    this.onEnd();
    const input = document.createElement('input');
    input.className = 'scm-grid-cell-editor'; input.type = 'text';
    this.initial = String(context.value ?? ''); input.value = this.initial;
    this.input = input; this.end = context.endEdit;
    this.start(context.col, context.row, input);
    this.adjustPosition(context.referencePosition.rect);
    input.addEventListener('input', () => this.pending(input.value !== this.initial));
    input.addEventListener('compositionstart', () => { this.composing = true; });
    input.addEventListener('compositionend', () => { this.composing = false; this.pending(input.value !== this.initial); this.compositionWaiters.forEach((resolve) => resolve()); this.compositionWaiters.clear(); });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.isComposing || this.composing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.cancel(); }
      else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const key = input.dataset.gridRowKey ?? '';
        this.end?.();
        this.advance(key, context.col, event.shiftKey ? -1 : 1);
      }
    });
    input.addEventListener('blur', () => { if (!this.composing) this.end?.(); });
    context.container.append(input); input.focus({ preventScroll: true }); input.select();
  };
  adjustPosition = (rect: { left: number; top: number; width: number; height: number }) => {
    if (this.input) Object.assign(this.input.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  };
  getValue = () => this.input?.value ?? this.initial;
  getInputElement = () => this.input!;
  isEditorElement = (target: HTMLElement) => this.composing || target === this.input;
  onEnd = () => {
    const input = this.input; this.input = undefined; this.end = undefined; this.composing = false;
    input?.remove(); this.compositionWaiters.forEach((resolve) => resolve()); this.compositionWaiters.clear(); this.pending(false); if (input) this.stop();
  };
}

export function ScmDataGrid<Row>(props: Props<Row>) {
  const { label, rows, columns, getRowKey, rowHeight = 32, maxHeight = 640, height, frozenColCount = 1, renderDetails, className = '', gridRef, detailsMode = 'inline' } = props;
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const table = useRef<ListTable | null>(null);
  const latest = useRef(props); latest.current = props;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeColumnKey, setActiveColumnKey] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const detailsReturnFocus = useRef<HTMLElement | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const menuViewport = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const menuAnchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  const menuReturnFocus = useRef<HTMLElement | null>(null);
  const menuContent = useRef<HTMLDivElement>(null);
  const restoreMenuFocus = useRef(true);
  const [failure, setFailure] = useState('');
  const [ready, setReady] = useState(false);
  const lastEdit = useRef<GridEdit | null>(null);
  const activeTarget = useRef<{ key: string; columnKey: string } | null>(null);
  const revealVersion = useRef(0);
  const navigationPending = useRef<Promise<void>>(Promise.resolve());
  const editing = useRef(false);
  const [editVersion, setEditVersion] = useState(0);
  const rowMap = useMemo(() => new Map(rows.map((row) => [getRowKey(row), row])), [rows, getRowKey]);
  const rowMapRef = useRef(rowMap); rowMapRef.current = rowMap;
  const rowIndexes = useMemo(() => new Map(rows.map((row, index) => [getRowKey(row), index])), [rows, getRowKey]);
  const keys = useMemo(() => rows.map(getRowKey), [rows, getRowKey]);
  const chosenKey = props.selectedRowKey ?? (activeKey && rowMap.has(activeKey) ? activeKey : keys[0]);
  const currentRow = chosenKey ? rowMap.get(chosenKey) : undefined;
  const currentIndex = chosenKey ? rowIndexes.get(chosenKey) ?? 0 : 0;
  const detailsRow = detailsKey ? rowMap.get(detailsKey) : undefined;
  const menuRow = menuKey ? rowMap.get(menuKey) : undefined;
  const nativeOffset = props.rowSeriesNumber === false ? 0 : 1;
  const columnMap = useMemo(() => new Map(columns.map((column, index) => [column.key, { column, index, physical: index + nativeOffset }])), [columns, nativeOffset]);
  const columnMapRef = useRef(columnMap); columnMapRef.current = columnMap;
  const currentColumn = activeColumnKey && columnMap.has(activeColumnKey) ? columnMap.get(activeColumnKey)! : columnMap.values().next().value;
  const records = useMemo<RecordValue[]>(() => rows.map((row, rowIndex) => {
    const record: RecordValue = { __key: getRowKey(row) };
    columns.forEach((column, index) => {
      record[`c${index}`] = column.utility === 'number' ? rowIndex + 1 : column.getChecked ? column.getChecked(row) : column.getValue(row) ?? '';
      if (column.disabled) record[`d${index}`] = column.disabled(row);
      if (column.editable) record[`e${index}`] = column.editable(row);
      if (column.getCellState) record[`s${index}`] = column.getCellState(row);
      if (column.buttonWhen) record[`b${index}`] = column.buttonWhen(row);
      if (column.indent) record[`i${index}`] = column.indent(row);
      if (column.icon) record[`v${index}`] = column.icon(row);
    });
    return record;
  }), [rows, columns, getRowKey]);
  const latestRecords = useRef(records); latestRecords.current = records;
  const appliedRecords = useRef<RecordValue[]>([]);
  const widths = useRef(new Map<string, number>());
  const retainedViewport = useRef<{ top: number; left: number; rowKey?: string; columnKey?: string; columnKeys: string[]; scope?: string } | null>(null);
  const activeScope = useRef(props.menuScopeKey);
  const refitFrozen = useRef<() => void>(() => {});
  const editor = useRef<NativeCellEditor | null>(null);
  const blocked = () => latest.current.active === false || Boolean(container.current?.closest('fieldset[disabled], [inert]'));
  const resolvedHeight = Math.max(76, height ?? Math.min(maxHeight, 37 + rows.length * rowHeight + 14));
  const structure = JSON.stringify([nativeOffset, Boolean(props.isGroupRow), columns.map(({ key, title, width, align, getChecked, onActivate, openDetails, openMenu, utility, icon, buttonWhen, indent, editable, getCellState }) => [key, title, width, align, Boolean(getChecked), Boolean(onActivate || openDetails || openMenu), utility, Boolean(icon), Boolean(buttonWhen), Boolean(indent), Boolean(editable), Boolean(getCellState)])]);
  const columnAt = (physical: number) => latest.current.columns[physical - (latest.current.rowSeriesNumber === false ? 0 : 1)];
  const closeMenu = () => { menuViewport.current = null; setMenuKey(null); };
  const closeDetails = () => {
    setDetailsKey(null);
    const target = detailsReturnFocus.current; detailsReturnFocus.current = null;
    if (target) requestAnimationFrame(() => {
      const activeDialog = document.activeElement?.closest('dialog[open]');
      if (target.isConnected && target.getClientRects().length && !blocked() && (!activeDialog || activeDialog === target.closest('dialog[open]'))) target.focus({ preventScroll: true });
    });
  };
  const cancelPan = useGridMiddlePan(container, table, { enabled: props.middleMousePan, active: props.active, isComposing: () => editor.current?.isComposing() ?? false, beforePan: closeMenu });

  const original = (col: number, row: number): Row | undefined => {
    const record = table.current?.getCellOriginRecord(col, row) as RecordValue | undefined;
    return record?.__key ? rowMapRef.current.get(record.__key) : undefined;
  };
  const activate = (row: Row, columnKey = latest.current.columns[0]?.key ?? '') => {
    activeTarget.current = { key: latest.current.getRowKey(row), columnKey };
    setActiveKey(latest.current.getRowKey(row)); setActiveColumnKey(columnKey);
    latest.current.onActiveRowChange?.(row);
  };
  const originalRef = useRef(original); originalRef.current = original;
  const activateRef = useRef(activate); activateRef.current = activate;
  const openMenu = (row: Row, anchor: DOMRect, returnFocus: HTMLElement | null) => {
    if (!latest.current.renderRowMenu || blocked()) return;
    const node = container.current, instance = table.current;
    menuViewport.current = node && instance ? { left: instance.scrollLeft, top: instance.scrollTop, width: node.clientWidth, height: node.clientHeight } : null;
    menuAnchor.current.getBoundingClientRect = () => anchor;
    menuReturnFocus.current = returnFocus; restoreMenuFocus.current = true;
    setMenuKey(latest.current.getRowKey(row));
  };
  const openMenuRef = useRef(openMenu); openMenuRef.current = openMenu;

  useImperativeHandle(gridRef, () => ({
    finishEdit: async () => {
      lastEdit.current = null;
      await editor.current?.waitForComposition();
      table.current?.completeEditCell(); return lastEdit.current;
    },
    cancelEdit: () => { lastEdit.current = null; table.current?.cancelEditCell(); },
    revealCell: async (rowKey, columnKey, options) => {
      const version = ++revealVersion.current;
      const cancelled = () => version !== revealVersion.current || options?.signal?.aborted;
      await import('@visactor/vtable');
      if (cancelled()) return;
      if (!table.current) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled()) return;
      await editor.current?.waitForComposition();
      if (cancelled()) return;
      table.current?.completeEditCell();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled()) return;
      const index = latest.current.rows.findIndex((row) => latest.current.getRowKey(row) === rowKey);
      if (index < 0 || !table.current) return;
      const column = columnMapRef.current.get(columnKey ?? '') ?? columnMapRef.current.values().next().value;
      if (!column) return;
      const row = latest.current.rows[index]!;
      activateRef.current(row, column.column.key); table.current.scrollToCell({ col: column.physical, row: index + 1 }); table.current.selectCell(column.physical, index + 1);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!cancelled() && options?.edit && !blocked() && table.current && column.column.editable?.(row)) table.current.startEditCell(column.physical, index + 1);
    },
  }));

  useLayoutEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let resizeFrame = 0;
    let release = () => {};
    const mountedColumnKeys = latest.current.columns.map((column) => column.key);
    setReady(false);
    const css = getComputedStyle(container.current);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const palette = {
      ink: token('--color-ink', '#0a0a0a'), panel: token('--color-panel', '#fff'),
      line: token('--color-line', '#dddfd5'), muted: token('--color-muted', '#60645c'),
      header: token('--color-canvas', '#f5f5f0'), group: token('--grid-group', '#edf3e1'),
      hover: token('--grid-hover', '#f0f4e8'), accent: token('--grid-accent', '#526e2b'),
      controlLine: token('--grid-control-line', '#858d7e'), font: css.fontFamily || '"Microsoft YaHei", sans-serif',
    };
    const activeEditor = new NativeCellEditor((col, row, input) => {
      const source = originalRef.current(col, row), column = columnAt(col);
      if (!source || !column) return;
      editing.current = true; lastEdit.current = null;
      input.setAttribute('aria-label', column.editLabel?.(source) ?? `${latest.current.label} ${column.title}`);
      if (column.getCellState?.(source) === 'error') input.setAttribute('aria-invalid', 'true');
      input.inputMode = column.inputMode ?? 'text'; input.maxLength = column.maxLength ?? 4000;
      input.dataset.gridRowKey = latest.current.getRowKey(source); input.dataset.gridColumnKey = column.key;
      activateRef.current(source, column.key); latest.current.onEditingRowChange?.(source);
    }, (pending) => latest.current.onPendingEditChange?.(pending), () => {
      editing.current = false; latest.current.onEditingRowChange?.(null);
      if (!disposed) setEditVersion((value) => value + 1);
    }, () => { table.current?.cancelEditCell(); container.current?.focus({ preventScroll: true }); }, (key, col, direction) => {
      requestAnimationFrame(() => {
        if (disposed || !table.current) return;
        const config = latest.current;
        let rowIndex = config.rows.findIndex((row) => config.getRowKey(row) === key), columnIndex = config.columns.findIndex((column) => column.key === columnAt(col)?.key);
        if (rowIndex < 0) return;
        for (let count = 0; count < config.rows.length * config.columns.length; count++) {
          columnIndex += direction;
          if (columnIndex >= config.columns.length) { columnIndex = 0; rowIndex++; }
          if (columnIndex < 0) { columnIndex = config.columns.length - 1; rowIndex--; }
          const row = config.rows[rowIndex];
          if (!row) { container.current?.focus({ preventScroll: true }); return; }
          const column = config.columns[columnIndex];
          if (column?.editable?.(row) && !column.disabled?.(row)) {
            const physical = columnMapRef.current.get(column.key)?.physical;
            if (physical === undefined) return;
            activateRef.current(row, column.key); table.current.scrollToCell({ col: physical, row: rowIndex + 1 });
            table.current.selectCell(physical, rowIndex + 1); table.current.startEditCell(physical, rowIndex + 1); return;
          }
        }
      });
    });
    editor.current = activeEditor;
    const definitions: TYPES.ColumnsDefine = latest.current.columns.map((column, index): TYPES.ColumnDefine => {
      const cellStyle = { fontSize: 13, color: palette.ink, textAlign: column.align ?? (column.getChecked ? 'center' as const : 'left' as const), padding: [6, 10, 6, 10] as [number, number, number, number], textOverflow: 'ellipsis' as const, autoWrapText: rowHeight > 32, lineClamp: rowHeight > 32 ? 2 : 1 };
      const base = {
      field: `c${index}`, title: column.title, headerType: 'text' as const, width: latest.current.columnWidths?.[column.key] ?? widths.current.get(column.key) ?? column.width ?? (column.align === 'right' ? 100 : 180), minWidth: column.icon ? 32 : 48,
      style: latest.current.isGroupRow || column.getCellState || column.indent ? (args: TYPES.StylePropertyFunctionArg) => {
        const record = args.table.getCellOriginRecord(args.col, args.row) as RecordValue | undefined;
        const row = record?.__key ? rowMapRef.current.get(record.__key) : undefined;
        const group = row ? latest.current.isGroupRow?.(row) : false;
        const state = row ? latest.current.columns[index]?.getCellState?.(row) : undefined;
        const indent = row ? latest.current.columns[index]?.indent?.(row) ?? 0 : 0;
        return { ...cellStyle, padding: [6, 10, 6, 10 + indent], bgColor: group ? palette.group : state === 'error' ? '#fff2f1' : state === 'modified' ? '#f4f8e9' : palette.panel, fontWeight: group ? 600 : 400, color: state === 'error' ? '#a32330' : palette.ink };
      } : cellStyle,
      headerStyle: { fontSize: 13, fontWeight: 600, color: palette.ink, textAlign: 'left' as const, padding: [6, 10, 6, 10] as [number, number, number, number] },
      icon: column.icon ? (args: TYPES.CellInfo & { table: Pick<ListTable, 'getCellOriginRecord'> }) => {
        const record = args.table.getCellOriginRecord(args.col, args.row) as RecordValue | undefined;
        const row = record?.__key ? rowMapRef.current.get(record.__key) : undefined;
        const config = columnMapRef.current.get(column.key)?.column;
        const icon = row ? config?.icon?.(row) : null;
        if (!icon || !row) return undefined;
        const shape = icon === 'more' ? '<circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/>' : icon === 'expand' ? '<path d="M5 3L11 8L5 13Z"/>' : '<path d="M3 5L8 11L13 5Z"/>';
        return { type: 'svg', name: `scm-${icon}`, funcType: `scm-${icon}`, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="${palette.ink}">${shape}</svg>`, width: 16, height: 16, positionType: 'contentLeft' as TYPES.IconPosition, cursor: 'pointer', visibleTime: 'always', hover: { width: 28, height: 28, bgColor: palette.hover }, tooltip: { title: config?.editLabel?.(row) ?? config?.title ?? '', placement: 'top' } } as TYPES.ColumnIconOption;
      } : undefined,
      disable: (args: TYPES.StylePropertyFunctionArg) => {
        const record = args.table.getCellOriginRecord(args.col, args.row) as RecordValue | undefined;
        const row = record?.__key ? rowMapRef.current.get(record.__key) : undefined;
        return blocked() || !row || Boolean(latest.current.columns[index]?.disabled?.(row));
      },
      editor: column.editable ? (args: { col: number; row: number }) => {
        const row = originalRef.current(args.col, args.row), config = columnMapRef.current.get(column.key)?.column;
        return !blocked() && row && config?.editable?.(row) && !config.disabled?.(row) ? activeEditor : '';
      } : undefined,
      };
      if (column.getChecked) return { ...base, cellType: 'checkbox' };
      if (column.icon) return { ...base, cellType: 'text' };
      if (column.onActivate || column.openDetails) return { ...base, cellType: column.buttonWhen ? (args: TYPES.CellInfo) => {
        // VTable 1.26 passes table and coordinates here, rather than originData.
        const instance = (args as TYPES.CellInfo & { table?: ListTable }).table;
        const source = (instance?.getCellOriginRecord(args.col, args.row) as RecordValue | undefined)?.__key;
        const row = source ? rowMapRef.current.get(source) : undefined;
        return row && latest.current.columns[index]?.buttonWhen?.(row) ? 'button' : 'text';
      } : 'button' as const };
      return { ...base, cellType: 'text' };
    });
    const mount = async () => {
    try {
      const { ListTable } = await import('@visactor/vtable');
      if (disposed || !container.current) return;
      const requestedFrozen = Math.min(frozenColCount + nativeOffset, definitions.length + nativeOffset);
      const fitFrozen = (columnWidths: number[]) => {
        const maximum = container.current ? container.current.clientWidth * .7 : 0;
        let count = 0, used = 0;
        while (count < requestedFrozen && used + columnWidths[count]! <= maximum) { used += columnWidths[count]!; count++; }
        return count;
      };
      const initialWidths = [...(nativeOffset ? [60] : []), ...latest.current.columns.map((column) => Math.max(column.icon ? 32 : 48, latest.current.columnWidths?.[column.key] ?? widths.current.get(column.key) ?? column.width ?? (column.align === 'right' ? 100 : 180)))];
      const instance = new ListTable(container.current, {
        columns: definitions, records: latestRecords.current, defaultRowHeight: rowHeight, defaultHeaderRowHeight: 36,
        frozenColCount: fitFrozen(initialWidths), maxFrozenWidth: '70%', rowSeriesNumber: nativeOffset ? { title: '#', width: 60, style: (args) => {
          const record = args.table.getCellOriginRecord(args.col, args.row) as RecordValue | undefined;
          const row = record?.__key ? rowMapRef.current.get(record.__key) : undefined;
          const group = row ? latest.current.isGroupRow?.(row) : false;
          return { textAlign: 'center', padding: [4, 4, 4, 4], bgColor: group ? palette.group : palette.panel, fontWeight: group ? 600 : 400, color: palette.muted };
        } } : undefined,
        widthMode: 'standard', heightMode: 'standard', autoWrapText: false,
        editCellTrigger: 'click', keyboardOptions: { moveFocusCellOnTab: true, moveFocusCellOnEnter: true },
        theme: {
          underlayBackgroundColor: palette.panel,
          defaultStyle: { bgColor: palette.panel, borderColor: palette.line, borderLineWidth: 1, fontFamily: palette.font, fontSize: 13, color: palette.ink },
          headerStyle: { bgColor: palette.header, borderColor: palette.line, borderLineWidth: 1, hover: { cellBgColor: palette.hover } },
          bodyStyle: { bgColor: palette.panel, hover: { cellBgColor: palette.hover } },
          selectionStyle: { cellBgColor: 'rgba(82,110,43,0.08)', cellBorderColor: palette.accent },
          buttonStyle: { buttonColor: palette.panel, buttonBorderColor: palette.controlLine, buttonLineWidth: 1, buttonBorderRadius: 8, buttonHoverColor: palette.hover, buttonHoverBorderColor: palette.accent, buttonTextHoverColor: palette.ink, buttonDisableColor: palette.header, buttonDisableBorderColor: palette.line, buttonTextDisableColor: palette.muted, buttonPadding: 6 },
          checkboxStyle: { defaultFill: palette.panel, defaultStroke: palette.controlLine, checkedFill: palette.accent, checkedStroke: palette.accent, disableFill: palette.header, disableCheckedFill: palette.muted, disableCheckedStroke: palette.muted },
          scrollStyle: { scrollRailColor: palette.header, scrollSliderColor: '#a7ad9e', scrollSliderCornerRadius: 4, width: 10, visible: 'scrolling' },
          frozenColumnLine: { border: { lineColor: '#bdc6b1', lineWidth: 1 }, shadow: { width: 3, startColor: 'rgba(36,48,27,0.12)', endColor: 'rgba(36,48,27,0)' } },
        },
      });
      table.current = instance; appliedRecords.current = latestRecords.current;
      const applyFrozen = () => {
        const count = fitFrozen(Array.from({ length: instance.colCount }, (_, index) => instance.getColWidth(index)));
        if (instance.frozenColCount !== count) instance.setFrozenColCount(count);
      };
      refitFrozen.current = applyFrozen;
      instance.on('click_cell', (event) => {
        if (blocked()) return;
        const row = originalRef.current(event.col, event.row);
        if (!row) return;
        const column = columnAt(event.col);
        activateRef.current(row, column?.key);
        if (column?.icon?.(row)) instance.selectCell(event.col, event.row, false, false, false);
        if (!column?.disabled?.(row) && (column?.buttonWhen?.(row) ?? true)) {
          column?.onActivate?.(row);
          if (column?.openDetails) { detailsReturnFocus.current = container.current; setDetailsKey(latest.current.getRowKey(row)); }
          if (column?.openMenu && container.current) {
            const cell = instance.getCellRelativeRect(event.col, event.row), bounds = container.current.getBoundingClientRect();
            openMenuRef.current(row, new DOMRect(bounds.left + cell.left, bounds.top + cell.top, cell.width, cell.height), container.current);
          }
        }
        if (column?.editable?.(row) && !column.disabled?.(row)) {
          const key = latest.current.getRowKey(row), columnKey = column.key;
          requestAnimationFrame(() => {
            if (disposed || editor.current?.input || blocked() || activeTarget.current?.key !== key || activeTarget.current.columnKey !== columnKey) return;
            const rowIndex = latest.current.rows.findIndex((item) => latest.current.getRowKey(item) === key);
            const physical = columnMapRef.current.get(columnKey)?.physical;
            if (rowIndex >= 0 && physical !== undefined) instance.startEditCell(physical, rowIndex + 1);
          });
        }
      });
      instance.on('selected_cell', (event) => { const row = originalRef.current(event.col, event.row); if (row) activateRef.current(row, columnAt(event.col)?.key); });
      instance.on('checkbox_state_change', (event) => {
        const row = originalRef.current(event.col, event.row), column = columnAt(event.col);
        if (row && !blocked() && !column?.disabled?.(row)) column?.onToggle?.(row, event.checked);
        else if (row && column?.getChecked) instance.setCellCheckboxState(event.col, event.row, column.getChecked(row));
      });
      instance.on('change_cell_value', (event) => {
        const row = originalRef.current(event.col, event.row), column = columnAt(event.col);
        if (!row || !column || blocked() || !column.editable?.(row) || column.disabled?.(row)) return;
        const edit = { rowKey: latest.current.getRowKey(row), columnKey: column.key, value: String(event.changedValue ?? '') };
        lastEdit.current = edit; latest.current.onEdit?.(edit, row);
      });
      instance.on('resize_column_end', () => {
        columnMapRef.current.forEach(({ column, physical }) => widths.current.set(column.key, instance.getColWidth(physical)));
        latest.current.onColumnWidthsChange?.({ ...latest.current.columnWidths, ...Object.fromEntries(widths.current) }); applyFrozen(); closeMenu();
      });
      const closeMovedMenu = () => {
        const opened = menuViewport.current, node = container.current;
        // VTable also emits scroll notifications when the offset has not changed.
        // A resize queued before opening must not dismiss a menu at its new position.
        if (opened && node && (instance.scrollLeft !== opened.left || instance.scrollTop !== opened.top || node.clientWidth !== opened.width || node.clientHeight !== opened.height)) closeMenu();
      };
      instance.on('scroll', closeMovedMenu);
      const observer = new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => { if (!disposed) { instance.resize(); applyFrozen(); closeMovedMenu(); } }); });
      observer.observe(container.current);
      const previous = retainedViewport.current;
      if (previous?.rowKey && previous.scope === latest.current.menuScopeKey) {
        const rowIndex = latest.current.rows.findIndex((row) => latest.current.getRowKey(row) === previous.rowKey);
        if (rowIndex >= 0) {
          const oldIndex = previous.columnKeys.indexOf(previous.columnKey ?? '');
          const closestKey = previous.columnKeys.filter((key) => columnMapRef.current.has(key)).sort((left, right) => {
            const a = previous.columnKeys.indexOf(left), b = previous.columnKeys.indexOf(right);
            return Math.abs(a - oldIndex) - Math.abs(b - oldIndex) || b - a;
          })[0];
          const column = columnMapRef.current.get(previous.columnKey ?? '') ?? columnMapRef.current.get(closestKey ?? '') ?? columnMapRef.current.values().next().value;
          if (column) instance.selectCell(column.physical, rowIndex + 1, false, false, false);
          instance.scrollLeft = previous.left; instance.scrollTop = previous.top;
        }
      }
      release = () => {
        if (table.current === instance) {
          const first = instance.rowCount > 1 && instance.colCount > nativeOffset ? instance.getCellOriginRecord(nativeOffset, 1) as RecordValue | undefined : undefined;
          retainedViewport.current = { top: instance.scrollTop, left: instance.scrollLeft, rowKey: activeTarget.current?.key ?? first?.__key, columnKey: activeTarget.current?.columnKey, columnKeys: mountedColumnKeys, scope: activeScope.current };
        }
        observer.disconnect(); cancelAnimationFrame(resizeFrame); cancelPan(); activeEditor.onEnd(); instance.release();
        if (table.current === instance) { table.current = null; refitFrozen.current = () => {}; }
      };
      setReady(true);
    } catch (error) {
      if (!disposed) setFailure(error instanceof Error ? error.message : '表格初始化失败');
    }
    };
    void mount();
    return () => { disposed = true; revealVersion.current++; release(); activeEditor.onEnd(); };
    // Callback refs carry business updates without rebuilding the Canvas instance.
  }, [structure, rowHeight, frozenColCount]);

  useLayoutEffect(() => {
    if (!table.current || editing.current || appliedRecords.current === records) return;
    const previous = appliedRecords.current;
    if (previous.length === records.length && previous.every((record, index) => record.__key === records[index]?.__key)) {
      const changes: RecordValue[] = [], indexes: number[] = [];
      records.forEach((record, index) => { if (columns.some((_, col) => ['c', 'd', 'e', 's', 'b', 'i', 'v'].some((prefix) => record[`${prefix}${col}`] !== previous[index]?.[`${prefix}${col}`]))) { changes.push(record); indexes.push(index); } });
      if (changes.length) table.current.updateRecords(changes, indexes);
    } else table.current.setRecords(records);
    appliedRecords.current = records; refitFrozen.current();
  }, [records, columns, editVersion]);
  useLayoutEffect(() => { table.current?.resize(); }, [resolvedHeight]);
  useLayoutEffect(() => {
    if (!props.columnWidths) return;
    widths.current = new Map(Object.entries(props.columnWidths));
    columnMapRef.current.forEach(({ column, physical }) => {
      const width = props.columnWidths?.[column.key] ?? column.width ?? (column.align === 'right' ? 100 : 180);
      if (table.current && table.current.getColWidth(physical) !== width) table.current.setColWidth(physical, width);
    });
    refitFrozen.current();
    table.current?.renderAsync();
  }, [props.columnWidths, ready, structure]);
  useEffect(() => { activeScope.current = props.menuScopeKey; closeMenu(); }, [props.menuScopeKey, structure, props.active]);
  useEffect(() => { if (menuKey && !rowMap.has(menuKey)) closeMenu(); }, [menuKey, rowMap]);
  useEffect(() => {
    if (!menuKey) return;
    const outsideScroll = (event: Event) => {
      if (event.target instanceof Node && menuContent.current?.contains(event.target)) return;
      closeMenu();
    };
    document.addEventListener('scroll', outsideScroll, true);
    window.addEventListener('resize', closeMenu);
    return () => { document.removeEventListener('scroll', outsideScroll, true); window.removeEventListener('resize', closeMenu); };
  }, [menuKey]);
  useEffect(() => {
    const finish = (event: Event) => { if (blocked()) table.current?.cancelEditCell(); else if (editor.current?.input && !editor.current.isComposing() && !editor.current.isEditorElement(event.target as HTMLElement)) table.current?.completeEditCell(); };
    document.addEventListener('pointerdown', finish, true);
    return () => document.removeEventListener('pointerdown', finish, true);
  }, []);

  const goTo = (index: number) => {
    const navigate = async () => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    const key = getRowKey(row);
    await editor.current?.waitForComposition(); table.current?.completeEditCell();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const targetIndex = latest.current.rows.findIndex((item) => latest.current.getRowKey(item) === key);
    const target = latest.current.rows[targetIndex]; if (!target || blocked()) return;
    const column = columnMapRef.current.get(currentColumn?.column.key ?? '') ?? columnMapRef.current.values().next().value;
    if (!column) return;
    activateRef.current(target, column.column.key); table.current?.scrollToCell({ col: column.physical, row: targetIndex + 1 }); table.current?.selectCell(column.physical, targetIndex + 1);
    };
    const pending = navigate(); navigationPending.current = pending;
    return pending;
  };
  const viewCurrent = async (trigger: HTMLButtonElement) => {
    const scope = latest.current.menuScopeKey;
    let pending: Promise<void>;
    do { pending = navigationPending.current; await pending; } while (pending !== navigationPending.current);
    // VTable emits programmatic scroll events on the following frame. Open after they settle.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!trigger.isConnected || blocked() || scope !== latest.current.menuScopeKey || pending !== navigationPending.current) return;
    const preferred = latest.current.selectedRowKey ?? activeTarget.current?.key;
    const first = latest.current.rows[0];
    const key = preferred && rowMapRef.current.has(preferred) ? preferred : first ? latest.current.getRowKey(first) : undefined;
    const row = key ? rowMapRef.current.get(key) : undefined;
    if (!key || !row) return;
    if (latest.current.renderRowMenu) openMenuRef.current(row, trigger.getBoundingClientRect(), trigger);
    else { detailsReturnFocus.current = trigger; setDetailsKey(key); }
  };
  const keyboardAction = async (toggle: boolean) => {
    const scope = latest.current.menuScopeKey;
    let pending: Promise<void>;
    do { pending = navigationPending.current; await pending; } while (pending !== navigationPending.current);
    if (blocked() || scope !== latest.current.menuScopeKey) return;
    const preferred = latest.current.selectedRowKey ?? activeTarget.current?.key;
    const first = latest.current.rows[0];
    const key = preferred && rowMapRef.current.has(preferred) ? preferred : first ? latest.current.getRowKey(first) : undefined;
    const row = key ? rowMapRef.current.get(key) : undefined;
    const field = columnMapRef.current.get(activeTarget.current?.columnKey ?? '') ?? columnMapRef.current.values().next().value;
    if (!row || !key || !field || field.column.disabled?.(row)) return;
    const column = field.column, rowIndex = latest.current.rows.findIndex((item) => latest.current.getRowKey(item) === key);
    if (toggle) { if (column.getChecked) column.onToggle?.(row, !column.getChecked(row)); return; }
    if (!(column.buttonWhen?.(row) ?? true)) return;
    if (column.editable?.(row)) { table.current?.startEditCell(field.physical, rowIndex + 1); return; }
    column.onActivate?.(row);
    if (column.openDetails) { detailsReturnFocus.current = container.current; setDetailsKey(key); }
    if (column.openMenu) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!table.current || !container.current || pending !== navigationPending.current || scope !== latest.current.menuScopeKey || blocked()) return;
      const cell = table.current.getCellRelativeRect(field.physical, rowIndex + 1), bounds = container.current.getBoundingClientRect();
      openMenuRef.current(row, new DOMRect(bounds.left + cell.left, bounds.top + cell.top, cell.width, cell.height), container.current);
    }
  };
  const navigation = <div className="scm-grid-row-controls">
      <button type="button" aria-label={`${label} 上一行`} disabled={!rows.length || currentIndex === 0} onClick={() => goTo(currentIndex - 1)}>上一行</button>
      <label>定位行<input aria-label={`${label} 定位行`} type="number" min={1} max={Math.max(1, rows.length)} value={rows.length ? currentIndex + 1 : ''} disabled={!rows.length} onChange={(event) => { if (event.target.value) goTo(Number(event.target.value) - 1); }} /></label>
      <button type="button" aria-label={`${label} 下一行`} disabled={!rows.length || currentIndex >= rows.length - 1} onClick={() => goTo(currentIndex + 1)}>下一行</button>
      {((detailsMode === 'dialog' && renderDetails) || props.renderRowMenu) && <button type="button" aria-label={`${label} 查看当前记录`} aria-haspopup={props.renderRowMenu ? 'menu' : 'dialog'} disabled={!currentRow} onClick={(event) => { void viewCurrent(event.currentTarget); }}>查看 / 操作</button>}
    </div>;
  return <section className={`scm-data-grid ${className}`} data-grid-label={label} data-row-count={rows.length} data-column-count={columns.length} data-grid-column-keys={JSON.stringify(columns.map((column) => column.key))}>
    <div className="scm-grid-navigation"><span id={`${id}-label`}>{label} · {rows.length} 行</span>{props.headerEnd && <div className="scm-grid-header-actions">{props.headerEnd}</div>}{props.navigationPosition !== 'bottom' && navigation}</div>
    <span id={`${id}-cell`} className="scm-grid-announcement" aria-live="polite">{currentRow && currentColumn ? `${currentIndex + 1} 行 · ${currentColumn.column.editLabel?.(currentRow) ?? `${currentColumn.column.title}：${currentColumn.column.utility === 'number' ? currentIndex + 1 : currentColumn.column.getValue(currentRow) ?? ''}`}` : ''}</span>
    {failure ? <p role="alert">表格暂时无法显示：{failure}</p> : <div ref={container} className="scm-grid-canvas" style={{ height: resolvedHeight } as CSSProperties} role="grid" aria-busy={!ready} aria-labelledby={`${id}-label`} aria-describedby={`${id}-cell`} aria-rowcount={rows.length + 1} aria-colcount={columns.length + nativeOffset} tabIndex={0} onKeyDownCapture={(event) => {
      if ((event.target as HTMLElement).closest('input,button,select,textarea')) return;
      if (blocked()) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); goTo(currentIndex + (event.key === 'ArrowDown' ? 1 : -1)); }
      else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && rows.length) {
        event.preventDefault(); event.stopPropagation();
        const index = Math.max(0, Math.min(columns.length - 1, (currentColumn?.index ?? 0) + (event.key === 'ArrowRight' ? 1 : -1)));
        const column = columnMap.get(columns[index]!.key)!;
        setActiveColumnKey(column.column.key); table.current?.selectCell(column.physical, currentIndex + 1); table.current?.scrollToCell({ col: column.physical, row: currentIndex + 1 });
      } else if ((event.key === 'Enter' || event.key === 'F2') && currentRow && currentColumn) {
        event.preventDefault(); event.stopPropagation();
        void keyboardAction(false);
      } else if (event.key === ' ' && currentRow && currentColumn?.column.getChecked) {
        event.preventDefault(); event.stopPropagation(); void keyboardAction(true);
      }
    }} />}
    {!rows.length && <p className="scm-grid-empty" role="status">当前没有符合条件的记录。</p>}
    {props.navigationPosition === 'bottom' && <div className="scm-grid-footer"><div className="scm-grid-footer-start">{props.footerStart}</div><div className="scm-grid-footer-end">{navigation}{props.footerEnd}</div></div>}
    {props.renderRowMenu && <Popover open={props.active !== false && menuRow !== undefined} onOpenChange={(open) => { if (!open) closeMenu(); }} portalContainer={container.current?.closest('dialog')}>
      <PopoverAnchor virtualRef={menuAnchor} />
      <PopoverContent ref={menuContent} className="scm-grid-row-menu" role="menu" aria-label={`${label} 行操作`} align="end" data-grid-menu-row-key={menuKey}
        onOpenAutoFocus={(event) => { event.preventDefault(); menuContent.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]):not([aria-disabled="true"])')?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = menuReturnFocus.current;
          const activeDialog = document.activeElement?.closest('dialog[open]');
          if (restoreMenuFocus.current && target?.isConnected && (!activeDialog || activeDialog === target.closest('dialog[open]'))) target.focus({ preventScroll: true });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') { closeMenu(); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]):not([aria-disabled="true"])'));
          const index = items.findIndex((item) => item === document.activeElement || item.contains(document.activeElement));
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}>
        {menuRow !== undefined && props.renderRowMenu(menuRow, {
          close: closeMenu,
          openDetails: () => { restoreMenuFocus.current = false; detailsReturnFocus.current = menuReturnFocus.current; if (menuKey) setDetailsKey(menuKey); closeMenu(); },
        })}
      </PopoverContent>
    </Popover>}
    {detailsMode === 'inline' && currentRow !== undefined && renderDetails && <div key={chosenKey} className="scm-grid-record" data-grid-row-key={chosenKey} data-grid-row-index={currentIndex + 1} aria-label={`${label} 当前记录`} role="region">{renderDetails(currentRow, { close: closeDetails })}</div>}
    {detailsMode === 'dialog' && renderDetails && <Dialog className="scm-grid-dialog" open={props.active !== false && detailsRow !== undefined} title={detailsRow !== undefined ? props.detailsTitle?.(detailsRow) ?? `${label} 记录详情` : `${label} 记录详情`} close={closeDetails} wide>
      {detailsRow !== undefined && <div key={detailsKey} className="scm-grid-record" data-grid-row-key={detailsKey} data-grid-row-index={(rowIndexes.get(detailsKey!) ?? 0) + 1} aria-label={`${label} 当前记录`} role="region">{renderDetails(detailsRow, { close: closeDetails })}</div>}
    </Dialog>}
  </section>;
}
