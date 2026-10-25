# 发货模块数据模型

## 月内发货次模型（2026-10-24）

`shipping_run` 统一保存编号日期、`month`、月内 `sequence`、版本、`origin=import/manual` 和 `membership_frozen_at`。人工与自动共用 `shipping_month_counter`；人工首票、内部组与编号原子提交，失败不占次数。人工导入引用为空，初始 `draft`，不自动同步。

`shipping_ticket` 保存国家、票序及稳定票号；`shipping_ticket_member` 保存需求、内部组和输入顺序，人工成员不要求源行。需求全局仅一个有效内部组和一个发货票占用。组关联变化保留票号与顺序；发货次更正将原安排保存至不可变 `shipping_run_correction` 后解除成员冻结，不重领次数。历史文件、确认和箱码保留。

物理表 `weekly_batch` 继续作为兼容内部容器：新容器以 `shipping_run_id` 唯一关联发货次；旧日期只是弃用元数据，不参与新分组或业务筛选。历史未关联组显示“未关联发货次”，不根据历史周自动编号；未冻结组可显式关联，冻结组保留原引用。下文早期周模型仅作历史说明，以本节和当前契约为准。

## 发票逐箱数据调整（2026-10-23）

新单据成员快照增加可选 `boxSource`，保存由绑定 M2/领星快照形成的自动逐箱 PO、原值/单位和两位 KG/CM 数据。`document_revision.fields` 用 `box.<内部箱UUID>.po/weight/length/width/height` 保存本票人工覆盖，沿用不可变修订及更正机制，无须删除或改写旧 M3 数据。来源采用后保留仍存在的内部箱覆盖，去除已移出箱的覆盖；写入拒绝未知箱 ID。

有效性以稳定货件、M2、需求及货件修订等当前基础引用为准，不再要求 M3。旧成员无 `boxSource` 时兼容其既有 M3 快照，再回退绑定 M2；旧修订和已发布字节保持原样。M4 文件与 M5–M8 的逐箱投影共用最终采用值。详细规则见[发票箱规](../business/invoice-box-data.md)。

## M5–M8 工作流模型（2026-10-22）

迁移 `0017_flashy_surge` 新增 `workflow_record/revision/attachment/box_claim/export`。业务记录以共享契约校验 JSONB，保存不可变 M4/M2 来源及箱范围，旧来源中的 M3 引用保留；每次修改追加修订。有效箱占用受数据库部分唯一索引约束，取消释放占用，交接和外部结果保留。

复用 `batch_operation` 幂等账本及审计，事务业务锁协调范围占用、费用确认及归档。文件与任务同事务入队，生成及发布两次核对依赖。源文件及附件按实际字节验哈希，查询重新核对依赖。确认费用行基于历史修订永久锁定，补账返回草稿也不能覆盖。全表与文件备份覆盖新表和附件，归档含原需求、取数、历史文件、反馈、账单及关联清单。

## M4 单据当前模型（2026-10-19）

增量迁移 `0014_brainy_mulholland_black.sql`、`0015_simple_mongoose.sql` 增加下列实体，不覆盖既有 M2/M3 数据。

| 实体 | 保存内容与约束 |
| --- | --- |
| `document_profile` / `document_profile_version` | 商品、主体、地址、渠道及税务档案；类别和稳定键唯一，更新使用预期版本，旧版本不可变。 |
| `document_template` / `document_template_version` | 用途、名称、当前版本/状态及不可变模板文件 ID、SHA-256、上传人、原因。 |
| `document` / `document_revision` | 生命周期、并发版本及不可变修订；保存完整 FBA 成员、M2/需求/货件来源版本、逐箱自动来源、人工箱数据覆盖、来源候选、表头、资料版本和模板版本；历史 M3 引用保留。 |
| `document_member_claim` | 用途、SID、FBA、单据和修订；未释放的 `purpose + sid + fba` 唯一，跨重新导入需求身份仍防重。取消释放，更正事务内释放并重占。 |
| `document_validation` | 每次校验的修订、问题、结果、操作人和时间。 |
| `document_export` | 幂等操作、来源/修订/模板依赖、队列任务、状态、错误、文件引用和完成时间。文件落盘发布成功后同事务冻结来源组。 |
| `document_review` | 具体导出、文件 ID、SHA-256、来源/资料/模板依赖、通过或退回决定及原因；依赖变化时动态失效。 |
| `document_profile_import` | 资料预检文件、内容哈希、所属账号、行差异及提交时间；确认提交复核原件和当前版本，整批原子处理。 |

共享 `file_index`、管理员认证、操作幂等和审计；Worker 发布时再次检查依赖并持有对应锁。备份包含全部新表和模板/单据不可变文件，恢复检查文件哈希与修订、来源引用。API 见[单据契约](../api/documents.md)。

## T12与M2当前落地模型（2026-10-17）

`0009_marvelous_caretaker.sql`新增同步运行的鉴权attempt与checkpoint命中次数；旧运行默认0未回填。队列active状态与实际持锁执行者分别检查，run session锁释放后可立即标中断和恢复，业务预算及成功快照保持。

迁移`0007_big_cammi.sql`新增批次、同步和导出18张表，`0008_robust_marvel_zombies.sql`补齐同步外键、状态/预算校验及恢复操作哈希；均为增量迁移，保留既有导入、需求、店铺、身份和文件。下文“原模型与后续规划”保留早期关系设计；当前实际版本边界以本节、共享契约和迁移为准。核心16项真实PostgreSQL技术验收通过并清理夹具，见[核心证据（私有记录说明）](../acceptance/evidence/README.md)，不据此扩大至少20票、真实增量或业务签收范围。

| 实体 | 当前保存内容与约束 |
| --- | --- |
| `weekly_batch` | 内部容器、唯一 `shipping_run_id`、排序模式/版本及下一个前缀；新容器按发货次建立，旧日期仅作兼容元数据。 |
| `sub_batch` | 当前名称、状态、成员/元数据版本、保存顺序、前缀、确认版本、冻结时间、实际发货日期、原组/替代组关联。冻结后成员更正建立新组，不覆盖旧确认。 |
| `sub_batch_member` | 当前与历史成员、接受需求版本及active；复合外键绑定组与容器、需求与修订，需求全局仅一个active成员，复用稳定 `demand.id`。 |
| `sub_batch_revision` | 组版本、完整成员ID/元数据快照、动作、原因、操作人和时间；排序模式/顺序变更另在批次审计保存前后顺序及排序版本。 |
| `shipment_revision` | 需求ID＋递增版本唯一，绑定不可变需求修订；JSON保存完整商品及逐箱关系、平台ID、内部箱UUID、确认顺序、多数量口径、重量尺寸/单位、观察时间和问题。记录lingxing/manual/xlsx来源、原快照ID、原因、操作者及时间。 |
| `group_confirmation` | 绑定组版本，保存不可变成员需求快照、逐票商品箱修订和数量规则版本。未冻结新候选或需求变化使旧确认过期；冻结组继续读取原确认，候选留待更正。 |
| `allocation_code` | 容器、组、需求、内部箱、前缀和箱序；新编码在发货次内唯一，组内有效箱唯一，旧前缀和旧码不回收；追加保码，组结构变化依原版本规则作废受影响旧码。 |
| `batch_decision`、`batch_print_record` | 列表/详情冲突的人工决定绑定组＋货件候选版本；不允许备注豁免身份、缺值、装箱守恒等硬错误。打印表只记录人工事实并冻结组，不控制打印机。 |
| `batch_operation` | operationId、动作、操作者、请求哈希及完整结果；同请求重放原结果，异内容或异操作人返回冲突，和业务记录/审计同事务提交。 |
| `batch_sync_run`、`batch_sync_item` | 明确日期范围、成员/需求输入版本、独立队列任务、逐票状态和错误、请求预算/已用数、候选修订ID及恢复次数；部分失败独立保存，不误报完整成功。 |
| `batch_sync_snapshot`、`batch_sync_retry_operation` | 每票、接口、页、尝试和成功状态关联不可变文件，作为分页检查点；恢复操作有operationId＋请求哈希。原响应通过file_index保存哈希和原采集时间。 |
| `lingxing_token_cache`、`lingxing_read_cooldown` | 服务端加密令牌缓存及端点可用时间，配合数据库协调API/Worker请求；凭据及明文token不进入业务快照或前端。 |
| `batch_export` | 独立operationId、队列和状态，固定整组确认引用、元数据版本、规则/模板和完整报表投影；保存月/区域筛选、行/箱数、文件索引、错误和时间。文件不覆盖，发布前重新复核引用。 |
| `batch_intake` | XLSX补录的operationId、请求哈希、组/需求、受控原件索引和结果；补录原件、候选发布及幂等记录同事务关联，不保留可见半成品。 |

当前商品、箱和箱内商品采用不可变`shipment_revision.data`内的结构化关系，确认快照直接引用完整修订；不是用十个箱列建模。每个箱仅对应一票需求，商品完整键为sid＋FBA＋MSKU＋FNSKU＋SKU。逐箱数据保留显式0与缺值，平台boxId/packageId/localBoxId/箱名分别保存，只有可靠强标识续接内部UUID；不明确的跨次映射由人工确认。

正式主数量为详情`quantity`，逐商品要求等于装箱合计；列表当前/初始申报、本地已发货和接收量独立保存。确认阻止缺品名、缺身份、缺量、重复、箱映射冲突、未确认箱序、不守恒和不安全数字；列表冲突决定与接收差异不覆盖原始数据。

组成员动作统一复核当前管理员、operationId和期望版本，在发货次、容器和组锁内原子提交。需求版本在确认与导出发布前持共享锁复核，避免导入并发后发布过期事实。查询与文件计算在长事务外执行；Worker发布时再次检查身份和输入版本。同步仅建立候选，导出使用确认投影，失败保留历史。

实际发货日期为独立本地事实：已确认或冻结组可补登，组元数据version递增，但保留confirmed_version、状态、前缀、冻结时间和旧文件。新导出引用当前元数据版本，旧文件日期不回改。已安排货件按发货次编号日期归月，旧未关联记录保留来源业务日期参考；跨月组仍整体确认和冻结，完整组数量与本月数量分别展示，主表动态扩展箱列并附完整逐箱长表。

## 历史兼容：M3 实物箱核对模型（2026-10-18）

2026-10-23 起此模型不再作为新发票门槛。旧表、确认、文件及其备份/归档校验保留，不删除历史来源或自动补做确认。

M3独立绑定M2确认及其“货件修订ID＋内部箱ID”，不修改M2确认版本、箱码、冻结快照或原发货表条件。原有历史组默认未完成实物确认。`0012_romantic_lord_tyger`新增10张表，增量迁移及历史兼容技术验收通过，12类原核心表记录摘要不变；真实批次签收pending。接口见[M3 API](../api/physical-review.md)，证据见[M3技术验收（私有记录说明）](../acceptance/evidence/README.md)。

| 实体 | 保存事实及约束 |
| --- | --- |
| `physical_review_state` | 每组当前M2确认、独立M3版本、采用来源、草稿／确认指针及pending_change；写入持周／组／M3锁并复查期望版本。 |
| `physical_source` | 不可变来源及业务指纹；逐箱保存领星原值／单位、KG/CM两位值、PO、商品数量、原快照ID及缺项／身份阻塞。 |
| `physical_revision` | 组＋M3版本唯一；完整逐箱核对清单、实测、原因、动作、操作者和时间，追加保存。 |
| `physical_confirmation` | 组＋M3版本唯一；绑定M2确认、来源指纹、完整来源／核对快照和规则版本。 |
| `physical_sync_run`、`physical_sync_item`、`physical_sync_snapshot` | 独立任务／逐票状态、请求预算、错误、原响应文件与成功检查点；不发布M2商品箱候选。 |
| `physical_template`、`physical_intake_preview` | 不可变服务器manifest绑定版本、箱清单和来源；预检保存原件哈希、文件索引及核对结果，提交整批再校验。 |
| `physical_export` | 独立幂等号／队列状态、M2/M3引用、完整确认投影、箱数与文件索引；排队和发布前验证，成功后冻结，失败不提前冻结。 |

业务指纹按规范排序的箱成员、商品数量、两位采用值、PO及缺项状态计算，忽略时间、任务号和等值原单位。等值来源保留核对进度；发现实质变化置pending_change，采用后全组待核对。确认后修改实测记录追加修订并使原确认过期。旧来源、修订、确认和文件均不覆盖；已冻结未替代组可追加M3，被替代组只读。

备份逐表摘要自然涵盖全部M3表，并在表存在时显式记录physicalConfirmations和已完成physicalExports；旧库不存在这些表时省略可选字段，保持旧清单对等。恢复检查每份M3历史XLSX的索引／哈希、确认引用、三张表和数字0.00格式，默认禁止领星请求。

## 店铺来源模型（2026-10-18）

迁移0006保留既有店铺、文件和解析历史，新增全局`seller_catalog_settings`及幂等`seller_catalog_operation`；默认mode为lingxing。设置version标记来源切换，catalog_version标记成功同步或人工维护；预览同时绑定两者，提交持共享锁复查，变更返回409。

`seller_mapping.sid`仍是真实领星sid且全局唯一。既有name/country/marketplace_id等作为人工资料保留，`manual_enabled`标记人工模式可用，`lingxing_data`独立保存远程名称、国家、站点、授权状态、是否出现、观察时间及不可变归档索引/哈希。领星同步不覆盖人工字段，不删除历史身份；被远程观察或已被需求引用的sid不能原地修改。新建人工版本的before为空对象，其余修订保存完整前后值。

升级`0011_next_thunderbolts.sql`增加两个非空布尔列：`lingxing_auto_approved`（代码`lingxingAutoApproved`）记录领星自动批准，`lingxing_disabled`（代码`lingxingDisabled`）记录本地显式停用，默认均为false。原`status`只表示人工资料的candidate/approved/disabled，不用于覆盖领星审批；人工模式仍按`manual_enabled`及原status选择，批准历史按来源分别判断，保留首次人工批准规则。

领星有效视图使用`lingxing_data`的名称、国家和站点。未在目录出现时无当前可选身份；身份不完整、授权状态非`1`、尚未取得可信自动批准标记或`lingxing_disabled=true`时有效状态为disabled，不可用于导入；其余身份显示approved。DTO的`autoApproved`表示该来源的自动批准标记，不代替有效status判断。显式同步发布远端状态与自动批准标记；首次取得自动批准时追加店铺修订和`seller_mapping.auto_approve`审计，不修改人工status。本地停用不会因同步重置，远端撤权或移出目录不会回退使用人工身份。

0011先保留历史显式停用，再在本地迁移可信缓存：须有正sid、有效名称/国家/观察时间、present=true、授权状态`1`，并关联`file_index`中名称为`lingxing-sellers-*.json`、MIME为`application/json`的归档及匹配SHA-256。每个符合项记录自动批准、店铺版本加1并追加前后快照及审计；有变更时整个迁移只将目录版本加1。审计使用禁止登录、无凭据/会话的迁移身份。该过程不重新读取领星，不改人工字段、历史源行或需求快照；页面GET仅做只读投影，不写入或补审批。实际应用结果另由升级与验收记录说明。

`seller_alias.normalized_alias`只约束别名之间全局唯一，正式名称之间及正式名与他店别名仍可能碰撞。解析统一读取当前来源的有效身份，再按NFKC、trim及小写精确匹配，多个不同店铺匹配时保留人工确认，不设“正式名优先”或任取一条。

店铺同步的远程查询在事务外，文件索引、来源字段、目录版本、操作结果与审计同事务发布；查询失败保留最近成功快照。领星只读适配器固定允许查询操作，无业务写入入口。本节原“商品/装箱业务表和成品导出待实现”状态已由上方T12/M2当前落地模型替代，最终业务目标见[成品表目标](../business/store-sources-and-output-target.md)。

## T10–T11 需求确认模型（2026-10-17）

迁移0005在既有导入5表之外增加demand、demand_revision、demand_source、import_preview、import_commit。下文未实现需求确认的描述属于T09历史状态，以本节为准。

- demand以sid＋标准化FBA唯一，保存当前内容/版本和首次业务日期/周范围；需求与周批次成员分开，T12再建立批次和分组。
- demand_revision按需求＋版本唯一，保存不可变快照、操作者和时间。参考量是可空字符串，不是正式商品数量。
- demand_source以导入＋精确工作表＋物理行唯一，跨解析run去重；保存原源行ID、本次店铺确认和接受时的版本，并以复合外键关联该版本。
- import_preview持久保存解析/导入版本、店铺快照、差异及逐票需求基线；原始源行和历史解析不修改。
- import_commit以operationId唯一，保存操作者、请求哈希及完整结果；业务写入与审计共同提交，原请求重放返回原结果。

一票一需求与本次显式店铺确认由用户在本轮确定，取代此前sid＋FBA仅识别货件、需求行关联尚未定的限制。相同只补来源，变化需显式确认版本，缺失不撤销；完整接口见[导入契约](../api/imports.md)。

## 原模型与后续规划

版本：1.3。更新日期：2026-10-17（`Asia/Shanghai`）。发货实体多数仍规划；D05店铺维护及T09文件/解析/源行5张表已迁移实现，完整上传契约见 [导入API](../api/imports.md)。

本模型基于项目现有 TypeScript、Hono、PostgreSQL、Drizzle 和 pg-boss 技术栈。首版只做读接口同步、人工分组、数量校验和发货表/清关文件导出。本文是业务数据库规划，不代表当前迁移已经全部实现。

## 核心实体

```text
weekly_batch
  └─ sub_batch (可多个，可人工合并/拆分)
       └─ sub_batch_shipment
            └─ shipment
                 ├─ shipment_item
                 └─ box
                      └─ box_item
```

| 实体 | 关键字段 | 约束 |
| --- | --- | --- |
| `weekly_batch` | id、week_start_date、week_end_date、display_name、timezone、status | 周起止日期唯一；使用 `Asia/Shanghai` |
| `sub_batch` | id、weekly_batch_id、display_order、status、version、confirmed_at、membership_source | 同周可多个；排序默认最小 FBA，可人工调整；候选计划不自动等于正式组 |
| `sub_batch_shipment` | sub_batch_id、shipment_id、membership_version | 同一 sid + FBA 在同周只能属于一个有效子批次 |
| `shipment` | sid、fba_shipment_no、source_snapshot_id、shipment_status、is_sta、sta_inbound_plan_id、sta_shipment_id、business_ship_date、created_date、planned_ship_date、delivery_window | sid + FBA 唯一；日期分别保留来源，计划键仅作分组候选 |
| `shipment_item` | shipment_id、msku、fnsku、sku、product_name、detail_declared_qty、current_declared_qty、initial_declared_qty、local_shipped_qty、received_qty、packed_qty、comparison_policy_version | 各数量口径分开；packed_qty 来自逐箱聚合；主口径规则待业务确认 |
| `box` | id、shipment_id、external_box_id、package_id、external_local_box_id、box_name、box_name_source_field、confirmed_order、recipe_fingerprint、weight/unit、dimensions/unit、display_code、status | 内部 ID 独立；单箱只归属一个 FBA；localBoxId 和箱名不作全局键，原始/实测/确认值分开 |
| `box_item` | box_id、shipment_item_id、quantity | 同一箱同一商品键重复时阻止并人工确认 |
| `allocation_code` | sub_batch_id、prefix、box_seq、box_id、version | 当周前缀唯一；追加不重排旧码 |
| `source_import`（已实现） | owner、file_id、sha256、original_name、byte_size、imported_at、business_date、date_policy_version、week_start_date/end_date、status/version/latest_run_id、sheets | owner+sha256唯一；首次接收上海日期固定；与file_index关联 |
| `source_mapping_version`（已实现） | key、parser_version、definition、created_at | 迁移登记feishu-v1/manual-v1不可变映射；后续更改追加版本 |
| `import_parse_run`（已实现） | import_id、created_by、queue_job_id、input_version、sheet_name、mapping_version、parser_version、status、processed_rows/counts/issues/error、时间 | 原文件一对多解析；只发布当前有效版本，失败保留；队列retry0 |
| `source_import_row`（已实现） | parse_run_id、sheet_name、row_number、hidden、raw_cells、normalized、issues、status | run+物理行号唯一；旧run不可变，不静默删缺FBA行 |
| `import_operation`（已实现） | operation_id、kind、actor_user_id、request_hash、import_id、parse_run_id、deduplicated | 全局操作号唯一；重放原run/导入，异请求409；与audit共同事务 |
| `sync_snapshot` | endpoint、request_hash、response_hash、payload、received_at、pagination_state、cache_source_snapshot_id | 原始响应不可变；缓存沿用原采集时间和来源，不伪装为本次取数 |
| `validation_issue` | scope、code、severity、details、status、source_rows、comparison_version | 区分请求失败、准备差异、收货差异、重复和待确认；保留原表与诊断值 |
| `manual_decision` | action、old_version、new_version、actor、reason | 合并、删除、保留、修改、拆分、移动均审计 |
| `export_version` | sub_batch_id、data_version、file_hash、status、created_at | 只引用已确认版本 |
| `print_record` | export_version、label_type、range、status、printed_at | 已打印后冻结移动 |

为支持商业发票、清关单和物流 B2B 文件生成，还需要增加以下主数据和单据实体：

| 实体 | 关键字段 | 说明 |
| --- | --- | --- |
| `seller_mapping`（已实现） | id、sid、name、country、marketplace_id、wid、status、manual_enabled、lingxing_data、lingxing_auto_approved、lingxing_disabled、version、source_file_id | 人工审批与领星自动批准/本地停用独立；授权按最近成功目录观察判断，不另建重复店铺身份；完整多仓关系另行扩展 |
| `product_declaration` | SKU/MSKU/FNSKU/ASIN、英文/中文品名、material、HS、用途、品牌、型号、单位、单价、币种、图片/链接、生效期 | 领星平台品名/标题不能替代最终申报档案 |
| `party_profile` | 主体类型、名称、税号/VAT、地址、联系方式、生效期 | 保存卖方、经营单位、生产销售单位和收件主体 |
| `address_profile` | 地址编码、FC、国家、省州、城市、地址行、邮编、来源、优先级、版本 | API 地址、地址库和人工修改需要可追溯 |
| `channel_rule` | 业务渠道、物流商、国家、运输方式、领星承运字段、模板服务名、版本 | alphaCode/alphaName 不直接等同 示例渠道A/示例渠道B/示例渠道C/示例物流商 |
| `tax_rule` | 国家、渠道、报关方式、交税方式、VAT 条件、默认币种、版本 | 维护 9710/9810、买单/退税和递延规则 |
| `declaration_rule` | 数量口径、最低申报价比例、精度、舍入、汇率来源、生效期 | 保存单箱数量、整票数量和金额计算规则 |
| `transit_rule` | 渠道、FC、预计天数、区域、生效期、来源 | 领星送达窗口不等于实际开船和物流时效 |
| `document_group` | 分票条件、成员 FBA/箱、主体、税务、币种、状态、版本 | 支持一组或多组 FBA 生成文件 |
| `template_version` | 模板哈希、格式、适用范围、明细起始行、版本、状态 | 固定 XLS/XLSX/PDF 输出和模板变更 |

## 版本和状态

候选分组保存 `sid + STA计划ID`、来源快照和候选成员；正式 `sub_batch_shipment` 只引用人工确认的成员版本。计划缺失或计划与业务组关系不明时保留待分组，不强制唯一对应。

配方指纹在同 sid 范围内包含排序后的 MSKU/FNSKU/SKU/箱内数量；不包含 FBA 或展示码，以支持已确认组内跨货件比较。货件商品身份仍包含 FBA。箱方案比较保留配方频次，不能用去重指纹数量代替实际箱数。

同一源完整记录重复时保存所有 source_import 行及诊断去重结果；不自动删行。raw `boxName/box_name` 均保留在快照，规范化箱名另存来源字段；字段冲突作为 issue，不覆盖原值。

数据库保存原始同步快照、规范化数据、人工确认版本和导出版本。合并、拆分、追加、移除和重复处理不覆盖历史数据，而是创建新版本。已导出或已打印的子批次不可直接移动；需要走更正版本和重新导出流程。

本段为早期模型记录：当时schema仅有认证、M0、店铺和导入表。需求确认随后由0005实现，批次及商品箱修订由0007/0008实现，M3实物模型见上节；其他主数据和单据仍按后续模块建设。源行预览仍不等同已确认分组或正式装箱事实。

## 人工导入、店铺映射与系统账号

人工导入可使用飞书人工导出文件，或业务人员按确定模板填写的实际需求；不依赖飞书 API 接入。保存来源类型、原文件索引、提交人、时间和原始行，确认后创建内部业务 ID。后续新增、更正和重复处置保留版本；不能仅因没有飞书 record ID 就伪造外部来源键。

T05 D05实际落地使用`seller_mapping`，后续店铺集成复用该稳定ID和sid，不另建重复身份。原candidate/approved/disabled保存人工资料状态；当前领星状态由独立自动批准、本地停用及授权快照计算，完整关系见上方店铺来源模型。sid数据库唯一，是否允许更正由远程观察及需求引用锁定。当前仅保存指定成品仓，不代表完整多仓适用关系或每次页面读取都重新查询实时授权。

`seller_alias` 以 NFKC → trim → lowercase 的别名为主键，外键指向映射；停用仍保留占用。`seller_mapping_revision` 以 operation_id 为主键、映射ID+version唯一，保存操作者、请求哈希、原因、完整before/after及时间；服务只追加历史，不提供覆写入口。源文件通过已有 `file_index` 归档至受控私有 DATA_DIR。修订同时提交映射、别名、历史和 `operation_audit`，版本或唯一键冲突全部回滚。

早期曾将全部目录店铺初始化为候选，这是历史初始化状态。0011对符合可信条件的领星缓存记录独立自动批准，不能据历史总数推断当前可用数量。解析发布及`resolveApprovedSeller`先选择当前来源身份，再按有效已批准正式名/别名精确匹配，并把映射ID、sid及版本写入源行；不再按原人工status预先排除领星身份。人工候选仍不自动匹配，正式提交仍需本次店铺和版本确认；不能把源行预览视为正式需求提交。

系统登录账号已实际使用 PostgreSQL 的 `user`、`account`、`session` 及 `verification` 表。用户身份与凭证分开保存，Better Auth在写入凭证前执行密码哈希。2026-10-17起仅允许有效管理员登录及使用业务接口；共享角色契约和账户创建/更新均只接受admin，公开注册关闭。原非管理员的业务操作人、文件上传人及审计关联继续保留，历史身份不再提供登录或业务权限。管理页面尚未实现，受控CLI与管理员创建账号接口仅用于管理员。本机开发账号JSON不参与运行时认证。

迁移`0004_even_madelyne_pryor.sql`停用非管理员，删除其`session`和`account`凭据行，保留`user`行及业务/审计外键，不改写原上传人或操作人。该迁移要求非空用户库中已有有效管理员，不自动提升其他身份；操作审计记录处理数量。`user.role`默认admin，`user_admin_only_active_check`仅允许admin或已停用历史身份，阻止可用非管理员再次写入。

建议状态：

```text
待分组 → 待同步 → 同步完成 → 有差异 → 待人工确认 → 已确认
→ 可导出 → 已导出 → 已打印
```

## 事务和并发

- 导入确认、子批次成员变更、人工重复处理和导出版本创建使用数据库事务。
- 子批次和导出版本使用乐观锁，提交时检查版本号；并发修改返回冲突。
- 领星同步由 Worker 执行，保存逐页结果和任务状态；任务重启后从未完成页继续，不重复覆盖已确认版本。
- 所有外部请求使用 operation id、请求哈希和业务范围，重复提交返回已有结果或冲突。

## 首版验收守恒式

```text
每个商品行的箱内数量合计 = 领星对照数量
子批次商品总量 = 成员 FBA 商品量之和
编码范围箱数 = 子批次有效箱数
正式导出引用的数据版本 = 已确认版本
```

任何准备量、有效箱数或版本守恒式失败都阻止该子批次正式导出。当前规则版本采用详情quantity作为主数量；接收量单独用于收货差异，少收/多收不改变原装箱守恒式，也不静默覆盖准备量。以上技术校验不替代真实业务逐行签收及后续M3线下实物核验。
