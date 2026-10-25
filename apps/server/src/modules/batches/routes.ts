import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { actualShipDateInputSchema, allocateBatchCodesInputSchema, batchDecisionInputSchema, batchOperationInputSchema, batchWorkspaceQuerySchema, boxMappingInputSchema, confirmAndAllocateSubBatchInputSchema, confirmSubBatchInputSchema, createSubBatchInputSchema, createWeeklyBatchInputSchema, manualShipmentInputSchema, mergeSubBatchesInputSchema, moveSubBatchMembersInputSchema, printRecordInputSchema, reorderSubBatchesInputSchema, splitSubBatchInputSchema, updateSubBatchMembersInputSchema } from '@scm/contracts';
import { auth } from '../../auth.js';
import { readConfig } from '../../config.js';
import { isDatabaseUnavailable, logError } from '../../errors.js';
import { allocateCodes, BatchError, confirmAndAllocateGroup, confirmGroup, correctGroup, getSubBatchDetail, getWeeklyBatch, listWeeklyBatches, manualShipment, mapBoxes, mergeGroups, moveMembers, recordDecision, recordPrint, reorderGroups, replayRetiredBatchOperation, setActualShipDate, splitGroup, updateMembers } from './service.js';
import { getBatchWorkspace } from './workspace.js';

type Variables = { actorId: string; traceId: string };
function baseRoutes() {
  const routes = new Hono<{ Variables: Variables }>();
  routes.use('*', async(c,next)=>{
    c.set('traceId',randomUUID()); c.header('Cache-Control','no-store');
    const current=await auth.api.getSession({headers:c.req.raw.headers});
    if(!current)throw new BatchError('UNAUTHORIZED',401,'请先登录。');
    if(current.user.banned||current.user.role!=='admin')throw new BatchError('FORBIDDEN',403,'当前账号没有批次操作权限。');
    c.set('actorId',current.user.id);
    if(c.req.method==='POST'){const config=readConfig();const origin=c.req.header('Origin');if((origin&&![new URL(config.BETTER_AUTH_URL).origin,new URL(config.WEB_ORIGIN).origin].includes(origin))||c.req.header('Sec-Fetch-Site')==='cross-site')throw new BatchError('FORBIDDEN',403,'请求来源不受信任。');}
    await next();
  });
  routes.onError((error,c)=>{
    if(error instanceof BatchError)return c.json({error:{code:error.code,message:error.message,details:error.details,traceId:c.get('traceId')}},error.status);
    logError('Batch API request failed',error);const unavailable=isDatabaseUnavailable(error);return c.json({error:{code:unavailable?'DATABASE_UNAVAILABLE':'INTERNAL_ERROR',message:unavailable?'数据库暂不可用，请稍后重试。':'批次处理失败，请刷新后重试。',traceId:c.get('traceId')}},unavailable?503:500);
  });
  return routes;
}
const uuid=(id:string)=>{if(!z.uuid().safeParse(id).success)throw new BatchError('VALIDATION_ERROR',422,'对象编号无效。');return id;};
async function body<T>(request:{header:(name:string)=>string|undefined;json:()=>Promise<unknown>},schema:z.ZodType<T>):Promise<T>{
  if(!request.header('Content-Type')?.toLowerCase().startsWith('application/json'))throw new BatchError('VALIDATION_ERROR',422,'请提交 JSON 操作内容。');
  const parsed=schema.safeParse(await request.json().catch(()=>null));if(!parsed.success)throw new BatchError('VALIDATION_ERROR',422,'请核对成员、数据和版本。',parsed.error.flatten());return parsed.data;
}
export function createBatchWorkspaceRoutes() {
  const routes = baseRoutes();
  routes.get('/workspace', async (c) => {
    const parsed = batchWorkspaceQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new BatchError('VALIDATION_ERROR', 422, '请核对发货次、筛选条件和分页参数。', parsed.error.flatten());
    return c.json(await getBatchWorkspace(c.get('actorId'), parsed.data));
  });
  return routes;
}
export function createWeeklyBatchRoutes(){const routes=baseRoutes();
  routes.get('/',async(c)=>c.json(await listWeeklyBatches(c.get('actorId'))));
  routes.post('/',async(c)=>{const input=await body(c.req,createWeeklyBatchInputSchema);return c.json(await replayRetiredBatchOperation(c.get('actorId'),input.operationId,'batch.create',input));});
  routes.get('/:id',async(c)=>c.json(await getWeeklyBatch(uuid(c.req.param('id')),c.get('actorId'))));
  routes.post('/:id/sub-batches',async(c)=>{const batchId=uuid(c.req.param('id')),input=await body(c.req,createSubBatchInputSchema);return c.json(await replayRetiredBatchOperation(c.get('actorId'),input.operationId,'sub_batch.create',{batchId,...input}));});
  routes.post('/:id/reorder',async(c)=>{const batchId=uuid(c.req.param('id')),input=await body(c.req,reorderSubBatchesInputSchema);return c.json(await replayRetiredBatchOperation(c.get('actorId'),input.operationId,'batch.reorder',{batchId,...input}));});
  routes.post('/:id/allocate-codes',async(c)=>{const batchId=uuid(c.req.param('id')),input=await body(c.req,allocateBatchCodesInputSchema);return c.json(await replayRetiredBatchOperation(c.get('actorId'),input.operationId,'batch.allocate',{batchId,...input}));});return routes;
}
export function createProcessingBatchRoutes(){const routes=baseRoutes();
  routes.get('/',async(c)=>c.json(await listWeeklyBatches(c.get('actorId'))));
  routes.get('/:id',async(c)=>c.json(await getWeeklyBatch(uuid(c.req.param('id')),c.get('actorId'))));
  routes.post('/:id/reorder',async(c)=>c.json(await reorderGroups(uuid(c.req.param('id')),await body(c.req,reorderSubBatchesInputSchema),c.get('actorId'))));
  routes.post('/:id/allocate-codes',async(c)=>c.json(await allocateCodes(uuid(c.req.param('id')),await body(c.req,allocateBatchCodesInputSchema),c.get('actorId'))));return routes;
}
export function createSubBatchRoutes(){const routes=baseRoutes();
  routes.get('/:id',async(c)=>c.json(await getSubBatchDetail(uuid(c.req.param('id')),c.get('actorId'))));
  routes.post('/:id/members',async(c)=>c.json(await updateMembers(uuid(c.req.param('id')),await body(c.req,updateSubBatchMembersInputSchema),c.get('actorId'))));
  routes.post('/:id/merge',async(c)=>c.json(await mergeGroups(uuid(c.req.param('id')),await body(c.req,mergeSubBatchesInputSchema),c.get('actorId'))));
  routes.post('/:id/split',async(c)=>c.json(await splitGroup(uuid(c.req.param('id')),await body(c.req,splitSubBatchInputSchema),c.get('actorId'))));
  routes.post('/:id/move',async(c)=>c.json(await moveMembers(uuid(c.req.param('id')),await body(c.req,moveSubBatchMembersInputSchema),c.get('actorId'))));
  routes.post('/:id/correction',async(c)=>c.json(await correctGroup(uuid(c.req.param('id')),await body(c.req,batchOperationInputSchema),c.get('actorId')),201));
  routes.post('/:id/confirm',async(c)=>c.json(await confirmGroup(uuid(c.req.param('id')),await body(c.req,confirmSubBatchInputSchema),c.get('actorId'))));
  routes.post('/:id/confirm-and-allocate',async(c)=>c.json(await confirmAndAllocateGroup(uuid(c.req.param('id')),await body(c.req,confirmAndAllocateSubBatchInputSchema),c.get('actorId'))));
  routes.post('/:id/decisions',async(c)=>c.json(await recordDecision(uuid(c.req.param('id')),await body(c.req,batchDecisionInputSchema),c.get('actorId'))));
  routes.post('/:id/box-mapping',async(c)=>c.json(await mapBoxes(uuid(c.req.param('id')),await body(c.req,boxMappingInputSchema),c.get('actorId'))));
  routes.post('/:id/actual-ship-date',async(c)=>c.json(await setActualShipDate(uuid(c.req.param('id')),await body(c.req,actualShipDateInputSchema),c.get('actorId'))));
  routes.post('/:id/print',async(c)=>c.json(await recordPrint(uuid(c.req.param('id')),await body(c.req,printRecordInputSchema),c.get('actorId'))));
  routes.post('/:id/shipments/:demandId/manual',async(c)=>c.json(await manualShipment(uuid(c.req.param('id')),uuid(c.req.param('demandId')),await body(c.req,manualShipmentInputSchema),c.get('actorId')),201));return routes;
}
