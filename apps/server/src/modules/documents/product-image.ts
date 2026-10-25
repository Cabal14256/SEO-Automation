import { eq, and, sql } from 'drizzle-orm';
import { documentProductImagePreviewInputSchema } from '@scm/contracts';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import { BatchError } from '../batches/service.js';
import { documentExports } from './schema.js';
import { lockedDocument } from './service.js';
import { downloadLingxingImage } from './lingxing-image.js';

type Input = z.infer<typeof documentProductImagePreviewInputSchema>;
async function assertImagePreviewScope(id: string, actorId: string, input: Input) {
  await db.transaction(async (tx) => {
    const { record, revision } = await lockedDocument(tx, id, actorId, input.expectedVersion);
    if (['cancelled', 'superseded'].includes(record.status)) throw new BatchError('DOCUMENT_READ_ONLY', 409, '已取消或被替代的单据不能补充图片。');
    const [file] = await tx.select({ id: documentExports.id }).from(documentExports).where(and(eq(documentExports.status, 'completed'), sql`${documentExports.reference}->>'documentId' = ${id}`)).limit(1);
    if (file) throw new BatchError('DOCUMENT_CORRECTION_REQUIRED', 409, '已有文件的发票请先通过更正建立新单据，再补充图片。');
    const matches = revision.data.members.some((member) => member.demand.snapshot.sid === input.sid && member.shipment.data.items.some((item) => item.msku === input.msku && item.fnsku === input.fnsku && item.sku === input.sku));
    if (!matches) throw new BatchError('DOCUMENT_PRODUCT_SCOPE_MISMATCH', 422, '图片只能用于当前单据中完整身份匹配的商品。');
  });
}

/** Read-only preview; saving its bytes requires an explicit document revision. */
export async function previewDocumentProductImage(id: string, actorId: string, input: Input) {
  await assertImagePreviewScope(id, actorId, input);
  let image: Awaited<ReturnType<typeof downloadLingxingImage>>;
  try { image = await downloadLingxingImage(input.url); }
  catch (error) { throw new BatchError('DOCUMENT_IMAGE_PREVIEW_FAILED', 422, error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : '无法获取图片，请检查公开HTTPS地址、网络或图片大小和格式。'); }
  await assertImagePreviewScope(id, actorId, input);
  return { image };
}
