# 发货取消、回收站与恢复 API

更新：2026-10-28（Asia/Shanghai）。共享契约为 `packages/contracts/src/shipping-lifecycle.ts`。所有路径以 `/api/v1` 开始，仅有效管理员可访问；写入校验可信来源及 JSON，响应禁止缓存。

## 三层记录与状态

| 类型 | 资源路径 | 本地操作范围 |
| --- | --- | --- |
| `run` | `shipping-runs` | 整次发货及其本次成员安排；底层需求保留为当前需求并回到待分组池 |
| `group` | `sub-batches` | 工作台中的一个内部处理批次及其成员安排；不是整个 `weekly_batch` 兼容容器 |
| `demand` | `demands` | 单条 FBA 需求本身及其有效安排 |

`lifecycle=active/cancelled/trashed` 独立于整理阶段、确认和冻结历史。取消为 `cancelled`，可恢复；删除为 `trashed`，进入回收站，可恢复。两者完成后释放有效发货票及内部组占用，旧安排留作追溯。单条需求被取消或删除后不能重新安排；取消／删除父发货次或批次不会把底层需求一并取消／删除。

已发布或冻结的记录允许通过影响核对后本地作废。原确认、编号、文件字节、审计和已发生的外部业务事实保留；本操作不向领星、物流商或申报平台发送取消请求。普通成员、数量编辑仍沿用冻结与更正规则。

## 端点与载荷

下表中的 `{resource}` 仅为上述三个资源之一。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /{resource}/:id/lifecycle-impact?action=cancel\|trash\|restore\|purge` | 返回当前影响范围、版本、冲突、阻塞原因及 `impactToken`，不提交操作 |
| `POST /{resource}/:id/lifecycle/cancel` | 取消并释放本地安排 |
| `POST /{resource}/:id/lifecycle/trash` | 删除并移入回收站；已取消记录也可删除 |
| `POST /{resource}/:id/lifecycle/restore` | 按最近操作快照恢复原生命周期及可恢复安排，重新核对占用 |
| `POST /{resource}/:id/lifecycle/purge` | 仅回收站内且无保护依赖的未发布记录可彻底删除，不能恢复 |
| `GET /shipping-recycle-bin` | 查询已删除记录；可选 `type=run/group/demand`、`q`、`page`、`pageSize` |

所有 POST 严格接受 `{operationId,expectedVersion,impactToken,reason}`：操作号为 UUID，版本为正整数，令牌来自同目标、同动作的最新影响查询，原因去首尾空白后为 1–2000 字。同操作者、同操作号和同内容重放原结果；换内容返回 409。影响范围或版本变化后须重新查询并明确核对，不替换未知结果请求中的原载荷。

影响响应包含 `type,id,name,version,lifecycle,action,impactToken,members,affectedRuns,groups,documents,workflowCount,conflicts,canExecute,blockingReasons`，恢复另含 `willRestoreTo`。提交响应为 `{type,id,version,lifecycle,pending,purged,replayed}`；完成返回 200，已接收但等待后台安全停止返回 202、`pending=true`。`purged=true` 表示实体已物理清理，响应中的 `lifecycle` 仍使用 `trashed`，没有独立的持久化 `purged` 枚举。

回收站分页默认第 1 页、每页 20 条，最多 100 条；关键词最长 200 字。返回 `{items,total,page,pageSize}`，每项含类型、名称、版本、删除人／时间／原因、成员数量、`pending`、`canPurge` 及 `purgeBlockingReasons`。回收站长期保留，不设自动到期清空。

## 安全停止、恢复与下游

后台步骤运行中先保存操作和恢复快照，记录标记为待停止；取得与 worker 相同的互斥锁后完成释放。待处理期间阻止新整理、同步、确认和生成；关闭页面不会撤销已接收操作。API、Worker 重启后继续处理持久化待办，延迟任务不能把取消或删除记录恢复成当前记录。

恢复原安排前检查 FBA 是否已被其他发货票或有效组占用、上级是否可用、原成员是否已独立取消／删除及快照是否仍可恢复。任一冲突阻止整次恢复，不抢占、不部分恢复。父记录恢复只恢复本次操作影响且未被独立操作替换的子记录；删除前原本已取消的记录恢复后仍为已取消。

恢复沿用身份、原月份、月内次数和票号，不回退计数器，也不恢复旧确认、有效箱码或下游有效性。恢复后重新同步、核对确认、生成及复核。来源作废使相关完整单据、整批文件及后续记录失效；历史文件可按原授权入口下载并核验哈希，不作为当前有效业务文件。外部单号、实际交接、申报结果及已确认费用不删除或回写。

## 彻底删除与兼容

永久清理只处理无发布、打印、冻结历史及共享依赖保护的未发布实体。发货次／批次清理保留底层需求；需求清理才删除其身份与修订。有效或历史下游引用、共享历史组、混合导出范围等会阻止清理并返回具体原因。输入原件、共享来源及网络归档不随工作台实体自动删除，已发布文件和审计始终保留。

旧操作结果和相关工作快照清除业务载荷，保留操作号、请求哈希及目标标识等最小记录，旧请求不能借重放重新建立已清理实体。物理删除不回收月内次数或旧票号。

迁移 `0023_shipping_lifecycle.sql` 将过去界面称为“删除需求”的 `demand.cancel` 历史映射为回收站状态；今后不再用“存在一次取消审计”推导当前状态。兼容的 `POST /demands/:id/cancel` 仍遵守旧保护条件并保存为 `trashed`，新界面使用上述统一接口。没有原安排快照的历史删除需求恢复为当前、未分组需求；新操作按保存快照恢复并检查冲突。

验证清单见[生命周期验收](../acceptance/shipping-lifecycle.md)，日常操作见[运行维护](../operations/runbook.md#取消删除与回收站2026-10-28)。
