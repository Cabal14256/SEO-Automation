import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { and, eq } from 'drizzle-orm';
import type { DocumentProfile, DocumentProfileCategory } from '@scm/contracts';
import { documentAddressDataSchema, documentProfileCategorySchema, documentProfileWriteSchema } from '@scm/contracts';
import { db } from '../../db/client.js';
import { fileIndex } from '../../db/schema.js';
import { BatchError } from '../batches/service.js';
import { batchOperations } from '../batches/schema.js';
import { publishReportFile } from '../batches/report-service.js';
import { checkedFileBytes } from '../imports/service.js';
import { validateImportArchive } from '../imports/zip-preflight.js';
import { documentDigest } from './domain.js';
import { documentProfiles } from './schema.js';
import { documentProfileImports } from './profile-import-schema.js';
import { documentOperation, writeDocumentProfileInTx } from './service.js';

type Row = { row: number; category: DocumentProfileCategory; key: string; expectedVersion?: number; data: Record<string, unknown>; errors: string[]; changes: string[] };
const shared = ['资料类别', '资料键', '预期版本'];
export const PROFILE_IMPORT_FIELDS = ['sid', 'msku', 'fnsku', 'sku', 'englishName', 'chineseName', 'unitPrice', 'unitPriceConfirmed', 'material', 'hsCode', 'use', 'brand', 'model', 'unit', 'currency', 'salesLink', 'imageBase64', 'imageExtension',
  'service', 'addressCode', 'recipientName', 'recipientCompany', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'state', 'postalCode', 'countryCode', 'phone', 'email', 'deliveryStation', 'battery', 'magnetic', 'liquid', 'powder', 'dangerous', 'customsMode', 'clearanceMode', 'taxMode', 'tradeTerms', 'vat', 'reference', 'remarks', 'deliveryWindow', 'partyName', 'taxId',
  'companyName', 'taxNumber', 'address', 'contact', 'destinationFc', 'channel', 'businessChannel', 'fc', 'country'] as const;
export async function createProfileImportTemplate() {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('单据资料');
  sheet.addRow([...shared, ...PROFILE_IMPORT_FIELDS]);
  sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }];
  sheet.columns.forEach((column, index) => { column.width = index < 3 ? 16 : 24; });
  return Buffer.from(await book.xlsx.writeBuffer());
}
export async function parseProfileImport(bytes: Buffer, existing: DocumentProfile[] = []): Promise<Row[]> {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new BatchError('FILE_TOO_LARGE', 422, '资料文件不能为空且不能超过 10 MiB。');
  await validateImportArchive(bytes);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.getWorksheet('单据资料');
  if (!sheet || book.worksheets.length !== 1 || sheet.rowCount > 1001 || sheet.columnCount > shared.length + PROFILE_IMPORT_FIELDS.length) throw new BatchError('INVALID_WORKBOOK', 422, '请使用系统单据资料模板，单次最多 1000 条资料。');
  const headers = [...shared, ...PROFILE_IMPORT_FIELDS];
  headers.forEach((header, index) => { if (sheet.getCell(1, index + 1).text !== header) throw new BatchError('INVALID_WORKBOOK', 422, `第 ${index + 1} 列应为 ${header}。`); });
  const rows: Row[] = [], seen = new Set<string>();
  for (let row = 2; row <= sheet.rowCount; row++) {
    if (sheet.getRow(row).actualCellCount === 0) continue;
    const errors: string[] = [], cell = (column: number) => {
      const value = sheet.getCell(row, column).value;
      if (typeof value === 'object' && value !== null) { errors.push(`第 ${column} 列不接受公式、链接对象或其他非值内容`); return ''; }
      return value === null || value === undefined ? '' : String(value).trim();
    };
    const categoryValue = cell(1), parsedCategory = documentProfileCategorySchema.safeParse(categoryValue), category = parsedCategory.success ? parsedCategory.data : 'product';
    if (!parsedCategory.success) errors.push('资料类别须为 product、party、address、channel 或 tax');
    const key = cell(2), rawVersion = cell(3), expectedVersion = rawVersion ? Number(rawVersion) : undefined;
    if (!key || key.length > 200) errors.push('资料键不能为空且不得超过 200 字');
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) errors.push('预期版本须为正整数');
    const identity = `${category}:${key}`; if (seen.has(identity)) errors.push('同一批文件含重复类别及资料键'); seen.add(identity);
    const data: Record<string, unknown> = {};
    PROFILE_IMPORT_FIELDS.forEach((field, index) => { const value = cell(index + 4); if (value) data[field] = value; });
    if (!Object.keys(data).length) errors.push('资料内容不能为空');
    if (category === 'address') {
      const parsedAddress = documentAddressDataSchema.safeParse(data);
      if (!parsedAddress.success) errors.push(...parsedAddress.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`));
    }
    const old = existing.find((profile) => profile.category === category && profile.key === key);
    if (category === 'address' && old?.status === 'retired') errors.push('地址已删除，请先在地址簿恢复后编辑');
    if (old && expectedVersion !== old.version || !old && expectedVersion !== undefined) errors.push('预期版本与当前档案不一致，请核对后重新预检');
    const changes = Object.keys({ ...old?.data, ...data }).filter((field) => documentDigest(old?.data[field] ?? null) !== documentDigest(data[field] ?? null));
    rows.push({ row, category, key, ...(expectedVersion ? { expectedVersion } : {}), data, errors, changes });
  }
  if (!rows.length) throw new BatchError('INVALID_WORKBOOK', 422, '资料文件没有有效数据行。');
  return rows;
}
export async function previewProfileImport(actorId: string, operationId: string, bytes: Buffer, fileName: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex'), input = { sha256 }, action = 'document.profile.import.preview';
  const [prior] = await db.select().from(batchOperations).where(eq(batchOperations.operationId, operationId));
  if (prior) {
    if (prior.actorId !== actorId || prior.requestHash !== documentDigest({ action, input })) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他文件。');
    return { ...prior.result, replayed: true };
  }
  let result: Record<string, unknown> = {};
  await publishReportFile({ bytes, originalName: fileName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: actorId }, async (saved) => {
    result = await documentOperation(actorId, operationId, action, input, async (tx) => {
      const existing = await tx.select().from(documentProfiles), rows = await parseProfileImport(bytes, existing.map((profile) => ({ ...profile, status: profile.status as DocumentProfile['status'], createdAt: profile.createdAt.toISOString() })));
      const previewId = randomUUID(); await tx.insert(fileIndex).values(saved);
      await tx.insert(documentProfileImports).values({ id: previewId, actorId, fileId: saved.id, sha256, rows });
      return { previewId, sha256, rows, valid: rows.every((row) => row.errors.length === 0) };
    });
    if (result.replayed) throw new BatchError('PROFILE_IMPORT_REPLAY', 409, '资料预检已保存。');
  }).catch((error: unknown) => { if (!(error instanceof BatchError) || error.code !== 'PROFILE_IMPORT_REPLAY') throw error; });
  return result;
}
export async function commitProfileImport(actorId: string, input: { operationId: string; previewId: string; sha256: string; reason: string }) {
  return documentOperation(actorId, input.operationId, 'document.profile.import.commit', input, async (tx) => {
    const [preview] = await tx.select().from(documentProfileImports).where(and(eq(documentProfileImports.id, input.previewId), eq(documentProfileImports.actorId, actorId))).for('update');
    if (!preview || preview.sha256 !== input.sha256) throw new BatchError('PREVIEW_CONFLICT', 409, '资料预检不存在、身份不符或文件已变化。');
    if (preview.committedAt) throw new BatchError('PREVIEW_COMMITTED', 409, '该预检已经提交，请勿重复提交。');
    const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, preview.fileId));
    if (!file) throw new BatchError('FILE_UNAVAILABLE', 503, '资料预检原件缺失。');
    const bytes = await checkedFileBytes(file);
    const existing = await tx.select().from(documentProfiles);
    const previewRows = preview.rows as Row[];
    if (previewRows.some((row) => row.errors.length > 0)) throw new BatchError('VALIDATION_BLOCKED', 422, '资料预检仍有输入错误，请修正文件后重新预检。', previewRows);
    if (previewRows.some((row) => { const current = existing.find((profile) => profile.category === row.category && profile.key === row.key); return current ? current.version !== row.expectedVersion : row.expectedVersion !== undefined; })) throw new BatchError('VERSION_CONFLICT', 409, '资料档案在预检后已变化，请重新预检并确认本批变化。');
    const rows = await parseProfileImport(bytes, existing.map((profile) => ({ ...profile, status: profile.status as DocumentProfile['status'], createdAt: profile.createdAt.toISOString() })));
    if (rows.some((row) => row.errors.length)) throw new BatchError('VALIDATION_BLOCKED', 422, '资料文件仍有输入错误，请修正后重新预检。', rows);
    const items: DocumentProfile[] = [];
    for (const row of rows.sort((a, b) => `${a.category}:${a.key}`.localeCompare(`${b.category}:${b.key}`))) items.push(await writeDocumentProfileInTx(tx, actorId, documentProfileWriteSchema.parse({ operationId: input.operationId, category: row.category, key: row.key, data: row.data, expectedVersion: row.expectedVersion, reason: input.reason })));
    await tx.update(documentProfileImports).set({ committedAt: new Date() }).where(eq(documentProfileImports.id, preview.id));
    return { previewId: preview.id, items, count: items.length };
  });
}
