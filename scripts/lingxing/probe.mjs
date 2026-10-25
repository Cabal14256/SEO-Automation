import { createCipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PATHS = Object.freeze({
  sellers: '/erp/sc/data/seller/lists',
  list: '/erp/sc/data/fba_report/shipmentList',
  detail: '/amzStaServer/openapi/inbound-shipment/shipmentDetailList',
  boxes: '/amzStaServer/openapi/inbound-shipment/listShipmentBoxes',
  inventory: '/erp/sc/routing/data/local_inventory/inventoryDetails',
});
const BASE = 'https://openapi.lingxing.com';
const present = value => value !== undefined && value !== null && value !== '' &&
  (typeof value !== 'string' || value.trim() !== '');
const array = value => Array.isArray(value) ? value : [];
const integer = value => present(value) && ['number', 'string'].includes(typeof value) &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

// Official rule: ASCII sort -> upper-case MD5 -> AES/ECB/PKCS padding -> Base64.
// JSON collections are stringified for signing only, not for the request body.
export function sign(params, appId) {
  const key = Buffer.from(appId, 'utf8');
  if (![16, 24, 32].includes(key.length)) throw new Error('AppId 必须是可用的 AES 密钥（16/24/32 字节），请核对领星 AppId。');
  const source = Object.keys(params).filter(k => params[k] !== '' && params[k] !== undefined && k !== 'sign')
    .sort().map(k => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : String(params[k])}`).join('&');
  const md5 = createHash('md5').update(source, 'utf8').digest('hex').toUpperCase();
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([cipher.update(md5, 'utf8'), cipher.final()]).toString('base64');
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets.filter(present)) {
      result = result.split(String(secret)).join('[REDACTED]');
      result = result.split(encodeURIComponent(String(secret))).join('[REDACTED]');
    }
    return result.replace(/((?:access_token|refresh_token|appSecret|app_key|sign)=)[^&\s]+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(access_token|refresh_token|appSecret|app_secret|appId|app_key|sign)$/i.test(k) ? '[REDACTED]' : redact(v, secrets)]));
  return value;
}

export class Client {
  constructor({ appId, appSecret, token, output, timeoutMs = 30000, fetchImpl = fetch, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
    Object.assign(this, { appId, appSecret, token, output, timeoutMs, fetchImpl, pause });
    this.secrets = [appId, appSecret, token];
    this.calls = [];
  }

  async authenticate() {
    if (this.token) return;
    const body = new FormData();
    body.set('appId', this.appId);
    body.set('appSecret', this.appSecret);
    const response = await this.fetchImpl(`${BASE}/api/auth-server/oauth/access-token`, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await response.json();
    this.secrets.push(data?.data?.access_token, data?.data?.refresh_token);
    if (!response.ok || String(data.code) !== '200' || !present(data?.data?.access_token)) {
      throw new Error(`鉴权失败 HTTP ${response.status}: ${JSON.stringify(redact(data, this.secrets))}`);
    }
    this.token = data.data.access_token;
    // Token and refresh token intentionally stay in memory for this short probe.
  }

  async call(name, path, params = {}) {
    if (!Object.values(PATHS).includes(path)) throw new Error('只允许预定义的查询接口');
    for (let attempt = 0; attempt < 3; attempt++) {
      const common = { access_token: this.token, app_key: this.appId, timestamp: String(Math.floor(Date.now() / 1000)) };
      const signature = sign({ ...params, ...common }, this.appId);
      const url = new URL(path, BASE);
      url.search = new URLSearchParams({ ...common, sign: signature }).toString();
      const method = path === PATHS.sellers ? 'GET' : 'POST';
      const started = Date.now();
      const record = { name, path, method, params, attempt: attempt + 1 };
      let retry = false;
      try {
        const response = await this.fetchImpl(url, {
          method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) } : {}),
          redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        });
        record.httpStatus = response.status;
        const raw = await response.text();
        try { record.response = JSON.parse(raw); } catch { record.response = { nonJsonBody: raw.slice(0, 4000) }; }
        retry = response.status === 429 || String(record.response.code) === '3001008';
        if (!response.ok || String(record.response.code) !== '0') {
          throw new Error(`HTTP ${response.status} / code ${record.response.code ?? '非 JSON'}: ${record.response.message ?? record.response.msg ?? '接口失败'}`);
        }
        record.ok = true;
      } catch (error) {
        record.ok = false;
        record.error = error.message;
      }
      record.elapsedMs = Date.now() - started;
      const safe = redact(record, [...this.secrets, signature]);
      this.calls.push(safe);
      if (this.output) await writeFile(join(this.output, 'raw', `${String(this.calls.length).padStart(3, '0')}-${name}.json`), JSON.stringify(safe, null, 2));
      if (record.ok) return record.response;
      if (retry && attempt < 2) { await this.pause(1000 * 2 ** attempt); continue; }
      throw new Error(safe.error);
    }
  }
}

export async function paginate(client, { name, path, params, extract, pageSize = 100, maxPages = 10 }) {
  const rows = [];
  const seen = new Set();
  let expected;
  for (let page = 0; page < maxPages; page++) {
    try {
      const result = await client.call(`${name}-p${page + 1}`, path, { ...params, offset: rows.length, length: pageSize });
      const batch = extract(result);
      if (!Array.isArray(batch)) throw new Error('返回数据结构不是预期的分页数组');
      const total = integer(result.total);
      if (total !== null && expected !== undefined && total !== expected) throw new Error('分页期间 total 变化，需重新采样');
      if (total !== null) expected = total;
      const digest = JSON.stringify(batch);
      if (batch.length && seen.has(digest)) throw new Error('分页重复，可能接口忽略了 offset');
      seen.add(digest);
      rows.push(...batch);
      if (expected !== undefined && rows.length > expected) throw new Error('已返回行数超过 total，分页口径异常');
      if (expected !== undefined && rows.length === expected) return { rows, complete: true, total: expected };
      if (batch.length < pageSize) {
        if (expected !== undefined && rows.length !== expected) throw new Error('分页提前结束，累计数量不等于 total');
        return { rows, complete: true, total: expected ?? rows.length };
      }
    } catch (error) { return { rows, complete: false, total: expected, error: error.message }; }
  }
  return { rows, complete: false, total: expected, error: '达到 maxPages 上限，尚未确认全部取完' };
}

function coverage(label, rows, fields, required = true) {
  return fields.map(field => ({ label: `${label}.${field}`, rows: rows.length,
    populated: rows.filter(r => present(r?.[field])).length, required }));
}

const identity = row => present(row?.msku) && present(row?.fnsku) ? JSON.stringify([String(row.msku), String(row.fnsku)]) : null;
function totals(rows, field) {
  const map = new Map();
  let valid = rows.length > 0;
  for (const row of rows) {
    const key = identity(row), quantity = integer(row[field]);
    if (!key || quantity === null) { valid = false; continue; }
    map.set(key, (map.get(key) ?? 0) + quantity);
    if (!Number.isSafeInteger(map.get(key))) valid = false;
  }
  return { map, valid };
}

export function analyze({ target, seller, listing, listComplete, detail, boxes, errors = [] }) {
  const blockers = [...errors];
  const warnings = [];
  const fba = target.shipmentConfirmationId;
  const details = array(detail?.data?.shipmentList).filter(s => s.shipmentConfirmationId === fba && String(s.sid) === String(target.sid));
  const shipment = details.length === 1 ? details[0] : undefined;
  if (details.length !== 1) blockers.push(`详情匹配到 ${details.length} 个货件，要求 sid + FBA 唯一匹配`);
  if (!seller) blockers.push('店铺列表未匹配到 sid');
  else if (String(seller.status) !== '1') blockers.push('店铺授权/同步状态不是正常状态 1');
  if (!listing) blockers.push('日期范围内未找到唯一货件列表记录，不能验证 STA 类型和列表数量');
  if (!listComplete) blockers.push('货件列表分页不完整');
  const groups = array(boxes?.data?.shipmentList);
  // A scoped query may return several groups; never flatten unrelated shipments.
  const expectedId = listing?.sta_shipment_id;
  const matched = present(expectedId) ? groups.filter(g => g.shipmentId === expectedId) : groups.length === 1 ? groups : [];
  if (matched.length !== 1) blockers.push('装箱响应不能唯一关联到当前货件');
  // Live responses use boxName too; retain the original snapshot and normalize only this view.
  const packing = matched.length === 1 ? array(matched[0].shipmentPackingList).map(box => ({
    ...box, box_name: present(box.box_name) ? box.box_name : box.boxName,
  })) : [];
  const items = array(shipment?.itemList);
  const boxItems = packing.flatMap(b => array(b.productList));
  if (!items.length) blockers.push('货件商品明细为空');
  if (!packing.length) blockers.push('装箱明细为空');
  const fields = [
    ...coverage('店铺', seller ? [seller] : [], ['sid', 'name', 'country', 'status']),
    ...coverage('货件详情', shipment ? [shipment] : [], ['shipmentConfirmationId', 'warehouseId', 'amazonReferenceId', 'shipingTime', 'alphaCode'], false),
    ...coverage('货件商品', items, ['msku', 'fnsku', 'sku', 'productName', 'quantity']),
    ...coverage('箱内商品', boxItems, ['msku', 'fnsku', 'sku', 'productName', 'quantityInBox']),
    ...coverage('箱', packing, ['boxId', 'packageId', 'localBoxId', 'box_name', 'weight', 'weightUnit', 'length', 'width', 'height', 'lengthUnit'], false),
    ...coverage('列表商品', array(listing?.item_list), ['quantity_shipped', 'init_quantity_shipped', 'quantity_shipped_local', 'quantity_received'], false),
  ];
  for (const field of fields) if (field.populated !== field.rows || field.rows === 0) {
    (field.required ? blockers : warnings).push(`${field.label} 非空覆盖 ${field.populated}/${field.rows}`);
  }
  const boxKeys = new Set();
  for (const [index, box] of packing.entries()) {
    // Names are candidates, never promoted to permanent internal box IDs.
    const key = ['boxId', 'packageId', 'localBoxId', 'box_name'].find(k => present(box[k]));
    const id = key ? `${key}:${box[key]}` : null;
    if (!id) blockers.push(`第 ${index + 1} 箱没有任何箱标识候选`);
    else if (boxKeys.has(id)) blockers.push(`箱标识重复：${id}`);
    else boxKeys.add(id);
    const products = array(box.productList);
    if (!products.length) blockers.push(`第 ${index + 1} 箱商品为空`);
    if (products.some(p => integer(p.quantityInBox) === null || integer(p.quantityInBox) === 0)) blockers.push(`第 ${index + 1} 箱包含无效或零数量`);
    if (integer(box.total) !== null && products.every(p => integer(p.quantityInBox) !== null) &&
      products.reduce((sum, p) => sum + Number(p.quantityInBox), 0) !== Number(box.total)) blockers.push(`第 ${index + 1} 箱 total 与逐商品数量之和不一致`);
    for (const field of ['weight', 'length', 'width', 'height']) {
      if (!present(box[field]) || !Number.isFinite(Number(box[field])) || Number(box[field]) <= 0) warnings.push(`第 ${index + 1} 箱 ${field} 不是正数，文件生成需补充`);
    }
    if (!['KG', 'LB'].includes(box.weightUnit) || !['CM', 'IN'].includes(box.lengthUnit)) warnings.push(`第 ${index + 1} 箱重量或尺寸单位缺失/未知`);
  }
  const declared = totals(items, 'quantity'), packed = totals(boxItems, 'quantityInBox');
  const listItems = array(listing?.item_list);
  const listQuantities = Object.fromEntries(['quantity_shipped', 'init_quantity_shipped', 'quantity_shipped_local', 'quantity_received'].map(k => [k, totals(listItems, k)]));
  if (!declared.valid || !packed.valid) blockers.push('数量或商品身份缺失/无效，无法完整核对');
  if (new Set(items.map(identity)).size !== items.length) blockers.push('详情商品身份重复，需确认重复行口径');
  const keys = new Set([...declared.map.keys(), ...packed.map.keys(), ...listItems.map(identity).filter(Boolean)]);
  const reconciliation = [...keys].map(key => {
    const [msku, fnsku] = JSON.parse(key);
    const detailQuantity = declared.map.get(key) ?? null;
    const packedQuantity = packed.map.get(key) ?? null;
    const delta = detailQuantity !== null && packedQuantity !== null ? packedQuantity - detailQuantity : null;
    if (delta !== 0) blockers.push(`${msku}/${fnsku} 装箱量与详情申报量不一致或缺行`);
    const row = { msku, fnsku, detailQuantity, packedQuantity, delta };
    for (const [field, result] of Object.entries(listQuantities)) row[field] = result.map.get(key) ?? null;
    if (row.quantity_shipped !== null && row.quantity_shipped !== detailQuantity) warnings.push(`${msku}/${fnsku} 列表当前申报量与详情不同`);
    return row;
  });
  if (listing && String(listing.is_sta) === '0') warnings.push('非 STA 货件：记录本次实测结果；本脚本未验证旧版 BoxInfo 降级');
  if (!present(shipment?.shippingAddress?.addressLine1) && !present(listing?.ship_to_address?.address_line1)) warnings.push('目的地址缺失，文件生成需补充');
  warnings.push('箱标识刷新稳定性、数量业务口径和实物装箱仍需人工确认');
  return { target, seller: seller ? { sid: seller.sid, name: seller.name, country: seller.country, status: seller.status } : null,
    isSta: listing?.is_sta ?? null, status: blockers.length ? '存在阻塞' : '本次样本核心字段通过',
    itemCount: items.length, boxCount: packing.length, mixedBoxCount: packing.filter(b => array(b.productList).length > 1).length,
    fields, reconciliation, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
}

export function validateConfig(config) {
  const result = { pageSize: 100, maxPages: 10, timeoutMs: 30000, shipments: [], ...config };
  for (const [key, min, max] of [['pageSize', 1, 800], ['maxPages', 1, 1000], ['timeoutMs', 1000, 120000]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} 必须为 ${min}~${max} 的整数`);
  }
  if (!Array.isArray(result.shipments)) throw new Error('shipments 必须为数组');
  result.shipments = result.shipments.map(s => {
    if (!s || !Number.isSafeInteger(Number(s.sid)) || Number(s.sid) <= 0 || typeof s.shipmentConfirmationId !== 'string') throw new Error('每票需要正整数 sid 和 FBA 字符串');
    const fba = s.shipmentConfirmationId.trim().toUpperCase();
    if (!/^FBA[A-Z0-9]+$/.test(fba)) throw new Error('货件号必须为 FBA 开头的字母数字');
    return { sid: Number(s.sid), shipmentConfirmationId: fba, sampleType: String(s.sampleType ?? '未分类') };
  });
  if (new Set(result.shipments.map(s => `${s.sid}/${s.shipmentConfirmationId}`)).size !== result.shipments.length) throw new Error('shipments 存在重复 sid/FBA');
  if (result.shipments.length) {
    for (const key of ['startDate', 'endDate']) {
      const value = result[key];
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${key} 必须为有效的 YYYY-MM-DD 日期`);
    }
    if (result.startDate >= result.endDate) throw new Error('startDate 必须早于 endDate（结束日期不包含当天）');
  }
  if (result.inventory !== undefined && (!result.inventory || typeof result.inventory.wid !== 'string' || !/^\d+(,\d+)*$/.test(result.inventory.wid))) throw new Error('inventory.wid 必须为仓库 ID 字符串，多个以逗号分隔');
  if (result.inventory?.sku !== undefined && typeof result.inventory.sku !== 'string') throw new Error('inventory.sku 必须为字符串（模糊搜索）');
  return result;
}

const cell = value => String(value ?? '—').replace(/[|\r\n]/g, ' ');
export function markdown(report) {
  const lines = ['# 领星 API 业务数据探测报告', '', `时间：${report.createdAt}；模式：${report.mode}`, '',
    '本报告验证本次样本可获取性，不代表生产验收、业务数量口径确认或实物装箱确认。', '',
    `店铺数：${report.sellerCount}；货件数：${report.shipments.length}；查询失败次数（含重试）：${report.calls.filter(c => !c.ok).length}`, '',
    '## 运行问题', '', ...report.errors.map(e => `- ${cell(e)}`), ...(report.errors.length ? [] : ['无。']), '',
    '## 货件汇总', '', '| sid | FBA | 样本类别 | STA | 商品行 | 箱数 | 混装箱 | 结果 |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.shipments.map(s => `| ${s.target.sid} | ${s.target.shipmentConfirmationId} | ${cell(s.target.sampleType)} | ${cell(s.isSta)} | ${s.itemCount} | ${s.boxCount} | ${s.mixedBoxCount} | ${s.status} |`)];
  for (const s of report.shipments) {
    lines.push('', `## ${s.target.shipmentConfirmationId} / sid ${s.target.sid}`, '', '### 阻塞项', '',
      ...(s.blockers.length ? s.blockers.map(e => `- ${cell(e)}`) : ['无。']), '', '### 待确认与文件生成缺口', '', ...s.warnings.map(e => `- ${cell(e)}`), '',
      '### 字段非空覆盖', '', '| 字段 | 非空/总行数 | 核心必需 |', '| --- | --- | --- |',
      ...s.fields.map(f => `| ${cell(f.label)} | ${f.populated}/${f.rows} | ${f.required ? '是' : '否'} |`), '',
      '### 数量核对（身份键为 MSKU + FNSKU，均保留原口径）', '',
      '| MSKU | FNSKU | 详情申报 | 装箱合计 | 差额 | 列表当前申报 | 初始申报 | 本地已发货 | 已接收 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...s.reconciliation.map(r => `| ${[r.msku, r.fnsku, r.detailQuantity, r.packedQuantity, r.delta, r.quantity_shipped, r.init_quantity_shipped, r.quantity_shipped_local, r.quantity_received].map(cell).join(' | ')} |`));
  }
  if (report.inventory) lines.push('', '## 可选库存探测', '', `行数：${report.inventory.rows.length}；分页完整：${report.inventory.complete}`, '',
    ...report.inventory.fields.map(f => `- ${f.label}：${f.populated}/${f.rows}`));
  lines.push('', '## 能力边界', '',
    '- 目的 FC、Reference ID、地址、承运方式、日期、箱重和尺寸可查看 raw 原始快照；缺值保留为缺值。',
    '- HS、材质、用途、最终申报品名、价格/币种、VAT、主体、业务渠道和周/子批次分组需要主数据或人工输入。',
    '- 单箱配方从真实装箱明细读取；不按商品总量猜测装箱，不用本地已发货量或接收量替代申报量。',
    '- 样本至少覆盖 STA、非 STA、多箱混装、缺字段及实际店铺/国家；项目要求至少 20 个历史货件核对。',
    '- 本脚本未验证标签下载/打印、token 续约、箱标识跨次稳定性、旧版接口降级和完整端到端业务流程。', '');
  return lines.join('\n');
}

export async function run(config, client, mode = 'live') {
  const report = { createdAt: new Date().toISOString(), mode, sellerCount: 0, shipments: [], errors: [], calls: client.calls };
  let sellers = [];
  try {
    const result = await client.call('sellers', PATHS.sellers);
    if (!Array.isArray(result.data)) throw new Error('店铺列表返回结构不是数组');
    sellers = result.data;
    report.sellerCount = sellers.length;
    report.sellers = sellers.map(s => ({ sid: s.sid, name: s.name, country: s.country, status: s.status }));
    if (!sellers.length) report.errors.push('店铺列表为空，无法验证店铺映射');
  } catch (error) { report.errors.push(`店铺列表：${error.message}`); }
  if (!config.shipments.length) report.errors.push('未提供货件样本，本次只验证店铺接口，不能确认项目所需业务数据');
  for (const target of config.shipments) {
    const params = { sid: target.sid, shipmentConfirmationId: target.shipmentConfirmationId };
    const listing = await paginate(client, { name: `${target.sid}-${target.shipmentConfirmationId}-list`, path: PATHS.list,
      params: { sid: String(target.sid), shipment_id: target.shipmentConfirmationId, start_date: config.startDate, end_date: config.endDate },
      extract: r => r.data?.list, pageSize: config.pageSize, maxPages: config.maxPages });
    const errors = listing.error ? [`货件列表：${listing.error}`] : [];
    const matches = listing.rows.filter(s => s.shipment_id === target.shipmentConfirmationId && String(s.sid) === String(target.sid));
    if (matches.length !== 1) errors.push(`货件列表精确匹配 ${matches.length} 行，请核对 sid、FBA 和创建日期范围`);
    let detail, boxes;
    try { detail = await client.call(`${target.sid}-${target.shipmentConfirmationId}-detail`, PATHS.detail, params); }
    catch (error) { errors.push(`货件详情：${error.message}`); }
    try { boxes = await client.call(`${target.sid}-${target.shipmentConfirmationId}-boxes`, PATHS.boxes, params); }
    catch (error) { errors.push(`装箱明细：${error.message}`); }
    report.shipments.push(analyze({ target, seller: sellers.find(s => String(s.sid) === String(target.sid)),
      listing: matches.length === 1 ? matches[0] : undefined, listComplete: listing.complete, detail, boxes, errors }));
  }
  if (config.inventory) {
    report.inventory = await paginate(client, { name: 'inventory', path: PATHS.inventory, params: config.inventory,
      extract: r => r.data, pageSize: config.pageSize, maxPages: config.maxPages });
    report.inventory.fields = coverage('库存', report.inventory.rows, ['wid', 'sku', 'product_valid_num']);
    if (!report.inventory.complete || !report.inventory.rows.length || report.inventory.fields.some(f => f.populated !== f.rows)) report.errors.push('库存分页不完整、结果为空或所需字段缺失');
  }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'env-file': { type: 'string' }, out: { type: 'string' }, demo: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('用法：node scripts/lingxing/probe.mjs --config <JSON> [--env-file <.env>] [--out <输出父目录>]\n模拟：node scripts/lingxing/probe.mjs --demo\n详见 docs/integrations/lingxing-probe.md');
    return;
  }
  if (values['env-file']) process.loadEnvFile(resolve(values['env-file']));
  const demo = values.demo ? await import('./fixtures.mjs') : null;
  if (demo && values.config) throw new Error('--demo 使用内置模拟样本，请勿同时指定 --config');
  const config = validateConfig(demo ? demo.demoConfig : values.config ? JSON.parse((await readFile(resolve(values.config), 'utf8')).replace(/^\uFEFF/, '')) : {});
  const appId = demo ? '0123456789abcdef' : process.env.LINGXING_APP_ID;
  const appSecret = demo ? undefined : process.env.LINGXING_APP_SECRET;
  const token = demo ? 'DEMO-TOKEN' : process.env.LINGXING_ACCESS_TOKEN;
  if (!appId || (!appSecret && !token)) throw new Error('请设置 LINGXING_APP_ID 和 LINGXING_APP_SECRET（或已有 LINGXING_ACCESS_TOKEN），详见运行说明。');
  sign({}, appId);
  const output = resolve(values.out ?? 'data/lingxing-probe', `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  await mkdir(join(output, 'raw'), { recursive: true });
  const client = new Client({ appId, appSecret, token, output, timeoutMs: config.timeoutMs, ...(demo ? { fetchImpl: demo.demoFetch } : {}) });
  let report;
  try {
    await client.authenticate();
    report = await run(config, client, demo ? 'demo（模拟数据，未访问领星）' : 'live');
  } catch (error) {
    report = { createdAt: new Date().toISOString(), mode: 'live', sellerCount: 0, shipments: [], errors: [error.message], calls: client.calls };
  }
  const safe = redact(report, client.secrets);
  await writeFile(join(output, 'report.json'), JSON.stringify(safe, null, 2));
  await writeFile(join(output, 'report.md'), markdown(safe));
  console.log(`报告：${join(output, 'report.md')}`);
  if (demo) console.log('模拟数据演示完成，未访问领星，不能用于判断真实账号能力。');
  console.log(`店铺 ${safe.sellerCount}；货件 ${safe.shipments.length}；核心通过 ${safe.shipments.filter(s => !s.blockers.length).length}`);
  process.exitCode = safe.errors.length || safe.shipments.some(s => s.blockers.length) ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(redact(error.message, [process.env.LINGXING_APP_ID, process.env.LINGXING_APP_SECRET, process.env.LINGXING_ACCESS_TOKEN]));
    process.exitCode = 1;
  });
}
