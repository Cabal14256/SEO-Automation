# 发货次、内部批次、同步与发货表 API

更新：2026-10-20（Asia/Shanghai）。本页对应 T12、T14–T21 及本轮批次工作区接口。所有业务接口要求当前有效管理员；POST 检查可信来源。匿名返回401、无权限403，参数错误422、版本/冻结/幂等冲突409。请求及响应契约见 `packages/contracts/src/batches.ts`、`reports.ts`；同步契约由同步模块维护。

T23恢复配置新增 `LINGXING_REQUESTS_ENABLED`（默认true，严格接受true/false）。false时同步提交/重试返回503、`LINGXING_REQUESTS_DISABLED`；旧任务、令牌缓存、鉴权和续约也不能外联。新导出仅在发布成功事务中保存已冻结投影，与发布后页面状态一致；queued/failed和历史文件不回改。

## 批次工作区列表

`GET /api/v1/batches/workspace` 返回本地批次摘要，不查询领星、不建立批次，也不读取商品/逐箱大 JSON。共享契约为 `batchWorkspaceQuerySchema`、`batchWorkspaceSchema`。

| 查询参数 | 约束与含义 |
| --- | --- |
| month | 可选 `YYYY-MM`，已关联批次按发货次月份筛选；省略为全部月份 |
| shippingRunId | 可选发货次 UUID，定位某月第几次发货 |
| sid、country、channel | 可选店铺正整数、国家、业务渠道；成员条件须由同一货件同时满足 |
| status | 可选 `empty / draft / confirmed / frozen`；已替代组不列入主工作区 |
| q | 可选，去首尾空白，最长 200 字；批次名或 FBA 不区分大小写搜索 |
| page、pageSize | page 默认 1、范围 1–100000；pageSize 仅 20 或 50，默认 20 |

响应顶层保留 `{rows,total,page,pageSize,availableWeeks,filters}` 兼容结构，弃用的 `availableWeeks` 和 `filters.weeks` 返回空集合。`total` 为筛选后行数，每个有效组一行；成员条件命中后仍展示完整组摘要。`filters.shippingRuns` 提供发货次选项，另含店铺、国家和渠道，不受分页清空。历史未关联组显示“未关联发货次”，不据旧日期自动创建次数。

每行含以下字段：

| 字段 | 含义 |
| --- | --- |
| id、rowKind、batch、group、shippingRuns | 行标识、内部容器、子批次和明确关联的发货次摘要；旧周日期仅作兼容元数据 |
| memberCount、sids、shops、countries、channels、fbas | 完整组的货件数和去重身份摘要；冻结组引用原确认成员 |
| status | `empty` 为无有效组的容器占位，其余对应子批次状态 |
| sync.syncedMemberCount | 具备当前需求版本数据的成员数；冻结组按原确认统计 |
| sync.staleMemberCount | 已有候选但对应需求版本过期的成员数 |
| sync.latestRun | 最近任务 `{id,status,groupVersion,createdAt,completedAt}` 或 null |
| confirmation | `{id,groupVersion,createdAt,current}` 或 null；current 检查成员/需求/候选版本，冻结组沿用原确认 |

`confirmation.current` 是列表摘要，不代表已经满足正式成品导出条件；后续接口仍检查阻塞异常、当前确认、箱编码、冻结和版本。前端处理向导另检查同步是否结束；状态读取失败不能按“没有任务”放行。

前端 `/batches` 使用此接口；“新建批次”或 `/batches/new` 进入选择发货次、选择需求、核对建立、结果四步，建立结果显式进入已有组处理向导。处理深链 `/batches/<处理容器UUID>?groupId=<组UUID>&wizard=process` 支持成员、同步商品、核对确认、成品导出，旧 `groupId/tab/demandId` 详情链接保留。向导复用下列业务接口，不新增自动合组或自动同步行为；恢复边界和未知请求重放见[运行说明](../operations.md#发货批次工作区与向导2026-10-18)。店铺维护入口归于 `/settings/seller-mappings`，API 路径保持。

## 发货次与内部组

新建及追加通过 [发货次接口](./shipping-runs.md) 同步保存票关联。周创建入口退役；旧写请求仅在操作账本已有相同原结果时允许幂等重放，未执行旧请求返回 `LEGACY_FLOW_RETIRED`，保留选择后转入新向导。`weekly-batches` 读路径作为历史兼容别名保留，不再表达业务周。

所有路径以 `/api/v1` 为前缀。

| 方法与路径 | 用途 |
| --- | --- |
| GET /batches/workspace | 分页内部组、发货次筛选和同步摘要 |
| GET /weekly-batches | 历史兼容的内部处理容器列表 |
| POST /weekly-batches | 仅重放已成功的历史请求；新建使用发货次接口 |
| GET /weekly-batches/:id | 批次版本、排序、子批次和未分组需求 |
| POST /weekly-batches/:id/sub-batches | 仅重放已成功的历史请求；新组使用发货次分票接口 |
| POST /weekly-batches/:id/reorder | 期望批次版本与完整有效组ID顺序 |
| POST /weekly-batches/:id/allocate-codes | 选择已确认组、组版本及批次版本，按已保存顺序分配 |
| GET /sub-batches/:id | 当前成员/候选、问题、历史确认、编码及操作历史 |
| POST /sub-batches/:id/members | 完整成员集合及需求版本，追加或移除 |
| POST /sub-batches/:id/merge、/split、/move | 人工合并、拆分或移动成员 |
| POST /sub-batches/:id/correction | 冻结组创建关联更正组，保留旧事实 |
| POST /sub-batches/:id/shipments/:demandId/manual | 带来源说明的完整人工候选数据 |
| POST /sub-batches/:id/box-mapping | 对全部箱提供内部ID对应和唯一顺序 |
| POST /sub-batches/:id/decisions | 对确切货件修订记录列表数量冲突采用详情量的决定 |
| POST /sub-batches/:id/confirm | 绑定确切需求/候选版本，经校验建立不可变确认 |
| POST /sub-batches/:id/confirm-and-allocate | 校验当前成员/候选和同步状态，在单事务内自动确认并分配箱码 |
| POST /sub-batches/:id/actual-ship-date | 独立本地发货日期事实；冻结后可登记，新版本审计 |
| POST /sub-batches/:id/print | 登记确切确认版本的人工打印事实并冻结 |

除自动确认接口外，修改输入共同含 operationId、expectedVersion、reason；重放返回原结果，不同内容复用编号返回409。成员全局唯一性由数据库约束和发货次/容器锁保证。确认不等于实物核验。旧/作废编码不回收；移除保留其余编码，合并拆分移动使影响组的旧码全部作废。

`confirm-and-allocate` 严格接收 `{operationId,expectedVersion,expectedBatchVersion,expectedDemandVersions,expectedShipmentVersions}`，其中 `expectedVersion` 是子批次版本，两个版本映射必须完整对应当前成员。说明由服务端生成“系统自动确认当前有效数据版本并分配箱码”，记录操作者、时间、确认快照及操作审计，不接收人工 `reason`。返回现有 `BatchMutationResult`，含 `groupId/batchId/operationId/replayed`。

接口对发货次、处理容器、组、需求和商品箱版本加锁校验，拒绝阻塞异常、冻结/已替代组、排队或运行中的同步，以及未解决的最近同步失败。提示级接收差异允许继续。确认和分码原子成功或全部回滚；已有有效确认复用，已有箱码保留，追加箱接续编号；完整确认及箱码均已就绪时不增加版本或占用新前缀。相同操作号与完整原内容重放返回原结果。

前端仅在当前可见的“校验、确认与编码”阶段，读取版本与同步状态成功后自动提交；后台隐藏阶段不写入。未知结果在当前账号/组的浏览器会话中保存原请求，显示“重试自动确认与编码”；已知409/422暂停，显式“刷新后重新校验”后采用新版本。刷新和轮询不会重复确认同一数据事实。旧 `confirm` 与 `allocate-codes` 接口为兼容保留。

## 领星只读同步

| 方法与路径 | 用途 |
| --- | --- |
| POST /batch-sync/:subBatchId | operationId、expectedVersion、startDate、endDate、requestBudget、maxPages |
| GET /batch-sync/:subBatchId | 最近同步运行历史 |
| GET /batch-sync/runs/:runId | run 与逐票 items，包括请求数、快照ID、错误与候选修订 |
| POST /batch-sync/runs/:runId/retry | operationId、additionalRequestBudget；只恢复未成功范围 |

日期是货件创建日期，区间左闭右开。分页固定100条，默认10页，默认单运行100次业务attempt预算；预算、分页及失败结果均持久保存。部分成功状态为 `partial`，不改变旧示例任务四状态契约。预算耗尽不会自动扩大，重试必须显式指定追加预算。

同步返回 `authRequests`（令牌获取/续约attempt）和 `cacheHits`（本次恢复读取的成功checkpoint）单列计数，不扣业务预算。0009迁移前历史运行的计数未回填，默认0不能解释为曾经没有鉴权。执行期间持跨进程run锁；Worker异常退出后，恢复对账识别已无持锁执行者的active任务，立即标记中断并允许恢复，无需等待两小时队列超时。

token获取/续约与业务成功码分开；令牌加密缓存，同appId/URL跨进程协调。仅固定查询白名单及鉴权接口可访问。响应与请求摘要保存不可变文件，不保存公共鉴权参数、密钥和签名。冻结组刷新只新增候选，原确认投影仍可查看；更正组才能采用新数据。

## 报表、补录与文件

| 方法与路径 | 用途 |
| --- | --- |
| GET /batch-reports | shippingRunId、month=YYYY-MM、subBatchId、sid、country、channel、region=all/US/EU、q、page、pageSize（≤100）；旧 weekStartDate/weeklyBatchId 仅保留兼容读取 |
| GET /batch-reports/intake-template.xlsx | “货件商品”与“逐箱商品”两表补录模板 |
| POST /batch-reports/intake | multipart：file、subBatchId、demandId、expectedVersion、reason、operationId |
| POST /batch-reports/exports | operationId、groupIds、expectedConfirmations、可选month及region |
| GET /batch-reports/exports | 按 shippingRunId、subBatchId、month 读取导出历史 |
| GET /batch-reports/exports/:id | 单条导出，响应 `{export:record}` |
| GET /files/:fileId/download | 授权原需求文件或已发布发货表下载 |

报表响应含分页商品rows、完整筛选范围boxes、total、maxBoxes、confirmation引用和blocked。只有已确认且全部箱已编码的组进入正式表；异常仅影响相应组。月筛选不拆组，完整组和本月商品合计分别表达；英国属于欧洲业务视图。

商品表在分页前按 FBA 的最小内部编码排列完整 FBA 块，前缀顺序为 `A…Z、AA、AB…`，同前缀按数字升序；块内保留首个正数量箱列的商品顺序。编码列表、逐箱明细与新生成 XLSX 使用相同编码顺序，箱列和数量不随排序变化。

`q` 可选，去首尾空白，最长 200 字，不区分英文大小写；匹配子批次名称、FBA、店铺、品名、MSKU、FNSKU、SKU 和内部编码。先形成月份／区域投影，再搜索命中子批次并保留该组完整投影，最后分页；`rows/boxes/confirmations/total/maxBoxes` 使用同一搜索范围。搜索仅用于定位子批次，导出仍提交完整组及确认引用，不将 `q` 写入导出请求。

`shippingRunId/sid/country/channel` 使用确认快照中的同一成员定位子批次，成员须同时位于当前月份／区域范围内；命中后保留该组原有月份／区域投影，不按这些定位条件裁剪商品或箱。`sid` 为正整数，国家和渠道去首尾空白后精确匹配。共同筛选选项沿用需求工作区的 `filters`；成品响应不另增选项集合。定位条件仅决定所选组，不写入导出请求，导出继续以 `groupIds/expectedConfirmations` 和原有 `month/region` 校验完整组及确认版本。

导出expectedConfirmations逐组含groupId/groupVersion/confirmationId，必须与页面预览一致。状态为queued/running/completed/failed/stale。提交与入队同事务；文件生成后再次检查当前管理员、组版本和确认，成功后才保存索引和冻结事实。旧文件保持原数据和日期，更正替代状态单独展示。

补录文件非空且≤10 MiB，ZIP展开与公式/外链受控校验；同一文件只接受选定sid/FBA。数量保留显式零、拒绝缺值冒充零。源文件、人工原因和候选修订一起保存，不能绕过商品身份、箱关系和数量守恒。
