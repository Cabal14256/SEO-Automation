# 发票与单据 API

更新：2026-10-28。共享校验契约为 `packages/contracts/src/documents.ts`。所有端点均以 `/api/v1` 为前缀，仅有效管理员可访问；写操作校验同源、`operationId` 幂等和乐观版本。409 表示版本/占用冲突，422 表示参数或业务阻塞。

## 发货来源作废与历史文件

发货次、内部批次或单条 FBA 的取消／删除使用[统一生命周期 API](shipping-lifecycle.md)，与下文单据自身的取消、自动任务删除分开。已发布／冻结来源允许本地作废；涉及一条 FBA 即使相关完整单据及整批文件来源失效，待处理任务停止，不生成部分文件，不把剩余 FBA 静默保留为有效合票。

来源恢复不会自动恢复旧确认、复核及下游有效性，须重新核对、生成与复核。已发布单张／整批文件保留原字节和映射，可从授权下载入口读取并核验哈希；自动任务及单据历史下载均按不可变发布映射读取归档，不以实时来源仍有效为条件。列表中的当前有效性、生成和复核继续核对实时来源。失效历史文件不能用于新复核，取消不代表领星等外部单据已取消，也不删除其外部事实。

## 当前发票规则 v2

新建及更正单据的 `generationRulesVersion` 为 `v2`。`productSourceFacts` 是服务端采用领星归档预览后保存的完整商品身份、`salesPrice/currency/unitPrice/cartonQuantity` 及 `sourceFileId/sourceSha256/fetchedAt` 快照；创建、修订、更正接口不接受客户端提交这两个属性。有效的 Listing 普通 `price` 始终优先，申报单价统一按售价 `× 0.2` 精确计算并 `ROUND_HALF_UP` 保留两位。普通商品档案或 `fields` 中的人工单价、币种及确认字段不能替代新规则来源。

仅在领星售价缺失或无效、已保留可核验来源归档及完整商品身份、且本票国家能唯一确定 USD/EUR/GBP 时，可人工补充本票商品**售价**和真实依据。系统仍自动计算 20% 申报单价，不能直接手填申报单价，也不自动换汇。有效远端金额即使币种与本票冲突，也不能用人工售价覆盖；应处理原价/币种冲突。旧归档的空售价即使曾标记 `LISTING_PRICE_INVALID` 也可直接补充，不因该标记单独强制重查；但已知归档中存在有效金额时，不允许用旧空事实遮蔽后人工替代。缺少可核验归档或身份时仍须查询并采用资料。

人工售价保留输入精度，只在计算申报单价时舍入。例如 `19.99 → 4.00`、`0.025 → 0.01`；零、负数、科学计数法、非法文本及 20% 舍入后为零的值（如 `0.01`）不接受。价格与非空依据必须同次提交，依据最多 1000 字。领星售价 `0.01` 因无法产生有效申报价可补正，但人工输入 `0.01` 仍不能通过。没有有效远端或有效人工售价时继续阻塞整批生成。

`currentRevision.data.manualSalesPrices` 保存服务端生成的完整身份、售价、国家锁定币种、原因、填写人/时间、归档文件 ID/哈希和对应成员来源版本。它不会改写 `productSourceFacts`、领星或公共商品档案。有效远端恢复后优先使用远端；货件来源版本或币种变化时，旧人工记录不能静默跨范围沿用。请求中的同名属性只接受 `{sid,msku,fnsku,sku,salesPrice,reason}` 命令；币种、操作人、时间及来源信息均由服务端核定，不能由客户端指定。`salesPrice:null` 显式清除本票人工价，历史修订和文件保留。

每个输出货箱编号只生成一行，按 MSKU、FNSKU、SKU 的固定文本顺序取箱内首个商品为代表，申报资料、单价、图片和链接均取该商品。仅代表商品需要完整申报资料，全部源商品继续核验身份与数量守恒。J 列默认取代表产品 `cg_box_pcs`；不是有效安全正整数时回退全箱实际数量合计。混装、回退或箱规与实际数量不同均提醒，允许导出后手工修改 Excel。F15 始终保留实际商品总量，箱数和毛重仍按实际箱去重，默认申报数量不回写发货及下游事实。

规则版本同时绑定导出引用；旧无版本快照按 v1 读取和验证，已发布文件不改写。旧未生成草稿须查询并采用领星资料建立 v2 修订，否则导出返回 `DOCUMENT_GENERATION_UPGRADE_REQUIRED`。旧版未完成任务或规则与修订不符时标记 `stale`，无文件的原待复核单据恢复草稿后重新取数生成。下文涉及人工价格确认和商品币种回退的说明仅适用于 v1 历史规则。

## 自动出单任务

默认制作流程在选择发货次和完整货件后，一次启动整批自动任务，最终只提供一份 XLSX。服务端依次建立内部单据范围、查询并采用领星来源、准备资料并统一检查；全部范围通过后才生成合并工作簿。相同最终表头的数据合并到同一 Sheet，不同收件地址或币种等表头内容分 Sheet。浏览器不逐票请求查询、校验和导出。任务持久化，关闭向导、离开页面或重新打开浏览器不取消后台处理；工作台显示最近任务，可回到同一批次查看结果。

任一范围存在缺项、来源歧义或错误时，整批停留在检查阶段，不生成部分文件，也不提供单范围下载。所有缺项集中在一页：公共字段填一次，按服务端指定的目标应用；商品、箱和单据字段分别保留完整作用范围，不能按同名标签混写。允许只填部分字段后保存，服务端统一复检，仍有缺项就继续留在检查阶段。全部范围就绪后再次核验引用，才生成并一次发布整份工作簿。缺项不能用虚构价格、服务、地址、税务或箱规填充。

补充保存使用批次版本、各单据版本和当前字段描述符原子提交；任一版本冲突不提交部分修改。保存失败时保留本次填写，不推进生成。重新读取缺项后如描述符版本变化，须核对新版并明确保留填写后再提交。已完成的准备阶段保留检查点，重新检查不会绕过整批屏障。旧 `legacy` 任务和已发布单据保留历史文件，可从单据详情追溯；新默认任务不沿用逐票下载流程。

整批非空且所有范围都已通过预检，但上次合并生成失败、尚无已发布合并文件时，使用“生成发票文件”继续原任务。该操作复用原任务的 retry，不重新建任务或草稿；响应失败后重试保留原操作编号。有缺项时仍显示“重新统一检查”，未保存填写、保存中或任务处理中不能重复生成。

自动准备仅采用唯一适用的有效资料和模板；多份适用配置不随意选择。已有引用保持具体版本，档案当前版本或模板哈希变化时显示待处理问题，不静默升级引用。此次全自动授权允许唯一、完整且无来源冲突的地址簿版本自动确认，并记录包含该地址版本的自动准备原因；人工改过且未确认的地址仍须人工核对，不自动代勾。

混装、申报数量回退及箱规件数差异沿用 v2 提醒，允许生成和下载，用户可在 Excel 中修改；币种冲突、无效来源、缺少真实出单必需资料等错误继续阻塞。自动任务不会批准复核，生成文件仍为待复核，复核继续绑定具体导出 ID 与文件 SHA-256。

任务 `mode` 为 `single_workbook` 或历史 `legacy`；`phase` 为 `preparing/needs_input/ready/generating/completed/failed`。原 `status` 保留兼容值 `queued/running/completed/partial/blocked/failed`。`counts` 汇总 `total/queued/running/ready/exporting/completed/blocked`；内部 `items` 保留稳定 ID、货件范围、单据版本和问题，但新界面只按 `bundle` 提供整批下载。`bundle` 包含状态、文件 ID、文件名、Sheet 数、完成时间和错误；只有完整发布后可下载。

`supplement` 可以为空，集中补充页通过 requirements 接口取得当前 `{descriptors,issues}`。描述符包含 `id,label,kind,value,required,scope,scopeLabel,options?,targets,help?`；scope 为 `common/product/box/document`，kind 为 `text/select/checkbox/number`。每个 target 精确绑定 `itemId,documentId,expectedVersion,fieldKey`。客户端提交描述符 ID 与值，不自行扩大目标。地址原因与确认复选框独立；人工地址只有在完整、填写真实核对原因并明确勾选后才确认。

缺价商品的统一补充项为“售价（USD/EUR/GBP）”和“手工售价原因”，页面即时预览 20% 申报单价。相同完整商品身份及币种可在多个单据间填写一次；不同币种使用不同描述符及 `@sellingPrice.<币种>.<身份哈希>` / `@sellingPriceReason.<币种>.<身份哈希>` 目标，不串用金额。服务端将两项转换为明确的售价命令，不写入普通 `fields`。旧单据详情的“人工补充售价”同样按票币种显示；409 恢复时如币种变化，保留旧填写并禁止保存，须重新输入或明确核对新币种后采用，不能自动换汇。有效远端恢复时，不适用的人工草稿保留供放弃，不会自动覆盖原价。

| 端点 | 用途 |
|---|---|
| GET `/documents/field-options` | 返回 `{services: string[]}`，从最新导入的丰信渠道参考目录读取无错误、无公式的服务名称并去重；没有目录时返回空数组 |
| GET `/documents/candidates?shippingRunId=UUID` | 指定发货次内有效 M2 完整货件、箱码阻塞、逐箱自动来源和绑定快照的地址/商品候选；不请求领星，不要求 M3 确认 |
| POST `/documents/automations` | 一次启动整批检查及单工作簿生成；`operationId,shippingRunId`，可选 `demandIds,fields,title`；继续已有草稿时改传成对的 `documentId,expectedVersion`，不能同时传 demandIds；返回 `{job,replayed}` |
| GET `/documents/automations` | 当前用户最近自动任务，可选 shippingRunId 筛选，返回 `{items}` |
| GET `/documents/automations/:id` | 读取同一持久化任务的批次和逐票进度，返回 `{job}` |
| GET `/documents/automations/:id/requirements` | 读取当前统一缺项及其具体单据版本，返回 `{job}`，描述符位于 job.supplement |
| POST `/documents/automations/:id/supplement` | `operationId,expectedVersion,documentVersions,values`；documentVersions 为单据 ID→版本，values 为 `{id,value}` 数组；原子保存并安排整批复检，返回 `{job,replayed}` |
| POST `/documents/automations/:id/retry` | `operationId,expectedVersion` 及可选 `itemIds`；重新安排检查，仍须全部范围通过才生成；返回 `{job,replayed}` |
| POST `/documents/automations/:id/delete` | `operationId,expectedVersion,reason`；取消并软删除当前账号的指定任务，不依赖队列可用；返回 `{automationId,version,deleted,deletedAt,cancelledDocumentIds,preservedDocumentIds,replayed}` |
| GET `/documents/automations/:id/download` | 授权下载完整发布的一份归档合并 XLSX，核验不可变发布映射及哈希；来源失效不改变原字节，不同表头按 Sheet 保留 |
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
| GET/POST `/document-profiles` | 返回完整 `{items}`（支持 category=address，含已删除地址），或建立资料版本；地址编辑可带 profileId、expectedVersion，并修改 key 而保留同一 ID |
| GET `/document-profiles/:id` | 读取单份资料，返回 `{profile}`，含已删除地址 |
| POST `/document-profiles/:id/retire` | 地址软删除、增加版本并返回 `{profile}`；其他类别保留原停用语义，返回 `{profileId}` |
| POST `/document-profiles/:id/restore` | 仅地址可恢复；携带 operationId、expectedVersion、reason，增加版本并返回 `{profile}` |
| GET `/document-profiles/:id/history` | 资料不可变版本、修改原因和操作人 |
| GET `/document-profiles/import-template.xlsx` | 下载资料批量导入模板 |
| POST `/document-profiles/import` | multipart 预检或提交，见下文 |
| GET/POST `/document-templates` | 模板列表或上传经过清理的丰信布局 XLSX；上传携带 file、operationId、purpose=invoice、name、reason；更新已有模板必须携带 expectedVersion，新建不传 |
| GET `/document-templates/:id/download?version=N` | 按版本下载受控模板 |
| GET `/document-templates/:id/history`、POST `/:id/retire` | 模板版本历史或按预期版本停用 |

自动任务删除使用与后台 worker 相同的排他锁；正在处理时返回 `DOCUMENT_AUTOMATION_BUSY`（409），任务版本变化返回 `VERSION_CONFLICT`（409），不能在后台步骤中途取消并释放占用。已请求的独立单票导出仍在排队或运行时返回 DOCUMENT_EXPORT_BUSY（409），须等待其结束，避免删除后仍产生新文件。成功后保存删除时间、操作人、原因和审计记录，清除待续跑意图，最近任务列表隐藏该任务；原任务读取、缺项、补充、续跑及整批下载均返回 404，延迟队列与恢复扫描也不再运行该任务。相同操作号和原请求重放返回原结果，不重复取消或增加版本。

删除只取消能以本任务确定建票操作的已提交幂等结果证明归属、仍为相同货件范围及检查点版本、没有任何导出记录且未被其他任务引用的草稿，并仅释放这些草稿的货件占用。建票成功但响应丢失的草稿也按该证明检查。接入的既有草稿、归属不明、后续版本已变化、有导出记录或被其他任务使用的单据保留，分别返回 cancelledDocumentIds / preservedDocumentIds 供核对。已有文件、单据历史、来源归档和冻结事实不删除；历史单据从原已发布导出入口授权读取归档字节，允许来源已失效，不通过已删除任务下载，也不据此认定文件当前有效。

GET `/documents` 接受 `page`（默认 1）、`pageSize`（默认 20，最多 100）、`q`、`weekStartDate` 和 `status`。关键词去除首尾空格，最多 200 字，忽略英文大小写，按字面匹配单据名称、单据 ID、订单号及成员 FBA／店铺；`%`、`_` 不作为通配符。来源周按 `YYYY-MM-DD` 精确匹配。状态默认 `active`，排除已取消及被替代单据；`all` 查询全部，或使用 draft、pending_review、approved、returned、stale、cancelled、superseded。状态按当前有效性判断，筛选先于分页，返回 `items,total,page,pageSize` 及规范化条件。取消后的原 ID 仍可读取详情、文件及历史；相同操作号重放不重复取消或增加版本。

资料导入预检 multipart 参数为 `phase=preview,operationId,file`，返回 previewId、文件 SHA-256、逐行 errors/changes、valid。提交参数为 `phase=commit,operationId,previewId,sha256,reason`；服务端重读原件、复核全部版本，任一错误整批回滚。同请求重放不重复增加版本。

资料类别为 product、party、address、channel、tax。档案引用用于复用和追溯，不强制每票分别引用商品、主体、渠道及税务档案；完整有效的单票字段和商品调整也可生成。已引用的资料仍须通过服务端版本与适用范围核验，停用或失效不能用手工字段绕过。商品身份必须完整匹配 sid/MSKU/FNSKU/SKU；unitPriceConfirmed 表示有效申报单价与币种组合已经人工确认。产品图片可采用公共资料，也可在本票商品申报中上传 PNG/JPEG 或显式读取图片 URL，保存修订后作为图片内容快照，不在重新打开页面或生成文件时抓取远程图片。

缺图以 `PRODUCT_IMAGE_MISSING` 提醒，旧快照中的无效图片以 `PRODUCT_IMAGE_INVALID` 提醒，允许生成待复核文件。图片列保留，无图或无效图的单元格留空；有图商品按实际明细行嵌图，不改变箱数、数量或行序。同一完整商品跨 FBA 的图片提醒仅报告一次，复核时保留具体商品提示。补图仅修改当前单据，替换、清空或恢复引用图片不改变公共资料及历史文件，也不撤回未变化的价格确认。

本票图片覆盖字段沿用 `product.<完整商品身份SHA256>.imageBase64` 与 `imageExtension`。单图最多 2 MiB，本票图片覆盖合计最多 8 MiB；只有规范图片字段可超过普通字段的 4000 字限制。图片 URL 只在显式预览时由服务端读取，必须为公开 HTTPS 图片直链，不跟随重定向；核对 DNS 地址并固定连接目标，校验大小、超时及图片内容。预览返回 `{image:{imageBase64,imageExtension}}`，不写入业务数据库，失败保留原图。创建、修订、更正请求的 JSON 上限为 12 MiB；图片须点击保存资料修订后才持久化，已有文件的单据仍须通过更正补图。

表单的报关方式、清关方式、交税方式、所在货站、币种及五项特殊属性选项由共享契约 `DOCUMENT_FIELD_OPTIONS` 定义，生成前校验及 XLSX 下拉使用同一组选项。服务目录仅供人工选择参考，不自动建立业务渠道与丰信服务的映射，也不设置税务或配送日期；显式引用的渠道资料若维护了非空 allowedServices/service，则本票服务仍须在该范围内。备注和预约配送时间可留空，填写后按原值导出。

本票币种按成员货件目的国家确定：美国为 USD，英国为 GBP，德国、法国、西班牙、意大利为 EUR。已支持国家的界面币种只读；创建及每次新修订均由服务端归一化。旧可编辑草稿的错误币种在前端显示为待保存修改，不自动提交修订；未知国家保留已有人工币种并允许选择。币种推导可识别德法西意同为 EUR，原有按店铺、渠道、目的仓及国家等分票规则继续生效。不同币种混票生成时以 `DOCUMENT_TICKET_CURRENCY_CONFLICT` 阻塞，须拆票，不自动换汇。

客户订单号 `orderNumber`、表头参考号 `reference`、贸易条款 `tradeTerms` 不再提供输入。创建、新修订及当前规则导出统一留空，即使旧草稿中仍有值也不输出；既有修订快照与已发布文件保留。逐箱 `PO / Reference ID` 仍按箱规规则填写和导出，与已移除的表头参考号独立。

丰信当前输出没有逐商品“申报单位”列，因此 unit 不作为生成必填项。商品币种空白时，通过共享 `documentProductCurrency` 仅回退本票已选的有效 USD、EUR 或 GBP；显式填写的其他币种不被覆盖，与本票币种不同仍阻塞。整票币种缺失或无效只在表头提示，不为每个依赖继承币种的商品重复报告币种缺项。单价须为可安全写入 XLSX、最多两位小数的有效正数，并须人工确认价格与有效币种组合。缺少单价或有效币种时先报告缺项，不重复附加“尚未确认”。同一完整商品身份跨 FBA 仅报告一次申报缺项（缺字段合并为一条 DECLARATION_REQUIRED）、价格、图片和销售链接问题；每个 FBA 的来源、箱数据及数量守恒仍独立校验。

保存修订、更正或采用领星资料时，服务端会比较前后有效单价/币种，组合变化将撤回原确认；仅改变本票币种时，显式商品币种不变的确认保留，其币种冲突仍须处理。若在同一修订重新确认，fields 须同时显式提交该完整商品身份的 unitPrice、有效 currency 和 unitPriceConfirmed=true，并与新有效组合一致；领星采用沿用 confirmPrices 的明确确认操作。比较、币种回退和导出投影不会改写历史修订、公共资料或已发布文件。

带电、带磁、液体、粉末、危险品五项空白属性在创建、保存修订及生成时统一默认“否”，保留已有明确选择的“是”或“否”。旧草稿生成时采用同样的默认值，不修改既有修订快照或已发布文件。

明细 A 列“货箱编号”按每个 FBA 独立生成：同一完整 FBA 的实物箱满足现有压缩规则且有 N 箱时输出 `FBA号U000001-N`，只有一箱输出 `FBA号U000001`；不满足压缩规则时逐箱输出 `FBA号U` 加该箱实际六位箱序，不追加自范围后缀。不同 FBA 不合并编号或箱数。B1“客户订单号”留空，不从明细箱码拼接。

单据绑定稳定货件、M2 确认、商品修订和内部箱；新票保存 `boxSource` 自动逐箱快照，保留领星原始值和单位。旧快照中已有的 M3 确认/指纹保持原样，不作为新候选或新文件的必要条件；仅取消 M3 门槛不会使旧票失效。引用的资料内容均回查服务器版本，不信任客户端传入的版本正文。公共资料新增版本不会静默替换历史快照，具体采用需要新修订或更正。

逐箱人工覆盖通过 `fields["box.<内部箱UUID>.<字段>"]` 提交，字段为 `po/weight/length/width/height`。重量按 KG、尺寸按 CM 解释，直接输入覆盖值；提交 `null` 或移除该字段恢复自动来源，显式空串表示缺值并在生成时阻塞。仅允许当前完整箱清单内的覆盖，服务端拒绝未知箱 ID。显式采用更新来源时保留稳定箱 ID 的覆盖，去除已移出本票箱的覆盖。

自动来源优先采用本票 `boxSource`，旧票回退其既有 M3 快照，再回退绑定的 M2 逐箱数据；生成及下游投影使用同一套最终值。KG/LB、CM/IN 十进制换算后 `ROUND_HALF_UP` 到两位，原始值不覆盖。草稿可缺项，生成时 PO 及正数毛重/长宽高须完整且可安全写入 XLSX；来源未知单位或缺值可通过本票有效覆盖补齐。修改箱规不会回写领星或 M2；已有文件使用更正生成新版本。详见[箱规规则](../business/invoice-box-data.md)。

单票地址仅以 `fields` 为最终导出值。新票或空白地址按成员 FBA 的来源地址代码和国家唯一匹配有效、完整的地址簿版本：来源 `addressCode` / `address_code` 优先，缺省时兼容目的仓；地址簿 `data.addressCode` 精确匹配优先于目的仓兼容匹配。成员来源代码或国家不一致、无匹配、多匹配或资料不完整时不自动选择。地址代码可以不同于目的仓，不能用同仓的另一地址覆盖代码精确匹配。

自动匹配整份采用十二项字段并记录地址版本引用。直接打开旧单据详情时，旧空白可编辑草稿只在浏览器中补全为待保存修改，不自动 POST，也不代替人工确认；地址簿读取失败保留现状并允许重试。默认自动任务按上文授权范围确认唯一无冲突版本。已有实质地址、人工模式、已确认或已引用的版本，以及用户本次已编辑的地址，不被异步目录刷新覆盖。成员 FBA、国家或来源地址代码变化而本次没有手改地址时，服务端重新尝试匹配；无匹配则保留旧可读地址、移除旧引用并撤回确认。

共享 `applyDocumentAddress` 整份替换十二项地址字段，未提供的可选字段清空，写入 `addressAdoptionVersion=explicit/v1` 并撤回旧确认和原因。修改地址或更换引用时，服务端同样撤回旧确认；若在同一修订显式重新确认，须提交 `confirmAddress=true`、最终 `fields`、`addressConfirmed=true` 和非空 `addressConfirmationReason`。手工/原始来源地址可不引用地址簿，但须完整并确认原因；本票地址与引用版本不一致也须确认原因。人工采用新的档案地址即使与档案完全一致仍须确认。完整地址包括收件人、地址第一行、城市、邮编和两个英文字母的国家代码。

地址簿新增/编辑另需有效 `destinationFc`（英文字母、数字、下划线或短横线，可用斜线分隔复合仓代码，最多 40 字），国家和目的仓统一转大写。编辑携带 `profileId` 与 `expectedVersion`；同分类标识必须唯一。已删除地址不能编辑或新采用，需先恢复。软删除和恢复都建立不可变版本，数据中的 `_addressBook` 保存该版本标识、状态及前一标识；已有地址版本和单票快照保留。已保存单据可继续追溯其已删除地址引用，不因地址簿删除/更名/更新改变既有文件或地址；其他类别停用仍使引用失效。

领星资料查询及所需 API 权限见[领星单据资料查询与权限](../integrations/lingxing-document-profiles.md)。查询结果先预览再采用；v1 人工价格默认未确认，v2 按已归档来源计算。既有非空字段和资料不会被静默覆盖。

`node scripts/m4/document-defaults-browser.mjs` 使用本地内存接口验证空白表头、六国自动币种、未知国家人工回退、混币种阻塞、地址代码匹配、迟到及失败查询、历史只读快照和窄屏布局。`node scripts/m4/document-automation-browser.mjs` 验证一次整批启动、统一缺项屏障、公共/商品/箱精确目标、部分保存、保存及进度读取失败保留填写、版本冲突、全批就绪后唯一下载、关闭恢复及窄屏界面。`node scripts/m4/document-manual-price-browser.mjs` 另用真实纯描述符、计划及十进制 helper 验证缺价补充、币种范围、精确 20% 预览、售价依据、服务端审计字段、503/409 恢复和旧链接命令保存。三个脚本均不调用真实业务 API 或外部地址，写入只更新各自进程内存；实际多 Sheet XLSX 内容另由服务端测试核对。
