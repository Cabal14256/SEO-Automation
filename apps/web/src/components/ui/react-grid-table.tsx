import { Children, Fragment, cloneElement, isValidElement, useMemo, type ReactElement, type ReactNode } from 'react';
import { ScmDataGrid, type GridColumn } from './scm-data-grid';
import { Button } from './button';
import { PersistentDataGrid, usePersistentGridScope } from './persistent-data-grid';

type ElementProps = { children?: ReactNode; label?: string; title?: string; textValue?: string; status?: string; value?: unknown; checked?: boolean; disabled?: boolean; type?: string; onChange?: (value: unknown) => void; colSpan?: number };
type Choice = { checked: boolean; disabled: boolean; toggle: (checked: boolean) => void };
type Row = { key: string; cells: ReactNode[]; text: string[]; choice?: Choice };
const statuses: Record<string, string> = { draft: '草稿', pending_review: '待复核', approved: '已通过', returned: '已退回', cancelled: '已取消', superseded: '已替代', stale: '已失效', queued: '排队中', running: '处理中', completed: '已完成', failed: '失败', ready: '可生成', blocked: '待处理', active: '当前记录', trash: '已删除' };

function elements(children: ReactNode): ReactElement<ElementProps>[] {
  const result: ReactElement<ElementProps>[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ElementProps>(child)) return;
    const structural = typeof child.type === 'function' ? (child.type as { gridCells?: (props: ElementProps) => ReactNode }).gridCells : undefined;
    if (child.type === Fragment) result.push(...elements(child.props.children));
    // Only explicitly marked, hook-free td/Fragment helpers participate in this protocol.
    else if (structural) result.push(...elements(structural(child.props)));
    else result.push(child);
  });
  return result;
}

/** Extract supplied data without invoking arbitrary components or mounting a hidden table. */
export function gridNodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return String(node);
  if (Array.isArray(node)) return node.map(gridNodeText).filter(Boolean).join(' ');
  if (!isValidElement<ElementProps>(node)) return '';
  const props = node.props;
  if (props.textValue !== undefined) return props.textValue;
  const childText = gridNodeText(props.children);
  if (childText) return childText;
  if (props.status) return statuses[props.status] ?? props.status;
  if (props.checked !== undefined) return '';
  if (typeof props.value === 'string' || typeof props.value === 'number') return String(props.value);
  return props.label ?? props.title ?? '';
}

function choiceIn(node: ReactNode): Choice | undefined {
  if (Array.isArray(node)) return node.map(choiceIn).find(Boolean);
  if (!isValidElement<ElementProps>(node)) return undefined;
  const props = node.props;
  if (typeof props.checked === 'boolean' && typeof props.onChange === 'function') {
    return { checked: props.checked, disabled: Boolean(props.disabled), toggle: (checked) => {
      // Native inputs receive an input-shaped event; existing Check components receive a boolean.
      props.onChange?.(node.type === 'input' ? { target: { checked }, currentTarget: { checked } } : checked);
    } };
  }
  return choiceIn(props.children);
}

/** Compatibility bridge for scoped, read-only business tables and their row actions. */
export function ReactGridTable({ label, headers, children }: { label: string; headers: ReactNode[]; children: ReactNode }) {
  const preferenceScope = usePersistentGridScope();
  const rows = useMemo<Row[]>(() => elements(children).filter((element) => element.type === 'tr').map((element, index) => {
    const cells: ReactNode[] = [];
    for (const cell of elements(element.props.children)) {
      cells.push(cell.props.children);
      for (let column = 1; column < (cell.props.colSpan ?? 1); column++) cells.push(null);
    }
    return { key: String(element.key ?? `row:${index}`), cells, text: cells.map(gridNodeText), choice: choiceIn(element.props.children) };
  }), [children]);
  const hasChoices = rows.some((row) => row.choice);
  const columns = useMemo<GridColumn<Row>[]>(() => [
    ...(hasChoices ? [{ key: 'selection', title: '选择', width: 64, getValue: () => '', getChecked: (row: Row) => row.choice?.checked ?? false, disabled: (row: Row) => !row.choice || row.choice.disabled, onToggle: (row: Row, checked: boolean) => row.choice?.toggle(checked) }] : []),
    ...headers.map((header, index): GridColumn<Row> => ({
      key: `column:${index}`, title: gridNodeText(header), width: /操作|查看/.test(gridNodeText(header)) ? 180 : index === 0 ? 240 : 220,
      getValue: (row) => row.text[index] ?? '',
    })),
  ], [headers, hasChoices]);
  if (preferenceScope) return <PersistentReactGrid label={label} headers={headers} rows={rows} hasChoices={hasChoices} />;
  return <ScmDataGrid label={label} rows={rows} columns={columns} getRowKey={(row) => row.key} rowHeight={56} maxHeight={320} frozenColCount={hasChoices ? 2 : 1} renderDetails={(row) => <dl className="scm-grid-record-fields">{headers.map((header, index) => <div className="scm-grid-record-field" key={index}><dt>{header}</dt><dd>{row.cells[index] ?? '—'}</dd></div>)}</dl>} />;
}

/** Reuse supplied buttons as DOM controls; never infer or call arbitrary component functions. */
function menuControls(node: ReactNode): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; role?: string }>(child)) return child;
    if (child.type === Button || child.type === 'button' || child.type === 'a') return cloneElement(child, { role: 'menuitem' });
    if (child.props.children) return cloneElement(child, { children: menuControls(child.props.children) });
    return child;
  });
}
function PersistentReactGrid({ label, headers, rows, hasChoices }: { label: string; headers: ReactNode[]; rows: Row[]; hasChoices: boolean }) {
  const actionIndexes = headers.flatMap((header, index) => gridNodeText(header).trim() === '操作' ? [index] : []);
  const dataColumns = headers.flatMap((header, index): GridColumn<Row>[] => actionIndexes.includes(index) ? [] : [{
    key: `column:${gridNodeText(header)}`, title: gridNodeText(header), width: index === 0 ? 230 : 210, getValue: (row) => row.text[index] ?? '',
  }]);
  const identityKey = dataColumns[0]?.key ?? 'rowNumber';
  const columns: GridColumn<Row>[] = [
    { key: 'rowNumber', title: '#', width: 48, utility: 'number', align: 'center', getValue: () => '' },
    ...(hasChoices ? [{ key: 'selection', title: '选择', width: 48, getValue: () => '', getChecked: (row: Row) => row.choice?.checked ?? false, disabled: (row: Row) => !row.choice || row.choice.disabled, onToggle: (row: Row, checked: boolean) => row.choice?.toggle(checked) }] : []),
    ...dataColumns,
    { key: 'actions', title: '操作', width: 48, align: 'center', getValue: () => '', icon: () => 'more', openMenu: true },
  ];
  return <PersistentDataGrid tableKey={label} label={label} rows={rows} columns={columns} mandatoryColumnKeys={[identityKey]} getRowKey={(row) => row.key} rowHeight={56} maxHeight={320} frozenColCount={hasChoices ? 3 : 2}
    detailsMode="dialog" detailsTitle={(row) => `${label} · ${row.text[0] || '完整详情'}`}
    renderDetails={(row) => <dl className="scm-grid-record-fields">{headers.map((header, index) => <div className="scm-grid-record-field" key={index}><dt>{header}</dt><dd>{row.cells[index] ?? '—'}</dd></div>)}</dl>}
    renderRowMenu={(row, context) => <><div className="scm-record-menu-summary"><strong>{row.text[0]}</strong>{row.text.map((text, index) => index > 0 && !actionIndexes.includes(index) && text ? <p key={index}>{gridNodeText(headers[index])}：{text}</p> : null)}</div>
      <div className="scm-record-menu-actions" onClick={(event) => { if (event.target instanceof Element && event.target.closest('button:not(:disabled),a[href]')) context.close(); }}>{actionIndexes.map((index) => <Fragment key={index}>{menuControls(row.cells[index])}</Fragment>)}
        <Button type="button" role="menuitem" variant="text" onClick={context.openDetails}>完整详情</Button>
      </div></>} />;
}
