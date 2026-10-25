import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Button } from './button';
import { Calendar } from './calendar';
import { DateTextInput } from './date-picker';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { addCalendarDays, formatISODate, parseISODate, shanghaiToday } from './date-utils';

type DateRangePickerProps = {
  id: string;
  startId: string;
  endId: string;
  startValue: string;
  endValue: string;
  onValueChange: (value: { start: string; end: string }) => void;
  startLabel: string;
  endLabel: string;
  endExclusive?: boolean;
  disabled?: boolean;
  required?: boolean;
};

export function DateRangePicker({ id, startId, endId, startValue, endValue, onValueChange, startLabel, endLabel, endExclusive = false, disabled, required }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const [anchor, setAnchor] = useState<Date>();
  const start = parseISODate(startValue);
  const end = parseISODate(endValue);
  const inclusiveEnd = end ? addCalendarDays(end, endExclusive ? -1 : 0) : undefined;
  const range: DateRange | undefined = anchor ? { from: anchor } : start ? { from: start, to: inclusiveEnd && inclusiveEnd >= start ? inclusiveEnd : undefined } : undefined;
  const change = (next: { start: string; end: string }) => { onValueChange(next); setAnchor(undefined); };
  const preset = (days?: number) => {
    const today = parseISODate(shanghaiToday())!;
    const from = days ? addCalendarDays(today, 1 - days) : new Date(today.getFullYear(), today.getMonth(), 1, 12);
    const last = days ? today : new Date(today.getFullYear(), today.getMonth() + 1, 0, 12);
    change({ start: formatISODate(from), end: formatISODate(addCalendarDays(last, endExclusive ? 1 : 0)) });
    setOpen(false);
  };
  const select = (day: Date) => {
    if (!anchor) { setAnchor(day); return; }
    const from = day < anchor ? day : anchor;
    const to = day < anchor ? anchor : day;
    change({ start: formatISODate(from), end: formatISODate(addCalendarDays(to, endExclusive ? 1 : 0)) });
    setOpen(false);
  };
  return <div id={id} className="date-range-picker">
    <div className="date-range-fields">
      <div className="field"><label htmlFor={startId}>{startLabel}</label><DateTextInput id={startId} value={startValue} onValueChange={(value) => change({ start: value, end: endValue })} required={required} disabled={disabled} max={end ? formatISODate(addCalendarDays(end, endExclusive ? -1 : 0)) : undefined} /></div>
      <div className="field"><label htmlFor={endId}>{endLabel}</label><DateTextInput id={endId} value={endValue} onValueChange={(value) => change({ start: startValue, end: value })} required={required} disabled={disabled} min={start ? formatISODate(addCalendarDays(start, endExclusive ? 1 : 0)) : undefined} /></div>
      <Popover open={open && !disabled} onOpenChange={(next) => { setAnchor(undefined); setOpen(next); }}>
        <PopoverTrigger asChild><Button type="button" className="date-range-calendar-trigger" icon={CalendarDays} disabled={disabled} aria-describedby={`${id}-help`}>选择日期范围</Button></PopoverTrigger>
        <PopoverContent className="picker-popover" aria-label="选择日期范围" align="start">
          <div className="date-range-presets"><Button type="button" variant="text" onClick={() => preset(7)}>最近7天</Button><Button type="button" variant="text" onClick={() => preset(30)}>最近30天</Button><Button type="button" variant="text" onClick={() => preset()}>本月</Button></div>
          <Calendar mode="range" selected={range} defaultMonth={start || parseISODate(shanghaiToday())} autoFocus onSelect={(_selection, day) => select(day)} />
          <p className="picker-helper" role="status">{anchor ? '请选择最后一天；同一天可再次点击。' : '依次选择开始和最后一天。'}</p>
          <div className="picker-actions"><Button type="button" variant="text" disabled={required || (!startValue && !endValue)} onClick={() => { change({ start: '', end: '' }); setOpen(false); }}>清空日期</Button></div>
        </PopoverContent>
      </Popover>
    </div>
    <small id={`${id}-help`} className="picker-helper">{endExclusive ? '结束日期当天不计入；日历会自动换算为所选最后一天的次日。' : '开始和结束日期当天均计入。'}</small>
  </div>;
}
