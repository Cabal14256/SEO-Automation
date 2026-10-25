import { ChevronsUpDown, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type AriaAttributes, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input } from './input';
import { filterMultiSelectOptions } from './multi-select-options';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import type { SelectOption } from './select';
import { useControlDisabled } from './use-control-disabled';

type MultiSelectProps = AriaAttributes & {
  id: string; values: string[]; onValuesChange: (values: string[]) => void; options: SelectOption[];
  search: string; onSearchChange: (value: string) => void;
  placeholder?: string; searchPlaceholder?: string; popupLabel?: string; selectedSummary?: string;
  emptyMessage?: string; disabled?: boolean; className?: string;
};

export function MultiSelect({ id, values, onValuesChange, options, search, onSearchChange, placeholder = '请选择，可多选',
  searchPlaceholder = '输入关键词搜索…', popupLabel = '选择选项', selectedSummary, emptyMessage = '没有匹配选项，请换个关键词。', disabled, className, ...aria }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const list = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const inherited = useControlDisabled(disabled);
  const effectiveDisabled = inherited.disabled;
  useEffect(() => { if (effectiveDisabled) setOpen(false); }, [effectiveDisabled]);
  const visible = filterMultiSelectOptions(options, search);
  const selectable = visible.filter((option) => !option.disabled);
  const selected = new Set(values);
  const allChecked = selectable.length > 0 && selectable.every((option) => selected.has(option.value));
  const label = values.length ? selectedSummary ?? `已选 ${values.length} 项` : placeholder;
  const change = (next: string[]) => { if (!effectiveDisabled) onValuesChange(next); };
  const toggle = (value: string, checked: boolean) => change(checked ? [...new Set([...values, value])] : values.filter((item) => item !== value));
  const toggleVisible = () => {
    const matched = new Set(selectable.map((option) => option.value));
    change(allChecked ? values.filter((value) => !matched.has(value)) : [...new Set([...values, ...matched])]);
  };
  const navigate = (event: KeyboardEvent<HTMLInputElement | HTMLDivElement>) => {
    const inputs = Array.from(list.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:disabled)') ?? []);
    if (!inputs.length) return;
    const index = inputs.indexOf(event.target as HTMLInputElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index < 0 ? event.key === 'ArrowDown' ? 0 : inputs.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + inputs.length) % inputs.length;
      inputs[next]?.focus();
    } else if (index >= 0 && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault(); inputs[event.key === 'Home' ? 0 : inputs.length - 1]?.focus();
    } else if (index >= 0 && event.key === 'Enter') {
      event.preventDefault(); inputs[index]?.click();
    }
  };
  return <Popover open={open && !effectiveDisabled} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button {...aria} ref={inherited.ref} id={id} type="button" role="combobox" aria-expanded={open && !effectiveDisabled}
        aria-controls={open && !effectiveDisabled ? popupId : undefined} aria-haspopup="dialog" aria-autocomplete="none"
        disabled={effectiveDisabled} data-slot="multi-select-trigger" className={cn('ui-control ui-multi-select-trigger', className)} title={label}>
        <span>{label}</span><ChevronsUpDown size={16} aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent id={popupId} role="dialog" aria-label={popupLabel} className="ui-combobox-content ui-multi-select-content"
      onOpenAutoFocus={(event) => { event.preventDefault(); searchInput.current?.focus(); }}>
      <div className="ui-combobox-search"><Search size={16} aria-hidden="true" /><Input ref={searchInput} value={search} placeholder={searchPlaceholder}
        aria-label={searchPlaceholder} onChange={(event) => onSearchChange(event.target.value)} onKeyDown={navigate} /></div>
      <div className="ui-multi-select-actions">
        <Button type="button" variant="text" disabled={effectiveDisabled || !selectable.length} onClick={toggleVisible}>{allChecked ? '取消选择搜索结果' : '全选搜索结果'}（{selectable.length}）</Button>
        <Button type="button" variant="text" disabled={effectiveDisabled || !values.length} onClick={() => change([])}>清空全部已选</Button>
      </div>
      <div ref={list} className="ui-multi-select-list" role="group" aria-label={`${popupLabel}列表`} onKeyDown={navigate}>
        {!visible.length && <p className="ui-combobox-empty" role="status">{emptyMessage}</p>}
        {visible.map((option) => <label key={option.value} className="ui-multi-select-option" data-checked={selected.has(option.value)} data-disabled={option.disabled || undefined}>
          <input type="checkbox" checked={selected.has(option.value)} disabled={effectiveDisabled || option.disabled} onChange={(event) => toggle(option.value, event.target.checked)} />
          <span>{option.label}</span>
        </label>)}
      </div>
      <div className="ui-multi-select-footer"><span role="status">已选 {values.length} 项 · 匹配 {visible.length} 项</span><Button type="button" onClick={() => setOpen(false)}>完成选择</Button></div>
    </PopoverContent>
  </Popover>;
}
