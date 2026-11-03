# 运输方式输入与 FBA 补全边界

历史接口核验日期：2026-10-19；当前业务规则更新：2026-11-03（上海时区）。范围：既有接口核验记录与本仓导入实现。本次未请求真实领星业务 API，未创建或修改领星单据。

## 当前导入规则（2026-11-03）

发货导入的业务渠道指头程运输方式，由人员手工填写。在线默认与 FBA 一起展示普通输入框，支持逐格输入、粘贴单列和完整表格；不会读取领星运输方式字典，也不会通过关联发货单读取或校验运输方式。

全名直接采用，本地识别以下六种拼音首字母，忽略首尾空格及大小写；其他全名或未知文本保留，不受领星目录是否存在或启用限制。

| 运输方式全名 | 缩写 |
| --- | --- |
| 海运 | HY |
| 海派 | HP |
| 空派 | KP |
| 快递 | KD |
| 铁运 | TY |
| 卡航 | KH |

在线和文件解析的标准化渠道采用上述六种归一规则，文件原始来源与已保存历史快照保持原值。发货自动整理要求有效来源行渠道非空，缺少时给出 `CHANNEL_REQUIRED`；“仅导入需求”不增加必填要求。接收结果不确定的提交保留原操作号和原始载荷重试，不在重放时重新归一请求。

FBA 补全仅通过 `listShipments` 读取店铺、国家、目的 FC、仓库地址、货件创建时间和取数时间，完整校验分页及 `sid + FBA` 身份。补全和采用候选保留手填业务渠道，渠道不再参与查询字段差异检查。历史已完成查询在读取或重放响应中统一清空渠道及候选、标为 `unavailable`，移除旧渠道来源及错误，保留数据库原证据。`unavailable` 是兼容字段状态，表示该流程不提供运输方式，不表示本次运输方式查询失败。

发货整理停在补全阶段时，显式重试会刷新已完成或失败的货件查询及在线来源旧依据，保留正在运行的查询；进入后续阶段后仍沿用原依据。已取消关联发货单取数，因此历史的运输方式缺值或查询错误不再影响导入。实现入口为 `apps/web/src/features/online-import.tsx`、`apps/server/src/modules/imports/fba-lookup.ts` 和 `apps/server/src/modules/shipping-runs/jobs.ts`，契约见[导入 API](../api/imports.md)与[发货整理 API](../api/shipping-runs.md)。

“设置 → 发票服务映射”仍独立读取领星国家和运输方式候选，不使用上述本地六种名称替换设置目录；保留的 `GET /api/v1/imports/transport-methods` 兼容接口也不再由发货导入调用。详见[发票服务映射](lingxing-document-profiles.md#发票服务映射2026-11-02)。

## 历史接口核验

以下为既有官方文档核验记录，本次未重新请求真实领星业务 API。领星可以从已维护的关联发货单读出头程运输方式和物流渠道；仅凭亚马逊 FBA 货件元数据或字典无法保证得出某票头程渠道。这些接口能力不代表当前发货导入会调用。

### 已核实的官方接口

| 接口 | 官方文档中的关键字段 | 对本项目的含义 |
| --- | --- | --- |
| [查询发货单列表](https://apidoc.lingxing.com/new/api-docs/FBA/GetInboundShipmentList/) `POST /erp/sc/routing/storage/shipment/getInboundShipmentList` | 请求 `search_field=shipment_id`、`search_value`；可用 `sids` 限定店铺；也有 `senior_search_list` 精准搜索。响应 `data.list[].shipment_sn`、`logistics_channel_name`、`logistics_provider_id/name`、`method_id/name`；`relate_list[].shipment_id`、`sid` 为关联货件及店铺 | 可从 FBA 找关联发货单，读取该单的物流渠道和运输方式，再反核店铺与 FBA，不能假设只有一张单 |
| [查询发货单详情](https://apidoc.lingxing.com/new/api-docs/FBA/getInboundShipmentListMwsDetail/) `POST /erp/sc/routing/storage/shipment/getInboundShipmentListMwsDetail` | 请求 `shipment_sn`。响应 `logistics_channel_id/name`、`logistics_provider_id/name`、`method_id/name`、`is_relate_head_logistics`，以及商品内 `shipment_id`、`sid`、`shipment_ids[]` 等关联字段；官方成功示例的 `method_name` 为“海派” | 通过列表取得发货单号后，可读取详情及渠道 ID；字段存在不保证业务值非空，详情示例中有大量空值或 0 |
| [查询头程物流渠道列表](https://apidoc.lingxing.com/new/api-docs/Logistics/ChannelList/) `POST /erp/sc/data/local_inventory/channelList` | 请求分页 `offset/length`。响应 `id`（ERP 物流方案代码）、`channel_name`、`method_id`、`method_name`（字段例为“海派”）、`enabled`、`provider.id/logistics_provider_name` | 是企业头程渠道配置字典，可用于渠道 ID 展示和校验，未提供 FBA 关联 |
| [查询运输方式列表](https://apidoc.lingxing.com/new/api-docs/Logistics/transportMethodList/) `POST /basicOpen/businessConfig/transportMethod/list` | 支持系统及自定义运输方式，对应 ERP 设置→业务配置→物流；返回 `method_id`、`name`、`code`、`is_system`、`enabled`。官方示例含“海派” | 可读企业实际定义的运输方式；不能把不同企业的 ID、序号或中文名称当成固定枚举 |

关联依据进一步得到[生成待发货发货单（关联货件）文档](https://apidoc.lingxing.com/new/api-docs/FBA/createReadySendOrder/)的印证：其 `logistics_channel_id` 明确对应“查询头程物流渠道列表”的 `id`，商品行包含 `shipment_id`。当次仅阅读这份文档，未调用该写接口。

### Amazon 货件字段与头程业务渠道的区别

[查询货件列表](https://apidoc.lingxing.com/new/api-docs/FBA/FBAShipmentList/)的 `shipping_mode` 定义为 `GROUND_SMALL_PARCEL`（SPD）或 `FREIGHT_LTL`（LTL），`shipping_solution` 为自有或亚马逊合作承运人。它们描述亚马逊入仓配送安排，不足以判断中国到目的国的头程走海派、空派或其他业务渠道。

发货单列表的 `logistics[].transport_type` 和详情新版头程轨迹的 `head_logistics_list.track_list[].transport_type` 区分 1 快递、2 海运、3 空运、4 其他。这是较粗的运输类型，不能据此区分“空派”和其他空运方案。旧版导入曾采用关联单的 `method_name`，`logistics_channel_name` 不能替代运输方式；渠道 ID 仅作为当时的关联发货单来源证据。当前业务渠道改为手填，不从上述字段推断。

### 已替换的导入方案（2026-10-19 至 2026-11-02）

以下仅保留旧实现的字段与证据语义，已由本页当前规则替换：在线业务渠道曾使用领星运输方式下拉列表，按目录启用状态校验；2026-11-02 曾根据目录的实际名称动态识别完整拼音首字母。旧版 FBA 补全在完整核验货件列表后，通过 `listInboundShipments` 按 `sids` 和 `senior_search_list` 查询关联发货单，只接纳未删除且 `status=-1/0/1/2` 的有效单。

历史 `channelStatus` 用 `unique/ambiguous/not_found/unavailable` 表示关联单运输方式结论，`channelOptions` 曾保存 `name`、`shipmentNumbers`、`channelIds` 和 `methodNames`，`channelSource='method_name'` 用来区分运输方式与物流渠道名称。唯一方式曾覆盖在线渠道，其他状态曾要求人工处理。旧 `channelIssue` 区分 `NO_LINKED_ORDER`、`METHOD_MISSING`、`METHOD_INCOMPLETE`、`LOOKUP_FAILED`；这些旧结论不再回放到当前输入或作为整理阻塞原因。

### 旧方案尚待真实数据验证

- 现有账号是否维护了目标 FBA 的发货单、关联货件、渠道和运输方式，API 权限是否允许读取；本次未验证。
- 一票 FBA 是否拆分到多张发货单、每张单的状态和运输方式是否一致；文档返回列表和关联列表，因此实现应支持多候选。
- 实际账号返回的运输方式是否完整、一致，以及有效单缺少运输方式时的人工确认流程；不从官方示例“海派”外推真实运输方式值或固定枚举。
- 官方示例与字段表存在少量类型、命名和版本差异，例如详情 `head_logistics_list` 表格标作数组而成功例为对象、`logistics_channel_id` 的字段说明写“渠道商ID”。实际适配需保留原始响应并按真实样本核验，不能仅按示例强制解析。
