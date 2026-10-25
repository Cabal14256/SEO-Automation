import { useEffect, useId, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { DOCUMENT_BOX_FIELDS, documentBoxFieldKey, documentBoxes, documentBoxSources, documentBoxValue, type DocumentBoxField, type DocumentRevisionData } from '@scm/contracts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { TableSelectionCheckbox, timestamp } from './batch-shared';
import { scrollDocumentFieldIntoView } from './document-details-navigation';
import './document-boxes.css';

const labels = { po: 'PO / Reference ID', weight: '毛重（KG）', length: '长（CM）', width: '宽（CM）', height: '高（CM）' };
const columns = ['po', 'weight', 'length', 'width', 'height'] as const;
const emptyBatch = { po: '', weight: '', length: '', width: '', height: '' };
type BoxFilter = 'all' | 'missing' | 'adjusted';
const normalized = (field: DocumentBoxField, value: string): string | null => field === 'po'
  ? value.trim() || null
  : documentBoxValue(value, field === 'weight' ? 'KG' : 'CM', field === 'weight' ? 'weight' : 'dimension');

export function DocumentBoxAdjustments({ members, fields, disabled, updateFields, sectionId, revealRequest }: {
  members: DocumentRevisionData['members'];
  fields: Record<string, string | null>;
  disabled: boolean;
  updateFields: (changes: Record<string, string | null>) => void;
  sectionId?: string;
  revealRequest?: { field: string; requestId: number };
}) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const completedReveal = useRef('');
  const [filter, setFilter] = useState<BoxFilter>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState(emptyBatch);
  const [confirmedOverwrite, setConfirmedOverwrite] = useState('');
  const [notice, setNotice] = useState('');
  const [editingBox, setEditingBox] = useState<string | null>(null);
  useEffect(() => {
    if (!revealRequest || !/^box\.[^.]+\.(?:po|weight|length|width|height)$/.test(revealRequest.field)) return;
    setFilter('all'); setEditingBox(null);
  }, [revealRequest?.field, revealRequest?.requestId]);
  useEffect(() => {
    if (filter !== 'all' || !revealRequest || !/^box\.[^.]+\.(?:po|weight|length|width|height)$/.test(revealRequest.field)) return;
    const requestKey = JSON.stringify([revealRequest.field, revealRequest.requestId]);
    if (completedReveal.current === requestKey) return;
    // Wait for the "all" filter's committed DOM before looking for a hidden box.
    const frame = requestAnimationFrame(() => {
      const input = [...section.current?.querySelectorAll<HTMLInputElement>('input[data-document-field]') ?? []]
        .find((element) => element.dataset.documentField === revealRequest.field);
      if (!input || input.matches(':disabled')) return;
      input.focus({ preventScroll: true }); scrollDocumentFieldIntoView(input);
      completedReveal.current = requestKey;
    });
    return () => cancelAnimationFrame(frame);
  }, [filter, revealRequest?.field, revealRequest?.requestId]);
  const boxes = members.flatMap((member) => {
    const adopted = new Map(documentBoxes(member, fields).map((box) => [box.boxId, box]));
    return documentBoxSources(member).map((source) => {
      const box = adopted.get(source.boxId)!;
      const adjusted = DOCUMENT_BOX_FIELDS.some((field) => fields[documentBoxFieldKey(source.boxId, field)] !== undefined && fields[documentBoxFieldKey(source.boxId, field)] !== null);
      return { source, adopted: box, adjusted, missing: !box.po || Object.values(box.values).some((value) => !value) };
    });
  });
  // Completing the last missing field must not remove its input mid-keystroke.
  const visible = boxes.filter((box) => box.source.boxId === editingBox || filter === 'all' || (filter === 'missing' ? box.missing : box.adjusted));
  const groups = new Map<string, typeof boxes>();
  for (const box of visible) {
    const group = groups.get(box.source.fba);
    if (group) group.push(box); else groups.set(box.source.fba, [box]);
  }
  const selectedBoxes = boxes.filter((box) => selected.includes(box.source.boxId));
  const visibleSelected = visible.filter((box) => selected.includes(box.source.boxId)).length;
  const batchFields = columns.filter((field) => batch[field].trim() !== '');
  const batchErrors = batchFields.filter((field) => normalized(field, batch[field]) === null);
  const batchValues = Object.fromEntries(batchFields.map((field) => [field, normalized(field, batch[field])])) as Partial<Record<DocumentBoxField, string | null>>;
  const manualChanges = selectedBoxes.flatMap(({ source }) => batchFields.flatMap((field) => {
    const value = fields[documentBoxFieldKey(source.boxId, field)];
    return value !== undefined && value !== null && normalized(field, value) !== batchValues[field] ? [[source.boxId, field, value]] : [];
  }));
  const overwriteKey = JSON.stringify([selectedBoxes.map((box) => box.source.boxId), batchValues, manualChanges]);
  const needsOverwriteConfirmation = manualChanges.length > 0 && confirmedOverwrite !== overwriteKey;
  const toggle = (boxId: string, checked: boolean) => {
    if (disabled) return;
    setSelected((current) => checked ? [...new Set([...current, boxId])] : current.filter((value) => value !== boxId)); setNotice('');
  };
  const applyBatch = () => {
    if (disabled || !selectedBoxes.length || !batchFields.length || batchErrors.length || needsOverwriteConfirmation) return;
    updateFields(Object.fromEntries(selectedBoxes.flatMap(({ source }) => batchFields.map((field) => [documentBoxFieldKey(source.boxId, field), batchValues[field]!] as const))));
    setNotice(`已将${batchFields.map((field) => labels[field]).join('、')}应用到 ${selectedBoxes.length} 个选中箱。请保存资料修订。`);
    setBatch(emptyBatch); setConfirmedOverwrite('');
  };
  return <section ref={section} id={sectionId} tabIndex={-1} className="document-field-group document-box-adjustments" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><h3 id={`${id}-title`}>逐箱制单资料</h3><span>{boxes.length} 箱 · KG / CM</span></div>
    <p className="mapping-help">按 FBA 核对本票 PO、毛重和长宽高；自动来源保留供核对。修改及恢复自动值都需保存资料修订。</p>
    {boxes.length === 0 ? <p className="form-note error-note" role="alert">当前来源没有可用箱明细，请在“货件与来源”中核对来源及箱码。</p> : <>
      <div className="document-box-toolbar">
        <div className="document-box-filters" role="group" aria-label="箱资料筛选">{([
          ['all', '全部', boxes.length], ['missing', '待补齐', boxes.filter((box) => box.missing).length], ['adjusted', '已修改', boxes.filter((box) => box.adjusted).length],
        ] as const).map(([value, label, count]) => <Button key={value} type="button" variant="text" aria-pressed={filter === value} onClick={() => { setEditingBox(null); setFilter(value); }}>{label} · {count} 箱</Button>)}</div>
        <div className="document-box-selection">
          <label><TableSelectionCheckbox label="选择当前可见箱" checked={visible.length > 0 && visibleSelected === visible.length} indeterminate={visibleSelected > 0 && visibleSelected < visible.length} disabled={disabled || !visible.length} onChange={(checked) => {
            if (disabled) return;
            const ids = new Set(visible.map((box) => box.source.boxId));
            setSelected((current) => checked ? [...new Set([...current, ...ids])] : current.filter((value) => !ids.has(value))); setNotice('');
          }} /><span>选择当前可见箱</span></label>
          {selectedBoxes.length > 0 && <><span role="status">已选 {selectedBoxes.length} 箱{selectedBoxes.length > visibleSelected ? `（${selectedBoxes.length - visibleSelected} 箱不在当前筛选中）` : ''}</span><Button type="button" variant="text" disabled={disabled} onClick={() => { setSelected([]); setNotice(''); }}>清空箱选择</Button></>}
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
      {[...groups].map(([fba, group]) => <section className="document-box-fba-group" key={fba} aria-label={`${fba} 箱资料`}>
        <div className="document-box-fba-heading"><h4>{fba}</h4><span>{group.length} 箱{filter !== 'all' ? '符合当前筛选' : ''}</span></div>
        <div className="document-box-table-scroll" role="region" aria-label={`${fba} 逐箱制单资料，可横向滚动`} tabIndex={0}>
          <table className="document-box-table" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">货箱 / 状态</th>{columns.map((field) => <th key={field} scope="col" role="columnheader">{labels[field]}</th>)}<th scope="col" role="columnheader">操作</th></tr></thead>
            {group.map(({ source, adopted, adjusted, missing }) => {
              const boxLabel = source.code || `${source.fba} 第 ${source.order} 箱`;
              return <tbody key={`${source.demandId}-${source.boxId}`} role="rowgroup" aria-label={`箱 ${boxLabel} 制单资料`}>
                <tr className="document-box-edit-row" role="row">
                  <th scope="row" role="rowheader" className="document-box-identity"><label><TableSelectionCheckbox label={`选择箱 ${boxLabel}`} checked={selected.includes(source.boxId)} disabled={disabled} onChange={(checked) => toggle(source.boxId, checked)} /><strong>{boxLabel}</strong></label><span>第 {source.order} 箱 · {adjusted ? '已修改' : '采用自动值'}{missing ? ' · 待补齐' : ''}</span></th>
                  {columns.map((field) => {
                    const key = documentBoxFieldKey(source.boxId, field), manual = fields[key] !== undefined && fields[key] !== null;
                    const automatic = field === 'po' ? source.po : source.values[field];
                    const value = manual ? fields[key]! : automatic ?? '', adoptedValue = field === 'po' ? adopted.po : adopted.values[field];
                    const invalid = !adoptedValue, inputId = `${id}-${source.boxId}-${field}`;
                    return <td key={field} role="cell" data-document-field={key} className={`document-box-value-cell document-box-value-${field}`}>
                      <label className="document-box-mobile-label" htmlFor={inputId}>{labels[field]}</label>
                      <Input id={inputId} data-document-field={key} aria-label={`${boxLabel} ${labels[field]}`} aria-describedby={`${inputId}-help`} aria-invalid={invalid || undefined} inputMode={field === 'po' ? 'text' : 'decimal'} maxLength={field === 'po' ? 200 : 100} value={value} disabled={disabled} onFocus={() => setEditingBox(source.boxId)} onBlur={(event) => {
                        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.closest('tbody')?.contains(event.relatedTarget)) setEditingBox(null);
                      }} onChange={(event) => { if (!disabled) { updateFields({ [key]: event.target.value }); setNotice(''); } }} />
                      <p id={`${inputId}-help`} className={`document-box-value-help${invalid ? ' error-note' : ''}`}>{invalid ? field === 'po' ? '请填写 PO / Reference ID。' : '请输入有效正数。' : manual ? `本票人工采用${field !== 'po' ? `：${adoptedValue}` : ''}` : '采用自动值'}</p>
                    </td>;
                  })}
                  <td className="document-box-row-actions" role="cell"><Button type="button" variant="text" icon={RotateCcw} disabled={disabled || !adjusted} onClick={() => {
                    if (!disabled) { updateFields(Object.fromEntries(DOCUMENT_BOX_FIELDS.map((field) => [documentBoxFieldKey(source.boxId, field), null]))); setNotice(''); }
                  }}>恢复自动值</Button></td>
                </tr>
                <tr className="document-box-source-row" role="row"><td colSpan={7} role="cell"><details className="document-box-automatic"><summary>{boxLabel} 自动来源</summary>
                  <p>原始来源登记：PO {source.po || '缺失'}；毛重 {source.raw.weight ?? '缺失'} {source.raw.weightUnit || '单位缺失'}；长 × 宽 × 高 {source.raw.length ?? '缺失'} × {source.raw.width ?? '缺失'} × {source.raw.height ?? '缺失'} {source.raw.dimensionUnit || '单位缺失'}。</p>
                  <p>自动采用：PO {source.po || '缺失'}；毛重 {source.values.weight ?? '缺失'} KG；长 × 宽 × 高 {source.values.length ?? '缺失'} × {source.values.width ?? '缺失'} × {source.values.height ?? '缺失'} CM。来源时间 {timestamp(source.sourceObservedAt)}</p>
                </details></td></tr>
              </tbody>;
            })}
          </table>
        </div>
      </section>)}
    </>}
  </section>;
}
