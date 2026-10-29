import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { applyDocumentAddress, documentLingxingApplyInputSchema, documentLingxingPreviewInputSchema, documentLingxingPreviewSchema, resolveDocumentLingxingAddress, type DocumentLingxingIssue, type DocumentLingxingPreview, type DocumentProductSourceFact, type DocumentRevisionData } from '@scm/contracts';
import { readConfig } from '../../config.js';
import { db, pool } from '../../db/client.js';
import { fileIndex } from '../../db/schema.js';
import { batchOperations } from '../batches/schema.js';
import { publishReportFile } from '../batches/report-service.js';
import { BatchError, requireBatchActor, type BatchTx } from '../batches/service.js';
import { checkedFileBytes } from '../imports/service.js';
import { createLingxingReadClient, LingxingReadError, type LingxingReadAttempt, type LingxingReadClient, type LingxingReadResult } from '../lingxing/read-client.js';
import { documentDigest, documentUsesProfileReference } from './domain.js';
import { downloadLingxingImage } from './lingxing-image.js';
import { mapLingxingInvoiceProduct, mapLingxingStockSubjects, matchLingxingFbaProduct, matchLingxingListingProduct } from './lingxing-mapping.js';
import { documentExports, documentProfiles, documentTemplates, documentTemplateVersions } from './schema.js';
import { appendDocumentRevisionInTx, documentOperation, lockedDocument, writeDocumentProfileInTx } from './service.js';
import { calculateInvoiceUnitPrice, documentProductOverrideKey, reviseDocumentProductFields } from './workbook.js';

type PreviewInput = z.infer<typeof documentLingxingPreviewInputSchema>;
type ApplyInput = z.infer<typeof documentLingxingApplyInputSchema>;
type ProductIdentity = { sid: number; msku: string; fnsku: string; sku: string };
type ProductSuggestion = DocumentLingxingPreview['products'][number];
type Client = Pick<LingxingReadClient, 'getFbaProducts' | 'getLocalProductDetail' | 'getListings' | 'listStockSubjects'>;
const PREVIEW_ACTION = 'document.lingxing.preview';
const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const blank = (value: unknown) => value === null || value === undefined || typeof value === 'string' && !value.trim();
const identityKey = (value: ProductIdentity) => JSON.stringify([value.sid, value.msku, value.fnsku, value.sku]);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const arrayData = (result: LingxingReadResult): Record<string, unknown>[] => {
  const data = result.payload.data;
  const list = Array.isArray(data) ? data : object(data)?.list ?? object(data)?.records ?? object(data)?.rows;
  if (!Array.isArray(list)) throw new BatchError('LINGXING_INVALID_RESPONSE', 503, '领星商品列表格式无法识别，不能据此判断商品不存在。');
  const rows = list.map(object);
  if (rows.some((value) => value === null)) throw new BatchError('LINGXING_INVALID_RESPONSE', 503, '领星商品列表包含非对象记录，未将不完整结果用于匹配。');
  return rows as Record<string, unknown>[];
};
export function documentLingxingProducts(data: DocumentRevisionData): Array<ProductIdentity & { country: string }> {
  const products = new Map<string, ProductIdentity & { country: string }>();
  for (const member of data.members) for (const item of member.shipment.data.items) {
    const identity = { sid: member.demand.snapshot.sid, msku: item.msku, fnsku: item.fnsku, sku: item.sku, country: member.demand.snapshot.country };
    products.set(identityKey(identity), identity);
  }
  return [...products.values()];
}
export function sameLingxingProduct(identity: ProductIdentity, data: Record<string, unknown>): boolean {
  return Number(data.sid) === identity.sid && ['msku', 'fnsku', 'sku'].every((field) => scalar(data[field]) === identity[field as keyof Omit<ProductIdentity, 'sid'>]);
}
export function aggregateLingxingFields(products: ProductSuggestion[]): Record<string, string | null> {
  const fields: Record<string, string | null> = {};
  for (const key of ['battery', 'magnetic', 'liquid', 'powder', 'dangerous']) {
    const values = products.map((product) => product.data[key]);
    if (values.some((value) => value === true || value === '是')) fields[key] = '是';
    else if (values.length && values.every((value) => value === false || value === '否')) fields[key] = '否';
  }
  const currencies = products.map((product) => scalar(product.data.currency).toUpperCase());
  if (currencies.length && currencies.every((currency) => currency === currencies[0]) && ['USD', 'EUR', 'GBP'].includes(currencies[0]!)) fields.currency = currencies[0]!;
  return fields;
}
const productFields = new Set(['englishName', 'chineseName', 'salesPrice', 'cartonQuantity', 'unitPrice', 'unitPriceSource', 'unitPriceSourceLabel', 'unitPriceKind', 'priceCandidates', 'material', 'hsCode', 'use', 'brand', 'model', 'salesLink', 'unit', 'currency', 'imageBase64', 'imageExtension', 'battery', 'magnetic', 'liquid', 'powder', 'dangerous']);
const addressFields = new Set(['recipientName', 'recipientCompany', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'state', 'postalCode', 'countryCode', 'phone', 'email', 'addressCode']);
/** Only empty values are filled. A review may confirm only the exact candidate
 * price/currency pair; it cannot confirm an unrelated existing manual price. */
export function mergeLingxingProduct(existing: Record<string, unknown>, suggestion: ProductSuggestion, confirmPrices: boolean): Record<string, unknown> {
  if (Object.keys(existing).length && !sameLingxingProduct(suggestion, existing)) throw new BatchError('DOCUMENT_PRODUCT_IDENTITY_CONFLICT', 409, '领星商品建议与现有完整商品身份不一致。');
  const result: Record<string, unknown> = { ...existing, sid: suggestion.sid, msku: suggestion.msku, fnsku: suggestion.fnsku, sku: suggestion.sku };
  for (const [key, value] of Object.entries(suggestion.data)) if (productFields.has(key) && blank(result[key]) && !blank(value)) result[key] = value;
  const price = scalar(result.unitPrice), currency = scalar(result.currency);
  const sameCandidatePair = price === scalar(suggestion.data.unitPrice) && currency === scalar(suggestion.data.currency);
  // A retained manual price must not acquire the source label of a different
  // remote candidate merely because its source-label field was empty.
  if (!sameCandidatePair) for (const key of ['unitPriceSource', 'unitPriceSourceLabel', 'unitPriceKind']) {
    if (blank(existing[key])) delete result[key]; else result[key] = existing[key];
  }
  const canConfirm = /^\d+(?:\.\d{1,2})?$/.test(price) && Number(price) > 0 && Number.isFinite(Number(price))
    && sameCandidatePair && ['USD', 'EUR', 'GBP'].includes(currency);
  const previouslyConfirmed = (existing.unitPriceConfirmed === true || existing.unitPriceConfirmed === 'true')
    && /^\d+(?:\.\d{1,2})?$/.test(scalar(existing.unitPrice)) && Number(existing.unitPrice) > 0 && Number(existing.unitPrice) <= Number.MAX_SAFE_INTEGER
    && ['USD', 'EUR', 'GBP'].includes(scalar(existing.currency)) && scalar(existing.unitPrice) === price && scalar(existing.currency) === currency;
  result.unitPriceConfirmed = previouslyConfirmed || confirmPrices && canConfirm;
  return result;
}
function issueFor(error: unknown, permission: string): DocumentLingxingIssue {
  if (error instanceof LingxingReadError) {
    const denied = error.metadata?.httpStatus === 403 || ['403', '2001004', '2001005'].includes(error.metadata?.businessCode ?? '');
    return { code: denied ? 'LINGXING_PERMISSION_REQUIRED' : error.code, message: denied ? `领星未授权“${permission}”，请开通后重新查询。` : error.message, permission };
  }
  if (error instanceof BatchError) return { code: error.code, message: error.message, permission };
  return { code: 'LINGXING_LOOKUP_FAILED', message: `“${permission}”查询未完成，未将查询失败视为资料不存在。`, permission };
}
async function writableDocument(tx: BatchTx, id: string, actorId: string, expectedVersion: number) {
  const result = await lockedDocument(tx, id, actorId, expectedVersion);
  if (['cancelled', 'superseded', 'approved', 'pending_review'].includes(result.record.status)) throw new BatchError('DOCUMENT_READ_ONLY', 409, '当前单据状态不允许补取资料，请先按既有流程建立或恢复草稿。');
  const [busy] = await tx.select({ id: documentExports.id }).from(documentExports).where(and(inArray(documentExports.status, ['queued', 'running']), sql`${documentExports.reference}->>'documentId' = ${id}`)).limit(1);
  if (busy) throw new BatchError('DOCUMENT_EXPORT_BUSY', 409, '当前发票仍在生成，请等待任务结束后补取资料。');
  const [exported] = await tx.select({ id: documentExports.id }).from(documentExports).where(and(eq(documentExports.status, 'completed'), sql`${documentExports.reference}->>'documentId' = ${id}`)).limit(1);
  if (exported) throw new BatchError('DOCUMENT_CORRECTION_REQUIRED', 409, '已生成文件的发票请通过更正建立新单据后补取资料。');
  return result;
}
/** Session advisory lock spans remote requests without holding a SQL
 * transaction. A concurrent retry reuses the saved result without refetching. */
async function previewExclusive<T>(operationId: string, work: () => Promise<T>): Promise<T> {
  const connection = await pool.connect(); let locked = false, discard = false;
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = await connection.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`document-lingxing-preview:${operationId}`]);
      if (result.rows[0]?.locked) { locked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!locked) throw new BatchError('DOCUMENT_PREVIEW_BUSY', 409, '相同领星查询仍在执行，请保持操作编号稍后重试。');
    return await work();
  } finally {
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [`document-lingxing-preview:${operationId}`]); }
    catch { discard = true; }
    connection.release(discard);
  }
}
export async function collectLingxingDocumentPreview(data: DocumentRevisionData, client: Client | null, initialIssues: DocumentLingxingIssue[] = [], imageDownload = downloadLingxingImage) {
  const issues = [...initialIssues], products: ProductSuggestion[] = [], parties: Record<string, unknown>[] = [];
  const identities = documentLingxingProducts(data), requests: Array<Record<string, unknown>> = [];
  if (identities.length > 50) throw new BatchError('DOCUMENT_PRODUCT_LIMIT', 422, '单次领星补取最多支持 50 个不同完整商品身份，请拆分发票。');
  const localCache = new Map<string, Record<string, unknown> | null>(), fbaCache = new Map<string, Record<string, unknown>[] | null>();
  let imageBytes = 0, businessRequests = 0, fbaDenied = false, localDenied = false;
  const checkBudget = () => { if (++businessRequests > 200) throw new BatchError('LINGXING_QUERY_BUDGET', 422, '本次领星查询已达到 200 次业务请求上限，未查询的资料仍需补充。'); };
  const listingCache = new Map<string, Record<string, unknown>[] | null>(), listingFailures = new Map<string, string>();
  const bySeller = new Map<number, string[]>();
  for (const identity of identities) if (identity.msku) bySeller.set(identity.sid, [...new Set([...(bySeller.get(identity.sid) ?? []), identity.msku])]);
  let listingsDenied = false;
  if (client) for (const [sid, mskus] of bySeller) for (let start = 0; start < mskus.length; start += 10) {
    const batch = mskus.slice(start, start + 10), keys = batch.map((msku) => JSON.stringify([sid, msku]));
    if (listingsDenied) { for (const key of keys) { listingCache.set(key, null); listingFailures.set(key, 'LINGXING_PERMISSION_REQUIRED'); } continue; }
    try {
      const found: Record<string, unknown>[] = [], pages = new Set<string>(); let complete = false, expectedTotal: number | undefined;
      for (let page = 0; page < 5; page++) {
        const params = { sid: String(sid), search_field: 'seller_sku' as const, search_value: batch, exact_search: 1 as const, is_delete: 0 as const, offset: page * 100, length: 100 };
        checkBudget(); const response = await client.getListings(params); requests.push({ operation: 'getListings', params, metadata: response.metadata });
        const rows = arrayData(response), digest = documentDigest(rows);
        if (pages.has(digest)) throw new BatchError('LISTING_SEARCH_INCOMPLETE', 422, '领星售价查询重复返回同一页，未采用不完整售价。');
        pages.add(digest); found.push(...rows);
        const total = response.payload.total === undefined ? undefined : Number(response.payload.total);
        if (rows.length > 100 || total !== undefined && (!Number.isSafeInteger(total) || total < found.length || expectedTotal !== undefined && expectedTotal !== total)) throw new BatchError('LISTING_SEARCH_INCOMPLETE', 422, '领星售价分页总数不一致，未采用不完整售价。');
        if (total !== undefined) expectedTotal = total;
        if (rows.length < 100 && (total === undefined || total === found.length) || total !== undefined && total === found.length) { complete = true; break; }
      }
      if (!complete) throw new BatchError('LISTING_SEARCH_INCOMPLETE', 422, '领星售价查询超过分页上限，未采用不完整售价。');
      for (let index = 0; index < batch.length; index++) listingCache.set(keys[index]!, found.filter((entry) => Number(entry.sid) === sid && scalar(entry.seller_sku) === batch[index]));
    } catch (error) {
      const issue = issueFor(error, '查询亚马逊 Listing'); issues.push(issue);
      if (issue.code === 'LINGXING_PERMISSION_REQUIRED') listingsDenied = true;
      for (const key of keys) { listingCache.set(key, null); listingFailures.set(key, issue.code); }
    }
  }
  const imageCache = new Map<string, Awaited<ReturnType<typeof downloadLingxingImage>> | null>();
  for (const identity of identities) {
    const productIssues: string[] = []; let fba: Record<string, unknown> | null = null, detail: Record<string, unknown> | null = null;
    if (client) {
      const key = JSON.stringify([identity.sid, identity.msku]);
      if (!fbaCache.has(key) && !fbaDenied && identity.msku) {
        try {
          const found: Record<string, unknown>[] = [], pages = new Set<string>(); let complete = false, expectedTotal: number | undefined;
          for (let page = 0; page < 5; page++) {
            const params = { sids: [identity.sid], search_field: 'msku' as const, search_value: identity.msku, offset: page * 100, length: 100 };
            checkBudget(); const response = await client.getFbaProducts(params); requests.push({ operation: 'getFbaProducts', params, metadata: response.metadata });
            const rows = arrayData(response), digest = documentDigest(rows);
            if (pages.has(digest)) throw new BatchError('FBA_PRODUCT_SEARCH_INCOMPLETE', 422, '领星模糊查询重复返回相同页面，未采用不完整的商品匹配。');
            pages.add(digest); found.push(...rows);
            const total = response.payload.total === undefined ? undefined : Number(response.payload.total);
            if (rows.length > 100 || total !== undefined && (!Number.isSafeInteger(total) || total < found.length || expectedTotal !== undefined && expectedTotal !== total)) throw new BatchError('FBA_PRODUCT_SEARCH_INCOMPLETE', 422, '领星商品分页总数不一致，未采用不完整的商品匹配。');
            if (total !== undefined) expectedTotal = total;
            if (rows.length < 100 && (total === undefined || total === found.length) || total !== undefined && total === found.length) { complete = true; break; }
          }
          if (!complete) throw new BatchError('FBA_PRODUCT_SEARCH_INCOMPLETE', 422, '领星模糊查询超过分页上限，未采用不完整的商品匹配。');
          fbaCache.set(key, found);
        } catch (error) { const issue = issueFor(error, '查询 FBA 商品信息'); issues.push(issue); productIssues.push(issue.code); fbaCache.set(key, null); if (issue.code === 'LINGXING_PERMISSION_REQUIRED') fbaDenied = true; }
      }
      const candidates = fbaCache.get(key);
      if (candidates) {
        const matches = candidates.filter((entry) => matchLingxingFbaProduct(identity, entry));
        if (matches.length === 1) fba = matches[0]!;
        else productIssues.push(matches.length ? 'FBA_PRODUCT_AMBIGUOUS' : 'FBA_PRODUCT_NOT_FOUND');
      } else productIssues.push('FBA_PRODUCT_LOOKUP_UNAVAILABLE');
      const productId = Number(fba?.product_id), localKey = Number.isSafeInteger(productId) && productId > 0 ? `id:${productId}` : `sku:${identity.sku}`;
      if (!localCache.has(localKey) && !localDenied) {
        try {
          if (!identity.sku && !localKey.startsWith('id:')) throw new BatchError('LOCAL_PRODUCT_ID_MISSING', 422, '当前商品缺少领星本地产品编号和 SKU，无法查询产品详情。');
          const params = localKey.startsWith('id:') ? { id: productId } : { sku: identity.sku };
          checkBudget(); const response = await client.getLocalProductDetail(params); requests.push({ operation: 'getLocalProductDetail', params, metadata: response.metadata });
          const raw = object(response.payload.data); if (!raw) throw new BatchError('LINGXING_INVALID_RESPONSE', 503, '领星本地产品详情格式无法识别。');
          localCache.set(localKey, raw);
        } catch (error) { const issue = issueFor(error, '查询本地产品详情'); issues.push(issue); productIssues.push(issue.code); localCache.set(localKey, null); if (issue.code === 'LINGXING_PERMISSION_REQUIRED') localDenied = true; }
      }
      detail = localCache.get(localKey) ?? null;
      if (localDenied && !detail) productIssues.push('LINGXING_PERMISSION_REQUIRED');
    } else productIssues.push('LINGXING_LOOKUP_UNAVAILABLE');
    const listingKey = JSON.stringify([identity.sid, identity.msku]), listings = listingCache.get(listingKey);
    const listing = listings?.length === 1 && matchLingxingListingProduct(identity, listings[0]) ? listings[0] : null;
    if (!listing) productIssues.push(listingFailures.get(listingKey) ?? (listings?.length ? listings.length > 1 ? 'LISTING_PRODUCT_AMBIGUOUS' : 'LISTING_PRODUCT_IDENTITY_MISMATCH' : 'LISTING_PRODUCT_NOT_FOUND'));
    const mapped = mapLingxingInvoiceProduct(identity, fba, detail, listing);
    const sources = data.members.flatMap((member) => member.sourceCandidates?.products ?? []).filter((entry) => sameLingxingProduct(identity, entry));
    if (!mapped.data.salesLink) {
      const links = [...new Set(sources.map((entry) => entry.salesLink).filter((value): value is string => Boolean(value)))];
      if (links.length === 1) mapped.data.salesLink = links[0];
    }
    const imageUrls = [...new Set([...mapped.imageUrls, ...sources.map((entry) => entry.imageUrl).filter((value): value is string => Boolean(value))])];
    for (const url of client ? imageUrls.slice(0, 3) : []) {
      if (!imageCache.has(url)) {
        try {
          if (imageBytes >= 8 * 1024 * 1024) throw new Error('IMAGE_BUDGET_EXCEEDED');
          const downloaded = await imageDownload(url); const size = Buffer.byteLength(downloaded.imageBase64, 'base64');
          if (imageBytes + size > 8 * 1024 * 1024) throw new Error('IMAGE_BUDGET_EXCEEDED');
          imageCache.set(url, downloaded);
        } catch { imageCache.set(url, null); }
      }
      const image = imageCache.get(url);
      if (image) {
        const size = Buffer.byteLength(image.imageBase64, 'base64');
        if (imageBytes + size > 8 * 1024 * 1024) { productIssues.push('PRODUCT_IMAGE_BUDGET'); break; }
        imageBytes += size; Object.assign(mapped.data, image); break;
      }
    }
    if (!mapped.data.imageBase64) productIssues.push(imageUrls.length ? 'PRODUCT_IMAGE_DOWNLOAD_FAILED' : 'PRODUCT_IMAGE_MISSING');
    const unresolvedIssues = mapped.issues.filter((issue) => !(mapped.data.salesLink && issue === '领星未提供可采用的 salesLink，仍需补充。')
      && !(imageUrls.length && issue === '领星未提供可采用的图片链接，仍需补充图片。'));
    products.push({ sid: identity.sid, msku: identity.msku, fnsku: identity.fnsku, sku: identity.sku, data: mapped.data, imageUrls, issues: [...new Set([...unresolvedIssues, ...productIssues])] });
  }
  if (client) {
    try { checkBudget(); const response = await client.listStockSubjects(); requests.push({ operation: 'listStockSubjects', metadata: response.metadata }); parties.push(...mapLingxingStockSubjects(response.payload.data).slice(0, 1000)); }
    catch (error) { issues.push(issueFor(error, '主体列表查询')); }
  }
  const addresses = data.members.flatMap((member) => member.sourceCandidates?.addresses.map((entry) => entry.data) ?? []);
  const address = resolveDocumentLingxingAddress(data.members), fields = { ...aggregateLingxingFields(products) };
  if (address) for (const [key, value] of Object.entries(address)) { if (addressFields.has(key)) fields[key] = value; }
  else if (addresses.length) issues.push({ code: 'DOCUMENT_ADDRESS_CONFLICT', message: '领星货件地址不完整、国家不符或存在冲突，请维护领星地址或人工核对本票地址。' });
  if (data.members.some((member) => !member.sourceCandidates)) issues.push({ code: 'DOCUMENT_SOURCE_SNAPSHOTS_MISSING', message: '部分货件尚无地址及商品来源快照，未将缺少快照视为来源资料不存在。' });
  return { products, fields, parties, issues, requests };
}
export async function previewDocumentLingxing(id: string, actorId: string, input: PreviewInput) {
  return previewExclusive(input.operationId, async () => {
    await db.transaction((tx) => requireBatchActor(tx, actorId));
    const operationInput = { id, ...input }, requestHash = documentDigest({ action: PREVIEW_ACTION, input: operationInput });
    const [previous] = await db.select().from(batchOperations).where(eq(batchOperations.operationId, input.operationId));
    if (previous) {
      if (previous.actorId !== actorId || previous.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于不同请求。');
      return { ...previous.result, replayed: true };
    }
    const { revision } = await db.transaction((tx) => writableDocument(tx, id, actorId, input.expectedVersion));
    const attempts: LingxingReadAttempt[] = [], initialIssues: DocumentLingxingIssue[] = []; let client: LingxingReadClient | null = null, attemptCount = 0, responseBytes = 0;
    try { client = await createLingxingReadClient(readConfig(), {
      beforeRequest: async () => { if (++attemptCount > 200 || responseBytes >= 8 * 1024 * 1024) throw new BatchError('LINGXING_QUERY_BUDGET', 422, '本次领星查询已达到请求或响应归档预算，剩余商品仍需补充。'); },
      onAttempt: async (attempt) => { attempts.push(attempt); responseBytes += Buffer.byteLength(JSON.stringify(attempt)); },
    }); }
    catch (error) { initialIssues.push(issueFor(error, '领星只读连接')); }
    const collected = await collectLingxingDocumentPreview(revision.data, client, initialIssues);
    const { requests, ...suggestions } = collected;
    const archive = { schema: 'document-lingxing-preview/v1', documentId: id, documentVersion: input.expectedVersion, operationId: input.operationId, actorId, fetchedAt: new Date().toISOString(), revisionDigest: documentDigest(revision.data), suggestions, requests, attempts };
    let result: Record<string, unknown> = {};
    await publishReportFile({ bytes: Buffer.from(JSON.stringify(archive)), originalName: `lingxing-document-${id}-${input.operationId}.json`, mimeType: 'application/json', createdBy: actorId }, async (saved) => {
      result = await documentOperation(actorId, input.operationId, PREVIEW_ACTION, operationInput, async (tx) => {
        // A document may have changed while network requests were running. The
        // result remains a reviewable archive tied to its original version;
        // apply will reject it until a fresh preview is made.
        await tx.insert(fileIndex).values(saved);
        const preview = documentLingxingPreviewSchema.parse({ documentId: id, documentVersion: input.expectedVersion, operationId: input.operationId, ...suggestions, sourceFileId: saved.id });
        return { documentId: id, preview };
      });
      if (result.replayed) throw new BatchError('DOCUMENT_LINGXING_REPLAY', 409, '该领星预览已保存。');
    }).catch((error: unknown) => { if (!(error instanceof BatchError) || error.code !== 'DOCUMENT_LINGXING_REPLAY') throw error; });
    return result;
  });
}
export function assertLingxingPreviewScope(preview: DocumentLingxingPreview, id: string, version: number, data: DocumentRevisionData) {
  if (preview.documentId !== id || preview.documentVersion !== version) throw new BatchError('PREVIEW_CONFLICT', 409, '领星预览不属于当前单据版本，请重新查询。');
  const expected = documentLingxingProducts(data).map(identityKey).sort(), actual = preview.products.map(identityKey).sort();
  if (documentDigest(expected) !== documentDigest(actual)) throw new BatchError('PREVIEW_CONFLICT', 409, '预览商品范围与当前完整商品身份不一致。');
}
/** Facts are rebuilt from the verified server archive, including explicit missing values. */
export function documentLingxingSourceFacts(preview: DocumentLingxingPreview, provenance: { sourceFileId: string; sourceSha256: string; fetchedAt: string }): DocumentProductSourceFact[] {
  return preview.products.map((product) => {
    const salesPrice = scalar(product.data.salesPrice), currency = scalar(product.data.currency).toUpperCase();
    const unitPrice = calculateInvoiceUnitPrice(salesPrice), carton = scalar(product.data.cartonQuantity);
    const cartonQuantity = /^\d+$/.test(carton) && BigInt(carton) > 0n && BigInt(carton) <= BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(carton).toString() : null;
    return { sid: product.sid, msku: product.msku, fnsku: product.fnsku, sku: product.sku,
      salesPrice: salesPrice || null, currency: currency || null, unitPrice, cartonQuantity, ...provenance };
  });
}
async function attachDerivedProfile(tx: BatchTx, actorId: string, input: ApplyInput, data: DocumentRevisionData, category: 'product', key: string, values: Record<string, unknown>, existing?: typeof documentProfiles.$inferSelect) {
  const profile = await writeDocumentProfileInTx(tx, actorId, { operationId: input.operationId, category, key, data: values, reason: input.reason, ...(existing ? { expectedVersion: existing.version } : {}) });
  const next = { category, profileId: profile.id, version: profile.version, data: profile.data };
  const index = data.profileReferences.findIndex((reference) => reference.profileId === profile.id);
  if (index < 0) data.profileReferences.push(next); else data.profileReferences[index] = next;
}
export async function applyDocumentLingxing(id: string, actorId: string, input: ApplyInput) {
  return documentOperation(actorId, input.operationId, 'document.lingxing.apply', { id, ...input }, async (tx) => {
    const { record, revision } = await writableDocument(tx, id, actorId, input.expectedVersion);
    const [operation] = await tx.select().from(batchOperations).where(eq(batchOperations.operationId, input.previewOperationId));
    if (!operation || operation.actorId !== actorId || operation.action !== PREVIEW_ACTION) throw new BatchError('PREVIEW_CONFLICT', 409, '领星预览不存在或不属于当前操作人。');
    const preview = documentLingxingPreviewSchema.parse(operation.result.preview);
    assertLingxingPreviewScope(preview, id, record.version, revision.data);
    const [source] = await tx.select().from(fileIndex).where(eq(fileIndex.id, preview.sourceFileId));
    if (!source) throw new BatchError('FILE_UNAVAILABLE', 503, '领星预览原始响应归档缺失。');
    const archive = object(JSON.parse((await checkedFileBytes(source)).toString('utf8')));
    if (!archive || archive.actorId !== actorId || archive.documentId !== id || archive.operationId !== input.previewOperationId || archive.revisionDigest !== documentDigest(revision.data)
      || documentDigest(archive.suggestions) !== documentDigest({ products: preview.products, fields: preview.fields, parties: preview.parties, issues: preview.issues })) throw new BatchError('PREVIEW_CONFLICT', 409, '领星预览归档与单据或保存结果不一致，请重新查询。');
    const data = structuredClone(revision.data), issues: DocumentLingxingIssue[] = []; let appliedProducts = 0;
    const fetchedAt = z.iso.datetime().safeParse(archive.fetchedAt);
    if (!fetchedAt.success) throw new BatchError('PREVIEW_CONFLICT', 409, '领星预览缺少有效取数时间，请重新查询。');
    const provenance = { system: 'lingxing', sourceFileId: source.id, sourceSha256: source.sha256, previewOperationId: input.previewOperationId, documentId: id, documentVersion: record.version, fetchedAt: fetchedAt.data };
    data.generationRulesVersion = 'v2';
    data.productSourceFacts = documentLingxingSourceFacts(preview, { sourceFileId: source.id, sourceSha256: source.sha256, fetchedAt: fetchedAt.data });
    const productProfiles = await tx.select().from(documentProfiles).where(eq(documentProfiles.category, 'product'));
    for (const suggestion of [...preview.products].sort((a, b) => identityKey(a).localeCompare(identityKey(b)))) {
      if (!documentUsesProfileReference(data, { category: 'product', profileId: input.previewOperationId, version: 1,
        data: { sid: suggestion.sid, msku: suggestion.msku, fnsku: suggestion.fnsku, sku: suggestion.sku } })) continue;
      const references = data.profileReferences.filter((reference) => reference.category === 'product' && sameLingxingProduct(suggestion, reference.data));
      const profiles = productProfiles.filter((profile) => profile.status === 'active'), matches = profiles.filter((profile) => sameLingxingProduct(suggestion, profile.data));
      if (references.length > 1 || !references.length && matches.length > 1) { issues.push({ code: 'DOCUMENT_PRODUCT_AMBIGUOUS', message: `商品 ${suggestion.sku} 有多份相同完整身份档案，请人工选择。` }); continue; }
      const reference = references[0], existing = reference ? profiles.find((profile) => profile.id === reference.profileId) : matches[0];
      if (reference && (!existing || existing.version !== reference.version || documentDigest(existing.data) !== documentDigest(reference.data))) throw new BatchError('VERSION_CONFLICT', 409, '本票商品档案已有更新，请重新选择后查询领星。');
      const key = existing?.key ?? `lingxing-product:${documentProductOverrideKey(suggestion.sid, suggestion)}`;
      if (!existing && productProfiles.some((profile) => profile.key === key)) { issues.push({ code: 'DOCUMENT_PROFILE_RETIRED', message: `商品 ${suggestion.sku} 的领星派生档案已停用，请人工处理。` }); continue; }
      const values = mergeLingxingProduct(existing?.data ?? {}, suggestion, true);
      if (!Object.keys(values).some((key) => productFields.has(key) && !blank(values[key]))) continue;
      const priorSources = Array.isArray(values._lingxingSources) ? values._lingxingSources : [];
      values._lingxingSources = [...priorSources, { ...provenance, identity: { sid: suggestion.sid, msku: suggestion.msku, fnsku: suggestion.fnsku, sku: suggestion.sku } }];
      await attachDerivedProfile(tx, actorId, input, data, 'product', key, values, existing); appliedProducts++;
    }
    const allowedFields = new Set(['currency', 'battery', 'magnetic', 'liquid', 'powder', 'dangerous']);
    const first = data.members[0]!;
    for (const [key, value] of Object.entries(preview.fields)) if (allowedFields.has(key) && blank(data.fields[key]) && !blank(value)) data.fields[key] = value;
    const address = resolveDocumentLingxingAddress(data.members);
    if (address && data.fields.addressSelectionMode !== 'manual') {
      data.fields = { ...applyDocumentAddress(data.fields, address), addressSelectionMode: 'lingxing', addressSourceLabel: '领星货件地址' };
      data.profileReferences = data.profileReferences.filter((reference) => reference.category !== 'address');
    }
    if (!data.profileReferences.some((reference) => reference.category === 'channel')) {
      const profiles = await tx.select().from(documentProfiles).where(and(eq(documentProfiles.category, 'channel'), eq(documentProfiles.status, 'active'))).for('share');
      const matches = profiles.filter((profile) => scalar(profile.data.businessChannel ?? profile.data.channel) === first.demand.snapshot.channel
        && (blank(profile.data.sid) || Number(profile.data.sid) === first.demand.snapshot.sid)
        && (blank(profile.data.country) || scalar(profile.data.country) === first.demand.snapshot.country));
      if (matches.length === 1) {
        const profile = matches[0]!, allowed = Array.isArray(profile.data.allowedServices) ? profile.data.allowedServices.map(scalar).filter(Boolean) : [scalar(profile.data.service)].filter(Boolean);
        data.profileReferences.push({ category: 'channel', profileId: profile.id, version: profile.version, data: profile.data });
        if (blank(data.fields.service) && allowed.length === 1) data.fields.service = allowed[0]!;
      }
    }
    if (!data.templateReference) {
      const templates = await tx.select().from(documentTemplates).where(and(eq(documentTemplates.purpose, data.purpose), eq(documentTemplates.status, 'active'))).for('share');
      if (templates.length === 1) {
        const template = templates[0]!, [version] = await tx.select().from(documentTemplateVersions).where(and(eq(documentTemplateVersions.templateId, template.id), eq(documentTemplateVersions.version, template.version)));
        if (version) data.templateReference = { templateId: template.id, version: version.version, fileId: version.fileId, sha256: version.sha256 };
      }
    }
    // Subject names are candidates only. Neither subjects nor country/product
    // defaults are evidence for VAT, tax mode or a party binding.
    data.fields = reviseDocumentProductFields(revision.data, data, undefined, true);
    return { documentId: id, document: await appendDocumentRevisionInTx(tx, id, record.version + 1, data, actorId, input.reason), appliedProducts, issues };
  });
}
