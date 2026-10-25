import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { readConfig } from '../../config.js';
import { closeDatabase, db } from '../../db/client.js';
import { fileIndex, operationAudit, sellerMappings, user } from '../../db/schema.js';
import { storeImmutableFile } from '../../file-store.js';
import { logError } from '../../errors.js';

const catalogSchema = z.object({
  ok: z.literal(true), httpStatus: z.literal(200), path: z.literal('/erp/sc/data/seller/lists'),
  response: z.object({ code: z.literal(0), response_time: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    data: z.array(z.object({ sid: z.number().int().positive(), name: z.string().trim().min(1), country: z.string().trim().min(1),
      marketplace_id: z.string().min(1).nullable().optional() })).min(1).max(10000) }),
});

try {
  const { values } = parseArgs({ options: { source: { type: 'string' }, actor: { type: 'string' } } });
  if (!values.source || !values.actor) throw new Error('Provide --source <raw seller snapshot> --actor <admin user ID>');
  const bytes = await readFile(values.source);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Catalog is too large');
  const raw: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  // Accept only a real successful read snapshot; report summaries and demo fixtures are not catalogs.
  const parsed = catalogSchema.parse(raw);
  const sellers = parsed.response.data;
  if (new Set(sellers.map((seller) => seller.sid)).size !== sellers.length) throw new Error('Duplicate sid in catalog');
  const observedAt = new Date(parsed.response.response_time.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(observedAt.getTime())) throw new Error('Invalid source time');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const actorId = values.actor;
  const runId = randomUUID();
  let inserted = 0;
  let alreadyArchived = false;
  // The immutable file helper compensates file creation if the entire transaction fails.
  await storeImmutableFile(readConfig().dataDir, { bytes, originalName: basename(values.source), mimeType: 'application/json', createdBy: actorId }, async (record) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('seller-catalog-seed', 0))`);
      const [actor] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
      if (!actor || actor.banned || actor.role !== 'admin') throw new Error('Active administrator is required');
      const [previous] = await tx.select().from(fileIndex).where(eq(fileIndex.sha256, sha256)).limit(1);
      if (previous) {
        alreadyArchived = true;
        // Throw a private sentinel so the extra filesystem copy is compensated.
        throw new Error('CATALOG_ALREADY_ARCHIVED');
      }
      await tx.insert(fileIndex).values(record);
      const rows = await tx.insert(sellerMappings).values(sellers.map((seller) => ({ id: randomUUID(), sid: seller.sid,
        name: seller.name, country: seller.country, marketplaceId: seller.marketplace_id ?? null,
        status: 'candidate', sourceObservedAt: observedAt, sourceSha256: sha256, sourceFileId: record.id })))
        .onConflictDoNothing({ target: sellerMappings.sid }).returning({ id: sellerMappings.id });
      inserted = rows.length;
      await tx.insert(operationAudit).values({ id: runId, action: 'seller_mapping.seed_candidates', targetId: record.id,
        actorUserId: actorId, requestHash: sha256, details: { inserted: String(inserted), skippedExisting: String(sellers.length - inserted), sourceSha256: sha256 } });
    });
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'CATALOG_ALREADY_ARCHIVED') return;
    throw error;
  });
  console.log(JSON.stringify({ result: 'passed', candidateCount: sellers.length, inserted, alreadyArchived, sha256, externalRequests: 0 }));
} catch (error) {
  logError('Seller catalog seed failed; existing mappings preserved', error);
  process.exitCode = 1;
} finally { await closeDatabase(); }
