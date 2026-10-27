import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { fileIndex } from '../../db/schema.js';
import { BatchError, requireBatchActor } from '../batches/service.js';
import { publishReportFile } from '../batches/report-service.js';
import { checkedFileBytes } from '../imports/service.js';
import { lockedWorkflow, workflowOperation } from './service.js';
import { workflowAttachments, workflowExports, workflowRecords } from './schema.js';
import { requireWorkflowAvailable } from './maintenance.js';

export async function attachWorkflowFile(actorId: string, input: { recordId: string; operationId: string; purpose: string; bytes: Buffer; name: string; mimeType: string }) {
  // Check before staging bytes or replaying an earlier attachment operation.
  await db.transaction((tx) => lockedWorkflow(tx, input.recordId, actorId));
  if (!input.bytes.length || input.bytes.length > 10 * 1024 * 1024) throw new BatchError('INVALID_FILE_SIZE', 422, '附件必须为非空且不超过10 MiB。');
  if (!/\.(?:pdf|png|jpe?g|xlsx?|docx|zip|txt|csv)$/i.test(input.name)) throw new BatchError('INVALID_FILE_TYPE', 422, '请上传PDF、图片、表格、Word、ZIP或文本资料。');
  const pdf = input.bytes.subarray(0, 5).toString('ascii') === '%PDF-', png = input.bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), jpeg = input.bytes[0] === 255 && input.bytes[1] === 216 && input.bytes[2] === 255;
  if ((/\.pdf$/i.test(input.name) || input.mimeType === 'application/pdf') && !pdf || (/\.png$/i.test(input.name) || input.mimeType === 'image/png') && !png || (/\.jpe?g$/i.test(input.name) || input.mimeType === 'image/jpeg') && !jpeg) throw new BatchError('INVALID_FILE_CONTENT', 422, '文件内容与PDF或图片格式不符，请提供原始文件。');
  const mimeType = pdf ? 'application/pdf' : png ? 'image/png' : jpeg ? 'image/jpeg' : input.mimeType;
  let result: { file: { id: string; recordId: string; purpose: string; name: string; mimeType: string; sha256: string; byteSize: number }; replayed: boolean } | undefined;
  try {
    await publishReportFile({ bytes: input.bytes, originalName: input.name, mimeType, createdBy: actorId }, async (file) => {
      result = await workflowOperation(actorId, input.operationId, 'workflow.file.attach', { recordId: input.recordId, purpose: input.purpose, name: input.name, mimeType, sha256: createHash('sha256').update(input.bytes).digest('hex') }, async (tx) => {
        await lockedWorkflow(tx, input.recordId, actorId);
        await tx.insert(fileIndex).values(file);
        await tx.insert(workflowAttachments).values({ fileId: file.id, recordId: input.recordId, purpose: input.purpose, createdBy: actorId });
        return { file: { id: file.id, recordId: input.recordId, purpose: input.purpose, name: file.originalName, mimeType: file.mimeType, sha256: file.sha256, byteSize: file.byteSize } };
      });
      // The original operation already owns its immutable bytes. Compensate only
      // this unindexed staged copy, using the existing safe publication helper.
      if (result.replayed) throw new BatchError('ATTACHMENT_REPLAY', 409, '附件操作已完成。');
    });
  } catch (error) { if (!result?.replayed) throw error; }
  if (!result) throw new BatchError('FILE_UNAVAILABLE', 503, '附件未完成发布。');
  return result;
}
export async function readWorkflowFile(id: string, actorId: string) {
  return db.transaction(async (tx) => {
    await requireBatchActor(tx, actorId);
    const [attachment] = await tx.select().from(workflowAttachments).where(eq(workflowAttachments.fileId, id));
    const sources = await tx.select({ kind: workflowRecords.kind }).from(workflowRecords).where(sql`${workflowRecords.source}->>'fileId' = ${id}`);
    const [exported] = await tx.select({ recordId: workflowExports.recordId }).from(workflowExports).where(eq(workflowExports.fileId, id)).limit(1);
    if (attachment) await lockedWorkflow(tx, attachment.recordId, actorId);
    else if (exported) await lockedWorkflow(tx, exported.recordId, actorId);
    else if (sources.length) {
      // One reviewed source document may also be used by the active finance module.
      // Keep that shared source readable while closing resources exclusive to maintenance modules.
      if (!sources.some((source) => source.kind === 'finance')) requireWorkflowAvailable(sources[0]!.kind);
    } else throw new BatchError('NOT_FOUND', 404, '附件没有可访问的业务关联。');
    const [file] = await tx.select().from(fileIndex).where(eq(fileIndex.id, id));
    if (!file) throw new BatchError('FILE_UNAVAILABLE', 503, '附件索引缺失。');
    return { file, bytes: await checkedFileBytes(file) };
  });
}
