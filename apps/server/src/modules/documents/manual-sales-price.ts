import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { calculateDocumentInvoiceUnitPrice, documentCanManuallySupplySalesPrice, documentLingxingPreviewSchema, documentManualSalesPriceInputSchema, documentManualSalesPriceSources, documentProductSourceFact, documentTicketCurrency,
  type DocumentManualSalesPriceInput, type DocumentRevisionData } from '@scm/contracts';
import { fileIndex } from '../../db/schema.js';
import { BatchError, type BatchTx } from '../batches/service.js';
import { checkedFileBytes } from '../imports/service.js';

const key = (identity: { sid: number; msku: string; fnsku: string; sku: string }) => JSON.stringify([identity.sid, identity.msku, identity.fnsku, identity.sku]);
const archiveSchema = z.object({ fetchedAt: z.iso.datetime(), suggestions: z.object({ products: documentLingxingPreviewSchema.shape.products }) });

/** Only authenticated revision commands create provenance; ordinary fields and profile data never do. */
export async function applyDocumentManualSalesPricesInTx(tx: BatchTx, data: DocumentRevisionData, actorId: string, changes?: DocumentManualSalesPriceInput[]): Promise<DocumentRevisionData> {
  if (!changes?.length) return data;
  const parsed = z.array(documentManualSalesPriceInputSchema).max(5000).parse(changes), identities = new Set<string>();
  let manual = [...data.manualSalesPrices ?? []];
  const archives = new Map<string, z.infer<typeof archiveSchema>>();
  for (const change of parsed) {
    const identity = key(change);
    if (identities.has(identity)) throw new BatchError('DOCUMENT_MANUAL_SALES_PRICE_DUPLICATE', 422, '同一完整商品身份不能重复提交人工售价。');
    identities.add(identity);
    const memberSources = documentManualSalesPriceSources(data, change.sid, change);
    if (!memberSources.length) throw new BatchError('DOCUMENT_MANUAL_SALES_PRICE_SCOPE', 422, '人工售价须精确匹配本票的店铺 SID、MSKU、FNSKU 和 SKU。');
    manual = manual.filter((entry) => key(entry) !== identity);
    if (change.salesPrice === null) continue;
    if (!documentCanManuallySupplySalesPrice(data, change.sid, change)) throw new BatchError('DOCUMENT_MANUAL_SALES_PRICE_UNAVAILABLE', 422, '仅领星售价缺失或无效且本票国家币种唯一时可补充人工售价；请先查询并采用当前资料。');
    const fact = documentProductSourceFact(data, change.sid, change)!, currency = documentTicketCurrency(data.members)!;
    let archive = archives.get(fact.sourceFileId);
    if (!archive) {
      const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, fact.sourceFileId));
      if (!file || file.sha256 !== fact.sourceSha256) throw new BatchError('DOCUMENT_SOURCE_FILE_INVALID', 422, '人工补充须保留可核验的领星售价来源归档，请重新查询并采用资料。');
      try { archive = archiveSchema.parse(JSON.parse((await checkedFileBytes(file)).toString('utf8'))); }
      catch { throw new BatchError('DOCUMENT_SOURCE_FILE_INVALID', 422, '领星售价来源归档无法核验，请重新查询并采用资料。'); }
      archives.set(fact.sourceFileId, archive);
    }
    const products = archive.suggestions.products.filter((entry) => key(entry) === identity);
    if (products.length !== 1 || archive.fetchedAt !== fact.fetchedAt) throw new BatchError('DOCUMENT_SOURCE_FILE_INVALID', 422, '人工售价的来源商品身份或取数版本无法核验，请重新查询并采用资料。');
    // Historical facts discarded both values when only currency was invalid. Never let that hide a valid amount.
    if (calculateDocumentInvoiceUnitPrice(products[0]!.data.salesPrice)) throw new BatchError('DOCUMENT_REMOTE_SALES_PRICE_AVAILABLE', 422, '领星已有有效售价，不能人工替代；请重新查询并采用资料，核对售价币种。');
    manual.push({ sid: change.sid, msku: change.msku, fnsku: change.fnsku, sku: change.sku, salesPrice: change.salesPrice, currency,
      reason: change.reason, recordedBy: actorId, recordedAt: new Date().toISOString(), sourceFileId: fact.sourceFileId, sourceSha256: fact.sourceSha256, memberSources: structuredClone(memberSources) });
  }
  return { ...data, manualSalesPrices: manual };
}
