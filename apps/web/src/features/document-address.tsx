import { useEffect, useId, useRef, useState } from 'react';
import { DOCUMENT_ADDRESS_FIELDS, DOCUMENT_ADDRESS_REQUIRED_FIELDS, applyDocumentAddress, documentAddressDifferences, hasCompleteDocumentAddress, type DocumentRevisionData } from '@scm/contracts';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Combobox } from '../components/ui/combobox';
import { Input } from '../components/ui/input';
import { Check } from './batch-shared';
import './document-address.css';

export const addressLabels: Record<string, string> = { addressCode: '地址代码', destinationFc: '领星目的仓', recipientName: '收件人', recipientCompany: '收件公司', addressLine1: '地址第 1 行', addressLine2: '地址第 2 行', addressLine3: '地址第 3 行', city: '城市', state: '州 / 省', postalCode: '邮编', countryCode: '国家代码', phone: '电话', email: '邮箱' };
const sourceLabels: Record<string, string> = { listShipments: '货件列表', getShipmentDetails: '货件详情' };
type AddressReference = DocumentRevisionData['profileReferences'][number];
type AddressChoice = { value: string; label: string; data: Record<string, unknown> };
type Props = {
  sectionId?: string;
  documentId: string;
  members: DocumentRevisionData['members'];
  fields: Record<string, string | null>;
  reference: AddressReference | null;
  disabled: boolean;
  conflict: boolean;
  adopt: (fields: Record<string, string | null>, reference: AddressReference | null) => void;
  edit: (key: string, value: string) => void;
  confirm: (checked: boolean) => void;
  reason: (value: string) => void;
};

export function DocumentAddressSection({ sectionId, documentId, members, fields, reference, disabled, conflict, adopt, edit, confirm, reason }: Props) {
  const id = useId();
  const [selected, setSelected] = useState('manual');
  const [notice, setNotice] = useState('');
  // Explicit editing stays open as fields change. Switching documents starts from that document's status.
  const [editorState, setEditorState] = useState({ documentId, open: false });
  const selectionTouched = useRef(false);
  const choices: AddressChoice[] = [
    { value: 'manual', label: '保留当前地址 / 本票核对补充', data: fields },
    ...members.flatMap((member) => (member.sourceCandidates?.addresses ?? []).filter((candidate) => Object.hasOwn(sourceLabels, candidate.source)).map((candidate, index) => ({ value: `source:${member.source.demandId}:${index}`, label: `领星 · ${member.demand.snapshot.fba} · ${sourceLabels[candidate.source]}${hasCompleteDocumentAddress(candidate.data) ? '' : ' · 待补全'}`, data: candidate.data }))),
  ];
  const choice = choices.find((item) => item.value === selected);
  const complete = hasCompleteDocumentAddress(fields);
  const previewComplete = Boolean(choice && hasCompleteDocumentAddress(choice.data));
  const previewMissing = choice ? DOCUMENT_ADDRESS_REQUIRED_FIELDS.filter((key) => !String(choice.data[key] ?? '').trim()).map((key) => addressLabels[key]) : [];
  if (choice && choice.data.countryCode && !/^[A-Z]{2}$/i.test(String(choice.data.countryCode).trim())) previewMissing.push('有效的两字母国家代码');
  const differences = choice ? documentAddressDifferences(fields, choice.data) : [];
  const referenceDifferences = reference ? documentAddressDifferences(fields, reference.data) : [];
  const confirmed = fields.addressConfirmed === 'true';
  const requiresReview = !complete || !confirmed || conflict || referenceDifferences.length > 0;
  const editorOpen = requiresReview || editorState.documentId === documentId && editorState.open;
  const currentSource = reference ? `历史地址快照 · v${reference.version}` : fields.addressSourceLabel || '本票核对补充';
  const confirmationLabel = !complete ? '待补全' : conflict ? '需处理来源冲突' : referenceDifferences.length ? '待核对引用差异' : confirmed ? '已确认' : '待核对确认';
  const addressLines = [
    [fields.recipientName, fields.recipientCompany].filter((value) => value?.trim()).join(' · '),
    fields.addressLine1, fields.addressLine2, fields.addressLine3,
    [fields.city, fields.state, fields.postalCode].filter((value) => value?.trim()).join(', '),
    fields.countryCode?.trim().toUpperCase(),
  ].filter((value): value is string => Boolean(value?.trim()));
  const missingFields = DOCUMENT_ADDRESS_REQUIRED_FIELDS.filter((key) => !fields[key]?.trim()).map((key) => addressLabels[key]);
  if (fields.countryCode?.trim() && !/^[A-Z]{2}$/i.test(fields.countryCode.trim())) missingFields.push('有效的两字母国家代码');
  const suggested = fields.addressSelectionMode !== 'manual' && choices.length === 2 ? choices[1]!.value : 'manual';
  useEffect(() => {
    if (selectionTouched.current) return;
    setSelected(suggested);
  }, [suggested]);
  return <section id={sectionId} tabIndex={-1} className="document-field-group document-address-section" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><h3 id={`${id}-title`}>收件地址</h3></div>
    <div className="document-address-summary" aria-label="本票最终地址">
      <div className="document-address-summary-content"><h4>本票最终地址</h4><address>{addressLines.length ? addressLines.map((line, index) => <span key={index}>{line}</span>) : <span className="mapping-help">尚未填写最终地址</span>}</address>
        {(fields.phone?.trim() || fields.email?.trim() || fields.addressCode?.trim()) && <p className="document-address-summary-contact">{fields.addressCode?.trim() && <span>地址代码：{fields.addressCode}</span>}{fields.phone?.trim() && <span>电话：{fields.phone}</span>}{fields.email?.trim() && <span>邮箱：{fields.email}</span>}</p>}
      </div>
      <div className="document-address-summary-meta"><span className="document-address-confirmation-status" data-confirmed={!requiresReview} role="status" aria-label="地址确认状态">{confirmationLabel}</span><p>当前采用：{currentSource}</p>{fields.addressCodeReason?.trim() && <p>B3 编码依据：{fields.addressCodeReason}</p>}{fields.addressConfirmationReason?.trim() && <p>核对依据：{fields.addressConfirmationReason}</p>}{missingFields.length > 0 && <p className="document-address-summary-warning">待补全：{missingFields.join('、')}</p>}{referenceDifferences.length > 0 && <p className="document-address-summary-warning">表单与引用地址存在差异，请重新采用或明确核对。</p>}</div>
    </div>
    <details className="document-address-editor" data-section-editor="address" open={editorOpen} onToggle={(event) => {
      if (!event.currentTarget.open && requiresReview) { event.currentTarget.open = true; return; }
      setEditorState({ documentId, open: event.currentTarget.open });
    }}>
      <summary aria-label="修改地址 / 更换来源"><ChevronRight size={16} aria-hidden="true" /><span>修改地址 / 更换来源</span>{requiresReview && <small aria-hidden="true">请补齐并确认后收起</small>}</summary>
      <div className="document-address-editor-body">
    <p className="mapping-help">收件地址以领星货件资料为准。选择来源并点击“采用地址”整份填写；缺失内容可在本票补充，修改后请重新核对并确认。</p>
    <div className="document-address-picker"><div className="field"><label htmlFor={`${id}-source`}>地址来源</label><Combobox id={`${id}-source`} value={selected} options={choices.map((item) => ({ value: item.value, label: item.label }))} disabled={disabled} onValueChange={(value) => { selectionTouched.current = true; setSelected(value); setNotice(''); }} searchPlaceholder="搜索领星货件地址…" placeholder="选择地址来源" /></div><Button type="button" icon={ArrowRight} disabled={disabled || !choice} onClick={() => {
      if (!choice) return;
      selectionTouched.current = true;
      adopt({ ...applyDocumentAddress(fields, choice.data), addressSourceLabel: choice.label, addressSelectionMode: selected === 'manual' ? 'manual' : 'lingxing' }, null);
      setNotice(selected === 'manual' ? '已保留本票地址，请核对下方内容并重新确认。' : '领星地址已填入下方表单，请补齐缺失内容并核对确认。');
    }}>采用地址</Button></div>
    {choice && selected !== 'manual' && <div className="document-address-preview"><h4>领星地址预览</h4><dl>{DOCUMENT_ADDRESS_FIELDS.filter((key) => choice.data[key]).map((key) => <div key={key}><dt>{addressLabels[key]}</dt><dd>{String(choice.data[key])}</dd></div>)}</dl>{!previewComplete ? <p className="form-note error-note">此来源缺少{previewMissing.join('、')}，采用后请在下方补齐并确认。</p> : <p className="mapping-help">{differences.length ? `采用后将替换：${differences.map((key) => addressLabels[key]).join('、')}。来源中未提供的可选字段会留空。` : '来源内容与当前表单一致。采用后仍需重新确认。'}</p>}</div>}
    {choices.length === 1 && <p className="form-note">当前货件尚无领星地址，请先查询并采用领星资料，或核对后补充本票地址。</p>}
    {notice && <p className="form-note" role="status">{notice}</p>}
    <div className="document-form-grid">{DOCUMENT_ADDRESS_FIELDS.map((key) => <div className="field" key={key} data-document-field={key}><label htmlFor={`${id}-${key}`}>{addressLabels[key]}</label><Input id={`${id}-${key}`} value={fields[key] || ''} maxLength={4000} disabled={disabled} aria-describedby={key === 'addressCode' ? `${id}-address-code-help` : undefined} onChange={(event) => { selectionTouched.current = true; setSelected('manual'); setNotice('地址已修改，请重新填写核对依据并确认。'); edit(key, event.target.value); }} />{key === 'addressCode' && <p id={`${id}-address-code-help`} className="mapping-help">B3 通常采用领星目的仓代码。特殊编码或同仓多地址须核对货代参考库；人工填写后请重新确认本票地址。</p>}</div>)}</div>
    <div className="document-address-confirmation"><div className="field" data-document-field="addressConfirmationReason"><label htmlFor={`${id}-reason`}>地址核对 / 冲突处理原因</label><Input id={`${id}-reason`} value={fields.addressConfirmationReason || ''} maxLength={4000} disabled={disabled} placeholder="填写核对依据，例如：已核对领星货件及本票目的仓" onChange={(event) => reason(event.target.value)} /></div><div data-document-field="addressConfirmed"><Check checked={fields.addressConfirmed === 'true'} disabled={disabled || !complete || !fields.addressConfirmationReason?.trim()} onChange={confirm}>已核对并确认本票采用的完整收件地址</Check></div>{!complete && <p className="mapping-help">补齐收件人、地址第 1 行、城市、邮编及两字母国家代码后可确认。</p>}{conflict && <p className="form-note error-note">领星来源中有不同的非空地址。请核对本票最终地址，并在上方记录采用依据。</p>}</div>
    {members.some((member) => member.sourceCandidates?.addresses.length) && <details className="document-field-group document-address-evidence"><summary>原始来源地址（仅供核对）</summary><p className="mapping-help">原始货件快照保留用于追溯。采用地址统一在上方完成。</p>{members.flatMap((member) => (member.sourceCandidates?.addresses ?? []).map((candidate, index) => <div className="document-address-source" key={`${member.source.demandId}-${index}`}><h4>{member.demand.snapshot.fba} · {sourceLabels[candidate.source] || candidate.source}</h4><p>{Object.entries(candidate.data).filter(([, value]) => value).map(([key, value]) => `${addressLabels[key] || key}：${value}`).join('；')}</p></div>))}</details>}
      </div>
    </details>
  </section>;
}
