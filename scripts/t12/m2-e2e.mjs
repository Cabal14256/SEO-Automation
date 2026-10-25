import { chooseOption } from '../shared/ui-controls.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = resolve(root, 'apps/server'); const requireServer = createRequire(resolve(server, 'package.json'));
Object.assign(process.env, requireServer('dotenv').parse(await readFile(resolve(server, '.env'))));
const { createConfirmationHarness, technicalWorkbook } = await import(pathToFileURL(resolve(server, 'dist/import-confirmation-acceptance.js')));
const { pool, closeDatabase } = await import(pathToFileURL(resolve(server, 'dist/db/client.js')));
const { readConfig } = await import(pathToFileURL(resolve(server, 'dist/config.js')));
const ExcelJS = requireServer('exceljs');
const live = process.argv.includes('--live'); const skipBrowser = process.argv.includes('--no-browser'); const europeOnly = process.argv.includes('--europe-only');
const out = resolve(root, '.local/t12-m2/e2e', live ? '' : 'offline'); await mkdir(out, { recursive: true });
const budgetPath = resolve(out, 'live-budget.json');
let ledger = { limit: 100, used: 0, reserved: 0, runs: {} };
try { ledger = JSON.parse(await readFile(budgetPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('真实请求预算记录不可读，请先人工核对，不能重置预算。'); }
ledger.reserved ??= 0;
assert(ledger.limit === 100 && Number.isSafeInteger(ledger.used) && Number.isSafeInteger(ledger.reserved) && ledger.used >= 0 && ledger.reserved >= 0 && ledger.used + ledger.reserved <= 100, '真实请求预算记录无效');
const startingRequests = ledger.used;
const priorExternalBoxes = new Map(); let comparedExternalBoxes = 0;
if (europeOnly) { const prior = new ExcelJS.Workbook(); await prior.xlsx.readFile(resolve(out,'verified-live-shipments.xlsx')); const sheet=prior.getWorksheet('逐箱明细'); const headers=sheet.getRow(1).values; const fbaIndex=headers.indexOf('FBA货件号'), boxIndex=headers.indexOf('平台箱ID'); sheet.eachRow((row,number)=>{if(number===1)return;const fba=row.getCell(fbaIndex).text, external=row.getCell(boxIndex).text;if(external){if(!priorExternalBoxes.has(fba))priorExternalBoxes.set(fba,new Set());priorExternalBoxes.get(fba).add(external);}}); }
async function saveBudget() { const temporary = `${budgetPath}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(ledger, null, 2)); await rename(temporary, budgetPath); }
const h = await createConfirmationHarness({ catalogMode: null }); const checks = []; const liveResults = [];
let browser, failed = false, cleaned = false, stage = 'setup', retainedSnapshots = 0;
const operation = (detail, reason = 'T12/M2技术验收') => ({ operationId: randomUUID(), expectedVersion: detail.group?.version ?? detail.batch.version, reason });
async function api(path, body, expected = 200) { const result = await h.request(path, undefined, body === undefined ? 'GET' : 'POST', body); assert.equal(result.status, expected, `${path}: ${JSON.stringify(result.data?.error ?? result.data)}`); return result.data; }
const record = (name, details = {}) => { checks.push({ name, result: 'passed', ...details }); console.log(`PASS ${name}`); };
async function waitFor(action, label, milliseconds = 240_000) { const end = Date.now() + milliseconds; while (Date.now() < end) { const value = await action(); if (value) return value; await delay(400); } throw new Error(label); }
async function detail(id) { return api(`/sub-batches/${id}`); }
async function week(id) { return api(`/weekly-batches/${id}`); }
async function cleanupBatches() {
  const actors = [...h.users.values()].map((u) => u.id); if (!actors.length) return;
  const tx = await pool.connect();
  try { await tx.query('begin');
    await tx.query('delete from batch_sync_snapshot where run_id in (select id from batch_sync_run where created_by=any($1::text[]))', [actors]);
    await tx.query('delete from batch_sync_retry_operation where run_id in (select id from batch_sync_run where created_by=any($1::text[]))', [actors]);
    await tx.query('delete from batch_sync_item where run_id in (select id from batch_sync_run where created_by=any($1::text[]))', [actors]);
    await tx.query('delete from batch_sync_run where created_by=any($1::text[])', [actors]);
    await tx.query('delete from batch_export where created_by=any($1::text[])', [actors]);
    await tx.query('delete from batch_intake where actor_id=any($1::text[])', [actors]);
    for (const table of ['batch_print_record', 'batch_decision', 'allocation_code', 'group_confirmation', 'sub_batch_revision', 'sub_batch_member']) await tx.query(`delete from ${table} where group_id in (select id from sub_batch where created_by=any($1::text[]))`, [actors]);
    await tx.query('delete from shipment_revision where created_by=any($1::text[])', [actors]);
    await tx.query('delete from sub_batch where created_by=any($1::text[])', [actors]);
    await tx.query('delete from weekly_batch where created_by=any($1::text[]) and not exists (select 1 from sub_batch where batch_id=weekly_batch.id)', [actors]);
    await tx.query('delete from batch_operation where actor_id=any($1::text[])', [actors]);
    await tx.query('commit');
  } catch (error) { await tx.query('rollback'); throw error; } finally { tx.release(); }
}
async function ensureConfirmed(groupId) {
  let d = await detail(groupId);
  for (const s of d.shipments) {
    if (!s.revision) return false;
    if(europeOnly){const previous=priorExternalBoxes.get(s.revision.data.fba);if(previous?.size){const current=new Set(s.revision.data.boxes.map((box)=>box.externalBoxId).filter(Boolean));assert.deepEqual([...current].sort(),[...previous].sort(),'欧洲再次查询的平台箱标识发生变化，需人工映射');comparedExternalBoxes+=current.size;}}
    if (!s.revision.data.boxes.length) { liveResults.push({ groupId, blocked: ['NO_BOXES'] }); return false; }
    await api(`/sub-batches/${groupId}/box-mapping`, { ...operation(d, '技术核对平台箱序建议，未替代业务签收'), demandId: s.demandId, expectedShipmentVersion: s.revision.version,
      mappings: [...s.revision.data.boxes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((b, i) => ({ boxId: b.id, existingBoxId: null, order: i + 1 })) });
    d = await detail(groupId);
  }
  if (d.issues.some((i) => i.severity === 'error')) { liveResults.push({ groupId, blocked: d.issues.filter((i) => i.severity === 'error').map((i) => i.code) }); return false; }
  await api(`/sub-batches/${groupId}/confirm`, { ...operation(d), expectedDemandVersions: Object.fromEntries(d.members.map((m) => [m.id, m.version])), expectedShipmentVersions: Object.fromEntries(d.shipments.map((s) => [s.demandId, s.revision.version])) });
  const w = await week(d.group.batchId); d = await detail(groupId);
  await api(`/weekly-batches/${w.batch.id}/allocate-codes`, { ...operation(w), groupIds: [groupId], expectedGroupVersions: { [groupId]: d.group.version } });
  return true;
}
try {
  await h.setup(); const admin = h.users.get('admin');
  assert.equal((await h.request('/weekly-batches', '')).status, 401);
  assert.equal((await h.request('/batch-reports', '')).status, 401);
  record('anonymous-protected-business-endpoints');
  stage = 'real-source-import';
  const original = await h.upload(); const preview = await h.preview(original); const all = await h.allItems(original, preview);
  const valid = all.filter((i) => i.selectable && i.after);
  const selected = [];
  const knownFbas = new Set(h.fixture?.preferredFbas ?? []);
  const us = valid.filter((i) => i.after.country === '美国').sort((a,b) => Number(knownFbas.has(b.after.fba)) - Number(knownFbas.has(a.after.fba)));
  selected.push(...us.slice(0, 18));
  for (const country of ['英国','法国','德国','西班牙','意大利']) { const item = valid.find((i) => i.after.country === country); if (item) selected.push(item); }
  if (selected.length < 20) selected.push(...valid.filter((i) => !selected.includes(i)).slice(0, 20 - selected.length));
  const result = await h.commit(original, preview, selected.map((i) => i.id)); assert.equal(result.status, 200);
  const ids = result.result.items.map((i) => i.demandId); const members = await Promise.all(ids.map(async (id) => (await api(`/demands/${id}`)).demand));
  record('real-source-selected-demands-provenance', { selectedShipments: members.length, sourceRows: original.latestRun.counts.totalRows, countries: [...new Set(members.map((m) => m.snapshot.country))], businessMonth: original.businessDate.slice(0,7) });
  const made = await api('/weekly-batches', { operationId: randomUUID(), weekStartDate: original.weekStartDate }, 201); const batchId = made.batchId;
  const buckets = new Map(); for (const member of members) { const key = JSON.stringify([member.snapshot.sid, member.snapshot.country, member.snapshot.channel]); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(member); }
  const groups = [];
  for (const bucket of buckets.values()) { const w = await week(batchId); const created = await api(`/weekly-batches/${batchId}/sub-batches`, { ...operation(w), name: `M2技术核对-${bucket[0].snapshot.country}-${groups.length+1}`, demandIds: bucket.map((m) => m.id), expectedDemandVersions: Object.fromEntries(bucket.map((m) => [m.id,m.version])) }, 201); groups.push(created.groupId); }
  record('real-source-manual-same-sid-country-channel-grouping', { groups: groups.length });
  const confirmed = [];
  if (live) {
    stage = 'budgeted-live-read-only-sync';
    for (const id of groups) {
      const allowance = ledger.limit - ledger.used - ledger.reserved;
      if (allowance <= 0) break;
      const d = await detail(id);
      if (europeOnly && d.members.every((member) => member.snapshot.country === '美国')) continue;
      ledger.reserved += allowance; await saveBudget();
      const started = await api(`/batch-sync/${id}`, { operationId: randomUUID(), expectedVersion: d.group.version, startDate: '2026-01-01', endDate: '2026-10-18', requestBudget: allowance, maxPages: 10 }, 202);
      const runId = started.run.id; let accounted = 0;
      ledger.runs[runId] = { accounted: 0, reserved: allowance, terminal: false }; await saveBudget();
      const completed = await waitFor(async () => { const state = await api(`/batch-sync/runs/${runId}`); assert(state.run.requestsUsed >= accounted && state.run.requestsUsed <= allowance, '同步请求计数超出预留预算'); if (state.run.requestsUsed > accounted) { const delta=state.run.requestsUsed-accounted; ledger.used += delta; ledger.reserved -= delta; accounted = state.run.requestsUsed; ledger.runs[runId] = { accounted, reserved: allowance-accounted, terminal: false }; await saveBudget(); } return ['completed','partial','failed'].includes(state.run.status) ? state : null; }, '真实同步未在期限内完成', 360_000);
      ledger.reserved -= allowance-accounted; ledger.runs[runId] = { accounted, reserved: 0, terminal: true }; await saveBudget();
      liveResults.push({ runId, status: completed.run.status, requests: completed.run.requestsUsed, items: completed.items.map((i) => ({ sid: i.sid, fba: i.fba, status: i.status, errorCode: i.errorCode })) });
      console.log(`SYNC ${completed.run.status}; used ${ledger.used}/${ledger.limit}`);
      if (completed.items.every((i) => i.status === 'completed') && await ensureConfirmed(id)) confirmed.push(id);
    }
    record('budgeted-real-read-only-sync-evidence', { requestsUsed: ledger.used, budget: ledger.limit, completedShipments: liveResults.flatMap((r) => r.items ?? []).filter((i) => i.status === 'completed').length, confirmedGroups: confirmed.length });
    if(europeOnly) record('real-european-external-box-identities-stable-across-reads',{comparedExternalBoxes});
  }
  // A separate, clearly marked fixture proves >10 boxes and browser actions even
  // when a real country or non-STA endpoint cannot return complete data.
  stage = 'technical-twelve-box-candidate';
  const store = members[0].snapshot;
  const technical = await h.upload(technicalWorkbook([{shop:store.shop,country:store.country,channel:store.channel,fba:`FBAM2${h.runId.replaceAll('-','').toUpperCase()}`}]), 'M2-TECHNICAL-12-BOX.xlsx');
  const tp = await h.preview(technical); const tc = await h.commit(technical,tp); assert.equal(tc.status,200);
  const demandId = tc.result.items[0].demandId; const dm = (await api(`/demands/${demandId}`)).demand; const w = await week(batchId);
  const created = await api(`/weekly-batches/${batchId}/sub-batches`, {...operation(w),name:'技术十二箱（非真实货件）',demandIds:[demandId],expectedDemandVersions:{[demandId]:dm.version}},201); const techId = created.groupId;
  const templateResponse=await fetch(`${h.baseURL}/api/v1/batch-reports/intake-template.xlsx`,{headers:{Cookie:admin.cookie}});assert.equal(templateResponse.status,200);const intakeBook=new ExcelJS.Workbook();await intakeBook.xlsx.load(Buffer.from(await templateResponse.arrayBuffer()));
  intakeBook.getWorksheet('货件商品').addRow([String(dm.snapshot.sid),dm.snapshot.fba,'00001','X001','001','技术补录商品',24]);
  intakeBook.getWorksheet('逐箱商品').addRow([String(dm.snapshot.sid),dm.snapshot.fba,'technical-source-box','1','技术来源箱','00001','X001','001',24,35,'LB',19,16,17,'IN']);
  const intakeBytes=Buffer.from(await intakeBook.xlsx.writeBuffer()),intakeOperation=randomUUID();
  const intakeForm=(reason='技术XLSX回退来源，不替代业务签收',operationId=intakeOperation,expectedVersion=1)=>{const form=new FormData();form.set('file',new Blob([intakeBytes]),'TECHNICAL-INTAKE.xlsx');form.set('operationId',operationId);form.set('subBatchId',techId);form.set('demandId',demandId);form.set('expectedVersion',String(expectedVersion));form.set('reason',reason);return form;};
  const intake=await api('/batch-reports/intake',intakeForm(),201);assert.equal(intake.revision.source,'xlsx');const intakeReplay=await api('/batch-reports/intake',intakeForm());assert(intakeReplay.replayed);assert.equal(intakeReplay.revision.id,intake.revision.id);
  assert.equal((await h.request('/batch-reports/intake',undefined,'POST',intakeForm('另一个原因'))).status,409);record('real-http-xlsx-intake-template-publication-idempotency-and-conflict');
  let d = await detail(techId); const boxes = Array.from({length:12},(_,i)=>({id:randomUUID(),externalBoxId:`technical-${i+1}`,packageId:null,localBoxId:String(i+1),name:`技术箱${i+1}`,order:i+1,items:[{msku:'00001',fnsku:'X001',sku:'001',quantity:'2'}],weight:'35',weightUnit:'LB',length:'19',width:'16',height:'17',dimensionUnit:'IN'}));
  await api(`/sub-batches/${techId}/shipments/${demandId}/manual`,{...operation(d,'显式技术夹具，不代表真实装箱'),expectedDemandVersion:dm.version,data:{sid:dm.snapshot.sid,fba:dm.snapshot.fba,observedAt:new Date().toISOString(),items:[{msku:'00001',fnsku:'X001',sku:'001',name:'技术十二箱商品',quantity:'24'}],boxes,issues:[]}},201);
  assert(await ensureConfirmed(techId)); confirmed.push(techId); record('twelve-box-full-identity-conservation-confirmation-allocation');
  stage = 'xlsx-export-and-freeze';
  const projection = await api(`/batch-reports?weeklyBatchId=${batchId}&month=${original.businessDate.slice(0,7)}&pageSize=100`);
  const refs = projection.confirmations.filter((r) => confirmed.includes(r.groupId)); assert.equal(refs.length,confirmed.length); assert(projection.maxBoxes >= 12);
  const exportBody = {operationId:randomUUID(),groupIds:refs.map((r)=>r.groupId),expectedConfirmations:refs,month:original.businessDate.slice(0,7),region:'all'};
  const accepted = await api('/batch-reports/exports',exportBody,202); const replay = await api('/batch-reports/exports',exportBody,202); assert.equal(replay.export.id,accepted.export.id); assert(replay.replayed);
  const exported = await waitFor(async()=>{const e=(await api(`/batch-reports/exports/${accepted.export.id}`)).export;return ['completed','failed','stale'].includes(e.status)?e:null;},'导出Worker未完成'); assert.equal(exported.status,'completed',exported.error);
  const download = await fetch(`${h.baseURL}/api/v1/files/${exported.fileId}/download`,{headers:{Cookie:admin.cookie}}); assert.equal(download.status,200); const bytes=Buffer.from(await download.arrayBuffer()); await writeFile(resolve(out,'verified-shipment-record.xlsx'),bytes);
  const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);const sheet=book.worksheets[0];assert.equal(sheet.rowCount-1,exported.rowCount);assert(book.getWorksheet('逐箱明细').rowCount>12);assert(sheet.getRow(1).values.includes('箱12'));
  const frozen=await detail(techId);assert.equal(frozen.group.status,'frozen');assert.equal((await h.request(`/sub-batches/${techId}/members`,undefined,'POST',{...operation(frozen),demandIds:[demandId],expectedDemandVersions:{[demandId]:dm.version}})).status,409);
  assert.equal((await h.request('/batch-reports/intake',undefined,'POST',intakeForm('冻结后不可直接补录',randomUUID(),frozen.group.version))).status,409);
  const sourceLink=await h.request(`/demands/${demandId}`);assert(sourceLink.data.sources.every((s)=>s.source.rowNumber>1));
  record('async-export-idempotency-xlsx-readback-authorized-download-and-freeze',{productRows:exported.rowCount,boxes:exported.boxCount,sheets:book.worksheets.map((s)=>s.name)});
  stage='frozen-ship-date-independent-version';
  await api(`/sub-batches/${techId}/actual-ship-date`,{...operation(frozen),actualShipDate:'2026-10-17'});
  const dated=await detail(techId);assert.equal(dated.confirmation.id,frozen.confirmation.id);assert.equal(dated.group.status,'frozen');assert(dated.group.version>frozen.group.version);
  assert.equal((await api(`/batch-reports?subBatchId=${techId}`)).rows[0].actualShipDate,'2026-10-17');record('frozen-local-ship-date-keeps-original-confirmation-and-file');
  if(!skipBrowser){
    stage='real-browser';browser=await chromium.launch({headless:true,channel:process.env.IMPORT_BROWSER_CHANNEL||'chrome'});const context=await browser.newContext({baseURL:h.baseURL,locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(25_000);const errors=[];page.on('pageerror',(e)=>errors.push(e.message));
    await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(admin.email);await page.getByLabel('密码',{exact:true}).fill(admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('heading',{name:'发货任务工作台',exact:true}).waitFor();
    await page.goto(`/batches/${batchId}`);await page.getByRole('heading',{name:'周批次与人工分组',exact:true}).waitFor();await page.getByRole('row').filter({hasText:'技术十二箱（非真实货件）'}).getByRole('button',{name:'查看并处理'}).click();await page.getByRole('heading',{name:'商品、逐箱数量与差异处理',exact:true}).waitFor();await page.screenshot({path:resolve(out,'batch-detail-desktop.png'),fullPage:true});
    await page.goto('/batch-reports');await page.getByRole('heading',{name:'月汇总与批次成品表',exact:true}).waitFor();await page.getByRole('columnheader',{name:'箱 12',exact:true}).waitFor();await page.screenshot({path:resolve(out,'report-desktop.png'),fullPage:true});await page.screenshot({path:resolve(out,'report-desktop-viewport.png')});
    await chooseOption(page.getByLabel('国家 / 区域',{exact:true}), 'EU');await page.getByRole('button',{name:'刷新成品表',exact:true}).click();await chooseOption(page.getByLabel('明细视图',{exact:true}), 'boxes');await chooseOption(page.getByLabel('国家 / 区域',{exact:true}), 'all');await page.getByRole('columnheader',{name:'平台箱标识',exact:true}).waitFor();
    for(const width of [390,320]){await page.setViewportSize({width,height:844});await page.goto('/batch-reports');await page.getByRole('heading',{name:'月汇总与批次成品表',exact:true}).waitFor();await page.getByRole('columnheader',{name:'箱 12',exact:true}).waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await page.screenshot({path:resolve(out,`report-${width}.png`),fullPage:true});await page.screenshot({path:resolve(out,`report-${width}-viewport.png`)});}
    assert.deepEqual(errors,[]);record('real-admin-browser-batches-products-boxes-region-and-320-390-responsive',{pageErrors:0});
  }
  stage='correction';const before=await detail(techId);const correction=await api(`/sub-batches/${techId}/correction`,operation(before,'技术验证冻结后新版本更正'),201);assert.notEqual(correction.groupId,techId);const old=await detail(techId);assert.equal(old.group.status,'superseded');assert.equal((await api(`/batch-reports/exports/${exported.id}`)).export.valid,false);record('frozen-correction-preserves-old-file-and-replacement-link');
  await h.unchangedOriginalAndMappings();record('original-workbook-and-existing-seller-candidates-unchanged');
} catch(error){failed=true;console.error(`FAIL ${stage}: ${error instanceof Error?error.message:'unknown'}`);checks.push({name:stage,result:'failed',message:error instanceof Error?error.message:'unknown'});}
finally{
  await browser?.close();
  try { const actors=[...h.users.values()].map((u)=>u.id); const snapshots=(await pool.query('select f.storage_key,f.sha256,s.id,s.operation,s.page from batch_sync_snapshot s join file_index f on f.id=s.file_id join batch_sync_run r on r.id=s.run_id where r.created_by=any($1::text[])',[actors])).rows; const archive=resolve(out,'raw');await mkdir(archive,{recursive:true});for(const snapshot of snapshots)await copyFile(resolve(readConfig().dataDir,snapshot.storage_key),resolve(archive,`${snapshot.id}.json`));retainedSnapshots=snapshots.length;await writeFile(resolve(out,europeOnly?'europe-snapshot-manifest.json':'snapshot-manifest.json'),JSON.stringify(snapshots.map(({storage_key,...row})=>row),null,2)); } catch(error) { failed=true;console.error(`Snapshot archive failed: ${error.message}`); }
  try{await cleanupBatches();await h.cleanup();cleaned=true;}catch(error){failed=true;console.error(`Cleanup failed: ${error instanceof Error?error.message:'unknown'}`);}
  const report={result:failed?'failed':'passed',date:'2026-10-17',liveBusinessRequests:ledger.used,requestsThisRun:ledger.used-startingRequests,reservedBusinessRequests:ledger.reserved,requestBudget:100,retainedSnapshots,technicalFixturesRemoved:cleaned,checks,liveResults,businessSignoff:'pending',uncovered:['真实每日增量业务文件签收','业务人员真实批次逐行签收','无真实证据的非STA和其他类别保持待验']};
  const name = europeOnly ? 'europe-e2e' : live ? 'e2e' : 'offline-e2e';
  await writeFile(resolve(out,`${name}-result.json`),JSON.stringify(report,null,2));await mkdir(resolve(root,'docs/acceptance/evidence/2026-10-17'),{recursive:true});await writeFile(resolve(root,`docs/acceptance/evidence/2026-10-17/t12-m2-${name}.json`),JSON.stringify(report,null,2));
  await closeDatabase();if(failed)process.exitCode=1;
}
