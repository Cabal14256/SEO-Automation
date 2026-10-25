import { useId } from 'react';
import { calculateDocumentInvoiceUnitPrice, documentCanManuallySupplySalesPrice, documentEffectiveSalesPrice, documentProductSourceFact, documentTicketCurrency, type DocumentManualSalesPriceInput, type DocumentRevisionData } from '@scm/contracts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { timestamp } from './batch-shared';

type Product = { sid: number; msku: string; fnsku: string; sku: string; prefix: string };
export type ManualSalesPriceDraft = DocumentManualSalesPriceInput & { enteredCurrency: string };
export type ManualSalesPriceDrafts = Record<string, ManualSalesPriceDraft>;

export function DocumentSalesPrice({ data, product, draft, disabled, change }: {
  data: DocumentRevisionData; product: Product; draft?: ManualSalesPriceDraft; disabled: boolean;
  change: (input: ManualSalesPriceDraft | undefined) => void;
}) {
  const id = useId();
  const fact = documentProductSourceFact(data, product.sid, product);
  const effective = documentEffectiveSalesPrice(data, product.sid, product);
  const eligible = documentCanManuallySupplySalesPrice(data, product.sid, product);
  const currency = documentTicketCurrency(data.members) ?? '';
  const saved = data.manualSalesPrices?.find((entry) => entry.sid === product.sid && entry.msku === product.msku && entry.fnsku === product.fnsku && entry.sku === product.sku);
  const salesPrice = draft ? draft.salesPrice ?? '' : saved?.salesPrice ?? '';
  const reason = draft?.reason ?? saved?.reason ?? '';
  const enteredCurrency = draft?.enteredCurrency ?? saved?.currency ?? currency;
  const currencyChanged = Boolean(salesPrice && enteredCurrency !== currency);
  const unitPrice = draft && eligible ? !currencyChanged && calculateDocumentInvoiceUnitPrice(draft.salesPrice) || '' : effective.unitPrice;
  const manual = draft && eligible ? Boolean(unitPrice) : effective.source === 'manual';
  const update = (next: { salesPrice?: string | null; reason?: string; enteredCurrency?: string }) => change({ sid: product.sid, msku: product.msku, fnsku: product.fnsku, sku: product.sku, salesPrice: salesPrice || null, reason, enteredCurrency, ...next });
  return <div className="document-invoice-price" tabIndex={-1} data-document-field={product.prefix + 'unitPrice'} aria-label={`${product.msku} 自动申报单价`}>
    <dl className="document-lingxing-values">
      <div><dt>Listing 普通售价</dt><dd>{fact?.salesPrice || '缺失'} {fact?.currency || ''}</dd></div>
      <div><dt>申报单价（售价 × 20%）</dt><dd>{unitPrice || '无法计算'} {manual ? currency : effective.currency}</dd></div>
      <div><dt>标准箱规件数</dt><dd>{fact?.cartonQuantity || '缺失，采用全箱实际数量'}</dd></div>
      <div><dt>领星资料时间</dt><dd>{fact ? timestamp(fact.fetchedAt) : '尚未采用资料'}</dd></div>
      {manual && <div><dt>本票售价来源</dt><dd>人工补充 · {salesPrice} {currency}{draft ? ' · 待保存' : saved ? ` · ${timestamp(saved.recordedAt)}` : ''}</dd></div>}
    </dl>
    {eligible ? <>
      <p className="mapping-help">领星售价缺失或无效，可补充本票商品售价。币种按 FBA 所属国家确定，申报单价自动按售价的 20% 计算。</p>
      {currencyChanged && <div className="permission-note warning-note" role="alert"><p>原填写币种为 {enteredCurrency}，当前货件币种为 {currency}，价格不会自动换汇。请重新填写或核对当前币种的售价。</p><Button type="button" disabled={disabled} onClick={() => update({ enteredCurrency: currency })}>已核对，按 {currency} 采用此售价</Button></div>}
      {effective.issue && !draft && <p className="form-note error-note">原人工售价与当前来源不一致，请核对并重新填写后保存。</p>}
      <div className="document-form-grid">
        <div className="field" data-document-field={product.prefix + 'manualSalesPrice'}><label htmlFor={`${id}-price`}>人工补充售价（{currency}）</label><Input id={`${id}-price`} value={salesPrice} inputMode="decimal" maxLength={100} disabled={disabled} aria-invalid={Boolean(salesPrice && !calculateDocumentInvoiceUnitPrice(salesPrice))} onChange={(event) => update({ salesPrice: event.target.value || null, enteredCurrency: currency })} /><p className="mapping-help">填写商品售价；须为正数，且计算后的申报单价大于零。</p>{salesPrice && !calculateDocumentInvoiceUnitPrice(salesPrice) && <p className="form-note error-note">售价无效，或 20% 保留两位小数后为零。</p>}</div>
        <div className="field" data-document-field={product.prefix + 'manualSalesPriceReason'}><label htmlFor={`${id}-reason`}>售价补充依据</label><Input id={`${id}-reason`} value={reason} maxLength={1000} disabled={disabled} onChange={(event) => update({ reason: event.target.value })} /><p className="mapping-help">请说明价格依据，保存时记录填写人和时间。</p></div>
      </div>
      {(saved || draft) && <Button type="button" variant="text" disabled={disabled} onClick={() => saved ? update({ salesPrice: null, reason: '清除本票人工补充售价' }) : change(undefined)}>{saved ? '清除人工补充' : '放弃本次售价填写'}</Button>}
    </> : <>
      {!unitPrice && <p className="form-note error-note">请先查询并采用领星资料；售价仍缺失或无效时，可人工补充。</p>}
      {draft && <p className="permission-note warning-note">当前来源已不适用人工补充，本次填写仍保留。请放弃本次售价填写后继续保存。<Button type="button" variant="text" disabled={disabled} onClick={() => change(undefined)}>放弃本次售价填写</Button></p>}
    </>}
    {effective.currency && data.fields.currency && effective.currency !== data.fields.currency && <p className="form-note error-note">售价币种 {effective.currency} 与整票币种 {data.fields.currency} 不一致，生成前须核对；系统不自动换汇。</p>}
    <p className="mapping-help">价格由系统保留两位小数；有效领星售价始终优先，人工补充仅用于本票。</p>
  </div>;
}
