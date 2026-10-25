# 通过 FBA 查询头程运输方式的接口核验

核验日期：2026-10-19；业务口径更新：2026-10-23（上海时区）。范围：领星官方公开接口文档与本仓现有实现。未请求真实领星业务 API，未创建或修改领星单据。

## 结论

**领星有接口可读出海派等头程运输方式和物流渠道，但前提是该 FBA 已关联领星发货单，且该单据维护了相应信息。** 仅凭亚马逊 FBA 货件元数据不能保证得出头程渠道；字典接口也不能独立判断某票 FBA 使用哪个渠道。

2026-10-19 已将只读发货单查询接入在线表“通过 FBA 补全信息”。2026-10-23 按“渠道＝运输方式”统一字段口径：业务渠道以关联发货单返回的 `method_name` 为优先值，如海派、空派；唯一有效结果可填入或覆盖手填渠道。未建单、未关联、运输方式缺失、多单运输方式冲突或查询失败时保留手填内容并人工确认，不以 `logistics_channel_name` 或平台 SPD/LTL 回退。文件导入仍保留来源渠道原值，不自动请求 API；历史导入、需求及确认快照不回写。本次口径调整未新增真实账号调用验证，渠道必填规则不变。

## 已核实的官方接口

| 接口 | 官方文档中的关键字段 | 对本项目的含义 |
| --- | --- | --- |
| [查询发货单列表](https://apidoc.lingxing.com/new/api-docs/FBA/GetInboundShipmentList/) `POST /erp/sc/routing/storage/shipment/getInboundShipmentList` | 请求 `search_field=shipment_id`、`search_value`；可用 `sids` 限定店铺；也有 `senior_search_list` 精准搜索。响应 `data.list[].shipment_sn`、`logistics_channel_name`、`logistics_provider_id/name`、`method_id/name`；`relate_list[].shipment_id`、`sid` 为关联货件及店铺 | 可从 FBA 找关联发货单，读取该单的物流渠道和运输方式，再反核店铺与 FBA，不能假设只有一张单 |
| [查询发货单详情](https://apidoc.lingxing.com/new/api-docs/FBA/getInboundShipmentListMwsDetail/) `POST /erp/sc/routing/storage/shipment/getInboundShipmentListMwsDetail` | 请求 `shipment_sn`。响应 `logistics_channel_id/name`、`logistics_provider_id/name`、`method_id/name`、`is_relate_head_logistics`，以及商品内 `shipment_id`、`sid`、`shipment_ids[]` 等关联字段；官方成功示例的 `method_name` 为“海派” | 通过列表取得发货单号后，可读取详情及渠道 ID；字段存在不保证业务值非空，详情示例中有大量空值或 0 |
| [查询头程物流渠道列表](https://apidoc.lingxing.com/new/api-docs/Logistics/ChannelList/) `POST /erp/sc/data/local_inventory/channelList` | 请求分页 `offset/length`。响应 `id`（ERP 物流方案代码）、`channel_name`、`method_id`、`method_name`（字段例为“海派”）、`enabled`、`provider.id/logistics_provider_name` | 是企业头程渠道配置字典，可用于渠道 ID 展示和校验，未提供 FBA 关联 |
| [查询运输方式列表](https://apidoc.lingxing.com/new/api-docs/Logistics/transportMethodList/) `POST /basicOpen/businessConfig/transportMethod/list` | 支持系统及自定义运输方式，对应 ERP 设置→业务配置→物流；返回 `method_id`、`name`、`code`、`is_system`、`enabled`。官方示例含“海派” | 可读企业实际定义的运输方式；不能把不同企业的 ID、序号或中文名称当成固定枚举 |

关联依据进一步得到[生成待发货发货单（关联货件）文档](https://apidoc.lingxing.com/new/api-docs/FBA/createReadySendOrder/)的印证：其 `logistics_channel_id` 明确对应“查询头程物流渠道列表”的 `id`，商品行包含 `shipment_id`。本次只阅读这份文档，未调用该写接口。

## Amazon 货件字段与头程业务渠道的区别

[查询货件列表](https://apidoc.lingxing.com/new/api-docs/FBA/FBAShipmentList/)的 `shipping_mode` 定义为 `GROUND_SMALL_PARCEL`（SPD）或 `FREIGHT_LTL`（LTL），`shipping_solution` 为自有或亚马逊合作承运人。它们描述亚马逊入仓配送安排，不足以判断中国到目的国的头程走海派、空派或其他业务渠道。

发货单列表的 `logistics[].transport_type` 和详情新版头程轨迹的 `head_logistics_list.track_list[].transport_type` 区分 1 快递、2 海运、3 空运、4 其他。这是较粗的运输类型，不能据此区分“空派”和其他空运方案。本项目的“业务渠道”指头程运输方式，直接采用有效关联单的 `method_name`，不转换成 HYKD 等旧缩写。`logistics_channel_name` 表示物流渠道名称，不能替代缺失的运输方式；渠道 ID 仅保留为关联发货单的来源证据。

## 已实现的只读补全规则

在线来源的“业务渠道”使用运输方式下拉列表，通过 `GET /api/v1/imports/transport-methods` 读取当前账号字典，不写死系统示例值。服务端校验返回列表完整性，并合并并发请求、缓存五分钟；外部请求禁用时不返回缓存。停用项展示但不可新选，历史或粘贴的非字典值保留并提示重新选择。在线新提交前检查填写的渠道是否为已启用值，空白仍允许按 FBA 自动补全；接收结果不确定的旧请求仍保留原操作号及原始载荷重试。字典读取失败不清空表格，可重试读取。此变更不回写历史来源、需求或领星数据。

1. Worker 先完整读取并校验 Amazon 货件列表，确定实际找到的 `sid + FBA` 身份。随后通过 allowlist 中的只读 operation `listInboundShipments` 调用固定路径 `POST /erp/sc/routing/storage/shipment/getInboundShipmentList`，以找到的店铺集合 `sids` 和 FBA 集合 `senior_search_list` 批量精准查询；返回关联货件再次核对 `relate_list[].sid + shipment_id`。
2. 查询使用 `is_delete=0`，只接纳 `status=-1/0/1/2` 的有效单；作废、删除及未知状态剔除。运输方式是关联发货单上的数据，不把待配货或待发货单的运输方式表述为已实际运输的事实。
3. 货件列表与发货单列表均校验完整分页；发货单每页20条，每类列表最多20页，两阶段共用40次请求预算。渠道列表失败或不完整时不发布部分渠道结论，保留此前已完整校验的货件元数据；限流、预算耗尽、目录或查询范围变化则中止整轮补全。
4. 所有有效关联单的非空 `method_name` 一致且没有运输方式缺失时，返回 `channelStatus=unique` 和 `channel`；在线表采用对应货件候选时优先填入或覆盖当前渠道。同一运输方式对应多个物流渠道仍可为唯一结果。多个运输方式为 `ambiguous`；没有有效运输方式为 `not_found`。部分有效单运输方式缺失且存在已知候选时为 `unavailable`，不能声称已知候选是唯一运输方式；接口失败或分页不完整亦为 `unavailable`。
5. 非唯一、缺失或不可用时保留手填内容，用户可显式选择已有运输方式候选或手工填写。兼容保留 `channel`、`channelStatus`、`channelOptions` 字段名；`channelOptions` 按运输方式保存 `name`、`shipmentNumbers`、`channelIds`（返回时）和 `methodNames`，其中 `name` 来自 `method_name`。`channelIds` 是关联单的物流渠道证据，不代表运输方式 ID，也不按运输方式名称猜渠道 ID。
6. 新查询候选带 `channelSource='method_name'`。缺少该标记的历史已完成查询，在读取或操作号重放响应中清空渠道及候选、标为 `unavailable`，保留货件元数据，不改写历史数据库记录。旧草稿原值保留，可重新查询更新。

实现入口为 `apps/web/src/features/online-import.tsx` 和 `apps/server/src/modules/imports/fba-lookup.ts`，契约见[导入 API](../api/imports.md)。本轮只接入发货单列表查询，未接入上述发货单详情、渠道字典或运输方式字典；未创建或修改领星单据。

## 尚待真实数据验证

- 现有账号是否维护了目标 FBA 的发货单、关联货件、渠道和运输方式，API 权限是否允许读取；本次未验证。
- 一票 FBA 是否拆分到多张发货单、每张单的状态和运输方式是否一致；文档返回列表和关联列表，因此实现应支持多候选。
- 实际账号返回的运输方式是否完整、一致，以及有效单缺少运输方式时的人工确认流程；不从官方示例“海派”外推真实运输方式值或固定枚举。
- 官方示例与字段表存在少量类型、命名和版本差异，例如详情 `head_logistics_list` 表格标作数组而成功例为对象、`logistics_channel_id` 的字段说明写“渠道商ID”。实际适配需保留原始响应并按真实样本核验，不能仅按示例强制解析。
