import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { unzipSync, zipSync } from 'fflate';
import type { PgBoss } from 'pg-boss';
import { onlineImportInputSchema, type OnlineImportInput, type OnlineImportRow } from '@scm/contracts';
import { db } from '../../db/client.js';
import { getCatalogState } from '../seller-mappings/catalog.js';
import { getFbaLookup } from './fba-lookup.js';
import { createSourceImport, ImportError, replayOnlineImport, type ImportCatalogExpectation } from './service.js';

const fields = ['shop', 'channel', 'country', 'destinationFc', 'fba', 'referenceQuantity', 'sourceFilledAt', 'notes', 'destinationAddress', 'shipmentCreatedAt'] as const;
const emptyRow = (row: OnlineImportRow) => fields.every((field) => !row[field].trim());
export function canonicalOnlineRows(input: OnlineImportInput) {
  const rows = input.rows.map((row) => ({ ...row }));
  while (rows.length && emptyRow(rows[rows.length - 1]!)) rows.pop();
  if (!rows.some((row) => !emptyRow(row))) throw new ImportError('VALIDATION_ERROR', 422, '请至少填写一行需求。');
  return rows;
}
export function onlineContentHash(rows: OnlineImportRow[]) {
  return createHash('sha256').update(JSON.stringify(rows.map((row) => fields.map((field) => row[field]).concat([row.lookupId ?? '', String(row.lookupSid ?? '')])))).digest('hex');
}
type Evidence = { source: string; observedAt: string };
const identityText = (value: string) => value.normalize('NFKC').trim().toLowerCase();
export async function buildOnlineWorkbook(rows: OnlineImportRow[], evidence: Map<number, Evidence> = new Map()) {
  const workbook = new ExcelJS.Workbook();
  const fixedTime = new Date('2000-01-01T00:00:00.000Z');
  workbook.creator = 'SCM Automation'; workbook.created = fixedTime; workbook.modified = fixedTime;
  const sheet = workbook.addWorksheet('在线需求导入', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow(['店铺', '渠道', '国家', '目的FC', 'FBA货件号', '参考数量', '来源填写时间', '子批次名称', '备注', '仓库地址', '货件创建时间', '元数据来源', '查询时间']);
  rows.forEach((row, index) => {
    if (emptyRow(row)) { sheet.addRow([]); return; }
    const source = evidence.get(index);
    // Always write strings: pasted formulas and identifiers must remain literal source values.
    sheet.addRow([row.shop, row.channel, row.country, row.destinationFc, row.fba, row.referenceQuantity, row.sourceFilledAt, '', row.notes,
      row.destinationAddress, row.shipmentCreatedAt, source?.source ?? 'online', source?.observedAt ?? '']);
  });
  sheet.columns.forEach((column) => { column.width = 22; column.numFmt = '@'; });
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: 'A1', to: 'M1' };
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  // ZIP member timestamps are not business data. Fix them so equal input/evidence
  // produces equal source hashes, including retries in a later process.
  return Buffer.from(zipSync(unzipSync(bytes), { mtime: fixedTime }));
}

export async function createOnlineImport(boss: PgBoss, input: OnlineImportInput, actorId: string) {
  const parsed = onlineImportInputSchema.safeParse(input);
  if (!parsed.success) throw new ImportError('VALIDATION_ERROR', 422, '在线表格格式无效，请检查行数和字段长度。', parsed.error.flatten());
  const rows = canonicalOnlineRows(parsed.data);
  const fingerprint = onlineContentHash(rows);
  const previous = await replayOnlineImport(input.operationId, fingerprint, actorId);
  if (previous) return previous;
  const evidence = new Map<number, Evidence>();
  let catalogSnapshot: ImportCatalogExpectation | undefined;
  for (const [index, row] of rows.entries()) {
    if (Boolean(row.lookupId) !== (row.lookupSid !== undefined)) throw new ImportError('LOOKUP_CANDIDATE_INVALID', 422, `第 ${index + 1} 行的查询来源和店铺候选必须一起提供。`);
  }
  const lookupIds = [...new Set(rows.flatMap((row) => row.lookupId ? [row.lookupId] : []))];
  if (lookupIds.length) {
    const catalog = await db.transaction((tx) => getCatalogState(tx));
    catalogSnapshot = { mode: catalog.mode, version: catalog.version, catalogVersion: catalog.catalogVersion };
    const lookups = new Map(await Promise.all(lookupIds.map(async (id) => [id, await getFbaLookup(id, actorId)] as const)));
    for (const [index, row] of rows.entries()) {
      if (!row.lookupId) continue;
      const lookup = lookups.get(row.lookupId)!;
      if (lookup.status !== 'completed') throw new ImportError('LOOKUP_INCOMPLETE', 422, `第 ${index + 1} 行的 FBA 查询尚未成功完成。`);
      if (lookup.catalogMode !== catalog.mode || lookup.catalogSettingsVersion !== catalog.version || lookup.catalogVersion !== catalog.catalogVersion) throw new ImportError('CATALOG_VERSION_CONFLICT', 409, '店铺目录已变化，请重新查询补全后提交。');
      const match = lookup.rows.find((item) => item.fba === row.fba.trim().toUpperCase());
      const candidate = match?.candidates.find((item) => item.sid === row.lookupSid);
      if (!candidate) throw new ImportError('LOOKUP_CANDIDATE_INVALID', 422, `第 ${index + 1} 行需重新选择 FBA 查询候选。`);
      if (identityText(row.shop) !== identityText(candidate.shop)) throw new ImportError('LOOKUP_SHOP_MISMATCH', 422, `第 ${index + 1} 行的店铺与查询候选不一致，请重新查询或清除查询来源后手工填写。`);
      const remoteFields = [identityText(row.country) === identityText(candidate.country), row.destinationFc.trim() === (candidate.destinationFc ?? ''),
        row.destinationAddress.trim() === (candidate.destinationAddress ?? ''), row.shipmentCreatedAt.trim() === (candidate.shipmentCreatedAt ?? ''),
        row.channel.trim() === (candidate.channel ?? '') || (candidate.channelOptions ?? []).some((option) => option.name === row.channel.trim())];
      evidence.set(index, { source: `${remoteFields.every(Boolean) ? 'lingxing' : 'online+lingxing'}:${lookup.id}:sid=${candidate.sid}`, observedAt: candidate.observedAt });
    }
  }
  const bytes = await buildOnlineWorkbook(rows, evidence);
  // The source service checks replay, then locks this catalog expectation inside
  // its own transaction. Do not hold another pool connection around that save.
  return createSourceImport(boss, { bytes, operationId: input.operationId, actorUserId: actorId,
    originalName: '在线填写快照.xlsx', sourceType: 'online', requestFingerprint: fingerprint, expectedCatalog: catalogSnapshot });
}
