import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { reportExportInputSchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { db } from '../../db/client.js';
import { demands, fileIndex } from '../../db/schema.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { batchIntakes } from './export-schema.js';
import { subBatches, weeklyBatches } from './schema.js';
import { BatchError, getSubBatchDetail, publishCandidateInTx, requireBatchActor } from './service.js';
import { createIntakeTemplate, parseIntakeWorkbook } from './workbook.js';
import { getExport, getShipmentReport, listExports, publishReportFile, requestReportExport } from './report-service.js';

const querySchema = z.object({ shippingRunId: z.uuid().optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), weekStartDate: z.iso.date().optional(), weeklyBatchId: z.uuid().optional(), subBatchId: z.uuid().optional(), sid: z.coerce.number().int().positive().optional(), country: z.string().trim().min(1).max(120).optional(), channel: z.string().trim().min(1).max(120).optional(), region: z.enum(['all', 'US', 'EU']).default('all'), q: z.string().trim().max(200).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) });
type Variables = { actorId: string };
export function createReportRoutes(getBoss: () => PgBoss | null) {
  const routes = new Hono<{ Variables: Variables }>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!current) throw new BatchError('UNAUTHORIZED', 401, '请先登录。');
    if (current.user.banned || current.user.role !== 'admin') throw new BatchError('FORBIDDEN', 403, '需要有效管理员身份。');
    await db.transaction((tx) => requireBatchActor(tx, current.user.id));
    c.set('actorId', current.user.id);
    if (c.req.method === 'POST') { const origin = c.req.header('Origin'), config = readConfig(); if ((origin && ![new URL(config.WEB_ORIGIN).origin, new URL(config.BETTER_AUTH_URL).origin].includes(origin)) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw new BatchError('FORBIDDEN', 403, '请求来源不受信任。'); }
    await next();
  });
  routes.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 + 64 * 1024, onError: (c) => c.json({ error: { code: 'FILE_TOO_LARGE', message: '补录文件不能超过10 MiB。' } }, 413) }));
  routes.get('/', async (c) => { const query = querySchema.safeParse(c.req.query()); if (!query.success) throw new BatchError('VALIDATION_ERROR', 422, '报表筛选条件无效。'); return c.json(await getShipmentReport(c.get('actorId'), query.data)); });
  routes.get('/exports', async (c) => { const query = querySchema.safeParse(c.req.query()); if (!query.success) throw new BatchError('VALIDATION_ERROR', 422, '历史筛选条件无效。'); return c.json(await listExports(query.data)); });
  routes.get('/exports/:id', async (c) => { const id = z.uuid().parse(c.req.param('id')); return c.json(await getExport(id)); });
  routes.post('/exports', async (c) => {
    const input = reportExportInputSchema.safeParse(await c.req.json().catch(() => null)); if (!input.success) throw new BatchError('VALIDATION_ERROR', 422, '请重新预览并选择确认范围。');
    const boss = getBoss(); if (!boss) throw new BatchError('QUEUE_UNAVAILABLE', 503, '导出队列暂不可用。');
    return c.json(await requestReportExport(boss, input.data, c.get('actorId')), 202);
  });
  routes.get('/intake-template.xlsx', async (c) => { c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); c.header('Content-Disposition', 'attachment; filename="shipment-intake.xlsx"'); c.header('X-Content-Type-Options', 'nosniff'); return c.body(new Uint8Array(await createIntakeTemplate())); });
  routes.post('/intake', async (c) => {
    const form = await c.req.formData().catch(() => null); const file = form?.get('file');
    const parsed = z.object({ subBatchId: z.uuid(), demandId: z.uuid(), expectedVersion: z.coerce.number().int().positive(), operationId: z.uuid(), reason: z.string().trim().min(1).max(1000) }).strict().safeParse(form ? Object.fromEntries([...form.entries()].filter(([key]) => key !== 'file')) : null);
    if (!parsed.success || !form || [...form.keys()].some((key) => form.getAll(key).length !== 1) || !(file instanceof File) || !/\.xlsx$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) throw new BatchError('VALIDATION_ERROR', 422, '需要不超过10 MiB的XLSX、货件、当前组版本和补录原因。');
    const input = parsed.data, actorId = c.get('actorId'); const bytes = Buffer.from(await file.arrayBuffer());
    const requestHash = createHash('sha256').update(bytes).update(JSON.stringify(input)).digest('hex');
    const [existing] = await db.select().from(batchIntakes).where(eq(batchIntakes.operationId, input.operationId));
    if (existing) { if (existing.actorId !== actorId || existing.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他补录。'); return c.json({ revision: existing.result, replayed: true }); }
    const detail = await getSubBatchDetail(input.subBatchId, actorId); const member = detail.members.find((m) => m.id === input.demandId);
    if (!member) throw new BatchError('MEMBER_NOT_FOUND', 422, '所选货件不属于该子批次。');
    if (detail.group.frozenAt || detail.group.status === 'superseded') throw new BatchError('GROUP_FROZEN', 409, '子批次已冻结，请先发起更正再补录。');
    let data; try { data = await parseIntakeWorkbook(bytes, { sid: member.snapshot.sid, fba: member.snapshot.fba }); } catch (error) { throw new BatchError('INVALID_WORKBOOK', 422, error instanceof Error ? error.message : '补录文件无效。'); }
    const previousBoxes = detail.shipments.find((s) => s.demandId === member.id)?.revision?.data.boxes ?? [];
    for (const box of data.boxes) { const matches = previousBoxes.filter((b) => b.externalBoxId && b.externalBoxId === box.externalBoxId); if (matches.length === 1) box.id = matches[0]!.id; }
    let result: Record<string, unknown> = {};
    let replayed = false;
    await publishReportFile({ bytes, originalName: file.name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdBy: actorId }, async (source) => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`intake:${input.operationId}`},0))`); await requireBatchActor(tx, actorId);
        const [duplicate] = await tx.select().from(batchIntakes).where(eq(batchIntakes.operationId, input.operationId));
        if (duplicate) { if (duplicate.actorId !== actorId || duplicate.requestHash !== requestHash) throw new BatchError('OPERATION_CONFLICT', 409, '操作编号已用于其他补录。'); throw new BatchError('INTAKE_REPLAY', 409, '补录已提交，请使用原操作编号重试读取结果。'); }
        await tx.select().from(weeklyBatches).where(eq(weeklyBatches.id, detail.group.batchId)).for('update');
        const [group] = await tx.select().from(subBatches).where(eq(subBatches.id, input.subBatchId)).for('update');
        if (!group || group.frozenAt || group.status === 'superseded') throw new BatchError('GROUP_FROZEN', 409, '子批次已冻结，请发起更正。');
        const [currentDemand] = await tx.select().from(demands).where(eq(demands.id, member.id)).for('share');
        if (!currentDemand || currentDemand.version !== member.version) throw new BatchError('DEMAND_VERSION_CONFLICT', 409, '需求版本已变化，请重新选择补录货件。');
        await tx.insert(fileIndex).values(source);
        const revision = await publishCandidateInTx(tx, { demandId: member.id, subBatchId: input.subBatchId, expectedGroupVersion: input.expectedVersion, expectedDemandVersion: member.version, actorId, data, source: 'xlsx', snapshotIds: [source.id], reason: input.reason });
        result = revision as unknown as Record<string, unknown>;
        await tx.insert(batchIntakes).values({ operationId: input.operationId, actorId, requestHash, groupId: input.subBatchId, demandId: member.id, sourceFileId: source.id, result });
      });
    }).catch(async (error: unknown) => { if (!(error instanceof BatchError) || error.code !== 'INTAKE_REPLAY') throw error; const [duplicate] = await db.select().from(batchIntakes).where(eq(batchIntakes.operationId, input.operationId)); if (!duplicate?.result) throw error; result = duplicate.result; replayed = true; });
    return c.json({ revision: result, replayed }, replayed ? 200 : 201);
  });
  routes.onError((error, c) => { if (error instanceof BatchError) return c.json({ error: { code: error.code, message: error.message } }, error.status); if (error instanceof z.ZodError) return c.json({ error: { code: 'VALIDATION_ERROR', message: '对象编号或参数无效。' } }, 422); logError('Shipment report failed', error); return c.json({ error: { code: isDatabaseUnavailable(error) ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: '报表处理失败，请重试或检查服务。', traceId: randomUUID() } }, isDatabaseUnavailable(error) ? 503 : 500); });
  return routes;
}
