import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronRight, CircleAlert, CircleCheck, RefreshCw } from 'lucide-react';
import type { DocumentLingxingPreview, DocumentRevisionData } from '@scm/contracts';
import { ApiError } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { messageOf, newOperation } from './batch-shared';
import { documentApi } from './document-api';
import { invoiceBoxPreview, invoiceProductIdentity } from './document-invoice-preview';
import { LingxingProgress } from './lingxing-progress';

const labels: Record<string, string> = {
  englishName: '英文申报品名', chineseName: '中文申报品名', material: '材质', hsCode: 'HS 编码',
  use: '用途', brand: '品牌', model: '型号', unit: '申报单位', unitPrice: '申报单价', currency: '币种',
  salesLink: '销售链接', name: '名称', company: '公司', partyName: '主体名称', shopName: '店铺名称',
  companyName: '公司名称', address: '地址', phone: '电话', email: '邮箱', vat: 'VAT',
  recipientName: '收件人', recipientCompany: '收件公司', addressCode: '地址代码', addressLine1: '地址第 1 行',
  addressLine2: '地址第 2 行', addressLine3: '地址第 3 行', city: '城市', state: '州 / 省',
  postalCode: '邮编', countryCode: '国家代码', channel: '业务渠道', service: '渠道服务',
  battery: '含电池', magnetic: '含磁性', liquid: '含液体', powder: '含粉末', dangerous: '危险品',
  orderNumber: '订单编号', reference: '参考号', deliveryStation: '交货仓站', deliveryWindow: '送仓时间',
  subjectName: '主体名称', subjectType: '主体类型', status: '状态', registrationAddress: '注册地址',
  customsMode: '报关方式', clearanceMode: '清关方式', taxMode: '税务方式', tradeTerms: '贸易条款', remarks: '备注',
  unitPriceSourceLabel: '单价来源', salesPrice: 'Listing 普通售价', cartonQuantity: '标准箱规件数',
};
const productKeys = ['englishName', 'chineseName', 'material', 'hsCode', 'use', 'brand', 'model', 'unit', 'unitPrice', 'currency', 'salesLink'];
const productIssueLabels: Record<string, string> = {
  LISTING_PRICE_INVALID: '领星售价或币种缺失、无效，无法按售价的 20% 计算申报单价，请在领星维护后重新查询。',
  LISTING_PRICE_UNAVAILABLE: '未取得可采用的领星售价，无法计算申报单价，请核对 Listing 资料与查询权限。',
  CARTON_QUANTITY_UNAVAILABLE: '领星未返回有效的每箱件数，申报数量将回退为本箱全部商品的实际数量；混装请导出后核对。',
  LISTING_PRODUCT_IDENTITY_MISMATCH: '售价记录的店铺、MSKU、FNSKU 或本地 SKU 与本票商品不一致，未采用该售价。',
  LISTING_PRODUCT_AMBIGUOUS: '同一店铺和 MSKU 返回多条售价记录，未自动采用，请核对领星 Listing。',
  LISTING_PRODUCT_NOT_FOUND: '未找到与本票完整商品身份一致的售价记录，请核对领星 Listing 配对。',
  LISTING_SEARCH_INCOMPLETE: '领星售价分页查询未完整结束，未采用本次售价，请重新查询。',
  FBA_PRODUCT_LOOKUP_UNAVAILABLE: '该商品的 FBA 资料查询未完成，请核对查询权限后重试。',
  LINGXING_LOOKUP_UNAVAILABLE: '该商品的领星资料查询未完成，现有空项仍需补齐。',
  PRODUCT_IMAGE_DOWNLOAD_FAILED: '商品图片下载未成功，请重试查询或手动补充图片。',
  PRODUCT_IMAGE_MISSING: '领星未返回可采用的商品图片，仍需补充。',
  LINGXING_PERMISSION_REQUIRED: '该商品资料查询权限尚未开通，请查看上方所需权限。',
  LINGXING_NOT_CONFIGURED: '尚未配置领星连接，请管理员完成配置后重试。',
  LINGXING_REQUESTS_DISABLED: '当前环境未启用领星查询，请管理员核对配置。',
  LINGXING_AUTH_FAILED: '领星鉴权未通过，请管理员核对连接配置和授权。',
  LINGXING_TIMEOUT: '领星查询超时，请稍后重试。',
  LINGXING_NETWORK_ERROR: '领星连接未完成，请检查网络后重试。',
  LINGXING_RATE_LIMITED: '领星查询达到限流，请稍后重试。',
  LINGXING_INVALID_RESPONSE: '领星返回资料无法识别，请稍后重试。',
  LINGXING_INVALID_CONFIG: '领星连接配置无效，请管理员核对。',
  LINGXING_INVALID_REQUEST: '该商品查询条件未通过校验，请核对商品身份。',
  LINGXING_OPERATION_DENIED: '当前连接未开放该资料查询，请管理员核对配置。',
  LINGXING_READ_FAILED: '该商品的领星资料读取失败，请查看上方查询提示后重试。',
  LINGXING_LOOKUP_FAILED: '该商品资料未能查询完成，请查看上方查询提示后重试。',
};
const productIssueText = (issue: string) => productIssueLabels[issue] || (/^[A-Z][A-Z0-9_:-]+$/.test(issue) ? '该商品资料未能完整获取，请查看上方查询提示后重试。' : issue.replace(/\b[A-Za-z][A-Za-z0-9]*\b/g, (word) => labels[word] || word));
const valueText = (value: unknown): string => value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const hasValue = (value: unknown) => valueText(value).trim() !== '';

function PreviewValues({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values).filter(([key, value]) => key in labels && hasValue(value) && typeof value !== 'object');
  return entries.length ? <dl className="document-lingxing-values">{entries.map(([key, value]) => <div key={key}><dt>{labels[key]}</dt><dd>{typeof value === 'boolean' ? value ? '是' : '否' : valueText(value)}</dd></div>)}</dl> : <p className="mapping-help">领星未返回可用值。</p>;
}

export function DocumentLingxing({ documentId, version, data, disabledReason, onBusyChange }: {
  documentId: string; version: number; data: DocumentRevisionData; disabledReason: string; onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const operations = useRef(new Map<string, string>());
  const [preview, setPreview] = useState<DocumentLingxingPreview | null>(null);
  const [reason, setReason] = useState('核对并采用领星商品与单票资料');
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: async (input: { phase: 'preview' | 'apply'; key: string }) => {
      if (!operations.current.has(input.key)) operations.current.set(input.key, newOperation());
      const operationId = operations.current.get(input.key)!;
      if (input.phase === 'preview') return documentApi.previewLingxing(documentId, { operationId, expectedVersion: version });
      if (!preview) throw new Error('请先查询并核对领星资料。');
      return documentApi.applyLingxing(documentId, { operationId, expectedVersion: version, previewOperationId: preview.operationId, reason: reason.trim(), confirmPrices: false });
    },
    onSuccess: async (result, input) => {
      operations.current.delete(input.key);
      if ('preview' in result) { setPreview(result.preview); return; }
      setPreview(null);
      await Promise.all(['documents', 'document', 'document-history', 'document-profiles'].map((key) => client.invalidateQueries({ queryKey: [key] })));
    },
    onError: (error) => { if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); },
  });
  useEffect(() => { onBusyChange(mutation.isPending); return () => onBusyChange(false); }, [mutation.isPending, onBusyChange]);
  const disabled = Boolean(disabledReason) || mutation.isPending;
  const query = () => {
    setPreview(null);
    mutation.mutate({ phase: 'preview', key: `preview:${documentId}:${version}` });
  };
  const apply = () => mutation.mutate({ phase: 'apply', key: `apply:${preview?.operationId}:${reason.trim()}` });
  const querying = mutation.isPending && mutation.variables.phase === 'preview';
  const representatives = new Set(invoiceBoxPreview(data).flatMap(({ box, representative }) => representative ? [invoiceProductIdentity(box.sid, representative)] : []));
  const queryStatus = querying ? 'running' : preview ? preview.issues.length > 0 || preview.products.some((product) => representatives.has(invoiceProductIdentity(product.sid, product)) && product.issues.length > 0) ? 'partial' : 'completed' : mutation.isError && mutation.variables.phase === 'preview' ? 'failed' : null;
  const priced = preview?.products.filter((product) => hasValue(product.data.unitPrice) && hasValue(product.data.currency)).length ?? 0;
  return <section className="content-panel document-lingxing" aria-labelledby={`${id}-title`} aria-busy={mutation.isPending}>
    <div className="section-heading"><h3 id={`${id}-title`}>从领星补齐资料</h3><Button type="button" icon={RefreshCw} loading={querying} disabled={disabled} onClick={query}>{preview ? '重新查询领星资料' : '查询领星资料'}</Button></div>
    <p className="mapping-help">按本票商品和店铺查询售价、标准箱规、申报资料与图片。申报单价按 Listing 普通售价 × 20% 自动计算，保留两位小数。先核对预览，再采用到当前单据。</p>
    {disabledReason && <p className="mapping-help">{disabledReason}</p>}
    {queryStatus && <LingxingProgress label="领星单据资料查询" status={queryStatus} startedAt={mutation.variables?.phase === 'preview' ? mutation.submittedAt : undefined} detail={querying ? '正在查询并整理领星商品、主体与图片资料，等待服务器返回并归档结果。' : queryStatus === 'failed' ? '本次查询未完成，请核对提示后重试。' : queryStatus === 'partial' ? '本次查询已结束，仍有资料需核对或补齐。' : '本次查询已结束，请核对结果后采用。'} />}
    {mutation.isError && <p className="form-note error-note" role="alert"><CircleAlert size={16} aria-hidden="true" />{messageOf(mutation.error)}{mutation.error instanceof ApiError && mutation.error.status === 409 ? ' 请重新读取单据，再查询最新资料。' : ' 可核对领星授权与资料后重试。'}</p>}
    {preview && <div className="document-lingxing-preview">
      <p className="form-note" role="status"><CircleCheck size={16} aria-hidden="true" />已查询 {preview.products.length} 个商品身份 · {priced} 项返回单价与币种 · 当前单据 v{preview.documentVersion}</p>
      {preview.issues.length > 0 && <div className="document-lingxing-notices" aria-label="领星查询提示">{preview.issues.map((issue, index) => <p className="form-note error-note" key={`${issue.code}-${index}`}><CircleAlert size={16} aria-hidden="true" /><span>{issue.message}{issue.permission && <small>需开通权限：{issue.permission}</small>}</span></p>)}</div>}
      {preview.products.length === 0 ? <p className="mapping-help">本次没有返回商品资料，请检查商品映射和领星 API 权限。</p> : <div className="document-lingxing-products">{preview.products.map((product, index) => {
        const representative = representatives.has(invoiceProductIdentity(product.sid, product));
        const missing = representative ? productKeys.filter((key) => !hasValue(product.data[key])) : [];
        const hasImage = hasValue(product.data.imageBase64);
        return <details className="document-lingxing-product" key={`${product.sid}-${product.msku}-${product.fnsku}-${product.sku}-${index}`}>
          <summary><span><ChevronRight size={14} aria-hidden="true" />{product.msku || product.sku || product.fnsku} <small>SID {product.sid} · {representative ? `输出代表商品 · ${productKeys.length - missing.length}/${productKeys.length} 项有值` : '箱内其他商品 · 不输出申报资料'} · {hasImage ? '图片已归档' : representative ? '图片待补齐' : '无需补充申报图片'}</small></span><span className="document-lingxing-price">申报单价 {valueText(product.data.unitPrice) || '缺失'} {valueText(product.data.currency) || '（币种缺失）'}<small>售价 {valueText(product.data.salesPrice) || '缺失'} × 20% · 箱规 {valueText(product.data.cartonQuantity) || '缺失，采用全箱实际数量'}</small>{hasValue(product.data.unitPriceSourceLabel) && <small>{valueText(product.data.unitPriceSourceLabel)}</small>}</span></summary>
          <p className="mapping-help">MSKU：{product.msku || '—'} · FNSKU：{product.fnsku || '—'} · SKU：{product.sku || '—'}</p>
          <PreviewValues values={product.data} />
          <p className="mapping-help">{hasImage ? '商品图片已保存到资料快照。' : product.imageUrls.length ? `领星返回 ${product.imageUrls.length} 个图片地址，尚未取得可用于发票的图片。` : '领星未返回商品图片。'}</p>
          {missing.length > 0 && <p className="document-waiting">仍缺：{missing.map((key) => labels[key]).join('、')}</p>}
          {product.issues.map((issue, issueIndex) => <p className={`form-note${representative ? ' error-note' : ''}`} key={issueIndex}>{!representative && '箱内其他商品资料提示（不阻止本票生成）：'}{productIssueText(issue)}</p>)}
        </details>;
      })}</div>}
      {Object.values(preview.fields).some(hasValue) && <details className="document-field-group"><summary>单票候选资料</summary><PreviewValues values={preview.fields} /></details>}
      {preview.parties.length > 0 && <details className="document-field-group"><summary>备货主体候选 · {preview.parties.length} 项</summary><p className="mapping-help">此列表供核对公司备货主体，不会自动确定本票卖方主体。</p>{preview.parties.map((party, index) => <PreviewValues key={index} values={party} />)}</details>}
      <p className="mapping-help">采用后更新售价、币种和标准箱规快照，按新规则自动计算申报单价，无需勾选价格确认。售价缺失或无效、币种冲突时须核对领星资料并重新查询。</p>
      <div className="field document-reason"><label htmlFor={`${id}-reason`}>采用原因</label><Input id={`${id}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} disabled={disabled} /></div>
      <div className="document-footer-actions"><Button type="button" icon={ArrowRight} variant="primary" loading={mutation.isPending && mutation.variables.phase === 'apply'} disabled={disabled || !reason.trim()} onClick={apply}>采用领星资料补齐空项</Button><span className="mapping-help">其他资料补齐空项；价格和箱规采用本次查询结果。采用后生成新修订，请重新校验。</span></div>
    </div>}
  </section>;
}
