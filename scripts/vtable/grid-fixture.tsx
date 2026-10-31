import { StrictMode, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ScmDataGrid, type GridColumn, type GridHandle } from '../../apps/web/src/components/ui/scm-data-grid';
import { GridTableScope } from '../../apps/web/src/components/ui/grid-table-scope';
import { BatchTable } from '../../apps/web/src/features/batch-shared';
import { ShippingShopCell, ShippingProductCells, ShippingBoxQuantityCells, ShippingCodesCell } from '../../apps/web/src/features/shipping-table-parts';
import '../../apps/web/src/components/ui/controls.css';

type Row = { id: string; name: string; po: string; weight: string; checked: boolean };
const initial: Row[] = [{ id: 'a', name: '技术商品甲', po: '00042', weight: '12.34', checked: false }, { id: 'b', name: '技术商品乙', po: 'PO-中文', weight: '8.00', checked: false }];

type UtilityRow = Row & { group: boolean };
function UtilityFixture() {
  const [rows, setRows] = useState<UtilityRow[]>(() => [{ id: 'group', name: 'FBA-UTILITY', po: '', weight: '', checked: false, group: true }, ...Array.from({ length: 30 }, (_, index) => ({ id: `p${index + 1}`, name: `夹具商品 ${index + 1}`, po: `PO-${index + 1}`, weight: String(index + 1), checked: false, group: false }))]);
  const [expanded, setExpanded] = useState(true), [hidePo, setHidePo] = useState(false), [mounted, setMounted] = useState(true);
  const [widths, setWidths] = useState<Record<string, number>>({}), [active, setActive] = useState('group'), [scope, setScope] = useState(0), [edits, setEdits] = useState(0), [menuResult, setMenuResult] = useState('');
  const ref = useRef<GridHandle>(null);
  const visibleRows = expanded ? rows : rows.filter((row) => row.group);
  const columns: GridColumn<UtilityRow>[] = [
    { key: 'expand', title: '', width: 32, getValue: () => '', icon: (row) => row.group ? expanded ? 'collapse' : 'expand' : null, buttonWhen: (row) => row.group, onActivate: () => setExpanded((value) => !value) },
    { key: 'number', title: '#', width: 48, getValue: () => '', utility: 'number' },
    { key: 'choice', title: '选择', width: 52, getValue: () => '', getChecked: (row) => row.checked, onToggle: (row, checked) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, checked } : item)) },
    { key: 'identity', title: '货件', width: 190, getValue: (row) => row.name },
    ...(!hidePo ? [{ key: 'po', title: 'PO', width: 160, getValue: (row: UtilityRow) => row.po, editable: (row: UtilityRow) => !row.group, editLabel: (row: UtilityRow) => `${row.name} 新布局 PO` }] : []),
    { key: 'weight', title: '毛重', width: 130, getValue: (row) => row.weight, editable: (row) => !row.group, editLabel: (row) => `${row.name} 新布局毛重`, inputMode: 'decimal' },
    ...Array.from({ length: 7 }, (_, index): GridColumn<UtilityRow> => ({ key: `wide:${index}`, title: `补充列 ${index + 1}`, width: 155, getValue: (row) => `${row.id} 业务字段 ${index + 1}` })),
    { key: 'actions', title: '操作', width: 48, getValue: () => '', icon: () => 'more', openMenu: true },
  ];
  const first = rows.find((row) => row.id === 'p1'), second = rows.find((row) => row.id === 'p2');
  return <section aria-label="新布局功能夹具">
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button onClick={() => void ref.current?.revealCell('p1', 'po', { edit: true })}>编辑新布局 PO</button>
      <button onClick={() => void ref.current?.revealCell(active, 'po', { edit: true })}>编辑当前新布局 PO</button>
      <button onClick={() => void ref.current?.revealCell('p1', 'weight', { edit: true })}>编辑新布局毛重</button>
      <button onClick={() => void ref.current?.revealCell('p1', 'actions')}>定位行内菜单</button>
      <button onClick={async () => { await ref.current?.finishEdit(); setHidePo((value) => !value); }}>切换 PO 列</button>
      <button onClick={() => setMounted((value) => !value)}>切换新布局挂载</button>
      <button onClick={() => setTimeout(() => setScope((value) => value + 1), 600)}>刷新菜单范围</button>
      <button onClick={() => setTimeout(() => setRows((current) => current.filter((row) => row.id !== 'p2')), 600)}>删除第二条夹具商品</button>
    </div>
    <output data-utility-state style={{ display: 'block', overflowWrap: 'anywhere' }}>{JSON.stringify({ first, second, active, edits, selected: rows.filter((row) => row.checked).map((row) => row.id), menuResult })}</output>
    <output data-utility-widths style={{ display: 'block', overflowWrap: 'anywhere' }}>{JSON.stringify(widths)}</output>
    <div style={{ minWidth: 0, paddingInline: 24 }}>{mounted && <ScmDataGrid label="新布局夹具" rows={visibleRows} columns={columns} getRowKey={(row) => row.id} gridRef={ref} rowSeriesNumber={false} navigationPosition="bottom" frozenColCount={4} rowHeight={40} height={264} middleMousePan menuScopeKey={String(scope)} columnWidths={widths} onColumnWidthsChange={setWidths}
      onActiveRowChange={(row) => setActive(row.id)} isGroupRow={(row) => row.group}
      onEdit={(edit) => { setEdits((value) => value + 1); setRows((current) => current.map((row) => row.id === edit.rowKey ? { ...row, [edit.columnKey]: edit.value } : row)); }}
      footerStart={<span>功能夹具底部信息</span>} footerEnd={<button type="button" onClick={() => setMenuResult('page-next')}>夹具下一页</button>}
      detailsMode="dialog" detailsTitle={(row) => `新布局记录 ${row.name}`} renderDetails={(row) => <p>{row.id} · {row.name} · {row.po} · {row.weight}</p>}
      renderRowMenu={(row, { close, openDetails }) => <><p>摘要：{row.name}</p><div data-utility-menu-scroll style={{ maxHeight: 72, overflowY: 'auto' }}>{Array.from({ length: 8 }, (_, index) => <p key={index}>菜单补充说明 {index + 1}</p>)}</div><button type="button" role="menuitem" onClick={() => { setMenuResult(row.id); close(); }}>菜单动作 {row.id}</button><button type="button" role="menuitem" disabled>不可用操作</button><button type="button" role="menuitem" onClick={openDetails}>完整详情</button></>} />}</div>
  </section>;
}

function Fixture() {
  const [rows, setRows] = useState(initial), [pending, setPending] = useState(false), [saved, setSaved] = useState(''), [large, setLarge] = useState<[number, number]>([0, 0]), [mounted, setMounted] = useState(true), [locked, setLocked] = useState(false);
  const [revealStatus, setRevealStatus] = useState('idle');
  const ref = useRef<GridHandle>(null);
  const abortableReveal = useRef<AbortController | null>(null);
  const outsideFocus = useRef<HTMLInputElement>(null);
  const columns: GridColumn<Row>[] = [
    { key: 'name', title: '商品', width: 180, getValue: (row) => row.name },
    { key: 'po', title: 'PO', width: 220, getValue: (row) => row.po, editable: () => true, editLabel: (row) => row.name + ' PO' },
    { key: 'weight', title: '毛重 KG', width: 120, align: 'right', getValue: (row) => row.weight, editable: () => true, editLabel: (row) => row.name + ' 毛重', inputMode: 'decimal' },
    { key: 'selection', title: '选择', width: 70, getValue: () => '', getChecked: (row) => row.checked, onToggle: (row, checked) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, checked } : item)) },
  ];
  const bigRows = useMemo(() => Array.from({ length: large[0] }, (_, index) => ({ id: String(index), index })), [large]);
  const bigColumns = useMemo<GridColumn<{ id: string; index: number }>[]>(() => Array.from({ length: large[1] }, (_, index) => ({ key: String(index), title: index === 0 ? '货件' : '箱 ' + index, width: index === 0 ? 180 : 82, align: index === 0 ? 'left' : 'right', getValue: (row) => index === 0 ? 'FBA-' + row.id.padStart(6, '0') : (row.index + index) % 100 })), [large]);
  return <main style={{ padding: 16, minWidth: 0 }}>
    <h1>业务网格验证夹具</h1><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button onClick={() => void ref.current?.revealCell('a', 'po', { edit: true })}>编辑首行 PO</button>
      <button onClick={() => void ref.current?.revealCell('b', 'weight', { edit: true })}>编辑第二行毛重</button>
      <button onClick={async () => {
        abortableReveal.current?.abort();
        const controller = new AbortController(); abortableReveal.current = controller; setRevealStatus('pending');
        await ref.current?.revealCell('b', 'weight', { edit: true, signal: controller.signal });
        if (abortableReveal.current === controller) setRevealStatus(controller.signal.aborted ? 'cancelled' : 'completed');
      }}>开始可撤销定位</button>
      <button onClick={() => { abortableReveal.current?.abort(); outsideFocus.current?.focus(); }}>撤销定位并切换焦点</button>
      <button onClick={async () => { const edit = await ref.current?.finishEdit(); const next = edit ? rows.map((row) => row.id === edit.rowKey ? { ...row, [edit.columnKey]: edit.value } : row) : rows; setSaved(JSON.stringify(next)); }}>保存夹具</button>
      <button onClick={() => ref.current?.cancelEdit()}>取消单元格</button><button onClick={() => setLocked((value) => !value)}>切换编辑锁定</button>
      <button onClick={() => setLarge([10000, 50])}>一万行五十列</button><button onClick={() => setLarge([50000, 100])}>五万行一百列</button>
      <button onClick={() => setMounted((value) => !value)}>切换网格挂载</button>
    </div><label>网格外部焦点<input ref={outsideFocus} aria-label="网格外部焦点" /></label><output data-reveal-status>{revealStatus}</output><output data-pending>{String(pending)}</output><output data-saved>{saved}</output>
    <fieldset disabled={locked} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><ScmDataGrid label="编辑夹具" rows={rows} columns={columns} getRowKey={(row) => row.id} gridRef={ref} onPendingEditChange={setPending} onEdit={(edit) => setRows((current) => current.map((row) => row.id === edit.rowKey ? { ...row, [edit.columnKey]: edit.value } : row))} renderDetails={(row) => <p>{row.name} · {row.po} · {row.weight} · {row.checked ? '已选' : '未选'}</p>} /></fieldset>
    <GridTableScope><BatchTable label="辅助表夹具" headers={['名称', '操作']}>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td><button onClick={() => setSaved(row.id)}>操作 {row.name}</button></td></tr>)}</BatchTable></GridTableScope>
    <GridTableScope><BatchTable label="结构单元格夹具" headers={['店铺', 'MSKU', 'FNSKU', '品名', 'SKU', '箱1', '箱2', '内部编码']}><tr key="structural"><ShippingShopCell shop="技术店铺" country="美国" channel="SEA" /><ShippingProductCells msku="M-STRUCT" fnsku="F-STRUCT" sku="S-STRUCT" productName="结构商品" separate /><ShippingBoxQuantityCells columns={[1, 2]} boxes={[{ boxOrder: 1, quantity: 12 }, { boxOrder: 2, quantity: 34 }]} /><ShippingCodesCell codes={['A1', 'A2']} /></tr></BatchTable></GridTableScope>
    <ScmDataGrid label="详情浮窗夹具" rows={rows} columns={[
      { key: 'name', title: '货件 / 商品', width: 220, getValue: (row) => row.id === 'a' ? '货件 · FBA-A' : '商品 1 / 1 · FBA-A', indent: (row) => row.id === 'a' ? 0 : 14 },
      { key: 'expand', title: '明细', width: 120, getValue: (row) => row.id === 'a' ? '展开商品' : '商品明细', buttonWhen: (row) => row.id === 'a', onActivate: (row) => setSaved('expand:' + row.id) },
      { key: 'actions', title: '操作', width: 150, getValue: () => '查看 / 操作', openDetails: true },
    ]} getRowKey={(row) => row.id} rowHeight={56} isGroupRow={(row) => row.id === 'a'} detailsMode="dialog" detailsTitle={(row) => '记录 ' + row.name} renderDetails={(row) => <p>{row.name} · {row.id}</p>} />
    <UtilityFixture />
    {mounted && large[0] > 0 && <ScmDataGrid label="性能夹具" rows={bigRows} columns={bigColumns} getRowKey={(row) => row.id} height={560} renderDetails={(row) => <p>当前货件 FBA-{row.id.padStart(6, '0')}</p>} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
