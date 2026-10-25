import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';
import type { WorkflowContext, WorkflowRecord } from '@scm/contracts';
import { db } from '../../db/client.js';
import { demandSources, fileIndex, sourceImports } from '../../db/schema.js';
import { BatchError } from '../batches/service.js';
import { batchExports } from '../batches/export-schema.js';
import { documentExports } from '../documents/schema.js';
import { batchSyncSnapshots } from '../lingxing/sync-schema.js';
import { physicalExports, physicalSyncSnapshots } from '../physical/schema.js';
import { checkedFileBytes } from '../imports/service.js';
import { workflowRevisions } from '../workflow/schema.js';
import { formatSheet } from './workbook.js';

export async function renderArchivePackage(record: WorkflowRecord, context: WorkflowContext) {
  const scope = new Set(record.boxIds), peers = context.records.filter((peer) => peer.id !== record.id && peer.boxIds.some((box) => scope.has(box)));
  const relatedIds = new Set([record.id, ...peers.map((peer) => peer.id)]);
  const fileIds = new Set([record.source.fileId, ...peers.map((peer) => peer.source.fileId), ...context.files.filter((file) => relatedIds.has(file.recordId)).map((file) => file.id), ...context.exports.filter((item) => relatedIds.has(item.recordId) && item.recordId !== record.id && item.status === 'completed' && item.fileId).map((item) => item.fileId!)]);
  const groups = [...new Set(record.source.members.map((member) => member.source.groupId))], demands = record.source.members.map((member) => member.demand.id);
  const snapshotIds = record.source.members.flatMap((member) => [...member.shipment.snapshotIds, ...member.physical?.snapshot.source.snapshotIds ?? []]);
  if (snapshotIds.length) {
    for (const table of [batchSyncSnapshots, physicalSyncSnapshots]) for (const row of await db.select({ fileId: table.fileId }).from(table).where(inArray(table.id, snapshotIds))) fileIds.add(row.fileId);
  }
  if (demands.length) for (const row of await db.select({ fileId: sourceImports.fileId }).from(demandSources).innerJoin(sourceImports, eq(sourceImports.id, demandSources.importId)).where(inArray(demandSources.demandId, demands))) fileIds.add(row.fileId);
  for (const groupId of groups) {
    for (const row of await db.select({ fileId: batchExports.fileId }).from(batchExports).where(and(eq(batchExports.status, 'completed'), sql`${batchExports.groupIds} @> ${JSON.stringify([groupId])}::jsonb`))) if (row.fileId) fileIds.add(row.fileId);
    for (const row of await db.select({ fileId: physicalExports.fileId }).from(physicalExports).where(and(eq(physicalExports.status, 'completed'), sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${physicalExports.references}) r WHERE r->>'groupId' = ${groupId})`))) if (row.fileId) fileIds.add(row.fileId);
  }
  for (const documentId of new Set([record.source.documentId, ...peers.map((peer) => peer.source.documentId)])) for (const row of await db.select({ fileId: documentExports.fileId }).from(documentExports).where(and(eq(documentExports.status, 'completed'), sql`${documentExports.reference}->>'documentId' = ${documentId}`))) if (row.fileId) fileIds.add(row.fileId);
  const indexed = await db.select().from(fileIndex).where(inArray(fileIndex.id, [...fileIds])).orderBy(fileIndex.id);
  if (indexed.length !== fileIds.size) throw new BatchError('ARCHIVE_FILE_MISSING', 503, '归档关联文件索引缺失。');
  if (indexed.reduce((sum, file) => sum + file.byteSize, 0) > 256 * 1024 * 1024) throw new BatchError('ARCHIVE_TOO_LARGE', 422, '归档文件超过256 MiB，请按批次拆分处理。');
  const zipped: Record<string, Uint8Array> = {}, entries: Array<{ fileId: string; path: string; name: string; sha256: string; byteSize: number }> = [];
  for (const file of indexed) {
    const bytes = await checkedFileBytes(file), safeName = Array.from(file.originalName).map((char) => char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char).join('').slice(0, 180), path = `files/${file.id}-${safeName}`;
    zipped[path] = new Uint8Array(bytes); entries.push({ fileId: file.id, path, name: file.originalName, sha256: file.sha256, byteSize: file.byteSize });
  }
  const history = await db.select().from(workflowRevisions).where(inArray(workflowRevisions.recordId, [...relatedIds])).orderBy(workflowRevisions.createdAt, workflowRevisions.id);
  const manifest = { format: 'scm-batch-archive/v1', createdAt: new Date().toISOString(), businessTimezone: 'Asia/Shanghai', record, records: peers, history, files: entries, externalOperations: 'manual-evidence-only' };
  const json = Buffer.from(JSON.stringify(manifest, null, 2)); zipped['manifest.json'] = json;
  zipped['manifest.sha256'] = Buffer.from(createHash('sha256').update(json).digest('hex'));
  const workbook = new ExcelJS.Workbook(), files = workbook.addWorksheet('文件清单');
  files.addRow(['文件ID', '文件名', '大小', 'SHA-256', '归档路径']); for (const entry of entries) files.addRow([entry.fileId, entry.name, entry.byteSize, entry.sha256, entry.path]); formatSheet(files);
  const relations = workbook.addWorksheet('业务关联'); relations.addRow(['模块', '记录ID', '名称', '版本', '状态', 'M4单据', '内部箱范围']);
  for (const peer of [record, ...peers]) relations.addRow([peer.kind, peer.id, peer.title, peer.version, peer.status, peer.source.documentId, peer.boxIds.join(',')]); formatSheet(relations);
  zipped['归档清单.xlsx'] = new Uint8Array(await workbook.xlsx.writeBuffer());
  return { bytes: Buffer.from(zipSync(zipped, { level: 6 })), name: `批次归档-${record.id.slice(0, 8)}.zip`, mimeType: 'application/zip' };
}
