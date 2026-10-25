# 本机试用发布、备份与隔离恢复

要求 Windows、Node.js 24、已安装生产依赖、已构建应用、PostgreSQL 18 工具和系统 `tar.exe`。所有命令不调用领星。服务安装由 `scripts/deployment/` 管理；业务签收不由工具代替。

## 发布包

```powershell
corepack pnpm build
node scripts/trial/cli.mjs package --repo D:/SCM-Automation --target D:/SCM-Automation/.local/trial/releases/<new-release>
```

目标必须不存在。发布复制当前磁盘中的应用源码（包含 dirty/untracked）、构建、迁移、文档规则、锁文件、Node 24 以及已安装的生产依赖闭包。生产依赖被物化为真实目录，不依赖开发目录的 junction、pnpm 或网络。排除 `.git`、`.local`、私密业务原件、`.env`、密钥和运行数据。`release-manifest.json` 保存每个文件 SHA-256、依赖版本、规则/迁移摘要及工作区状态。发布前须完成构建和检查；发布工具不自动修改源码。

## 运行配置

受控 `runtime.json` 使用部署工具产生的配置：`trialRoot`、`releasePath`、`dataDir`、`envPath`、`postgresBin`、`postgresDataDir`、`postgresPort`、`database`、`runtimeDir`、`backupDir`、`keyPath`、`services.api`、`services.worker`。可选 `configDir`、`caddyDataDir` 分别默认为试用目录的 `config`、`caddy-data`。数据库 URL 只从 `envPath` 读取，且必须为配置对应的本机数据库。凭据仅通过子进程环境传给 PostgreSQL；命令不会回显连接串或密钥。

备份密钥必须位于 `trialRoot` 之外，并以受控 ACL 单独保管。首次初始化后复制到独立安全位置；丢失密钥无法恢复备份。

```powershell
node scripts/trial/cli.mjs key-init --key D:/SCM-Automation/.local/development/recovery/trial-backup.key
node scripts/trial/cli.mjs verify --config D:/SCM-Automation/.local/trial/runtime.json
node scripts/trial/cli.mjs backup --config D:/SCM-Automation/.local/trial/runtime.json
```

备份领取互斥锁，记录原运行服务，停止 HTTPS（若配置）、API、Worker；核对所有索引文件及历史 XLSX，记录逐表数据摘要，执行 `pg_dump -Fc`，复制完整 DATA_DIR、当前 release、config 和 CA 状态；复制后重新核对暂存数据的索引字节、SHA-256、历史 XLSX，以及复制前固定的 release manifest 和全部发布文件，在 `finally` 恢复原先运行的服务。AES-256-GCM 加密后回读认证成功才发布 `.scmbak` 及不含凭据的收据。只删除完成时间超过 30 天且有收据的备份。任务计划每日调用同一命令；重叠调用失败，不生成第二份不一致备份。中断留下锁时应先确认没有备份进程，再人工移除锁。

## 隔离恢复

```powershell
node scripts/trial/cli.mjs restore --config D:/SCM-Automation/.local/trial/runtime.json --backup D:/SCM-Automation/.local/trial/backups/<id>.scmbak --target D:/SCM-Automation/.local/archive/restore-<new-id> --port 55434 --database scm_restore_<new_id>
```

新目录必须不存在且不得与试用目录、密钥目录重叠；数据库名称和端口必须不同，禁止开发库 `55432/scm_automation_dev`。先验证 GCM 认证、归档路径及全部文件哈希，再初始化新的仅监听 `127.0.0.1` 的 PostgreSQL cluster，创建独立普通 `scm_app`、恢复新库。

恢复配置强制 `LINGXING_REQUESTS_ENABLED=false`，清空领星凭据/环境文件，默认 API、Worker 均不启动；验证完成后 PostgreSQL 也停止。核验所有业务表（含审计、确认及导出版本）摘要、每个文件索引的 SHA-256/字节数，并用 ExcelJS 打开每个历史成品 XLSX。`restore-report.json` 记录恢复点年龄、实际耗时、核验数量及尚待执行的队列恢复/签收/独立介质检查。恢复过程中失败的目录保留供诊断，重试应使用另一个新目录。

恢复副本的 `runtime/recovery-admin.env` 仅用于隔离 cluster 管理。开始人工任务恢复演练前，须显式选择独立 API 端口、保持外联开关关闭并确认当前指向恢复副本。不要把恢复副本中的配置覆盖试用配置。恢复报告中的 RTO 只覆盖本次本机隔离恢复，不能替代设备重启、独立介质和真实业务数据恢复验收。

## 工具验证

```powershell
node --test scripts/trial/core.test.mjs
```

覆盖密文破坏/截断/错误密钥、缺失或改变文件、复制期 release/索引变化、目录与路径冲突、真实 tar 回读、密钥不覆盖、30 天保留策略，以及依赖版本冲突、peer 上下文和开发依赖排除。真实服务故障、独立数据库恢复和历史 XLSX 核验另行记录验收证据。
