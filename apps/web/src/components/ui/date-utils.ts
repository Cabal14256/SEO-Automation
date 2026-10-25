/** Parse calendar values as local dates, never as UTC timestamps. */
export function parseISODate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
}

export function formatISODate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function addCalendarDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setHours(12, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

/** Presets use the same business timezone as the server. */
export function shanghaiToday(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  const date = parseISODate(`${part('year')}-${part('month')}-${part('day')}`)!;
  return formatISODate(addCalendarDays(date, offsetDays));
}

export function dateInputError(value: string, { required = false, min, max, month = false }: { required?: boolean; min?: string; max?: string; month?: boolean }): string {
  if (!value) return required ? `请选择${month ? '月份' : '日期'}。` : '';
  const valid = month ? /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Boolean(parseISODate(`${value}-01`)) : Boolean(parseISODate(value));
  if (!valid) return month ? '请输入有效月份，格式为 YYYY-MM。' : '请输入有效日期，格式为 YYYY-MM-DD。';
  if (min && value < min) return `${month ? '月份' : '日期'}不能早于 ${min}。`;
  if (max && value > max) return `${month ? '月份' : '日期'}不能晚于 ${max}。`;
  return '';
}
