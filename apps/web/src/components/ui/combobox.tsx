import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import type { SelectFieldProps } from './select';
import { useControlDisabled } from './use-control-disabled';

type ComboboxProps = SelectFieldProps & { searchPlaceholder?: string; emptyMessage?: string };

export function Combobox({ id, value, onValueChange, options, placeholder = '请选择', searchPlaceholder = '输入关键词搜索…', emptyMessage = '没有匹配选项，请换个关键词。', disabled, required, name, className, ...aria }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const inherited = useControlDisabled(disabled);
  const validationInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const inheritedRef = inherited.ref;
  const triggerRef = useCallback((node: HTMLButtonElement | null) => { trigger.current = node; inheritedRef(node); }, [inheritedRef]);
  const effectiveDisabled = inherited.disabled;
  useEffect(() => { if (effectiveDisabled) setOpen(false); }, [effectiveDisabled]);
  const selected = options.find((option) => option.value === value);
  const label = selected?.label ?? (value || placeholder);
  return <>
    {(name || required) && <input ref={validationInput} className="sr-only" tabIndex={-1} aria-hidden="true" name={name} value={value} required={required} disabled={effectiveDisabled}
      onChange={() => {}} onInvalid={(event) => { event.preventDefault(); trigger.current?.focus(); setOpen(true); }} />}
    <Popover open={open && !effectiveDisabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button {...aria} ref={triggerRef} id={id} type="button" role="combobox" aria-expanded={open && !effectiveDisabled} aria-controls={open && !effectiveDisabled ? listId : undefined}
          aria-haspopup="listbox" aria-autocomplete="none" aria-required={required || undefined} disabled={effectiveDisabled} data-slot="combobox-trigger" data-value={value}
          className={cn('ui-control ui-combobox-trigger', className)} title={label}>
          <span>{label}</span><ChevronsUpDown size={16} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="ui-combobox-content" aria-labelledby={id}>
        <Command label={aria['aria-label'] ?? `搜索${placeholder}`}>
          <div className="ui-combobox-search"><Search size={16} aria-hidden="true" /><Command.Input placeholder={searchPlaceholder} aria-label={searchPlaceholder} /></div>
          <Command.List id={listId} className="ui-combobox-list">
            <Command.Empty className="ui-combobox-empty">{emptyMessage}</Command.Empty>
            {options.map((option) => <Command.Item key={option.value} value={`option:${option.value}`}
              keywords={[option.label, ...(option.keywords ?? [])]} disabled={option.disabled} data-option-value={option.value}
              className="ui-combobox-option" onSelect={() => { if (!effectiveDisabled) onValueChange(option.value); setOpen(false); }}>
              <span>{option.label}</span><Check size={16} aria-hidden="true" className={cn('ui-option-check', value !== option.value && 'ui-option-unchecked')} />
            </Command.Item>)}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  </>;
}
