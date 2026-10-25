# M3 实物箱核对 API

> 历史兼容接口。2026-10-23 起，工作区移除实物箱确认入口，新发票直接采用领星/M2 逐箱数据并在本票修改 PO、毛重和长宽高，不再要求 M3 确认。本文保留旧记录、接口及文件的技术规则，不能作为当前发票前置条件。当前规则见[发票箱规](../business/invoice-box-data.md)。

2026-10-19 新增 `GET /api/v1/physical-reviews`，按 weekFrom/weekTo、sid、country、channel、status、q、page/pageSize 查询独立核对工作区。状态为 pending/blocked/confirmed/stale，默认每页 20 项，可选 50 项；返回任务行、整组核对进度和筛选选项。逐组 API、确认和导出规则继续有效；入口改为 `/shipping?view=physical&groupId=...`，原批次详情 physical 标签仍可访问。

2026-10-20 工作区每行新增 `physical.exportReference`，类型为 `{groupId,m2ConfirmationId,physicalConfirmationId,m3Version,sourceFingerprint} | null`。仅当实物确认有效、允许导出且存在整组确认时返回引用；旧响应缺少该字段时按 null 解析。列表直接使用这些轻量引用进行表格勾选与跨页选择，无需逐组轮询完整核对快照；导出提交与文件发布仍重新校验全部引用。

更新：2026-10-18（`Asia/Shanghai`）。契约来源为 `packages/contracts/src/physical.ts`，规则版本 `physical-review/v1`。M3 独立于 M2 制表确认；[技术验收已通过（私有记录说明）](../acceptance/evidence/README.md)，真实批次逐箱核对及明确人工签收仍为 pending。

所有接口仅供有效管理员使用，API、事务与 Worker 发布时重新检查身份；POST 检查同源。领星全程只读，打开页面、读取历史或下载模板不请求领星。下载沿用 `/api/v1/files/:id/download` 的授权和哈希检查。

## 核对与来源

前缀为 `/api/v1/sub-batches/:id/physical-review`：

| 方法与路径 | 请求与结果 |
| --- | --- |
| `GET /` | 当前 M2 确认 ID、M3 版本、采用来源、可用来源、草稿、确认、阻塞项、采集任务及 `valid/canConfirm/canExport/readOnly/pendingChange`。历史批次默认未确认。 |
| `GET /history` | 追加保存的来源、核对修订和整组确认历史。 |
| `POST /sources` | 基础写入字段加 `sourceId`；明确采用当前 M2 的最新来源。身份不匹配不可采用；等值来源保留进度，实质变化创建全组 pending 草稿。 |
| `POST /revisions` | 基础写入字段加完整 `entries` 箱清单；返回操作号、是否重放和当前版本。 |
| `POST /confirmations` | 基础写入字段；全部箱核对且没有阻塞项时创建独立整组确认。 |
| `POST /sync` | 基础写入字段加 `startDate/endDate/requestBudget/maxPages`；202 返回 `run/items`。结束日期不含当日，默认预算 100、最多 1000 次，默认最多 10 页。 |
| `GET /sync/:runId` | 返回该组的任务及逐票状态、成功快照和错误。 |
| `POST /sync/:runId/retry` | `{operationId, additionalRequestBudget}`；仅显式恢复失败范围，成功检查点及原观察时间保留，预算不自动增加。 |

基础写入字段为 `{operationId, m2ConfirmationId, expectedVersion, sourceFingerprint}`；未采用来源时指纹为 null。版本或来源冲突返回 409，业务阻塞或无效输入返回 422。相同操作者、操作号和相同请求重放原结果，操作号用于不同请求返回 409；响应丢失时保留原 payload 和操作号重试。

来源保存原值、原单位、KG/CM 两位采用值、逐箱商品与数量及原始快照引用；PO 取该 FBA 的列表 `reference_id`／详情 `amazonReferenceId`，至少一个非空且两个非空时必须一致。服务端固定采用值，客户端不可覆盖。来源以货件修订 ID＋内部箱 ID 关联 M2；强标识须唯一匹配，已人工映射的弱标识仅可用唯一 localBoxId＋箱名＋商品数量组合续接，禁止按返回数组位置匹配。

`entries` 每项为 `{shipmentRevisionId, boxId, status, measured, reason}`，状态为 `pending/consistent/different`，实测字段为可选十进制字符串 `weight/length/width/height`，单位固定 KG/CM。每次保存必须包含完整且无重复的箱清单。草稿允许待核对及尚未补全的差异；已填实测值须为有效正数。“一致”不得携带实测值。最终确认要求所有箱已核对，“有差异”至少一项按两位数比较确有差异并填写原因。

发现来源实质变化后立即阻止新确认和导出，采用后全组重核。等值重采忽略任务号、采集时间和等值原单位，不清除进度。已确认后修改记录，原确认失效，保留新实测草稿并将所有箱重置待核对。M2 未确认、过期、箱码缺失或组被替代时不得写入；已冻结且未被替代组可补做 M3。

## 批量核对模板

`GET /template.xlsx` 固定服务器不可变 manifest 并返回“逐箱核对”“模板元数据”两张表。元数据绑定模板 ID、来源 ID、子批次、M2 确认、M3 版本、来源指纹及规则版本。来源列只读，仅核对结果、实测值和原因可编辑。

`POST /intake` 使用 multipart：`file/phase/operationId/m2ConfirmationId/expectedVersion/sourceFingerprint`，`phase` 为 `preview` 或 `commit`；提交还需 `previewId/sha256` 并重新上传相同文件。预检返回 `{previewId,sha256,entries,boxCount}`，提交保存整组草稿，不自动最终确认。

只接受非空且不超过 10 MiB 的 XLSX；检查实际解压大小、条目、路径、宏、外链、DTD、公式及单元格类型。服务端按模板 ID 读取保存的 manifest，检查全部只读列、元数据、重复／遗漏／新增箱及版本；行可以重排。实测数字读取 OOXML 原数字文本后使用 Decimal 换算／舍入。提交重新检查上传哈希、归档原件哈希、箱清单和当前版本；任一行错误整次拒绝，不覆盖领星原始数据。

## 实物箱明细导出

| 接口 | 用途 |
| --- | --- |
| `POST /api/v1/physical-exports` | `{operationId,references}` 创建任务，202 返回 `{export}`。引用包含 `groupId/m2ConfirmationId/physicalConfirmationId/m3Version/sourceFingerprint`，最多 500 个不同组。 |
| `GET /api/v1/physical-exports?subBatchId=...` | 返回独立实物导出历史 `{items}`，可按组筛选。 |
| `GET /api/v1/physical-exports/:id` | 返回 `{export}`，包含状态、文件、错误、箱数、引用及当前是否仍有效。 |

任务状态为 `queued/running/completed/failed/stale`。排队前和发布前复查 M2/M3 引用，生成中变化则任务失效，不发布过期文件；生成或发布失败不提前冻结。成功发布后沿用整组冻结机制；旧确认和旧文件保留，过期文件仍可授权下载。

文件固定三张表：“实物箱明细”一箱一行，含领星采用值、实测及差异、PO、范围箱号、来源及确认信息；“箱内商品”保留完整商品身份和数量；“版本与核对记录”保存 M2/M3 确认、来源指纹、规则及操作者。重量尺寸采用数字单元格和 `0.00` 格式。原 M2 发货表继续使用原条件，完整示例物流商 B2B 文件属于后续单据模块。
