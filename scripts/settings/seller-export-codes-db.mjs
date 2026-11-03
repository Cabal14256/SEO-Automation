import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root=resolve(import.meta.dirname,'../..');
const pgBin=process.env.SERVICE_MAPPING_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const folder=resolve(root,'.local/development/data/acceptance/seller-export-codes',randomUUID());
const postgres=resolve(folder,'postgres'), data=resolve(folder,'data');
await mkdir(data,{recursive:true});
const socket=createServer(); await new Promise(done=>socket.listen(0,'127.0.0.1',done));
const port=socket.address().port; await new Promise(done=>socket.close(done));
const { Client }=createRequire(resolve(root,'apps/server/package.json'))('pg');
const run=(cmd,args,env=process.env)=>new Promise((done,reject)=>{
  const child=spawn(cmd,args,{cwd:resolve(root,'apps/server'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output=''; for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});
  child.once('error',reject);child.once('exit',code=>code===0?done(output):reject(new Error(output.slice(-4000)||`Acceptance command exited ${code}`)));
});
let started=false;
try{
  await run(resolve(pgBin,'initdb.exe'),['-D',postgres,'-U','mapping_admin','--encoding=UTF8','--locale=C','--auth=trust']);
  await run(resolve(pgBin,'pg_ctl.exe'),['start','-D',postgres,'-l',resolve(folder,'postgres.log'),'-o',`-p ${port} -h 127.0.0.1`,'-w']);started=true;
  const admin=new Client({host:'127.0.0.1',port,user:'mapping_admin',database:'postgres'});await admin.connect();
  try{await admin.query('create role scm_app login');await admin.query('create database scm_mapping_acceptance owner scm_app');}finally{await admin.end();}
  const env={...process.env,DATABASE_URL:`postgresql://scm_app@127.0.0.1:${port}/scm_mapping_acceptance`,DATA_DIR:data,
    BETTER_AUTH_SECRET:'test-isolated-service-mapping-acceptance-secret-2026',BETTER_AUTH_URL:'http://localhost:3197',WEB_ORIGIN:'http://localhost:3197',
    LINGXING_REQUESTS_ENABLED:'true',LINGXING_APP_ID:'0123456789abcdef',LINGXING_APP_SECRET:'',LINGXING_ACCESS_TOKEN:'technical-offline-token',LINGXING_ENV_FILE:'',
    SERVICE_MAPPING_ACCEPTANCE_OUT:resolve(folder,'result.json')};
  const output=await run(process.execPath,[resolve(root,'apps/server/node_modules/tsx/dist/cli.mjs'),'src/seller-export-codes-acceptance.ts'],env);
  const report=JSON.parse(await readFile(env.SERVICE_MAPPING_ACCEPTANCE_OUT,'utf8'));assert.equal(report.result,'passed');
  process.stdout.write(output);console.log(`Isolated PostgreSQL evidence: ${env.SERVICE_MAPPING_ACCEPTANCE_OUT}`);
}finally{if(started)await run(resolve(pgBin,'pg_ctl.exe'),['stop','-D',postgres,'-m','fast','-w']);}
