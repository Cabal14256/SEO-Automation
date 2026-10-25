# T23 本机试用部署与恢复

本机试用默认使用项目根下的 `.local/trial`（例如 `D:/SCM-Automation/.local/trial`）、API `127.0.0.1:3002`、独立 PostgreSQL `127.0.0.1:55433`。HTTPS 地址由部署时的 `-HostName` 确定；文中的 `https://scm.example.invalid` 仅为示例，应替换为本机受控配置中的实际地址。原开发环境 `3001/55432` 与既有 `5432` 服务保持独立。正式验收状态以本轮证据为准；安装服务不能替代整机重启和业务签收。

## 发布与服务

从源码根执行构建和检查，再生成一个不存在的新发布目录：

```powershell
corepack pnpm build
corepack pnpm trial:package --repo D:/SCM-Automation --target D:/SCM-Automation/.local/trial/releases/<new-release>
./scripts/deployment/trial.ps1 provision -ReleasePath D:/SCM-Automation/.local/trial/releases/<new-release>
./scripts/deployment/trial.ps1 install
```

`provision` 仅初始化空试用环境；中断后保留现状，不能直接重跑覆盖。`install` 使用 PostgreSQL 18 原生服务和 WinSW 2.12.0，固定 Caddy 2.11.7，校验官方归档哈希。二进制缓存位于 `D:/SCM-Automation/.local/development/runtime/t23-downloads`，下载来源为对应项目的 GitHub Releases。所有服务以 LocalService 运行，API/数据库仅本机监听；防火墙只允许本地子网访问本程序的 TCP 443。

首次迁移空库，或在试用 API/Worker 尚未启动时复制当前开发快照；复制工具只接受空目标，短暂停止并恢复原开发 API/Worker，不修改源数据库：

```powershell
Start-Service SCM-Trial-Postgres
./scripts/deployment/seed-from-development.ps1
./scripts/deployment/trial.ps1 start
./scripts/deployment/trial.ps1 trust
./scripts/deployment/trial.ps1 status
```

启动检查包含四项服务状态、数据库、实际 Worker 子进程与启动后的新心跳。开发快照不是业务签收；现有管理员使用其原凭据登录试用环境，不在文档复制密码。`runtime.json`、`config/app.env` 只保存在受控目录。当前试用默认 `LINGXING_REQUESTS_ENABLED=false`；需要实际批次同步时，在核对剩余预算后显式启用。恢复环境始终保持关闭。

本轮试用未复制领星密钥。实际只读同步前，将已授权凭据保存在 `trial/config/lingxing.env`，在 `app.env` 设置其绝对 `LINGXING_ENV_FILE` 路径，并核对预算后启用请求；该受控配置随完整加密备份保存。恢复工具继续清空领星凭据并固定禁用请求。

本机已信任的内部 CA 不会自动传到其他设备。指定局域网客户端需解析本机名，并在核对证书指纹后信任 `evidence/https-root.crt`；只分发公开根证书。不得通过关闭 TLS 校验验收。第二台客户端及用户保存工作后的系统重启需另行实测。

升级和回退均使用已完成校验的新发布目录：

```powershell
./scripts/deployment/trial.ps1 release -ReleasePath D:/SCM-Automation/.local/trial/releases/<release>
```

升级先检查必需产物，停止应用服务后切换。启动健康失败时恢复上一版配置和应用；数据库迁移不能靠切换代码自动逆转。含不兼容迁移的升级必须恢复升级前完整备份到新环境再切换，不能对原库执行破坏性回滚。

## 加密备份与恢复

```powershell
node scripts/trial/cli.mjs key-init --key D:/SCM-Automation/.local/development/recovery/trial-backup.key
corepack pnpm trial:verify --config D:/SCM-Automation/.local/trial/runtime.json
corepack pnpm trial:backup --config D:/SCM-Automation/.local/trial/runtime.json
./scripts/deployment/schedule-backup.ps1
```

计划任务 `SCM-Trial-DailyBackup` 每日 02:00 以 SYSTEM 运行，错过时补执行，禁止重叠运行，保留至少最近 30 天成功备份。当前目的地 `trial/backups` 属于本机暂存；配置独立介质前不算独立备份通过。密钥位于试用目录外且不进入备份包；正式交付必须另外保存可恢复的密钥副本。

正式试用的原始资料、人工参考、对账包及签收原文保存到 `D:/SCM-Automation/.local/trial/data/acceptance`，随 DATA_DIR 一起备份。默认开发预检目录 `SCM-Automation/.local/development/data/acceptance` 的后续变化不会自动复制到试用环境。

```powershell
corepack pnpm trial:restore --config D:/SCM-Automation/.local/trial/runtime.json --backup D:/SCM-Automation/.local/trial/backups/<id>.scmbak --target D:/SCM-Automation/.local/archive/restore-<new-id> --port 55434 --database scm_restore_<new_id>
```

工具认证密文和全部归档文件后建立新集群，比较所有业务表和序列、审计、确认、编码及导出版本，校验索引文件哈希并回读历史 XLSX；完成后停止恢复数据库。恢复副本不自动启动 API/Worker、不注册正式服务、不调用领星。人工审查未决任务后，再启动隔离副本演练任务恢复。实际耗时和备份恢复点年龄写入 `restore-report.json`，不能把它们当作已经达成的长期 RPO/RTO 承诺。

`restore-fixture.mjs create/remove` 仅用于试用库内带清单的技术恢复数据，不是业务批次；完成演练后仅清理该清单对应记录。正式业务批次在 T22 签收后必须保留，并再次执行完整备份恢复核对。

排队任务演练使用本地示例任务：先停止试用 Worker，运行 `verify-runtime.mjs --config <试用配置> --enqueue-only`，备份该 queued 任务；备份结束后恢复试用 Worker。恢复库验证通过并停止后，人工复核未决清单，再按顺序执行：

```powershell
./scripts/deployment/recovery-runtime.ps1 db-start -ConfigPath <恢复目录>/runtime.json
./scripts/deployment/recovery-runtime.ps1 api-start -ConfigPath <恢复目录>/runtime.json
node scripts/deployment/verify-runtime.mjs --recovery <恢复目录>/runtime.json --resume-task <原taskId> --expect-queued
./scripts/deployment/recovery-runtime.ps1 worker-start -ConfigPath <恢复目录>/runtime.json
node scripts/deployment/verify-runtime.mjs --recovery <恢复目录>/runtime.json --resume-task <原taskId>
./scripts/deployment/recovery-runtime.ps1 stop -ConfigPath <恢复目录>/runtime.json
```

恢复启动器仅接受 `restoreOnly=true` 的独立目录/端口，固定禁止领星请求，验证新 Worker 的实际心跳后才返回。任务验证比较原 taskId 和创建时间，不重新提交；恢复进程不注册成自启服务。

工具格式、错误及恢复边界见 [备份工具说明](../../scripts/trial/README.md)；真实文件和签收操作见 [T13/T22 验收说明](../acceptance/t13-t22-runbook.md)。
