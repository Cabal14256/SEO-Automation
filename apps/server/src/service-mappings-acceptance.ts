import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';

let mockedTransportRequests=0;
globalThis.fetch=async(input) => {
  const url=new URL(String(input));
  assert.equal(url.origin,'https://openapi.lingxing.com');
  assert.equal(url.pathname,'/basicOpen/businessConfig/transportMethod/list');
  mockedTransportRequests+=1;
  return new Response(JSON.stringify({code:0,total:3,data:[
    {method_id:'method-sea',name:'海派',enabled:1,remark:''},
    {method_id:'method-air',name:'空派',enabled:1,remark:''},
    {method_id:'method-retired',name:'海卡',enabled:0,remark:''},
  ]}),{status:200,headers:{'Content-Type':'application/json'}});
};
const {db,closeDatabase}=await import('./db/client.js');
const {user,sellerMappings,operationAudit}=await import('./db/schema.js');
const {batchOperations}=await import('./modules/batches/schema.js');
const {serviceMappings}=await import('./modules/service-mappings/schema.js');
const {createServiceMapping,reviseServiceMapping,deleteServiceMapping,listServiceMappings,getServiceMappingOptions}=await import('./modules/service-mappings/service.js');
const {getDocumentFieldOptions}=await import('./modules/documents/field-options.js');
const {getActiveServiceMappingsInTx}=await import('./modules/service-mappings/repository.js');
const {planDocumentServiceMapping}=await import('./modules/documents/automatic-preparation.js');
const actor='service-mapping-acceptance-admin', at=new Date().toISOString();
const checks:string[]=[];
const member=(country:string,channel:string) => ({demand:{snapshot:{country,channel}}}) as unknown as Parameters<typeof planDocumentServiceMapping>[0]['members'][number];
try{
  await migrate(db,{migrationsFolder:resolve(process.cwd(),'drizzle')});
  await db.insert(user).values({id:actor,name:'Technical acceptance',email:'mapping-acceptance@fixture.invalid',role:'admin'});
  await db.insert(sellerMappings).values({id:randomUUID(),sid:9876501,name:'Technical US',country:'美国',status:'approved',sourceObservedAt:new Date(at),sourceSha256:'a'.repeat(64),
    lingxingData:{name:'Technical US',country:'美国',marketplaceId:null,status:'1',present:true,observedAt:at}});
  const directory=await getServiceMappingOptions(actor);assert.deepEqual(directory.countries.items,[{code:'US',name:'美国'}]);
  assert.equal(directory.transportMethods.items.filter(item=>item.enabled).length,2);checks.push('complete-local-migration-and-read-only-directory');
  const input={operationId:randomUUID(),countryCode:'US',transportMethod:'海派',transportMethodId:'method-sea',service:'手写服务甲'};
  const created=await createServiceMapping(actor,input);assert.equal(created.mapping.version,1);assert.equal(created.replayed,false);
  assert.deepEqual((await listServiceMappings(actor)).items.map(item=>item.service),['手写服务甲']);checks.push('create-and-read-persisted-manual-service');
  const replay=await createServiceMapping(actor,input);assert.equal(replay.mapping.id,created.mapping.id);assert.equal(replay.replayed,true);
  await assert.rejects(createServiceMapping(actor,{...input,service:'不同载荷'}),{code:'OPERATION_CONFLICT'});
  await assert.rejects(createServiceMapping(actor,{...input,operationId:randomUUID()}),{code:'SERVICE_MAPPING_DUPLICATE'});checks.push('idempotency-and-unique-active-country-method');
  let active=await db.transaction(getActiveServiceMappingsInTx);
  const oldTicket=planDocumentServiceMapping({members:[member('美国','海派')],fields:{}},active);assert.equal(oldTicket.service,'手写服务甲');
  assert.equal(planDocumentServiceMapping({members:[member('英国','海派')],fields:{}},active).issues[0]?.code,'DOCUMENT_SERVICE_MAPPING_MISSING');
  const revision={...input,operationId:randomUUID(),expectedVersion:1,service:'手写服务乙'};
  const updated=await reviseServiceMapping(created.mapping.id,actor,revision);assert.equal(updated.mapping.version,2);
  assert.equal((await reviseServiceMapping(created.mapping.id,actor,revision)).replayed,true);
  await assert.rejects(reviseServiceMapping(created.mapping.id,actor,{...revision,operationId:randomUUID()}),{code:'VERSION_CONFLICT'});
  active=await db.transaction(getActiveServiceMappingsInTx);assert.equal(planDocumentServiceMapping({members:[member('US','海派')],fields:{}},active).service,'手写服务乙');
  assert.equal(planDocumentServiceMapping({members:[member('US','海派')],fields:{service:oldTicket.service!}},active).service,undefined);
  assert.deepEqual(await getDocumentFieldOptions(actor),{services:['手写服务乙']});checks.push('revision-conflict-and-historical-invoice-value-preserved');
  process.env.LINGXING_REQUESTS_ENABLED='false';
  const offline=await reviseServiceMapping(created.mapping.id,actor,{...revision,operationId:randomUUID(),expectedVersion:2,service:'离线维护服务'});
  assert.equal(offline.mapping.version,3);checks.push('same-key-service-edit-does-not-require-remote-directory');
  const deletion={operationId:randomUUID(),expectedVersion:3};
  const deleted=await deleteServiceMapping(created.mapping.id,actor,deletion);assert(deleted.mapping.deletedAt);
  assert.equal((await deleteServiceMapping(created.mapping.id,actor,deletion)).replayed,true);
  assert.deepEqual((await listServiceMappings(actor)).items,[]);assert.deepEqual(await getDocumentFieldOptions(actor),{services:[]});
  const [retained]=await db.select().from(serviceMappings).where(eq(serviceMappings.id,created.mapping.id));assert.equal(retained!.service,'离线维护服务');assert(retained!.deletedAt);
  checks.push('delete-hides-active-options-and-keeps-audited-row');
  process.env.LINGXING_REQUESTS_ENABLED='true';
  const replacement=await createServiceMapping(actor,{...input,operationId:randomUUID(),service:'重建服务'});assert.notEqual(replacement.mapping.id,created.mapping.id);
  const audits=await db.select({id:operationAudit.id}).from(operationAudit).where(eq(operationAudit.targetId,created.mapping.id));assert.equal(audits.length,4);
  assert.equal((await db.select().from(batchOperations)).length,5);checks.push('deleted-combination-can-be-recreated-with-distinct-identity');
  const attemptsBefore=mockedTransportRequests;
  await db.insert(user).values({id:'mapping-banned',name:'Banned fixture',email:'mapping-banned@fixture.invalid',banned:true,role:'admin'});
  await assert.rejects(createServiceMapping('mapping-banned',{...input,operationId:randomUUID()}),{code:'FORBIDDEN'});
  assert.equal(mockedTransportRequests,attemptsBefore);checks.push('banned-actor-rejected-before-remote-access');
  const result={result:'passed',kind:'isolated-postgresql-service-mapping-acceptance',checks,mockedTransportRequests,externalBusinessRequests:0,productionWrites:0,finishedAt:new Date().toISOString()};
  await writeFile(process.env.SERVICE_MAPPING_ACCEPTANCE_OUT!,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await closeDatabase();}
