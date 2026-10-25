import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appModules, batchPackage, canonical, filePath, json, newOutput, preflight, putJson, recordSignoff, root, verifyPackage } from './core.mjs';

const usage = `验收工具（不写业务数据库，不调用领星）
  node scripts/acceptance/cli.mjs prepare [--out <私有目录，默认 .local/development/data/acceptance>]
  node scripts/acceptance/cli.mjs preflight --manifest <intake-manifest.json> --out <新目录>
  node scripts/acceptance/cli.mjs capture --manifest <capture.json> --cookie-file <私有Cookie文件> --out <新目录>
  node scripts/acceptance/cli.mjs batch-package --manifest <batch-manifest.json> --out <新目录>
  node scripts/acceptance/cli.mjs verify --package <证据包目录>
  node scripts/acceptance/cli.mjs signoff --package <证据包目录> --decision <明确结论.json> --out <新目录>
Cookie 文件只供现有管理员会话 GET 请求，绝不保存到包中。证书应受信任，不能关闭 TLS 校验。`;

export async function prepare(output = resolve(root, '.local/development/data/acceptance')) {
  const out = resolve(output); await mkdir(out, { recursive: true });
  async function template(name, value) { const path = join(out, name); try { await putJson(path, value); } catch (e) { if (e.code !== 'EEXIST') throw e; } return path; }
  const manifest = await template('intake-manifest.json', { schemaVersion: 1, initial: { path: resolve(root, '.local/acceptance/source.xlsx'), sha256: '0000000000000000000000000000000000000000000000000000000000000000', source: '请在私有清单中填写原件路径、独立核验的 SHA-256、来源和导出时间', exportedAt: null, kind: 'snapshot', sheetName: '飞书表格', mappingVersion: 'feishu-v1' }, increment: null, sellerConfirmations: [], expectedDiff: null });
  await template('batch-manifest.example.json', { schemaVersion: 1, batchId: null, groupDetails: [], demandDetails: [], reportPages: [], exportRecord: null, workbook: null, humanReference: null, decisionEvidence: null, historicalEvidence: resolve(root, 'docs/acceptance/evidence/2026-10-17/t12-m2-e2e.json') });
  await template('capture.example.json', { schemaVersion: 1, baseUrl: 'https://scm.example.invalid', batchId: null, groupIds: [], exportId: null, humanReference: null, decisionEvidence: null, historicalEvidence: resolve(root, 'docs/acceptance/evidence/2026-10-17/t12-m2-e2e.json') });
  await template('signoff.example.json', { decision: 'pending', signer: null, statement: null, decidedAt: null, packageSha256: null, evidencePath: null });
  const report = await preflight(manifest, join(out, `preflight-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`));
  return { ...report, templates: out, note: '原件已只读解析；真实增量、人工参考及用户签收仍待补充。' };
}

export async function capture(manifestPath, cookiePath, output, fetcher = fetch) {
  const input = await json(manifestPath), base = dirname(resolve(manifestPath)), { contracts } = await appModules();
  if (input.schemaVersion !== 1 || !input.batchId || !input.exportId || !input.groupIds?.length || new Set(input.groupIds).size !== input.groupIds.length) throw new Error('需要实际批次、组和已完成导出编号');
  const url = new URL(input.baseUrl); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('只允许 HTTPS 或本机 HTTP');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('baseUrl 只能包含可信服务 origin');
  const cookie = (await readFile(cookiePath, 'utf8')).trim(); if (!cookie || /[\r\n]/.test(cookie)) throw new Error('Cookie 文件格式无效');
  const uuid = (value) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('对象编号无效'); return value; };
  uuid(input.batchId); uuid(input.exportId); input.groupIds.forEach(uuid);
  async function get(path, binary = false) {
    const response = await fetcher(new URL(path, url), { method: 'GET', headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`只读采集失败：HTTP ${response.status}，路径 ${path.split('?')[0]}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  const weekly = contracts.weeklyBatchDetailSchema.parse(await get(`/api/v1/weekly-batches/${input.batchId}`));
  if (input.groupIds.some((id) => !weekly.groups.some((g) => g.id === id))) throw new Error('组不属于所选批次');
  const exported = await get(`/api/v1/batch-reports/exports/${input.exportId}`), record = contracts.reportExportRecordSchema.parse(exported.export);
  if (!record.valid || record.status !== 'completed' || !record.fileId || canonical([...record.groupIds].sort()) !== canonical([...input.groupIds].sort())) throw new Error('导出必须已完成且恰好覆盖所选实际组');
  const out = await newOutput(output), groupDetails = [], demandDetails = [], reportPages = [];
  const before = [];
  for (const [index, id] of input.groupIds.entries()) {
    const detail = contracts.subBatchDetailSchema.parse(await get(`/api/v1/sub-batches/${id}`)); before.push(detail); const name = `group-${index}.json`; await putJson(join(out, name), detail); groupDetails.push(name);
    for (const member of detail.members) { const name = `demand-${uuid(member.id)}.json`; if (!demandDetails.includes(name)) { await putJson(join(out, name), await get(`/api/v1/demands/${member.id}`)); demandDetails.push(name); } }
  }
  const filter = new URLSearchParams({ weeklyBatchId: input.batchId, region: record.region, pageSize: '100' }); if (record.month) filter.set('month', record.month);
  // A batch package represents the entire export scope. Capturing a partial week
  // uses per-group pages which are joined below without losing the global order.
  const all = [], boxes = [], refs = [], blocked = []; let generatedAt, maxBoxes = 0;
  for (const id of input.groupIds) {
    filter.delete('weeklyBatchId'); filter.set('subBatchId', id);
    let total = Infinity;
    for (let page = 1; (page - 1) * 100 < total; page++) {
      filter.set('page', String(page)); const data = contracts.reportResponseSchema.parse(await get(`/api/v1/batch-reports?${filter}`));
      if (total !== Infinity && total !== data.total) throw new Error('采集期间报表总数变化'); total = data.total; all.push(...data.rows); generatedAt ??= data.generatedAt;
      if (page === 1) { boxes.push(...data.boxes); refs.push(...data.confirmations); blocked.push(...data.blocked); maxBoxes = Math.max(maxBoxes, data.maxBoxes); }
      if (data.rows.length !== Math.min(100, total - (page - 1) * 100)) throw new Error('报表分页提前结束');
    }
  }
  // Match the service projection's saved group order, independent of input order.
  const order = new Map(before.map((g) => [g.group.id, g.group.position])); all.sort((a, b) => order.get(a.groupId) - order.get(b.groupId)); boxes.sort((a, b) => order.get(a.groupId) - order.get(b.groupId));
  const report = { rows: all, boxes, confirmations: refs, blocked, total: all.length, page: 1, pageSize: Math.max(1, all.length), generatedAt: generatedAt ?? new Date().toISOString(), maxBoxes };
  await putJson(join(out, 'report.json'), report); reportPages.push('report.json'); await putJson(join(out, 'export.json'), exported);
  await writeFile(join(out, 'shipment-record.xlsx'), await get(`/api/v1/files/${uuid(record.fileId)}/download`, true), { flag: 'wx', mode: 0o600 });
  for (const detail of before) { const after = contracts.subBatchDetailSchema.parse(await get(`/api/v1/sub-batches/${detail.group.id}`)); if (canonical(detail) !== canonical(after)) throw new Error('采集期间业务组发生变化；结果未获准用于签收'); }
  const finalExport = await get(`/api/v1/batch-reports/exports/${input.exportId}`); if (canonical(finalExport) !== canonical(exported)) throw new Error('采集期间导出有效性发生变化');
  const manifest = { schemaVersion: 1, batchId: input.batchId, groupDetails, demandDetails, reportPages, exportRecord: 'export.json', workbook: 'shipment-record.xlsx', humanReference: input.humanReference ? filePath(base, input.humanReference) : null, decisionEvidence: input.decisionEvidence ? filePath(base, input.decisionEvidence) : null, historicalEvidence: input.historicalEvidence ? filePath(base, input.historicalEvidence) : null };
  await putJson(join(out, 'batch-manifest.json'), manifest);
  return { task: 'T22-capture', result: 'captured_for_review', manifest: join(out, 'batch-manifest.json'), productRows: all.length, boxes: boxes.length, realBusinessRequests: 0, note: '仅访问本地应用现有记录；未发领星请求，未创建/修改业务批次。' };
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args, options = {};
  for (let index = 0; index < rest.length; index += 2) { if (!rest[index]?.startsWith('--') || !rest[index + 1] || rest[index + 1].startsWith('--') || options[rest[index].slice(2)]) throw new Error(usage); options[rest[index].slice(2)] = rest[index + 1]; }
  const needed = (...names) => names.forEach((name) => { if (!options[name]) throw new Error(`缺少 --${name}\n${usage}`); });
  if (command === 'prepare') return prepare(options.out);
  if (command === 'preflight') { needed('manifest', 'out'); return preflight(options.manifest, options.out); }
  if (command === 'capture') { needed('manifest', 'cookie-file', 'out'); return capture(options.manifest, options['cookie-file'], options.out); }
  if (command === 'batch-package') { needed('manifest', 'out'); return batchPackage(options.manifest, options.out); }
  if (command === 'verify') { needed('package'); const checked = await verifyPackage(resolve(options.package)); return { result: 'integrity_verified', sha256: checked.sha256, task: checked.manifest.task }; }
  if (command === 'signoff') { needed('package', 'decision', 'out'); return recordSignoff(options.package, options.decision, options.out); }
  throw new Error(usage);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then((result) => { console.log(JSON.stringify(result, null, 2)); if (result.result === 'mismatch') process.exitCode = 2; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
