import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { sellerExportCodeInputSchema } from '@scm/contracts';
import { db, closeDatabase } from './db/client.js';
import { user, sellerMappings, operationAudit } from './db/schema.js';
import { listSellerExportCodes, saveSellerExportCode, readSellerExportCodes } from './modules/seller-mappings/export-codes.js';

globalThis.fetch = async () => { throw new Error('No remote requests allowed'); };
const actor = 'export-code-test', sid = 9876501;
try {
  await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  await db.insert(user).values({ id: actor, name: 'Fixture', email: 'codes@fixture.invalid', role: 'admin' });
  await db.insert(sellerMappings).values({ id: randomUUID(), sid, name: '测试店铺', country: '美国', sourceObservedAt: new Date(), sourceSha256: 'a'.repeat(64) });
  assert.equal((await listSellerExportCodes(actor)).items[0]!.code, '');
  const input = { operationId: randomUUID(), expectedVersion: 0, code: '001' };
  assert.deepEqual(await saveSellerExportCode(sid, input, actor), { code: '001', version: 1 });
  assert.deepEqual(await saveSellerExportCode(sid, input, actor), { code: '001', version: 1 });
  await assert.rejects(saveSellerExportCode(sid, { ...input, code: '002' }, actor), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(saveSellerExportCode(sid, { ...input, operationId: randomUUID() }, actor), { code: 'VERSION_CONFLICT' });
  assert.equal((await readSellerExportCodes([sid])).get(sid), '001');
  await db.update(sellerMappings).set({ name: '重命名店铺' }).where(eq(sellerMappings.sid, sid));
  assert.equal((await listSellerExportCodes(actor)).items[0]!.code, '001');
  const outcomes = await Promise.allSettled(['002', '003'].map((code) => saveSellerExportCode(sid, { operationId: randomUUID(), expectedVersion: 1, code }, actor)));
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
  await saveSellerExportCode(sid, { operationId: randomUUID(), expectedVersion: 2, code: '' }, actor);
  assert.equal((await readSellerExportCodes([sid])).get(sid), '');
  for (const code of ['A01', '-1', '1.5', '1'.repeat(21)]) assert.equal(sellerExportCodeInputSchema.safeParse({ ...input, code }).success, false);
  await db.insert(user).values({ id: 'codes-banned', name: 'Banned', email: 'codes-banned@fixture.invalid', role: 'admin', banned: true });
  await assert.rejects(listSellerExportCodes('codes-banned'), { code: 'FORBIDDEN' });
  await assert.rejects(saveSellerExportCode(sid, { ...input, operationId: randomUUID() }, 'codes-banned'), { code: 'FORBIDDEN' });
  assert.equal((await db.select().from(operationAudit)).filter((entry) => entry.action === 'seller_export_code.save').length, 3);
  const result = { result: 'passed', checks: ['migration', 'persist-leading-zeros', 'replay', 'operation-conflict', 'stale-version', 'sid-binding-after-rename', 'concurrent-update', 'clear', 'validation', 'authorization', 'audit'], realLingxingRequests: 0 };
  await writeFile(process.env.SERVICE_MAPPING_ACCEPTANCE_OUT!, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await closeDatabase(); }
