import { createHash } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { sellerExportCodeInputSchema, type SellerExportCodeInput } from '@scm/contracts';
import { db } from '../../db/client.js';
import { operationAudit, sellerExportCodes, sellerMappings } from '../../db/schema.js';
import { activeSeller, getCatalogState, requireCatalogActor } from './catalog.js';
import { MappingError } from './service.js';

export async function listSellerExportCodes(actorId: string) {
  return db.transaction(async (tx) => {
    await requireCatalogActor(tx, actorId);
    const catalog = await getCatalogState(tx);
    const rows = await tx.select({ seller: sellerMappings, setting: sellerExportCodes }).from(sellerMappings)
      .leftJoin(sellerExportCodes, eq(sellerMappings.sid, sellerExportCodes.sid)).orderBy(asc(sellerMappings.sid));
    return { items: rows.map(({ seller, setting }) => {
      const identity = activeSeller(seller, catalog.mode) ?? seller;
      return { sid: seller.sid, name: identity.name, country: identity.country,
        code: setting?.code ?? '', version: setting?.version ?? 0 };
    }) };
  });
}

export async function saveSellerExportCode(sid: number, raw: SellerExportCodeInput, actorId: string) {
  const input = sellerExportCodeInputSchema.parse(raw);
  const hash = createHash('sha256').update(JSON.stringify({ sid, ...input })).digest('hex');
  return db.transaction(async (tx) => {
    await requireCatalogActor(tx, actorId);
    const [seller] = await tx.select().from(sellerMappings).where(eq(sellerMappings.sid, sid)).for('update');
    if (!seller) throw new MappingError('NOT_FOUND', 404, '店铺不存在，请刷新列表。');
    const [previous] = await tx.select().from(operationAudit).where(eq(operationAudit.id, input.operationId));
    if (previous) {
      if (previous.actorUserId !== actorId || previous.action !== 'seller_export_code.save' || previous.requestHash !== hash) throw new MappingError('OPERATION_CONFLICT', 409, '操作编号已用于其他请求。');
      return { code: previous.details.code!, version: Number(previous.details.version) };
    }
    const [current] = await tx.select().from(sellerExportCodes).where(eq(sellerExportCodes.sid, sid));
    if ((current?.version ?? 0) !== input.expectedVersion) throw new MappingError('VERSION_CONFLICT', 409, '代号已被修改，请刷新并核对后保存。');
    const version = (current?.version ?? 0) + 1;
    await tx.insert(sellerExportCodes).values({ sid, code: input.code, version, updatedBy: actorId })
      .onConflictDoUpdate({ target: sellerExportCodes.sid, set: { code: input.code, version, updatedBy: actorId, updatedAt: new Date() } });
    await tx.insert(operationAudit).values({ id: input.operationId, action: 'seller_export_code.save', targetId: seller.id,
      actorUserId: actorId, requestHash: hash, details: { sid: String(sid), before: current?.code ?? '', code: input.code, version: String(version) } });
    return { code: input.code, version };
  });
}

/** Read once per generation; archived downloads never consult mutable settings. */
export async function readSellerExportCodes(sids: number[]) {
  const unique = [...new Set(sids)];
  if (!unique.length) return new Map<number, string>();
  const rows = await db.select().from(sellerExportCodes).where(inArray(sellerExportCodes.sid, unique));
  return new Map(rows.map((row) => [row.sid, row.code]));
}
