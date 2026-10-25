import { useState } from 'react';
import { DOCUMENT_FIELD_OPTIONS } from '@scm/contracts';
import { Button } from '../components/ui/button';
import { Combobox } from '../components/ui/combobox';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';

const currencyLabels: Record<string, string> = { USD: '美元（USD）', EUR: '欧元（EUR）', GBP: '英镑（GBP）' };

type DocumentFieldProps = {
  id: string;
  fieldKey: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  type?: 'text' | 'number' | 'url';
  min?: number;
  step?: string;
  services?: string[];
  servicesLoading?: boolean;
  servicesError?: boolean;
  retryServices?: () => void;
  serviceHelp?: string;
};

/** Keep template choices identical in single-ticket and public-profile forms. */
export function DocumentField({ id, fieldKey, value, onValueChange, disabled, required, type = 'text', min, step, services = [], servicesLoading, servicesError, retryServices, serviceHelp }: DocumentFieldProps) {
  const [manualService, setManualService] = useState(false);
  const choices: readonly string[] | undefined = Object.hasOwn(DOCUMENT_FIELD_OPTIONS, fieldKey) ? DOCUMENT_FIELD_OPTIONS[fieldKey as keyof typeof DOCUMENT_FIELD_OPTIONS] : undefined;
  if (choices) {
    const invalid = Boolean(value && !choices.includes(value));
    return <>
      <SelectField id={id} value={value} onValueChange={onValueChange} disabled={disabled} required={required}
        aria-describedby={invalid ? `${id}-help` : undefined}
        options={[{ value: '', label: '请选择' }, ...choices.map((choice) => ({ value: choice, label: fieldKey === 'currency' ? currencyLabels[choice] || choice : choice }))]} />
      {invalid && <p id={`${id}-help`} className="mapping-help error-note">当前值不在模板选项中，请重新选择。</p>}
    </>;
  }
  if (fieldKey === 'service') return <>
    {manualService ? <Input id={id} value={value} onChange={(event) => onValueChange(event.target.value)} maxLength={4000} required={required} disabled={disabled} autoFocus aria-describedby={`${id}-help`} />
      : <Combobox id={id} value={value} onValueChange={onValueChange} disabled={disabled} required={required} aria-describedby={`${id}-help`}
        placeholder={servicesLoading ? '正在读取渠道服务…' : '请选择渠道服务'} searchPlaceholder="搜索渠道服务…"
        emptyMessage={servicesError ? '渠道目录读取失败，请重试或手动填写。' : servicesLoading ? '正在读取渠道目录…' : '没有匹配的渠道服务，可手动填写。'}
        options={[{ value: '', label: '请选择' }, ...[...new Set(services)].filter(Boolean).map((service) => ({ value: service, label: service }))]} />}
    <div className="document-service-actions"><Button type="button" variant="text" disabled={disabled} onClick={() => setManualService((current) => !current)}>{manualService ? '从目录选择渠道服务' : '手动填写渠道服务'}</Button>
      {servicesError && retryServices && <Button type="button" variant="text" disabled={disabled || servicesLoading} onClick={retryServices}>重试渠道目录</Button>}</div>
    <p id={`${id}-help`} className="mapping-help">{servicesError ? '渠道目录读取失败，可重试或手动填写。' : !servicesLoading && services.length === 0 ? '暂无渠道目录，可手动填写已确认的服务。' : serviceHelp || '目录仅供参考，请选择实际采用的服务。'}</p>
  </>;
  return <Input id={id} value={value} onChange={(event) => onValueChange(event.target.value)} type={type} min={min} step={step} maxLength={4000} required={required} disabled={disabled} />;
}
