# T08–T11 上传、解析、差异与确认提交契约

版本：1.7。更新：2026-10-23（`Asia/Shanghai`）。本契约覆盖上传前校验、模板下载、T09解析及T10–T11映射、差异、选择提交、需求版本、导入草稿和统一发货工作台的需求管理。仅有效管理员可访问。周批次和子批次业务接口及领星同步见[批次契约](batches.md)。

共享Zod定义见 `packages/contracts/src/imports.ts`、`demands.ts`、`demand-workspace.ts` 和 `import-drafts.ts`。页面为 `/imports`、`/imports/new` 和 `/imports/$importId`，统一发货工作台为 `/shipping`。上传保存不代表业务需求确认；必须生成差异预览并选择提交。提交建立需求和版本，不创建周批次、子批次或领星任务。

2026-10-23 新增[本次发货自动整理](shipping-runs.md)：新导入默认按空白行分票，可仅提供单列 FBA；后台依次补全、提交和制表。上述手动确认流程在“仅导入需求”模式保留。源行增加可选 `sourceTicketIndex`、`sourceMemberIndex`，草稿保存编号日期和分票边界，票号不写入需求内容字段。

## 权限与文件

仅有效管理员可以上传、重新解析及访问全部导入、源行、解析历史和原文件。匿名请求401；非管理员、未知或停用身份被拒绝；不存在的对象404。对象和列表均在数据库检查当前管理员身份及停用状态，Worker领取前和结果发布前再次检查；排队后失去管理员权限的任务失败且不发布源行。旧非管理员上传的原件和源行仍由管理员访问，其原始操作者关联保持可追溯。

文件仅支持非空、最多10MiB的 `.xlsx`；multipart总包额外允许64KiB表单开销。扩展名、ZIP签名和包结构分别检查；旧XLS、宏、加密ZIP、路径穿越、DTD/实体及外部工作簿链接不支持。普通超链接仅作为原始内容，不访问链接。文件名只用于展示，存储路径由系统UUID生成，前端不能传本地路径。

原文件通过已有不可变文件服务保存至受控私有 DATA_DIR，建立file_index并保存SHA-256/长度。目录记录、解析运行、操作幂等、审计和pg-boss入队在同一数据库事务提交；失败清理新文件。若数据库提交结果不明确，只在能确认无已提交索引时补偿删除，无法确认时保留受控文件供核对，避免损坏已提交原件。下载和解析均重新检查索引、长度与哈希。

## 接口

`GET /api/v1/imports/transport-methods`：仅已登录且未停用的管理员可读取领星运输方式字典，无需任务队列。响应为 `{items:[{id,name,enabled,remark}],queriedAt}`，其中 `id` 保持字符串精度，列表包含停用项以供历史值展示。通过统一领星只读客户端查询 `listTransportMethods`，只返回完整有效的列表；缓存五分钟并合并并发请求，领星连接错误返回 503 与对应错误码。在线来源的业务渠道下拉只允许新选已启用名称；空白允许按 FBA 自动补全，旧值或粘贴的非字典值保留并提示修正。历史来源和已提交快照不回写。

| 方法与路径（均带 `/api/v1`） | 请求 | 结果 |
| --- | --- | --- |
| `POST /imports` | multipart：单个file及UUID operationId，不设置JSON Content-Type | 202 `{import,run,taskId,taskUrl,replayed,deduplicated}`；taskId=run.id，taskUrl为解析历史查询入口 |
| `GET /imports` | page默认1，pageSize默认20/最多100 | `{items,total,page,pageSize}`；有效管理员查看全部；按importedAt/id倒序 |
| `GET /imports/template` | 已登录管理员，无需请求体 | 下载 `需求导入模板.xlsx`；标准空白数据页及填写说明，无示例需求，响应为 XLSX attachment |
| `GET /imports/:id` | UUID | `{import}`；查询当前状态时对账已失败/取消的队列任务 |
| `GET /imports/:id/runs` | UUID | `{items}` 最近100个解析运行，按创建时间/id倒序 |
| `GET /imports/:id/rows` | page/pageSize，可选status、parseRunId | `{items,total,page,pageSize,parseRunId,previewVersion}`；默认当前run；历史run须属于该导入；按物理rowNumber/id升序 |
| `POST /imports/:id/parse` | JSON，见下文 | 202同上传结构；expectedVersion与幂等检查；运行中不能替换 |
| `GET /files/:fileId/download` | 受控fileId | 授权、校验后以attachment返回原文件；无任意路径访问 |

客户端于 2026-10-19 改为在活动文件向导的“填写与解析”阶段，选择有效文件后自动调用上述 `POST /imports`；正常流程移除“上传并校验”，失败后提供“重试上传”并保留原文件及 `operationId`。恢复尚未接收的文件草稿进入该阶段时自动继续原请求；隐藏文件面板、在线方式、取消选择和本地无效文件不触发上传。同一文件操作不会因重渲染重复自动提交。服务端上传协议、校验、去重、日期及解析队列契约未改变；详见[当前操作](../operations.md#选择文件后自动上传2026-10-19)。

```json
{
  "operationId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 1,
  "sheetName": "飞书表格",
  "mappingVersion": "feishu-v1"
}
```

该示意不代表已经执行。映射接受已登记不可变版本 `feishu-v1`、`manual-v1` 和 `online-v1`，具体列位置见字段规格及本页在线填报扩展。工作表名精确保存，UI加引号显示尾空格。上传在保存和排队前自动检查 XLSX 结构与支持的表头，不要求固定工作表名称；唯一可用且可见的输入表通过后绑定 `sheetName/mappingVersion` 并自动排队。多张可用表或只有隐藏候选进入 `awaiting_mapping`，保留工作表清单及人工选择，不按表名优先级静默取表。

损坏文件、不安全压缩/XML、宏、无支持表头（`UNSUPPORTED_IMPORT_HEADERS`）或没有非空需求行（`EMPTY_WORKSHEET`）返回 422，不创建新的导入文件或解析任务；具体原因在响应 `error.message` 中。行内 FBA、数量等错误属于后续解析和需求核对，仍保留源行，允许其他有效行继续提交。成功的操作号或相同内容重放优先复用原记录，不重新解释历史上传。

模板复用 `online-v1` 十三列映射：店铺、渠道、国家、目的FC、FBA货件号、参考数量、来源填写时间、子批次名称、备注、仓库地址、货件创建时间、元数据来源、查询时间。参考数量列为默认隐藏的历史兼容列，新需求无需填写；后两列为空白保留列。模板和上传快照的解析规则相同，下载本身不建立导入记录或需求。

## 状态、幂等和版本

导入状态：上传校验通过后 `queued → parsing → preview_ready/failed`；需要人工选表时直接保存为 `awaiting_mapping`（元数据运行 completed，未排队），人工确认后再进入 queued。解析运行状态：`queued → running → completed/failed`；completed代表该运行完成，即使部分源行有错误也不代表需求有效。每次重新解析增加导入version，建立新的run；历史行绑定parseRunId，保持不可变。重新解析不修改原文件或业务日期。新解析器标识为 `xlsx-preview-v2`，历史运行保留原版本。

写请求必须同源且带operationId。同操作者、对象/文件及内容重放返回原run；同operationId不同请求409。新操作号但同一操作者及相同文件SHA-256返回原导入和原日期，不新增文件或任务。不同操作者上传相同字节拥有各自隔离记录。解析请求先检查已完成幂等操作，再检查expectedVersion；并发提交旧版本或导入忙返回409，不自动覆盖或自动重试。页面网络失败保留文件/选项和operationId，同一请求可显式重试。

## 日期与数据模型

`importedAt`采用服务端成功接收本次文件的时间，`businessDate`转换为上海YYYY-MM-DD；保存 `datePolicyVersion=import-date-shanghai-v1`、周一起止日期。解析、确认、网络重试跨日不重新取日期，同文件幂等重放沿用原日期。来源J、输出X等原日期仅参考，不当作实际本轮业务归周或发货完成事实。

| 实体 | 关系与约束 |
| --- | --- |
| source_import | UUID、owner、fileId、SHA/大小/名称、固定日期/周范围、status、version、latestRunId、sheets；owner+SHA唯一 |
| source_mapping_version | 映射键、parserVersion、不可变列定义；迁移内登记三种v1映射 |
| import_parse_run | 导入/操作者/pg-boss job、inputVersion、sheet/mapping/parser版本、状态、进度、分类计数、错误、开始/完成时间 |
| source_import_row | parseRunId+物理rowNumber唯一；原工作表、隐藏状态、rawCells、normalized、issues、行状态；不覆盖旧run |
| import_operation | operationId全局唯一，kind/actor/requestHash/importId/parseRunId/去重标志，关联audit |

上传先检查操作号及内容重放，只有新内容才进行完整校验并保存/排队。Worker领取和最终发布使用短事务，Worker重新读取文件、校验压缩包和解析XML在事务外。队列retryLimit=0，执行超时120秒；失败、取消、超时经API或Worker五秒对账持久化为失败，用户显式重新解析。排队任务重启后继续；运行中断不自动重放成功结果。行结果在一次发布事务写入，无部分解析行伪装完整预览；处理中显示等待，终态后显示实际计数。

解析限制：最多1000个ZIP条目、解压合计64MiB、单条32MiB，逐流校验实际解压长度；最多100张工作表、全文件50000个物理行/500000单元格，所选输入页最多10000行/256列。采用yauzl预校验及fflate/fast-xml-parser读取原始OOXML，以保留物理类型、原始值、公式和缓存状态；没有执行公式、宏或外部请求。模板生成和导出复用既有ExcelJS，解析原件不通过ExcelJS重建值模型，以保留“无缓存/空缓存”的差异。

## 预览数据与未定业务

rawCells保存address/column/type/rawValue/decoded value/numberFormat/formula/formulaCache/hidden。源行保存物理工作表和行号；隐藏、合并、重复及缺身份均提示，空值与0不同。缺缓存保留公式且不把公式文本作数量或编号。FBA去首尾空白并大写，重复保留所有行并标记；缺FBA行保留并报错，不静默删除。

解析阶段按当前来源下已批准正式店铺名或可选别名精确匹配，别名可留空；名称同名或与他店别名碰撞时不自动选择sid，保留待人工确认。确认阶段允许管理员为本次导入显式选择候选或已批准店铺，保存独立确认快照，不批准全局别名。来源国家冲突报错。参考数量仅保留原值，负数/非整数提示错误；数值超过安全整数时保留原始数字文本并报错，不将舍入值用于规范化数量。不据其生成正式商品量。来源少行不自动撤销需求，来源键为空不伪造来源ID。

## T10–T11 差异与提交

以下接口均带 `/api/v1`。请求与响应严格按共享schema校验。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /imports/:id/confirmation` | 返回来源名称/国家/行数、候选店铺、最新预览ID、提交摘要及可选历史基线 |
| `POST /imports/:id/preview` | 输入expectedVersion、parseRunId、sellerSelections及可选baselineImportId；持久化并返回第一页差异 |
| `GET /imports/:id/previews/:previewId` | page/pageSize及可选kind分页筛选；返回preview、items、total |
| `GET /imports/:id/previews/:previewId/errors.csv` | 授权下载带文件/工作表/行/单元格的错误清单；转义CSV及公式前缀 |
| `POST /imports/:id/commit` | 输入operationId、previewId、selectedItemIds、confirmedChangedItemIds；原子提交选中范围 |
| `GET /imports/:id/commits` | 返回提交历史、成功清单、关联需求ID/版本和来源位置 |
| `GET /demands/:id` | 返回当前需求、不可变版本及全部确认来源 |

sellerSelections逐项包含sourceShop、sellerMappingId、expectedVersion、confirmed=true。预览请求另必须提供expectedCatalogSettingsVersion和expectedCatalogVersion，与confirmation.catalog当前值一致。服务端保存sid、当前来源下的店铺名称/国家、确认人及时间；preview保存sellerCatalogMode、sellerCatalogSettingsVersion、sellerCatalogVersion。停用、切换来源、更新目录或版本变化返回409，国家冲突进入可定位错误；无需wid，不修改全局店铺或别名。

三步向导在“填写与解析”阶段采用店铺映射，不再设置独立确认步骤。`confirmation.shops[].resolution` 为兼容新增的可选对象：`status=unique/ambiguous/unmatched`、`sellerMappingId`、`expectedVersion`、`reason`；仅唯一匹配返回非空建议 ID 和版本。在线快照中的已验证 FBA 查询 SID 优先，其次采用当前目录已批准名称／别名的唯一匹配；国家冲突、同一来源名称下多个查询 SID 或失效查询身份不自动采用。前端唯一匹配自动携带原协议的 `confirmed=true`，异常在第一步选择；该标记表示本次采用映射，界面不宣称用户逐店铺勾选。其余源行保留为错误，不阻塞有效需求。草稿确认内容可选保存 `shopSelections` 与 `baselineImportId`，旧草稿仍有效。

一票一需求，以sid与去首尾空白/大写的FBA为唯一键。差异kind为new、unchanged、changed、conflict、error、missing。比较渠道、目的FC、仓库地址、货件创建时间、备注和来源子批次名称；原店铺别名、原日期、来源ID、文件名、行号及历史参考量不触发需求变化或同票内容冲突。参考量仅保留在历史字段和原始来源中，不展示于日常填写及核对界面，不参与正式商品量。只改变参考量的提交仅补来源，不覆盖既有需求快照或增加版本；旧预览提交时仍按当前语义复核。来源批次名不自动创建分组。

映射后同票同内容的所有来源保留为一项；同票内容不同或任一行存在阻塞错误时整票不可提交。错误含文件名、精确工作表名、物理行和可用单元格地址。只有显式选择历史baselineImportId才提示其已提交需求在本次缺失；提示不撤销、删除或移周。

新增建立需求v1，变化须逐项confirmedChangedItemIds确认后追加版本，相同只补来源。业务日期和周范围只在首次建立需求时取本次导入固定值，跨周重导不移动既有需求。同导入/精确工作表/物理行跨run唯一；重解析不能改绑已提交来源，旧原件不会重新应用旧内容。新预览中的已提交项只读；旧成功请求可重放。

预览绑定导入/解析/店铺快照及逐票需求版本。提交锁定导入、店铺及按固定顺序排列的货件键，复查有效管理员、最新解析、店铺和需求版本及来源状态。选中范围整体提交或回滚：过期409、非法项目/未确认变化422。文件中未选错误不影响其他有效项。

提交结果、需求、版本、来源及审计同事务保存。operationId同操作者同请求返回原结果并标记replayed，异请求409；先查重放再查版本，断网后可用同操作号核对。重新解析不取消已提交事实。解析status保持原枚举，确认入口另返回not_submitted、partially_submitted或submitted摘要。

新增demand、demand_revision、demand_source、import_preview及import_commit五表；sid/FBA唯一、需求版本唯一、源行原点唯一，来源通过外键关联接受时的需求版本。原文件及解析源行不修改。

## 错误

统一结构 `{error:{code,message,details?,traceId}}`。401未登录，403角色/来源拒绝，404对象不可见，409版本/操作/忙冲突，413大小限制，415文件格式不支持，422请求校验，503数据库/队列/文件不可用，500未预期错误。异步解析的结构、缓存或完整性失败保存在run.errorCode/errorMessage供页面展示。服务器不记录源行正文、凭据或连接串。
# 需求工作区与在线填报扩展

发货工作台主表统一使用 `GET /api/v1/demands`，浏览独立于正式报表的确认及编码门槛。支持 `month`、周批次 `batchId`、`weekStartDate`、子批次 `groupId`、`grouping=ungrouped`、`sid`、`country`、`channel`、`region=all/US/EU`、`status`、`q`、`page`、`pageSize`。`month` 按首次业务日期筛选，区域复用正式发货表的国家规则，英国归欧洲；省略 `region` 或使用 `all` 不限制区域。归属筛选与数据处理状态分别生效；未建立周批次的需求也可用 `weekStartDate` 筛选。返回 `rows/total/demandTotal/maxBoxes/filters`，其中 `filters.weeks` 提供全部需求周及去重票数，筛选选项不随当前页或条件清空。

新增 `lifecycle=active|cancelled|all`，默认只查询当前需求，与数据处理 `status` 分别筛选；返回行包含 `lifecycle`。已取消需求保留历史占位及来源，可查询但不可分组或导出。`GET /demands/:id` 保留需求、修订和来源，增加 `management`（lifecycle、canEdit、canDelete、reason、groupId、batchId）及 `operations`（action、reason、createdBy、createdAt、version），写入时再次原子复查权限与版本。

`POST /demands/:id/revisions` 携带 `operationId`、`expectedVersion`、`reason` 及非空 `fields`；fields 严格仅允许 channel、destinationFc、destinationAddress、referenceQuantity、notes、sourceFilledAt，各值为去首尾空格、最多 2000 字的字符串或 null。店铺、FBA、国家及首次业务日期／归属周不可修改。`POST /demands/:id/cancel` 携带相同操作号、版本与原因字段。原因必填、最多 1000 字；响应为 `{demand,replayed}`。两者保存新版本及操作审计，取消保留原行、所有来源和修订；组内修改同步成员版本并撤回组确认、作废相关旧码，取消移出成员。冻结、有效下游占用或运行中任务返回 409；请求重放不重复增加版本。取消状态复用已有审计记录，无数据库迁移。导入预览将已取消身份标为不可提交，提交、分组及候选采集再次校验，避免同一 sid/FBA 被隐式恢复。

默认仍按商品展开后分页，每页50行。`pageBy=demand` 按完整货件分页；单页发货工作台采用每页20票，以同一份返回数据切换“货件分组、商品平铺、逐箱长表”三种展示，共用筛选、分页、来源和状态，不分别维护需求表与成品表。商品或有效内部箱码关键词匹配到某票时返回该票完整商品明细，不因搜索切掉其余商品；`total` 是完整匹配货件的商品/占位行数，`demandTotal` 是总票数，货件分页使用后者判断末页。无商品的需求保留一条占位；候选数量缺失或无效返回 `null`，合法0保持0。有效确认优先显示确认快照；冻结后保留该快照，不随新需求或候选更新；原确认过期时显示最新候选并提示核对。

商品行兼容新增 `groupQuantity/monthQuantity`（`number | null`，旧响应可缺省）。二者只来自该子批次的有效确认快照，按 `sid + MSKU/FNSKU/SKU` 完整商品身份合计，并在搜索与分页前计算；`groupQuantity` 包含完整确认组，`monthQuantity` 按所选 `month` 的首次业务日期计算，未指定月份时等于该组全期商品合计。合计不按当前页、关键词或箱内重复出现次数累加；候选、确认失效及无商品占位行均为 `null`，无效数量或超出安全整数范围也不显示为正式合计。

每条商品行的 `boxes` 表达实际箱与该商品的数量分布。新增可选 `boxName/externalBoxId/localBoxId/weightUnit/lengthUnit`（`string | null`）及 `weight/length/width/height`（`number | null`）。重量与尺寸保留来源原值和单位，不自动换算或推定缺失单位；缺失、空白或无法表示为有限数值的测量为 `null`，合法0保留0。一个混装箱可出现在多条商品分布中，始终沿用同一个 `boxId`；货件箱数使用 `totalBoxes` 或按实际箱身份去重，不能把逐箱商品行数当成箱数。有效确认和冻结行的箱资料随相应确认快照显示，候选行保留其候选来源。

主表中的“已确认”、箱码或上述合计均不替代正式导出校验。导出资格仍由 `GET /api/v1/batch-reports` 的确认引用提供，前端同时核对可见主表的 `groupId/groupVersion/confirmationId`；生成请求提交完整 `groupIds/expectedConfirmations` 及原有 `month/region`。关键词、商品展示方式及当前页不裁剪导出批次成员；按完整子批次的确认版本导出，文件成功发布后才冻结。接口细节见[批次报表契约](batches.md#报表补录与文件)。

2026-10-20 起，导入结果可显式将本次提交的去重 `demandId` 带入新建/加入批次流程。导入提交接口及数据模型不变，分组继续调用周批次和成员接口；同一文件不自动成为同一批次。已分组需求显示原归属，跨周、店铺、国家或渠道的需求分别核对。

`POST /api/v1/imports/online` 接收 `{operationId, rows}`，最多1000行。文本字段为 `fba/shop/channel/country/destinationFc/destinationAddress/shipmentCreatedAt/sourceFilledAt/referenceQuantity/notes`；采用查询候选时同时提交 `lookupId/lookupSid`。服务端生成不可变“在线填写快照.xlsx”，使用“在线需求导入”工作表及 `online-v1` 映射，返回现有202 `ImportAccepted`，继续经过源行预览、店铺确认、差异及显式提交。公式样文字按文本保存。操作号幂等基于标准字段顺序的输入内容，等值输入生成相同快照字节；同操作号异内容409。

`POST /api/v1/imports/fba-lookups` 接收 `{operationId,fbas,startDate,endDate,expectedCatalogSettingsVersion,expectedCatalogVersion}`，最多100个不同FBA，UI日期两端均包含。服务端将结束日期转换为领星左闭右开的次日，限定当前可用店铺范围，不自动扩大日期。返回202 `FbaLookupRecord`；通过 `GET /api/v1/imports/fba-lookups/:id` 轮询。完成后每票为 `unique/ambiguous/not_found` 及候选店铺、国家、目的FC、地址、创建时间、取数时间；每个候选另返回 `channel`、`channelStatus` 和 `channelOptions`。货件查询失败或分页不完整时不发布补全结果。

在线“补全并解析”按标准化 FBA 去重，每批最多 100 个顺序查询，汇总后一次保存在线快照，保留 1000 行容量。查询未找到、失败或存在差异时暂停，用户处理或明确选择按当前填写继续后再解析。查询与提交结果不确定时复用各自操作编号，已完成批次不重复发起；终态失败任务重试使用新查询操作编号。在线草稿可选保存 `pendingSubmission` 原请求，须与草稿 `operationId/rows` 一致；恢复后直接重试原提交，不重新补全或修改内容。正式需求仍须在差异预览后显式提交。

Worker 先完整读取并校验领星货件列表，再以实际找到的 `sid + FBA` 集合，通过只读 operation `listInboundShipments`（`POST /erp/sc/routing/storage/shipment/getInboundShipmentList`）查询关联发货单。请求使用店铺集合 `sids`、FBA 精准条件 `senior_search_list` 和 `is_delete=0`；发货单每页20条，每类列表最多20页，两阶段共用40次请求预算。响应按 `relate_list[].sid + shipment_id` 再次核对，只接纳 `status=-1/0/1/2` 的有效单，作废、删除及未知状态剔除。业务渠道指头程运输方式，只取 `method_name`，不以物流渠道名称 `logistics_channel_name` 或平台SPD/LTL字段回退。

兼容保留 `channel`、`channelStatus`、`channelOptions` 字段名。`channelOptions` 按运输方式逐项保存 `name`（来自 `method_name`）、`shipmentNumbers`、`channelIds`（返回时）和 `methodNames`；`channelIds` 仅为关联发货单的物流渠道证据，不代表运输方式 ID。新查询候选带 `channelSource='method_name'`；缺少该标记的历史已完成查询在读取或操作号重放响应中清空渠道及候选、标为 `unavailable`，保留货件元数据，不改写历史数据库记录。旧草稿原值保留，可重新查询更新。渠道状态规则如下：

| `channelStatus` | 含义与在线表处理 |
| --- | --- |
| `unique` | 所有有效关联单的非空运输方式一致且无运输方式缺失；`channel` 返回该方式，采用货件候选时优先填入或覆盖当前渠道，包括 HYKD 等旧缩写；同一运输方式对应多个物流渠道仍可为唯一结果 |
| `ambiguous` | 得到多个运输方式；不自动填入，用户显式选择候选或手工填写 |
| `not_found` | 未取得有效运输方式；保留手工内容并提示人工确认 |
| `unavailable` | 运输方式查询失败、分页不完整，或部分有效关联单缺少运输方式但存在已知候选；不声称唯一，保留手工内容，已有候选可显式选择 |

关联发货单接口失败或分页不完整时降级为渠道 `unavailable`，仍发布此前已完整校验的货件元数据；限流、请求预算耗尽、目录或查询范围变化则中止本轮，不发布补全结果。该能力接入在线表“通过 FBA 补全信息”，文件导入仍保留来源渠道原值，不自动发起领星查询；新规则不回写历史导入、需求或确认快照，不改变渠道必填规则。

查询只获取元数据，不建立需求、分组或商品装箱版本，不写回领星。候选店铺的别名审批状态不限制只读查询，停用或实际目录未授权店铺排除。在线来源记录为 `sourceType=online`，历史与文件上传为 `xlsx`；列表另提供 `submissionStatus/submittedSourceRows`。填写、创建、实际发货及首次导入业务日期各自保存。新增字段兼容旧快照缺值；来源填写日期仍属于证据，不因更换来源日期生成需求变化。

## 导入草稿箱（2026-10-19）

草稿共享定义为 `packages/contracts/src/import-drafts.ts`，实现见 `apps/server/src/modules/imports/drafts.ts`。下列路径均带 `/api/v1`，只允许有效管理员读写自己的草稿；他人草稿按不存在返回 404。管理员可将按现有导入权限可访问的导入关联到自己的草稿，不要求关联导入也由自己上传，草稿内容仍按 owner 隔离。草稿与正式导入分别保存，保存草稿不调用领星、不创建解析任务、不提交需求，也不确定首次导入业务日期。

| 方法与路径 | 请求 | 结果 |
| --- | --- | --- |
| `GET /imports/drafts` | `q` 可选、最长 200 字；`page` 默认 1，`pageSize` 默认 20、最多 100 | `{items,total}`；按更新时间/id 倒序，搜索草稿标题、在线内容或文件名 |
| `GET /imports/drafts/:draftId` | 草稿 UUID | `{draft}`；当前用户未删除草稿及完整内容 |
| `PUT /imports/drafts/:draftId` | JSON `{title,expectedVersion,content}`；标题去首尾空格后 1–120 字，新建 `expectedVersion=0` | `{draft,replayed}`；同草稿 ID、相同期望版本及相同内容的成功请求可重放，不重复递增版本 |
| `DELETE /imports/drafts/:draftId?version=N` | 当前正整数版本 | `{deleted:true}`；版本冲突 409，软删除并清空未提交草稿内容，保留正式导入及需求 |

`content` 保存 `source`、`progress`、可选 `online`、`file`、`confirmation`。在线内容最多 1000 行，保存查询日期、原操作号和行值；文件保存名称、类型、修改时间、标准 Base64 字节及原上传操作号，解码后须非空且最多 10 MiB。草稿请求体最多 20 MiB。`progress` 保存关联导入 ID、来源、目标步骤和已核对版本等恢复标识，来源必须与外层一致；`confirmation.importId` 必须与关联导入一致。

草稿行允许尚未补齐的业务字段，但仍受字段类型、长度及文件大小校验。草稿保存结果未知时，前端锁住原 ID、期望版本及内容，显式重试原请求；已知 4xx 校验或版本错误后才解除原请求锁并修改或另存。恢复草稿不自动采用旧版本确认；当前解析、目录和需求版本检查仍在正式预览/提交路径执行。普通勾选不作为持久确认，已经发起的未知业务提交保留原 payload 和操作号用于重放。浏览器刷新/关闭只受原生离开提醒约束，不能保证退出时执行自定义异步保存；当前操作流程见[草稿箱与恢复](../operations.md#需求导入草稿箱2026-10-19)，其规则覆盖旧标签页自动恢复行为。

头程运输方式的官方 API 核验及实现边界见[通过 FBA 查询头程运输方式](../integrations/fba-logistics-channel.md)：在线补全读取关联领星发货单的 `method_name`；2026-10-23 口径调整未新增真实账号调用验证。
