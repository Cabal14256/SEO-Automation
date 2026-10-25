import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DOCUMENT_ADDRESS_FIELDS, DOCUMENT_ADDRESS_REQUIRED_FIELDS, applyDocumentAddress, documentAddressDifferences, documentMemberAddressCode, hasCompleteDocumentAddress, matchDocumentAddressProfiles, type DocumentProfile, type DocumentRevisionData } from '@scm/contracts';
import { ArrowRight, BookOpen, ChevronRight, Save } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Combobox } from '../components/ui/combobox';
import { Input } from '../components/ui/input';
import { Check, newOperation, QueryError } from './batch-shared';
import './document-address.css';

export const addressLabels: Record<string, string> = { addressCode: '地址代码', recipientName: '收件人', recipientCompany: '收件公司', addressLine1: '地址第 1 行', addressLine2: '地址第 2 行', addressLine3: '地址第 3 行', city: '城市', state: '州 / 省', postalCode: '邮编', countryCode: '国家代码', phone: '电话', email: '邮箱' };
const sourceLabels: Record<string, string> = { listShipments: '货件列表', getShipmentDetails: '货件详情' };
type AddressReference = DocumentRevisionData['profileReferences'][number];
type AddressChoice = { value: string; label: string; data: Record<string, unknown>; profile: AddressReference | null };
type Props = {
  sectionId?: string;
  documentId: string;
  members: DocumentRevisionData['members'];
  fields: Record<string, string | null>;
  reference: AddressReference | null;
  profiles: DocumentProfile[];
  loading: boolean;
  error?: unknown;
  retry: () => void;
  disabled: boolean;
  dirty: boolean;
  conflict: boolean;
  adopt: (fields: Record<string, string | null>, reference: AddressReference | null) => void;
  edit: (key: string, value: string) => void;
  confirm: (checked: boolean) => void;
  reason: (value: string) => void;
};

export function DocumentAddressSection({ sectionId, documentId, members, fields, reference, profiles, loading, error, retry, disabled, dirty, conflict, adopt, edit, confirm, reason }: Props) {
  const id = useId();
  const navigate = useNavigate();
  const [selected, setSelected] = useState('manual');
  const [notice, setNotice] = useState('');
  // Explicit editing stays open as fields change. Switching documents starts from that document's status.
  const [editorState, setEditorState] = useState({ documentId, open: false });
  const selectionTouched = useRef(false);
  const automaticallyFilled = useRef(false);
  const matches = matchDocumentAddressProfiles(members, profiles);
  const hasExistingAddress = DOCUMENT_ADDRESS_FIELDS.some((key) => !['addressCode', 'countryCode'].includes(key) && Boolean(fields[key]?.trim()));
  useEffect(() => {
    if (automaticallyFilled.current || selectionTouched.current || disabled || loading || error || reference || hasExistingAddress || fields.addressSelectionMode === 'manual' || fields.addressConfirmed === 'true' || matches.length !== 1) return;
    const profile = matches[0]!;
    automaticallyFilled.current = true;
    setSelected(`profile:${profile.id}`);
    adopt({ ...applyDocumentAddress(fields, profile.data), addressSelectionMode: 'profile', addressSourceLabel: `地址簿 · ${profile.key} · v${profile.version}` }, { category: profile.category, profileId: profile.id, version: profile.version, data: profile.data });
    setNotice(`已按 FBA 地址代码 ${documentMemberAddressCode(members[0]!) ?? ''} 自动填写地址簿详情，请核对后确认。`);
  }, [disabled, loading, error, reference, hasExistingAddress, fields, matches, members, adopt]);
  const choices: AddressChoice[] = [
    { value: 'manual', label: '保留当前地址 / 手工核对', data: fields, profile: null },
    ...matches.map((profile) => ({ value: `profile:${profile.id}`, label: `地址簿 · ${profile.key} · v${profile.version}`, data: profile.data, profile: { category: profile.category, profileId: profile.id, version: profile.version, data: profile.data } })),
    ...members.flatMap((member) => (member.sourceCandidates?.addresses ?? []).map((candidate, index) => ({ value: `source:${member.source.demandId}:${index}`, label: `来源 · ${member.demand.snapshot.fba} · ${sourceLabels[candidate.source] || candidate.source}${hasCompleteDocumentAddress(candidate.data) ? '' : ' · 待补全'}`, data: candidate.data, profile: null }))),
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
  const currentSource = reference ? `地址簿 · ${profiles.find((profile) => profile.id === reference.profileId)?.key || '已保存地址'} · v${reference.version}` : fields.addressSourceLabel || '本票手工地址';
  const confirmationLabel = !complete ? '待补全' : conflict ? '需处理来源冲突' : referenceDifferences.length ? '待核对引用差异' : confirmed ? '已确认' : '待核对确认';
  const addressLines = [
    [fields.recipientName, fields.recipientCompany].filter((value) => value?.trim()).join(' · '),
    fields.addressLine1, fields.addressLine2, fields.addressLine3,
    [fields.city, fields.state, fields.postalCode].filter((value) => value?.trim()).join(', '),
    fields.countryCode?.trim().toUpperCase(),
  ].filter((value): value is string => Boolean(value?.trim()));
  const missingFields = DOCUMENT_ADDRESS_REQUIRED_FIELDS.filter((key) => !fields[key]?.trim()).map((key) => addressLabels[key]);
  if (fields.countryCode?.trim() && !/^[A-Z]{2}$/i.test(fields.countryCode.trim())) missingFields.push('有效的两字母国家代码');
  const suggested = fields.addressSelectionMode === 'manual' ? 'manual' : reference && matches.some((profile) => profile.id === reference.profileId) ? `profile:${reference.profileId}` : matches.length === 1 ? `profile:${matches[0]!.id}` : 'manual';
  useEffect(() => {
    if (selectionTouched.current || loading) return;
    setSelected(suggested);
  }, [loading, suggested]);
  const openAddressBook = (data: Record<string, unknown>) => {
    const destinationFc = members[0]?.demand.snapshot.destinationFc || '';
    const addressData = Object.fromEntries(DOCUMENT_ADDRESS_FIELDS.map((key) => [key, typeof data[key] === 'string' ? data[key] : '']));
    try {
      const draftId = newOperation();
      sessionStorage.setItem(`scm:address-draft:${draftId}`, JSON.stringify({ key: `${destinationFc} ${addressData.countryCode || ''}`.trim(), data: { ...addressData, destinationFc }, reason: '从本票地址补充地址簿' }));
      void navigate({ to: '/settings/addresses', search: { documentId, draftId } });
    } catch { setNotice('无法保存地址草稿，请进入设置 → 收件地址手动新增。'); }
  };
  return <section id={sectionId} tabIndex={-1} className="document-field-group document-address-section" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><h3 id={`${id}-title`}>收件地址</h3><Button type="button" variant="text" icon={BookOpen} disabled={dirty} onClick={() => void navigate({ to: '/settings/addresses', search: { documentId } })}>管理地址簿</Button></div>
    {Boolean(error) && <QueryError error={error} retry={retry} />}
    <div className="document-address-summary" aria-label="本票最终地址">
      <div className="document-address-summary-content"><h4>本票最终地址</h4><address>{addressLines.length ? addressLines.map((line, index) => <span key={index}>{line}</span>) : <span className="mapping-help">尚未填写最终地址</span>}</address>
        {(fields.phone?.trim() || fields.email?.trim() || fields.addressCode?.trim()) && <p className="document-address-summary-contact">{fields.addressCode?.trim() && <span>地址代码：{fields.addressCode}</span>}{fields.phone?.trim() && <span>电话：{fields.phone}</span>}{fields.email?.trim() && <span>邮箱：{fields.email}</span>}</p>}
      </div>
      <div className="document-address-summary-meta"><span className="document-address-confirmation-status" data-confirmed={!requiresReview} role="status" aria-label="地址确认状态">{confirmationLabel}</span><p>当前采用：{currentSource}</p>{fields.addressConfirmationReason?.trim() && <p>核对依据：{fields.addressConfirmationReason}</p>}{missingFields.length > 0 && <p className="document-address-summary-warning">待补全：{missingFields.join('、')}</p>}{referenceDifferences.length > 0 && <p className="document-address-summary-warning">表单与引用地址存在差异，请重新采用或明确核对。</p>}</div>
    </div>
    <details className="document-address-editor" data-section-editor="address" open={editorOpen} onToggle={(event) => {
      if (!event.currentTarget.open && requiresReview) { event.currentTarget.open = true; return; }
      setEditorState({ documentId, open: event.currentTarget.open });
    }}>
      <summary aria-label="修改地址 / 更换来源"><ChevronRight size={16} aria-hidden="true" /><span>修改地址 / 更换来源</span>{requiresReview && <small aria-hidden="true">请补齐并确认后收起</small>}</summary>
      <div className="document-address-editor-body">
    <p className="mapping-help">下方表单是本票最终收件地址。选择来源并预览后，点击“采用地址”整份替换；修改后请重新核对并确认。</p>
    <div className="document-address-picker"><div className="field"><label htmlFor={`${id}-source`}>地址来源</label><Combobox id={`${id}-source`} value={selected} options={choices.map((item) => ({ value: item.value, label: item.label }))} disabled={disabled || loading} onValueChange={(value) => { selectionTouched.current = true; setSelected(value); setNotice(''); }} searchPlaceholder="搜索地址簿或货件来源…" placeholder={loading ? '正在读取地址簿…' : '选择地址来源'} /></div><Button type="button" icon={ArrowRight} disabled={disabled || loading || !choice || selected !== 'manual' && !previewComplete} onClick={() => {
      if (!choice) return;
      selectionTouched.current = true;
      adopt({ ...applyDocumentAddress(fields, choice.data), addressSourceLabel: choice.label, addressSelectionMode: choice.profile ? 'profile' : 'manual' }, choice.profile);
      setNotice(selected === 'manual' ? '已切换为本票手工地址，请核对下方内容并重新确认。' : '地址已整份填入下方表单，请核对最终内容并重新确认。');
    }}>采用地址</Button></div>
    {choice && selected !== 'manual' && <div className="document-address-preview"><h4>候选地址预览</h4><dl>{DOCUMENT_ADDRESS_FIELDS.filter((key) => choice.data[key]).map((key) => <div key={key}><dt>{addressLabels[key]}</dt><dd>{String(choice.data[key])}</dd></div>)}</dl>{!previewComplete ? <><p className="form-note error-note">此来源缺少{previewMissing.join('、')}，补全前无法采用。</p><Button type="button" icon={BookOpen} disabled={disabled || dirty} onClick={() => openAddressBook(choice.data)}>在地址簿补全</Button></> : <p className="mapping-help">{differences.length ? `采用后将替换：${differences.map((key) => addressLabels[key]).join('、')}。候选中未提供的可选字段会留空。` : '候选内容与当前表单一致。采用后仍需重新确认。'}</p>}</div>}
    {!loading && matches.length === 0 && <p className="form-note">FBA 地址代码及国家没有匹配的有效地址簿记录，可在设置中新增，或填写并确认本票地址。</p>}
    {matches.length > 1 && <p className="form-note">匹配到 {matches.length} 份地址，请在地址来源中明确选择一份。</p>}
    {notice && <p className="form-note" role="status">{notice}</p>}
    <div className="document-form-grid">{DOCUMENT_ADDRESS_FIELDS.map((key) => <div className="field" key={key} data-document-field={key}><label htmlFor={`${id}-${key}`}>{addressLabels[key]}</label><Input id={`${id}-${key}`} value={fields[key] || ''} maxLength={4000} disabled={disabled} onChange={(event) => { selectionTouched.current = true; setSelected('manual'); setNotice('地址已修改，请重新填写核对依据并确认。'); edit(key, event.target.value); }} /></div>)}</div>
    <div className="document-address-confirmation"><div className="field" data-document-field="addressConfirmationReason"><label htmlFor={`${id}-reason`}>地址核对 / 冲突处理原因</label><Input id={`${id}-reason`} value={fields.addressConfirmationReason || ''} maxLength={4000} disabled={disabled} placeholder="填写核对依据，例如：已核对地址簿及本票目的仓" onChange={(event) => reason(event.target.value)} /></div><div data-document-field="addressConfirmed"><Check checked={fields.addressConfirmed === 'true'} disabled={disabled || !complete || !fields.addressConfirmationReason?.trim()} onChange={confirm}>已核对并确认本票采用的完整收件地址</Check></div>{!complete && <p className="mapping-help">补齐收件人、地址第 1 行、城市、邮编及两字母国家代码后可确认。</p>}{conflict && <p className="form-note error-note">原始来源中有不同的非空地址。请核对本票最终地址，并在上方记录采用依据。</p>}</div>
    <div className="document-footer-actions"><Button type="button" icon={Save} disabled={disabled || dirty} onClick={() => openAddressBook(fields)}>保存到地址簿</Button>{dirty && <span className="mapping-help">请先保存本票修改，再前往地址簿维护。</span>}</div>
    {members.some((member) => member.sourceCandidates?.addresses.length) && <details className="document-field-group document-address-evidence"><summary>原始来源地址（仅供核对）</summary><p className="mapping-help">原始货件快照保留用于追溯。采用地址统一在上方完成。</p>{members.flatMap((member) => (member.sourceCandidates?.addresses ?? []).map((candidate, index) => <div className="document-address-source" key={`${member.source.demandId}-${index}`}><h4>{member.demand.snapshot.fba} · {sourceLabels[candidate.source] || candidate.source}</h4><p>{Object.entries(candidate.data).filter(([, value]) => value).map(([key, value]) => `${addressLabels[key] || key}：${value}`).join('；')}</p></div>))}</details>}
      </div>
    </details>
  </section>;
}
