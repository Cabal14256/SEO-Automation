# 发货全流程自动化系统

M5–M8 已增加本地单据与分配核对、物流交接、报关／9810、费用分摊及归档；领星保持只读。入口、运行限制和待补真实资料见 [交付说明](./docs/m5-m8-implementation.md)。

TypeScript 单仓项目，包含 React 工作台、Hono API、独立 Worker 和 PostgreSQL。支持店铺双来源、需求上传与草稿、差异确认、周批次人工分组、领星只读同步、M2 制表和 M4 丰信 B2B 单票 XLSX。发票直接采用领星逐箱数据，并允许在本票修改 PO、毛重和长宽高，不再要求实物箱确认。

本仓库中的店铺名称、编号、货件和商品示例均使用虚构数据。真实业务文件、接口响应、数据库备份、截图及历史验收资料保留在受控本地目录，不随公开仓库发布。示例和自动化测试不能代替真实业务签收。

```text
apps/web/              React + Vite 工作台
apps/server/           Hono API、独立 Worker、Drizzle 迁移
packages/contracts/    浏览器与服务端共用的字段校验
docs/                  业务规则、数据模型、接口、验收场景和运行说明
```

开发需要 Node.js >=24.22.1 <25、Corepack 和 PostgreSQL 18。版本文件固定为 `24.22.1`；这是 2026-10-21 安全更新，修复 Brotli、TLS、DNS 等漏洞，详见 [Node.js 官方公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)。升级运行时后须重启 API 和 Worker；历史发布包自带的 `runtime/node.exe` 也须通过新发布包更新。

1. 运行 `corepack pnpm install --frozen-lockfile`。
2. 复制 `apps/server/.env.example` 为 `apps/server/.env`，配置数据库连接、认证密钥和受控私有数据目录。不要提交凭据或业务文件。
3. 运行 `corepack pnpm db:migrate`，按[运行说明](./docs/operations.md)创建首个管理员账号。
4. 运行 `corepack pnpm dev` 启动 API 和 Web；另开终端运行 `corepack pnpm dev:worker`。浏览器访问 Vite 输出的本机地址。

无需数据库时，可运行 `node scripts/lingxing/probe.mjs --demo` 查看模拟取数报告；真实账号接入见[脚本说明](./docs/integrations/lingxing-probe.md)。

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

需求导入支持“飞书表格”和“需求导入”两种结构，业务日期固定为首次接收时的上海日期；重复导入不重复建立需求，变更需要显式确认。未完成内容可保存至账号隔离的草稿箱。批次、商品与逐箱表、导出记录通过发货工作区管理；导出或打印后冻结，更正建立新版本。整个流程仅查询领星业务数据。

发货管理提供发货工作台和发票与单据入口。M2 四步向导完成数量核对、箱序和箱码；发票草稿可先保存，生成需有效 M2、箱码、完整有效的最终箱数据及申报资料。取数、人工修改、历史兼容和下游文件说明见[发票箱规](./docs/business/invoice-box-data.md)。单据资料和模板版本在设置中维护，文件复核、取消、更正及历史按[操作说明](./docs/operations.md)执行。

本机源码、开发及试用资料统一收纳在 `SCM-Automation` 下。源码保留在根目录；`.local/development` 保存开发数据库和文件，`.local/trial` 保存独立试用环境，`.local/archive` 保存旧历史及演练副本。整个 `.local` 和真实配置均被 Git 忽略。

公开到 GitHub 前，在源码根目录执行：

```powershell
corepack pnpm privacy:install-hook
corepack pnpm privacy:check
corepack pnpm privacy:history
```

整理后的根仓库使用新的干净历史，日常开发与 GitHub 发布共用这一个仓库。原 Git 历史、旧公开快照及原始资料仅作为被忽略的本机归档保存，不将旧提交、分支或标签合并回来。仅添加 `.gitignore` 不会清除已有历史中的敏感文件；尚未整理过的副本须先完成旧历史归档和干净历史迁移。`privacy:export` 仅保留为可选的项目外快照工具，不是日常发布步骤。默认检查不证明未知业务数据已被全部识别，新增样例应始终使用独立编造的数据。上传步骤见 [GitHub 发布](./docs/github-publishing.md)。

完整说明见[文档索引](./docs/README.md)、[实现状态](./docs/implementation-status.md)和[隐私发布说明](./docs/privacy.md)。生产环境由 API 提供 `apps/web/dist`，API 与 Worker 为独立进程；部署和恢复按[运行说明](./docs/operations.md)在目标设备验收。
