# M5–M8 工作流 API

路径以 `/api/v1` 开始，仅有效管理员可访问。错误采用 `{error:{code,message,details?}}`；修改检查 Origin，下载核验 SHA-256。

## 记录接口

`fulfillment/logistics/customs/finance/archives` 分别对应五类本地记录。

| 方法与路径 | 行为 |
|---|---|
| `GET /{module}` | `q/status/groupId/page/pageSize` 查询，按实际有效状态筛选后分页 |
| `POST /{module}` | 创建草稿，服务器读取有效已复核 M4 来源 |
| `GET /{module}/:id` | 返回 `record/context/issues/history`，当前状态实时核对 |
| `PUT /{module}/:id` | 保存修订，必须提供 `expectedVersion` |
| `POST /{module}/:id/actions` | 完整业务输入及预期版本，执行明确动作 |
| `POST /{module}/:id/exports` | `operationId/expectedVersion/purpose` 事务入队，发布前再核验 |

写入字段为 `operationId/sourceDocumentId/title/boxIds/data/action/reason`。更新必填 `expectedVersion`；已有来源不能原地替换。同账号同操作号同请求重放原结果，不同请求冲突。草稿可缺业务字段，但身份非法、重复范围、事实删除或覆盖始终阻止。

来源包含 M4 单据、修订、已复核文件及哈希、M2 确认和逐箱快照；旧来源中的 M3 引用保留。逐箱 PO、KG 毛重和 CM 长宽高统一采用本票最终值，包括发票内已保存的人工覆盖。M6 独立登记的毛重/计费重、M7 净重/毛重和外部事实继续独立保留。`context` 包含同周记录、附件、导出历史、来源有效性及失效记录编号；来源失效仍保留外部事实。

## 动作与文件用途

| 模块 | 动作 | 文件用途 |
|---|---|---|
| M5 | `save/confirm/record_result/cancel` | `preparation/reconciliation` |
| M6 | `save/submit/record_receipt/release/handover/record_lingxing/cancel` | 引用M4文件 |
| M7 | `save/preflight/review/return/record-customs/record-9810/complete/cancel` | `customs-package/filing9810-checklist` |
| M8 | `save/confirm/record_result/settle/cancel` | `allocation-checklist` |
| 归档 | `save/check/archive/reopen` | `archive-package` |

复核绑定具体文件与内容指纹，反馈绑定实际提交版本和哈希。费用按外部单号分摊，确认过的行永久保留，通过新增调整行更正。金额以十进制字符串传输，最多六位小数；不隐式换汇或自动消化尾差。

## 来源、附件及导入

- `GET /workflow-sources?weekStartDate=`：有效已复核 M4 候选；已有失效来源仍可追溯。
- `POST /workflow-files`：multipart `recordId/operationId/purpose/file`，先保存草稿再上传。模板使用 `purpose=template`。
- `GET /workflow-files/:id/download`：下载有业务关联的原件。
- `GET /workflow-exports/:id`：返回 `{export}`，含状态、依赖哈希、文件哈希及当前有效性。
- `GET /workflow-exports/:id/download`：下载已发布历史字节，失效文件保留。
- `GET /finance/import-template`：下载标准九列模板。
- `POST /finance/:id/import-preview`：multipart `operationId/file`，返回 `{lines,issues,file}`。保存原件，不自动确认；核对后显式保存。公式、外链和异常压缩包不作为实际金额。

归档范围由服务器展开为完整批次；检查通过仅表示当前可归档。成功发布且依赖有效的 ZIP 显示“已归档”，补账或更正使旧包失效并重新提示待办。
