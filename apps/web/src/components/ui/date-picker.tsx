import { useEffect, useRef, useState, type AriaAttributes } from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from './input';
import { Button } from './button';
import { Calendar } from './calendar';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { dateInputError, formatISODate, parseISODate, shanghaiToday } from './date-utils';

export type DatePickerProps = Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid' | 'aria-label'> & {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  min?: string;
  max?: string;
  className?: string;
};

/** A text field retains partial or invalid input so people can correct it. */
export function DateTextInput({ id, value, onValueChange, disabled, required, min, max, className, month = false, ...aria }: DatePickerProps & { month?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);
  const error = dateInputError(value, { required, min, max, month });
  const showError = touched && Boolean(error) && !disabled;
  useEffect(() => { input.current?.setCustomValidity(disabled ? '' : error); }, [disabled, error]);
  return <>
    <Input ref={input} id={id} type="text" inputMode="text" value={value} required={required} disabled={disabled}
      className={cn('date-input', className)} placeholder={month ? 'YYYY-MM' : 'YYYY-MM-DD'} autoComplete="off"
      aria-label={aria['aria-label']} aria-invalid={aria['aria-invalid'] || showError || undefined}
      aria-describedby={[aria['aria-describedby'], showError ? `${id}-date-error` : undefined].filter(Boolean).join(' ') || undefined}
      onChange={(event) => onValueChange(event.target.value)} onBlur={() => setTouched(true)}
      onInvalid={() => setTouched(true)} />
    {showError && <small id={`${id}-date-error`} className="picker-error" role="status">{error}</small>}
  </>;
}

export function DatePicker({ className, ...props }: DatePickerProps) {
  const { id, value, onValueChange, disabled, required, min, max } = props;
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const selected = parseISODate(value);
  const today = shanghaiToday();
  const permitted = (date: string) => !dateInputError(date, { min, max });
  const choose = (date: string) => { onValueChange(date); setOpen(false); };
  return <div className={cn('date-picker', className)}>
    <div className="date-input-wrap">
      <DateTextInput {...props} />
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild><button type="button" className="date-picker-trigger" disabled={disabled} aria-label="打开日期选择" aria-controls={`${id}-calendar`}><CalendarDays size={17} aria-hidden="true" /></button></PopoverTrigger>
        <PopoverContent id={`${id}-calendar`} className="picker-popover" aria-label="选择日期" align="start">
          <Calendar mode="single" selected={selected} defaultMonth={selected || parseISODate(today)} autoFocus
            disabled={(date) => !permitted(formatISODate(date))}
            onSelect={(date) => { if (date) choose(formatISODate(date)); }} />
          <div className="picker-actions"><Button type="button" variant="text" disabled={!permitted(today)} onClick={() => choose(today)}>今天</Button><Button type="button" variant="text" disabled={required || !value} onClick={() => choose('')}>清空</Button></div>
        </PopoverContent>
      </Popover>
    </div>
  </div>;
}
