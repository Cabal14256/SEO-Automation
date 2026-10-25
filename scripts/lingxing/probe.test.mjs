import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, Client, markdown, paginate, PATHS, redact, run, sign, validateConfig } from './probe.mjs';
import { demoConfig, demoFetch, fixture } from './fixtures.mjs';

const appId = '0123456789abcdef';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('签名与独立 .NET MD5/AES-ECB 计算的固定向量一致；支持嵌套 JSON、ASCII 排序和中文', () => {
  const params = { timestamp: '1720408272', sid: 1, ids: ['a', 'b'], filter: { city: '上海' }, app_key: appId, access_token: 'test-token' };
  assert.equal(sign(params, appId), 'ne7C6/dNOj5FLjJj6r3YF89tpRPgNIF/xbzjcXMxJRU3ciLgYakkxZHNnCfqFj7U');
  assert.equal(sign({ ...params, blank: '', absent: undefined }, appId), sign(params, appId));
  assert.notEqual(sign({ ...params, empty: null }, appId), sign(params, appId));
  assert.throws(() => sign(params, 'bad-key'), /AppId/);
});

test('鉴权使用 multipart，token 留在内存；token 接口成功码 200', async () => {
  const client = new Client({ appId, appSecret: 'secret', fetchImpl: async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/auth-server/oauth/access-token');
    assert.equal(options.body.get('appId'), appId);
    assert.equal(options.body.get('appSecret'), 'secret');
    return json({ code: '200', data: { access_token: 'issued-token', refresh_token: 'refresh-secret' } });
  } });
  await client.authenticate();
  assert.equal(client.token, 'issued-token');
  assert.deepEqual(client.calls, []);
});

test('业务请求签名包含业务参数，查询串编码不改变签名，响应中的密钥不进入快照', async () => {
  const client = new Client({ appId, token: 'my/token+', fetchImpl: async (input, options) => {
    const url = new URL(input);
    const query = Object.fromEntries(url.searchParams);
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { sid: 1, shipmentConfirmationId: 'FBA123' });
    assert.equal(query.sign, sign({ ...body, ...query }, appId));
    assert.equal(query.access_token, 'my/token+');
    assert.equal(options.redirect, 'error');
    return json({ code: '0', data: { access_token: 'my/token+', message: `echo ${query.sign}` } });
  } });
  await client.call('detail', PATHS.detail, { sid: 1, shipmentConfirmationId: 'FBA123' });
  assert.equal(client.calls[0].response.data.access_token, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(client.calls), /my\/token\+/);
});

test('限流有限重试，权限错误与超时不盲目重试', async () => {
  let attempts = 0;
  const pauses = [];
  const client = new Client({ appId, token: 'token', pause: async ms => pauses.push(ms), fetchImpl: async () => {
    attempts++;
    return attempts < 3 ? json({ code: 3001008, message: 'limited' }) : json({ code: 0, data: [] });
  } });
  await client.call('sellers', PATHS.sellers);
  assert.equal(attempts, 3);
  assert.deepEqual(pauses, [1000, 2000]);
  client.fetchImpl = async () => json({ code: 403, message: 'denied' });
  await assert.rejects(() => client.call('denied', PATHS.sellers), /denied/);
  assert.equal(client.calls.length, 4);
  client.fetchImpl = async () => { throw new Error('timeout token'); };
  await assert.rejects(() => client.call('timeout', PATHS.sellers), /timeout/);
  assert.equal(client.calls.length, 5);
  assert.doesNotMatch(client.calls.at(-1).error, /token/);
});

test('HTTP 200 但业务失败及非 JSON 响应都不能算成功', async () => {
  const client = new Client({ appId, token: 'token', fetchImpl: async () => json({ code: 2001001, message: 'bad' }) });
  await assert.rejects(() => client.call('bad', PATHS.sellers), /2001001/);
  client.fetchImpl = async () => new Response('<html>gateway</html>');
  await assert.rejects(() => client.call('html', PATHS.sellers), /非 JSON/);
});

test('分页偏移与累计数量一致，完整抓取', async () => {
  const offsets = [];
  const result = await paginate({ call: async (_name, _path, body) => {
    offsets.push(body.offset);
    return { total: 3, data: { list: body.offset ? [{ id: 3 }] : [{ id: 1 }, { id: 2 }] } };
  } }, { name: 'list', path: PATHS.list, params: {}, extract: r => r.data.list, pageSize: 2, maxPages: 3 });
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(offsets, [0, 2]);
});

test('分页重复、提前结束、total 变化和页数上限不能误报完整', async () => {
  const options = { name: 'list', path: PATHS.list, params: {}, extract: r => r.data, pageSize: 1, maxPages: 2 };
  const repeated = await paginate({ call: async () => ({ total: 3, data: [{ id: 1 }] }) }, options);
  assert.equal(repeated.complete, false);
  assert.match(repeated.error, /分页重复/);
  const short = await paginate({ call: async () => ({ total: 3, data: [] }) }, options);
  assert.equal(short.complete, false);
  assert.match(short.error, /提前结束/);
  let count = 0;
  const changing = await paginate({ call: async () => ({ total: ++count + 1, data: [{ id: count }] }) }, options);
  assert.match(changing.error, /total 变化/);
  const capped = await paginate({ call: async () => ({ data: [{ id: 1 }] }) }, { ...options, maxPages: 1 });
  assert.equal(capped.complete, false);
  assert.match(capped.error, /maxPages/);
});

test('多箱混装按商品核对，已发货量为零仍保留；不等同申报量', () => {
  const result = analyze(fixture());
  assert.deepEqual(result.blockers, []);
  assert.equal(result.boxCount, 2);
  assert.equal(result.mixedBoxCount, 1);
  assert.equal(result.reconciliation[0].detailQuantity, 5);
  assert.equal(result.reconciliation[0].packedQuantity, 5);
  assert.equal(result.reconciliation[0].quantity_shipped_local, 0);
});

test('真实响应的 boxName 可用于箱名覆盖和标识候选，原始响应不被改写', () => {
  const data = fixture();
  const packing = data.boxes.data.shipmentList[0].shipmentPackingList;
  for (const [index, box] of packing.entries()) {
    delete box.boxId;
    box.boxName = `P1 - B${index + 1}`;
  }
  const result = analyze(data);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.fields.find(f => f.label === '箱.box_name').populated, 2);
  assert.ok(!result.warnings.some(w => w.includes('box_name')));
  assert.equal(packing[0].box_name, undefined);
});

test('货件总量相同但各商品分配不同仍发现差异', () => {
  const data = fixture();
  data.boxes.data.shipmentList[0].shipmentPackingList[0].productList[0].quantityInBox = 2;
  data.boxes.data.shipmentList[0].shipmentPackingList[0].productList[1].quantityInBox = 2;
  const result = analyze(data);
  assert.equal(result.reconciliation[0].delta, -1);
  assert.equal(result.reconciliation[1].delta, 1);
  assert.ok(result.blockers.some(e => e.includes('不一致')));
});

test('缺商品身份、空数量、零箱数量和缺箱号不能补成默认值', () => {
  const data = fixture();
  const box = data.boxes.data.shipmentList[0].shipmentPackingList[0];
  delete box.boxId;
  delete box.productList[0].fnsku;
  box.productList[0].quantityInBox = '';
  box.productList[1].quantityInBox = 0;
  const result = analyze(data);
  assert.ok(result.blockers.some(e => e.includes('箱标识')));
  assert.ok(result.blockers.some(e => e.includes('fnsku')));
  assert.ok(result.blockers.some(e => e.includes('无效或零数量')));
  assert.ok(result.blockers.some(e => e.includes('无法完整核对')));
});

test('不能合并多个货件的装箱分组；可以按 STA 内部 ID 精确匹配', () => {
  const data = fixture();
  data.boxes.data.shipmentList.push({ shipmentId: 'other-shipment', shipmentPackingList: [] });
  assert.equal(analyze(data).boxCount, 2);
  delete data.listing.sta_shipment_id;
  const result = analyze(data);
  assert.equal(result.boxCount, 0);
  assert.ok(result.blockers.some(e => e.includes('不能唯一关联')));
});

test('API 返回别的 FBA、分页不完整和空装箱均阻塞', () => {
  const data = fixture();
  data.detail.data.shipmentList[0].shipmentConfirmationId = 'FBAOTHER';
  data.listComplete = false;
  data.boxes.data.shipmentList[0].shipmentPackingList = [];
  const result = analyze(data);
  assert.ok(result.blockers.some(e => e.includes('详情匹配到 0')));
  assert.ok(result.blockers.some(e => e.includes('分页不完整')));
  assert.ok(result.blockers.some(e => e.includes('装箱明细为空')));
});

test('输入校验拒绝无效日期、危险货件号、重复货件和非法页数', () => {
  assert.throws(() => validateConfig({ ...demoConfig, startDate: '2026-02-30' }), /日期/);
  assert.throws(() => validateConfig({ ...demoConfig, maxPages: 0 }), /maxPages/);
  assert.throws(() => validateConfig({ ...demoConfig, shipments: [{ sid: 1, shipmentConfirmationId: '../FBA' }] }), /货件号/);
  assert.throws(() => validateConfig({ ...demoConfig, shipments: [...demoConfig.shipments, ...demoConfig.shipments] }), /重复/);
  assert.throws(() => validateConfig({ inventory: { wid: '1; DROP' } }), /wid/);
});

test('完整模拟流程经过客户端签名和分页，报告保留核心通过与业务待确认的区别', async () => {
  const client = new Client({ appId, token: 'DEMO-TOKEN', fetchImpl: demoFetch });
  const report = await run(validateConfig(demoConfig), client, 'demo');
  assert.equal(report.calls.length, 4);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.shipments[0].blockers, []);
  assert.match(markdown(report), /本次样本核心字段通过/);
  assert.match(markdown(report), /HS、材质/);
  assert.doesNotMatch(JSON.stringify(report), /DEMO-TOKEN/);
});

test('单票详情失败后仍取装箱并继续下一票，保留可用证据', async () => {
  const client = new Client({ appId, token: 'DEMO-TOKEN', fetchImpl: async (url, options) => {
    if (new URL(url).pathname === PATHS.detail) return json({ code: 403, message: '无权限' });
    return demoFetch(url, options);
  } });
  const config = validateConfig({ ...demoConfig, shipments: [...demoConfig.shipments, { sid: 2, shipmentConfirmationId: 'FBAOTHER002' }] });
  const report = await run(config, client);
  assert.equal(report.calls.length, 7); // One seller lookup, then three queries per shipment.
  assert.equal(report.shipments.length, 2);
  assert.equal(report.shipments[0].boxCount, 2);
  assert.ok(report.shipments[0].blockers.some(e => e.includes('无权限')));
});

test('可选库存分页读取，零可用量合法，空库存保持未验证', async () => {
  let inventoryRows = [{ wid: 1, sku: 'SKU-A', product_valid_num: 0 }];
  const client = new Client({ appId, token: 'DEMO-TOKEN', fetchImpl: async (url, options) => {
    if (new URL(url).pathname === PATHS.inventory) return json({ code: 0, total: inventoryRows.length, data: inventoryRows });
    return demoFetch(url, options);
  } });
  const config = validateConfig({ ...demoConfig, inventory: { wid: '1' } });
  const report = await run(config, client, 'demo');
  assert.equal(report.inventory.complete, true);
  assert.equal(report.inventory.fields.find(f => f.label === '库存.product_valid_num').populated, 1);
  assert.deepEqual(report.errors, []);
  inventoryRows = [];
  const empty = await run(config, client, 'demo');
  assert.ok(empty.errors.some(e => e.includes('库存')));
});

test('递归脱敏处理字段及错误中的密钥、URL 参数', () => {
  const result = redact({ access_token: 'unknown', rows: [{ nested: 'secret-value' }], error: 'url?sign=abc&access_token=foo' }, ['secret-value']);
  assert.equal(result.access_token, '[REDACTED]');
  assert.equal(result.rows[0].nested, '[REDACTED]');
  assert.doesNotMatch(result.error, /abc|foo/);
});
