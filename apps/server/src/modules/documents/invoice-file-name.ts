import { invoiceFilenamePart as filePart, type DocumentRevisionData } from '@scm/contracts';

export type InvoiceFileNameData = Pick<DocumentRevisionData, 'members' | 'fields'>;

/** Match the reference: 10.31号16店铺-US-UPS-2件（ONT8）.xlsx. */
export function documentInvoiceFileName(data: InvoiceFileNameData, boxCount: number, generatedAt = new Date(), shopCode?: string): string {
  if (!Number.isSafeInteger(boxCount) || boxCount <= 0) throw new Error('发票文件名需要有效的实际箱数。');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).formatToParts(generatedAt);
  const date = ['month', 'day'].map((type) => Number(parts.find((part) => part.type === type)!.value)).join('.') + '号';
  const snapshot = data.members[0]?.demand.snapshot;
  return `${date}${filePart(shopCode?.trim() || snapshot?.shop, '未填店铺')}-${filePart(snapshot?.country, '未填国家')}-${filePart(snapshot?.channel, '未填渠道')}-${boxCount}件（${filePart(data.fields.addressCode, '未填地址编码')}）.xlsx`;
}
