import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { calculateDocumentInvoiceUnitPrice, type DocumentAutomationFieldDescriptor, type DocumentAutomationJob, type DocumentAutomationSupplementInput } from '@scm/contracts';
import { ApiError } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';
import { Check, messageOf, newOperation } from './batch-shared';
import { documentAutomationApi } from './document-automation-api';

type FieldValue = string | boolean | null;
export type AutomationFormState = { dirty: boolean; busy: boolean };
const versionsOf = (job: DocumentAutomationJob): Record<string, number> => Object.fromEntries(job.items.flatMap((item) => item.documentId && item.documentVersion ? [[item.documentId, item.documentVersion]] : []));
const signatures = (versions: Record<string, number>) => JSON.stringify(Object.entries(versions).sort(([left], [right]) => left.localeCompare(right)));
const targetKeys = (field: DocumentAutomationFieldDescriptor) => field.targets.map((target) => `${target.documentId}:${target.fieldKey}`).sort();

export function DocumentAutomationSupplement({ job, blocked, onState, registerDiscard, actionsContainer }: {
  job: DocumentAutomationJob; blocked: boolean; onState: (state: AutomationFormState) => void; registerDiscard: (discard: () => void) => void;
  actionsContainer?: HTMLDivElement | null;
}) {
  const id = useId(), client = useQueryClient();
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const baseVersions = useRef<Record<string, number> | null>(null);
  const draftDescriptors = useRef(new Map<string, DocumentAutomationFieldDescriptor>());
  const originalRequest = useRef<{ key: string; input: DocumentAutomationSupplementInput } | null>(null);
  const inFlight = useRef(false);
  const [acknowledged, setAcknowledged] = useState(0);
  const descriptors = job.supplement?.descriptors ?? [];
  const currentVersions = versionsOf(job);
  const changedVersion = Boolean(baseVersions.current && signatures(baseVersions.current) !== signatures(currentVersions));
  const removed = Object.keys(values).filter((key) => !descriptors.some((field) => field.id === key));
  const dirty = Object.keys(values).length > 0;
  const draftValue = (field: DocumentAutomationFieldDescriptor): { present: boolean; value: FieldValue } => {
    if (Object.hasOwn(values, field.id)) return { present: true, value: values[field.id]! };
    const targets = targetKeys(field);
    const matches = Object.entries(values).filter(([key]) => {
      const previous = draftDescriptors.current.get(key);
      return previous?.scope === field.scope && previous.kind === field.kind && targets.every((target) => targetKeys(previous).includes(target));
    });
    const choices = new Map(matches.map(([, value]) => [JSON.stringify(value), value]));
    return choices.size === 1 ? { present: true, value: [...choices.values()][0]! } : { present: false, value: field.value };
  };
  const mutation = useMutation({ networkMode: 'always', mutationFn: async () => {
    const included = { ...values };
    for (const confirmation of descriptors.filter((field) => field.kind === 'checkbox' && values[field.id] === true && field.targets.some((target) => target.fieldKey === 'addressConfirmed'))) {
      const documentIds = new Set(confirmation.targets.map((target) => target.documentId));
      for (const reason of descriptors.filter((field) => field.targets.some((target) => target.fieldKey === 'addressConfirmationReason' && documentIds.has(target.documentId)))) {
        const visible = draftValue(reason).value;
        if (!Object.hasOwn(included, reason.id) && typeof visible === 'string' && visible.trim()) included[reason.id] = visible;
      }
    }
    const submitted = Object.entries(included).map(([fieldId, value]) => ({ id: fieldId, value }));
    const documentVersions = baseVersions.current ?? currentVersions;
    const key = JSON.stringify({ values: submitted, documentVersions });
    if (originalRequest.current?.key !== key) originalRequest.current = { key, input: { operationId: newOperation(), expectedVersion: job.version, documentVersions, values: submitted } };
    return documentAutomationApi.supplement(job.id, originalRequest.current.input);
  }, onSuccess: async (result) => {
    setValues({}); baseVersions.current = null; originalRequest.current = null; draftDescriptors.current.clear();
    client.setQueryData(['document-automation', job.id], result);
    await Promise.all([client.invalidateQueries({ queryKey: ['document-automation-requirements', job.id] }), client.invalidateQueries({ queryKey: ['document-automations'] }), client.invalidateQueries({ queryKey: ['document'] }), client.invalidateQueries({ queryKey: ['documents'] })]);
  }, onError: (error) => { if (error instanceof ApiError && error.status === 409) originalRequest.current = null; }, onSettled: () => { inFlight.current = false; } });
  const resetMutation = mutation.reset;
  useEffect(() => {
    registerDiscard(() => { setValues({}); baseVersions.current = null; originalRequest.current = null; draftDescriptors.current.clear(); resetMutation(); });
    return () => { registerDiscard(() => {}); onState({ dirty: false, busy: false }); };
  }, [onState, registerDiscard, resetMutation]);
  useEffect(() => { onState({ dirty, busy: mutation.isPending }); }, [dirty, mutation.isPending, onState]);
  const update = (field: DocumentAutomationFieldDescriptor, value: FieldValue) => {
    if (blocked || inFlight.current) return;
    baseVersions.current ??= currentVersions;
    draftDescriptors.current.set(field.id, field);
    setValues((current) => ({ ...current, [field.id]: value }));
  };
  const grouped = new Map<string, DocumentAutomationFieldDescriptor[]>();
  for (const field of descriptors) {
    const key = `${field.scope}:${field.scopeLabel}`;
    const group = grouped.get(key); if (group) group.push(field); else grouped.set(key, [field]);
  }
  return <section className="document-automation-supplement" aria-label="统一补充资料">
    <div className="section-heading"><div><h3>统一补充缺少的资料</h3><p className="mapping-help">共 {descriptors.length} 项待补充。相同范围的公共资料只需填写一次；整批检查全部通过后才会生成一份 XLSX。</p></div></div>
    {changedVersion || removed.length ? <div className="permission-note warning-note" role="alert"><p>部分单据版本或缺项已更新，本次填写仍保留。请核对新版内容后继续，已由新版解决的旧缺项将不再提交。</p>{removed.length > 0 && <details><summary>查看原先填写的内容</summary><ul>{removed.map((key) => <li key={key}>{draftDescriptors.current.get(key)?.scopeLabel} · {draftDescriptors.current.get(key)?.label || '已更新字段'}：{String(values[key] ?? '') || '空白'}</li>)}</ul></details>}<Button type="button" icon={RefreshCw} disabled={blocked || mutation.isPending} onClick={() => {
      baseVersions.current = currentVersions; originalRequest.current = null;
      const restored = Object.fromEntries(descriptors.flatMap((field) => { const previous = draftValue(field); return previous.present ? [[field.id, previous.value]] : []; }));
      draftDescriptors.current = new Map(descriptors.filter((field) => Object.hasOwn(restored, field.id)).map((field) => [field.id, field]));
      setValues(restored); setAcknowledged(acknowledged + 1); resetMutation();
    }}>已核对新版，保留填写继续</Button></div> : null}
    <form id={`${id}-form`} onSubmit={(event) => { event.preventDefault(); if (blocked || inFlight.current || !dirty || changedVersion || removed.length) return; inFlight.current = true; mutation.mutate(); }}>
      <fieldset className="document-wizard-fieldset" disabled={blocked || mutation.isPending}>
        {[...grouped].map(([key, group]) => <fieldset key={key} className="document-automation-field-group" aria-label={group[0]!.scopeLabel}><legend>{group[0]!.scopeLabel}</legend><div className="document-form-grid">{group.map((field) => {
          const draft = draftValue(field), value = draft.value;
          const inputId = `${id}-${field.id}`;
          const salesPriceCurrency = /^@sellingPrice\.(USD|GBP|EUR)\./.exec(field.targets[0]?.fieldKey ?? '')?.[1];
          const declaredPrice = salesPriceCurrency ? calculateDocumentInvoiceUnitPrice(value) : null;
          return <div className="field" key={field.id} data-automation-field={field.id}>
            {field.kind === 'checkbox' ? <Check checked={value === true || value === 'true'} disabled={blocked || mutation.isPending} onChange={(checked) => update(field, checked)}>{field.label}</Check> : <>
              <label htmlFor={inputId}>{field.label}{field.required ? '（待补）' : ''}</label>
              {field.kind === 'select' ? <SelectField id={inputId} value={String(value ?? '')} disabled={blocked || mutation.isPending} onValueChange={(next) => update(field, next)} options={[{ value: '', label: '请选择' }, ...(field.options ?? []).filter((option) => option.value !== '')]} />
                : <Input id={inputId} value={String(value ?? '')} maxLength={4000} inputMode={field.kind === 'number' ? 'decimal' : 'text'} disabled={blocked || mutation.isPending} onChange={(event) => update(field, event.target.value)} />}
            </>}
            <p className="mapping-help">{field.help || (field.targets.length > 1 ? `统一填写到 ${field.targets.length} 个对应位置。` : '仅修改此处对应的资料。')}</p>
            {salesPriceCurrency && <p className="mapping-help" role="status">申报单价（售价 × 20%）：{declaredPrice ? `${declaredPrice} ${salesPriceCurrency}` : '待填写有效售价'}</p>}
            {changedVersion && draft.present && value !== field.value && <p className="mapping-help">新版保存值：{String(field.value ?? '') || '空白'}。本次输入已保留，请核对后继续。</p>}
          </div>;
        })}</div></fieldset>)}
      </fieldset>
      {mutation.error && <p className="form-note error-note" role="alert">{messageOf(mutation.error)} 所有填写已保留。{typeof mutation.error === 'object' && 'status' in mutation.error && mutation.error.status === 409 ? ' 请刷新任务并核对新版后继续。' : ' 可重试确认保存结果。'}</p>}
      <p className="mapping-help">可先保存部分资料；仍有缺项时会继续提示，不会提前生成。</p>
      {!actionsContainer && <Button type="submit" variant="primary" icon={ArrowRight} loading={mutation.isPending} disabled={blocked || !dirty || changedVersion || removed.length > 0}>保存并统一检查</Button>}
    </form>
    {actionsContainer && createPortal(<Button type="submit" form={`${id}-form`} variant="primary" icon={ArrowRight} loading={mutation.isPending} disabled={blocked || !dirty || changedVersion || removed.length > 0}>保存并统一检查</Button>, actionsContainer)}
  </section>;
}
