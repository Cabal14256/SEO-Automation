import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const normalize = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase();
export const key = (sid, fba) => JSON.stringify([sid, String(fba).trim().toUpperCase()]);
const contentFields = ['channel', 'destinationFc', 'referenceQuantity', 'notes', 'subBatchName'];
const check = (condition, message) => { if (!condition) throw new Error(message); };
const integer = (value) => { check(typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)), '确认数据缺少合法整数数量，不能用0补齐'); return Number(value); };
export const filePath = (base, name) => { check(typeof name === 'string' && name.length > 0, '需要文件路径'); return resolve(base, name); };
export async function appModules() {
  const contracts = await import(pathToFileURL(resolve(root, 'packages/contracts/dist/index.js')));
  const parser = await import(pathToFileURL(resolve(root, 'apps/server/dist/modules/imports/parser.js')));
  const require = createRequire(resolve(root, 'apps/server/package.json'));
  return { contracts, parser, ExcelJS: require('exceljs') };
}
export async function newOutput(path) {
  const absolute = resolve(path), rel = relative(root, absolute);
  check(rel && (rel === '..' || /^\.\.[\\/]/.test(rel) || isAbsolute(rel) || /^\.local[\\/]|^docs[\\/]private[\\/]/.test(rel)), '原始业务证据必须保存在工作区外、.local 或 docs/private 中');
  await mkdir(dirname(absolute), { recursive: true });
  await mkdir(absolute); // Existing results are immutable; choose a new directory.
  return absolute;
}
export async function putJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
export async function inventory(path) {
  const result = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      check(!entry.isSymbolicLink(), '证据包不能包含符号链接');
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) { const bytes = await readFile(full); result.push({ path: relative(path, full).replaceAll('\\', '/'), byteSize: bytes.length, sha256: hash(bytes) }); }
    }
  }
  await visit(path); return result;
}
export async function seal(path, metadata) {
  const manifest = { schemaVersion: 1, ...metadata, files: await inventory(path) };
  await putJson(join(path, 'package-manifest.json'), manifest);
  const sha256 = hash(await readFile(join(path, 'package-manifest.json')));
  await writeFile(join(path, 'package.sha256'), `${sha256}\n`, { flag: 'wx', mode: 0o600 });
  return sha256;
}
export async function verifyPackage(path) {
  const bytes = await readFile(join(path, 'package-manifest.json'));
  check(hash(bytes) === (await readFile(join(path, 'package.sha256'), 'utf8')).trim(), '证据包清单哈希不符');
  const manifest = JSON.parse(bytes), actual = (await inventory(path)).filter((entry) => !['package-manifest.json', 'package.sha256'].includes(entry.path));
  check(canonical(actual) === canonical(manifest.files), '证据包文件缺失、增加或哈希不符');
  return { manifest, sha256: hash(bytes) };
}
async function keepInput(out, input, label) {
  const target = join(out, 'inputs', `${label}${/\.xlsx$/i.test(input) ? '.xlsx' : '.json'}`);
  await mkdir(dirname(target), { recursive: true }); await copyFile(input, target);
  return { path: relative(out, target).replaceAll('\\', '/'), originalName: basename(input), sha256: hash(await readFile(target)) };
}

export function deriveDiff(beforeRows, afterRows, confirmations, mode = 'snapshot') {
  const mappings = new Map();
  for (const mapping of confirmations) {
    check(Number.isSafeInteger(mapping.sid) && mapping.sid > 0 && mapping.sourceShop && mapping.country && mapping.confirmedBy && !Number.isNaN(Date.parse(mapping.confirmedAt)), '店铺确认需要 sourceShop、sid、country、confirmedBy、confirmedAt');
    check(!mappings.has(normalize(mapping.sourceShop)), '来源名称存在重复店铺确认');
    mappings.set(normalize(mapping.sourceShop), mapping);
  }
  const grouped = (rows) => {
    const groups = new Map(), errors = [];
    for (const row of rows) {
      const item = row.normalized, mapping = mappings.get(normalize(item.shop));
      const problems = row.issues.filter((i) => i.severity === 'error');
      if (!mapping) problems.push({ code: 'IMPORT_SELLER_CONFIRMATION_REQUIRED' });
      if (mapping && item.country && normalize(mapping.country) !== normalize(item.country)) problems.push({ code: 'COUNTRY_MISMATCH' });
      const source = { sheetName: row.sheetName, rowNumber: row.rowNumber, addresses: row.rawCells.map((c) => c.address) };
      if (!mapping || !item.fba || problems.length) { errors.push({ kind: 'error', sid: mapping?.sid ?? null, fba: item.fba, sources: [source], issues: problems.map((i) => i.code) }); continue; }
      const identity = key(mapping.sid, item.fba), value = { sid: mapping.sid, fba: item.fba, country: mapping.country, ...Object.fromEntries(contentFields.map((field) => [field, item[field] ?? null])) };
      const group = groups.get(identity) ?? { value, variants: new Set(), sources: [] };
      group.variants.add(canonical(Object.fromEntries(contentFields.map((field) => [field, value[field]])))); group.sources.push(source); groups.set(identity, group);
    }
    return { groups, errors };
  };
  const before = grouped(beforeRows), after = grouped(afterRows), items = [...after.errors];
  for (const [identity, group] of after.groups) {
    const old = before.groups.get(identity);
    const conflict = group.variants.size > 1 || old?.variants.size > 1;
    const changedFields = old ? contentFields.filter((field) => old.value[field] !== group.value[field]) : [];
    items.push({ sid: group.value.sid, fba: group.value.fba, kind: conflict ? 'conflict' : !old ? 'new' : changedFields.length ? 'changed' : 'unchanged', changedFields, before: old?.value ?? null, after: group.value, sources: group.sources, baselineSources: old?.sources ?? [] });
  }
  const missingDeferred = mode === 'snapshot' && after.errors.length > 0;
  if (mode === 'snapshot' && !missingDeferred) for (const [identity, group] of before.groups) if (!after.groups.has(identity)) items.push({ sid: group.value.sid, fba: group.value.fba, kind: 'missing', before: group.value, after: null, sources: [], baselineSources: group.sources, action: '仅提示，不撤销需求' });
  const counts = Object.fromEntries(['new', 'unchanged', 'changed', 'conflict', 'error', 'missing'].map((kind) => [kind, items.filter((item) => item.kind === kind).length]));
  return { items, counts, baselineErrors: before.errors, baselineConflicts: [...before.groups.values()].filter((g) => g.variants.size > 1).length, missingDeferred, missingPolicy: mode === 'delta' ? '仅增量文件不推断缺失' : missingDeferred ? '身份未解决，暂停缺失推断' : '完整快照缺失仅提示' };
}
export function compareDiff(expected, actual) {
  const comparable = (items) => items.map((item) => ({ sid: item.sid, fba: item.fba, kind: item.kind, changedFields: [...item.changedFields ?? []].sort() })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return canonical(comparable(expected)) === canonical(comparable(actual));
}
export function verifyImportObservations(evidence, diff) {
  const failures = [], pending = [];
  const need = ['initialCommit', 'incrementCommit', 'replayCommit', 'beforeDemands', 'afterDemands', 'demandDetails', 'actualPreview'];
  for (const name of need) if (!evidence[name]) pending.push(`缺少业务实测 ${name}`);
  if (pending.length) return { failures, pending };
  const increment = evidence.incrementCommit, replay = evidence.replayCommit;
  if (!replay.replayed || replay.operationId !== increment.operationId || canonical({ ...replay, replayed: false }) !== canonical({ ...increment, replayed: false })) failures.push('幂等重放未返回同操作的原始结果');
  const before = new Map(evidence.beforeDemands.map((d) => [key(d.snapshot.sid, d.snapshot.fba), d])), after = new Map();
  for (const demand of evidence.afterDemands) { const id = key(demand.snapshot.sid, demand.snapshot.fba); if (after.has(id)) failures.push(`sid + FBA 重复需求：${id}`); after.set(id, demand); }
  for (const [id, demand] of before) { const current = after.get(id); if (!current) failures.push(`缺行导致原需求消失：${id}`); else if (['id', 'businessDate', 'weekStartDate', 'weekEndDate'].some((f) => current[f] !== demand[f])) failures.push(`首次业务日期、周或稳定身份变化：${id}`); }
  const actual = evidence.actualPreview.items.map((i) => ({ ...i, changedFields: i.kind === 'changed' ? contentFields.filter((f) => i.before?.[f] !== i.after?.[f]) : [] }));
  if (!compareDiff(diff.items.map((i) => ({ ...i, changedFields: i.changedFields ?? [] })), actual)) failures.push('页面差异预览与独立文件对账不一致');
  const linked = [...evidence.initialCommit.items, ...increment.items];
  for (const item of linked) for (const location of item.sources) {
    const detail = evidence.demandDetails.find((d) => d.demand.id === item.demandId);
    if (!detail?.sources.some((entry) => entry.source.importId === location.importId && entry.source.sheetName === location.sheetName && entry.source.rowNumber === location.rowNumber && entry.source.fileName === location.fileName && canonical(entry.source.addresses) === canonical(location.addresses))) failures.push(`来源关联缺失：${item.demandId}/${location.sheetName}/${location.rowNumber}`);
  }
  return { failures, pending };
}
export async function preflight(manifestPath, output) {
  const base = dirname(resolve(manifestPath)), input = await json(manifestPath), out = await newOutput(output), pending = [], inputs = [];
  check(input.schemaVersion === 1, '不支持的资料清单版本');
  const { parser, contracts } = await appModules();
  async function parseSource(source, name) {
    if (!source?.path) { pending.push(`缺少${name}真实文件`); return null; }
    check(['snapshot', 'delta'].includes(source.kind), `${name}必须说明 snapshot 或 delta`);
    check(source.source, `${name}必须说明来源`);
    if (!source.exportedAt || Number.isNaN(Date.parse(source.exportedAt))) pending.push(`${name}缺少可核实的来源导出时间`);
    const path = filePath(base, source.path), bytes = await readFile(path), sha256 = hash(bytes);
    if (source.sha256) check(sha256 === source.sha256, `${name}文件哈希不符`);
    const parsed = parser.parseImportWorkbook(bytes, source.sheetName ? { sheetName: source.sheetName, mappingVersion: source.mappingVersion } : undefined);
    const retained = await keepInput(out, path, name); inputs.push(retained);
    if (parsed.status !== 'preview_ready') pending.push(`${name}工作表映射尚未确定`);
    return { source: { ...source, path: retained.path, sha256 }, parsed };
  }
  const initial = await parseSource(input.initial, 'initial'), increment = await parseSource(input.increment, 'increment');
  let diff = null, expectedMatched = null;
  if (initial && increment && initial.parsed.status === 'preview_ready' && increment.parsed.status === 'preview_ready') {
    diff = deriveDiff(initial.parsed.rows, increment.parsed.rows, input.sellerConfirmations ?? [], increment.source.kind);
    if (diff.baselineErrors.length || diff.baselineConflicts) pending.push('首次资料存在未解决身份或冲突，须与已接受需求逐项核对');
    if (diff.missingDeferred) pending.push('当前身份未解决，缺失比较待验');
    if (input.expectedDiff) { const path = filePath(base, input.expectedDiff); inputs.push(await keepInput(out, path, 'human-expected-diff')); expectedMatched = compareDiff(await json(path), diff.items); }
    else pending.push('缺少人工预期差异清单');
  }
  let observations = null;
  if (input.operationEvidence && diff) {
    const path = filePath(base, input.operationEvidence), raw = await json(path); inputs.push(await keepInput(out, path, 'business-observations'));
    const schemas = { initialCommit: contracts.importCommitResultSchema, incrementCommit: contracts.importCommitResultSchema, replayCommit: contracts.importCommitResultSchema, beforeDemands: contracts.demandRecordSchema.array(), afterDemands: contracts.demandRecordSchema.array(), demandDetails: contracts.demandDetailSchema.array(), actualPreview: contracts.importPreviewPayloadSchema };
    for (const [field, schema] of Object.entries(schemas)) if (raw[field]) raw[field] = schema.parse(raw[field]);
    observations = verifyImportObservations(raw, diff); pending.push(...observations.pending);
  } else pending.push('真实页面提交、幂等重放、首次业务日期和来源关联需业务实测证据');
  const covered = diff ? ['new', 'unchanged', 'changed', 'conflict', 'error', 'missing'].filter((kind) => diff.counts[kind] > 0) : [];
  const result = { schemaVersion: 1, task: 'T13', result: expectedMatched === false || observations?.failures.length ? 'mismatch' : pending.length ? 'pending' : 'ready_for_business_review', automatedComparison: expectedMatched, generatedAt: new Date().toISOString(), pending, uncoveredRealCategories: ['new', 'unchanged', 'changed', 'conflict', 'error', 'missing'].filter((kind) => !covered.includes(kind)), observations, sourceManifest: { ...input, initial: initial?.source ?? null, increment: increment?.source ?? null }, initial: initial ? { counts: initial.parsed.counts, sheetName: initial.parsed.sheetName, issues: initial.parsed.issues } : null, increment: increment ? { counts: increment.parsed.counts, sheetName: increment.parsed.sheetName, issues: increment.parsed.issues } : null, diff, inputs, realBusinessRequests: 0 };
  await putJson(join(out, 'preflight.json'), result);
  await writeFile(join(out, 'review.md'), `# T13 真实增量验收\n\n状态：${result.result}。此工具不提交业务数据。\n\n${pending.map((p) => `- [ ] ${p}`).join('\n')}\n\n- [ ] 首次与后续导入在业务页面完成店铺确认和差异复核\n- [ ] 重放同一次确认不新增需求，缺行不撤销\n- [ ] 现存 sid + FBA 首次业务日期及周范围不变\n- [ ] 原文件、工作表、物理行与需求来源一致\n- [ ] 所有未覆盖真实变化类别列为待验\n`, { flag: 'wx', mode: 0o600 });
  const sha256 = await seal(out, { task: 'T13', result: result.result });
  return { task: 'T13', result: result.result, pending: pending.length, sha256, output: out, realBusinessRequests: 0 };
}

const productKey = (row) => canonical([row.sid, row.fba, row.msku, row.fnsku, row.sku]);
export function compareRows(expected, actual, fields, identity = productKey) {
  const differences = [], group = (rows) => { const result = new Map(); for (const row of rows) { const id = identity(row); if (result.has(id)) differences.push({ key: id, field: 'duplicate', expected: null, actual: row }); else result.set(id, row); } return result; };
  const left = group(expected), right = group(actual);
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(id), b = right.get(id);
    if (!a || !b) { differences.push({ key: id, field: a ? 'missing' : 'extra', expected: a ?? null, actual: b ?? null }); continue; }
    for (const field of fields) if (canonical(a[field] ?? null) !== canonical(b[field] ?? null)) differences.push({ key: id, field, expected: a[field] ?? null, actual: b[field] ?? null });
  }
  return differences;
}
export function combinePages(pages) {
  check(pages.length > 0, '需要完整报表分页');
  const sorted = [...pages].sort((a, b) => a.page - b.page), first = sorted[0];
  check(first.page === 1, '报表缺少第一页');
  for (const [index, page] of sorted.entries()) {
    check(page.page === index + 1 && page.pageSize === first.pageSize && page.total === first.total && canonical(page.confirmations) === canonical(first.confirmations) && canonical(page.boxes) === canonical(first.boxes), '报表分页缺失、重复或版本发生变化');
    check(page.rows.length === Math.min(page.pageSize, page.total - index * page.pageSize), '报表分页提前结束或包含多余行');
    check(!page.blocked.length, '报表包含阻塞组');
  }
  check(sorted.flatMap((p) => p.rows).length === first.total, '报表分页不完整');
  return { ...first, rows: sorted.flatMap((p) => p.rows) };
}
export async function workbookRows(path, ExcelJS) {
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path);
  const main = book.worksheets[0], detail = book.getWorksheet('逐箱明细'), versions = book.getWorksheet('版本说明');
  check(main && detail && versions, '成品表缺少主表、逐箱明细或版本说明');
  function rows(sheet) {
    const headers = sheet.getRow(1).values.slice(1), result = [];
    check(new Set(headers).size === headers.length, 'XLSX 存在重复表头');
    sheet.eachRow((row, number) => { if (number === 1) return; const item = {}; for (const [i, header] of headers.entries()) { const value = row.getCell(i + 1).value; check(value === null || value instanceof Date || ['number', 'string', 'boolean'].includes(typeof value), 'XLSX 不应使用公式或富文本替代计算结果'); item[header] = value instanceof Date ? value.toISOString().slice(0, 10) : value; } result.push(item); });
    return result;
  }
  return { products: rows(main), boxes: rows(detail), versions: rows(versions), productHeaders: main.getRow(1).values.slice(1), boxHeaders: detail.getRow(1).values.slice(1) };
}

export async function batchPackage(manifestPath, output) {
  const base = dirname(resolve(manifestPath)), input = await json(manifestPath), out = await newOutput(output), pending = [], differences = [], inputs = [];
  check(input.schemaVersion === 1, '不支持的批次清单版本');
  const { contracts, ExcelJS } = await appModules();
  async function load(name, label, schema) { const path = filePath(base, name); inputs.push(await keepInput(out, path, label)); const value = await json(path); return schema ? schema.parse(value) : value; }
  const groups = await Promise.all((input.groupDetails ?? []).map((path, index) => load(path, `group-${index}`, contracts.subBatchDetailSchema)));
  check(groups.length > 0 && new Set(groups.map((d) => d.group.id)).size === groups.length, '需要不重复的实际业务组');
  check(groups.every((d) => d.group.batchId === input.batchId && d.confirmation && ['confirmed', 'frozen'].includes(d.group.status) && !d.group.replacedById && !d.issues.some((i) => i.severity === 'error')), '业务组尚未完成确认或存在阻塞差异');
  const pages = await Promise.all((input.reportPages ?? []).map((path, index) => load(path, `report-${index}`, contracts.reportResponseSchema))), report = combinePages(pages);
  const refs = groups.map((d) => ({ groupId: d.group.id, groupVersion: d.group.version, confirmationId: d.confirmation.id })).sort((a, b) => a.groupId.localeCompare(b.groupId));
  const sortedRefs = (items) => [...items].sort((a, b) => a.groupId.localeCompare(b.groupId));
  check(canonical(refs) === canonical(sortedRefs(report.confirmations)), '页面报表确认版本与业务组不符');
  const exportedRaw = await load(input.exportRecord, 'export-record'), exported = contracts.reportExportRecordSchema.parse(exportedRaw.export ?? exportedRaw);
  check(exported.status === 'completed' && exported.valid && exported.fileId && canonical(refs) === canonical(sortedRefs(exported.references)), '导出版本无效或与当前组不符');
  check(exported.rowCount === report.rows.length && exported.boxCount === report.boxes.length, '页面与导出范围不一致');
  const xlsxPath = filePath(base, input.workbook); inputs.push(await keepInput(out, xlsxPath, 'shipment-record')); const xlsx = await workbookRows(xlsxPath, ExcelJS);
  const headerMap = { fba: 'FBA货件号', shop: '店铺', country: '国家', channel: '渠道', destinationFc: '目的FC', msku: 'MSKU', fnsku: 'FNSKU', sku: 'SKU', productName: '品名', quantity: '发货数量', groupName: '打包批次', status: '流程状态', actualShipDate: '实际发货日期', businessDate: '业务日期', dataRevisionId: '数据版本' };
  check([...Object.values(headerMap), '内部编码', '子批次商品合计', '本月商品数量', ...Array.from({ length: Math.max(10, report.maxBoxes) }, (_, index) => `箱${index + 1}`)].every((h) => xlsx.productHeaders.includes(h)), 'XLSX 主表缺少固定字段或完整动态箱列');
  const mappedProducts = xlsx.products.map((row) => Object.fromEntries(Object.entries(headerMap).map(([field, header]) => [field, row[header]])));
  const productIdentityWithoutSid = (r) => canonical([r.shop, r.country, r.fba, r.msku, r.fnsku, r.sku]);
  differences.push(...compareRows(report.rows, mappedProducts, Object.keys(headerMap), productIdentityWithoutSid).map((d) => ({ ...d, source: 'page-vs-xlsx-product' })));
  const displayed = new Set();
  for (const [index, row] of report.rows.entries()) {
    const x = xlsx.products[index]; if (!x) continue;
    const groupProduct = canonical([row.groupId, row.sid, row.msku, row.fnsku, row.sku]), first = !displayed.has(groupProduct); displayed.add(groupProduct);
    for (const [field, expected] of [['内部编码', row.codes.join('、')], ['子批次商品合计', first ? row.groupQuantity : null], ['本月商品数量', first ? row.monthQuantity : null]]) if (canonical(x[field] ?? null) !== canonical(expected)) differences.push({ source: 'page-vs-xlsx-product', key: productKey(row), field, expected, actual: x[field] ?? null });
    for (let box = 1; box <= Math.max(10, report.maxBoxes); box++) { const expected = row.boxes.find((b) => b.boxOrder === box)?.quantity ?? null; if (canonical(x[`箱${box}`] ?? null) !== canonical(expected)) differences.push({ source: 'page-vs-xlsx-product', key: productKey(row), field: `箱${box}`, expected, actual: x[`箱${box}`] ?? null }); }
  }
  const flattenBoxes = (boxes) => boxes.flatMap((b) => b.items.map((item) => ({ ...b, ...item, items: undefined })));
  const boxFields = { sid: 'sid', fba: 'FBA货件号', boxId: '内部箱ID', boxExternalId: '平台箱ID', boxName: '平台箱名', boxOrder: '货件内箱序', code: '内部编码', msku: 'MSKU', fnsku: 'FNSKU', sku: 'SKU', quantity: '箱内数量', weight: '重量', weightUnit: '重量单位', length: '长', width: '宽', height: '高', lengthUnit: '尺寸单位', confirmationId: '确认版本' };
  const mappedBoxes = xlsx.boxes.map((row) => Object.fromEntries(Object.entries(boxFields).map(([field, header]) => [field, field === 'sid' ? Number(row[header]) : row[header]])));
  const boxIdentity = (r) => canonical([r.sid, r.fba, r.boxId, r.msku, r.fnsku, r.sku]);
  differences.push(...compareRows(flattenBoxes(report.boxes), mappedBoxes, Object.keys(boxFields), boxIdentity).map((d) => ({ ...d, source: 'page-vs-xlsx-box' })));
  check(xlsx.versions.some((v) => v['项目'] === '导出编号' && v['值'] === exported.id), 'XLSX 导出编号与记录不符');
  for (const ref of refs) check(xlsx.versions.some((v) => v['项目'] === '子批次确认' && v['值'] === `${ref.groupId} / 组版本 ${ref.groupVersion} / 确认 ${ref.confirmationId}`), 'XLSX 确认版本缺失');
  const demands = [];
  for (const [index, path] of (input.demandDetails ?? []).entries()) demands.push(await load(path, `demand-${index}`, contracts.demandDetailSchema));
  const allMembers = groups.flatMap((g) => g.confirmation.snapshot.members);
  check(new Set(allMembers.map((d) => d.id)).size === allMembers.length, '需求重复归组');
  for (const detail of groups) {
    const snapshot = detail.confirmation.snapshot;
    check(detail.confirmation.groupId === detail.group.id && canonical([...detail.group.demandIds].sort()) === canonical(snapshot.members.map((m) => m.id).sort()), '确认成员与当前组不符');
    for (const row of report.rows.filter((r) => r.groupId === detail.group.id)) {
      const member = snapshot.members.find((m) => m.snapshot.sid === row.sid && m.snapshot.fba === row.fba), shipment = snapshot.shipments.find((s) => s.demandId === member?.id);
      const product = shipment?.revision.data.items.find((p) => p.msku === row.msku && p.fnsku === row.fnsku && p.sku === row.sku);
      if (!member || !product || row.dataRevisionId !== shipment.revision.id || row.quantity !== integer(product.quantity) || row.businessDate !== member.businessDate) differences.push({ source: 'confirmation-vs-page', key: productKey(row), field: 'product/version/date' });
      if (row.boxes.reduce((sum, b) => sum + b.quantity, 0) !== row.quantity) differences.push({ source: 'confirmation-vs-page', key: productKey(row), field: 'quantity-conservation' });
    }
    for (const box of report.boxes.filter((b) => b.groupId === detail.group.id)) {
      const shipment = snapshot.shipments.find((s) => s.demandId === box.demandId), original = shipment?.revision.data.boxes.find((b) => b.id === box.boxId);
      if (!original || !detail.codes.some((c) => c.valid && c.demandId === box.demandId && c.boxId === box.boxId && c.code === box.code)) differences.push({ source: 'confirmation-vs-page', key: box.boxId, field: 'box/code' });
      else differences.push(...compareRows(original.items.map((i) => ({ ...i, sid: box.sid, fba: box.fba, quantity: integer(i.quantity) })), box.items.map((i) => ({ ...i, sid: box.sid, fba: box.fba })), ['quantity']).map((d) => ({ ...d, source: 'confirmation-vs-page-box' })));
    }
  }
  for (const member of allMembers) { const detail = demands.find((d) => d.demand.id === member.id); if (!detail?.sources.length) pending.push(`需求 ${member.id} 缺少原文件/工作表/物理行证据`); else if (detail.demand.version !== member.version || detail.demand.businessDate !== member.businessDate) differences.push({ source: 'demand-provenance', key: member.id, field: 'version/businessDate' }); }
  if (input.humanReference) {
    const manual = await load(input.humanReference, 'human-reference');
    check(manual.preparedBy && manual.preparedAt && manual.source && manual.products?.length && manual.boxes?.length, '人工参考必须说明编制人、时间、来源、商品及逐箱明细');
    const productFields = ['groupName', 'quantity', 'productName', 'codes', 'groupQuantity', 'monthQuantity', 'businessDate', 'actualShipDate'];
    differences.push(...compareRows(manual.products, report.rows, productFields).map((d) => ({ ...d, source: 'human-vs-page-product' })));
    const manualBoxIdentity = (r) => canonical([r.sid, r.fba, r.boxOrder, r.msku, r.fnsku, r.sku]);
    differences.push(...compareRows(manual.boxes, flattenBoxes(report.boxes), ['groupName', 'boxOrder', 'code', 'quantity'], manualBoxIdentity).map((d) => ({ ...d, source: 'human-vs-page-box' })));
    if (!manual.independentlyPrepared) pending.push('人工参考尚未声明独立编制，不能用导出结果回填代替参考');
  } else pending.push('缺少独立人工参考商品和逐箱明细');
  const waived = groups.flatMap((g) => g.issues.filter((i) => i.code === 'LIST_QUANTITY_MISMATCH' && i.severity === 'warning').map((i) => ({ groupId: g.group.id, demandId: i.demandId })));
  const decisions = input.decisionEvidence ? await load(input.decisionEvidence, 'decision-evidence') : [];
  for (const issue of waived) if (!decisions.some((d) => d.groupId === issue.groupId && d.demandId === issue.demandId && d.issueCode === 'LIST_QUANTITY_MISMATCH' && d.note && d.createdBy && d.createdAt)) pending.push(`差异决定 ${issue.demandId} 缺少原因或操作者`);
  let historicalShipments = 0;
  if (input.historicalEvidence) { const evidence = await load(input.historicalEvidence, 'historical-real-evidence'); historicalShipments = new Set((evidence.liveResults ?? []).flatMap((run) => run.items ?? []).filter((i) => i.status === 'completed').map((i) => key(i.sid, i.fba))).size; }
  if (historicalShipments < 20) pending.push('未附至少20票真实历史货件证据，技术夹具不计入');
  const result = { schemaVersion: 1, task: 'T22', result: differences.length ? 'mismatch' : pending.length ? 'pending' : 'ready_for_signoff', generatedAt: new Date().toISOString(), batchId: input.batchId, orderedGroups: [...groups].sort((a, b) => a.group.position - b.group.position).map((g) => ({ id: g.group.id, name: g.group.name, position: g.group.position, prefix: g.group.prefix, version: g.group.version, confirmationId: g.confirmation.id, ruleVersion: g.confirmation.snapshot.ruleVersion })), references: refs, shipmentCount: allMembers.length, historicalShipments, productRows: report.rows.length, boxes: report.boxes.length, exportId: exported.id, workbookSha256: hash(await readFile(xlsxPath)), templateVersion: xlsx.versions.find((v) => v['项目'] === '模板版本')?.['值'], pending, differences, inputs, realBusinessRequests: 0 };
  await putJson(join(out, 'reconciliation.json'), result);
  await putJson(join(out, 'product-rows.json'), report.rows); await putJson(join(out, 'box-rows.json'), flattenBoxes(report.boxes));
  await writeFile(join(out, 'review.md'), `# T22 实际批次签收\n\n状态：${result.result}。自动对账不能代替业务签收。\n\n商品 ${result.productRows} 行，箱 ${result.boxes} 个，差异 ${differences.length} 项。\n\n${pending.map((p) => `- [ ] ${p}`).join('\n')}\n\n请逐行核对 product-rows.json、box-rows.json、原始参考及 XLSX，明确给出接受或拒绝结论。\n`, { flag: 'wx', mode: 0o600 });
  const sha256 = await seal(out, { task: 'T22', result: result.result, batchId: input.batchId });
  return { task: 'T22', result: result.result, differences: differences.length, pending: pending.length, sha256, output: out, realBusinessRequests: 0 };
}

export async function recordSignoff(packagePath, decisionPath, output) {
  const checked = await verifyPackage(resolve(packagePath)), decision = await json(decisionPath), base = dirname(resolve(decisionPath));
  check(['accepted', 'rejected', 'pending'].includes(decision.decision), '签收决定必须为 accepted、rejected 或 pending');
  check(decision.signer && decision.statement && decision.decidedAt && !Number.isNaN(Date.parse(decision.decidedAt)) && decision.packageSha256 === checked.sha256, '签收需要姓名、明确结论、时间和匹配的证据包哈希');
  check(checked.manifest.task === 'T22', '业务批次签收只能绑定 T22 包');
  if (decision.decision === 'accepted') check(checked.manifest.result === 'ready_for_signoff', '存在缺失材料或对账差异，不能登记通过');
  const evidence = await readFile(filePath(base, decision.evidencePath)); check(evidence.length > 0, '必须保留用户明确结论的原文证据');
  const out = await newOutput(output);
  await writeFile(join(out, 'explicit-user-decision.txt'), evidence, { flag: 'wx', mode: 0o600 });
  const result = { schemaVersion: 1, task: 'T22', decision: decision.decision, signer: decision.signer, statement: decision.statement, decidedAt: decision.decidedAt, recordedAt: new Date().toISOString(), packageSha256: checked.sha256, explicitEvidenceSha256: hash(evidence), note: '此记录保留用户明确结论及哈希，不提供数字签名或身份认证。' };
  await putJson(join(out, 'signoff.json'), result); const sha256 = await seal(out, { task: 'T22-signoff', result: decision.decision });
  return { task: 'T22', result: decision.decision, sha256, output: out };
}
