import { documentInvoicePrice, documentProductSourceFact, type DocumentManualSalesPriceInput, type DocumentRevisionData } from '@scm/contracts';
import { Button } from '../components/ui/button';
import { timestamp } from './batch-shared';

type Product = { sid: number; msku: string; fnsku: string; sku: string; prefix: string };
export type ManualSalesPriceDraft = DocumentManualSalesPriceInput & { enteredCurrency: string };
export type ManualSalesPriceDrafts = Record<string, ManualSalesPriceDraft>;

export function DocumentSalesPrice({ data, product, draft, disabled, change }: {
  data: DocumentRevisionData; product: Product; draft?: ManualSalesPriceDraft; disabled: boolean;
  change: (input: ManualSalesPriceDraft | undefined) => void;
}) {
  const fact = documentProductSourceFact(data, product.sid, product);
  const { unitPrice, currency } = documentInvoicePrice(data);
  return <div className="document-invoice-price" tabIndex={-1} data-document-field={product.prefix + 'unitPrice'} aria-label={`${product.msku} 自动申报单价`}>
    <dl className="document-lingxing-values">
      <div><dt>固定申报单价（每件）</dt><dd>{unitPrice} {currency}</dd></div>
      <div><dt>标准箱规件数</dt><dd>{fact?.cartonQuantity || '缺失，采用全箱实际数量'}</dd></div>
      <div><dt>领星资料时间</dt><dd>{fact ? timestamp(fact.fetchedAt) : '尚未采用资料'}</dd></div>
    </dl>
    <p className="mapping-help">申报单价固定为每件 2.00，沿用本票币种，无需补充商品售价。</p>
    {draft && <p className="mapping-help">本次保留的售价填写不再用于申报单价。<Button type="button" variant="text" disabled={disabled} onClick={() => change(undefined)}>清除本次售价填写</Button></p>}
  </div>;
}
