import { IMPORT_DATE_POLICY } from '@scm/contracts';

export function businessDateForReceipt(receivedAt: Date) {
  if (!Number.isFinite(receivedAt.getTime())) throw new Error('Invalid receipt time');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(receivedAt);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  const businessDate = `${part('year')}-${part('month')}-${part('day')}`;
  const monday = new Date(`${businessDate}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { importedAt: new Date(receivedAt), businessDate, datePolicyVersion: IMPORT_DATE_POLICY,
    weekStartDate: monday.toISOString().slice(0, 10), weekEndDate: sunday.toISOString().slice(0, 10) };
}
