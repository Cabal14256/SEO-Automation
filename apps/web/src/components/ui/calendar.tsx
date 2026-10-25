import { DayPicker, type DayPickerProps } from 'react-day-picker';
import { zhCN } from 'react-day-picker/locale';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseISODate, shanghaiToday } from './date-utils';

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: DayPickerProps) {
  return <DayPicker locale={zhCN} weekStartsOn={1} today={parseISODate(shanghaiToday())} showOutsideDays={showOutsideDays}
    className={cn('calendar', className)} classNames={{
      root: 'calendar', months: 'calendar-months', month: 'calendar-month', month_caption: 'calendar-caption',
      caption_label: 'calendar-caption-label', nav: 'calendar-nav', button_previous: 'calendar-nav-button', button_next: 'calendar-nav-button',
      chevron: 'calendar-chevron', month_grid: 'calendar-grid', weekdays: 'calendar-weekdays', weekday: 'calendar-weekday',
      week: 'calendar-week', day: 'calendar-day', day_button: 'calendar-day-button', today: 'calendar-today',
      selected: 'calendar-selected', outside: 'calendar-outside', disabled: 'calendar-disabled', hidden: 'calendar-hidden',
      range_start: 'calendar-range-start', range_middle: 'calendar-range-middle', range_end: 'calendar-range-end', ...classNames,
    }} components={{ Chevron: ({ orientation, className: iconClass }) => {
      const Icon = orientation === 'left' ? ChevronLeft : orientation === 'right' ? ChevronRight : orientation === 'up' ? ChevronUp : ChevronDown;
      return <Icon className={iconClass} size={16} aria-hidden="true" />;
    } }} labels={{ labelPrevious: () => '上个月', labelNext: () => '下个月' }} {...props} />;
}
