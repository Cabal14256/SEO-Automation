import { useId, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { SelectField } from '../components/ui/select';
import { type WorkflowFile, type WorkflowSource, workflowBoxes } from '@scm/contracts';

export type Box = ReturnType<typeof workflowBoxes>[number];
export const boxLabel = (box: Box) => `${box.fba} · ${box.code || box.localBoxId || box.order}`;
export function TextField({ label, value, change, type = 'text', required = false }: { label: string; value: string; change: (value: string) => void; type?: string; required?: boolean }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label><Input id={id} type={type} value={value} onChange={(event) => change(event.target.value)} required={required} maxLength={type === 'text' ? 4000 : undefined} /></div>;
}
export function ChoiceField({ label, value, change, options }: { label: string; value: string; change: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label><SelectField id={id} value={value} options={options} onValueChange={change} /></div>;
}
export function FileField({ label, value, change, files }: { label: string; value: string | undefined; change: (value: string | undefined) => void; files: WorkflowFile[] }) {
  return <ChoiceField label={label} value={value ?? ''} change={(next) => change(next || undefined)} options={[{ value: '', label: '请选择已上传附件' }, ...files.map((file) => ({ value: file.id, label: file.name }))]} />;
}
export function Section({ title, children, action, help }: { title: string; children: ReactNode; action?: ReactNode; help?: string }) {
  return <section className="workflow-section"><div className="workflow-section-heading"><h3>{title}</h3>{action}</div>{help && <p className="mapping-help">{help}</p>}{children}</section>;
}
export function AddButton({ children, click }: { children: ReactNode; click: () => void }) { return <Button type="button" icon={Plus} onClick={click}>{children}</Button>; }
export function RemoveButton({ label, click }: { label: string; click: () => void }) { return <IconButton type="button" icon={Trash2} label={label} onClick={click} />; }
export function BoxesSelection({ source, value, change, disabled = false }: { source: WorkflowSource; value: string[]; change: (value: string[]) => void; disabled?: boolean }) {
  return <div className="workflow-box-selection">{workflowBoxes(source).map((box) => <label key={box.id} className="import-check"><input type="checkbox" checked={value.includes(box.id)} disabled={disabled} onChange={(event) => change(event.target.checked ? [...value, box.id] : value.filter((id) => id !== box.id))} /><span>{boxLabel(box)}<small>{box.country} · {box.items.reduce((sum, item) => sum + Number(item.quantity), 0)} 件</small></span></label>)}</div>;
}
