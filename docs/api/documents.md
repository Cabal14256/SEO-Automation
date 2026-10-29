# 发票与单据 API

更新：2026-10-29。共享校验契约为 `packages/contracts/src/documents.ts`。所有端点均以 `/api/v1` 为前缀，仅有效管理员可访问；写操作校验同源、`operationId` 幂等和乐观版本。409 表示版本/占用冲突，422 表示参数或业务阻塞。

## 发货来源作废与历史文件

发货次、内部批次或单条 FBA 的取消／删除使用[统一生命周期 API](shipping-lifecycle.md)，与下文单据自身的取消、自动任务删除分开。已发布／冻结来源允许本地作废；涉及一条 FBA 即使相关完整单据及整批文件来源失效，待处理任务停止，不生成部分文件，不把剩余 FBA 静默保留为有效合票。

来源恢复不会自动恢复旧确认、复核及下游有效性，须重新核对、生成与复核。已发布单张／整批文件保留原字节和映射，可从授权下载入口读取并核验哈希；自动任务及单据历史下载均按不可变发布映射读取归档，不以实时来源仍有效为条件。列表中的当前有效性、生成和复核继续核对实时来源。失效历史文件不能用于新复核，取消不代表领星等外部单据已取消，也不删除其外部事实。

## 当前发票规则 v2

新建及更正单据的 `generationRulesVersion` 为 `v2`。2026-10-29 起，当前发票每件申报单价固定为 `2.00`，沿用本票币种，不换汇；不再按 Listing 售价计算。领星售价缺失、无效或与本票币种不同，以及历史人工售价失效，均不影响固定申报单价。普通商品档案或 `fields` 中的单价、币种及确认字段不能覆盖当前输出规则。

`productSourceFacts` 是服务端采用领星归档预览后保存的完整商品身份、`salesPrice/currency/unitPrice/cartonQuantity` 及 `sourceFileId/sourceSha256/fetchedAt` 快照；创建、修订、更正接口不接受客户端提交这两个属性。已归档的售价、派生单价和币种保留为来源事实，箱规件数仍参与申报数量默认值计算；来源文件、身份、箱数据及商品申报资料继续核验。

当前制作流程不再要求补充售价及售价原因。历史按售价 20% 计算的文件、快照及人工补价记录保留；重新生成当前规则文件须使用更正流程，不改写原文件。

`currentRevision.data.manualSalesPrices` 及兼容命令保留历史审计语义，不决定当前固定申报单价。新导出引用额外绑定 `pricingRule: "fixed-2"`，缺少此标记的旧文件不能作为当前价格规则的结果复用；已发布历史文件仍从原归档入口读取。

当前 ZIP 中的单票导出引用还绑定 `invoiceFileName` 和 `invoiceFileSha256`。单票下载提取对应 Excel，导出接口的 `fileSha256`、人工复核与后续工作流均绑定这份 Excel 的哈希；存储索引仍保留整份 ZIP 的大小与哈希，读取时同时核验 ZIP 和单票内容。历史单文件导出继续使用原归档哈希。

每个输出货箱编号只生成一行。2026-10-29 起 v2 同一完整 FBA 的 PO、毛重、尺寸一致且箱序连续时，即使各箱商品不同也合并为一行；按 MSKU、FNSKU、SKU 的固定文本顺序从全部箱内选择一个代表商品，申报资料、图片和链接取该商品，申报单价固定为 `2.00`。仅输出代表商品需要完整申报资料，全部源商品继续核验身份与数量守恒。J 列默认取代表产品 `cg_box_pcs`；不是有效安全正整数时回退代表商品所在箱的实际数量合计。混装、回退或默认申报数量与任一箱实际数量不同均提醒，允许导出后手工修改 Excel。F15 始终保留全部实际商品总量，箱数和毛重仍按实际箱去重，默认申报数量不回写发货及下游事实。

规则版本同时绑定导出引用；旧无版本快照按 v1 读取和验证，已发布文件不改写。旧未生成草稿须查询并采用领星资料建立 v2 修订，否则导出返回 `DOCUMENT_GENERATION_UPGRADE_REQUIRED`。旧版未完成任务或规则与修订不符时标记 `stale`，无文件的原待复核单据恢复草稿后重新取数生成。下文涉及人工价格确认和商品币种回退的说明仅适用于 v1 历史规则。

## 自动出单任务

默认制作流程在选择发货次和完整货件后，一次启动整批自动任务，最终提供一份 ZIP，其中每张发票为独立 XLSX 文件，每个文件保留本票表头和明细。即使表头相同，不同单据也不合并到同一 Excel 文件。服务端依次建立内部单据范围、查询并采用领星来源、准备资料并统一检查；全部范围通过后才生成并发布压缩包。浏览器不逐票请求查询、校验和导出。任务持久化，关闭向导、离开页面或重新打开浏览器不取消后台处理；工作台显示最近任务，可回到同一批次查看结果。

启动时若所选 FBA 已被未完成任务占用，返回 `DOCUMENT_AUTOMATION_BUSY`（409）及 `details.jobId`。页面提供“继续已有任务”，先读取该任务最新进度再打开，不重新启动或自动续跑；原新建选择和填写仍可从“继续本次制作”恢复。占用任务可能仅覆盖部分所选货件，须核对其实际范围。任务占用不显示成版本冲突；只有实际版本冲突才提示重新读取并核对，保留服务端具体原因和未保存输入。

任一范围存在缺项、来源歧义或错误时，整批停留在检查阶段，不生成部分文件，也不提供单范围下载。所有缺项集中在一页：公共字段填一次，按服务端指定的目标应用；商品、箱和单据字段分别保留完整作用范围，不能按同名标签混写。允许只填部分字段后保存，服务端统一复检，仍有缺项就继续留在检查阶段。全部范围就绪后再次核验引用，才生成并一次发布整份 ZIP。服务、地址、税务及箱规缺项仍须补齐真实资料。

补充保存使用批次版本、各单据版本和当前字段描述符原子提交；任一版本冲突不提交部分修改。保存失败时保留本次填写，不推进生成。重新读取缺项后如描述符版本变化，须核对新版并明确保留填写后再提交。已完成的准备阶段保留检查点，重新检查不会绕过整批屏障。旧 `legacy` 任务和已发布单据保留历史文件，可从单据详情追溯；新默认任务不沿用逐票下载流程。

整批非空且所有范围都已通过预检，但上次打包生成失败、尚无已发布文件时，使用“生成发票文件”继续原任务。该操作复用原任务的 retry，不重新建任务或草稿；响应失败后重试保留原操作编号。有缺项时仍显示“重新统一检查”，未保存填写、保存中或任务处理中不能重复生成。

自动准备仅采用唯一适用的有效资料和模板；多份适用配置不随意选择。已有引用保持具体版本，档案当前版本或模板哈希变化时显示待处理问题，不静默升级引用。收件地址以本票绑定的领星货件来源为准，不匹配本地地址簿；所有成员均有完整、相互一致且符合目的国家的来源地址时，可自动采用并确认，记录来源核对依据。人工改过且未确认的地址仍须人工核对，不自动代勾。

混装、申报数量回退及箱规件数差异沿用 v2 提醒，允许生成和下载，用户可在 Excel 中修改；币种冲突、无效来源、缺少真实出单必需资料等错误继续阻塞。自动任务不会批准复核，生成文件仍为待复核，复核继续绑定具体导出 ID 与文件 SHA-256。

任务 `mode` 保留兼容值 `single_workbook` 或历史 `legacy`，`single_workbook` 当前输出 ZIP；`phase` 为 `preparing/needs_input/ready/generating/completed/failed`。原 `status` 保留兼容值 `queued/running/completed/partial/blocked/failed`。`counts` 汇总 `total/queued/running/ready/exporting/completed/blocked`；内部 `items` 保留稳定 ID、货件范围、单据版本和问题，但新界面只按 `bundle` 提供整批下载。`bundle` 包含状态、文件 ID、文件名、可选 Excel 文件数 `fileCount`、兼容历史的 `sheetCount`、完成时间和错误；只有完整发布后可下载。历史 XLSX 仍按原文件名和类型返回。

`supplement` 可以为空，集中补充页通过 requirements 接口取得当前 `{descriptors,issues}`。描述符包含 `id,label,kind,value,required,scope,scopeLabel,options?,targets,help?`；scope 为 `common/product/box/document`，kind 为 `text/select/checkbox/number`。每个 target 精确绑定 `itemId,documentId,expectedVersion,fieldKey`。客户端提交描述符 ID 与值，不自行扩大目标。地址原因与确认复选框独立；人工地址只有在完整、填写真实核对原因并明确勾选后才确认。

当前统一补充页不再生成售价及售价原因描述符；商品申报资料仍按完整身份和服务端精确目标补充。页面显示固定申报单价 `2.00` 及本票币种，缺少 Listing 售价不会要求人工补价。

| 端点 | 用途 |
|---|---|
| GET `/documents/field-options` | 返回 `{services: string[]}`，从最新导入的丰信渠道参考目录读取无错误、无公式的服务名称并去重；没有目录时返回空数组 |
| GET `/documents/candidates?shippingRunId=UUID` | 指定发货次内有效 M2 完整货件、箱码阻塞、逐箱自动来源和绑定快照的地址/商品候选；不请求领星，不要求 M3 确认 |
| POST `/documents/automations` | 一次启动整批检查及独立 Excel 文件 ZIP 生成；`operationId,shippingRunId`，可选 `demandIds,fields,title`；继续已有草稿时改传成对的 `documentId,expectedVersion`，不能同时传 demandIds；返回 `{job,replayed}` |
| GET `/documents/automations` | 当前用户最近自动任务，可选 shippingRunId 筛选，返回 `{items}` |
| GET `/documents/automations/:id` | 读取同一持久化任务的批次和逐票进度，返回 `{job}` |
| GET `/documents/automations/:id/requirements` | 读取当前统一缺项及其具体单据版本，返回 `{job}`，描述符位于 job.supplement |
| POST `/documents/automations/:id/supplement` | `operationId,expectedVersion,documentVersions,values`；documentVersions 为单据 ID→版本，values 为 `{id,value}` 数组；原子保存并安排整批复检，返回 `{job,replayed}` |
| POST `/documents/automations/:id/retry` | `operationId,expectedVersion` 及可选 `itemIds`；重新安排检查，仍须全部范围通过才生成；返回 `{job,replayed}` |
| POST `/documents/automations/:id/delete` | `operationId,expectedVersion,reason`；取消并软删除当前账号的指定任务，不依赖队列可用；返回 `{automationId,version,deleted,deletedAt,cancelledDocumentIds,preservedDocumentIds,replayed}` |
| GET `/documents/automations/:id/download` | 授权下载完整发布的 ZIP（每张发票一个独立 XLSX），核验不可变发布映射及哈希；历史 XLSX 仍返回原归档，来源失效不改变原字节 |
| GET/POST `/documents` | 搜索、筛选及分页列表，或建立草稿；创建携带 shippingRunId、demandIds、title、fields |
| GET `/documents/:id` | 当前单据、当前修订校验及导出记录；失效来源显示 stale |
| GET `/documents/:id/history` | 修订、校验及绑定文件哈希的复核历史 |
| POST `/documents/:id/revisions` | expectedVersion、reason 及字段/资料/模板引用；可选 manualSalesPrices 命令补充或清除售价；demandIds 显式采用当前来源；confirmAddress=true 显式确认本次提交的最终完整地址 |
| POST `/documents/:id/product-image-preview` | 携带 expectedVersion、sid、msku、fnsku、sku、url；核对可编辑单据及完整商品身份后读取公开 HTTPS PNG/JPEG，返回图片快照，不建立修订 |
| POST `/documents/:id/validate` | 校验当前版本，返回 `{validation,replayed}`，不生成文件 |
| POST `/documents/:id/lingxing-preview` | 查询本票领星商品申报/清关资料及主体候选；携带 operationId、expectedVersion；归档来源后返回预览及权限诊断 |
| POST `/documents/:id/lingxing-apply` | 携带 operationId、expectedVersion、previewOperationId、reason、confirmPrices；从服务端预览补充空白资料并建立修订 |
| POST `/documents/:id/exports` | 校验并入队，202 返回 `{document,export,replayed}` |
| GET `/documents/:id/exports` | 本票文件历史、当前有效性及原因 |
| POST `/documents/:id/review` | decision=approve/return，绑定 exportId、fileSha256、expectedVersion 及 reason；生成中不可复核 |
| POST `/documents/:id/cancel` | 列表删除及向导取消共用：携带 operationId、expectedVersion、reason，标记 cancelled 并释放占用；已有冻结及历史保留，生成中或已结束单据返回 409 |
| POST `/documents/:id/correct` | 使用 demandIds 将原票全部货件原子移交新草稿；可选 manualSalesPrices 命令按新票范围核定；原票 superseded |
| GET `/document-exports/:id`、GET `/:id/download` | 任务详情或仅下载已发布发票；校验文件索引、哈希和管理员身份 |
| GET/POST `/document-profiles` | 列出或建立商品、主体、渠道、税务资料版本；列表不返回本地地址，category=address 返回空 items，地址新增和编辑已关闭 |
| GET `/document-profiles/:id` | 读取单份资料，返回 `{profile}`；历史地址资料仍可追溯 |
| POST `/document-profiles/:id/retire` | 停用非地址资料，返回 `{profileId}`；本地地址维护已关闭 |
| POST `/document-profiles/:id/restore` | 原地址恢复入口已关闭，保留历史数据 |
| GET `/document-profiles/:id/history` | 资料不可变版本、修改原因和操作人 |
| GET `/document-profiles/import-template.xlsx` | 下载资料批量导入模板 |
| POST `/document-profiles/import` | multipart 预检或提交，见下文 |
| GET/POST `/document-templates` | 模板列表或上传经过清理的丰信布局 XLSX；上传携带 file、operationId、purpose=invoice、name、reason；更新已有模板必须携带 expectedVersion，新建不传 |
| GET `/document-templates/:id/download?version=N` | 按版本下载受控模板 |
| GET `/document-templates/:id/history`、POST `/:id/retire` | 模板版本历史或按预期版本停用 |

自动任务删除使用与后台 worker 相同的排他锁；正在处理时返回 `DOCUMENT_AUTOMATION_BUSY`（409），任务版本变化返回 `VERSION_CONFLICT`（409），不能在后台步骤中途取消并释放占用。已请求的独立单票导出仍在排队或运行时返回 DOCUMENT_EXPORT_BUSY（409），须等待其结束，避免删除后仍产生新文件。成功后保存删除时间、操作人、原因和审计记录，清除待续跑意图，最近任务列表隐藏该任务；原任务读取、缺项、补充、续跑及整批下载均返回 404，延迟队列与恢复扫描也不再运行该任务。相同操作号和原请求重放返回原结果，不重复取消或增加版本。

工作台“自动出单任务”行内提供“删除任务”，确认框展示货件范围、任务编号及版本，要求填写删除原因。提交时锁定表单与关闭操作；网络结果不确定时允许原请求重放确认，版本冲突须重新读取并核对后再次提交。成功反馈区分取消的草稿与保留的单据，并刷新任务、单据与可出单货件；单据列表已有“删除单据”，仍使用单据取消接口保留历史。`corepack pnpm m4:deletion:browser` 使用全拦截内存接口验证任务删除、失败恢复和窄屏布局，不接触真实 API 或数据库。

删除只取消能以本任务确定建票操作的已提交幂等结果证明归属、仍为相同货件范围及检查点版本、没有任何导出记录且未被其他任务引用的草稿，并仅释放这些草稿的货件占用。建票成功但响应丢失的草稿也按该证明检查。接入的既有草稿、归属不明、后续版本已变化、有导出记录或被其他任务使用的单据保留，分别返回 cancelledDocumentIds / preservedDocumentIds 供核对。已有文件、单据历史、来源归档和冻结事实不删除；历史单据从原已发布导出入口授权读取归档字节，允许来源已失效，不通过已删除任务下载，也不据此认定文件当前有效。

GET `/documents` 接受 `page`（默认 1）、`pageSize`（默认 20，最多 100）、`q`、`weekStartDate` 和 `status`。关键词去除首尾空格，最多 200 字，忽略英文大小写，按字面匹配单据名称、单据 ID、订单号及成员 FBA／店铺；`%`、`_` 不作为通配符。来源周按 `YYYY-MM-DD` 精确匹配。状态默认 `active`，排除已取消及被替代单据；`all` 查询全部，或使用 draft、pending_review、approved、returned、stale、cancelled、superseded。状态按当前有效性判断，筛选先于分页，返回 `items,total,page,pageSize` 及规范化条件。取消后的原 ID 仍可读取详情、文件及历史；相同操作号重放不重复取消或增加版本。

资料导入预检 multipart 参数为 `phase=preview,operationId,file`，返回 previewId、文件 SHA-256、逐行 errors/changes、valid。提交参数为 `phase=commit,operationId,previewId,sha256,reason`；服务端重读原件、复核全部版本，任一错误整批回滚。同请求重放不重复增加版本。

可维护及批量导入的资料类别为 product、party、channel、tax；address 仅保留历史读取兼容，不再接受维护、导入或新的地址引用。档案引用用于复用和追溯，不强制每票分别引用商品、主体、渠道及税务档案；完整有效的单票字段和商品调整也可生成。已引用的资料仍须通过服务端版本与适用范围核验，停用或失效不能用手工字段绕过。商品身份必须完整匹配 sid/MSKU/FNSKU/SKU；unitPriceConfirmed 表示有效申报单价与币种组合已经人工确认。产品图片可采用公共资料，也可在本票商品申报中上传 PNG/JPEG 或显式读取图片 URL，保存修订后作为图片内容快照，不在重新打开页面或生成文件时抓取远程图片。

缺图以 `PRODUCT_IMAGE_MISSING` 提醒，旧快照中的无效图片以 `PRODUCT_IMAGE_INVALID` 提醒，允许生成待复核文件。图片列保留，无图或无效图的单元格留空；有图商品按实际明细行嵌图，不改变箱数、数量或行序。同一完整商品跨 FBA 的图片提醒仅报告一次，复核时保留具体商品提示。补图仅修改当前单据，替换、清空或恢复引用图片不改变公共资料及历史文件，也不撤回未变化的价格确认。

本票图片覆盖字段沿用 `product.<完整商品身份SHA256>.imageBase64` 与 `imageExtension`。单图最多 2 MiB，本票图片覆盖合计最多 8 MiB；只有规范图片字段可超过普通字段的 4000 字限制。图片 URL 只在显式预览时由服务端读取，必须为公开 HTTPS 图片直链，不跟随重定向；核对 DNS 地址并固定连接目标，校验大小、超时及图片内容。预览返回 `{image:{imageBase64,imageExtension}}`，不写入业务数据库，失败保留原图。创建、修订、更正请求的 JSON 上限为 12 MiB；图片须点击保存资料修订后才持久化，已有文件的单据仍须通过更正补图。

表单的报关方式、清关方式、交税方式、所在货站、币种及五项特殊属性选项由共享契约 `DOCUMENT_FIELD_OPTIONS` 定义，生成前校验及 XLSX 下拉使用同一组选项。服务目录仅供人工选择参考，不自动建立业务渠道与丰信服务的映射，也不设置税务或配送日期；显式引用的渠道资料若维护了非空 allowedServices/service，则本票服务仍须在该范围内。备注和预约配送时间可留空，填写后按原值导出。

本票币种按成员货件目的国家确定：美国为 USD，英国为 GBP，德国、法国、西班牙、意大利为 EUR。已支持国家的界面币种只读；创建及每次新修订均由服务端归一化。旧可编辑草稿的错误币种在前端显示为待保存修改，不自动提交修订；未知国家保留已有人工币种并允许选择。币种推导可识别德法西意同为 EUR，原有按店铺、渠道、目的仓及国家等分票规则继续生效。不同币种混票生成时以 `DOCUMENT_TICKET_CURRENCY_CONFLICT` 阻塞，须拆票，不自动换汇。

客户订单号 `orderNumber`、表头参考号 `reference`、贸易条款 `tradeTerms` 不再提供输入。创建、新修订及当前规则导出统一留空，即使旧草稿中仍有值也不输出；既有修订快照与已发布文件保留。逐箱 `PO / Reference ID` 仍按箱规规则填写和导出，与已移除的表头参考号独立。

丰信当前输出没有逐商品“申报单位”列，因此 unit 不作为生成必填项。v2 单价固定为 `2.00`，商品输出币种采用本票有效币种，不要求人工价格确认。以下价格及商品币种规则仅供 v1 历史兼容：商品币种空白时，通过共享 `documentProductCurrency` 仅回退本票已选的有效 USD、EUR 或 GBP；显式填写的其他币种不被覆盖，与本票币种不同仍阻塞。整票币种缺失或无效只在表头提示，不为每个依赖继承币种的商品重复报告币种缺项。单价须为可安全写入 XLSX、最多两位小数的有效正数，并须人工确认价格与有效币种组合。缺少单价或有效币种时先报告缺项，不重复附加“尚未确认”。同一完整商品身份跨 FBA 仅报告一次申报缺项（缺字段合并为一条 DECLARATION_REQUIRED）、价格、图片和销售链接问题；每个 FBA 的来源、箱数据及数量守恒仍独立校验。

v1 历史兼容的价格确认中，保存修订、更正或采用领星资料时，服务端会比较前后有效单价/币种，组合变化将撤回原确认；仅改变本票币种时，显式商品币种不变的确认保留，其币种冲突仍须处理。若在同一修订重新确认，fields 须同时显式提交该完整商品身份的 unitPrice、有效 currency 和 unitPriceConfirmed=true，并与新有效组合一致；领星采用沿用 confirmPrices 的明确确认操作。比较、币种回退和导出投影不会改写历史修订、公共资料或已发布文件。

带电、带磁、液体、粉末、危险品五项空白属性在创建、保存修订及生成时统一默认“否”，保留已有明确选择的“是”或“否”。旧草稿生成时采用同样的默认值，不修改既有修订快照或已发布文件。

明细 A 列“货箱编号”按每个 FBA 独立生成，欧洲与美国使用相同规则：v2 同一完整 FBA 的 PO、毛重、尺寸一致且箱序从 1 连续到 N 时，不再要求箱内商品组成相同，输出一行 `FBA号U000001-N`；只有一箱输出 `FBA号U000001`。PO、毛重、尺寸不同或箱序不连续时，保留逐箱明细及实际六位箱序，不追加自范围后缀。v1 保留原有完整同构压缩规则。不同 FBA 不合并编号或箱数。B1“客户订单号”留空，不从明细箱码拼接。已生成文件保持原字节，需通过更正生成新文件。

单据绑定稳定货件、M2 确认、商品修订和内部箱；新票保存 `boxSource` 自动逐箱快照，保留领星原始值和单位。旧快照中已有的 M3 确认/指纹保持原样，不作为新候选或新文件的必要条件；仅取消 M3 门槛不会使旧票失效。引用的资料内容均回查服务器版本，不信任客户端传入的版本正文。公共资料新增版本不会静默替换历史快照，具体采用需要新修订或更正。

逐箱人工覆盖通过 `fields["box.<内部箱UUID>.<字段>"]` 提交，字段为 `po/weight/length/width/height`。重量按 KG、尺寸按 CM 解释，直接输入覆盖值；提交 `null` 或移除该字段恢复自动来源，显式空串表示缺值并在生成时阻塞。仅允许当前完整箱清单内的覆盖，服务端拒绝未知箱 ID。显式采用更新来源时保留稳定箱 ID 的覆盖，去除已移出本票箱的覆盖。

自动来源优先采用本票 `boxSource`，旧票回退其既有 M3 快照，再回退绑定的 M2 逐箱数据；生成及下游投影使用同一套最终值。KG/LB、CM/IN 十进制换算后 `ROUND_HALF_UP` 到两位，原始值不覆盖。草稿可缺项，生成时 PO 及正数毛重/长宽高须完整且可安全写入 XLSX；来源未知单位或缺值可通过本票有效覆盖补齐。修改箱规不会回写领星或 M2；已有文件使用更正生成新版本。详见[箱规规则](../business/invoice-box-data.md)。

单票地址仅以 `fields` 为最终导出值，默认来源是成员 FBA 绑定的领星货件地址快照。自动采用要求每个成员均有完整地址、同一货件的候选来源无冲突、全部成员地址一致，且国家符合本票范围；地址代码不能替代完整地址。缺失、不完整、冲突或跨国家范围的来源不会自动填入或确认，也不回退本地地址簿。

街道来源兼容领星列表 `ship_to_address.address_line1/2/3`、详情 `shippingAddress.addressLine1/2/3` 以及旧 `address_line_1/2/3`，逐字段采用首个非空别名；两个接口的不同非空值仍构成来源冲突。候选地址分别归档显式 `addressCode/address_code` 和原始物流中心编码 `data.destinationFc`（来自列表 `destination_fulfillment_center_id` / 详情 `warehouseId`），不混淆原始字段。

v2 的 B3 常规采用每个成员均有证据且一致的领星物流中心编码，不回退需求输入 FC；历史草稿仅从绑定的成功原始文件补读缺失 FC，不重新请求领星。若指定参考库中存在特殊编码或同 FC 多地址，须按国家、FC 及完整地理地址唯一匹配，且最终地理地址与绑定领星来源一致；公式、缺项、冲突或无法唯一匹配时清除自动猜值、撤回确认并标记 `addressCodeStatus=needs_review`，统一补充页要求填写 B3 和原因并明确确认。已确认的完整人工地址及非空 B3 保留，直接修订 B3 且未指定地址模式时服务端按人工修改处理。

参考文件通过 `DOCUMENT_ADDRESS_CODE_CATALOG_FILE` + `DOCUMENT_ADDRESS_CODE_CATALOG_SHA256` 指定，原件不可读、哈希改变或解析失败会明确拒绝，不静默回退 FC。服务端保存 `addressCodeRuleVersion=lingxing-fc/v1`、`addressCodeStatus`、`addressCodeSource`、`addressCodeReason`、来源快照摘要及使用的参考哈希/行号；客户端提交的自动来源说明会被重算覆盖。新导出再次核对编码、来源与参考采用版本，旧快照即使 B3 恰好同值也不能跳过参考版本采用。仅补编码，不从货代参考库覆盖收件地址或重新启用本地地址资料。

新生成的单票及 ZIP 内各 Excel 文件均对 B3:B14 自动换行、按合并列宽和字体设置行高，并保留模板及右侧字段需要的高度；打印标题行为 `1:17`，后续页重复完整地址区和商品表头。地址过长导致单行或完整重复表头超出受控打印布局时返回 `DOCUMENT_WORKBOOK_INVALID`，提示拆分地址行或调整模板列宽。新的 ZIP 文件继续保留这些布局规则，原历史文件不改写。

旧快照升级解析时，若同一成员、同一绑定原件仅补出此前未解析的 FC，或补齐已由同票详情提供的空街道，且旧非空值不变、每个 FBA 新旧完整地址一致，不因这类纯解析补全撤回刚完成的自动确认。真实地址、已解析 FC 变化，或新发现冲突/缺项，仍须重新核对；新增字段造成的补全不允许跨 FBA 借用地址。

服务端在创建、采用来源及符合条件的修订中整份填写十二项字段，标记 `addressSelectionMode=lingxing` 并保留来源说明，不建立本地地址资料引用。浏览器通过“采用地址”显式填入领星候选，修改后须保存，不自动 POST 或代替人工确认。已有本票人工填写不被异步资料刷新覆盖；成员或领星地址来源范围变化会撤回旧确认，并按新来源重新核对。历史地址引用、修订和已发布文件保持可追溯。

共享 `applyDocumentAddress` 整份替换十二项地址字段，未提供的可选字段清空，写入 `addressAdoptionVersion=explicit/v1` 并撤回旧确认和原因。修改地址或更换来源时，服务端同样撤回旧确认；若在同一修订显式重新确认，须提交 `confirmAddress=true`、最终 `fields`、`addressConfirmed=true` 和非空 `addressConfirmationReason`。人工采用来源候选或补充本票地址后，须核对完整地址并记录依据，不回写领星。完整地址包括收件人、地址第一行、城市、邮编和两个英文字母的国家代码。

工作台不再提供本地地址簿页面、保存到地址簿或地址资料集中选择；原地址页链接转到单据资料。地址缺失时可先在领星核实，或在本票填写并明确确认。原地址资料及其不可变版本不删除，既有单票快照和文件不改写。

领星资料查询及所需 API 权限见[领星单据资料查询与权限](../integrations/lingxing-document-profiles.md)。查询结果先预览再采用；v1 人工价格默认未确认，v2 当前申报单价固定为 `2.00`，领星归档用于商品资料及箱规取数。既有非空字段和资料不会被静默覆盖。

`node scripts/m4/document-defaults-browser.mjs` 使用本地内存接口验证空白表头、六国自动币种、未知国家人工回退、混币种阻塞、领星地址来源、本票人工地址保留、历史只读快照和窄屏布局。`node scripts/m4/document-automation-browser.mjs` 验证一次整批启动、统一缺项屏障、公共/商品/箱精确目标、部分保存、保存及进度读取失败保留填写、版本冲突、全批就绪后 ZIP 下载、关闭恢复及窄屏界面。`document-manual-price-browser.mjs` 验证缺失或无效售价、旧人工售价及旧价格覆盖均不改变当前固定单价，也不会要求补充售价。脚本不调用真实业务 API 或外部地址，写入只更新各自进程内存；当前固定单价及 ZIP 内独立 XLSX 内容由服务端回读测试核对。
