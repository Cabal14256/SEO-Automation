# 月内发货次验收（2026-10-24）

发货月份取上海编号日期所在月份，月内第 N 次在最终提交事务中领取。人工和自动整理共用次数，每次独立分配箱码；需求首次导入日期不限制安排。整次文件发布后冻结安排，更正保留原次数、票号和旧文件。

## 验证入口

- `corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm build`。
- `corepack pnpm --filter @scm/server exec vitest run --maxWorkers=4`：985 项通过；数据库专项默认跳过，另行执行下项。限制 worker 数避免并行生成大型单据耗尽本机资源。
- `corepack pnpm monthly:db`：完整迁移、重复有效归组的停止与回滚、27 项 PostgreSQL 集成用例。创建随机隔离模板和测试 schema，结束后清理，不迁移业务 schema。
- `corepack pnpm monthly:browser`：人工创建／追加、未知结果与刷新重放、旧草稿原请求恢复、冻结更正、月次筛选、跨导入月份和待安排池，桌面与手机尺寸。

数据库专项使用 `apps/server/.env` 或显式的 `DATABASE_URL`，需有创建测试 schema 的权限，不要求创建数据库。外部资料补全和同步均使用离线测试实现。

## 历史与上线

新增迁移为 `0019_magical_stardust.sql`。迁移首先检查一个需求是否有多个有效内部组；冲突时报告需求和组 ID 并停止，不自动选择归属。原组、确认、箱码与导出投影不重新编号；已有整次发布记录回填成员冻结时间。

本次验收未向现有业务库应用迁移。应用部署时运行 `corepack pnpm db:migrate`，并同时更新 API、Worker 和 Web。历史未关联组显示“历史批次／未关联发货次”，未冻结历史组可显式关联；冻结组通过更正处理。

浏览器截图和结果位于 `.local/t40/monthly-shipping/`、`.local/t40/monthly-workspace/`；数据库检查结果位于 `.local/t40/monthly-db/result.json`。所有验收输入均为独立编造的数据。
