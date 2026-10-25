# 领星 API 业务数据测试脚本

用途：验证企业账号是否真的能取到 M2 只读制表、M3 箱数据和后续文件生成需要的数据。脚本不依赖数据库、Web 服务或第三方 npm 包，使用项目要求的 Node.js 24。

Windows 如果提示找不到 `node`，可将下文的 `node scripts/lingxing/probe.mjs` 替换为 `powershell -ExecutionPolicy Bypass -File scripts/lingxing/probe.ps1`。这个入口会查找 PATH、常见 Node 安装目录和当前 Codex 附带的 Node 24，不修改系统环境。例如：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/lingxing/probe.ps1 --demo
```

## 1. 准备凭据

在领星 ERP 开放接口配置中取得 AppId/AppSecret，并配置运行电脑的**出口公网 IP 白名单**。凭据只填本地 `.env`，不需要发到聊天中。

在项目根目录运行 PowerShell：

```powershell
Copy-Item scripts/lingxing/.env.example scripts/lingxing/.env
notepad scripts/lingxing/.env
```

填入 `LINGXING_APP_ID` 和 `LINGXING_APP_SECRET`。如果已有有效的 `LINGXING_ACCESS_TOKEN`，可以配置该项，脚本优先使用现有 token，不再申请新 token。使用新 token 是否影响其他客户端，应按企业现有接入方式协调；本工具不持久化或续约 token。不要在报告目录里保存 `.env`。

## 2. 先查询店铺 sid

```powershell
node scripts/lingxing/probe.mjs --env-file scripts/lingxing/.env
```

不提供配置时只查询店铺列表，控制台显示报告位置。打开 `report.json` 的 `sellers` 找到实际店铺的 `sid`、名称、国家和状态。此模式退出码为 `2`，表示尚未验证货件业务数据，属于预期行为。

## 3. 配置实际货件

```powershell
Copy-Item scripts/lingxing/probe.example.json scripts/lingxing/probe.local.json
notepad scripts/lingxing/probe.local.json
```

将示例 sid/FBA 换为真实值，`shipments` 数组可填多票、多个店铺，例如：

```json
{
  "startDate": "2026-09-01",
  "endDate": "2026-11-01",
  "pageSize": 100,
  "maxPages": 10,
  "timeoutMs": 30000,
  "shipments": [
    { "sid": 123456, "shipmentConfirmationId": "FBAREPLACE001", "sampleType": "STA 单商品多箱" },
    { "sid": 123456, "shipmentConfirmationId": "FBAREPLACE002", "sampleType": "STA 多商品混装" },
    { "sid": 654321, "shipmentConfirmationId": "FBAREPLACE003", "sampleType": "非 STA 历史货件" }
  ]
}
```

日期筛选的是**货件创建日期**，不是发货日期；区间为 `[startDate, endDate)`，不包含结束当天。历史货件要将开始日期往前调整。即使精确传 FBA，列表查询仍需日期参数。FBA 自动去掉首尾空格并转大写，sid 不根据名称猜测。

可选：在顶层增加 `"inventory": { "wid": "123,456", "sku": "实际SKU" }` 测试本地仓可用库存。`wid` 需填写真实仓库 ID，`sku` 是模糊筛选，报告保留每行 SKU，不能将结果直接当成指定 SKU 的库存合计。库存是后续模块，不填则不调用。

## 4. 执行真实测试

```powershell
node scripts/lingxing/probe.mjs --env-file scripts/lingxing/.env --config scripts/lingxing/probe.local.json
```

也可以通过 `corepack pnpm lingxing:probe --env-file scripts/lingxing/.env --config scripts/lingxing/probe.local.json` 运行。可用 `--out D:/SCM-Automation/.local/development/data/lingxing-probe` 指定输出父目录，每次创建独立的时间戳目录。

输出默认保存在已忽略提交的 `data/lingxing-probe/run-*/`：

| 文件 | 内容 |
| --- | --- |
| `report.md` | 中文货件结果、字段非空覆盖、阻塞项、待确认项、逐商品数量核对 |
| `report.json` | 便于后续程序分析的完整报告、店铺映射和调用摘要；可选库存行 |
| `raw/*.json` | 每次业务调用的参数、HTTP 状态、耗时、重试序号和脱敏响应快照；无凭据查询串 |

快照会移除凭据，但仍包含真实商品、店铺和收发货地址等业务数据，分享前按实际需要处理。自定义 `--out` 时应选择项目外目录或被版本控制忽略的目录。

## 5. 报告如何判断

| 项目需求 | 接口与验证内容 |
| --- | --- |
| 店铺、国家、权限映射 | `seller/lists`：sid、name、country、status；状态异常阻塞 |
| 货件身份、数量口径 | `shipmentList`：分页完整性、sid/FBA 唯一匹配、STA 类型、四种数量原值 |
| 发货记录商品明细 | `shipmentDetailList`：MSKU、FNSKU、SKU、品名、有效申报量 |
| 现有装箱重建 | `listShipmentBoxes`：逐箱商品、数量、箱标识候选、空箱/重复箱检测 |
| 数量守恒 | 按 MSKU + FNSKU 核对装箱合计与详情申报量；逐商品缺行和差异阻塞 |
| 发票/物流文件候选数据 | Reference ID、FC、地址、日期、承运方式、箱重尺寸及单位，缺值/非法值提示 |
| 成品仓可用库存（可选） | `inventoryDetails`：分页、wid、sku、product_valid_num 非空覆盖 |

`quantity_shipped` 是列表当前申报量，`init_quantity_shipped` 是初始申报量，`quantity_shipped_local` 是本地已发货量，`quantity_received` 是已接收量。脚本分列保留，不自动选定业务主数量。装箱合计暂与详情 `quantity` 做诊断性核对，业务正式使用的对照口径仍需确认。零本地已发货量和零接收量是合法值，不视为字段缺失。

“本次样本核心字段通过”仅表示本次真实响应能支持核心商品和箱关系的读取与数量核对。箱号跨次是否稳定、线下实物是否一致、Reference ID 是否可作 PO、业务数量口径、分组和正式导出仍需确认。箱内数量缺失不填 0，多个不明装箱分组不合并，箱名/数组序号不冒充永久内部箱 ID。

报告的 `箱.box_name` 兼容原始响应中的 `box_name` 和 `boxName`。实测箱名可能为 `P1 - B3`，而当前货件的 `localBoxId` 为 `1`；两者含义不同，不能直接互换或假设编号连续。原始响应快照保留实际字段名。

HS、最终中英文申报品名、材质、用途、品牌型号、申报价/币种、VAT、卖方主体、业务渠道和正式模板等应来自项目主数据，不能凭这些接口完成所有文件生成。详情 `productName` 只作平台品名。

退出码：`0` 为选定样本核心检查通过；`2` 为接口失败、数据阻塞或尚未完成货件验证；`1` 为配置或本地运行错误。可选字段告警不会把核心通过提升为完整业务验收。单票失败继续其他查询，保留已获得的数据。

## 6. 无凭据演示与本地验证

```powershell
# 不访问领星，使用内置模拟数据跑签名、查询和报告输出流程
node scripts/lingxing/probe.mjs --demo

# 检查签名、鉴权、编码、脱敏、分页、限流、缺字段、混装核对与失败保留
node --test scripts/lingxing/probe.test.mjs
```

模拟报告明确标注 demo，不能证明真实 API 权限或数据完整性。建议真实样本覆盖所有实际店铺/国家、STA/非 STA、单商品多箱、多商品混装、缺字段/重复箱等情况，按项目要求最终核对至少 20 票。无对应真实样本的类别继续标记待验收。

## 7. 错误处理与范围

- 所有业务请求串行；HTTP 429 或领星 `3001008` 最多重试 2 次，指数退避。令牌桶容量不解释为固定 QPS。
- 超时、网络异常、权限错误不自动重试，避免超时请求仍占用令牌桶时继续叠加调用。保留错误后可人工重新运行。
- 分页检查累计数量、total 变化、重复页和最大页数；未确认取完时不能报告完整。库存与列表支持分页，STA 详情/装箱按官方返回结构读取。
- token 仅保留在本次进程内；短时脚本未实现续约。大批量测试遇到 token 过期会记录失败，应分批采样，或使用现有接入系统管理的有效 token。
- 非 STA 货件直接实测新接口，失败保留错误；未自动回退旧 `BoxInfo`。旧接口对部分 LTL 合作承运人货件无法保证逐箱商品。
- 仅读取，不创建发货单、不分配库存、不改物流、不下载或打印标签，也不写入项目业务数据库。

## 官方依据

2026-10-16 已通过官方 Markdown 地址重新核对以下文档，与项目 2026-10-13 的归档一致；本次核对没有使用企业凭据请求业务 API。

- [接入指南与签名](https://apidoc.lingxing.com/#/docs/Guidance/newInstructions)
- [获取 Token](https://apidoc.lingxing.com/#/docs/Authorization/GetToken)
- [店铺列表](https://apidoc.lingxing.com/#/docs/BasicData/SellerLists)
- [货件列表](https://apidoc.lingxing.com/#/docs/FBA/FBAShipmentList)
- [货件详情](https://apidoc.lingxing.com/#/docs/FBA/ShipmentDetailList)
- [货件装箱](https://apidoc.lingxing.com/#/docs/FBA/ListShipmentBoxes)
- [本地仓库存](https://apidoc.lingxing.com/#/docs/Warehouse/InventoryDetails)
