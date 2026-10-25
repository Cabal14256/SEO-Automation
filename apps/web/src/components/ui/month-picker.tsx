import { useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { DateTextInput, type DatePickerProps } from './date-picker';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { dateInputError, shanghaiToday } from './date-utils';

export function MonthPicker({ className, ...props }: DatePickerProps) {
  const { id, value, onValueChange, disabled, required, min, max } = props;
  const currentMonth = shanghaiToday().slice(0, 7);
  const [year, setYear] = useState(() => Number((dateInputError(value, { month: true }) ? currentMonth : value || currentMonth).slice(0, 4)));
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const permitted = (month: string) => !dateInputError(month, { month: true, min, max });
  const choose = (month: string) => { onValueChange(month); setOpen(false); };
  return <div className={cn('month-picker date-picker', className)}>
    <div className="date-input-wrap">
      <DateTextInput {...props} month />
      <Popover open={open && !disabled} onOpenChange={(next) => {
        if (next) setYear(Number((dateInputError(value, { month: true }) ? currentMonth : value || currentMonth).slice(0, 4)));
        setOpen(next);
      }}>
        <PopoverTrigger asChild><button type="button" className="date-picker-trigger month-picker-trigger" disabled={disabled} aria-label="打开月份选择" aria-controls={`${id}-months`}><CalendarDays size={17} aria-hidden="true" /></button></PopoverTrigger>
        <PopoverContent id={`${id}-months`} className="picker-popover" aria-label="选择月份" align="start">
          <div className="month-picker-header"><button type="button" className="calendar-nav-button" aria-label="上一年" disabled={year <= Math.max(1, Number(min?.slice(0, 4)) || 1)} onClick={() => setYear((current) => current - 1)}><ChevronLeft size={16} aria-hidden="true" /></button><strong aria-live="polite">{year} 年</strong><button type="button" className="calendar-nav-button" aria-label="下一年" disabled={year >= Math.min(9999, Number(max?.slice(0, 4)) || 9999)} onClick={() => setYear((current) => current + 1)}><ChevronRight size={16} aria-hidden="true" /></button></div>
          <div className="month-picker-grid" role="group" aria-label={`${year}年月份`}>{Array.from({ length: 12 }, (_, index) => {
            const month = `${String(year).padStart(4, '0')}-${String(index + 1).padStart(2, '0')}`;
            return <button key={month} type="button" className="month-picker-option" aria-pressed={value === month} disabled={!permitted(month)} onClick={() => choose(month)}>{index + 1}月</button>;
          })}</div>
          <div className="picker-actions"><Button type="button" variant="text" disabled={!permitted(currentMonth)} onClick={() => choose(currentMonth)}>本月</Button><Button type="button" variant="text" disabled={required || !value} onClick={() => choose('')}>清空</Button></div>
        </PopoverContent>
      </Popover>
    </div>
  </div>;
}
