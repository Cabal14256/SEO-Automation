import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useCallback, useEffect, useState, type AriaAttributes } from 'react';
import { cn } from '@/lib/utils';
import { useControlDisabled } from './use-control-disabled';

export type SelectOption = { value: string; label: string; disabled?: boolean; keywords?: string[] };
export type SelectFieldProps = AriaAttributes & {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  className?: string;
};

// Radix reserves an empty value for its placeholder. Encode every option so
// existing API values (including "" for an unrestricted filter) stay intact.
const encode = (value: string) => `option:${value}`;

export function SelectField({ id, value, onValueChange, options, placeholder = '请选择', disabled, required, name, className, ...aria }: SelectFieldProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const inherited = useControlDisabled(disabled);
  const disabledRef = inherited.ref;
  const triggerRef = useCallback((node: HTMLButtonElement | null) => {
    disabledRef(node);
    if (node) setContainer(node.closest('dialog'));
  }, [disabledRef]);
  const effectiveDisabled = inherited.disabled;
  useEffect(() => { if (effectiveDisabled) setOpen(false); }, [effectiveDisabled]);
  const selected = options.find((option) => option.value === value);
  const visibleOptions = selected || !value ? options : [{ value, label: value }, ...options];
  return <SelectPrimitive.Root value={required && !value ? '' : selected || value ? encode(value) : ''} disabled={effectiveDisabled} required={required}
    onValueChange={(next) => { if (!effectiveDisabled) onValueChange(next.slice('option:'.length)); }} open={open && !effectiveDisabled} onOpenChange={setOpen}>
    {name && <input type="hidden" name={name} value={value} disabled={effectiveDisabled} />}
    <SelectPrimitive.Trigger {...aria} id={id} data-slot="select-trigger" data-value={value}
      ref={triggerRef}
      className={cn('ui-control ui-select-trigger', className)}>
      <SelectPrimitive.Value placeholder={placeholder} />
      <SelectPrimitive.Icon asChild><ChevronDown size={16} aria-hidden="true" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal container={container ?? undefined}>
      <SelectPrimitive.Content position="popper" align="start" sideOffset={6} collisionPadding={12} data-slot="select-content" className="ui-select-content"
        onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(false); }}>
        <SelectPrimitive.ScrollUpButton className="ui-select-scroll"><ChevronUp size={16} aria-hidden="true" /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="ui-select-viewport">
          {visibleOptions.map((option) => <SelectPrimitive.Item key={option.value} value={encode(option.value)} disabled={option.disabled}
            data-value={option.value} data-option-value={option.value} className="ui-select-option">
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="ui-option-check"><Check size={16} aria-hidden="true" /></SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="ui-select-scroll"><ChevronDown size={16} aria-hidden="true" /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>;
}
