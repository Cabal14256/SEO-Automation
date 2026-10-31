import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { DOCUMENT_BOX_FIELDS, documentBoxFieldKey, documentBoxes, documentBoxSources, documentBoxValue, type DocumentBoxField, type DocumentRevisionData } from '@scm/contracts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { TableSelectionCheckbox, timestamp } from './batch-shared';
import { scrollDocumentFieldIntoView } from './document-details-navigation';
import { DocumentDataGrid, useDocumentGridPreferences } from './document-grid';
import './document-boxes.css';
import { type GridColumn, type GridHandle } from '../components/ui/scm-data-grid';

const labels = { po: 'PO / Reference ID', weight: '毛重（KG）', length: '长（CM）', width: '宽（CM）', height: '高（CM）' };
const columns = ['po', 'weight', 'length', 'width', 'height'] as const;
const emptyBatch = { po: '', weight: '', length: '', width: '', height: '' };
type BoxFilter = 'all' | 'missing' | 'adjusted';
export type DocumentBoxEditorHandle = { finishEdit: () => Promise<Record<string, string | null> | null>; cancelEdit: () => void };
const normalized = (field: DocumentBoxField, value: string): string | null => field === 'po'
  ? value.trim() || null
  : documentBoxValue(value, field === 'weight' ? 'KG' : 'CM', field === 'weight' ? 'weight' : 'dimension');

export function DocumentBoxAdjustments({ members, fields, disabled, updateFields, sectionId, revealRequest, onPendingEditChange, registerEditor, active = true }: {
  members: DocumentRevisionData['members'];
  fields: Record<string, string | null>;
  disabled: boolean;
  active?: boolean;
  updateFields: (changes: Record<string, string | null>) => void;
  sectionId?: string;
  revealRequest?: { field: string; requestId: number };
  onPendingEditChange?: (pending: boolean) => void;
  registerEditor?: (handle: DocumentBoxEditorHandle | null) => void;
}) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const completedReveal = useRef('');
  const grid = useRef<GridHandle>(null);
  const preferences = useDocumentGridPreferences('box-adjustments');
  const latestPreferences = useRef(preferences); latestPreferences.current = preferences;
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  const [filter, setFilter] = useState<BoxFilter>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState(emptyBatch);
  const [confirmedOverwrite, setConfirmedOverwrite] = useState('');
  const [notice, setNotice] = useState('');
  const [editingBox, setEditingBox] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [detailView, setDetailView] = useState<'full' | 'source'>('full');
  const [openSourceKey, setOpenSourceKey] = useState<string | null>(null);
  const [preparedReveal, setPreparedReveal] = useState<{ key: string; demandId: string; boxId: string; field: DocumentBoxField; requestId: number } | null>(null);
  const releaseFrame = useRef(0);
  const locked = useRef(disabled); locked.current = disabled;
  useEffect(() => () => cancelAnimationFrame(releaseFrame.current), []);
  const editRow = (boxId: string | null) => {
    cancelAnimationFrame(releaseFrame.current);
    if (boxId) { setEditingBox(boxId); return; }
    // Tab starts the next input on the following frame. Keep its box pinned.
    releaseFrame.current = requestAnimationFrame(() => {
      releaseFrame.current = requestAnimationFrame(() => {
        if (!section.current) return;
        const focus = document.activeElement;
        if (!section.current.querySelector('.scm-grid-cell-editor') && !(focus instanceof Element && focus.closest('.document-box-active'))) setEditingBox(null);
      });
    });
  };
  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)');
    const change = async () => { await grid.current?.finishEdit(); if (section.current) setNarrow(media.matches); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    registerEditor?.({ finishEdit: async () => {
      const edit = await grid.current?.finishEdit();
      if (!edit) return null;
      const identity = JSON.parse(edit.rowKey) as [string, string];
      return { [documentBoxFieldKey(identity[1], edit.columnKey as DocumentBoxField)]: edit.value };
    }, cancelEdit: () => grid.current?.cancelEdit() });
    return () => registerEditor?.(null);
  }, [registerEditor]);
  useEffect(() => {
    if (!active || !revealRequest || !/^box\.[^.]+\.(?:po|weight|length|width|height)$/.test(revealRequest.field)) { setPreparedReveal(null); return; }
    const key = JSON.stringify([revealRequest.field, revealRequest.requestId]);
    if (completedReveal.current === key) return;
    const [, boxId, field] = revealRequest.field.split('.');
    const source = members.flatMap(documentBoxSources).find((box) => box.boxId === boxId);
    if (!source || !boxId || !field) return;
    let live = true;
    void grid.current?.finishEdit().then(() => {
      if (!live) return;
      setFilter('all'); setEditingBox(null);
      setCollapsedGroups((current) => current.filter((demandId) => demandId !== source.demandId));
      const current = latestPreferences.current;
      if (current.hiddenColumnKeys.includes(field)) current.setHiddenColumnKeys(current.hiddenColumnKeys.filter((columnKey) => columnKey !== field));
      setPreparedReveal({ key, demandId: source.demandId, boxId, field: field as DocumentBoxField, requestId: revealRequest.requestId });
    });
    return () => { live = false; };
  }, [active, revealRequest?.field, revealRequest?.requestId, members]);
  useEffect(() => {
    if (!active || !preparedReveal || preparedReveal.key !== JSON.stringify([revealRequest?.field, revealRequest?.requestId]) || filter !== 'all' || collapsedGroups.includes(preparedReveal.demandId) || preferences.hiddenColumnKeys.includes(preparedReveal.field) || completedReveal.current === preparedReveal.key) return;
    let live = true;
    const controller = new AbortController();
    // Column visibility and group expansion must commit before the Canvas lookup.
    const frame = requestAnimationFrame(() => {
      void grid.current?.revealCell(JSON.stringify([preparedReveal.demandId, preparedReveal.boxId]), preparedReveal.field, { edit: !narrow && !disabled, requestId: preparedReveal.requestId, signal: controller.signal }).then(() => {
        if (!live) return;
        const input = narrow ? section.current?.querySelector<HTMLInputElement>(`input[data-document-field="${documentBoxFieldKey(preparedReveal.boxId, preparedReveal.field)}"]`) : section.current?.querySelector<HTMLInputElement>('.scm-grid-cell-editor');
        if (input && !input.disabled) { input.focus({ preventScroll: true }); scrollDocumentFieldIntoView(input); }
        completedReveal.current = preparedReveal.key;
      });
    });
    return () => { live = false; controller.abort(); cancelAnimationFrame(frame); };
  }, [active, filter, collapsedGroups, preferences.hiddenColumnKeys, preparedReveal, revealRequest?.field, revealRequest?.requestId, narrow, disabled]);
  const boxes = useMemo(() => members.flatMap((member) => {
    const adopted = new Map(documentBoxes(member, fields).map((box) => [box.boxId, box]));
    return documentBoxSources(member).map((source) => {
      const box = adopted.get(source.boxId)!;
      const adjusted = DOCUMENT_BOX_FIELDS.some((field) => fields[documentBoxFieldKey(source.boxId, field)] !== undefined && fields[documentBoxFieldKey(source.boxId, field)] !== null);
      return { source, adopted: box, adjusted, missing: !box.po || Object.values(box.values).some((value) => !value) };
    });
  }), [members, fields]);
  // Completing the last missing field must not remove its input mid-keystroke.
  const visible = boxes.filter((box) => box.source.boxId === editingBox || filter === 'all' || (filter === 'missing' ? box.missing : box.adjusted));
  const groups = new Map<string, { fba: string; boxes: typeof boxes }>();
  for (const box of visible) {
    const group = groups.get(box.source.demandId);
    if (group) group.boxes.push(box); else groups.set(box.source.demandId, { fba: box.source.fba, boxes: [box] });
  }
  const expandedBoxes = visible.filter((box) => !collapsedGroups.includes(box.source.demandId));
  const selectedBoxes = boxes.filter((box) => selected.includes(box.source.boxId));
  const filteredSelected = visible.filter((box) => selected.includes(box.source.boxId)).length;
  const visibleSelected = expandedBoxes.filter((box) => selected.includes(box.source.boxId)).length;
  const batchFields = columns.filter((field) => batch[field].trim() !== '');
  const batchErrors = batchFields.filter((field) => normalized(field, batch[field]) === null);
  const batchValues = Object.fromEntries(batchFields.map((field) => [field, normalized(field, batch[field])])) as Partial<Record<DocumentBoxField, string | null>>;
  const manualChanges = selectedBoxes.flatMap(({ source }) => batchFields.flatMap((field) => {
    const value = fields[documentBoxFieldKey(source.boxId, field)];
    return value !== undefined && value !== null && normalized(field, value) !== batchValues[field] ? [[source.boxId, field, value]] : [];
  }));
  const overwriteKey = JSON.stringify([selectedBoxes.map((box) => box.source.boxId), batchValues, manualChanges]);
  const needsOverwriteConfirmation = manualChanges.length > 0 && confirmedOverwrite !== overwriteKey;
  const toggle = async (boxId: string, checked: boolean) => {
    await grid.current?.finishEdit();
    if (locked.current) return;
    setSelected((current) => checked ? [...new Set([...current, boxId])] : current.filter((value) => value !== boxId)); setNotice('');
  };
  const applyBatch = async () => {
    const edit = await grid.current?.finishEdit();
    if (edit) { setNotice('当前单元格已写入草稿，请核对批量覆盖内容后再次应用。'); return; }
    if (locked.current || !selectedBoxes.length || !batchFields.length || batchErrors.length || needsOverwriteConfirmation) return;
    updateFields(Object.fromEntries(selectedBoxes.flatMap(({ source }) => batchFields.map((field) => [documentBoxFieldKey(source.boxId, field), batchValues[field]!] as const))));
    setNotice(`已将${batchFields.map((field) => labels[field]).join('、')}应用到 ${selectedBoxes.length} 个选中箱。请保存资料修订。`);
    setBatch(emptyBatch); setConfirmedOverwrite('');
  };
  type BoxData = (typeof boxes)[number];
  type BoxGridRow = { kind: 'group'; key: string; demandId: string; fba: string; count: number } | { kind: 'box'; key: string; box: BoxData };
  const gridRows: BoxGridRow[] = [...groups].flatMap(([demandId, group]) => [
    { kind: 'group' as const, key: JSON.stringify(['group', demandId]), demandId, fba: group.fba, count: group.boxes.length },
    ...(collapsedGroups.includes(demandId) ? [] : group.boxes.map((box) => ({ kind: 'box' as const, key: JSON.stringify([box.source.demandId, box.source.boxId]), box }))),
  ]);
  const changeGroup = async (demandId: string) => {
    await grid.current?.finishEdit();
    if (!section.current) return;
    setEditingBox(null);
    setCollapsedGroups((current) => current.includes(demandId) ? current.filter((key) => key !== demandId) : [...current, demandId]);
  };
  const changeAllGroups = async (collapse: boolean) => {
    await grid.current?.finishEdit();
    if (!section.current) return;
    setEditingBox(null);
    setCollapsedGroups(collapse ? [...new Set(boxes.map((box) => box.source.demandId))] : []);
  };
  const restore = async (box: BoxData) => { await grid.current?.finishEdit(); if (!locked.current) { updateFields(Object.fromEntries(DOCUMENT_BOX_FIELDS.map((field) => [documentBoxFieldKey(box.source.boxId, field), null]))); setNotice(''); } };
  const boxLabel = (box: BoxData) => box.source.code || box.source.fba + ' 第 ' + box.source.order + ' 箱';
  const gridColumns: GridColumn<BoxGridRow>[] = [
    { key: 'expand', title: '', width: 40, getValue: () => '', icon: (row) => row.kind === 'group' ? collapsedGroups.includes(row.demandId) ? 'expand' : 'collapse' : null, onActivate: (row) => { if (row.kind === 'group') void changeGroup(row.demandId); }, buttonWhen: (row) => row.kind === 'group', disabled: (row) => row.kind !== 'group', editLabel: (row) => row.kind === 'group' ? `${collapsedGroups.includes(row.demandId) ? '展开' : '收起'} FBA ${row.fba}` : '货箱明细' },
    { key: 'rowNumber', title: '#', width: 56, align: 'center', utility: 'number', getValue: () => '' },
    { key: 'selection', title: '选择', width: 64, getValue: () => '', getChecked: (row) => row.kind === 'box' && selected.includes(row.box.source.boxId), onToggle: (row, checked) => { if (row.kind === 'box') toggle(row.box.source.boxId, checked); }, disabled: (row) => disabled || row.kind === 'group' },
    { key: 'fba', title: 'FBA', width: 180, getValue: (row) => row.kind === 'group' ? row.fba : row.box.source.fba },
    { key: 'identity', title: '货箱 / 箱码', width: 210, getValue: (row) => row.kind === 'group' ? row.count + ' 箱' : boxLabel(row.box), indent: (row) => row.kind === 'box' ? 12 : 0 },
    ...columns.map((field): GridColumn<BoxGridRow> => ({ key: field, title: labels[field], width: field === 'po' ? 220 : 120, align: field === 'po' ? 'left' : 'right', getValue: (row) => row.kind === 'group' ? '' : fields[documentBoxFieldKey(row.box.source.boxId, field)] ?? (field === 'po' ? row.box.source.po : row.box.source.values[field]) ?? '', editable: (row) => row.kind === 'box' && !disabled && !narrow, editLabel: (row) => row.kind === 'box' ? boxLabel(row.box) + ' ' + labels[field] : labels[field], inputMode: field === 'po' ? 'text' : 'decimal', maxLength: field === 'po' ? 200 : 100, getCellState: (row) => row.kind === 'group' ? 'default' : !(field === 'po' ? row.box.adopted.po : row.box.adopted.values[field]) ? 'error' : fields[documentBoxFieldKey(row.box.source.boxId, field)] != null ? 'modified' : 'default' })),
    { key: 'status', title: '状态 / 采用值', width: 180, getValue: (row) => row.kind === 'group' ? '' : (row.box.adjusted ? '已修改' : '采用自动值') + (row.box.missing ? ' · 待补齐' : '') },
    { key: 'actions', title: '操作', width: 56, getValue: () => '', icon: () => 'more', openMenu: true, editLabel: (row) => row.kind === 'group' ? `FBA ${row.fba} 分组操作` : boxLabel(row.box) + ' 操作' },
  ];
  return <section ref={section} id={sectionId} tabIndex={-1} className="document-field-group document-box-adjustments" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><h3 id={`${id}-title`}>逐箱制单资料</h3><span>{boxes.length} 箱 · KG / CM</span></div>
    <p className="mapping-help">按 FBA 核对本票 PO、毛重和长宽高；自动来源保留供核对。修改及恢复自动值都需保存资料修订。</p>
    {boxes.length === 0 ? <p className="form-note error-note" role="alert">当前来源没有可用箱明细，请在“货件与来源”中核对来源及箱码。</p> : <>
      <div className="document-box-toolbar">
        <div className="document-box-filters" role="group" aria-label="箱资料筛选">{([
          ['all', '全部', boxes.length], ['missing', '待补齐', boxes.filter((box) => box.missing).length], ['adjusted', '已修改', boxes.filter((box) => box.adjusted).length],
        ] as const).map(([value, label, count]) => <Button key={value} type="button" variant="text" aria-pressed={filter === value} onClick={async () => { await grid.current?.finishEdit(); if (!locked.current) { setEditingBox(null); setFilter(value); } }}>{label} · {count} 箱</Button>)}</div>
        <div className="document-box-selection">
          <label><TableSelectionCheckbox label="选择当前可见箱" checked={expandedBoxes.length > 0 && visibleSelected === expandedBoxes.length} indeterminate={visibleSelected > 0 && visibleSelected < expandedBoxes.length} disabled={disabled || !expandedBoxes.length} onChange={async (checked) => {
            await grid.current?.finishEdit();
            if (locked.current) return;
            const ids = new Set(expandedBoxes.map((box) => box.source.boxId));
            setSelected((current) => checked ? [...new Set([...current, ...ids])] : current.filter((value) => !ids.has(value))); setNotice('');
          }} /><span>选择当前可见箱</span></label>
          {selectedBoxes.length > 0 && <><span role="status">已选 {selectedBoxes.length} 箱{selectedBoxes.length > filteredSelected ? `（${selectedBoxes.length - filteredSelected} 箱不在当前筛选中）` : ''}{filteredSelected > visibleSelected ? `（${filteredSelected - visibleSelected} 箱在收起分组中）` : ''}</span><Button type="button" variant="text" disabled={disabled} onClick={async () => { await grid.current?.finishEdit(); if (!locked.current) { setSelected([]); setNotice(''); } }}>清空箱选择</Button></>}
        </div>
      </div>
      {selectedBoxes.length > 0 && <fieldset className="document-box-batch" disabled={disabled}>
        <legend>批量填写 · 已选 {selectedBoxes.length} 箱</legend>
        <p className="mapping-help">只将下方填写的值应用到勾选箱；空白字段保持原值，未选箱保持原值。此处不会保存单据。</p>
        <div className="document-box-batch-fields">{columns.map((field) => <div className="field" key={field}>
          <label htmlFor={`${id}-batch-${field}`}>批量{labels[field]}</label>
          <Input id={`${id}-batch-${field}`} value={batch[field]} disabled={disabled} inputMode={field === 'po' ? 'text' : 'decimal'} maxLength={field === 'po' ? 200 : 100} placeholder="留空保持原值" aria-invalid={batchErrors.includes(field) || undefined} aria-describedby={batchErrors.includes(field) ? `${id}-batch-${field}-error` : undefined} onChange={(event) => { setBatch((current) => ({ ...current, [field]: event.target.value })); setConfirmedOverwrite(''); setNotice(''); }} />
          {batchErrors.includes(field) && <p id={`${id}-batch-${field}-error`} className="form-note error-note">请输入有效正数。</p>}
        </div>)}</div>
        {batchFields.length > 0 && <p id={`${id}-batch-preview`} className="document-box-batch-preview">将应用到 {selectedBoxes.length} 个选中箱：{batchFields.map((field) => `${labels[field]} ${batchValues[field] ?? '待修正'}`).join('；')}。</p>}
        {manualChanges.length > 0 && <label className="document-box-overwrite"><input type="checkbox" checked={confirmedOverwrite === overwriteKey} disabled={disabled || batchErrors.length > 0} onChange={(event) => setConfirmedOverwrite(event.target.checked ? overwriteKey : '')} /><span>确认覆盖上述字段中的 {manualChanges.length} 处已有人工值</span></label>}
        <Button type="button" aria-describedby={batchFields.length ? `${id}-batch-preview` : undefined} disabled={disabled || !batchFields.length || batchErrors.length > 0 || needsOverwriteConfirmation} onClick={applyBatch}>应用到 {selectedBoxes.length} 个选中箱</Button>
      </fieldset>}
      {notice && <p className="form-note success-note" role="status">{notice}</p>}
      {visible.length === 0 && <p className="list-state">{filter === 'missing' ? '所有箱的制单资料均已补齐。' : '当前没有人工修改的箱资料。'}</p>}
      <DocumentDataGrid tableKey="box-adjustments" label="逐箱制单资料" active={active} gridRef={grid} rows={gridRows} columns={gridColumns} preferences={preferences} mandatoryColumnKeys={['fba', 'identity']} beforeColumnChange={async () => { await grid.current?.finishEdit(); }} getRowKey={(row) => row.key} frozenColCount={5} maxHeight={640} isGroupRow={(row) => row.kind === 'group'}
        className="document-box-grid" detailsMode={narrow ? 'inline' : 'dialog'} detailsTitle={(row) => row.kind === 'group' ? row.fba + ' 分组详情' : boxLabel(row.box) + (detailView === 'source' ? ' 自动来源' : ' 制单资料')}
        menuScopeKey={JSON.stringify([filter, collapsedGroups])}
        headerEnd={<div className="document-box-group-controls" role="group" aria-label="FBA 分组展开方式"><Button type="button" variant="text" disabled={!groups.size || [...groups.keys()].every((key) => collapsedGroups.includes(key))} onClick={() => void changeAllGroups(true)}>全部收起</Button><Button type="button" variant="text" disabled={!groups.size || [...groups.keys()].every((key) => !collapsedGroups.includes(key))} onClick={() => void changeAllGroups(false)}>全部展开</Button></div>}
        footerStart={<span className="document-box-grid-count">{groups.size} 个 FBA 分组 · 当前显示 {expandedBoxes.length} / {boxes.length} 箱</span>}
        onPendingEditChange={onPendingEditChange}
        onEditingRowChange={(row) => editRow(row?.kind === 'box' ? row.box.source.boxId : null)}
        onActiveRowChange={(row) => { if (row.kind === 'group' || row.box.source.boxId !== editingBox) setEditingBox(null); }}
        onEdit={(edit, row) => { if (!disabled && row.kind === 'box' && columns.includes(edit.columnKey as DocumentBoxField)) { updateFields({ [documentBoxFieldKey(row.box.source.boxId, edit.columnKey as DocumentBoxField)]: edit.value }); setNotice(''); } }}
        renderRowMenu={(row, context) => {
          if (row.kind === 'group') return <><div className="scm-record-menu-summary"><strong>{row.fba}</strong><p>{row.count} 箱 · {collapsedGroups.includes(row.demandId) ? '已收起' : '已展开'}</p></div><div className="scm-record-menu-actions"><Button type="button" variant="text" role="menuitem" onClick={async () => { context.close(); await changeGroup(row.demandId); }}>{collapsedGroups.includes(row.demandId) ? '展开此分组' : '收起此分组'}</Button><Button type="button" variant="text" role="menuitem" onClick={context.openDetails}>完整详情</Button></div></>;
          const { source, adjusted, missing, adopted } = row.box;
          const showDetails = async (view: 'full' | 'source') => {
            await grid.current?.finishEdit();
            setDetailView(view);
            if (!narrow) { context.openDetails(); return; }
            context.close();
            setOpenSourceKey(view === 'source' ? row.key : null);
            requestAnimationFrame(() => {
              const target = section.current?.querySelector<HTMLElement>(view === 'source' ? '.document-box-automatic > summary' : '.document-box-active');
              target?.focus({ preventScroll: true });
              target?.scrollIntoView({ block: 'nearest' });
            });
          };
          return <><div className="scm-record-menu-summary"><strong>{boxLabel(row.box)}</strong><p>{source.fba} · 第 {source.order} 箱</p><p>{adjusted ? '已修改' : '采用自动值'}{missing ? ' · 待补齐' : ''} · PO {adopted.po || '待补齐'}</p><p>毛重 {adopted.values.weight || '待补齐'} KG · 长 × 宽 × 高 {adopted.values.length || '—'} × {adopted.values.width || '—'} × {adopted.values.height || '—'} CM</p></div><div className="scm-record-menu-actions"><Button type="button" variant="text" role="menuitem" onClick={() => void showDetails('source')}>查看自动来源</Button><Button type="button" variant="text" role="menuitem" icon={RotateCcw} disabled={disabled || !adjusted} onClick={async () => { context.close(); await restore(row.box); }}>恢复自动值</Button><Button type="button" variant="text" role="menuitem" onClick={() => void showDetails('full')}>完整详情</Button></div></>;
        }}
        renderDetails={(row) => {
          if (row.kind === 'group') return <div className="document-box-group-summary"><p>{row.fba} · {row.count} 箱。{collapsedGroups.includes(row.demandId) ? '当前分组已收起。' : '选择箱行可查看来源和编辑资料。'}</p><Button type="button" variant="text" onClick={() => void changeGroup(row.demandId)}>{collapsedGroups.includes(row.demandId) ? '展开此分组' : '收起此分组'}</Button></div>;
          const { source, adopted, adjusted, missing } = row.box, label = boxLabel(row.box);
          const index = expandedBoxes.findIndex((box) => box.source.boxId === source.boxId);
          const move = async (offset: number) => { await grid.current?.finishEdit(); const next = expandedBoxes[index + offset]; if (next) void grid.current?.revealCell(JSON.stringify([next.source.demandId, next.source.boxId]), 'identity'); };
          return <div className="document-box-active" tabIndex={-1} aria-label={label + ' 制单资料'}>
            <div className="document-box-active-heading"><label><TableSelectionCheckbox label={'选择箱 ' + label} checked={selected.includes(source.boxId)} disabled={disabled} onChange={(checked) => toggle(source.boxId, checked)} /><strong>{label}</strong></label><span>{source.fba} · 第 {source.order} 箱 · {adjusted ? '已修改' : '采用自动值'}{missing ? ' · 待补齐' : ''}</span><Button type="button" variant="text" icon={RotateCcw} disabled={disabled || !adjusted} onClick={() => restore(row.box)}>恢复自动值</Button></div>
            {narrow && <><div className="document-box-mobile-pages"><Button type="button" variant="text" disabled={index <= 0} onClick={() => void move(-1)}>上一箱</Button><span>{index + 1} / {expandedBoxes.length} 箱</span><Button type="button" variant="text" disabled={index >= expandedBoxes.length - 1} onClick={() => void move(1)}>下一箱</Button></div><div className="document-box-mobile-fields">{columns.map((field) => {
              const key = documentBoxFieldKey(source.boxId, field), manual = fields[key] !== undefined && fields[key] !== null;
              const automatic = field === 'po' ? source.po : source.values[field], value = manual ? fields[key]! : automatic ?? '';
              const adoptedValue = field === 'po' ? adopted.po : adopted.values[field], inputId = id + '-' + source.boxId + '-' + field;
              return <div className="field" key={field}><label htmlFor={inputId}>{labels[field]}</label><Input id={inputId} data-document-field={key} aria-label={label + ' ' + labels[field]} aria-invalid={!adoptedValue || undefined} value={value} disabled={disabled} inputMode={field === 'po' ? 'text' : 'decimal'} maxLength={field === 'po' ? 200 : 100} onFocus={() => editRow(source.boxId)} onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.closest('.document-box-active')?.contains(event.relatedTarget)) editRow(null); }} onChange={(event) => { if (!disabled) updateFields({ [key]: event.target.value }); }} /><p className={'document-box-value-help' + (!adoptedValue ? ' error-note' : '')}>{!adoptedValue ? field === 'po' ? '请填写 PO / Reference ID。' : '请输入有效正数。' : manual ? '本票人工采用：' + adoptedValue : '采用自动值'}</p></div>;
            })}</div></>}
            {!narrow && detailView === 'full' && <dl className="document-box-active-values">{columns.map((field) => { const value = field === 'po' ? adopted.po : adopted.values[field]; return <div key={field}><dt>{labels[field]}</dt><dd className={!value ? 'error-note' : undefined}>{value || '待补齐'}</dd></div>; })}</dl>}
            <details className="document-box-automatic" open={narrow ? openSourceKey === row.key : detailView === 'source'} onToggle={(event) => { if (narrow && event.currentTarget.open !== (openSourceKey === row.key)) setOpenSourceKey(event.currentTarget.open ? row.key : null); }}><summary>{label} 自动来源</summary><p>原始来源登记：PO {source.po || '缺失'}；毛重 {source.raw.weight ?? '缺失'} {source.raw.weightUnit || '单位缺失'}；长 × 宽 × 高 {source.raw.length ?? '缺失'} × {source.raw.width ?? '缺失'} × {source.raw.height ?? '缺失'} {source.raw.dimensionUnit || '单位缺失'}。</p><p>自动采用：PO {source.po || '缺失'}；毛重 {source.values.weight ?? '缺失'} KG；长 × 宽 × 高 {source.values.length ?? '缺失'} × {source.values.width ?? '缺失'} × {source.values.height ?? '缺失'} CM。来源时间 {timestamp(source.sourceObservedAt)}</p></details>
          </div>;
        }} />
    </>}
  </section>;
}
