# SCM Automation · 发货流程自动化工作台

面向特定内部跨境发货流程的 TypeScript 项目，将需求导入、货件整理、箱数据核对、单据生成和后续履约记录串联到同一个工作台，保留来源、修订、文件版本与操作记录。

> [!WARNING]
> **内部项目声明**
>
> 本项目围绕特定内部业务规则、账号权限、第三方接口及运行环境开发，公开源码仅供内部研究、维护和技术参考。项目中的字段映射、页面与自动化脚本选择器、账号配置、单据模板和业务判断均具有明显的环境依赖性，不保证适用于其他组织、账号或业务场景。
>
> **不建议直接复制、照搬或用于生产环境。** 如需参考实现，请先独立完成安全审查、合规评估、测试验证和环境适配，取得必要的数据与接口授权，并自行承担使用风险。示例、测试通过和历史技术记录均不代表真实业务验收或生产就绪。

[文档导航](docs/README.md) · [当前实现与限制](docs/development/implementation-status.md) · [运行维护](docs/operations/runbook.md) · [隐私与发布](docs/publishing/privacy.md)

## 项目范围

| 环节 | 当前能力 |
| --- | --- |
| 需求接收 | XLSX 与在线表格导入、店铺匹配、差异预览、显式提交、账号隔离的草稿 |
| 发货整理 | 按月管理发货次与票号，支持自动整理、人工分组及完整 FBA 货件关联 |
| 数据与制表 | 领星只读查询、商品与逐箱核对、箱序与箱码、发货表 XLSX 导出 |
| 发票与单据 | 版本化资料和模板、后台出单任务、集中补齐、单票及整批合并 XLSX、文件复核与更正 |
| 后续流程 | 本地单据与分配核对、物流交接、报关与 9810 记录、费用分摊及批次归档 |
| 维护与追溯 | 管理员认证、独立 Worker、操作审计、不可变文件、数据库迁移及备份恢复工具 |

领星业务数据保持**只读**。外部建单、库存分配、发货确认及费用回填等动作由业务人员在相应系统执行，本项目登记结果与核对凭据。当前发票直接采用领星／M2 逐箱快照，允许本票修订箱规；旧 M3 实物箱确认仅保留历史兼容。具体规则见[业务规则](docs/business/rules.md)与[发票箱规](docs/business/invoice-box-data.md)。

第三方账号权限、渠道与国家覆盖、接收系统实际导入、真实批次签收及目标设备部署仍需逐项验证。M5–M8 的交付范围和待补资料见[实施说明](docs/development/m5-m8-implementation.md)。

## 技术与结构

项目采用 pnpm workspace：React + Vite 提供工作台，Hono 提供 API，独立 Worker 执行后台任务；PostgreSQL 保存业务记录和任务状态，Drizzle 管理数据模型与迁移，共享契约使用 Zod 校验。

```text
apps/web/              React 工作台
apps/server/           Hono API、Worker、数据库迁移
packages/contracts/    前后端共享契约与字段校验
scripts/               开发、验收、部署、隐私检查工具
docs/                  分类文档与历史计划
```

API 与 Worker 分别启动，业务文件保存在私有 `DATA_DIR`，数据库保存文件索引及哈希。构建部署时 API 可提供 `apps/web/dist`。数据关系见[数据模型](docs/architecture/data-model.md)。

## 本地研究与开发

以下命令从仓库根目录执行。项目当前要求 Node.js `>=24.22.1 <25`、Corepack、pnpm `12.11.2` 和 PostgreSQL 18；运行时版本以 [package.json](package.json)、[.node-version](.node-version) 和锁文件为准。配套环境管理与部署脚本主要面向 Windows / PowerShell。

### 离线示例

无需数据库或真实账号，可先查看使用虚构数据的取数报告：

```powershell
node scripts/lingxing/probe.mjs --demo --out .local/demo/lingxing-probe
```

这只演示数据结构和核对方式，不启动完整工作台，也不验证真实接口权限。完整说明见[领星探测脚本](docs/integrations/lingxing-probe.md)。

### 启动工作台

1. 安装依赖：

   ```powershell
   corepack pnpm install --frozen-lockfile
   ```

2. 复制 `apps/server/.env.example` 为 `apps/server/.env`，配置独立的开发数据库、随机认证密钥和私有文件目录。调整示例中的机器路径；离线研究时设置 `LINGXING_REQUESTS_ENABLED=false`。真实凭据仅保存在受控本地配置中。

3. 确认数据库可访问后执行迁移：

   ```powershell
   corepack pnpm db:migrate
   ```

4. 按[首次启动说明](docs/operations/runbook.md#依赖与首次启动)创建管理员，密码通过交互输入。系统关闭公开注册，仅支持管理员账户。

5. 分别在两个终端启动 API／Web 和 Worker：

   ```powershell
   corepack pnpm dev
   ```

   ```powershell
   corepack pnpm dev:worker
   ```

浏览器访问 Vite 输出的本机地址，默认 `http://localhost:5173`；默认 API 地址为 `http://localhost:3001`。Windows 独立集群初始化、进程管理及故障恢复另见[运行维护](docs/operations/runbook.md)，应在阅读后选择适合本机的配置方式。

### 常用检查

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm privacy:test
corepack pnpm privacy:check
corepack pnpm privacy:history
```

集成、浏览器和部署验收分别需要对应的隔离环境，入口见[验收文档](docs/README.md#验收与验证)。技术验证不能替代业务人员对真实数据和文件的复核。

## 文档入口

| 阅读目的 | 入口 |
| --- | --- |
| 查找全部文档、区分现行规则与历史方案 | [文档导航](docs/README.md) |
| 了解实现范围和待验事项 | [当前实现状态](docs/development/implementation-status.md) |
| 理解业务字段、数量口径及制单规则 | [业务规则](docs/business/rules.md)、[字段映射](docs/business/field-mapping.md) |
| 阅读接口与数据设计 | [API 导航](docs/README.md#接口契约)、[数据模型](docs/architecture/data-model.md) |
| 配置、运行、部署和恢复 | [运行维护](docs/operations/runbook.md)、[试用部署](docs/deployment/trial.md) |
| 准备 GitHub 展示与上传 | [隐私说明](docs/publishing/privacy.md)、[发布步骤](docs/publishing/github-publishing.md) |

## 私有资料与 Git 边界

**`docs/private/` 是仅供本地使用的业务示例目录，整个目录（包括其中的 README）均不纳入 Git，也不随源码或发布包上传。** 目录可能包含原始业务示例，不能因文件名带有“示例”就视为可公开素材。公开文档不依赖该目录即可阅读。

原始研究、验收证据、业务模板、真实配置、数据库、备份及截图也应保存在受控且被忽略的位置；公开测试与文档示例应独立编造。`.local/` 用于本地开发、试用和归档数据，不属于源码。

首次克隆后可安装本地推送检查：

```powershell
corepack pnpm privacy:install-hook
```

发布前检查当前文件、暂存区与 Git 历史，按[GitHub 发布步骤](docs/publishing/github-publishing.md)操作。`.gitignore` 不会移除已经跟踪的文件或清除旧提交；检查器也不能识别所有未知业务资料，仍需人工复核。
